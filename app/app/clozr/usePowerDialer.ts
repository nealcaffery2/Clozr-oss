'use client';

/**
 * The power dialer's engine: one rep's session over a list, run by Talkr.
 *
 * Every list runs on Talkr's server as a `parallel` campaign (talkr
 * docs/dialers.md §4), one to ten lines: Talkr picks who rings next
 * (suppression, the per-day cap and the lead's calling window are its
 * selection-time rules), REST-dials the lines with machine detection, and
 * rings this browser only when a person answers. The first answer is the
 * rep's; a second answer hears the rep's recording; machines hear it too. One
 * line is the same path with one seller at a time, which is what makes AMD
 * and the drop work on every call instead of only on batches.
 *
 * Power is the rep pressing Next. Predictive presses it for them, with a
 * short countdown they can stop, and slows down before the abandonment cap
 * (lib/power-dialer.ts paceLines).
 *
 * The hook owns: the session and its campaign, each line of the last batch
 * as the stream moves it, the lead cards, the "up next" preview, the tally
 * (lib/dial-session.ts) and the talk clock. It never decides who to ring.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type CallDto,
  type CampaignDto,
  type CampaignQueueLeadDto,
  type CampaignSettingsDto,
  type DialSessionDto,
  type LeadCardDto,
} from '@/lib/talkr-web/api';
import { refusalText, type Softphone } from '@/lib/softphone';
import { TalkrError } from '@/lib/talkr';
import { openMic } from '@/lib/phone-audio';
import {
  ABANDON_CAP_PERCENT, STARTING_LINES, clampLines, isListCampaign, lineEvent, lineFromLabel, lineIsLive, lineStateFromStatus,
  nextLineState, paceLines, sessionStats, winnerLine, type DialLine, type DialMode, type SessionStats,
} from '@/lib/power-dialer';
import { emptyTally, outcomeForDisposition, tallyOutcome, type SessionTally } from '@/lib/dial-session';
import type { OutcomeKey } from '@/lib/call-outcomes';
import { formatPhone } from '@/lib/talkr-web/time';
import { predictiveVoicemailText } from '@/lib/busy-answer';
import { readyDropScript, readyDropUrl } from '@/lib/busy-drop';
import { onTalkrEvent } from '@/lib/talkr-events';

/** How long Next waits before its one retry when Talkr says a line is still in flight. */
const IN_FLIGHT_RETRY_MS = 2_500;
/** Predictive: the pause between a saved outcome and the next batch, which the rep can stop. */
export const AUTO_NEXT_SECONDS = 3;
/** How many leads the "Up next" list previews. */
const UP_NEXT = 10;

/** Why `next` had nobody to dial, in words a rep can act on. */
const IDLE_SENTENCES: Record<string, string> = {
  outside_calling_window: 'Everyone left is outside their calling window. The list resumes when their local morning comes round.',
  waiting_retries: 'Everyone left is waiting on a retry. Nothing is dialable yet.',
  exhausted: 'That is the whole list. Every lead is contacted or out of attempts.',
  campaign_not_active: 'The campaign was paused. A manager has to reactivate it.',
  session_call_in_flight: 'Finish the call on the line before dialing the next one.',
  no_leads: 'Nobody is left to dial on this list.',
};

function idleSentence(reason: string | undefined): string {
  if (!reason) return 'Nobody to dial right now.';
  return IDLE_SENTENCES[reason] ?? reason.replace(/_/g, ' ');
}

/**
 * The campaign settings a session runs with: N lines, AMD that drops the
 * rep's recording (or speaks the script), 8am to 8pm in the seller's zone.
 * The recording is a signed URL good for a couple of minutes, so `next`
 * refreshes it before every batch (withDropUrl).
 */
