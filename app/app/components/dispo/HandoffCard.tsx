// The acquisitions-to-dispo handoff, on the dispo property's Overview: the
// SOP's first three steps in one card.
//
//   1. Read the handoff: deal basics, property and access, selling context.
//      Every field is click-to-edit (components/ds/InlineField) and saves its
//      own column; nothing here is a second copy of the deal sheet.
//   2. Access: vacant within 24 hours, occupied within 48.
//   3. Comps under 30 days, and a signed contract.
//
// Plus days on market and the "MLS after 6 days" flag. The deal is read on
// its own (lib/dispo-sop loadDispoDeal, every column), so the handoff shows
// columns the app's list query does not carry.
'use client';

import React, { useEffect, useState } from 'react';
import { InlineField, type InlineOption, type InlineValue } from '@/components/ds/InlineField';
import { Badge, btn, GREEN, HAIR, INK, LINE, MUTED, RED } from '@/components/genius/parts';
import { patchRecord } from '@/lib/crm-write';
import { saveDeal } from '@/lib/deal-sheet';
import { DEAL_TYPES } from '@/lib/deal-types';
import {
  accessCheck, compsCheck, contractCheck, loadDispoDeal, marketTiming, MLS_AFTER_DAYS, setAccessVerified,
  type CheckState, type DispoDeal, type SopCheck,
} from '@/lib/dispo-sop';

type Field = { col: string; label: string; type: 'text' | 'money' | 'date' | 'select' | 'textarea'; options?: InlineOption[]; wide?: boolean };

const TYPE_OPTIONS: InlineOption[] = DEAL_TYPES.map((t) => ({ value: t.label, label: t.label }));
const OCCUPANCY: InlineOption[] = [{ value: 'vacant', label: 'Vacant' }, { value: 'occupied', label: 'Occupied' }];
const ACCESS: InlineOption[] = [{ value: 'lockbox', label: 'Lockbox' }, { value: 'appointment', label: 'By appointment' }];
const URGENCY: InlineOption[] = ['Normal', 'High', 'Urgent'].map((u) => ({ value: u, label: u }));

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Deal basics',
    fields: [
      { col: 'transaction_type', label: 'Contract type', type: 'select', options: TYPE_OPTIONS },
      { col: 'offer_amount', label: 'Purchase price', type: 'money' },
      { col: 'arv', label: 'ARV', type: 'money' },
      { col: 'rehab', label: 'Repairs', type: 'money' },
      { col: 'contract_status', label: 'Contract status', type: 'text' },
      { col: 'contract_date', label: 'Contract signed', type: 'date' },
      { col: 'close_date', label: 'AB close date', type: 'date' },
      { col: 'contract_url', label: 'Contract link', type: 'text' },
    ],
  },
  {
    title: 'Property and access',
    fields: [
      { col: 'occupancy_status', label: 'Vacant or occupied', type: 'select', options: OCCUPANCY },
      { col: 'access_kind', label: 'Access', type: 'select', options: ACCESS },
      { col: 'access_instructions', label: 'Lockbox code or how to book', type: 'text' },
      { col: 'occupancy_notes', label: 'Occupant', type: 'text' },
      { col: 'utilities', label: 'Utilities', type: 'text' },
      { col: 'foundation', label: 'Foundation', type: 'text' },
      { col: 'roof', label: 'Roof', type: 'text' },
      { col: 'major_repairs', label: 'Major repairs', type: 'text' },
      { col: 'sticky_issues', label: 'Sticky issues', type: 'text' },
      { col: 'photos_url', label: 'Photos link', type: 'text' },
    ],
  },
  {
    title: 'Selling context',
    fields: [
      { col: 'buyer_restrictions', label: 'Buyer restrictions', type: 'text' },
      { col: 'target_buyer', label: 'Target buyer', type: 'text' },
      { col: 'urgency', label: 'Urgency', type: 'select', options: URGENCY },
      { col: 'comps_dated_on', label: 'Comps dated', type: 'date' },
      { col: 'notes', label: 'Notes', type: 'textarea', wide: true },
    ],
  },
];

