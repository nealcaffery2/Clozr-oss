'use client';

/**
 * Talkr's persistent call bar, on every CLOZR screen while a call is live.
 *
 * Unlike Talkr's (fixed over the page), this one sits in the shell's column
 * under <main>, so the screen shrinks to make room instead of losing its
 * bottom edge. Its height is published as --clozr-callbar so the fixed layers
 * (side panels, the floating buttons, toasts) stand on it rather than behind it.
 *
 * Transfer, Add call, Text/Email and the keypad live here too — not only on
 * the full dialer — so a desk call never forces the rep into another screen.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { useSoftphone } from './softphoneAdapter';
import { formatDialed } from './DialerParts';
import { Icon, HangupIcon } from './Icon';
import { Button } from './ui';
import { PhoneText } from './CopyPhone';
import { ProspectTime } from './ProspectTime';
import { duration } from '@/lib/talkr-web/time';
import { toE164 } from '@/lib/talkr';

const DARK_BTN: CSSProperties = { background: 'rgba(255,255,255,.06)', border: '1px solid var(--dark-2)', color: '#e4e4e7' };
const PANEL_IN = {
  width: '100%', height: 36, borderRadius: 9, border: '1px solid var(--dark-2)',
  background: 'rgba(255,255,255,.06)', color: '#fff', padding: '0 12px',
  font: '500 13px/1 var(--sans)', outline: 0,
} as const;

type Panel = 'none' | 'keypad' | 'add' | 'transfer' | 'message';

export function CallBar({ V }: { V: ClozrView }) {
  const {
    callState, active, serverStatus, hangup, toggleMute, sendDigit,
    onHold, toggleHold, participants, addParticipant, transfer, completeTransfer, team,
  } = useSoftphone();
  const [elapsed, setElapsed] = useState(0);
  const [panel, setPanel] = useState<Panel>('none');
  const [digits, setDigits] = useState('');
  const [xferMode, setXferMode] = useState<'warm' | 'blind'>('warm');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const startedAt = active?.startedAt ?? null;
  useEffect(() => {
    if (callState !== 'in_call' || !startedAt) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [callState, startedAt]);

  // The full Dialer screen already is the call; the bar would only repeat it.
  // On a phone the call is a full-screen sheet (DialerPanel), never a strip.
  const shown = callState !== 'idle' && callState !== 'wrapup' && !!active && !V.isDialer && !V.isMobile;

  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!shown || !el) return;
    const ro = new ResizeObserver(() => root.style.setProperty('--clozr-callbar', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--clozr-callbar');
    };
  }, [shown, panel]);

  useEffect(() => {
    if (!shown) { setPanel('none'); setDigits(''); }
  }, [shown]);

  if (!shown || !active) return null;

  const statusLabel = onHold
    ? 'On hold'
    : callState === 'connecting' || callState === 'ringing'
      ? serverStatus === 'ringing' || callState === 'ringing' ? 'Ringing…' : 'Connecting…'
      : 'Live';
  const counterparty = active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number;
  const record = V.dialerRecordFor(counterparty);
  const others = participants.filter((p) => p.state !== 'left' && p.role !== 'agent').length;
  const e164 = toE164(digits) ?? '';
  const valid = e164.length >= 10;
  const inCall = callState === 'in_call';
  const warmPending = participants.some((p) => p.role === 'agent' && p.state !== 'left')
    && participants.some((p) => p.role !== 'agent' && p.state !== 'left');

  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? 'none' : p));

  const runAdd = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await addParticipant({ to_number: e164, consult: true });
      setDigits('');
      setPanel('none');
    } finally { setBusy(false); }
  };
  const runTransfer = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await transfer({ mode: xferMode, to_number: e164 });
      setDigits('');
      setPanel('none');
    } finally { setBusy(false); }
  };
  const message = (ch: 'text' | 'email') => {
    const pid = record?.target?.personId;
    if (pid) {
      V.openQuickReach(ch, pid);
      setPanel('none');
      return;
    }
    if (V.can.inbox) V.goInbox();
    setPanel('none');
  };

  const btn = (active: boolean): CSSProperties => ({
    ...DARK_BTN,
    background: active ? 'var(--accent)' : DARK_BTN.background,
    color: active ? '#fff' : DARK_BTN.color,
  });

  return (
    <div
      ref={ref}
      data-screen-label="Live call"
      data-testid="call-bar"
      className="talkr-dialer"
      style={{ flexShrink: 0, borderTop: '1px solid var(--dark-2)', background: 'var(--ink)', position: 'relative', zIndex: 44 }}
    >
      <div className="flex items-center gap-1.5 px-3 py-2.5 md:gap-2.5 md:px-5" style={{ flexWrap: 'wrap' }}>
        <span
          style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: !onHold && callState === 'in_call' ? 'var(--green)' : 'var(--amber)',
            animation: 'bluepulse 2.4s ease-in-out infinite',
          }}
          aria-hidden
        />
        <div className="min-w-0 flex-1" style={{ minWidth: 140 }}>
          <div className="flex min-w-0 items-center gap-2" style={{ font: '600 13px/1.3 var(--sans)', color: '#fff' }}>
            {record && <span className="truncate">{record.name}</span>}
            <PhoneText e164={counterparty} size={20} tone="dark" />
            {others > 1 && (
              <span className="truncate" style={{ color: 'var(--muted-2)', font: '500 12px/1 var(--sans)' }}>
                · {others} on the line
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5" style={{ font: '500 11px/1.4 var(--sans)', color: 'var(--muted-2)' }}>
            <span>
              {statusLabel}
              {active.startedAt ? ` · ${duration(elapsed)}` : ''}
            </span>
            {record?.address && <span className="truncate">{record.address}</span>}
            <ProspectTime e164={counterparty} tone="dark" size={11} />
          </div>
        </div>

        {record && (
          <Button tone="ghost" onClick={record.open} style={DARK_BTN}>
            <Icon name="user" size={15} />
            <span className="hidden xl:inline">Record</span>
          </Button>
        )}
        {!V.isToday && (
          <Button tone="ghost" onClick={V.openDialer} style={DARK_BTN}>
            <Icon name="phone" size={15} />
            <span className="hidden xl:inline">Dialer</span>
          </Button>
        )}
        <Button tone="ghost" onClick={toggleMute} style={btn(!!active.muted)}>
          <Icon name={active.muted ? 'mic-off' : 'mic'} size={15} />
          <span className="hidden md:inline">{active.muted ? 'Unmute' : 'Mute'}</span>
        </Button>
        <Button tone="ghost" onClick={() => void toggleHold()} style={btn(onHold)}>
          <Icon name="pause" size={15} />
          <span className="hidden md:inline">{onHold ? 'Resume' : 'Hold'}</span>
        </Button>
        <Button tone="ghost" onClick={() => toggle('keypad')} style={btn(panel === 'keypad')} aria-pressed={panel === 'keypad'}>
          <Icon name="grid" size={15} />
          <span className="hidden md:inline">Keypad</span>
        </Button>
        <Button tone="ghost" onClick={() => toggle('add')} style={btn(panel === 'add')} disabled={!inCall} title={!inCall ? 'Wait until the call is live' : undefined}>
          <Icon name="plus" size={15} />
          <span className="hidden md:inline">Add call</span>
        </Button>
        <Button tone="ghost" onClick={() => toggle('transfer')} style={btn(panel === 'transfer')} disabled={!inCall} title={!inCall ? 'Wait until the call is live' : undefined}>
          <Icon name="transfer" size={15} />
          <span className="hidden md:inline">Transfer</span>
        </Button>
        <Button tone="ghost" onClick={() => toggle('message')} style={btn(panel === 'message')}>
          <Icon name="msg" size={15} />
          <span className="hidden md:inline">Text / Email</span>
        </Button>
        <Button tone="red" onClick={hangup}>
          <HangupIcon size={15} />
          <span className="hidden sm:inline">End</span>
        </Button>
      </div>

      {warmPending && (
        <div className="flex items-center gap-2 px-3 pb-2 md:px-5">
          <span style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted-2)', flex: 1 }}>
            Live transfer in progress — caller is on hold.
          </span>
          <Button tone="ghost" onClick={() => void completeTransfer()} style={{ ...DARK_BTN, background: '#0A8560', borderColor: '#0A8560', color: '#fff' }}>
            Complete transfer
          </Button>
        </div>
      )}

      {panel === 'keypad' && (
        <div data-testid="callbar-keypad" className="flex justify-center px-3 pb-3" style={{ borderTop: '1px solid var(--dark-2)' }}>
          <div
            className="rounded-2xl p-3 mt-2"
            style={{ background: 'rgba(255,255,255,.04)', border: '1px solid var(--dark-2)' }}
          >
            {/* Dark keys on the dark bar — not the light ios-key island. */}
            <div className="mx-auto grid w-max grid-cols-3 gap-x-3 gap-y-2.5">
              {(['1','2','3','4','5','6','7','8','9','*','0','#'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => sendDigit(d)}
                  aria-label={d === '*' ? 'star' : d === '#' ? 'pound' : d}
                  style={{
                    width: 52, height: 52, borderRadius: '50%', border: 0, cursor: 'pointer',
                    background: 'rgba(255,255,255,.12)', color: '#fff',
                    display: 'inline-flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    font: '400 20px/1 var(--sans)',
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {(panel === 'add' || panel === 'transfer') && (
        <div data-testid={`callbar-${panel}`} className="px-3 pb-3 md:px-5" style={{ borderTop: '1px solid var(--dark-2)' }}>
          <div className="mt-2 flex flex-col gap-2" style={{ maxWidth: 480 }}>
            <div style={{ font: '600 11px/1 var(--sans)', color: 'var(--muted-2)' }}>
              {panel === 'add' ? 'Add someone to this call' : 'Transfer this call'}
            </div>
            {panel === 'transfer' && (
              <div className="flex gap-1.5">
                {([
                  ['warm', 'Live transfer'],
                  ['blind', 'Transfer & hang up'],
                ] as const).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setXferMode(m)}
                    style={{
                      ...DARK_BTN, height: 30, padding: '0 10px', borderRadius: 8, cursor: 'pointer',
                      background: xferMode === m ? 'var(--accent)' : DARK_BTN.background,
                      color: xferMode === m ? '#fff' : DARK_BTN.color, font: '600 12px/1 var(--sans)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2 items-center">
              <input
                value={formatDialed(digits)}
                onChange={(e) => setDigits(e.target.value.replace(/[^\d+*#]/g, '').slice(0, 16))}
                placeholder={panel === 'add' ? 'Number to add' : 'Number to transfer to'}
                inputMode="tel"
                style={PANEL_IN}
              />
              <Button
                tone="ghost"
                disabled={!valid || busy}
                onClick={() => void (panel === 'add' ? runAdd() : runTransfer())}
                style={{ ...DARK_BTN, background: valid ? '#0A8560' : DARK_BTN.background, border: valid ? '1px solid #0A8560' : DARK_BTN.border, color: '#fff', opacity: valid ? 1 : 0.5 }}
              >
                {busy ? '…' : panel === 'add' ? 'Add' : 'Transfer'}
              </Button>
            </div>
            {team.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {team.slice(0, 6).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void (async () => {
                        setBusy(true);
                        try {
                          if (panel === 'add') await addParticipant({ user_id: m.id, consult: true });
                          else await transfer({ mode: xferMode, user_id: m.id });
                          setPanel('none');
                        } finally { setBusy(false); }
                      })();
                    }}
                    style={{ ...DARK_BTN, height: 28, padding: '0 10px', borderRadius: 8, cursor: 'pointer', font: '500 12px/1 var(--sans)' }}
                  >
                    {m.display_name}
                  </button>
                ))}
              </div>
            )}
            <div style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted-2)' }}>
              {panel === 'add'
                ? 'They join on consult hold — merge when you are ready.'
                : xferMode === 'warm'
                  ? 'Caller waits on hold while you talk first, then complete the transfer.'
                  : 'Hands the caller over and drops you from the call.'}
            </div>
          </div>
        </div>
      )}

      {panel === 'message' && (
        <div data-testid="callbar-message" className="flex items-center gap-2 px-3 pb-3 md:px-5" style={{ borderTop: '1px solid var(--dark-2)' }}>
          <span style={{ font: '500 12px/1.3 var(--sans)', color: 'var(--muted-2)', flex: 1, minWidth: 0 }} className="truncate">
            {record ? `Message ${record.name}` : counterparty ? `Message ${counterparty}` : 'No number on this call'}
          </span>
          <Button tone="ghost" disabled={!counterparty && !record} onClick={() => message('text')} style={DARK_BTN}>
            <Icon name="msg" size={15} /> Text
          </Button>
          <Button tone="ghost" disabled={!record?.target?.personId} onClick={() => message('email')} style={DARK_BTN} title={!record?.target?.personId ? 'Email needs a CRM record' : undefined}>
            <Icon name="mail" size={15} /> Email
          </Button>
        </div>
      )}
    </div>
  );
}
