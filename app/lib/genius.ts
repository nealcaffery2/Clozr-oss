// Genius Mode v2, the browser side: every cash buyer already buying around an
// address, streamed in from the `genius-discover` edge function.
//
// The rules (who counts as a flipper, how a buyer is scored) live in
// supabase/functions/_shared/genius-core.ts and run on the server; this file
// shares its types, reads the run as it streams, reopens saved runs straight
// from `discover_runs` (no RealEstateAPI call), and does the arithmetic the
// Analytics tab and Investor Comps need over a run already in hand.

import { addBuyerEmail } from './buyer-contacts';
import type { Filters, FoundVia, Kind, Purchase, SkipHit, SkipPhone, Strategy, Subject } from '../supabase/functions/_shared/genius-core';
import { tracePurchaseStub } from '../supabase/functions/_shared/genius-core';
import { type Evidence, type Labelled, type Method, METHOD_BLURB, METHOD_LABEL, METHOD_TAG, RUN_METHODS, headline, isMethod } from '../supabase/functions/_shared/genius-methods';
import { emptyBuyBox } from './buyer-profile';
import { createBuyer, tagBuyers } from './crm-write';
import { SKIPTRACE_TAG } from './data-runs';
import type { WriteResult } from './crm-write';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, supabase } from './supabase';
import { guardedFetch } from './read-only';

export type { Evidence, Filters, FoundVia, Kind, Method, Purchase, SkipHit, SkipPhone, Strategy, Subject };
export { METHOD_BLURB, METHOD_LABEL, RUN_METHODS, headline };
/** A found buyer, with the method that found them and its proof when a method ran (genius-methods.ts). */
export type Candidate = Labelled;

/** The label on a result: Buyr, Facebook, Homefull, or Genius. */
export function foundLabel(f: { found_via?: string | null; homefull?: boolean } | null | undefined): string {
  const v = f?.found_via;
  if (v === 'buyr') return 'Buyr';
  if (v === 'facebook') return 'Facebook';
  if (v === 'homefull') return 'Homefull';
  if (v === 'genius') return 'Genius';
  if (isMethod(v)) return METHOD_LABEL[v];
  if (f?.homefull) return 'Homefull';
  return 'Genius';
}

/** The method that found a buyer, for the label on the row: the strongest proof, else the run's found_via. */
export function methodOf(c: Candidate, via?: FoundVia | null): Method {
  const h = headline(c);
  if (h) return h.method;
  if (via === 'buyr' || via === 'facebook' || via === 'homefull') return via;
  return 'genius';
}

export type PhoneMark = 'good' | 'wrong';
export type MarkedPhone = SkipPhone & { status?: PhoneMark };

export const KIND_LABEL: Record<Kind, string> = { flipper: 'Flipper', landlord: 'Landlord', builder: 'Builder' };
export const KIND_PLURAL: Record<Kind, string> = { flipper: 'Flippers', landlord: 'Landlords', builder: 'Builders' };
export const KIND_COLOR: Record<Kind, string> = { flipper: '#ea580c', landlord: '#2563eb', builder: '#0d9488' };
/** Text badges for the same types: a dark shade on a pale tint, because white on the pin colour fails contrast (3.6:1 on orange). */
export const KIND_BADGE: Record<Kind, { color: string; tint: string }> = { flipper: { color: '#9a3412', tint: '#ffedd5' }, landlord: { color: '#1d4ed8', tint: '#dbeafe' }, builder: { color: '#0f766e', tint: '#ccfbf1' } };
export const STRATEGY_LABEL: Record<Strategy, string> = { any: 'Any exit', flip: 'Fix & flip', rental: 'Buy & hold', build: 'New build' };

/** What a run searches with. Everything is optional; the server clamps and fills defaults. */
export type RunFilters = {
  radius_mi: number; months: number; kinds: Kind[]; property_types: string[]; strategy: Strategy; asking_price: number | null;
  include_non_arms_length: boolean; include_institutional: boolean; flip_months: number;
  beds_min: number | null; beds_max: number | null; baths_min: number | null; baths_max: number | null;
  price_min: number | null; price_max: number | null; min_portfolio: number;
  homefull: boolean;
  found_via: FoundVia | null;
  /** The discovery methods to run after the base search (genius-methods.ts). */
  methods: Method[];
};
export const DEFAULT_FILTERS: RunFilters = {
  radius_mi: 2, months: 24, kinds: ['flipper', 'landlord'], property_types: ['SFR'], strategy: 'any', asking_price: null,
  include_non_arms_length: false, include_institutional: false, flip_months: 18,
  beds_min: null, beds_max: null, baths_min: null, baths_max: null, price_min: null, price_max: null, min_portfolio: 0,
  homefull: false, found_via: null, methods: [],
};

/** Where a run centres: one of the workspace's deals, or an address typed on the Genius page. */
export type Target =
  | { deal_id: number }
  | { address: string; city?: string | null; state?: string | null; zip?: string | null; reapi_id?: string | null; arv?: number | null };

