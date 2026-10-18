/**
 * POST /rvm-tick — send due ringless voicemails, and take delivery receipts.
 *
 * The minute kick (rvm_kick) posts with the service-role key. Drop Cowboy and
 * Slybroadcast deposit the audio without ringing the handset and post a
 * receipt to ?drop=&t=&via=. With neither account on file, Telnyx places a
 * machine-detect call on the same URL without via: a machine gets the
 * recording (or the script, spoken) after its greeting, and a person who
 * answers is hung up. Every failure lands on rvm_drops.last_error in words
 * the RVM tab shows as they are.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { decideRvm, localMidnightIso, nextWindowOpen, zoneForRvm, DEFAULT_RVM_WINDOW, type RvmDecision, type RvmFacts } from '../../../lib/rvm.ts';
import { audioKind, dropCowboyPayload, receiptOutcome, slybroadcastFields, type CarrierAudio } from '../../../lib/rvm-carriers.ts';
import { lineUsable, marketState, rampCap, rampDay, worseRisk, type PoolLine, type RvmPoolSettings } from '../../../lib/rvm-pool.ts';
import { outreachItem, type OutreachItem } from '../../../lib/talkr-outreach.ts';
import { telnyxSetting } from '../_shared/telnyx-settings.ts';
import { postOutreach } from '../_shared/talkr-outreach.ts';
import {
  claimQueued, historyFacts, must, notesByText, once, readGates, ReadFailed, signedUrlUsable, SIGNED_URL_SECONDS, takeLine,
  type CallerPool, type Gate, type GateDb, type GateRow, type TakenLine,
} from './batch.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Drop = {
  id: number; workspace_id: number; seller_id: number | null; buyer_id: number | null;
  /** The deal the send was about (migration 194); logged on the activity row. */
  deal_id?: number | null;
  phone_e164: string | null; library_id: number | null; script: string | null;
  variant_group: string; status: string; scheduled_at: string; webhook_token: string | null;
  provider_call_id: string | null;
  /** The rep who queued it (a blast's sender, an action plan's enroller). */
  created_by?: string | null;
  from_e164?: string | null;
  provider?: string | null;
};

const TELNYX = 'https://api.telnyx.com/v2';

async function telnyx(key: string, path: string, body?: unknown, method = 'POST'): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${TELNYX}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: { errors: [{ detail: 'Telnyx did not answer.' }] } };
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

/** Telnyx's own words for a refusal ("Invalid connection_id", "Destination number is not permitted"). */
function telnyxError(r: { status: number; data: Record<string, unknown> }, fallback: string): string {
  const e = (r.data.errors as { title?: string; detail?: string }[] | undefined)?.[0];
  const why = e?.detail || e?.title;
  return (why ? `${fallback} Telnyx said: ${why}` : `${fallback} (HTTP ${r.status})`).slice(0, 240);
}

/** A stale-receipt failure the tick wrote; a real receipt arriving later still counts. */
const NO_RECEIPT = 'No delivery receipt arrived within 30 minutes.';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const url = new URL(req.url);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } });
  const dropId = Number(url.searchParams.get('drop'));
  const token = url.searchParams.get('t');
  const via = url.searchParams.get('via');
  if (dropId && token && via) return handleReceipt(admin, dropId, token, via, await readBody(req));
  if (dropId && token) return handleEvent(admin, dropId, token, await req.json().catch(() => ({})));

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  // The cron's key (vault clozr_service_role_key) and this runtime's env key can be
  // different issues of the service key; accept exactly either one (migration 193).
  if (!bearer || (bearer !== serviceKey && (await admin.rpc('is_cron_key', { p_key: bearer })).data !== true)) return json({ error: 'service role only' }, 403);
  return tick(admin);
});

async function readBody(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null);
    if (!form) return {};
    return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]));
  }
  return await req.json().catch(() => ({}));
}

/** A carrier setting, read once per tick. A failed read holds the drop rather than reading as "not set up". */
async function secret(admin: SupabaseClient, cache: Map<string, Promise<unknown>>, name: string): Promise<string | null> {
  const env = Deno.env.get(name.toUpperCase())?.trim();
  if (env) return env;
  return await once(cache, `secret:${name}`, async () => {
    const data = must(await admin.rpc('rvm_provider_secret', { p_name: name }), `the ${name} setting`);
    return typeof data === 'string' && data.trim() ? data.trim() : null;
  });
}

async function tick(admin: SupabaseClient): Promise<Response> {
  // One run at a time (migration 194): a run counts each pool line's drops
  // today once, so an overlapping run (the cron and a send-now kick) could
  // spend a line's warm-up cap twice. Before the migration there is no lease: run.
  const lease = await admin.rpc('rvm_tick_lease', { p_seconds: Math.ceil(TICK_BUDGET_MS / 1000) + 50 });
  if (!lease.error && lease.data !== true) return json({ ok: true, busy: true });
  try {
    return await tickRun(admin);
  } finally {
    if (!lease.error) await admin.rpc('rvm_tick_release').then(() => undefined, () => undefined);
  }
}

