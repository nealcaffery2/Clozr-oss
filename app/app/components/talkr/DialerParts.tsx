'use client';

/**
 * The dialer pieces the Talkr Dialer screen and CLOZR's slide-out quick dialer
 * share. The keypad, Recent list, softphone row and notes card are lifted out
 * of Talkr's app/(app)/dialer/page.tsx (so both surfaces are the same
 * component); the rest is what CLOZR's dialer had and Talkr's does not — the
 * live transcript and seller intelligence, record / AI toggles, the call
 * queue, voicemail, dispositions, and the wrap-up that writes the call to the
 * CLOZR record — built in Talkr's card style.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { api } from '@/lib/talkr-web/api';
import { duration, formatPhone, toE164 } from '@/lib/talkr-web/time';
import { Icon } from './Icon';
import { ResumeCard } from './SessionSummary';
import { DialerSetupFlag } from './DialerReadiness';
import { DIAL_PREFS_CHANGED, readPrefs } from '@/lib/dial-session';
import { QUEUE_DEPTHS } from '@/lib/seller-phones';
import { Mark } from '@/components/ds/mark';
import { Button, Card, EmptyState, Eyebrow, Toggle } from './ui';
import { AddContactButton } from './AddContact';
import { CoachingReviewCard } from './CoachingReviewCard';
import { firstName } from '@/lib/call-coaching';
import { aiTargetFrom, useAiCall } from '@/lib/ai-call';
import { TalkrCallRecording } from '@/app/components/record/CallRecording';
import { PhoneText } from './CopyPhone';
import { SellerWrapUp } from './OutcomePicker';
import { shortDeviceLabel, useSoftphone } from './softphoneAdapter';

/** The Talkr mark in Talkr Red. Lives in components/brand (inline SVG); re-exported for the dialer's imports. */
export { TalkrMark } from '@/app/components/brand/TalkrMark';

const KEYS: Array<[string, string]> = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

/**
 * What the dialer keeps of a typed or pasted number: digits, and a leading +.
 * "(210) 555-0134" pastes as 2105550134; "+44 20 7946 0958" keeps its +.
 */
export function dialDigits(raw: string): string {
  const t = raw.trim();
  const plus = t.startsWith('+');
  return ((plus ? '+' : '') + t.replace(/\D/g, '')).slice(0, plus ? 16 : 11);
}

/** How the display shows it: grouped for a North American number, as typed otherwise. */
const shown = (d: string) => (d.startsWith('+') ? d : formatPhone(d));

/**
 * The number being dialed — the Phone app's big centred display, with an ⓧ
 * that clears it all. Typed, pasted or tapped in; a phone keyboard when typed.
 */