export type Suggestion = { title: string; address: string; city: string | null; state: string | null; zip: string | null; reapi_id: string | null; lat: number | null; lng: number | null };
export type PlanCount = { label: string; count: number };
export type Estimate = { subject: Subject; total: number; plans: PlanCount[]; est_credits: number; ceiling: number };

export type RunEvent =
  | { type: 'subject'; subject: Subject }
  | { type: 'scan_count'; total: number; plans: PlanCount[]; ceiling: number }
  | { type: 'progress'; stage: 'search' | 'enrich' | 'skiptrace' | 'attom' | 'attom_owners' | 'homefull' | 'snipe' | 'deeds'; done: number; total: number }
  /** The method passes: how many buyers each labelled or added, and what a method could not do (no deed index, no photos). */
  | { type: 'methods'; methods: Method[]; counts: Record<string, number>; notes: string[] }
  /** Compare mode: how RealEstateAPI and ATTOM overlapped, by property. `error` when ATTOM could not run. */
  | { type: 'compare'; reapi_properties?: number; attom_sales?: number; attom_with_owner?: number; both?: number; attom_only?: number; reapi_only?: number; attom_calls?: number; note?: string; error?: string }
  | { type: 'buyers'; candidates: Candidate[]; properties_scanned: number; partial: boolean }
  | { type: 'done'; run_id: number | null; credits: Record<string, number>; truncated: boolean; properties_scanned: number; sales_scanned: number }
  | { type: 'error'; error: string; run_id?: number | null };

export type Run = {
  run_id: number | null; deal_id: number | null; subject: Subject; filters: Partial<RunFilters>; candidates: Candidate[];
  sales_scanned: number; properties_scanned: number | null; credits: Record<string, number>; created_at: string | null; status: string;
};

export type PastRun = { id: number; address: string | null; deal_id: number | null; buyer_count: number | null; top_score: number | null; created_at: string; status: string; radius_mi: number; months: number; filters: Partial<RunFilters> | null };

type Res<T> = { ok: true; data: T } | { ok: false; message: string };

async function call<T>(body: Record<string, unknown>): Promise<Res<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('genius-discover', { body });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  return { ok: true, data: data as T };
}

export const autocomplete = (workspaceId: number, q: string) =>
  call<{ results: Suggestion[] }>({ workspace_id: workspaceId, action: 'autocomplete', q });

export const estimate = (workspaceId: number, target: Target, f: RunFilters) =>
  call<Estimate>({ workspace_id: workspaceId, action: 'estimate', ...target, ...f });

export const portfolio = (workspaceId: number, reapiId: string) =>
  call<{ total: number | null; value: number | null; properties: { reapi_id: string; address: string; city: string; state: string; zip: string; lat: number | null; lng: number | null; property_type: string | null; beds: number | null; baths: number | null; sqft: number | null; est_value: number | null; last_sale_date: string | null; last_sale_amount: number | null }[] }>(
    { workspace_id: workspaceId, action: 'portfolio', reapi_id: reapiId });

/** Bulk skip trace. Cached owners come back free; the run on file is updated so a reopen shows the phones. */
export const skipTrace = (workspaceId: number, cands: Candidate[], runId: number | null) =>
  call<{ results: Record<string, { hits: SkipHit[]; cached: boolean; at: string } | { error: string }>; credits: Record<string, number> }>({
    workspace_id: workspaceId, action: 'skiptrace', run_id: runId,
    targets: cands.slice(0, 100).map((c) => ({ key: c.key, owner_name: c.owner_name, corporate: c.corporate, people: c.people, mail_parts: c.mail_parts, mailing: c.mailing, purchases: c.purchases.slice(0, 3) })),
  });

/** A CRM record to trace: a seller at their property, a buyer at a mailing or purchase address. */
export type TraceTarget = {
  key: string; owner_name: string; corporate: boolean; people: string[];
  mail_parts: { address: string; city: string; state: string; zip: string } | null; mailing: string | null;
};

/** The same skip trace for records that are not Genius candidates (People and Buyers bulk action). */
export const skipTraceTargets = (workspaceId: number, targets: TraceTarget[]) =>
  call<{ results: Record<string, { hits: SkipHit[]; cached: boolean; at: string } | { error: string }>; credits: Record<string, number> }>({
    workspace_id: workspaceId, action: 'skiptrace',
    targets: targets.slice(0, 100).map((t) => ({
      ...t,
      purchases: t.mail_parts ? [tracePurchaseStub(t.mail_parts)] : [],
    })),
  });

/**
 * A full run, read as it streams: onEvent fires for every line the function
 * writes, so the subject shows first, then the count, progress and buyers.
 * Resolves once the stream ends; an error before streaming (no key, a bad
 * address, the monthly cap) comes back as ok:false.
 */
