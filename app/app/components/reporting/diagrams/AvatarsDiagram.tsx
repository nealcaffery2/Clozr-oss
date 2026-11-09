'use client';

// Funnel by avatar: one row per avatar and tier, four bands left to right
// (reached, demos, sign-ups, customers) whose widths are honest shares of
// that row's contacts reached, so a row's shape is its conversion. Rows are
// the report's order (most customers, then most reached). Customers are the
// one green band.

import React from 'react';
import type { Diagram as Spec } from '@/lib/reporting';
import { Diagram, clip, num, pct, tipProps } from './Diagram';

type Avatars = Extract<Spec, { type: 'avatars' }>;

const STEPS = [
  { k: 'reached', word: 'Reached', color: 'var(--dia-heat-cold)' },
  { k: 'demos', word: 'Demos', color: 'var(--dia-heat-mild)' },
  { k: 'signups', word: 'Sign-ups', color: 'var(--dia-heat-warm)' },
  { k: 'customers', word: 'Customers', color: 'var(--dia-hi)' },
] as const;
const PAD = 16, LABEL = 150, ROW = 30, TOP = 10, MAX_ROWS = 14;

export function AvatarsDiagram({ d, title, caption, empty }: { d: Avatars; title: string; caption: string; empty: string }) {
  const rows = d.rows.filter((r) => r.reached).slice(0, MAX_ROWS);
  const height = TOP + rows.length * ROW + 8;
  return (
    <Diagram title={title} caption={caption} empty={rows.length ? null : empty} minWidth={520} height={height}
      legend={STEPS.map((s) => ({ color: s.color, label: s.word }))}>
      {(w, tip) => {
        const x0 = PAD + LABEL, bw = w - x0 - PAD, colW = bw / STEPS.length;
        return (
          <g>
            {rows.map((r, i) => {
              const y = TOP + i * ROW;
              const text = `${r.label}\n${STEPS.map((s) => `${s.word}: ${num(r[s.k])}${s.k === 'reached' ? '' : ` (${pct(r[s.k], r.reached)})`}`).join('\n')}`;
              return (
                <g key={r.label} {...tipProps(tip, text)}>
                  <text x={PAD} y={y + 16} fontSize="12" fontWeight="600" fill="var(--dia-ink)">{clip(r.label, 24)}</text>
                  {STEPS.map((s, j) => {
                    const share = r.reached ? r[s.k] / r.reached : 0;
                    const bandW = Math.max(r[s.k] ? 3 : 0, (colW - 6) * share);
                    const cx = x0 + j * colW + (colW - 6) / 2;
                    return (
                      <g key={s.k}>
                        <rect x={x0 + j * colW} y={y + 4} width={colW - 6} height={ROW - 8} rx="3" fill="var(--dia-paper-2)" stroke="var(--dia-hair)" />
                        <rect x={cx - bandW / 2} y={y + 4} width={bandW} height={ROW - 8} rx="3" fill={s.color} />
                        <text x={cx} y={y + 18} textAnchor="middle" fontSize="11" fontWeight="600" fill={share > 0.45 ? 'var(--on-dark, #fff)' : 'var(--dia-ink)'} className={share > 0.45 ? 'dia-on-fill' : 'dia-mono'}>{num(r[s.k])}</text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>
        );
      }}
    </Diagram>
  );
}
