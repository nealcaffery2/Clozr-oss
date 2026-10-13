/**
 * POST /rvm-pool — rotation for the RVM number pool (migration 197).
 *
 *   { action: 'rotate', workspace_id? }          the daily pg_cron run (every workspace
 *                                                 with a pool), or an admin's run for one
 *   { action: 'approve', workspace_id, event_id } an admin buys the replacement an open
 *                                                 purchase request asked for
 *
 * rotate retires every live pool line lib/rvm-rotation.ts says went bad
 * (spam label, At risk or paused by the guard, refused by Free Caller
 * Registry, poor STIR/SHAKEN attestation), logs it on rvm_pool_events and
 * tells the owners and admins. The number is kept: callbacks to it still
 * reach their drop. Then, per retired line, settings.rvm_pool.replace decides:
 * off (default) logs that nothing was bought; approve opens a request an
 * admin approves in the RVM tab; auto buys, never past monthly_cap a month.
 *
 * A purchase goes through Talkr, like Settings → Phone → Buy, so the new line
 * gets the main lines' routing and protection: a local number in the retired
 * line's area code, else its state; "ring the rep who last reached out" on;
 * caller-registry and 10DLC queued; into the pool on day 0 of the warm-up.
 *
 * Nothing is bought unless the function secret RVM_POOL_LIVE_PURCHASES is
 * "true". Without it a purchase is searched and logged as a dry run.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, corsFor, jsonWith, isServiceCaller } from '../_shared/security.ts';
import { activeTalkrBinding, gateTalkrWrite, readTalkrOrg } from '../_shared/talkr-binding.ts';
import { loadTalkrConnections } from '../_shared/talkr-connect.ts';
import { TALKR_DEFAULT_URL, partnerToken } from '../_shared/talkr-outreach.ts';
import {
  capMonth, lineVerdict, reasonsSentence, replaceDecision, replaceSettings, replacementAreaCodes, rotationPolicy,
  type RotationHealth, type RotationLine,
} from '../../../lib/rvm-rotation.ts';
import { stateCode2, stateOfPhone, type RvmPoolSettings } from '../../../lib/rvm-pool.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

type Line = RotationLine & { workspace_id: number; talkr_number_id?: string | null };
type Ws = { id: number; name: string | null; owner_id: string; settings: Any };
type Talkr = { base: string; token: string };

const LIVE = () => (Deno.env.get('RVM_POOL_LIVE_PURCHASES') ?? '').trim().toLowerCase() === 'true';

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'POST, OPTIONS', headers: ALLOW_HEADERS });
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...HARDENING } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const input = await req.json().catch(() => ({})) as { action?: string; workspace_id?: number; event_id?: number };
  const action = String(input.action ?? 'rotate');
  if (!['rotate', 'approve'].includes(action)) return json({ error: 'action must be rotate or approve' }, 400);

  // The cron signs with the vault's service key (migration 193); a person must be an owner or admin.
  const service = await isServiceCaller(admin, bearer);
  let actor: string | null = null;
  const wsId = Number(input.workspace_id);
  if (!service) {
    if (!bearer) return json({ error: 'sign in' }, 401);
    if (!Number.isFinite(wsId)) return json({ error: 'workspace_id required' }, 400);
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data: who } = await asCaller.auth.getUser();
    if (!who?.user) return json({ error: 'sign in' }, 401);
    const { data: m } = await admin.from('workspace_members').select('role').eq('workspace_id', wsId).eq('user_id', who.user.id).maybeSingle();
    if (!m || !['owner', 'admin'].includes(String(m.role))) return json({ error: 'admins only' }, 403);
    actor = who.user.id;
  }

  if (action === 'approve') {
    if (!Number.isFinite(wsId) || !Number.isFinite(Number(input.event_id))) return json({ error: 'workspace_id and event_id required' }, 400);
    return json(await approve(admin, url, serviceKey, wsId, Number(input.event_id), actor));
  }

  // rotate: one workspace, or every workspace with a live pool line.
  let ids: number[];
  if (Number.isFinite(wsId)) ids = [wsId];
  else {
    const { data, error } = await admin.from('caller_lines').select('workspace_id').eq('pool', 'rvm').is('retired_at', null);
    if (error) return json({ ok: false, error: error.message }, 500);
    ids = [...new Set(((data ?? []) as { workspace_id: number }[]).map((r) => r.workspace_id))];
  }
  const results = [];
  for (const id of ids) {
    try {
      results.push({ workspace_id: id, ...(await rotate(admin, url, serviceKey, id, actor)) });
    } catch (e) {
      results.push({ workspace_id: id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: results.every((r) => r.ok !== false), live_purchases: LIVE(), results });
});

async function loadWs(admin: SupabaseClient, id: number): Promise<Ws | null> {
  const { data } = await admin.from('workspaces').select('id, name, owner_id, settings').eq('id', id).maybeSingle();
  return (data as Ws | null) ?? null;
}

async function event(admin: SupabaseClient, row: Record<string, unknown>): Promise<number | null> {
  const { data, error } = await admin.from('rvm_pool_events').insert(row).select('id').single();
  if (error) console.error('rvm_pool_events', error.message);
  return (data as { id: number } | null)?.id ?? null;
}

async function tellAdmins(admin: SupabaseClient, wsId: number, title: string, body: string): Promise<void> {
  const { data } = await admin.from('workspace_members').select('user_id').eq('workspace_id', wsId).in('role', ['owner', 'admin']);
  const rows = ((data ?? []) as { user_id: string | null }[]).filter((m) => m.user_id).map((m) => ({
    workspace_id: wsId, user_id: m.user_id, category: 'RVM pool', title: title.slice(0, 120), body: body.slice(0, 1000),
  }));
  if (rows.length) await admin.from('notifications').insert(rows);
}

/** Purchases this calendar month (Central) plus requests still open: what counts against the cap. */
async function spentThisMonth(admin: SupabaseClient, wsId: number, now: Date): Promise<number> {
  const month = capMonth(now);
  const since = new Date(now.getTime() - 32 * 86_400_000).toISOString();
  const { data } = await admin.from('rvm_pool_events').select('action, status, created_at').eq('workspace_id', wsId)
    .gte('created_at', since).in('action', ['purchased', 'purchase_requested']);
  return ((data ?? []) as { action: string; status: string; created_at: string }[])
    .filter((e) => (e.action === 'purchased' && capMonth(new Date(e.created_at)) === month) || (e.action === 'purchase_requested' && e.status === 'open'))
    .length;
}