export async function discover(workspaceId: number, target: Target, f: RunFilters, opts: { skipTrace: boolean; compare?: boolean }, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<Res<null>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { ok: false, message: 'Sign in again to run Genius Mode.' };
  let res: Response;
  try {
    // Raw fetch for the stream, so it takes the client's read-only guard by hand.
    res = await guardedFetch(`${SUPABASE_URL}/functions/v1/genius-discover`, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId, action: 'discover', ...target, ...f, skip_trace: opts.skipTrace, ...(opts.compare ? { compare: true } : {}) }),
    });
  } catch (e) {
    return { ok: false, message: (e as Error).name === 'AbortError' ? 'Stopped.' : 'Could not reach Genius Mode. Check the connection and try again.' };
  }
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('ndjson') || !res.body) {
    let message = `Genius Mode answered ${res.status}.`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* keep */ }
    return { ok: false, message };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let failed: string | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as RunEvent;
          if (ev.type === 'error') failed = ev.error;
          onEvent(ev);
        } catch { /* a torn line; the next buyers event carries the whole list */ }
      }
    }
  } catch (e) {
    return { ok: false, message: (e as Error).name === 'AbortError' ? 'Stopped.' : 'The connection dropped mid-run. Reopen it from Past searches, or run it again.' };
  }
  return failed ? { ok: false, message: failed } : { ok: true, data: null };
}

// ---- saved runs ----------------------------------------------------------------------

/** Fill the fields a v1 run did not have, so an old saved run still renders. */
export function normalizeCandidate(c: Partial<Candidate> & { kind?: string }): Candidate {
  const purchases: Purchase[] = ((c.purchases ?? []) as Partial<Purchase>[]).map((p) => {
    const dflt: Partial<Purchase> = {
      reapi_id: '', role: 'hold', lat: null, lng: null, property_type: null, price_source: p.price ? 'recorded' : null,
      non_disclosure: !p.price, resale_price: null, resale_date: null, days_held: null, financed: null, est_value: null,
      pct_of_arv: null, price_per_sqft: p.price && p.sqft ? Math.round(p.price / p.sqft) : null, agent: null, zillow: '',
    };
    return { ...dflt, ...p } as Purchase;
  });
  const kind: Kind = c.kind === 'flipper' || c.kind === 'landlord' || c.kind === 'builder' ? c.kind : 'landlord';
  return {
    key: c.key ?? Math.random().toString(36).slice(2), owner_name: c.owner_name ?? 'Unknown owner', people: c.people ?? [],
    kind, corporate: !!c.corporate, institutional: !!c.institutional, absentee: c.absentee ?? null, mailing: c.mailing ?? null, mail_parts: c.mail_parts ?? null,
    purchases, purchase_count: c.purchase_count ?? purchases.length, flips: c.flips ?? 0, holds: c.holds ?? purchases.length, builds: c.builds ?? 0,
    last_purchase: c.last_purchase ?? null, nearest_mi: c.nearest_mi ?? null, lat: c.lat ?? purchases[0]?.lat ?? null, lng: c.lng ?? purchases[0]?.lng ?? null,
    avg_price: c.avg_price ?? null, min_price: c.min_price ?? null, max_price: c.max_price ?? null, avg_ppsf: c.avg_ppsf ?? null, avg_days_held: c.avg_days_held ?? null,
    cash: c.cash ?? null, non_disclosure: !!c.non_disclosure, portfolio_count: c.portfolio_count ?? null, portfolio_value: c.portfolio_value ?? null,
    likelihood: c.likelihood ?? 0, smart_match: !!c.smart_match, smart_rank: c.smart_rank ?? null,
    pct_of_arv: c.pct_of_arv != null && c.pct_of_arv >= 15 && c.pct_of_arv <= 200 ? c.pct_of_arv : null,
    reasons: c.reasons ?? [], matched_buyer_id: c.matched_buyer_id ?? null, match_by: c.match_by ?? null,
    contacts: c.contacts ?? null, contacts_at: c.contacts_at ?? null,
    ...(c.method ? { method: c.method } : {}), ...(c.methods ? { methods: c.methods } : {}), ...(c.evidence ? { evidence: c.evidence } : {}),
  };
}

const PAST_COLS = 'id, address, deal_id, buyer_count, top_score, created_at, status, radius_mi, months, filters';

function asPast(rows: unknown): PastRun[] {
  return ((rows ?? []) as (Omit<PastRun, 'filters'> & { filters?: Partial<RunFilters> | null })[]).map((row) => ({ ...row, filters: row.filters ?? null }));
}

export async function pastRuns(workspaceId: number, dealId?: number | null): Promise<PastRun[]> {
  if (!supabase) return [];
  let q = supabase.from('discover_runs').select(PAST_COLS)
    .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(40);
  if (dealId) q = q.eq('deal_id', dealId);
  const { data } = await q;
  return asPast(data);
}

/**
 * Every saved Genius run for one dispo house: this deal's runs, and searches
 * of the same street started from the Genius page (those have no deal id).
 */