async function tickRun(admin: SupabaseClient): Promise<Response> {
  // Measured from when the drop was handed to the carrier (sent_at, set at
  // claim). This used to be created_at, so any drop queued more than half an
  // hour before it was due (every action-plan step, every drop that waited for
  // the local window) was failed on the next tick, a minute after it went out,
  // and the carrier's real receipt was then ignored.
  const stale = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: timedOut } = await admin.from('rvm_drops').update({ status: 'failed', last_error: NO_RECEIPT })
    .in('status', ['sending', 'dialing']).not('provider', 'is', null).lt('sent_at', stale).select('id, workspace_id');
  const { data: neverSent } = await admin.from('rvm_drops').update({ status: 'failed', last_error: NO_RECEIPT })
    .eq('status', 'sending').is('sent_at', null).lt('scheduled_at', stale).select('id, workspace_id');
  await logFailedMany(admin, [...(timedOut ?? []), ...(neverSent ?? [])] as { id: number; workspace_id: number }[], NO_RECEIPT);
  const pools = new Map<number, Promise<CallerPool>>();
  // Recordings, signed links and carrier settings, this tick only.
  const cache = new Map<string, Promise<unknown>>();
  const sendingTo = new Set<string>();
  const outreach: { workspaceId: number; dropId: number; item: OutreachItem | null }[] = [];
  const tally = { sent: 0, ready: 0, waited: 0, skipped: 0, failed: 0 };
  // A blast goes out in one run, not 48 drops a minute: batches until the
  // queue is empty or the budget is spent (the next minute's run, or a
  // rvm_send_now kick, picks up the rest). A drop is claimed with
  // status = 'queued' in the update, so two runs that overlap cannot both send it.
  const started = Date.now();
  const seenIds = new Set<number>();
  for (let batch = 0; batch < 40 && Date.now() - started < TICK_BUDGET_MS; batch++) {
    const due = (await loadDue(admin)) ?? [];
    // A drop the rules left queued (a held blacklist check) is not looked at twice in one run.
    const rows = (due as Drop[]).filter((d) => !seenIds.has(d.id));
    if (!rows.length) break;
    for (const d of rows) seenIds.add(d.id);
    // The people, their earlier drops and last calls, one read per table. A
    // failed or cut-short read is not the end: each drop then reads its own.
    const gates = await readGates(admin as unknown as GateDb, rows, noConsentGate)
      .catch((err) => {
        if (!(err instanceof ReadFailed)) throw err;
        console.error('rvm-tick batch read', err.message);
        return null;
      });
    let cursor = 0;
    const worker = async () => {
      while (cursor < rows.length) {
        const drop = rows[cursor++];
        if (!drop) break;
        const result = await consider(admin, drop, gates, cache, pools, sendingTo, outreach);
        tally[result]++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, rows.length) }, () => worker()));
    // The read came back short: the queue is empty. (Not rows: held drops filtered out are not the end of it.)
    if (due.length < 48) break;
  }
  await tellTalkr(admin, outreach);
  return json({ ok: true, ...tally });
}

const DUE_COLUMNS = 'id, workspace_id, seller_id, buyer_id, deal_id, phone_e164, library_id, script, variant_group, status, scheduled_at, webhook_token, provider_call_id, created_by';

/** The next 48 due drops. Before migration 194 there is no deal_id: read without it. */
async function loadDue(admin: SupabaseClient): Promise<unknown[] | null> {
  const read = (cols: string) => admin.from('rvm_drops').select(cols)
    .eq('status', 'queued').lte('scheduled_at', new Date().toISOString()).order('scheduled_at').limit(48);
  const first = await read(DUE_COLUMNS);
  if (!first.error) return first.data;
  if (/deal_id/.test(first.error.message)) return (await read(DUE_COLUMNS.replace(' deal_id,', ''))).data;
  console.error('rvm-tick due drops', first.error.message);
  return null;
}

/** How long one run keeps taking batches. The cron runs every minute, so a run stays under it. */
const TICK_BUDGET_MS = 40_000;

/**
 * Tell Talkr who reached out, per workspace and in batches, so a callback can
 * ring that rep. Best effort: a failure is noted on the drop, never undone.
 */
async function tellTalkr(admin: SupabaseClient, rows: { workspaceId: number; dropId: number; item: OutreachItem | null }[]): Promise<void> {
  const byWs = new Map<number, typeof rows>();
  for (const r of rows) { const l = byWs.get(r.workspaceId) ?? []; l.push(r); byWs.set(r.workspaceId, l); }
  for (const [ws, list] of byWs) {
    let results: { ref: string; ok: boolean; note: string | null }[] = [];
    try {
      results = await postOutreach(admin, ws, list.map((r) => r.item));
    } catch (err) {
      results = list.flatMap((r) => r.item ? [{ ref: r.item.ref, ok: false, note: `Talkr not told: ${String((err as Error)?.message ?? err).slice(0, 120)}` }] : []);
    }
    for (const [note, ids] of notesByText(results)) {
      await admin.from('rvm_drops').update({ notes: note }).in('id', ids).then(() => undefined, () => undefined);
    }
  }
}

type PoolRow = { phone_e164: string; pool?: string | null; market_state?: string | null; daily_cap?: number | null; ramp_started_at?: string | null; spam_risk?: string | null; retired_at?: string | null };
/** Number guard's verdict per line (migration 68), keyed on E.164. */
async function healthByPhone(admin: SupabaseClient, workspaceId: number): Promise<Map<string, { paused: boolean; grade: string | null; spam_risk: string | null }>> {
  const data = must(await admin.from('number_health').select('phone_e164, paused, grade, spam_risk').eq('workspace_id', workspaceId), 'the number guard');
  return new Map(((data ?? []) as { phone_e164: string; paused: boolean; grade: string | null; spam_risk: string | null }[]).map((h) => [h.phone_e164, h]));
}