/** Columns whose save has side effects the deal sheet owns (the TC checklist track, the TC close date, the stage). */
const VIA_SHEET = new Set(['transaction_type', 'contract_status', 'close_date']);

const TONE: Record<CheckState, { color: string; tint: string; word: string }> = {
  ok: { color: GREEN, tint: '#e7f6f0', word: 'Done' },
  due: { color: '#b45309', tint: '#fef3c7', word: 'Due' },
  late: { color: RED, tint: '#fee2e2', word: 'Late' },
  missing: { color: '#b45309', tint: '#fef3c7', word: 'Missing' },
};

/** Sample handoff for /demo: a vacant house with a lockbox, comps a week old. */
const DEMO: DispoDeal = {
  id: 0, workspace_id: 0, seller_id: null, stage: 'Ready To Market',
  transaction_type: 'Assignment', offer_amount: 214000, arv: 345000, rehab: 52000, contract_status: 'Signed', contract_date: '2026-08-27',
  close_date: '2026-10-24', contract_url: null, occupancy_status: 'vacant', access_kind: 'lockbox', access_instructions: 'Lockbox 4471 on the back door',
  occupancy_notes: null, utilities: 'On', foundation: 'Pier and beam, no movement noted', roof: 'End of life', major_repairs: 'Kitchen, both baths, roof',
  sticky_issues: null, photos_url: null, buyer_restrictions: 'No owner-occupants', target_buyer: 'Flippers in Oak Cliff', urgency: 'High',
  comps_dated_on: '2026-10-03', notes: 'Seller leaves the shed contents.', marketing_started_on: '2026-10-05', access_verified_at: null,
};

