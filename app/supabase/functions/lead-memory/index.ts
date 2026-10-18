/**
 * POST /lead-memory: the brief and facts every channel reads (migration 110).
 *
 * { action: 'refresh', workspace_id, record_kind: 'seller'|'buyer', record_id }
 *   A signed-in member's Refresh on the record card. The record is checked as
 *   the caller (RLS), so a rep who cannot see it cannot refresh it; the
 *   history is then read and the row written with the service role.
 *   Returns { memory, source: 'ai'|'fallback', message? }.
 *
 * { action: 'refresh_dirty' }
 *   The two-minute pg_cron kick (lead_memory_kick, only when something is
 *   dirty), service role only. Takes up to DIRTY_CAP records from
 *   lead_memory_dirty(), newest touch first, and refreshes DIRTY_PARALLEL at
 *   a time until the time budget runs out; whatever is left stays dirty for
 *   the next tick.
 *
 * Deployed with verify_jwt, so the gateway checks the bearer's signature and
 * its role claim can be trusted. Needs ANTHROPIC_API_KEY for the AI brief;
 * without it a deterministic brief from the latest touches is stored so the
 * card and the phone agent still get something.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, serverError, tooMany, isServiceCaller } from '../_shared/security.ts';
import { refreshLeadMemory } from '../_shared/lead-memory.ts';
import { pool } from '../ai-agent/pool.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const DIRTY_CAP = 15;
/** Model calls at once. Each record is its own memory row and nothing is sent, so order does not matter. */
const DIRTY_PARALLEL = 3;
/** Stop starting new records after this long, so a tick never overlaps the next. */
const DIRTY_BUDGET_MS = 80_000;

type Body = { action?: string; workspace_id?: number; record_kind?: string; record_id?: number };

const missingTable = (msg: string) => /does not exist|schema cache|PGRST20[25]|42P01|42883/i.test(msg);

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const isService = await isServiceCaller(admin, bearer);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }

  if (body.action === 'refresh_dirty') {
    if (!isService) return json({ error: 'service role only' }, 403);
    const started = Date.now();
    const { data, error } = await admin.rpc('lead_memory_dirty', { p_limit: DIRTY_CAP });
    if (error) {
      if (missingTable(error.message)) return json({ error: 'Lead memory is not set up: apply migration 110 (lead_memory).' }, 503);
      return serverError(CORS, 'lead-memory dirty', error);
    }
    const queue = (data ?? []) as { workspace_id: number; record_kind: 'seller' | 'buyer'; record_id: number }[];
    const run = async () => {
      let done = 0;
      await pool(queue, DIRTY_PARALLEL, async (d) => {
        if (Date.now() - started > DIRTY_BUDGET_MS) return;
        try {
          if (await refreshLeadMemory(admin, Number(d.workspace_id), d.record_kind, Number(d.record_id))) done++;
        } catch (e) {
          console.error('lead-memory refresh_dirty', `${d.record_kind}:${d.record_id}`, String(e));
        }
      });
      console.log('lead-memory refresh_dirty', { queued: queue.length, refreshed: done, ms: Date.now() - started });
    };
    // pg_net gives up after five seconds; the work carries on past the reply.
    EdgeRuntime.waitUntil(run());
    return json({ ok: true, queued: queue.length }, 202);
  }

  if (body.action !== 'refresh') return json({ error: "action must be 'refresh' or 'refresh_dirty'" }, 400);

  const ws = Number(body.workspace_id);
  const id = Number(body.record_id);
  const kind = body.record_kind === 'buyer' ? 'buyer' : body.record_kind === 'seller' ? 'seller' : null;
  if (!Number.isFinite(ws) || !Number.isFinite(id) || !kind) return json({ error: 'workspace_id, record_kind and record_id are required' }, 422);

  if (!isService) {
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false },
    });
    const { data: who } = await asCaller.auth.getUser();
    if (!who?.user) return json({ error: 'sign in first' }, 401);
    const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
    if (!member) return json({ error: 'not a member of that workspace' }, 403);
    const { data: visible } = await asCaller.from(kind === 'seller' ? 'sellers' : 'buyers').select('id').eq('id', id).eq('workspace_id', ws).maybeSingle();
    if (!visible) return json({ error: 'record not found' }, 404);
    const rl = await rateLimit(admin, `lead-memory:${who.user.id}`, 120, 3600);
    if (!rl.allowed) return tooMany(CORS, rl);
  }

  try {
    const r = await refreshLeadMemory(admin, ws, kind, id);
    if (!r) return json({ error: 'record not found' }, 404);
    return json({ ok: true, ...r });
  } catch (e) {
    if (missingTable(String(e))) return json({ error: 'Lead memory is not set up: apply migration 110 (lead_memory).' }, 503);
    return serverError(CORS, 'lead-memory refresh', e);
  }
});
