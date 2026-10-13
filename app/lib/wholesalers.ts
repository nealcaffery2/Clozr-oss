// The wholesaler database (migration 192) from the browser: every LLC on an
// assignment in the Dispositions Drive, who sells to whom, and the contract
// harvester that fills it. The rows are read straight from Supabase; the
// harvest runs through the dispo-contracts edge function.

import { type Method, METHOD_TAG } from '../supabase/functions/_shared/genius-methods';
import { entityDisplay, entityKey, familyOf } from '../supabase/functions/_shared/genius-methods';
import { createBuyer } from './crm-write';
import { emptyBuyBox } from './buyer-profile';
import { supabase } from './supabase';

type Res<T> = { ok: true; data: T } | { ok: false; message: string };
const NO_DB = { ok: false as const, message: 'Supabase is not configured.' };

export type EntityKind = 'wholesaler' | 'buyer' | 'both' | 'title' | 'unknown';
export type Entity = {
  id: number; name: string; name_key: string; parent_id: number | null; kind: EntityKind; state: string | null; county: string | null;
  contact_name: string | null; email: string | null; phone: string | null; website: string | null; source: string;
  first_seen: string | null; last_seen: string | null; deals: number; buyer_id: number | null; vendor_id: number | null; notes: string | null;
};
export type WholesalerDeal = {
  id: number; assignor_id: number | null; assignee_id: number | null; assignor_name: string | null; assignee_name: string | null;
  assignee_person: string | null; assignee_email: string | null; assignee_phone: string | null; assignor_person: string | null; assignor_email: string | null; assignor_phone: string | null;
  property_address: string | null; city: string | null; state: string | null; zip: string | null; county: string | null;
  purchase_price: number | null; assignment_fee: number | null; total_price: number | null; contract_date: string | null; closing_date: string | null;
  title_company: string | null; leg: 'AB' | 'BC' | 'AA' | 'deed' | 'unknown'; source: 'drive' | 'deed' | 'manual'; source_url: string | null; deal_id: number | null;
};
export type TopBuyer = { wholesaler_id: number; buyer_id: number; deals: number; last_deal: string | null; volume: number | null; states: string[] | null; counties: string[] | null };

export type WholesalerBook = { entities: Entity[]; deals: WholesalerDeal[]; top: TopBuyer[] };

export async function loadWholesalers(workspaceId: number): Promise<Res<WholesalerBook>> {
  if (!supabase) return NO_DB;
  const [e, d, t] = await Promise.all([
    supabase.from('wholesaler_entities').select('*').eq('workspace_id', workspaceId).order('deals', { ascending: false }).order('name').limit(5000),
    supabase.from('wholesaler_deals').select('*').eq('workspace_id', workspaceId).order('closing_date', { ascending: false, nullsFirst: false }).limit(5000),
    supabase.from('wholesaler_top_buyers').select('*').eq('workspace_id', workspaceId).limit(5000),
  ]);
  const err = e.error ?? d.error ?? t.error;
  if (err) return { ok: false, message: /wholesaler_/.test(err.message) ? 'The wholesaler database is not applied yet (migration 192).' : err.message };
  return { ok: true, data: { entities: (e.data ?? []) as Entity[], deals: (d.data ?? []) as WholesalerDeal[], top: (t.data ?? []) as TopBuyer[] } };
}

/** The family an entity belongs to: its parent row, else itself. */
export const rootOf = (e: Entity, byId: Map<number, Entity>) => (e.parent_id ? byId.get(e.parent_id) ?? e : e);

export type Family = { root: Entity; aliases: Entity[]; deals: number; buyers: { entity: Entity; deals: number; last_deal: string | null; volume: number | null }[]; states: string[] };

