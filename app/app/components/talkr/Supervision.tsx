'use client';

/**
 * Supervision: teammates' live calls with Listen / Whisper / Barge, and the
 * card for the call being monitored. Renders nothing for anyone the server
 * does not let monitor (GET /v1/calls/live answers 403), and nothing in the
 * sample-data demo.
 *
 * Listen hears everyone and is heard by no one; Whisper is heard by the rep
 * only; Barge joins the conversation. The monitor leg rings this browser and
 * the softphone answers it (softphoneAdapter.tsx).
 */

import { useEffect, useState } from 'react';
import type { LiveCallDto, MonitorMode } from '@/lib/talkr-web/api';
import { duration, formatPhone } from '@/lib/talkr-web/time';
import { useSoftphone } from './softphoneAdapter';
import { Icon } from './Icon';
import { Avatar, EmptyState, Eyebrow } from './ui';
import { IosSegmented } from './ios';

const MODES: Array<{ value: MonitorMode; label: string }> = [
  { value: 'listen', label: 'Listen' },
  { value: 'whisper', label: 'Whisper' },
  { value: 'barge', label: 'Barge' },
];

const MODE_HINT: Record<MonitorMode, string> = {
  listen: 'You hear both sides. Nobody hears you.',
  whisper: 'Only the rep hears you. The caller does not.',
  barge: 'Everyone hears you.',
};

const MODE_NOW: Record<MonitorMode, string> = { listen: 'Listening', whisper: 'Whispering', barge: 'Barged in' };

const PILL: React.CSSProperties = {
  border: '1px solid var(--line)',
  background: 'var(--panel)',
  color: 'var(--text)',
  borderRadius: 999,
  font: '600 10.5px/1 var(--sans)',
  padding: '7px 10px',
  cursor: 'pointer',
};

/** Seconds since the server's snapshot, ticking locally between polls. */
function useTicking(seconds: number) {
  const [extra, setExtra] = useState(0);
  useEffect(() => {
    const at = Date.now();
    setExtra(0);
    const t = setInterval(() => setExtra(Math.floor((Date.now() - at) / 1000)), 1000);
    return () => clearInterval(t);
  }, [seconds]);
  return seconds + extra;
}

function who(c: LiveCallDto) {
  return c.counterparty.name ?? formatPhone(c.counterparty.number);
}

function Row({ call }: { call: LiveCallDto }) {
  const { startMonitor, monitor, callState } = useSoftphone();
  const secs = useTicking(call.duration_seconds);
  const busy = monitor !== null || callState !== 'idle';
  return (
    <div className="flex flex-wrap items-center gap-2.5 px-2 py-2" style={{ borderBottom: '1px solid var(--line-soft)' }}>
      <Avatar name={call.rep.display_name} size={28} />
      <span className="mr-auto flex min-w-0 flex-col gap-1">
        <span className="truncate" style={{ font: '600 12px/1 var(--sans)' }}>
          {call.rep.display_name}
        </span>
        <span className="truncate" style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted)' }}>
          {call.direction === 'inbound' ? 'from' : 'with'} {who(call)} · {duration(secs)}
        </span>
      </span>
      <span className="flex gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            disabled={busy}
            title={busy ? 'Finish your current call first.' : MODE_HINT[m.value]}
            onClick={() => void startMonitor(call, m.value)}
            className="disabled:opacity-40"
            style={PILL}
          >
            {m.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** The call being monitored: who, how long, the mode switch, and Leave. */
export function MonitorCard() {
  const { monitor, switchMonitor, leaveMonitor, callState, controlError } = useSoftphone();
  const secs = useTicking(monitor?.call.duration_seconds ?? 0);
  if (!monitor) return null;
  const { call, mode } = monitor;
  return (
    <section
      className="flex flex-col items-center gap-3 px-4 pb-5 pt-6 text-center"
      style={{ borderRadius: 'var(--r-lg)', background: 'var(--panel)' }}
      aria-label="Monitoring a call"
    >
      <Avatar name={call.rep.display_name} size={64} />
      <span className="display max-w-full truncate" style={{ font: '600 22px/1.1 var(--sans)' }}>
        {call.rep.display_name}
      </span>
      <span style={{ font: '500 13px/1.2 var(--sans)', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
        {callState === 'in_call' ? `${MODE_NOW[mode]}` : 'Connecting'} · {who(call)} ·{' '}
        {duration(secs)}
      </span>
      <IosSegmented value={mode} onChange={(m) => void switchMonitor(m)} options={MODES} full />
      <p style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted)' }}>{MODE_HINT[mode]}</p>
      {controlError && (
        <p role="status" style={{ font: '500 11px/1.4 var(--sans)', color: 'var(--red)' }}>
          {controlError}
        </p>
      )}
      <button
        type="button"
        onClick={() => void leaveMonitor()}
        className="inline-flex items-center gap-2"
        style={{ ...PILL, background: 'var(--red)', color: '#fff', borderColor: 'transparent', padding: '11px 18px', font: '600 12px/1 var(--sans)' }}
      >
        <Icon name="x" size={13} />
        Leave
      </button>
    </section>
  );
}

/** Teammates' live calls. Null when the viewer cannot monitor. */
export function LiveCalls() {
  const { liveCalls, monitor } = useSoftphone();
  if (liveCalls === null) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <Eyebrow>Live calls</Eyebrow>
      {monitor && <MonitorCard />}
      {liveCalls.length === 0 && !monitor && (
        <EmptyState compact icon="phone" title="Nobody is on a call" hint="Teammates' live calls show here to listen in, whisper or barge." />
      )}
      {liveCalls
        .filter((c) => c.call_id !== monitor?.call.call_id)
        .map((c) => (
          <Row key={c.call_id} call={c} />
        ))}
    </div>
  );
}
