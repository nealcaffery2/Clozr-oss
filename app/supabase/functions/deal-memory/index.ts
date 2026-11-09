/**
 * POST /deal-memory: the Smart Summary for a deal under contract (migration 399).
 *
 * { action: 'refresh', workspace_id, deal_id, force? }
 *   A signed-in member's Refresh on the deal sheet, the TC file or the
 *   Contracts screen. The deal is checked as the caller (RLS), so a seat that
 *   cannot see it cannot refresh it; the documents and messages are then read
 *   and the row written with the service role. A deal whose inputs have not
 *   changed keeps its summary without a model call unless `force`.
 *   Returns { memory, source: 'ai'|'fallback'|'unchanged', message? }.
 *
 * { action: 'refresh_dirty' }
 *   The ten-minute pg_cron kick (deal_memory_kick, only when something is
 *   dirty), service role only. Takes up to DIRTY_CAP deals from
 *   deal_memory_dirty(), newest touch first, DIRTY_PARALLEL at a time until
 *   the time budget runs out; the rest stay dirty for the next tick.
 *
 * Deployed with verify_jwt. Needs ANTHROPIC_API_KEY (the same secret lead
 * memory and docs-extract use; ANTHROPIC_WORKSPACE_ID when the key spans
 * workspaces). Without it the rule-based summary is stored.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, isServiceCaller, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { refreshDealMemory } from '../_shared/deal-memory.ts';
import { pool } from '../ai-agent/pool.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const DIRTY_CAP = 6;
const DIRTY_PARALLEL = 2;
const DIRTY_BUDGET_MS = 180_000;

type Body = { action?: string; workspace_id?: number; deal_id?: number; force?: boolean };

const missingTable = (msg: string) => /does not exist|schema cache|PGRST20[25]|42P01|42883/i.test(msg);
const NOT_SET_UP = 'Deal summaries are not set up: apply migration 399 (deal_memory).';

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
    const { data, error } = await admin.rpc('deal_memory_dirty', { p_limit: DIRTY_CAP });
    if (error) return missingTable(error.message) ? json({ error: NOT_SET_UP }, 503) : serverError(CORS, 'deal-memory dirty', error);
    const queue = (data ?? []) as { workspace_id: number; deal_id: number }[];
    const run = async () => {
      let done = 0;
      await pool(queue, DIRTY_PARALLEL, async (d) => {
        if (Date.now() - started > DIRTY_BUDGET_MS) return;
        try {
          if (await refreshDealMemory(admin, Number(d.workspace_id), Number(d.deal_id))) done++;
        } catch (e) {
          console.error('deal-memory refresh_dirty', d.deal_id, String(e));
        }
      });
      console.log('deal-memory refresh_dirty', { queued: queue.length, refreshed: done, ms: Date.now() - started });
    };
    // pg_net gives up after five seconds; the work carries on past the reply.
    EdgeRuntime.waitUntil(run());
    return json({ ok: true, queued: queue.length }, 202);
  }

  if (body.action !== 'refresh') return json({ error: "action must be 'refresh' or 'refresh_dirty'" }, 400);
  const ws = Number(body.workspace_id);
  const id = Number(body.deal_id);
  if (!Number.isFinite(ws) || !Number.isFinite(id)) return json({ error: 'workspace_id and deal_id are required' }, 422);

  if (!isService) {
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false },
    });
    const { data: who } = await asCaller.auth.getUser();
    if (!who?.user) return json({ error: 'sign in first' }, 401);
    const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
    if (!member) return json({ error: 'not a member of that workspace' }, 403);
    const { data: visible } = await asCaller.from('deals').select('id').eq('id', id).eq('workspace_id', ws).maybeSingle();
    if (!visible) return json({ error: 'deal not found' }, 404);
    const rl = await rateLimit(admin, `deal-memory:${who.user.id}`, 60, 3600);
    if (!rl.allowed) return tooMany(CORS, rl);
  }

  try {
    const r = await refreshDealMemory(admin, ws, id, body.force === true);
    if (!r) return json({ error: 'deal not found' }, 404);
    return json({ ok: true, ...r });
  } catch (e) {
    if (missingTable(String(e))) return json({ error: NOT_SET_UP }, 503);
    return serverError(CORS, 'deal-memory refresh', e);
  }
});
