'use client';

// Data flow: the systems that feed CLOZR's workspace tables on the left, the
// workspace in the middle, and where the data goes on the right. The shape is
// fixed; the sublabels carry this range's counts where the loaded rows have
// them. Colour per system in light; in dark, blueprint boxes with mono tags and
// the workspace as the one green node.

import React from 'react';
import type { Diagram as Spec } from '@/lib/reporting';
import { CAT, Diagram, tipProps } from './Diagram';

type DataFlow = Extract<Spec, { type: 'dataflow' }>;
type Node = { id: string; name: string; tag: string; what: string; color: string };

const INPUTS: Node[] = [
  { id: 'talkr', name: 'Talkr', tag: 'EXT', what: 'Calls and texts on the team lines', color: CAT[0] },
  { id: 'gmail', name: 'Gmail', tag: 'EXT', what: 'Email threads synced per rep', color: CAT[1] },
  { id: 'dealmachine', name: 'DealMachine', tag: 'EXT', what: 'Driving-for-dollars leads imported', color: CAT[2] },
  { id: 'podio', name: 'Podio', tag: 'EXT', what: 'Legacy CRM leads imported', color: CAT[3] },
  { id: 'compr', name: 'Compr', tag: 'EXT', what: 'Underwriting: ARV, MAO and offer bands', color: CAT[4] },
  { id: 'ads', name: 'Google Ads', tag: 'SPEND', what: 'Ad spend per source (not connected yet)', color: CAT[5] },
];
const CORE: Node = { id: 'clozr', name: 'CLOZR workspace', tag: 'ORIG', what: 'Supabase tables: sellers, deals, comms, offers, buyers', color: 'var(--dia-hi)' };
const OUTPUTS: Node[] = [
  { id: 'reports', name: 'Reports', tag: 'APP', what: 'This screen and the TV leaderboard', color: CAT[6] },
  { id: 'sequences', name: 'Sequences', tag: 'EDGE', what: 'Action plans and cold steps sent by edge functions', color: CAT[7] },
  { id: 'buyr', name: 'Buyr', tag: 'EXT', what: 'Deals marketed to buyers', color: CAT[2] },
  { id: 'esign', name: 'E-sign', tag: 'EDGE', what: 'CLOZR e-sign and PandaDoc contracts', color: CAT[0] },
];
const NW = 176, NH = 52, GAP = 12, PAD = 16, TOP = 16, CORE_W = 208, CORE_H = 128, R = 8;

export function DataFlowDiagram({ d, title, caption }: { d: DataFlow; title: string; caption: string }) {
  const mid = React.useId().replace(/:/g, '');
  const stackH = INPUTS.length * NH + (INPUTS.length - 1) * GAP;
  const height = TOP + stackH + 16;
  // Every box carries its own name, so the legend explains the tags instead.
  const legend = [{ color: 'var(--dia-hi)', label: 'ORIG: system of record' }, { color: 'var(--dia-soft)', label: 'EXT: external system' }, { color: 'var(--dia-soft)', label: 'EDGE: edge function' }, { color: 'var(--dia-soft)', label: 'APP: this app' }];
  // Elbow from a box's side edge to the core's side edge: horizontal, a vertical jog at xm, horizontal in.
  const elbow = (x0: number, y0: number, x1: number, y1: number, xm: number) => {
    if (Math.abs(y1 - y0) < 1) return `M${x0},${y0} H${x1}`;
    const s = y1 > y0 ? 1 : -1, dir = x1 > x0 ? 1 : -1;
    return `M${x0},${y0} H${xm - dir * R} Q${xm},${y0} ${xm},${y0 + s * R} V${y1 - s * R} Q${xm},${y1} ${xm + dir * R},${y1} H${x1}`;
  };
  const Box = ({ n, x, y, w, h, tip, big }: { n: Node; x: number; y: number; w: number; h: number; tip: Parameters<typeof tipProps>[0]; big?: boolean }) => (
    <g {...tipProps(tip, `${n.name}\n${n.what}\n${d.counts[n.id] ?? 'no count in range'}`)}>
      <rect x={x} y={y} width={w} height={h} rx="8" fill="var(--dia-node-fill)" stroke={n.color} strokeWidth={big ? 2 : 1.5} />
      <rect x={x + w - 46} y={y + 8} width="38" height="16" rx="2" fill="none" stroke={n.color} strokeWidth="0.8" />
      <text x={x + w - 27} y={y + 19.5} textAnchor="middle" fontSize="11" fill={n.color} fontWeight="600" className="dia-mono">{n.tag}</text>
      <text x={x + 12} y={y + (big ? 30 : 21)} fontSize={big ? 14 : 12.5} fontWeight="600" fill="var(--dia-ink)">{n.name}</text>
      {big ? <text x={x + 12} y={y + 50} fontSize="11.5" fill="var(--dia-ink-2)">Supabase workspace tables</text> : null}
      <text x={x + 12} y={y + (big ? 72 : 38)} fontSize="11" fill="var(--dia-muted)" className="dia-mono">{d.counts[n.id] ?? '—'}</text>
      {big ? <text x={x + 12} y={y + 92} fontSize="11" fill="var(--dia-muted)" className="dia-mono">sellers · deals · comms · offers</text> : null}
      {big ? <text x={x + 12} y={y + 108} fontSize="11" fill="var(--dia-muted)" className="dia-mono">buyers · contracts · tasks</text> : null}
    </g>
  );
  return (
    <Diagram title={title} caption={caption} minWidth={840} height={height} legend={legend}>
      {(w, tip) => {
        const inX = PAD, outX = w - PAD - NW, coreX = Math.round((w - CORE_W) / 2), coreY = TOP + (stackH - CORE_H) / 2;
        const inGap = coreX - (inX + NW), outGap = outX - (coreX + CORE_W);
        const inPort = (i: number) => coreY + (CORE_H * (i + 1)) / (INPUTS.length + 1);
        const outPort = (i: number) => coreY + (CORE_H * (i + 1)) / (OUTPUTS.length + 1);
        const outY = (i: number) => TOP + (stackH - (OUTPUTS.length * NH + (OUTPUTS.length - 1) * GAP)) / 2 + i * (NH + GAP);
        return (
          <g>
            <defs><marker id={mid} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="var(--dia-soft)" /></marker></defs>
            <g fill="none" stroke="var(--dia-soft)" strokeWidth="1" markerEnd={`url(#${mid})`}>
              {INPUTS.map((n, i) => <path key={n.id} d={elbow(inX + NW, TOP + i * (NH + GAP) + NH / 2, coreX - 2, inPort(i), inX + NW + (inGap * (i + 1)) / (INPUTS.length + 1))} strokeDasharray={n.id === 'ads' ? '4,3' : undefined} />)}
              {OUTPUTS.map((n, i) => <path key={n.id} d={elbow(coreX + CORE_W, outPort(i), outX - 2, outY(i) + NH / 2, coreX + CORE_W + (outGap * (i + 1)) / (OUTPUTS.length + 1))} />)}
            </g>
            {INPUTS.map((n, i) => <Box key={n.id} n={n} x={inX} y={TOP + i * (NH + GAP)} w={NW} h={NH} tip={tip} />)}
            <Box n={CORE} x={coreX} y={coreY} w={CORE_W} h={CORE_H} tip={tip} big />
            {OUTPUTS.map((n, i) => <Box key={n.id} n={n} x={outX} y={outY(i)} w={NW} h={NH} tip={tip} />)}
          </g>
        );
      }}
    </Diagram>
  );
}
