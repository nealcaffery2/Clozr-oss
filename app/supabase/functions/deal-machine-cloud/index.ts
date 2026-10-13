/**
 * POST /deal-machine-cloud — Deal Machine without a Chrome.
 *
 * The extension only ever worked while one office Chrome was open, awake and
 * logged in, and everything it knew about a good deal lived in that browser.
 * This runs the job on CLOZR's side: InvestorLift and the workspace's Facebook
 * groups are pulled through Apify actors on a server, every find is judged here
 * against the fund buy box and the MAO (_shared/deal-machine-engine.ts), and
 * what passes lands as a property, a contact and a deal the same way /ingest
 * lands the extension's finds.
 *
 * It reports through the tables the Deal Machine screen already reads
 * (migration 84): it is a device named `clozr-cloud` that heartbeats, takes the
 * RUN / PAUSE / RESUME / STOP commands addressed to it, writes runs with counts
 * and per-source diagnostics, and writes its log. Nothing about the screen has
 * to know a server is doing the work instead of a laptop.
 *
 * One action, service role only (pg_cron every two minutes through
 * public.dm_cloud_kick(), and at once when a command for the cloud is queued):
 *
 *   tick  { workspace_id? }  take commands, start a scheduled run when one is
 *                            due (8:00 and 18:00 Central), move running runs on
 *                            (Apify status → read the dataset → judge → land),
 *                            heartbeat.
 *
 * A run spans many ticks: Apify actors take minutes, and a tick stops reading
 * after ~100s and picks up at the same dataset offset next time. A lease on the
 * run row keeps two ticks from working one run.
 *
 * Secrets: the workspace's Apify token (workspace_integration_secrets.apify_token,
 * saved write-only from the screen) or the APIFY_TOKEN project secret.
 * Actors: APIFY_INVESTORLIFT_ACTOR, APIFY_FB_GROUPS_ACTOR override the defaults.
 *
 * Deploy:  supabase functions deploy deal-machine-cloud
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { type SupabaseClient, createClient } from 'jsr:@supabase/supabase-js@2';
import { bearerOf, isServiceCaller } from '../_shared/security.ts';
import {
  BUYBOX_STATES, type Candidate, type DmSource, type JudgeSettings, type LandPolicy, type Verdict, describe, fromFacebookPost, fromInvestorLift,
  judge, shouldLand, toEnvelope,
} from '../_shared/deal-machine-engine.ts';
import { dealColumns, dealLinks, hasDealFacts, nameIsAddress } from '../_shared/ingest-deal.ts';
import { hasRoundRobin, roundRobinLead } from '../_shared/round-robin.ts';

const DEVICE = 'clozr-cloud';
const SOURCE = 'deal_machine';
const APIFY = 'https://api.apify.com/v2';
const IL_ACTOR = (Deno.env.get('APIFY_INVESTORLIFT_ACTOR') ?? '').trim() || 'convertfleetdotonline~investorlift-property-scraper';
const FB_ACTOR = (Deno.env.get('APIFY_FB_GROUPS_ACTOR') ?? '').trim() || 'apify~facebook-groups-scraper';
const TICK_BUDGET_MS = 100_000;
const LEASE_MS = 150_000;
const COMMAND_TTL_MS = 60 * 60 * 1000;
const PAGE = 100;
const ACTIVE = ['running', 'paused', 'stopping'];
/** What the cloud can do. The buyers-list bot and the group jobs still need a browser. */
const CLOUD_COMMANDS = new Set(['run', 'scrape', 'pause', 'resume', 'stop', 'force_reset']);
const SCHEDULE_HOURS = [8, 18];

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

type Db = SupabaseClient;
// deno-lint-ignore no-explicit-any
type Any = any;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ---- settings ---------------------------------------------------------------------

type Cloud = {
  enabled: boolean;
  investorlift: boolean;
  facebook: boolean;
  /** Most InvestorLift rows the actor returns per run. */
  ilMaxItems: number;
  fbPostsPerGroup: number;
  fbMaxGroups: number;
  /** Posts older than this are skipped. */
  fbDays: number;
  land: LandPolicy;
};
const CLOUD_DEFAULTS: Cloud = { enabled: false, investorlift: true, facebook: true, ilMaxItems: 500, fbPostsPerGroup: 40, fbMaxGroups: 25, fbDays: 3, land: 'buybox' };

type Settings = JudgeSettings & { autoRun: boolean; dryRun: boolean; autoCompr: boolean; cloud: Cloud };

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

