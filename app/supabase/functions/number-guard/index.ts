/**
 * POST /number-guard — the phone numbers' daily check-up, enforced.
 *
 * Runs every business morning from pg_cron (migration 68,
 * public.number_guard_kick) and on demand from Settings as an admin. For each
 * workspace, as the workspace owner (partner token, like call-sync):
 *
 *   1. Read. GET /v1/reputation/summary?refresh=1 — every line's grade and
 *      warnings, spam risk and category from the carrier's reputation feed,
 *      STIR/SHAKEN attestation actually observed on its calls, 10DLC brand /
 *      campaign / number assignment, text failure rate, and Talkr's own
 *      registration checklist. refresh=1 makes Talkr re-read the carrier, so
 *      this is the one billed lookup of the day per number.
 *   2. Enforce. workspaces.settings->'number_guard' (defaults below): every
 *      line gets pause_on_warning and the daily call/text caps; texting from a
 *      line that is not on an approved 10DLC campaign is refused (sms_gate
 *      'block'). Only differences are written.
 *   3. Alert. Compared with yesterday's snapshot (number_health), anything
 *      that got worse — a grade dropping, a number newly flagged as spam or
 *      paused, attestation slipping below A on a meaningful share of calls,
 *      texts failing — is one notification per admin, plus a digest of what
 *      is still open (10DLC not filed or not approved, a line without a
 *      campaign, checklist items to do) at most once a day.
 *
 *   4. Advance. A 10DLC filing an admin already started (migration 76,
 *      functions/ten-dlc-register) is pushed to its next stage, because the
 *      gate between brand, campaign and number assignment is a carrier
 *      decision that arrives whenever it arrives. It never starts one: every
 *      one of those calls charges the registry against the workspace.
 *
 * What it does not do by itself: sign an LOA or accept Telnyx's terms. Those
 * stay a person's job. Once they are done, caller-registry (migration 91)
 * enrolls new lines, files remediation, attaches branded calling and reads
 * the Free Caller Registry code from AgentMail. The guard kicks that after
 * every run.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, corsFor, jsonWith, isServiceCaller } from '../_shared/security.ts';
import { FUNDS_PREFIX, needsFunds } from '../_shared/tendlc.ts';
import { newDigestTopics } from '../_shared/number-digest.ts';
import { activeTalkrBinding, gateTalkrWrite, readTalkrOrg, TALKR_NOT_CONNECTED } from '../_shared/talkr-binding.ts';
import { loadTalkrConnections } from '../_shared/talkr-connect.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const TALKR_DEFAULT_URL = 'https://talkr.example.com';

type Policy = {
  enabled: boolean;
  pause_on_warning: boolean;
  daily_call_cap: number | null;
  daily_sms_cap: number | null;
  sms_gate: 'auto' | 'block' | 'warn';
  /** Alert when fewer than this share of signed calls got Attestation A (with at least 20 calls). */
  min_attestation_a: number;
  alert_admins: boolean;
  /** Outbound caller name (CNAM) to list on every line that has none; null = the workspace name, '' = leave alone. */
  cnam_name: string | null;
};
const DEFAULT_POLICY: Policy = {
  enabled: true, pause_on_warning: true, daily_call_cap: 150, daily_sms_cap: 200, sms_gate: 'block', min_attestation_a: 0.9, alert_admins: true, cnam_name: null,
};

/** CNAM is 15 characters of letters, digits and spaces; a name that does not fit is cut at a word. */
function cnamFrom(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 15) return clean;
  const cut = clean.slice(0, 15);
  const sp = cut.lastIndexOf(' ');
  return (sp > 6 ? cut.slice(0, sp) : cut).trim();
}

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function partnerToken(user: { id: string; email: string | null }): Promise<string | null> {
  const secret = Deno.env.get('TALKR_PARTNER_JWT_SECRET');
  if (!secret || !user.email) return null;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({
    iss: `${Deno.env.get('SUPABASE_URL')}/auth/v1`, sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, iat: now, exp: now + 300,
  })));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function talkr(base: string, token: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: Any }> {
  try {
    const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: 'unreachable' } };
  }
}

