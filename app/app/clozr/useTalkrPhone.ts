// The phone, for real.
//
// `useClozr` renders the dialer, the Talkr screen and the phone settings from
// a view-model; this hook is where that view-model's phone facts come from
// when the workspace is signed in. It owns:
//
//   - the softphone (lib/softphone.ts: Talkr's Twilio media leg),
//   - the live transcript (lib/live-transcript.ts: both legs → Deepgram),
//   - seller intelligence, asked of Talkr on every seller turn,
//   - the post-call card (Talkr's summary over the transcript we heard, or
//     the durable AI notes from the recording once they exist),
//   - Talkr's conversations, recent calls, dispositions, team and numbers.
//
// The demo (no Supabase) never calls this hook's network paths: `enabled` is
// false and `useClozr` keeps its scripted call, so the prototype still works
// without an account.
'use client';

import { liveCallerBlock, mergeLineProviders, type LinePools } from '@/lib/caller-spin';
import { pushCallerIdPick, reconcileCallerId } from '@/lib/caller-id-link';
import { loadLinePools } from '@/lib/line-pools';
import { useSession } from '@/lib/session';
import { getSmsFrom } from '@/lib/sms-from';
import { replyLine, sendsAsSelf } from '@/lib/thread-line';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSoftphone, refusalText, type Softphone } from '@/lib/softphone';
import { mayAutoAcquirePhone } from '@/lib/softphone-lock';
import { onExtensionCall, useTalkrExtension, type ExtensionState } from '@/lib/talkr-extension';
import { useDialSession, type DialSession } from './useDialSession';
import { useLiveTranscript, type LiveTranscript } from '@/lib/live-transcript';
import { playEvent } from '@/lib/phone-audio';
import { fileCallOnRecord } from '@/lib/call-file';
import { TALKR_EVENT_TYPES, eventFacts, publishTalkrEvent, type TalkrEvent } from '@/lib/talkr-events';
import { heartbeatStatus, usePresence } from '@/lib/talkr-presence';
import {
  TalkrError,
  areaCity,
  eventStreamUrl,
  keepEventStream,
  formatPhone,
  setTalkrUrl,
  talkr,
  talkrToken,
  toE164,
  type CallDto,
  type ConversationDto,
  type DispositionDto,
  type HistoryItemDto,
  type IntelContext,
  type IntelTurn,
  type LiveIntelDto,
  type MeDto,
  type MessageDto,
  type PhoneNumberDto,
  type SummaryIntelDto,
  type TeamMemberDto,
} from '@/lib/talkr';

export type RecordTarget = { workspaceId: number; sellerId: number | null; buyerId: number | null; dealId: number | null };

export type TalkrStatus = 'off' | 'loading' | 'ok' | 'unlinked' | 'unreachable' | 'error';

export type PhoneData = {
  status: TalkrStatus;
  error: string | null;
  me: MeDto | null;
  dispositions: DispositionDto[];
  recent: CallDto[];
  history: HistoryItemDto[];
  team: TeamMemberDto[];
  convs: ConversationDto[];
  msgs: Record<string, MessageDto[]>;
  unread: number;
};

const NO_ORG_NUMBERS: NonNullable<MeDto['org_numbers']> = [];

/**
 * Under this many seconds, with the transcriber running and nothing heard, a
 * call was a voicemail greeting rather than a conversation. Long enough to
 * cover "hello? — sorry, wrong number", short enough that a real call never
 * lands inside it.
 */
const NO_ANSWER_SECONDS = 25;

const EMPTY: PhoneData = {
  status: 'off', error: null, me: null, dispositions: [], recent: [], history: [], team: [], convs: [], msgs: {}, unread: 0,
};

/** The four chips the dialer shows, mapped onto whatever the org's dispositions are called. */
const CHIP_MATCH: Record<string, RegExp> = {
  'Interested': /interest(?!.*not)|hot|warm|motivated/i,
  'Appointment set': /appoint|walk/i,
  'Callback': /call.?back|follow/i,
  'Not interested': /not.?interest|dead|no\b/i,
};

/** Talkr's timestamps, in the words the dialer uses. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const d = new Date(t);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** "$235,000" out of "235K" / "$235k" / "235,000" / "two thirty five" (no). Null when no number is in the text. */
export function parseMoney(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /\$?\s*(\d{1,3}(?:[,\d]{0,7})(?:\.\d+)?)\s*([kK])?/.exec(text);
  if (!m) return null;
  let n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (m[2]) n *= 1000;
  // "235" on its own in a house-price conversation means $235,000.
  if (!m[2] && n < 2000) n *= 1000;
  return n >= 10_000 ? Math.round(n) : null;
}