function settingsOf(raw: Any): Settings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const c = { ...CLOUD_DEFAULTS, ...(r.cloud && typeof r.cloud === 'object' ? r.cloud : {}) };
  const states = Array.isArray(r.markets?.enabledStates) ? r.markets.enabledStates.map(String) : [];
  return {
    autoRun: r.autoRun === true,
    dryRun: r.dryRun === true,
    autoCompr: r.integrations?.autoCompr !== false,
    deal: { maoPct: clamp(r.deal?.maoPct, 40, 95, 70), minArv: clamp(r.deal?.minArv, 0, 1e8, 80_000), maxArv: clamp(r.deal?.maxArv, 0, 1e8, 600_000) },
    markets: {
      enabledStates: states,
      enabledCities: Array.isArray(r.markets?.enabledCities) ? r.markets.enabledCities.map(String) : [],
      mode: r.markets?.mode === 'loose' ? 'loose' : 'strict',
    },
    cloud: {
      enabled: c.enabled === true,
      investorlift: c.investorlift !== false,
      facebook: c.facebook !== false,
      ilMaxItems: clamp(c.ilMaxItems, 20, 5000, CLOUD_DEFAULTS.ilMaxItems),
      fbPostsPerGroup: clamp(c.fbPostsPerGroup, 5, 200, CLOUD_DEFAULTS.fbPostsPerGroup),
      fbMaxGroups: clamp(c.fbMaxGroups, 1, 200, CLOUD_DEFAULTS.fbMaxGroups),
      fbDays: clamp(c.fbDays, 1, 30, CLOUD_DEFAULTS.fbDays),
      land: c.land === 'qualified' || c.land === 'valid' ? c.land : 'buybox',
    },
  };
}

// ---- Apify --------------------------------------------------------------------------

async function apifyToken(db: Db, ws: number): Promise<string> {
  const { data } = await db.from('workspace_integration_secrets').select('apify_token').eq('workspace_id', ws).maybeSingle();
  return String((data as { apify_token?: string } | null)?.apify_token ?? '').trim() || (Deno.env.get('APIFY_TOKEN') ?? '').trim();
}

