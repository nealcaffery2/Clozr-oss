'use client';

/**
 * Talkr Phone: the full-screen phone for iPhone (and any phone-width screen).
 *
 * On a phone this is the one phone there is. It replaces the slide-out
 * dialer, the Dialer screen's phone layout and the incoming-call banner with
 * a single fixed, edge-to-edge surface over the CRM, built from the same
 * Talkr parts the desk uses (Keys, ActiveCall, WrapUpCard, CallContext, the
 * lists) in their phone variants. Only ClozrShell mounts it, and only when
 * V.isMobile — the desk never renders any of this.
 *
 * Four states, picked from the softphone: incoming (over everything), the
 * call, the wrap-up, and idle (Recents / Queue / Keypad / Voicemail / RVM / Live).
 * Done (idle) or Minimise (a call, a wrap-up) is the one way back to the CRM;
 * a minimised call carries on behind a pill above the tab bar that brings the
 * phone back. Exactly one ActiveCall and one WrapUpCard are ever mounted, so
 * the wrap-up's Enter shortcut cannot save a call twice.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { useWakeLock } from '@/app/clozr/useWakeLock';
import { aiTargetFrom, useAiCall } from '@/lib/ai-call';
import { CallClock } from '@/lib/call-clock';
import { PHONE_OTHER_TAB } from '@/lib/softphone-lock';
import { formatPhone, toE164 } from '@/lib/talkr-web/time';
import { ActiveCall } from './ActiveCall';
import { CallContext, defaultCallContextTab, type CallContextTab } from './CallContext';
import { CallerIdPicker, DefaultStar, showsDefault } from './CallerIdPicker';
import { DialSessionBar, DialSessionStart } from './DialSessionBar';
import {
  Keys,
  LiveCallCard,
  NotesCard,
  PhoneNumberDisplay,
  QueueList,
  RecentList,
  RecordingToggles,
  SoftphoneRow,
  TalkrNotSignedIn,
  VoicemailList,
  WrapUpCard,
  dialDigits,
} from './DialerParts';
import { Icon } from './Icon';
import { PhoneSheet, PhoneTabBar, type PhoneTab } from './ios';
import { ProspectTime } from './ProspectTime';
import { useSoftphone } from './softphoneAdapter';
import { LiveCalls, MonitorCard } from './Supervision';
import { RvmPanel } from './RvmPanel';
import '@/app/clozr/talkr-dialer.css';
import { TalkrMark } from '@/app/components/brand/TalkrMark';
import { openReach } from '@/app/components/record/reach';

type DialerTab = 'Dial' | 'Queue' | 'Recent' | 'Voicemail' | 'RVM' | 'Live';
type ContextTab = CallContextTab | 'notes';

/** The Phone app's handset, filled (Icon's phone path, painted rather than stroked). */
function Handset({ size = 32, down = false }: { size?: number; down?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={down ? { transform: 'rotate(135deg)' } : undefined}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

/** iOS's delete key: a filled tag with the × cut out of it. */
function DeleteGlyph() {
  return (
    <svg width="33" height="24" viewBox="0 0 33 24" aria-hidden>
      <path d="M11.2 1.5h18.3a2 2 0 0 1 2 2v17a2 2 0 0 1-2 2H11.2a2 2 0 0 1-1.5-.7L1.8 13.3a2 2 0 0 1 0-2.6l7.9-8.5a2 2 0 0 1 1.5-.7z" fill="var(--on-dark, #fff)" fillOpacity="0.9" />
      <path d="M16.5 7.5l9 9m0-9l-9 9" stroke="#000" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The phone's own history.back() calls still in flight. Their popstate may
 * arrive after the phone that made them is gone (or after the next one has
 * opened), so the count is cleared only once every listener has seen it.
 */
let selfBacks = 0;
function backOutOfPhone() {
  selfBacks += 1;
  window.addEventListener(
    'popstate',
    () => {
      setTimeout(() => {
        selfBacks = Math.max(0, selfBacks - 1);
      }, 0);
    },
    { once: true },
  );
  window.history.back();
}

/**
 * The host. It stays mounted on a phone so the screen stays awake for a call
 * even while the phone is minimised; the surface itself renders only while up.
 */
export function PhoneScreen({ V }: { V: ClozrView }) {
  const { callState } = useSoftphone();
  const session = V.talkrPhone.session.session;
  const sessionRunning = (!!session && session.state !== 'paused') || !!V.queueSession;
  // A locked phone drops the call (iOS suspends the page), so the screen is
  // held awake from dialling to hang-up, while a call rings in, and while a
  // power-dialer session is running.
  useWakeLock(V.isMobile && (callState === 'connecting' || callState === 'ringing' || callState === 'in_call' || !!V.incoming || sessionRunning));
  if (!V.isMobile || !V.phoneUp) return null;
  return <PhoneSurface V={V} />;
}

function PhoneSurface({ V }: { V: ClozrView }) {
  const sp = useSoftphone();
  const { callState, authed, active, team, me, setMe, liveCalls, monitor, deviceState } = sp;
  const rootRef = useRef<HTMLDivElement>(null);
  const [digits, setDigits] = useState('');
  const [sheet, setSheet] = useState<null | 'options' | 'callerid' | 'lead' | 'context' | 'incoming-lead' | 'decline-message'>(null);
  const [ctxTab, setCtxTab] = useState<ContextTab>('lead');
  const [reason, setReason] = useState<string | null>(null);
  const ai = useAiCall(V.templatesWorkspaceId ?? null);
  const aiBusy = ai.busy;
  const aiNote = ai.note;
  /** "Save & next call": the next dial waits until the wrap-up has closed the call. */
  const pendingNext = useRef(false);
  const latest = useRef(V);
  useEffect(() => {
    latest.current = V;
  });

  // ── what the phone is showing ──────────────────────────────────────────
  const incoming = sp.incoming ?? (V.incoming ? { from: V.incoming.e164, talkrCallId: null } : null);
  const inCall = callState === 'connecting' || callState === 'ringing' || callState === 'in_call';
  const mode: 'incoming' | 'monitor' | 'call' | 'wrap' | 'idle' = incoming
    ? 'incoming'
    : monitor
      ? 'monitor'
      : inCall
        ? 'call'
        : callState === 'wrapup'
          ? 'wrap'
          : 'idle';
  const liveTab = liveCalls !== null;
  const tab: DialerTab = V.dialerTab === 'Live' && !liveTab ? 'Dial' : (V.dialerTab as DialerTab);
  const pickTab = (t: DialerTab) => V.dialerTabs.find((x) => x.label === t)?.go();

  // ── the page behind: dark, pinned, and one Back press to leave ─────────
  useEffect(() => {
    const html = document.documentElement;
    html.dataset.phone = 'up';
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      delete html.dataset.phone;
    };
  }, []);
  useEffect(() => {
    // An iOS edge swipe (or Android Back) closes or minimises the phone
    // rather than leaving CLOZR: the phone owns one history entry while up.
    if (!(window.history.state as { clozrPhone?: number } | null)?.clozrPhone) {
      window.history.pushState({ ...((window.history.state as object | null) ?? {}), clozrPhone: 1 }, '', window.location.href);
    }
    let popped = false;
    const onPop = () => {
      if (selfBacks > 0) return;
      popped = true;
      latest.current.minimisePhone();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed by Done or Minimise: take the phone's history entry back out.
      if (!popped && (window.history.state as { clozrPhone?: number } | null)?.clozrPhone) {
        backOutOfPhone();
      }
    };
  }, []);

  // A new call opens its context on the panel's default tab.
  const direction = active?.record.direction;
  useEffect(() => {
    if (direction) setCtxTab(defaultCallContextTab('incall', direction));
  }, [direction]);
  // Sheets belong to the state they were opened in.
  useEffect(() => {
    setSheet(null);
    setReason(null);
  }, [mode]);
  // Back to an empty keypad after a call.
  useEffect(() => {
    if (mode === 'call') setDigits('');
  }, [mode]);
  // The inline reason under the number fades after 3s.
  useEffect(() => {
    if (!reason) return;
    const t = setTimeout(() => setReason(null), 3000);
    return () => clearTimeout(t);
  }, [reason]);
  // "Save & next call" dials once the saved call is really over.
  useEffect(() => {
    if (callState !== 'idle' || !pendingNext.current) return;
    pendingNext.current = false;
    const cur = latest.current;
    if (cur.talkrPhone.session.session) void cur.talkrPhone.session.next();
    else cur.queueSession?.next();
  }, [callState]);

  // ── keypad actions ──────────────────────────────────────────────────────
  const e164 = digits ? toE164(digits) : '';
  const wholeNumber = digits.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').length >= 10;
  const match = wholeNumber ? V.dialerRecordFor(e164) : null;
  const live = V.talkrStatus !== 'demo';
  const canInit = V.talkrStatus === 'ok';
  const callBlocked = deviceState !== 'ready' && !canInit;
  const press = (d: string) => setDigits((cur) => dialDigits(cur + d));

  const lastDialled = (): string => {
    if (authed) {
      const c = sp.recent.find((r) => r.direction === 'outbound') ?? sp.recent[0];
      const raw = c ? (c.direction === 'outbound' ? c.to_number : c.from_number) : '';
      return /^\+1\d{10}$/.test(raw) ? raw.slice(2) : dialDigits(raw);
    }
    return '';
  };
  const call = () => {
    if (!digits) {
      // As on iOS: Call on an empty keypad brings back the last number; a second tap dials it.
      const last = lastDialled();
      if (last) setDigits(last);
      else setReason('Type a number to call.');
      return;
    }
    if (deviceState !== 'ready') {
      if (canInit && (sp.phoneInOtherTab() || sp.deviceError === PHONE_OTHER_TAB)) {
        // Do not ask for the mic and do not say the phone failed to connect.
        // Use phone here, on the row under this, takes the lock.
        void sp.initDevice({ claim: false });
        setReason(PHONE_OTHER_TAB);
      } else if (canInit) {
        // The mic prompt has to come from a tap, so the softphone starts here.
        // A press takes the lock; only the automatic connect backs off.
        void sp.initDevice({ claim: true });
        setReason(deviceState === 'initializing' ? 'Connecting the phone…' : 'Starting the phone — tap Call again in a moment.');
      } else {
        setReason(`Calling is unavailable: ${V.callerIdLabel}.`);
      }
      return;
    }
    V.dialE164(e164);
  };
  const aiCall = async () => {
    if (!e164 || aiBusy) return;
    await ai.start(e164, aiTargetFrom(V.dialerRecordFor(e164)));
  };
  /** Leave the phone for another screen: minimise first so the screen change is seen. */
  const away = (go: () => void) => {
    V.minimisePhone();
    go();
  };
  // A number in hand opens the docked quick text; without one, the inbox.
  const openText = (phone?: unknown) => away(() => (typeof phone === 'string' && phone ? openReach('text', { name: '', phone }) : V.goInbox()));
  const minimiseRecord = <T extends { open: () => void }>(rec: T | null): T | null => (rec ? { ...rec, open: () => away(rec.open) } : null);

  // A hardware keyboard (an iPad, or a desk browser at phone width) types on the keypad.
  const keypadShowing = mode === 'idle' && tab === 'Dial' && !sheet;
  const callRef = useRef(call);
  useEffect(() => {
    callRef.current = call;
  });
  useEffect(() => {
    if (!keypadShowing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      // A tapped key keeps focus; Enter there is a call, not the same digit again.
      const onPad = !!t?.closest?.('[data-dialpad]');
      if (/^[0-9*#+]$/.test(e.key)) {
        setDigits((cur) => (e.key === '+' ? (cur ? cur : '+') : dialDigits(cur + e.key)));
        e.preventDefault();
      } else if (e.key === 'Backspace') {
        setDigits((cur) => cur.slice(0, -1));
        e.preventDefault();
      } else if (e.key === 'Enter' && (t === null || t === document.body || t === rootRef.current || onPad)) {
        callRef.current();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keypadShowing]);

  // Delete: a tap takes one, a hold repeats, a long hold clears.
  const delTimers = useRef<number[]>([]);
  const stopDelete = () => {
    delTimers.current.forEach((t) => window.clearTimeout(t));
    delTimers.current.forEach((t) => window.clearInterval(t));
    delTimers.current = [];
  };
  useEffect(() => stopDelete, []);
  const startDelete = () => {
    stopDelete();
    setDigits((cur) => cur.slice(0, -1));
    delTimers.current.push(
      window.setTimeout(() => {
        delTimers.current.push(window.setInterval(() => setDigits((cur) => cur.slice(0, -1)), 90));
      }, 500),
      window.setTimeout(() => {
        stopDelete();
        setDigits('');
      }, 1800),
    );
  };

  // ── pieces ─────────────────────────────────────────────────────────────
  const sessionOn = !!V.talkrPhone.session.session || !!V.queueSession;
  const sessionLeft = V.talkrPhone.session.session ? V.talkrPhone.session.remaining : V.queueSession?.left ?? null;
  const sessionMode = V.talkrPhone.session.session?.mode ?? V.queueSession?.mode;
  const sessionName = sessionMode && sessionMode !== 'power' ? 'Predictive' : 'Power dialer';
  const tabs: Array<PhoneTab<DialerTab>> = [
    { value: 'Recent', label: 'Recents', icon: 'clock', testId: 'phone-tab-recents' },
    { value: 'Queue', label: 'Queue', icon: 'users', testId: 'phone-tab-queue', badge: sessionLeft ?? V.callQueueCount },
    { value: 'Dial', label: 'Keypad', icon: 'grid', testId: 'phone-tab-keypad' },
    { value: 'Voicemail', label: 'Voicemail', icon: 'voicemail', testId: 'phone-tab-voicemail', badge: V.voicemails.length },
    { value: 'RVM', label: 'RVM', icon: 'mic', testId: 'phone-tab-rvm' },
    ...(liveTab ? [{ value: 'Live' as const, label: 'Live', icon: 'speaker' as const, testId: 'phone-tab-live' }] : []),
  ];
  const tabBar = <PhoneTabBar tabs={tabs} active={tab} onPick={pickTab} />;
  const done = (
    <button type="button" className="phone-textbtn justify-self-start" onClick={V.closePhone}>
      Done
    </button>
  );
  const minimise = (
    <button type="button" className="phone-iconbtn justify-self-start" aria-label="Minimise call" onClick={V.minimisePhone}>
      <Icon name="chevron-down" size={30} strokeWidth={2.2} />
    </button>
  );
  const params = (p: { phone: string } | null) => (authed ? p : null);
  const talkrReady = !(V.talkrStatus !== 'ok' && V.talkrStatus !== 'demo' && V.talkrStatus !== 'loading');

  // ── the states ─────────────────────────────────────────────────────────
  let body: ReactNode;
  let surfaceClass = '';

  if (mode === 'incoming' && incoming) {
    surfaceClass = 'phone-callbg';
    const rec = V.dialerRecordFor(incoming.from);
    const name = V.incoming?.name ?? rec?.name ?? formatPhone(incoming.from);
    const onLine = active?.record.contact_name ?? V.callTarget?.name;
    body = (
      <>
        <div className="flex flex-none flex-col items-center px-6 text-center" style={{ marginTop: 48 }}>
          <span className="inline-flex items-center gap-1.5" style={{ font: '400 13px/1.2 var(--sans)', color: 'rgba(255,255,255,.6)' }}><TalkrMark size={14} color="#fff" />Talkr · incoming call</span>
          <span
            data-testid="incoming-name"
            style={{ marginTop: 8, font: '600 34px/1.12 var(--sans)', color: 'var(--on-dark, #fff)', overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}
          >
            {name}
          </span>
          {name !== formatPhone(incoming.from) && (
            <span style={{ marginTop: 4, font: '400 17px/1.3 var(--sans)', color: 'rgba(255,255,255,.72)' }}>{formatPhone(incoming.from)}</span>
          )}
          <span className="mt-3 flex flex-wrap justify-center gap-1.5">
            {[rec?.stage, rec?.address].filter(Boolean).map((t) => (
              <span key={t} style={{ padding: '5px 10px', borderRadius: 12, background: 'rgba(255,255,255,.12)', font: '500 13px/1.2 var(--sans)', color: '#fff' }}>
                {t}
              </span>
            ))}
            <ProspectTime e164={incoming.from} tone="dark" size={13} className="rounded-xl px-2.5 py-1" />
          </span>
          {(callState === 'wrapup' || inCall) && (
            <span style={{ marginTop: 10, font: '400 13px/1.3 var(--sans)', color: '#FFB340' }}>
              {callState === 'wrapup' ? 'Accepting ends wrap-up' : `You're on a call with ${onLine ?? 'someone'}`}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1" />
        <div className="flex flex-none justify-between" style={{ padding: '0 max(32px, 11vw)' }}>
          <span className="flex w-[78px] flex-col items-center gap-2">
            <button type="button" className="phone-glass" aria-label="Decline and message" onClick={() => setSheet('decline-message')}>
              <Icon name="msg" size={24} />
            </button>
            <span style={{ font: '400 13px/1 var(--sans)' }}>Message</span>
          </span>
          <span className="flex w-[78px] flex-col items-center gap-2">
            <button type="button" className="phone-glass" aria-label="Caller's lead" onClick={() => setSheet('incoming-lead')}>
              <Icon name="user" size={24} />
            </button>
            <span style={{ font: '400 13px/1 var(--sans)' }}>Lead</span>
          </span>
        </div>
        <div className="flex flex-none justify-between" style={{ padding: '28px max(32px, 11vw) max(env(safe-area-inset-bottom, 0px), 40px)' }}>
          <span className="flex flex-col items-center gap-2">
            <button type="button" className="phone-decline" data-testid="incoming-decline" aria-label="Decline" onClick={sp.rejectIncoming}>
              <Handset size={34} down />
            </button>
            <span style={{ font: '400 15px/1 var(--sans)' }}>Decline</span>
          </span>
          <span className="flex flex-col items-center gap-2">
            <button type="button" className="phone-accept" data-testid="incoming-accept" aria-label="Accept" onClick={sp.acceptIncoming}>
              <Handset size={34} />
            </button>
            <span style={{ font: '400 15px/1 var(--sans)' }}>Accept</span>
          </span>
        </div>
        <PhoneSheet open={sheet === 'decline-message'} onClose={() => setSheet(null)} title="Decline and message?">
          <p style={{ font: '400 15px/1.4 var(--sans)', color: 'rgba(255,255,255,.72)', padding: '4px 4px 12px' }}>
            The call goes to the next rep or voicemail, and the inbox opens on {name}.
          </p>
          <button
            type="button"
            className="phone-row"
            style={{ color: '#FF453A', fontWeight: 600 }}
            onClick={() => {
              sp.rejectIncoming();
              away(() => V.goInbox());
            }}
          >
            Decline &amp; message
          </button>
          <button type="button" className="phone-row" onClick={() => setSheet(null)}>
            Cancel
          </button>
        </PhoneSheet>
        <PhoneSheet open={sheet === 'incoming-lead'} onClose={() => setSheet(null)} title={name} tone="light" height="88%">
          <CallContext mode="incoming" params={params({ phone: incoming.from })} record={minimiseRecord(rec)} onText={openText} />
        </PhoneSheet>
      </>
    );
  } else if (mode === 'monitor') {
    surfaceClass = 'phone-callbg';
    body = (
      <>
        <div className="phone-head">
          {minimise}
          <span style={{ font: '600 17px/1 var(--sans)' }}>Listening in</span>
          <span />
        </div>
        <div className="phone-light m-4 min-h-0 flex-1 overflow-auto rounded-[18px]" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
          <MonitorCard />
        </div>
      </>
    );
  } else if (mode === 'call' && active) {
    surfaceClass = 'phone-callbg';
    const last = V.transcript.length ? V.transcript[V.transcript.length - 1] : null;
    const rec = V.callRecord;
    const peek = V.nextBestQuestion || (last ? `${last.who}: ${last.text}` : '') || (rec ? [rec.address, rec.stage].filter(Boolean).join(' · ') : '');
    const activeCallId = authed && active.record.id && active.record.id !== 'unknown' && active.record.id !== 'demo' ? active.record.id : undefined;
    const other = active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number;
    const ctxParams = authed ? (activeCallId ? { call_id: activeCallId } : other ? { phone: other } : null) : null;
    const ts = V.talkrPhone.session;
    const sessionRows = ts.session ? (
      <>
        <button type="button" className="phone-row" aria-disabled={ts.busy ? true : undefined} onClick={() => !ts.busy && void (ts.session!.state === 'paused' ? ts.resume() : ts.pause())}>
          <span className="inline-flex w-7 justify-center" style={{ color: 'var(--muted)' }}>
            <Icon name={ts.session.state === 'paused' ? 'play' : 'pause'} size={20} />
          </span>
          {ts.session.state === 'paused' ? 'Resume session' : 'Pause session'}
        </button>
        <button type="button" className="phone-row" style={{ color: '#FF453A' }} onClick={() => !ts.busy && void ts.end()}>
          <span className="inline-flex w-7 justify-center">
            <Icon name="x" size={20} />
          </span>
          End session
        </button>
      </>
    ) : V.queueSession ? (
      <button type="button" className="phone-row" style={{ color: '#FF453A' }} onClick={V.queueSession.end}>
        <span className="inline-flex w-7 justify-center">
          <Icon name="x" size={20} />
        </span>
        End session
      </button>
    ) : null;
    const ctxTabs: Array<{ value: ContextTab; label: string }> = [
      { value: 'lead', label: 'Lead' },
      { value: 'script', label: 'Script' },
      { value: 'objections', label: 'Objections' },
      { value: 'live', label: 'Live' },
      { value: 'notes', label: 'Notes' },
    ];
    body = (
      <>
        <div className="phone-head">
          {minimise}
          {sessionOn ? (
            <span
              className="inline-flex items-center"
              style={{ height: 28, padding: '0 12px', borderRadius: 14, background: 'rgba(255,255,255,.14)', font: '500 13px/1 var(--sans)', whiteSpace: 'nowrap' }}
            >
              {sessionName}{sessionLeft !== null ? ` · ${sessionLeft} left` : ''}
            </span>
          ) : (
            <span />
          )}
          <button type="button" className="phone-iconbtn justify-self-end" data-testid="context-open" aria-label="Details: lead, script and notes" onClick={() => setSheet('context')}>
            <Icon name="template" size={24} />
          </button>
        </div>
        <ActiveCall
          variant="phone"
          team={team}
          onText={openText}
          recording={V.rec}
          peek={peek || undefined}
          onContext={(t) => {
            if (t) setCtxTab(t);
            setSheet('context');
          }}
          onOpenRecord={rec ? () => away(rec.open) : undefined}
          callerId={V.callerIdLabel.replace(/^caller ID /, '')}
          sessionRows={sessionRows}
        />
        <PhoneSheet open={sheet === 'context'} onClose={() => setSheet(null)} title={V.callTarget?.name ?? 'This call'} tone="light" height="88%" testId="context-sheet">
          <div className="phone-seg sticky top-0 z-10 mb-3" role="tablist" style={{ background: '#e3e3e8' }}>
            {ctxTabs.map((t) => (
              <button key={t.value} type="button" role="tab" aria-selected={ctxTab === t.value} data-testid={`context-tab-${t.value}`} onClick={() => setCtxTab(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
          {ctxTab === 'notes' ? (
            <div className="phone-notes">
              <NotesCard V={V} />
            </div>
          ) : (
            <CallContext
              mode="incall"
              callId={activeCallId}
              params={ctxParams}
              record={minimiseRecord(rec)}
              direction={active.record.direction}
              onText={openText}
              liveSlot={<LiveCallCard V={V} />}
              tab={ctxTab}
              onTabChange={(t) => setCtxTab(t)}
            />
          )}
        </PhoneSheet>
      </>
    );
  } else if (mode === 'wrap') {
    const rec = V.callRecord;
    const ts = V.talkrPhone.session;
    const canNext = (!!ts.session && ts.session.state !== 'paused' && !V.talkrPhone.extension.holdingSoftphone) || !!V.queueSession;
    body = (
      <>
        <div className="grid flex-none items-center" style={{ height: 56, gridTemplateColumns: '1fr auto 1fr', padding: '0 8px' }}>
          {minimise}
          <span className="flex min-w-0 flex-col items-center text-center">
            <span style={{ font: '400 13px/1.2 var(--sans)', color: 'rgba(255,255,255,.6)' }}>Call ended · {V.callDuration}</span>
            <span className="max-w-[52vw] truncate" style={{ font: '600 17px/1.25 var(--sans)' }}>
              {V.callTarget?.name ?? 'Wrap-up'}
            </span>
          </span>
          {rec ? (
            <button type="button" className="phone-textbtn mint justify-self-end" onClick={() => away(rec.open)}>
              Open record
            </button>
          ) : (
            <span />
          )}
        </div>
        <div className="phone-light phone-scroll" style={{ background: '#F2F2F7', borderRadius: '14px 14px 0 0', padding: '16px 16px 0' }}>
          <WrapUpCard
            V={V}
            stickyFooter
            mobile
            onNext={
              canNext
                ? () => {
                    pendingNext.current = true;
                  }
                : undefined
            }
            onOpenRecord={rec ? () => away(rec.open) : undefined}
          />
        </div>
      </>
    );
  } else if (tab === 'Dial') {
    body = (
      <>
        <div className="phone-head">
          {done}
          <button
            type="button"
            data-testid="phone-callerid"
            onClick={() => setSheet('callerid')}
            className="inline-flex min-w-0 items-center justify-center"
            style={{ minHeight: 44, maxWidth: '60vw', border: 0, background: 'none', padding: 0 }}
          >
            <span
              className="inline-flex min-w-0 items-center gap-1"
              style={{ height: 32, padding: '0 12px', borderRadius: 16, background: 'rgba(255,255,255,.1)', font: '500 13px/1 var(--sans)', color: 'rgba(255,255,255,.72)' }}
            >
              {showsDefault(me) && <DefaultStar size={12} />}
              <span className="truncate">From {V.callerIdLabel.replace(/^caller ID /, '')}</span>
              <Icon name="chevron-down" size={13} style={{ flex: 'none' }} />
            </span>
          </button>
          <button type="button" className="phone-iconbtn justify-self-end" data-testid="phone-more" aria-label="Phone options" onClick={() => setSheet('options')}>
            <Icon name="more" size={24} strokeWidth={3} />
          </button>
        </div>
        {sessionOn && <DialSessionBar V={V} variant="compact" />}
        {!talkrReady ? (
          <div className="phone-dark phone-scroll">
            <TalkrNotSignedIn V={V} />
          </div>
        ) : (
          <>
            <div className="flex min-h-[96px] flex-1 flex-col items-center justify-end overflow-hidden px-4 pb-4">
              <PhoneNumberDisplay digits={digits} onPaste={(text) => setDigits(dialDigits(text))} />
              {(reason || sp.deviceError) && (
                <span role="status" className="mt-1 text-center" style={{ font: '400 13px/1.35 var(--sans)', color: sp.deviceError && !reason ? '#FF6961' : 'rgba(255,255,255,.72)' }}>
                  {reason ?? sp.deviceError}
                </span>
              )}
              {sp.deviceAction && (
                <button
                  type="button"
                  onClick={() => sp.deviceAction?.run()}
                  className="mt-2"
                  style={{ height: 36, padding: '0 14px', borderRadius: 18, border: 0, background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', font: '600 13px/1 var(--sans)' }}
                >
                  {sp.deviceAction.label}
                </button>
              )}
              {match && (
                <button
                  type="button"
                  data-testid="phone-match"
                  onClick={() => setSheet('lead')}
                  className="mt-2 inline-flex max-w-full items-center gap-2"
                  style={{ height: 40, padding: '0 14px', borderRadius: 20, border: 0, background: 'rgba(255,255,255,.12)', color: '#fff' }}
                >
                  <Icon name="user" size={16} style={{ flex: 'none' }} />
                  <span className="truncate" style={{ font: '600 15px/1 var(--sans)' }}>{match.name}</span>
                  <span className="truncate" style={{ font: '400 13px/1 var(--sans)', color: 'rgba(255,255,255,.6)' }}>{match.address || match.stage}</span>
                </button>
              )}
              {digits && (
                <div className="phone-actions mt-3 flex gap-2">
                  <button type="button" className="phone-pill" onClick={openText}>
                    <Icon name="msg" size={16} />
                    Message
                  </button>
                  {live && (
                    <button type="button" className="phone-pill" aria-disabled={aiBusy ? true : undefined} onClick={() => void aiCall()}>
                      {aiBusy ? 'Starting AI…' : 'AI call'}
                    </button>
                  )}
                </div>
              )}
              {aiNote && <span role={ai.phase === 'error' ? 'alert' : 'status'} style={{ marginTop: 6, font: '400 13px/1.35 var(--sans)', color: 'rgba(255,255,255,.6)' }}>{aiNote}</span>}
            </div>
            <Keys
              variant="phone"
              onKey={press}
              onLongPress={() => setDigits((cur) => (cur === '0' ? '+' : cur))}
            />
            <div className="phone-pad" style={{ marginTop: 'calc(var(--key) * 0.22)' }}>
              <span />
              <button
                type="button"
                className="phone-call"
                data-testid="phone-call"
                aria-label="Call"
                aria-disabled={callBlocked ? true : undefined}
                onClick={call}
              >
                <Handset size={32} />
              </button>
              <button
                type="button"
                className="phone-del"
                data-testid="phone-delete"
                aria-label="Delete"
                style={{ visibility: digits ? 'visible' : 'hidden' }}
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse' && e.button !== 0) return;
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    /* synthetic */
                  }
                  startDelete();
                }}
                onPointerUp={stopDelete}
                onPointerCancel={stopDelete}
                onLostPointerCapture={stopDelete}
                onClick={(e) => {
                  if (e.detail === 0) setDigits((cur) => cur.slice(0, -1));
                }}
                onContextMenu={(e) => e.preventDefault()}
              >
                <DeleteGlyph />
              </button>
            </div>
          </>
        )}
        <div style={{ height: 16, flex: 'none' }} />
        {tabBar}
        <PhoneSheet open={sheet === 'options'} onClose={() => setSheet(null)} title="Phone options" testId="phone-options">
          <div className="phone-dark flex flex-col gap-3" style={{ background: 'transparent' }}>
            <div className="flex flex-col">
              <button type="button" className="phone-row" onClick={openText}>
                <span className="inline-flex w-7 justify-center" style={{ color: 'var(--muted)' }}>
                  <Icon name="msg" size={20} />
                </span>
                Message
              </button>
              {live && (
                <button
                  type="button"
                  className="phone-row"
                  aria-disabled={!e164 || aiBusy ? true : undefined}
                  onClick={() => (e164 ? void aiCall() : setReason('Type the number for the AI to call first.'))}
                >
                  <span className="inline-flex w-7 justify-center" style={{ color: 'var(--muted)' }}>
                    <Icon name="phone" size={20} />
                  </span>
                  AI call
                  <span className="ml-auto" style={{ font: '400 13px/1.2 var(--sans)', color: 'var(--muted)' }}>
                    {e164 ? formatPhone(e164) : 'Type a number first'}
                  </span>
                </button>
              )}
              {!live && (
                <div className="phone-row" style={{ cursor: 'default' }}>
                  <span className="inline-flex w-7 justify-center" style={{ color: 'var(--muted)' }}>
                    <Icon name="phone" size={20} />
                  </span>
                  AI call
                  <span className="ml-auto" style={{ font: '400 13px/1.2 var(--sans)', color: 'var(--muted)' }}>
                    Needs a Talkr workspace
                  </span>
                </div>
              )}
            </div>
            <RecordingToggles V={V} />
            {live && <SoftphoneRow V={V} />}
            <p style={{ font: '400 13px/1.4 var(--sans)', color: 'var(--muted)' }}>
              <b style={{ color: 'var(--text)', fontWeight: 600 }}>Keep CLOZR open during calls.</b> The screen stays awake while you are on a call; a call
              drops if you lock the phone or switch apps.
            </p>
            {live && (
              <button type="button" className="phone-row" onClick={() => sp.openTalkrSettings('calling')}>
                <span className="inline-flex w-7 justify-center">
                  <TalkrMark size={18} />
                </span>
                Talkr settings
              </button>
            )}
            {liveTab && <LiveCalls />}
          </div>
        </PhoneSheet>
        <PhoneSheet open={sheet === 'callerid'} onClose={() => setSheet(null)} title="Caller ID" tone={me && me.org_numbers.length > 0 ? 'light' : 'dark'}>
          {me && me.org_numbers.length > 0 ? (
            <CallerIdPicker me={me} onChange={setMe} />
          ) : (
            <p style={{ font: '400 15px/1.45 var(--sans)', padding: '4px 4px 12px' }}>
              Calls go out {V.callerIdLabel.startsWith('caller ID') ? `on ${V.callerIdLabel.replace(/^caller ID /, '')}` : `— ${V.callerIdLabel}`}.
            </p>
          )}
        </PhoneSheet>
        <PhoneSheet open={sheet === 'lead' && !!match} onClose={() => setSheet(null)} title={match?.name ?? 'Lead'} tone="light" height="88%">
          {match && (
            <CallContext
              mode="precall"
              params={params({ phone: e164 })}
              record={minimiseRecord(match)}
              onCall={(input) => {
                setSheet(null);
                if (input.to_number) V.dialE164(input.to_number);
              }}
              canCall={deviceState === 'ready'}
              onText={openText}
            />
          )}
        </PhoneSheet>
      </>
    );
  } else {
    const title = tab === 'Recent' ? 'Recents' : tab;
    body = (
      <>
        <div className="phone-head">
          {done}
          <span style={{ font: '600 17px/1 var(--sans)' }}>{title}</span>
          <span />
        </div>
        <div className="phone-dark phone-scroll flex flex-col gap-0.5" style={{ padding: '0 16px 16px' }}>
          {tab === 'Recent' && <RecentList V={V} big onPick={(phone) => V.dialE164(phone)} />}
          {tab === 'Queue' && (
            <>
              {sessionOn ? (
                <div style={{ margin: '4px -16px 8px' }}>
                  <DialSessionBar V={V} variant="compact" />
                </div>
              ) : (
                <DialSessionStart V={V} />
              )}
              <QueueList V={V} wide />
            </>
          )}
          {tab === 'Voicemail' && <VoicemailList V={V} />}
          {tab === 'RVM' && <RvmPanel V={V} />}
          {tab === 'Live' && <LiveCalls />}
        </div>
        {tabBar}
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="phone-root"
      data-phone-state={mode === 'idle' ? `idle-${tab.toLowerCase()}` : mode}
      className={`talkr-dialer clozr-phone ${surfaceClass}`}
      role="dialog"
      aria-modal="true"
      aria-label="Phone"
      style={{ outline: 'none' }}
    >
      {body}
    </div>
  );
}

/** The minimised call: one tap back to it, above the CRM's tab bar. */
export function PhoneCallPill({ V }: { V: ClozrView }) {
  const show = V.isMobile && V.phoneCallMin;
  // Drawers and toasts already lift themselves by --clozr-callbar on a phone.
  useEffect(() => {
    if (!show) return;
    const root = document.documentElement;
    root.style.setProperty('--clozr-callbar', '52px');
    return () => {
      root.style.removeProperty('--clozr-callbar');
    };
  }, [show]);
  if (!show) return null;
  const wrap = V.callState === 'wrap';
  const name = V.callTarget?.name ?? 'your call';
  return (
    <button
      type="button"
      className="clozr-phone-pill"
      data-testid="call-pill"
      aria-label={wrap ? `Finish wrap-up with ${name}` : `Return to call with ${name}`}
      onClick={() => V.openPhone()}
      style={{ background: wrap ? '#18181b' : '#0A8560' }}
    >
      <span aria-hidden className={wrap ? undefined : 'talkr-rec-dot'} style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--surface, #fff)', flex: 'none' }} />
      <span className="min-w-0 flex-1 truncate" style={{ textAlign: 'left' }}>
        {wrap ? `Finish wrap-up · ${name}` : name}
      </span>
      {!wrap && V.muted && <Icon name="mic-off" size={16} />}
      {!wrap && <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}><CallClock timer={V.callTimer} /></span>}
      {wrap && <Icon name="chevron-right" size={16} />}
    </button>
  );
}