async function loadPool(admin: SupabaseClient, workspaceId: number): Promise<CallerPool> {
  // Before migration 197 there is no retired_at, before 135 no pool columns: fall back a step at a time.
  // Only a missing column falls back; any other failure holds the drop (a retired line must not look live).
  const missing = (e: { message: string } | null) => !!e && /does not exist/.test(e.message);
  let res = await admin.from('caller_lines').select('phone_e164, pool, market_state, daily_cap, ramp_started_at, spam_risk, retired_at').eq('workspace_id', workspaceId);
  if (missing(res.error)) res = await admin.from('caller_lines').select('phone_e164, pool, market_state, daily_cap, ramp_started_at, spam_risk').eq('workspace_id', workspaceId) as typeof res;
  const rows: unknown[] | null = missing(res.error)
    ? must(await admin.from('caller_lines').select('phone_e164, spam_risk').eq('workspace_id', workspaceId), 'the caller lines')
    : must(res, 'the caller lines');
  const all = ((rows ?? []) as PoolRow[]).filter((l) => !!l.phone_e164);
  // The plain rotation is the main lines; a pool line, retired or not, is never one of them.
  const ids = all.filter((l) => l.pool !== 'rvm').map((l) => l.phone_e164);
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const used = must(await admin.from('rvm_drops').select('from_e164')
    .eq('workspace_id', workspaceId).gte('created_at', since).not('from_e164', 'is', null).limit(5000), "this week's caller ID use");
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = 0;
  for (const row of (used ?? []) as { from_e164?: string | null }[]) {
    if (row.from_e164 && row.from_e164 in counts) counts[row.from_e164]++;
  }
  const poolRows = all.filter((l) => l.pool === 'rvm');
  const rvm: PoolLine[] = [];
  const usedToday: Record<string, number> = {};
  if (poolRows.length) {
    const ws = must(await admin.from('workspaces').select('settings').eq('id', workspaceId).maybeSingle(), 'the RVM pool settings');
    const settings = ((ws?.settings as { rvm_pool?: RvmPoolSettings } | null)?.rvm_pool ?? null);
    const health = await healthByPhone(admin, workspaceId);
    const now = new Date();
    // "Today" is the workspace's Central day (Acme Homes' zone), like the leaderboard's.
    const midnight = localMidnightIso(now, 'America/Chicago');
    const today = must(await admin.from('rvm_drops').select('from_e164')
      .eq('workspace_id', workspaceId).gte('sent_at', midnight).in('from_e164', poolRows.map((l) => l.phone_e164)).limit(20_000), "today's pool line use");
    for (const row of (today ?? []) as { from_e164?: string | null }[]) {
      if (row.from_e164) usedToday[row.from_e164] = (usedToday[row.from_e164] ?? 0) + 1;
    }
    for (const l of poolRows) {
      const h = health.get(l.phone_e164);
      rvm.push({
        e164: l.phone_e164,
        state: l.market_state ?? null,
        cap: rampCap(rampDay(l.ramp_started_at, now), settings, l.daily_cap),
        // A retired line (rvm-pool rotation) is still the pool's, so an all-retired pool holds drops rather than using the main lines.
        usable: !l.retired_at && lineUsable({ paused: h?.paused, grade: h?.grade, spam_risk: worseRisk(h?.spam_risk, l.spam_risk) }),
      });
    }
  }
  return { lines: ids, counts, seq: 0, rvm, usedToday };
}

/**
 * Caller ID for this drop. With an RVM pool set up (Settings → Phone numbers →
 * RVM number pool): a line in the lead's state, then a neighbouring state or
 * the lead's area code, then any pool line, never one at today's warm-up cap.
 * `full` means every pool line is at its cap and the drop waits for tomorrow.
 * Without a pool: every caller line, area code first, then the least used
 * this week. Counted forward so a batch spreads out (takeLine, which also
 * hands back `release` for a drop that is not claimed after all).
 */
async function takeCallerId(
  admin: SupabaseClient,
  workspaceId: number,
  pools: Map<number, Promise<CallerPool>>,
  dest: string | null,
  state: string | null,
): Promise<TakenLine> {
  let pending = pools.get(workspaceId);
  if (!pending) {
    pending = loadPool(admin, workspaceId);
    pools.set(workspaceId, pending);
  }
  return takeLine(await pending, dest, state);
}

/** The drop's line on the seller's or buyer's activity log: one row per drop, its status moving in place. */
async function logDrop(
  admin: SupabaseClient,
  drop: Pick<Drop, 'id' | 'workspace_id' | 'seller_id' | 'buyer_id' | 'phone_e164' | 'script' | 'created_by'> & { from_e164?: string | null; deal_id?: number | null },
  status: 'sending' | 'delivered' | 'failed',
  extra: { provider?: string | null; why?: string | null; at?: string } = {},
): Promise<void> {
  const via = extra.provider ? ` via ${PROVIDER_NAME[extra.provider] ?? extra.provider}` : '';
  const summary = status === 'delivered' ? 'Ringless voicemail delivered'
    : status === 'failed' ? `Ringless voicemail failed${extra.why ? `: ${extra.why}` : ''}`.slice(0, 280)
      : `Ringless voicemail sent${via}`;
  const row: Record<string, unknown> = {
    workspace_id: drop.workspace_id, seller_id: drop.seller_id, buyer_id: drop.buyer_id,
    channel: 'voicemail', direction: 'outbound', occurred_at: extra.at ?? new Date().toISOString(),
    to_phone: drop.phone_e164, from_phone: drop.from_e164 ?? null, body: drop.script, summary, status,
    source: 'rvm', source_id: `rvm:${drop.id}`, rep_id: drop.created_by ?? null,
  };
  if (drop.deal_id) row.deal_id = drop.deal_id;
  let { error } = await admin.from('communications').upsert(row, { onConflict: 'workspace_id,source,source_id' });
  if (error && /rep_id/.test(error.message)) {
    delete row.rep_id;
    ({ error } = await admin.from('communications').upsert(row, { onConflict: 'workspace_id,source,source_id' }));
  }
  if (error) console.error('rvm activity row', drop.id, error.message);
  else await carryAgent(admin, drop);
}

/**
 * A drop an AI agent queued (rvm_drops.ai_agent_key, migration 269) names that
 * agent on its voicemail row, so the activity log shows the agent, not the rep
 * it went out as. Read apart from the drop's columns so the tick keeps working
 * before the migration.
 */
async function carryAgent(admin: SupabaseClient, drop: Pick<Drop, 'id' | 'workspace_id'>): Promise<void> {
  const { data, error } = await admin.from('rvm_drops').select('ai_agent_key').eq('id', drop.id).maybeSingle();
  const key = error ? null : (data as { ai_agent_key?: string | null } | null)?.ai_agent_key ?? null;
  if (!key) return;
  const { error: upErr } = await admin.from('communications').update({ ai_agent_key: key })
    .eq('workspace_id', drop.workspace_id).eq('source', 'rvm').eq('source_id', `rvm:${drop.id}`);
  if (upErr) console.error('rvm agent', drop.id, upErr.message);
}

/**
 * A failure on drops whose activity row already exists (the stale-receipt
 * sweep). It also carries the agent again: carryAgent read the drop when it
 * was sent, which can be before ai-agent stamped it, and a drop that times
 * out gets no receipt to read it a second time.
 */
