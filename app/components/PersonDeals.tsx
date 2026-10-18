// Every deal on a contact. A partner (Offerpad, Mark Spain…) sends hundreds of
// submissions, each its own property with its own stage and numbers; this is
// where they live on the one contact. Search, then open a deal's sheet.
'use client';

import React, { useState } from 'react';

export type PersonDealRow = { id: string; addr: string; city: string; stage: string; stageColor: string; offer: string; arv: string; fee: string; when: string; open: () => void };

export function PersonDeals({ rows }: { rows: PersonDealRow[] }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  if (rows.length < 2) return null;
  const n = q.trim().toLowerCase();
  const hits = n ? rows.filter((r) => `${r.addr} ${r.city} ${r.stage}`.toLowerCase().includes(n)) : rows;
  const shown = all || n ? hits.slice(0, 200) : hits.slice(0, 8);
  return (
    <div style={{ marginTop: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 600 }}>Deals &amp; submissions</span>
        <span style={{ fontSize: '11px', color: 'var(--subtle, #a1a1aa)' }}>{rows.length}</span>
      </div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a property" aria-label="Find a property on this contact"
        style={{ width: '100%', height: '30px', padding: '0 9px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '12.5px', background: 'var(--canvas, #fafafa)', marginBottom: '6px' }} />
      <div style={{ border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', overflow: 'hidden', background: 'var(--surface, #fff)' }}>
        {shown.map((r) => (
          <button key={r.id} type="button" className="dc2" onClick={r.open}
            style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '8px', width: '100%', textAlign: 'left', padding: '8px 10px', border: 0, borderBottom: '1px solid var(--divider-2, #f0f0f1)', background: 'var(--surface, #fff)', cursor: 'pointer' }}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.addr}</span>
              <span style={{ display: 'block', fontSize: '11px', color: 'var(--meta, #71717a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {[r.city, r.offer !== '—' ? r.offer : null, r.arv !== '—' ? 'ARV ' + r.arv : null, r.when].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span style={{ textAlign: 'right' }}>
              <span style={{ display: 'block', fontSize: '11.5px', fontWeight: 700, color: r.stageColor, whiteSpace: 'nowrap' }}>{r.stage}</span>
              {r.fee !== '—' ? <span style={{ display: 'block', fontSize: '11.5px', fontWeight: 700, color: 'var(--tx-green, #15803d)' }}>{r.fee}</span> : null}
            </span>
          </button>
        ))}
        {!hits.length ? <div style={{ padding: '10px', fontSize: '12px', color: 'var(--subtle, #a1a1aa)' }}>No property matches.</div> : null}
      </div>
      {!n && hits.length > 8 ? (
        <button type="button" onClick={() => setAll(!all)} style={{ marginTop: '6px', border: 0, background: 'none', color: 'var(--tx-mint, #0a8560)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', padding: 0 }}>
          {all ? 'Show fewer' : `Show all ${hits.length}`}
        </button>
      ) : null}
    </div>
  );
}
