'use client';

/**
 * The power dialer, as the rep sees it.
 *
 * Talkr has had dial sessions since Phase 5 (talkr/docs/dialers.md) and CLOZR
 * has had the client for them in `lib/talkr-web/api.ts` since the port — with
 * nothing on screen calling any of it. "Start session" dialled the first row
 * of the CRM's own queue and that was the whole feature. This hook is the
 * missing half: a session a rep starts against a campaign, and a Next that
 * walks it.
 *
 * Three things about the server shape drive everything here:
 *
 *  - **`next` dials.** It applies suppression, the per-day attempt cap and the
 *    lead's calling window *at selection time*, then creates the call and
 *    hands back the record. The browser's job is only to open its leg for it
 *    (`sp.connectToCall`), never to decide who to ring. That is the whole
 *    compliance story and it stays on the server.
 *  - **Idle is an answer, not an error.** Nothing eligible comes back as
 *    `{ idle, reason }` — outside the calling window, waiting on retries,
 *    exhausted — and the rep is told which. A dialer that silently stops is
 *    how a rep sits there thinking the list is done.
 *  - **One active session per rep**, enforced by a partial unique index. So a
 *    reload adopts the existing session rather than starting a second one,
 *    and a second Start is a clean refusal.
 *
 * Power mode is the rep pressing Next. Progressive advances itself server-side
 * when a disposition is saved, so the counters move under us — which is why
 * the session is re-read after every call rather than tracked locally.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type CallDto,
  type CampaignDto,
  type CampaignSettingsDto,
  type DialSessionDto,
  type LeadCardDto,
} from '@/lib/talkr-web/api';
import { refusalText, type Softphone } from '@/lib/softphone';
import { ABANDON_CAP_PERCENT, STARTING_LINES, autoAdvances, paceLines, winnerLine, type DialMode } from '@/lib/dial-engine';
import { predictiveVoicemailText } from '@/lib/busy-answer';
import { readyDropScript } from '@/lib/busy-drop';
import { recentOutboundFromNumbers, spinOrgCallerId, type LinePools, type OrgLine } from '@/lib/caller-spin';

/** Why `next` had nobody to dial, in words a rep can act on. */
const IDLE_SENTENCES: Record<string, string> = {
  outside_calling_window: 'Everyone left is outside their calling window. The list resumes when their local morning comes round.',
  waiting_retries: 'Everyone left is waiting on a retry. Nothing is dialable yet.',
  exhausted: 'That is the whole list — every lead is contacted or out of attempts.',
  campaign_not_active: 'The campaign was paused. A manager has to reactivate it.',
  session_call_in_flight: 'Finish the call on the line before dialling the next one.',
};

function idleSentence(reason: string | undefined): string {
  if (!reason) return 'Nobody to dial right now.';
  return IDLE_SENTENCES[reason] ?? reason.replace(/_/g, ' ');
}

const RESTORE_KEY = 'clozr-campaign-restore:';

type CampaignRestore = { mode: string; settings: CampaignSettingsDto };

/** The campaign as it was before this browser turned it predictive, so End puts it back. */
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

export type DialBackgroundLine = {
  callId: string;
  name: string;
  status: string;
};

export type DialSession = {
  /** The rep's active or paused session, or null. */
  session: DialSessionDto | null;
  campaign: CampaignDto | null;
  /** Who the current session call is with, as the server described them. */
  card: LeadCardDto | null;
  /** Campaigns this rep may run, for the picker. Empty until loaded. */
  campaigns: CampaignDto[];
  /** How many leads are still dialable in the campaign behind this session. */
  remaining: number | null;
  /** Parallel lines still ringing while this browser holds the winner. */
  background: DialBackgroundLine[];
  /** Set when `next` had nobody to dial. Cleared by the next successful advance. */
  idle: string | null;
  /** Set when the server refused something. Cleared on the next action. */
  error: string | null;
  busy: boolean;
  start: (campaignId: string, mode?: DialMode) => Promise<boolean>;
  /** Machines the campaign has reached, once stats have loaded. */
  machines: number | null;
  /** Set when predictive pacing paused the session for the abandonment cap. */
  capNote: string | null;
  next: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  end: () => Promise<void>;
  /** Re-read the session and its counters (after a call, or an SSE nudge). */
  refresh: () => void;
  /** Re-read the campaign list (after one is created, activated or paused). */
  reloadCampaigns: () => void;
};

