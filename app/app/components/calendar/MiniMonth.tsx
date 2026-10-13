// The small month in the sidebar — Google Calendar mini-month with circular
// selection and busy dots.
'use client';

import React from 'react';
import { addMonths, isToday, monthGrid, sameDay } from '@/lib/calendar';
import { Chevron } from '@/components/ds/chrome';
import { INK, MINT, MUTED } from './ui';

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function MiniMonth({ month, selected, busyDays, onPick, onMonth }: {
  month: Date; selected: Date; busyDays: Set<string>;
  onPick: (d: Date) => void; onMonth: (d: Date) => void;
}) {
  const days = monthGrid(month);
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ font: '500 14px/1.2 var(--font-sans)', color: '#3c4043', flex: 1 }}>
          {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </span>
        <button type="button" className="cz-icon-btn" onClick={() => onMonth(addMonths(month, -1))} aria-label="Previous month" style={{ width: 28, height: 28 }}>
          <Chevron dir="left" size={14} color="#3c4043" />
        </button>
        <button type="button" className="cz-icon-btn" onClick={() => onMonth(addMonths(month, 1))} aria-label="Next month" style={{ width: 28, height: 28 }}>
          <Chevron dir="right" size={14} color="#3c4043" />
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0 }}>
        {DOW.map((d, i) => (
          <span key={i} style={{ font: '500 10px/1 var(--font-sans)', color: '#70757a', textAlign: 'center', padding: '4px 0' }}>{d}</span>
        ))}
        {days.map((d) => {
          const inMonth = d.getMonth() === month.getMonth();
          const sel = sameDay(d, selected);
          const today = isToday(d);
          return (
            <button
              key={key(d)}
              type="button"
              onClick={() => onPick(d)}
              style={{
                height: 28, border: 0, borderRadius: '50%', cursor: 'pointer',
                font: `${sel || today ? 600 : 400} 12px/1 var(--font-sans)`,
                position: 'relative',
                background: sel ? MINT : 'transparent',
                color: sel ? '#fff' : today ? MINT : inMonth ? INK : '#dadce0',
              }}
            >
              {d.getDate()}
              {busyDays.has(key(d)) && !sel ? (
                <span style={{ position: 'absolute', left: '50%', bottom: 2, width: 3, height: 3, marginLeft: -1.5, borderRadius: '50%', background: MUTED }} />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