async function apify(token: string, path: string, init: RequestInit = {}): Promise<Any> {
  const res = await fetch(`${APIFY}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 240);
    throw new Error(`Apify ${res.status}${res.status === 401 ? ' (token refused)' : res.status === 402 ? ' (out of Apify credit)' : ''}: ${body}`);
  }
  return await res.json();
}

async function startActor(token: string, actor: string, input: unknown, maxItems?: number): Promise<{ id: string; datasetId: string }> {
  const qs = maxItems ? `?maxItems=${maxItems}` : '';
  const { data } = await apify(token, `/acts/${encodeURIComponent(actor)}/runs${qs}`, { method: 'POST', body: JSON.stringify(input) });
  return { id: String(data.id), datasetId: String(data.defaultDatasetId) };
}

// ---- run state ------------------------------------------------------------------------

type SourceState = {
  status: 'running' | 'reading' | 'done' | 'failed' | 'skipped';
  apifyRunId?: string;
  datasetId?: string;
  offset: number;
  total?: number;
  note?: string;
  scraped: number; valid: number; qualified: number; buybox: number; landed: number; deduped: number; rejected: number; errors: number;
};
type CloudState = {
  sources: Partial<Record<DmSource, SourceState>>;
  /** Why finds did not land, counted. */
  reasons: Record<string, number>;
  /** Facebook group url → what came out of it this run. */
  groups: Record<string, { posts: number; deals: number }>;
  withAddress: number; withArv: number; withAsking: number;
};
const emptySource = (status: SourceState['status'], note?: string): SourceState =>
  ({ status, note, offset: 0, scraped: 0, valid: 0, qualified: 0, buybox: 0, landed: 0, deduped: 0, rejected: 0, errors: 0 });

type Run = { id: number; status: string; dryRun: boolean; cloud: CloudState; startedAt: string };

function countsOf(st: CloudState) {
  const s = Object.values(st.sources).filter(Boolean) as SourceState[];
  const sum = (k: keyof SourceState) => s.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  return {
    scraped: sum('scraped'), valid: sum('valid'), qualified: sum('qualified'), buybox: sum('buybox'),
    clozr: sum('landed'), deduped: sum('deduped'), rejected: sum('rejected'), errors: sum('errors'),
  };
}

function diagOf(st: CloudState) {
  const out: Record<string, unknown> = { runtime: 'cloud', withAddress: st.withAddress, withArv: st.withArv, withAskingPrice: st.withAsking, reasons: st.reasons };
  for (const [k, v] of Object.entries(st.sources)) {
    if (!v) continue;
    out[k] = { scraped: v.scraped, valid: v.valid, qualified: v.qualified, landed: v.landed, errors: v.errors, status: v.status, note: v.note ?? null };
  }
  return out;
}

/** 0–100 for the screen's bar: each source's share, Apify running = a quarter, reading = by offset. */
function progressOf(st: CloudState): { step: number; total: number; label: string } {
  const s = Object.entries(st.sources).filter(([, v]) => v && v.status !== 'skipped') as [DmSource, SourceState][];
  if (!s.length) return { step: 0, total: 100, label: 'starting' };
  let done = 0;
  for (const [, v] of s) {
    if (v.status === 'done' || v.status === 'failed') done += 1;
    else if (v.status === 'reading') done += 0.3 + 0.7 * (v.total ? Math.min(1, v.offset / v.total) : 0);
    else done += 0.15;
  }
  return { step: Math.round((done / s.length) * 100), total: 100, label: stepOf(st) };
}

function stepOf(st: CloudState): string {
  const name: Record<DmSource, string> = { investorlift: 'InvestorLift', facebook: 'Facebook groups' };
  const parts = (Object.entries(st.sources) as [DmSource, SourceState | undefined][])
    .filter(([, v]) => v && v.status !== 'skipped')
    .map(([k, v]) => {
      if (v!.status === 'running') return `${name[k]}: Apify pulling`;
      if (v!.status === 'reading') return `${name[k]}: judging ${v!.offset}${v!.total ? `/${v!.total}` : ''}`;
      return `${name[k]}: ${v!.status}`;
    });
  return parts.join(' · ') || 'starting';
}

// ---- log ----------------------------------------------------------------------------------

type Line = { level: 'error' | 'warn' | 'info' | 'debug'; tag: string; msg: string };
class Log {
  lines: Line[] = [];
  constructor(private db: Db, private ws: number, private runId: number | null) {}
  add(level: Line['level'], tag: string, msg: string) { this.lines.push({ level, tag, msg: msg.slice(0, 2000) }); }
  async flush() {
    if (!this.lines.length) return;
    const ts = Date.now();
    const rows = this.lines.splice(0).map((l, i) => ({
      workspace_id: this.ws, run_id: this.runId, device_id: DEVICE, ts: new Date(ts + i).toISOString(), level: l.level, tag: l.tag, msg: l.msg,
    }));
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await this.db.from('dm_run_log').insert(rows.slice(i, i + 400));
      if (error) console.error('dm cloud log', error.message);
    }
  }
}

// ---- landing (the deal half of /ingest, for a find this function judged) -------------------

type Source = { id: number; settings: Any };

/**
 * ingest_apply for the property and contact, then the deal row, photos, COMPR
 * and round robin — what ingest/index.ts does after its key check, so a cloud
 * find and an extension find are the same kind of record. Returns whether the
 * deal is new.
 */
async function land(db: Db, ws: number, src: Source, env: Any): Promise<{ created: boolean; dealId: number | null; deduped: boolean }> {
  if (env.person && nameIsAddress(env.person.name, env.property?.line1)) delete env.person.name;
  if (env.person && !env.person.name && !env.person.phone && !env.person.email) delete env.person;
  const { data, error } = await db.rpc('ingest_apply', { p_workspace_id: ws, p_envelope: env });
  if (error) throw new Error(`ingest_apply: ${error.message}`);
  const applied = data as { deduped?: boolean; property_id?: number | null; seller_id?: number | null };
  let created = false;
  let dealId: number | null = null;
  if (applied.property_id && hasDealFacts(env.deal)) {
    const cols = dealColumns(env.deal);
    const { data: found } = await db.from('deals').select('id, seller_id').eq('workspace_id', ws).eq('source', SOURCE).eq('source_id', env.source_id).order('id').limit(1);
    if (found?.length) {
      dealId = found[0].id as number;
      const { error: upErr } = await db.from('deals').update({ ...cols, ...(found[0].seller_id ? {} : { seller_id: applied.seller_id ?? null }), updated_at: new Date().toISOString() }).eq('id', dealId);
      if (upErr) throw new Error(`deal update: ${upErr.message}`);
    } else {
      const { data: made, error: insErr } = await db.from('deals').insert({
        workspace_id: ws, property_id: applied.property_id, seller_id: applied.seller_id ?? null, stage: 'Prospect', source: SOURCE,
        source_id: env.source_id, submitted_at: env.occurred_at ?? new Date().toISOString(), ...cols,
      }).select('id').single();
      if (insErr) throw new Error(`deal insert: ${insErr.message}`);
      dealId = made.id as number;
      created = true;
    }
    const links = dealLinks(env.deal);
    if (links.length) {
      const { data: have } = await db.from('deal_files').select('url').eq('deal_id', dealId).not('url', 'is', null);
      const known = new Set((have ?? []).map((r) => r.url as string));
      const rows = links.filter((l) => !known.has(l.url)).map((l) => ({ workspace_id: ws, deal_id: dealId, source: SOURCE, ...l }));
      if (rows.length) await db.from('deal_files').insert(rows);
    }
    const keyAllows = (src.settings as { auto_compr?: string } | null)?.auto_compr !== 'off';
    if (created && env.options?.run_compr === true && keyAllows && applied.seller_id) EdgeRuntime.waitUntil(queueCompr(ws, applied.seller_id, dealId));
  }
  if (hasRoundRobin(src.settings) && !applied.deduped && applied.seller_id) await roundRobinLead(db, src.id, applied.seller_id);
  return { created, dealId, deduped: !!applied.deduped && !created };
}

async function queueCompr(ws: number, sellerId: number, dealId: number) {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/compr-underwrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      body: JSON.stringify({ workspace_id: ws, seller_id: sellerId, deal_id: dealId }),
    });
    if (!res.ok) console.error('dm cloud compr', { status: res.status, deal: dealId });
  } catch (e) {
    console.error('dm cloud compr', { deal: dealId, err: (e as Error).message });
  }
}

// ---- runs ------------------------------------------------------------------------------------

function mapRun(r: Any): Run {
  const c = r.cloud && typeof r.cloud === 'object' ? r.cloud : {};
  return {
    id: Number(r.id), status: String(r.status), dryRun: !!r.dry_run, startedAt: String(r.started_at),
    cloud: { sources: c.sources ?? {}, reasons: c.reasons ?? {}, groups: c.groups ?? {}, withAddress: c.withAddress ?? 0, withArv: c.withArv ?? 0, withAsking: c.withAsking ?? 0 },
  };
}

async function save(db: Db, run: Run, extra: Record<string, unknown> = {}) {
  const { error } = await db.from('dm_runs').update({
    cloud: run.cloud, counts: countsOf(run.cloud), diag: diagOf(run.cloud), step: stepOf(run.cloud), ...extra,
  }).eq('id', run.id);
  if (error) console.error('dm cloud save', run.id, error.message);
}

async function startRun(db: Db, ws: number, s: Settings, trigger: string, opts: { commandId?: number; runKey?: string } = {}): Promise<Run | null> {
  const runKey = opts.runKey ?? `cloud:${new Date().toISOString()}`;
  const st: CloudState = { sources: {}, reasons: {}, groups: {}, withAddress: 0, withArv: 0, withAsking: 0 };
  const { data: row, error } = await db.from('dm_runs').insert({
    workspace_id: ws, device_id: DEVICE, run_key: runKey, kind: 'machine', trigger, status: 'running', dry_run: s.dryRun,
    command_id: opts.commandId ?? null, step: 'starting', cloud: st, counts: {},
  }).select('*').single();
  if (error) {
    if (error.code === '23505') return null; // this schedule slot already ran
    throw new Error(`run insert: ${error.message}`);
  }
  const run = mapRun(row);
  const log = new Log(db, ws, run.id);
  const fail = async (msg: string) => {
    log.add('error', 'Cloud', msg);
    await log.flush();
    await db.from('dm_runs').update({ status: 'failed', error: msg, ended_at: new Date().toISOString(), step: null }).eq('id', run.id);
    return { ...run, status: 'failed' };
  };

  const { data: src } = await db.from('ingest_sources').select('id').eq('workspace_id', ws).eq('name', SOURCE).eq('active', true).limit(1).maybeSingle();
  if (!src) return await fail('No active Deal Machine key. An owner or admin issues it under Deal Machine → Settings → Integrations; cloud finds land under it.');
  const token = await apifyToken(db, ws);
  if (!token) return await fail('No Apify token. An owner or admin pastes it under Deal Machine → Settings → Cloud.');

  log.add('info', 'Cloud', `Run started (${trigger}${s.dryRun ? ', dry run' : ''}). Landing ${s.cloud.land === 'qualified' ? 'only deals that clear the MAO' : s.cloud.land === 'buybox' ? 'buy-box deals' : 'every real house deal'}.`);

  if (s.cloud.investorlift) {
    const states = BUYBOX_STATES.filter((x) => s.markets.mode === 'loose' || !s.markets.enabledStates.length || s.markets.enabledStates.map((y) => y.toUpperCase()).includes(x));
    try {
      const r = await startActor(token, IL_ACTOR, { mode: 'active', states, propertyTypes: [], propertyUrls: [] }, s.cloud.ilMaxItems);
      st.sources.investorlift = { ...emptySource('running'), apifyRunId: r.id, datasetId: r.datasetId };
      log.add('info', 'InvestorLift', `Apify pull started for ${states.length} states (up to ${s.cloud.ilMaxItems} listings).`);
    } catch (e) {
      st.sources.investorlift = { ...emptySource('failed', (e as Error).message), errors: 1 };
      log.add('error', 'InvestorLift', `Could not start the Apify pull: ${(e as Error).message}`);
    }
  } else st.sources.investorlift = emptySource('skipped', 'off in Settings → Cloud');

  if (s.cloud.facebook) {
    const { data: groups } = await db.from('dm_groups').select('url').eq('workspace_id', ws).eq('active', true).order('last_scraped_at', { ascending: true, nullsFirst: true }).limit(s.cloud.fbMaxGroups);
    const urls = (groups ?? []).map((g) => String(g.url));
    if (!urls.length) {
      st.sources.facebook = emptySource('skipped', 'no active groups');
      log.add('warn', 'Facebook', 'No active Facebook groups. Add them in Buyr → Facebook groups.');
    } else {
      try {
        const r = await startActor(token, FB_ACTOR, { startUrls: urls.map((url) => ({ url })), resultsLimit: s.cloud.fbPostsPerGroup, maxPostsPerProfile: s.cloud.fbPostsPerGroup }, urls.length * s.cloud.fbPostsPerGroup);
        st.sources.facebook = { ...emptySource('running'), apifyRunId: r.id, datasetId: r.datasetId };
        log.add('info', 'Facebook', `Apify pull started for ${urls.length} group${urls.length === 1 ? '' : 's'} (${s.cloud.fbPostsPerGroup} posts each, last ${s.cloud.fbDays} days kept).`);
      } catch (e) {
        st.sources.facebook = { ...emptySource('failed', (e as Error).message), errors: 1 };
        log.add('error', 'Facebook', `Could not start the Apify pull: ${(e as Error).message}`);
      }
    }
  } else st.sources.facebook = emptySource('skipped', 'off in Settings → Cloud');

  run.cloud = st;
  await save(db, run);
  await log.flush();
  return run;
}

/** Stop a run: abort the Apify actors still going and close the row. */
async function stopRun(db: Db, ws: number, run: Run, why: string) {
  const token = await apifyToken(db, ws);
  for (const v of Object.values(run.cloud.sources)) {
    if (v?.status === 'running' && v.apifyRunId && token) await apify(token, `/actor-runs/${v.apifyRunId}/abort`, { method: 'POST' }).catch(() => null);
  }
  const log = new Log(db, ws, run.id);
  log.add('warn', 'Cloud', why);
  await log.flush();
  await save(db, run, { status: 'stopped', ended_at: new Date().toISOString(), step: null, lease_until: null });
}

async function finishRun(db: Db, ws: number, run: Run, log: Log) {
  const sources = Object.values(run.cloud.sources).filter(Boolean) as SourceState[];
  const failed = sources.filter((v) => v.status === 'failed');
  const allFailed = failed.length > 0 && sources.every((v) => v.status === 'failed' || v.status === 'skipped');
  const c = countsOf(run.cloud);
  const top = Object.entries(run.cloud.reasons).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, n]) => `${n}× ${r}`).join(' · ');
  log.add(allFailed ? 'error' : 'info', 'Cloud',
    `Done. ${c.scraped} read · ${c.valid} real deals · ${c.qualified} clear the MAO · ${run.dryRun ? `${c.qualified + c.buybox} would land (dry run)` : `${c.clozr} new in CLOZR, ${c.deduped} already there`}.`);
  if (top) log.add('info', 'Cloud', `Not landed: ${top}`);
  await log.flush();

  // What each Facebook group gave, so a dead group is visible in Buyr.
  for (const [url, g] of Object.entries(run.cloud.groups)) {
    await db.from('dm_groups').update({ last_scraped_at: new Date().toISOString(), last_result: { posts: g.posts, deals: g.deals, runtime: 'cloud' }, updated_at: new Date().toISOString() })
      .eq('workspace_id', ws).ilike('url', url.replace(/\/+$/, '') + '%');
  }
  await save(db, run, {
    status: allFailed ? 'failed' : 'done', ended_at: new Date().toISOString(), step: null, lease_until: null,
    error: failed.length ? failed.map((f) => f.note).filter(Boolean).join(' · ').slice(0, 2000) || null : null,
  });
  // The log keeps 14 days, as the extension's door prunes it (deal-machine/index.ts).
  await db.from('dm_run_log').delete().eq('workspace_id', ws).lt('ts', new Date(Date.now() - 14 * 86_400_000).toISOString());
}

const GROUP_KEY = (item: Any): string | null => {
  const u = String(item?.inputUrl ?? item?.facebookUrl ?? '').match(/^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/groups\/[^/?#]+/i);
  return u ? `https://www.facebook.com/groups/${u[0].split('/groups/')[1]}/` : null;
};

/** One run forward: poll the actors, then read, judge and land until the tick's time is up. */
async function advance(db: Db, ws: number, run: Run, s: Settings, deadline: number) {
  const log = new Log(db, ws, run.id);
  const token = await apifyToken(db, ws);
  const { data: src } = await db.from('ingest_sources').select('id, settings').eq('workspace_id', ws).eq('name', SOURCE).eq('active', true).limit(1).maybeSingle();
  if (!token || !src) {
    log.add('error', 'Cloud', !token ? 'The Apify token was removed mid-run.' : 'The Deal Machine key was disabled mid-run.');
    await log.flush();
    await save(db, run, { status: 'failed', ended_at: new Date().toISOString(), step: null, lease_until: null, error: 'lost its token or key' });
    return;
  }
  const name: Record<DmSource, string> = { investorlift: 'InvestorLift', facebook: 'Facebook' };
  const bump = (reason: string) => { run.cloud.reasons[reason] = (run.cloud.reasons[reason] ?? 0) + 1; };

  for (const key of ['investorlift', 'facebook'] as DmSource[]) {
    const v = run.cloud.sources[key];
    if (!v || Date.now() > deadline) continue;

    if (v.status === 'running') {
      try {
        const { data } = await apify(token, `/actor-runs/${v.apifyRunId}`);
        const status = String(data?.status ?? '');
        if (status === 'SUCCEEDED') {
          const { data: ds } = await apify(token, `/datasets/${v.datasetId}`).catch(() => ({ data: null }));
          v.total = Number(ds?.itemCount ?? 0) || undefined;
          v.status = 'reading';
          log.add('info', name[key], `Apify finished: ${v.total ?? 'some'} rows to judge.`);
        } else if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
          v.status = 'failed';
          v.errors++;
          v.note = `Apify run ${status.toLowerCase()}`;
          log.add('error', name[key], `${v.note}. Its log is at console.apify.com/actors/runs/${v.apifyRunId}.`);
        }
      } catch (e) {
        v.errors++;
        log.add('warn', name[key], `Could not read the Apify run: ${(e as Error).message}`);
      }
    }

    while (v.status === 'reading' && Date.now() < deadline) {
      let items: Any[];
      try {
        items = await apify(token, `/datasets/${v.datasetId}/items?clean=true&offset=${v.offset}&limit=${PAGE}`);
      } catch (e) {
        v.errors++;
        log.add('warn', name[key], `Could not read rows at ${v.offset}: ${(e as Error).message}`);
        break;
      }
      if (!Array.isArray(items) || !items.length) {
        v.status = 'done';
        log.add('info', name[key], `Judged ${v.scraped}: ${v.valid} real deals, ${v.qualified} clear the MAO, ${v.landed} new in CLOZR.`);
        break;
      }
      for (const item of items) {
        if (Date.now() > deadline) break;
        v.offset++;
        v.scraped++;
        const gk = key === 'facebook' ? GROUP_KEY(item) : null;
        if (gk) run.cloud.groups[gk] = { posts: (run.cloud.groups[gk]?.posts ?? 0) + 1, deals: run.cloud.groups[gk]?.deals ?? 0 };
        let c: Candidate | null;
        try {
          c = key === 'investorlift' ? fromInvestorLift(item) : fromFacebookPost(item, Date.now(), s.cloud.fbDays);
        } catch {
          c = null;
        }
        if (!c) {
          v.rejected++;
          bump(key === 'facebook' ? 'not a deal post, or older than the window' : 'off market or unreadable');
          continue;
        }
        if (c.line1) run.cloud.withAddress++;
        if (c.arv !== null) run.cloud.withArv++;
        if (c.asking !== null) run.cloud.withAsking++;
        const verdict: Verdict = judge(c, s);
        if (verdict.status === 'rejected') {
          v.rejected++;
          bump(verdict.reason.replace(/\d[\d,]*/g, '#'));
          log.add('debug', name[key], `skip · ${verdict.reason} · ${describe(c)}`);
          continue;
        }
        v.valid++;
        if (verdict.status === 'qualified') v.qualified++;
        if (verdict.status === 'buybox') v.buybox++;
        if (gk) run.cloud.groups[gk].deals++;
        if (!shouldLand(verdict, s.cloud.land)) {
          bump(verdict.status === 'valid' ? 'outside the buy box' : 'misses the MAO');
          log.add('debug', name[key], `hold · ${verdict.reason} · ${describe(c)}`);
          continue;
        }
        const mark = verdict.status === 'qualified' ? '✅' : verdict.status === 'buybox' ? '🟧' : '▫️';
        if (run.dryRun) {
          log.add('info', name[key], `${mark} would land · ${verdict.reason} · ${describe(c)}`);
          continue;
        }
        try {
          const env = toEnvelope(c, verdict, { runCompr: s.autoCompr, maoPct: s.deal.maoPct });
          const r = await land(db, ws, src as Source, env);
          if (r.created) {
            v.landed++;
            log.add('info', name[key], `${mark} landed · ${verdict.reason} · ${describe(c)}${r.dealId ? ` · deal ${r.dealId}` : ''}`);
          } else {
            v.deduped++;
            log.add('debug', name[key], `already in CLOZR · ${describe(c)}`);
          }
        } catch (e) {
          v.errors++;
          log.add('error', name[key], `Could not land ${describe(c)}: ${(e as Error).message}`);
        }
      }
      await save(db, run);
      await log.flush();
    }
  }

  const sources = Object.values(run.cloud.sources).filter(Boolean) as SourceState[];
  if (sources.every((x) => ['done', 'failed', 'skipped'].includes(x.status))) {
    await finishRun(db, ws, run, log);
    return;
  }
  await save(db, run, { lease_until: null });
  await log.flush();
}