export function NumberField({
  digits,
  setDigits,
  onDial,
  big,
}: {
  digits: string;
  setDigits: (next: string) => void;
  onDial: () => void;
  big: boolean;
}) {
  const { callState } = useSoftphone();
  return (
    <div className="dial-display relative flex w-full items-center justify-center" style={{ minHeight: big ? 56 : 48 }}>
      <input
        value={shown(digits)}
        onChange={(e) => setDigits(dialDigits(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && digits && callState === 'idle') onDial();
        }}
        placeholder="Enter a number"
        inputMode="tel"
        // Off, and ignored by password managers: their autofill badge sat on
        // top of the last digits.
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        enterKeyHint="go"
        aria-label="Number to dial"
        className="w-full min-w-0 bg-transparent text-center outline-none"
        // A full (217) 555-0100 at 30px overran the narrow desk column; long numbers step down.
        style={{ font: `500 ${(big ? 34 : 30) - (digits.length > 10 ? 6 : 0)}px/1.15 var(--sans)`, letterSpacing: '-0.01em', padding: '0 30px' }}
      />
      {digits && (
        <button
          type="button"
          onClick={() => setDigits('')}
          aria-label="Clear number"
          title="Clear number"
          className="absolute right-1 inline-flex items-center justify-center"
          style={{ width: 22, height: 22, borderRadius: '50%', border: 'none', background: 'rgba(118,118,128,.32)', color: '#fff', cursor: 'pointer' }}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * The twelve round keys: digit over letters, soft grey. `variant="phone"` is
 * the full-screen phone's pad (PhoneScreen.tsx): iOS keys that take the digit
 * on touch-down, not on release, and a long press on 0 for +.
 */
export function Keys({
  onKey,
  variant = 'default',
  onLongPress,
  tones = false,
}: {
  onKey: (d: string) => void;
  big?: boolean;
  variant?: 'default' | 'phone';
  /** Phone only: a 500ms hold on 0 (the + under it). */
  onLongPress?: (d: string) => void;
  /** Phone only: the in-call tone pad, on the call screen's glass. */
  tones?: boolean;
}) {
  if (variant === 'phone') return <PhonePad onKey={onKey} onLongPress={onLongPress} tones={tones} />;
  return (
    <div className="mx-auto grid w-max grid-cols-3 gap-x-4 gap-y-3">
      {KEYS.map(([d, letters]) => (
        <button key={d} type="button" onClick={() => onKey(d)} className="ios-key" aria-label={letters ? `${d} ${letters}` : d}>
          <span style={{ font: '400 32px/1 var(--sans)' }}>{d}</span>
          <span style={{ font: '600 9px/1 var(--sans)', letterSpacing: '0.16em', color: 'var(--muted)', minHeight: 9 }}>{letters}</span>
        </button>
      ))}
    </div>
  );
}

const keyTestId = (d: string) => `phone-key-${d === '*' ? 'star' : d === '#' ? 'hash' : d}`;

/**
 * The phone's pad. A digit lands on pointerdown — the instant a finger
 * touches, like the Phone app — and the pressed colour is an attribute set in
 * the same handler, so there is no transition and no wait for a re-render.
 * A keyboard press (Enter/Space) arrives as a click with detail 0 and is taken
 * there, so nothing is typed twice.
 */
function PhonePad({ onKey, onLongPress, tones }: { onKey: (d: string) => void; onLongPress?: (d: string) => void; tones: boolean }) {
  const hold = useRef<number | null>(null);
  const clearHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => clearHold, []);
  const release = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.removeAttribute('data-down');
    clearHold();
  };
  return (
    <div className={tones ? 'phone-pad tones' : 'phone-pad'} data-testid={tones ? 'phone-tonepad' : 'phone-pad'}>
      {KEYS.map(([d, letters]) => (
        <button
          key={d}
          type="button"
          data-key={d}
          data-testid={keyTestId(d)}
          className={d === '*' || d === '#' ? 'phone-key glyph' : 'phone-key'}
          aria-label={letters ? `${d} ${letters}` : d === '*' ? 'star' : d === '#' ? 'pound' : d}
          onPointerDown={(e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.currentTarget.setAttribute('data-down', '');
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* a synthetic event has no pointer to capture */
            }
            onKey(d);
            clearHold();
            if (d === '0' && onLongPress) {
              hold.current = window.setTimeout(() => {
                hold.current = null;
                onLongPress('0');
              }, 500);
            }
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={release}
          onClick={(e) => {
            if (e.detail === 0) onKey(d);
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="phone-key-d">{d}</span>
          {!tones || letters ? <span className="phone-key-l">{d === '0' ? '+' : letters}</span> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The number as the keypad shows it: grouped as it is typed for a North
 * American number, anything else exactly as it came. Letters (a name search)
 * and an explicit + are left alone. Shared by the phone's display and the
 * in-call Add call / Transfer fields.
 */
export function formatDialed(value: string): string {
  if (/[A-Za-z]/.test(value)) return value;
  if (value.trim().startsWith('+')) return value;
  if (value.replace(/\D/g, '').length > 11) return value;
  return formatPhone(value);
}

/**
 * The phone's number display: no <input>, so the iOS keyboard never opens.
 * A tap on the empty display (or a hold on any number) offers Paste, read
 * from the clipboard inside that same tap as iOS requires.
 */
export function PhoneNumberDisplay({ digits, onPaste }: { digits: string; onPaste: (text: string) => void }) {
  const [bubble, setBubble] = useState(false);
  const hold = useRef<number | null>(null);
  const text = formatDialed(digits);
  const size = text.length <= 14 ? 36 : text.length <= 17 ? 30 : 24;
  useEffect(() => () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
  }, []);
  useEffect(() => {
    if (!bubble) return;
    const t = window.setTimeout(() => setBubble(false), 4000);
    return () => window.clearTimeout(t);
  }, [bubble]);
  const stopHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };
  return (
    <div className="relative flex w-full flex-col items-center">
      {bubble && (
        <button
          type="button"
          data-testid="phone-paste"
          onClick={() => {
            setBubble(false);
            void navigator.clipboard?.readText().then(onPaste, () => undefined);
          }}
          style={{
            position: 'absolute', bottom: '100%', marginBottom: 6, height: 32, padding: '0 14px', border: 0, borderRadius: 8,
            background: 'rgba(255,255,255,.18)', color: '#fff', font: '500 15px/1 var(--sans)',
          }}
        >
          Paste
        </button>
      )}
      <div
        role="status"
        aria-live="polite"
        aria-label={digits ? `Number ${text}` : 'No number entered'}
        data-testid="phone-number"
        onClick={() => {
          if (!digits) setBubble((b) => !b);
        }}
        onPointerDown={() => {
          stopHold();
          hold.current = window.setTimeout(() => setBubble(true), 600);
        }}
        onPointerUp={stopHold}
        onPointerCancel={stopHold}
        onPointerLeave={stopHold}
        className="w-full"
        style={{
          minHeight: 44, font: `400 ${size}px/1.1 var(--sans)`, letterSpacing: '0.5px', color: '#fff', textAlign: 'center',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 24px',
          direction: size === 24 ? 'rtl' : undefined, WebkitUserSelect: 'none', userSelect: 'none',
        }}
      >
        <span dir="ltr">{text}</span>
      </div>
    </div>
  );
}

/** Talkr does not know this rep (or cannot be reached): what to do about it, instead of a dead keypad. */
export function TalkrNotSignedIn({ V }: { V: ClozrView }) {
  if (V.talkrStatus === 'ok' || V.talkrStatus === 'demo' || V.talkrStatus === 'loading') return null;
  return (
    <div className="px-5 pt-3">
      <Card className="flex items-center gap-3" style={{ padding: '11px 14px' }}>
        <span style={{ color: 'var(--amber)', display: 'inline-flex', flexShrink: 0 }}><Mark label="warning" /></span>
        <span className="min-w-0 flex-1" style={{ font: '500 12px/1.45 var(--sans)' }}>
          {V.callerIdLabel}. {V.talkrError ?? 'Settings → Phone shows how to link your Talkr sign-in.'}
        </span>
        <Button tone="ghost" onClick={V.goSettings}>
          Settings
        </Button>
      </Card>
    </div>
  );
}

/** The Phone app's keypad: display, round keys, then text · the round green call · backspace. */
export function DialBlock({ V, digits, setDigits, error, big = false }: { V: ClozrView; digits: string; setDigits: (d: string) => void; error: string | null; big?: boolean }) {
  const { callState, deviceState } = useSoftphone();
  const ai = useAiCall(V.templatesWorkspaceId ?? null);
  const aiBusy = ai.busy;
  const aiNote = ai.note;
  const dial = () => V.dialE164(toE164(digits));
  const dialDisabled = !digits || callState !== 'idle' || deviceState !== 'ready';

  async function aiCall() {
    const to = toE164(digits);
    if (!to || aiBusy) return;
    await ai.start(to, aiTargetFrom(V.dialerRecordFor(to)));
  }

  return (
    <>
      <NumberField digits={digits} setDigits={setDigits} onDial={dial} big={big} />
      <Keys onKey={(d) => setDigits(dialDigits(digits + d))} />
      <div className="mx-auto grid w-max grid-cols-3 items-center justify-items-center gap-x-4">
        {/* Kept in the grid but hidden for a role without the inbox (TC), so the call button stays centred. */}
        <button
          type="button"
          onClick={V.goInbox}
          disabled={!V.can.inbox}
          aria-label="Text from the inbox"
          title="Text from the inbox"
          className="inline-flex items-center justify-center"
          style={{ width: 76, height: 48, border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', visibility: V.can.inbox ? 'visible' : 'hidden' }}
        >
          <Icon name="msg" size={24} />
        </button>
        <button type="button" className="ios-round" style={{ background: 'var(--green)' }} disabled={dialDisabled} onClick={dial} aria-label="Call" title="Call">
          <Icon name="phone" size={30} />
        </button>
        <button
          type="button"
          onClick={() => setDigits(digits.slice(0, -1))}
          aria-label="Backspace"
          title="Backspace"
          className="inline-flex items-center justify-center"
          style={{ width: 76, height: 48, border: 'none', background: 'none', color: 'var(--muted)', cursor: 'pointer', visibility: digits ? 'visible' : 'hidden' }}
        >
          <Icon name="backspace" size={26} />
        </button>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <Button
          tone="ghost"
          disabled={!digits || callState !== 'idle' || aiBusy}
          onClick={() => void aiCall()}
          style={{ padding: '8px 12px', font: '600 11.5px/1 var(--sans)' }}
          title="Telnyx AI Assistant outbound (ElevenLabs voice on the assistant)"
        >
          {aiBusy ? 'Starting AI…' : 'AI call'}
        </Button>
        {aiNote && <span role={ai.phase === 'error' ? 'alert' : 'status'} style={{ font: '500 11px/1.35 var(--sans)', color: ai.phase === 'error' ? 'var(--red)' : 'var(--muted)', textAlign: 'center', maxWidth: 280 }}>{aiNote}</span>}
      </div>
      <SoftphoneRow V={V} error={error} />
    </>
  );
}

/** Enable / reconnect, which headset is live, and any error — Talkr's row, CLOZR's status words. */
export function SoftphoneRow({ V, error }: { V: ClozrView; error?: string | null }) {
  const { deviceState, deviceError, deviceAction, initDevice, inputDevices, outputDevices, activeInputDeviceId, activeOutputDeviceId, openTalkrSettings } = useSoftphone();
  const micLabel = shortDeviceLabel(inputDevices.find((d) => d.deviceId === activeInputDeviceId)?.label ?? 'Default mic');
  const speakerLabel = shortDeviceLabel(outputDevices.find((d) => d.deviceId === activeOutputDeviceId)?.label ?? 'Default speaker');
  const live = V.talkrStatus !== 'demo';
  return (
    <>
      {live && deviceAction && (
        <Button tone="accent" onClick={() => deviceAction.run()}>
          {deviceAction.label}
        </Button>
      )}
      {live && !deviceAction && deviceState !== 'ready' && (
        <Button tone="accent" onClick={() => void initDevice()} disabled={deviceState === 'initializing' || V.talkrStatus !== 'ok'}>
          {deviceState === 'initializing' ? 'Connecting…' : deviceState === 'error' ? 'Retry softphone' : 'Enable softphone'}
        </Button>
      )}
      {live && (
        <p className="flex items-center gap-1.5 truncate" style={{ font: '500 10.5px/1.4 var(--sans)', color: V.softphoneReady ? 'var(--green)' : 'var(--muted-2)' }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: V.softphoneReady ? 'var(--green)' : 'var(--line-hover)', flex: 'none' }} aria-hidden />
          {V.talkrStatus === 'ok' ? V.softphoneLabel : V.callerIdLabel}
        </p>
      )}
      {deviceState === 'ready' && live && (
        // Which headset is live, at a glance: the wrong one is the commonest "I can't hear them".
        <p className="truncate" style={{ font: '500 10.5px/1.4 var(--sans)', color: 'var(--muted-2)' }}>
          Audio: {micLabel} → {speakerLabel} ·{' '}
          <button type="button" onClick={() => openTalkrSettings('audio')} style={{ color: 'var(--muted)', background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}>
            change
          </button>
        </p>
      )}
      {deviceError && <p style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--red)' }}>{deviceError}</p>}
      {(error ?? V.talkrError) && <p style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--red)' }}>{error ?? V.talkrError}</p>}
    </>
  );
}

/** CLOZR's two call switches, and the consent line that goes with them. */
export function RecordingToggles({ V }: { V: ClozrView }) {
  const row = (label: string, on: boolean, flip: () => void, locked?: string) => (
    <div className="flex items-center justify-between gap-2 px-3 py-2" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--panel)', boxShadow: 'var(--shadow-rest)' }}>
      <span style={{ font: '500 11.5px/1 var(--sans)' }}>{label}</span>
      <Toggle on={on} onChange={flip} label={label} disabled={!!locked} title={locked} />
    </div>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        {row('Record call', V.rec, V.toggleRec, V.recLocked ? 'Talkr records every call, dual-channel, with consent handled by the carrier flow' : undefined)}
        {row('AI transcription', V.ai, V.toggleAiRec)}
      </div>
      <p style={{ font: '400 10.5px/1.4 var(--sans)', color: 'var(--muted-2)' }}>
        Recording requires consent in one-party states; two-party states prompt automatically.
      </p>
    </div>
  );
}

/** Talkr's Recent rows: the call log when Talkr knows the rep, CLOZR's sample calls otherwise. */
export function RecentList({ V, big, onPick }: { V: ClozrView; big: boolean; onPick: (e164: string) => void }) {
  const { recent, authed } = useSoftphone();
  const rows = authed
    ? recent.map((c) => {
        const other = c.direction === 'outbound' ? c.to_number : c.from_number;
        return {
          id: c.id,
          name: c.contact_name ?? formatPhone(other),
          sub: `${c.direction} · ${c.status.replace(/_/g, ' ')}`,
          right: c.duration_seconds != null ? duration(c.duration_seconds) : '',
          missed: c.status === 'no_answer' || c.status === 'busy',
          inbound: c.direction === 'inbound',
          phone: other,
        };
      })
    : V.recentCalls.map((r, i) => ({
        id: String(i), name: r.name, sub: r.kind, right: r.time, missed: /missed/i.test(r.kind), inbound: /inbound/i.test(r.kind), phone: '',
      }));
  return (
    <>
      {rows.length === 0 && (
        <EmptyState compact icon="phone" title="No calls yet" hint="Your last few calls land here, one tap from redialling them." />
      )}
      {rows.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => c.phone && onPick(c.phone)}
          className={`lift-row dial-row flex items-center gap-2.5 px-2 text-left ${big ? 'py-3' : 'py-2'}`}
          style={{ borderBottom: '1px solid var(--line-soft)', borderRadius: 8, cursor: 'pointer' }}
        >
          <span
            className={`inline-flex items-center justify-center ${big ? 'h-9 w-9' : 'h-6 w-6'}`}
            style={{ borderRadius: big ? 11 : 8, background: 'var(--panel-2)', color: c.missed ? 'var(--red)' : c.inbound ? 'var(--accent)' : 'var(--green)' }}
          >
            <Icon name="phone" size={big ? 15 : 12} />
          </span>
          <span className="mr-auto flex min-w-0 flex-col gap-1">
            <span className="truncate" style={{ font: big ? '600 14px/1 var(--sans)' : '600 12px/1 var(--sans)' }}>{c.name}</span>
            <span style={{ font: big ? '500 11.5px/1 var(--sans)' : '500 10px/1 var(--sans)', color: 'var(--muted)' }}>{c.sub}</span>
          </span>
          <span style={{ font: big ? '500 12px/1 var(--sans)' : '500 10px/1 var(--sans)', color: 'var(--muted-2)' }}>{c.right}</span>
        </button>
      ))}
    </>
  );
}

/** The rep's remembered session choices (lib/dial-session.ts), kept current when the setup sheet saves them. */
function useDialPrefs(V: ClozrView) {
  const ws = V.floorWorkspaceId;
  const uid = V.floorMe;
  const [prefs, setPrefs] = useState(() => readPrefs(ws, uid));
  useEffect(() => {
    const on = () => setPrefs(readPrefs(ws, uid));
    const t = window.setTimeout(on, 0);
    window.addEventListener(DIAL_PREFS_CHANGED, on);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener(DIAL_PREFS_CHANGED, on);
    };
  }, [ws, uid]);
  return prefs;
}

/** CLOZR's priority call queue, as Talkr rows. `wide` is the full dialer's centre column. */
export function QueueList({ V, wide = false }: { V: ClozrView; wide?: boolean }) {
  // Mode and numbers per lead are set in the setup sheet that every start
  // opens (DialSessionSetup.tsx); the header says what the last one was.
  const prefs = useDialPrefs(V);
  const depthLabel = QUEUE_DEPTHS.find((d) => d.id === prefs.depth)?.label ?? '1';
  const running = !!V.queueSession || !!V.talkrPhone.session.session;
  return (
    <>
      <ResumeCard V={V} />
      <div className="mb-1 flex flex-col gap-2 px-3 py-2.5" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--band)' }}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex flex-col gap-1">
            <span className="display" style={{ font: '700 18px/1 var(--sans)' }}>{V.callQueueCount}</span>
            <span style={{ font: '500 10.5px/1 var(--sans)', color: 'var(--muted)' }}>priority calls · est. {V.callQueueCount * 4} min</span>
          </span>
          <span className="flex flex-wrap items-center justify-end gap-1.5">
            {/* Dials this list in order, with Next in the session bar. Talkr's
                own campaigns are started from the box above, labelled as such. */}
            <Button
              tone="green"
              onClick={() => void V.startQueue()}
              disabled={V.callQueueCount === 0 || running}
              title={running ? 'A session is already running' : 'Pick the mode, numbers per lead, caller ID and voicemail, then dial'}
              style={{ padding: '8px 11px', font: '600 11.5px/1 var(--sans)' }}
            >
              Start session
            </Button>
            {V.callQueueManual && (
              <Button tone="ghost" onClick={V.clearCallQueue} title="Take everyone off your call queue" style={{ padding: '7px 8px' }}>
                <Icon name="x" size={13} />
              </Button>
            )}
          </span>
        </div>
        <span className="flex items-center justify-between gap-2">
          <span data-testid="queue-last-setup" style={{ font: '500 10.5px/1.3 var(--sans)', color: 'var(--muted)' }}>
            Last time: {prefs.mode === 'predictive' ? 'Predictive' : 'Power'} · {depthLabel} number{prefs.depth === 1 ? '' : 's'} per lead. Start session asks first.
          </span>
        </span>
      </div>
      {!running && <DialerSetupFlag style={{ marginBottom: 4 }} />}
      {!V.callQueueManual && V.callQueue.length > 0 && (
        <div className="px-2 pb-1" style={{ font: '500 10.5px/1.3 var(--sans)', color: 'var(--muted)' }}>
          Suggested · select sellers or buyers and use Add to call queue to build your own.
        </div>
      )}
      {V.callQueue.length === 0 && <EmptyState compact icon="users" title="Queue is clear" hint="Select sellers or buyers and use Add to call queue." />}
      {V.callQueue.map((q, i) => (
        <div key={`${q.name}-${i}`} className={`dial-row flex items-center px-2 ${wide ? 'gap-3 py-3' : 'gap-2.5 py-2'}`} style={{ borderBottom: '1px solid var(--line-soft)' }}>
          <span className={`inline-flex shrink-0 items-center justify-center ${wide ? 'h-9 w-9' : 'h-7 w-7'}`} style={{ borderRadius: wide ? 11 : 8, background: 'var(--panel-2)', font: `700 ${wide ? 12 : 10}px/1 var(--sans)`, color: 'var(--muted)' }}>
            {q.initials}
          </span>
          <span className="mr-auto flex min-w-0 flex-col gap-1">
            <span className="truncate" style={{ font: `600 ${wide ? 14 : 12}px/1 var(--sans)` }}>{q.name}</span>
            <span className="flex min-w-0 items-center gap-1" style={{ font: `500 ${wide ? 11.5 : 10}px/1.2 var(--sans)`, color: 'var(--muted)' }}>
              {toE164(q.phone) ? <PhoneText e164={toE164(q.phone)} size={16} /> : q.phone}
              <span className="truncate">· {q.reason}</span>
            </span>
          </span>
          <Button tone="ghost" onClick={q.go} style={{ padding: '6px 10px', font: '600 11px/1 var(--sans)' }}>
            <Icon name="phone" size={12} />
            Call
          </Button>
          {q.remove && (
            <Button tone="ghost" onClick={q.remove} title="Take off the queue" style={{ padding: '6px 7px' }}>
              <Icon name="x" size={12} />
            </Button>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * CLOZR's voicemail tab, as Talkr rows. `wide` is the full dialer's centre
 * column: caller, transcript and controls on one line instead of stacked, so a
 * wide screen reads as a list rather than a phone column stretched out.
 */
export function VoicemailList({ V, wide = false }: { V: ClozrView; wide?: boolean }) {
  return (
    <>
      {V.voicemails.length === 0 && <EmptyState compact icon="voicemail" title="No voicemails" hint="Voicemails left on your Talkr lines land here." />}
      {wide && V.voicemails.map((v, i) => (
        <div
          key={`${v.name}-${i}`}
          className="grid items-center gap-4 px-2 py-3 min-[1100px]:grid-cols-[180px_minmax(0,1fr)_auto]"
          style={{ borderBottom: '1px solid var(--line-soft)' }}
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center" style={{ borderRadius: 11, background: 'var(--panel-2)', color: 'var(--accent)' }}>
              <Icon name="voicemail" size={15} />
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate" style={{ font: '600 14px/1 var(--sans)' }}>{v.name}</span>
              <span style={{ font: '500 11.5px/1 var(--sans)', color: 'var(--muted-2)' }}>{v.time}</span>
            </span>
          </span>
          <span style={{ font: '400 13px/1.5 var(--sans)', color: 'var(--muted)' }}>{v.text}</span>
          <span className="flex flex-wrap items-center gap-2">
            <VoicemailPlay id={v.id} hasRecording={v.hasRecording} />
            <Button tone="ghost" onClick={v.callBack} style={{ padding: '7px 11px', font: '600 11.5px/1 var(--sans)' }}>
              <Icon name="phone" size={12} />
              Call back
            </Button>
          </span>
        </div>
      ))}
      {!wide && V.voicemails.map((v, i) => (
        <div key={`${v.name}-${i}`} className="flex flex-col gap-1.5 px-2 py-2.5" style={{ borderBottom: '1px solid var(--line-soft)' }}>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate" style={{ font: '600 12px/1 var(--sans)' }}>{v.name}</span>
            <span style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted-2)' }}>{v.time}</span>
          </div>
          <span style={{ font: '400 11.5px/1.45 var(--sans)', color: 'var(--muted)' }}>{v.text}</span>
          <div className="flex flex-wrap gap-1.5">
            <VoicemailPlay id={v.id} hasRecording={v.hasRecording} />
            <Button tone="ghost" onClick={v.callBack} style={{ padding: '6px 9px', font: '600 10.5px/1 var(--sans)' }}>
              <Icon name="phone" size={11} />
              Call back
            </Button>
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * A call with no softphone leg yet (the demo, or the moment before Talkr
 * connects). Name, clock, mute and end — not a dial pad.
 */
export function ScriptedCall({ V }: { V: ClozrView }) {
  const name = V.callTarget?.name || 'Call';
  const phone = V.callTarget?.phone || '';
  return (
    <section aria-label="Active call" className="flex flex-col items-center gap-2 px-4 py-6 text-center">
      <span style={{ font: '600 22px/1.2 var(--sans)' }}>{name}</span>
      {phone && phone !== name && <span style={{ font: '400 14px/1.2 var(--sans)', color: 'var(--muted)' }}>{phone}</span>}
      <span style={{ font: '500 13px/1.3 var(--sans)', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
        {V.callState === 'wrap' ? 'Call ended' : V.listeningLabel}
      </span>
      {V.callState === 'live' && (
        <div className="mt-3 flex gap-2">
          <Button tone="ghost" onClick={V.toggleMute}>{V.muted ? 'Unmute' : 'Mute'}</Button>
          <Button tone="red" onClick={V.endCall}>End</Button>
        </div>
      )}
    </section>
  );
}

/** Talkr's call-notes card, plus CLOZR's disposition chips and the record note. */
export function NotesCard({ V }: { V: ClozrView }) {
  const { notes, setNotes, callState } = useSoftphone();
  return (
    <Card className="flex flex-col gap-2.5">
      <Eyebrow>Call notes</Eyebrow>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Asking price, timeline, condition…"
        className="min-h-24 resize-none outline-none"
        style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', padding: '10px 12px', font: '400 12.5px/1.5 var(--sans)' }}
      />
      <div className="flex flex-wrap gap-1.5">
        {['motivated', 'callback after 5pm local', 'do not call'].map((tag) => (
          <Button key={tag} tone="ghost" style={{ padding: '7px 10px', font: '600 11px/1 var(--sans)' }} onClick={() => setNotes((n) => `${n} [${tag}]`.trim())}>
            + {tag}
          </Button>
        ))}
      </div>
      {callState !== 'idle' && (
        <div className="flex flex-col gap-1.5 pt-1" style={{ borderTop: '1px solid var(--line-soft)' }}>
          {/* A seller's call is logged once, by its outcome in the wrap-up; the chips are for everyone else. */}
          {!V.outcomeTarget && <Eyebrow className="pt-1.5">Disposition</Eyebrow>}
          <div className="flex flex-wrap gap-1.5">
            {!V.outcomeTarget && V.dispositions.map((d) => (
              <Button key={d.label} tone="ghost" onClick={d.go} style={{ padding: '7px 10px', font: '600 11px/1 var(--sans)' }}>
                {d.label}
              </Button>
            ))}
            <Button tone="quiet" onClick={V.addCallNote} style={{ padding: '7px 10px', font: '600 11px/1 var(--sans)' }}>
              <Icon name="plus" size={12} />
              Add note to record
            </Button>
          </div>
        </div>
      )}
      <p style={{ font: '400 10.5px/1.4 var(--sans)', color: 'var(--muted-2)' }}>
        Saved to the record as a call note when the call ends.
      </p>
    </Card>
  );
}

/** CLOZR's live transcript and seller intelligence, in Talkr cards. */
export function LiveCallCard({ V }: { V: ClozrView }) {
  const listening = V.listeningLabel.startsWith('●') && V.listeningLabel !== '● connecting';
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [V.transcript.length]);
  return (
    <>
      <Card className="flex flex-col gap-2.5" padded={false}>
        <div className="flex items-center justify-between px-4 pt-3.5">
          <Eyebrow>Live transcript</Eyebrow>
          <span style={{ font: '600 11px/1 var(--sans)', color: listening ? 'var(--green)' : 'var(--muted-2)' }}>
            {V.listeningLabel}
          </span>
        </div>
        <div ref={tail} className="flex max-h-64 flex-col gap-2.5 overflow-auto px-4 pb-4">
          {V.transcript.length === 0 && (
            <p style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>The conversation appears here as it happens.</p>
          )}
          {V.transcript.map((l, i) => (
            <div key={i}>
              <span style={{ font: '700 11px/1 var(--sans)', color: l.color === '#0A8560' ? 'var(--accent)' : 'var(--muted)' }}>
                {l.who}
              </span>
              <p style={{ font: '400 12.5px/1.5 var(--sans)', marginTop: 2 }}>{l.text}</p>
            </div>
          ))}
        </div>
      </Card>
      <Card className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span style={{ width: 6, height: 6, background: 'var(--accent)', animation: 'bluepulse 2.4s ease-in-out infinite' }} aria-hidden />
          <Eyebrow>Seller intelligence</Eyebrow>
        </div>
        <div className="flex flex-col">
          {V.liveIntel.map((f) => (
            <div key={f.k} className="grid gap-2 py-1.5" style={{ gridTemplateColumns: '112px 1fr', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ font: '500 11.5px/1.35 var(--sans)', color: 'var(--muted)' }}>{f.k}</span>
              <span style={{ font: '600 12px/1.35 var(--sans)' }}>{f.v}</span>
            </div>
          ))}
        </div>
        <div className="relative overflow-hidden p-3.5" style={{ borderRadius: 'var(--r-md)', background: 'var(--ink)', color: '#fff' }}>
          <div
            className="pointer-events-none absolute"
            style={{ top: -80, right: -60, width: 220, height: 220, borderRadius: '50%', background: 'radial-gradient(circle, rgba(10, 133, 96,.40), rgba(10, 133, 96,0) 70%)' }}
            aria-hidden
          />
          <div className="relative flex flex-col gap-1.5">
            <Eyebrow>Suggested response</Eyebrow>
            <span style={{ font: '500 13px/1.5 var(--sans)' }}>{V.suggestedResponse}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Eyebrow>Next best question</Eyebrow>
          <span style={{ font: '600 12.5px/1.45 var(--sans)' }}>{V.nextBestQuestion}</span>
        </div>
        <div className="flex flex-col gap-1">
          <Eyebrow>AI coaching</Eyebrow>
          <span style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>{V.aiCoaching}</span>
        </div>
      </Card>
    </>
  );
}

const KEY_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

/** The props both wrap-ups take. */
type WrapUpProps = {
  V: ClozrView;
  /** The full-screen phone: Skip and Save pinned to the bottom of the scroller, thumb-sized. */
  stickyFooter?: boolean;
  /** A touch screen: no keyboard hints or key badges, and 16px fields so iOS never zooms. */
  mobile?: boolean;
  /** A power-dialer session is running: Save becomes "Save & next call", and this dials on once saved. */
  onNext?: () => void;
  /** Open record, when the host has to do something first (the phone minimises). */
  onOpenRecord?: () => void;
};

/**
 * The wrap-up. A call whose party is a seller logs an outcome
 * (OutcomePicker: the stage, the next task and the text in one save); a
 * buyer or an unknown number keeps Talkr's disposition grid. The two never
 * mount together, so only one key handler is ever listening.
 */
export function WrapUpCard(props: WrapUpProps) {
  const target = props.V.outcomeTarget;
  return target
    ? <SellerWrapUp V={props.V} target={target} mobile={props.mobile} onOpenRecord={props.onOpenRecord} />
    : <DispositionWrapUp {...props} />;
}

/**
 * The wrap-up: Talkr's (keyboard dispositions, note, follow-up, save the
 * number as a contact) and CLOZR's (the AI summary, the CRM fields it drew
 * from the call, and Accept, which writes them to the seller record).
 */
function DispositionWrapUp({
  V,
  stickyFooter = false,
  mobile = false,
  onNext,
  onOpenRecord,
}: WrapUpProps) {
  const { notes, setNotes, authed, me } = useSoftphone();
  const call = V.talkrPhone.sp.call;
  const callId = authed && call && call.id !== 'unknown' ? call.id : null;
  const dispositions = authed
    ? V.talkrPhone.data.dispositions
    : V.dispositions.map((d) => ({ slug: d.label, name: d.label, requires_follow_up: false, adds_suppression: false }));
  const [selected, setSelected] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  // The rep's corrections to the CRM fields, by field. A field they have not
  // touched shows (and saves) what the summary said, even if that arrives late.
  const [edits, setEdits] = useState<Parameters<ClozrView['acceptWrap']>[0]>({});
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Set once the wrap-up is handed off. acceptWrap makes several writes before
  // the card closes, and a second Enter or click would log the note, the
  // activity and the task twice.
  const handedOff = useRef(false);
  const [handed, setHanded] = useState(false);
  const noAnswer = V.wrapNoAnswer;
  const other = call ? (call.direction === 'outbound' ? call.to_number : call.from_number) : '';
  const known = Boolean(V.callRecord) || Boolean(call?.contact_id) || Boolean(call?.contact_name);

  const save = useCallback(async () => {
    if (handedOff.current || saving || (!selected && !V.canAccept && !noAnswer)) return;
    setError(null);
    if (selected && !authed) {
      V.queueSession?.logCall(selected, { noAnswer, talked: false });
      V.dispositions.find((d) => d.label === selected)?.go();
      return;
    }
    if (selected && callId) {
      setSaving(true);
      try {
        await api.setDisposition(callId, {
          disposition: selected,
          note: notes || undefined,
          follow_up_at: followUp ? new Date(followUp).toISOString() : undefined,
        });
      } catch (e) {
        setError((e as Error).message);
        setSaving(false);
        return;
      }
      setSaving(false);
      // The outcome and the note go on the call's own row, once
      // (lib/call-outcome-write); the draft clears so hang-up does not file it again.
      V.saveCallNote(notes, V.callTarget, { callId, outcome: dispositions.find((d) => d.slug === selected)?.name ?? selected });
      setNotes('');
    }
    handedOff.current = true;
    setHanded(true);
    // A running session counts the call by what the disposition means (lib/dial-session.ts).
    V.queueSession?.logCall(dispositions.find((d) => d.slug === selected)?.name ?? selected, { noAnswer, talked: !noAnswer && V.canAccept });
    if (!noAnswer && V.canAccept) V.acceptWrap(Object.fromEntries(V.wrapFields.map((f) => [f.key, edits[f.key] ?? f.v])));
    else V.dismissWrap();
  }, [saving, selected, authed, callId, notes, setNotes, followUp, noAnswer, edits, V, dispositions]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || (e.target as HTMLElement | null)?.isContentEditable) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
        return;
      }
      const idx = KEY_ORDER.indexOf(e.key);
      if (idx >= 0 && dispositions[idx]) {
        setSelected(dispositions[idx].slug);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        void save();
      } else if (e.key.toLowerCase() === 'n') {
        noteRef.current?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispositions, save]);

  const chosen = dispositions.find((d) => d.slug === selected);
  /** Skip, or Done on a call nobody answered: a running session still counts the no-answer. */
  const skipWrap = () => {
    if (noAnswer) V.queueSession?.logCall(null, { noAnswer: true, talked: false });
    V.dismissWrap();
  };
  const transcriptText = V.transcript.map((l) => `${l.who}: ${l.text}`).join('\n');

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span style={{ font: '700 15px/1.2 var(--sans)', letterSpacing: '-0.01em' }}>Call wrap-up · {V.callTarget.name}</span>
            <span style={{ font: '500 11.5px/1.4 var(--sans)', color: 'var(--muted)' }}>{V.wrapStatusLine}</span>
          </div>
          {V.callRecord && (
            <Button tone="ghost" onClick={onOpenRecord ?? V.callRecord.open} style={{ padding: '7px 10px', font: '600 11.5px/1 var(--sans)' }}>
              Open record
              <Icon name="chevron-right" size={12} />
            </Button>
          )}
        </div>
        {!mobile && (
          <p style={{ font: '400 11.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
            Press a key to pick, <kbd className="rounded px-1" style={{ background: 'var(--panel-2)' }}>n</kbd> for notes,{' '}
            <kbd className="rounded px-1" style={{ background: 'var(--panel-2)' }}>Enter</kbd> to save.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          {dispositions.map((d, i) => (
            <button
              key={d.slug}
              type="button"
              onClick={() => setSelected(selected === d.slug ? null : d.slug)}
              className="flex items-center gap-2 px-3 py-2 text-left"
              style={{
                borderRadius: 'var(--r-btn)',
                border: `1px solid ${selected === d.slug ? 'var(--accent)' : 'var(--line)'}`,
                background: selected === d.slug ? 'var(--accent-soft)' : 'var(--panel)',
                boxShadow: selected === d.slug ? 'inset 0 1px 3px rgba(20, 30, 55, .14)' : 'var(--shadow-rest)',
                font: mobile ? '500 15px/1.2 var(--sans)' : '500 12.5px/1.2 var(--sans)',
                cursor: 'pointer',
                ...(mobile ? { minHeight: 50, color: 'var(--text)' } : {}),
              }}
            >
              {!mobile && <span className="rounded px-1.5" style={{ background: 'var(--bg)', font: '500 10.5px/1.5 var(--sans)', color: 'var(--muted)' }}>{KEY_ORDER[i] ?? ''}</span>}
              {d.name}
              {d.adds_suppression && <span className="ml-auto" style={{ font: '600 10.5px/1 var(--sans)', color: 'var(--red)' }}>DNC</span>}
            </button>
          ))}
        </div>

        {authed && other && !known && !savedName && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5" style={{ borderRadius: 'var(--r-btn)', border: '1px solid var(--line)', background: 'var(--panel-2)' }}>
            <span style={{ font: '400 12.5px/1.3 var(--sans)' }}>
              Save <span style={{ fontWeight: 600 }}>{formatPhone(other) || other}</span> as a contact
            </span>
            <span className="ml-auto">
              <AddContactButton phone={other} tone="dark" onCreated={(contact) => setSavedName(contact.display_name)} />
            </span>
          </div>
        )}
        {savedName && (
          <p style={{ font: '400 12.5px/1.3 var(--sans)', color: 'var(--muted)' }}>
            Saved as <span style={{ fontWeight: 600, color: 'var(--text)' }}>{savedName}</span>.
          </p>
        )}

        <textarea
          ref={noteRef}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (seller motivation, condition, price talk…)"
          rows={3}
          className="w-full outline-none"
          style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--bg)', padding: 12, font: mobile ? '400 16px/1.45 var(--sans)' : '400 12.5px/1.5 var(--sans)', ...(mobile ? { minHeight: 96 } : {}) }}
        />
        {chosen?.requires_follow_up && (
          <label className="flex flex-col gap-1">
            <Eyebrow>Follow-up</Eyebrow>
            <input
              type="datetime-local"
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              className="w-full outline-none"
              style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--bg)', padding: 8, font: mobile ? '400 16px/1.2 var(--sans)' : '400 12.5px/1 var(--sans)' }}
            />
          </label>
        )}
      </Card>

      <Card className="flex flex-col gap-2" style={{ background: 'var(--accent-soft)', borderColor: 'rgba(10, 133, 96,.18)' }}>
        <Eyebrow>Call summary</Eyebrow>
        <p style={{ font: '400 12.5px/1.55 var(--sans)' }}>{V.summaryText}</p>
        {!noAnswer && (
          <div className="flex gap-4" style={{ font: '500 11.5px/1 var(--sans)', color: 'var(--muted)' }}>
            <span>
              Sentiment <b style={{ fontWeight: 600, color: V.sentimentColor }}>{V.sentimentLabel}</b>
            </span>
            <span>
              Talk ratio <b style={{ fontWeight: 600, color: 'var(--text)' }}>{V.talkRatioLabel}</b>
            </span>
          </div>
        )}
      </Card>

      {!noAnswer && V.wrapFields.length > 0 && <WrapFieldsCard V={V} edits={edits} setEdits={setEdits} mobile={mobile} />}

      {!noAnswer && (
        <CoachingReviewCard
          demo={!authed}
          auto={!!callId}
          transcript={transcriptText}
          repName={firstName(me?.display_name, 'Rep')}
          prospectName={firstName(V.callTarget?.name, 'Prospect')}
          workspaceId={V.liveIds?.workspaceId}
          talkrCallId={callId}
          source="live"
        />
      )}

      {error && <p style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--red)' }}>{error}</p>}

      {stickyFooter ? (
        // Pinned to the bottom of the phone's scroller: Save is always one
        // thumb away, however long the summary and the fields run.
        <div
          data-testid="wrap-footer"
          className="flex gap-2"
          style={{
            position: 'sticky', bottom: 0, zIndex: 2, margin: '0 -16px', padding: '12px 16px max(env(safe-area-inset-bottom, 0px), 12px)',
            background: 'rgba(242,242,247,.94)', WebkitBackdropFilter: 'blur(16px)', backdropFilter: 'blur(16px)',
            borderTop: '0.5px solid rgba(60,60,67,.18)',
          }}
        >
          <button
            type="button"
            data-testid="wrap-skip"
            onClick={skipWrap}
            style={{ flex: 1, height: 50, borderRadius: 14, border: '1px solid var(--line)', background: '#fff', color: 'var(--text)', font: '600 17px/1 var(--sans)' }}
          >
            {noAnswer ? 'Done' : 'Skip'}
          </button>
          <button
            type="button"
            data-testid="wrap-save"
            onClick={() => {
              const already = handedOff.current;
              void save().then(() => {
                if (!already && handedOff.current) onNext?.();
              });
            }}
            disabled={handed || saving || (!selected && !V.canAccept && !noAnswer)}
            style={{
              flex: 2, height: 50, borderRadius: 14, border: 0, background: '#0A8560', color: '#fff', font: '600 17px/1 var(--sans)',
              opacity: handed || saving || (!selected && !V.canAccept && !noAnswer) ? 0.45 : 1,
            }}
          >
            {saving ? 'Saving…' : onNext ? 'Save & next call' : 'Save'}
          </button>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button tone="quiet" onClick={skipWrap}>
            {noAnswer ? 'Done' : 'Skip'}
          </Button>
          <Button tone="accent" onClick={() => void save()} disabled={handed || saving || (!selected && !V.canAccept && !noAnswer)}>
            {saving ? 'Saving…' : noAnswer || !V.canAccept ? 'Save' : 'Save & accept changes'}
          </Button>
        </div>
      )}
    </div>
  );
}

type WrapEdits = Parameters<ClozrView['acceptWrap']>[0];

/**
 * What the call summary drew from the call, for the rep to correct before it
 * is written: the desk and phone wrap-ups (`talkr`, inside a Talkr panel) and
 * Today's "From this call" (`plain`, in CLOZR's own styles).
 */
export function WrapFieldsCard({
  V,
  edits,
  setEdits,
  mobile = false,
  variant = 'talkr',
}: {
  V: ClozrView;
  edits: WrapEdits;
  setEdits: (next: (prev: WrapEdits) => WrapEdits) => void;
  mobile?: boolean;
  variant?: 'talkr' | 'plain';
}) {
  const plain = variant === 'plain';
  const rows = V.wrapFields.map((f) => (
    <label key={f.key} className="grid gap-2 py-1.5" style={{ gridTemplateColumns: plain ? '132px 1fr' : '120px 1fr', borderBottom: plain ? '1px solid #F0F0F1' : '1px solid var(--line-soft)' }}>
      <span style={plain ? { fontSize: 13, fontWeight: 500, lineHeight: 1.45, color: '#52525B' } : { font: '500 11.5px/1.35 var(--sans)', color: 'var(--muted)' }}>{f.k}</span>
      {/* A one-row textarea that grows with its text, so a long value
          wraps the way the plain text did instead of scrolling out of sight. */}
      <textarea
        className="dc24 w-full min-w-0"
        // field-sizing grows it in Chromium; elsewhere, size it from the text.
        rows={Math.max(1, Math.ceil(String(edits[f.key] ?? f.v ?? '').length / 42))}
        value={edits[f.key] ?? f.v}
        onChange={(e) => setEdits((prev) => ({ ...prev, [f.key]: e.target.value }))}
        placeholder="—"
        style={{
          ...(plain ? { fontSize: 13, fontWeight: 500, lineHeight: 1.45, fontFamily: 'inherit' } : { font: mobile ? '500 16px/1.35 var(--sans)' : '500 12px/1.35 var(--sans)' }),
          outline: 0, borderRadius: 5, border: 0, background: 'transparent', padding: 0, color: 'inherit', resize: 'none', fieldSizing: 'content',
        }}
      />
    </label>
  ));
  if (plain) {
    return (
      <div style={{ background: '#FFFFFF', border: '1px solid #E4E4E7', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#52525B' }}>From this call</h3>
        {rows}
      </div>
    );
  }
  return (
    <Card className="flex flex-col gap-1">
      <Eyebrow className="pb-1">Updated CRM fields</Eyebrow>
      {rows}
    </Card>
  );
}

/** Play a voicemail in the same smart player the inbox's Calls tab uses. */
function VoicemailPlay({ id, hasRecording }: { id: string | null; hasRecording: boolean }) {
  const [open, setOpen] = useState(false);
  if (!id || !hasRecording) return <span style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted)', alignSelf: 'center' }}>No recording</span>;
  if (open) return <div style={{ flexBasis: '100%', width: '100%', minWidth: 0, order: 9 }}><TalkrCallRecording talkrCallId={id} autoPlay /></div>;
  return (
    <Button tone="ghost" onClick={() => setOpen(true)} style={{ padding: '6px 9px', font: '600 10.5px/1 var(--sans)' }}>
      <Icon name="play" size={11} />
      Play
    </Button>
  );
}
