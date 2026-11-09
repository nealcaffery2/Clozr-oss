/**
 * POST /skip-trace: phones and emails for CRM owners (People, Buyers, a seller
 * or buyer record). Individuals and LLCs trace on RealEstateAPI
 * (REAL_ESTATE_API_API_KEY); BatchData (BATCHDATA_API_KEY,
 * _shared/batchdata.ts) is wired but off. Results cache per workspace for 90
 * days in genius_skip_cache and every paid lookup lands in the credit ledger.
 *
 * Body: { workspace_id, action: 'skiptrace', targets: TraceIn[] }
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, tooMany } from '../_shared/security.ts';
import { BatchDataError, fatal, skipTrace } from '../_shared/batchdata.ts';
import {
  type Any, type Candidate, type SkipHit, type SkipProvider, type SkipRequest,
  mapSkipBatch, mapSkipReapi, mergeSkipHits, skipTarget,
} from '../_shared/property-data.ts';

const REAPI = 'https://api.realestateapi.com/v2';
const PAGE = 250;                 // PropertySearch's per-request ceiling.
const DETAIL_TTL_DAYS = 30;
const SKIP_TTL_DAYS = 90;
// BatchData is off (its key stopped working 2026-10-10): every owner, LLCs too, traces on RealEstateAPI alone.
// ponytail: hard switch; flip to true once BATCHDATA_API_KEY works again.
const BATCH_ON = false;


class ReapiError extends Error { constructor(msg: string, public status = 502) { super(msg); } }

function key(): string {
  const k = (Deno.env.get('REAL_ESTATE_API_API_KEY') ?? '').trim();
  if (!k) throw new ReapiError('Skip trace is not connected: set the REAL_ESTATE_API_API_KEY secret on the Supabase project.', 503);
  return k;
}

async function reapi(path: 'PropertySearch' | 'PropertyDetail' | 'SkipTrace' | 'AutoComplete', body: Record<string, unknown>): Promise<Any> {
  const res = await fetch(`${REAPI}/${path}`, {
    method: 'POST',
    headers: { 'x-api-key': key(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 401 || res.status === 403) throw new ReapiError('RealEstateAPI rejected the key — check REAL_ESTATE_API_API_KEY on the Supabase project.', 503);
  if (res.status === 402) throw new ReapiError('RealEstateAPI is out of credits — top up the account at realestateapi.com, then try again.', 402);
  if (res.status === 429) throw new ReapiError('RealEstateAPI is rate limiting this account right now. Try again in a minute.', 429);
  if (res.status === 404 && path === 'PropertyDetail') return null;
  if (!res.ok) throw new ReapiError(`RealEstateAPI answered ${res.status} on ${path}.`);
  return await res.json();
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

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
    ? `This workspace has used its data credits for the month (${b.used.toLocaleString('en-US')} of ${b.cap.toLocaleString('en-US')}). An owner can raise the cap in Settings.`
    : null;
}

type TraceIn = Pick<Candidate, 'key' | 'owner_name' | 'corporate' | 'people' | 'mail_parts' | 'mailing' | 'purchases'>;

/** Skip trace each target: cache first, then RealEstateAPI for everyone; LLCs also BatchData, merged. */
async function trace(ctx: Ctx, targets: TraceIn[]): Promise<Record<string, { hits: SkipHit[]; cached: boolean; at: string } | { error: string }>> {
  const since = new Date(Date.now() - SKIP_TTL_DAYS * 864e5).toISOString();
  const plans = targets.map((t) => ({ t, plan: skipTarget(t) }));
  const keys = plans.map((p) => p.plan?.owner_key).filter((k): k is string => !!k);
  const { data: hit } = keys.length
    ? await ctx.admin.from('genius_skip_cache').select('owner_key, hits, fetched_at').eq('workspace_id', ctx.ws).in('owner_key', keys).gte('fetched_at', since)
    : { data: [] };
  const cache = new Map((hit ?? []).map((r: Any) => [r.owner_key as string, r]));
  const out: Record<string, { hits: SkipHit[]; cached: boolean; at: string } | { error: string }> = {};
  type Work = { ts: TraceIn[]; useBatch: boolean; body: SkipRequest; reapi: Record<string, string>; reapiHits?: SkipHit[]; reapiErr?: string | null };
  const todo = new Map<string, Work>();
  for (const { t, plan } of plans) {
    if (!plan) { out[t.key] = { error: 'No address to trace this owner at.' }; continue; }
    const c = cache.get(plan.owner_key);
    if (c) { out[t.key] = { hits: c.hits, cached: true, at: c.fetched_at }; continue; }
    const q = todo.get(plan.owner_key);
    if (q) q.ts.push(t);
    else todo.set(plan.owner_key, { ts: [t], useBatch: plan.useBatch, body: plan.body, reapi: plan.reapi });
  }
  if (!todo.size) return out;

  const at = new Date().toISOString();
  const rows: Any[] = [];
  let paid = 0; let stop: Error | null = null;
  const settle = (q: Work, r: { hits: SkipHit[]; cached: boolean; at: string } | { error: string }) => { for (const t of q.ts) out[t.key] = r; };
  const keep = (owner_key: string, q: Work, hits: SkipHit[], provider: SkipProvider) => {
    rows.push({ workspace_id: ctx.ws, owner_key, owner_name: q.ts[0].owner_name, hits, provider, fetched_at: at, fetched_by: ctx.userId });
    settle(q, { hits, cached: false, at });
  };
  const owners = [...todo.entries()];
  try {
    let reapiOut = false;
    // 1 · RealEstateAPI for every owner (LLCs: mail/property address, no names).
    await pool(owners, 4, async ([owner_key, q]) => {
      if (stop) { q.reapiErr = stop.message; return; }
      if (reapiOut) return;
      try {
        const j = await reapi('SkipTrace', q.reapi);
        paid++;
        q.reapiHits = mapSkipReapi(j);
      } catch (e) {
        if (e instanceof ReapiError && (e.status === 402 || e.status === 503)) { reapiOut = true; return; }
        if (e instanceof ReapiError && e.status === 429 && !stop) stop = e;
        q.reapiErr = (e as Error).message;
      }
    });

    const batchQueue = BATCH_ON ? owners.filter(([_, q]) => q.useBatch || reapiOut || !(q.reapiHits?.length)) : [];
    const reapiOnly = BATCH_ON ? owners.filter(([_, q]) => !q.useBatch && !reapiOut && q.reapiHits !== undefined) : owners;

    for (const [owner_key, q] of reapiOnly) {
      if (stop && !q.reapiHits?.length) { settle(q, { error: stop.message }); continue; }
      if (q.reapiErr && !q.reapiHits?.length) { settle(q, { error: q.reapiErr }); continue; }
      if (q.reapiHits === undefined) { settle(q, { error: 'RealEstateAPI is not answering skip traces right now. Try again later.' }); continue; }
      // An LLC RealEstateAPI found nothing for is not cached, so BatchData can try it once it is back on.
      if (q.useBatch && !q.reapiHits.length) { settle(q, { hits: [], cached: false, at }); continue; }
      keep(owner_key, q, q.reapiHits, 'reapi');
    }

    // 2 · BatchData for LLCs (always, merged with RealEstateAPI) and individuals RealEstateAPI missed.
    if (batchQueue.length) {
      const { answers, billed } = await skipTrace(batchQueue.map(([, q]) => q.body));
      paid += billed;
      batchQueue.forEach(([owner_key, q], i) => {
        const d = answers[i];
        if (d instanceof BatchDataError) {
          if (q.reapiHits?.length) keep(owner_key, q, q.reapiHits, 'reapi');
          else { settle(q, { error: d.message }); if (fatal(d) && !stop) stop = d; }
          return;
        }
        if (d?.meta?.error) {
          if (q.reapiHits?.length) keep(owner_key, q, q.reapiHits, 'reapi');
          else settle(q, { error: 'BatchData could not trace this owner. Try again later.' });
          return;
        }
        const batchHits = mapSkipBatch(d);
        const merged = mergeSkipHits(q.reapiHits ?? [], batchHits);
        const provider: SkipProvider = batchHits.length ? 'batchdata' : 'reapi';
        if (merged.length || !q.reapiErr) keep(owner_key, q, merged, provider);
        else if (q.reapiErr) settle(q, { error: q.reapiErr });
        else keep(owner_key, q, [], provider);
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
  if (!['owner', 'admin', 'dispositions', 'tc', 'member'].includes(member.role)) return json({ error: 'your role cannot skip trace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const ctx: Ctx = { ws, userId: who.user.id, admin, asCaller, credits: {}, runId: null };
  const action = String(b.action ?? '');
  const rl = await rateLimit(admin, `skiptrace:${who.user.id}`, 40, 60);
  if (!rl.allowed) return tooMany(cors, rl);

  try {
    if (action === 'skiptrace') {
      const targets: TraceIn[] = (Array.isArray(b.targets) ? b.targets : []).slice(0, 100).map((t: Any) => ({
        key: String(t?.key ?? ''), owner_name: String(t?.owner_name ?? ''), corporate: !!t?.corporate,
        people: Array.isArray(t?.people) ? t.people.map(String) : [], mail_parts: t?.mail_parts ?? null, mailing: t?.mailing ?? null,
        purchases: Array.isArray(t?.purchases) ? t.purchases.slice(0, 3) : [],
      })).filter((t: TraceIn) => t.key);
      if (!targets.length) return json({ error: 'targets is required' }, 422);
      const block = await overBudget(ctx); if (block) return json({ error: block }, 402);
      const results = await trace(ctx, targets);
      return json({ results, credits: ctx.credits });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    if (e instanceof ReapiError || e instanceof BatchDataError) return json({ error: e.message }, e.status);
    console.error('skip-trace', String(e));
    return json({ error: 'Skip trace hit an error on our side. Try again in a moment.' }, 500);
  }
});
