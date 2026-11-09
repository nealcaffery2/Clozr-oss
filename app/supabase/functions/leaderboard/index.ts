/**
 * GET /leaderboard?period=last-30-days — the TV board's feed.
 *
 * The Acme Homes dashboard used to assemble its leaderboard from Podio and
 * smrtPhone. Both are retired: CLOZR is the system of record, so the board
 * now pulls one JSON document from here every few minutes and draws it. The
 * shape is the dashboard's own `LeaderboardData` (salesPeople[] with the
 * SalesPerson fields, executiveSummary, period, lastUpdated), computed by the
 * same engine the Sales leaderboard screen inside CLOZR uses
 * (_shared/leaderboard.ts, a mirror of lib/leaderboard.ts), so the two boards
 * cannot disagree.
 *
 * Auth: a read-only ingest key named `dashboard` (Settings → Ingest keys), as
 * `Authorization: Bearer clz_…` and nowhere else (no `?key=`). The key names
 * the workspace. A signed-in member's JWT is accepted too (for CLOZR itself
 * and for support).
 *
 *   GET ?period=<id>          one period (default last-30-days)
 *   GET ?all=true             every period, keyed by id: { periods: { today: {…}, … } }
 *   GET ?period=…&raw=1       the payload plus the engine's notes and range
 *
 * Deploy:  supabase functions deploy leaderboard --no-verify-jwt
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { type SupabaseClient, createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, clientIp, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { DEFAULT_TZ, PERIOD_IDS, type Goals, type LeaderboardPayload, type LeaderboardRaw, applyLeaderboardResets, buildLeaderboard } from '../_shared/leaderboard.ts';
import { everyRowResult } from '../_shared/every-row.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, ...HARDENING, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// deno-lint-ignore no-explicit-any
type Any = any;

/** Every row the engine reads, for one workspace. One read serves every period. */
async function loadRaw(db: SupabaseClient, ws: number): Promise<{ raw: LeaderboardRaw; settings: Any }> {
  const { data: wsRow } = await db.from('workspaces').select('settings').eq('id', ws).maybeSingle();
  const settings = wsRow?.settings ?? {};
  // Paged by id: a bare select stops at PostgREST's 1,000 rows, and a board past that counted a slice.
  const [membersQ, sellersQ, dealsQ, commsQ, offersQ, apptsQ, buyersQ] = await Promise.all([
    db.from('workspace_members').select('user_id, role, profiles(full_name, email, avatar_url)').eq('workspace_id', ws),
    everyRowResult<Any>(() => db.from('sellers').select('id, created_at, assigned_to, source').eq('workspace_id', ws).is('archived_at', null).order('id')),
    everyRowResult<Any>(() => db.from('deals').select('id, seller_id, stage, created_at, stage_entered_at, contract_date, close_date, closed_on, owner_id, dispo_rep_id, assignment_fee, dispo_fee, wholesale_fee, marketed_fee, total_cogs, deal_net_profit, market, coordinator').eq('workspace_id', ws).order('id')),
    // Grouped in SQL (migration 391): per rep, line owner, seller rep, day, channel and direction, with the board's resets applied.
    db.rpc('leaderboard_comms', { p_ws: ws, p_tz: typeof settings?.leaderboard_tz === 'string' ? settings.leaderboard_tz : DEFAULT_TZ, p_resets: resetsOf(settings) }),
    everyRowResult<Any>(() => db.from('offers').select('seller_id, direction, sent_at, created_by').eq('workspace_id', ws).order('id')),
    everyRowResult<Any>(() => db.from('appointments').select('seller_id, assigned_to, starts_at, created_at, deleted_at').eq('workspace_id', ws).order('id')),
    everyRowResult<Any>(() => db.from('buyers').select('created_at, created_by').eq('workspace_id', ws).order('id')),
  ]);
  for (const q of [membersQ, sellersQ, dealsQ, commsQ, offersQ]) if (q.error) throw q.error;
  const members = ((membersQ.data ?? []) as Any[]).map((m) => {
    const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
    return { id: String(m.user_id), name: p?.full_name || 'Teammate', role: String(m.role ?? 'member'), email: p?.email ?? null, avatar: p?.avatar_url ?? null };
  });
  const grouped = (commsQ.data ?? {}) as { comms?: LeaderboardRaw['comms']; first_touch?: Record<string, string> };
  return {
    settings,
    raw: {
      members,
      sellers: (sellersQ.data ?? []) as Any,
      deals: (dealsQ.data ?? []) as Any,
      comms: grouped.comms ?? [],
      firstTouch: grouped.first_touch ?? {},
      offers: (offersQ.data ?? []) as Any,
      appointments: (apptsQ.data ?? []) as Any,
      buyers: (buyersQ.data ?? []) as Any,
    },
  };
}

