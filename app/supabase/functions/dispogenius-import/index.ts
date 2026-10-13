/**
 * POST /dispogenius-import — bring Dispo Genius deals, and the buyers working
 * them, into CLOZR.
 *
 * Body: { workspace_id, action, ... }
 *   status   → { connected }
 *   deals    { page?, limit?, search?, status? } → { count, next, previous, results }
 *   preview  { deal_id } → { deal, buyers, matches: [{ dg, existing_buyer_id, by }] }
 *   import   { deal_ids: number[] } → { counts, errors }
 *
 * Who: owner, admin or dispositions on workspace_id, checked with the caller's
 * JWT; the service role then does the writing. The API key is the
 * DISPOGENIUS_API_KEY project secret, read only here and never returned — it is
 * location-scoped and a leaked one exposes that whole location's buyer list.
 *
 * Dispo Genius (api.dispogenius.io), all Bearer-authed, 30 req/min per key:
 *   GET /api/v1/deals                 paginated { count, next, previous, results }
 *   GET /api/v1/deals/{id}/           one deal, 49 fields
 *   GET /api/v1/{deal_id}/buyers      paginated buyer interactions for a deal
 *
 * Idempotent. Deals carry source='dispogenius', source_id=<deal id>; buyers
 * carry source_id='dg:<phone-or-email-key>' only when they were created here.
 * A buyer already in CLOZR is matched, never duplicated — phone first, then
 * email — and an existing row is filled, never overwritten, because CLOZR is
 * the system of record and Dispo Genius is a source.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import {
  type Any, type DgBuyer, clampScore, dealPatch, emailKey, matchBuyer, matchStatus, num, phoneKey, splitAddress,
} from '../_shared/dispogenius-map.ts';

const DG = 'https://api.dispogenius.io';

/** The nine workflow statuses the API accepts. Anything else matches nothing. */
const DG_STATUSES = [
  'Pre Marketing', 'Waiting for Responses', 'Waiting for Interest', 'Interested Buyers',
  'Offer Received', 'Offer Accepted', 'Pending', 'Closed', 'Cancelled',
] as const;

/**
 * One authenticated GET. Throws with the reason: a revoked key, a rate limit
 * and an empty location are three different problems and only one of them is
 * worth retrying.
 */
async function dg(path: string, params: Record<string, string> = {}): Promise<Any> {
  const key = (Deno.env.get('DISPOGENIUS_API_KEY') ?? '').trim();
  if (!key) throw new Error('Dispo Genius is not connected: set the DISPOGENIUS_API_KEY secret on the Supabase project.');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${DG}${path}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new Error('Dispo Genius rejected the key — check DISPOGENIUS_API_KEY, and that it is a production key.');
  if (res.status === 404) throw new Error('Dispo Genius has no such deal or page.');
  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    throw new Error(`Dispo Genius is rate limiting this key${retry ? ` — try again in ${retry}s` : ''}.`);
  }
  if (!res.ok) throw new Error(`Dispo Genius answered ${res.status}.`);
  return await res.json();
}

/**
 * Walk a paginated endpoint. `next` is an absolute URL built by their server,
 * so the origin is checked before the bearer token follows it, and a repeated
 * URL stops the walk rather than looping forever.
 */
async function dgAll(path: string, params: Record<string, string> = {}, cap = 10): Promise<Any[]> {
  const out: Any[] = [];
  const seen = new Set<string>();
  let page: Any = await dg(path, { ...params, limit: '100' });
  for (let i = 0; i < cap; i++) {
    out.push(...(Array.isArray(page?.results) ? page.results : []));
    const next: string | null = page?.next ?? null;
    if (!next || seen.has(next)) break;
    seen.add(next);
    let u: URL;
    try { u = new URL(next); } catch { break; }
    if (u.origin !== DG) break; // never send the token to another origin
    page = await dg(u.pathname, Object.fromEntries(u.searchParams));
  }
  return out;
}

