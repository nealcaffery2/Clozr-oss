'use client';

// Lead funnel: Leads → Contacted → Appointment → Offer → Contract → Closed as
// honest-width bands (width = share of leads), cold at the top and hot at the
// close (lib/heat.ts). The step with the biggest drop from the prior step is
// tagged; in dark mode that band is the one green highlight.

import React from 'react';
import type { Diagram as Spec } from '@/lib/reporting';
import { Diagram, num, pct, tipProps } from './Diagram';

type Funnel = Extract<Spec, { type: 'funnel' }>;

const HEAT = [
  { word: 'Cold', color: 'var(--dia-heat-cold)' }, { word: 'Cool', color: 'var(--dia-heat-cool)' }, { word: 'Mild', color: 'var(--dia-heat-mild)' },
  { word: 'Warm', color: 'var(--dia-heat-warm)' }, { word: 'Hot', color: 'var(--dia-heat-hot)' }, { word: 'Hot', color: 'var(--dia-heat-hot-2)' },
];
const ROW = 52, PAD = 16, TOP = 12;

export function FunnelDiagram({ d, title, caption, empty }: { d: Funnel; title: string; caption: string; empty: string }) {
  const steps = d.steps;
  const total = steps[0]?.n ?? 0;
  // The biggest drop: the lowest conversion from the prior step.
  let worst = -1, worstRate = 2;
  steps.forEach((s, i) => { if (i && steps[i - 1].n) { const r = s.n / steps[i - 1].n; if (r < worstRate) { worstRate = r; worst = i; } } });
  const height = TOP + steps.length * ROW + 8;
  return (
    <Diagram title={title} caption={caption} empty={total ? null : empty} minWidth={440} height={height}
      legend={steps.map((s, i) => ({ color: HEAT[i].color, label: `${s.k} (${HEAT[i].word})` }))}>
      {(w, tip) => {
        const fw = Math.round(w * 0.5) - PAD;
        const cx = PAD + fw / 2;
        const lx = PAD + fw + 20;
        const wOf = (n: number) => Math.max(10, (fw * n) / total);
        return (
          <g>
            {steps.map((s, i) => {
              const top = wOf(s.n), bot = i + 1 < steps.length ? wOf(steps[i + 1].n) : top * 0.72;
              const y = TOP + i * ROW;
              const h = ROW - 4;
              const pts = `${cx - top / 2},${y} ${cx + top / 2},${y} ${cx + bot / 2},${y + h} ${cx - bot / 2},${y + h}`;
              const text = `${s.k}\n${num(s.n)} of ${num(total)} leads · ${pct(s.n, total)}${s.rate ? `\n${s.rate}` : ''}`;
              return (
                <g key={s.k}>
                  <g {...tipProps(tip, text)}>
                    <polygon points={pts} fill={HEAT[i].color} className={i === worst ? 'dia-funnel-worst' : undefined} stroke="var(--dia-paper)" strokeWidth="1" />
                    {top >= 56 ? <text x={cx} y={y + h / 2 + 4} textAnchor="middle" fontSize="12" fontWeight="600" fill="#fff" className="dia-on-fill">{num(s.n)}</text> : null}
                  </g>
                  <text x={lx} y={y + 20} fontSize="12.5" fontWeight="600" fill="var(--dia-ink)">{s.k}</text>
                  <text x={lx} y={y + 36} fontSize="11.5" fill="var(--dia-muted)" className="dia-mono">
                    {num(s.n)} · {pct(s.n, total)} of leads{s.rate ? ` · ${s.rate.replace(' of prior step', ' of prior')}` : ''}
                  </text>
                  {i === worst ? <text x={w - PAD} y={y + 20} textAnchor="end" fontSize="11" fontWeight="600" fill="var(--dia-hi)" className="dia-mono">biggest drop</text> : null}
                </g>
              );
            })}
          </g>
        );
      }}
    </Diagram>
  );
}