function resetsOf(settings: Any): Record<string, string> {
  const raw = settings?.leaderboard_resets;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

function build(raw: LeaderboardRaw, settings: Any, period: string): LeaderboardPayload {
  const goals = (settings?.leaderboard_goals ?? {}) as Partial<Goals>;
  const filtered = applyLeaderboardResets(raw, resetsOf(settings));
  return buildLeaderboard(filtered, period, {
    tz: typeof settings?.leaderboard_tz === 'string' ? settings.leaderboard_tz : DEFAULT_TZ,
    goals,
    exclude: Array.isArray(settings?.leaderboard_exclude) ? settings.leaderboard_exclude.map(String) : [],
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url = new URL(req.url);
  const auth = req.headers.get('authorization') ?? '';
  // Header only: a key in the URL lands in proxy and browser logs.
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) return json({ error: 'missing bearer token' }, 401);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const ip = clientIp(req);

  let ws: number | null = null;
  let who = 'key';
  if (bearer.startsWith('clz_')) {
    const { data: src } = await db.from('ingest_sources').select('id, workspace_id, name, active').eq('key_hash', await sha256(bearer)).maybeSingle();
    if (!src) {
      const rl = await rateLimit(db, `lb:badkey:${ip}`, 30, 600);
      if (!rl.allowed) return tooMany(CORS, rl);
      return json({ error: 'unknown key' }, 401);
    }
    if (!src.active) return json({ error: 'key is disabled' }, 403);
    if (src.name !== 'dashboard') return json({ error: `key is for source "${src.name}"; the leaderboard needs a "dashboard" key` }, 403);
    ws = src.workspace_id as number;
    void db.from('ingest_sources').update({ last_used_at: new Date().toISOString() }).eq('id', src.id);
  } else {
    // A member's JWT. No ?workspace_id= means the oldest membership (lowest id),
    // the same default the app uses. An explicit id still has to be one of theirs.
    const { data: u } = await db.auth.getUser(bearer);
    if (!u?.user) return json({ error: 'not signed in' }, 401);
    const want = Number(url.searchParams.get('workspace_id') || 0) || null;
    let q = db.from('workspace_members').select('workspace_id').eq('user_id', u.user.id);
    if (want) q = q.eq('workspace_id', want);
    const { data: m } = await q.order('workspace_id', { ascending: true }).limit(1);
    if (!m?.length) return json({ error: 'not a member of that workspace' }, 403);
    ws = m[0].workspace_id as number;
    who = 'member';
  }

  const rl = await rateLimit(db, `lb:ws:${ws}`, 120, 60);
  if (!rl.allowed) return tooMany(CORS, rl);

  try {
    const { raw, settings } = await loadRaw(db, ws!);
    const all = url.searchParams.get('all') === 'true';
    if (all) {
      const periods: Record<string, LeaderboardPayload> = {};
      for (const p of PERIOD_IDS) periods[p] = build(raw, settings, p);
      return json({ ok: true, workspace_id: ws, auth: who, periods });
    }
    const period = url.searchParams.get('period') || 'last-30-days';
    if (!(PERIOD_IDS as string[]).includes(period)) return json({ error: `unknown period "${period}"`, periods: PERIOD_IDS }, 422);
    const payload = build(raw, settings, period);
    return json(url.searchParams.get('raw') ? payload : { ...payload, notes: undefined, range: undefined, ...(payload.notes.length ? { notes: payload.notes } : {}) });
  } catch (e) {
    return serverError(CORS, `leaderboard failed ws=${ws}`, e);
  }
});