export async function propertyRuns(workspaceId: number, dealId: number, address: string | null): Promise<PastRun[]> {
  if (!supabase) return [];
  const hint = streetKey(address).split(' ').slice(0, 2).join(' ');
  const recent = supabase.from('discover_runs').select(PAST_COLS).eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(120);
  const byStreet = hint.length >= 5
    ? supabase.from('discover_runs').select(PAST_COLS).eq('workspace_id', workspaceId).ilike('address', `%${hint.replace(/[%_]/g, '')}%`).order('created_at', { ascending: false }).limit(40)
    : Promise.resolve({ data: [] as unknown[] });
  const [a, b] = await Promise.all([recent, byStreet]);
  const rows = asPast([...(a.data ?? []), ...(b.data ?? [])]);
  rows.sort((x, y) => y.created_at.localeCompare(x.created_at));
  return matchPropertyRuns(rows, dealId, address);
}

/** The newest finished run for this house, deal-linked or an older address search. */
export async function lastPropertyRun(workspaceId: number, dealId: number, address: string | null): Promise<Run | null> {
  const past = await propertyRuns(workspaceId, dealId, address);
  const row = past.find((p) => p.status !== 'running') ?? past[0];
  return row ? loadRun(workspaceId, row.id) : null;
}

/** Deal ids that already have a saved run from this source inside the window. Buyr uses this so a visit does not search the same house twice. */
export async function dealsSyncedVia(workspaceId: number, via: FoundVia, withinDays = 14): Promise<Set<number>> {
  if (!supabase) return new Set();
  const since = new Date(Date.now() - withinDays * 86_400_000).toISOString();
  const { data } = await supabase.from('discover_runs').select('deal_id, filters')
    .eq('workspace_id', workspaceId).gte('created_at', since).not('deal_id', 'is', null).limit(400);
  const ids = new Set<number>();
  for (const row of (data ?? []) as { deal_id: number | null; filters: { found_via?: string } | null }[]) {
    if (row.deal_id && row.filters?.found_via === via) ids.add(row.deal_id);
  }
  return ids;
}

/** A saved run, read from the table. Zero RealEstateAPI calls — this is the "reopen for free" path. */
export async function loadRun(workspaceId: number, runId: number): Promise<Run | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('discover_runs').select('*').eq('workspace_id', workspaceId).eq('id', runId).maybeSingle();
  return data ? toRun(data) : null;
}

/** The latest finished run for a deal, so the deal's Genius tab opens on it. */
export async function lastRun(workspaceId: number, dealId: number): Promise<Run | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('discover_runs').select('*').eq('workspace_id', workspaceId).eq('deal_id', dealId).neq('status', 'running')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data ? toRun(data) : null;
}

function toRun(d: { id: number; deal_id: number | null; subject: unknown; filters?: unknown; candidates: unknown; sales_scanned: number; properties_scanned?: number | null; credits?: unknown; created_at: string; status?: string; radius_mi: number; months: number; kinds: string[] | null }): Run {
  const filters = (d.filters && Object.keys(d.filters as object).length ? d.filters : { radius_mi: Number(d.radius_mi), months: d.months, kinds: d.kinds ?? undefined }) as Partial<RunFilters>;
  return {
    run_id: d.id, deal_id: d.deal_id, subject: d.subject as Subject, filters,
    candidates: ((d.candidates ?? []) as Partial<Candidate>[]).map(normalizeCandidate),
    sales_scanned: d.sales_scanned, properties_scanned: d.properties_scanned ?? null, credits: (d.credits ?? {}) as Record<string, number>,
    created_at: d.created_at, status: d.status ?? 'done',
  };
}

/** Write the candidates back onto the saved run (added to buyers, phones found), so a reopen shows them. */
export async function saveCandidates(workspaceId: number, runId: number | null, cands: Candidate[]) {
  if (!supabase || !runId) return;
  await supabase.from('discover_runs').update({ candidates: cands as never }).eq('id', runId).eq('workspace_id', workspaceId);
}

/** The workspace's deals, for "Pick a deal" on the Genius page. */
export async function dealOptions(workspaceId: number): Promise<{ id: number; label: string; address: string; city: string | null; state: string | null; zip: string | null; arv: number | null; price: number | null; lat: number | null; lng: number | null }[]> {
  if (!supabase) return [];
  const { data: deals } = await supabase.from('deals').select('id, arv, asking_price, marketed_price, property_id, seller_id, stage')
    .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(200);
  const rows = (deals ?? []) as { id: number; arv: number | null; asking_price: number | null; marketed_price: number | null; property_id: number | null; seller_id: number | null; stage: string | null }[];
  const ids = rows.map((d) => d.property_id).filter((x): x is number => !!x);
  const { data: props } = ids.length ? await supabase.from('properties').select('id, line1, city, state, zip, lat, lng').in('id', ids) : { data: [] };
  const byId = new Map(((props ?? []) as { id: number; line1: string | null; city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null }[]).map((p) => [p.id, p]));
  return rows.flatMap((d) => {
    const p = d.property_id ? byId.get(d.property_id) : null;
    if (!p?.line1) return [];
    return [{ id: d.id, label: `${p.line1}${p.city ? `, ${p.city}` : ''}${d.stage ? ` · ${d.stage}` : ''}`, address: p.line1, city: p.city, state: p.state, zip: p.zip, arv: d.arv, price: d.marketed_price ?? d.asking_price, lat: Number(p.lat) || null, lng: Number(p.lng) || null }];
  });
}

