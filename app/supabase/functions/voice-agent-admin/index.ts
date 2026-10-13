/**
 * POST /voice-agent-admin: the AI Agent console's backend (migration 111).
 *
 * Deployed with verify_jwt (the default), so the gateway checks the bearer's
 * signature; the caller must also be a member of `workspace_id`. Reads are open
 * to any member; changing, publishing, spending ElevenLabs or Anthropic credit
 * needs the owner or admin role (the check call-sync and caller-registry use).
 * Body { action, workspace_id, agent_key?, ... }; every answer is
 * { ok: true, ... } or { error }. Neither the ElevenLabs API key nor any stored
 * secret is ever returned. agent_key defaults to 'lead_manager', so a
 * single-agent workspace never has to send one.
 *
 * Agents      list_agents, templates, create_agent, duplicate_agent, delete_agent, set_enabled
 * Editing     get, save_draft (never touches ElevenLabs), preview_prompt
 * Publishing  publish (= connect), versions, diff, rollback
 * Testing     voices, preview, test_session (phone: rings that number instead), scenarios, score_call
 * Calls       calls, stats
 * Deprecated  save_settings (= save_draft), connect (= publish)
 *
 * One ElevenLabs agent per agent_key. A workspace's agents share one secret
 * set, one lead_context tool and one post-call webhook; the phone webhooks tell
 * agents apart by the ElevenLabs agent_id in each payload and read the agent's
 * LIVE settings (what was last published), never its draft.
 *
 * Needs ELEVENLABS_API_KEY for everything that talks to ElevenLabs and
 * ANTHROPIC_API_KEY for score_call. Setup and shapes: docs/voice-agent.md.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { corsFor, fence, jsonWith, rateLimit, serverError, tooMany, UNTRUSTED_RULE } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';
import { NO_EXTRAS, buildInitiation, phoneKey, pickPersona, resolveCaller, type CallLeg, type Resolution } from '../_shared/voice-agent.ts';
import { initiationFor, loadCandidates, missingRelation } from '../_shared/voice-agent-db.ts';
import {
  ElevenError, PREVIEW_MAX_CHARS, SAMPLE_BUYER, SAMPLE_BUYER_MEMORY, SAMPLE_CANDIDATE, SAMPLE_MEMORY, SAMPLE_REP, agentBody, builtWriteTools, callOut, checksFromAgent, deleteRemoteAgent, elJson,
  generateSecret, getSignedUrl, listVoices, previewSpeech, runConnect, webhookUrls,
  type Checks, type ConnectState, type ElConfig,
} from '../_shared/voice-agent-admin.ts';
import {
  AGENT_KEY_RE, DEFAULT_AGENT_KEY, TOOL_AVAILABLE, TOOL_KEYS, TOOL_LABELS, cleanText, defaultSettings, diffLines, diffSettings, normalizeSettings,
  settingsFromRow, slugify, type AgentSettings,
} from '../_shared/voice-agent-settings.ts';
import { TEMPLATES } from '../_shared/voice-agent-templates.ts';
import { assemblePrompt, estimateTokens, promptWarnings } from '../_shared/voice-agent-prompt.ts';
import { SCENARIOS, SCORING_SYSTEM, SCORING_TOOL, parseGrades, scenarioById, scoringUserMessage } from '../_shared/voice-agent-scenarios.ts';
import { aggregateStats, enabledAfterPublish, parseSetEnabled } from '../_shared/voice-agent-calls.ts';
import { audienceForRole } from '../_shared/ai-agent.ts';
import { telnyxSetting } from '../_shared/telnyx-settings.ts';
import { phoneE164 } from '../_shared/docs-people.ts';
import {
  TelnyxError, cleanAreaCode, cleanCovers, cleanLabel, defaultLabel, ensureSipConnection, importToEleven, numberId, orderNumber, pickLocalNumber, tagNumber, updateEleven,
  type NumberRow, type SipState,
} from '../_shared/agent-lines.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

type Body = Record<string, unknown> & { action?: string; workspace_id?: number | string; agent_key?: string };

const NOT_MIGRATED = 'AI Agent is not set up: apply migration 111 (voice_agent_settings).';
const NO_KEY = 'ELEVENLABS_API_KEY is not set on the Supabase project.';
const MAX_AGENTS = 10;
const CONFIRM_MSG = 'Deleting an agent removes it from ElevenLabs and deletes its versions. Send confirm: true to go ahead.';

const READ = ['numbers', 'get', 'list_agents', 'templates', 'preview_prompt', 'versions', 'diff', 'calls', 'stats', 'scenarios'];
const WRITE = ['save_draft', 'save_settings', 'create_agent', 'duplicate_agent', 'delete_agent', 'set_enabled', 'publish', 'connect', 'rollback', 'voices', 'preview', 'test_session', 'score_call', 'set_number', 'add_number', 'wire_numbers'];

type SettingsRow = {
  workspace_id: number; agent_key: string; role: string; name: string; status: 'draft' | 'live'; enabled: boolean; settings: unknown;
  live_settings: unknown; live_version: number; latest_version: number; agent_id: string | null; connected_at: string | null; updated_at: string;
  /** Migration 123; absent before it. */
  avatar_url?: string | null; audience?: string | null;
};
type SecretsRow = {
  workspace_id: number; personalize_secret: string | null; tool_secret: string | null; webhook_secret: string | null; webhook_id: string | null; tool_id: string | null;
  /** The write tools' ElevenLabs ids (migration 123); absent before it. */
  tool_ids?: Record<string, string> | null;
};
const COLS = 'workspace_id, agent_key, role, name, status, enabled, settings, live_settings, live_version, latest_version, agent_id, connected_at, updated_at';
/** COLS plus the face and audience (migration 123). Reads fall back to COLS on a database without them. */
const COLS_123 = `${COLS}, avatar_url, audience`;
const lacks123 = (e: { message?: string } | null) => !!e && /avatar_url|audience/.test(String(e.message ?? ''));

