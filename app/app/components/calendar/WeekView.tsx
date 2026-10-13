// The time grid: seven days (or one), 6am–10pm — Google Calendar week/day.
// Drag across empty slots to make an appointment; click one to open it.
'use client';

import React, { useMemo, useRef, useState } from 'react';
import { type CalEvent, type Rep, DAY, addDays, fmtTime, isToday, sameDay, startOfDay, typeColor } from '@/lib/calendar';
import { INK, LINE, MINT, SOFT, SyncDot } from './ui';

const FIRST_HOUR = 6;
const LAST_HOUR = 22;
const ROW = 24; // px per half hour
const HOURS = LAST_HOUR - FIRST_HOUR;
const GUTTER = 56;

type Drag = { day: number; from: number; to: number } | null; // slots (half hours) from FIRST_HOUR

export function WeekView({ start, days, events, reps, selectedId, onOpen, onCreate }: {
  /** The first day shown, at midnight. */
  start: Date; days: 1 | 7; events: CalEvent[]; reps: Rep[]; selectedId: string | null;
  onOpen: (ev: CalEvent) => void; onCreate: (start: Date, end: Date) => void;
}) {
  const cols = useMemo(() => Array.from({ length: days }, (_, i) => addDays(start, i)), [start, days]);
  const colorOf = (ev: CalEvent) => reps.find((r) => r.user_id === ev.repId)?.color ?? typeColor(ev.type);
  const [drag, setDrag] = useState<Drag>(null);
  const dragging = useRef<Drag>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const slotAt = (e: React.MouseEvent): { day: number; slot: number } | null => {
    const g = gridRef.current;
    if (!g) return null;
    const r = g.getBoundingClientRect();
    const x = e.clientX - r.left - GUTTER;
    const y = e.clientY - r.top + g.scrollTop;
    if (x < 0) return null;
    const day = Math.min(days - 1, Math.max(0, Math.floor(x / ((r.width - GUTTER) / days))));
    const slot = Math.min(HOURS * 2 - 1, Math.max(0, Math.floor(y / ROW)));
    return { day, slot };
  };
  const timeOf = (day: number, slot: number) => new Date(startOfDay(cols[day]).getTime() + (FIRST_HOUR * 2 + slot) * 30 * 60_000);

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-event]')) return;
    const s = slotAt(e);
    if (!s) return;
    dragging.current = { day: s.day, from: s.slot, to: s.slot + 1 };
    setDrag(dragging.current);
  };
  const onMove = (e: React.MouseEvent) => {
    if (!dragging.current) return;
    const s = slotAt(e);
    if (!s) return;
    const d = dragging.current;
    const next = { ...d, to: Math.max(d.from + 1, s.slot + 1) };
    if (next.to !== d.to) { dragging.current = next; setDrag(next); }
  };
  const onUp = () => {
    const d = dragging.current;
    dragging.current = null;
    setDrag(null);
    if (d) onCreate(timeOf(d.day, d.from), timeOf(d.day, d.to));
  };

  const allDay = (day: Date) => events.filter((ev) => ev.allDay && ev.start < addDays(day, 1) && ev.end >= day);
  const timed = (day: Date) => events.filter((ev) => !ev.allDay && sameDay(ev.start, day));

  /** Overlapping events share the column, side by side. */
  const layout = (list: CalEvent[]) => {
    const sorted = [...list].sort((a, b) => a.start.getTime() - b.start.getTime());
    const lanes: CalEvent[][] = [];
    const placed: { ev: CalEvent; lane: number; lanes: number }[] = [];
    for (const ev of sorted) {
      let lane = lanes.findIndex((l) => l.every((o) => o.end <= ev.start || o.start >= ev.end));
      if (lane < 0) { lane = lanes.length; lanes.push([]); }
      lanes[lane].push(ev);
      placed.push({ ev, lane, lanes: 0 });
    }
    for (const p of placed) {
      const overl = placed.filter((o) => o.ev.start < p.ev.end && o.ev.end > p.ev.start);
      p.lanes = Math.max(...overl.map((o) => o.lane)) + 1;
    }
    return placed;
  };

  const now = new Date();
  const nowTop = ((now.getHours() - FIRST_HOUR) * 2 + now.getMinutes() / 30) * ROW;

  return (
    <div className="cal-grid" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, background: '#fff', borderTop: `1px solid ${LINE}`, overflow: 'hidden' }}>
      {/* Day headers — Google: weekday + large circular date */}
      <div style={{ display: 'grid', gridTemplateColumns: `${GUTTER}px repeat(${days}, 1fr)`, borderBottom: `1px solid ${SOFT}`, overflow: 'hidden', scrollbarGutter: 'stable' }}>
        <div />
        {cols.map((d) => {
          const today = isToday(d);
          return (
            <div key={d.toISOString()} style={{ padding: '8px 4px 6px', textAlign: 'center', borderLeft: `1px solid ${SOFT}` }}>
              <div style={{ font: `500 11px/1 var(--font-sans)`, color: today ? MINT : '#70757a', marginBottom: 4 }}>
                {d.toLocaleDateString('en-US', { weekday: 'short' })}
              </div>
              <div
                className={`cal-today-num${today ? ' is-today' : ''}`}
                style={{
                  width: days === 1 ? 40 : 46, height: days === 1 ? 40 : 46, borderRadius: '50%',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  font: `${today ? 500 : 400} ${days === 1 ? 22 : 26}px/1 var(--font-sans)`,
                  letterSpacing: '-0.02em',
                  background: today ? MINT : 'transparent',
                  color: today ? '#fff' : '#3c4043',
                }}
              >
                {d.getDate()}
              </div>
              {allDay(d).map((ev) => {
                const c = colorOf(ev);
                const sel = selectedId === ev.id;
                return (
                  <button
                    key={ev.id}
                    type="button"
                    data-event
                    className="cal-event"
                    onClick={() => onOpen(ev)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', border: 0, cursor: 'pointer',
                      marginTop: 4, padding: '2px 8px', borderRadius: 4,
                      background: sel ? INK : c, color: '#fff',
                      font: '500 11px/1.3 var(--font-sans)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {ev.title}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <div ref={gridRef} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', userSelect: drag ? 'none' : undefined, cursor: 'cell' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `${GUTTER}px repeat(${days}, 1fr)`, height: `${HOURS * 2 * ROW}px`, position: 'relative' }}>
          <div style={{ position: 'relative' }}>
            {Array.from({ length: HOURS }, (_, h) => (
              <div key={h} style={{ position: 'absolute', top: `${h * 2 * ROW - 7}px`, right: 8, font: '400 10px/1 var(--font-sans)', color: '#70757a' }}>
                {h === 0 ? '' : fmtTime(new Date(2000, 0, 1, FIRST_HOUR + h))}
              </div>
            ))}
          </div>
          {cols.map((d, di) => {
            const placed = layout(timed(d));
            return (
              <div key={d.toISOString()} style={{ position: 'relative', borderLeft: `1px solid ${SOFT}`, background: isToday(d) ? 'rgba(10,133,96,.03)' : undefined }}>
                {Array.from({ length: HOURS * 2 }, (_, s) => (
                  <div key={s} style={{ position: 'absolute', left: 0, right: 0, top: `${s * ROW}px`, height: `${ROW}px`, borderTop: `1px ${s % 2 ? 'dotted' : 'solid'} ${s % 2 ? '#f1f3f4' : SOFT}` }} />
                ))}
                {isToday(d) && nowTop > 0 && nowTop < HOURS * 2 * ROW ? (
                  <div style={{ position: 'absolute', left: 0, right: 0, top: `${nowTop}px`, height: 0, borderTop: `2px solid ${MINT}`, zIndex: 2, pointerEvents: 'none' }}>
                    <span style={{ position: 'absolute', left: -5, top: -5, width: 10, height: 10, borderRadius: '50%', background: MINT }} />
                  </div>
                ) : null}
                {drag && drag.day === di ? (
                  <div style={{
                    position: 'absolute', left: 4, right: 4, top: `${drag.from * ROW}px`, height: `${(drag.to - drag.from) * ROW - 2}px`,
                    background: 'rgba(10,133,96,.15)', border: `1px solid ${MINT}`, borderRadius: 4, zIndex: 3, pointerEvents: 'none',
                    font: '600 11px/1.2 var(--font-sans)', color: MINT, padding: '3px 6px',
                  }}>
                    {fmtTime(timeOf(di, drag.from))} – {fmtTime(timeOf(di, drag.to))}
                  </div>
                ) : null}
                {placed.map(({ ev, lane, lanes }) => {
                  const top = ((ev.start.getHours() - FIRST_HOUR) * 60 + ev.start.getMinutes()) / 30 * ROW;
                  const h = Math.max(ROW - 2, (ev.end.getTime() - ev.start.getTime()) / (30 * 60_000) * ROW - 2);
                  if (top + h < 0 || top > HOURS * 2 * ROW) return null;
                  const w = 100 / lanes;
                  const c = colorOf(ev);
                  const sel = selectedId === ev.id;
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      data-event
                      className="cal-event"
                      onClick={() => onOpen(ev)}
                      title={`${fmtTime(ev.start)} · ${ev.title}`}
                      style={{
                        position: 'absolute', top: `${Math.max(0, top)}px`, height: `${h}px`,
                        left: `calc(${lane * w}% + 2px)`, width: `calc(${w}% - 4px)`,
                        textAlign: 'left', border: 0, borderRadius: 4, cursor: 'pointer', padding: '2px 6px', overflow: 'hidden',
                        background: sel ? INK : c, color: '#fff', zIndex: sel ? 4 : 1,
                        font: '500 12px/1.25 var(--font-sans)',
                        textDecoration: ev.done ? 'line-through' : 'none', opacity: ev.done ? 0.55 : 1,
                        boxShadow: '0 1px 1px rgba(0,0,0,.08)',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{ev.title}</span>
                        {ev.source === 'appointment' ? <SyncDot state={ev.syncState} /> : null}
                      </span>
                      {h >= ROW * 1.5 ? (
                        <span style={{ display: 'block', fontSize: 11, opacity: 0.9, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                          {fmtTime(ev.start)}{ev.sellerName ? ` · ${ev.sellerName}` : ''}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const weekRange = (start: Date, days: number) => ({ from: startOfDay(start), to: new Date(startOfDay(start).getTime() + days * DAY) });