async function logFailedMany(admin: SupabaseClient, drops: { id: number; workspace_id: number }[], why: string): Promise<void> {
  if (!drops.length) return;
  const byWs = new Map<number, string[]>();
  for (const d of drops) { const l = byWs.get(d.workspace_id) ?? []; l.push(`rvm:${d.id}`); byWs.set(d.workspace_id, l); }
  for (const [ws, ids] of byWs) {
    await admin.from('communications').update({ status: 'failed', summary: `Ringless voicemail failed: ${why}` })
      .eq('workspace_id', ws).eq('source', 'rvm').in('source_id', ids).neq('status', 'delivered');
  }
  const { data, error } = await admin.from('rvm_drops').select('id, workspace_id, ai_agent_key').in('id', drops.map((d) => d.id)).not('ai_agent_key', 'is', null);
  if (error) return; // Before migration 269 there is no agent to carry.
  const byAgent = new Map<string, { ws: number; key: string; ids: string[] }>();
  for (const d of (data ?? []) as { id: number; workspace_id: number; ai_agent_key: string }[]) {
    const k = `${d.workspace_id}:${d.ai_agent_key}`;
    const g = byAgent.get(k) ?? { ws: d.workspace_id, key: d.ai_agent_key, ids: [] };
    g.ids.push(`rvm:${d.id}`);
    byAgent.set(k, g);
  }
  for (const g of byAgent.values()) {
    const { error: upErr } = await admin.from('communications').update({ ai_agent_key: g.key })
      .eq('workspace_id', g.ws).eq('source', 'rvm').in('source_id', g.ids).is('ai_agent_key', null);
    if (upErr) console.error('rvm agent sweep', g.ws, upErr.message);
  }
}

const PROVIDER_NAME: Record<string, string> = { dropcowboy: 'Drop Cowboy', slybroadcast: 'Slybroadcast', telnyx: 'Telnyx' };

type PersonRow = GateRow;

function propertyOf(row: PersonRow | null): { state: string | null; zip: string | null } {
  const prop = Array.isArray(row?.properties) ? row.properties[0] : row?.properties;
  return { state: prop?.state ?? null, zip: prop?.zip ?? null };
}

function carrierError(data: Record<string, unknown>, fallback: string): string {
  const raw = data.error ?? data.ERROR ?? data.message ?? data.reason ?? fallback;
  return String(raw).slice(0, 240);
}

/** No workspace in this build gates drops on consent (batch.ts readGates asks per workspace). */
const noConsentGate = async (_ws: number): Promise<boolean> => false;

type Clip = { id: number; name?: string; script: string | null; audio_path: string | null };

/** The variant group's active recordings, plus the pinned one. Read once per workspace and group (and pin) per tick. */
async function loadClips(admin: SupabaseClient, drop: Drop, cache: Map<string, Promise<unknown>>): Promise<Clip[]> {
  const grouped = await once(cache, `clips:${drop.workspace_id}:${drop.variant_group}`, async () => (must(await admin.from('vm_library')
    .select('id, name, script, audio_path').eq('workspace_id', drop.workspace_id).eq('active', true)
    .eq('variant_group', drop.variant_group), 'the voicemail recordings') ?? []) as Clip[]);
  const clips = [...grouped];
  // A drop pinned to one recording (a bulk send, a dispo push or a plan step that
  // picked it) carries a group of its own, so the clip is not in the group's
  // rows: load it, or the send would have its id but no audio and the carrier
  // would read the script aloud instead.
  if (drop.library_id && !clips.some((c) => String(c.id) === String(drop.library_id))) {
    const pinned = await once(cache, `clip:${drop.workspace_id}:${drop.library_id}`, async () => must(await admin.from('vm_library')
      .select('id, name, script, audio_path').eq('workspace_id', drop.workspace_id).eq('id', drop.library_id!).maybeSingle(), 'the voicemail recording') as Clip | null);
    if (pinned) clips.unshift(pinned);
  }
  return clips;
}

/** A signed link to the recording, made once per tick and reused only while it still has most of its hour. */
async function signedAudio(admin: SupabaseClient, cache: Map<string, Promise<unknown>>, path: string): Promise<string> {
  const key = `signed:${path}`;
  const load = async () => {
    const at = Date.now();
    const signed = await admin.storage.from('vm-library').createSignedUrl(path, SIGNED_URL_SECONDS);
    if (!signed.data?.signedUrl) throw new ReadFailed('check_failed', `could not open the recording from storage: ${signed.error?.message ?? 'no link came back'}`);
    return { url: signed.data.signedUrl, expiresAt: at + SIGNED_URL_SECONDS * 1000 };
  };
  let link = await once(cache, key, load);
  if (!signedUrlUsable(link)) {
    cache.delete(key);
    link = await once(cache, key, load);
  }
  return link.url;
}

type Judged =
  | { done: 'waited' | 'skipped' }
  | { decision: Extract<RvmDecision, { action: 'send' }>; phone: string | null; place: { state: string | null; zip: string | null }; row: PersonRow | null; clips: Clip[]; now: Date };

/** The rules on one set of reads: a drop that waits or is skipped is updated here; a send comes back to go out. */
async function judge(admin: SupabaseClient, drop: Drop, gate: Gate, cache: Map<string, Promise<unknown>>): Promise<Judged> {
  const person = gate.person;
  const row = person.row as PersonRow | null;
  const phone = drop.phone_e164 || row?.phone || null;
  const place = drop.seller_id ? propertyOf(row) : { state: null, zip: null };
  const { heard, heardAt, lastDrop, lastAnswered } = historyFacts(gate.prior);
  const lastTalk = gate.lastTalk ?? lastAnswered;
  const clips = await loadClips(admin, drop, cache);
  const recordings = clips.map((c) => ({ id: String(c.id), name: c.name as string }));
  if (drop.library_id && !recordings.some((r) => r.id === String(drop.library_id))) {
    recordings.unshift({ id: String(drop.library_id), name: 'Step' });
  }
  const now = new Date();
  const facts: RvmFacts = {
    phone, dnc: person.dnc, blacklisted: person.blocked === 'blacklisted',
    now, timeZone: zoneForRvm(phone, 'America/Chicago', place.state), window: DEFAULT_RVM_WINDOW,
    lastLiveTalkAt: lastTalk ?? null, lastDropAt: lastDrop ?? null,
    minDaysSinceTalk: 7, minDaysSinceDrop: 3,
    sentToday: 0, dailyCap: null,
    recordings: recordings.length ? recordings : (drop.script ? [{ id: 'script', name: 'Script' }] : []),
    heardIds: heard, heardAt,
  };
  const decision = decideRvm(facts);
  if (decision.action === 'wait') {
    await admin.from('rvm_drops').update({ scheduled_at: decision.until, skip_reason: decision.reason }).eq('id', drop.id).eq('status', 'queued');
    return { done: 'waited' };
  }
  if (decision.action === 'skip') {
    await admin.from('rvm_drops').update({ status: 'skipped', skip_reason: decision.reason }).eq('id', drop.id).eq('status', 'queued');
    return { done: 'skipped' };
  }
  return { decision, phone, place, row, clips, now };
}