export function sessionSettings(base: CampaignSettingsDto = {}, lines: number = STARTING_LINES, amd = true): CampaignSettingsDto {
  return withDropUrl({
    amdEnabled: amd,
    amdAction: 'voicemail_drop',
    parallelLines: clampLines(lines),
    abandonmentCapPercent: base.abandonmentCapPercent ?? ABANDON_CAP_PERCENT,
    maxAttemptsPerDay: base.maxAttemptsPerDay ?? 3,
    callingWindowStart: base.callingWindowStart ?? '08:00',
    callingWindowEnd: base.callingWindowEnd ?? '20:00',
    timezonePolicy: base.timezonePolicy ?? 'lead',
    amdVoicemailText: predictiveVoicemailText(base.amdVoicemailText, readyDropScript()),
  });
}

/** The settings with the armed recording's current signed URL, or without one when nothing is armed. */
export function withDropUrl(settings: CampaignSettingsDto): CampaignSettingsDto {
  const url = readyDropUrl();
  const { amdVoicemailUrl: _old, ...rest } = settings;
  return url ? { ...rest, amdVoicemailUrl: url } : rest;
}

const RESTORE_KEY = 'clozr-campaign-restore:';
const MODE_KEY = 'clozr-dial-mode:';

type CampaignRestore = { mode: string; settings: CampaignSettingsDto };

/** The mode the rep picked at Start, per campaign, so a reload still knows whether Next is theirs or automatic. */
function rememberMode(campaignId: string, mode: DialMode) {
  try { sessionStorage.setItem(MODE_KEY + campaignId, mode); } catch { /* no storage */ }
}
function readMode(campaignId: string): DialMode | null {
  try {
    const m = sessionStorage.getItem(MODE_KEY + campaignId);
    return m === 'power' || m === 'predictive' ? m : null;
  } catch { return null; }
}
function forgetMode(campaignId: string) {
  try { sessionStorage.removeItem(MODE_KEY + campaignId); } catch { /* no storage */ }
}

/** The campaign as it was before this browser changed it for a session, so End puts it back. */
function rememberCampaign(campaign: CampaignDto) {
  if (typeof sessionStorage === 'undefined') return;
  const key = RESTORE_KEY + campaign.id;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, JSON.stringify({ mode: campaign.mode, settings: campaign.settings }));
}

function takeCampaignRestore(id: string): CampaignRestore | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(RESTORE_KEY + id);
  sessionStorage.removeItem(RESTORE_KEY + id);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CampaignRestore;
    if (!parsed || typeof parsed.mode !== 'string' || !parsed.settings) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** What a finished session came to, kept on screen until the rep starts another. */
export type SessionSummary = {
  title: string;
  mode: DialMode;
  lines: number;
  stats: SessionStats;
  tally: SessionTally;
  how: 'ended' | 'finished';
  endedAt: number;
};

export type PowerDialer = {
  /** The rep's active or paused session, or null. */
  session: DialSessionDto | null;
  campaign: CampaignDto | null;
  /** Power (the rep presses Next) or predictive (the next batch dials itself), as the rep chose it. */
  dialMode: DialMode;
  /** Who the current session call is with, as the server described them. */
  card: LeadCardDto | null;
  /** Campaigns this rep may run, for the picker. Empty until loaded. */
  campaigns: CampaignDto[];
  /** How many leads are still dialable in the campaign behind this session. */
  remaining: number | null;
  /** Every line of the last batch, live: who is ringing, who answered, who was a machine, who heard the recording. */
  lines: DialLine[];
  /** The line this browser is on, once Talkr bridged one. */
  winner: DialLine | null;
  /** Set when `next` had nobody to dial. Cleared by the next successful advance. */
  idle: string | null;
  /** Set when the server refused something. Cleared on the next action. */
  error: string | null;
  busy: boolean;
  /** Lines per batch as the session runs them now (pacing can lower it between batches). */
  lineCount: number;
  /** Change the lines per batch for the next Next. */
  setLineCount: (n: number) => Promise<void>;
  /** Machine detection on the seller leg: off, and a machine rings through to the rep. */
  amd: boolean;
  setAmd: (on: boolean) => Promise<void>;
  /** The session's numbers, from Talkr's counters and this browser's clock. */
  stats: SessionStats;
  tally: SessionTally;
  /** Who Talkr will ring next, in order. */
  upNext: CampaignQueueLeadDto[];
  /** Predictive: seconds until the next batch dials itself, or null when nothing is counting down. */
  countdown: number | null;
  cancelCountdown: () => void;
  /** The last session's summary, until the next start. */
  summary: SessionSummary | null;
  dismissSummary: () => void;
  start: (campaignId: string, mode?: DialMode, lines?: number, opts?: { title?: string; amd?: boolean }) => Promise<boolean>;
  /** Machines the campaign has reached, once stats have loaded. */
  machines: number | null;
  /** Set when pacing paused the session for the abandonment cap. */
  capNote: string | null;
  /** Dial the next batch. `auto` is predictive's own press: it counts down first and can be stopped. */
  next: (opts?: { auto?: boolean }) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  end: () => Promise<void>;
  /** The outcome saved for the call the session rang last, so the tally and the summary count it. */
  logOutcome: (key: OutcomeKey) => void;
  /** A Talkr disposition (a buyer's or an unknown number's wrap-up), counted by what it means. */
  logDisposition: (name: string | null, o: { noAnswer: boolean; talked: boolean }) => void;
  /** Re-read the session and its counters (after a call, or an SSE nudge). */
  refresh: () => void;
  /** Re-read the campaign list (after one is created, activated or paused). */
  reloadCampaigns: () => void;
};