/** Wholesalers grouped by family, most deals first, each with its aliases and who it sells to. */
export function families(book: WholesalerBook): Family[] {
  const byId = new Map(book.entities.map((e) => [e.id, e]));
  const groups = new Map<number, Family>();
  for (const e of book.entities) {
    const r = rootOf(e, byId);
    const g = groups.get(r.id) ?? { root: r, aliases: [], deals: 0, buyers: [], states: [] };
    if (e.id !== r.id) g.aliases.push(e);
    groups.set(r.id, g);
  }
  for (const t of book.top) {
    const g = groups.get(t.wholesaler_id); const b = byId.get(t.buyer_id);
    if (!g || !b) continue;
    g.buyers.push({ entity: b, deals: t.deals, last_deal: t.last_deal, volume: t.volume });
    for (const s of t.states ?? []) if (!g.states.includes(s)) g.states.push(s);
  }
  for (const d of book.deals) {
    const a = d.assignor_id ? byId.get(d.assignor_id) : null;
    if (!a) continue;
    const g = groups.get(rootOf(a, byId).id);
    if (g) { g.deals++; if (d.state && !g.states.includes(d.state)) g.states.push(d.state); }
  }
  const out = [...groups.values()].filter((g) => g.deals > 0 || g.root.kind === 'wholesaler' || g.root.kind === 'both' || g.aliases.length > 0);
  for (const g of out) g.buyers.sort((x, y) => y.deals - x.deals || String(y.last_deal ?? '').localeCompare(String(x.last_deal ?? '')));
  return out.sort((x, y) => y.deals - x.deals || x.root.name.localeCompare(y.root.name));
}

/** The end buyers we have signed with (BC legs), most deals first, with the contact off the contract. */
export function contractBuyers(book: WholesalerBook): { entity: Entity; deals: WholesalerDeal[]; wholesalers: string[] }[] {
  const byId = new Map(book.entities.map((e) => [e.id, e]));
  const groups = new Map<number, { entity: Entity; deals: WholesalerDeal[]; wholesalers: string[] }>();
  for (const d of book.deals) {
    if (!d.assignee_id || !(d.leg === 'BC' || d.leg === 'deed')) continue;
    const b = byId.get(d.assignee_id);
    if (!b) continue;
    const g = groups.get(b.id) ?? { entity: b, deals: [], wholesalers: [] };
    g.deals.push(d);
    const w = d.assignor_id ? byId.get(d.assignor_id) : null;
    const wn = w ? rootOf(w, byId).name : d.assignor_name ?? '';
    if (wn && !g.wholesalers.includes(wn)) g.wholesalers.push(wn);
    groups.set(b.id, g);
  }
  return [...groups.values()].sort((x, y) => y.deals.length - x.deals.length);
}

// ---- edits ----------------------------------------------------------------------------
export async function addEntity(workspaceId: number, input: { name: string; kind: EntityKind; state?: string | null; parent_id?: number | null; contact_name?: string | null; email?: string | null; phone?: string | null; notes?: string | null }): Promise<Res<number>> {
  if (!supabase) return NO_DB;
  const name = entityDisplay(input.name);
  const key = entityKey(name);
  if (!key) return { ok: false, message: 'Type the company name.' };
  let parent = input.parent_id ?? null;
  const fam = familyOf(name);
  if (!parent && fam && entityKey(fam) !== key) {
    const { data } = await supabase.from('wholesaler_entities').upsert({ workspace_id: workspaceId, name: fam, name_key: entityKey(fam), kind: 'wholesaler', source: 'manual' } as never, { onConflict: 'workspace_id,name_key' }).select('id').maybeSingle();
    parent = (data as { id: number } | null)?.id ?? null;
  }
  const { data, error } = await supabase.from('wholesaler_entities').upsert({
    workspace_id: workspaceId, name, name_key: key, kind: input.kind, state: input.state?.toUpperCase() || null, parent_id: parent, source: 'manual',
    contact_name: input.contact_name || null, email: input.email?.toLowerCase() || null, phone: input.phone || null, notes: input.notes || null,
  } as never, { onConflict: 'workspace_id,name_key' }).select('id').maybeSingle();
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: (data as { id: number } | null)?.id ?? 0 };
}