type Outcome = 'sent' | 'ready' | 'waited' | 'skipped' | 'failed';

async function consider(
  admin: SupabaseClient,
  drop: Drop,
  gates: Map<number, Gate> | null,
  cache: Map<string, Promise<unknown>>,
  pools: Map<number, Promise<CallerPool>>,
  sendingTo: Set<string>,
  outreach: { workspaceId: number; dropId: number; item: OutreachItem | null }[],
): Promise<Outcome> {
  const held: Held = { destKey: '', release: null };
  try {
    return await considerSend(admin, drop, gates, cache, pools, sendingTo, outreach, held);
  } catch (err) {
    if (!(err instanceof ReadFailed)) throw err;
    if (held.destKey) sendingTo.delete(held.destKey);
    // Could not tell whether it may go (the blacklist, consent, its last drop or
    // call, its line or recording): hold the drop, do not send it. Every read
    // that can throw comes before the claim, so a claimed drop is never re-queued.
    await admin.from('rvm_drops').update({ scheduled_at: new Date(Date.now() + 5 * 60_000).toISOString(), skip_reason: err.reason, last_error: err.message }).eq('id', drop.id).eq('status', 'queued');
    return 'waited';
  } finally {
    // A caller line taken for a drop that was never claimed (held, lost to
    // another run, left ready or failed before the claim) goes back, so it
    // does not fill that line's warm-up cap for the rest of the tick.
    held.release?.();
  }
}

/** What considerSend took for this drop, for consider to give back if the drop is not claimed. */
type Held = { destKey: string; release: (() => void) | null };

