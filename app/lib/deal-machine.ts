// Deal Machine — CLOZR's own program for the scraper, with the Chrome
// extension as its runtime.
//
// The extension is the only part that has to live in a browser: it opens
// InvestorLift, Facebook groups and RealEstateBees as a logged-in person and
// reads the page. Everything it used to keep in its popup lives here instead
// (migration 84): the settings and buy box it scrapes against, the Facebook
// groups it works, the RUN / PAUSE / STOP it obeys, the run it is on, the log
// it writes and the buyers lists it opted into. The extension pulls this every
// minute through the `deal-machine` edge function and pushes its progress back
// through the same door; what it finds still lands through /ingest as deals,
// contacts and buyers.
//
// So the screen can answer the real questions honestly: is the extension on
// (a device seen in the last five minutes), what is it doing (the running
// row), what did it find (deals with source 'deal_machine'), and why did it
// skip something (the log).
//
// Since migration 187 the deal job also runs without a Chrome: with Cloud on,
// the `deal-machine-cloud` function pulls InvestorLift and the Facebook groups
// through Apify, judges every find against the buy box and the MAO
// (supabase/functions/_shared/deal-machine-engine.ts) and lands the good ones.
// It is just another device to this screen, `clozr-cloud`, and RUN / PAUSE /
// RESUME / STOP are addressed to it. The buyers-list bot and the Facebook
// group jobs still need the extension.
'use client';

import { supabase } from './supabase';
import { type IngestKey, listKeys } from './ingest';

/** The name an ingest key must have for the extension to be allowed to use it. */
export const DEAL_MACHINE_SOURCE = 'deal_machine';

/** A device is "on" when its heartbeat is this fresh. The extension syncs every minute, the cloud every two. */
export const DEVICE_ONLINE_MS = 5 * 60 * 1000;

/** The device id the cloud runner reports as (migration 187). */
export const CLOUD_DEVICE_ID = 'clozr-cloud';

/** Commands the cloud runner takes. The rest need a browser. */
export const CLOUD_COMMANDS = new Set(['run', 'scrape', 'pause', 'resume', 'stop', 'force_reset']);

/** What lands as a CLOZR deal: only MAO-clearing deals, every buy-box deal, or every real house deal. */
export type LandPolicy = 'qualified' | 'buybox' | 'valid';

// ---- settings ---------------------------------------------------------------

/**
 * The extension's configuration, as one object. Field names follow the
 * extension's own storage keys so the bridge on its side is a plain copy.
 * Secrets (Apify, Firecrawl, Sheets tokens) are deliberately absent: they stay
 * in the extension's local storage.
 */
export type DmSettings = {
  /** Scheduled runs (8 AM machine, 6 PM scrape, 9:30 buyers list, 10:30 group discovery). */
  autoRun: boolean;
  /** Shorter timeouts and delays. */
  fastMode: boolean;
  /** Log every deal, submit none. */
  dryRun: boolean;
  deal: {
    /** The share of ARV a deal must clear: asking ≤ maoPct% × ARV − rehab − $20k. */
    maoPct: number;
    minArv: number;
    maxArv: number;
  };
  markets: {
    enabledStates: string[];
    enabledCities: string[];
    /** strict: a deal outside the enabled states/cities is dropped; loose: it is kept and flagged. */
    mode: 'strict' | 'loose';
  };
  /** The identity the buyers-list bot types into opt-in forms. */
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    company: string;
    maxPrice: number | null;
    notes: string;
    /** The number InvestorLift texts a verification code to. */
    ilVerificationPhone: string;
  };
  buyersList: {
    /** Submit opt-in forms without a person confirming each one. */
    autoSubmit: boolean;
    /** Domains that never need confirming. */
    allowlistDomains: string[];
  };
  facebook: {
    /** Comment the deals@ address on deal posts that have no contact info. */
    autoComment: boolean;
    /** Join groups the discovery step finds. */
    autoJoin: boolean;
  };
  integrations: {
    /** Mirror finds into CLOZR through /ingest. Off means Podio only, which is the old world. */
    clozrEnabled: boolean;
    /** Ask CLOZR to underwrite each new deal (the key's Auto-run COMPR switch can still veto). */
    autoCompr: boolean;
    /** Keep the Podio JV push running beside CLOZR. */
    podioEnabled: boolean;
    firecrawlEnabled: boolean;
    firecrawlDailyLimit: number;
    apifyEnabled: boolean;
    apifyDailyLimit: number;
    sheetsWebhookEnabled: boolean;
  };
  /** Deal Machine on CLOZR's side (deal-machine-cloud): no Chrome needed for the deal scrape. */
  cloud: {
    enabled: boolean;
    investorlift: boolean;
    facebook: boolean;
    ilMaxItems: number;
    fbPostsPerGroup: number;
    fbMaxGroups: number;
    fbDays: number;
    land: LandPolicy;
  };
};