async function rotate(admin: SupabaseClient, url: string, serviceKey: string, wsId: number, actor: string | null) {
  const ws = await loadWs(admin, wsId);
  if (!ws) return { ok: false, error: 'no such workspace' };
  const pool = (ws.settings?.rvm_pool ?? null) as RvmPoolSettings | null;
  const policy = rotationPolicy(pool, ws.settings?.number_guard ?? null);
  const { data: lineRows, error } = await admin.from('caller_lines')
    .select('workspace_id, phone_e164, market_state, spam_risk, fcr_status, retired_at, talkr_number_id')
    .eq('workspace_id', wsId).eq('pool', 'rvm').is('retired_at', null);
  if (error) return { ok: false, error: error.message };
  const lines = (lineRows ?? []) as Line[];
  if (!lines.length) return { ok: true, retired: [], live: 0 };
  const { data: healthRows } = await admin.from('number_health')
    .select('phone_e164, paused, grade, spam_risk, attestation_a_7d, attestation_calls_7d, checked_at')
    .eq('workspace_id', wsId).in('phone_e164', lines.map((l) => l.phone_e164));
  const health = new Map<string, RotationHealth>();
  for (const h of (healthRows ?? []) as (RotationHealth & { phone_e164: string })[]) health.set(h.phone_e164, h);

  const now = new Date();
  const retired: { line: Line; why: string }[] = [];
  for (const line of lines) {
    const reasons = lineVerdict(line, health.get(line.phone_e164), policy);
    if (!reasons.length) continue;
    const why = reasonsSentence(reasons);
    const { data: moved } = await admin.from('caller_lines').update({ retired_at: now.toISOString(), retired_reason: why })
      .eq('workspace_id', wsId).eq('phone_e164', line.phone_e164).is('retired_at', null).select('phone_e164');
    if (!moved?.length) continue;
    await event(admin, { workspace_id: wsId, phone_e164: line.phone_e164, action: 'retired', reason: why, actor, detail: { reasons, health: health.get(line.phone_e164) ?? null } });
    retired.push({ line, why });
  }
  const live = lines.length - retired.length;
  if (!retired.length) return { ok: true, retired: [], live };

  const settings = replaceSettings(pool);
  let spent = await spentThisMonth(admin, wsId, now);
  const outcomes: { phone: string; outcome: string; bought?: string | null }[] = [];
  for (const { line } of retired) {
    const decision = replaceDecision(settings, spent);
    if (decision.action === 'skip') {
      const reason = decision.why === 'off'
        ? 'Automatic replacement is off (RVM tab, Pool health).'
        : `This month's replacement cap (${settings.monthlyCap}) is used up.`;
      await event(admin, { workspace_id: wsId, phone_e164: line.phone_e164, action: 'purchase_skipped', reason, actor, detail: { mode: settings.mode, cap: settings.monthlyCap, spent } });
      outcomes.push({ phone: line.phone_e164, outcome: decision.why === 'off' ? 'not replaced (off)' : 'not replaced (cap)' });
      continue;
    }
    spent++;
    if (decision.action === 'request') {
      await event(admin, { workspace_id: wsId, phone_e164: line.phone_e164, action: 'purchase_requested', status: 'open', reason: 'Approve a local replacement in the RVM tab.', actor, detail: { area_codes: replacementAreaCodes(line), market_state: line.market_state ?? null } });
      outcomes.push({ phone: line.phone_e164, outcome: 'replacement waiting for approval' });
      continue;
    }
    const bought = await buyReplacement(admin, url, serviceKey, ws, line, actor);
    outcomes.push({ phone: line.phone_e164, outcome: bought.ok ? (bought.dryRun ? 'dry run, nothing bought' : 'replaced') : `replacement failed: ${bought.error}`, bought: bought.ok ? bought.phone : null });
  }

  const lineList = retired.map(({ line, why }) => `${line.phone_e164} (${why})`).join('; ');
  const after = outcomes.map((o) => `${o.phone}: ${o.outcome}${o.bought ? ` → ${o.bought}` : ''}`).join('; ');
  await tellAdmins(admin, wsId,
    `${retired.length} RVM pool line${retired.length === 1 ? '' : 's'} retired`,
    `Taken out of the RVM pool: ${lineList}. ${after}. ${live} line${live === 1 ? '' : 's'} left in the pool${live ? '' : ': ringless drops wait until a line is back'}. Callbacks to a retired number are still credited.`);
  return { ok: true, retired: retired.map((r) => r.line.phone_e164), outcomes, live };
}

