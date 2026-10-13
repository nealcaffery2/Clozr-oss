/**
 * POST /dispogenius-sync — the bridge from section 09 of the teardown.
 *
 * DispoGenius's Genius View is a stream of LABELLED OUTCOMES: which buyer
 * engaged, replied, offered, and at what percentage of ARV. Our own match score
 * has never been validated against anything. Staging their outcomes beside our
 * scores is what turns guessed weights into calibrated ones.
 *
 * Two phases, both read-only against DispoGenius — it polls, never pushes, so
 * running it cannot disturb a live campaign on their side.
 *
 *   link  GET /api/v1/deals        -> match their deals to ours on normalised
 *                                     address and fill deals.dispogenius_deal_id
 *   poll  GET /api/v1/{id}/buyers  -> append today's snapshot per buyer
 *
 * Linking is automatic on purpose. Hand-mapping deal ids is exactly the kind of
 * chore that never gets done, and the bridge is worthless until it is.
 *
 * Snapshots are append-only, one row per buyer per UTC day: the trajectory is
 * the signal, and a buyer who cooled over three weeks is not the same as one
 * who was never warm.
 *
 * Called nightly by pg_cron (dispogenius_sync_kick) with the vault's service
 * key. The service role only (the project's service key or the cron's vault
 * key, as `Authorization: Bearer …`): it writes to any workspace. This lived
 * only in the dashboard behind a static token in the source; that token no
 * longer opens anything, and migration 206 takes it out of the kick.
 *
 * Secrets: DISPOGENIUS_API_KEY, optionally DISPOGENIUS_API_URL.
 * Body: { action?: 'sync'|'link'|'poll', workspace_id?, limit?, dry_run? }
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { bearerOf, HARDENING, isServiceCaller } from '../_shared/security.ts';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...HARDENING, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
type Any = any;

const pick = (o: Any, ...paths: string[]): Any => {
  for (const p of paths) {
    const v = p.split('.').reduce((a: Any, k) => (a == null ? undefined : a[k]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null =>
  v === null || v === undefined ? null : v === true || v === 'true' || v === 1 || v === '1';

/**
 * Street suffixes and directionals vary freely between systems ("123 Oak St NW"
 * vs "123 OAK STREET NORTHWEST"), so both sides collapse to the same token set
 * before comparison. Without this the match rate is near zero on real data.
 */
const SUFFIX: Record<string, string> = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave',
  drive: 'dr', dr: 'dr', road: 'rd', rd: 'rd', lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct', circle: 'cir', cir: 'cir', boulevard: 'blvd', blvd: 'blvd',
  place: 'pl', pl: 'pl', terrace: 'ter', ter: 'ter', trail: 'trl', trl: 'trl',
  parkway: 'pkwy', pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy', way: 'way',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};
function normAddr(line1: unknown): string {
  return String(line1 ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SUFFIX[w] ?? w)
    .join(' ')
    .trim();
}
const zip5 = (v: unknown) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 5 ? d.slice(0, 5) : '';
};

