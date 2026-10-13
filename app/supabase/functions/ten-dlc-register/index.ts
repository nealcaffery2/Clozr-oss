/**
 * POST /ten-dlc-register — file a workspace's 10DLC brand and campaign, and
 * put its numbers on the campaign. Admin-invoked from Settings, or service-role
 * for a re-check.
 *
 *   { action: 'check',    workspace_id }  → validate the facts, file nothing
 *   { action: 'register', workspace_id }  → file whatever is not filed yet
 *   { action: 'assign',   workspace_id }  → (re)assign the messaging profile
 *   { action: 'attach',   workspace_id, phones? } → put these lines (default:
 *       every line CLOZR knows) on the approved campaign, one by one
 *
 * Three calls, in an order that cannot be reordered: the campaign needs a
 * brand id, and the assignment needs a campaign id. Each one's result is
 * written to ten_dlc_registrations before the next is attempted, so a run that
 * dies halfway resumes instead of paying TCR twice — and a second press of
 * Register while a campaign is pending is a no-op, not a second filing.
 *
 * attach is what runs when a number is bought, imported or handed to a
 * teammate, and every morning from number-guard. Telnyx's assign-by-profile is
 * a one-time task over the numbers on the profile at that moment, so a line
 * that arrives later is not on the campaign until something attaches it. Each
 * line is put on the messaging profile and then on the campaign; one already
 * there is left alone. Before the campaign is approved it does nothing, and the
 * approval itself attaches every known line.
 *
 * Carrier credential. Talkr holds the Telnyx key (see number-guard), so by
 * default this calls Talkr's reputation routes with the same partner token
 * every other server-side Talkr call uses. A Telnyx key on CLOZR — the
 * TELNYX_API_KEY secret, else the Vault copy of Talkr's key (migration 98) —
 * switches to calling Telnyx directly, which is the only path until the Talkr
 * routes ship.
 *
 * What this cannot do, and does not pretend to: make the facts true. A wrong
 * EIN, a website without a privacy policy or a consent story that does not
 * match the opt-in box gets the filing rejected, and the rejection comes back
 * through ten-dlc-events naming the field.
 *
 * Env: TALKR_PARTNER_JWT_SECRET (Talkr path), TELNYX_API_KEY or Vault
 * telnyx_api_key (direct path), TELNYX_MESSAGING_PROFILE_ID (optional),
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, corsFor, jsonWith, isServiceCaller } from '../_shared/security.ts';
import {
  type CampaignFacts,
  type EntityFacts,
  type TenDlcFacts,
  brandPayload,
  campaignPayload,
  campaignOk,
  brandOk,
  fundsMessage,
  attachPlan,
  needsFunds,
  normalizePhone,
  qualifies,
  terminal,
  validateCampaign,
  validateEntity,
} from '../_shared/tendlc.ts';
import { telnyxSetting } from '../_shared/telnyx-settings.ts';
import { activeTalkrBinding, gateTalkrWrite, readTalkrOrg, TALKR_NOT_CONNECTED } from '../_shared/talkr-binding.ts';
import { loadTalkrConnections } from '../_shared/talkr-connect.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const TALKR_DEFAULT_URL = 'https://talkr.example.com';
const TELNYX_BASE = 'https://api.telnyx.com/v2';

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

function jwtRole(token: string): string {
  try {
    const part = token.split('.')[1] ?? '';
    const pad = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4);
    return String(JSON.parse(atob(pad)).role ?? '');
  } catch {
    return '';
  }
}

// --------------------------------------------------------------- the carrier

type Called = { ok: boolean; status: number; data: Any; error: string | null };

/**
 * One shape for both paths. Telnyx answers `{ data: {...} }` and Talkr's
 * routes proxy that envelope through unchanged, so callers below read `.data`
 * either way and never learn which path they took.
 */
type Where = { mode: 'talkr'; base: string; token: string } | { mode: 'direct'; key: string };