/**
 * Where a deal's house sits, so the Genius tab opens on a map of it before any
 * search has run. Read from the property row (the deal's, else its seller's);
 * null until something has geocoded it — the first search does.
 */
export async function dealCenter(workspaceId: number, dealId: number): Promise<{ lat: number; lng: number } | null> {
  if (!supabase) return null;
  const { data: deal } = await supabase.from('deals').select('property_id, seller_id').eq('workspace_id', workspaceId).eq('id', dealId).maybeSingle();
  let propId = (deal as { property_id: number | null } | null)?.property_id ?? null;
  const sellerId = (deal as { seller_id: number | null } | null)?.seller_id ?? null;
  if (!propId && sellerId) {
    const { data: s } = await supabase.from('sellers').select('property_id').eq('id', sellerId).maybeSingle();
    propId = (s as { property_id: number | null } | null)?.property_id ?? null;
  }
  if (!propId) return null;
  const { data: p } = await supabase.from('properties').select('lat, lng').eq('id', propId).maybeSingle();
  const lat = Number((p as { lat: unknown } | null)?.lat); const lng = Number((p as { lng: unknown } | null)?.lng);
  return lat && lng ? { lat, lng } : null;
}

/** Keep a phone's good / wrong mark on the saved run, and on the buyer's own numbers when they are in the list. */
export async function markPhone(workspaceId: number, runId: number | null, cands: Candidate[], key: string, number: string, mark: PhoneMark): Promise<Candidate[]> {
  const next = cands.map((c) => (c.key !== key ? c : {
    ...c, contacts: (c.contacts ?? []).map((h) => ({ ...h, phones: h.phones.map((p) => (p.number === number ? { ...p, status: mark } : p)) })),
  }));
  if (!supabase) return next;
  if (runId) await supabase.from('discover_runs').update({ candidates: next as never }).eq('id', runId).eq('workspace_id', workspaceId);
  const c = next.find((x) => x.key === key);
  if (c?.matched_buyer_id) {
    const pk = number.replace(/\D+/g, '').slice(-10);
    const { data: row } = await supabase.from('buyer_phones').select('id').eq('workspace_id', workspaceId).eq('buyer_id', c.matched_buyer_id).eq('phone_key', pk).maybeSingle();
    if (mark === 'wrong' && row) await supabase.from('buyer_phones').update({ is_verified: false, kind: 'wrong' }).eq('id', row.id);
    else if (mark === 'good' && row) await supabase.from('buyer_phones').update({ is_verified: true }).eq('id', row.id);
    else if (mark === 'good') await supabase.from('buyer_phones').insert({ workspace_id: workspaceId, buyer_id: c.matched_buyer_id, phone: number, source: 'genius', is_verified: true });
  }
  return next;
}

/** Add a number by hand to a found buyer. */
export function addPhone(cands: Candidate[], key: string, number: string): Candidate[] {
  return cands.map((c) => (c.key !== key ? c : {
    ...c, contacts: [{ name: c.people[0] ?? null, phones: [{ number, type: 'manual', dnc: false, score: null, status: 'good' } as MarkedPhone], emails: [], mailing: null }, ...(c.contacts ?? [])],
  }));
}

// ---- contacts ------------------------------------------------------------------------------

/** Every usable number: DNC and wrong numbers last, and never offered for bulk text or auto-dial. */
export function phonesOf(c: Candidate): (MarkedPhone & { person: string | null })[] {
  const seen = new Set<string>();
  const out: (MarkedPhone & { person: string | null })[] = [];
  for (const h of c.contacts ?? []) for (const p of h.phones as MarkedPhone[]) {
    const k = p.number.replace(/\D+/g, '');
    if (seen.has(k)) continue;
    seen.add(k); out.push({ ...p, person: h.name });
  }
  const rank = (p: MarkedPhone) => (p.status === 'wrong' ? 3 : p.dnc ? 2 : p.status === 'good' ? 0 : /wireless|mobile|cell/i.test(p.type ?? '') ? 0.5 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}
export const bestPhone = (c: Candidate) => phonesOf(c).find((p) => !p.dnc && p.status !== 'wrong')?.number ?? null;
export const emailsOf = (c: Candidate) => Array.from(new Set((c.contacts ?? []).flatMap((h) => h.emails)));

/**
 * A skip trace that came back with someone to reach. `contacts: null` has not
 * been traced. An empty hit list was traced and found nothing — those owners
 * are not added to buyers.
 */
export function hasSkipTraceContact(c: Candidate): boolean {
  if (!c.contacts) return false;
  const phone = phonesOf(c).some((p) => p.status !== 'wrong' && p.number.replace(/\D/g, '').length >= 10);
  return phone || emailsOf(c).length > 0;
}

const STREET_SUFFIX = /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|place|pl|circle|cir|trail|trl|parkway|pkwy)\b/g;

