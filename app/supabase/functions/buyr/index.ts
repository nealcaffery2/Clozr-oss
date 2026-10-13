/**
 * POST /buyr — the sniping queue buyr reads.
 *
 * Deal Machine already stores the deals it found and the wholesaler lists it
 * opted into. Buyr uses the aged ones (default 90 days) to look up who the
 * end buyer was. Auth is the buyr ingest key: bearer token, SHA-256, matched
 * against ingest_sources.key_hash. `verify_jwt` is off.
 *
 *   { action: 'queue', days?: number }
 *
 * Deploy:  supabase functions deploy buyr --no-verify-jwt
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, clientIp, rateLimit, tooMany } from '../_shared/security.ts';

const SOURCE = 'buyr';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, ...HARDENING, 'Content-Type': 'application/json' } });

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  const key = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!key) return json({ error: 'missing bearer token' }, 401);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const ip = clientIp(req);
  const { data: src } = await db.from('ingest_sources').select('id, workspace_id, name, active')
    .eq('key_hash', await sha256(key)).maybeSingle();
  if (!src) {
    const rl = await rateLimit(db, `buyr:badkey:${ip}`, 30, 600);
    if (!rl.allowed) return tooMany(CORS, rl);
    return json({ error: 'unknown key' }, 401);
  }
  if (!src.active) return json({ error: 'key is disabled' }, 403);
  if (src.name !== SOURCE) return json({ error: `key is for source "${src.name}", this endpoint is for "${SOURCE}"` }, 403);

  const perKey = await rateLimit(db, `buyr:key:${src.id}`, 120, 60);
  if (!perKey.allowed) return tooMany(CORS, perKey);

  let body: { action?: string; days?: number };
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  if (body.action !== 'queue') return json({ error: 'action must be queue' }, 422);

  const days = Math.min(365, Math.max(1, Math.round(Number(body.days) || 90)));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const ws = src.workspace_id as number;

  const [dealsR, optinsR] = await Promise.all([
    db.from('deals')
      .select('id, created_at, lead_source, source, properties(line1, city, state, zip)')
      .eq('workspace_id', ws)
      .eq('source', 'deal_machine')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(200),
    db.from('dm_optins')
      .select('domain, url, last_at')
      .eq('workspace_id', ws)
      .eq('status', 'opted_in')
      .order('last_at', { ascending: false })
      .limit(200),
  ]);
  if (dealsR.error) return json({ error: dealsR.error.message }, 500);
  if (optinsR.error) return json({ error: optinsR.error.message }, 500);

  const deals = (dealsR.data ?? []).flatMap((row) => {
    const prop = row.properties as { line1?: string; city?: string; state?: string; zip?: string } | { line1?: string; city?: string; state?: string; zip?: string }[] | null;
    const p = Array.isArray(prop) ? prop[0] : prop;
    const line1 = p?.line1?.trim();
    if (!line1) return [];
    const address = [line1, p?.city, p?.state, p?.zip].filter(Boolean).join(', ');
    return [{
      id: row.id,
      address,
      line1,
      city: p?.city ?? null,
      state: p?.state ?? null,
      zip: p?.zip ?? null,
      created_at: row.created_at,
      lead_source: row.lead_source,
    }];
  });

  void db.from('ingest_sources').update({ last_used_at: new Date().toISOString() }).eq('id', src.id);
  return json({
    ok: true,
    aged_days: days,
    deals,
    wholesaler_optins: optinsR.data ?? [],
  });
});
