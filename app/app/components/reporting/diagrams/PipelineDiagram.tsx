'use client';

// Dispo pipeline: the four active deal stages flowing left to right into
// Closed, each box with its deal count and median days in stage. Stages warm
// up toward the close (lib/heat.ts); Closed is CLOZR green, the one highlight.

import React from 'react';
import type { Diagram as Spec } from '@/lib/reporting';
import { Diagram, num, tipProps, tw, usd } from './Diagram';

type Pipeline = Extract<Spec, { type: 'pipeline' }>;

const COLORS = [
  { word: 'Cool', color: 'var(--dia-heat-cool)' }, { word: 'Mild', color: 'var(--dia-heat-mild)' },
  { word: 'Warm', color: 'var(--dia-heat-warm)' }, { word: 'Hot', color: 'var(--dia-heat-hot)' }, { word: 'Closed', color: 'var(--dia-hi)' },
];
const GAP = 16, PAD = 16, BOX_H = 108, TOP = 16;

export function PipelineDiagram({ d, title, caption, empty }: { d: Pipeline; title: string; caption: string; empty: string }) {
  const mid = React.useId().replace(/:/g, '');
  const none = d.stages.every((s) => !s.n);
  return (
    <Diagram title={title} caption={caption} empty={none ? empty : null} minWidth={d.stages.length * 92 + (d.stages.length - 1) * GAP + PAD * 2} height={TOP + BOX_H + 16}
      legend={d.stages.map((s, i) => ({ color: COLORS[i].color, label: `${s.k} (${COLORS[i].word})` }))}>
      {(w, tip) => {
        const bw = (w - PAD * 2 - GAP * (d.stages.length - 1)) / d.stages.length;
        return (
          <g>
            <defs><marker id={mid} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="var(--dia-soft)" /></marker></defs>
            {d.stages.map((s, i) => {
              if (!i) return null;
              const x0 = PAD + (i - 1) * (bw + GAP) + bw, x1 = x0 + GAP;
              return <line key={s.k} x1={x0 + 2} y1={TOP + BOX_H / 2} x2={x1 - 2} y2={TOP + BOX_H / 2} stroke="var(--dia-soft)" strokeWidth="1.5" markerEnd={`url(#${mid})`} />;
            })}
            {d.stages.map((s, i) => {
              const x = PAD + i * (bw + GAP);
              const c = COLORS[i].color;
              const last = i === d.stages.length - 1;
              // Wrap the stage name to the box, word by word.
              const lines = s.k.split(' ').reduce<string[]>((ls, word) => { const last = ls[ls.length - 1]; if (last !== undefined && tw(last + ' ' + word, 12) <= bw - 24) ls[ls.length - 1] = last + ' ' + word; else ls.push(word); return ls; }, []);
              const text = `${s.k}\n${num(s.n)} deal${s.n === 1 ? '' : 's'}${s.days === null ? '' : ` · median ${s.days}d in stage`}${s.fees ? `\n${usd(s.fees)} in fees` : ''}`;
              return (
                <g key={s.k} {...tipProps(tip, text)}>
                  <rect x={x} y={TOP} width={bw} height={BOX_H} rx="8" fill="var(--dia-node-fill)" stroke={c} strokeWidth="1.5" className={last ? 'dia-hi-dark-stroke' : undefined} />
                  <rect x={x + 1} y={TOP + 1} width={bw - 2} height="6" rx="3" fill={c} className={last ? 'dia-hi-dark' : undefined} />
                  {lines.map((l, j) => <text key={j} x={x + 12} y={TOP + 24 + j * 14} fontSize="12" fontWeight="600" fill="var(--dia-ink)">{l}</text>)}
                  <text x={x + 12} y={TOP + 80} fontSize="22" fontWeight="700" fill={c} className={last ? 'dia-hi-dark' : undefined} letterSpacing="-0.02em">{num(s.n)}</text>
                  <text x={x + 12} y={TOP + 98} fontSize="11" fill="var(--dia-muted)" className="dia-mono">
                    {last ? (s.fees ? usd(s.fees) + ' fees' : 'in range') : s.days === null ? 'no date yet' : `${s.days}d median`}
                  </text>
                </g>
              );
            })}
          </g>
        );
      }}
    </Diagram>
  );
}