async function considerSend(
  admin: SupabaseClient,
  drop: Drop,
  gates: Map<number, Gate> | null,
  cache: Map<string, Promise<unknown>>,
  pools: Map<number, Promise<CallerPool>>,
  sendingTo: Set<string>,
  outreach: { workspaceId: number; dropId: number; item: OutreachItem | null }[],
  held: Held,
): Promise<Outcome> {
  // The batch's reads settle a drop that waits or is skipped. One they would
  // send is judged again on reads made for it alone, just now, with no cache
  // (person, consent flag, earlier drops, last call), so a do-not-call, an
  // opt-out or a drop that landed since the batch read still stops it. Only
  // that second judgment can send.
  const batch = gates?.get(drop.id);
  const first = batch ? await judge(admin, drop, batch, cache) : null;
  if (first && 'done' in first) return first.done;
  const fresh = (await readGates(admin as unknown as GateDb, [drop], noConsentGate)).get(drop.id)!;
  const judged = await judge(admin, drop, fresh, cache);
  if ('done' in judged) return judged.done;
  const { decision, phone, place, row, clips, now } = judged;
  // Two drops for one number can both pass the rules before either is marked
  // sent. The second one waits out the same window a fresh drop would.
  const destKey = (phone ?? '').replace(/\D/g, '').slice(-10);
  if (destKey.length >= 10) {
    if (sendingTo.has(destKey)) {
      await admin.from('rvm_drops').update({ status: 'skipped', skip_reason: 'recent_drop' }).eq('id', drop.id).eq('status', 'queued');
      return 'skipped';
    }
    sendingTo.add(destKey);
    held.destKey = destKey;
  }
  // The line's market: the property's state for a seller, the first state in a buyer's markets.
  const leadState = drop.seller_id ? place.state : marketState(row?.markets ?? null);
  const taken = await takeCallerId(admin, drop.workspace_id, pools, phone, leadState);
  held.release = taken.release ?? null;
  if (taken.noLine) {
    if (destKey.length >= 10) sendingTo.delete(destKey);
    await admin.from('rvm_drops').update({
      scheduled_at: new Date(Date.now() + 30 * 60_000).toISOString(), skip_reason: 'no_pool_line',
      last_error: 'Every line in the RVM number pool is paused, flagged or retired, so this waits for a healthy pool line rather than going out on a main line.',
    }).eq('id', drop.id).eq('status', 'queued');
    return 'waited';
  }
  if (taken.full) {
    // Every RVM pool line is at today's warm-up cap: the drop waits for tomorrow's window.
    if (destKey.length >= 10) sendingTo.delete(destKey);
    const tz = zoneForRvm(phone, 'America/Chicago', place.state);
    const tomorrow = new Date(Date.parse(localMidnightIso(now, 'America/Chicago')) + 86_400_000 + 60_000);
    const until = nextWindowOpen(tomorrow, tz, DEFAULT_RVM_WINDOW).toISOString();
    await admin.from('rvm_drops').update({ scheduled_at: until, skip_reason: 'daily_cap' }).eq('id', drop.id).eq('status', 'queued');
    return 'waited';
  }
  const from = taken.from;
  const clip = clips.find((c) => String(c.id) === decision.recordingId);
  const script = (clip?.script || drop.script || '').trim();
  const kind = audioKind(clip?.audio_path);
  let audioUrl: string | null = null;
  if (clip?.audio_path && kind) audioUrl = await signedAudio(admin, cache, clip.audio_path);
  const webhookToken = crypto.randomUUID();
  const libraryId = clip?.id ?? drop.library_id;
  const claim = async (provider: string) => {
    const patch: Record<string, unknown> = {
      status: 'sending', provider, webhook_token: webhookToken, phone_e164: phone, from_e164: from,
      library_id: libraryId, script: script || drop.script, sent_at: new Date().toISOString(), last_error: null,
      pool_tier: taken.tier ?? null,
    };
    if (!await claimQueued(admin as unknown as GateDb, drop.id, patch)) return false;
    // Claimed: the line is spent (rvm_drops now has from_e164 and sent_at, which the next tick counts too).
    held.release = null;
    // On the record's activity log from the moment a network has it.
    await logDrop(admin, { ...drop, phone_e164: phone, from_e164: from, script: script || drop.script }, 'sending', { provider });
    return true;
  };
  const sentDrop = { ...drop, phone_e164: phone, from_e164: from, script: script || drop.script };
  const failed = async (why: string) => {
    await admin.from('rvm_drops').update({ status: 'failed', last_error: why }).eq('id', drop.id);
    await logDrop(admin, sentDrop, 'failed', { why });
    return 'failed' as const;
  };
  // Talkr rings the rep who reached out when this number calls back.
  const accepted = () => outreach.push({
    workspaceId: drop.workspace_id, dropId: drop.id,
    item: outreachItem({ phone, userId: drop.created_by, channel: 'rvm', at: new Date(), ref: `rvm:${drop.id}` }),
  });
  // Why a ringless network could not take this one, for the message on the row.
  const clipName = (clip as { name?: string } | undefined)?.name;
  const webmOnly = !!clip?.audio_path && !kind;

  if (phone) {
    const cowboy = await prepareDropCowboy(admin, cache, drop, phone, webhookToken, script, audioUrl, kind, from, place.zip);
    if (cowboy) {
      if (!await claim('dropcowboy')) return 'failed';
      const posted = await postCarrier(cowboy.url, cowboy.init, cowboy.callIdFrom);
      if (!posted.ok) return await failed(posted.error);
      await admin.from('rvm_drops').update({ provider_call_id: posted.callId }).eq('id', drop.id);
      accepted();
      return 'sent';
    }
    const sly = await prepareSlybroadcast(admin, cache, drop, phone, webhookToken, from, audioUrl, kind);
    if (sly) {
      if (!await claim('slybroadcast')) return 'failed';
      const posted = await postCarrier(sly.url, sly.init, sly.callIdFrom);
      if (!posted.ok) return await failed(posted.error);
      await admin.from('rvm_drops').update({ provider_call_id: posted.callId }).eq('id', drop.id);
      accepted();
      return 'sent';
    }
  }

  if (!phone) {
    await admin.from('rvm_drops').update({ status: 'failed', last_error: 'No phone number on this record, so there is nowhere to drop the voicemail.' })
      .eq('id', drop.id).eq('status', 'queued');
    return 'failed';
  }
  // A browser recording is WebM. No ringless network and no Telnyx playback
  // takes WebM, and with no script to speak instead the call would ring a
  // voicemail box and leave silence.
  if (webmOnly && !script) {
    await admin.from('rvm_drops').update({
      status: 'failed',
      last_error: `The recording "${clipName ?? 'voicemail'}" is WebM, which carriers cannot play. Record it again (new recordings save as WAV) or add a script.`,
    }).eq('id', drop.id).eq('status', 'queued');
    return 'failed';
  }
  // A failed Vault read holds the drop (consider's ReadFailed path); only "not set" marks it ready below.
  const unread = (e: Error): never => { throw new ReadFailed('check_failed', `could not check the Telnyx settings: ${e.message}`); };
  const key = await telnyxSetting(admin, 'TELNYX_API_KEY').catch(unread);
  const connection = await telnyxSetting(admin, 'TELNYX_CONNECTION_ID').catch(unread);
  if (!key || !connection || !from) {
    const why = !from
      ? 'No caller ID line on file (Settings, Calling), so this one is dropped from the RVM tab.'
      : webmOnly
        ? `No ringless account can take the WebM recording "${clipName ?? 'voicemail'}" and there is no Telnyx connection (TELNYX_API_KEY, TELNYX_CONNECTION_ID), so this one is dropped from the RVM tab.`
        : 'No ringless account (Drop Cowboy or Slybroadcast) and no Telnyx connection (TELNYX_API_KEY, TELNYX_CONNECTION_ID), so this one is dropped from the RVM tab.';
    await admin.from('rvm_drops').update({
      status: 'ready', phone_e164: phone, library_id: libraryId, script: script || drop.script, last_error: why,
    }).eq('id', drop.id).eq('status', 'queued');
    return 'ready';
  }
  if (!await claim('telnyx')) return 'failed';
  const base = Deno.env.get('SUPABASE_URL')!;
  // detect_beep: Telnyx reports machine vs human, then the end of the
  // greeting. Playing on detection alone talked over the greeting, so the box
  // recorded the tail of the message or nothing.
  const placed = await telnyx(key, '/calls', {
    connection_id: connection,
    to: phone,
    from,
    answering_machine_detection: 'detect_beep',
    webhook_url: `${base}/functions/v1/rvm-tick?drop=${drop.id}&t=${webhookToken}`,
    timeout_secs: 40,
  });
  const callId = (placed.data?.data as { call_control_id?: string } | undefined)?.call_control_id;
  if (!placed.ok || !callId) return await failed(telnyxError(placed, 'The carrier did not start the call.'));
  await admin.from('rvm_drops').update({ provider_call_id: callId }).eq('id', drop.id);
  accepted();
  return 'sent';
}

type Prepared = { url: string; init: RequestInit; callIdFrom: (data: Record<string, unknown>) => string | null };

