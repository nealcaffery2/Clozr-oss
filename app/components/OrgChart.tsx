// A company's people as an org chart: tiers by seniority (the main point of
// contact, when there is one, above everyone), joined by a line, each person a
// button. Shared by the buyer record (Company card) and the vendor and
// wholesaler cards in People's grouped view.
'use client';

import React from 'react';

/** 0 runs the company, 1 runs a team, 2 leads, 3 everyone else. */
export function seniority(title: string | null | undefined): number {
  const t = (title ?? '').toLowerCase();
  if (/\b(owner|founder|ceo|president|principal|partner|managing member|chief)\b/.test(t)) return 0;
  if (/\b(vp|vice president|director|head)\b/.test(t)) return 1;
  if (/\b(manager|lead|senior|sr\.?)\b/.test(t)) return 2;
  return 3;
}

export type OrgPerson = {
  key: string | number;
  name: string;
  title: string | null;
  /** The company's main point of contact: drawn above the rest. */
  main?: boolean;
  /** The record being looked at: highlighted, not a link. */
  current?: boolean;
  onOpen?: () => void;
  /** What a click does, for the button's title ("Open Andrea Brooks", "Text Bob"). */
  hint?: string;
};

const initials = (n: string) => (n || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

export function OrgChart({ people, label }: { people: OrgPerson[]; label: string }) {
  const rank = (p: OrgPerson) => (p.main ? -1 : seniority(p.title));
  const ranks = [...new Set(people.map(rank))].sort((a, b) => a - b);
  const tiers = ranks.map((r) => people.filter((p) => rank(p) === r).sort((a, b) => a.name.localeCompare(b.name)));
  if (!tiers.length) return null;
  return (
    <ol aria-label={`${label} org chart`} style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'grid' }}>
      {tiers.map((tier, i) => (
        <li key={i} style={{ position: 'relative', paddingTop: i ? '14px' : 0 }}>
          {/* The line from the tier above. */}
          {i ? <span aria-hidden style={{ position: 'absolute', left: '50%', top: 0, width: '1px', height: '14px', background: 'var(--divider, #e4e4e7)' }} /> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center' }}>
            {tier.map((p) => (
              <button key={p.key} type="button" onClick={p.current ? undefined : p.onOpen} aria-current={p.current ? 'true' : undefined}
                disabled={!p.current && !p.onOpen} title={p.current ? 'This record' : p.hint ?? `Open ${p.name}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, maxWidth: '100%', padding: '6px 9px 6px 6px', borderRadius: '10px', textAlign: 'left',
                  border: `1px solid ${p.current ? 'var(--tx-mint, #0a8560)' : p.main ? '#f59e0b' : 'var(--divider, #e4e4e7)'}`,
                  background: p.current ? 'var(--tint-mint, #ecfdf5)' : 'var(--surface, #fff)',
                  cursor: p.current || !p.onOpen ? 'default' : 'pointer', font: 'inherit', color: 'var(--ink, #18181b)',
                }}>
                <span aria-hidden style={{ width: '26px', height: '26px', borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontSize: '10.5px', fontWeight: 700, background: 'var(--surface-2, #f4f4f5)', color: 'var(--muted, #52525b)' }}>{initials(p.name)}</span>
                <span style={{ minWidth: 0, display: 'grid' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name || 'No name'}{p.main ? <span style={{ color: 'var(--tx-amber, #b45309)' }}> ★</span> : null}</span>
                  <span style={{ fontSize: '11.5px', color: p.title ? 'var(--muted, #52525b)' : 'var(--meta, #71717a)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title || (p.main ? 'Main contact' : 'No title yet')}</span>
                </span>
              </button>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}
