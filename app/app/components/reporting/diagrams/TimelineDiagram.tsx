'use client';

// Closings timeline: one marker per closed deal on its close date, sized by
// assignment fee, labels alternating above and below the line. Honest time
// scale across the range. The largest fee is the one highlight in dark mode.

import React from 'react';
import type { Diagram as Spec } from '@/lib/reporting';
import { Diagram, clip, num, tipProps, usd } from './Diagram';

type Timeline = Extract<Spec, { type: 'timeline' }>;

const DAY = 86_400_000, PAD = 24, MIN_W = 560, ROW = 30;
const shortDay = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function TimelineDiagram({ d, title, caption, empty }: { d: Timeline; title: string; caption: string; empty: string }) {
  const max = Math.max(1, ...d.events.map((e) => e.fee));
  const top = d.events.reduce((a, e, i) => (e.fee > d.events[a].fee ? i : a), 0);
  const span = Math.max(DAY, d.end - d.start);
  const xAt = (w: number) => (t: number) => PAD + ((Math.min(d.end, Math.max(d.start, t)) - d.start) / span) * (w - PAD * 2);
  // Labels alternate above and below the line; a label within 96px of the last one on its side moves out a row, as many rows as it takes.
  const place = (w: number) => {
    const x = xAt(w);
    const lastX: Record<string, number> = {};
    return d.events.map((e, i) => {
      const cx = x(e.t);
      const side = i % 2 ? 1 : -1;
      let row = 0;
      while (cx - (lastX[`${side}${row}`] ?? -1e9) < 96) row++;
      lastX[`${side}${row}`] = cx;
      return { e, cx, side, row, r: 4 + 7 * Math.sqrt(e.fee / max) };
    });
  };
  // The narrowest layout needs the most rows, so it sets the height; wider cards only spread labels out.
  const rows = (side: number) => Math.max(0, ...place(MIN_W).filter((p) => p.side === side).map((p) => p.row + 1));
  const BASE = 36 + Math.max(2, rows(-1)) * ROW;
  const H = BASE + 24 + Math.max(2, rows(1)) * ROW + 16;
  return (
    <Diagram title={title} caption={caption} empty={d.events.length ? null : empty} minWidth={MIN_W} height={H}
      legend={[{ color: 'var(--dia-marker)', label: 'Closing (size = fee)' }, { color: 'var(--dia-hi)', label: 'Largest fee' }]}>
      {(w, tip) => {
        const x0 = PAD, x1 = w - PAD;
        const x = xAt(w);
        // Ticks: about one per 110px, snapped to whole days.
        const nTicks = Math.max(2, Math.min(10, Math.floor((x1 - x0) / 110)));
        const stepDays = Math.max(1, Math.round(span / DAY / nTicks));
        const ticks: number[] = [];
        for (let t = d.start; t <= d.end; t += stepDays * DAY) ticks.push(t);
        const placed = place(w);
        return (
          <g>
            <text x={x1} y={18} textAnchor="end" fontSize="11.5" fill="var(--dia-muted)" className="dia-mono">{num(d.events.length)} closed · {usd(d.total)}</text>
            <line x1={x0} y1={BASE} x2={x1} y2={BASE} stroke="var(--dia-rule)" strokeWidth="1" />
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} y1={BASE - 4} x2={x(t)} y2={BASE + 4} stroke="var(--dia-soft)" strokeWidth="1" />
                <text x={x(t)} y={BASE + 20} textAnchor="middle" fontSize="11" fill="var(--dia-muted)" className="dia-mono">{shortDay(t)}</text>
              </g>
            ))}
            {placed.map(({ e, cx, side, row, r }, i) => {
              const ly = side < 0 ? BASE - 30 - row * ROW : BASE + 42 + row * ROW;
              const anchor = cx < x0 + 70 ? 'start' : cx > x1 - 70 ? 'end' : 'middle';
              return (
                <g key={i} {...tipProps(tip, `${e.label}\nclosed ${shortDay(e.t)} · ${usd(e.fee)} fee`)}>
                  <line x1={cx} y1={side < 0 ? BASE - r : BASE + r} x2={cx} y2={side < 0 ? ly + 6 : ly - 16} stroke="var(--dia-rule)" strokeWidth="1" />
                  <circle cx={cx} cy={BASE} r={r} fill={i === top ? 'var(--dia-hi)' : 'var(--dia-marker)'} stroke="var(--dia-paper)" strokeWidth="2" />
                  <text x={cx} y={ly} textAnchor={anchor} fontSize="12" fontWeight="500" fill="var(--dia-ink)">{clip(e.label, 22)}</text>
                  <text x={cx} y={ly + 14} textAnchor={anchor} fontSize="11" fill="var(--dia-muted)" className="dia-mono">{usd(e.fee)}</text>
                </g>
              );
            })}
          </g>
        );
      }}
    </Diagram>
  );
}