async function importDeal(admin: SupabaseClient, ws: number, userId: string, dgDealId: number) {
  const detail = await dg(`/api/v1/deals/${dgDealId}/`);
  const src = String(dgDealId);

  // The property, on the database's own address key, so a deal that also came
  // in from Podio or an import lands on the same row rather than a second one.
  let propertyId: number | null = null;
  const addr = splitAddress(detail?.property_address);
  if (addr?.line1) {
    const { data: key } = await admin.rpc('address_key', { p_line1: addr.line1, p_city: addr.city, p_state: addr.state, p_zip: addr.zip });
    const hit = key ? (await admin.from('properties').select('id').eq('workspace_id', ws).eq('address_key', key).limit(1)).data?.[0] : null;
    if (hit) propertyId = hit.id as number;
    else {
      const { data } = await admin.from('properties')
        .insert({ workspace_id: ws, line1: addr.line1, city: addr.city || null, state: addr.state || null, zip: addr.zip || null, source: 'dispogenius', source_id: src })
        .select('id').single();
      propertyId = (data?.id as number) ?? null;
    }
  }

  const { data: existingDeal } = await admin.from('deals')
    .select('id').eq('workspace_id', ws).eq('source', 'dispogenius').eq('source_id', src).maybeSingle();

  let dealId: number;
  if (existingDeal) {
    dealId = existingDeal.id as number;
    const patch = { ...dealPatch(detail), ...(propertyId ? { property_id: propertyId } : {}) };
    if (Object.keys(patch).length) await admin.from('deals').update(patch).eq('id', dealId);
  } else {
    const { data, error } = await admin.from('deals')
      .insert({ workspace_id: ws, ...dealPatch(detail), ...(propertyId ? { property_id: propertyId } : {}), source: 'dispogenius', source_id: src, created_by: userId })
      .select('id').single();
    if (error) throw new Error(`deal ${dgDealId}: ${error.message}`);
    dealId = data!.id as number;
  }

  // Everyone already in the workspace, keyed the way the matcher keys them.
  const { data: buyers } = await admin.from('buyers').select('id, phone, email').eq('workspace_id', ws);
  const byPhone = new Map<string, number>();
  const byEmail = new Map<string, number>();
  for (const b of (buyers ?? []) as Any[]) {
    const p = phoneKey(b.phone); if (p && !byPhone.has(p)) byPhone.set(p, b.id);
    const e = emailKey(b.email); if (e && !byEmail.has(e)) byEmail.set(e, b.id);
  }

  const rows = await dgAll(`/api/v1/${dgDealId}/buyers`);
  const counts = { buyers_created: 0, buyers_matched: 0, buyers_skipped: 0, matches: 0 };

  for (const row of rows) {
    const b: DgBuyer | null = row?.buyer ?? null;
    // An orphaned interaction has no buyer profile left to import.
    if (!b) { counts.buyers_skipped++; continue; }
    // Without a phone or an email there is nothing to dedupe on, and a
    // name-only row is how a buyer list grows three copies of one person.
    const p = phoneKey(b.phone); const e = emailKey(b.email);
    if (!p && !e) { counts.buyers_skipped++; continue; }

    const hit = matchBuyer(b, byPhone, byEmail);
    let buyerId: number;
    if (hit) {
      buyerId = hit.id;
      counts.buyers_matched++;
      // Fill the gaps, never overwrite: CLOZR is the record, this is a source.
      const { data: cur } = await admin.from('buyers').select('phone, email, buyer_type').eq('id', buyerId).single();
      const fill: Record<string, unknown> = {};
      if (!cur?.phone && b.phone) fill.phone = b.phone;
      if (!cur?.email && b.email) fill.email = b.email;
      if (!cur?.buyer_type && b.type) fill.buyer_type = b.type;
      if (Object.keys(fill).length) await admin.from('buyers').update(fill).eq('id', buyerId);
    } else {
      const { data, error } = await admin.from('buyers').insert({
        workspace_id: ws, name: b.full_name ?? b.email ?? b.phone ?? 'Unknown buyer',
        phone: b.phone, email: b.email, buyer_type: b.type,
        // 'active' is the only status this workspace uses; an inactive buyer is
        // expressed by active_again_at, not by a status the app cannot read.
        status: 'active',
        ...(b.is_active ? {} : { active_again_at: null }),
        source: 'dispogenius', source_id: `dg:${p ?? e}`, created_by: userId,
      }).select('id').single();
      if (error) { counts.buyers_skipped++; continue; }
      buyerId = data!.id as number;
      counts.buyers_created++;
      if (p) byPhone.set(p, buyerId);
      if (e) byEmail.set(e, buyerId);
    }

    // The engagement Dispo Genius already tracked for this deal.
    const temp = String(row?.temperature ?? '').toLowerCase();
    await admin.from('deal_buyer_matches').upsert({
      workspace_id: ws, deal_id: dealId, buyer_id: buyerId,
      score: clampScore(row?.probability_score),
      status: matchStatus(row?.status),
      reasons: ['imported from Dispo Genius'],
      ...(temp === 'hot' || temp === 'warm' || temp === 'cold' ? { temperature: temp } : {}),
    }, { onConflict: 'deal_id,buyer_id' });
    counts.matches++;
  }
  return { deal_id: dealId, ...counts };
}