async function approve(admin: SupabaseClient, url: string, serviceKey: string, wsId: number, eventId: number, actor: string | null) {
  const { data: ev } = await admin.from('rvm_pool_events').select('id, phone_e164, action, status')
    .eq('id', eventId).eq('workspace_id', wsId).maybeSingle();
  const req = ev as { id: number; phone_e164: string | null; action: string; status: string } | null;
  if (!req || req.action !== 'purchase_requested' || req.status !== 'open') return { ok: false, error: 'No open replacement request with that id.' };
  const ws = await loadWs(admin, wsId);
  if (!ws) return { ok: false, error: 'no such workspace' };
  // The request already counts against the cap; purchases made since it was opened might not leave room.
  const settings = replaceSettings(ws.settings?.rvm_pool ?? null);
  const month = capMonth(new Date());
  const { data: bought } = await admin.from('rvm_pool_events').select('created_at').eq('workspace_id', wsId).eq('action', 'purchased')
    .gte('created_at', new Date(Date.now() - 32 * 86_400_000).toISOString());
  const boughtThisMonth = ((bought ?? []) as { created_at: string }[]).filter((e) => capMonth(new Date(e.created_at)) === month).length;
  if (settings.mode === 'off') return { ok: false, error: 'Replacement is switched off. Turn on "Ask an admin" or "Automatic" first.' };
  if (boughtThisMonth >= settings.monthlyCap) return { ok: false, error: `This month's replacement cap (${settings.monthlyCap}) is used up.` };
  // Claim the request before buying: a double click or two admins at once buy one number, not two.
  const { data: claimed } = await admin.from('rvm_pool_events').update({ status: 'done', resolved_at: new Date().toISOString(), resolved_by: actor })
    .eq('id', req.id).eq('status', 'open').select('id');
  if (!claimed?.length) return { ok: false, error: 'Someone else is already handling that request.' };
  const reopen = () => admin.from('rvm_pool_events').update({ status: 'open', resolved_at: null, resolved_by: null }).eq('id', req.id);
  const { data: lineRow } = await admin.from('caller_lines').select('workspace_id, phone_e164, market_state, spam_risk, fcr_status, retired_at, talkr_number_id')
    .eq('workspace_id', wsId).eq('phone_e164', req.phone_e164 ?? '').maybeSingle();
  const line = (lineRow as Line | null) ?? { workspace_id: wsId, phone_e164: req.phone_e164 ?? '' };
  const result = await buyReplacement(admin, url, serviceKey, ws, line, actor);
  // A dry run or a failure buys nothing, so the request goes back to waiting.
  if (!result.ok || result.dryRun) await reopen();
  else await admin.from('rvm_pool_events').update({ detail: { bought: result.phone } }).eq('id', req.id);
  return result;
}

