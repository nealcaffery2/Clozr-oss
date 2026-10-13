'use client';

import { optionReadouts } from '@/supabase/functions/_shared/option-clock';

/** Seller and buyer option clocks. The same readout the hourly risk scan uses. */
export function OptionTimers({ seller, buyer }: { seller?: string | null; buyer?: string | null }) {
  const rows = optionReadouts(seller, buyer);
  if (!rows.length) return null;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {rows.map((r) => (
        <div key={r.side} title={r.title} style={{
          fontSize: 11, fontWeight: 650,
          color: r.atRisk ? '#b45309' : '#0A8560',
          background: r.atRisk ? '#fffbeb' : '#f0fdf4',
          border: `1px solid ${r.atRisk ? '#fde68a' : '#bbf7d0'}`,
          borderRadius: 7, padding: '3px 7px',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{r.label}</div>
      ))}
    </div>
  );
}