// ---------------------------------------------------------------- handler

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  if (!['owner', 'admin', 'dispositions'].includes(member.role)) return json({ error: 'your role cannot import from Dispo Genius' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  if (b.action === 'status') return json({ connected: !!(Deno.env.get('DISPOGENIUS_API_KEY') ?? '').trim() });

  // Their limit is 30/min per key and one import walks several pages, so the
  // gate here is tighter than the usual browser-facing one.
  const rl = await rateLimit(admin, `dispogenius:${ws}`, 10, 60);
  if (!rl.allowed) return tooMany(cors, rl);

  try {
    if (b.action === 'deals') {
      const params: Record<string, string> = {
        page: String(Math.max(1, Math.round(Number(b.page) || 1))),
        limit: String(Math.min(100, Math.max(1, Math.round(Number(b.limit) || 25)))),
      };
      if (b.search) params.search = String(b.search);
      if (b.status) {
        // Only the documented values; an unsupported one silently matches nothing.
        const wanted = String(b.status).split(',').map((x) => x.trim()).filter((x) => (DG_STATUSES as readonly string[]).includes(x));
        if (wanted.length) params.status = wanted.join(',');
      }
      const page = await dg('/api/v1/deals', params);
      return json({ count: page?.count ?? 0, next: page?.next ?? null, previous: page?.previous ?? null, results: page?.results ?? [] });
    }

    if (b.action === 'preview') {
      const id = Number(b.deal_id);
      if (!Number.isInteger(id)) return json({ error: 'deal_id must be an integer' }, 422);
      const [deal, rows] = [await dg(`/api/v1/deals/${id}/`), await dgAll(`/api/v1/${id}/buyers`)];
      const { data: buyers } = await admin.from('buyers').select('id, phone, email').eq('workspace_id', ws);
      const byPhone = new Map<string, number>(); const byEmail = new Map<string, number>();
      for (const x of (buyers ?? []) as Any[]) {
        const p = phoneKey(x.phone); if (p && !byPhone.has(p)) byPhone.set(p, x.id);
        const e = emailKey(x.email); if (e && !byEmail.has(e)) byEmail.set(e, x.id);
      }
      const matches = rows.map((r: Any) => {
        const hit = r?.buyer ? matchBuyer(r.buyer, byPhone, byEmail) : null;
        return { dg: r?.buyer ?? null, temperature: r?.temperature ?? null, probability_score: r?.probability_score ?? null,
          existing_buyer_id: hit?.id ?? null, by: hit?.by ?? null };
      });
      return json({ deal, buyers: rows.length, matches });
    }

    if (b.action === 'import') {
      const ids: number[] = Array.isArray(b.deal_ids) ? b.deal_ids.map(Number).filter(Number.isInteger) : [];
      if (!ids.length) return json({ error: 'deal_ids is required' }, 422);
      // Their rate limit, and the edge wall clock, both argue for small batches.
      if (ids.length > 5) return json({ error: 'Import at most 5 deals per call.' }, 422);
      const imported = []; const errors: string[] = [];
      for (const id of ids) {
        try { imported.push(await importDeal(admin, ws, who.user.id, id)); }
        catch (e) { errors.push(`deal ${id}: ${(e as Error).message}`); }
      }
      return json({ imported, errors });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    // Their refusals are the operator's problem to fix, so they are passed
    // through; anything else stays generic and goes to the log.
    if (/Dispo Genius/.test(msg)) return json({ error: msg }, 502);
    return serverError(cors, 'dispogenius-import', e);
  }
});
