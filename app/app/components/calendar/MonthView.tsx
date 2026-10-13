// Six weeks of days, each with its events — Google Calendar month grid.
// Click a day's empty space to make an appointment; click an event to open it.
'use client';

import React from 'react';
import { type CalEvent, type Rep, fmtTime, isToday, monthGrid, sameDay, typeColor } from '@/lib/calendar';
import { INK, LINE, MINT, SOFT, SyncDot } from './ui';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function MonthView({ month, events, reps, selectedId, onOpen, onCreate, compact }: {
  month: Date; events: CalEvent[]; reps: Rep[]; selectedId: string | null;
  onOpen: (ev: CalEvent) => void; onCreate: (start: Date, end: Date) => void; compact?: boolean;
}) {
  const days = monthGrid(month);
  const colorOf = (ev: CalEvent) => reps.find((r) => r.user_id === ev.repId)?.color ?? typeColor(ev.type);
  const maxShown = compact ? 2 : 4;
  return (
    <div className="cal-grid" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, background: '#fff', borderTop: `1px solid ${LINE}`, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: `1px solid ${SOFT}` }}>
        {DOW.map((d) => (
          <div key={d} style={{ padding: '8px 4px', font: '500 11px/1 var(--font-sans)', color: '#70757a', textAlign: 'center' }}>
            {compact ? d[0] : d}
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: '1fr', flex: 1, minHeight: 0, overflow: 'auto' }}>
        {days.map((d, i) => {
          const inMonth = d.getMonth() === month.getMonth();
          const todays = events.filter((ev) => sameDay(ev.start, d) || (ev.allDay && ev.start <= d && ev.end >= d));
          const extra = todays.length - maxShown;
          const today = isToday(d);
          return (
            <div
              key={i}
              onClick={() => { const s = new Date(d); s.setHours(9, 0, 0, 0); onCreate(s, new Date(s.getTime() + 3_600_000)); }}
              style={{
                minHeight: compact ? 64 : 96, padding: '4px 2px',
                borderRight: (i % 7) === 6 ? 0 : `1px solid ${SOFT}`,
                borderBottom: i >= 35 ? 0 : `1px solid ${SOFT}`,
                background: inMonth ? '#fff' : '#f8f9fa', cursor: 'cell', minWidth: 0,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 2 }}>
                <span style={{
                  font: `${today ? 700 : 500} 12px/1 var(--font-sans)`,
                  color: today ? '#fff' : inMonth ? '#3c4043' : '#dadce0',
                  background: today ? MINT : 'transparent',
                  borderRadius: '50%', width: 24, height: 24,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {d.getDate()}
                </span>
              </div>
              {todays.slice(0, maxShown).map((ev) => {
                const c = colorOf(ev);
                const sel = selectedId === ev.id;
                return (
                  <button
                    key={ev.id}
                    type="button"
                    className="cal-event"
                    onClick={(e) => { e.stopPropagation(); onOpen(ev); }}
                    title={`${ev.allDay ? 'All day' : fmtTime(ev.start)} · ${ev.title}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left',
                      border: 0, cursor: 'pointer', padding: '1px 6px', marginBottom: 1,
                      borderRadius: 4,
                      background: sel ? INK : c,
                      color: '#fff',
                      font: '500 11px/1.3 var(--font-sans)',
                      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                      textDecoration: ev.done ? 'line-through' : 'none',
                      opacity: ev.done ? 0.55 : 1,
                    }}
                  >
                    {!compact && !ev.allDay ? <span style={{ opacity: 0.9, flex: 'none' }}>{fmtTime(ev.start)}</span> : null}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{ev.title}</span>
                    {ev.source === 'appointment' ? <SyncDot state={ev.syncState} /> : null}
                  </button>
                );
              })}
              {extra > 0 ? (
                <span style={{ font: '500 11px/1 var(--font-sans)', color: '#70757a', paddingLeft: 6 }}>+{extra} more</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