export const EMPTY_DIAL_SESSION: DialSession = {
  session: null,
  campaign: null,
  card: null,
  campaigns: [],
  remaining: null,
  background: [],
  idle: null,
  error: null,
  busy: false,
  start: async () => false,
  machines: null,
  capNote: null,
  next: async () => undefined,
  pause: async () => undefined,
  resume: async () => undefined,
  end: async () => undefined,
  refresh: () => undefined,
  reloadCampaigns: () => undefined,
};

export function useDialSession({
  enabled,
  sp,
  extensionHasPhone = false,
  orgNumbers = [],
  linePools,
  onCallOpened,
  onCallFailed,
}: {
  /** Talkr knows this rep. Without that none of these endpoints exist to call. */
  enabled: boolean;
  sp: Softphone;
  /**
   * Every org line this rep may present. A session rotates across the live
   * Telnyx lines before each Next so one number does not carry the list.
   * The destination is unknown until the server picks the lead, so this
   * pass is least-used, not local presence.
   */
  orgNumbers?: readonly OrgLine[];
  /** caller_lines pools so an RVM line is not the live caller ID. */
  linePools?: () => Promise<LinePools>;
  /**
   * The Talkr extension holds the softphone, so this tab has no phone to open
   * a leg on — and bringing one up would be a second registration under the
   * same identity. Next is refused before the server creates a call.
   */
  extensionHasPhone?: boolean;
  /**
   * A call was created for this session and is about to be answered here.
   * The CRM's own call state is set by whoever dials, and this path does not
   * go through the dialer's Call button — without this the audio would be
   * live while the screen still showed a keypad.
   */
  onCallOpened?: (call: CallDto) => void;
  /** The leg for that call could not be opened; undo what onCallOpened did. */
  onCallFailed?: () => void;
}): DialSession {
  const [session, setSession] = useState<DialSessionDto | null>(null);
  const [campaign, setCampaign] = useState<CampaignDto | null>(null);
  const [card, setCard] = useState<LeadCardDto | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [background, setBackground] = useState<DialBackgroundLine[]>([]);
  const [idle, setIdle] = useState<string | null>(null);
  const [machines, setMachines] = useState<number | null>(null);
  const [capNote, setCapNote] = useState<string | null>(null);
  const capPaused = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const [campaignsNonce, setCampaignsNonce] = useState(0);
  const reloadCampaigns = useCallback(() => setCampaignsNonce((n) => n + 1), []);

  // The list of campaigns is read once: a rep starting a session needs to pick
  // one, and they do not change under a rep mid-shift. Nothing is cleared on
  // the way out — `enabled` is read at the bottom instead, because clearing
  // state from an effect body is a cascading render for no gain.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api
      .listCampaigns()
      .then(({ campaigns: rows }) => {
        if (live) setCampaigns(rows.filter((c) => c.status === 'active'));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, campaignsNonce]);

  // Adopt whatever session this rep already has. A reload, a second tab and a
  // session that advanced itself in progressive mode all land here.
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
          setBackground([]);
          return;
        }
        const detail = await api.getDialSession(found.id);
        if (!live) return;
        setSession(detail.session);
        setCampaign(detail.campaign);
        setCard(detail.card);
        const stats = await api.campaignStats(found.campaign_id).catch(() => null);
        if (!live) return;
        if (stats) {
          setRemaining(stats.lead_counts.pending ?? 0);
          setMachines(stats.calls.machine);
          const cap = stats.abandonment.cap_percent || ABANDON_CAP_PERCENT;
          const mode = detail.campaign?.mode;
          if (autoAdvances(mode) && detail.campaign) {
            const currentLines = detail.campaign.settings.parallelLines ?? STARTING_LINES;
            const paced = paceLines({
              answered: stats.abandonment.answered,
              abandoned: stats.abandonment.abandoned,
              machines: stats.calls.machine,
              currentLines,
              capPercent: cap,
            });
            if (paced.pause && detail.session.state === 'active' && capPaused.current !== found.id) {
              capPaused.current = found.id;
              const paused = await api.dialSessionAction(found.id, 'pause').catch(() => null);
              if (paused) setSession(paused.session);
              setCapNote(`Predictive paused. Abandonment is over the ${cap}% cap, so it stopped opening lines.`);
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
        // to put on screen — it means this rep does not run campaigns. Any
        // other failure (a network blip mid-session) keeps what is showing:
        // dropping the bar would offer Start for a session that still exists.
        if (live && err instanceof ApiError && err.status === 403) setSession(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, nonce]);

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
        setNonce((n) => n + 1);
      }
    },
    [],
  );

  const start = useCallback<DialSession['start']>(
    async (campaignId, mode = 'power') => {
      const existing = campaigns.find((c) => c.id === campaignId);
      const result = await act(async () => {
        if (existing && (existing.mode !== mode || mode === 'predictive')) {
          rememberCampaign(existing);
          await api.updateCampaign(campaignId, {
            mode,
            settings: {
              ...existing.settings,
              ...(mode === 'predictive'
                ? {
                    amdEnabled: true,
                    amdAction: 'voicemail_drop' as const,
                    parallelLines: STARTING_LINES,
                    abandonmentCapPercent: existing.settings.abandonmentCapPercent ?? ABANDON_CAP_PERCENT,
                    maxAttemptsPerDay: existing.settings.maxAttemptsPerDay ?? 3,
                    callingWindowStart: existing.settings.callingWindowStart ?? '08:00',
                    callingWindowEnd: existing.settings.callingWindowEnd ?? '20:00',
                    timezonePolicy: existing.settings.timezonePolicy ?? 'lead',
                    amdVoicemailText: predictiveVoicemailText(existing.settings.amdVoicemailText, readyDropScript()),
                  }
                : {}),
            },
          });
        }
        return api.startDialSession(campaignId);
      });
      if (!result) return false;
      setSession(result.session);
      setIdle(null);
      setCapNote(null);
      return true;
    },
    [act, campaigns],
  );

  const spConnect = sp.connectToCall;
  const currentId = session?.id ?? null;

  const next = useCallback<DialSession['next']>(async () => {
    if (!currentId) return;
    setIdle(null);
    if (extensionHasPhone) {
      setError('The Talkr extension has the phone. Run the session from there, or close it to dial here.');
      return;
    }
    // Ask for the mic inside the tap. The leg opens only after the server
    // answers, and by then iOS Safari no longer counts this as a gesture and
    // will not prompt. Held until the leg has its own, then released.
    const mic: Promise<MediaStream | null> = typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
      : Promise.resolve(null);
    let handed = false;
    try {
      const result = await act(async () => {
        // Point the campaign at the quietest line before Next. `next` itself
        // does not take a caller id, and a dedicated pin would burn one number
        // across the whole list. One line, or no campaign loaded yet, dials
        // on whatever the server already has.
        const camp = campaign;
        if (camp && orgNumbers.length > 0) {
          const from = await spinOrgCallerId({
            lines: orgNumbers,
            dest: null,
            load: recentOutboundFromNumbers,
            linePools,
          });
          if (from?.notice) setError(from.notice);
          if (from && camp.settings.callerIdPhoneNumberId !== from.id) {
            const updated = await api.updateCampaign(camp.id, {
              settings: { ...camp.settings, callerIdPhoneNumberId: from.id },
            }).catch(() => null);
            if (updated) setCampaign(updated.campaign);
          }
        }
        return api.dialSessionNext(currentId);
      });
      if (!result) return;
      if (result.idle) {
        setIdle(idleSentence(result.reason));
        setBackground([]);
        return;
      }
      // Power and progressive dial one line. Predictive rings more than one
      // on the server, which bridges whoever answers first and abandons the
      // other. This browser can hold one of those lines.
      const line = winnerLine(result.lines);
      if (!line) {
        setIdle(idleSentence(undefined));
        return;
      }
      setCard(line.card);
      // Other parallel lines stay on the server; keep them so the bar can show
      // who else is still ringing while this browser talks to the winner.
      setBackground(
        (result.lines ?? [])
          .filter((l) => l.call.id !== line.call.id)
          .map((l) => ({
            callId: l.call.id,
            name: l.card?.contact?.display_name
              || l.call.contact_name
              || l.call.to_number
              || 'Lead',
            status: l.call.status || 'ringing',
          })),
      );
      // Before the leg, so the screen is on the call while it is still ringing.
      onCallOpened?.(line.call);
      try {
        await spConnect(line.call, mic);
        handed = true;
      } catch (err) {
        // The call exists on the server whatever this browser managed; say what
        // went wrong, and take the screen back off a call nobody is on.
        setError(err instanceof Error ? err.message : 'Could not open the call in this browser.');
        onCallFailed?.();
      }
    } finally {
      // The softphone keeps the stream until hangup once the leg is up.
      // Stopping it here, while the call is live, is what leaves the mic on.
      if (!handed) void mic.then((s) => s?.getTracks().forEach((t) => t.stop()));
    }
  }, [act, currentId, extensionHasPhone, spConnect, onCallOpened, onCallFailed, campaign, orgNumbers, linePools]);

  const action = useCallback(
    (kind: 'pause' | 'resume' | 'end') => async () => {
      if (!currentId) return;
      const result = await act(() => api.dialSessionAction(currentId, kind));
      if (!result) return;
      setSession(kind === 'end' ? null : result.session);
      if (kind === 'end') {
        const restoreId = result.session.campaign_id;
        const prior = takeCampaignRestore(restoreId);
        if (prior) void api.updateCampaign(restoreId, { mode: prior.mode, settings: prior.settings }).catch(() => undefined);
        setCampaign(null);
        setCard(null);
        setRemaining(null);
        setBackground([]);
        setIdle(null);
        setCapNote(null);
      }
    },
    [act, currentId],
  );

  const pause = useMemo(() => action('pause'), [action]);
  const resume = useMemo(() => action('resume'), [action]);
  const end = useMemo(() => action('end'), [action]);

  // A finished call means the counters moved and the next lead is dialable.
  // Re-read rather than guess, because progressive advances on the server —
  // and after a beat, because Talkr finalises duration and disposition once
  // the leg has dropped, so reading too early reads a half-written call.
  const phase = sp.phase;
  const wasInCall = useRef(false);
  useEffect(() => {
    if (phase === 'in_call') wasInCall.current = true;
    if (phase !== 'idle' || !wasInCall.current || !currentId) return;
    wasInCall.current = false;
    setBackground([]);
    const t = setTimeout(refresh, 1500);
    return () => clearTimeout(t);
  }, [phase, currentId, refresh]);

  return useMemo(
    () =>
      enabled
        ? { session, campaign, card, campaigns, remaining, background, idle, error, busy, start, next, pause, resume, end, refresh, reloadCampaigns, machines, capNote }
        : EMPTY_DIAL_SESSION,
    [enabled, session, campaign, card, campaigns, remaining, background, idle, error, busy, start, next, pause, resume, end, refresh, reloadCampaigns, machines, capNote],
  );
}
