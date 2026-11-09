'use client';

// Scheduled texts in the composer and the thread (migration 367): the "Send
// later" half of the Send control, with presets and a date-time field, and the
// pending bubble a scheduled text shows until the tick sends it.

import React, { useEffect, useId, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { PRESETS, type SchedulePreset, presetTime, scheduleProblem, sendsLabel, toLocalInput } from '@/lib/inbox-schedule';
import type { ScheduledRow } from '@/lib/use-scheduled';
import { Bubble } from '@/app/components/talkr/Bubble';

/** The clock button beside Send: a popover with presets and a time field. */
export function SendLater({ disabled, initial = null, editing = false, onPick, onCancelEdit }: {
  disabled: boolean;
  /** The time an edited row already has. */
  initial?: Date | null;
  editing?: boolean;
  onPick: (at: Date) => Promise<string | null>;
  onCancelEdit?: () => void;
}) {
  // The parent keys this on the row being edited, so `initial` is read once.
  const [open, setOpen] = useState(!!initial);
  const [when, setWhen] = useState(() => toLocalInput(initial ?? presetTime('hour')!));
  const [picked, setPicked] = useState<SchedulePreset>(initial ? 'pick' : 'hour');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const choose = (p: SchedulePreset) => {
    setPicked(p);
    const t = presetTime(p);
    if (t) setWhen(toLocalInput(t));
    setErr(null);
  };
  const at = new Date(when);
  const problem = scheduleProblem(at);
  const go = async () => {
    if (problem) { setErr(problem); return; }
    setBusy(true);
    const e = await onPick(at);
    setBusy(false);
    if (e) { setErr(e); return; }
    setOpen(false);
    setPicked('hour');
    setWhen(toLocalInput(presetTime('hour')!));
  };
  return (
    <span ref={root} className="ax-menu ax-later" data-open={open || undefined}>
      <button type="button" className="send-later" aria-label={editing ? 'Change when it sends' : 'Send later'} title={editing ? 'Change when it sends' : 'Send later'}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={id} disabled={disabled && !editing} onClick={() => setOpen((v) => !v)}>
        <Clock size={15} strokeWidth={2.4} aria-hidden />
      </button>
      {open && (
        <div id={id} role="dialog" aria-label="Send later" className="ax-menu-pop ax-later-pop" data-align="end">
          <p className="ax-menu-h">{editing ? 'Sends instead at' : 'Send later'}</p>
          <div className="ax-later-presets" role="group" aria-label="When">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className="ax-fchip" aria-pressed={picked === p.id} onClick={() => choose(p.id)}>{p.label}</button>
            ))}
          </div>
          <label className="ax-flabel ax-later-when">Date and time
            <input type="datetime-local" value={when} min={toLocalInput(new Date())} onChange={(e) => { setWhen(e.target.value); setPicked('pick'); setErr(null); }} />
          </label>
          {err ? <p className="ax-later-err" role="alert">{err}</p> : <p className="ax-later-hint">{problem ?? sendsLabel(at)}</p>}
          <div className="ax-later-foot">
            {editing && onCancelEdit ? <button type="button" className="ax-tool" onClick={() => { setOpen(false); onCancelEdit(); }}>Keep as is</button> : null}
            <button type="button" className="ax-tool ax-tool-accent" disabled={busy || !!problem} onClick={() => void go()}>{busy ? 'Scheduling…' : editing ? 'Move it' : 'Schedule'}</button>
          </div>
        </div>
      )}
    </span>
  );
}

/** A text that has not gone out yet, in the thread where it will land. */
export function ScheduledBubble({ row, onEdit, onCancel }: { row: ScheduledRow; onEdit: () => void; onCancel: () => void }) {
  const at = new Date(row.send_at);
  const failed = row.status === 'error';
  return (
    <Bubble mine tail faded={!failed} receipt={
      <span className="ax-sched-line">
        <Clock size={11} strokeWidth={2.5} aria-hidden />
        <span style={failed ? { color: 'var(--red)' } : undefined}>{failed ? `Not sent: ${row.error ?? 'unknown error'}` : sendsLabel(at)}</span>
        <button type="button" className="ax-link" onClick={onEdit}>{failed ? 'Try again' : 'Edit'}</button>
        <button type="button" className="ax-link" onClick={onCancel}>{failed ? 'Dismiss' : 'Cancel'}</button>
      </span>
    }>
      {row.body}
    </Bubble>
  );
}