export const DEFAULT_STATES = ['AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'GA', 'IN', 'KS', 'KY', 'MA', 'MO', 'NC', 'NV', 'NY', 'OH', 'OK', 'PA', 'SC', 'TN', 'TX', 'UT'];

export const DEFAULT_SETTINGS: DmSettings = {
  autoRun: false,
  fastMode: false,
  dryRun: false,
  deal: { maoPct: 70, minArv: 80_000, maxArv: 600_000 },
  markets: { enabledStates: DEFAULT_STATES, enabledCities: [], mode: 'strict' },
  contact: { firstName: '', lastName: '', email: '', phone: '', company: 'Acme Homes', maxPrice: 500_000, notes: '', ilVerificationPhone: '' },
  buyersList: { autoSubmit: false, allowlistDomains: [] },
  facebook: { autoComment: false, autoJoin: false },
  integrations: {
    clozrEnabled: true, autoCompr: true, podioEnabled: true,
    firecrawlEnabled: false, firecrawlDailyLimit: 10, apifyEnabled: false, apifyDailyLimit: 5, sheetsWebhookEnabled: false,
  },
  cloud: { enabled: false, investorlift: true, facebook: true, ilMaxItems: 500, fbPostsPerGroup: 40, fbMaxGroups: 25, fbDays: 3, land: 'buybox' },
};

/** Defaults filled in under whatever is stored, one level deep, so an older row never leaves a field undefined. */
export function withDefaults(raw: unknown): DmSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof DmSettings, unknown>>;
  const sect = <K extends keyof DmSettings>(k: K): DmSettings[K] => {
    const d = DEFAULT_SETTINGS[k];
    const v = r[k];
    if (typeof d !== 'object' || d === null) return (v === undefined ? d : v) as DmSettings[K];
    return { ...(d as object), ...((v && typeof v === 'object' ? v : {}) as object) } as DmSettings[K];
  };
  return {
    autoRun: sect('autoRun'), fastMode: sect('fastMode'), dryRun: sect('dryRun'),
    deal: sect('deal'), markets: sect('markets'), contact: sect('contact'),
    buyersList: sect('buyersList'), facebook: sect('facebook'), integrations: sect('integrations'), cloud: sect('cloud'),
  };
}

// ---- rows -------------------------------------------------------------------

export type DmDevice = {
  id: number; deviceId: string; label: string | null; version: string | null;
  runState: string; isRunning: boolean; step: string | null;
  progress: { step?: number; total?: number; label?: string } | null;
  stats: Record<string, number> | null;
  settingsVersion: number | null; lastSeenAt: string; online: boolean;
};

export type DmRun = {
  id: number; runKey: string; kind: string; trigger: string; status: string; dryRun: boolean;
  startedAt: string; endedAt: string | null; step: string | null;
  counts: { scraped?: number; valid?: number; qualified?: number; submitted?: number; clozr?: number; optedIn?: number; [k: string]: number | undefined };
  diag: Record<string, unknown> | null; error: string | null; deviceId: string | null;
};

