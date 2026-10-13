// The dispo property's Walkthroughs tab: the walkthroughs booked on this
// house only (its seller or its property), read on their own, and Confirm
// stamps the appointment (migration 235 `appointments.confirmed_at`) and logs
// it on the buyer.
'use client';

import React, { useEffect, useState } from 'react';
import { Badge, btn, GREEN, HAIR, INK, INK_2, LINE, MUTED, RED } from '@/components/genius/parts';
import { confirmWalkthrough, loadDispoDeal } from '@/lib/dispo-sop';
import { supabase } from '@/lib/supabase';
import type { DeskBuyer } from './OfferDesk';

type Walk = { id: number; buyer_id: number | null; starts_at: string; title: string; confirmed_at: string | null };
export type DemoWalk = { buyer: string; contact: string; date: string; time: string; status: string };

async function loadWalks(dealId: number): Promise<Walk[] | null> {
  if (!supabase) return null;
  const deal = await loadDispoDeal(dealId);
  if (!deal) return null;
  const propertyId = deal.property_id == null ? null : Number(deal.property_id);
  if (deal.seller_id == null && propertyId == null) return [];
  // This house's walkthroughs. One booked before the house was recorded on it
  // (seller only, no property) counts too, but only when the seller has just
  // this one house: a partner with forty houses would see every one's.
  let sellerOnly = false;
  if (deal.seller_id != null) {
    const { data: houses } = await supabase.from('deals').select('property_id').eq('seller_id', deal.seller_id).not('property_id', 'is', null).limit(50);
    sellerOnly = new Set((houses ?? []).map((h) => h.property_id)).size <= 1;
  }
  let q = supabase.from('appointments').select('*').eq('workspace_id', deal.workspace_id).ilike('kind', '%walk%').is('deleted_at', null);
  if (propertyId != null && deal.seller_id != null && sellerOnly) q = q.or(`property_id.eq.${propertyId},and(seller_id.eq.${deal.seller_id},property_id.is.null)`);
  else if (propertyId != null) q = q.eq('property_id', propertyId);
  else if (deal.seller_id != null && sellerOnly) q = q.eq('seller_id', deal.seller_id).is('property_id', null);
  else return [];
  const { data, error } = await q.order('starts_at', { ascending: false }).limit(100);
  if (error) return null;
  return ((data ?? []) as Record<string, unknown>[]).map((a) => ({
    id: Number(a.id), buyer_id: a.buyer_id == null ? null : Number(a.buyer_id), starts_at: String(a.starts_at),
    title: String(a.title ?? ''), confirmed_at: (a.confirmed_at as string | null) ?? null,
  }));
}

export function Walkthroughs({ dealId, workspaceId, userId, canWrite, isMobile, buyerOf, onOpenBuyer, onToast, version, demoRows }: {
  dealId: number | null; workspaceId: number | null; userId: string | null; canWrite: boolean; isMobile: boolean;
  buyerOf: (id: number) => DeskBuyer | null; onOpenBuyer: (id: number) => void; onToast: (m: string, tone?: 'success' | 'error') => void;
  /** Bumped after a walkthrough is booked, so the list reads again. */
  version: number;
  demoRows?: DemoWalk[] | null;
}) {
  const [walks, setWalks] = useState<Walk[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(demoRows ? 'ready' : 'loading');
  const [busy, setBusy] = useState<number | null>(null);
  const [demoConfirmed, setDemoConfirmed] = useState<Record<number, boolean>>({});

  const demo = !!demoRows;
  useEffect(() => {
    if (demo || !dealId) return;
    let live = true;
    void loadWalks(dealId).then((w) => {
      if (!live) return;
      if (!w) { setState('error'); return; }
      setWalks(w); setState('ready');
    });
    return () => { live = false; };
  }, [dealId, demo, version]);
  // When "past" is judged; read once, not on every render.
  const [now] = useState(() => Date.now());

  const confirm = async (w: Walk) => {
    if (!workspaceId) return;
    setBusy(w.id);
    const b = w.buyer_id ? buyerOf(w.buyer_id) : null;
    const r = await confirmWalkthrough(workspaceId, w.id, w.buyer_id, `${b?.company || b?.name || 'Buyer'} · ${when(w.starts_at)}`, userId);
    setBusy(null);
    if (!r.ok) return onToast(r.message, 'error');
    setWalks((x) => (x ?? []).map((y) => (y.id === w.id ? { ...y, confirmed_at: new Date().toISOString() } : y)));
    onToast('Walkthrough confirmed', 'success');
  };

  const rows = demoRows
    ? demoRows.map((d, i) => ({ key: i, who: d.buyer, contact: d.contact, at: `${d.date} · ${d.time}`, past: false, confirmed: d.status === 'Confirmed' || !!demoConfirmed[i], go: () => setDemoConfirmed((c) => ({ ...c, [i]: true })), open: null as null | (() => void), busy: false }))
    : (walks ?? []).map((w) => {
      const b = w.buyer_id ? buyerOf(w.buyer_id) : null;
      return {
        key: w.id, who: b?.company || b?.name || 'Buyer', contact: b?.name ?? '', at: when(w.starts_at), past: new Date(w.starts_at).getTime() < now,
        confirmed: !!w.confirmed_at, go: () => void confirm(w), open: w.buyer_id ? () => onOpenBuyer(w.buyer_id as number) : null, busy: busy === w.id,
      };
    });

  return (
    <div data-gx style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${HAIR}`, fontSize: '13.5px', fontWeight: 650, color: INK }}>Walkthroughs on this property</div>
      {state === 'loading' ? <div role="status" style={{ padding: '14px 16px', fontSize: '12.5px', color: MUTED }}>Loading walkthroughs…</div> : null}
      {state === 'error' ? <div role="alert" style={{ padding: '14px 16px', fontSize: '12.5px', color: RED }}>Could not read the walkthroughs. Reload to try again.</div> : null}
      {state === 'ready' && rows.length === 0 ? <div style={{ padding: '14px 16px', fontSize: '12.5px', color: MUTED }}>No walkthroughs booked on this house yet. Schedule one for a buyer who asked.</div> : null}
      {rows.map((r) => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr) auto' : 'minmax(0,1.4fr) minmax(0,1fr) auto auto', gap: '10px', alignItems: 'center', padding: '10px 16px', borderBottom: `1px solid ${HAIR}`, fontSize: '12.5px' }}>
          <span style={{ minWidth: 0 }}>
            {r.open ? (
              <button type="button" onClick={r.open} style={{ border: 0, background: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: INK, cursor: 'pointer', textAlign: 'left' }}>{r.who}</button>
            ) : <span style={{ fontWeight: 600 }}>{r.who}</span>}
            <span style={{ display: 'block', fontSize: '11.5px', color: MUTED }}>{r.contact}{isMobile ? ` · ${r.at}` : ''}</span>
          </span>
          {isMobile ? null : <span style={{ color: INK_2, fontVariantNumeric: 'tabular-nums' }}>{r.at}</span>}
          {r.confirmed ? <Badge color={GREEN} tint="#e7f6f0">Confirmed</Badge> : <Badge>{r.past ? 'Not confirmed' : 'Scheduled'}</Badge>}
          {!isMobile || !r.confirmed ? (
            r.confirmed || !canWrite ? <span /> : (
              <button type="button" style={btn('ghost', true)} disabled={r.busy} onClick={r.go}>{r.busy ? 'Confirming…' : 'Confirm'}</button>
            )
          ) : null}
        </div>
      ))}
    </div>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