/** Drop Cowboy deposits the file. Building the body does not send it. */
async function prepareDropCowboy(
  admin: SupabaseClient, cache: Map<string, Promise<unknown>>, drop: Drop, phone: string, token: string, script: string,
  audioUrl: string | null, audioType: CarrierAudio | null, from: string | null, postalCode: string | null,
): Promise<Prepared | null> {
  const teamId = await secret(admin, cache, 'dropcowboy_team_id');
  const cowboySecret = await secret(admin, cache, 'dropcowboy_secret');
  const brandId = await secret(admin, cache, 'dropcowboy_brand_id');
  if (!teamId || !cowboySecret || !brandId) return null;
  const voiceId = await secret(admin, cache, 'dropcowboy_voice_id');
  const base = Deno.env.get('SUPABASE_URL')!;
  const payload = dropCowboyPayload({
    teamId, secret: cowboySecret, brandId, phone, dropId: drop.id,
    callbackUrl: `${base}/functions/v1/rvm-tick?drop=${drop.id}&t=${token}&via=dropcowboy`,
    forwardingNumber: from, postalCode, script, voiceId, audioUrl, audioType,
  });
  if (!payload) return null;
  return {
    url: 'https://api.dropcowboy.com/v1/rvm',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-team-id': teamId, 'x-secret': cowboySecret },
      body: JSON.stringify(payload),
    },
    callIdFrom: (data) => {
      const id = data.id ?? data.rvm_id ?? data.foreign_id;
      return id == null ? null : String(id);
    },
  };
}

/** Slybroadcast is the second ringless network, used when Drop Cowboy cannot take this clip. */
async function prepareSlybroadcast(
  admin: SupabaseClient, cache: Map<string, Promise<unknown>>, drop: Drop, phone: string, token: string, from: string | null,
  audioUrl: string | null, audioType: CarrierAudio | null,
): Promise<Prepared | null> {
  const uid = await secret(admin, cache, 'slybroadcast_uid');
  const password = await secret(admin, cache, 'slybroadcast_password');
  if (!uid || !password || !from || !audioUrl || !audioType) return null;
  const base = Deno.env.get('SUPABASE_URL')!;
  const fields = slybroadcastFields({
    uid, password, phone, callerId: from, audioUrl, audioType,
    callbackUrl: `${base}/functions/v1/rvm-tick?drop=${drop.id}&t=${token}&via=slybroadcast`,
  });
  if (!fields) return null;
  return {
    url: 'https://www.slybroadcast.com/gateway/vmb.json.php',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    },
    callIdFrom: (data) => {
      const id = data.session_id ?? data.sessionId;
      return id == null ? null : String(id);
    },
  };
}

/** A 2xx that is not an explicit failure means the network accepted the job, not that the mailbox has it. */
async function postCarrier(url: string, init: RequestInit, callIdFrom?: (data: Record<string, unknown>) => string | null): Promise<{ ok: true; callId: string | null } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, error: 'The ringless network did not answer.' };
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: `The ringless network refused our credentials (HTTP ${res.status}). Check the account keys in Settings.` };
  }
  if (!res.ok || receiptOutcome(data) === 'failed') {
    return { ok: false, error: carrierError(data, `The ringless network did not accept the voicemail (HTTP ${res.status}).`) };
  }
  return { ok: true, callId: callIdFrom ? callIdFrom(data) : null };
}

/** Still open: handed to the carrier, playing, or failed only because the receipt was slow. */
function awaitingReceipt(drop: { status: string; last_error?: string | null }): boolean {
  return drop.status === 'sending' || drop.status === 'dialing' || (drop.status === 'failed' && drop.last_error === NO_RECEIPT);
}

async function recordDrop(admin: SupabaseClient, drop: Drop & { last_error?: string | null }): Promise<boolean> {
  if (!awaitingReceipt(drop)) return false;
  const now = new Date().toISOString();
  const updated = await admin.from('rvm_drops').update({ status: 'dropped', sent_at: now, last_error: null })
    .eq('id', drop.id).eq('status', drop.status).select('id');
  if (!updated.data?.length) return false;
  await logDrop(admin, drop, 'delivered', { at: now });
  return true;
}