/** The docs are not explicit about the auth header, so settle it once per run. */
async function resolveAuth(base: string, key: string): Promise<Record<string, string> | null> {
  const schemes: Record<string, string>[] = [
    { Authorization: `Bearer ${key}` },
    { 'Api-Key': key },
    { 'X-API-Key': key },
  ];
  for (const h of schemes) {
    try {
      const res = await fetch(`${base}/api/v1/deals?page=1&page_size=1`, {
        headers: { ...h, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return h;
    } catch (_e) { /* try the next scheme */ }
  }
  return null;
}

/** Phase 1: fill deals.dispogenius_deal_id by matching normalised addresses. */
async function linkDeals(admin: SupabaseClient, base: string, auth: Record<string, string>,
                         workspace: number, dryRun: boolean) {
  const { data: ours } = await admin
    .from('deals')
    .select('id, dispogenius_deal_id, property_id, properties(line1, city, state, zip)')
    .eq('workspace_id', workspace)
    .is('closed_on', null);

  // Key on normalised street + zip, and on street + city as a fallback, because
  // one side often carries a zip the other does not.
  const byKey = new Map<string, number>();
  for (const d of (ours ?? []) as Any[]) {
    if (d.dispogenius_deal_id) continue;
    const p = Array.isArray(d.properties) ? d.properties[0] : d.properties;
    const street = normAddr(p?.line1);
    if (!street) continue;
    const z = zip5(p?.zip);
    const city = String(p?.city ?? '').toLowerCase().trim();
    if (z) byKey.set(`${street}|${z}`, d.id);
    if (city) byKey.set(`${street}|${city}`, d.id);
  }
  if (byKey.size === 0) return { linked: 0, scanned: 0 };

  let linked = 0;
  let scanned = 0;
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${base}/api/v1/deals?page=${page}&page_size=100`, {
      headers: { ...auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) break;
    const j: Any = await res.json();
    const list: Any[] = Array.isArray(j) ? j : (j?.results ?? j?.deals ?? j?.data ?? []);
    if (list.length === 0) break;
    scanned += list.length;

    for (const x of list) {
      const street = normAddr(pick(x, 'address', 'street_address', 'property.address', 'property.line1', 'address_line_1'));
      if (!street) continue;
      const z = zip5(pick(x, 'zip', 'zip_code', 'postal_code', 'property.zip'));
      const city = String(pick(x, 'city', 'property.city') ?? '').toLowerCase().trim();
      const ourId = (z ? byKey.get(`${street}|${z}`) : undefined)
        ?? (city ? byKey.get(`${street}|${city}`) : undefined);
      if (!ourId) continue;
      const theirId = pick(x, 'id', 'deal_id', 'opportunity_id');
      if (!theirId) continue;
      if (!dryRun) {
        await admin.from('deals')
          .update({ dispogenius_deal_id: String(theirId) })
          .eq('id', ourId).is('dispogenius_deal_id', null);
      }
      linked++;
      byKey.delete(`${street}|${z}`);
      if (city) byKey.delete(`${street}|${city}`);
    }
    if (list.length < 100) break;
  }
  return { linked, scanned };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } });
  if (!(await isServiceCaller(admin, bearerOf(req)))) return json({ error: 'service role only' }, 403);

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }

  const action = String(b?.action ?? 'sync');
  const dryRun = b.dry_run === true;
  const key = (Deno.env.get('DISPOGENIUS_API_KEY') ?? '').trim();
  const base = (Deno.env.get('DISPOGENIUS_API_URL') ?? 'https://api.dispogenius.io').replace(/\/$/, '');

  const { data: ws } = await admin.from('workspaces').select('id').order('id').limit(1).maybeSingle();
  const workspace = Number(b.workspace_id ?? ws?.id);
  if (!Number.isFinite(workspace)) return json({ error: 'no workspace' }, 422);

  // No key: record it once, not once a night. A run log full of identical
  // skips would hide a real failure.
  if (!key) {
    const { data: last } = await admin.from('dispogenius_sync_runs')
      .select('status').eq('workspace_id', workspace)
      .order('started_at', { ascending: false }).limit(1).maybeSingle();
    if (last?.status !== 'skipped') {
      await admin.from('dispogenius_sync_runs').insert({
        workspace_id: workspace, status: 'skipped',
        error: 'DISPOGENIUS_API_KEY is not set on this project.',
        finished_at: new Date().toISOString(),
      });
    }
    return json({ ok: false, error: 'DISPOGENIUS_API_KEY is not set on this project.' }, 503);
  }

  const { data: run } = await admin.from('dispogenius_sync_runs')
    .insert({ workspace_id: workspace, kind: 'buyers', status: 'running' }).select('id').single();
  const runId = run?.id ?? null;
  const fail = async (msg: string, code = 502) => {
    await admin.from('dispogenius_sync_runs')
      .update({ status: 'failed', error: msg, finished_at: new Date().toISOString() }).eq('id', runId);
    return json({ ok: false, error: msg }, code);
  };

  const auth = await resolveAuth(base, key);
  if (!auth) return await fail('DispoGenius rejected the key on every auth scheme tried (Bearer, Api-Key, X-API-Key).', 401);

  let link = { linked: 0, scanned: 0 };
  if (action === 'sync' || action === 'link') {
    try {
      link = await linkDeals(admin, base, auth, workspace, dryRun);
    } catch (e) {
      return await fail(`link phase failed: ${(e as Error).message}`);
    }
  }
  if (action === 'link') {
    await admin.from('dispogenius_sync_runs').update({
      status: 'succeeded', deals_polled: 0, rows_written: 0,
      error: `linked ${link.linked} of ${link.scanned} scanned`,
      finished_at: new Date().toISOString(),
    }).eq('id', runId);
    return json({ ok: true, ...link, dry_run: dryRun });
  }

  const { data: deals } = await admin.from('deals')
    .select('id, dispogenius_deal_id')
    .eq('workspace_id', workspace)
    .not('dispogenius_deal_id', 'is', null)
    .is('closed_on', null)
    .limit(Math.min(200, Math.max(1, Number(b.limit) || 50)));

  if (!deals || deals.length === 0) {
    await admin.from('dispogenius_sync_runs').update({
      status: 'succeeded', deals_polled: 0, rows_written: 0,
      error: link.scanned > 0 ? `no address matches across ${link.scanned} of their deals` : null,
      finished_at: new Date().toISOString(),
    }).eq('id', runId);
    return json({ ok: true, ...link, deals_polled: 0, rows_written: 0,
      note: 'No open deal matched one of theirs by address.' });
  }

  const { data: ourBuyers } = await admin.from('buyers')
    .select('id, email, phone_key').eq('workspace_id', workspace);
  const byPhone = new Map<string, number>();
  const byEmail = new Map<string, number>();
  for (const bu of ourBuyers ?? []) {
    if (bu.phone_key) byPhone.set(String(bu.phone_key), bu.id);
    if (bu.email) byEmail.set(String(bu.email).toLowerCase(), bu.id);
  }

  let polled = 0;
  let written = 0;
  let matched = 0;
  const errors: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const d of deals) {
    try {
      const res = await fetch(`${base}/api/v1/${encodeURIComponent(String(d.dispogenius_deal_id))}/buyers`, {
        headers: { ...auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) { errors.push(`deal ${d.dispogenius_deal_id}: HTTP ${res.status}`); continue; }
      const j: Any = await res.json();
      const list: Any[] = Array.isArray(j) ? j : (j?.results ?? j?.buyers ?? j?.data ?? []);
      polled++;

      const rows = list.map((x: Any) => {
        const emailRaw = pick(x, 'email', 'buyer.email', 'contact.email');
        const email = emailRaw ? String(emailRaw).toLowerCase() : null;
        const phoneRaw = pick(x, 'phone', 'phone_number', 'buyer.phone', 'contact.phone');
        const digits = phoneRaw ? String(phoneRaw).replace(/\D/g, '') : '';
        const pkey = digits.length === 10 ? `+1${digits}`
          : (digits.length === 11 && digits.charAt(0) === '1' ? `+${digits}` : null);
        const ourId = (pkey ? byPhone.get(pkey) : undefined)
          ?? (email ? byEmail.get(email) : undefined) ?? null;
        if (ourId) matched++;
        return {
          workspace_id: workspace, run_id: runId,
          dispogenius_deal_id: String(d.dispogenius_deal_id),
          dispogenius_buyer_id: String(pick(x, 'id', 'buyer_id', 'buyer.id') ?? email ?? (digits || null) ?? crypto.randomUUID()),
          buyer_name: pick(x, 'name', 'full_name', 'buyer.name'),
          buyer_company: pick(x, 'company', 'company_name', 'buyer.company'),
          email,
          phone: phoneRaw ? String(phoneRaw) : null,
          status: pick(x, 'status', 'interaction_status'),
          temperature: pick(x, 'temperature'),
          probability_score: num(pick(x, 'probability_score', 'metrics.probability_score', 'likelihood_to_buy')),
          stars: num(pick(x, 'stars', 'interaction_stars')),
          email_opened_count: num(pick(x, 'email_opened_count', 'metrics.email_opened_count')),
          link_clicks: num(pick(x, 'total_image_clicks', 'link_clicks', 'metrics.total_image_clicks')),
          call_count: num(pick(x, 'call_count', 'metrics.call_count')),
          message_count: num(pick(x, 'message_count', 'metrics.message_count')),
          replied: bool(pick(x, 'replied', 'has_replied')),
          offered: bool(pick(x, 'offered', 'has_offered')) ?? (num(pick(x, 'offer_amount')) !== null),
          offer_amount: num(pick(x, 'offer_amount', 'offer.amount')),
          pct_of_arv: num(pick(x, 'percentage_of_arv', 'metrics.percentage_of_arv')),
          raw: x,
          deal_id: d.id,
          buyer_id: ourId,
          pulled_on: today,
        };
      });

      if (rows.length > 0 && !dryRun) {
        const { error } = await admin.from('dispogenius_buyer_snapshots')
          .upsert(rows, { onConflict: 'dispogenius_deal_id,dispogenius_buyer_id,pulled_on' });
        if (error) errors.push(`deal ${d.dispogenius_deal_id}: ${error.message}`);
        else written += rows.length;
      } else {
        written += rows.length;
      }
    } catch (e) {
      errors.push(`deal ${d.dispogenius_deal_id}: ${(e as Error).message}`);
    }
  }

  await admin.from('dispogenius_sync_runs').update({
    status: (errors.length > 0 && written === 0) ? 'failed' : 'succeeded',
    deals_polled: polled, rows_written: written,
    error: errors.length > 0 ? errors.slice(0, 5).join('; ') : null,
    finished_at: new Date().toISOString(),
  }).eq('id', runId);

  return json({ ok: true, ...link, deals_polled: polled, rows_written: written,
    linked_to_our_buyers: matched, errors: errors.slice(0, 5), dry_run: dryRun });
});
