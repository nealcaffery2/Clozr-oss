'use client';

// Lead flow: a three-column Sankey. Sources on the left, the rep each lead was
// assigned to in the middle, the stage group it sits in now on the right.
// Ribbon width is the lead count; colour follows the source through both hops
// so a source can be traced to its outcome. Dark mode: grey ribbons, mono labels.

import React from 'react';
import type { Diagram as Spec } from '@/lib/reporting';
import { cat, Diagram, clip, num, pct, tipProps } from './Diagram';

type LeadFlow = Extract<Spec, { type: 'leadflow' }>;

const BAR = 12, REP_W = 128, GAP = 18, TOP = 36, BOTTOM = 16, LABEL_W = 150;

export function LeadFlowDiagram({ d, title, caption, empty }: { d: LeadFlow; title: string; caption: string; empty: string }) {
  const total = d.flows.reduce((a, f) => a + f.n, 0);
  // Node totals per column; reps ordered by volume, sources and stages keep the order the lib set.
  const sum = (col: 'source' | 'rep' | 'stage', n: number) => Array.from({ length: n }, (_, i) => d.flows.filter((f) => f[col] === i).reduce((a, f) => a + f.n, 0));
  const srcN = sum('source', d.sources.length), repN = sum('rep', d.reps.length), stgN = sum('stage', d.stages.length);
  const repOrder = d.reps.map((_, i) => i).sort((a, b) => repN[b] - repN[a]);
  const tallest = Math.max(d.sources.length, d.reps.length, d.stages.length);
  // One px-per-lead scale for every column, chosen so the tallest column fits about 320px
  // however many leads there are; a node is never thinner than 4px even if its ribbons are.
  const k = Math.min(24, (320 - (tallest - 1) * GAP) / Math.max(1, total));
  const colH = (ns: number[]) => ns.reduce((a, n) => a + Math.max(4, n * k), 0) + (ns.length - 1) * GAP;
  const height = TOP + Math.max(colH(srcN), colH(repN), colH(stgN)) + BOTTOM;
  const legend = d.sources.map((s, i) => ({ color: cat(i, s), label: s }));
  return (
    <Diagram title={title} caption={caption} empty={total ? null : empty} minWidth={680} height={height} legend={legend}>
      {(w, tip) => {
        const xs = [LABEL_W, Math.round(w / 2 - REP_W / 2), w - LABEL_W - BAR];
        const place = (ns: number[], order: number[]) => {
          const h = colH(ns), y0 = TOP + (height - TOP - BOTTOM - h) / 2;
          const pos = new Array<{ y: number; h: number }>(ns.length);
          let y = y0;
          for (const i of order) { const hh = Math.max(4, ns[i] * k); pos[i] = { y, h: hh }; y += hh + GAP; }
          return pos;
        };
        const sp = place(srcN, d.sources.map((_, i) => i)), rp = place(repN, repOrder), tp = place(stgN, d.stages.map((_, i) => i));
        // Ribbon offsets: each node hands out its height in a fixed order so ribbons never stack.
        const srcOut = srcN.map(() => 0), repIn = repN.map(() => 0), repOut = repN.map(() => 0), stgIn = stgN.map(() => 0);
        const flows = [...d.flows].sort((a, b) => a.source - b.source || repOrder.indexOf(a.rep) - repOrder.indexOf(b.rep) || a.stage - b.stage);
        const left = flows.map((f) => {
          const h = f.n * k;
          const y0 = sp[f.source].y + srcOut[f.source], y1 = rp[f.rep].y + repIn[f.rep];
          srcOut[f.source] += h; repIn[f.rep] += h;
          return { f, y0, y1, h };
        });
        const byRepStage = [...flows].sort((a, b) => repOrder.indexOf(a.rep) - repOrder.indexOf(b.rep) || a.stage - b.stage || a.source - b.source);
        const right = byRepStage.map((f) => {
          const h = f.n * k;
          const y0 = rp[f.rep].y + repOut[f.rep], y1 = tp[f.stage].y + stgIn[f.stage];
          repOut[f.rep] += h; stgIn[f.stage] += h;
          return { f, y0, y1, h };
        });
        const ribbon = (x0: number, x1: number, y0: number, y1: number, h: number) => {
          const m = (x0 + x1) / 2;
          return `M${x0},${y0} C${m},${y0} ${m},${y1} ${x1},${y1} L${x1},${y1 + h} C${m},${y1 + h} ${m},${y0 + h} ${x0},${y0 + h} Z`;
        };
        const head = (x: number, t: string, anchor: 'start' | 'middle' | 'end') => <text x={x} y={16} textAnchor={anchor} fontSize="11.5" fontWeight="600" fill="var(--dia-muted)" className="dia-mono">{t}</text>;
        return (
          <g>
            {head(xs[0] + BAR, 'Source', 'end')}{head(xs[1] + REP_W / 2, 'Assigned rep', 'middle')}{head(xs[2], 'Stage now', 'start')}
            {left.map(({ f, y0, y1, h }, i) => (
              <path key={'l' + i} d={ribbon(xs[0] + BAR, xs[1], y0, y1, h)} fill={cat(f.source, d.sources[f.source])}
                {...tipProps(tip, `${d.sources[f.source]} → ${d.reps[f.rep]}\n${num(f.n)} lead${f.n === 1 ? '' : 's'}`)} className="dia-node dia-ribbon" />
            ))}
            {right.map(({ f, y0, y1, h }, i) => (
              <path key={'r' + i} d={ribbon(xs[1] + REP_W, xs[2], y0, y1, h)} fill={cat(f.source, d.sources[f.source])}
                {...tipProps(tip, `${d.reps[f.rep]} → ${d.stages[f.stage]}\n${num(f.n)} lead${f.n === 1 ? '' : 's'} from ${d.sources[f.source]}`)} className="dia-node dia-ribbon" />
            ))}
            {d.sources.map((s, i) => (
              <g key={'s' + i} {...tipProps(tip, `${s}\n${num(srcN[i])} lead${srcN[i] === 1 ? '' : 's'} · ${pct(srcN[i], total)} of leads`)}>
                <rect x={xs[0]} y={sp[i].y} width={BAR} height={sp[i].h} fill={cat(i, s)} />
                <text x={xs[0] - 8} y={sp[i].y + sp[i].h / 2 + 4} textAnchor="end" fontSize="12" fontWeight="500" fill="var(--dia-ink)">{clip(s, 16)} <tspan fill="var(--dia-muted)" className="dia-mono">{num(srcN[i])}</tspan></text>
              </g>
            ))}
            {d.reps.map((r, i) => (
              <g key={'r' + i} {...tipProps(tip, `${r}\n${num(repN[i])} lead${repN[i] === 1 ? '' : 's'} · ${pct(repN[i], total)} of leads`)}>
                <rect x={xs[1]} y={rp[i].y} width={REP_W} height={rp[i].h} fill="var(--dia-ink)" />
                {rp[i].h >= 18
                  ? <text x={xs[1] + REP_W / 2} y={rp[i].y + rp[i].h / 2 + 4} textAnchor="middle" fontSize="11.5" fontWeight="600" fill="var(--dia-paper)">{clip(r, 16)} <tspan fontWeight="400" className="dia-mono">{num(repN[i])}</tspan></text>
                  : <text x={xs[1] + REP_W / 2} y={rp[i].y - 5} textAnchor="middle" fontSize="11.5" fontWeight="500" fill="var(--dia-ink)">{clip(r, 16)} <tspan fill="var(--dia-muted)" className="dia-mono">{num(repN[i])}</tspan></text>}
              </g>
            ))}
            {d.stages.map((s, i) => (
              <g key={'t' + i} {...tipProps(tip, `${s}\n${num(stgN[i])} lead${stgN[i] === 1 ? '' : 's'} · ${pct(stgN[i], total)} of leads`)}>
                <rect x={xs[2]} y={tp[i].y} width={BAR} height={tp[i].h} fill="var(--dia-ink)" />
                <text x={xs[2] + BAR + 8} y={tp[i].y + tp[i].h / 2 + 4} fontSize="12" fontWeight="500" fill="var(--dia-ink)">{s} <tspan fill="var(--dia-muted)" className="dia-mono">{num(stgN[i])}</tspan></text>
              </g>
            ))}
          </g>
        );
      }}
    </Diagram>
  );
}
