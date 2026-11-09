'use client';

// The clock half of a record composer's Send button: the Inbox's presets
// (lib/inbox-schedule) and a date-time field. Texts and emails share it, so
// "Send later" reads the same on both tabs.

import React, { useState } from 'react';
import { Clock } from 'lucide-react';
import { PRESETS, presetTime, sendsLabel, toLocalInput, type SchedulePreset } from '@/lib/inbox-schedule';
import { primaryBtn } from './ui';

export function WhenMenu({ disabled, title, onPick }: {
  disabled?: boolean;
  title?: string;
  /** Called with the chosen time; the caller validates (scheduleProblem) and closes by returning true. */
  onPick: (at: Date | null) => Promise<boolean> | boolean;
}) {
  const [when, setWhen] = useState<null | 'menu' | 'pick'>(null);
  const [pickAt, setPickAt] = useState('');
  const pick = async (at: Date | null) => { if (await onPick(at)) setWhen(null); };
  const fallback = () => toLocalInput(presetTime('hour')!);
  return (
    <>
      <button type="button" className="dc3 rec-press" aria-label="Send later" title={title ?? 'Send later'} aria-haspopup="menu" aria-expanded={!!when} disabled={disabled}
        style={{ ...primaryBtn, height: '30px', padding: '0 8px', borderRadius: '0 8px 8px 0', borderLeft: '1px solid rgba(255,255,255,.35)', opacity: disabled ? 0.5 : 1 }} onClick={() => setWhen((w) => (w ? null : 'menu'))}>
        <Clock size={14} aria-hidden />
      </button>
      {when ? (
        <>
          <div onClick={() => setWhen(null)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div role="menu" className="rec-when" onKeyDown={(e) => { if (e.key === 'Escape') setWhen(null); }}>
            {when === 'menu' ? PRESETS.map((p: { id: SchedulePreset; label: string }) => (
              <button key={p.id} type="button" role="menuitem" className="dc2 rec-when-item" onClick={() => (p.id === 'pick' ? setWhen('pick') : void pick(presetTime(p.id)))}>
                {p.label}{p.id !== 'pick' ? <span>{sendsLabel(presetTime(p.id)!).replace(/^Sends /, '')}</span> : null}
              </button>
            )) : (
              <div style={{ padding: '6px' }}>
                <label htmlFor="rec-when-at" style={{ display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)', marginBottom: '4px' }}>Send at</label>
                <input id="rec-when-at" type="datetime-local" className="rec-email-in" value={pickAt || fallback()} min={toLocalInput(new Date())} onChange={(e) => setPickAt(e.target.value)} />
                <button type="button" className="dc3 rec-press" style={{ ...primaryBtn, height: '28px', marginTop: '8px', width: '100%' }} onClick={() => void pick(new Date(pickAt || fallback()))}>Schedule</button>
              </div>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}
