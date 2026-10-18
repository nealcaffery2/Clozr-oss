'use client';

// Org chart: owners on top, a bus down to one column per role (admins,
// acquisitions, dispositions, transaction coordination, other), each person
// with their in-range calls, offers and contracts. Colour per role in light;
// in dark every box is a white stroke and the leading rep is the one green.

import React from 'react';
import type { Diagram as Spec } from '@/lib/reporting';
import { Diagram, clip, num, tipProps } from './Diagram';

type Org = Extract<Spec, { type: 'org' }>;
type Person = Org['people'][number];

const ROLES: { key: string; label: string; match: (r: string) => boolean; color: string }[] = [
  { key: 'admin', label: 'Admins', match: (r) => r === 'admin', color: 'var(--dia-cat-1)' },
  { key: 'acq', label: 'Acquisitions', match: (r) => ['acquisitions', 'sdr', 'partnerships', 'member'].includes(r), color: 'var(--dia-cat-2)' },
  { key: 'dispo', label: 'Dispositions', match: (r) => r === 'dispositions', color: 'var(--dia-cat-3)' },
  { key: 'tc', label: 'Transaction coordination', match: (r) => r === 'tc' || r === 'notary', color: 'var(--dia-cat-5)' },
  { key: 'other', label: 'Other', match: () => true, color: 'var(--dia-cat-other)' },
];
const OWNER = 'var(--dia-cat-4)';
const ROLE_WORD: Record<string, string> = { owner: 'Owner', admin: 'Admin', acquisitions: 'Acquisitions', dispositions: 'Dispositions', tc: 'Transaction coordinator', member: 'Member', notary: 'Notary', partnerships: 'Partnerships', sdr: 'SDR' };
const BOX_W = 184, BOX_H = 76, COL_GAP = 20, ROW_GAP = 12, PAD = 16, MAX_PER_COL = 6;