const GRADE_RANK: Record<string, number> = { good: 0, watch: 1, at_risk: 2 };
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'POST, OPTIONS', headers: ALLOW_HEADERS });
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...HARDENING } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const input = await req.json().catch(() => ({})) as { action?: string; workspace_id?: number };

  const role = (await isServiceCaller(admin, bearer)) ? 'service_role' : 'person';
  let onlyWorkspace: number | null = null;
  if (role !== 'service_role') {
    if (!bearer) return json({ error: 'sign in' }, 401);
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data: who } = await asCaller.auth.getUser();
    if (!who?.user) return json({ error: 'sign in' }, 401);
    const ws = Number(input.workspace_id);
    if (!Number.isFinite(ws)) return json({ error: 'workspace_id required' }, 400);
    const { data: m } = await admin.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
    if (!m || !['owner', 'admin'].includes(String(m.role))) return json({ error: 'admins only' }, 403);
    onlyWorkspace = ws;
  } else if (Number.isFinite(Number(input.workspace_id))) {
    onlyWorkspace = Number(input.workspace_id);
  }

  const configured = !!Deno.env.get('TALKR_PARTNER_JWT_SECRET');
  const connections = await loadTalkrConnections(admin, onlyWorkspace !== null ? [onlyWorkspace] : undefined);
  const connBy = new Map(connections.map((c) => [c.workspace_id, c]));
  let workspaces: { id: number; name: string; owner_id: string; settings: Any }[] = [];
  if (onlyWorkspace !== null) {
    const { data, error: wsErr } = await admin.from('workspaces').select('id, name, owner_id, settings').eq('id', onlyWorkspace);
    if (wsErr) return json({ error: wsErr.message }, 500);
    workspaces = data ?? [];
  } else if (connections.length) {
    const { data, error: wsErr } = await admin.from('workspaces').select('id, name, owner_id, settings').in('id', connections.map((c) => c.workspace_id));
    if (wsErr) return json({ error: wsErr.message }, 500);
    workspaces = data ?? [];
  }

  const results: Record<string, unknown>[] = [];
  for (const ws of workspaces) {
    const binding = activeTalkrBinding(ws, connBy.get(ws.id) ?? null);
    if (!binding) {
      // Cron never visits an unbound workspace: no run row, no PATCH, no alert.
      if (onlyWorkspace === null) continue;
      const refused = { workspace_id: ws.id, ok: false, numbers: 0, issues: 0, enforced: 0, error: TALKR_NOT_CONNECTED };
      const { error: logErr } = await admin.from('number_guard_runs').insert(refused);
      if (logErr) console.error('number_guard_runs insert', logErr.message);
      results.push(refused);
      continue;
    }
    const policy: Policy = { ...DEFAULT_POLICY, ...((ws.settings?.number_guard ?? {}) as Partial<Policy>) };
    const run: Record<string, unknown> = { workspace_id: ws.id, ok: false, numbers: 0, issues: 0, enforced: 0 };
    try {
      if (!policy.enabled) { run.ok = true; run.summary = { skipped: 'guard disabled in workspace settings' }; results.push(run); continue; }
      if (!configured) throw new Error('TALKR_PARTNER_JWT_SECRET is not set on this project, so the server cannot read Talkr.');
      const base = String(ws.settings?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
      const { data: p } = await admin.from('profiles').select('email').eq('id', ws.owner_id).maybeSingle();
      const token = await partnerToken({ id: ws.owner_id, email: p?.email ?? null });
      if (!token) throw new Error('The workspace owner has no email on their profile, so no Talkr token can be minted.');
      const observed = await readTalkrOrg((path) => talkr(base, token, path));
      const gate = gateTalkrWrite({ binding, observedOrgId: observed });
      if (!gate.ok) throw new Error(gate.error);
      Object.assign(run, await guard(admin, base, token, ws.id, policy, cnamFrom(policy.cnam_name ?? ws.name ?? '')));
      // number_guard_runs has no `advanced` column; a top-level key made every
      // successful run's insert fail, so only failures were ever recorded.
      (run.summary as Record<string, unknown>).advanced = await advanceRegistration(admin, ws.id);
      run.ok = true;
    } catch (e) {
      run.error = e instanceof Error ? e.message : String(e);
    }
    const { error: logErr } = await admin.from('number_guard_runs').insert(run);
    if (logErr) console.error('number_guard_runs insert', logErr.message);
    results.push(run);
  }
  return json({ ok: results.every((r) => r.ok), configured, runs: results });
});