export type TalkrPhone = {
  enabled: boolean;
  data: PhoneData;
  sp: Softphone;
  tx: LiveTranscript;
  /** Live seller intelligence for the call in progress. */
  intel: LiveIntelDto | null;
  intelBusy: boolean;
  /** The post-call card. Null while it is being produced. */
  summary: SummaryIntelDto | null;
  /** `no_answer`: nobody picked up, so there is nothing to transcribe or summarise. */
  summaryStatus: 'idle' | 'working' | 'ready' | 'unavailable' | 'no_answer';
  /** What the rep sees as caller ID right now. */
  callerId: { id: string | null; label: string; city: string | null; mode: 'dedicated' | 'local_presence' };
  callerIdOptions: Array<{ id: string; label: string; city: string | null; mine: boolean; isDefault: boolean; blocked: string | null }>;
  setCallerId: (numberId: string) => Promise<void>;
  /** The transcript as Talkr's intel endpoint wants it. */
  turns: IntelTurn[];
  /** Re-reads the lists that move (threads, recent calls, call history); not the reference data. */
  refresh: () => void;
  /** Starts over: who the rep is on Talkr, their numbers, dispositions and team, then the lists. */
  retry: () => void;
  /** Loads a thread. Reading it is not opening it: only `markRead` clears its unread count. */
  loadMessages: (conversationId: string) => void;
  markRead: (conversationId: string) => void;
  sendSms: (input: { conversation_id?: string; to_number?: string; body: string }) => Promise<boolean>;
  /**
   * Log the wrap-up disposition on Talkr. Resolves to the label used, or null
   * when Talkr has no match. A chip ("Interested", "Callback") is matched onto
   * the org's list and swallows its error; `pick` names the disposition
   * outright (a call outcome already matched it), carries the follow-up time,
   * and rethrows so the caller can say what failed.
   */
  disposition: (chip: string, note?: string, pick?: { slug: string; follow_up_at?: string; callId?: string }) => Promise<string | null>;
  /** Supplies what the CRM knows about the party so the model does not re-ask it. */
  setContext: (ctx: IntelContext | null) => void;
  /** The record the call in progress is filed on at hang-up (lib/call-file.ts). */
  setRecordTarget: (target: RecordTarget | null) => void;
  /** The communications row the last call was filed on, once it is. */
  filedCommId: number | null;
  /** Clears everything about the last call; the dialer is idle again. */
  reset: () => void;
  /**
   * The Talkr Chrome extension, when it is installed and signed in here. While
   * it holds the softphone this tab does not register one, so the dialer says
   * where the call is actually running instead of looking broken.
   */
  extension: ExtensionState;
  /** The power dialer: a session over a campaign, and the Next that walks it. */
  session: DialSession;
};

