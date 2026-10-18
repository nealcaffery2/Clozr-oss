/**
 * POST /deal-machine — the extension's control channel.
 *
 * /ingest takes what Deal Machine finds. This takes everything else that used
 * to live in the popup: the extension pulls its settings, its Facebook groups
 * and the commands a rep pressed in CLOZR, and pushes back its heartbeat, the
 * run it is on, its log and the buyers lists it opted into. Migration 84 is
 * the schema.
 *
 * Auth is the same Deal Machine ingest key (`ingest_sources`, name
 * 'deal_machine'): bearer token, SHA-256, matched against key_hash. The key
 * decides the workspace; nothing in the body can move a device between
 * workspaces. `verify_jwt` is off because an extension has no Supabase session.
 *
 * Every request is `{ action, device_id, ... }`:
 *
 *   sync          heartbeat + pull. Body carries the device's state; the answer
 *                 carries settings (when newer than `settings_version`), the
 *                 active groups, and pending commands, which are acked on the
 *                 way out.
 *   command.done  { command_id, ok, result }
 *   run.start     { run_key, kind, trigger, dry_run, command_id? }
 *   run.update    { run_key, step, counts, status? }
 *   run.end       { run_key, status, counts, diag, error }
 *   log           { run_key?, lines: [{ ts, level, tag, msg }] }
 *   optins        { run_key?, items: [{ domain, url, status, method, detail, occurred_at }] }
 *   groups.sync   { groups: [{ url, name, tags, members, posts_per_day }] }
 *                 the extension's local list merged in, never deleting CLOZR's
 *   groups.result { url, members, posts_per_day, scraped_at, result }
 *
 * Deploy:  supabase functions deploy deal-machine --no-verify-jwt
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { type SupabaseClient, createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, clientIp, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { type Optin, type OptinHave, mergeOptins } from './optins.ts';

const SOURCE = 'deal_machine';
const COMMAND_TTL_MS = 60 * 60 * 1000;
const LOG_KEEP_DAYS = 14;
const LOG_BATCH_MAX = 500;

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

type Db = SupabaseClient;
// deno-lint-ignore no-explicit-any
type Any = any;

const str = (v: unknown, max = 512): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const iso = (v: unknown): string => {
  const t = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN;
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

const RUN_STATUS = new Set(['running', 'paused', 'stopping', 'done', 'stopped', 'failed']);
const OPTIN_STATUS = new Set(['opted_in', 'no_form', 'failed', 'skipped', 'queued']);
const LEVELS = new Set(['error', 'warn', 'info', 'debug']);

/** The run row for a key, created if the extension reported progress before start (a torn-down worker). */
async function runFor(db: Db, ws: number, deviceId: string | null, runKey: string, seed: Record<string, unknown> = {}): Promise<number> {
  const { data } = await db.from('dm_runs').select('id').eq('workspace_id', ws).eq('run_key', runKey).maybeSingle();
  if (data) return data.id as number;
  const { data: made, error } = await db.from('dm_runs')
    .insert({ workspace_id: ws, device_id: deviceId, run_key: runKey, ...seed }).select('id').single();
  if (error) throw error;
  return made.id as number;
}