/** Slybroadcast posts a pipe-delimited `var`, or a JSON row, and wants the body `OK` back. */
function normalizeReceipt(via: string, body: Record<string, unknown> | unknown[]): Record<string, unknown> {
  const raw = !Array.isArray(body) ? String(body.var ?? '') : '';
  if (via === 'slybroadcast' && raw.includes('|')) {
    const parts = raw.split('|').map((part) => part.replace(/"/g, '').trim());
    const status = parts[2] ?? '';
    return { status, reason: /fail/i.test(status) ? (parts[3] ?? '') : '' };
  }
  if (Array.isArray(body)) {
    const row = body[0] as Record<string, unknown> | undefined;
    if (!row) return {};
    const status = row['dial status'] ?? row.dispoCode ?? row.status ?? '';
    const reason = row['fail reason'] ?? row.dispoText ?? row.reason ?? '';
    return { status, reason: /fail/i.test(String(status)) ? reason : '' };
  }
  return body;
}

function receiptResponse(via: string, body: unknown, status = 200): Response {
  if (via === 'slybroadcast') return new Response('OK', { status, headers: { 'content-type': 'text/plain' } });
  return json(body, status);
}

async function handleReceipt(admin: SupabaseClient, dropId: number, token: string, via: string, body: unknown): Promise<Response> {
  const { data } = await admin.from('rvm_drops')
    .select('id, workspace_id, seller_id, buyer_id, phone_e164, script, status, webhook_token, provider_call_id, library_id, last_error, created_by, from_e164, provider')
    .eq('id', dropId).maybeSingle();
  const drop = data as (Drop & { last_error: string | null }) | null;
  if (!drop || !drop.webhook_token || drop.webhook_token !== token) return receiptResponse(via, { error: 'unknown drop' }, 404);
  if (!awaitingReceipt(drop)) return receiptResponse(via, { ok: true, ignored: true });
  const receipt = normalizeReceipt(via, (body ?? {}) as Record<string, unknown> | unknown[]);
  const outcome = receiptOutcome(receipt);
  if (outcome === 'pending') return receiptResponse(via, { ok: true, pending: true });
  if (outcome === 'failed') {
    const why = carrierError(receipt, 'The carrier reported a failed delivery.');
    const moved = await admin.from('rvm_drops').update({ status: 'failed', last_error: why }).eq('id', drop.id).eq('status', drop.status).select('id');
    if (moved.data?.length) await logDrop(admin, drop, 'failed', { why });
    return receiptResponse(via, { ok: true, failed: true });
  }
  const dropped = await recordDrop(admin, drop);
  return receiptResponse(via, { ok: true, dropped });
}

/**
 * Telnyx call-control events for a machine-detect drop.
 *
 * detect_beep sends `call.machine.detection.ended` (human, machine, not_sure)
 * and then `call.machine.greeting.ended` once the greeting and its beep are
 * over; premium detection sends the `call.machine.premium.*` pair. A person
 * is hung up on at detection. The recording starts only at greeting end, and
 * only once: the drop moves sending → dialing when playback begins, so a
 * repeated or reordered event cannot play it twice.
 */
async function handleEvent(admin: SupabaseClient, dropId: number, token: string, body: unknown): Promise<Response> {
  const { data } = await admin.from('rvm_drops')
    .select('id, workspace_id, seller_id, buyer_id, phone_e164, script, status, webhook_token, provider_call_id, library_id, last_error, created_by, from_e164, provider')
    .eq('id', dropId).maybeSingle();
  const drop = data as (Drop & { script: string | null; last_error: string | null }) | null;
  if (!drop || !drop.webhook_token || drop.webhook_token !== token) return json({ error: 'unknown drop' }, 404);
  const event = body as { data?: { event_type?: string; payload?: { result?: string; call_control_id?: string; hangup_cause?: string } } };
  const type = event.data?.event_type ?? '';
  const result = (event.data?.payload?.result ?? '').toLowerCase();
  const callId = event.data?.payload?.call_control_id || drop.provider_call_id;
  const key = await telnyxSetting(admin, 'TELNYX_API_KEY');
  if (!key || !callId) return json({ ok: true, ignored: true });
  const fail = async (why: string, from: string[] = ['sending', 'dialing']) => {
    const moved = await admin.from('rvm_drops').update({ status: 'failed', last_error: why.slice(0, 240) }).eq('id', drop.id).in('status', from).select('id');
    if (moved.data?.length) await logDrop(admin, drop, 'failed', { why });
  };

  if (type === 'call.machine.detection.ended' || type === 'call.machine.premium.detection.ended') {
    if (/human/.test(result)) {
      await telnyx(key, `/calls/${callId}/actions/hangup`, {});
      await admin.from('rvm_drops').update({ status: 'answered', sent_at: new Date().toISOString() }).eq('id', drop.id).eq('status', 'sending');
      return json({ ok: true, answered: true });
    }
    if (/fax|silence/.test(result)) {
      await telnyx(key, `/calls/${callId}/actions/hangup`, {});
      await fail(result.includes('fax') ? 'A fax machine answered, so no voicemail was left.' : 'The line stayed silent, so no voicemail was left.');
      return json({ ok: true, ended: true });
    }
    // machine or not_sure: wait for the greeting to end.
    return json({ ok: true, waiting: 'greeting' });
  }

  if (type === 'call.machine.greeting.ended' || type === 'call.machine.premium.greeting.ended') {
    const started = await admin.from('rvm_drops').update({ status: 'dialing' }).eq('id', drop.id).eq('status', 'sending').select('id');
    if (!started.data?.length) return json({ ok: true, ignored: true });
    const { data: clip } = drop.library_id
      ? await admin.from('vm_library').select('name, audio_path, script').eq('id', drop.library_id).maybeSingle()
      : { data: null };
    const c = clip as { name?: string | null; audio_path?: string | null; script?: string | null } | null;
    const script = (c?.script || drop.script || '').trim();
    // Telnyx plays mp3 and wav. A WebM clip is spoken from its script instead.
    const kind = audioKind(c?.audio_path);
    if (c?.audio_path && (kind === 'mp3' || kind === 'wav')) {
      const signed = await admin.storage.from('vm-library').createSignedUrl(c.audio_path, 600);
      if (signed.data?.signedUrl) {
        const played = await telnyx(key, `/calls/${callId}/actions/playback_start`, { audio_url: signed.data.signedUrl });
        if (played.ok) return json({ ok: true, playback: true });
        if (!script) {
          await telnyx(key, `/calls/${callId}/actions/hangup`, {});
          await fail(telnyxError(played, 'Telnyx could not play the recording.'));
          return json({ ok: true, failed: true });
        }
      } else if (!script) {
        await telnyx(key, `/calls/${callId}/actions/hangup`, {});
        await fail(`The recording "${c.name ?? 'voicemail'}" could not be opened from storage.`);
        return json({ ok: true, failed: true });
      }
    }
    if (!script) {
      await telnyx(key, `/calls/${callId}/actions/hangup`, {});
      await fail(c?.audio_path
        ? `The recording "${c.name ?? 'voicemail'}" is WebM, which Telnyx cannot play, and it has no script to speak. Record it again or add a script.`
        : 'This drop has no recording and no script, so there was nothing to leave.');
      return json({ ok: true, failed: true });
    }
    const spoke = await telnyx(key, `/calls/${callId}/actions/speak`, { payload: script.slice(0, 3000), voice: 'female', language: 'en-US' });
    if (!spoke.ok) {
      await telnyx(key, `/calls/${callId}/actions/hangup`, {});
      await fail(telnyxError(spoke, 'Telnyx could not speak the script.'));
      return json({ ok: true, failed: true });
    }
    return json({ ok: true, speak: true });
  }

  if (type === 'call.playback.ended' || type === 'call.speak.ended') {
    // Recorded before hanging up: the hangup's own event must find it dropped, not mid-playback.
    const dropped = await recordDrop(admin, drop);
    await telnyx(key, `/calls/${callId}/actions/hangup`, {});
    return json({ ok: true, dropped });
  }

  if (type === 'call.hangup') {
    if (drop.status === 'sending') {
      const cause = event.data?.payload?.hangup_cause ?? '';
      await fail(/busy/i.test(cause) ? 'The line was busy.' : /no_answer|timeout/i.test(cause)
        ? 'Nobody and no voicemail box answered.' : 'The call ended before a voicemail was left.', ['sending']);
    } else if (drop.status === 'dialing') {
      await fail('The voicemail box hung up while the message was playing.', ['dialing']);
    }
    return json({ ok: true, ended: true });
  }
  return json({ ok: true });
}
