/**
 * POST /provider-check — is a provider key present AND accepted?
 *
 * "Set" and "working" are different states, and only the second one matters.
 * A key can be present and rejected (wrong account, revoked, typo on paste),
 * which surfaces as a silent empty result rather than an error a rep can act
 * on.
 *
 * Never returns a key or any part of one — only presence, and the provider's
 * verdict on it. Each check spends a real BatchData skip-trace or ATTOM call,
 * so the service role only (the project's service key, or the cron's vault
 * key), sent as `Authorization: Bearer …`. This lived only in the dashboard
 * behind a static token in the source; that token no longer opens anything.
 *
 * Body: { provider: 'batchdata' | 'attom' | 'dispogenius' }
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bearerOf, HARDENING, isServiceCaller } from '../_shared/security.ts';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...HARDENING, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
type Any = any;

async function checkBatchData() {
  const key = (Deno.env.get('BATCHDATA_API_KEY') ?? '').trim();
  if (!key) return { present: false, ok: false, detail: 'BATCHDATA_API_KEY is not set on this project.' };
  try {
    const res = await fetch('https://api.batchdata.com/api/v1/property/skip-trace', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ propertyAddress: { street: '1 Nonexistent Test Way', city: 'Richmond', state: 'VA', zip: '23220' } }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { present: true, ok: false, status: res.status, detail: 'Key is set but BatchData rejected it.' };
    }
    if (res.status === 429) return { present: true, ok: true, status: 429, detail: 'Key accepted; rate limited.' };
    if (!res.ok) return { present: true, ok: false, status: res.status, detail: `BatchData answered ${res.status}.` };
    return { present: true, ok: true, status: res.status, detail: 'Key accepted by BatchData.' };
  } catch (e) {
    return { present: true, ok: false, detail: `Could not reach BatchData: ${(e as Error).message}` };
  }
}

async function checkAttom() {
  const key = (Deno.env.get('ATTOM_API_KEY') ?? '').trim();
  if (!key) return { present: false, ok: false, detail: 'ATTOM_API_KEY is not set on this project.' };
  try {
    const url = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/basicprofile'
      + '?' + new URLSearchParams({ address1: '1600 Pennsylvania Ave NW', address2: 'Washington DC 20500' });
    const res = await fetch(url, { headers: { APIKey: key, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) return { present: true, ok: false, status: res.status, detail: 'Key is set but ATTOM rejected it.' };
    if (!res.ok) return { present: true, ok: false, status: res.status, detail: `ATTOM answered ${res.status}.` };
    return { present: true, ok: true, status: res.status, detail: 'Key accepted by ATTOM.' };
  } catch (e) {
    return { present: true, ok: false, detail: `Could not reach ATTOM: ${(e as Error).message}` };
  }
}

/**
 * DispoGenius ships a location-scoped bearer key over a documented public API.
 * GET /api/v1/deals is the cheapest authenticated read: it pages, it does not
 * mutate, and a bad key fails on it the same way it would on anything else.
 * The base URL is overridable because the teardown saw both api.dispogenius.io
 * and go.dispogenius.io in use.
 */
async function checkDispoGenius() {
  const key = (Deno.env.get('DISPOGENIUS_API_KEY') ?? '').trim();
  if (!key) return { present: false, ok: false, detail: 'DISPOGENIUS_API_KEY is not set on this project.' };
  const base = (Deno.env.get('DISPOGENIUS_API_URL') ?? 'https://api.dispogenius.io').replace(/\/$/, '');
  const attempts: Any[] = [];
  // The docs are not explicit about the scheme, so try the three plausible ones
  // rather than reporting a false negative on a key that is actually good.
  for (const [label, headers] of [
    ['Bearer',  { Authorization: `Bearer ${key}` }],
    ['Api-Key', { 'Api-Key': key }],
    ['X-API-Key', { 'X-API-Key': key }],
  ] as [string, Record<string, string>][]) {
    try {
      const res = await fetch(`${base}/api/v1/deals?page=1&page_size=1`, {
        headers: { ...headers, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const j: Any = await res.json().catch(() => ({}));
        const n = Array.isArray(j?.results) ? j.results.length : Array.isArray(j) ? j.length : null;
        return { present: true, ok: true, status: res.status, auth_scheme: label, base,
                 detail: 'Key accepted by DispoGenius.', sample_rows: n, count: j?.count ?? null };
      }
      attempts.push({ scheme: label, status: res.status, body: (await res.text()).slice(0, 200) });
    } catch (e) {
      attempts.push({ scheme: label, error: (e as Error).message });
    }
  }
  return { present: true, ok: false, base, detail: 'Key is set but no auth scheme was accepted.', attempts };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  if (!(await isServiceCaller(admin, bearerOf(req)))) return json({ error: 'service role only' }, 403);
  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }

  const p = String(b?.provider ?? '').toLowerCase();
  if (p === 'batchdata') return json({ provider: p, ...(await checkBatchData()) });
  if (p === 'attom') return json({ provider: p, ...(await checkAttom()) });
  if (p === 'dispogenius') return json({ provider: p, ...(await checkDispoGenius()) });
  return json({ error: "provider must be 'batchdata', 'attom' or 'dispogenius'" }, 400);
});