async function sync(db: Db, ws: number, body: Any) {
  const deviceId = str(body.device_id, 128)!;
  const state = obj(body.state);
  const runState = str(state.run_state, 32) ?? 'idle';
  const isRunning = state.is_running === true;

  await db.from('dm_devices').upsert({
    workspace_id: ws, device_id: deviceId,
    label: str(body.label, 120), version: str(body.version, 40),
    run_state: runState, is_running: isRunning,
    step: str(state.step, 300), progress: obj(state.progress), stats: obj(state.stats),
    settings_version: int(body.settings_version), last_seen_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,device_id' });

  // Settings only when the device is behind; the object is small but there is
  // no reason to ship it sixty times an hour.
  const { data: srow } = await db.from('dm_settings').select('settings, version').eq('workspace_id', ws).maybeSingle();
  const have = int(body.settings_version) ?? 0;
  const settings = srow && (srow.version as number) > have ? { version: srow.version, settings: srow.settings } : null;

  const { data: groups } = await db.from('dm_groups').select('id, url, name, tags, active').eq('workspace_id', ws).eq('active', true).order('id');

  // Commands: expire the stale, hand over the rest, mark them acked so a
  // second device (or this one after a worker restart) does not run them too.
  const cutoff = new Date(Date.now() - COMMAND_TTL_MS).toISOString();
  await db.from('dm_commands').update({ status: 'expired', finished_at: new Date().toISOString() })
    .eq('workspace_id', ws).eq('status', 'pending').lt('created_at', cutoff);
  const { data: pending } = await db.from('dm_commands').select('id, command, args, created_at, device_id')
    .eq('workspace_id', ws).eq('status', 'pending').or(`device_id.is.null,device_id.eq.${deviceId}`)
    .order('created_at').limit(20);
  const commands = pending ?? [];
  if (commands.length) {
    await db.from('dm_commands').update({ status: 'acked', acked_at: new Date().toISOString(), device_id: deviceId })
      .in('id', commands.map((c) => c.id));
  }

  return { ok: true, server_time: new Date().toISOString(), settings, groups: groups ?? [], commands };
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
    const rl = await rateLimit(db, `dm:badkey:${ip}`, 30, 600);
    if (!rl.allowed) return tooMany(CORS, rl);
    return json({ error: 'unknown key' }, 401);
  }
  if (!src.active) return json({ error: 'key is disabled' }, 403);
  if (src.name !== SOURCE) return json({ error: `key is for source "${src.name}", this endpoint is for "${SOURCE}"` }, 403);

  const perKey = await rateLimit(db, `dm:key:${src.id}`, 600, 60);
  if (!perKey.allowed) return tooMany(CORS, perKey);

  let body: Any;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'body must be a JSON object' }, 422);

  const ws = src.workspace_id as number;
  const action = str(body.action, 40);
  const deviceId = str(body.device_id, 128);
  if (!action) return json({ error: 'action is required' }, 422);
  if (!deviceId) return json({ error: 'device_id is required' }, 422);

  // The key was used, whichever action it was.
  void db.from('ingest_sources').update({ last_used_at: new Date().toISOString() }).eq('id', src.id);

  try {
    switch (action) {
      case 'sync':
        return json(await sync(db, ws, body));

      case 'command.done': {
        const id = int(body.command_id);
        if (!id) return json({ error: 'command_id is required' }, 422);
        await db.from('dm_commands').update({
          status: body.ok === false ? 'failed' : 'done', finished_at: new Date().toISOString(),
          result: body.result === undefined ? null : body.result,
        }).eq('workspace_id', ws).eq('id', id);
        return json({ ok: true });
      }

      case 'run.start': {
        const runKey = str(body.run_key, 200);
        if (!runKey) return json({ error: 'run_key is required' }, 422);
        const id = await runFor(db, ws, deviceId, runKey, {
          kind: str(body.kind, 40) ?? 'machine', trigger: str(body.trigger, 40) ?? 'manual',
          dry_run: body.dry_run === true, started_at: iso(body.started_at), status: 'running',
          command_id: int(body.command_id),
        });
        return json({ ok: true, run_id: id });
      }

      case 'run.update': {
        const runKey = str(body.run_key, 200);
        if (!runKey) return json({ error: 'run_key is required' }, 422);
        const id = await runFor(db, ws, deviceId, runKey, { kind: str(body.kind, 40) ?? 'machine' });
        const patch: Record<string, unknown> = {};
        if (body.step !== undefined) patch.step = str(body.step, 300);
        if (body.counts !== undefined) patch.counts = obj(body.counts);
        const st = str(body.status, 20);
        if (st && RUN_STATUS.has(st)) patch.status = st;
        if (Object.keys(patch).length) await db.from('dm_runs').update(patch).eq('id', id);
        return json({ ok: true, run_id: id });
      }

      case 'run.end': {
        const runKey = str(body.run_key, 200);
        if (!runKey) return json({ error: 'run_key is required' }, 422);
        const id = await runFor(db, ws, deviceId, runKey, { kind: str(body.kind, 40) ?? 'machine' });
        const st = str(body.status, 20);
        await db.from('dm_runs').update({
          status: st && RUN_STATUS.has(st) && st !== 'running' ? st : 'done',
          ended_at: iso(body.ended_at), counts: obj(body.counts), diag: body.diag ?? null,
          error: str(body.error, 2000), step: null,
        }).eq('id', id);
        return json({ ok: true, run_id: id });
      }

      case 'log': {
        const lines = Array.isArray(body.lines) ? body.lines.slice(0, LOG_BATCH_MAX) : [];
        if (!lines.length) return json({ ok: true, written: 0 });
        const runKey = str(body.run_key, 200);
        const runId = runKey ? await runFor(db, ws, deviceId, runKey, {}) : null;
        const rows = lines.map((l: Any) => ({
          workspace_id: ws, run_id: runId, device_id: deviceId,
          ts: iso(l?.ts), level: LEVELS.has(String(l?.level)) ? String(l.level) : 'info',
          tag: str(l?.tag, 40), msg: str(l?.msg, 2000) ?? '',
        })).filter((r: Any) => r.msg);
        if (rows.length) {
          const { error } = await db.from('dm_run_log').insert(rows);
          if (error) throw error;
        }
        // Prune on the way through — one cheap delete per batch keeps the table bounded.
        void db.from('dm_run_log').delete().eq('workspace_id', ws)
          .lt('ts', new Date(Date.now() - LOG_KEEP_DAYS * 86_400_000).toISOString());
        return json({ ok: true, written: rows.length });
      }

      case 'optins': {
        const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
        const runKey = str(body.run_key, 200);
        const runId = runKey ? await runFor(db, ws, deviceId, runKey, {}) : null;
        const found: Optin[] = items.map((it: Any) => ({
          domain: str(it?.domain, 253)?.toLowerCase().replace(/^www\./, '') ?? '',
          url: str(it?.url, 2000), status: OPTIN_STATUS.has(String(it?.status)) ? String(it.status) : 'opted_in',
          method: str(it?.method, 40), detail: str(it?.detail, 500), at: iso(it?.occurred_at),
        })).filter((o: Optin) => o.domain);
        // One read of the domains already there and one upsert, in place of a
        // read and a write per domain. A failed read writes nothing (500, the
        // extension queues the batch again).
        const have = new Map<string, OptinHave>();
        const domains = [...new Set(found.map((o) => o.domain))];
        for (let i = 0; i < domains.length; i += 100) {
          const { data, error } = await db.from('dm_optins').select('domain, url, status, attempts, first_at')
            .eq('workspace_id', ws).in('domain', domains.slice(i, i + 100));
          if (error) throw error;
          for (const r of (data ?? []) as OptinHave[]) have.set(r.domain, r);
        }
        const rows = mergeOptins(found, have, { workspace_id: ws, run_id: runId, device_id: deviceId });
        if (rows.length) {
          const { error } = await db.from('dm_optins').upsert(rows, { onConflict: 'workspace_id,domain' });
          if (error) throw error;
        }
        return json({ ok: true, written: found.length });
      }

      case 'groups.sync': {
        const groups = Array.isArray(body.groups) ? body.groups.slice(0, 2000) : [];
        const rows = groups.map((g: Any) => {
          const url = str(typeof g === 'string' ? g : g?.url, 500);
          if (!url || !/^https?:\/\/(www\.)?facebook\.com\/groups\//i.test(url)) return null;
          return {
            workspace_id: ws, url: url.replace(/\/+$/, '') + '/', name: str(g?.name, 200),
            tags: Array.isArray(g?.tags) ? g.tags.map((t: unknown) => String(t).slice(0, 40)).slice(0, 20) : [],
            members: int(g?.members), posts_per_day: Number.isFinite(Number(g?.posts_per_day)) ? Number(g.posts_per_day) : null,
            source: 'extension', updated_at: new Date().toISOString(),
          };
        }).filter(Boolean);
        if (rows.length) {
          // ignoreDuplicates: a group CLOZR already knows keeps its name, tags and active flag.
          const { error } = await db.from('dm_groups').upsert(rows, { onConflict: 'workspace_id,url', ignoreDuplicates: true });
          if (error) throw error;
        }
        const { data: all } = await db.from('dm_groups').select('id, url, name, tags, active').eq('workspace_id', ws).order('id');
        return json({ ok: true, groups: all ?? [] });
      }

      case 'groups.result': {
        const url = str(body.url, 500);
        if (!url) return json({ error: 'url is required' }, 422);
        await db.from('dm_groups').update({
          members: int(body.members) ?? undefined,
          posts_per_day: Number.isFinite(Number(body.posts_per_day)) ? Number(body.posts_per_day) : undefined,
          last_scraped_at: iso(body.scraped_at), last_result: body.result ?? null, updated_at: new Date().toISOString(),
        }).eq('workspace_id', ws).ilike('url', url.replace(/\/+$/, '') + '%');
        return json({ ok: true });
      }

      default:
        return json({ error: `unknown action "${action}"` }, 422);
    }
  } catch (e) {
    return serverError(CORS, `deal-machine ${action} failed ws=${ws}`, e);
  }
});
