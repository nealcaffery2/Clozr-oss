/**
 * POST /caller-registry — keep a new line on the registries that decide
 * whether it shows as a business or as spam.
 *
 *   { action: 'status',   workspace_id }
 *   { action: 'mail',     workspace_id }   read the AgentMail inbox for Free Caller Registry codes
 *   { action: 'advance',  workspace_id, phones?: string[] }
 *
 * advance is what runs when a number is bought and every business morning
 * from number-guard. It does only the step the carrier will accept:
 *
 *   - queue the number for Free Caller Registry, and ask Firecrawl to submit
 *     the form when FIRECRAWL_API_KEY is set (or Vault secret firecrawl_api_key)
 *   - read AgentMail (AGENTMAIL_API_KEY + caller_registry.agentmail_inbox_id)
 *     for the verification code, and open a confirm link on a registry host
 *   - put the number on the Telnyx messaging profile and re-run the 10DLC
 *     assignment when the campaign is already approved
 *   - enroll it in Number Reputation once that product is approved, and file
 *     remediation when the score is medium or high
 *   - attach it to the branded-calling DIR once the DIR is verified and an
 *     LOA document id is on file
 *   - create the enterprise and the DIR only when caller_registry.auto_file
 *     is set and the facts are complete
 *
 * Every line in the RVM pool is planned the same way as a Talkr line, and one
 * Talkr does not hold also gets its CNAM listing and its spam verdict straight
 * from Telnyx (migration 195), so the pool has the main lines' protection.
 *
 * Creating those is billable and the terms have to be accepted by a person.
 * A missing fact is reported, not guessed.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, corsFor, jsonWith, isServiceCaller } from '../_shared/security.ts';
import {
  type LegalFacts,
  type LinePlan,
  type RegistryFacts,
  cnamFrom,
  cnamTargets,
  dirGaps,
  dirPayload,
  enterpriseGaps,
  enterprisePayload,
  extractFcrMail,
  fcrAgentPrompt,
  fcrFiled,
  planLine,
  registryLines,
  reputationRows,
} from '../_shared/caller-registry.ts';
import { campaignOk as campaignApproved } from '../_shared/tendlc.ts';
import { worseRisk } from '../../../lib/rvm-pool.ts';
import { telnyxSetting } from '../_shared/telnyx-settings.ts';
import { activeTalkrBinding, gateTalkrWrite, readTalkrOrg, TALKR_NOT_CONNECTED } from '../_shared/talkr-binding.ts';
import { loadTalkrConnections } from '../_shared/talkr-connect.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const TALKR_DEFAULT_URL = 'https://talkr.example.com';
const TELNYX = 'https://api.telnyx.com/v2';

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

async function telnyx(key: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Any }> {
  try {
    const res = await fetch(`${TELNYX}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok || res.status === 202, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: e instanceof Error ? e.message : 'unreachable' } };
  }
}

const errOf = (json: Any, status: number) => String(json?.errors?.[0]?.detail ?? json?.errors?.[0]?.title ?? json?.error ?? json?.message ?? `HTTP ${status}`);

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'POST, OPTIONS', headers: ALLOW_HEADERS });
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...HARDENING } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const input = await req.json().catch(() => ({})) as { action?: string; workspace_id?: number; phones?: string[] };
  const action = String(input.action ?? 'status');
  if (!['status', 'mail', 'advance'].includes(action)) return json({ error: 'action must be status, mail or advance' }, 400);
  const wsId = Number(input.workspace_id);
  if (!Number.isFinite(wsId)) return json({ error: 'workspace_id required' }, 400);

  // The service role is exactly the env key or the cron's vault key.
  if (!(await isServiceCaller(admin, bearer))) {
    if (!bearer || jwtRole(bearer) !== 'authenticated') return json({ error: 'sign in' }, 401);
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data: who } = await asCaller.auth.getUser();
    if (!who?.user) return json({ error: 'sign in' }, 401);
    const { data: m } = await admin.from('workspace_members').select('role').eq('workspace_id', wsId).eq('user_id', who.user.id).maybeSingle();
    if (!m || !['owner', 'admin'].includes(String(m.role))) return json({ error: 'admins only' }, 403);
  }

  const { data: ws } = await admin.from('workspaces').select('id, name, owner_id, settings').eq('id', wsId).maybeSingle();
  if (!ws) return json({ error: 'no such workspace' }, 404);
  const settings = (ws.settings ?? {}) as Any;
  // Binding and org match before any caller_lines, registry state, or mail write.
  const binding = activeTalkrBinding(ws, (await loadTalkrConnections(admin, [wsId]))[0] ?? null);
  if (!binding) return json({ ok: false, error: TALKR_NOT_CONNECTED });
  {
    const talkrBase = String(settings.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
    const { data: owner } = await admin.from('profiles').select('email').eq('id', ws.owner_id).maybeSingle();
    const token = await partnerToken({ id: ws.owner_id, email: owner?.email ?? null });
    if (!token) return json({ ok: false, error: TALKR_NOT_CONNECTED });
    const observed = await readTalkrOrg(async (path) => {
      try {
        const res = await fetch(`${talkrBase}${path}`, { headers: { authorization: `Bearer ${token}` } });
        return { ok: res.ok, body: await res.json().catch(() => ({})) };
      } catch {
        return { ok: false, body: {} };
      }
    });
    if (!gateTalkrWrite({ binding, observedOrgId: observed }).ok) return json({ ok: false, error: TALKR_NOT_CONNECTED });
  }
  const legal = (settings.ten_dlc?.entity ?? {}) as LegalFacts;
  const reg = (settings.caller_registry ?? {}) as RegistryFacts;
  const inboxId = reg.agentmail_inbox_id?.trim() || Deno.env.get('AGENTMAIL_INBOX_ID') || '';
  const fcrEmail = (reg.fcr_email || legal.email || '').trim();

  const { data: existing } = await admin.from('caller_registry_state').select('*').eq('workspace_id', wsId).maybeSingle();
  const state: Any = existing ?? { workspace_id: wsId };
  const { data: lineRows } = await admin.from('caller_lines').select('*').eq('workspace_id', wsId);
  const lines = new Map<string, Any>((lineRows ?? []).map((r: Any) => [r.phone_e164, r]));

  // Columns a database without migration 195 lacks: written when there, dropped when not.
  const NEW_LINE_COLS = ['spam_category', 'reputation_checked_at', 'cnam_listed'];
  const without = (row: Record<string, unknown>, cols: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !cols.includes(k)));
  const saveState = async (patch: Record<string, unknown>) => {
    Object.assign(state, patch, { last_run_at: new Date().toISOString() });
    const { error } = await admin.from('caller_registry_state').upsert({ workspace_id: wsId, ...state }, { onConflict: 'workspace_id' });
    if (error && /fcr_job_phones/.test(error.message)) {
      await admin.from('caller_registry_state').upsert(without({ workspace_id: wsId, ...state }, ['fcr_job_phones']), { onConflict: 'workspace_id' });
    }
  };
  const saveLine = async (phone: string, patch: Record<string, unknown>) => {
    const row = { ...(lines.get(phone) ?? { workspace_id: wsId, phone_e164: phone, fcr_status: 'queued' }), ...patch };
    lines.set(phone, row);
    const { error } = await admin.from('caller_lines').upsert(row, { onConflict: 'workspace_id,phone_e164' });
    if (error && NEW_LINE_COLS.some((c) => error.message.includes(c))) {
      const retry = await admin.from('caller_lines').upsert(without(row, NEW_LINE_COLS), { onConflict: 'workspace_id,phone_e164' });
      if (retry.error) console.error('caller_lines', phone, retry.error.message);
    } else if (error) console.error('caller_lines', phone, error.message);
  };

  const notes: string[] = [];
  const problems = [...enterpriseGaps(legal, reg), ...(reg.auto_file ? dirGaps(reg, legal) : [])];

  // ---- AgentMail: the verification code ------------------------------------
  const syncMail = async () => {
    const key = Deno.env.get('AGENTMAIL_API_KEY');
    if (!key || !inboxId) {
      notes.push(key ? 'No AgentMail inbox id on caller_registry.agentmail_inbox_id.' : 'AGENTMAIL_API_KEY is not set, so Free Caller Registry mail is not read.');
      return;
    }
    const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages?limit=25`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const body = await res.json().catch(() => ({})) as Any;
    if (!res.ok) {
      notes.push(`AgentMail: ${errOf(body, res.status)}`);
      return;
    }
    const messages: Any[] = body.messages ?? body.data ?? [];
    for (const msg of messages) {
      const from = String(msg.from ?? msg.from_ ?? '');
      const subject = String(msg.subject ?? '');
      const text = String(msg.text ?? msg.extracted_text ?? msg.preview ?? msg.html ?? '');
      const found = extractFcrMail({ from, subject, text });
      if (!found) continue;
      const id = String(msg.message_id ?? msg.messageId ?? msg.id ?? '');
      if (!id) continue;
      await admin.from('caller_registry_mail').upsert({
        message_id: id, workspace_id: wsId, from_addr: from, subject, code: found.code, confirm_url: found.url, received_at: msg.timestamp ?? msg.created_at ?? null,
      }, { onConflict: 'message_id' });
      if (found.code) {
        state.last_code = found.code;
        state.last_code_at = new Date().toISOString();
      }
      if (found.url) {
        const { data: prior } = await admin.from('caller_registry_mail').select('clicked_at').eq('message_id', id).maybeSingle();
        if (!prior?.clicked_at) {
          const click = await fetch(found.url, { redirect: 'follow' });
          if (click.ok || click.status < 400) {
            await admin.from('caller_registry_mail').update({ clicked_at: new Date().toISOString() }).eq('message_id', id);
            notes.push('Opened a Free Caller Registry confirmation link from AgentMail.');
          }
        }
      }
    }
    if (state.last_code) {
      for (const [phone, row] of lines) {
        if (row.fcr_status === 'queued' || row.fcr_status === 'submitting') await saveLine(phone, { fcr_status: 'code_ready', last_error: null });
      }
    }
  };

  if (action === 'mail' || action === 'advance') await syncMail();

  if (action === 'status' || action === 'mail') {
    await saveState({ last_error: notes.filter((n) => n.startsWith('AgentMail')).join(' ') || null, notes });
    return json({ ok: true, state, lines: [...lines.values()], problems, notes });
  }

  // ---- which lines ---------------------------------------------------------
  const snapshots: Any[] = [];
  const hinted = (input.phones ?? []).map((p) => p.trim()).filter(Boolean);

  const telnyxKey = await telnyxSetting(admin, 'TELNYX_API_KEY');
  {
    const talkrBase = String(settings.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
    const { data: p } = await admin.from('profiles').select('email').eq('id', ws.owner_id).maybeSingle();
    const talkrToken = await partnerToken({ id: ws.owner_id, email: p?.email ?? null }) ?? '';
    if (talkrToken) {
      const res = await fetch(`${talkrBase}/v1/reputation/summary`, { headers: { authorization: `Bearer ${talkrToken}` } });
      const body = await res.json().catch(() => ({})) as Any;
      if (res.ok) {
        snapshots.length = 0;
        for (const n of (body.numbers ?? []) as Any[]) snapshots.push(n);
      } else notes.push(`Talkr reputation: ${errOf(body, res.status)}`);
    }
  }
  // number_health's 10DLC flag for lines Talkr's summary leaves out.
  const { data: healthRows } = await admin.from('number_health').select('phone_e164, ten_dlc_assigned').eq('workspace_id', wsId);
  const health: Record<string, { ten_dlc_assigned: boolean | null }> = {};
  for (const h of (healthRows ?? []) as Any[]) if (h.phone_e164) health[h.phone_e164] = { ten_dlc_assigned: h.ten_dlc_assigned ?? null };

  const { data: filing } = await admin.from('ten_dlc_registrations').select('status, campaign_status, messaging_profile_id').eq('workspace_id', wsId).maybeSingle();
  const profileId = filing?.messaging_profile_id || settings.ten_dlc?.messaging_profile_id || null;
  const campaignOk = filing?.status === 'active' || campaignApproved(filing?.campaign_status);

  // ---- Telnyx gates --------------------------------------------------------
  let reputationApproved = state.reputation_status === 'approved' && state.loa_status === 'approved';
  let dirVerified = state.dir_status === 'verified';
  if (telnyxKey) {
    if (!state.enterprise_id) {
      const list = await telnyx(telnyxKey, 'GET', '/enterprises');
      const rows: Any[] = list.json?.data ?? [];
      if (rows.length === 1) state.enterprise_id = rows[0].id;
      else if (rows.length > 1) notes.push('More than one Telnyx enterprise exists. Set caller_registry by saving enterprise_id on the state row before filing another.');
      else if (reg.auto_file && enterpriseGaps(legal, reg).length === 0) {
        const created = await telnyx(telnyxKey, 'POST', '/enterprises', enterprisePayload(
          legal, reg, settings.ten_dlc?.entity?.entity_type, settings.ten_dlc?.entity?.vertical,
        ));
        if (created.ok) state.enterprise_id = created.json?.data?.id ?? created.json?.id;
        else notes.push(`Enterprise: ${errOf(created.json, created.status)}`);
      } else if (reg.auto_file) notes.push('Enterprise was not created — the legal facts are incomplete.');
    }
    if (state.enterprise_id) {
      const rep = await telnyx(telnyxKey, 'GET', `/enterprises/${state.enterprise_id}/reputation`);
      if (rep.ok) {
        state.reputation_status = rep.json?.data?.status ?? state.reputation_status;
        state.loa_status = rep.json?.data?.loa_status ?? state.loa_status;
        reputationApproved = state.reputation_status === 'approved' && state.loa_status === 'approved';
      }
      // The carrier's spam verdict for every enrolled line, the RVM pool's
      // included: rvm-tick skips a high one and rvm-pool rotates it out.
      if (reputationApproved) {
        for (let page = 1; page <= 20; page++) {
          const list = await telnyx(telnyxKey, 'GET', `/enterprises/${state.enterprise_id}/reputation/numbers?page[size]=250&page[number]=${page}`);
          if (!list.ok) { notes.push(`Reputation read: ${errOf(list.json, list.status)}`); break; }
          for (const r of reputationRows(list.json)) {
            if (!lines.has(r.phone_e164)) continue;
            await saveLine(r.phone_e164, { spam_risk: r.spam_risk, spam_category: r.spam_category, reputation_checked_at: r.checked_at ?? new Date().toISOString() });
          }
          if (page >= Number(list.json?.meta?.total_pages ?? 1)) break;
        }
      }
      if (!state.dir_id && reg.auto_file && dirGaps(reg, legal).length === 0 && reg.terms_accepted) {
        await telnyx(telnyxKey, 'POST', `/terms_of_service/branded_calling/agree`);
        await telnyx(telnyxKey, 'POST', `/enterprises/${state.enterprise_id}/branded_calling`);
        const dir = await telnyx(telnyxKey, 'POST', `/enterprises/${state.enterprise_id}/dir`, dirPayload(reg, legal));
        if (dir.ok) {
          state.dir_id = dir.json?.data?.id ?? dir.json?.id;
          state.dir_status = dir.json?.data?.status ?? 'draft';
        } else notes.push(`Branded calling: ${errOf(dir.json, dir.status)}`);
      }
      if (state.dir_id) {
        const dir = await telnyx(telnyxKey, 'GET', `/dir/${state.dir_id}`);
        if (dir.ok) state.dir_status = dir.json?.data?.status ?? state.dir_status;
        if (state.dir_status === 'draft') {
          const sub = await telnyx(telnyxKey, 'POST', `/dir/${state.dir_id}/submit`);
          if (sub.ok) state.dir_status = sub.json?.data?.status ?? 'submitted';
          else notes.push(`DIR submit: ${errOf(sub.json, sub.status)}`);
        }
        dirVerified = state.dir_status === 'verified';
      }
    }
  } else notes.push('TELNYX_API_KEY is not set on CLOZR. 10DLC still files through Talkr; reputation enrollment and branded calling wait for the key.');

  const gates = {
    reputation_approved: reputationApproved,
    dir_verified: dirVerified,
    loa_document_id: reg.loa_document_id ?? null,
    messaging_profile_id: profileId,
    campaign_approved: Boolean(campaignOk && profileId),
  };

  const plans: LinePlan[] = [];
  for (const n of registryLines(snapshots, hinted, [...lines.values()], health)) {
    const phone = n.phone_e164;
    // The worse of Talkr's verdict and the carrier's (just read above), so neither overwrites a high with a low.
    const risk = worseRisk(n.spam_risk, lines.get(phone)?.spam_risk) ?? n.spam_risk ?? lines.get(phone)?.spam_risk ?? null;
    const plan = planLine(
      { phone_e164: phone, spam_risk: risk, ten_dlc_assigned: n.ten_dlc_assigned ?? null },
      lines.get(phone) ? {
        phone_e164: phone,
        reputation_enrolled: Boolean(lines.get(phone).reputation_enrolled),
        branded_attached: Boolean(lines.get(phone).branded_attached),
        fcr_status: String(lines.get(phone).fcr_status ?? 'queued'),
        remediation_open: Boolean(lines.get(phone).remediation_open),
      } : null,
      gates,
    );
    plans.push(plan);
    await saveLine(phone, {
      talkr_number_id: n.talkr_number_id ?? lines.get(phone)?.talkr_number_id ?? null,
      spam_risk: risk,
      fcr_status: lines.get(phone)?.fcr_status ?? 'queued',
    });
  }

  // ---- CNAM on pool lines Talkr does not hold ------------------------------
  // number-guard lists the business name through Talkr on Talkr's numbers;
  // a pool line bought on the carrier directly gets it here.
  const cnamName = cnamFrom(String(settings.number_guard?.cnam_name || reg.display_name || legal.display_name || ws.name || ''));
  if (telnyxKey && cnamName) {
    for (const phone of cnamTargets([...lines.values()])) {
      const r = await telnyx(telnyxKey, 'PATCH', `/phone_numbers/${encodeURIComponent(phone)}/voice`, {
        cnam_listing: { cnam_listing_enabled: true, cnam_listing_details: cnamName },
      });
      if (r.ok) await saveLine(phone, { cnam_listed: true, last_error: null });
      else notes.push(`${phone} CNAM: ${errOf(r.json, r.status)}`);
    }
  }

  if (telnyxKey && state.enterprise_id) {
    const enroll = plans.filter((p) => p.enroll_reputation).map((p) => p.phone_e164);
    for (let i = 0; i < enroll.length; i += 100) {
      const batch = enroll.slice(i, i + 100);
      const r = await telnyx(telnyxKey, 'POST', `/enterprises/${state.enterprise_id}/reputation/numbers`, { phone_numbers: batch });
      if (r.ok) for (const phone of batch) await saveLine(phone, { reputation_enrolled: true, last_error: null });
      else notes.push(`Reputation enroll: ${errOf(r.json, r.status)}`);
    }
    const brand = plans.filter((p) => p.attach_branded).map((p) => p.phone_e164);
    for (let i = 0; i < brand.length && state.dir_id; i += 15) {
      const batch = brand.slice(i, i + 15);
      const r = await telnyx(telnyxKey, 'POST', `/dir/${state.dir_id}/phone_numbers`, {
        phone_numbers: batch,
        documents: [{ document_id: reg.loa_document_id, document_type: 'letter_of_authorization', description: 'LOA covering this set of numbers.' }],
      });
      if (r.ok) for (const phone of batch) await saveLine(phone, { branded_attached: true, last_error: null });
      else notes.push(`Branded numbers: ${errOf(r.json, r.status)}`);
    }
    const fix = plans.filter((p) => p.remediate).map((p) => p.phone_e164);
    if (fix.length) {
      const purpose = (reg.call_purpose || settings.ten_dlc?.campaign?.description || 'Outbound calls to people who asked this business to contact them about a property.').slice(0, 2000);
      const r = await telnyx(telnyxKey, 'POST', `/enterprises/${state.enterprise_id}/reputation/remediation`, {
        phone_numbers: fix, call_purpose: purpose, contact_email: fcrEmail || undefined,
      });
      if (r.ok) for (const phone of fix) await saveLine(phone, { remediation_open: true, remediation_id: r.json?.data?.id ?? null, last_error: null });
      else notes.push(`Remediation: ${errOf(r.json, r.status)}`);
    }
    const assign = plans.filter((p) => p.assign_messaging_profile);
    if (assign.length && profileId) {
      for (const p of assign) {
        const path = `/phone_numbers/${encodeURIComponent(p.phone_e164)}/messaging`;
        const r = await telnyx(telnyxKey, 'PATCH', path, { messaging_profile_id: profileId });
        if (!r.ok) notes.push(`${p.phone_e164} messaging profile: ${errOf(r.json, r.status)}`);
      }
      const kicked = await fetch(`${url.replace(/\/$/, '')}/functions/v1/ten-dlc-register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'attach', workspace_id: wsId, phones: assign.map((p) => p.phone_e164) }),
      });
      if (!kicked.ok) notes.push(`10DLC attach: HTTP ${kicked.status}`);
    }
  }

  // ---- Free Caller Registry via Firecrawl ----------------------------------
  const queued = [...lines.values()].filter((r) => r.fcr_status === 'queued' || r.fcr_status === 'code_ready').map((r) => r.phone_e164 as string);
  const envFire = Deno.env.get('FIRECRAWL_API_KEY')?.trim() ?? '';
  let fireKey = envFire;
  if (!fireKey) {
    const { data: fromVault, error: vaultErr } = await admin.rpc('caller_registry_firecrawl_key');
    if (!vaultErr && typeof fromVault === 'string') fireKey = fromVault.trim();
  }
  // The numbers the open job was handed (migration 195), else the ones still marked submitting.
  const jobPhones = (): string[] => Array.isArray(state.fcr_job_phones) && state.fcr_job_phones.length
    ? state.fcr_job_phones.filter((p: unknown) => typeof p === 'string' && lines.has(p))
    : fcrFiled([...lines.values()]);
  if (state.fcr_job_id && fireKey) {
    const job = await fetch(`https://api.firecrawl.dev/v2/agent/${state.fcr_job_id}`, { headers: { authorization: `Bearer ${fireKey}` } });
    const jobBody = await job.json().catch(() => ({})) as Any;
    state.fcr_job_status = jobBody.status ?? state.fcr_job_status;
    if (['completed', 'success', 'finished'].includes(String(state.fcr_job_status))) {
      // The lines the job was handed, not the ones still waiting their turn.
      for (const phone of jobPhones()) await saveLine(phone, { fcr_status: 'submitted', last_error: null });
      state.fcr_job_id = null;
      state.fcr_job_phones = null;
    } else if (['failed', 'error'].includes(String(state.fcr_job_status))) {
      notes.push(`Firecrawl: ${jobBody.error ?? 'the registry form did not submit'}`);
      // Back in the queue for the next run, instead of submitting forever.
      for (const phone of jobPhones()) await saveLine(phone, { fcr_status: 'queued' });
      state.fcr_job_id = null;
      state.fcr_job_phones = null;
    }
  } else if (queued.length && fireKey && fcrEmail && !state.fcr_job_id) {
    const business = reg.display_name || legal.display_name || legal.legal_name || ws.name;
    const started = await fetch('https://api.firecrawl.dev/v2/agent', {
      method: 'POST',
      headers: { authorization: `Bearer ${fireKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        urls: ['https://freecallerregistry.com/fcr'],
        prompt: fcrAgentPrompt({ business, email: fcrEmail, phones: queued.slice(0, 20), code: state.last_code ?? null }),
      }),
    });
    const startedBody = await started.json().catch(() => ({})) as Any;
    if (started.ok && (startedBody.id || startedBody.jobId)) {
      state.fcr_job_id = startedBody.id ?? startedBody.jobId;
      state.fcr_job_status = startedBody.status ?? 'processing';
      state.fcr_job_phones = queued.slice(0, 20);
      for (const phone of queued.slice(0, 20)) await saveLine(phone, { fcr_status: 'submitting' });
    } else notes.push(`Firecrawl: ${errOf(startedBody, started.status)}`);
  } else if (queued.length && !fireKey) {
    notes.push(`${queued.length} number${queued.length === 1 ? '' : 's'} waiting on Free Caller Registry. Set FIRECRAWL_API_KEY to submit the form, or add them at freecallerregistry.com — the verification code is read from AgentMail.`);
  }

  await saveState({ last_error: notes.find((n) => !n.startsWith(`${queued.length} number`)) ?? null, notes });
  return json({
    ok: notes.every((n) => n.startsWith(`${queued.length} number`) || n.includes('not set')),
    state, lines: [...lines.values()], problems, notes, plans,
  });
});
