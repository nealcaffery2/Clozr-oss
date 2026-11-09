// The buyer's company as an org chart: everyone on file at the same company
// (same company name, or the company's own email domain), ranked by title,
// each one a click to their record. Lives in the buyer record's right rail.
//
// Read on its own when the record opens: the loaded buyer list holds only
// part of the workspace, and a colleague may be a prospect or a realtor row.
'use client';

import React, { useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { supabase } from '@/lib/supabase';
import { companyDomain, companyKey } from '@/lib/quick-add-dupes';
import { OrgChart } from '@/components/OrgChart';

type Person = { id: number; name: string | null; title: string | null; email: string | null; company: string | null };

export { seniority } from '@/components/OrgChart';

export function CompanyChart({ V, buyerId, company, email, title }: {
  V: ClozrView; buyerId: number | null; company: string | null; email: string | null; title: string | null;
}) {
  const [read, setRead] = useState<{ q: string; rows: Person[] } | null>(null);
  const ws = V.liveIds?.workspaceId ?? null;
  const domain = companyDomain(email);
  const key = companyKey(company);

  // What was read is kept with the company it was read for, so another record never shows this one's people.
  const q = `${ws}|${domain ?? ''}|${key}|${title ?? ''}`;
  const people = read && read.q === q ? read.rows : null;
  useEffect(() => {
    if (!supabase || ws == null || (!domain && !key)) return;
    let live = true;
    const like = (v: string) => v.replace(/[\\%_]/g, (c) => '\\' + c);
    const ors = [domain ? `email.ilike.%@${like(domain)}` : null, company?.trim() ? `company.ilike.${like(company.trim())}` : null].filter(Boolean).join(',');
    void supabase.from('buyers').select('id, name, title, email, company' as 'id').eq('workspace_id', ws).or(ors).is('archived_at' as 'id', null).limit(60)
      .then(({ data }) => {
        if (!live) return;
        const rows = ((data ?? []) as unknown as Person[]).filter((r) => (domain && companyDomain(r.email) === domain) || (key && companyKey(r.company) === key));
        setRead({ q: `${ws}|${domain ?? ''}|${key}|${title ?? ''}`, rows });
      });
    return () => { live = false; };
  }, [ws, domain, key, company, title]);

  if (!company?.trim() && !domain) return null;
  const name = company?.trim() || domain || 'This company';
  const all = people ?? [];

  return (
    <div className="rec-card" style={{ marginTop: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 600 }}>Company</div>
        <button type="button" onClick={() => V.openAddBuyer({ company: company?.trim() || '' })}
          style={{ border: 0, background: 'none', padding: 0, color: 'var(--tx-mint, #0a8560)', fontSize: '12px', fontWeight: 650, cursor: 'pointer' }}>
          + Add a contact
        </button>
      </div>
      <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--ink, #18181b)', marginTop: '2px' }}>{name}</div>
      <div style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>
        {people === null ? 'Reading who works there…' : `${all.length} ${all.length === 1 ? 'person' : 'people'} on file`}
      </div>
      <OrgChart label={name} people={all.map((p) => ({
        key: p.id, name: p.name || 'No name', title: p.title, current: p.id === buyerId,
        onOpen: () => V.genius.openBuyer(p.id), hint: `Open ${p.name ?? 'buyer'}`,
      }))} />
    </div>
  );
}