export async function setParent(entityId: number, parentId: number | null): Promise<Res<null>> {
  if (!supabase) return NO_DB;
  const { error } = await supabase.from('wholesaler_entities').update({ parent_id: parentId } as never).eq('id', entityId);
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

export async function setKind(entityId: number, kind: EntityKind): Promise<Res<null>> {
  if (!supabase) return NO_DB;
  const { error } = await supabase.from('wholesaler_entities').update({ kind } as never).eq('id', entityId);
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

/**
 * A buyer entity from a contract into the buyer list as a Prospect, labelled
 * `contract`, with the person, email and phone the signature block gave.
 * Already-known buyers (same email or phone) come back with their id.
 */
export async function entityToBuyer(workspaceId: number, e: Entity, deals: WholesalerDeal[], userId: string | null): Promise<Res<number>> {
  if (!supabase) return NO_DB;
  if (e.buyer_id) return { ok: true, data: e.buyer_id };
  const mine = deals.filter((d) => d.assignee_id === e.id);
  const box = emptyBuyBox();
  const cities = Array.from(new Set(mine.map((d) => d.city).filter((c): c is string => !!c)));
  const state = mine.find((d) => d.state)?.state ?? e.state ?? undefined;
  box.location_prefs = cities.map((name) => ({ name, type: 'city' as const, state }));
  const prices = mine.map((d) => d.total_price ?? d.purchase_price).filter((p): p is number => !!p);
  if (prices.length) box.price = { min: Math.round(Math.min(...prices) * 0.7), max: Math.round(Math.max(...prices) * 1.3) };
  box.strategies = ['fix_and_flip'];
  const who = Array.from(new Set(mine.map((d) => d.assignor_name).filter(Boolean)));
  box.notes = `Found by Contract: bought ${mine.length} deal${mine.length === 1 ? '' : 's'} by assignment${who.length ? ` from ${who.slice(0, 3).join(', ')}` : ''}${mine[0]?.property_address ? `, last ${mine[0].property_address}${mine[0].city ? `, ${mine[0].city}` : ''}` : ''}.`;
  const person = e.contact_name ?? mine.find((d) => d.assignee_person)?.assignee_person ?? null;
  const email = e.email ?? mine.find((d) => d.assignee_email)?.assignee_email ?? null;
  const phone = e.phone ?? mine.find((d) => d.assignee_phone)?.assignee_phone ?? null;
  const entity = /\b(llc|inc|corp|lp|llp|ltd|pllc|trust|holdings)\b/i.test(e.name);
  const method: Method = 'contract';
  const r = await createBuyer(workspaceId, {
    name: person ?? e.name, company: entity ? e.name : null, phone, email,
    buyer_type: 'flipper', entity_type: entity ? 'llc' : 'individual',
    tags: ['buyer-prospect', METHOD_TAG[method], 'genius'], source: 'genius', status: 'Prospect', criteria: box,
  }, userId);
  const id = r.id ?? null;
  if (!id) return { ok: false, message: r.message ?? 'Could not add that buyer.' };
  await supabase.from('buyers').update({ found_via: method, found_evidence: { methods: [method], evidence: [{ method, summary: box.notes }] } } as never).eq('id', id);
  await supabase.from('wholesaler_entities').update({ buyer_id: id } as never).eq('id', e.id);
  return { ok: true, data: id };
}

// ---- the harvester ----------------------------------------------------------------------
export type HarvestStatus = {
  config: { folder: string; root_name: string | null; enabled: boolean; last_run_at: string | null; last_error: string | null; last_notes: Record<string, unknown> | null; files_seen: number; contracts_read: number; queued: number; done_at: string | null } | null;
  drive_connected: boolean; email: string | null; entities: number; deals: number; buyers: number; default_folder: string;
};

async function invoke<T>(body: Record<string, unknown>): Promise<Res<T>> {
  if (!supabase) return NO_DB;
  const { data, error } = await supabase.functions.invoke('dispo-contracts', { body });
  if (error) {
    let message = error.message;
    try { const ctx = (error as { context?: Response }).context; if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message; } catch { /* keep */ }
    return { ok: false, message };
  }
  const payload = data as { error?: string } & T;
  if (payload?.error) return { ok: false, message: payload.error };
  return { ok: true, data: payload };
}

export const harvestStatus = (workspaceId: number) => invoke<HarvestStatus>({ workspace_id: workspaceId, action: 'status' });
export const harvestRun = (workspaceId: number) => invoke<{ filed: number; read: number; files: number; folders: number; skipped: number; errors: number; queued: number; done: boolean; error: string | null; notes: string[] }>({ workspace_id: workspaceId, action: 'run' });
export const harvestSave = (workspaceId: number, folder: string) => invoke<{ folder: string; root_name: string | null }>({ workspace_id: workspaceId, action: 'save', folder });