async function call(where: Where, path: { talkr: string; telnyx: string }, body?: unknown, method = 'POST'): Promise<Called> {
  const url = where.mode === 'talkr' ? `${where.base}${path.talkr}` : `${TELNYX_BASE}${path.telnyx}`;
  const auth = where.mode === 'talkr' ? where.token : where.key;
  try {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({}));
    const data = json?.data ?? json?.brand ?? json?.campaign ?? json;
    const detail = Array.isArray(json?.detail) ? json.detail.map((d: Any) => `${(d?.loc ?? []).slice(-1)[0] ?? ''}: ${d?.msg ?? ''}`).join('; ') : null;
    const error = res.ok ? null : where.mode === 'talkr' && res.status === 404
      ? `Talkr has no ${path.talkr} route, so it cannot file this. Set TELNYX_API_KEY on the CLOZR project (Edge Functions → Secrets) and CLOZR files with Telnyx directly.`
      : String(json?.errors?.[0]?.detail ?? json?.errors?.[0]?.title ?? detail ?? json?.error ?? json?.message ?? `HTTP ${res.status}`);
    return { ok: res.ok, status: res.status, data, error };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : 'unreachable' };
  }
}

const pick = (o: Any, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

/** Every line CLOZR has seen for this workspace (caller-registry keeps the list from Talkr). */
async function knownLines(admin: Any, wsId: number): Promise<string[]> {
  const { data } = await admin.from('caller_lines').select('phone_e164').eq('workspace_id', wsId);
  return [...new Set(((data ?? []) as Any[]).map((r) => String(r.phone_e164 ?? '')).filter((p) => p.startsWith('+1')))];
}

type Attached = { phone: string; outcome: 'attached' | 'already' | 'failed'; error?: string };

/**
 * Put each line on the messaging profile, then on the campaign. One at a time
 * and each on its own: a line Telnyx refuses (not 10DLC-capable, not on this
 * account) does not stop the rest.
 */
async function attachLines(where: Where, phones: string[], campaignId: string, profileId: string): Promise<Attached[]> {
  const out: Attached[] = [];
  for (const phone of phones.slice(0, 200)) {
    const num = encodeURIComponent(phone);
    const cur = await call(where, { talkr: '', telnyx: `/10dlc/phone_number_campaigns/${num}` }, undefined, 'GET');
    const plan = attachPlan(cur.ok ? cur.data : null, campaignId);
    if (plan === 'skip') { out.push({ phone, outcome: 'already' }); continue; }
    const prof = await call(where, { talkr: '', telnyx: `/phone_numbers/${num}/messaging` }, { messaging_profile_id: profileId }, 'PATCH');
    if (!prof.ok) { out.push({ phone, outcome: 'failed', error: `messaging profile: ${prof.error}` }); continue; }
    const r = plan === 'replace'
      ? await call(where, { talkr: '', telnyx: `/10dlc/phone_number_campaigns/${num}` }, { phoneNumber: phone, campaignId }, 'PUT')
      : await call(where, { talkr: '', telnyx: '/10dlc/phone_number_campaigns' }, { phoneNumber: phone, campaignId });
    out.push(r.ok ? { phone, outcome: 'attached' } : { phone, outcome: 'failed', error: r.error ?? `HTTP ${r.status}` });
  }
  return out;
}

// ------------------------------------------------------------------ handler

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'POST, OPTIONS', headers: ALLOW_HEADERS });
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...HARDENING } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const input = await req.json().catch(() => ({})) as { action?: string; workspace_id?: number; phones?: unknown };
  const action = String(input.action ?? 'check');
  if (!['check', 'register', 'assign', 'attach'].includes(action)) return json({ error: 'action must be check, register, assign or attach' }, 400);

  const wsId = Number(input.workspace_id);
  if (!Number.isFinite(wsId)) return json({ error: 'workspace_id required' }, 400);

  // Filing costs money and speaks for the business, so only its admins may.
  let actorId: string | null = null;
  // The service role is exactly the env key or the cron's vault key.
  if (!(await isServiceCaller(admin, bearer))) {
    if (!bearer || jwtRole(bearer) !== 'authenticated') return json({ error: 'sign in' }, 401);
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data: who } = await asCaller.auth.getUser();
    if (!who?.user) return json({ error: 'sign in' }, 401);
    const { data: m } = await admin.from('workspace_members').select('role').eq('workspace_id', wsId).eq('user_id', who.user.id).maybeSingle();
    if (!m || !['owner', 'admin'].includes(String(m.role))) return json({ error: 'admins only' }, 403);
    actorId = who.user.id;
  }

  const { data: ws, error: wsErr } = await admin.from('workspaces').select('id, name, owner_id, settings').eq('id', wsId).maybeSingle();
  if (wsErr) return json({ error: wsErr.message }, 500);
  if (!ws) return json({ error: 'no such workspace' }, 404);
  const binding = activeTalkrBinding(ws, (await loadTalkrConnections(admin, [wsId]))[0] ?? null);
  if (!binding) return json({ ok: false, error: TALKR_NOT_CONNECTED });

  const facts = (ws.settings?.ten_dlc ?? {}) as TenDlcFacts;
  const entity = (facts.entity ?? {}) as Partial<EntityFacts>;
  const campaign = (facts.campaign ?? {}) as Partial<CampaignFacts>;

  const problems = [
    ...validateEntity(entity),
    ...validateCampaign(campaign, entity.display_name || entity.legal_name),
  ];

  const { data: existing, error: regErr } = await admin.from('ten_dlc_registrations').select('*').eq('workspace_id', wsId).maybeSingle();
  if (regErr) return json({ error: `ten_dlc_registrations: ${regErr.message} (is migration 76 applied?)` }, 500);
  const state: Any = existing ?? { workspace_id: wsId, status: 'draft' };
  const telnyxKey = await telnyxSetting(admin, 'TELNYX_API_KEY');
  const carrier = telnyxKey ? 'telnyx' : 'talkr';

  if (action === 'check') {
    return json({ ok: problems.length === 0, problems, registration: existing ?? null, carrier });
  }

  // Attaching a line changes nothing about the filing, so it does not wait on
  // the facts being valid — only on an approved campaign to attach it to.
  if (action === 'attach') {
    const asked = (Array.isArray(input.phones) ? input.phones : []).map((p) => normalizePhone(String(p ?? ''))).filter((p): p is string => Boolean(p));
    const phones = asked.length ? asked : await knownLines(admin, wsId);
    if (!state.campaign_id || !campaignOk(state.campaign_status)) {
      return json({ ok: true, waiting: 'campaign', message: 'The 10DLC campaign is not approved yet. Every line is attached the moment it is.', registration: existing ?? null });
    }
    if (!telnyxKey) {
      return json({ ok: false, error: 'Attaching a line to the campaign needs TELNYX_API_KEY on CLOZR (Edge Functions → Secrets).', registration: state }, 503);
    }
    const profileId = facts.messaging_profile_id?.trim() || state.messaging_profile_id || await telnyxSetting(admin, 'TELNYX_MESSAGING_PROFILE_ID') || null;
    if (!profileId) {
      return json({ ok: false, error: 'No Telnyx messaging profile is set, so a line cannot be attached. Add it in Settings → Workspace → Company & 10DLC.', registration: state }, 422);
    }
    const results = await attachLines({ mode: 'direct', key: telnyxKey }, phones, String(state.campaign_id), profileId);
    const failed = results.filter((r) => r.outcome === 'failed');
    return json({
      ok: failed.length === 0,
      results,
      attached: results.filter((r) => r.outcome === 'attached').map((r) => r.phone),
      already: results.filter((r) => r.outcome === 'already').map((r) => r.phone),
      ...(failed.length ? { error: failed.map((r) => `${r.phone}: ${r.error}`).join(' · ') } : {}),
      registration: state,
    }, failed.length && failed.length === results.length ? 502 : 200);
  }
  if (problems.length) {
    return json({ ok: false, error: 'The 10DLC facts are not complete or not valid yet.', problems, registration: existing ?? null, carrier }, 422);
  }

  // ---- which path to the carrier -------------------------------------------
  let where: Where;
  if (telnyxKey) {
    where = { mode: 'direct', key: telnyxKey };
  } else {
    const base = String(ws.settings?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
    const { data: p } = await admin.from('profiles').select('email').eq('id', ws.owner_id).maybeSingle();
    const token = await partnerToken({ id: ws.owner_id, email: p?.email ?? null });
    if (!token) {
      return json({
        error: 'No way to reach the carrier: TELNYX_API_KEY is not set on CLOZR, and no Talkr partner token could be minted (check TALKR_PARTNER_JWT_SECRET and that the workspace owner has an email).',
      }, 503);
    }
    const observed = await readTalkrOrg(async (path) => {
      try {
        const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
        return { ok: res.ok, body: await res.json().catch(() => ({})) };
      } catch {
        return { ok: false, body: {} };
      }
    });
    if (!gateTalkrWrite({ binding, observedOrgId: observed }).ok) return json({ ok: false, error: TALKR_NOT_CONNECTED });
    where = { mode: 'talkr', base, token };
  }
  const direct = where.mode === 'direct';

  const webhookUrl = `${url.replace(/\/$/, '')}/functions/v1/ten-dlc-events`;
  const save = async (patch: Record<string, unknown>) => {
    Object.assign(state, patch);
    const { error } = await admin.from('ten_dlc_registrations').upsert({ workspace_id: wsId, ...patch }, { onConflict: 'workspace_id' });
    if (error) console.error('ten_dlc_registrations upsert', error.message);
  };

  // Only a refusal of the facts (400/402/422) is a rejection. A missing route,
  // a bad key or an outage is ours to fix and must not read as "Rejected".
  const fail = async (step: string, r: Called) => {
    // Not enough money on the Telnyx account is not a rejection: nothing was
    // filed, so the filing stays in flight and the morning guard files it
    // again, which goes through once the balance is topped up.
    if (needsFunds(r.error)) {
      await save({ status: 'submitting', reasons: [], last_error: fundsMessage(r.error) });
      return json({ ok: false, step, funds: true, error: state.last_error, registration: state }, 402);
    }
    const refused = [400, 402, 422].includes(r.status);
    await save({
      ...(refused ? { status: 'failed', reasons: r.data?.reasons ?? [] } : {}),
      last_error: `${step}: ${r.error ?? 'refused'}`,
    });
    return json({ ok: false, step, error: r.error, registration: state }, refused ? 422 : 502);
  };

  // The webhook is the fast path; this read is the backstop for a missed or
  // unverifiable delivery (no TELNYX_PUBLIC_KEY), and the morning guard runs it.
  if (direct && state.brand_id) {
    const b = await call(where, { talkr: '', telnyx: `/10dlc/brand/${state.brand_id}` }, undefined, 'GET');
    if (b.ok) await save({ brand_status: pick(b.data, 'identityStatus', 'status') ?? state.brand_status, tcr_brand_id: pick(b.data, 'tcrBrandId') ?? state.tcr_brand_id });
  }
  if (direct && state.campaign_id) {
    const c = await call(where, { talkr: '', telnyx: `/10dlc/campaign/${state.campaign_id}` }, undefined, 'GET');
    if (c.ok) await save({ campaign_status: pick(c.data, 'campaignStatus', 'status') ?? state.campaign_status, tcr_campaign_id: pick(c.data, 'tcrCampaignId') ?? state.tcr_campaign_id });
  }

  // A person pressing Register after a rejection means "I fixed the facts".
  // The brand is corrected in place and re-vetted; a rejected campaign cannot
  // be edited, so it is filed again. The morning guard never does either.
  const byHuman = actorId !== null;
  if (action === 'register' && byHuman && state.brand_id && terminal(state.brand_status)) {
    if (!direct) return json({ ok: false, error: 'Correcting a rejected brand needs TELNYX_API_KEY on CLOZR.', registration: state }, 503);
    const u = await call(where, { talkr: '', telnyx: `/10dlc/brand/${state.brand_id}` }, brandPayload(entity as EntityFacts, webhookUrl), 'PUT');
    if (!u.ok) return await fail('brand update', u);
    const rv = await call(where, { talkr: '', telnyx: `/10dlc/brand/${state.brand_id}/revet` }, undefined, 'PUT');
    if (!rv.ok) return await fail('brand revet', rv);
    await save({ brand_status: pick(rv.data, 'identityStatus', 'status') ?? 'PENDING', status: 'brand_pending', reasons: [], last_error: null });
  }
  if (action === 'register' && byHuman && state.campaign_id && terminal(state.campaign_status)) {
    await save({ campaign_id: null, tcr_campaign_id: null, campaign_status: null, campaign_filed_at: null });
  }

  await save({ status: state.status === 'failed' || state.status === 'draft' ? 'submitting' : state.status, submitted_by: state.submitted_by ?? actorId, submitted_at: state.submitted_at ?? new Date().toISOString(), last_error: null });

  // ---- 1. the brand --------------------------------------------------------
  if (action === 'register' && !state.brand_id) {
    const r = await call(where, { talkr: '/v1/reputation/brand', telnyx: '/10dlc/brand' }, brandPayload(entity as EntityFacts, webhookUrl));
    if (!r.ok) return await fail('brand', r);
    await save({
      brand_id: pick(r.data, 'brandId', 'id'),
      tcr_brand_id: pick(r.data, 'tcrBrandId'),
      brand_status: pick(r.data, 'identityStatus', 'status') ?? 'PENDING',
      brand_filed_at: new Date().toISOString(),
      status: 'brand_pending',
      reasons: [],
    });
  }
  if (!state.brand_id) return json({ ok: false, error: 'No brand id yet — file the brand first.', registration: state }, 409);

  // A brand still being vetted cannot carry a campaign; TCR refuses and charges
  // nothing, but the run is noise. Wait for the webhook instead.
  if (action === 'register' && !brandOk(state.brand_status) && !state.campaign_id) {
    if (terminal(state.brand_status)) {
      await save({ status: 'failed', last_error: `The brand is ${state.brand_status}. Correct the legal name, EIN or address in Settings → Workspace → Company & 10DLC and press Register again.` });
      return json({ ok: false, error: state.last_error, registration: state }, 422);
    }
    await save({ status: 'brand_pending' });
    return json({ ok: true, waiting: 'brand', message: `The brand is ${state.brand_status ?? 'pending'}. The campaign is filed as soon as TCR verifies it.`, registration: state });
  }

  // ---- 2. the campaign -----------------------------------------------------
  if (action === 'register' && !state.campaign_id) {
    // Free, and it is the carrier's own answer to "is this use case allowed for
    // this brand, with this many sub use cases" — asked before the fee, not after.
    if (direct) {
      const q = await call(where, { talkr: '', telnyx: `/10dlc/campaignBuilder/brand/${state.brand_id}/usecase/${campaign.usecase}` }, undefined, 'GET');
      if (!q.ok) return await fail('qualify', q);
      const why = qualifies(q.data, (campaign.sub_usecases ?? []).length);
      if (why) return json({ ok: false, error: why, problems: [{ field: 'sub_usecases', problem: why }], registration: state }, 422);
    }
    const r = await call(where, { talkr: '/v1/reputation/campaign', telnyx: '/10dlc/campaignBuilder' }, campaignPayload(state.brand_id, campaign as CampaignFacts, webhookUrl));
    if (!r.ok) return await fail('campaign', r);
    await save({
      campaign_id: pick(r.data, 'campaignId', 'id'),
      tcr_campaign_id: pick(r.data, 'tcrCampaignId'),
      campaign_status: pick(r.data, 'campaignStatus', 'status') ?? 'PENDING',
      campaign_filed_at: new Date().toISOString(),
      status: 'campaign_pending',
      reasons: [],
    });
  }
  if (!state.campaign_id) return json({ ok: false, error: 'No campaign id yet.', registration: state }, 409);

  if (terminal(state.campaign_status)) {
    await save({ status: 'failed', last_error: state.last_error ?? `The campaign is ${state.campaign_status}. Fix the campaign facts and press Register to file a new one.` });
    return json({ ok: false, error: state.last_error, registration: state }, 422);
  }
  if (!campaignOk(state.campaign_status)) {
    if (state.status !== 'campaign_pending') await save({ status: 'campaign_pending' });
    return json({ ok: true, waiting: 'campaign', message: `The campaign is ${state.campaign_status ?? 'pending'}. Numbers are assigned as soon as the carriers approve it.`, registration: state });
  }

  // ---- 3. the numbers ------------------------------------------------------
  // By messaging profile, not one number at a time: every number on the profile
  // joins the campaign, so the line bought next month is covered without anyone
  // remembering to come back here.
  let profileId: string | null = facts.messaging_profile_id?.trim() || state.messaging_profile_id
    || (direct ? await telnyxSetting(admin, 'TELNYX_MESSAGING_PROFILE_ID') : null) || null;
  if (!profileId && direct) {
    const list = await call(where, { talkr: '', telnyx: '/messaging_profiles?page[size]=50' }, undefined, 'GET');
    const rows: Any[] = Array.isArray(list.data) ? list.data : [];
    if (rows.length === 1) profileId = String(rows[0].id);
    else if (rows.length > 1) {
      return json({
        ok: false,
        error: `The campaign is approved. Telnyx has ${rows.length} messaging profiles (${rows.map((r) => `${r.name ?? 'unnamed'} ${r.id}`).join(', ')}); pick the one your lines send from in Settings → Workspace → Company & 10DLC.`,
        registration: state,
      }, 422);
    }
  }
  if (!profileId) {
    return json({
      ok: false,
      error: 'The campaign is approved, but no Telnyx messaging profile is set, so there is nothing to assign. Add it in Settings → Workspace → Company & 10DLC.',
      registration: state,
    }, 422);
  }
  if (state.status === 'active' && state.messaging_profile_id === profileId && action !== 'assign') {
    return json({ ok: true, registration: state });
  }
  if (direct && action === 'register' && state.assignment_task_id && state.messaging_profile_id === profileId) {
    const t = await call(where, { talkr: '', telnyx: `/10dlc/phoneNumberAssignmentByProfile/${state.assignment_task_id}` }, undefined, 'GET');
    const task = String(pick(t.data, 'status') ?? '').toUpperCase();
    if (task === 'COMPLETED') {
      await save({ assignment_status: 'ASSIGNED', status: 'active', active_at: state.active_at ?? new Date().toISOString() });
      return json({ ok: true, registration: state });
    }
    if (t.ok && task !== 'FAILED') {
      await save({ assignment_status: task || 'PENDING' });
      return json({ ok: true, waiting: 'assignment', message: `Your lines are being attached to the campaign (${task.toLowerCase() || 'pending'}).`, registration: state });
    }
  }
  const r = await call(where, { talkr: '/v1/reputation/assign', telnyx: '/10dlc/phoneNumberAssignmentByProfile' }, {
    messagingProfileId: profileId,
    campaignId: state.campaign_id,
  });
  if (!r.ok) return await fail('assign', r);
  await save({
    messaging_profile_id: profileId,
    assignment_task_id: pick(r.data, 'taskId'),
    assignment_status: 'PENDING',
    status: 'assigning',
  });
  // The profile task only covers lines already on the profile. A line that
  // was bought onto another profile, or onto none, is moved here and attached.
  if (direct) {
    const results = await attachLines(where, await knownLines(admin, wsId), String(state.campaign_id), profileId);
    const failed = results.filter((x) => x.outcome === 'failed');
    if (failed.length) await save({ last_error: `attach: ${failed.map((x) => `${x.phone}: ${x.error}`).join(' · ')}` });
  }

  return json({ ok: true, registration: state });
});
