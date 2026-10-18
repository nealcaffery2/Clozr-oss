// The buyer record's profile, edited where it is read: name, company, type,
// VIP, vetted, proof of funds, markets and the price range, each one click to
// edit (components/ds/InlineField) and saved on its own (lib/crm-write
// `saveBuyerField`). Phones and emails stay in BuyerContact; the rest of the
// buy box (strategy, rehab, economics) opens the Buy box dialog.
//
// The row is read on its own so the fields show what the database holds now,
// not the list's copy, and each save patches that row in place.
'use client';

import React, { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { InlineField, type InlineOption, type InlineValue } from '@/components/ds/InlineField';
import { BUYER_TYPES, ENTITY_TYPES, normalizeBuyBox } from '@/lib/buyer-profile';
import { saveBuyerField, type BuyerFieldKey } from '@/lib/crm-write';
import { supabase } from '@/lib/supabase';

const TYPES: InlineOption[] = BUYER_TYPES.map(([v, l]) => ({ value: v, label: l }));
const ENTITIES: InlineOption[] = ENTITY_TYPES.map(([v, l]) => ({ value: v, label: l }));
const YES_NO: InlineOption[] = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

type Row = Record<string, unknown>;

const rowStyle = (mobile: boolean): React.CSSProperties => ({
  display: 'grid', gridTemplateColumns: mobile ? 'minmax(0,86px) minmax(0,1fr)' : '88px minmax(0,1fr)', gap: '10px',
  padding: '6px 0', borderBottom: '1px solid var(--divider-2, #f0f0f1)', fontSize: '12.5px', alignItems: 'baseline',
});

/** The name and company at the top of the record. */
export function BuyerHeadFields({ V }: { V: ClozrView }) {
  const { row, save, readOnly, id } = useBuyerRow(V);
  const name = row ? String(row.name ?? '') : V.B.name;
  const company = row ? (row.company == null ? null : String(row.company)) : (V.B.company && V.B.company !== '—' ? V.B.company : null);
  return (
    <div style={{ minWidth: 0, display: 'grid', gap: '2px' }}>
      <span style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>
        <InlineField recordId={`buyer${id}`} field="name" label="Buyer name" type="text" value={name} readOnly={readOnly} onSave={save('name')} />
      </span>
      <span style={{ fontSize: '12.5px', color: 'var(--muted, #52525b)' }}>
        <InlineField recordId={`buyer${id}`} field="company" label="Company" type="text" value={company} placeholder="Add company" readOnly={readOnly} onSave={save('company')} />
      </span>
    </div>
  );
}

/** Type, VIP, vetted, POF, markets and the price range, as rows in the left rail. */
export function BuyerProfileFields({ V }: { V: ClozrView }) {
  const { row, save, readOnly, id, state, retry } = useBuyerRow(V);
  const m = V.isMobile;
  const banner = state === 'error' ? (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)', borderBottom: '1px solid var(--divider-2, #f0f0f1)' }}>
      <span style={{ flex: 1 }}>Could not read this buyer, so the fields below can&apos;t be edited.</span>
      <button type="button" onClick={retry} style={{ height: '28px', padding: '0 10px', borderRadius: '8px', border: 0, boxShadow: '0 0 0 1px rgba(0,0,0,.08)', background: 'var(--surface, #fff)', fontSize: '12px', fontWeight: 500, cursor: 'pointer', color: 'var(--ink, #18181b)' }}>Retry</button>
    </div>
  ) : state === 'missing' ? (
    <div role="status" style={{ padding: '8px 0', fontSize: '12.5px', color: 'var(--meta, #71717a)', borderBottom: '1px solid var(--divider-2, #f0f0f1)' }}>This buyer was not found. It may have been archived or merged.</div>
  ) : null;
  const box = normalizeBuyBox(row?.criteria ?? {});
  const markets = row ? (Array.isArray(row.markets) ? (row.markets as string[]).join('; ') : '') : (V.buyerMarkets || []).map((x) => x.m).join('; ');
  const yes = (v: unknown) => (v ? 'yes' : 'no');
  const f = (label: string, el: React.ReactNode) => (
    <div style={rowStyle(m)}><span style={{ color: 'var(--meta, #71717a)' }}>{label}</span><span style={{ minWidth: 0 }}>{el}</span></div>
  );
  const rid = `buyer${id}`;
  return (
    <>
      {banner}
      {f('Type', <InlineField recordId={rid} field="buyer_type" label="Buyer type" type="select" options={TYPES} value={row ? (row.buyer_type as string | null) ?? null : null} format={(v) => TYPES.find((t) => t.value === v)?.label ?? V.B.type ?? ''} readOnly={readOnly} onSave={save('buyer_type')} />)}
      {f('Entity', <InlineField recordId={rid} field="entity_type" label="Entity" type="select" options={ENTITIES} value={row ? (row.entity_type as string | null) ?? null : null} format={(v) => ENTITIES.find((t) => t.value === v)?.label ?? ''} placeholder="Add entity" readOnly={readOnly} onSave={save('entity_type')} />)}
      {f('VIP', <InlineField recordId={rid} field="vip" label="VIP" type="select" options={YES_NO} value={row ? yes(row.vip) : yes(V.B.status === 'VIP')} readOnly={readOnly} onSave={save('vip')} />)}
      {f('Vetted', <InlineField recordId={rid} field="vetted" label="Vetted" type="select" options={YES_NO} value={row ? yes(row.vetted_at) : yes(V.B.status === 'Vetted' || V.B.status === 'VIP')}
        format={(v) => (v === 'yes' && row?.vetted_at ? 'Yes, ' + new Date(String(row.vetted_at)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : v === 'yes' ? 'Yes' : 'No')}
        readOnly={readOnly} onSave={save('vetted')} />)}
      {f('Markets', <InlineField recordId={rid} field="markets" label="Markets, separated by semicolons" type="text" value={markets || null} placeholder="Add markets" readOnly={readOnly} onSave={save('markets')} />)}
      {f('Price min', <InlineField recordId={rid} field="price_min" label="Lowest price they buy at" type="money" value={box.price.min ?? null} placeholder="No minimum" readOnly={readOnly} onSave={save('price_min')} />)}
      {f('Price max', <InlineField recordId={rid} field="price_max" label="Highest price they buy at" type="money" value={box.price.max ?? null} placeholder="No maximum" readOnly={readOnly} onSave={save('price_max')} />)}
      {f('POF link', <InlineField recordId={rid} field="pof_url" label="Proof of funds link" type="text" value={row ? (row.pof_url as string | null) ?? null : null} placeholder="Add a link" readOnly={readOnly} onSave={save('pof_url')} />)}
      {f('Website', <InlineField recordId={rid} field="website" label="Website" type="text" value={row ? (row.website as string | null) ?? null : null} placeholder="Add a website" readOnly={readOnly} onSave={save('website')} />)}
      {f('Notes', <InlineField recordId={rid} field="notes" label="Notes on this buyer" type="textarea" value={row ? (row.notes as string | null) ?? null : null} placeholder="Add notes" readOnly={readOnly} onSave={save('notes')} />)}
      {f('POF verified', <InlineField recordId={rid} field="pof_verified" label="Proof of funds verified" type="select" options={YES_NO} value={row ? yes(row.pof_verified_at) : 'no'} readOnly={readOnly} onSave={save('pof_verified')} />)}
    </>
  );
}

/**
 * The buyer's row, read once per buyer and shared by the head and the rail
 * (a module cache keyed by id), and the save for one field. A save patches
 * the cached row; the lists elsewhere pick it up on their next refresh.
 */
/** What the read came back with when it did not bring a row: no such buyer (or no access), or a failed request. */
type LoadState = 'missing' | 'error';
const cache = new Map<number, Row>();
const status = new Map<number, LoadState>();
const listeners = new Map<number, Set<() => void>>();
const notify = (id: number) => listeners.get(id)?.forEach((fn) => fn());
const publish = (id: number, r: Row) => { cache.set(id, r); status.delete(id); notify(id); };
const inflight = new Set<number>();

/** Read one buyer's row. Always clears its in-flight mark; an empty answer or a failure is remembered, not retried in a loop. */
async function fetchBuyerRow(id: number): Promise<void> {
  if (!supabase || inflight.has(id)) return;
  inflight.add(id);
  status.delete(id);
  notify(id);
  try {
    const { data, error } = await supabase.from('buyers').select('*').eq('id', id).maybeSingle();
    if (error) status.set(id, 'error');
    else if (!data) status.set(id, 'missing');
    else { cache.set(id, data as Row); status.delete(id); }
  } catch {
    status.set(id, 'error');
  } finally {
    inflight.delete(id);
    notify(id);
  }
}

function useBuyerRow(V: ClozrView) {
  const id = V.B.dbId;
  const live = !!V.liveIds?.workspaceId && id != null;
  const row = useSyncExternalStore(
    useCallback((fn: () => void) => {
      if (id == null) return () => {};
      const set = listeners.get(id) ?? new Set();
      set.add(fn);
      listeners.set(id, set);
      return () => { set.delete(fn); };
    }, [id]),
    () => (id != null ? cache.get(id) ?? null : null),
    () => null,
  );
  const state = useSyncExternalStore(
    useCallback((fn: () => void) => {
      if (id == null) return () => {};
      const set = listeners.get(id) ?? new Set();
      set.add(fn);
      listeners.set(id, set);
      return () => { set.delete(fn); };
    }, [id]),
    () => (id != null ? status.get(id) ?? null : null),
    () => null,
  );
  useEffect(() => {
    if (!live || id == null || cache.has(id) || status.has(id)) return;
    void fetchBuyerRow(id);
  }, [id, live]);
  const retry = () => { if (id != null) { status.delete(id); void fetchBuyerRow(id); } };
  // Until the row is read, a save would rebuild the buy box from nothing (a
  // price min would erase the max), so the fields wait for it.
  const readOnly = !live ? null : !V.liveIds?.canWrite ? 'You can view this buyer but not edit it'
    : state === 'missing' ? 'This buyer was not found. It may have been archived or merged'
      : state === 'error' ? 'This buyer could not be read. Retry above'
        : !row ? 'Loading this buyer…' : null;
  const save = (key: BuyerFieldKey) => async (v: InlineValue) => {
    const value = v === 'yes' ? true : v === 'no' ? false : v;
    if (!live || id == null) {
      // Demo: the field keeps what was typed.
      return { ok: true };
    }
    const r = await saveBuyerField(id, key, value, row ?? {});
    if (r.ok) {
      publish(id, { ...(row ?? {}), ...r.row });
      // The one place a buyer field save reaches the lists: patched in place, no re-read.
      if (key === 'name' || key === 'company' || key === 'vip' || key === 'vetted' || key === 'markets') V.patchBuyerLocal(id, { ...(row ?? {}), ...r.row });
    }
    return r;
  };
  return { row, save, readOnly, id: id ?? 'demo', state, retry };
}

/** Read a buyer's row again (after the Buy box dialog saves), for any record showing it. */
export async function refreshBuyerRow(id: number): Promise<void> {
  await fetchBuyerRow(id);
}