/**
 * Push a filing somebody already started to its next stage.
 *
 * The three 10DLC calls can only run in order, and the gate between them is a
 * carrier decision that arrives whenever it arrives. ten-dlc-register is
 * idempotent and files only what is not filed yet, so calling it each morning
 * turns "wait for the brand, then come back and file the campaign, then come
 * back and attach the numbers" into something nobody has to remember.
 *
 * The line it will not cross: a filing nobody authorised. Without
 * `submitted_at` — an admin pressing Register — this does nothing, because
 * every one of those calls charges TCR against the workspace's account.
 */
async function advanceRegistration(admin: SupabaseClient, wsId: number): Promise<string | null> {
  const { data: reg } = await admin.from('ten_dlc_registrations').select('status, submitted_at, last_error, campaign_id').eq('workspace_id', wsId).maybeSingle();
  if (!reg?.submitted_at) return null;
  // A filing Telnyx refused only for want of funds filed nothing, so trying
  // again is free until the balance is there and then goes through. (Rows
  // saved before that refusal was told apart read 'failed'.)
  const unfunded = reg.status === 'failed' && !reg.campaign_id && (needsFunds(reg.last_error) || String(reg.last_error ?? '').startsWith(FUNDS_PREFIX));
  if (!unfunded && !['submitting', 'brand_pending', 'campaign_pending', 'assigning'].includes(String(reg.status))) return null;
  const url = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/functions/v1/ten-dlc-register`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'register', workspace_id: wsId }),
    });
    const body = await res.json().catch(() => ({})) as Any;
    if (body?.waiting) return `waiting on the ${body.waiting}`;
    if (body?.ok) return 'advanced';
    return String(body?.error ?? `HTTP ${res.status}`);
  } catch (e) {
    return e instanceof Error ? e.message : 'unreachable';
  }
}

async function guard(admin: SupabaseClient, base: string, token: string, wsId: number, policy: Policy, cnam: string) {
  const sum = await talkr(base, token, '/v1/reputation/summary?refresh=1');
  if (!sum.ok) throw new Error(`Talkr reputation ${sum.status}: ${sum.body?.error ?? sum.body?.message ?? 'refused'}`);
  const s = sum.body as Any;
  const numbers: Any[] = s.numbers ?? [];
  const { data: prevRows } = await admin.from('number_health').select('*').eq('workspace_id', wsId);
  const prev = new Map<string, Any>((prevRows ?? []).map((r: Any) => [r.talkr_number_id, r]));

  const alerts: string[] = [];   // got worse since last time → notify now
  const open: string[] = [];     // still not right → in the digest
  let enforced = 0;
  const enforceErrors: string[] = [];

  // ---- workspace-level: the texting gate --------------------------------------
  if (s.carrier_connected && s.sms_gate && s.sms_gate !== policy.sms_gate) {
    const r = await talkr(base, token, '/v1/reputation/settings', { method: 'PATCH', body: JSON.stringify({ sms_gate: policy.sms_gate }) });
    if (r.ok) enforced++; else enforceErrors.push(`sms_gate: ${r.status}`);
  }

  // ---- 10DLC standing ---------------------------------------------------------
  // CLOZR files these itself now (migration 76, functions/ten-dlc-register), so
  // the digest says where the filing has got to rather than repeating "go and
  // do this by hand" every morning at something already in flight.
  const { data: reg } = await admin.from('ten_dlc_registrations').select('*').eq('workspace_id', wsId).maybeSingle();
  const tenDlc = s.ten_dlc;
  if (s.carrier_connected) {
    if (tenDlc?.error) open.push(`10DLC could not be read from the carrier: ${tenDlc.error}`);
    else if (tenDlc) {
      const approved = (tenDlc.campaigns ?? []).filter((c: Any) => c.approved);
      const unfunded = String(reg?.last_error ?? '').startsWith(FUNDS_PREFIX) || needsFunds(reg?.last_error);
      if (unfunded) {
        open.push(`10DLC is waiting on your Telnyx balance, not on the carriers: ${String(reg?.last_error ?? '').replace(FUNDS_PREFIX, '').trim() || 'add funds at portal.telnyx.com → Billing.'}`);
      } else if (!tenDlc.brands?.length) {
        if (reg?.status === 'failed') open.push(`The 10DLC filing was rejected and texting stays blocked: ${reg.last_error ?? 'no reason given'} (Settings → Phone numbers → 10DLC).`);
        else if (reg?.brand_id) open.push(`10DLC brand filed and waiting on TCR (${reg.brand_status ?? 'pending'}) — nothing to do but wait.`);
        else open.push('No 10DLC brand is registered — texts from long codes are filtered until the brand and campaign are filed. CLOZR files both once the company facts are in: Settings → Workspace → Company & 10DLC, then Register.');
      } else if (!approved.length) {
        const filed = (tenDlc.campaigns ?? []).map((c: Any) => `${c.usecase ?? 'campaign'}: ${c.campaign_status ?? c.status ?? 'pending'}`).join(', ');
        if (reg?.status === 'failed') open.push(`The 10DLC campaign was rejected: ${reg.last_error ?? 'no reason given'}. A rejected campaign cannot be edited — correct the facts and file again (Settings → Phone numbers → 10DLC).`);
        else open.push(`10DLC brand is filed but no campaign is approved yet (${filed || 'none submitted'}).`);
      }
    }
  } else {
    open.push(`Carrier checks are off on Talkr (${s.carrier === 'telnyx' ? 'no Telnyx API key set on Talkr' : `calls run on ${s.carrier}`}) — spam risk, 10DLC and caller names cannot be read or fixed.`);
  }
  for (const item of (s.checklist ?? []) as Any[]) {
    if (['todo', 'pending', 'partial'].includes(item.status)) open.push(`${item.title}: ${item.detail}${item.link ? ` ${item.link}` : ''}`);
  }

  // ---- per line ---------------------------------------------------------------
  const rows: Record<string, unknown>[] = [];
  for (const n of numbers) {
    const was = prev.get(n.id);
    const label = n.label ? `${n.label} (${n.phone_e164})` : n.phone_e164;
    const att = n.attestation?.observed_7d ?? { total: 0, A: 0, a_share: null };
    const aShare = typeof att.a_share === 'number' ? att.a_share : (att.total ? att.A / att.total : null);
    const spam = n.spam?.status === 'ok' ? n.spam : null;

    // enforce protection
    const want: Record<string, unknown> = {};
    if (n.protection?.pause_on_warning !== policy.pause_on_warning) want.pause_on_warning = policy.pause_on_warning;
    if (policy.daily_call_cap !== null && n.protection?.daily_call_cap !== policy.daily_call_cap) want.daily_call_cap = policy.daily_call_cap;
    if (policy.daily_sms_cap !== null && n.protection?.daily_sms_cap !== policy.daily_sms_cap) want.daily_sms_cap = policy.daily_sms_cap;
    // A line with no caller name shows as a bare number (or worse) on landlines; list the workspace's.
    // A line that never had CNAM set comes back as null, not as a disabled
    // record, so the old `n.cnam && !n.cnam.enabled` skipped exactly the lines
    // that needed a name and reported the same warning every morning. What we
    // must not do is overwrite a name somebody chose, so only a line with no
    // name listed is written.
    const listed = n.cnam?.enabled ? String(n.cnam.name ?? '').trim() : '';
    const patch: Record<string, unknown> = {};
    if (Object.keys(want).length) patch.protection = want;
    if (cnam && s.carrier_connected && !listed) patch.cnam = { enabled: true, name: cnam };
    if (Object.keys(patch).length) {
      const r = await talkr(base, token, `/v1/numbers/${encodeURIComponent(n.id)}/reputation`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (r.ok) enforced++; else enforceErrors.push(`${label}: ${r.status} ${r.body?.error ?? ''}`.trim());
    }

    // what got worse
    if (was && GRADE_RANK[n.grade] > GRADE_RANK[was.grade ?? 'good']) alerts.push(`${label} dropped to ${n.grade.replace('_', ' ')}: ${(n.warnings ?? []).map((w: Any) => w.message).join('; ') || 'see Caller reputation'}`);
    if (spam?.spam_risk && RISK_RANK[spam.spam_risk] > RISK_RANK[was?.spam_risk ?? 'low'] && spam.spam_risk !== 'low') alerts.push(`${label} is now ${spam.spam_risk} spam risk${spam.spam_category ? ` (${spam.spam_category})` : ''} on the carrier feed — remediation from Talkr, and lower volume on this line.`);
    if (n.paused && !was?.paused) alerts.push(`${label} is paused: outbound calls are refused while its spam-label warning is active.`);
    if (att.total >= 20 && aShare !== null && aShare < policy.min_attestation_a && !(was && was.attestation_a_7d !== null && was.attestation_a_7d < policy.min_attestation_a)) alerts.push(`${label}: only ${Math.round(aShare * 100)}% of its calls this week were signed with Attestation A — calls from a number we do not own on Telnyx get B and are filtered harder.`);
    const failRate = n.metrics?.sms_failure_rate_7d;
    if (typeof failRate === 'number' && n.metrics.sms_sent_7d >= 20 && failRate > 0.05 && !(was && (was.sms_failure_rate_7d ?? 0) > 0.05)) alerts.push(`${label}: ${Math.round(failRate * 100)}% of its texts failed this week (${Object.entries(n.metrics.sms_error_codes ?? {}).map(([c, k]) => `${c}×${k}`).join(', ') || 'carrier filtering'}).`);

    // what is still open
    if (n.grade !== 'good') open.push(`${label} is ${n.grade.replace('_', ' ')}${(n.warnings ?? []).length ? `: ${(n.warnings ?? []).map((w: Any) => w.message).join('; ')}` : ''}.`);
    if (s.carrier_connected && n.ten_dlc?.assigned === false) open.push(`${label} is not on a 10DLC campaign — its texts are filtered${policy.sms_gate === 'block' ? ' and refused by the gate' : ''}.`);
    if (spam?.spam_risk && spam.spam_risk !== 'low') open.push(`${label}: ${spam.spam_risk} spam risk${spam.spam_category ? ` (${spam.spam_category})` : ''}.`);

    rows.push({
      workspace_id: wsId, talkr_number_id: n.id, phone_e164: n.phone_e164, label: n.label ?? null, grade: n.grade, paused: !!n.paused,
      spam_risk: spam?.spam_risk ?? null, spam_category: spam?.spam_category ?? null,
      attestation_a_7d: aShare, attestation_calls_7d: att.total ?? 0,
      ten_dlc_assigned: n.ten_dlc?.assigned ?? null, ten_dlc_status: n.ten_dlc?.assignment_status ?? n.ten_dlc?.campaign?.campaign_status ?? null,
      campaign_approved: n.ten_dlc?.campaign?.approved ?? null,
      sms_failure_rate_7d: typeof failRate === 'number' ? failRate : null,
      warnings: n.warnings ?? [], checked_at: n.checked_at ?? new Date().toISOString(), snapshot: n, updated_at: new Date().toISOString(),
    });
  }
  if (rows.length) {
    const { error } = await admin.from('number_health').upsert(rows, { onConflict: 'workspace_id,talkr_number_id' });
    if (error) throw new Error(`number_health: ${error.message}`);
  }
  // lines Talkr no longer lists
  const gone = [...prev.keys()].filter((id) => !numbers.some((n) => n.id === id));
  if (gone.length) await admin.from('number_health').delete().eq('workspace_id', wsId).in('talkr_number_id', gone);

  // A line that is not on the campaign yet (bought or reassigned since the
  // campaign was approved, or an attach that failed) is attached now. This is
  // the backstop: buying, importing and assigning a line already attach it.
  const unattached = numbers.filter((n) => n.ten_dlc?.assigned === false).map((n) => String(n.phone_e164 ?? '')).filter(Boolean);
  if (unattached.length) {
    try {
      const url = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
      const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      if (url && key) {
        const res = await fetch(`${url}/functions/v1/ten-dlc-register`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'attach', workspace_id: wsId, phones: unattached }),
        });
        const body = await res.json().catch(() => ({})) as Any;
        if (!body?.waiting && !body?.ok && body?.error) enforceErrors.push(`10DLC attach: ${body.error}`);
      }
    } catch (e) {
      enforceErrors.push(`10DLC attach: ${e instanceof Error ? e.message : 'unreachable'}`);
    }
  }

  try {
    const url = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (url && key) {
      const res = await fetch(`${url}/functions/v1/caller-registry`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'advance', workspace_id: wsId }),
      });
      const body = await res.json().catch(() => ({})) as Any;
      const waiting = ((body?.notes ?? []) as string[]).find((n) => n.includes('Free Caller Registry') || n.includes('Enterprise') || n.includes('Branded'));
      if (waiting) open.push(waiting);
      if (!res.ok && body?.error) enforceErrors.push(`caller registry: ${body.error}`);
    }
  } catch (e) {
    enforceErrors.push(`caller registry: ${e instanceof Error ? e.message : 'unreachable'}`);
  }

  // ---- notify -----------------------------------------------------------------
  let notified = 0;
  if (policy.alert_admins) {
    const { data: admins } = await admin.from('workspace_members').select('user_id, role').eq('workspace_id', wsId).in('role', ['owner', 'admin']);
    const targets = (admins ?? []).map((m: Any) => m.user_id as string);
    const notes: Record<string, unknown>[] = [];
    for (const a of alerts) for (const uid of targets) notes.push({ workspace_id: wsId, user_id: uid, category: 'Number health', title: a.length > 120 ? a.slice(0, 117) + '…' : a, body: a });
    let digested = false;
    if (open.length) {
      // One digest a day, and only when a topic is new since the last run. A
      // reworded 10DLC line or a count that ticked is the same list, and
      // re-posting it brought back what the admin had just marked read.
      const digest = open.join('\n');
      const { data: lastRun } = await admin.from('number_guard_runs').select('summary').eq('workspace_id', wsId).eq('ok', true).order('ran_at', { ascending: false }).limit(1).maybeSingle();
      const last = lastRun?.summary as Any;
      if (newDigestTopics(open, last?.open, last?.digest ?? null).length) {
        const title = `${open.length} thing${open.length === 1 ? '' : 's'} to fix on your phone numbers`;
        for (const uid of targets) notes.push({ workspace_id: wsId, user_id: uid, category: 'Number health', title, body: digest });
        digested = true;
      }
    }
    if (notes.length) {
      // A new digest replaces the old one: the bell holds one list, not a week of them.
      if (digested && targets.length) {
        await admin.from('notifications').update({ read_at: new Date().toISOString() })
          .eq('workspace_id', wsId).eq('category', 'Number health').in('user_id', targets)
          .like('title', '% to fix on your phone numbers').is('read_at', null);
      }
      const { error } = await admin.from('notifications').insert(notes);
      if (error) enforceErrors.push(`notify: ${error.message}`); else notified = notes.length;
    }
  }

  return {
    numbers: numbers.length, issues: alerts.length + open.length, enforced,
    summary: { counts: s.counts, sms_gate: s.sms_gate, carrier_connected: s.carrier_connected, alerts, open, digest: open.join('\n'), enforce_errors: enforceErrors, notified },
  };
}