export function OrgChartDiagram({ d, title, caption, empty }: { d: Org; title: string; caption: string; empty: string }) {
  const owners = d.people.filter((p) => p.role === 'owner');
  const rest = d.people.filter((p) => p.role !== 'owner');
  const cols = ROLES.map((r) => ({ ...r, people: [] as Person[] }));
  for (const p of rest) cols.find((c) => c.match(p.role))!.people.push(p);
  const used = cols.filter((c) => c.people.length);
  const rank = (p: Person) => p.contracts * 1e6 + p.offers * 1e3 + p.calls;
  const lead = d.people.length ? d.people.reduce((a, p) => (rank(p) > rank(a) ? p : a)) : null;
  const tallest = Math.max(0, ...used.map((c) => Math.min(c.people.length, MAX_PER_COL) + (c.people.length > MAX_PER_COL ? 1 : 0)));
  const rootH = owners.length ? BOX_H + 40 : 0;
  const height = PAD + rootH + (used.length ? 28 + tallest * (BOX_H + ROW_GAP) : 0) + PAD;
  const minWidth = Math.max(owners.length * (BOX_W + COL_GAP), used.length * (BOX_W + 24 + COL_GAP)) - COL_GAP + PAD * 2;
  // The column header already names the role, so a box repeats it only when the person's role is a different word (SDR under Acquisitions, Notary under TC).
  const Box = ({ p, x, y, color, tip, col }: { p: Person; x: number; y: number; color: string; tip: Parameters<typeof tipProps>[0]; col?: string }) => {
    const top = lead && p.id === lead.id && (p.calls || p.offers || p.contracts);
    const role = ROLE_WORD[p.role] ?? p.role;
    const showRole = !col || !['Admins', 'Acquisitions', 'Dispositions', 'Transaction coordination'].includes(col) || !['admin', 'acquisitions', 'dispositions', 'tc'].includes(p.role);
    return (
      <g {...tipProps(tip, `${p.name}\n${ROLE_WORD[p.role] ?? p.role}\n${num(p.calls)} calls · ${num(p.offers)} offers · ${num(p.contracts)} contracts · ${num(p.closings)} closings`)}>
        <rect x={x} y={y} width={BOX_W} height={BOX_H} rx="8" fill="var(--dia-node-fill)" stroke={color} strokeWidth="1.5" className={top ? 'dia-hi-dark-stroke' : undefined} />
        <text x={x + 12} y={y + 20} fontSize="12.5" fontWeight="600" fill="var(--dia-ink)">{clip(p.name, 18)}</text>
        {top ? <text x={x + BOX_W - 10} y={y + 20} textAnchor="end" fontSize="11" fontWeight="600" fill="var(--dia-hi)" className="dia-mono">top</text> : null}
        {showRole ? <text x={x + 12} y={y + 35} fontSize="11" fill={color} fontWeight="600" className="dia-mono">{role}</text> : null}
        <text x={x + 12} y={y + (showRole ? 50 : 40)} fontSize="11" fill="var(--dia-muted)" className="dia-mono">{num(p.calls)} calls · {num(p.offers)} offers</text>
        <text x={x + 12} y={y + (showRole ? 65 : 56)} fontSize="11" fill="var(--dia-muted)" className="dia-mono">{num(p.contracts)} contracts · {num(p.closings)} closings</text>
      </g>
    );
  };
  return (
    <Diagram title={title} caption={caption} empty={d.people.length ? null : empty} minWidth={minWidth} height={height}
      legend={[{ color: OWNER, label: 'Owner' }, ...used.map((c) => ({ color: c.color, label: c.label })), { color: 'var(--dia-hi)', label: 'Top rep (contracts, then offers, then calls)' }]}>
      {(w, tip) => {
        const cw = BOX_W + 24;
        const colsW = used.length * cw + (used.length - 1) * COL_GAP;
        const cx0 = Math.max(PAD, (w - colsW) / 2);
        const ownersW = owners.length * BOX_W + (owners.length - 1) * COL_GAP;
        const ox0 = Math.max(PAD, (w - ownersW) / 2);
        const busY = PAD + BOX_H + 20;
        const colTop = PAD + rootH;
        return (
          <g>
            {owners.length && used.length ? (
              <g stroke="var(--dia-soft)" strokeWidth="1" fill="none">
                {owners.map((o, i) => <line key={o.id} x1={ox0 + i * (BOX_W + COL_GAP) + BOX_W / 2} y1={PAD + BOX_H} x2={ox0 + i * (BOX_W + COL_GAP) + BOX_W / 2} y2={busY} />)}
                <line x1={Math.min(ox0 + BOX_W / 2, cx0 + cw / 2)} y1={busY} x2={Math.max(ox0 + ownersW - BOX_W / 2, cx0 + colsW - cw / 2)} y2={busY} />
                {used.map((_, i) => <line key={i} x1={cx0 + i * (cw + COL_GAP) + cw / 2} y1={busY} x2={cx0 + i * (cw + COL_GAP) + cw / 2} y2={colTop} />)}
              </g>
            ) : null}
            {owners.map((o, i) => <Box key={o.id} p={o} x={ox0 + i * (BOX_W + COL_GAP)} y={PAD} color={OWNER} tip={tip} />)}
            {used.map((c, i) => {
              const x = cx0 + i * (cw + COL_GAP);
              const shown = c.people.slice(0, MAX_PER_COL);
              const more = c.people.length - shown.length;
              const spineX = x + 10;
              const lastY = colTop + 28 + (shown.length - 1 + (more ? 1 : 0)) * (BOX_H + ROW_GAP) + BOX_H / 2;
              return (
                <g key={c.key}>
                  <text x={x + cw / 2} y={colTop + 16} textAnchor="middle" fontSize="11.5" fontWeight="600" fill={c.color} className="dia-mono">{c.label}</text>
                  <line x1={spineX} y1={colTop + 24} x2={spineX} y2={lastY} stroke="var(--dia-soft)" strokeWidth="1" />
                  {shown.map((p, j) => {
                    const y = colTop + 28 + j * (BOX_H + ROW_GAP);
                    return (
                      <g key={p.id}>
                        <line x1={spineX} y1={y + BOX_H / 2} x2={x + 24} y2={y + BOX_H / 2} stroke="var(--dia-soft)" strokeWidth="1" />
                        <Box p={p} x={x + 24} y={y} color={c.color} tip={tip} col={c.label} />
                      </g>
                    );
                  })}
                  {more ? (() => { const y = colTop + 28 + shown.length * (BOX_H + ROW_GAP); return (
                    <g>
                      <line x1={spineX} y1={y + BOX_H / 2} x2={x + 24} y2={y + BOX_H / 2} stroke="var(--dia-soft)" strokeWidth="1" />
                      <rect x={x + 24} y={y} width={BOX_W} height={BOX_H} rx="8" fill="none" stroke="var(--dia-soft)" strokeDasharray="4,3" />
                      <text x={x + 24 + BOX_W / 2} y={y + BOX_H / 2 + 4} textAnchor="middle" fontSize="11.5" fill="var(--dia-muted)" className="dia-mono">+{more} more in the leaderboard</text>
                    </g>
                  ); })() : null}
                </g>
              );
            })}
          </g>
        );
      }}
    </Diagram>
  );
}