/** Street line only, so "344 Copper Ridge Lane" and "344 Copper Ridge Ln, Dallas" are one house. */
export function streetKey(raw: string | null | undefined): string {
  const first = String(raw ?? '').split(',')[0] ?? '';
  return first.toLowerCase().replace(/[.#]/g, ' ').replace(STREET_SUFFIX, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when two address strings are the same house. A blank or a house number alone is never a match. */
export function samePropertyAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = streetKey(a);
  const kb = streetKey(b);
  if (!ka || !kb || !/\d/.test(ka) || ka.length < 6) return false;
  return ka === kb;
}

/** Runs saved on this deal, or earlier searches of the same street from the Genius page. */
export function matchPropertyRuns<T extends { id: number; deal_id: number | null; address: string | null }>(
  rows: T[], dealId: number, address: string | null,
): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    if (r.deal_id === dealId || samePropertyAddress(r.address, address)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

const phoneDigits = (n: string | null | undefined) => String(n ?? '').replace(/\D+/g, '').slice(-10);

export type TraceWrite = {
  /** Best dialable number, written onto buyers.phone only when that column is empty. */
  phone: string | null;
  /** First email, written onto buyers.email only when that column is empty. */
  email: string | null;
  /** Numbers the buyer does not already have. */
  insert: { phone: string; kind: string | null; dnc: boolean; verified: boolean }[];
};

/**
 * What a skip trace should write onto a buyer who is already in the CRM.
 * Re-adding a found owner used to stop at "already in buyers" and leave the
 * phones on the Genius card. Wrong numbers and duplicates are left out.
 */
export function traceWrites(c: Candidate, existing: { phone: string | null; email: string | null; phoneKeys: string[] }): TraceWrite {
  const phones = phonesOf(c).filter((p) => p.status !== 'wrong' && phoneDigits(p.number).length >= 10);
  const have = new Set(existing.phoneKeys.map(phoneDigits).filter((k) => k.length >= 10));
  const insert: TraceWrite['insert'] = [];
  for (const p of phones) {
    const k = phoneDigits(p.number);
    if (have.has(k)) continue;
    have.add(k);
    insert.push({ phone: p.number, kind: p.type ?? null, dnc: !!p.dnc, verified: p.status === 'good' });
    if (insert.length >= 6) break;
  }
  const email = emailsOf(c)[0] ?? null;
  return {
    phone: existing.phone ? null : (phones.find((p) => !p.dnc)?.number ?? phones[0]?.number ?? null),
    email: existing.email ? null : email,
    insert,
  };
}

/** Put a skip trace onto a buyer row: fill a blank phone and email, and keep every new number. */
export async function applyTraceToBuyer(workspaceId: number, buyerId: number, c: Candidate): Promise<{ phones: number; email: boolean; phone: boolean }> {
  const none = { phones: 0, email: false, phone: false };
  if (!supabase) return none;
  const [{ data: buyer }, { data: rows }] = await Promise.all([
    supabase.from('buyers').select('phone, email').eq('id', buyerId).eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('buyer_phones').select('phone, phone_key').eq('workspace_id', workspaceId).eq('buyer_id', buyerId),
  ]);
  const write = traceWrites(c, {
    phone: buyer?.phone ?? null,
    email: buyer?.email ?? null,
    phoneKeys: (rows ?? []).flatMap((r) => [r.phone_key, r.phone].filter((x): x is string => !!x)),
  });
  const patch: { phone?: string; email?: string; updated_at: string } = { updated_at: new Date().toISOString() };
  if (write.phone) patch.phone = write.phone;
  if (write.email) patch.email = write.email;
  if (write.phone || write.email) {
    await supabase.from('buyers').update(patch).eq('id', buyerId).eq('workspace_id', workspaceId);
  }
  // The buyer has been traced now, whatever came back.
  if (c.contacts_at) await tagBuyers([String(buyerId)], SKIPTRACE_TAG);
  if (write.insert.length) {
    const start = (rows ?? []).length;
    await supabase.from('buyer_phones').insert(write.insert.map((p, i) => ({
      workspace_id: workspaceId, buyer_id: buyerId, phone: p.phone, position: start + i + 1,
      kind: p.kind, source: 'genius', is_dnc: p.dnc, is_verified: p.verified,
    })));
  }
  // Every other address the trace found goes under the main one (buyer_emails). Best effort.
  const mainEmail = write.email ?? buyer?.email ?? null;
  for (const e of emailsOf(c).filter((x) => x && x.toLowerCase() !== String(mainEmail ?? '').toLowerCase()).slice(0, 5)) {
    await addBuyerEmail(workspaceId, buyerId, mainEmail, e, 'skip trace');
  }
  return { phones: write.insert.length, email: !!write.email, phone: !!write.phone };
}

/** Add a found owner to the buyer list, buy box seeded from what they actually bought, every good number kept. */
export async function addCandidate(workspaceId: number, c: Candidate, userId: string | null, via: FoundVia | null = null): Promise<WriteResult> {
  const box = emptyBuyBox();
  const cities = Array.from(new Set(c.purchases.map((p) => p.city).filter(Boolean)));
  const zips = Array.from(new Set(c.purchases.map((p) => p.zip).filter(Boolean)));
  const state = c.purchases.find((p) => p.state)?.state;
  box.location_prefs = [
    ...cities.map((name) => ({ name, type: 'city' as const, state })),
    ...zips.map((name) => ({ name, type: 'zip' as const, state })),
  ];
  const prices = c.purchases.map((p) => p.price).filter((p): p is number => !!p);
  if (prices.length) box.price = { min: Math.round(Math.min(...prices) * 0.7), max: Math.round(Math.max(...prices) * 1.3) };
  box.strategies = c.kind === 'landlord' ? ['buy_and_hold'] : c.kind === 'builder' ? ['new_construction'] : ['fix_and_flip'];
  const beds = c.purchases.map((p) => p.beds).filter((b): b is number => !!b);
  if (beds.length) box.beds = { min: Math.min(...beds) };
  const last = c.purchases[0];
  const method = methodOf(c, via);
  const how = METHOD_LABEL[method];
  const proof = (c.evidence ?? []).map((e) => `${METHOD_LABEL[e.method]}: ${e.summary}`).join(' ');
  box.notes = `Found by ${how}: ${c.purchase_count} ${KIND_LABEL[c.kind].toLowerCase()} purchase${c.purchase_count === 1 ? '' : 's'} nearby`
    + (last ? `, last ${last.address}, ${last.city}${last.date ? ` (${last.date.slice(0, 7)})` : ''}` : '')
    + `. Likelihood ${c.likelihood}%.` + (c.portfolio_count ? ` Owns ${c.portfolio_count}.` : '') + (proof ? ` ${proof}` : '') + (c.mailing ? ` Mailing: ${c.mailing}.` : '');
  const phones = phonesOf(c).filter((p) => p.status !== 'wrong');
  const primary = phones.find((p) => !p.dnc)?.number ?? null;
  // One tag per method that found them, so a Buyers filter can say "every Homefull flipper".
  const methodTags = Array.from(new Set([...(c.methods ?? []), method].map((m) => METHOD_TAG[m])));
  const r = await createBuyer(workspaceId, {
    name: c.corporate ? (c.people[0] ?? c.owner_name) : c.owner_name, company: c.corporate ? c.owner_name : null,
    phone: primary, email: emailsOf(c)[0] ?? null,
    buyer_type: c.kind === 'builder' ? 'developer' : c.kind, entity_type: c.corporate ? 'llc' : 'individual',
    tags: [...(via === 'buyr' ? ['buyr', 'buyer-prospect'] : via === 'facebook' ? ['fb-comment', 'buyer-prospect'] : ['genius', 'buyer-prospect']), ...methodTags, ...(c.contacts_at ? [SKIPTRACE_TAG] : [])],
    source: via === 'buyr' || via === 'facebook' ? 'buyr' : 'genius', status: 'Prospect', criteria: box,
  }, userId);
  if (r.id && !r.ok) {
    // Same email or phone as a buyer already on file. The new row is refused;
    // the skip trace still has to land on that record.
    await applyTraceToBuyer(workspaceId, r.id, c);
    return r;
  }
  if (r.ok && r.id && supabase) {
    // How they were found, on the row (migration 192): the method and its proof, for the buyer record and the Buyers filters.
    await supabase.from('buyers').update({ found_via: method, found_evidence: { methods: c.methods ?? [method], evidence: c.evidence ?? [], likelihood: c.likelihood, run_via: via ?? 'genius' } } as never).eq('id', r.id);
  }
  if (r.ok && r.id && supabase && phones.length) {
    await supabase.from('buyer_phones').insert(phones.slice(0, 6).map((p, i) => ({
      workspace_id: workspaceId, buyer_id: r.id!, phone: p.number, position: i + 1, kind: p.type, source: 'genius',
      is_dnc: p.dnc, is_verified: p.status === 'good',
    })));
  }
  return r;
}

// ---- analytics -----------------------------------------------------------------------------

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const range = (xs: number[]) => (xs.length ? [Math.min(...xs), Math.max(...xs)] as [number, number] : null);

export type SideStats = { buyers: number; purchases: number; priced: number; avg: number | null; range: [number, number] | null; avg_ppsf: number | null; ppsf_range: [number, number] | null };

function side(cands: Candidate[], role: Purchase['role']): SideStats {
  const ps = cands.flatMap((c) => c.purchases.filter((p) => p.role === role));
  const prices = ps.map((p) => p.price).filter((p): p is number => !!p);
  const ppsf = ps.map((p) => p.price_per_sqft).filter((p): p is number => !!p);
  return {
    buyers: cands.filter((c) => c.purchases.some((p) => p.role === role)).length, purchases: ps.length, priced: prices.length,
    avg: avg(prices), range: range(prices), avg_ppsf: avg(ppsf), ppsf_range: range(ppsf),
  };
}

/** The Analytics tab and the Genius Analysis box: what flippers pay, what landlords pay, and whether rent covers it. */
export function analytics(cands: Candidate[], s: Subject | null) {
  const flips = side(cands, 'flip'); const holds = side(cands, 'hold');
  const arv = s?.arv ?? s?.est_value ?? null;
  const rent = s?.suggested_rent ?? null;
  const held = cands.flatMap((c) => c.purchases.map((p) => p.days_held)).filter((d): d is number => !!d && d > 0);
  return {
    flips, holds, arv, rent,
    flip_pct_arv: flips.avg && arv ? Math.round((flips.avg / arv) * 100) : null,
    avg_days_held: avg(held),
    // The 1% rule: monthly rent over purchase price. At or above 1% a landlord's numbers work.
    one_pct: rent && holds.avg ? Number(((rent / holds.avg) * 100).toFixed(2)) : null,
    unique_buyers: cands.length,
    properties: new Set(cands.flatMap((c) => c.purchases.map((p) => p.reapi_id || p.address))).size,
    non_disclosure: cands.some((c) => c.non_disclosure),
  };
}

export type CompOpts = { radius_mi: number; months: number; beds: number | null; baths: number | null; sqft_band: number | null; year_min: number | null; year_max: number | null };
export type CompRow = Purchase & { id: string; buyer: string; kind: Kind };

/** Every priced investor purchase in the run that passes the comp filters, newest first. */
export function investorComps(cands: Candidate[], s: Subject | null, o: CompOpts): CompRow[] {
  const since = new Date(); since.setMonth(since.getMonth() - o.months);
  const cutoff = since.toISOString().slice(0, 10);
  const rows: CompRow[] = [];
  for (const c of cands) for (const p of c.purchases) {
    if (!p.price || !p.date || p.date < cutoff) continue;
    if (p.distance_mi !== null && p.distance_mi > o.radius_mi) continue;
    if (o.beds !== null && p.beds !== null && p.beds !== o.beds) continue;
    if (o.baths !== null && p.baths !== null && Math.floor(p.baths) !== Math.floor(o.baths)) continue;
    if (o.sqft_band !== null && s?.sqft && p.sqft && Math.abs(p.sqft - s.sqft) / s.sqft > o.sqft_band) continue;
    if (o.year_min !== null && p.year_built !== null && p.year_built < o.year_min) continue;
    if (o.year_max !== null && p.year_built !== null && p.year_built > o.year_max) continue;
    rows.push({ ...p, id: `${c.key}:${p.reapi_id || p.address}:${p.role}`, buyer: c.owner_name, kind: c.kind });
  }
  return rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

/** Est. investor price: the median $/sqft of the included comps times the subject's size, else the median price. */
export function investorPrice(rows: CompRow[], s: Subject | null) {
  const ppsf = median(rows.map((r) => r.price_per_sqft).filter((p): p is number => !!p));
  const price = ppsf && s?.sqft ? ppsf * s.sqft : median(rows.map((r) => r.price!).filter(Boolean));
  return { price: price ? Math.round(price / 500) * 500 : null, ppsf: ppsf ? Math.round(ppsf) : null, n: rows.length };
}

// ---- export ----------------------------------------------------------------------------------

export function toCsv(cands: Candidate[]): string {
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols: [string, (c: Candidate) => unknown][] = [
    ['Buyer', (c) => c.owner_name], ['Person', (c) => c.people.join('; ')], ['Type', (c) => KIND_LABEL[c.kind]], ['Entity', (c) => (c.corporate ? 'yes' : '')],
    ['Likelihood', (c) => c.likelihood], ['SmartMatch', (c) => (c.smart_match ? c.smart_rank : '')], ['In buyers', (c) => (c.matched_buyer_id ? 'yes' : '')],
    ['Buys nearby', (c) => c.purchase_count], ['Portfolio', (c) => c.portfolio_count ?? ''], ['Nearest mi', (c) => c.nearest_mi ?? ''],
    ['Last purchase', (c) => c.last_purchase ?? ''], ['Avg price', (c) => c.avg_price ?? ''], ['% of ARV', (c) => c.pct_of_arv ?? ''],
    ['Avg days held', (c) => c.avg_days_held ?? ''], ['Cash', (c) => (c.cash === null ? '' : c.cash ? 'yes' : 'no')],
    ['Phone 1', (c) => phonesOf(c)[0]?.number ?? ''], ['Phone 2', (c) => phonesOf(c)[1]?.number ?? ''], ['Phone 3', (c) => phonesOf(c)[2]?.number ?? ''],
    ['DNC', (c) => phonesOf(c).filter((p) => p.dnc).map((p) => p.number).join('; ')], ['Email', (c) => emailsOf(c)[0] ?? ''],
    ['Mailing', (c) => c.mailing ?? ''], ['Last address', (c) => c.purchases[0] ? `${c.purchases[0].address}, ${c.purchases[0].city} ${c.purchases[0].state} ${c.purchases[0].zip}` : ''],
    ['Reasons', (c) => c.reasons.join('; ')],
  ];
  return [cols.map(([h]) => h).join(','), ...cands.map((c) => cols.map(([, f]) => esc(f(c))).join(','))].join('\n');
}

export function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
