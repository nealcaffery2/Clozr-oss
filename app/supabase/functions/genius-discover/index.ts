/**
 * POST /genius-discover — Genius Mode v2: every cash buyer already buying
 * around an address, from public records, with phones on demand.
 *
 * Property data is RealEstateAPI's (REAL_ESTATE_API_API_KEY, read only here)
 * and skip tracing is split: individuals on RealEstateAPI, LLCs on BatchData
 * (BATCHDATA_API_KEY, _shared/batchdata.ts): the
 * rules that turn records into buyers live in _shared/genius-core.ts. The
 * caller's JWT decides the workspace and the deal they may see; the service
 * role writes the run, the caches and the credit ledger.
 *
 * Body: { workspace_id, action, ... }
 *   autocomplete { q }                                    → { results: Suggestion[] }             (free on every REAPI plan)
 *   estimate     { deal_id? | address?, ...filters }     → { subject, total, plans, est_credits }  (count calls only)
 *   discover     { deal_id? | address?, ...filters, skip_trace?, enrich_limit?, skip_limit?, max_records? }
 *                → application/x-ndjson, one event per line:
 *                  { type:'subject', subject } · { type:'scan_count', total, plans } · { type:'progress', stage, done, total }
 *                  { type:'buyers', candidates, properties_scanned } (repeated; each replaces the last)
 *                  { type:'done', run_id, credits, truncated } · { type:'error', error }
 *   portfolio    { reapi_id }                            → { total, value, properties: [...] }
 *   skiptrace    { targets: SkipTarget[], run_id? }     → { results: { [key]: { hits, cached, at } }, credits }
 *   owner        { address }                           → { owner, mailing, source, source_url, tried }   (ATTOM → RealEstateAPI → county record via Claude, cached)
 *
 * compare: true on discover also searches ATTOM (ATTOM_API_KEY) around the same
 * point and merges it in without duplicates (one property, one buyer); each
 * buyer carries `sources` and a { type:'compare', … } event counts the overlap.
 *
 * Filters: radius_mi, months, kinds[], property_types[], strategy, asking_price, include_non_arms_length,
 * include_institutional, flip_months, beds_min/max, baths_min/max, price_min/max, min_portfolio, homefull.
 *
 * methods[] on discover runs the discovery methods after the base run
 * (_shared/genius-methods.ts): homefull (listing photos through Gemini, cached
 * 180 days a house), reverse_llc, wholesale_snipe (PropertyDetail sale chains),
 * landlord, wholesaler_buyers (our assignment contracts and the county deed
 * index: _shared/deed-search.ts where we have an adapter, Claude reading the
 * county's own index everywhere else, _shared/records-agent.ts). Each buyer carries `method`, `methods` and
 * `evidence`; a { type:'methods', counts, notes } event sums the pass.
 *
 * Pay once: PropertyDetail is cached 30 days per property, a skip trace 90 days per
 * owner, and a saved run reopens from discover_runs without calling this at all.
 * A refused key, empty credits, or a rate limit is an error event, never "no buyers found".
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, tooMany } from '../_shared/security.ts';
import { BatchDataError, fatal, skipTrace } from '../_shared/batchdata.ts';
import {
  type Any, type Candidate, type Filters, type Hit, type KnownBuyer, type SkipHit, type Source, type Subject,
  type SkipProvider, type SkipRequest,
  type Purchase,
  addressKey, applyDetail, at, attomOwnerName, attomType, buildBuyers, mapAttom, mapHit, mapSkipBatch, mapSkipReapi, matchKnown, mergeAttom, parseFilters, searchPlans, skipTarget, subjectFrom, tagSources,
  isEntity, miles, ownerFrom, ownerKey,
} from '../_shared/genius-core.ts';
import {
  type Evidence, type Labelled, type Method, type RankedBuyer, type RenovationVerdict,
  applyHomefull, detectDoubleClose, entityKey, familyOf, granteeCandidate, homefullTargets, label, landlords, parseMethods, rankGrantees, reverseLlc, saleRows, snipeTargets, snipedBuyer,
} from '../_shared/genius-methods.ts';
import { type DeedTransaction } from '../_shared/genius-methods.ts';
import { PYTHON_ONLY, portalFor, searchGrantors } from '../_shared/deed-search.ts';
import { checkHouse } from '../_shared/homefull-vision.ts';
import { deedsByAgent, ownerByAgent } from '../_shared/records-agent.ts';

const REAPI = 'https://api.realestateapi.com/v2';
const PAGE = 250;                 // PropertySearch's per-request ceiling.
const DETAIL_TTL_DAYS = 30;
const SKIP_TTL_DAYS = 90;

const ATTOM = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';

class ReapiError extends Error { constructor(msg: string, public status = 502) { super(msg); } }

function key(): string {
  const k = (Deno.env.get('REAL_ESTATE_API_API_KEY') ?? '').trim();
  if (!k) throw new ReapiError('Genius Mode is not connected: set the REAL_ESTATE_API_API_KEY secret on the Supabase project.', 503);
  return k;
}

/** One RealEstateAPI call. Throws on anything but a 2xx so a dead key never reads as an empty neighbourhood. */
async function reapi(path: 'PropertySearch' | 'PropertyDetail' | 'SkipTrace' | 'AutoComplete', body: Record<string, unknown>): Promise<Any> {
  const res = await fetch(`${REAPI}/${path}`, {
    method: 'POST',
    headers: { 'x-api-key': key(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 401 || res.status === 403) throw new ReapiError('RealEstateAPI rejected the key — check REAL_ESTATE_API_API_KEY on the Supabase project.', 503);
  if (res.status === 402) throw new ReapiError('RealEstateAPI is out of credits — top up the account at realestateapi.com, then run Genius Mode again.', 402);
  if (res.status === 429) throw new ReapiError('RealEstateAPI is rate limiting this account right now. Try again in a minute.', 429);
  if (res.status === 404 && path === 'PropertyDetail') return null;
  if (!res.ok) throw new ReapiError(`RealEstateAPI answered ${res.status} on ${path}.`);
  return await res.json();
}

/** Run fn over items, n at a time. */
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * Every row a query matches. PostgREST caps a response at 1,000 rows whatever
 * .limit() says, so a bare read of a big buyer list silently stops matching
 * after the first thousand. Pages until a short page, up to `max`.
 */
// deno-lint-ignore no-explicit-any
async function allRows(q: (from: number, to: number) => PromiseLike<{ data: any[] | null }>, max = 50000): Promise<Any[]> {
  const out: Any[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data } = await q(from, from + 999);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

type Ctx = { ws: number; userId: string; admin: SupabaseClient; asCaller: SupabaseClient; credits: Record<string, number>; runId: number | null };

async function spend(ctx: Ctx, kind: 'search' | 'detail' | 'skiptrace' | 'count' | 'vision' | 'deeds' | 'scrape', units: number) {
  if (!units) return;
  ctx.credits[kind] = (ctx.credits[kind] ?? 0) + units;
  await ctx.admin.from('genius_credit_log').insert({ workspace_id: ctx.ws, run_id: ctx.runId, kind, units, created_by: ctx.userId });
}

/** The workspace's monthly credit cap (workspaces.settings.genius_monthly_credit_cap), and what this month has used. */
async function budget(ctx: Ctx): Promise<{ cap: number | null; used: number }> {
  const { data: w } = await ctx.admin.from('workspaces').select('settings').eq('id', ctx.ws).maybeSingle();
  const cap = Number((w?.settings as Any)?.genius_monthly_credit_cap);
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const data = await allRows((a, b) => ctx.admin.from('genius_credit_log').select('units').eq('workspace_id', ctx.ws)
    .in('kind', ['search', 'detail', 'skiptrace', 'vision', 'deeds', 'scrape']).gte('created_at', start.toISOString()).order('id').range(a, b));
  const used = data.reduce((a: number, r: { units: number }) => a + (r.units ?? 0), 0);
  return { cap: Number.isFinite(cap) && cap > 0 ? cap : null, used };
}

async function overBudget(ctx: Ctx): Promise<string | null> {
  const b = await budget(ctx);
  return b.cap !== null && b.used >= b.cap
    ? `This workspace has used its Genius credits for the month (${b.used.toLocaleString('en-US')} of ${b.cap.toLocaleString('en-US')}). An owner can raise the cap in Settings.`
    : null;
}

// ---- subject ------------------------------------------------------------------------

async function cachedDetail(ctx: Ctx, id: string): Promise<Any | null> {
  const since = new Date(Date.now() - DETAIL_TTL_DAYS * 864e5).toISOString();
  const { data } = await ctx.admin.from('genius_property_cache').select('detail').eq('workspace_id', ctx.ws).eq('reapi_id', id).gte('fetched_at', since).maybeSingle();
  return data?.detail ?? null;
}
async function putCache(ctx: Ctx, rows: { reapi_id: string; detail: Any }[]) {
  if (!rows.length) return;
  await ctx.admin.from('genius_property_cache').upsert(rows.map((r) => ({ workspace_id: ctx.ws, ...r, fetched_at: new Date().toISOString() })), { onConflict: 'workspace_id,reapi_id' });
}

/**
 * Where the search centres and what we compare against. A deal brings its ARV
 * and price; a typed address brings whatever the caller entered. The record
 * lookup is cached under the address so an estimate followed by a run pays once.
 */
async function resolveSubject(ctx: Ctx, b: Any): Promise<{ subject: Subject; dealId: number | null; sellerId: number | null; county: string | null } | { error: string; status: number }> {
  let line1 = ''; let city: string | null = null; let state: string | null = null; let zip: string | null = null;
  let lat: number | null = null; let lng: number | null = null; let arv: number | null = null; let price: number | null = null; let beds: number | null = null;
  let dealId: number | null = null; let sellerId: number | null = null; let propId: number | null = null;
  if (b.deal_id) {
    const { data: deal } = await ctx.asCaller.from('deals').select('*').eq('id', Number(b.deal_id)).eq('workspace_id', ctx.ws).maybeSingle();
    if (!deal) return { error: 'deal not found', status: 404 };
    dealId = deal.id; sellerId = deal.seller_id ?? null;
    const seller: Any = deal.seller_id ? (await ctx.asCaller.from('sellers').select('id, property_address, asking_price, property_id').eq('id', deal.seller_id).maybeSingle()).data : null;
    propId = deal.property_id ?? seller?.property_id ?? null;
    const prop: Any = propId ? (await ctx.asCaller.from('properties').select('*').eq('id', propId).maybeSingle()).data : null;
    line1 = String(prop?.line1 || seller?.property_address || '');
    city = prop?.city ?? null; state = prop?.state ?? null; zip = prop?.zip ?? null;
    lat = Number(prop?.lat) || null; lng = Number(prop?.lng) || null; beds = Number(prop?.beds) || null;
    arv = Number(deal.arv) || null;
    // What a buyer would pay: the marketed or asking price, else contract plus the target fee.
    price = Number(b.asking_price) || Number(deal.marketed_price) || Number(deal.asking_price)
      || (Number(deal.offer_amount) ? Number(deal.offer_amount) + (Number(deal.target_assignment) || 0) : 0) || null;
    if (!line1) return { error: 'The deal needs a property address first.', status: 422 };
  } else if (b.address) {
    line1 = String(b.address).slice(0, 200);
    city = b.city ? String(b.city) : null; state = b.state ? String(b.state) : null; zip = b.zip ? String(b.zip) : null;
    arv = Number(b.arv) || null; price = Number(b.asking_price) || null;
  } else return { error: 'Give an address or pick a deal.', status: 422 };

  const full = [line1, [city, state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const ck = `addr:${addressKey(full)}`;
  let row: Any = await cachedDetail(ctx, ck);
  if (!row) {
    const j = b.reapi_id
      ? await reapi('PropertySearch', { ids: [Number(b.reapi_id)], size: 1 })
      : await reapi('PropertySearch', { address: full, size: 1 });
    row = Array.isArray(j?.data) ? j.data[0] ?? null : null;
    await spend(ctx, 'search', row ? 1 : 0);
    if (row) await putCache(ctx, [{ reapi_id: ck, detail: row }]);
  }
  const subject = subjectFrom(row, { address: line1, city, state, zip, lat, lng, arv, price, beds, deal_id: dealId });
  if (!subject) return { error: 'Could not place that address on the map — check the street, city, state and ZIP.', status: 422 };
  if (propId && (!lat || !lng)) await ctx.admin.from('properties').update({ lat: subject.lat, lng: subject.lng }).eq('id', propId);
  const county = String(row?.address?.county ?? row?.county ?? '').replace(/\s+county$/i, '').trim() || null;
  return { subject, dealId, sellerId, county };
}

// ---- search -----------------------------------------------------------------------------

async function counts(ctx: Ctx, f: Filters, s: Subject) {
  const plans = searchPlans(f, s.lat, s.lng);
  const n = await pool(plans, 4, async (p) => {
    const j = await reapi('PropertySearch', { ...p.body, count: true });
    return Number(j?.resultCount ?? j?.recordCount ?? j?.data ?? 0) || 0;
  });
  await spend(ctx, 'count', plans.length);
  return plans.map((p, i) => ({ ...p, count: n[i] }));
}

// ---- the people we already know ---------------------------------------------------------------

async function knownBuyers(ctx: Ctx): Promise<KnownBuyer[]> {
  const all = await allRows((a, b) => ctx.admin.from('buyers').select('id, name, company, email, phone_key').eq('workspace_id', ctx.ws).order('id').range(a, b));
  const phones = new Map<number, string[]>(); const names = new Map<number, string[]>();
  const ph = await allRows((a, b) => ctx.admin.from('buyer_phones').select('buyer_id, phone_key, phone').eq('workspace_id', ctx.ws).order('id').range(a, b));
  for (const r of ph) { const k = String(r.phone_key ?? r.phone ?? '').replace(/\D+/g, '').slice(-10); if (k) phones.set(r.buyer_id, [...(phones.get(r.buyer_id) ?? []), k]); }
  const bc = await allRows((a, b) => ctx.admin.from('buyer_contacts').select('buyer_id, full_name').eq('workspace_id', ctx.ws).order('id').range(a, b));
  for (const r of bc) if (r.full_name) names.set(r.buyer_id, [...(names.get(r.buyer_id) ?? []), r.full_name]);
  return all.map((b) => ({
    id: b.id, name: b.name, company: b.company, email: b.email,
    phone_keys: [String(b.phone_key ?? '').replace(/\D+/g, '').slice(-10), ...(phones.get(b.id) ?? [])].filter(Boolean),
    contact_names: names.get(b.id) ?? [],
  }));
}

/** Every fresh skip trace this workspace holds, keyed by the candidate key it was traced for. */
async function cachedContacts(ctx: Ctx): Promise<Map<string, { hits: SkipHit[]; at: string }>> {
  const since = new Date(Date.now() - SKIP_TTL_DAYS * 864e5).toISOString();
  const data = await allRows((a, b) => ctx.admin.from('genius_skip_cache').select('owner_key, hits, fetched_at').eq('workspace_id', ctx.ws).gte('fetched_at', since).order('id').range(a, b));
  const m = new Map<string, { hits: SkipHit[]; at: string }>();
  for (const r of data) m.set(String(r.owner_key).split('|')[0], { hits: r.hits as SkipHit[], at: r.fetched_at });
  return m;
}

// ---- skip trace -----------------------------------------------------------------------------------

type TraceIn = Pick<Candidate, 'key' | 'owner_name' | 'corporate' | 'people' | 'mail_parts' | 'mailing' | 'purchases'>;

/** Skip trace each target: the workspace's 90-day cache first, then individuals on RealEstateAPI and LLCs on BatchData. */
async function trace(ctx: Ctx, targets: TraceIn[]): Promise<Record<string, { hits: SkipHit[]; cached: boolean; at: string } | { error: string }>> {
  const since = new Date(Date.now() - SKIP_TTL_DAYS * 864e5).toISOString();
  const plans = targets.map((t) => ({ t, plan: skipTarget(t) }));
  const keys = plans.map((p) => p.plan?.owner_key).filter((k): k is string => !!k);
  const { data: hit } = keys.length
    ? await ctx.admin.from('genius_skip_cache').select('owner_key, hits, fetched_at').eq('workspace_id', ctx.ws).in('owner_key', keys).gte('fetched_at', since)
    : { data: [] };
  const cache = new Map((hit ?? []).map((r: Any) => [r.owner_key as string, r]));
  const out: Record<string, { hits: SkipHit[]; cached: boolean; at: string } | { error: string }> = {};
  // One request per owner_key, however many targets share it.
  type Todo = [string, { ts: TraceIn[]; provider: SkipProvider; body: SkipRequest; reapi: Record<string, string> }];
  const todo = new Map<string, Todo[1]>();
  for (const { t, plan } of plans) {
    if (!plan) { out[t.key] = { error: 'No address to trace this owner at.' }; continue; }
    const c = cache.get(plan.owner_key);
    if (c) { out[t.key] = { hits: c.hits, cached: true, at: c.fetched_at }; continue; }
    const q = todo.get(plan.owner_key);
    if (q) q.ts.push(t); else todo.set(plan.owner_key, { ts: [t], provider: plan.provider, body: plan.body, reapi: plan.reapi });
  }
  if (!todo.size) return out;

  // Only real answers (hits or a genuine no-match) are cached; a failed call is an
  // error on that owner, never "no contact found".
  const at = new Date().toISOString();
  const rows: Any[] = [];
  let paid = 0; let stop: Error | null = null;
  const settle = (q: Todo[1], r: { hits: SkipHit[]; cached: boolean; at: string } | { error: string }) => { for (const t of q.ts) out[t.key] = r; };
  const keep = ([owner_key, q]: Todo, hits: SkipHit[], provider: SkipProvider) => {
    rows.push({ workspace_id: ctx.ws, owner_key, owner_name: q.ts[0].owner_name, hits, provider, fetched_at: at, fetched_by: ctx.userId });
    settle(q, { hits, cached: false, at });
  };
  const owners = [...todo.entries()];
  try {
    // 1 · Individuals on RealEstateAPI ($0.05 a hit), four at a time. If RealEstateAPI
    //     can't serve at all (no credits, no key), the rest go to BatchData instead.
    const toBatch: Todo[] = owners.filter(([, q]) => q.provider === 'batchdata');
    let reapiOut = false;
    await pool(owners.filter(([, q]) => q.provider === 'reapi'), 4, async (o) => {
      if (reapiOut) { toBatch.push(o); return; }
      if (stop) { settle(o[1], { error: stop.message }); return; }
      try {
        const j = await reapi('SkipTrace', o[1].reapi);
        paid++;
        keep(o, mapSkipReapi(j), 'reapi');
      } catch (e) {
        if (e instanceof ReapiError && (e.status === 402 || e.status === 503)) { reapiOut = true; toBatch.push(o); return; }
        if (e instanceof ReapiError && e.status === 429 && !stop) stop = e;
        settle(o[1], { error: (e as Error).message });
      }
    });

    // 2 · LLCs and other entities — and any individual RealEstateAPI couldn't take — batched on BatchData.
    if (toBatch.length) {
      const { answers, billed } = await skipTrace(toBatch.map(([, q]) => q.body));
      paid += billed;
      toBatch.forEach((o, i) => {
        const d = answers[i];
        if (d instanceof BatchDataError) { settle(o[1], { error: d.message }); if (fatal(d) && !stop) stop = d; }
        else if (d?.meta?.error) settle(o[1], { error: 'BatchData could not trace this owner. Try again later.' });
        else keep(o, mapSkipBatch(d), 'batchdata');
      });
    }
  } finally {
    if (rows.length) {
      const { error } = await ctx.admin.from('genius_skip_cache').upsert(rows, { onConflict: 'workspace_id,owner_key' });
      // Before migration 183 the table has no provider column: cache without it rather than not at all.
      if (error && /provider/i.test(error.message)) {
        await ctx.admin.from('genius_skip_cache').upsert(rows.map(({ provider: _p, ...r }) => r), { onConflict: 'workspace_id,owner_key' });
      }
    }
    await spend(ctx, 'skiptrace', paid);
  }
  // A provider that can't serve at all fails the request only when nobody got an answer;
  // otherwise its owners carry the error and the traces that did land come back.
  if (stop && !rows.length) throw stop;
  return out;
}

// ---- ATTOM, for compare mode -------------------------------------------------------------------------

/** One ATTOM Property API call (GET, apikey header). "No results" is a 400 with SuccessWithoutResult: that is an empty answer, not an error. */
async function attom(path: string, params: Record<string, string | number>): Promise<Any> {
  const k = (Deno.env.get('ATTOM_API_KEY') ?? '').trim();
  if (!k) throw new ReapiError('ATTOM is not connected: set the ATTOM_API_KEY secret on the Supabase project.', 503);
  const qs = new URLSearchParams(Object.entries(params).map(([a, v]) => [a, String(v)]));
  const res = await fetch(`${ATTOM}/${path}?${qs}`, { headers: { apikey: k, Accept: 'application/json' }, signal: AbortSignal.timeout(25_000) });
  if (res.status === 401 || res.status === 403) throw new ReapiError('ATTOM rejected the key — check ATTOM_API_KEY on the Supabase project.', 503);
  if (res.status === 429) throw new ReapiError('ATTOM is rate limiting this account right now. Try again in a minute.', 429);
  const j = await res.json().catch(() => null);
  if (!res.ok && !/withoutresult/i.test(String(j?.status?.msg ?? ''))) throw new ReapiError(`ATTOM answered ${res.status}${j?.status?.msg ? `: ${String(j.status.msg).slice(0, 160)}` : ''}.`, 502);
  return j;
}
/** An object's field names, nested, with no values: safe to log. */
const shapeOf = (o: Any, depth = 0): Any => (o && typeof o === 'object' && !Array.isArray(o) && depth < 4
  ? Object.fromEntries(Object.keys(o).map((k) => [k, shapeOf(o[k], depth + 1)])) : Array.isArray(o) ? [o.length ? shapeOf(o[0], depth + 1) : null] : typeof o);
const ymd = (d: Date) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * ATTOM's sales around the subject in the same window, each with its owner:
 * sale/snapshot by radius and sale date, then assessment/detail per property
 * for the owner, mailing address and absentee flag (the snapshot has no owner).
 */
async function attomHits(f: Filters, s: Subject, send: Send, cap: number): Promise<{ hits: Hit[]; calls: number; total: number }> {
  const end = new Date(); const start = new Date(); start.setUTCMonth(start.getUTCMonth() - f.months);
  const sales: Any[] = []; let calls = 0; let total = 0;
  for (let page = 1; sales.length < cap; page++) {
    const j = await attom('sale/snapshot', { latitude: s.lat, longitude: s.lng, radius: f.radius_mi, startsalesearchdate: ymd(start), endsalesearchdate: ymd(end), pagesize: 100, page });
    calls++;
    total = Number(j?.status?.total) || total;
    const rows: Any[] = Array.isArray(j?.property) ? j.property : [];
    // The shape ATTOM sent, field names only (no values), so the mapping can be checked in the function logs.
    if (page === 1 && rows[0]) console.log('attom sale/snapshot shape', JSON.stringify(shapeOf(rows[0])));
    sales.push(...rows);
    send({ type: 'progress', stage: 'attom', done: sales.length, total: Math.min(total || sales.length, cap) });
    if (rows.length < 100) break;
  }
  const idOf = (x: Any) => String(at(at(x, 'identifier') ?? {}, 'attomId', 'Id') ?? '');
  const kind = (x: Any) => { const sm = at(x, 'summary') ?? {}; return attomType(at(sm, 'propType'), at(sm, 'propSubType'), at(sm, 'propLandUse'), at(sm, 'propClass')); };
  const want = sales.slice(0, cap).filter((x) => { const t = kind(x); return !!idOf(x) && (!t || t === 'LAND' || f.property_types.includes(t)); });
  const owners = new Map<string, Any>();
  let done = 0; let viaDetailOwner = 0;
  await pool(want, 5, async (x) => {
    const id = idOf(x);
    try {
      const j = await attom('assessment/detail', { attomid: id });
      calls++;
      let p = Array.isArray(j?.property) ? j.property[0] : null;
      if (p && !owners.size) console.log('attom assessment/detail shape', JSON.stringify(shapeOf(p)));
      // Some ATTOM plans and counties leave the owner off the assessment: property/detailowner carries it.
      if (!attomOwnerName(p)) {
        const o = await attom('property/detailowner', { attomid: id });
        calls++;
        const q = Array.isArray(o?.property) ? o.property[0] : null;
        if (q && !viaDetailOwner) console.log('attom property/detailowner shape', JSON.stringify(shapeOf(q)));
        if (attomOwnerName(q)) { p = { ...(p ?? {}), owner: at(q, 'owner') }; viaDetailOwner++; }
      }
      if (p) owners.set(id, p);
    } catch (e) {
      if (e instanceof ReapiError && (e.status === 503 || e.status === 429)) throw e;
    }
    done++;
    if (done % 10 === 0 || done === want.length) send({ type: 'progress', stage: 'attom_owners', done, total: want.length });
  });
  // Every hit goes back, owner or not: a property RealEstateAPI also holds gets its owner from there in mergeAttom.
  return { hits: want.map((x) => mapAttom(x, owners.get(idOf(x)) ?? null)), calls, total };
}

// ---- discover (streamed) ---------------------------------------------------------------------------

type Send = (o: Record<string, unknown>) => void;

const HOMEFULL_TTL_DAYS = 180;

/**
 * The method passes, after the base run and before the skip trace. Base
 * candidates are rebuilt from the hits at each step (buildBuyers is pure),
 * so what a method adds lives beside them: `labels` (proof by candidate key,
 * reapplied after every rebuild) and `extras` (buyers the records around the
 * house never surfaced: a sniped end buyer, a wholesaler's repeat buyer).
 */
type MethodState = { labels: Map<string, Evidence[]>; extras: Map<string, Labelled>; notes: string[]; counts: Record<string, number> };

/** Base candidates with their proof back on, and the extras beside them. */
function decorate(list: Candidate[], st: MethodState): Labelled[] {
  const out: Labelled[] = list.map((c) => {
    const ev = st.labels.get(c.key);
    if (!ev) return c;
    return ev.reduce((x, e) => label(x, e), c as Labelled);
  });
  const have = new Set(out.map((c) => c.key));
  for (const [k, c] of st.extras) if (!have.has(k)) out.push(c);
  return out.sort((a, b) => b.likelihood - a.likelihood || b.purchase_count - a.purchase_count);
}

/** Keep a labelled candidate's proof for the next rebuild. */
function remember(st: MethodState, cands: Labelled[], base: Set<string>) {
  for (const c of cands) {
    if (!c.evidence?.length) continue;
    if (base.has(c.key)) st.labels.set(c.key, c.evidence);
    else st.extras.set(c.key, c);
  }
}

/** A purchase row for a house the base run holds a hit for (a sniped end buyer's buy). */
function purchaseOf(h: Hit, s: Subject): Purchase {
  const dist = h.lat && h.lng ? Number(miles(s, { lat: h.lat, lng: h.lng }).toFixed(2)) : null;
  return {
    reapi_id: h.reapi_id, role: 'hold', address: h.address, city: h.city, state: h.state, zip: h.zip, lat: h.lat, lng: h.lng, distance_mi: dist,
    property_type: h.property_type, beds: h.beds, baths: h.baths, sqft: h.sqft, year_built: h.year_built,
    price: h.last_sale_amount, price_source: h.last_sale_amount ? 'recorded' : null, non_disclosure: !h.last_sale_amount, date: h.last_sale_date,
    resale_price: null, resale_date: null, days_held: null, financed: null, est_value: h.est_value, pct_of_arv: null,
    price_per_sqft: h.last_sale_amount && h.sqft ? Math.round(h.last_sale_amount / h.sqft) : null, agent: null,
    zillow: `https://www.zillow.com/homes/${encodeURIComponent(`${h.address} ${h.city} ${h.state} ${h.zip}`.trim().replace(/\s+/g, '-'))}_rb/`,
  };
}

async function runMethods(ctx: Ctx, b: Any, f: Filters, s: Subject, county: string | null, hits: Map<string, Hit>, list: Labelled[], known: KnownBuyer[], methods: Method[], st: MethodState, send: Send): Promise<Labelled[]> {
  const base = new Set(list.map((c) => c.key));
  let out = list;

  if (methods.includes('reverse_llc')) {
    out = reverseLlc(out, { min_portfolio: Math.max(2, f.min_portfolio) });
    st.counts.reverse_llc = out.filter((c) => c.methods?.includes('reverse_llc')).length;
  }
  if (methods.includes('landlord')) {
    out = landlords(out, hits);
    st.counts.landlord = out.filter((c) => c.methods?.includes('landlord')).length;
  }

  // Homefull: the listing photos of every completed flip the top buyers made, cached per house.
  if (methods.includes('homefull')) {
    const targets = homefullTargets(out, Math.min(40, Math.max(1, Number(b.homefull_limit) || 25)));
    const verdicts = new Map<string, RenovationVerdict>();
    if (targets.length) {
      const since = new Date(Date.now() - HOMEFULL_TTL_DAYS * 864e5).toISOString();
      const keys = targets.map((t) => `homefull:${t.reapi_id}`);
      const { data: cached } = await ctx.admin.from('genius_property_cache').select('reapi_id, detail').eq('workspace_id', ctx.ws).in('reapi_id', keys).gte('fetched_at', since);
      for (const r of (cached ?? []) as Any[]) verdicts.set(String(r.reapi_id).slice('homefull:'.length), r.detail as RenovationVerdict);
      const todo = targets.filter((t) => !verdicts.has(t.reapi_id));
      let done = targets.length - todo.length;
      send({ type: 'progress', stage: 'homefull', done, total: targets.length });
      const fresh: { reapi_id: string; detail: Any }[] = [];
      let scrapeCalls = 0;
      await pool(todo, 3, async (t) => {
        const v = await checkHouse(t);
        scrapeCalls += v.calls;
        // A verdict is cached; a miss (no listing, no key) is not, so the next run tries again.
        if (v.renovated !== null) { verdicts.set(t.reapi_id, v); fresh.push({ reapi_id: `homefull:${t.reapi_id}`, detail: v }); }
        else if (v.note && !st.notes.includes(v.note)) st.notes.push(v.note);
        done++;
        send({ type: 'progress', stage: 'homefull', done, total: targets.length });
      });
      await spend(ctx, 'vision', fresh.length);
      await spend(ctx, 'scrape', scrapeCalls);
      await putCache(ctx, fresh);
    }
    out = applyHomefull(out, verdicts, targets);
    st.counts.homefull = out.filter((c) => c.methods?.includes('homefull')).length;
    st.counts.homefull_checked = verdicts.size;
  }

  // Wholesale snipe: the deed chain on the houses the top buyers bought; a double close names the wholesaler and the end buyer.
  if (methods.includes('wholesale_snipe')) {
    const ids = snipeTargets(out, hits, Math.min(100, Math.max(1, Number(b.snipe_limit) || 60)));
    if (ids.length) {
      const since = new Date(Date.now() - DETAIL_TTL_DAYS * 864e5).toISOString();
      const { data: cached } = await ctx.admin.from('genius_property_cache').select('reapi_id, detail').eq('workspace_id', ctx.ws).in('reapi_id', ids).gte('fetched_at', since);
      const have = new Map((cached ?? []).map((c: Any) => [c.reapi_id as string, c.detail]));
      const missing = ids.filter((id) => !have.has(id));
      let done = ids.length - missing.length;
      send({ type: 'progress', stage: 'snipe', done, total: ids.length });
      const fresh: { reapi_id: string; detail: Any }[] = [];
      await pool(missing, 5, async (id) => {
        const j = await reapi('PropertyDetail', { id: Number(id) });
        const d = j?.data ?? null;
        if (d) { have.set(id, d); fresh.push({ reapi_id: id, detail: d }); }
        done++;
        if (done % 5 === 0 || done === ids.length) send({ type: 'progress', stage: 'snipe', done, total: ids.length });
      });
      await spend(ctx, 'detail', missing.length);
      await putCache(ctx, fresh);
      const deedRows: Record<string, unknown>[] = [];
      let found = 0;
      for (const [id, d] of have) {
        const h = hits.get(id);
        if (h) hits.set(id, applyDetail(h, d));
        const dc = detectDoubleClose(saleRows(d?.saleHistory));
        if (!dc || !h) continue;
        found++;
        const p = out.flatMap((c) => c.purchases).find((x) => x.reapi_id === id) ?? purchaseOf(hits.get(id)!, s);
        const key = ownerKey(ownerFrom(dc.end_buyer)?.name ?? dc.end_buyer, isEntity(dc.end_buyer));
        const existing = out.find((c) => c.key === key) ?? null;
        const made = snipedBuyer(dc, p, existing);
        out = existing ? out.map((c) => (c.key === key ? made : c)) : [...out, made];
        deedRows.push({
          workspace_id: ctx.ws, assignor_name: dc.wholesaler, assignee_name: made.owner_name, property_address: h.address, city: h.city, state: h.state, zip: h.zip, county,
          purchase_price: dc.a_price, total_price: dc.b_price, assignment_fee: dc.spread, contract_date: dc.a_date, closing_date: dc.b_date,
          leg: 'deed', source: 'deed', source_id: `reapi:${id}:${dc.b_date}`, source_url: p.zillow, raw: { kind: dc.kind, seller: dc.seller, gap_days: dc.gap_days },
        });
      }
      if (deedRows.length) await recordDeedDeals(ctx, deedRows);
      st.counts.wholesale_snipe = found;
    }
  }

  // Wholesaler buyers: our own assignment contracts first (they carry contact details), then the county deed index.
  if (methods.includes('wholesaler_buyers')) {
    const state = s.state ?? null;
    const { data: ents } = await ctx.admin.from('wholesaler_entities').select('id, name, parent_id, kind, state').eq('workspace_id', ctx.ws);
    const entities = (ents ?? []) as { id: number; name: string; parent_id: number | null; kind: string; state: string | null }[];
    const nameOf = new Map(entities.map((e) => [e.id, e.name]));
    const rootName = (e: { name: string; parent_id: number | null }) => familyOf(e.name) ?? (e.parent_id ? nameOf.get(e.parent_id) ?? e.name : e.name);
    const famOf = (n: string) => { const e = entities.find((x) => entityKey(x.name) === entityKey(n)); return e ? rootName(e) : familyOf(n) ?? n; };

    // 1 · from the contracts in the Drive: assignees of our BC legs (and deed rows a snipe pass wrote), in this state.
    const { data: deals } = await ctx.admin.from('wholesaler_deals').select('assignor_name, assignee_name, assignee_person, assignee_email, assignee_phone, property_address, city, state, zip, county, total_price, purchase_price, closing_date, contract_date, leg, source')
      .eq('workspace_id', ctx.ws).in('leg', ['BC', 'deed', 'unknown']).limit(2000);
    const txs: DeedTransaction[] = [];
    const contact = new Map<string, { person: string | null; email: string | null; phone: string | null }>();
    for (const d of (deals ?? []) as Any[]) {
      if (!d.assignee_name || !d.assignor_name) continue;
      if (state && d.state && d.state !== state) continue;
      txs.push({ grantor: d.assignor_name, grantee: d.assignee_name, address: [d.property_address, d.city, d.state, d.zip].filter(Boolean).join(', ') || null, county: d.county ?? '', state: d.state ?? state ?? '', date: d.closing_date ?? d.contract_date ?? null, price: d.total_price ?? d.purchase_price ?? null, doc_type: d.source === 'deed' ? 'deed' : 'assignment', instrument: null, source_url: '' });
      const k = entityKey(d.assignee_name);
      if (d.assignee_email || d.assignee_phone) contact.set(k, { person: d.assignee_person ?? null, email: d.assignee_email ?? null, phone: d.assignee_phone ?? null });
    }
    st.counts.contract_buyers = txs.length;

    // 2 · the county deed index, by every wholesaler name we hold for this market.
    const portal = portalFor(county, state);
    const wholesalers = entities.filter((e) => (e.kind === 'wholesaler' || e.kind === 'both') && (!e.state || !state || e.state === state));
    if (portal && wholesalers.length) {
      const names = Array.from(new Set(wholesalers.map((e) => e.name))).slice(0, 25);
      send({ type: 'progress', stage: 'deeds', done: 0, total: names.length });
      const sinceDate = new Date(); sinceDate.setMonth(sinceDate.getMonth() - Math.max(f.months, 24));
      const r = await searchGrantors(portal, names, { maxPages: 2, since: sinceDate.toISOString().slice(0, 10) });
      await spend(ctx, 'deeds', r.pages);
      send({ type: 'progress', stage: 'deeds', done: names.length, total: names.length });
      if (r.error) st.notes.push(r.error);
      txs.push(...r.transactions);
      st.counts.deeds = r.transactions.length;
      if (r.transactions.length) {
        await recordDeedDeals(ctx, r.transactions.slice(0, 500).map((t) => ({
          workspace_id: ctx.ws, assignor_name: t.grantor, assignee_name: t.grantee, property_address: t.address, county: t.county, state: t.state,
          total_price: t.price, closing_date: t.date, leg: 'deed', source: 'deed', source_id: `${portal.county}:${t.instrument ?? `${t.grantor}|${t.grantee}|${t.date}`}`, source_url: t.source_url, raw: { doc_type: t.doc_type },
        })));
      }
    } else if (!portal && county && state && wholesalers.length) {
      // No adapter for this county: Claude finds its register of deeds and reads the index, cached a week.
      const names = Array.from(new Set(wholesalers.map((e) => e.name))).slice(0, 12);
      const sinceDate = new Date(); sinceDate.setMonth(sinceDate.getMonth() - Math.max(f.months, 24));
      const ck = `deeds:${county}|${state}|${addressKey(names.slice().sort().join(' '))}`.slice(0, 200).toLowerCase();
      send({ type: 'progress', stage: 'deeds', done: 0, total: names.length });
      let r = (await cachedDetail(ctx, ck)) as Awaited<ReturnType<typeof deedsByAgent>> | null;
      if (!r) {
        r = await deedsByAgent(county, state, names, { since: sinceDate.toISOString().slice(0, 10) });
        await spend(ctx, 'deeds', r.calls);
        if (!r.error) await putCache(ctx, [{ reapi_id: ck, detail: r }]);
      }
      send({ type: 'progress', stage: 'deeds', done: names.length, total: names.length });
      txs.push(...r.transactions);
      st.counts.deeds = r.transactions.length;
      if (r.error) st.notes.push(`${county} County deed index: ${r.error}.`);
      else if (!r.transactions.length) {
        const python = PYTHON_ONLY.find((x) => x.toLowerCase() === `${county} ${state}`.toLowerCase());
        st.notes.push(r.note ?? (python ? `${county} County's index needs a browser; the Buyr scraper reads it.` : `No deeds from these wholesalers in ${county} County, ${state} since ${sinceDate.toISOString().slice(0, 10)}.`));
      }
      if (r.transactions.length) {
        await recordDeedDeals(ctx, r.transactions.slice(0, 500).map((t) => ({
          workspace_id: ctx.ws, assignor_name: t.grantor, assignee_name: t.grantee, property_address: t.address, county: t.county, state: t.state,
          total_price: t.price, closing_date: t.date, leg: 'deed', source: 'deed', source_id: `${county}:${t.instrument ?? `${t.grantor}|${t.grantee}|${t.date}`}`, source_url: t.source_url, raw: { doc_type: t.doc_type, via: 'claude' },
        })));
      }
    } else if (!wholesalers.length) st.notes.push('No wholesalers on file for this market yet: harvest the Dispositions Drive or add them under Wholesalers.');

    const ranked: RankedBuyer[] = rankGrantees(txs, { aliasOf: famOf }).slice(0, Math.min(80, Math.max(1, Number(b.wholesaler_limit) || 40)));
    for (const g of ranked) {
      const existing = out.find((c) => c.key === g.key) ?? null;
      let made = granteeCandidate(g, existing, { lat: s.lat, lng: s.lng });
      const ct = contact.get(g.key);
      // A buyer we signed a contract with already has a person, an email and a phone: no skip trace needed.
      if (ct && !made.contacts) made = { ...made, contacts: [{ name: ct.person, phones: ct.phone ? [{ number: ct.phone, type: 'contract', dnc: false, score: 100 }] : [], emails: ct.email ? [ct.email] : [], mailing: null }], contacts_at: new Date().toISOString() };
      out = existing ? out.map((c) => (c.key === g.key ? made : c)) : [...out, made];
    }
    st.counts.wholesaler_buyers = ranked.length;
  }

  out = matchKnown(out, known) as Labelled[];
  remember(st, out, base);
  return decorate(out.filter((c) => base.has(c.key)), st);
}

/** Deeds a method read, into the wholesaler database (the entity rows first, then the deal rows). Best effort. */
async function recordDeedDeals(ctx: Ctx, rows: Record<string, unknown>[]) {
  try {
    const names = Array.from(new Set(rows.flatMap((r) => [String(r.assignor_name ?? ''), String(r.assignee_name ?? '')]).filter(Boolean)));
    const ents = names.map((n) => ({ workspace_id: ctx.ws, name: n, name_key: entityKey(n), kind: 'unknown', source: 'deed', state: rows.find((r) => r.assignor_name === n || r.assignee_name === n)?.state ?? null }));
    for (let i = 0; i < ents.length; i += 200) await ctx.admin.from('wholesaler_entities').upsert(ents.slice(i, i + 200), { onConflict: 'workspace_id,name_key', ignoreDuplicates: true });
    const { data } = await ctx.admin.from('wholesaler_entities').select('id, name_key').eq('workspace_id', ctx.ws).in('name_key', ents.map((e) => e.name_key));
    const idOf = new Map(((data ?? []) as Any[]).map((e) => [e.name_key, e.id]));
    const deals = rows.map((r) => ({ ...r, assignor_id: idOf.get(entityKey(String(r.assignor_name))) ?? null, assignee_id: idOf.get(entityKey(String(r.assignee_name))) ?? null }));
    for (let i = 0; i < deals.length; i += 200) await ctx.admin.from('wholesaler_deals').upsert(deals.slice(i, i + 200), { onConflict: 'workspace_id,source,source_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('genius-discover recordDeedDeals', String(e));
  }
}

async function discover(ctx: Ctx, b: Any, f: Filters, send: Send) {
  const maxRecords = Math.min(4000, Math.max(250, Number(b.max_records) || 2000));
  const enrichLimit = Math.min(150, Math.max(0, Number(b.enrich_limit ?? 60)));
  const skipLimit = Math.min(100, Math.max(0, Number(b.skip_limit ?? 40)));
  const methods = parseMethods(b.methods);
  const st: MethodState = { labels: new Map(), extras: new Map(), notes: [], counts: {} };

  const r = await resolveSubject(ctx, b);
  if ('error' in r) throw new ReapiError(r.error, r.status);
  const s = r.subject;
  send({ type: 'subject', subject: s });

  const { data: run } = await ctx.admin.from('discover_runs').insert({
    workspace_id: ctx.ws, deal_id: r.dealId, seller_id: r.sellerId, radius_mi: f.radius_mi, months: f.months, kinds: f.kinds,
    subject: s, address: [s.address, s.city, s.state].filter(Boolean).join(', '), filters: f, methods, status: 'running', created_by: ctx.userId,
  }).select('id').single();
  ctx.runId = run?.id ?? null;
  try {
    // 1 · How big is this? Counts are cheap; pulls are what cost.
    const plans = await counts(ctx, f, s);
    const total = plans.reduce((a, p) => a + p.count, 0);
    send({ type: 'scan_count', total, plans: plans.map((p) => ({ label: p.label, count: p.count })), ceiling: maxRecords });

    // 2 · Pull, union by property id, page by page.
    const hits = new Map<string, Hit>();
    let pulled = 0; let truncated = false;
    const todo = plans.filter((p) => p.count > 0);
    for (const p of todo) {
      for (let idx = 0; idx < p.count; idx += PAGE) {
        if (pulled >= maxRecords) { truncated = true; break; }
        const size = Math.min(PAGE, maxRecords - pulled);
        const j = await reapi('PropertySearch', { ...p.body, size, resultIndex: idx });
        const rows: Any[] = Array.isArray(j?.data) ? j.data : [];
        pulled += rows.length;
        await spend(ctx, 'search', rows.length);
        for (const row of rows) { const h = mapHit(row); if (h.reapi_id && !hits.has(h.reapi_id)) hits.set(h.reapi_id, h); }
        send({ type: 'progress', stage: 'search', done: pulled, total: Math.min(total, maxRecords) });
        if (rows.length < size) break;
      }
      if (truncated) break;
    }

    // 2b · Compare mode: ATTOM's sales around the same point, merged in without duplicates.
    const sources = new Map<string, Set<Source>>();
    let compare: Record<string, unknown> | null = null;
    if (b.compare) {
      try {
        const before = hits.size;
        const a = await attomHits(f, s, send, Math.min(1000, Math.max(100, Number(b.attom_max) || 400)));
        const m = mergeAttom(hits, a.hits, sources);
        const withOwner = a.hits.filter((h) => !!h.owner).length;
        compare = {
          reapi_properties: before, attom_sales: a.total, attom_with_owner: withOwner, both: m.matched, attom_only: m.added, reapi_only: Math.max(0, before - m.matched), attom_calls: a.calls,
          ...(a.hits.length && !withOwner ? { note: 'ATTOM sent no owner names on this account (assessment and owner detail both blank), so owners came from RealEstateAPI. Ask ATTOM to add owner data to the plan.' } : {}),
        };
      } catch (e) {
        compare = { error: (e as Error).message };
      }
      send({ type: 'compare', ...compare });
    }
    const tag = (l: Candidate[]) => (b.compare ? tagSources(l, sources) : l);
    const build = (contacts: Map<string, { hits: SkipHit[]; at: string }>) => decorate(tag(buildBuyers([...hits.values()], f, s, known, contacts)), st);

    // 3 · Buyers from what the search alone says.
    const known = await knownBuyers(ctx);
    const contacts = await cachedContacts(ctx);
    let list: Labelled[] = build(contacts);
    send({ type: 'buyers', candidates: list, properties_scanned: hits.size, partial: true });

    // 4 · Enrich the purchases that matter: the top buyers' unpriced buys and holds (sale history, MLS, rentals, agent, portfolio).
    const want = new Set<string>();
    // ATTOM-only properties have no RealEstateAPI id to enrich.
    for (const c of list.slice(0, enrichLimit)) for (const p of c.purchases) if ((p.price === null || p.role === 'hold') && !p.reapi_id.startsWith('attom:')) want.add(p.reapi_id);
    const ids = [...want].slice(0, enrichLimit * 2);
    if (ids.length) {
      const since = new Date(Date.now() - DETAIL_TTL_DAYS * 864e5).toISOString();
      const { data: cached } = await ctx.admin.from('genius_property_cache').select('reapi_id, detail').eq('workspace_id', ctx.ws).in('reapi_id', ids).gte('fetched_at', since);
      const have = new Map((cached ?? []).map((c: Any) => [c.reapi_id as string, c.detail]));
      const missing = ids.filter((id) => !have.has(id));
      let done = ids.length - missing.length;
      send({ type: 'progress', stage: 'enrich', done, total: ids.length });
      const fresh: { reapi_id: string; detail: Any }[] = [];
      await pool(missing, 5, async (id) => {
        const j = await reapi('PropertyDetail', { id: Number(id) });
        const d = j?.data ?? null;
        if (d) { have.set(id, d); fresh.push({ reapi_id: id, detail: d }); }
        done++;
        if (done % 5 === 0 || done === ids.length) send({ type: 'progress', stage: 'enrich', done, total: ids.length });
      });
      await spend(ctx, 'detail', missing.length);
      await putCache(ctx, fresh);
      for (const [id, d] of have) { const h = hits.get(id); if (h) hits.set(id, applyDetail(h, d)); }
      list = build(contacts);
      send({ type: 'buyers', candidates: list, properties_scanned: hits.size, partial: !!b.skip_trace || methods.length > 0 });
    }

    // 4b · The methods: label what the run found, add who it could not see.
    if (methods.length) {
      list = await runMethods(ctx, b, f, s, r.county, hits, list, known, methods, st, send);
      send({ type: 'methods', methods, counts: st.counts, notes: st.notes });
      send({ type: 'buyers', candidates: list, properties_scanned: hits.size, partial: !!b.skip_trace });
    }

    // 5 · Skip trace, only when asked: the top unphoned buyers, cache first.
    if (b.skip_trace && skipLimit) {
      const need = list.filter((c) => !c.contacts).slice(0, skipLimit);
      send({ type: 'progress', stage: 'skiptrace', done: 0, total: need.length });
      const res = await trace(ctx, need);
      const got = new Map<string, { hits: SkipHit[]; at: string }>(contacts);
      for (const [k, v] of Object.entries(res)) if ('hits' in v) got.set(k, { hits: v.hits, at: v.at });
      for (const [k, c] of st.extras) { const g = got.get(k); if (g && !c.contacts) st.extras.set(k, { ...c, contacts: g.hits, contacts_at: g.at }); }
      list = build(got);
      send({ type: 'progress', stage: 'skiptrace', done: need.length, total: need.length });
      send({ type: 'buyers', candidates: list, properties_scanned: hits.size, partial: false });
    }

    // 6 · Save, so the team reopens it for free.
    await ctx.admin.from('discover_runs').update({
      candidates: list, sales_scanned: total, properties_scanned: hits.size, buyer_count: list.length,
      ...(compare || st.notes.length || Object.keys(st.counts).length ? { filters: { ...f, ...(compare ? { compare } : {}), ...(methods.length ? { method_counts: st.counts, method_notes: st.notes } : {}) } } : {}),
      top_score: list[0]?.likelihood ?? null, credits: ctx.credits, status: 'done', finished_at: new Date().toISOString(),
    }).eq('id', ctx.runId);
    send({ type: 'done', run_id: ctx.runId, credits: ctx.credits, truncated, properties_scanned: hits.size, sales_scanned: total });
  } catch (e) {
    await ctx.admin.from('discover_runs').update({ status: 'error', error: (e as Error).message.slice(0, 500), credits: ctx.credits, finished_at: new Date().toISOString() }).eq('id', ctx.runId);
    throw e;
  }
}

// ---- entry ----------------------------------------------------------------------------------------------

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false } });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  if (!['owner', 'admin', 'dispositions', 'tc', 'member'].includes(member.role)) return json({ error: 'your role cannot run Genius Mode' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const ctx: Ctx = { ws, userId: who.user.id, admin, asCaller, credits: {}, runId: null };
  const action = String(b.action ?? '');
  const rl = action === 'autocomplete'
    ? await rateLimit(admin, `genius-ac:${who.user.id}`, 120, 60)
    : await rateLimit(admin, `genius:${who.user.id}`, 40, 60);
  if (!rl.allowed) return tooMany(cors, rl);

  try {
    if (action === 'autocomplete') {
      const q = String(b.q ?? '').trim().slice(0, 120);
      if (q.length < 3) return json({ results: [] });
      const j = await reapi('AutoComplete', { search: q, search_types: ['A'] });
      const results = (Array.isArray(j?.data) ? j.data : []).slice(0, 8).map((d: Any) => ({
        title: String(d?.title ?? d?.address ?? ''), address: String(d?.street ?? d?.address ?? ''),
        city: d?.city ?? null, state: d?.state ?? null, zip: d?.zip ?? null, reapi_id: d?.id != null ? String(d.id) : null,
        lat: Number(d?.latitude) || null, lng: Number(d?.longitude) || null,
      }));
      return json({ results });
    }

    if (action === 'estimate') {
      const f = parseFilters(b);
      const r = await resolveSubject(ctx, b);
      if ('error' in r) return json({ error: r.error }, r.status);
      const plans = await counts(ctx, f, r.subject);
      const total = plans.reduce((a, p) => a + p.count, 0);
      const ceiling = Math.min(4000, Math.max(250, Number(b.max_records) || 2000));
      return json({ subject: r.subject, total, plans: plans.map((p) => ({ label: p.label, count: p.count })), est_credits: Math.min(total, ceiling) + Math.min(150, Number(b.enrich_limit ?? 60)) * 2, ceiling });
    }

    if (action === 'portfolio') {
      const id = String(b.reapi_id ?? '').replace(/\D+/g, '');
      if (!id) return json({ error: 'reapi_id is required' }, 422);
      let d = await cachedDetail(ctx, id);
      if (!d) {
        const block = await overBudget(ctx); if (block) return json({ error: block }, 402);
        const j = await reapi('PropertyDetail', { id: Number(id) });
        d = j?.data ?? null;
        await spend(ctx, 'detail', 1);
        if (d) await putCache(ctx, [{ reapi_id: id, detail: d }]);
      }
      const lp = d?.linkedProperties ?? {};
      const ids: number[] = (Array.isArray(lp.ids) ? lp.ids : []).map(Number).filter(Number.isFinite).slice(0, 100);
      let properties: Any[] = [];
      if (ids.length) {
        const pk = `portfolio:${id}`;
        let rows: Any[] = ((await cachedDetail(ctx, pk)) as Any[] | null) ?? [];
        if (!rows.length) {
          const j = await reapi('PropertySearch', { ids, size: ids.length });
          rows = Array.isArray(j?.data) ? j.data : [];
          await spend(ctx, 'search', rows.length);
          await putCache(ctx, [{ reapi_id: pk, detail: rows }]);
        }
        properties = rows.map(mapHit).map((h) => ({
          reapi_id: h.reapi_id, address: h.address, city: h.city, state: h.state, zip: h.zip, lat: h.lat, lng: h.lng,
          property_type: h.property_type, beds: h.beds, baths: h.baths, sqft: h.sqft, est_value: h.est_value,
          last_sale_date: h.last_sale_date, last_sale_amount: h.last_sale_amount ?? h.mls_sold_price,
        })).sort((a, b) => String(b.last_sale_date ?? '').localeCompare(String(a.last_sale_date ?? '')));
      }
      return json({ total: Number(lp.totalOwned) || ids.length || null, value: Number(lp.totalValue) || null, properties });
    }

    // Who owns one address, whatever county it is in: ATTOM, then RealEstateAPI, then the county's own record through Claude.
    if (action === 'owner') {
      const address = String(b.address ?? '').trim().slice(0, 200);
      if (!address) return json({ error: 'address is required' }, 422);
      const ck = `owner:${addressKey(address)}`;
      const hit = await cachedDetail(ctx, ck);
      if (hit) return json({ ...hit, cached: true });
      const block = await overBudget(ctx); if (block) return json({ error: block }, 402);
      const tried: string[] = [];
      let found: Any = null;
      if ((Deno.env.get('ATTOM_API_KEY') ?? '').trim()) {
        try {
          const o = await attom('property/detailowner', { address });
          const q = Array.isArray(o?.property) ? o.property[0] : null;
          const name = attomOwnerName(q);
          if (name) {
            const own = at(q, 'owner') ?? {};
            found = { owner: name, mailing: String(at(own, 'mailingAddressOneLine') ?? '') || null, source: 'attom', source_url: null };
          } else tried.push('ATTOM had no owner name');
        } catch (e) { tried.push(`ATTOM: ${(e as Error).message}`); }
      }
      if (!found && (Deno.env.get('REAL_ESTATE_API_API_KEY') ?? '').trim()) {
        try {
          const j = await reapi('PropertySearch', { address, size: 1 });
          const row = Array.isArray(j?.data) ? j.data[0] : null;
          await spend(ctx, 'search', row ? 1 : 0);
          const h = row ? mapHit(row) : null;
          if (h?.owner?.name) found = { owner: h.owner.name, mailing: h.owner_mailing, last_sale_date: h.last_sale_date, last_sale_price: h.last_sale_amount, source: 'realestateapi', source_url: null };
          else tried.push('RealEstateAPI had no owner name');
        } catch (e) { tried.push(`RealEstateAPI: ${(e as Error).message}`); }
      }
      if (!found) {
        const r = await ownerByAgent(address);
        await spend(ctx, 'scrape', r.calls);
        if (r.owner?.owner) found = { ...r.owner, source: 'county' };
        else tried.push(r.error ?? r.owner?.note ?? 'the county record had no owner');
      }
      if (!found) return json({ owner: null, tried });
      await putCache(ctx, [{ reapi_id: ck, detail: found }]);
      return json({ ...found, tried, credits: ctx.credits });
    }

    if (action === 'skiptrace') {
      const targets: TraceIn[] = (Array.isArray(b.targets) ? b.targets : []).slice(0, 100).map((t: Any) => ({
        key: String(t?.key ?? ''), owner_name: String(t?.owner_name ?? ''), corporate: !!t?.corporate,
        people: Array.isArray(t?.people) ? t.people.map(String) : [], mail_parts: t?.mail_parts ?? null, mailing: t?.mailing ?? null,
        purchases: Array.isArray(t?.purchases) ? t.purchases.slice(0, 3) : [],
      })).filter((t: TraceIn) => t.key);
      if (!targets.length) return json({ error: 'targets is required' }, 422);
      const block = await overBudget(ctx); if (block) return json({ error: block }, 402);
      const results = await trace(ctx, targets);
      // Write what we found back onto the saved run, so reopening it shows the phones.
      if (b.run_id) {
        const { data: run } = await asCaller.from('discover_runs').select('id, candidates').eq('id', Number(b.run_id)).eq('workspace_id', ws).maybeSingle();
        if (run) {
          const cands = (run.candidates as Any[]).map((c) => {
            const r = results[c.key];
            return r && 'hits' in r ? { ...c, contacts: r.hits, contacts_at: r.at } : c;
          });
          await admin.from('discover_runs').update({ candidates: cands }).eq('id', run.id);
        }
      }
      return json({ results, credits: ctx.credits });
    }

    if (action === 'discover') {
      key();
      const block = await overBudget(ctx); if (block) return json({ error: block }, 402);
      const f = parseFilters(b);
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(ctrl) {
          const send: Send = (o) => { try { ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch { /* client went away */ } };
          try { await discover(ctx, b, f, send); }
          catch (e) { console.error('genius-discover run', String(e)); send({ type: 'error', error: e instanceof ReapiError || e instanceof BatchDataError ? e.message : 'Genius Mode hit an error on our side. Try again in a moment.', run_id: ctx.runId }); }
          finally { try { ctrl.close(); } catch { /* closed */ } }
        },
      });
      return new Response(stream, { headers: { ...cors, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    if (e instanceof ReapiError || e instanceof BatchDataError) return json({ error: e.message }, e.status);
    console.error('genius-discover', String(e));
    return json({ error: 'Genius Mode hit an error on our side. Try again in a moment.' }, 500);
  }
});