export type DmCommand = {
  id: number; command: string; args: Record<string, unknown>; status: string;
  createdAt: string; ackedAt: string | null; finishedAt: string | null; result: unknown; requestedBy: string | null;
};

export type DmGroup = {
  id: number; url: string; name: string | null; tags: string[]; active: boolean;
  members: number | null; postsPerDay: number | null; lastScrapedAt: string | null;
  lastResult: Record<string, unknown> | null; source: string;
};

export type DmOptin = {
  id: number; domain: string; url: string | null; status: string; method: string | null; detail: string | null;
  attempts: number; firstAt: string; lastAt: string;
};

export type DmLogLine = { id: number; ts: string; level: 'error' | 'warn' | 'info' | 'debug'; tag: string | null; msg: string; runId: number | null };

export type LandedDeal = {
  id: number; sellerId: number | null; stage: string; createdAt: string;
  address: string | null; city: string | null; state: string | null;
  arv: number | null; rehab: number | null; mao: number | null; asking: number | null;
  sourceId: string | null; leadSource: string | null; heroImageUrl: string | null;
};

export type DealMachineState = {
  /** The 'deal_machine' key, or null when one has never been minted (or the role cannot read keys). */
  key: IngestKey | null;
  settings: DmSettings;
  settingsVersion: number;
  devices: DmDevice[];
  runs: DmRun[];
  /** Commands not yet finished: what the extension is about to do. */
  commands: DmCommand[];
  groups: DmGroup[];
  optins: DmOptin[];
  landed: LandedDeal[];
  totals: { deals: number; buyers: number; wholesalers: number; optedIn: number; groups: number };
  /** True when Supabase is not configured at all (the demo). */
  offline: boolean;
  /** The workspace has an Apify token saved for the cloud runner (null before migration 187). */
  apifyConnected: boolean | null;
};

