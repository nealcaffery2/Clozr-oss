'use client';

// Date added, and the offer-versus-ask gap, inside the Filters panel.
// Selected ranges are chips. Custom opens two date inputs.

import React from 'react';
import { DATE_RANGES } from '@/lib/date-window';
import { GAP_BASIS, GAP_CHOICES } from '@/lib/attack-gap';

const label: React.CSSProperties = { display: 'block', fontSize: 11.5, color: '#71717a', fontWeight: 500, marginBottom: 6 };
const note: React.CSSProperties = { fontSize: 11.5, color: '#71717a', marginTop: 6, lineHeight: 1.45 };
const field: React.CSSProperties = { width: '100%', height: 32, padding: '0 8px', border: '1px solid #e4e4e7', borderRadius: 8, fontSize: 12.5, background: '#fafafa', color: '#18181b', fontFamily: 'inherit', boxSizing: 'border-box' };
const shown = (v: string | undefined) => (v && v !== 'Any' ? v : '');

function Chips({ name, value, options, onChange }: { name: string; value: string; options: readonly string[]; onChange: (v: string) => void }) {
  return (
    <div role="group" aria-label={name} className="cz-fp-chips">
      {options.map((o) => (
        <button key={o} type="button" className="cz-fp-chip" aria-pressed={value === o} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  );
}

export function DateRangeFields({ when, from, to, onChange }: {
  when: string | undefined;
  from: string | undefined;
  to: string | undefined;
  onChange: (patch: { when: string; from?: string; to?: string }) => void;
}) {
  const picked = when && DATE_RANGES.includes(when as typeof DATE_RANGES[number]) ? when : 'Any';
  return (
    <section>
      <span style={label}>Date added</span>
      <Chips name="Date added" value={picked} options={DATE_RANGES} onChange={(v) => onChange(v === 'Custom' ? { when: v } : { when: v, from: 'Any', to: 'Any' })} />
      {picked === 'Custom' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
          <label><span style={label}>From</span><input type="date" aria-label="Date added from" value={shown(from)} onChange={(e) => onChange({ when: 'Custom', from: e.target.value || 'Any' })} style={field} /></label>
          <label><span style={label}>To</span><input type="date" aria-label="Date added to" value={shown(to)} onChange={(e) => onChange({ when: 'Custom', to: e.target.value || 'Any' })} style={field} /></label>
        </div>
      ) : null}
    </section>
  );
}

export function AttackGapFields({ basis, gap, onBasis, onGap }: {
  basis: string | undefined;
  gap: string | undefined;
  onBasis: (v: string) => void;
  onGap: (v: string) => void;
}) {
  return (
    <section>
      <span style={label}>Offer vs ask</span>
      <Chips name="Compare our number" value={basis === 'UW high' ? 'UW high' : 'Our offer'} options={GAP_BASIS} onChange={onBasis} />
      <div style={{ height: 8 }} />
      <Chips name="Gap" value={gap && GAP_CHOICES.includes(gap as typeof GAP_CHOICES[number]) ? gap : 'Any'} options={GAP_CHOICES} onChange={onGap} />
      <div style={note}>Asking $100k and we can offer $120k is a +$20k gap. At or above their ask is a deal we can attack. Within $20k is that close on either side. UW high is the underwriter’s high offer.</div>
    </section>
  );
}