export function HandoffCard({ dealId, address, seller, canWrite, readOnlyReason, isMobile, userId, onToast, demo }: {
  dealId: number | null;
  address: string;
  seller: string;
  canWrite: boolean;
  readOnlyReason?: string | null;
  isMobile: boolean;
  userId: string | null;
  onToast: (m: string) => void;
  demo?: boolean;
}) {
  const [deal, setDeal] = useState<DispoDeal | null>(demo ? DEMO : null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(demo ? 'ready' : 'loading');
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (demo || !dealId) return;
    let live = true;
    void loadDispoDeal(dealId).then((d) => {
      if (!live) return;
      setDeal(d);
      setState(d ? 'ready' : 'error');
    });
    return () => { live = false; };
  }, [dealId, demo]);

  if (!demo && !dealId) return null;
  const readOnly = !canWrite ? (readOnlyReason || 'You can view this deal but not edit it') : null;

  const save = (col: string) => async (v: InlineValue) => {
    if (demo || !dealId) { setDeal((d) => (d ? { ...d, [col]: v } : d)); return { ok: true }; }
    if (VIA_SHEET.has(col)) {
      const r = await saveDeal(dealId, { [col]: v } as never);
      if (!r.ok) return { ok: false, message: r.message || 'That did not save.' };
      setDeal((d) => (d ? { ...d, [col]: v, ...(r.deal ? { stage: (r.deal as { stage?: string }).stage ?? d.stage } : {}) } : d));
      return { ok: true };
    }
    const r = await patchRecord<DispoDeal>('deals', dealId, { [col]: v });
    if (r.ok) setDeal((d) => (d ? { ...d, ...r.row } : r.row));
    return r;
  };

  const verify = async (on: boolean) => {
    if (demo || !dealId) { setDeal((d) => (d ? { ...d, access_verified_at: on ? new Date().toISOString() : null } : d)); return; }
    setVerifying(true);
    const r = await setAccessVerified(dealId, on, userId);
    setVerifying(false);
    if (!r.ok) return onToast(r.message);
    setDeal((d) => (d ? { ...d, access_verified_at: on ? new Date().toISOString() : null } : d));
    onToast(on ? 'Access verified' : 'Access marked not verified');
  };

  const str = (k: string) => (deal?.[k] == null ? null : String(deal[k]));
  const num = (k: string) => (deal?.[k] == null ? null : Number(deal[k]));
  // Sold the new way (Mark Sold) or the old one (a buyer on it, or past Ready To Market): never MLS.
  const sold = !!deal?.sold_at || deal?.buyer_id != null || !['Prospect', 'Under Contract Seller', 'Ready To Market'].includes(String(deal?.stage ?? ''));
  const timing = marketTiming(str('marketing_started_on'), { sold });
  const checks: SopCheck[] = deal ? [
    accessCheck({ occupancy_status: str('occupancy_status'), access_verified_at: str('access_verified_at'), marketing_started_on: str('marketing_started_on') }),
    compsCheck(str('comps_dated_on')),
    contractCheck({ contract_date: str('contract_date'), contract_status: str('contract_status') }),
  ] : [];

  return (
    <section data-gx data-testid="dispo-handoff" aria-labelledby="handoff-title" style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '12px 16px', borderBottom: `1px solid ${HAIR}` }}>
        <h2 id="handoff-title" style={{ margin: 0, fontSize: '13.5px', fontWeight: 650, color: INK }}>Acquisitions handoff</h2>
        <span style={{ fontSize: '11.5px', color: MUTED, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${address} · ${seller}`}>
          {address} · {seller}
        </span>
        <span style={{ flex: 1 }} />
        {timing.dom == null
          ? <Badge title="Days on market start when the deal reaches Ready To Market">Not on market yet</Badge>
          : <Badge color={timing.mlsDue ? RED : INK} tint={timing.mlsDue ? '#fee2e2' : '#f4f4f5'} title={`Marketing started ${str('marketing_started_on')}`}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{timing.dom} day{timing.dom === 1 ? '' : 's'} on market</span>
            </Badge>}
        {timing.mlsDue ? <Badge color={RED} tint="#fee2e2" title={`Unsold after ${MLS_AFTER_DAYS} days: list it on the MLS`}>MLS now</Badge> : null}
      </header>

      {state === 'loading' ? <div role="status" style={{ padding: '14px 16px', fontSize: '12.5px', color: MUTED }}>Loading the handoff…</div> : null}
      {state === 'error' ? <div role="alert" style={{ padding: '14px 16px', fontSize: '12.5px', color: RED }}>Could not read this deal. It may be archived or outside your workspace. Reload to try again.</div> : null}

      {deal ? (
        <>
          <div role="list" aria-label="Dispo checks" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0,1fr))', borderBottom: `1px solid ${HAIR}` }}>
            {checks.map((c, i) => {
              const t = TONE[c.state];
              return (
                <div role="listitem" key={c.key} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', borderLeft: !isMobile && i ? `1px solid ${HAIR}` : 0, borderTop: isMobile && i ? `1px solid ${HAIR}` : 0, minWidth: 0 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '12.5px', fontWeight: 600, color: INK }}>{c.label}</span>
                      <Badge color={t.color} tint={t.tint}>{t.word}</Badge>
                    </div>
                    <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '2px' }}>{c.detail}</div>
                  </div>
                  {c.key === 'access' && !readOnly ? (
                    <button type="button" style={btn('ghost', true)} disabled={verifying} onClick={() => void verify(c.state !== 'ok')}>
                      {verifying ? 'Saving…' : c.state === 'ok' ? 'Undo' : 'Mark verified'}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0,1fr))' }}>
            {GROUPS.map((g, gi) => (
              <div key={g.title} role="group" aria-label={g.title} style={{ padding: '12px 16px 14px', borderLeft: !isMobile && gi ? `1px solid ${HAIR}` : 0, borderTop: isMobile && gi ? `1px solid ${HAIR}` : 0, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: INK, marginBottom: '8px' }}>{g.title}</div>
                <div style={{ display: 'grid', gap: '10px' }}>
                  {g.fields.map((f) => (
                    <InlineField key={f.col} recordId={`deal${dealId ?? 'demo'}`} field={f.col} label={f.label} showLabel type={f.type}
                      options={f.options} readOnly={readOnly}
                      value={f.type === 'money' ? num(f.col) : f.type === 'date' ? (str(f.col)?.slice(0, 10) ?? null) : str(f.col)}
                      onSave={save(f.col)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