type PropertyBit = { line1: string | null; city: string | null; state: string | null };
function propOf(p: PropertyBit | PropertyBit[] | null | undefined): PropertyBit | null {
  const row = Array.isArray(p) ? p[0] : p;
  return row ?? null;
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// The dm_* tables are not in database.types.ts (like discover_runs); rows come back untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (name: string) => (supabase as any).from(name);

function mapDevice(r: Row): DmDevice {
  const seen = String(r.last_seen_at ?? '');
  return {
    id: Number(r.id), deviceId: String(r.device_id), label: s(r.label), version: s(r.version),
    runState: String(r.run_state ?? 'idle'), isRunning: !!r.is_running, step: s(r.step),
    progress: r.progress ?? null, stats: r.stats ?? null, settingsVersion: num(r.settings_version),
    lastSeenAt: seen, online: Date.now() - Date.parse(seen) < DEVICE_ONLINE_MS,
  };
}
function mapRun(r: Row): DmRun {
  return {
    id: Number(r.id), runKey: String(r.run_key), kind: String(r.kind ?? 'machine'), trigger: String(r.trigger ?? 'manual'),
    status: String(r.status ?? 'running'), dryRun: !!r.dry_run, startedAt: String(r.started_at), endedAt: s(r.ended_at),
    step: s(r.step), counts: r.counts ?? {}, diag: r.diag ?? null, error: s(r.error), deviceId: s(r.device_id),
  };
}
function mapCommand(r: Row): DmCommand {
  return {
    id: Number(r.id), command: String(r.command), args: r.args ?? {}, status: String(r.status), createdAt: String(r.created_at),
    ackedAt: s(r.acked_at), finishedAt: s(r.finished_at), result: r.result ?? null, requestedBy: s(r.requested_by),
  };
}
function mapGroup(r: Row): DmGroup {
  return {
    id: Number(r.id), url: String(r.url), name: s(r.name), tags: Array.isArray(r.tags) ? r.tags.map(String) : [], active: r.active !== false,
    members: num(r.members), postsPerDay: num(r.posts_per_day), lastScrapedAt: s(r.last_scraped_at), lastResult: r.last_result ?? null,
    source: String(r.source ?? 'clozr'),
  };
}
function mapOptin(r: Row): DmOptin {
  return {
    id: Number(r.id), domain: String(r.domain), url: s(r.url), status: String(r.status), method: s(r.method), detail: s(r.detail),
    attempts: Number(r.attempts ?? 1), firstAt: String(r.first_at), lastAt: String(r.last_at),
  };
}
function mapLanded(r: Row): LandedDeal {
  const p = propOf(r.properties);
  return {
    id: Number(r.id), sellerId: num(r.seller_id), stage: String(r.stage ?? ''), createdAt: String(r.created_at ?? ''),
    address: p?.line1 ?? null, city: p?.city ?? null, state: p?.state ?? null,
    arv: num(r.arv), rehab: num(r.rehab), mao: num(r.mao), asking: num(r.asking_price) ?? num(r.offer_amount),
    sourceId: s(r.source_id), leadSource: s(r.lead_source), heroImageUrl: s(r.hero_image_url),
  };
}

const EMPTY: DealMachineState = {
  key: null, settings: DEFAULT_SETTINGS, settingsVersion: 0, devices: [], runs: [], commands: [], groups: [], optins: [], landed: [],
  totals: { deals: 0, buyers: 0, wholesalers: 0, optedIn: 0, groups: 0 }, offline: !supabase, apifyConnected: null,
};

/** Everything the Deal Machine screen renders, in one read. */
export async function loadDealMachine(workspaceId: number | null): Promise<DealMachineState> {
  if (!supabase || !workspaceId) return { ...EMPTY, offline: !supabase };
  const w = workspaceId;

  const [keys, settingsQ, devicesQ, runsQ, commandsQ, groupsQ, optinsQ, landedQ, dealCountQ, buyerEventsQ, wholesalerEventsQ, optedInQ, apifyQ] = await Promise.all([
    listKeys(w),
    table('dm_settings').select('settings, version').eq('workspace_id', w).maybeSingle(),
    table('dm_devices').select('*').eq('workspace_id', w).order('last_seen_at', { ascending: false }),
    table('dm_runs').select('*').eq('workspace_id', w).order('started_at', { ascending: false }).limit(30),
    table('dm_commands').select('*').eq('workspace_id', w).in('status', ['pending', 'acked']).order('created_at'),
    table('dm_groups').select('*').eq('workspace_id', w).order('active', { ascending: false }).order('id'),
    table('dm_optins').select('*').eq('workspace_id', w).order('last_at', { ascending: false }).limit(200),
    supabase.from('deals')
      .select('id, seller_id, stage, created_at, arv, rehab, mao, asking_price, offer_amount, source_id, lead_source, hero_image_url, properties(line1, city, state)')
      .eq('workspace_id', w).eq('source', DEAL_MACHINE_SOURCE).order('created_at', { ascending: false }).limit(60),
    supabase.from('deals').select('id', { count: 'exact', head: true }).eq('workspace_id', w).eq('source', DEAL_MACHINE_SOURCE),
    table('ingest_events').select('id', { count: 'exact', head: true }).eq('workspace_id', w).eq('source', DEAL_MACHINE_SOURCE).eq('event_type', 'buyer.captured'),
    table('ingest_events').select('id', { count: 'exact', head: true }).eq('workspace_id', w).eq('source', DEAL_MACHINE_SOURCE).eq('event_type', 'wholesaler.captured'),
    table('dm_optins').select('id', { count: 'exact', head: true }).eq('workspace_id', w).eq('status', 'opted_in'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc('dm_apify_connected', { p_workspace_id: w }) as Promise<{ data: boolean | null; error: unknown }>,
  ]);

  const key = keys.find((k) => k.name === DEAL_MACHINE_SOURCE) ?? null;
  const groups = ((groupsQ.data ?? []) as Row[]).map(mapGroup);
  return {
    key,
    settings: withDefaults(settingsQ.data?.settings),
    settingsVersion: Number(settingsQ.data?.version ?? 0),
    devices: ((devicesQ.data ?? []) as Row[]).map(mapDevice),
    runs: ((runsQ.data ?? []) as Row[]).map(mapRun),
    commands: ((commandsQ.data ?? []) as Row[]).map(mapCommand),
    groups,
    optins: ((optinsQ.data ?? []) as Row[]).map(mapOptin),
    landed: ((landedQ.data ?? []) as Row[]).map(mapLanded),
    totals: {
      deals: dealCountQ.count ?? 0,
      buyers: buyerEventsQ.count ?? 0,
      wholesalers: wholesalerEventsQ.count ?? 0,
      optedIn: optedInQ.count ?? 0,
      groups: groups.filter((g) => g.active).length,
    },
    offline: false,
    apifyConnected: apifyQ.error ? null : !!apifyQ.data,
  };
}

// ---- writes -----------------------------------------------------------------

type Result = { ok: boolean; message?: string };
const fail = (message: string): Result => ({ ok: false, message });

export async function saveSettings(workspaceId: number, settings: DmSettings): Promise<Result> {
  if (!supabase) return fail('Supabase is not configured.');
  const { error } = await table('dm_settings').upsert({ workspace_id: workspaceId, settings }, { onConflict: 'workspace_id' });
  return error ? fail(error.message) : { ok: true };
}

/** One button press. The extension picks it up on its next sync (within a minute) and acks it. */
export async function sendCommand(workspaceId: number, command: DmCommand['command'], args: Record<string, unknown> = {}, deviceId: string | null = null): Promise<Result & { id?: number }> {
  if (!supabase) return fail('Supabase is not configured.');
  const { data: { session } } = await supabase.auth.getSession();
  const { data, error } = await table('dm_commands')
    .insert({ workspace_id: workspaceId, command, args, device_id: deviceId, requested_by: session?.user.id ?? null })
    .select('id').single();
  return error ? fail(error.message) : { ok: true, id: Number(data.id) };
}

export async function cancelCommand(id: number): Promise<Result> {
  if (!supabase) return fail('Supabase is not configured.');
  const { error } = await table('dm_commands').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending');
  return error ? fail(error.message) : { ok: true };
}

/** Save (or clear, with '') the Apify token the cloud runner uses. Owner or admin; it is never read back. */
export async function saveApifyToken(workspaceId: number, token: string): Promise<Result> {
  if (!supabase) return fail('Supabase is not configured.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc('set_dm_apify_token', { p_workspace_id: workspaceId, p_token: token });
  return error ? fail(error.message) : { ok: true };
}

export function normalizeGroupUrl(raw: string): string | null {
  const t = raw.trim();
  const m = t.match(/^(?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/groups\/([^/?#\s]+)/i);
  if (!m) return null;
  return `https://www.facebook.com/groups/${m[1]}/`;
}

export async function addGroups(workspaceId: number, urls: string[], tags: string[] = []): Promise<Result & { added?: number; rejected?: string[] }> {
  if (!supabase) return fail('Supabase is not configured.');
  const rejected: string[] = [];
  const rows = [...new Set(urls.map((u) => { const n = normalizeGroupUrl(u); if (!n && u.trim()) rejected.push(u.trim()); return n; }).filter(Boolean) as string[])]
    .map((url) => ({ workspace_id: workspaceId, url, tags, source: 'clozr' }));
  if (!rows.length) return { ok: rejected.length === 0, added: 0, rejected, message: rejected.length ? 'None of those were Facebook group links.' : undefined };
  const { error } = await table('dm_groups').upsert(rows, { onConflict: 'workspace_id,url', ignoreDuplicates: true });
  return error ? fail(error.message) : { ok: true, added: rows.length, rejected };
}

export async function updateGroup(id: number, patch: Partial<Pick<DmGroup, 'name' | 'tags' | 'active'>>): Promise<Result> {
  if (!supabase) return fail('Supabase is not configured.');
  const { error } = await table('dm_groups').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  return error ? fail(error.message) : { ok: true };
}

export async function removeGroup(id: number): Promise<Result> {
  if (!supabase) return fail('Supabase is not configured.');
  const { error } = await table('dm_groups').delete().eq('id', id);
  return error ? fail(error.message) : { ok: true };
}

/** The most recent log lines, newest last. `since` narrows to lines after that id for cheap polling. */
export async function loadLog(workspaceId: number, opts: { sinceId?: number; runId?: number | null; limit?: number } = {}): Promise<DmLogLine[]> {
  if (!supabase) return [];
  let q = table('dm_run_log').select('id, ts, level, tag, msg, run_id').eq('workspace_id', workspaceId);
  if (opts.runId) q = q.eq('run_id', opts.runId);
  if (opts.sinceId) q = q.gt('id', opts.sinceId);
  const { data } = await q.order('id', { ascending: false }).limit(opts.limit ?? 400);
  return ((data ?? []) as Row[]).map((r) => ({
    id: Number(r.id), ts: String(r.ts), level: (['error', 'warn', 'info', 'debug'].includes(r.level) ? r.level : 'info'),
    tag: s(r.tag), msg: String(r.msg ?? ''), runId: num(r.run_id),
  })).reverse();
}

/** Realtime on the tables the screen watches; returns the unsubscribe. */
export function subscribeDealMachine(workspaceId: number, onChange: () => void): () => void {
  if (!supabase) return () => {};
  const ch = supabase.channel(`dm:${workspaceId}`);
  for (const t of ['dm_runs', 'dm_devices', 'dm_commands']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `workspace_id=eq.${workspaceId}` }, onChange);
  }
  ch.subscribe();
  return () => { void supabase!.removeChannel(ch); };
}

// ---- formatting ---------------------------------------------------------------

/** "3m ago" / "2h ago" / "5d ago" — the same shape the calendar's status line uses. */
export function since(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.round(secs / 60) + 'm ago';
  if (secs < 86_400) return Math.round(secs / 3600) + 'h ago';
  return Math.round(secs / 86_400) + 'd ago';
}

/** $186,000 — blank for a missing number rather than $0, which would be a claim. */
export function money(v: number | null): string {
  return v === null ? '—' : '$' + Math.round(v).toLocaleString('en-US');
}

/** "4m 12s" for a run's duration. */
export function duration(startIso: string, endIso: string | null): string {
  const a = Date.parse(startIso);
  const b = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b)) return '—';
  const secs = Math.max(0, Math.round((b - a) / 1000));
  if (secs < 60) return secs + 's';
  const m = Math.floor(secs / 60);
  if (m < 60) return m + 'm ' + (secs % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

/** The deal clears the buy box when asking ≤ maoPct% of ARV − rehab − the $20k assignment fee. */
export function maoOf(arv: number | null, rehab: number | null, maoPct = 70): number | null {
  if (arv === null) return null;
  return Math.round(arv * (maoPct / 100) - (rehab ?? 0) - 20_000);
}

export const COMMAND_LABELS: Record<string, string> = {
  run: 'Run Deal Machine', scrape: 'Scrape only', buyers_list: 'Buyers list bot', blitz: 'Blitz: opt into all markets',
  pause: 'Pause', resume: 'Resume', stop: 'Stop', force_reset: 'Force reset', fb_discovery: 'Discover & join groups',
  join_groups: 'Join saved groups', pull_groups: 'Pull my Facebook groups', il_etl: 'InvestorLift ETL', retry_failed_optins: 'Retry failed opt-ins',
};

export const KIND_LABELS: Record<string, string> = {
  machine: 'Deal Machine', scrape: 'Scrape', buyers_list: 'Buyers list', fb_group: 'Facebook group', il_etl: 'InvestorLift ETL',
  fb_discovery: 'Group discovery', join_groups: 'Join groups', blitz: 'Blitz',
};