/** Talkr as the workspace owner, after the same binding and org checks caller-registry makes. */
async function talkrFor(admin: SupabaseClient, ws: Ws): Promise<Talkr | null> {
  const binding = activeTalkrBinding(ws, (await loadTalkrConnections(admin, [ws.id]))[0] ?? null);
  if (!binding) return null;
  const base = String(ws.settings?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
  const { data: owner } = await admin.from('profiles').select('email').eq('id', ws.owner_id).maybeSingle();
  const token = await partnerToken({ id: ws.owner_id, email: (owner as { email?: string } | null)?.email ?? null });
  if (!token) return null;
  const observed = await readTalkrOrg(async (path) => {
    try {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { ok: res.ok, body: await res.json().catch(() => ({})) };
    } catch {
      return { ok: false, body: {} };
    }
  });
  return gateTalkrWrite({ binding, observedOrgId: observed }).ok ? { base, token } : null;
}

async function talkrCall(t: Talkr, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Any }> {
  try {
    const res = await fetch(`${t.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${t.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, status: 0, json: { error: e instanceof Error ? e.message : 'unreachable' } };
  }
}

const talkrErr = (r: { status: number; json: Any }) => String(r.json?.error?.message ?? r.json?.error ?? r.json?.message ?? `HTTP ${r.status}`).slice(0, 200);

/**
 * Find a local number for the retired line and, when RVM_POOL_LIVE_PURCHASES
 * is "true", buy it through Talkr and put it in the pool. Logged either way.
 */
async function buyReplacement(
  admin: SupabaseClient, url: string, serviceKey: string, ws: Ws, line: Pick<Line, 'phone_e164' | 'market_state'>, actor: string | null,
): Promise<{ ok: true; phone: string; dryRun: boolean } | { ok: false; error: string }> {
  const fail = async (error: string) => {
    await event(admin, { workspace_id: ws.id, phone_e164: line.phone_e164, action: 'purchase_failed', reason: error, actor });
    return { ok: false as const, error };
  };
  const talkr = await talkrFor(admin, ws);
  if (!talkr) return await fail('Talkr is not connected to this workspace, so no number can be bought.');
  const codes = replacementAreaCodes(line);
  let pick: string | null = null;
  for (const code of codes) {
    const found = await talkrCall(talkr, 'GET', `/v1/numbers/available?area_code=${code}&limit=5`);
    if (!found.ok) continue;
    pick = ((found.json?.numbers ?? []) as { phone_e164?: string }[]).map((n) => String(n.phone_e164 ?? '')).find((p) => /^\+1\d{10}$/.test(p)) ?? null;
    if (pick) break;
  }
  if (!pick) return await fail(`No local number is for sale in ${codes.join(', ') || 'that market'} right now.`);
  const state = stateCode2(line.market_state) ?? stateOfPhone(line.phone_e164);
  if (!LIVE()) {
    await event(admin, {
      workspace_id: ws.id, phone_e164: line.phone_e164, action: 'purchase_skipped', actor,
      reason: `Dry run: would have bought ${pick}. Set the function secret RVM_POOL_LIVE_PURCHASES=true to buy for real.`,
      detail: { would_buy: pick, market_state: state, dry_run: true },
    });
    return { ok: true, phone: pick, dryRun: true };
  }
  const bought = await talkrCall(talkr, 'POST', '/v1/numbers', { phone_e164: pick, label: `RVM pool${state ? ` · ${state}` : ''}` });
  const number = bought.json?.number as { id?: string; phone_e164?: string } | undefined;
  if (!bought.ok || !number?.phone_e164) return await fail(`Talkr did not buy ${pick}: ${talkrErr(bought)}`);
  const phone = number.phone_e164;
  // A callback to the new line rings whoever left the voicemail.
  if (number.id) await talkrCall(talkr, 'PATCH', `/v1/numbers/${encodeURIComponent(number.id)}`, { route_callbacks_to_last_contact: true });
  await admin.from('caller_lines').upsert({
    workspace_id: ws.id, phone_e164: phone, talkr_number_id: number.id ?? null, pool: 'rvm', market_state: state,
    ramp_started_at: new Date().toISOString().slice(0, 10), replaces: line.phone_e164,
  }, { onConflict: 'workspace_id,phone_e164' });
  await admin.from('caller_lines').update({ replaced_by: phone }).eq('workspace_id', ws.id).eq('phone_e164', line.phone_e164);
  await event(admin, { workspace_id: ws.id, phone_e164: phone, action: 'purchased', reason: `Replaces ${line.phone_e164}`, actor, detail: { replaces: line.phone_e164, market_state: state, talkr_number_id: number.id ?? null } });
  // The main lines' registrations: Free Caller Registry, reputation, branded calling, 10DLC.
  const kick = (fn: string, body: unknown) => fetch(`${url.replace(/\/$/, '')}/functions/v1/${fn}`, {
    method: 'POST', headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(() => undefined, () => undefined);
  await kick('caller-registry', { action: 'advance', workspace_id: ws.id, phones: [phone] });
  await kick('ten-dlc-register', { action: 'attach', workspace_id: ws.id, phones: [phone] });
  return { ok: true, phone, dryRun: false };
}
