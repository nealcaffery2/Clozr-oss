// The public record COMPR pulled for this property: owner, loan, equity, tax,
// last sale, foreclosure / tax events, permits, rent. Read-only; a COMPR run
// replaces it. Blank fields are ones COMPR did not return.
'use client';

import React, { useEffect, useState } from 'react';
import type { PropertyRecordRow } from '@/lib/database.types';
import { loadPropertyRecords } from '@/lib/property-records';

const money = (n: number | null | undefined) => (n == null ? null : '$' + Math.round(n).toLocaleString('en-US'));
const day = (s: string | null | undefined) => (s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null);
const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ') || null;
const EVENT: Record<string, string> = { foreclosure: 'Foreclosure', tax_delinquent: 'Tax delinquent' };

export function PropertyRecords({ sellerId, dealId, reloadKey }: { sellerId?: number | null; dealId?: number | null; reloadKey?: string | number | null }) {
  const [state, setState] = useState<{ key: string; row: PropertyRecordRow | null } | null>(null);
  const key = `${dealId ?? ''}:${sellerId ?? ''}:${reloadKey ?? ''}`;
  useEffect(() => {
    let live = true;
    void loadPropertyRecords({ dealId, sellerId }).then((row) => { if (live) setState({ key, row }); });
    return () => { live = false; };
  }, [dealId, sellerId, key]);

  const cur = state?.key === key ? state : null;
  const r = cur?.row ?? null;
  if (!cur) return <div style={{ fontSize: '12.5px', color: '#71717a', padding: '8px 0' }}>Loading property records…</div>;
  if (!r) return <div style={{ fontSize: '12.5px', color: '#71717a', padding: '8px 0' }}>Run COMPR to pull property records.</div>;

  const mail = r.owner_mailing;
  const sale = r.last_sale;
  const rows: [string, React.ReactNode][] = [
    ['Owner', r.owner_name],
    ['Absentee', r.absentee == null ? null : r.absentee ? 'Yes — owner does not live there' : 'No — owner-occupied'],
    ['Mailing', mail ? join(mail.line1, [mail.city, mail.state].filter(Boolean).join(', '), mail.zip) : null],
    ...(r.mortgages ?? []).map((m, i): [string, React.ReactNode] => [
      i ? `Loan ${i + 1}` : 'Loan',
      join(m.lender, m.amount != null ? `${money(m.amount)} original` : null, m.balance != null ? `${money(m.balance)} balance` : null,
        m.type, m.rate_pct != null ? `${m.rate_pct}%` : null, day(m.date)),
    ]),
    ['Equity', join(money(r.est_equity), r.ltv != null ? `LTV ${r.ltv}%` : null)],
    ['Assessed', money(r.assessed_value)],
    ['Taxes', r.tax_amount != null ? `${money(r.tax_amount)} / yr` : null],
    ['Last sale', sale ? join(money(sale.price), day(sale.date)) : null],
    ['Prior sale', sale ? join(money(sale.prior_price), day(sale.prior_date)) : null],
    ...(r.events ?? []).map((e): [string, React.ReactNode] => [
      EVENT[e.type] ?? e.type,
      <span key={e.type} style={{ color: '#b91c1c' }}>
        {join(e.detail.stage as string | null, day(e.date),
          e.detail.auction_date ? `auction ${day(e.detail.auction_date as string)}` : null,
          e.detail.unpaid_balance != null ? `${money(e.detail.unpaid_balance as number)} unpaid` : null,
          e.detail.balance != null ? `${money(e.detail.balance as number)} owed` : null) ?? 'On record'}
      </span>,
    ]),
    ['Permits', r.permits ? join(`${r.permits.count}`, r.permits.last_date ? `last ${day(r.permits.last_date)}` : null, money(r.permits.total_job_value)) : null],
    ['Rent est.', r.rent_estimate != null ? `${money(r.rent_estimate)} / mo` : null],
  ];

  return (
    <div>
      {rows.filter(([, v]) => v != null && v !== '').map(([k, v], i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '86px 1fr', gap: '8px', padding: '6px 0', borderBottom: '1px solid #f0f0f1', fontSize: '12px' }}>
          <span style={{ color: '#71717a' }}>{k}</span>
          <span style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{v}</span>
        </div>
      ))}
      <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '6px' }}>from COMPR · {day(r.fetched_at)}</div>
    </div>
  );
}