const EMPTY_STATS = sessionStats({ dialed: 0, connected: 0, abandoned: 0, machines: 0, talkSeconds: 0, calls: 0, startedAt: null, now: 0, remaining: null });

export const EMPTY_POWER_DIALER: PowerDialer = {
  session: null,
  campaign: null,
  dialMode: 'power',
  card: null,
  campaigns: [],
  remaining: null,
  lines: [],
  winner: null,
  idle: null,
  error: null,
  busy: false,
  lineCount: STARTING_LINES,
  setLineCount: async () => undefined,
  amd: true,
  setAmd: async () => undefined,
  stats: EMPTY_STATS,
  tally: emptyTally(),
  upNext: [],
  countdown: null,
  cancelCountdown: () => undefined,
  summary: null,
  dismissSummary: () => undefined,
  start: async () => false,
  machines: null,
  capNote: null,
  next: async () => undefined,
  pause: async () => undefined,
  resume: async () => undefined,
  end: async () => undefined,
  logOutcome: () => undefined,
  logDisposition: () => undefined,
  refresh: () => undefined,
  reloadCampaigns: () => undefined,
};

export function usePowerDialer({
  enabled,
  sp,
  extensionHasPhone = false,
  orgNumbers = [],
  onCallOpened,
  onCallFailed,
  onLinesDialed,
}: {
  /** Talkr knows this rep. Without that none of these endpoints exist to call. */
  enabled: boolean;
  sp: Softphone;
  /** Every org line this rep may present, so each line of a batch can say which number it rang from. */
  orgNumbers?: readonly { phone_e164: string; label?: string | null }[];
  /**
   * The Talkr extension holds the softphone, so this tab has no phone to open
   * a leg on, and bringing one up would be a second registration under the
   * same identity. Next is refused before the server creates a call.
   */
  extensionHasPhone?: boolean;
  /**
   * A call was created for this session and is about to be answered here.
   * The CRM's own call state is set by whoever dials, and this path does not
   * go through the dialer's Call button.
   */
  onCallOpened?: (call: CallDto) => void;
  /** The leg for that call could not be opened; undo what onCallOpened did. */
  onCallFailed?: () => void;
  /** Every line Next just rang, before any answers: a CLOZR list takes the people off its queue here. */
  onLinesDialed?: (lines: DialLine[]) => void;
}): PowerDialer {
  const [session, setSession] = useState<DialSessionDto | null>(null);
  const [campaign, setCampaign] = useState<CampaignDto | null>(null);
  const [pickedMode, setPickedMode] = useState<DialMode | null>(null);
  const [card, setCard] = useState<LeadCardDto | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [lines, setLines] = useState<DialLine[]>([]);
  const [idle, setIdle] = useState<string | null>(null);
  const [machines, setMachines] = useState<number | null>(null);
  const [capNote, setCapNote] = useState<string | null>(null);
  const capPaused = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [upNext, setUpNext] = useState<CampaignQueueLeadDto[]>([]);
  const [tally, setTally] = useState<SessionTally>(emptyTally);
  const [talkSeconds, setTalkSeconds] = useState(0);
  const [callsHere, setCallsHere] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** What the session was started as in this tab, for the summary. */
  const startedAs = useRef<{ title: string; lines: number } | null>(null);
  /** How many lines the rep asked for at Start; pacing never opens more. Null until a start in this tab. */
  const wantedLines = useRef<number | null>(null);
  /** When the session was last asked to re-read, so the end-of-call read can skip one already done. */
  const lastRefresh = useRef(0);
  const refresh = useCallback(() => {
    lastRefresh.current = Date.now();
    setNonce((n) => n + 1);
  }, []);
  const [campaignsNonce, setCampaignsNonce] = useState(0);
  const reloadCampaigns = useCallback(() => setCampaignsNonce((n) => n + 1), []);

  // The session clock and the pace move once a second while a session is up.
  const sessionUp = !!session;
  useEffect(() => {
    if (!sessionUp) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sessionUp]);

  // The list of campaigns is read once: a rep starting a session needs to pick
  // one, and they do not change under a rep mid-shift.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api
      .listCampaigns()
      .then(({ campaigns: rows }) => {
        // A campaign CLOZR built for a list session is that session's, not one to pick.
        if (live) setCampaigns(rows.filter((c) => c.status === 'active' && !isListCampaign(c.name)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, campaignsNonce]);

  const loadUpNext = useCallback((campaignId: string) => {
    void api.campaignQueue(campaignId, UP_NEXT).then((r) => setUpNext(r.leads)).catch(() => undefined);
  }, []);

  // Adopt whatever session this rep already has. A reload, a second tab and a
  // session that advanced itself all land here.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void (async () => {
      try {
        const { session: found } = await api.activeDialSession();
        if (!live) return;
        setSession(found);
        if (!found) {
          setCampaign(null);
          setCard(null);
          setRemaining(null);
          setLines([]);
          setUpNext([]);
          return;
        }
        const detail = await api.getDialSession(found.id);
        if (!live) return;
        setSession(detail.session);
        setCampaign(detail.campaign);
        setPickedMode(readMode(found.campaign_id));
        setCard(detail.card);
        loadUpNext(found.campaign_id);
        const stats = await api.campaignStats(found.campaign_id).catch(() => null);
        if (!live) return;
        if (stats) {
          setRemaining(stats.lead_counts.pending ?? 0);
          setMachines(stats.calls.machine);
          const cap = stats.abandonment.cap_percent || ABANDON_CAP_PERCENT;
          // Pacing and the abandonment cap apply to every session: the 3% cap is the law, not a mode.
          if (detail.campaign?.mode === 'parallel') {
            const currentLines = detail.campaign.settings.parallelLines ?? STARTING_LINES;
            const paced = paceLines({
              answered: stats.abandonment.answered,
              abandoned: stats.abandonment.abandoned,
              machines: stats.calls.machine,
              currentLines,
              capPercent: cap,
              maxLines: wantedLines.current ?? currentLines,
            });
            if (paced.pause && detail.session.state === 'active' && capPaused.current !== found.id) {
              capPaused.current = found.id;
              const paused = await api.dialSessionAction(found.id, 'pause').catch(() => null);
              if (paused) setSession(paused.session);
              setCapNote(`Paused. Abandonment is over the ${cap}% cap, so it stopped opening lines.`);
            } else if (!paced.pause) {
              if (paced.lines !== currentLines) {
                const updated = await api.updateCampaign(found.campaign_id, {
                  settings: { ...detail.campaign.settings, parallelLines: paced.lines },
                }).catch(() => null);
                if (updated) setCampaign(updated.campaign);
              }
              setCapNote(paced.reason === 'near_cap'
                ? 'One line at a time. Abandonment is near the cap, so it stopped dialing ahead.'
                : null);
            }
          }
        }
      } catch (err) {
        // A rep without `campaigns.run` gets a 403 here. That is not an error
        // to put on screen. Any other failure (a network blip mid-session)
        // keeps what is showing: dropping the page would offer Start for a
        // session that still exists.
        if (live && err instanceof ApiError && err.status === 403) setSession(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, nonce, loadUpNext]);

  /** Every action: one at a time, errors in words, session re-read after. */
  const act = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        return await work();
      } catch (err) {
        setError(refusalText(err));
        return null;
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [refresh],
  );

  const start = useCallback<PowerDialer['start']>(
    async (campaignId, mode = 'power', wanted, opts) => {
      const existing = campaigns.find((c) => c.id === campaignId);
      // Every session is a Talkr parallel campaign, one line or ten: Talkr
      // dials the sellers with machine detection and rings this browser when a
      // person answers. Power and predictive differ only in who presses Next.
      const linesWanted = clampLines(wanted ?? existing?.settings.parallelLines ?? STARTING_LINES);
      wantedLines.current = linesWanted;
      const result = await act(async () => {
        if (existing) {
          rememberCampaign(existing);
          await api.updateCampaign(campaignId, {
            mode: 'parallel',
            settings: { ...existing.settings, ...sessionSettings(existing.settings, linesWanted, opts?.amd ?? true) },
          });
        }
        return api.startDialSession(campaignId);
      });
      if (!result) return false;
      rememberMode(campaignId, mode);
      startedAs.current = { title: opts?.title ?? existing?.name ?? 'List', lines: linesWanted };
      setPickedMode(mode);
      setSession(result.session);
      setSummary(null);
      setTally(emptyTally());
      setTalkSeconds(0);
      setCallsHere(0);
      setIdle(null);
      setCapNote(null);
      setLines([]);
      loadUpNext(campaignId);
      return true;
    },
    [act, campaigns, loadUpNext],
  );

  const spBridge = sp.awaitBridge;
  const spCancelBridge = sp.cancelBridgeWait;
  const spRetarget = sp.retarget;
  const currentId = session?.id ?? null;
  /** The last batch Next rang, with each line's card, so `bridged` can put the right person on screen. */
  const batchRef = useRef<{ call: CallDto; card: LeadCardDto | null }[]>([]);

  const cancelCountdown = useCallback(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    setCountdown(null);
  }, []);
  // A countdown still running when the shell unmounts must not dial.
  useEffect(() => () => { if (countdownTimer.current) clearInterval(countdownTimer.current); countdownTimer.current = null; }, []);

  const dial = useCallback(async () => {
    if (!currentId) return;
    setIdle(null);
    if (extensionHasPhone) {
      setError('The Talkr extension has the phone. Run the session from there, or close it to dial here.');
      return;
    }
    // Ask for the mic inside the tap. The leg opens only after the server
    // answers, and by then iOS Safari no longer counts this as a gesture and
    // will not prompt. Held until the leg has its own, then released.
    const mic: Promise<MediaStream | null> = openMic(true);
    let handed = false;
    // A batch still waiting on an answer is over: this press is the next one.
    spCancelBridge();
    try {
      const result = await act(async () => {
        // Caller ID is Talkr's per line (talkr docs/dialers.md §9): each line
        // dials from the rep's own number in the seller's area code, else
        // their least-used line this week. A pin left from before puts every
        // line on one number, so it is cleared. The recording's fresh signed
        // URL goes with every batch: Talkr plays it to a machine and to a
        // second person who answers while this rep is bridged.
        const camp = campaign;
        if (camp) {
          let settings: CampaignSettingsDto = { ...camp.settings };
          delete settings.callerIdPhoneNumberId;
          settings = withDropUrl(settings);
          if (JSON.stringify(settings) !== JSON.stringify(camp.settings)) {
            const updated = await api.updateCampaign(camp.id, { settings }).catch(() => null);
            if (updated) setCampaign(updated.campaign);
          }
        }
        // Talkr refuses Next (call_in_flight) while a line of the last batch
        // is still open in its calls table. Its status callback can land a
        // second or two after the carrier ended the line, so one refusal is
        // waited out and retried before the rep sees it.
        try {
          return await api.dialSessionNext(currentId);
        } catch (err) {
          if (!(err instanceof TalkrError && err.code === 'call_in_flight')) throw err;
          await new Promise((r) => setTimeout(r, IN_FLIGHT_RETRY_MS));
          return api.dialSessionNext(currentId);
        }
      });
      if (!result) return;
      if (result.idle) {
        setIdle(idleSentence(result.reason));
        setLines([]);
        return;
      }
      const line = winnerLine(result.lines);
      if (!line) {
        setIdle(idleSentence(undefined));
        return;
      }
      setCard(line.card);
      // Every line of the batch stays on the server; the page shows each one
      // from dial to outcome, updated from the stream (lineEvent below).
      const at = Date.now();
      const dialed: DialLine[] = (result.lines ?? []).map((l) => ({
        callId: l.call.id,
        name: l.card?.contact?.display_name || l.call.contact_name || l.call.to_number || 'Lead',
        phone: l.call.to_number ?? '',
        state: lineStateFromStatus(l.call.status) ?? 'dialing',
        since: at,
        from: lineFromLabel(l.call.from_number, orgNumbers, formatPhone) ?? undefined,
        card: l.card ?? null,
      }));
      setLines(dialed);
      batchRef.current = (result.lines ?? []).map((l) => ({ call: l.call, card: l.card ?? null }));
      onLinesDialed?.(dialed);
      if (campaign) loadUpNext(campaign.id);
      // Before the leg, so the screen is on the call while it is still ringing.
      onCallOpened?.(line.call);
      try {
        // Talkr dialled the lines itself and rings this browser only when
        // someone answers: wait for that invite.
        await spBridge(line.call, mic);
        handed = true;
      } catch (err) {
        // Nobody on the batch answered (or the rep moved on): the lines panel
        // already says so, and the screen comes back off a call nobody is on.
        if ((err as { code?: string }).code !== 'no_answer') {
          setError(err instanceof Error ? err.message : 'Could not open the call in this browser.');
        }
        onCallFailed?.();
      }
    } finally {
      // The softphone keeps the stream until hangup once the leg is up.
      // Stopping it here, while the call is live, is what leaves the mic on.
      if (!handed) void mic.then((s) => s?.getTracks().forEach((t) => t.stop()));
    }
  }, [act, currentId, extensionHasPhone, spBridge, spCancelBridge, onCallOpened, onCallFailed, onLinesDialed, campaign, orgNumbers, loadUpNext]);

  const dialRef = useRef(dial);
  useEffect(() => { dialRef.current = dial; }, [dial]);

  const next = useCallback<PowerDialer['next']>(async (opts) => {
    cancelCountdown();
    if (!opts?.auto) return dial();
    // Predictive's own press: a short count the rep can stop with Pause or End.
    setCountdown(AUTO_NEXT_SECONDS);
    let left = AUTO_NEXT_SECONDS;
    countdownTimer.current = setInterval(() => {
      left -= 1;
      if (left > 0) { setCountdown(left); return; }
      if (countdownTimer.current) clearInterval(countdownTimer.current);
      countdownTimer.current = null;
      setCountdown(null);
      void dialRef.current();
    }, 1000);
  }, [cancelCountdown, dial]);

  const action = useCallback(
    (kind: 'pause' | 'resume' | 'end') => async () => {
      if (!currentId) return;
      if (kind !== 'resume') { spCancelBridge(); cancelCountdown(); }
      const result = await act(() => api.dialSessionAction(currentId, kind));
      if (!result) return;
      setSession(kind === 'end' ? null : result.session);
      if (kind === 'end') {
        const restoreId = result.session.campaign_id;
        const prior = takeCampaignRestore(restoreId);
        forgetMode(restoreId);
        // A campaign built for a CLOZR list is done with: archived, so it
        // never shows up as something to dial again. A real campaign goes
        // back to how it was before this browser changed its mode.
        if (campaign && campaign.id === restoreId && isListCampaign(campaign.name)) {
          void api.updateCampaign(restoreId, { status: 'archived' }).catch(() => undefined);
        } else if (prior) {
          void api.updateCampaign(restoreId, { mode: prior.mode, settings: prior.settings }).catch(() => undefined);
        }
        const ended = result.session;
        setSummary({
          title: startedAs.current?.title ?? campaign?.name ?? 'List',
          mode: pickedMode ?? 'power',
          lines: startedAs.current?.lines ?? campaign?.settings.parallelLines ?? 1,
          stats: sessionStats({
            dialed: ended.dialed, connected: ended.connected, abandoned: ended.abandoned, machines: machines ?? 0,
            talkSeconds, calls: callsHere, startedAt: Date.parse(ended.started_at) || null, now: Date.now(), remaining,
          }),
          tally,
          how: idle ? 'finished' : 'ended',
          endedAt: Date.now(),
        });
        setPickedMode(null);
        setCampaign(null);
        setCard(null);
        setRemaining(null);
        setLines([]);
        setUpNext([]);
        setIdle(null);
        setCapNote(null);
        startedAs.current = null;
      }
    },
    [act, currentId, campaign, spCancelBridge, cancelCountdown, pickedMode, machines, talkSeconds, callsHere, remaining, tally, idle],
  );

  const pause = useMemo(() => action('pause'), [action]);
  const resume = useMemo(() => action('resume'), [action]);
  const end = useMemo(() => action('end'), [action]);

  const setLineCount = useCallback<PowerDialer['setLineCount']>(async (n) => {
    if (!campaign) return;
    const wanted = clampLines(n);
    wantedLines.current = wanted;
    const updated = await act(() => api.updateCampaign(campaign.id, { settings: { ...campaign.settings, parallelLines: wanted } }));
    if (updated) setCampaign(updated.campaign);
  }, [act, campaign]);

  const setAmd = useCallback<PowerDialer['setAmd']>(async (on) => {
    if (!campaign) return;
    const updated = await act(() => api.updateCampaign(campaign.id, { settings: { ...campaign.settings, amdEnabled: on } }));
    if (updated) setCampaign(updated.campaign);
  }, [act, campaign]);

  // A finished call means the counters moved and the next lead is dialable.
  // Re-read rather than guess, and after a beat, because Talkr finalises
  // duration and disposition once the leg has dropped. The talk clock counts
  // this browser's leg: the far end answered at `startedAt`, hung up at `endedAt`.
  const phase = sp.phase;
  const wasInCall = useRef(false);
  /** The call on screen has been counted once (at wrap-up, or at idle when wrap-up was skipped). */
  const counted = useRef(false);
  const spStartedAt = sp.startedAt;
  const spEndedAt = sp.endedAt;
  useEffect(() => {
    if (phase === 'in_call') {
      wasInCall.current = true;
      counted.current = false;
    }
    if (phase !== 'idle' && phase !== 'wrapup') return;
    if (!wasInCall.current || !currentId) return;
    const idle = phase === 'idle';
    if (idle) wasInCall.current = false;
    const talk = spStartedAt && spEndedAt && spEndedAt > spStartedAt ? Math.round((spEndedAt - spStartedAt) / 1000) : 0;
    const endedAt = Date.now();
    const t = setTimeout(() => {
      if (!counted.current) {
        counted.current = true;
        setTalkSeconds((s) => s + talk);
        setCallsHere((n) => n + 1);
      }
      if (idle && lastRefresh.current < endedAt) refresh();
    }, idle ? 1500 : 0);
    return () => clearTimeout(t);
  }, [phase, currentId, refresh, spStartedAt, spEndedAt]);

  // Each line moves on the stream: Talkr's call status as it rings and ends,
  // and the session's own amd / abandoned / bridged verdicts, which stick past the hang-up.
  useEffect(() => {
    if (!enabled || !currentId) return;
    return onTalkrEvent((e) => {
      const hit = lineEvent(e);
      if (!hit) return;
      // Talkr named the line it is bridging to this browser: that person is
      // the call on screen, not whichever line the batch listed first.
      if (hit.state === 'talking' && e.type === 'session.updated') {
        const won = batchRef.current.find((l) => l.call.id === hit.callId);
        if (won) {
          setCard(won.card);
          spRetarget(won.call);
          onCallOpened?.(won.call);
        }
      }
      setLines((prev) => {
        const i = prev.findIndex((l) => l.callId === hit.callId);
        if (i < 0) return prev;
        const state = nextLineState(prev[i]!.state, hit.state);
        if (state === prev[i]!.state) return prev;
        const copy = prev.slice();
        copy[i] = { ...prev[i]!, state, since: Date.now() };
        return copy;
      });
    });
  }, [enabled, currentId, spRetarget, onCallOpened]);

  // Every line of the batch is at an outcome and none was bridged here: stop
  // waiting for an invite that is not coming, so Next is free again.
  useEffect(() => {
    if (lines.length === 0 || sp.phase !== 'connecting') return;
    if (lines.some((l) => lineIsLive(l.state))) return;
    spCancelBridge();
  }, [lines, sp.phase, spCancelBridge]);

  // The tally: outcomes the rep saved, keyed by the number rung so one call counts once.
  const winner = useMemo(() => lines.find((l) => l.state === 'talking') ?? null, [lines]);
  const lastWho = useRef<string | null>(null);
  useEffect(() => { if (winner) lastWho.current = winner.phone; }, [winner]);
  const logOutcome = useCallback<PowerDialer['logOutcome']>((key) => {
    const who = lastWho.current ?? 'unknown';
    const seconds = spStartedAt && spEndedAt && spEndedAt > spStartedAt ? (spEndedAt - spStartedAt) / 1000 : 0;
    setTally((t) => (t.last[who] === key ? t : tallyOutcome(t, key, who, seconds)));
  }, [spStartedAt, spEndedAt]);
  const logDisposition = useCallback<PowerDialer['logDisposition']>((name, o) => {
    const key = outcomeForDisposition(name) ?? (o.noAnswer ? 'noanswer' : o.talked ? 'followup' : null);
    if (key) logOutcome(key);
  }, [logOutcome]);

  const dialMode: DialMode = pickedMode ?? (campaign?.mode === 'progressive' || campaign?.mode === 'predictive' ? 'predictive' : 'power');
  const lineCount = clampLines(campaign?.settings.parallelLines ?? STARTING_LINES);
  const amd = campaign?.settings.amdEnabled ?? true;
  const stats = useMemo(() => sessionStats({
    dialed: session?.dialed ?? 0,
    connected: session?.connected ?? 0,
    abandoned: session?.abandoned ?? 0,
    machines: machines ?? 0,
    talkSeconds,
    calls: callsHere,
    startedAt: session ? Date.parse(session.started_at) || null : null,
    now,
    remaining,
  }), [session, machines, talkSeconds, callsHere, now, remaining]);
  const dismissSummary = useCallback(() => setSummary(null), []);

  return useMemo<PowerDialer>(
    () =>
      enabled
        ? {
            session, campaign, dialMode, card, campaigns, remaining, lines, winner, idle, error, busy, lineCount, setLineCount, amd, setAmd,
            stats, tally, upNext, countdown, cancelCountdown, summary, dismissSummary, start, machines, capNote, next, pause, resume, end,
            logOutcome, logDisposition, refresh, reloadCampaigns,
          }
        : EMPTY_POWER_DIALER,
    [
      enabled, session, campaign, dialMode, card, campaigns, remaining, lines, winner, idle, error, busy, lineCount, setLineCount, amd, setAmd,
      stats, tally, upNext, countdown, cancelCountdown, summary, dismissSummary, start, machines, capNote, next, pause, resume, end,
      logOutcome, logDisposition, refresh, reloadCampaigns,
    ],
  );
}