export function useTalkrPhone({
  enabled,
  talkrUrl,
  aiEnabled,
  onCallOpened,
  onCallFailed,
}: {
  enabled: boolean;
  talkrUrl: string | null;
  /** The "AI transcription" toggle: off means no audio leaves the browser and no intel is asked for. */
  aiEnabled: boolean;
  /** A call the power dialer opened, so `useClozr` can put the screen on it. */
  onCallOpened?: (call: CallDto) => void;
  /** That call's leg could not be opened here, so the screen comes back off it. */
  onCallFailed?: () => void;
}): TalkrPhone {
  const [data, setData] = useState<PhoneData>(EMPTY);
  const [intel, setIntel] = useState<LiveIntelDto | null>(null);
  const [intelBusy, setIntelBusy] = useState(false);
  const [summary, setSummary] = useState<SummaryIntelDto | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<TalkrPhone['summaryStatus']>('idle');
  const [nonce, setNonce] = useState(0);
  const contextRef = useRef<IntelContext | null>(null);
  const targetRef = useRef<RecordTarget | null>(null);
  /** The target as it was when the call connected; the screen may move on before wrap-up. */
  const callTargetRef = useRef<RecordTarget | null>(null);
  const [filedCommId, setFiledCommId] = useState<number | null>(null);
  const intelSeq = useRef(0);
  const summaryFor = useRef<string | null>(null);

  const sp = useSoftphone({ enabled });
  const meIdRef = useRef<string | null>(null);
  /** The call up in this tab, for the event filter. */
  const callIdRef = useRef<string | null>(null);
  const liveCallId = sp.call?.id ?? null;
  useEffect(() => { callIdRef.current = liveCallId; }, [liveCallId]);
  const talkrOrgRef = useRef<string | null>(null);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  const providersRef = useRef<Array<{ id: string; provider: string | null }>>([]);
  const auth = useSession();
  const workspaceId = auth.workspace?.id ?? null;
  const userId = auth.user?.id ?? null;
  const [linePools, setLinePools] = useState<LinePools>({});
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadLinePools(workspaceId).then((pools) => { if (live) setLinePools(pools); });
    return () => { live = false; };
  }, [enabled, workspaceId]);
  useEffect(() => {
    meIdRef.current = data.me?.id ?? null;
    talkrOrgRef.current = data.me?.org?.id ?? null;
  }, [data.me?.id, data.me?.org?.id]);
  const tx = useLiveTranscript();

  useEffect(() => setTalkrUrl(talkrUrl), [talkrUrl]);

  // How many times in a row Talkr has been unreachable: the backoff's step.
  // A ref, so resetting it does not run the bootstrap again.
  const unreachableRuns = useRef(0);
  const retry = useCallback(() => { unreachableRuns.current = 0; setNonce((n) => n + 1); }, []);

  // The lists that move: threads, recent calls and call history. Three reads,
  // not the seven-request bootstrap below, which runs once per sign-in.
  // Calls close together (a text sent, then the wrap-up) share one read.
  const listsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listsSeq = useRef(0);
  const readLists = useCallback(() => {
    const seq = ++listsSeq.current;
    void Promise.all([
      talkr.conversations({ limit: 60 }).catch(() => null),
      talkr.calls().catch(() => null),
      talkr.history({ type: 'calls', limit: 40 }).catch(() => null),
    ]).then(([convs, calls, hist]) => {
      if (seq !== listsSeq.current) return;
      setData((d) => (d.status !== 'ok' ? d : {
        ...d,
        ...(convs ? { convs: convs.conversations, unread: convs.counts.unread } : {}),
        ...(calls ? { recent: calls.calls.slice(0, 12) } : {}),
        ...(hist ? { history: hist.items } : {}),
      }));
    });
  }, []);
  const refresh = useCallback(() => {
    if (listsTimer.current) clearTimeout(listsTimer.current);
    listsTimer.current = setTimeout(() => { listsTimer.current = null; readLists(); }, 300);
  }, [readLists]);
  useEffect(() => () => { if (listsTimer.current) clearTimeout(listsTimer.current); }, []);

  // ---- who am I on Talkr, and the reference data the dialer reads ----------
  // Talkr unreachable (a deploy, a network blip) tries again on its own, 5 s
  // doubling to five minutes; a refusal (unlinked, 4xx) waits for Retry.
  const [backoffTick, setBackoffTick] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setData(EMPTY);
      return;
    }
    let live = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    setData((d) => (d.status === 'ok' ? d : { ...d, status: 'loading' }));
    void (async () => {
      try {
        const [meRaw, listed] = await Promise.all([
          talkr.me(),
          talkr.numbers().catch(() => ({ numbers: [] as PhoneNumberDto[] })),
        ]);
        if (!live) return;
        const me: MeDto = {
          ...meRaw,
          org_numbers: mergeLineProviders(meRaw.org_numbers ?? [], listed.numbers),
        };
        providersRef.current = listed.numbers.map((n) => ({ id: n.id, provider: n.provider ?? null }));
        const [disp, calls, hist, team, convs] = await Promise.all([
          talkr.dispositions().catch(() => ({ dispositions: [] as DispositionDto[] })),
          talkr.calls().catch(() => ({ calls: [] as CallDto[] })),
          talkr.history({ type: 'calls', limit: 40 }).catch(() => ({ items: [] as HistoryItemDto[] })),
          talkr.team().catch(() => ({ members: [] as TeamMemberDto[] })),
          talkr.conversations({ limit: 60 }).catch(() => ({ conversations: [] as ConversationDto[], total: 0, counts: { unread: 0 } })),
        ]);
        if (!live) return;
        unreachableRuns.current = 0;
        setData((d) => ({
          ...d,
          status: 'ok',
          error: null,
          me,
          dispositions: disp.dispositions,
          recent: calls.calls.slice(0, 12),
          history: hist.items,
          team: team.members,
          convs: convs.conversations,
          unread: convs.counts.unread,
        }));
      } catch (err) {
        if (!live) return;
        const status: TalkrStatus =
          err instanceof TalkrError ? (err.status === 401 || err.code === 'unlinked' ? 'unlinked' : err.status === 0 ? 'unreachable' : err.status >= 500 ? 'unreachable' : 'error') : 'error';
        setData((d) => ({ ...d, status, error: refusalText(err) }));
        if (status === 'unreachable') {
          const step = unreachableRuns.current++;
          again = setTimeout(() => setBackoffTick((n) => n + 1), Math.min(300_000, 5_000 * 2 ** Math.min(step, 6)));
        }
      }
    })();
    return () => {
      live = false;
      if (again) clearTimeout(again);
    };
    // The backoff timer moving `backoffTick` is what re-runs this.
  }, [enabled, nonce, talkrUrl, backoffTick]);

  // ---- realtime: Talkr's SSE nudges a refetch of what changed --------------
  // One stream per signed-in tab. Every event is published on lib/talkr-events
  // for the Inbox, which used to open two more streams of its own.
  //
  // The bus carries the whole org: every teammate's texts and calls. Only an
  // event about this rep (their user id, one of their lines, the conversation
  // or call they have open, their dial session) re-reads the lists at once;
  // anything else is folded into one read a minute, which keeps a manager's
  // unread count honest without a refetch per teammate's dial.
  const sessionRefreshRef = useRef<() => void>(() => undefined);
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || data.status !== 'ok') return;
    let soon: ReturnType<typeof setTimeout> | null = null;
    let later: ReturnType<typeof setTimeout> | null = null;
    const now = () => {
      if (soon) clearTimeout(soon);
      if (later) { clearTimeout(later); later = null; }
      soon = setTimeout(() => {
        soon = null;
        readLists();
        // Counters and card move under us in progressive / predictive — re-read.
        if (sessionIdRef.current) sessionRefreshRef.current();
      }, 400);
    };
    const eventually = () => {
      if (soon || later) return;
      later = setTimeout(() => { later = null; readLists(); }, 60_000);
    };
    const mine = (e: TalkrEvent) => {
      const f = eventFacts(e);
      const meId = meIdRef.current;
      if (meId && f.userIds.includes(meId)) return true;
      if (f.sessionId && f.sessionId === sessionIdRef.current) return true;
      if (f.callId && f.callId === callIdRef.current) return true;
      const d = dataRef.current;
      if (f.numbers.length) {
        const own = new Set((d.me?.numbers ?? []).map((n) => n.phone_e164.replace(/\D/g, '').slice(-10)));
        if (f.numbers.some((n) => own.has(n))) return true;
      }
      // A thread already in this rep's list (a rep's list is their own threads).
      return !!f.conversationId && d.convs.some((c) => c.id === f.conversationId && (!c.assigned_user_id || c.assigned_user_id === meId));
    };
    // Talkr's bus events carry the user they are for. One that names nobody is
    // not announced: a teammate's text or voicemail stays with them (the bell
    // still lists the rep's own, by the line it came in on).
    const forMe = (e: TalkrEvent) => {
      const meId = meIdRef.current;
      return !!meId && eventFacts(e).userIds.includes(meId);
    };
    const stop = keepEventStream(async () => {
      const token = await talkrToken();
      return token ? eventStreamUrl(token) : null;
    }, (es) => {
      for (const type of TALKR_EVENT_TYPES) {
        es.addEventListener(type, (raw) => {
          const e = publishTalkrEvent(type, (raw as MessageEvent).data);
          // message.received is only ever an inbound text (services/messages.ts).
          if (type === 'message.received' && forMe(e)) playEvent('sms');
          if (type === 'voicemail.left' && forMe(e)) playEvent('voicemail');
          if (type === 'voicemail.left') return;
          if (mine(e)) now(); else eventually();
        });
      }
    });
    return () => {
      if (soon) clearTimeout(soon);
      if (later) clearTimeout(later);
      stop();
    };
  }, [enabled, data.status, readLists]);

  // The Talkr extension is the same phone in a window that outlives this tab.
  // When it is holding the softphone this page must not register a second one
  // under the same identity — two registrations is how an inbound call rings
  // in a window nobody is looking at.
  const extension = useTalkrExtension();
  const extensionHasPhone = extension.holdingSoftphone;

  // The power dialer. Talkr picks who to ring (suppression, attempt caps and
  // the lead's calling window are all selection-time server rules); this tab
  // only opens the leg for the call it hands back.
  const linePoolsForSpin = useCallback(() => loadLinePools(workspaceId), [workspaceId]);
  const session = useDialSession({
    enabled: enabled && data.status === 'ok',
    sp,
    extensionHasPhone,
    orgNumbers: data.me?.org_numbers ?? NO_ORG_NUMBERS,
    linePools: linePoolsForSpin,
    onCallOpened,
    onCallFailed,
  });
  sessionRefreshRef.current = session.refresh;
  sessionIdRef.current = session.session?.id ?? null;

  // A call placed in the extension is a call on this rep's Talkr account, so
  // the record owes an entry for it. Talkr has already written the call;
  // re-reading history is what brings it here, and talkr-sync.ts puts it on
  // the seller. Only on 'ended' — a ringing call has nothing to log yet.
  useEffect(() => {
    if (!enabled) return;
    return onExtensionCall((call) => {
      if (call.phase !== 'ended') return;
      // Talkr finalises duration and disposition after the leg drops; a short
      // wait is the difference between logging the call and logging a stub.
      setTimeout(refresh, 2500);
    });
  }, [enabled, refresh]);

  // The softphone connects on its own once Talkr knows who the rep is: a rep
  // who can see the dialer can take a call, no button to press. 'error' is
  // left alone so a bad token does not loop; a drop ('off') reconnects.
  const spDeviceState = sp.deviceState;
  const spInit = sp.initDevice;
  // Not while a call is up: rebuilding the engine would end it. The phase
  // changing when the call is over runs this again.
  const spPhase = sp.phase;
  const callUp = spPhase === 'connecting' || spPhase === 'ringing' || spPhase === 'in_call';
  useEffect(() => {
    if (!enabled || data.status !== 'ok' || spDeviceState !== 'off') return;
    if (extensionHasPhone || callUp) return;
    // A restored or background tab must not register. Focus and becoming
    // visible try again; initDevice itself also refuses while hidden.
    const tryAuto = () => {
      if (!mayAutoAcquirePhone(document)) return;
      void spInit().catch(() => undefined);
    };
    tryAuto();
    document.addEventListener('visibilitychange', tryAuto);
    window.addEventListener('focus', tryAuto);
    return () => {
      document.removeEventListener('visibilitychange', tryAuto);
      window.removeEventListener('focus', tryAuto);
    };
  }, [enabled, data.status, spDeviceState, spInit, extensionHasPhone, callUp]);

  // The guard above only stops a new registration. A tab that registered
  // before the extension said it holds the phone has to stand its own down,
  // or both ring. A call in progress here finishes first: the release is
  // refused until it is over, and this runs again when the phase changes.
  const spRelease = sp.releaseDevice;
  useEffect(() => {
    if (!extensionHasPhone || spDeviceState !== 'ready') return;
    if (spPhase !== 'idle') return;
    spRelease();
  }, [extensionHasPhone, spDeviceState, spPhase, spRelease]);

  // Presence: Talkr's floor and transfer lists show who can take a call. The
  // extension sends its own heartbeat while it holds the phone, so this tab
  // going quiet is the truth rather than a gap. What it sends is what the rep
  // picked (lib/talkr-presence), never a blanket Available over their Away.
  const presence = usePresence();
  const phoneReady = sp.deviceState === 'ready';
  useEffect(() => {
    if (!enabled || data.status !== 'ok' || extensionHasPhone) return;
    const status = heartbeatStatus(presence, phoneReady);
    const beat = () => void talkr.heartbeat(status).catch(() => undefined);
    beat();
    const id = setInterval(beat, 30_000);
    return () => clearInterval(id);
  }, [enabled, data.status, phoneReady, extensionHasPhone, presence]);
  // Offline once, when this tab stops speaking for the rep, not on every change of presence.
  useEffect(() => {
    if (!enabled || data.status !== 'ok' || extensionHasPhone) return;
    return () => { void talkr.heartbeat('offline').catch(() => undefined); };
  }, [enabled, data.status, extensionHasPhone]);

  // Do not disturb: a call that rings here is declined, so the caller reaches
  // voicemail and nothing rings over what the rep is doing.
  const ringing = sp.incoming;
  const declineIncoming = sp.rejectIncoming;
  useEffect(() => {
    if (presence === 'dnd' && ringing) declineIncoming();
  }, [presence, ringing, declineIncoming]);

  // ---- the live transcript follows the call ---------------------------------
  const inCall = sp.phase === 'in_call';
  const { status: txStatus, start: txStart } = tx;
  useEffect(() => {
    if (!inCall || !aiEnabled) return;
    if (txStatus !== 'idle') return;
    // The SDK exposes the streams a beat after `accept`; start polls the getter.
    const t = setTimeout(() => void txStart(() => sp.getStreams()), 250);
    return () => clearTimeout(t);
  }, [inCall, aiEnabled, txStatus, txStart, sp]);

  // A dropped socket mid-call gets two more tries, a few seconds apart; a
  // refused key says so and stops, since retrying cannot change the answer.
  const txRetries = useRef(0);
  useEffect(() => {
    if (!inCall) { txRetries.current = 0; return; }
    if (tx.status !== 'error' || txRetries.current >= 2 || /refused the transcription key|could not get a Deepgram key/i.test(tx.error ?? '')) return;
    const t = setTimeout(() => { txRetries.current += 1; tx.stop(); }, 4000);
    return () => clearTimeout(t);
  }, [inCall, tx]);

  useEffect(() => {
    if (inCall) return;
    if (tx.status !== 'idle') tx.stop();
  }, [inCall, tx]);

  const turns: IntelTurn[] = useMemo(
    () => tx.lines.map((l) => ({ speaker: l.speaker === 'rep' ? 'rep' : 'seller', text: l.text })),
    [tx.lines],
  );

  // ---- seller intelligence on every seller turn -----------------------------
  const callId = sp.call?.id ?? null;
  useEffect(() => {
    if (!inCall || !aiEnabled || !callId || tx.sellerTurns === 0) return;
    const seq = ++intelSeq.current;
    const t = setTimeout(() => {
      setIntelBusy(true);
      const elapsed = sp.startedAt ? Math.round((Date.now() - sp.startedAt) / 1000) : undefined;
      void talkr
        .intel(callId, { mode: 'live', turns: turns.slice(-40), context: contextRef.current ?? undefined, elapsed_seconds: elapsed })
        .then((r) => {
          if (intelSeq.current === seq) setIntel(r);
        })
        .catch(() => undefined)
        .finally(() => {
          if (intelSeq.current === seq) setIntelBusy(false);
        });
    }, 500);
    return () => clearTimeout(t);
    // `turns` is what changed when sellerTurns did; keying on the counter keeps
    // a rep-only turn from re-asking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.sellerTurns, inCall, aiEnabled, callId]);

  // ---- the post-call card ------------------------------------------------------
  useEffect(() => {
    if (sp.phase !== 'wrapup' || !callId || summaryFor.current === callId) return;
    summaryFor.current = callId;
    setSummary(null);

    // Straight to voicemail.
    //
    // A voicemail box answers exactly like a person does, so the carrier calls
    // the call "completed" and the duration clock runs: the status never says
    // nobody picked up. What says it is that nothing came back. A call that
    // ended almost as soon as it connected, with the transcriber listening and
    // not one word captured from the other side, was a greeting and a hang-up.
    //
    // Claiming to transcribe that is worse than saying nothing: the rep waits
    // through half a minute of "summarising…" to be told there is no summary,
    // and is offered CRM changes drawn from silence.
    //
    // Only when the transcriber was actually running, because with it off no
    // turns is the normal state of every call, however long and real.
    const seconds = sp.call?.duration_seconds ?? (sp.startedAt ? Math.round((Date.now() - sp.startedAt) / 1000) : 0);
    // The ring guard hung up because the seller's line rang out, was busy, or
    // never rang (lib/ring-guard.ts): nobody was there, whatever the clock says.
    if (sp.ringOut || (aiEnabled && turns.length === 0 && seconds > 0 && seconds < NO_ANSWER_SECONDS)) {
      setSummaryStatus('no_answer');
      return;
    }

    setSummaryStatus('working');
    let live = true;
    void (async () => {
      // What we heard, summarised now.
      if (aiEnabled && turns.length > 0) {
        try {
          const r = await talkr.intel(callId, { mode: 'summary', turns, context: contextRef.current ?? undefined });
          if (!live) return;
          setSummary(r);
          setSummaryStatus('ready');
          return;
        } catch {
          /* fall through to the durable notes */
        }
      }
      // Otherwise wait for Talkr's own recording → transcript → notes.
      for (let i = 0; i < 8 && live; i++) {
        try {
          const t = await talkr.transcript(callId);
          if (!live) return;
          if (!t.configured && !t.summary_configured) break;
          if (t.transcript?.status === 'completed' && t.transcript.summary) {
            const ai = t.transcript.ai;
            const ratio = ai.rep_talk_ratio != null ? Math.round(ai.rep_talk_ratio * 100) : null;
            setSummary({
              mode: 'summary',
              talk_ratio: ratio != null ? { rep: ratio, seller: 100 - ratio } : null,
              summary: t.transcript.summary,
              sentiment: (ai.sentiment as SummaryIntelDto['sentiment']) ?? 'neutral',
              motivation: ai.seller_motivation ?? null,
              timeline: ai.timeline ?? null,
              price_expectation: ai.asking_price ?? null,
              objection: ai.objections?.[0] ?? null,
              condition: null,
              follow_up: ai.next_step ?? null,
              suggested_task: ai.next_step ?? null,
            });
            setSummaryStatus('ready');
            return;
          }
          if (t.transcript?.status === 'failed') break;
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
      if (live) setSummaryStatus('unavailable');
    })();
    return () => {
      live = false;
    };
  }, [sp.phase, callId, aiEnabled, turns, sp.startedAt, sp.call?.duration_seconds, sp.ringOut]);

  // A finished call belongs in Recent straight away.
  useEffect(() => {
    if (sp.phase === 'wrapup' && enabled) refresh();
  }, [sp.phase, enabled, refresh]);

  // ---- the call, filed on its record -----------------------------------------
  // Pin the record when the call connects: by wrap-up the screen may already
  // be on the next lead of a power-dialer session.
  useEffect(() => {
    if (inCall) callTargetRef.current = targetRef.current;
  }, [inCall, callId]);

  // At hang-up with what was heard, then again once the summary is ready.
  // call-coach finds this row by the Talkr id, so the hang-up scorecard is
  // stored on it rather than lost when the two-minute mirror has not run yet.
  const filedFor = useRef<string | null>(null);
  useEffect(() => {
    if (sp.phase !== 'wrapup' || !callId || !sp.call) return;
    const target = callTargetRef.current ?? targetRef.current;
    if (!target) return;
    const withSummary = summaryStatus === 'ready' && summary ? 'summary' : 'lines';
    const key = `${callId}:${withSummary}`;
    if (filedFor.current === key || (withSummary === 'lines' && filedFor.current === `${callId}:summary`)) return;
    filedFor.current = key;
    const call = sp.call;
    const offsetS = tx.startedAt && sp.startedAt ? Math.max(0, (tx.startedAt - sp.startedAt) / 1000) : 0;
    void fileCallOnRecord({
      workspaceId: target.workspaceId,
      talkrCallId: callId,
      sellerId: target.sellerId,
      buyerId: target.buyerId,
      dealId: target.dealId,
      direction: call.direction,
      fromPhone: call.from_number,
      toPhone: call.to_number,
      occurredAt: call.answered_at ?? call.created_at ?? new Date().toISOString(),
      durationS: call.duration_seconds ?? (sp.startedAt ? Math.round((Date.now() - sp.startedAt) / 1000) : null),
      status: call.status,
      lines: tx.lines.map((l) => ({ speaker: l.speaker, text: l.text, start: l.start, end: l.end })),
      offsetS,
      summary: withSummary === 'summary' ? summary : null,
      talkrOrgId: talkrOrgRef.current,
    }).then((r) => {
      if (r.ok) setFiledCommId(r.id);
      else console.error('could not file the call on the record', r.message);
    });
    // tx.lines is final by wrap-up; keying on it would refile on reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp.phase, callId, summaryStatus, summary]);

  // ---- caller ID -------------------------------------------------------------
  const me = data.me;
  const callerId = useMemo(() => {
    const all = me?.org_numbers ?? [];
    const chosen = all.find((n) => n.id === me?.default_phone_number_id) ?? me?.numbers[0] ?? all[0] ?? null;
    if (!me) return { id: null, label: 'Talkr', city: null, mode: 'dedicated' as const };
    if (me.caller_id_mode === 'local_presence') return { id: chosen?.id ?? null, label: 'local presence', city: null, mode: 'local_presence' as const };
    if (!chosen) return { id: null, label: 'no number yet', city: null, mode: 'dedicated' as const };
    return { id: chosen.id, label: formatPhone(chosen.phone_e164), city: areaCity(chosen.phone_e164), mode: 'dedicated' as const };
  }, [me]);

  const callerIdOptions = useMemo(
    () =>
      (me?.org_numbers ?? []).map((n) => ({
        id: n.id,
        label: n.label ? `${formatPhone(n.phone_e164)} · ${n.label}` : formatPhone(n.phone_e164),
        city: areaCity(n.phone_e164),
        mine: n.assigned_user_id === me?.id,
        isDefault: n.id === me?.default_phone_number_id,
        blocked: liveCallerBlock(n, linePools),
      })),
    [me, linePools],
  );

  const setCallerId = useCallback(async (numberId: string) => {
    try {
      const next = numberId === 'local_presence'
        ? await talkr.updateMe({ caller_id_mode: 'local_presence' })
        : await talkr.updateMe({ caller_id_mode: 'dedicated', default_phone_number_id: numberId });
      setData((d) => ({
        ...d,
        me: { ...next, org_numbers: mergeLineProviders(next.org_numbers ?? [], providersRef.current) },
      }));
      // The line last dialed from becomes the default on both sides.
      if (numberId !== 'local_presence') {
        void pushCallerIdPick({
          workspaceId,
          userId,
          talkrOrgId: next.org?.id,
          phone: next.org_numbers?.find((n) => n.id === numberId)?.phone_e164,
        });
      }
    } catch (err) {
      setData((d) => ({ ...d, error: refusalText(err) }));
    }
  }, [workspaceId, userId]);

  // Once per workspace and Talkr seat: Talkr's default (what dials) wins,
  // CLOZR's caller ID fills in a Talkr seat that has none.
  const reconciledFor = useRef<string | null>(null);
  useEffect(() => {
    if (data.status !== 'ok' || !me || !workspaceId || !userId) return;
    const key = `${workspaceId}:${userId}:${me.id}`;
    if (reconciledFor.current === key) return;
    reconciledFor.current = key;
    void reconcileCallerId({ workspaceId, userId, me }).then((next) => {
      if (!next) return;
      setData((d) => ({
        ...d,
        me: { ...next, org_numbers: mergeLineProviders(next.org_numbers ?? [], providersRef.current) },
      }));
    });
  }, [data.status, me, workspaceId, userId]);

  // ---- messaging -------------------------------------------------------------
  const loadMessages = useCallback((conversationId: string) => {
    void talkr.messages(conversationId).then((r) => {
      setData((d) => ({ ...d, msgs: { ...d.msgs, [conversationId]: r.messages } }));
    }).catch(() => undefined);
  }, []);
  const markRead = useCallback((conversationId: string) => {
    setData((d) => {
      const was = d.convs.find((c) => c.id === conversationId)?.unread_count ?? 0;
      if (!was) return d;
      return { ...d, unread: Math.max(0, d.unread - 1), convs: d.convs.map((c) => (c.id === conversationId ? { ...c, unread_count: 0 } : c)) };
    });
    void talkr.markRead(conversationId).catch(() => undefined);
  }, []);

  const sendSms = useCallback<TalkrPhone['sendSms']>(async (input) => {
    try {
      // The CRM-wide send-from pick, unless the caller named a line. With no
      // pick the TC still replies on her own line, not the rep's thread line.
      let from = getSmsFrom();
      if (!from && sendsAsSelf() && input.conversation_id) {
        const { me, convs } = dataRef.current;
        const conv = convs.find((c) => c.id === input.conversation_id);
        if (me && conv) from = replyLine(me, conv.our_number ?? null, true);
      }
      const r = await talkr.sendMessage(from ? { ...input, from_phone_number_id: from } : input);
      setData((d) => ({
        ...d,
        msgs: { ...d.msgs, [r.conversation_id]: [...(d.msgs[r.conversation_id] ?? []), r.message] },
      }));
      refresh();
      return true;
    } catch (err) {
      setData((d) => ({ ...d, error: refusalText(err) }));
      return false;
    }
  }, [refresh]);

  // ---- wrap-up -----------------------------------------------------------------
  const disposition = useCallback<TalkrPhone['disposition']>(async (chip, note, pick) => {
    const id = pick?.callId ?? sp.call?.id;
    if (!id) return null;
    if (pick) {
      const named = data.dispositions.find((d) => d.slug === pick.slug);
      await talkr.setDisposition(id, { disposition: pick.slug, note, ...(pick.follow_up_at ? { follow_up_at: pick.follow_up_at } : {}) });
      if (/appoint|appt/i.test(pick.slug) || /appoint|appt/i.test(named?.name ?? '')) playEvent('appointment');
      return named?.name ?? pick.slug;
    }
    const re = CHIP_MATCH[chip];
    const match =
      data.dispositions.find((d) => d.name.toLowerCase() === chip.toLowerCase()) ??
      (re ? data.dispositions.find((d) => re.test(d.name) || re.test(d.slug)) : undefined);
    if (!match) return null;
    try {
      await talkr.setDisposition(id, { disposition: match.slug, note });
      if (/appoint|appt/i.test(match.slug) || /appoint|appt/i.test(match.name)) playEvent('appointment');
      return match.name;
    } catch (err) {
      setData((d) => ({ ...d, error: refusalText(err) }));
      return null;
    }
  }, [data.dispositions, sp.call?.id]);

  const setContext = useCallback((ctx: IntelContext | null) => {
    contextRef.current = ctx;
  }, []);

  const setRecordTarget = useCallback((target: RecordTarget | null) => {
    targetRef.current = target;
  }, []);

  const reset = useCallback(() => {
    sp.finishWrapup();
    tx.reset();
    setIntel(null);
    setSummary(null);
    setSummaryStatus('idle');
    setFiledCommId(null);
    summaryFor.current = null;
    intelSeq.current += 1;
  }, [sp, tx]);

  return useMemo<TalkrPhone>(
    () => ({
      enabled,
      data,
      sp,
      tx,
      intel,
      intelBusy,
      summary,
      summaryStatus,
      callerId,
      callerIdOptions,
      setCallerId,
      turns,
      refresh,
      retry,
      loadMessages,
      markRead,
      sendSms,
      disposition,
      setContext,
      setRecordTarget,
      filedCommId,
      reset,
      extension,
      session,
    }),
    [
      enabled, data, sp, tx, intel, intelBusy, summary, summaryStatus, callerId, callerIdOptions, setCallerId, turns,
      refresh, retry, loadMessages, markRead, sendSms, disposition, setContext, setRecordTarget, filedCommId, reset, extension, session,
    ],
  );
}

export { formatPhone, toE164 };