// ---- the tick -------------------------------------------------------------------------------

/** "2026-10-08:08" when it is 8 or 18 o'clock in Central, else null. */
function scheduleSlot(now = new Date()): string | null {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const hour = Number(p.hour);
  return SCHEDULE_HOURS.includes(hour) ? `${p.year}-${p.month}-${p.day}:${String(hour).padStart(2, '0')}` : null;
}

async function activeRun(db: Db, ws: number): Promise<Run | null> {
  const { data } = await db.from('dm_runs').select('*').eq('workspace_id', ws).eq('device_id', DEVICE).in('status', ACTIVE).order('started_at', { ascending: false }).limit(1);
  return data?.length ? mapRun(data[0]) : null;
}

async function finishCommand(db: Db, id: number, ok: boolean, result: unknown) {
  await db.from('dm_commands').update({ status: ok ? 'done' : 'failed', finished_at: new Date().toISOString(), result }).eq('id', id);
}

async function workspaceTick(db: Db, ws: number, deadline: number) {
  const { data: srow } = await db.from('dm_settings').select('settings, version').eq('workspace_id', ws).maybeSingle();
  const s = settingsOf(srow?.settings);
  let run = await activeRun(db, ws);

  // Commands addressed to the cloud. Stale ones expire like the extension's.
  await db.from('dm_commands').update({ status: 'expired', finished_at: new Date().toISOString() })
    .eq('workspace_id', ws).eq('device_id', DEVICE).eq('status', 'pending').lt('created_at', new Date(Date.now() - COMMAND_TTL_MS).toISOString());
  const { data: pending } = await db.from('dm_commands').select('id, command').eq('workspace_id', ws).eq('device_id', DEVICE).eq('status', 'pending').order('created_at').limit(10);
  for (const cmd of pending ?? []) {
    const { data: claimed } = await db.from('dm_commands').update({ status: 'acked', acked_at: new Date().toISOString() }).eq('id', cmd.id).eq('status', 'pending').select('id');
    if (!claimed?.length) continue;
    const c = String(cmd.command);
    if (!CLOUD_COMMANDS.has(c)) { await finishCommand(db, cmd.id, false, { error: 'This job needs the Chrome extension; the cloud runs the deal scrape only.' }); continue; }
    if (c === 'run' || c === 'scrape') {
      if (!s.cloud.enabled) { await finishCommand(db, cmd.id, false, { error: 'Cloud runs are off (Settings → Cloud).' }); continue; }
      if (run) { await finishCommand(db, cmd.id, false, { error: 'A run is already on.' }); continue; }
      run = await startRun(db, ws, s, 'manual', { commandId: cmd.id });
      await finishCommand(db, cmd.id, !!run && run.status !== 'failed', { run_id: run?.id ?? null });
      if (run?.status === 'failed') run = null;
    } else if (c === 'pause' || c === 'resume') {
      const from = c === 'pause' ? 'running' : 'paused';
      if (run?.status === from) {
        await db.from('dm_runs').update({ status: c === 'pause' ? 'paused' : 'running' }).eq('id', run.id);
        run.status = c === 'pause' ? 'paused' : 'running';
      }
      await finishCommand(db, cmd.id, true, { run_id: run?.id ?? null });
    } else {
      if (run) await stopRun(db, ws, run, c === 'force_reset' ? 'Force reset from CLOZR.' : 'Stopped from CLOZR.');
      run = null;
      await finishCommand(db, cmd.id, true, {});
    }
  }

  // The schedule: one run per slot, keyed so a second tick in the same hour is a no-op.
  if (!run && s.cloud.enabled && s.autoRun) {
    const slot = scheduleSlot();
    if (slot) {
      const made = await startRun(db, ws, s, 'schedule', { runKey: `cloud:sched:${slot}` });
      if (made && made.status !== 'failed') run = made;
    }
  }

  // Move the run on, holding a lease so an overlapping tick leaves it alone.
  if (run && run.status === 'running') {
    const until = new Date(Date.now() + LEASE_MS).toISOString();
    const { data: leased } = await db.from('dm_runs').update({ lease_until: until }).eq('id', run.id).eq('status', 'running')
      .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).select('*');
    if (leased?.length) {
      run = mapRun(leased[0]);
      await advance(db, ws, run, s, deadline);
      run = await activeRun(db, ws);
    }
  }

  // Heartbeat: the cloud is "on" while it is switched on or still finishing a run.
  if (s.cloud.enabled || run) {
    const prog = run ? progressOf(run.cloud) : null;
    await db.from('dm_devices').upsert({
      workspace_id: ws, device_id: DEVICE, label: 'CLOZR Cloud', version: 'cloud',
      run_state: run ? (run.status === 'paused' ? 'paused' : run.status === 'stopping' ? 'stopping' : 'running') : 'idle',
      is_running: !!run, step: run ? stepOf(run.cloud) : null, progress: prog ?? {}, stats: run ? countsOf(run.cloud) : {},
      settings_version: Number(srow?.version ?? 0), last_seen_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,device_id' });
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } });
  if (!(await isServiceCaller(db, bearerOf(req)))) return json({ error: 'service role only' }, 403);
  const body = await req.json().catch(() => ({})) as { action?: string; workspace_id?: number };
  if ((body.action ?? 'tick') !== 'tick') return json({ error: `unknown action "${body.action}"` }, 422);

  const deadline = Date.now() + TICK_BUDGET_MS;
  const wanted = new Set<number>();
  const only = Number(body.workspace_id) || null;
  const [on, cmds, runs] = await Promise.all([
    db.from('dm_settings').select('workspace_id').eq('settings->cloud->>enabled', 'true'),
    db.from('dm_commands').select('workspace_id').eq('device_id', DEVICE).eq('status', 'pending').limit(200),
    db.from('dm_runs').select('workspace_id').eq('device_id', DEVICE).in('status', ACTIVE).limit(200),
  ]);
  for (const r of [...(on.data ?? []), ...(cmds.data ?? []), ...(runs.data ?? [])]) wanted.add(Number(r.workspace_id));
  if (only) for (const w of [...wanted]) if (w !== only) wanted.delete(w);

  const results: Record<number, string> = {};
  for (const ws of wanted) {
    try {
      await workspaceTick(db, ws, deadline);
      results[ws] = 'ok';
    } catch (e) {
      console.error('dm cloud tick', ws, (e as Error).message);
      results[ws] = 'error';
    }
  }
  return json({ ok: true, workspaces: results });
});