/** The list-row shape: what the console shows for an agent without opening it. */
function summary(r: SettingsRow) {
  const draft = settingsFromRow(r.settings);
  return {
    agent_key: r.agent_key, role: r.role, name: r.name || draft.identity.name, status: r.status, enabled: r.enabled, agent_id: r.agent_id,
    connected: !!r.agent_id && !!r.connected_at, connected_at: r.connected_at, live_version: r.live_version, latest_version: r.latest_version,
    has_unpublished_changes: !r.live_settings || JSON.stringify(settingsFromRow(r.live_settings)) !== JSON.stringify(draft), updated_at: r.updated_at,
    avatar_url: r.avatar_url ?? null, audience: r.audience ?? audienceForRole(r.role),
  };
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const action = String(body.action ?? '');
  const ws = Number(body.workspace_id);
  if (!Number.isInteger(ws) || ws <= 0) return json({ error: 'workspace_id is required' }, 422);
  if (![...READ, ...WRITE].includes(action)) return json({ error: `action must be one of ${[...READ, ...WRITE].join(', ')}` }, 400);
  const key = body.agent_key === undefined || body.agent_key === null || body.agent_key === '' ? DEFAULT_AGENT_KEY : String(body.agent_key);
  if (!AGENT_KEY_RE.test(key)) return json({ error: 'agent_key must be a slug: lowercase letters, digits and underscores, starting with a letter' }, 422);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  const userId = who.user.id;
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', userId).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  const isAdmin = ['owner', 'admin'].includes(String(member.role));
  if (!READ.includes(action) && !isAdmin) return json({ error: 'only an owner or admin can change the AI Agent' }, 403);

  // Reads (opening the console, the numbers table, stats) are what a screen does on every
  // load, so they get a far larger budget than changes; publish keeps its own tighter one.
  const rl = READ.includes(action)
    ? await rateLimit(admin, `voice-agent-admin-read:${userId}`, 3000, 3600)
    : await rateLimit(admin, `voice-agent-admin:${userId}`, 600, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const apiKey = Deno.env.get('ELEVENLABS_API_KEY') ?? '';
  const cfg: ElConfig = { apiKey, baseUrl: Deno.env.get('ELEVENLABS_API_BASE') || undefined };
  const urls = webhookUrls(url);

  /** An ElevenLabs failure as our answer: 502 with its (redacted) reason, never a 500. */
  const elFail = (e: unknown) => {
    if (!(e instanceof ElevenError)) return null;
    const hint = e.status === 401 || e.status === 403 ? 'ElevenLabs rejected the API key or its permissions' : 'ElevenLabs refused the request';
    return json({ error: `${hint}: ${e.message}` }, 502);
  };

  const readAgent = async (k = key): Promise<SettingsRow | null> => {
    const one = (cols: string) => admin.from('voice_agent_settings').select(cols).eq('workspace_id', ws).eq('agent_key', k).maybeSingle();
    let r = await one(COLS_123);
    if (lacks123(r.error)) r = await one(COLS);
    if (r.error) throw r.error;
    return (r.data as unknown as SettingsRow | null) ?? null;
  };
  const readAgents = async (): Promise<SettingsRow[]> => {
    const all = (cols: string) => admin.from('voice_agent_settings').select(cols).eq('workspace_id', ws).order('created_at');
    let r = await all(COLS_123);
    if (lacks123(r.error)) r = await all(COLS);
    if (r.error) throw r.error;
    return (r.data ?? []) as unknown as SettingsRow[];
  };
  /**
   * Lead manager → Acquisitions out of the box (migration 124): a new Lead
   * manager hands to the workspace's Acquisitions agent when there is exactly
   * one, and a new Acquisitions agent becomes the next stage of every Lead
   * manager that has none. Best effort: before migration 124 nothing happens.
   */
  const wireHandoff = async (k: string, role: string) => {
    const rows = await readAgents();
    const acq = rows.filter((r) => r.role === 'acquisitions');
    const run = async (q: PromiseLike<{ error: { message?: string } | null }>) => {
      const { error } = await q;
      if (error && !/handoff_/.test(String(error.message ?? ''))) console.error('voice-agent-admin handoff wiring', error.message);
    };
    if (['lead_manager', 'speed_to_lead', 'reactivation'].includes(role) && acq.length === 1) await run(admin.from('voice_agent_settings').update({ handoff_to: acq[0].agent_key }).eq('workspace_id', ws).eq('agent_key', k).is('handoff_to', null));
    if (role === 'acquisitions' && acq.length === 1) await run(admin.from('voice_agent_settings').update({ handoff_to: k }).eq('workspace_id', ws).in('role', ['lead_manager', 'speed_to_lead', 'reactivation']).is('handoff_to', null));
  };
  /** A new agent's audience: its template's, else its role's. Best effort: before migration 123 there is no column. */
  const setAudience = async (k: string, audience: string) => {
    const { error } = await admin.from('voice_agent_settings').update({ audience }).eq('workspace_id', ws).eq('agent_key', k);
    if (error && !lacks123(error)) throw error;
  };
  const readSecrets = async (): Promise<SecretsRow | null> => {
    const cols = 'workspace_id, personalize_secret, tool_secret, webhook_secret, webhook_id, tool_id';
    let { data, error } = await admin.from('voice_agent_secrets').select(`${cols}, tool_ids`).eq('workspace_id', ws).maybeSingle();
    // Before migration 123 there is no tool_ids column: read without it.
    if (error && /tool_ids/.test(error.message)) ({ data, error } = await admin.from('voice_agent_secrets').select(cols).eq('workspace_id', ws).maybeSingle());
    if (error) throw error;
    return (data as SecretsRow | null) ?? null;
  };
  /** The default agent is created on first use so a single-agent workspace works with no create_agent call. */
  const ensureAgent = async (k: string): Promise<SettingsRow | null> => {
    const r = await readAgent(k);
    if (r || k !== DEFAULT_AGENT_KEY) return r;
    const s = templateSettings('lead_manager', '');
    const { error } = await admin.from('voice_agent_settings').upsert({ workspace_id: ws, agent_key: k, role: 'lead_manager', name: '', settings: s, updated_by: userId }, { onConflict: 'workspace_id,agent_key', ignoreDuplicates: true });
    if (error) throw error;
    return await readAgent(k);
  };
  const needAgent = (k = key) => ensureAgent(k);
  /** Reads never write: the default agent that has not been created yet reads as a fresh draft. */
  const readOrVirtual = async (k = key): Promise<SettingsRow | null> => {
    const r = await readAgent(k);
    if (r || k !== DEFAULT_AGENT_KEY) return r;
    return {
      workspace_id: ws, agent_key: k, role: 'lead_manager', name: '', status: 'draft', enabled: false, settings: templateSettings('lead_manager', ''),
      live_settings: null, live_version: 0, latest_version: 0, agent_id: null, connected_at: null, updated_at: new Date().toISOString(),
    };
  };
  const notFound = () => json({ error: `no agent '${key}' in this workspace` }, 404);

  /** A new agent's settings from a template (its sections copied in to be edited) or bare defaults. */
  function templateSettings(templateId: string, name: string, role?: string): AgentSettings {
    const t = TEMPLATES[templateId];
    const base = defaultSettings();
    if (!t) {
      const r = normalizeSettings({ identity: { name, role: role || 'custom' } }, base);
      return r.settings;
    }
    const r = normalizeSettings({
      ...t.settings,
      identity: { ...(t.settings.identity as object), ...(name ? { name } : {}) },
      script: { ...(t.settings.script as object), sections: t.sections },
    }, base);
    return r.settings;
  }

  /**
   * Push settings to ElevenLabs and, only if that worked, snapshot a version
   * and mark the agent live. The webhooks read live_settings, so nothing about
   * a call changes until this succeeds.
   */
  // ---- Local presence numbers (migration 150, _shared/agent-lines.ts) ---------------------
  const NUM_COLS = 'id, workspace_id, market, state, area_code, covers, label, answer_agent_key, phone_number, status, telnyx_number_id, telnyx_order_id, el_phone_number_id, error';
  /** The workspace's AI caller numbers, biggest market first as seeded; [] before migration 150. */
  const readNumbers = async (): Promise<NumberRow[]> => {
    const { data, error } = await admin.from('voice_agent_numbers').select(NUM_COLS).eq('workspace_id', ws).order('id');
    if (error) { if (/voice_agent_numbers/.test(error.message)) return []; throw error; }
    return (data ?? []) as NumberRow[];
  };
  const saveNumber = async (id: number, patch: Partial<NumberRow>) => {
    const { error } = await admin.from('voice_agent_numbers').update({ ...patch, updated_at: new Date().toISOString() }).eq('workspace_id', ws).eq('id', id);
    if (error) throw error;
  };
  const lineError = (e: unknown) => (e instanceof TelnyxError ? `Telnyx: ${e.message}` : e instanceof ElevenError ? `ElevenLabs: ${e.message}` : e instanceof Error ? e.message : String(e)).slice(0, 400);
  /** The agent's draft and live settings with this default number on them and outbound calling on. */
  const putNumberOnAgent = async (k: string, phoneNumberId: string, outboundOn = true) => {
    const r = await readAgent(k);
    if (!r) return;
    const withNumber = (raw: unknown) => {
      const s = settingsFromRow(raw);
      return { ...s, channels: { ...s.channels, phone_number_id: phoneNumberId, outbound: outboundOn ? true : s.channels.outbound } };
    };
    const { error } = await admin.from('voice_agent_settings').update({
      settings: withNumber(r.settings), ...(r.live_settings ? { live_settings: withNumber(r.live_settings) } : {}), updated_at: new Date().toISOString(),
    }).eq('workspace_id', ws).eq('agent_key', k);
    if (error) throw error;
  };
  /**
   * Wire the pool for a published agent: buy what is still wanted, import it into ElevenLabs,
   * hand each number to the agent that answers it (this one when that agent is not live yet),
   * and give this agent a default number. Never throws: each number keeps its own outcome.
   */
  async function wireNumbers(row: SettingsRow, agentId: string): Promise<{ numbers: NumberRow[]; errors: { market: string; message: string }[] }> {
    const errors: { market: string; message: string }[] = [];
    const pool = await readNumbers();
    if (!pool.length) return { numbers: pool, errors };
    // Which ElevenLabs agent answers each number: its answering agent if published, else this one.
    const live = new Map<string, string>();
    for (const a of await readAgents()) if (a.agent_id) live.set(a.agent_key, a.agent_id);
    live.set(row.agent_key, agentId);
    const answerer = (n: NumberRow) => (n.answer_agent_key && live.get(n.answer_agent_key)) || agentId;
    let t: { apiKey: string } | null = null;
    let sip: Awaited<ReturnType<typeof ensureSipConnection>> | null = null;
    const needSip = async () => {
      if (sip && t) return { t, sip };
      const key = await telnyxSetting(admin, 'TELNYX_API_KEY');
      if (!key) throw new Error('No Telnyx API key: set TELNYX_API_KEY on the Supabase project.');
      t = { apiKey: key };
      const { data: secRow } = await admin.from('voice_agent_secrets').select('sip_connection_id, sip_username, sip_password').eq('workspace_id', ws).maybeSingle();
      const have = (secRow ?? { sip_connection_id: null, sip_username: null, sip_password: null }) as SipState;
      sip = await ensureSipConnection(t, ws, have);
      if (sip.state.sip_connection_id !== have.sip_connection_id || sip.state.sip_username !== have.sip_username || sip.state.sip_password !== have.sip_password) {
        const { error } = await admin.from('voice_agent_secrets').upsert({ workspace_id: ws, ...sip.state, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' });
        if (error) throw error;
      }
      return { t, sip };
    };
    for (const n of pool) {
      const label = cleanLabel(n.label, defaultLabel(n.market));
      try {
        if (n.el_phone_number_id) {
          // Live already: keep it on its answering agent and its label current.
          await updateEleven(cfg, n.el_phone_number_id, { agent_id: answerer(n), label });
          if (n.status !== 'active' || n.error) await saveNumber(n.id, { status: 'active', error: null });
          continue;
        }
        const { t: tc, sip: sp } = await needSip();
        const conn = sp.state.sip_connection_id!;
        let phone = n.phone_number;
        if (!phone) {
          const o = await orderNumber(tc, [n.area_code, ...(n.covers ?? [])], conn, label);
          phone = o.phone;
          await saveNumber(n.id, { phone_number: phone, telnyx_order_id: o.orderId || null, status: 'ordered', error: null, label });
        }
        // Ours, so the voice agent tells inbound from outbound, and the caller registry
        // (migration 91) registers it for reputation like the workspace's other numbers.
        const { error: clErr } = await admin.from('caller_lines').upsert({ workspace_id: ws, phone_e164: phone, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id,phone_e164', ignoreDuplicates: true });
        if (clErr) console.error('caller_lines', clErr.message);
        const tid = n.telnyx_number_id || await numberId(tc, phone).catch(() => null);
        if (tid) {
          await tagNumber(tc, tid, conn, label).catch((e) => console.error('tag number', lineError(e)));
          if (tid !== n.telnyx_number_id) await saveNumber(n.id, { telnyx_number_id: tid });
        }
        const elId = await importToEleven(cfg, phone, label, answerer(n), sp.creds);
        await saveNumber(n.id, { el_phone_number_id: elId, status: 'active', error: null, label });
      } catch (e) {
        const msg = lineError(e);
        console.error('wire number', n.market, msg);
        errors.push({ market: n.market, message: msg });
        await saveNumber(n.id, { status: n.phone_number ? 'ordered' : 'failed', error: msg }).catch(() => {});
      }
    }
    const after = await readNumbers();
    // New numbers go straight onto the 10DLC campaign and the caller registries (Free Caller
    // Registry, Number Reputation, branded calling) instead of waiting for number-guard's
    // morning run. Best effort: number-guard retries every morning anyway.
    const bought = after.filter((n) => n.phone_number && !pool.find((p) => p.id === n.id)?.el_phone_number_id && n.el_phone_number_id).map((n) => n.phone_number!);
    if (bought.length) {
      const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const post = (fn: string, body: Record<string, unknown>) => fetch(`${url}/functions/v1/${fn}`, {
        method: 'POST', headers: { Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then(async (r) => { if (!r.ok) console.error(fn, r.status, (await r.text()).slice(0, 200)); }).catch((e) => console.error(fn, String(e)));
      await Promise.all([
        post('ten-dlc-register', { action: 'attach', workspace_id: ws, phones: bought }),
        post('caller-registry', { action: 'advance', workspace_id: ws, phones: bought }),
      ]);
    }
    // A default number (used when no pool number is local to the lead) for this agent and for every other
    // published agent still without one, so each can call out: one it answers, else the first live one.
    // Only the agent being published has outbound switched on here; the others keep their own switch.
    const live1 = after.filter((n) => n.status === 'active' && n.el_phone_number_id);
    const homeFor = (k: string) => live1.find((n) => n.answer_agent_key === k) ?? live1[0];
    const home = homeFor(row.agent_key);
    if (home) await putNumberOnAgent(row.agent_key, home.el_phone_number_id!).catch((e) => errors.push({ market: home.market, message: lineError(e) }));
    if (live1.length) {
      for (const a of await readAgents()) {
        if (a.agent_key === row.agent_key || !a.agent_id) continue;
        const ch = settingsFromRow(a.live_settings ?? a.settings).channels;
        if (ch.phone_number_id) continue;
        const h = homeFor(a.agent_key)!;
        await putNumberOnAgent(a.agent_key, h.el_phone_number_id!, false).catch((e) => errors.push({ market: h.market, message: lineError(e) }));
      }
    }
    return { numbers: after, errors };
  }

  async function publishAgent(row: SettingsRow, settings: AgentSettings, note: string) {
    if (!apiKey) return json({ error: NO_KEY }, 503);
    const pl = await rateLimit(admin, `voice-agent-publish:${ws}`, 30, 3600);
    if (!pl.allowed) return tooMany(CORS, pl);
    const sec = await readSecrets();
    const state: ConnectState = {
      agent_id: row.agent_id, tool_id: sec?.tool_id ?? null, webhook_id: sec?.webhook_id ?? null,
      personalize_secret: sec?.personalize_secret || generateSecret(), tool_secret: sec?.tool_secret || generateSecret(), webhook_secret: sec?.webhook_secret ?? null,
      write_tool_ids: (sec?.tool_ids ?? {}) as ConnectState['write_tool_ids'],
    };
    const persist = async (s: ConnectState) => {
      const row: Record<string, unknown> = {
        workspace_id: ws, personalize_secret: s.personalize_secret, tool_secret: s.tool_secret, webhook_secret: s.webhook_secret,
        webhook_id: s.webhook_id, tool_id: s.tool_id, tool_ids: s.write_tool_ids ?? {}, updated_at: new Date().toISOString(),
      };
      let { error } = await admin.from('voice_agent_secrets').upsert(row, { onConflict: 'workspace_id' });
      if (error && /tool_ids/.test(error.message)) {
        // Before migration 123: the write tools are still created, their ids are just not kept.
        const { tool_ids: _t, ...older } = row;
        ({ error } = await admin.from('voice_agent_secrets').upsert(older, { onConflict: 'workspace_id' }));
      }
      if (error) throw error;
    };
    // The secrets are stored before ElevenLabs is told them, so a webhook that fires the
    // moment the agent exists already finds its row.
    await persist(state);
    const r = await runConnect(cfg, state, settings, TEMPLATES, urls);
    await persist(r.state);

    // What to do by hand: the phone number, settings ElevenLabs cannot express, and any step that failed.
    // Header secrets are never listed: a hand-made secret goes in the matching ELEVENLABS_*_SECRET project secret.
    const manual: { step: string; value_to_paste: string; where: string }[] = [];
    if (r.connected && r.state.agent_id) manual.push({ step: 'phone_number', value_to_paste: r.state.agent_id, where: 'ElevenLabs, Phone numbers: add the Telnyx SIP trunk number and assign it to this agent (docs/voice-agent.md, Telnyx SIP connection)' });
    for (const u of r.unapplied) manual.push({ step: `setting:${u.setting}`, value_to_paste: u.value, where: u.reason });
    if (!r.checks.post_call_webhook) manual.push({ step: 'post_call_webhook', value_to_paste: urls.post_call, where: 'ElevenLabs, Agents, Settings: create an HMAC webhook at this URL with transcript events and retries, then set its signing secret as the ELEVENLABS_WEBHOOK_SECRET project secret' });
    for (const e of r.errors.filter((x) => x.step.startsWith('tool:'))) manual.push({ step: e.step.replace(':', '_'), value_to_paste: urls.tool.replace(/lead-context$/, e.step.slice(5).replace(/_/g, '-')), where: `ElevenLabs refused the ${e.step.slice(5)} tool (${e.message}). Publish again, or add it by hand as a webhook tool with header X-Voice-Agent-Secret` });
    if (!r.checks.tool && settings.tools.lead_context.enabled) manual.push({ step: 'lead_context_tool', value_to_paste: urls.tool, where: 'ElevenLabs, Tools: webhook tool lead_context, POST, header X-Voice-Agent-Secret set to a secret you also set as ELEVENLABS_TOOL_SECRET' });
    if (!r.checks.personalize_webhook) manual.push({ step: 'initiation_webhook', value_to_paste: urls.personalize, where: 'ElevenLabs, Agents, Settings: initiation webhook URL with header X-Voice-Agent-Secret set to a secret you also set as ELEVENLABS_PERSONALIZE_SECRET; enable it on the agent Security tab with the First message override' });
    const errors = r.errors.map((x) => ({ step: x.step, message: x.message }));

    if (!r.connected) {
      // The agent id may have been created before a later step failed: keep it so a retry updates in place.
      if (r.state.agent_id && r.state.agent_id !== row.agent_id) await admin.from('voice_agent_settings').update({ agent_id: r.state.agent_id, updated_at: new Date().toISOString() }).eq('workspace_id', ws).eq('agent_key', row.agent_key);
      return json({ error: `Could not set up the ElevenLabs agent: ${errors.find((x) => x.step === 'agent')?.message ?? 'unknown error'}`, checks: r.checks, manual, errors }, 502);
    }

    const prompt = assemblePrompt(settings, TEMPLATES);
    const now = new Date().toISOString();
    let version = row.latest_version + 1;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await admin.from('voice_agent_versions').insert({ workspace_id: ws, agent_key: row.agent_key, version, settings, prompt, note: note.slice(0, 200), created_by: userId });
      if (!error) break;
      if (attempt === 2 || !/duplicate|23505/i.test(error.message + (error.code ?? ''))) throw error;
      version++;
    }
    const { error: upErr } = await admin.from('voice_agent_settings').update({
      settings, live_settings: settings, live_version: version, latest_version: version, status: 'live', enabled: enabledAfterPublish(row),
      agent_id: r.state.agent_id, connected_at: now, updated_at: now, updated_by: userId,
    }).eq('workspace_id', ws).eq('agent_key', row.agent_key);
    if (upErr) throw upErr;
    // The local presence numbers: bought, wired to ElevenLabs and assigned on publish.
    const wired = r.state.agent_id ? await wireNumbers({ ...row, name: settings.identity.name || row.name }, r.state.agent_id) : { numbers: [], errors: [] };
    if (wired.numbers.some((n) => n.status === 'active')) {
      const i = manual.findIndex((m) => m.step === 'phone_number');
      if (i >= 0) manual.splice(i, 1);
    }
    for (const e of wired.errors) errors.push({ step: `number:${e.market}`, message: e.message });
    return json({
      ok: true, version, live_version: version, agent_key: row.agent_key, agent_id: r.state.agent_id, checks: r.checks, manual, errors, tts_model_used: r.tts_model_used,
      numbers: wired.numbers,
    });
  }

  try {
    switch (action) {
      // ---- Agents -------------------------------------------------------------
      case 'numbers': {
        return json({ ok: true, numbers: await readNumbers() });
      }

      case 'add_number': {
        // A new market: bought and wired on the next publish (or Buy and wire now).
        const area = cleanAreaCode(body.area_code);
        if (!area) return json({ error: 'area_code must be a 3-digit US area code' }, 422);
        const market = cleanLabel(body.market, `Area ${area}`).slice(0, 40);
        const st = String(body.state ?? '').trim().toUpperCase();
        const { error } = await admin.from('voice_agent_numbers').insert({
          workspace_id: ws, market, area_code: area, covers: cleanCovers(area, body.covers), state: /^[A-Z]{2}$/.test(st) ? st : null,
          label: cleanLabel(body.label, defaultLabel(market)), answer_agent_key: typeof body.answer_agent_key === 'string' && body.answer_agent_key ? body.answer_agent_key : null,
        });
        if (error) {
          if (/voice_agent_numbers/.test(error.message) && !/duplicate|unique/i.test(error.message)) return json({ error: 'Local numbers need migration 150 (voice_agent_numbers).' }, 503);
          if (/duplicate|unique/i.test(error.message + (error.code ?? ''))) return json({ error: `There is already a ${market} number.` }, 409);
          throw error;
        }
        return json({ ok: true, numbers: await readNumbers() });
      }

      case 'set_number': {
        // Rename a market's number (here, in ElevenLabs and in Telnyx), its covered area codes, or who answers it.
        const id = Number(body.id);
        const cur = (await readNumbers()).find((n) => n.id === id);
        if (!cur) return json({ error: 'no such number' }, 404);
        const label = body.label === undefined ? cur.label : cleanLabel(body.label, defaultLabel(cur.market));
        const patch: Partial<NumberRow> = { label };
        if (body.covers !== undefined) patch.covers = cleanCovers(cur.area_code, body.covers);
        if (body.answer_agent_key !== undefined) patch.answer_agent_key = typeof body.answer_agent_key === 'string' && body.answer_agent_key ? body.answer_agent_key : null;
        if (body.area_code !== undefined && !cur.phone_number) {
          const area = cleanAreaCode(body.area_code);
          if (!area) return json({ error: 'area_code must be a 3-digit US area code' }, 422);
          patch.area_code = area;
          patch.covers = cleanCovers(area, patch.covers ?? cur.covers);
        }
        await saveNumber(id, patch);
        const warnings: string[] = [];
        const answer = patch.answer_agent_key !== undefined && patch.answer_agent_key ? (await readAgent(patch.answer_agent_key))?.agent_id ?? null : null;
        if (cur.el_phone_number_id && apiKey && (label !== cur.label || answer)) {
          await updateEleven(cfg, cur.el_phone_number_id, { label, ...(answer ? { agent_id: answer } : {}) }).catch((e) => warnings.push(lineError(e)));
        }
        if (cur.telnyx_number_id && label !== cur.label) {
          const k = await telnyxSetting(admin, 'TELNYX_API_KEY');
          if (k) await tagNumber({ apiKey: k }, cur.telnyx_number_id, null, label).catch((e) => warnings.push(lineError(e)));
        }
        return json({ ok: true, numbers: await readNumbers(), warnings });
      }

      case 'wire_numbers': {
        // Buy and wire the pool now, without publishing again: needs this agent live.
        const row = await readAgent(key);
        if (!row) return notFound();
        if (!row.agent_id) return json({ error: 'Publish an agent first: the numbers are assigned to its ElevenLabs agent.' }, 409);
        if (!apiKey) return json({ error: NO_KEY }, 503);
        const w = await wireNumbers(row, row.agent_id);
        return json({ ok: !w.errors.length, numbers: w.numbers, errors: w.errors });
      }

      case 'list_agents': {
        const rows = await readAgents();
        return json({ ok: true, agents: rows.map(summary), max_agents: MAX_AGENTS });
      }

      case 'templates': {
        return json({
          ok: true,
          templates: Object.values(TEMPLATES).map((t) => ({ id: t.id, name: t.name, role: t.role, audience: t.audience, description: t.description, open_items: t.open_items })),
          tools: TOOL_KEYS.map((k) => ({ key: k, label: TOOL_LABELS[k], available: TOOL_AVAILABLE[k] })),
        });
      }

      case 'create_agent': {
        const rows = await readAgents();
        if (rows.length >= MAX_AGENTS) return json({ error: `A workspace can have up to ${MAX_AGENTS} agents.` }, 409);
        const templateId = typeof body.template === 'string' ? body.template : '';
        if (templateId && !TEMPLATES[templateId]) return json({ error: `template must be one of ${Object.keys(TEMPLATES).join(', ')}` }, 422);
        const role = templateId ? TEMPLATES[templateId].role : cleanText(body.role, 40) ? slugify(cleanText(body.role, 40)) : 'custom';
        const name = cleanText(body.name, 40);
        const want = typeof body.agent_key === 'string' && body.agent_key ? body.agent_key : slugify(name) || templateId || role;
        if (!AGENT_KEY_RE.test(want)) return json({ error: 'agent_key must be a slug: lowercase letters, digits and underscores, starting with a letter' }, 422);
        const taken = new Set(rows.map((r) => r.agent_key));
        if (typeof body.agent_key === 'string' && body.agent_key && taken.has(want)) return json({ error: `agent_key '${want}' is already used` }, 409);
        let k = want; let n = 2;
        while (taken.has(k)) k = `${want.slice(0, 36)}_${n++}`;
        const settings = templateSettings(templateId, name, role);
        const { error } = await admin.from('voice_agent_settings').insert({ workspace_id: ws, agent_key: k, role, name, settings, updated_by: userId });
        if (error) throw error;
        await setAudience(k, templateId ? TEMPLATES[templateId].audience : audienceForRole(role));
        await wireHandoff(k, role);
        const row = await readAgent(k);
        return json({ ok: true, agent_key: k, agent: row ? summary(row) : null, settings });
      }

      case 'duplicate_agent': {
        const src = await readAgent(key);
        if (!src) return notFound();
        const rows = await readAgents();
        if (rows.length >= MAX_AGENTS) return json({ error: `A workspace can have up to ${MAX_AGENTS} agents.` }, 409);
        const taken = new Set(rows.map((r) => r.agent_key));
        const name = cleanText(body.name, 40) || `${src.name || key} copy`.slice(0, 40);
        const want = typeof body.new_key === 'string' && body.new_key ? body.new_key : slugify(name) || `${key}_copy`;
        if (!AGENT_KEY_RE.test(want)) return json({ error: 'new_key must be a slug: lowercase letters, digits and underscores, starting with a letter' }, 422);
        if (typeof body.new_key === 'string' && body.new_key && taken.has(want)) return json({ error: `agent_key '${want}' is already used` }, 409);
        let k = want; let n = 2;
        while (taken.has(k)) k = `${want.slice(0, 36)}_${n++}`;
        // The copy starts from the draft and gets its own ElevenLabs agent on its first publish.
        const settings = settingsFromRow(src.settings);
        settings.identity.name = name;
        const { error } = await admin.from('voice_agent_settings').insert({ workspace_id: ws, agent_key: k, role: src.role, name, settings, updated_by: userId });
        if (error) throw error;
        await setAudience(k, src.audience ?? audienceForRole(src.role));
        const row = await readAgent(k);
        return json({ ok: true, agent_key: k, agent: row ? summary(row) : null, settings });
      }

      case 'delete_agent': {
        const row = await readAgent(key);
        if (!row) return notFound();
        if (body.confirm !== true) return json({ error: CONFIRM_MSG, needs_confirm: true, has_live_agent: !!row.agent_id }, 409);
        let remote = false;
        if (row.agent_id) {
          // Off ElevenLabs first: if that fails the row stays, so the agent is never left running with no record of it.
          if (!apiKey) return json({ error: NO_KEY }, 503);
          await deleteRemoteAgent(cfg, row.agent_id);
          remote = true;
        }
        const { error } = await admin.from('voice_agent_settings').delete().eq('workspace_id', ws).eq('agent_key', key);
        if (error) throw error;
        return json({ ok: true, deleted: key, remote_deleted: remote });
      }

      case 'set_enabled': {
        const p = parseSetEnabled(body);
        if ('error' in p) return json({ error: p.error }, 422);
        const { data, error } = await admin.from('voice_agent_settings')
          .update({ enabled: p.enabled, updated_at: new Date().toISOString(), updated_by: userId })
          .eq('workspace_id', ws).eq('agent_key', key).select('agent_key, enabled').maybeSingle();
        if (error) throw error;
        if (!data) return notFound();
        return json({ ok: true, agent_key: (data as Any).agent_key, enabled: (data as Any).enabled });
      }

      // ---- Editing ------------------------------------------------------------
      case 'get': {
        const row = await readOrVirtual();
        if (!row) return notFound();
        const sec = await readSecrets();
        const draft = settingsFromRow(row.settings);
        const checks: Checks = {
          api_key: !!apiKey,
          agent: !!row.agent_id,
          personalize_webhook: !!row.agent_id && !!sec?.personalize_secret,
          tool: !!row.agent_id && !!sec?.tool_id && !!sec?.tool_secret,
          post_call_webhook: !!row.agent_id && !!sec?.webhook_id && !!sec?.webhook_secret,
          write_tools: !!row.agent_id && builtWriteTools().every((k) => !!sec?.tool_ids?.[k]),
        };
        let live: string | undefined;
        if (body.verify === true && row.agent_id && apiKey) {
          try {
            const agent = await elJson(cfg, 'GET', `/v1/convai/agents/${encodeURIComponent(row.agent_id)}`);
            Object.assign(checks, checksFromAgent(agent, { personalizeUrl: urls.personalize, toolId: sec?.tool_id ?? null, webhookId: sec?.webhook_id ?? null }));
            const carried = (agent as Any)?.conversation_config?.agent?.prompt?.tool_ids;
            checks.write_tools = builtWriteTools().filter((k) => draft.tools[k]?.enabled).every((k) => !!sec?.tool_ids?.[k] && Array.isArray(carried) && carried.includes(sec.tool_ids[k]));
            checks.agent = true;
          } catch (e) {
            checks.agent = false;
            live = e instanceof ElevenError ? (e.status === 404 ? 'ElevenLabs no longer has this agent: publish again.' : `ElevenLabs: ${e.message}`) : 'Could not reach ElevenLabs.';
          }
        }
        return json({
          ok: true, ...summary(row), settings: draft, live_settings: row.live_settings ? settingsFromRow(row.live_settings) : null,
          checks, webhook_urls: urls, can_edit: isAdmin, ...(live ? { live_check: live } : {}),
        });
      }

      case 'save_draft':
      case 'save_settings': {
        const row = await needAgent();
        if (!row) return notFound();
        const { settings, errors, warnings } = normalizeSettings(body.settings, settingsFromRow(row.settings));
        if (errors.length) return json({ error: errors.join('; '), errors }, 422);
        const now = new Date().toISOString();
        const { error } = await admin.from('voice_agent_settings').update({
          settings, name: settings.identity.name || row.name, role: settings.identity.role || row.role, updated_at: now, updated_by: userId,
        }).eq('workspace_id', ws).eq('agent_key', row.agent_key);
        if (error) throw error;
        const unpublished = !row.live_settings || JSON.stringify(settingsFromRow(row.live_settings)) !== JSON.stringify(settings);
        // save_settings used to push to ElevenLabs. It now only saves; { publish: true } keeps the old one-call flow.
        if (action === 'save_settings' && body.publish === true) return await publishAgent({ ...row, name: settings.identity.name || row.name }, settings, cleanText(body.note, 200) || 'save_settings');
        return json({ ok: true, settings, warnings, has_unpublished_changes: unpublished, ...(action === 'save_settings' ? { deprecated: 'save_settings only saves a draft now: use save_draft, then publish' } : {}) });
      }

      case 'preview_prompt': {
        const row = await readOrVirtual();
        if (!row) return notFound();
        let settings = settingsFromRow(row.settings);
        if (body.settings !== undefined) {
          const r = normalizeSettings(body.settings, settings);
          if (r.errors.length) return json({ error: r.errors.join('; '), errors: r.errors }, 422);
          settings = r.settings;
        }
        const prompt = assemblePrompt(settings, TEMPLATES);
        const built = agentBody(settings, TEMPLATES, { toolId: null, webhookId: null, personalizeUrl: urls.personalize, personalizeSecret: '' });
        return json({
          ok: true, prompt, tokens: estimateTokens(prompt), warnings: promptWarnings(settings, TEMPLATES),
          not_applied: built.unapplied,
        });
      }

      // ---- Publishing ---------------------------------------------------------
      case 'publish':
      case 'connect': {
        const row = await needAgent();
        if (!row) return notFound();
        return await publishAgent(row, settingsFromRow(row.settings), cleanText(body.note, 200) || (action === 'connect' ? 'connect' : ''));
      }

      case 'versions': {
        const row = await readOrVirtual();
        if (!row) return notFound();
        const { data, error } = await admin.from('voice_agent_versions').select('version, note, created_by, created_at, prompt')
          .eq('workspace_id', ws).eq('agent_key', key).order('version', { ascending: false }).limit(50);
        if (error) throw error;
        return json({
          ok: true, agent_key: key, live_version: row.live_version,
          versions: ((data ?? []) as Any[]).map((v) => ({ version: v.version, note: v.note, created_by: v.created_by, created_at: v.created_at, is_live: v.version === row.live_version, prompt_tokens: estimateTokens(String(v.prompt ?? '')) })),
        });
      }

      case 'diff': {
        const row = await readOrVirtual();
        if (!row) return notFound();
        const load = async (ref: unknown): Promise<{ label: string; settings: AgentSettings; prompt: string } | null> => {
          if (ref === 'draft') { const s = settingsFromRow(row.settings); return { label: 'draft', settings: s, prompt: assemblePrompt(s, TEMPLATES) }; }
          const v = ref === 'live' ? row.live_version : Number(ref);
          if (!Number.isInteger(v) || v <= 0) return null;
          const { data } = await admin.from('voice_agent_versions').select('settings, prompt').eq('workspace_id', ws).eq('agent_key', key).eq('version', v).maybeSingle();
          return data ? { label: `v${v}`, settings: settingsFromRow((data as Any).settings), prompt: String((data as Any).prompt ?? '') } : null;
        };
        const [a, b] = await Promise.all([load(body.from), load(body.to ?? 'draft')]);
        if (!a || !b) return json({ error: "from and to must be version numbers, 'live' or 'draft' that exist" }, 404);
        const lines = diffLines(a.prompt, b.prompt);
        return json({
          ok: true, from: a.label, to: b.label, changes: diffSettings(a.settings, b.settings),
          prompt: { added: lines.added, removed: lines.removed, tokens_from: estimateTokens(a.prompt), tokens_to: estimateTokens(b.prompt) },
        });
      }

      case 'rollback': {
        const row = await needAgent();
        if (!row) return notFound();
        const v = Number(body.version);
        if (!Number.isInteger(v) || v <= 0) return json({ error: 'version is required' }, 422);
        const { data } = await admin.from('voice_agent_versions').select('settings').eq('workspace_id', ws).eq('agent_key', key).eq('version', v).maybeSingle();
        if (!data) return json({ error: `version ${v} does not exist` }, 404);
        // History stays append-only: a rollback publishes the old settings as a new version.
        return await publishAgent(row, settingsFromRow((data as Any).settings), cleanText(body.note, 200) || `Rollback to v${v}`);
      }

      // ---- Testing ------------------------------------------------------------
      case 'voices': {
        if (!apiKey) return json({ error: NO_KEY }, 503);
        const search = typeof body.search === 'string' ? cleanText(body.search, 80) : undefined;
        return json({ ok: true, voices: await listVoices(cfg, search || undefined) });
      }

      case 'preview': {
        if (!apiKey) return json({ error: NO_KEY }, 503);
        const voice = typeof body.voice_id === 'string' ? body.voice_id.trim() : '';
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(voice)) return json({ error: 'voice_id is not a valid voice id' }, 422);
        const text = cleanText(body.text, PREVIEW_MAX_CHARS);
        if (!text) return json({ error: 'text is required' }, 422);
        // The agent's draft model and tuning; a preview of unedited values may pass any of the
        // voice keys below and they go through the same validation as a save.
        const row = await readAgent(key);
        const voiceIn: Record<string, unknown> = {};
        for (const k of ['tts_model', 'stability', 'similarity', 'speed'] as const) if (body[k] !== undefined) voiceIn[k] = body[k];
        const { settings: eff, errors } = normalizeSettings({ voice: voiceIn }, settingsFromRow(row?.settings ?? {}));
        if (errors.length) return json({ error: errors.join('; ') }, 422);
        const pl = await rateLimit(admin, `voice-preview:${ws}`, 20, 3600);
        if (!pl.allowed) return tooMany(CORS, pl);
        return json({ ok: true, ...(await previewSpeech(cfg, voice, text, eff.voice)) });
      }

      case 'test_session': {
        if (!apiKey) return json({ error: NO_KEY }, 503);
        const row = await needAgent();
        if (!row) return notFound();
        if (!row.agent_id) return json({ error: 'Publish the agent first.' }, 409);
        // What ElevenLabs runs is the published version, so that is what the test hears.
        const live = settingsFromRow(row.live_settings ?? row.settings);
        const wsName = (await admin.from('workspaces').select('name').eq('id', ws).maybeSingle()).data?.name;
        const base = pickPersona({ agent_name: live.identity.name, company: live.identity.company }, { name: Deno.env.get('VOICE_AGENT_NAME') || null, company: Deno.env.get('VOICE_AGENT_COMPANY') || null }, wsName);
        const rn = live.rules.compliance.recording_notice;
        const persona = { ...base, introduceAs: live.identity.introduce_as, recordingNotice: rn.enabled ? rn.text : null, casual: live.personality.formality <= 2 };
        let init;
        let resolution: string;
        if (body.sample === true && body.record_kind === 'buyer') {
          // A buyer call carries no offer range or seller facts, the same as initiationFor gives a real buyer.
          const leg: CallLeg = { direction: 'inbound', ours: '', theirs: '' };
          init = buildInitiation(resolveCaller([SAMPLE_BUYER]), leg, SAMPLE_BUYER_MEMORY, { ...persona, repName: SAMPLE_REP }, { ...NO_EXTRAS, rep_phone: '+15125550100' });
          resolution = 'one';
        } else if (body.sample === true) {
          const leg: CallLeg = { direction: 'inbound', ours: '', theirs: '' };
          // "Me": the sample seller, under the tester's own first name.
          const meta = (who.user.user_metadata ?? {}) as Any;
          const mine = body.record_kind === 'me' ? String(meta.full_name || meta.name || '').trim().split(/\s+/)[0].slice(0, 40) : '';
          const cand = mine ? { ...SAMPLE_CANDIDATE, name: mine } : SAMPLE_CANDIDATE;
          const mem = mine ? { brief: SAMPLE_MEMORY.brief.replaceAll('Jamie', mine), facts: { ...SAMPLE_MEMORY.facts, first_name: mine, last_contact_summary: SAMPLE_MEMORY.facts.last_contact_summary?.replaceAll('Jamie', mine) ?? null } } : SAMPLE_MEMORY;
          init = buildInitiation(resolveCaller([cand]), leg, mem, { ...persona, repName: SAMPLE_REP }, {
            rep_phone: '+15125550100', lead_source: 'form', property_facts: '3 bed, 2 bath', mortgage_payoff_estimate: '$120,000',
            offer_low: live.offer_authority.mode === 'none' ? '' : '$150,000', offer_high: live.offer_authority.mode === 'none' ? '' : '$170,000', seller_asking_price: '$210,000',
            call_goal: '',
          });
          resolution = 'one';
        } else {
          const kind = body.record_kind === 'buyer' ? 'buyer' : body.record_kind === 'seller' ? 'seller' : null;
          const id = Number(body.record_id);
          if (!kind || !Number.isInteger(id)) return json({ error: 'record_kind and record_id are required, or send sample: true' }, 422);
          // Checked as the caller, so a rep who cannot see the record cannot hear its memory.
          const { data: visible } = await asCaller.from(kind === 'seller' ? 'sellers' : 'buyers').select('id, phone, phone_key').eq('id', id).eq('workspace_id', ws).maybeSingle();
          if (!visible) return json({ error: 'record not found' }, 404);
          let pk = phoneKey((visible as Any).phone_key ?? (visible as Any).phone);
          if (!pk && kind === 'buyer') {
            const { data: bp } = await admin.from('buyer_phones').select('phone, phone_key').eq('workspace_id', ws).eq('buyer_id', id).order('position').limit(5);
            for (const p of (bp ?? []) as Any[]) { pk = phoneKey(p.phone_key ?? p.phone); if (pk) break; }
          }
          if (!pk) return json({ error: 'This record has no phone number, so there is no caller to test as.' }, 422);
          const all = await loadCandidates(admin, ws, pk);
          const chosen = all.find((c) => c.kind === kind && c.id === id);
          if (!chosen) return json({ error: 'This record could not be matched on its phone number.' }, 422);
          let res: Resolution = resolveCaller(all);
          resolution = res.status;
          // A blocked number stays blocked (that is the point of the test). Otherwise the rep
          // chose who is calling, even when a shared number would leave it ambiguous.
          if (res.status !== 'blocked') res = { status: 'one', match: chosen };
          init = await initiationFor(admin, ws, res, { direction: 'inbound', ours: '', theirs: pk }, persona, live);
        }
        if (typeof body.phone === 'string' && body.phone.trim()) {
          // A real phone test: the agent rings this number with the same brief. Nothing is read from or written to the CRM.
          const to = phoneE164(body.phone);
          if (!to) return json({ error: 'Type a US phone number to call, like (210) 555-0100.' }, 422);
          const pl = await rateLimit(admin, `voice-agent-phone-test:${ws}`, 6, 3600);
          if (!pl.allowed) return tooMany(CORS, pl);
          const { data: pool } = await admin.from('voice_agent_numbers').select('market, state, area_code, covers, status, el_phone_number_id, phone_number').eq('workspace_id', ws).eq('status', 'active');
          const local = pickLocalNumber((pool ?? []) as Parameters<typeof pickLocalNumber>[0], to);
          const fromId = local?.el_phone_number_id ?? live.channels.phone_number_id;
          if (!fromId) return json({ error: 'This agent has no phone number to call from yet. Add one on the Handling tab, then publish.' }, 409);
          const dv = init.dynamic_variables as Record<string, unknown>;
          const first_message = dv.first_name ? `Hi, is this ${dv.first_name}?` : 'Hi, who am I speaking with?';
          try {
            const r = await elJson<{ success?: boolean; message?: string; conversation_id?: string | null }>(cfg, 'POST', '/v1/convai/sip-trunk/outbound-call', {
              agent_id: row.agent_id, agent_phone_number_id: fromId, to_number: to,
              conversation_initiation_client_data: { dynamic_variables: dv, conversation_config_override: { agent: { first_message } } },
            });
            if (r.success === false) return json({ error: `ElevenLabs: ${String(r.message ?? 'refused').slice(0, 200)}` }, 502);
            console.log('voice-agent phone test', { ws, agent: row.agent_key, by: userId });
            return json({
              ok: true, phone_call: true, to, conversation_id: r.conversation_id ?? null, agent_key: row.agent_key, live_version: row.live_version,
              dynamic_variables: dv, first_message, resolution,
              note: `Calling ${to} now${local?.market ? ` from the ${local.market} number` : ''}. Pick up and play the caller.`,
            });
          } catch (e) {
            return elFail(e) ?? json({ error: 'Could not reach ElevenLabs.' }, 502);
          }
        }
        const signed_url = await getSignedUrl(cfg, row.agent_id);
        return json({
          ok: true, signed_url, agent_key: row.agent_key, agent_id: row.agent_id, live_version: row.live_version, dynamic_variables: init.dynamic_variables,
          first_message: init.conversation_config_override.agent.first_message, resolution,
        });
      }

      case 'scenarios': {
        return json({ ok: true, scenarios: SCENARIOS });
      }

      case 'score_call': {
        const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
        if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY is not set on the Supabase project.' }, 503);
        const scenario = scenarioById(String(body.scenario_id ?? ''));
        if (!scenario) return json({ error: `scenario_id must be one of ${SCENARIOS.map((s) => s.id).join(', ')}` }, 422);
        const conv = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
        if (!/^[A-Za-z0-9_-]{6,80}$/.test(conv)) return json({ error: 'conversation_id is required' }, 422);
        // As the caller: what a member cannot read in the call log they cannot grade either.
        const { data: call } = await asCaller.from('communications').select('transcript').eq('workspace_id', ws).eq('source', 'elevenlabs').eq('source_id', 'el:' + conv).maybeSingle();
        const transcript = String((call as Any)?.transcript ?? '').trim();
        if (!call) return json({ error: 'No stored call with that conversation_id. It appears here after ElevenLabs sends the post-call webhook.' }, 404);
        if (!transcript) return json({ error: 'That call has no transcript to grade.' }, 422);
        const sl = await rateLimit(admin, `voice-agent-score:${ws}`, 30, 3600);
        if (!sl.allowed) return tooMany(CORS, sl);
        const ws_ = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
        const client = new Anthropic({ apiKey: anthropicKey, ...(ws_ ? { defaultHeaders: { 'anthropic-workspace-id': ws_ } } : {}) });
        // Sonnet 5.5: forced tool_choice 400s, so the tool is asked for in the system prompt and choice stays auto.
        const res = await client.messages.create({
          model: CLAUDE_MODEL, thinking: CLAUDE_THINKING, max_tokens: 1800,
          system: toolRule('grade_call') + SCORING_SYSTEM + UNTRUSTED_RULE,
          tools: [SCORING_TOOL as unknown as Anthropic.Tool],
          tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: scoringUserMessage(scenario, fence('transcript', transcript, 24_000)) }],
        });
        const use = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (!use) return json({ error: 'The grader did not return a result. Try again.' }, 502);
        return json({ ok: true, conversation_id: conv, model: CLAUDE_MODEL, ...parseGrades(use.input, scenario, transcript) });
      }

      // ---- Calls --------------------------------------------------------------
      case 'calls': {
        // As the caller, so what a member sees here is what RLS already lets them read.
        const sel = 'id, occurred_at, direction, duration_s, status, from_phone, to_phone, seller_id, buyer_id, summary, transcript, source_id';
        let q = asCaller.from('communications').select(sel).eq('workspace_id', ws).eq('source', 'elevenlabs').order('occurred_at', { ascending: false }).limit(25);
        if (typeof body.agent_key === 'string' && body.agent_key) {
          const { data: ids, error: e1 } = await asCaller.from('voice_agent_calls').select('conversation_id').eq('workspace_id', ws).eq('agent_key', key).order('occurred_at', { ascending: false }).limit(25);
          if (e1) throw e1;
          const list = ((ids ?? []) as Any[]).map((r) => 'el:' + r.conversation_id);
          if (!list.length) return json({ ok: true, calls: [] });
          q = q.in('source_id', list);
        }
        const { data, error } = await q;
        if (error) throw error;
        return json({ ok: true, calls: ((data ?? []) as Any[]).map(callOut) });
      }

      case 'stats': {
        const days = Math.min(90, Math.max(1, Math.round(Number(body.days) || 30)));
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        let q = asCaller.from('voice_agent_calls').select('agent_key, duration_s, booked, transferred, dnc_requested, not_interested').eq('workspace_id', ws).gte('occurred_at', since).limit(10000);
        if (typeof body.agent_key === 'string' && body.agent_key) q = q.eq('agent_key', key);
        const { data, error } = await q;
        if (error) throw error;
        const stats = aggregateStats((data ?? []) as Any[]);
        // Agents with no calls yet still show, with zeros.
        const known = typeof body.agent_key === 'string' && body.agent_key ? [key] : (await readAgents()).map((r) => r.agent_key);
        for (const k of known) if (!stats.some((s) => s.agent_key === k)) stats.push({ agent_key: k, calls: 0, avg_duration_s: 0, booked: 0, transferred: 0, dnc_requests: 0, not_interested: 0 });
        stats.sort((a, b) => a.agent_key.localeCompare(b.agent_key));
        const totals = stats.reduce((t, s) => ({
          calls: t.calls + s.calls, booked: t.booked + s.booked, transferred: t.transferred + s.transferred,
          dnc_requests: t.dnc_requests + s.dnc_requests, not_interested: t.not_interested + s.not_interested,
        }), { calls: 0, booked: 0, transferred: 0, dnc_requests: 0, not_interested: 0 });
        return json({
          ok: true, days, agents: stats, totals,
          basis: {
            booked_and_transferred: 'exact: counted from the agent booking a time with book_appointment (a lookup of open times is not a booking) or calling the transfer tool.',
            dnc_requests_and_not_interested: 'exact when the agent called mark_do_not_contact or saved an outcome with save_qualification; otherwise the caller\'s own words matched against keywords, which is a heuristic.',
          },
        });
      }
    }
    return json({ error: 'unreachable' }, 500);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited, try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'voice-agent-admin anthropic', e, 502);
    if (missingRelation(String(e instanceof Error ? e.message : (e as Any)?.message ?? e))) return json({ error: NOT_MIGRATED }, 503);
    const el = elFail(e);
    if (el) return el;
    return serverError(CORS, `voice-agent-admin ${action}`, e);
  }
});
