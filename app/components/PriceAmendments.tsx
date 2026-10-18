// A deal's amended prices: which price, from → to, by how much, who and when.
// Written by the database on every change (migration 48), so it is the same
// trail whichever screen made the change.
'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Row = { id: number; field: string; old_value: number | null; new_value: number | null; delta: number; changed_by: string | null; changed_at: string };

export const PRICE_LABEL: Record<string, string> = {
  offer_amount: 'Seller price', sold_price: 'Dispo price', marketed_price: 'Marketed price', marketed_fee: 'Marketed fee',
  dispo_fee: 'Dispo fee', assignment_fee: 'Assignment fee', target_assignment: 'Target assignment', price_drop: 'Price drop',
};
const usd = (n: number | null) => (n == null ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));

export function PriceAmendments({ workspaceId, dealId, reloadKey }: { workspaceId: number; dealId: number; reloadKey?: unknown }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!supabase) return;
    let live = true;
    void Promise.all([
      supabase.from('deal_price_changes').select('id,field,old_value,new_value,delta,changed_by,changed_at').eq('deal_id', dealId).order('changed_at', { ascending: false }),
      supabase.from('workspace_roster').select('user_id, full_name, email').eq('workspace_id', workspaceId),
    ]).then(([c, t]) => {
      if (!live) return;
      setRows(((c.data ?? []) as Row[]));
      setNames(Object.fromEntries((t.data ?? []).map((r) => [r.user_id, r.full_name || r.email || 'Teammate'])));
    });
    return () => { live = false; };
  }, [workspaceId, dealId, reloadKey]);

  if (rows === null) return <div style={{ fontSize: '12px', color: 'var(--subtle, #a1a1aa)' }}>Loading…</div>;
  if (!rows.length) return <div style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>No price has been amended on this deal.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px', minWidth: '560px' }}>
        <thead>
          <tr>{['Price', 'From', 'To', 'Change', 'By', 'When'].map((h) => <th key={h} style={{ textAlign: 'left', fontSize: '11px', color: 'var(--meta, #71717a)', padding: '6px 8px', borderBottom: '1px solid var(--divider, #e4e4e7)' }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--divider-2, #f0f0f1)', fontWeight: 600 }}>{PRICE_LABEL[r.field] ?? r.field}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--divider-2, #f0f0f1)', color: 'var(--meta, #71717a)', textDecoration: 'line-through' }}>{usd(r.old_value)}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--divider-2, #f0f0f1)', fontWeight: 600 }}>{usd(r.new_value)}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--divider-2, #f0f0f1)', fontWeight: 600, color: Number(r.delta) < 0 ? 'var(--tx-red, #b91c1c)' : '#16a34a' }}>{Number(r.delta) > 0 ? '+' : ''}{usd(Number(r.delta))}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--divider-2, #f0f0f1)' }}>{r.changed_by ? names[r.changed_by] ?? 'Teammate' : 'System / import'}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--divider-2, #f0f0f1)', color: 'var(--muted, #52525b)', whiteSpace: 'nowrap' }}>{new Date(r.changed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
