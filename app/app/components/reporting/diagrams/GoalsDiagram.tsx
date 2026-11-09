'use client';

// Road to 100: one long bar of customers won with the 70 and 100 marks on it,
// then one row per daily goal, the count so far as a filled bar against the
// pace (goal x work days in range) as the bar's full width. A row at or past
// its pace is CLOZR green, behind is amber; the shortfall is written on the row.

import React from 'react';
import type { Diagram as Spec } from '@/lib/reporting';
import { Diagram, num, pct, tipProps } from './Diagram';

type Goals = Extract<Spec, { type: 'goals' }>;

const PAD = 16, LABEL = 118, ROW = 34, ROAD_H = 22, TOP = 14, GAP = 26;
const AMBER = 'var(--dia-heat-mild)';

export function GoalsDiagram({ d, title, caption, empty }: { d: Goals; title: string; caption: string; empty: string }) {
  const marks = d.marks.length ? d.marks : [100];
  const roadMax = Math.max(marks[marks.length - 1], d.customers);
  // The road is customers by default; `money` makes it dollars (the MRR road).
  const fmt = (n: number) => (d.money ? '$' + num(Math.round(n)) : num(n));
  const label = d.label ?? 'Customers';
  const height = TOP + ROAD_H + 22 + GAP + d.goals.length * ROW + 8;
  return (
    <Diagram title={title} caption={caption} empty={empty || null} minWidth={460} height={height}
      legend={[{ color: 'var(--dia-hi)', label: 'At or ahead of pace' }, { color: AMBER, label: 'Behind pace' }, { color: 'var(--dia-rule)', label: 'Pace (goal x work days)' }]}>
      {(w, tip) => {
        const x0 = PAD + LABEL, bw = w - x0 - PAD;
        const rx = (n: number) => x0 + (bw * n) / roadMax;
        const y0 = TOP + ROAD_H + 22 + GAP;
        return (
          <g>
            <text x={PAD} y={TOP + ROAD_H / 2 + 4} fontSize="12.5" fontWeight="600" fill="var(--dia-ink)">{label}</text>
            <g {...tipProps(tip, `${fmt(d.customers)} ${d.money ? label : 'customers won'}\n${marks.map((m) => `${fmt(m)}: ${pct(d.customers, m)}`).join('\n')}`)}>
              <rect x={x0} y={TOP} width={bw} height={ROAD_H} rx="4" fill="var(--dia-paper-2)" stroke="var(--dia-rule)" />
              <rect x={x0} y={TOP} width={Math.max(d.customers ? 4 : 0, rx(d.customers) - x0)} height={ROAD_H} rx="4" fill="var(--dia-hi)" />
              <text x={Math.min(w - PAD - 30, rx(d.customers) + 6)} y={TOP + ROAD_H / 2 + 4} fontSize="12" fontWeight="700" fill="var(--dia-ink)" className="dia-mono">{fmt(d.customers)}</text>
            </g>
            {marks.map((m) => (
              <g key={m}>
                <line x1={rx(m)} x2={rx(m)} y1={TOP - 4} y2={TOP + ROAD_H + 4} stroke="var(--dia-ink)" strokeWidth="1.5" strokeDasharray={m === marks[marks.length - 1] ? undefined : '3 2'} />
                <text x={rx(m)} y={TOP + ROAD_H + 18} textAnchor={m === marks[marks.length - 1] ? 'end' : 'middle'} fontSize="11" fontWeight="600" fill="var(--dia-muted)" className="dia-mono">{fmt(m)}</text>
              </g>
            ))}
            {d.goals.map((g, i) => {
              const y = y0 + i * ROW;
              const ok = g.got >= g.want;
              // No pace (Paid): a plain count, no bar.
              const fill = g.want ? Math.min(1, g.got / g.want) : 0;
              const words = g.want ? (ok ? `${num(g.got - g.want)} ahead` : `${num(g.want - g.got)} short`) : num(g.got);
              return (
                <g key={g.k} {...tipProps(tip, g.want ? `${g.k}\n${num(g.got)} so far, pace ${num(g.want)} (${num(g.perDay)} a day)\n${pct(g.got, g.want)} of pace` : `${g.k}\n${num(g.got)} so far`)}>
                  <text x={PAD} y={y + 15} fontSize="12.5" fontWeight="600" fill="var(--dia-ink)">{g.k}</text>
                  <rect x={x0} y={y + 3} width={bw} height={16} rx="3" fill="var(--dia-paper-2)" stroke="var(--dia-rule)" />
                  <rect x={x0} y={y + 3} width={Math.max(g.got && g.want ? 3 : 0, bw * fill)} height={16} rx="3" fill={ok ? 'var(--dia-hi)' : AMBER} />
                  <text x={w - PAD} y={y + 15} textAnchor="end" fontSize="11.5" fill="var(--dia-ink)" className="dia-mono">{g.want ? <>{num(g.got)} / {num(g.want)} · {words}</> : words}</text>
                </g>
              );
            })}
          </g>
        );
      }}
    </Diagram>
  );
}
