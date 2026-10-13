/**
 * POST /ai-agent: AI agents that work a record (migration 123).
 *
 * A rep switches an agent ON for a seller or a buyer (or for a selection of
 * buyers), tells it what to do in a chat or lets it decide from the record's
 * history, and the agent texts, emails and calls on a plan until it is
 * switched OFF, the plan is done, the person asks to stop, or it hands the
 * person to a rep. Every action is a row in ai_agent_actions and a line on
 * the record's activity timeline (kind ai_agent).
 *
 * Deployed with verify_jwt (the default). Body { action, workspace_id, ... };
 * every answer is { ok: true, ... } or { error }.
 *
 * Members (any role; the read-only preview is refused client-side):
 *   agents       the workspace's agents with their faces, audiences and load
 *   status       { record_kind, record_id }: the record's enrollment, chat,
 *                plan, recent actions, and whether it may go on an agent
 *   log          { record_kind, record_id, limit? }: the record's AI actions
 *   report       { days? }: per-agent counts for the AI agents report
 *   chat         { record_kind, record_id, agent_key?, message?, mode?, channels? }:
 *                talk to the agent; it answers and drafts or updates the plan.
 *                Nothing goes out until it is switched on.
 *   start        same body: switch ON (drafts a plan first when there is none)
 *   stop         { record_kind, record_id }: switch OFF
 *   bulk_start   { buyer_ids, agent_key, mode?, channels?, message? }: up to 200
 *                buyers; VIPs, funds, do-not-contact and unreachable buyers are
 *                skipped with the reason. Plans are drafted on the first tick.
 *   bulk_stop    { buyer_ids?, seller_ids? }
 * Owners and admins:
 *   generate_avatar { agent_key, prompt?, style? }: an AI picture, a
 *                realistic headshot (default) or an illustration. With the
 *                GEMENI_API_KEY secret Gemini makes it (stored in the public
 *                avatars bucket); without it Claude draws an SVG portrait.
 *   set_audience { agent_key, audience: sellers | buyers | both }
 *   autopilot    the workspace's AI Autopilot (migration 146): settings, the
 *                lead sources seen, the agents and stages to pick from, and
 *                today's numbers
 * Owners and admins (AI Autopilot):
 *   set_autopilot    { settings }: speed to lead, follow-up, reactivation
 *   run_reactivation runs tonight's reactivation for this workspace now
 * Service role (pg_cron, ai_agent_kick every 2 minutes):
 *   tick         works the due enrollments: reads what happened, decides the
 *                next touch with Claude and sends it (text through Talkr as
 *                the rep, email from the rep's Gmail through the mailbox
 *                guard, a call through the agent's ElevenLabs number).
 *   speed        AI Autopilot speed to lead: claims new leads the sellers
 *                insert trigger queued and makes the first touch in seconds
 *   reactivate   AI Autopilot's nightly reactivation (clozr-ai-autopilot-nightly)
 *
 * Needs ANTHROPIC_API_KEY. Texts need TALKR_PARTNER_JWT_SECRET (as the dispo
 * campaigns do), email a connected Gmail with sending on, calls ELEVENLABS_API_KEY
 * and a published agent with an ElevenLabs phone number id.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { corsFor, fence, jsonWith, rateLimit, serverError, tooMany, UNTRUSTED_RULE } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';
import { gatherHistory } from '../_shared/lead-memory.ts';
import { historyText } from '../../../lib/lead-memory.ts';
import { isDoNotEngage } from '../../../lib/blacklist.ts';
import { textRecipient } from '../_shared/docs-flow.ts';
import { phoneE164 } from '../_shared/docs-people.ts';
import { withOptOut } from '../_shared/sms-compliance.ts';
import { slopFindings, slopReport } from '../_shared/no-ai-slop.ts';
import { SCOPE, accessFor, has, messageIdOf, sendMail, textToHtml, type Account } from '../_shared/google.ts';
import { guardSend, release, unsubscribeToken, unsubscribeUrl } from '../_shared/mailguard.ts';
import { phoneKey, resolveCaller } from '../_shared/voice-agent.ts';
import { initiationFor, loadCandidates, missingRelation } from '../_shared/voice-agent-db.ts';
import { agentSwitchedOff, outboundAllowedNow } from '../_shared/voice-agent-calls.ts';
import { cleanText, settingsFromRow, type AgentSettings } from '../_shared/voice-agent-settings.ts';
import { ROLE_LABEL } from '../_shared/voice-agent-prompt.ts';
import { EL_BASE, ElevenError, elJson } from '../_shared/voice-agent-admin.ts';
import { pickLocalNumber } from '../_shared/agent-lines.ts';
import { DNC_TAG, withDncTag } from '../_shared/voice-agent-tools.ts';
import { hasDnc } from '../../../lib/rvm.ts';
import { emailRep } from '../_shared/rep-alert.ts';
import {
  autopilotStop, cadencePlan, callOutcome, reviewCall, CALL_LABEL, CALL_NEXT, type CallReview, firstTouch, followupInstructions, funnel, inCallWindow, isHumanTouch, leadZone, nextWindowOpen, normalizeAutopilot,
  reactivationEligible, reactivationInstructions, sourceKind, speedCallGoal, speedEligibility, speedEmail, speedText, spreadAt, whoOf, REACTIVATION_CADENCE,
  nextMorningMs, spendCheck, type AutopilotSettings, type Program, type SpendToday,
} from '../_shared/ai-autopilot.ts';
import { sellerStageGroup } from '../../../lib/stages.ts';
import { LIST_LABEL, REACTIVATION_LISTS } from '../../../lib/reactivation.ts';
import {
  AVATAR_SYSTEM, AVATAR_TOOL, CHANNELS, DECIDE_TOOL, DEFAULT_TZ, EMPTY_PLAN, MAX_BULK, MAX_TOUCHES_DEFAULT, PLAN_TOOL, RVM_GAP_DAYS,
  activityLine, aggregateActions, appendChat, asksToStop, audienceServes, avatarPrompt, cleanChannels, deciderSystem, deciderUser, eligibility,
  firstLookAt, gateDecision, instructionsFrom, nextLookAt, nowLabel, parseDecision, parsePlan, personaOf, plannerSystem, plannerUser, readChat,
  readPlan, sanitizeSvg, svgDataUri, cleanTriggers, handoffDue, handoffTarget, mayQualify, relayPatch, prettyPhone,
  type ActionRow, type Channel, type ChatTurn, type Decision, type HandoffTrigger, type NextStage, type Persona, type Plan, type Reach, type RecordKind,
} from '../_shared/ai-agent.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// deno-lint-ignore no-explicit-any
type Any = any;
type Body = Record<string, unknown> & { action?: string; workspace_id?: number | string };

const READ = ['agents', 'status', 'log', 'report', 'autopilot'];
const WRITE = ['chat', 'start', 'stop', 'handoff', 'bulk_start', 'bulk_stop', 'generate_avatar', 'set_audience', 'set_handoff', 'set_autopilot', 'run_reactivation', 'test_call'];
const ADMIN_ONLY = ['generate_avatar', 'set_audience', 'set_handoff', 'set_autopilot', 'run_reactivation', 'test_call'];
const NOT_MIGRATED = 'AI agents are not set up: apply migration 123 (ai_agent_enrollments).';
const ENROLL_COLS = 'id, workspace_id, record_kind, record_id, agent_key, status, mode, instructions, channels, plan, chat, touches, max_touches, next_action_at, last_action_at, last_inbound_seen_at, claimed_at, stop_reason, started_by, started_at, stopped_by, stopped_at, updated_at';
/** ENROLL_COLS plus the autopilot program (migration 146). */
const ENROLL_COLS_146 = `${ENROLL_COLS}, program, autopilot`;
const AUTOPILOT_NOT_MIGRATED = 'AI Autopilot is not set up: apply migration 146 (ai_autopilot).';
/** Is this error the database without migration 146. */
const lacks146 = (e: { message?: string; code?: string } | null | undefined) => {
  const m = String(e?.message ?? '');
  return !!e && (e.code === 'PGRST202' || (missingRelation(m) && /ai_autopilot|program|autopilot|booked_by|ai_agent_key/.test(m)));
};
/** Learned on the first read: null until then. */
let has146: boolean | null = null;
const AGENT_COLS = 'workspace_id, agent_key, role, name, status, enabled, settings, live_settings, live_version, agent_id, avatar_url, audience';
/** AGENT_COLS plus the hand-off (migration 124). Reads fall back to AGENT_COLS before it, so only the hand-off is missing. */
const AGENT_COLS_124 = `${AGENT_COLS}, handoff_to, handoff_on`;
const lacks124 = (e: { message?: string } | null) => !!e && /handoff_|relayed_from/.test(String(e.message ?? ''));

// ---- small shared reads ---------------------------------------------------------------

function anthropic(): Anthropic | null {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return null;
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return new Anthropic({ apiKey: key, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
}

type AgentLite = {
  agent_key: string; role: string; name: string; avatar_url: string | null; audience: string; enabled: boolean; live_version: number;
  agent_id: string | null; settings: AgentSettings; live: AgentSettings | null; can_call: boolean;
  /** The agent this one hands a record to, and when (migration 124). */
  handoff_to: string | null; handoff_on: HandoffTrigger[];
};

function agentOf(r: Any): AgentLite {
  const draft = settingsFromRow(r.settings);
  const live = r.live_settings ? settingsFromRow(r.live_settings) : null;
  const s = live ?? draft;
  return {
    agent_key: String(r.agent_key), role: String(r.role ?? ''), name: String(r.name || s.identity.name || ROLE_LABEL[String(r.role)] || r.agent_key),
    avatar_url: r.avatar_url ?? null, audience: String(r.audience ?? 'sellers'), enabled: r.enabled !== false, live_version: Number(r.live_version ?? 0),
    agent_id: r.agent_id ?? null, settings: s, live,
    // A call needs a published agent, its ElevenLabs number and the API key.
    can_call: !!r.agent_id && !!live && !!live.channels.phone_number_id && !!Deno.env.get('ELEVENLABS_API_KEY'),
    handoff_to: r.handoff_to ?? null, handoff_on: r.handoff_on === undefined ? [] : cleanTriggers(r.handoff_on),
  };
}

async function agentRows(admin: SupabaseClient, ws: number, key?: string): Promise<Any[]> {
  const q = (cols: string) => {
    let x = admin.from('voice_agent_settings').select(cols).eq('workspace_id', ws);
    if (key) x = x.eq('agent_key', key);
    return x.order('created_at');
  };
  let r = await q(AGENT_COLS_124);
  if (lacks124(r.error)) r = await q(AGENT_COLS);
  if (r.error) throw r.error;
  return (r.data ?? []) as Any[];
}

async function loadAgents(admin: SupabaseClient, ws: number): Promise<AgentLite[]> {
  return (await agentRows(admin, ws)).map(agentOf);
}

async function loadAgent(admin: SupabaseClient, ws: number, key: string): Promise<AgentLite | null> {
  const [row] = await agentRows(admin, ws, key);
  return row ? agentOf(row) : null;
}

/** The agents that already worked this run (migration 124); none before it. */
async function relayedFrom(admin: SupabaseClient, enrollmentId: number): Promise<string[]> {
  const { data, error } = await admin.from('ai_agent_enrollments').select('relayed_from').eq('id', enrollmentId).maybeSingle();
  if (error) return [];
  return ((data as Any)?.relayed_from ?? []) as string[];
}

/** A fresh run starts with nobody in relayed_from. Best effort: before migration 124 there is no column. */
async function clearRelayed(admin: SupabaseClient, enrollmentId: number) {
  const { error } = await admin.from('ai_agent_enrollments').update({ relayed_from: [] }).eq('id', enrollmentId);
  if (error && !lacks124(error)) console.error('ai-agent relayed_from', error.message);
}

/**
 * Hand a running record from one agent to the next: the same enrollment, now
 * the next agent's, with a fresh plan it drafts from the whole history on its
 * first look. The rep who switched it on hears about it; both agents' ledgers
 * and the record's timeline say so.
 */
async function relay(admin: SupabaseClient, ws: number, e: Any, from: AgentLite, to: AgentLite, reason: string, actor: { id: string | null; name: string | null } = { id: null, name: null }): Promise<Any> {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { ...relayPatch({ chat: e.chat, instructions: e.instructions, relayed_from: await relayedFrom(admin, Number(e.id)) }, from, to, reason, nowIso), claimed_at: null };
  let r = await admin.from('ai_agent_enrollments').update(patch).eq('id', e.id).select(ENROLL_COLS).maybeSingle();
  if (lacks124(r.error)) {
    const { relayed_from: _r, ...older } = patch;
    r = await admin.from('ai_agent_enrollments').update(older).eq('id', e.id).select(ENROLL_COLS).maybeSingle();
  }
  if (r.error) throw r.error;
  const kind = e.record_kind as RecordKind; const id = Number(e.record_id);
  const why = reason || 'their stage is done';
  const by = actor.name ? ` (${actor.name} handed it on)` : '';
  await record(admin, { ws, agent: from, enrollmentId: Number(e.id), kind, id, channel: 'system', action: 'relayed', summary: `${to.name}, the ${ROLE_LABEL[to.role] ?? to.role.replace(/_/g, ' ')}, takes over: ${why}.${by}`, detail: { to_agent: to.agent_key, reason: why }, actorId: actor.id });
  await record(admin, { ws, agent: to, enrollmentId: Number(e.id), kind, id, channel: 'system', action: 'took_over', summary: `From ${from.name}: ${why}.`, detail: { from_agent: from.agent_key }, actorId: actor.id, timeline: false });
  const rep = e.started_by ?? null;
  if (rep && !actor.id) {
    const { data: rec } = await admin.from(kind === 'seller' ? 'sellers' : 'buyers').select('name').eq('id', id).maybeSingle();
    await admin.from('notifications').insert({
      workspace_id: ws, user_id: rep, category: 'AI agent', title: `${from.name} handed ${String((rec as Any)?.name || 'a ' + kind)} to ${to.name}`.slice(0, 120),
      body: why.slice(0, 500), seller_id: kind === 'seller' ? id : null, buyer_id: kind === 'buyer' ? id : null,
    });
  }
  return r.data;
}

type Rec = {
  kind: RecordKind; id: number; name: string; phone: string | null; email: string | null; tags: string[]; archived_at: string | null;
  assigned_to: string | null; vip: boolean; buyer_type: string | null; entity_type: string | null; blacklisted_at: string | null;
};

/** One seller or buyer with what reaching them needs. `db` decides visibility: the caller's client for a member, admin for the tick. */
async function loadRecord(db: SupabaseClient, admin: SupabaseClient, ws: number, kind: RecordKind, id: number): Promise<Rec | null> {
  if (kind === 'seller') {
    const { data } = await db.from('sellers').select('id, name, phone, email, tags, archived_at, assigned_to').eq('id', id).eq('workspace_id', ws).maybeSingle();
    if (!data) return null;
    const r = data as Any;
    return { kind, id, name: String(r.name ?? ''), phone: phoneE164(r.phone), email: validEmail(r.email), tags: r.tags ?? [], archived_at: r.archived_at ?? null, assigned_to: r.assigned_to ?? null, vip: false, buyer_type: null, entity_type: null, blacklisted_at: null };
  }
  const { data } = await db.from('buyers').select('id, name, company, phone, email, tags, vip, buyer_type, entity_type, blacklisted_at').eq('id', id).eq('workspace_id', ws).maybeSingle();
  if (!data) return null;
  const r = data as Any;
  let phone = phoneE164(r.phone);
  // A buyer's main number may be flagged DNC on buyer_phones; the next clean number is used instead.
  const { data: phones } = await admin.from('buyer_phones').select('phone, is_dnc, position').eq('workspace_id', ws).eq('buyer_id', id).order('position').limit(10);
  const list = (phones ?? []) as Any[];
  const dncKeys = new Set(list.filter((p) => p.is_dnc).map((p) => phoneKey(p.phone)));
  if (phone && dncKeys.has(phoneKey(phone))) phone = null;
  if (!phone) phone = list.map((p) => (!p.is_dnc ? phoneE164(p.phone) : null)).find((p) => !!p) ?? null;
  return { kind, id, name: String(r.name || r.company || ''), phone, email: validEmail(r.email), tags: r.tags ?? [], archived_at: null, assigned_to: null, vip: !!r.vip, buyer_type: r.buyer_type ?? null, entity_type: r.entity_type ?? null, blacklisted_at: r.blacklisted_at ?? null };
}

const validEmail = (v: unknown) => { const e = String(v ?? '').trim().toLowerCase(); return /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/.test(e) ? e : null; };

const reachOf = (r: Rec, a: AgentLite | null): Reach => ({ phone: !!r.phone, email: !!r.email, call: !!r.phone && !!a?.can_call });
const dncOf = (r: Rec) => isDoNotEngage({ tags: r.tags, blacklisted_at: r.blacklisted_at });
const tzOf = (a: AgentLite | null) => a?.settings.rules.compliance.quiet_hours.tz || a?.settings.call_handling.call_hours.tz || DEFAULT_TZ;

async function firstNameOf(admin: SupabaseClient, userId: string | null | undefined): Promise<string> {
  if (!userId) return '';
  const { data } = await admin.from('profiles').select('full_name').eq('id', userId).maybeSingle();
  return String((data as Any)?.full_name ?? '').trim().split(/\s+/)[0] ?? '';
}

async function personaFor(admin: SupabaseClient, ws: number, a: AgentLite, repId: string | null): Promise<Persona> {
  const [{ data: w }, rep] = await Promise.all([admin.from('workspaces').select('name').eq('id', ws).maybeSingle(), firstNameOf(admin, repId)]);
  return personaOf(a.settings, { name: a.name, company: String((w as Any)?.name ?? ''), rep });
}

/**
 * The ledger row and the timeline line for one action. The ledger is the
 * agent's own record (report, log); the activity line is what a rep reads on
 * the record. A failure to write either is logged, never thrown: the action
 * itself already happened.
 */
async function record(admin: SupabaseClient, i: {
  ws: number; agent: { agent_key: string; name: string }; enrollmentId: number | null; kind: RecordKind; id: number; channel: 'call' | 'rvm' | 'sms' | 'email' | 'plan' | 'system';
  action: string; status?: 'done' | 'skipped' | 'failed'; summary: string; detail?: Record<string, unknown>; communicationId?: number | null; conversationId?: string | null;
  actorId?: string | null; actorName?: string | null; timeline?: boolean;
}): Promise<void> {
  const { error } = await admin.from('ai_agent_actions').insert({
    workspace_id: i.ws, agent_key: i.agent.agent_key, enrollment_id: i.enrollmentId, record_kind: i.kind, record_id: i.id, channel: i.channel, action: i.action,
    status: i.status ?? 'done', summary: i.summary.slice(0, 2000), detail: i.detail ?? {}, communication_id: i.communicationId ?? null,
    conversation_id: i.conversationId ?? null, actor_id: i.actorId ?? null,
  });
  if (error) console.error('ai-agent ledger', error.message);
  if (i.timeline === false) return;
  const line = activityLine(i.agent.name, i.status === 'failed' ? 'failed' : i.status === 'skipped' && i.action !== 'stopped' ? 'skipped' : i.action, i.summary, i.actorName);
  const { error: aErr } = await admin.from('activity').insert({
    workspace_id: i.ws, entity_type: i.kind, entity_id: i.id, kind: 'ai_agent', title: line.title, body: line.body || null, actor_id: i.actorId ?? null,
  });
  if (aErr) console.error('ai-agent activity', aErr.message);
}

const planText = (p: Plan) => [p.summary, p.goal ? `Goal: ${p.goal}` : '', ...p.steps.map((s) => `Day ${s.day} · ${s.channel === 'sms' ? 'text' : s.channel === 'rvm' ? 'voicemail' : s.channel}: ${s.purpose}`), p.stop_when ? `Stops when: ${p.stop_when}` : ''].filter(Boolean).join('\n');

/** The history as the model reads it: fenced, because it is what other people wrote. */
async function historyFor(admin: SupabaseClient, ws: number, kind: RecordKind, id: number): Promise<string> {
  const h = await gatherHistory(admin, ws, kind, id);
  return h ? fence('history', historyText(h, 200), 90_000) : '(no history on file)';
}

/** One forced-by-prompt tool call; the tool's input, or null. */
async function claudeTool(client: Anthropic, system: string, tool: { name: string; description: string; input_schema: unknown }, user: string, maxTokens = 1800): Promise<Record<string, unknown> | null> {
  const res = await client.messages.create({
    model: CLAUDE_MODEL, thinking: CLAUDE_THINKING, max_tokens: maxTokens,
    system: toolRule(tool.name) + system + UNTRUSTED_RULE,
    tools: [tool as unknown as Anthropic.Tool], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: user }],
  });
  const use = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === tool.name);
  return use ? use.input as Record<string, unknown> : null;
}

/** Ask the agent for a plan: its reply to the rep and the plan, or a plain fallback when the model is not there. */
async function draftPlan(client: Anthropic | null, i: { persona: Persona; kind: RecordKind; agent: AgentLite; history: string; chat: ChatTurn[]; mode: 'auto' | 'custom'; channels: Channel[]; reach: Reach; tz: string }): Promise<{ reply: string; plan: Plan }> {
  if (!client) {
    const plan: Plan = { summary: 'A light follow-up: one touch now, then every few days.', goal: 'Reconnect and set the next step.', stop_when: 'They reply (a person takes over) or the plan runs out.', steps: i.channels.filter((c) => c !== 'call').slice(0, 1).flatMap((c) => [0, 3, 7, 14].map((day) => ({ day, channel: c, purpose: day ? 'Check back in' : 'Reconnect' }))) };
    return { reply: 'The AI model is not configured (ANTHROPIC_API_KEY), so I set a simple follow-up plan. An admin can connect the model for plans written from the history.', plan };
  }
  const input = await claudeTool(client, plannerSystem(i.persona, i.kind, i.agent.settings), PLAN_TOOL, plannerUser({ kind: i.kind, history: i.history, chat: i.chat, mode: i.mode, channels: i.channels, reach: i.reach, nowLabel: nowLabel(Date.now(), i.tz) }));
  const plan = parsePlan(input, i.channels) ?? EMPTY_PLAN;
  const reply = cleanText(input?.reply, 2000, true) || (plan.summary ? `Here's the plan: ${plan.summary}` : 'I could not draft a plan from that. Tell me a bit more about what you want.');
  return { reply, plan };
}

function enrollmentOut(e: Any | null) {
  if (!e) return null;
  return {
    id: Number(e.id), record_kind: e.record_kind, record_id: Number(e.record_id), agent_key: e.agent_key, status: e.status, mode: e.mode,
    instructions: e.instructions ?? '', channels: cleanChannels(e.channels), plan: readPlan(e.plan), chat: readChat(e.chat), touches: Number(e.touches ?? 0),
    max_touches: Number(e.max_touches ?? MAX_TOUCHES_DEFAULT), next_action_at: e.next_action_at ?? null, last_action_at: e.last_action_at ?? null,
    stop_reason: e.stop_reason ?? null, started_at: e.started_at ?? null, stopped_at: e.stopped_at ?? null, started_by: e.started_by ?? null,
  };
}

const agentOut = (a: AgentLite, active = 0) => ({
  agent_key: a.agent_key, name: a.name, role: a.role, role_label: ROLE_LABEL[a.role] ?? a.role.replace(/_/g, ' '), avatar_url: a.avatar_url, audience: a.audience,
  enabled: a.enabled, live: a.live_version > 0, can_call: a.can_call, active, handoff_to: a.handoff_to, handoff_on: a.handoff_on,
});

// ---- the server -------------------------------------------------------------------------

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const action = String(body.action ?? '');
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  // The cron's key (vault clozr_service_role_key) and this runtime's env key can be
  // different issues of the service key; accept exactly either one.
  const isService = async () => !!bearer && (bearer === serviceKey || (await admin.rpc('is_cron_key', { p_key: bearer })).data === true);

  if (action === 'tick') {
    if (!(await isService())) return json({ error: 'service role only' }, 403);
    try { return json({ ok: true, ...(await tick(admin)) }); } catch (e) {
      if (missingRelation(String((e as Any)?.message ?? e))) return json({ error: NOT_MIGRATED }, 503);
      return serverError(CORS, 'ai-agent tick', e);
    }
  }
  // A dispo campaign's AI call (migration 192, dispo-campaign-tick): ring one
  // buyer about one deal, from the workspace's dispo agent, with the brief as
  // the call goal. Service role only; the campaign row is the audit trail.
  if (action === 'deal_call') {
    if (!(await isService())) return json({ error: 'service role only' }, 403);
    const ws = Number(body.workspace_id); const buyerId = Number(body.buyer_id);
    if (!Number.isFinite(ws) || !Number.isFinite(buyerId)) return json({ error: 'workspace_id and buyer_id are required' }, 422);
    const rec = await loadRecord(admin, admin, ws, 'buyer', buyerId);
    if (!rec) return json({ error: 'buyer not found', stop: true }, 404);
    if (dncOf(rec)) return json({ error: 'buyer is marked do not contact', stop: true }, 409);
    if (!rec.phone) return json({ error: 'buyer has no number the agent may call', stop: true }, 409);
    const agents = (await loadAgents(admin, ws)).filter((a) => a.enabled && a.can_call && /buyer|both|all|everyone/i.test(a.audience));
    const wanted = typeof body.agent_key === 'string' ? body.agent_key : '';
    // The dispo roles first: a buyer assistant's template holds prices back, a junior dispo coordinator's is written to pitch a deal.
    const agent = (wanted && agents.find((a) => a.agent_key === wanted)) ?? ['jr_dispo', 'buyer_assistant'].map((r) => agents.find((a) => a.role === r)).find(Boolean) ?? agents[0] ?? null;
    if (!agent) return json({ error: 'No published AI agent that works buyers and can call (Settings, AI Agent, Handling: a phone number and outbound calls on).', retry_hours: 24 }, 409);
    const persona = await personaFor(admin, ws, agent, typeof body.rep_id === 'string' ? body.rep_id : null);
    const goal = cleanText(String(body.call_goal ?? ''), 2000, true) || 'Tell them about the deal we just got under contract and ask if they want the details.';
    const decision: Decision = { action: 'call', body: '', subject: '', call_goal: goal, next_check_hours: 24, reason: `Dispo campaign ${Number(body.campaign_id) || ''} for deal ${Number(body.deal_id) || ''}`.trim() };
    const r = await placeCall(admin, ws, agent, rec, decision, persona);
    if (!r.ok) return json({ error: r.reason, retry_hours: r.retryHours, stop: !!r.stop }, r.stop ? 409 : 503);
    await record(admin, { ws, agent: { agent_key: agent.agent_key, name: agent.name }, enrollmentId: null, kind: 'buyer', id: buyerId, channel: 'call', action: 'call_placed', summary: `Calling ${rec.phone} about deal ${Number(body.deal_id) || ''}: ${goal.slice(0, 300)}`, conversationId: r.conversationId, detail: { goal, campaign_id: Number(body.campaign_id) || null, deal_id: Number(body.deal_id) || null, from_number: r.from.phone, from_market: r.from.market } }).catch((e) => console.error('ai-agent deal_call record', String(e)));
    return json({ ok: true, agent_key: agent.agent_key, conversation_id: r.conversationId, from: r.from });
  }

  if (action === 'speed' || action === 'reactivate') {
    if (!(await isService())) return json({ error: 'service role only' }, 403);
    try {
      const out = action === 'speed' ? await speedRun(admin, { url, serviceKey }) : await reactivateRun(admin, null);
      return json({ ok: true, ...out });
    } catch (e) {
      if (lacks146(e as Any)) return json({ error: AUTOPILOT_NOT_MIGRATED }, 503);
      return serverError(CORS, `ai-agent ${action}`, e);
    }
  }

  const ws = Number(body.workspace_id);
  if (!Number.isInteger(ws) || ws <= 0) return json({ error: 'workspace_id is required' }, 422);
  if (![...READ, ...WRITE].includes(action)) return json({ error: `action must be one of ${[...READ, ...WRITE].join(', ')}` }, 400);
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  const userId = who.user.id;
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', userId).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  const isAdmin = ['owner', 'admin'].includes(String(member.role));
  if (ADMIN_ONLY.includes(action) && !isAdmin) return json({ error: 'only an owner or admin can change an agent' }, 403);
  const rl = await rateLimit(admin, `ai-agent:${userId}`, 600, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const kindOf = (v: unknown): RecordKind | null => (v === 'seller' || v === 'buyer' ? v : null);
  const readEnrollment = async (kind: RecordKind, id: number) => {
    const { data, error } = await admin.from('ai_agent_enrollments').select(ENROLL_COLS).eq('workspace_id', ws).eq('record_kind', kind).eq('record_id', id).maybeSingle();
    if (error) throw error;
    return data as Any | null;
  };
  const myName = async () => firstNameOf(admin, userId);

  try {
    switch (action) {
      case 'agents': {
        const [agents, { data: counts }] = await Promise.all([
          loadAgents(admin, ws),
          admin.from('ai_agent_enrollments').select('agent_key').eq('workspace_id', ws).eq('status', 'active').limit(10000),
        ]);
        const active = new Map<string, number>();
        for (const r of (counts ?? []) as Any[]) active.set(r.agent_key, (active.get(r.agent_key) ?? 0) + 1);
        return json({ ok: true, agents: agents.map((a) => agentOut(a, active.get(a.agent_key) ?? 0)), can_edit: isAdmin });
      }

      case 'status': {
        const kind = kindOf(body.record_kind); const id = Number(body.record_id);
        if (!kind || !Number.isInteger(id)) return json({ error: 'record_kind and record_id are required' }, 422);
        const rec = await loadRecord(asCaller, admin, ws, kind, id);
        if (!rec) return json({ error: 'record not found' }, 404);
        const [e, agents, { data: acts }] = await Promise.all([
          readEnrollment(kind, id), loadAgents(admin, ws),
          admin.from('ai_agent_actions').select('id, agent_key, channel, action, status, summary, created_at').eq('workspace_id', ws).eq('record_kind', kind).eq('record_id', id).order('created_at', { ascending: false }).limit(30),
        ]);
        const serving = agents.filter((a) => audienceServes(a.audience, kind));
        const current = e ? agents.find((a) => a.agent_key === e.agent_key) ?? null : serving[0] ?? null;
        const channels = cleanChannels(e?.channels);
        const el = eligibility({ kind, record: rec, dnc: dncOf(rec), audience: current?.audience ?? (kind === 'buyer' ? 'buyers' : 'sellers'), channels: [...CHANNELS], reach: reachOf(rec, current) });
        return json({
          ok: true, enrollment: enrollmentOut(e), agents: serving.map((a) => agentOut(a)), agent: current ? agentOut(current) : null,
          eligible: el.ok ? { ok: true } : { ok: false, reason: el.reason, code: el.code }, reach: reachOf(rec, current), channels,
          record: { kind, id, name: rec.name }, actions: acts ?? [],
        });
      }

      case 'log': {
        const kind = kindOf(body.record_kind); const id = Number(body.record_id);
        if (!kind || !Number.isInteger(id)) return json({ error: 'record_kind and record_id are required' }, 422);
        if (!(await loadRecord(asCaller, admin, ws, kind, id))) return json({ error: 'record not found' }, 404);
        const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
        const { data, error } = await admin.from('ai_agent_actions').select('id, agent_key, channel, action, status, summary, detail, created_at').eq('workspace_id', ws).eq('record_kind', kind).eq('record_id', id).order('created_at', { ascending: false }).limit(limit);
        if (error) throw error;
        return json({ ok: true, actions: data ?? [] });
      }

      case 'chat':
      case 'start': {
        const kind = kindOf(body.record_kind); const id = Number(body.record_id);
        if (!kind || !Number.isInteger(id)) return json({ error: 'record_kind and record_id are required' }, 422);
        const rec = await loadRecord(asCaller, admin, ws, kind, id);
        if (!rec) return json({ error: 'record not found' }, 404);
        let e = await readEnrollment(kind, id);
        const agents = await loadAgents(admin, ws);
        const wantKey = typeof body.agent_key === 'string' && body.agent_key ? body.agent_key : e?.agent_key ?? agents.find((a) => audienceServes(a.audience, kind))?.agent_key;
        const agent = agents.find((a) => a.agent_key === wantKey) ?? null;
        if (!agent) return json({ error: kind === 'buyer' ? 'No agent works buyers yet. An admin can add the Buyer assistant in Settings, AI Agent.' : 'No agent works sellers yet. An admin can add one in Settings, AI Agent.' }, 409);
        const channels = cleanChannels(body.channels ?? e?.channels);
        const el = eligibility({ kind, record: rec, dnc: dncOf(rec), audience: agent.audience, channels, reach: reachOf(rec, agent) });
        if (!el.ok) return json({ error: el.reason, code: el.code }, 422);

        const message = cleanText(body.message, 2000, true);
        const fresh = !e || ['stopped', 'done'].includes(e.status) || e.agent_key !== agent.agent_key;
        let chat = fresh ? [] as ChatTurn[] : readChat(e!.chat);
        const now = new Date().toISOString();
        if (message) chat = appendChat(chat, { role: 'rep', text: message, at: now, by: userId });
        else if (body.mode === 'auto' && (fresh || !chat.length)) chat = appendChat(chat, { role: 'rep', text: 'Let the AI decide from the record history.', at: now, by: userId });
        const mode: 'auto' | 'custom' = chat.some((t) => t.role === 'rep' && t.text !== 'Let the AI decide from the record history.') ? 'custom' : 'auto';

        let plan = fresh ? EMPTY_PLAN : readPlan(e!.plan, channels);
        let reply: string | null = null;
        const needPlan = action === 'chat' || !plan.steps.length || !!message;
        if (needPlan) {
          const pl = await rateLimit(admin, `ai-agent-plan:${userId}`, 120, 3600);
          if (!pl.allowed) return tooMany(CORS, pl);
          const persona = await personaFor(admin, ws, agent, e?.started_by ?? rec.assigned_to ?? userId);
          const drafted = await draftPlan(anthropic(), { persona, kind, agent, history: await historyFor(admin, ws, kind, id), chat, mode, channels, reach: reachOf(rec, agent), tz: tzOf(agent) });
          plan = drafted.plan; reply = drafted.reply;
          chat = appendChat(chat, { role: 'agent', text: reply, at: new Date().toISOString() });
        }

        const wasActive = !fresh && e!.status === 'active';
        const turningOn = action === 'start' && !wasActive;
        const tz = tzOf(agent);
        const row: Record<string, unknown> = {
          workspace_id: ws, record_kind: kind, record_id: id, agent_key: agent.agent_key, mode, channels, plan, chat, instructions: instructionsFrom(chat),
          status: action === 'start' || wasActive ? 'active' : 'draft',
          ...(fresh ? { touches: 0, last_action_at: null, last_inbound_seen_at: now, stop_reason: null, stopped_at: null, stopped_by: null, started_at: now, started_by: userId, claimed_at: null } : {}),
          ...(turningOn ? { started_at: now, started_by: userId, stop_reason: null, stopped_at: null, stopped_by: null, next_action_at: firstLookAt(Date.now(), tz) } : {}),
          // The rep changed course on a running agent: it looks again right away (the gap rules still hold).
          ...(wasActive && needPlan ? { next_action_at: firstLookAt(Date.now(), tz) } : {}),
          ...(action === 'chat' && !wasActive ? { next_action_at: null } : {}),
        };
        const { data: saved, error } = e
          ? await admin.from('ai_agent_enrollments').update(row).eq('id', e.id).select(ENROLL_COLS).maybeSingle()
          : await admin.from('ai_agent_enrollments').insert({ ...row, started_by: userId }).select(ENROLL_COLS).maybeSingle();
        if (error) {
          if (/VIP|fund|works/.test(error.message)) return json({ error: error.message }, 422);
          throw error;
        }
        e = saved as Any;
        if (fresh) await clearRelayed(admin, Number(e.id));
        const actorName = await myName();
        if (turningOn) {
          await record(admin, { ws, agent, enrollmentId: e.id, kind, id, channel: 'system', action: 'started', summary: `${mode === 'auto' ? 'Deciding from the record history' : `Instructions: ${instructionsFrom(chat, 600)}`}\nChannels: ${channels.map((c) => (c === 'sms' ? 'text' : c)).join(', ')}\n\n${planText(plan)}`, detail: { mode, channels }, actorId: userId, actorName });
        } else if (wasActive && needPlan) {
          await record(admin, { ws, agent, enrollmentId: e.id, kind, id, channel: 'plan', action: 'plan_updated', summary: `${message ? `${actorName || 'A rep'} asked: ${message.slice(0, 300)}\n\n` : ''}${planText(plan)}`, actorId: userId });
        } else if (needPlan) {
          await record(admin, { ws, agent, enrollmentId: e.id, kind, id, channel: 'plan', action: 'chat', summary: message || 'Let the AI decide from the record history.', actorId: userId, timeline: false });
        }
        return json({ ok: true, reply, enrollment: enrollmentOut(e), agent: agentOut(agent) });
      }

      case 'stop': {
        const kind = kindOf(body.record_kind); const id = Number(body.record_id);
        if (!kind || !Number.isInteger(id)) return json({ error: 'record_kind and record_id are required' }, 422);
        if (!(await loadRecord(asCaller, admin, ws, kind, id))) return json({ error: 'record not found' }, 404);
        const e = await readEnrollment(kind, id);
        if (!e || ['stopped', 'done'].includes(e.status)) return json({ ok: true, enrollment: enrollmentOut(e) });
        const reason = cleanText(body.reason, 200) || 'switched off';
        const { data: saved, error } = await admin.from('ai_agent_enrollments').update({ status: 'stopped', stop_reason: reason, stopped_at: new Date().toISOString(), stopped_by: userId, next_action_at: null, claimed_at: null }).eq('id', e.id).select(ENROLL_COLS).maybeSingle();
        if (error) throw error;
        if (e.status !== 'draft') {
          const agent = await loadAgent(admin, ws, e.agent_key);
          await record(admin, { ws, agent: agent ?? { agent_key: e.agent_key, name: e.agent_key }, enrollmentId: e.id, kind, id, channel: 'system', action: 'stopped', summary: `After ${e.touches} touch${e.touches === 1 ? '' : 'es'}. ${reason === 'switched off' ? '' : reason}`.trim(), actorId: userId, actorName: await myName() });
        }
        return json({ ok: true, enrollment: enrollmentOut(saved) });
      }

      case 'bulk_start': {
        // Buyers (the Buyers bulk bar) or sellers (the People bulk bar): record_kind, then ids, or buyer_ids / seller_ids.
        const kind: RecordKind = body.record_kind === 'seller' || (!body.record_kind && Array.isArray(body.seller_ids) && !body.buyer_ids) ? 'seller' : 'buyer';
        const word = kind === 'buyer' ? 'buyers' : 'sellers';
        const ids = idsOf(body.ids ?? (kind === 'buyer' ? body.buyer_ids : body.seller_ids), kind === 'buyer' ? 'b' : 's');
        if (!ids.length) return json({ error: `${kind === 'buyer' ? 'buyer_ids' : 'seller_ids'} is required` }, 422);
        if (ids.length > MAX_BULK) return json({ error: `At most ${MAX_BULK} ${word} at a time.` }, 422);
        const agent = typeof body.agent_key === 'string' ? await loadAgent(admin, ws, body.agent_key) : (await loadAgents(admin, ws)).find((a) => audienceServes(a.audience, kind)) ?? null;
        if (!agent) return json({ error: kind === 'buyer' ? 'No agent works buyers yet. An admin can add the Buyer assistant in Settings, AI Agent.' : 'No agent works sellers yet. An admin can add a Lead manager in Settings, AI Agent.' }, 409);
        if (!audienceServes(agent.audience, kind)) return json({ error: `${agent.name} works ${agent.audience}, not ${word}.` }, 422);
        const channels = cleanChannels(body.channels);
        const message = cleanText(body.message, 2000, true);
        const now = Date.now(); const nowIso = new Date(now).toISOString();
        const tz = tzOf(agent);
        const { data: existing } = await admin.from('ai_agent_enrollments').select('id, record_id, status, agent_key').eq('workspace_id', ws).eq('record_kind', kind).in('record_id', ids);
        const byId = new Map(((existing ?? []) as Any[]).map((r) => [Number(r.record_id), r]));
        const started: number[] = []; const skipped: { id: number; name: string; reason: string }[] = [];
        const actorName = await myName();
        let n = 0;
        for (const id of ids) {
          const rec = await loadRecord(asCaller, admin, ws, kind, id);
          if (!rec) { skipped.push({ id, name: '', reason: 'not found' }); continue; }
          const el = eligibility({ kind, record: rec, dnc: dncOf(rec), audience: agent.audience, channels, reach: reachOf(rec, agent) });
          if (!el.ok) { skipped.push({ id, name: rec.name, reason: el.reason }); continue; }
          const ex = byId.get(id);
          if (ex && ex.status === 'active') { skipped.push({ id, name: rec.name, reason: ex.agent_key === agent.agent_key ? 'already on this agent' : 'already on another agent' }); continue; }
          const chat: ChatTurn[] = [{ role: 'rep', text: message || 'Let the AI decide from the record history.', at: nowIso, by: userId }];
          // Spread the first looks so 200 records do not all wake in one tick; plans are drafted then.
          const row = {
            workspace_id: ws, record_kind: kind, record_id: id, agent_key: agent.agent_key, status: 'active', mode: message ? 'custom' : 'auto', channels,
            plan: {}, chat, instructions: message, touches: 0, last_action_at: null, last_inbound_seen_at: nowIso, stop_reason: null, stopped_at: null, stopped_by: null,
            started_at: nowIso, started_by: userId, claimed_at: null, next_action_at: firstLookAt(now + n * 90_000, tz),
          };
          const { data: saved, error } = ex
            ? await admin.from('ai_agent_enrollments').update(row).eq('id', ex.id).select('id').maybeSingle()
            : await admin.from('ai_agent_enrollments').insert(row).select('id').maybeSingle();
          if (error) { skipped.push({ id, name: rec.name, reason: /VIP|fund/.test(error.message) ? 'VIP or fund' : 'could not be saved' }); continue; }
          if (ex && (saved as Any)?.id) await clearRelayed(admin, Number((saved as Any).id));
          n++; started.push(id);
          await record(admin, { ws, agent, enrollmentId: (saved as Any)?.id ?? null, kind, id, channel: 'system', action: 'started', summary: `Bulk start for ${ids.length} ${word}. ${message ? `Instructions: ${message.slice(0, 600)}` : 'Deciding from the record history.'}\nChannels: ${channels.map((c) => (c === 'sms' ? 'text' : c)).join(', ')}`, detail: { mode: message ? 'custom' : 'auto', channels, bulk: true }, actorId: userId, actorName });
        }
        return json({ ok: true, record_kind: kind, started: started.length, started_ids: started, skipped, agent: agentOut(agent) });
      }

      case 'bulk_stop': {
        const buyers = idsOf(body.buyer_ids, 'b'); const sellers = idsOf(body.seller_ids, 's');
        if (!buyers.length && !sellers.length) return json({ error: 'buyer_ids or seller_ids is required' }, 422);
        if (buyers.length + sellers.length > MAX_BULK * 2) return json({ error: 'Too many at once.' }, 422);
        const actorName = await myName();
        let stopped = 0;
        for (const [kind, list] of [['buyer', buyers], ['seller', sellers]] as const) {
          if (!list.length) continue;
          // Only records the caller can see.
          const { data: visible } = await asCaller.from(kind === 'buyer' ? 'buyers' : 'sellers').select('id').eq('workspace_id', ws).in('id', list);
          const ok = ((visible ?? []) as Any[]).map((r) => Number(r.id));
          if (!ok.length) continue;
          const { data: rows, error } = await admin.from('ai_agent_enrollments').update({ status: 'stopped', stop_reason: 'switched off', stopped_at: new Date().toISOString(), stopped_by: userId, next_action_at: null, claimed_at: null })
            .eq('workspace_id', ws).eq('record_kind', kind).in('record_id', ok).in('status', ['active', 'paused', 'draft']).select('id, record_id, agent_key, touches, status');
          if (error) throw error;
          const agents = new Map((await loadAgents(admin, ws)).map((a) => [a.agent_key, a]));
          for (const r of (rows ?? []) as Any[]) {
            stopped++;
            const a = agents.get(r.agent_key);
            await record(admin, { ws, agent: a ?? { agent_key: r.agent_key, name: r.agent_key }, enrollmentId: r.id, kind, id: Number(r.record_id), channel: 'system', action: 'stopped', summary: `Bulk stop. After ${r.touches} touch${r.touches === 1 ? '' : 'es'}.`, actorId: userId, actorName });
          }
        }
        return json({ ok: true, stopped });
      }

      case 'report': {
        const days = Math.min(90, Math.max(1, Math.round(Number(body.days) || 30)));
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const [agents, acts, enr, calls] = await Promise.all([
          loadAgents(admin, ws),
          admin.from('ai_agent_actions').select('agent_key, action, status, channel, record_kind, record_id, created_at').eq('workspace_id', ws).gte('created_at', since).limit(50000),
          admin.from('ai_agent_enrollments').select('agent_key, status').eq('workspace_id', ws).limit(50000),
          admin.from('voice_agent_calls').select('agent_key, duration_s, booked, transferred, dnc_requested, not_interested, seller_id').eq('workspace_id', ws).gte('occurred_at', since).limit(20000),
        ]);
        if (acts.error) throw acts.error;
        const tz = agents[0] ? tzOf(agents[0]) : DEFAULT_TZ;
        const per = new Map(aggregateActions((acts.data ?? []) as ActionRow[], Math.min(days, 30), Date.now(), tz).map((r) => [r.agent_key, r]));
        const load = new Map<string, { active: number; total: number; done: number; stopped: number }>();
        for (const r of (enr.data ?? []) as Any[]) {
          const e = load.get(r.agent_key) ?? { active: 0, total: 0, done: 0, stopped: 0 };
          e.total++; if (r.status === 'active') e.active++; if (r.status === 'done') e.done++; if (r.status === 'stopped') e.stopped++;
          load.set(r.agent_key, e);
        }
        const voice = new Map<string, { calls: number; booked: number; transferred: number; minutes: number }>();
        for (const r of (calls.data ?? []) as Any[]) {
          const v = voice.get(r.agent_key) ?? { calls: 0, booked: 0, transferred: 0, minutes: 0 };
          v.calls++; if (r.booked) v.booked++; if (r.transferred) v.transferred++; v.minutes += Math.max(0, Number(r.duration_s) || 0) / 60;
          voice.set(r.agent_key, v);
        }
        const empty = { texts: 0, emails: 0, calls: 0, voicemails: 0, replies: 0, booked: 0, handoffs: 0, dnc: 0, records_touched: 0, failed: 0, by_day: [] as { day: string; touches: number }[] };
        // The AI funnel. Best effort: a read that fails leaves the per-agent report standing.
        const fun = await reportFunnel(admin, ws, since, (acts.data ?? []) as ActionRow[], (calls.data ?? []) as Any[], { tz, days }).catch((e) => { console.error('ai-agent funnel', String(e)); return null; });
        return json({
          ok: true, days, funnel: fun,
          agents: agents.map((a) => {
            const r = per.get(a.agent_key) ?? { ...empty, agent_key: a.agent_key };
            const v = voice.get(a.agent_key) ?? { calls: 0, booked: 0, transferred: 0, minutes: 0 };
            const l = load.get(a.agent_key) ?? { active: 0, total: 0, done: 0, stopped: 0 };
            const touches = r.texts + r.emails + r.calls + r.voicemails;
            return {
              ...agentOut(a, l.active), ...r, enrollments: l,
              voice_calls: v.calls, voice_booked: v.booked, transferred: v.transferred, talk_minutes: Math.round(v.minutes),
              touches, reply_rate: r.records_touched ? Math.round((r.replies / r.records_touched) * 100) : 0,
            };
          }),
        });
      }

      case 'autopilot': {
        return json({ ok: true, ...(await autopilotView(admin, ws, isAdmin)) });
      }

      case 'set_autopilot': {
        const ap = await loadAutopilot(admin, ws);
        if (!ap.migrated) return json({ error: AUTOPILOT_NOT_MIGRATED }, 503);
        const next = normalizeAutopilot(body.settings);
        const agents = await loadAgents(admin, ws);
        for (const [what, k] of [['Speed to lead', next.speed.agent_key], ['Follow-up', next.followup.agent_key], ['Reactivation', next.reactivation.agent_key]] as const) {
          if (!k) continue;
          const a = agents.find((x) => x.agent_key === k);
          if (!a) return json({ error: `${what}: that agent no longer exists.` }, 422);
          if (!audienceServes(a.audience, 'seller')) return json({ error: `${what}: ${a.name} works ${a.audience}, not sellers.` }, 422);
        }
        if (next.send_as) {
          const { data: m } = await admin.from('workspace_members').select('user_id').eq('workspace_id', ws).eq('user_id', next.send_as).maybeSingle();
          if (!m) return json({ error: 'Texts and emails can only go out as a member of this workspace.' }, 422);
        }
        const { error } = await admin.from('ai_autopilot_settings').upsert({ workspace_id: ws, settings: next, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: 'workspace_id' });
        if (error) {
          if (lacks146(error)) return json({ error: AUTOPILOT_NOT_MIGRATED }, 503);
          throw error;
        }
        return json({ ok: true, ...(await autopilotView(admin, ws, isAdmin)) });
      }

      case 'run_reactivation': {
        const ap = await loadAutopilot(admin, ws);
        if (!ap.migrated) return json({ error: AUTOPILOT_NOT_MIGRATED }, 503);
        if (!ap.settings.reactivation.enabled) return json({ error: 'Switch reactivation on first.' }, 422);
        const rl2 = await rateLimit(admin, `ai-autopilot-reactivate:${ws}`, 6, 3600);
        if (!rl2.allowed) return tooMany(CORS, rl2);
        return json({ ok: true, ...(await reactivateRun(admin, ws)) });
      }

      case 'test_call': {
        // "Call me now": the speed-to-lead agent calls the owner's own phone with a sample lead. No record is read or written.
        const to = phoneE164(String(body.phone ?? ''));
        if (!to) return json({ error: 'Type a phone number to call, like (210) 555-0100.' }, 422);
        const tl = await rateLimit(admin, `ai-autopilot-test:${ws}`, 6, 3600);
        if (!tl.allowed) return tooMany(CORS, tl);
        const ap = await loadAutopilot(admin, ws);
        const agents = await loadAgents(admin, ws);
        const agent = programAgent(agents, typeof body.agent_key === 'string' && body.agent_key ? body.agent_key : ap.settings.speed.agent_key, ['speed_to_lead', 'lead_manager']);
        if (!agent) return json({ error: 'No agent works sellers yet. Create one below first.' }, 409);
        const apiKey = Deno.env.get('ELEVENLABS_API_KEY');
        if (!apiKey) return json({ error: 'Calls need the ELEVENLABS_API_KEY secret on the Supabase project.' }, 409);
        if (!agent.agent_id || !agent.live || !agent.live.channels.phone_number_id) return json({ error: `${agent.name} is not published with an ElevenLabs phone number yet (Handling tab, then Publish).` }, 409);
        if (!agent.live.channels.outbound) return json({ error: `Outbound calls are off for ${agent.name} (Handling tab).` }, 409);
        const persona = await personaFor(admin, ws, agent, userId);
        const rn = agent.live.rules.compliance.recording_notice;
        const init = await initiationFor(admin, ws, { status: 'none' }, { direction: 'outbound', ours: '', theirs: phoneKey(to) ?? '' }, {
          agentName: persona.name, company: persona.company, introduceAs: agent.live.identity.introduce_as, recordingNotice: rn.enabled ? rn.text : null,
        }, agent.live, '');
        const sample = {
          ...init.dynamic_variables, first_name: 'Alex', property_address: '1204 Oak St', caller_known: true, do_not_engage: false, record_kind: 'seller', lead_source: 'form',
          rep_name: persona.rep || 'our acquisitions team', company: persona.company, agent_name: persona.name,
          lead_brief: 'Sample lead for a test call: Alex filled in the seller form a minute ago about 1204 Oak St. Nothing else is on file yet.',
          call_goal: speedCallGoal({ source: 'your website form', minutesOld: 0.2, transferOn: transferOn(agent) }),
        };
        try {
          const from = await callerNumberFor(admin, ws, to, agent.live.channels.phone_number_id);
          const r = await elJson<{ success?: boolean; message?: string; conversation_id?: string | null }>({ apiKey, baseUrl: Deno.env.get('ELEVENLABS_API_BASE') || EL_BASE }, 'POST', '/v1/convai/sip-trunk/outbound-call', {
            agent_id: agent.agent_id, agent_phone_number_id: from.id, to_number: to,
            conversation_initiation_client_data: { dynamic_variables: sample, conversation_config_override: { agent: { first_message: 'Hi, is this Alex?' } } },
          });
          if (r.success === false) return json({ error: `ElevenLabs: ${String(r.message ?? 'refused').slice(0, 200)}` }, 502);
          console.log('ai-agent test call', { ws, agent: agent.agent_key, by: userId });
          return json({ ok: true, agent: agentOut(agent), conversation_id: r.conversation_id ?? null, note: `${agent.name} is calling ${to} now${from.market ? ` from the ${from.market} number` : ''} as if you were a new lead named Alex about 1204 Oak St.` });
        } catch (e) {
          return json({ error: e instanceof ElevenError ? `ElevenLabs: ${e.message}` : 'Could not reach ElevenLabs.' }, 502);
        }
      }

      case 'generate_avatar': {
        const agent = typeof body.agent_key === 'string' ? await loadAgent(admin, ws, body.agent_key) : null;
        if (!agent) return json({ error: 'agent not found' }, 404);
        const al = await rateLimit(admin, `ai-agent-avatar:${ws}`, 20, 3600);
        if (!al.allowed) return tooMany(CORS, al);
        const extra = cleanText(body.prompt, 400);
        const prompt = avatarPrompt(agent.name, agent.role, extra, body.style === 'illustrated' ? 'illustrated' : 'realistic');
        const made = await makeAvatar(admin, ws, agent.agent_key, prompt);
        if ('error' in made) return json({ error: made.error }, made.status);
        const { error } = await admin.from('voice_agent_settings').update({ avatar_url: made.url, avatar_prompt: extra, updated_at: new Date().toISOString(), updated_by: userId }).eq('workspace_id', ws).eq('agent_key', agent.agent_key);
        if (error) throw error;
        return json({ ok: true, agent_key: agent.agent_key, avatar_url: made.url, provider: made.provider });
      }

      case 'handoff': {
        // A rep hands a running record to another agent now: the one picked, else the agent's own next agent.
        const kind = kindOf(body.record_kind); const id = Number(body.record_id);
        if (!kind || !Number.isInteger(id)) return json({ error: 'record_kind and record_id are required' }, 422);
        if (!(await loadRecord(asCaller, admin, ws, kind, id))) return json({ error: 'record not found' }, 404);
        const e = await readEnrollment(kind, id);
        if (!e || e.status !== 'active') return json({ error: 'No agent is working this record. Switch one on first.' }, 409);
        const agents = await loadAgents(admin, ws);
        const from = agents.find((a) => a.agent_key === e.agent_key);
        if (!from) return json({ error: 'The agent on this record no longer exists.' }, 409);
        const wantKey = typeof body.agent_key === 'string' && body.agent_key ? body.agent_key : from.handoff_to;
        const to = agents.find((a) => a.agent_key === wantKey);
        if (!to) return json({ error: wantKey ? 'That agent no longer exists.' : `${from.name} has no next agent set. Pick one, or set it in Settings, AI Agent.` }, 422);
        if (to.agent_key === from.agent_key) return json({ error: `${from.name} is already working this record.` }, 422);
        if (!audienceServes(to.audience, kind)) return json({ error: `${to.name} works ${to.audience}, not ${kind}s.` }, 422);
        const actorName = await myName();
        const saved = await relay(admin, ws, e, from, to, cleanText(body.reason, 300) || `${actorName || 'A rep'} handed it on`, { id: userId, name: actorName || null });
        return json({ ok: true, enrollment: enrollmentOut(saved), agent: agentOut(to) });
      }

      case 'set_handoff': {
        const key = String(body.agent_key ?? '');
        const from = await loadAgent(admin, ws, key);
        if (!from) return json({ error: 'agent not found' }, 404);
        const toKey = body.handoff_to === null || body.handoff_to === '' ? null : String(body.handoff_to ?? from.handoff_to ?? '') || null;
        if (toKey) {
          if (toKey === key) return json({ error: 'An agent cannot hand off to itself.' }, 422);
          const to = await loadAgent(admin, ws, toKey);
          if (!to) return json({ error: 'The agent to hand off to does not exist.' }, 422);
          if (!['sellers', 'buyers', 'both'].some((k) => (from.audience === 'both' || from.audience === k) && (to.audience === 'both' || to.audience === k))) return json({ error: `${to.name} works ${to.audience} and ${from.name} works ${from.audience}: they never share a record.` }, 422);
        }
        const on = body.handoff_on === undefined ? from.handoff_on : cleanTriggers(body.handoff_on);
        const { data, error } = await admin.from('voice_agent_settings').update({ handoff_to: toKey, handoff_on: on, updated_at: new Date().toISOString(), updated_by: userId })
          .eq('workspace_id', ws).eq('agent_key', key).select('agent_key, handoff_to, handoff_on').maybeSingle();
        if (error) {
          if (lacks124(error)) return json({ error: 'Agent hand-off is not set up: apply migration 124 (ai_agent_handoff).' }, 503);
          throw error;
        }
        return json({ ok: true, ...(data as Any) });
      }

      case 'set_audience': {
        const audience = String(body.audience ?? '');
        if (!['sellers', 'buyers', 'both'].includes(audience)) return json({ error: 'audience must be sellers, buyers or both' }, 422);
        const { data, error } = await admin.from('voice_agent_settings').update({ audience, updated_at: new Date().toISOString(), updated_by: userId })
          .eq('workspace_id', ws).eq('agent_key', String(body.agent_key ?? '')).select('agent_key, audience').maybeSingle();
        if (error) throw error;
        if (!data) return json({ error: 'agent not found' }, 404);
        return json({ ok: true, ...(data as Any) });
      }
    }
    return json({ error: 'unreachable' }, 500);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'the AI is busy, try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'ai-agent anthropic', e, 502);
    if (missingRelation(String((e as Any)?.message ?? e)) || /avatar_url|audience/.test(String((e as Any)?.message ?? ''))) return json({ error: NOT_MIGRATED }, 503);
    return serverError(CORS, `ai-agent ${action}`, e);
  }
});

/** Ids from numbers or view ids ('b45', 's12'), unique, positive. */
function idsOf(v: unknown, prefix: string): number[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const x of v) {
    const n = Number(typeof x === 'string' && x.startsWith(prefix) ? x.slice(prefix.length) : x);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

// ---- avatars --------------------------------------------------------------------------------

/**
 * A picture for the agent. Gemini makes it when the GEMENI_API_KEY secret is
 * set (GEMINI_API_KEY also works), stored in the public avatars bucket under
 * agents/<workspace>/; else Claude draws an SVG portrait, kept inline as a
 * data URI. GEMINI_IMAGE_MODEL overrides the model.
 */
async function makeAvatar(admin: SupabaseClient, ws: number, key: string, prompt: string): Promise<{ url: string; provider: string } | { error: string; status: number }> {
  const gemini = Deno.env.get('GEMENI_API_KEY') || Deno.env.get('GEMINI_API_KEY');
  let geminiError = '';
  if (gemini) {
    try {
      const model = Deno.env.get('GEMINI_IMAGE_MODEL') || 'gemini-2.5-flash-image';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': gemini, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
      });
      const out = await res.json().catch(() => ({})) as Any;
      const part = ((out?.candidates?.[0]?.content?.parts ?? []) as Any[]).find((p) => p?.inlineData?.data || p?.inline_data?.data);
      const inline = part?.inlineData ?? part?.inline_data;
      if (res.ok && inline?.data) {
        const type = String(inline.mimeType ?? inline.mime_type ?? 'image/png');
        const bytes = Uint8Array.from(atob(String(inline.data)), (c) => c.charCodeAt(0));
        const path = `agents/${ws}/${key}-${Date.now()}.${type.includes('jpeg') ? 'jpg' : 'png'}`;
        const { error } = await admin.storage.from('avatars').upload(path, bytes, { contentType: type, upsert: true });
        if (!error) return { url: admin.storage.from('avatars').getPublicUrl(path).data.publicUrl, provider: 'gemini' };
        console.error('ai-agent avatar upload', error.message);
      } else {
        geminiError = String(out?.error?.message ?? (res.ok ? 'no image came back' : res.status)).slice(0, 200);
        console.error('ai-agent avatar gemini', res.status, geminiError);
      }
    } catch (e) { console.error('ai-agent avatar gemini', String(e)); }
  }
  const client = anthropic();
  if (!client) return { error: geminiError ? `Gemini could not make the picture: ${geminiError}` : 'Set GEMENI_API_KEY (Gemini picture) or ANTHROPIC_API_KEY (drawn avatar) on the Supabase project.', status: 503 };
  const input = await claudeTool(client, AVATAR_SYSTEM, AVATAR_TOOL, `Draw this avatar: ${prompt}`, 8000);
  const svg = sanitizeSvg(String(input?.svg ?? ''));
  if (!svg) return { error: 'The avatar did not come out right. Try again.', status: 502 };
  return { url: svgDataUri(svg), provider: 'claude' };
}

// ---- the tick -------------------------------------------------------------------------------

const TICK_BATCH = 12;
const TICK_BUDGET_MS = 110_000;
const LEASE_MS = 10 * 60_000;

async function tick(admin: SupabaseClient): Promise<Record<string, number>> {
  const started = Date.now();
  const tally = { looked: 0, texts: 0, emails: 0, calls: 0, voicemails: 0, waits: 0, finished: 0, stopped: 0, failed: 0, relayed: 0, capped: 0 };
  const { data: due, error } = await admin.from('ai_agent_enrollments').select('id').eq('status', 'active').lte('next_action_at', new Date().toISOString())
    .order('next_action_at').limit(TICK_BATCH * 2);
  if (error) throw error;
  const client = anthropic();
  // The workspace's daily spend ceiling (AI Autopilot, limits): today's texts, emails, calls and steps.
  const spend = new Map<number, { limits: AutopilotSettings['limits']; today: SpendToday; tz: string; noted: boolean }>();
  const spendFor = async (ws: number) => {
    let g = spend.get(ws);
    if (g) return g;
    const tz = DEFAULT_TZ;
    const since = localMidnightIso(tz);
    const [{ settings }, touches, steps] = await Promise.all([
      loadAutopilot(admin, ws),
      admin.from('ai_agent_actions').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('status', 'done').in('action', ['call_placed', 'sms_sent', 'email_sent', 'rvm_sent']).gte('created_at', since),
      admin.from('ai_agent_actions').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).neq('channel', 'system').gte('created_at', since),
    ]);
    g = { limits: settings.limits, today: { touches: touches.count ?? 0, steps: steps.count ?? 0 }, tz, noted: false };
    spend.set(ws, g);
    return g;
  };
  for (const { id } of (due ?? []) as Any[]) {
    if (Date.now() - started > TICK_BUDGET_MS || tally.looked >= TICK_BATCH) break;
    // The lease: only one tick works a record at a time, and a crashed one frees it after ten minutes.
    const claim = (cols: string) => admin.from('ai_agent_enrollments').update({ claimed_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'active').lte('next_action_at', new Date().toISOString())
      .or(`claimed_at.is.null,claimed_at.lt.${new Date(Date.now() - LEASE_MS).toISOString()}`)
      .select(cols).maybeSingle();
    // With migration 146 the row carries its autopilot program; before it, the plain columns.
    let r = await claim(has146 === false ? ENROLL_COLS : ENROLL_COLS_146);
    if (r.error && lacks146(r.error)) { has146 = false; r = await claim(ENROLL_COLS); }
    const claimed = r.data;
    if (!claimed) continue;
    tally.looked++;
    const e = claimed as Any;
    const g = await spendFor(Number(e.workspace_id));
    const gate = spendCheck(g.limits, g.today);
    if (!gate.ok) {
      // Over the daily ceiling: no Claude call, no text; it waits for tomorrow morning.
      tally.capped++;
      await admin.from('ai_agent_enrollments').update({ claimed_at: null, next_action_at: new Date(nextMorningMs(Date.now(), g.tz)).toISOString() }).eq('id', e.id);
      if (!g.noted) {
        g.noted = true;
        console.log('ai-agent daily limit', { ws: e.workspace_id, ...g.today, limit: gate.outcome });
      }
      continue;
    }
    try {
      const outcome = await work(admin, client, e);
      tally[outcome]++;
      g.today.steps++;
      if (outcome === 'texts' || outcome === 'emails' || outcome === 'calls' || outcome === 'voicemails') g.today.touches++;
    } catch (err) {
      tally.failed++;
      console.error('ai-agent work', e.id, String(err));
      await admin.from('ai_agent_enrollments').update({ claimed_at: null, next_action_at: new Date(Date.now() + 3_600_000).toISOString() }).eq('id', e.id);
      await record(admin, { ws: e.workspace_id, agent: { agent_key: e.agent_key, name: e.agent_key }, enrollmentId: e.id, kind: e.record_kind, id: Number(e.record_id), channel: 'system', action: 'failed', status: 'failed', summary: 'Something went wrong on this step; it will try again in an hour.', detail: { error: String(err).slice(0, 300) }, timeline: false });
    }
  }
  return tally;
}

type Outcome = 'texts' | 'emails' | 'calls' | 'voicemails' | 'waits' | 'finished' | 'stopped' | 'failed' | 'relayed';

/** One enrollment's turn: check, read, decide, act, and set when to look again. */
async function work(admin: SupabaseClient, client: Anthropic | null, e: Any): Promise<Outcome> {
  const ws = Number(e.workspace_id); const kind = e.record_kind as RecordKind; const id = Number(e.record_id);
  const now = Date.now();
  const save = (patch: Record<string, unknown>) => admin.from('ai_agent_enrollments').update({ claimed_at: null, ...patch }).eq('id', e.id);
  const end = async (status: 'stopped' | 'done', reason: string) => { await save({ status, stop_reason: reason, stopped_at: new Date().toISOString(), next_action_at: null }); };

  const agent = await loadAgent(admin, ws, e.agent_key);
  if (!agent) { await end('stopped', 'the agent was deleted'); return 'stopped'; }
  const tag = { agent_key: agent.agent_key, name: agent.name };
  const base = { ws, agent: tag, enrollmentId: Number(e.id), kind, id };
  const tz = tzOf(agent);
  if (agentSwitchedOff({ enabled: agent.enabled, live_version: agent.live_version })) {
    await save({ next_action_at: new Date(now + 6 * 3_600_000).toISOString() });
    await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: 'The agent is switched off in Settings, AI Agent; holding.', timeline: false });
    return 'waits';
  }
  const rec = await loadRecord(admin, admin, ws, kind, id);
  if (!rec) { await end('stopped', 'the record is gone'); return 'stopped'; }
  const channels = cleanChannels(e.channels);
  const reach = reachOf(rec, agent);
  // AI Autopilot (migration 146): the program this enrollment runs, and the speed phase it is in.
  const program = (e.program ?? null) as Program | null;
  const ap = (e.autopilot && typeof e.autopilot === 'object' ? e.autopilot : {}) as Any;
  const el = eligibility({ kind, record: rec, dnc: dncOf(rec), audience: agent.audience, channels, reach });
  if (!el.ok) {
    await end('stopped', el.reason);
    await record(admin, { ...base, channel: 'system', action: 'auto_stopped', summary: `${el.reason}.` });
    return 'stopped';
  }

  // What they said since the agent last looked.
  const col = kind === 'seller' ? 'seller_id' : 'buyer_id';
  const since = e.last_inbound_seen_at ?? e.started_at;
  const { data: inbound } = await admin.from('communications').select('id, channel, body, summary, transcript, occurred_at').eq('workspace_id', ws).eq(col, id)
    .eq('direction', 'inbound').gt('occurred_at', since).order('occurred_at', { ascending: false }).limit(20);
  const replies = (inbound ?? []) as Any[];
  const repliedSince = replies.length > 0 && (!e.last_action_at || replies.some((r) => r.occurred_at > e.last_action_at));
  const seenAt = replies[0]?.occurred_at ?? e.last_inbound_seen_at ?? since;
  if (replies.length) {
    const said = replies.map((r) => String(r.body || r.summary || r.transcript || '')).join('\n');
    await record(admin, { ...base, channel: (replies[0].channel === 'call' ? 'call' : replies[0].channel === 'email' ? 'email' : 'sms'), action: 'reply_seen', summary: `They replied: ${said.replace(/\s+/g, ' ').slice(0, 300)}`, timeline: false });
    if (asksToStop(said)) {
      await applyStop(admin, ws, rec, said, replies[0]?.channel ?? null);
      await end('stopped', 'asked not to be contacted');
      await record(admin, { ...base, channel: 'system', action: 'marked_dnc', summary: `They asked not to be contacted ("${said.replace(/\s+/g, ' ').slice(0, 160)}"). Tagged ${DNC_TAG}; nothing else will go out.` });
      return 'stopped';
    }
  }

  if (program && kind === 'seller') {
    // The stop rules first (booked, not interested, a rep took it, a dead or later stage), then the speed phases.
    const stop = await autopilotStopFor(admin, ws, e, rec, ap);
    if (stop) {
      // A call still waiting to be read gets its verdict on the timeline first.
      const conv = ap.phase === 'await_call' ? ap.conversation_id : ap.review_call?.conversation_id;
      if (conv) {
        const row = await speedCallRow(admin, ws, conv);
        await reviewAndRecord(admin, { ws, e, rec, base, conversationId: conv, answered: callOutcome(row, Date.parse(String(ap.call_at ?? ap.review_call?.at ?? e.last_action_at)), Date.now(), 0) === 'answered' });
      }
      await end(stop.status, stop.reason);
      await save({ last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: stop.status === 'done' ? 'finished' : 'auto_stopped', summary: `AI Autopilot: ${stop.reason}.`, detail: { program } });
      return stop.status === 'done' ? 'finished' : 'stopped';
    }
    // The last autopilot call, read and scored: booked, follow up, nurture, or drop.
    if (ap.review_call && (!ap.phase || ap.phase === 'followup')) {
      const placed = Date.parse(String(ap.review_call.at ?? e.last_action_at));
      const out = callOutcome(await speedCallRow(admin, ws, ap.review_call.conversation_id), placed, Date.now());
      if (out === 'pending') { await save({ next_action_at: new Date(Date.now() + 3 * 60_000).toISOString() }); return 'waits'; }
      const rv = await reviewAndRecord(admin, { ws, e, rec, base, conversationId: ap.review_call.conversation_id ?? null, answered: out === 'answered' });
      const cleared = { ...ap, review_call: null, last_review: rv };
      if (rv.next === 'booked' || rv.next === 'drop') return endReviewed(rv, save, base, seenAt, { autopilot: cleared });
      if (rv.next === 'nurture') { await save({ autopilot: { ...cleared, nurture: true }, ...nurturePatch(e, tzOf(agent)) }); return 'waits'; }
      await save({ autopilot: cleared });
      e.autopilot = cleared;
    }
    // A reply in the middle of the speed phase is answered on the next look, by the follow-up agent.
    if (ap.phase && ap.phase !== 'followup') return await speedPhase(admin, { ws, e, ap, agent, rec, base, save, seenAt: replies.length ? String(e.last_inbound_seen_at ?? e.started_at) : seenAt, channels, replied: replies.length > 0 });
  }

  // The next stage (migration 124): who takes the record when this agent's stage is done.
  const touches = Number(e.touches ?? 0); const maxTouches = Number(e.max_touches ?? MAX_TOUCHES_DEFAULT);
  const target = agent.handoff_to ? handoffTarget(agent, await loadAgents(admin, ws), kind, await relayedFrom(admin, Number(e.id))) : { to: null, why: '' };
  if (target.to && kind === 'seller' && mayQualify(agent, touches)) {
    // Cheap first: the trigger is on and a touch was made; only then read the seller's answers.
    const { data: answers } = await admin.from('sellers').select('motivation, timeline, condition').eq('id', id).eq('workspace_id', ws).maybeSingle();
    if (handoffDue(agent, { trigger: 'qualified', touches, record: answers as Any })) {
      await relay(admin, ws, { ...e, last_inbound_seen_at: seenAt }, agent, target.to, 'qualified: motivation, timeline and condition are on file');
      await save({ last_inbound_seen_at: seenAt, next_action_at: new Date().toISOString() });
      return 'relayed';
    }
  }
  const nextStage: NextStage | null = target.to && handoffDue(agent, { trigger: 'ready', touches })
    ? { agent_key: target.to.agent_key, name: target.to.name, role: ROLE_LABEL[target.to.role] ?? target.to.role.replace(/_/g, ' ') }
    : null;

  const persona = await personaFor(admin, ws, agent, e.started_by ?? rec.assigned_to);
  const history = await historyFor(admin, ws, kind, id);
  let plan = readPlan(e.plan, channels);
  let chat = readChat(e.chat);
  if (!plan.steps.length && !plan.summary) {
    const drafted = await draftPlan(client, { persona, kind, agent, history, chat, mode: e.mode === 'custom' ? 'custom' : 'auto', channels, reach, tz });
    plan = drafted.plan;
    chat = appendChat(chat, { role: 'agent', text: drafted.reply, at: new Date().toISOString() });
    await save({ plan, chat, claimed_at: new Date().toISOString() });
    await record(admin, { ...base, channel: 'plan', action: 'plan_created', summary: planText(plan) });
  }

  const { count: textedBefore } = await admin.from('ai_agent_actions').select('id', { count: 'exact', head: true }).eq('enrollment_id', e.id).eq('action', 'sms_sent').eq('status', 'done');
  let decision: Decision;
  if (!client) {
    decision = { action: 'wait', body: '', subject: '', call_goal: '', next_check_hours: 24, reason: 'the AI model is not configured (ANTHROPIC_API_KEY)' };
  } else {
    const input = await claudeTool(client, deciderSystem(persona, kind, agent.settings, nextStage), DECIDE_TOOL, deciderUser({
      kind, history, plan, instructions: String(e.instructions ?? ''), channels, reach, touches, maxTouches, startedAt: e.started_at, nowMs: now,
      nowLabel: nowLabel(now, tz), repliedSince, firstText: !textedBefore,
    }), 1500);
    decision = parseDecision(input, channels, reach);
    // No AI slop (_shared/no-ai-slop.ts): a drafted text or email with a slop pattern is rewritten once with the findings, then held.
    let slop = decision.action === 'sms' || decision.action === 'email' ? slopFindings(`${decision.subject}\n${decision.body}`) : [];
    if (slop.length) {
      const retry = await claudeTool(client, deciderSystem(persona, kind, agent.settings, nextStage), DECIDE_TOOL, deciderUser({
        kind, history, plan, instructions: String(e.instructions ?? ''), channels, reach, touches, maxTouches, startedAt: e.started_at, nowMs: now,
        nowLabel: nowLabel(now, tz), repliedSince, firstText: !textedBefore,
      }) + `\n\nYour last draft was held and was not sent, it reads like AI slop: ${slopReport(slop)}. Write it again without those.`, 1500);
      decision = parseDecision(retry, channels, reach);
      slop = decision.action === 'sms' || decision.action === 'email' || decision.action === 'rvm' ? slopFindings(`${decision.subject}\n${decision.body}`) : [];
    }
    if (slop.length) {
      // Held, and the reply stays unread (last_inbound_seen_at does not move), so the next look answers it again.
      await save({ next_action_at: nextLookAt(now, 1, tz) });
      await record(admin, { ...base, channel: decision.action === 'email' ? 'email' : 'sms', action: 'skipped', status: 'skipped', summary: `Held a draft that read like AI slop: ${slopReport(slop)}. Trying again in an hour.`, detail: { body: decision.body }, timeline: false });
      return 'waits';
    }
  }
  decision = gateDecision(decision, { nowMs: now, tz, lastActionAt: e.last_action_at, repliedSince, touches, maxTouches });
  if (decision.action === 'rvm' && await rvmRecently(admin, ws, kind, id, now)) decision = { ...decision, action: 'wait', reason: `a voicemail went out in the last ${RVM_GAP_DAYS} days (${decision.reason || 'rvm'})` };
  const next = nextLookAt(now, decision.next_check_hours, tz);
  const sender = e.started_by ?? rec.assigned_to ?? ap.sender ?? null;
  const prog = program ? { program } : {};

  switch (decision.action) {
    case 'wait': {
      await save({ next_action_at: next, last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: `${decision.reason || 'Waiting for the next step.'} Next look ${next}.`, timeline: false });
      return 'waits';
    }
    case 'finish': {
      await end('done', decision.reason || 'the plan is done');
      await save({ last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: 'finished', summary: decision.reason || 'The plan is done.' });
      return 'finished';
    }
    case 'handoff': {
      // The next agent takes it when one is set and the 'ready' trigger is on; otherwise a person does.
      if (nextStage && target.to) {
        await relay(admin, ws, { ...e, chat, last_inbound_seen_at: seenAt }, agent, target.to, decision.reason || 'ready for the next stage');
        await save({ last_inbound_seen_at: seenAt, next_action_at: new Date().toISOString() });
        return 'relayed';
      }
      await end('done', 'handed off to a person');
      await save({ last_inbound_seen_at: seenAt });
      const who = sender;
      // Everything the rep needs to pick up the phone, without opening anything: who, their number,
      // what they actually said, and why the agent thinks they're ready. The notification and the task
      // both carry the record, so a click opens it on the conversation the agent had.
      const lastSaid = String(replies[0]?.body || replies[0]?.summary || '').replace(/\s+/g, ' ').trim();
      const why = decision.reason || 'they replied and want to move forward';
      const phone = rec.phone ? ` · ${prettyPhone(rec.phone)}` : '';
      const note = [
        `${rec.name || 'This ' + kind} is ready to talk${phone}.`,
        lastSaid ? `They said: "${lastSaid.slice(0, 220)}"` : '',
        `${agent.name}: ${why}.`,
        `${agent.name} has stopped; the conversation is on their record.`,
      ].filter(Boolean).join('\n');
      const link = { seller_id: kind === 'seller' ? id : null, buyer_id: kind === 'buyer' ? id : null };
      if (who) await admin.from('notifications').insert({ workspace_id: ws, user_id: who, category: 'AI agent', title: `Call ${rec.name || 'this ' + kind} now${phone} · ${agent.name} handed them to you`.slice(0, 120), body: note.slice(0, 500), ...link });
      await admin.from('tasks').insert({ workspace_id: ws, ...link, title: `Call ${rec.name || 'the ' + kind}${phone}: ${agent.name} says they're ready`.slice(0, 200), task_type: 'call', priority: 'high', due_at: new Date().toISOString(), assigned_to: who, created_by: who, notes: note });
      await emailRep(admin, who, { subject: `Call ${rec.name || 'this ' + kind} now${phone}: ${agent.name} says they're ready`, lines: note.split('\n'), name: rec.name || 'them', phone: rec.phone, kind, id, key: `handoff:${e.id}:${seenAt}` });
      await record(admin, { ...base, channel: 'system', action: 'handoff', summary: note });
      return 'finished';
    }
    case 'sms': {
      const body = textedBefore ? decision.body : withOptOut(decision.body);
      const sent = await textRecipient(admin, { workspace_id: ws, created_by: sender }, { phone: rec.phone, seller_id: kind === 'seller' ? id : null, buyer_id: kind === 'buyer' ? id : null }, body, sender, { contractsLine: false });
      if (!sent.ok) {
        const optedOut = /opted out/.test(sent.reason);
        const patch: Record<string, unknown> = { next_action_at: /quiet hours/.test(sent.reason) ? nextLookAt(now, 1, tz) : nextLookAt(now, 6, tz), last_inbound_seen_at: seenAt };
        // A number that replied STOP to Talkr takes texting off this record for good.
        if (optedOut) patch.channels = channels.filter((c) => c !== 'sms').length ? channels.filter((c) => c !== 'sms') : channels;
        await save(patch);
        await record(admin, { ...base, channel: 'sms', action: 'sms_sent', status: optedOut ? 'skipped' : 'failed', summary: `Text not sent: ${sent.reason}.`, detail: { body } });
        return 'failed';
      }
      await save({ touches: touches + 1, last_action_at: new Date().toISOString(), next_action_at: next, last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'sms', action: 'sms_sent', summary: `"${body}"\n\nWhy: ${decision.reason}`, detail: { body, ...prog }, communicationId: sent.communication_id ?? null });
      return 'texts';
    }
    case 'email': {
      const r = await sendEmail(admin, ws, sender, rec, decision, persona);
      if (!r.ok) {
        await save({ next_action_at: nextLookAt(now, r.retryHours, tz), last_inbound_seen_at: seenAt });
        await record(admin, { ...base, channel: 'email', action: 'email_sent', status: 'failed', summary: `Email not sent: ${r.reason}.`, detail: { subject: decision.subject } });
        return 'failed';
      }
      await save({ touches: touches + 1, last_action_at: new Date().toISOString(), next_action_at: next, last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'email', action: 'email_sent', summary: `Subject: ${decision.subject}\n\n${decision.body}\n\nWhy: ${decision.reason}`, detail: { subject: decision.subject, to: rec.email, ...prog }, communicationId: r.communicationId });
      return 'emails';
    }
    case 'rvm': {
      const r = await dropVoicemail(admin, ws, rec, decision.body, sender);
      if (!r.ok) {
        await save({ next_action_at: nextLookAt(now, 6, tz), last_inbound_seen_at: seenAt });
        await record(admin, { ...base, channel: 'rvm', action: 'rvm_sent', status: 'failed', summary: `Voicemail not queued: ${r.reason}.`, detail: { body: decision.body } });
        return 'failed';
      }
      await save({ touches: touches + 1, last_action_at: new Date().toISOString(), next_action_at: next, last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'rvm', action: 'rvm_sent', summary: `"${decision.body}"\n\nWhy: ${decision.reason}`, detail: { body: decision.body, rvm_drop_id: r.dropId, library_id: r.libraryId, ...prog } });
      return 'voicemails';
    }
    case 'call': {
      const r = await placeCall(admin, ws, agent, rec, decision, persona);
      if (!r.ok) {
        await save({ next_action_at: nextLookAt(now, r.retryHours, tz), last_inbound_seen_at: seenAt });
        await record(admin, { ...base, channel: 'call', action: 'call_placed', status: 'failed', summary: `Call not placed: ${r.reason}.` });
        if (r.stop) { await end('stopped', r.reason); return 'stopped'; }
        return 'failed';
      }
      // An autopilot call is read and scored within minutes of ending (review_call), whatever the plan's next step says.
      const review = program ? { autopilot: { ...ap, review_call: { conversation_id: r.conversationId, at: new Date().toISOString() } }, next_action_at: new Date(Math.min(Date.parse(next), Date.now() + 15 * 60_000)).toISOString() } : {};
      await save({ touches: touches + 1, last_action_at: new Date().toISOString(), next_action_at: next, last_inbound_seen_at: seenAt, ...review });
      await record(admin, { ...base, channel: 'call', action: 'call_placed', summary: `Calling ${rec.phone}: ${decision.call_goal}\n\nWhy: ${decision.reason}`, conversationId: r.conversationId, detail: { goal: decision.call_goal, ...prog, from_number: r.from.phone, from_market: r.from.market } });
      return 'calls';
    }
  }
  return 'waits';
}

/**
 * Someone asked to stop: tag the record DNC (and a buyer's numbers), as the voice agent's mark_do_not_contact does,
 * and record the phone and email in contact_opt_outs (migration 228) so it holds on every record and channel, forever.
 */
async function applyStop(admin: SupabaseClient, ws: number, rec: Rec, said: string, channel: string | null = null) {
  const table = rec.kind === 'seller' ? 'sellers' : 'buyers';
  const tags = withDncTag(rec.tags, hasDnc);
  if (tags) await admin.from(table).update({ tags }).eq('id', rec.id).eq('workspace_id', ws);
  if (rec.kind === 'buyer' && rec.phone) await admin.from('buyer_phones').update({ is_dnc: true }).eq('workspace_id', ws).eq('buyer_id', rec.id).eq('phone_key', rec.phone);
  for (const who of [rec.phone ? { phone_key: rec.phone } : null, rec.email ? { email: rec.email } : null]) {
    if (!who) continue;
    const { error } = await admin.from('contact_opt_outs').insert({ workspace_id: ws, ...who, channel, said: said.slice(0, 500), record_kind: rec.kind, record_id: rec.id });
    if (error && !/duplicate key|23505/.test(error.message) && !missingRelation(error.message)) console.error('ai-agent opt-out', error.message);
  }
  console.log('ai-agent stop request', { ws, kind: rec.kind, id: rec.id, said: said.slice(0, 80) });
}

/**
 * A ringless voicemail: one rvm_drops row with status queued, which the rvm-tick
 * function sends within the minute (the consent gate, the caller ID from the RVM
 * pool and the provider all live there). The newest active recording in the
 * workspace's library for this audience is used; without one the script is
 * spoken. The action-plan enrollment_id stays null: this is an AI agent, not a plan.
 */
async function dropVoicemail(admin: SupabaseClient, ws: number, rec: Rec, script: string, sender: string | null): Promise<{ ok: true; dropId: number; libraryId: number | null } | { ok: false; reason: string }> {
  if (!rec.phone) return { ok: false, reason: 'no phone on file' };
  const text = String(script ?? '').trim().slice(0, 4500);
  if (!text) return { ok: false, reason: 'nothing to say' };
  const audience = rec.kind === 'seller' ? 'sellers' : 'buyers';
  const { data: lib } = await admin.from('vm_library').select('id, audience').eq('workspace_id', ws).eq('active', true).order('created_at', { ascending: false }).limit(50);
  const clip = ((lib ?? []) as Any[]).find((l) => l.audience == null || l.audience === 'both' || l.audience === audience) ?? null;
  const { data: drop, error } = await admin.from('rvm_drops').insert({
    workspace_id: ws, seller_id: rec.kind === 'seller' ? rec.id : null, buyer_id: rec.kind === 'buyer' ? rec.id : null, phone_e164: rec.phone, script: text,
    library_id: clip ? Number(clip.id) : null, variant_group: 'default', status: 'queued', scheduled_at: new Date().toISOString(), created_by: sender,
  }).select('id').maybeSingle();
  if (error || !drop) return { ok: false, reason: error?.message ?? 'no row' };
  return { ok: true, dropId: Number((drop as Any).id), libraryId: clip ? Number(clip.id) : null };
}

/** Did any agent drop a voicemail on this record in the last RVM_GAP_DAYS: one per week per person, whatever the model picks. */
async function rvmRecently(admin: SupabaseClient, ws: number, kind: RecordKind, id: number, nowMs: number): Promise<boolean> {
  const { count } = await admin.from('ai_agent_actions').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('record_kind', kind).eq('record_id', id)
    .eq('action', 'rvm_sent').eq('status', 'done').gte('created_at', new Date(nowMs - RVM_GAP_DAYS * 86_400_000).toISOString());
  return (count ?? 0) > 0;
}

/** An email from the rep's own Gmail, through the mailbox guard as an automated (bulk) send with one-click unsubscribe. */
async function sendEmail(admin: SupabaseClient, ws: number, sender: string | null, rec: Rec, d: Decision, p: Persona): Promise<{ ok: true; communicationId: number | null } | { ok: false; reason: string; retryHours: number }> {
  if (!rec.email) return { ok: false, reason: 'no email on file', retryHours: 24 };
  if (!sender) return { ok: false, reason: 'no rep to send as', retryHours: 24 };
  const { data } = await admin.from('google_accounts').select('id, workspace_id, user_id, email, scopes, calendar_id, status, gmail_send').eq('workspace_id', ws).eq('user_id', sender).eq('status', 'active').limit(1).maybeSingle();
  const account = data as Account | null;
  if (!account || !account.gmail_send || !has(account, SCOPE.gmailSend)) return { ok: false, reason: 'the rep has no Gmail connected with sending on (Settings, Google)', retryHours: 24 };
  const token = await accessFor(admin, account);
  if (!token) return { ok: false, reason: 'Gmail needs reconnecting', retryHours: 24 };
  const claim = await guardSend(admin, account, [rec.email], 'bulk');
  if (!claim.ok) return { ok: false, reason: claim.message, retryHours: claim.code === 'suppressed' ? 24 * 14 : 6 };
  const link = unsubscribeUrl(await unsubscribeToken({ w: ws, e: rec.email, a: account.id }));
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const text = `${d.body}\n\n--\nDon't want these emails? Unsubscribe: ${link}`;
  const html = `${textToHtml(d.body)}<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#71717a;margin-top:24px">Don't want these emails? <a href="${esc(link)}" style="color:#71717a">Unsubscribe</a></p>`;
  const from = `"${`${p.name} · ${p.company}`.replace(/["\r\n<>]/g, '')}" <${account.email}>`;
  const sent = await sendMail(token, {
    to: rec.email, subject: d.subject, html, text, from,
    headers: { 'List-Unsubscribe': `<${link}>, <mailto:${account.email}?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
  if (!sent) { await release(admin, claim.ids); return { ok: false, reason: 'Gmail refused that send', retryHours: 6 }; }
  const messageId = (await messageIdOf(token, sent.id)) ?? `gmail:${sent.id}`;
  const { data: comm } = await admin.from('communications').upsert({
    workspace_id: ws, seller_id: rec.kind === 'seller' ? rec.id : null, buyer_id: rec.kind === 'buyer' ? rec.id : null, rep_id: account.user_id,
    channel: 'email', direction: 'outbound', occurred_at: new Date().toISOString(), subject: d.subject, body: d.body.slice(0, 20_000),
    from_email: account.email.toLowerCase(), to_email: rec.email, status: 'sent', source: 'gmail', source_id: messageId,
  }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
  return { ok: true, communicationId: (comm as Any)?.id ?? null };
}

/**
 * Local presence (migration 150): the ElevenLabs number to call `to` from. The
 * workspace's AI number local to the lead (same area code, else same state),
 * else the agent's own default. Before migration 150, always the default.
 */
async function callerNumberFor(admin: SupabaseClient, ws: number, to: string | null, fallback: string): Promise<{ id: string; market: string | null; phone: string | null }> {
  const { data, error } = await admin.from('voice_agent_numbers').select('market, state, area_code, covers, status, el_phone_number_id, phone_number')
    .eq('workspace_id', ws).eq('status', 'active');
  if (error || !data?.length) return { id: fallback, market: null, phone: null };
  const hit = pickLocalNumber(data as Parameters<typeof pickLocalNumber>[0], to);
  if (hit) return { id: hit.el_phone_number_id, market: hit.market, phone: hit.phone_number };
  // The agent's default: name it too when it is one of the pool's numbers.
  const own = (data as { el_phone_number_id: string | null; market: string; phone_number: string | null }[]).find((r) => r.el_phone_number_id === fallback);
  return { id: fallback, market: own?.market ?? null, phone: own?.phone_number ?? null };
}

/**
 * An outbound call by the agent's ElevenLabs number (SIP trunk), with the
 * same initiation data /personalize would give plus why we are calling. The
 * number is checked like an inbound call: a do-not-engage match stops it.
 * The post-call webhook files the transcript on the record as usual.
 */
async function placeCall(admin: SupabaseClient, ws: number, a: AgentLite, rec: Rec, d: Decision, p: Persona, opts: { leadWindowChecked?: boolean } = {}): Promise<{ ok: true; conversationId: string | null; from: { market: string | null; phone: string | null } } | { ok: false; reason: string; retryHours: number; stop?: boolean }> {
  const apiKey = Deno.env.get('ELEVENLABS_API_KEY');
  if (!apiKey || !a.agent_id || !a.live || !a.live.channels.phone_number_id) return { ok: false, reason: 'the agent has no published ElevenLabs agent and phone number id (Settings, AI Agent, Handling)', retryHours: 24 };
  if (!a.live.channels.outbound) return { ok: false, reason: 'outbound calls are switched off for this agent (Settings, AI Agent, Handling)', retryHours: 24 };
  // AI Autopilot's speed calls are held to 8am to 9pm (or the owner's narrower window) in the LEAD's time zone, any day,
  // checked before this; every other call keeps the agent's own call and quiet hours.
  if (!opts.leadWindowChecked && !outboundAllowedNow(a.live, Date.now())) return { ok: false, reason: 'outside the agent\'s call hours', retryHours: 1 };
  const key = phoneKey(rec.phone);
  if (!rec.phone || !key) return { ok: false, reason: 'no phone number', retryHours: 24 };
  const res = resolveCaller(await loadCandidates(admin, ws, key));
  if (res.status === 'blocked') return { ok: false, reason: 'this number is on a do-not-contact list', retryHours: 24, stop: true };
  const match = res.status === 'one' ? res.match : res.status === 'many' ? res.matches.find((c) => c.kind === rec.kind && c.id === rec.id) : undefined;
  const rn = a.live.rules.compliance.recording_notice;
  const init = await initiationFor(admin, ws, match ? { status: 'one', match } : { status: 'none' }, { direction: 'outbound', ours: '', theirs: key }, {
    agentName: p.name, company: p.company, introduceAs: a.live.identity.introduce_as, recordingNotice: rn.enabled ? rn.text : null,
  }, a.live, d.call_goal);
  try {
    const from = await callerNumberFor(admin, ws, rec.phone, a.live.channels.phone_number_id);
    if (from.market) console.log('ai-agent local presence', { ws, market: from.market });
    const r = await elJson<{ success?: boolean; message?: string; conversation_id?: string | null }>({ apiKey, baseUrl: Deno.env.get('ELEVENLABS_API_BASE') || EL_BASE }, 'POST', '/v1/convai/sip-trunk/outbound-call', {
      agent_id: a.agent_id, agent_phone_number_id: from.id, to_number: rec.phone,
      conversation_initiation_client_data: { dynamic_variables: init.dynamic_variables, conversation_config_override: init.conversation_config_override },
    });
    if (r.success === false) return { ok: false, reason: `ElevenLabs: ${String(r.message ?? 'refused').slice(0, 200)}`, retryHours: 6 };
    return { ok: true, conversationId: r.conversation_id ?? null, from: { market: from.market, phone: from.phone } };
  } catch (e) {
    return { ok: false, reason: e instanceof ElevenError ? `ElevenLabs: ${e.message}` : 'could not reach ElevenLabs', retryHours: 6 };
  }
}

// ---- AI Autopilot (migration 146) -------------------------------------------------------------

/** The workspace's autopilot settings; the defaults (everything off) before migration 146 or a first save. */
async function loadAutopilot(admin: SupabaseClient, ws: number): Promise<{ settings: AutopilotSettings; migrated: boolean; updated_at: string | null }> {
  const { data, error } = await admin.from('ai_autopilot_settings').select('settings, updated_at').eq('workspace_id', ws).maybeSingle();
  if (error) {
    if (lacks146(error)) return { settings: normalizeAutopilot({}), migrated: false, updated_at: null };
    throw error;
  }
  return { settings: normalizeAutopilot((data as Any)?.settings ?? {}), migrated: true, updated_at: (data as Any)?.updated_at ?? null };
}

/** What the speed and reactivation paths need about a seller beyond loadRecord: where it came from, when, the property and its state, the stage. */
async function sellerFacts(admin: SupabaseClient, ws: number, id: number): Promise<{ source: string | null; created_at: string | null; address: string | null; state: string | null; stage: string | null }> {
  const { data } = await admin.from('sellers').select('source, created_at, property_address, lead_stage, property_id').eq('id', id).eq('workspace_id', ws).maybeSingle();
  const r = (data ?? {}) as Any;
  let state: string | null = null;
  let address: string | null = r.property_address ?? null;
  if (r.property_id) {
    const { data: p } = await admin.from('properties').select('line1, city, state').eq('id', r.property_id).maybeSingle();
    state = (p as Any)?.state ?? null;
    address = address || [(p as Any)?.line1, (p as Any)?.city].filter(Boolean).join(', ') || null;
  }
  if (!state && address) state = /,\s*([A-Za-z]{2})\b\s*\d{0,5}\s*$/.exec(address)?.[1] ?? null;
  return { source: r.source ?? null, created_at: r.created_at ?? null, address, state, stage: r.lead_stage ?? null };
}

/** The agent a program uses: the one picked, else the first seller agent with one of these roles, else any seller agent. */
function programAgent(agents: AgentLite[], key: string | null, roles: string[]): AgentLite | null {
  const sellers = agents.filter((a) => audienceServes(a.audience, 'seller'));
  if (key) { const a = sellers.find((x) => x.agent_key === key); if (a) return a; }
  for (const r of roles) { const a = sellers.find((x) => x.role === r); if (a) return a; }
  return sellers[0] ?? null;
}

/** Who texts and emails go out as: the lead's rep, else the member the owner picked, else the workspace owner. */
async function autopilotSender(admin: SupabaseClient, ws: number, s: AutopilotSettings, assigned: string | null): Promise<string | null> {
  if (assigned) return assigned;
  if (s.send_as) return s.send_as;
  const { data } = await admin.from('workspaces').select('owner_id').eq('id', ws).maybeSingle();
  return ((data as Any)?.owner_id ?? null) as string | null;
}

const canCallNow = (a: AgentLite) => a.can_call && !!a.live?.channels.outbound;
const decisionFor = (i: Partial<Decision>): Decision => ({ action: 'wait', body: '', subject: '', call_goal: '', next_check_hours: 24, reason: '', ...i });
const transferOn = (a: AgentLite) => !!a.live && a.live.live_transfer.enabled && a.live.live_transfer.destinations.length > 0;

/** Run `fn` over `items`, at most `n` at a time. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

const SPEED_BATCH = 25;
const SPEED_INFLIGHT = 50;
const SPEED_PARALLEL = 10;

/**
 * Speed to lead: claim the queued new leads (never more than SPEED_INFLIGHT in
 * flight across every run), make each one's first touch, and when the batch was
 * full kick the next run at once so a burst of a hundred drains in seconds.
 */
async function speedRun(admin: SupabaseClient, env: { url: string; serviceKey: string }): Promise<Record<string, number>> {
  const { data, error } = await admin.rpc('ai_autopilot_claim_speed', { p_limit: SPEED_BATCH, p_inflight: SPEED_INFLIGHT });
  if (error) throw error;
  const rows = (data ?? []) as Any[];
  const settings = new Map<number, Promise<AutopilotSettings>>();
  const agents = new Map<number, Promise<AgentLite[]>>();
  const memo = <T,>(m: Map<number, Promise<T>>, ws: number, f: () => Promise<T>) => { if (!m.has(ws)) m.set(ws, f()); return m.get(ws)!; };
  const tally: Record<string, number> = { claimed: rows.length, call: 0, sms: 0, email: 0, waiting: 0, skipped: 0, failed: 0 };
  await pool(rows, SPEED_PARALLEL, async (l) => {
    try {
      const out = await speedOne(admin, l, {
        settings: (ws) => memo(settings, ws, async () => (await loadAutopilot(admin, ws)).settings),
        agents: (ws) => memo(agents, ws, () => loadAgents(admin, ws)),
      });
      tally[out] = (tally[out] ?? 0) + 1;
    } catch (e) {
      tally.failed++;
      console.error('ai-agent speed', l.id, String(e));
      await admin.from('ai_autopilot_leads').update({ status: Number(l.attempts) >= 3 ? 'failed' : 'queued', skip_reason: String(e).slice(0, 300), updated_at: new Date().toISOString() }).eq('id', l.id);
    }
  });
  if (rows.length >= SPEED_BATCH) {
    // More may be waiting: the next run now, not at the next minute.
    EdgeRuntime.waitUntil(fetch(`${env.url}/functions/v1/ai-agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.serviceKey}` }, body: '{"action":"speed"}' }).catch(() => undefined));
  }
  return tally;
}

type SpeedOut = 'call' | 'sms' | 'email' | 'waiting' | 'skipped';

/** One new lead: check it, put it on the agent, and make the first touch. */
async function speedOne(admin: SupabaseClient, l: Any, c: { settings: (ws: number) => Promise<AutopilotSettings>; agents: (ws: number) => Promise<AgentLite[]> }): Promise<SpeedOut> {
  const ws = Number(l.workspace_id); const id = Number(l.seller_id);
  const now = Date.now(); const nowIso = new Date(now).toISOString();
  const mark = (patch: Record<string, unknown>) => admin.from('ai_autopilot_leads').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', l.id);
  const skip = async (reason: string): Promise<SpeedOut> => { await mark({ status: 'skipped', skip_reason: reason.slice(0, 300) }); return 'skipped'; };

  const s = await c.settings(ws);
  const rec = await loadRecord(admin, admin, ws, 'seller', id);
  if (!rec) return skip('the record is gone');
  const f = await sellerFacts(admin, ws, id);
  const { data: ex } = await admin.from('ai_agent_enrollments').select('id, status').eq('workspace_id', ws).eq('record_kind', 'seller').eq('record_id', id).maybeSingle();
  const onAgent = !!ex && ['draft', 'active', 'paused'].includes(String((ex as Any).status));
  const el = speedEligibility(s, { source: f.source, archived_at: rec.archived_at, created_at: f.created_at ?? l.lead_created_at, phone: rec.phone, email: rec.email }, { dnc: dncOf(rec), onAgent, nowMs: now });
  if (!el.ok) return skip(el.reason);
  const agent = programAgent(await c.agents(ws), s.speed.agent_key, ['lead_manager', 'speed_to_lead']);
  if (!agent) return skip('no agent works sellers (Settings, AI Agent)');
  if (agentSwitchedOff({ enabled: agent.enabled, live_version: agent.live_version })) return skip(`${agent.name} is switched off`);

  const tz = leadZone(rec.phone, f.state, tzOf(agent));
  const ft = firstTouch({ nowMs: now, tz, window: s.speed.window, channels: s.speed.channels, canCall: canCallNow(agent), hasPhone: !!rec.phone, hasEmail: !!rec.email, afterHoursText: s.speed.after_hours_text });
  if (!ft.now && !ft.later) return skip(ft.reason);

  const sender = await autopilotSender(admin, ws, s, rec.assigned_to);
  const persona = await personaFor(admin, ws, agent, sender);
  const who = whoOf({ name: rec.name, agent: persona.name, company: persona.company, address: f.address, source: f.source });
  const channels = cleanChannels([...s.speed.channels, ...(s.followup.enabled ? s.followup.channels : [])]);
  const ap: Record<string, unknown> = { phase: 'followup', sender, tz, start_group: sellerStageGroup(String(f.stage ?? '')), source: f.source, lead_created_at: f.created_at ?? l.lead_created_at };
  const row: Record<string, unknown> = {
    workspace_id: ws, record_kind: 'seller', record_id: id, agent_key: agent.agent_key, status: 'active', mode: 'custom', channels,
    plan: cadencePlan('followup', s.followup.cadence_days, s.followup.channels, canCallNow(agent)),
    chat: [{ role: 'agent', text: `AI Autopilot: speed to lead${f.source ? ` (${f.source})` : ''}. ${ft.reason}.`, at: nowIso }],
    instructions: followupInstructions({ source: f.source, reached: false, days: s.followup.cadence_days, rep: persona.rep }),
    touches: 0, max_touches: s.followup.max_touches, last_action_at: null, last_inbound_seen_at: nowIso, stop_reason: null, stopped_at: null, stopped_by: null,
    started_at: nowIso, started_by: null, claimed_at: nowIso, next_action_at: null, program: 'speed', autopilot: ap,
  };
  const { data: saved, error } = ex
    ? await admin.from('ai_agent_enrollments').update(row).eq('id', (ex as Any).id).select('id').maybeSingle()
    : await admin.from('ai_agent_enrollments').insert(row).select('id').maybeSingle();
  if (error) {
    if (/VIP|fund|works|not found/.test(error.message)) return skip(error.message);
    throw error;
  }
  const eid = Number((saved as Any).id);
  try {
    return await speedTouch(admin, { l, s, rec, f, agent, eid, ex: !!ex, now, tz, ft, sender, persona, who, channels, ap, mark });
  } catch (err) {
    // The lead is on the agent already: never leave it stuck. The tick picks it up on the follow-up cadence.
    console.error('ai-agent speed touch', eid, String(err));
    await admin.from('ai_agent_enrollments').update({ claimed_at: null, program: 'followup', autopilot: { ...ap, phase: 'followup' }, next_action_at: new Date(Date.now() + 5 * 60_000).toISOString() }).eq('id', eid);
    await mark({ status: 'enrolled', enrollment_id: eid, agent_key: agent.agent_key, skip_reason: `first touch failed: ${String(err).slice(0, 200)}` });
    return 'waiting';
  }
}

/** The first touch itself, once the lead is on the agent. */
async function speedTouch(admin: SupabaseClient, i: {
  l: Any; s: AutopilotSettings; rec: Rec; f: Awaited<ReturnType<typeof sellerFacts>>; agent: AgentLite; eid: number; ex: boolean; now: number; tz: string;
  ft: ReturnType<typeof firstTouch>; sender: string | null; persona: Persona; who: ReturnType<typeof whoOf>; channels: Channel[]; ap: Record<string, unknown>;
  mark: (patch: Record<string, unknown>) => PromiseLike<unknown>;
}): Promise<SpeedOut> {
  const { l, s, rec, f, agent, eid, now, tz, ft, sender, persona, who, channels, ap, mark } = i;
  const ws = Number(l.workspace_id); const id = rec.id; const nowIso = new Date(now).toISOString();
  if (i.ex) await clearRelayed(admin, eid);
  const base = { ws, agent: { agent_key: agent.agent_key, name: agent.name }, enrollmentId: eid, kind: 'seller' as RecordKind, id };
  const minutesOld = Math.max(0, (now - Date.parse(String(f.created_at ?? l.lead_created_at ?? nowIso))) / 60_000);
  await record(admin, { ...base, channel: 'system', action: 'started', summary: `AI Autopilot speed to lead${f.source ? ` for a ${f.source} lead` : ''}, ${Math.round(minutesOld * 60)} seconds after it came in. ${ft.reason}.`, detail: { program: 'speed', first: ft.now, later: ft.later } });

  const touched = async (channel: 'call' | 'sms' | 'email', patch: Record<string, unknown>): Promise<SpeedOut> => {
    await admin.from('ai_agent_enrollments').update({ claimed_at: null, touches: 1, last_action_at: new Date().toISOString(), ...patch }).eq('id', eid);
    await mark({ status: 'touched', first_touch_at: new Date().toISOString(), first_touch_channel: channel, enrollment_id: eid, agent_key: agent.agent_key });
    return channel;
  };
  const laterPhase = ft.later === 'call' ? 'call_at_open' : ft.later === 'sms' ? 'text_at_open' : 'followup';
  const followupAt = () => nextLookAt(Date.now(), 24, tzOf(agent));

  // A call first when it may go now.
  if (ft.now === 'call') {
    const r = await placeCall(admin, ws, agent, rec, decisionFor({ action: 'call', call_goal: speedCallGoal({ source: f.source, minutesOld, transferOn: transferOn(agent) }) }), persona, { leadWindowChecked: true });
    if (r.ok) {
      await record(admin, { ...base, channel: 'call', action: 'call_placed', summary: `Speed to lead: calling ${rec.phone} ${Math.round(minutesOld * 60)} seconds after the lead came in.`, conversationId: r.conversationId, detail: { program: 'speed', from_number: r.from.phone, from_market: r.from.market } });
      return touched('call', { autopilot: { ...ap, phase: 'await_call', conversation_id: r.conversationId, call_at: new Date().toISOString() }, next_action_at: new Date(Date.now() + s.speed.fallback_minutes * 60_000).toISOString() });
    }
    await record(admin, { ...base, channel: 'call', action: 'call_placed', status: 'failed', summary: `Speed call not placed: ${r.reason}. Texting instead.`, detail: { program: 'speed' } });
  }
  // A text: the first touch, the after-hours one, or the stand-in for a call that could not be placed.
  if ((ft.now === 'sms' || ft.now === 'call') && rec.phone && channels.includes('sms')) {
    const kind = inCallWindow(now, tz, s.speed.window) ? 'first' : 'after_hours';
    if (kind === 'first' || s.speed.after_hours_text) {
      const body = withOptOut(speedText(kind, who));
      const sent = await textRecipient(admin, { workspace_id: ws, created_by: sender }, { phone: rec.phone, seller_id: id }, body, sender, { contractsLine: false });
      if (sent.ok) {
        await record(admin, { ...base, channel: 'sms', action: 'sms_sent', summary: `"${body}"\n\nWhy: speed to lead, ${kind === 'first' ? 'the first touch' : 'after hours; the call follows when the window opens'}.`, detail: { body, program: 'speed' }, communicationId: sent.communication_id ?? null });
        const phase = kind === 'after_hours' && ft.later === 'call' ? 'call_at_open' : 'followup';
        return touched('sms', {
          autopilot: { ...ap, phase, texted: true }, program: phase === 'followup' ? 'followup' : 'speed',
          next_action_at: phase === 'call_at_open' ? new Date(ft.later_at ?? nextWindowOpen(now, tz, s.speed.window)).toISOString() : followupAt(),
        });
      }
      await record(admin, { ...base, channel: 'sms', action: 'sms_sent', status: 'failed', summary: `Speed text not sent: ${sent.reason}.`, detail: { body, program: 'speed' } });
    }
  }
  if (ft.now && rec.email && channels.includes('email')) {
    const m = speedEmail(who, persona.rep);
    const r = await sendEmail(admin, ws, sender, rec, decisionFor({ action: 'email', subject: m.subject, body: m.body }), persona);
    if (r.ok) {
      await record(admin, { ...base, channel: 'email', action: 'email_sent', summary: `Subject: ${m.subject}\n\n${m.body}\n\nWhy: speed to lead.`, detail: { subject: m.subject, to: rec.email, program: 'speed' }, communicationId: r.communicationId });
      return touched('email', { autopilot: { ...ap, phase: laterPhase }, program: laterPhase === 'followup' ? 'followup' : 'speed', next_action_at: ft.later_at ? new Date(ft.later_at).toISOString() : followupAt() });
    }
    await record(admin, { ...base, channel: 'email', action: 'email_sent', status: 'failed', summary: `Speed email not sent: ${r.reason}.`, detail: { program: 'speed' } });
  }
  // Nothing went out now: wait for the window (or hand the lead to the follow-up cadence).
  const at = ft.later_at ?? (ft.later ? nextWindowOpen(now, tz, s.speed.window) : null);
  await admin.from('ai_agent_enrollments').update({ claimed_at: null, autopilot: { ...ap, phase: at ? laterPhase : 'followup' }, program: at ? 'speed' : 'followup', next_action_at: at ? new Date(at).toISOString() : followupAt() }).eq('id', eid);
  await mark({ status: 'enrolled', enrollment_id: eid, agent_key: agent.agent_key, detail: { waiting_for: at ? new Date(at).toISOString() : null } });
  return 'waiting';
}

/**
 * Read one AI call and decide what it came to (reviewCall): the post-call
 * flags, the outcome the agent saved, the seller's timeline. The verdict is a
 * line on the record's timeline ("Call outcome: Warm. Next: follow up on the
 * cadence, because ...") and a call_reviewed row in the ledger.
 */
async function reviewAndRecord(admin: SupabaseClient, i: { ws: number; e: Any; rec: Rec; base: Base; conversationId: string | null; answered: boolean }): Promise<CallReview> {
  const [vc, q, sel] = await Promise.all([
    i.conversationId ? admin.from('voice_agent_calls').select('booked, transferred, dnc_requested, not_interested, outcome').eq('workspace_id', i.ws).eq('conversation_id', i.conversationId).maybeSingle() : Promise.resolve({ data: null }),
    admin.from('ai_agent_actions').select('detail').eq('workspace_id', i.ws).eq('record_kind', 'seller').eq('record_id', i.rec.id).eq('action', 'qualification_saved').gte('created_at', String(i.e.last_action_at ?? i.e.started_at)).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('sellers').select('timeline').eq('id', i.rec.id).eq('workspace_id', i.ws).maybeSingle(),
  ]);
  const v = ((vc as Any).data ?? {}) as Any;
  const rv = reviewCall({
    answered: i.answered, booked: v.booked, transferred: v.transferred, dnc_requested: v.dnc_requested, not_interested: v.not_interested,
    outcome: String((q as Any).data?.detail?.outcome ?? v.outcome ?? ''), timeline: (sel as Any).data?.timeline ?? null,
  });
  await record(admin, { ...i.base, channel: 'call', action: 'call_reviewed', summary: `Call outcome: ${CALL_LABEL[rv.label]}. Next: ${CALL_NEXT[rv.next]}, because ${rv.reason}.`, detail: { ...rv, conversation_id: i.conversationId, program: i.e.program ?? null } });
  return rv;
}

/** A reviewed call that ends the run: booked (done) or dropped (done, or stopped for do-not-contact), with the reason. */
async function endReviewed(rv: CallReview, save: (patch: Record<string, unknown>) => PromiseLike<unknown>, base: Base, seenAt: string, extra: Record<string, unknown> = {}): Promise<Outcome> {
  const reason = rv.next === 'booked' ? `booked: ${rv.reason}` : `dropped: ${rv.reason}`;
  await save({ ...extra, status: rv.label === 'dnc' ? 'stopped' : 'done', stop_reason: reason, stopped_at: new Date().toISOString(), next_action_at: null, last_inbound_seen_at: seenAt });
  void base;
  return rv.label === 'dnc' ? 'stopped' : 'finished';
}

/** Long-term nurture: the next look in about a month, and the agent told to keep it light until then. */
function nurturePatch(e: Any, tz: string): Record<string, unknown> {
  const note = 'Long-term nurture: they are not ready yet. Check in about once a month, short and friendly, until the timeline gets closer.';
  const instructions = String(e.instructions ?? '');
  return { next_action_at: nextLookAt(Date.now(), 24 * 30, tz), instructions: instructions.includes('Long-term nurture') ? instructions : `${instructions}\n${note}`.trim().slice(0, 4000) };
}

/** The ElevenLabs call the speed phase is waiting on, once the post-call webhook has filed it. */
async function speedCallRow(admin: SupabaseClient, ws: number, conversationId: string | null | undefined): Promise<{ duration_s: number | null; status: string | null } | null> {
  if (!conversationId) return null;
  const { data } = await admin.from('communications').select('duration_s, status').eq('workspace_id', ws).eq('source', 'elevenlabs').eq('source_id', `el:${conversationId}`).maybeSingle();
  return (data as Any) ?? null;
}

type Base = { ws: number; agent: { agent_key: string; name: string }; enrollmentId: number; kind: RecordKind; id: number };

/**
 * The speed phases on the tick: waiting on the first call (answered: on to
 * the follow-up; not answered: the fallback text), and the call or text that
 * waited for the calling window to open.
 */
async function speedPhase(admin: SupabaseClient, i: {
  ws: number; e: Any; ap: Any; agent: AgentLite; rec: Rec; channels: Channel[]; seenAt: string; base: Base; replied: boolean;
  save: (patch: Record<string, unknown>) => PromiseLike<unknown>;
}): Promise<Outcome> {
  const { ws, e, ap, agent, rec, base, save } = i;
  const now = Date.now();
  const s = (await loadAutopilot(admin, ws)).settings;
  const f = await sellerFacts(admin, ws, rec.id);
  const tz = String(ap.tz || leadZone(rec.phone, f.state, tzOf(agent)));
  const sender = e.started_by ?? rec.assigned_to ?? ap.sender ?? null;
  const persona = await personaFor(admin, ws, agent, sender);
  const who = whoOf({ name: rec.name, agent: persona.name, company: persona.company, address: f.address, source: f.source });
  const touches = Number(e.touches ?? 0);

  const toFollowup = async (reached: boolean, extra: Record<string, unknown> = {}): Promise<Outcome> => {
    if (!s.followup.enabled) {
      await save({ ...extra, status: 'done', stop_reason: 'speed to lead done; follow-up is off', stopped_at: new Date().toISOString(), next_action_at: null, last_inbound_seen_at: i.seenAt });
      await record(admin, { ...base, channel: 'system', action: 'finished', summary: 'AI Autopilot: speed to lead done. The follow-up cadence is switched off, so the lead is back with the team.', detail: { program: 'speed' } });
      return 'finished';
    }
    const follow = programAgent(await loadAgents(admin, ws), s.followup.agent_key, [agent.role]) ?? agent;
    const patch: Record<string, unknown> = {
      program: 'followup', autopilot: { ...ap, phase: 'followup', reached }, last_inbound_seen_at: i.seenAt,
      instructions: followupInstructions({ source: f.source, reached, days: s.followup.cadence_days, rep: persona.rep }),
      next_action_at: i.replied ? new Date().toISOString() : nextLookAt(Date.now(), 24, tzOf(follow)),
      ...extra,
    };
    if (follow.agent_key !== agent.agent_key) {
      patch.agent_key = follow.agent_key;
      await record(admin, { ...base, channel: 'system', action: 'relayed', summary: `${follow.name} takes over the follow-up cadence.`, detail: { to_agent: follow.agent_key, program: 'followup' } });
      await record(admin, { ...base, agent: { agent_key: follow.agent_key, name: follow.name }, channel: 'system', action: 'took_over', summary: `Follow-up cadence from ${agent.name}.`, detail: { from_agent: agent.agent_key, program: 'followup' }, timeline: false });
    }
    await save(patch);
    return 'waits';
  };

  const text = async (kind: 'first' | 'missed_call'): Promise<Outcome> => {
    if (!rec.phone || !i.channels.includes('sms')) return toFollowup(false);
    if (!inCallWindow(now, tz, s.speed.window) && !s.speed.after_hours_text) {
      await save({ autopilot: { ...ap, phase: 'text_at_open', text_kind: kind }, next_action_at: new Date(nextWindowOpen(now, tz, s.speed.window)).toISOString(), last_inbound_seen_at: i.seenAt });
      return 'waits';
    }
    const { count: before } = await admin.from('ai_agent_actions').select('id', { count: 'exact', head: true }).eq('enrollment_id', e.id).eq('action', 'sms_sent').eq('status', 'done');
    const plain = speedText(kind, who);
    const body = before ? plain : withOptOut(plain);
    const sent = await textRecipient(admin, { workspace_id: ws, created_by: sender }, { phone: rec.phone, seller_id: rec.id }, body, sender, { contractsLine: false });
    if (!sent.ok) {
      await record(admin, { ...base, channel: 'sms', action: 'sms_sent', status: 'failed', summary: `Text not sent: ${sent.reason}.`, detail: { body, program: 'speed' } });
      if (/quiet hours/.test(sent.reason)) {
        await save({ autopilot: { ...ap, phase: 'text_at_open', text_kind: kind }, next_action_at: new Date(nextWindowOpen(now + 60_000, tz, s.speed.window)).toISOString(), last_inbound_seen_at: i.seenAt });
        return 'failed';
      }
      return toFollowup(false);
    }
    await record(admin, { ...base, channel: 'sms', action: 'sms_sent', summary: `"${body}"\n\nWhy: speed to lead, ${kind === 'missed_call' ? 'the call was not answered' : 'the text that waited for the calling window'}.`, detail: { body, program: 'speed' }, communicationId: sent.communication_id ?? null });
    return toFollowup(false, { touches: touches + 1, last_action_at: new Date().toISOString() });
  };

  switch (String(ap.phase)) {
    case 'await_call': {
      const placed = Date.parse(String(ap.call_at ?? e.last_action_at ?? new Date(now).toISOString()));
      const out = callOutcome(await speedCallRow(admin, ws, ap.conversation_id), placed, now);
      if (out === 'pending') { await save({ next_action_at: new Date(now + 2 * 60_000).toISOString(), last_inbound_seen_at: i.seenAt }); return 'waits'; }
      // Read the call, score it, and decide: booked, follow up, long-term nurture, or drop.
      const rv = await reviewAndRecord(admin, { ws, e, rec, base, conversationId: ap.conversation_id ?? null, answered: out === 'answered' });
      if (rv.next === 'booked' || rv.next === 'drop') return endReviewed(rv, save, base, i.seenAt);
      if (rv.next === 'nurture') return toFollowup(true, { autopilot: { ...ap, phase: 'followup', reached: true, nurture: true }, ...nurturePatch(e, tzOf(agent)) });
      if (out === 'answered') return toFollowup(true);
      return ap.texted || i.replied ? toFollowup(false) : text('missed_call');
    }
    case 'call_at_open': {
      if (!inCallWindow(now, tz, s.speed.window)) { await save({ next_action_at: new Date(nextWindowOpen(now, tz, s.speed.window)).toISOString(), last_inbound_seen_at: i.seenAt }); return 'waits'; }
      if (!canCallNow(agent) || !rec.phone || !i.channels.includes('call')) return ap.texted ? toFollowup(false) : text('first');
      const minutesOld = (now - Date.parse(String(ap.lead_created_at ?? e.started_at))) / 60_000;
      const r = await placeCall(admin, ws, agent, rec, decisionFor({ action: 'call', call_goal: speedCallGoal({ source: f.source, minutesOld, transferOn: transferOn(agent) }) }), persona, { leadWindowChecked: true });
      if (!r.ok) {
        await record(admin, { ...base, channel: 'call', action: 'call_placed', status: 'failed', summary: `Call not placed: ${r.reason}.`, detail: { program: 'speed' } });
        return ap.texted ? toFollowup(false) : text('first');
      }
      await record(admin, { ...base, channel: 'call', action: 'call_placed', summary: `Speed to lead: calling ${rec.phone} as the calling window opens.`, conversationId: r.conversationId, detail: { program: 'speed', from_number: r.from.phone, from_market: r.from.market } });
      await save({ autopilot: { ...ap, phase: 'await_call', conversation_id: r.conversationId, call_at: new Date().toISOString() }, touches: touches + 1, last_action_at: new Date().toISOString(), next_action_at: new Date(Date.now() + s.speed.fallback_minutes * 60_000).toISOString(), last_inbound_seen_at: i.seenAt });
      return 'calls';
    }
    case 'text_at_open':
      return text(ap.text_kind === 'missed_call' ? 'missed_call' : 'first');
  }
  return toFollowup(false);
}

/** The autopilot's stop rules for one seller, from what happened since the enrollment started. */
async function autopilotStopFor(admin: SupabaseClient, ws: number, e: Any, rec: Rec, ap: Any): Promise<{ reason: string; status: 'done' | 'stopped' } | null> {
  const since = String(e.started_at);
  const id = rec.id;
  const [sel, appt, vc, qual, outb, mine] = await Promise.all([
    admin.from('sellers').select('lead_stage').eq('id', id).eq('workspace_id', ws).maybeSingle(),
    admin.from('appointments').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('seller_id', id).is('deleted_at', null).gte('created_at', since),
    admin.from('voice_agent_calls').select('not_interested, dnc_requested').eq('workspace_id', ws).eq('seller_id', id).gte('occurred_at', since).limit(50),
    admin.from('ai_agent_actions').select('detail').eq('workspace_id', ws).eq('record_kind', 'seller').eq('record_id', id).eq('action', 'qualification_saved').gte('created_at', since).limit(20),
    admin.from('communications').select('id, direction, source, channel, body').eq('workspace_id', ws).eq('seller_id', id).eq('direction', 'outbound').gt('occurred_at', since).limit(50),
    admin.from('ai_agent_actions').select('communication_id, detail').eq('workspace_id', ws).eq('record_kind', 'seller').eq('record_id', id).in('action', ['sms_sent', 'email_sent', 'call_placed']).gte('created_at', since).limit(200),
  ]);
  const ids = new Set(((mine.data ?? []) as Any[]).map((a) => Number(a.communication_id)).filter((n) => Number.isFinite(n) && n > 0));
  const bodies = new Set(((mine.data ?? []) as Any[]).map((a) => String(a.detail?.body ?? '').trim()).filter(Boolean));
  const notInterested = ((vc.data ?? []) as Any[]).some((c) => c.not_interested || c.dnc_requested)
    || ((qual.data ?? []) as Any[]).some((q) => ['not_interested', 'do_not_contact'].includes(String(q.detail?.outcome ?? '')));
  return autopilotStop({
    booked: (appt.count ?? 0) > 0, dnc: dncOf(rec), archived: !!rec.archived_at, notInterested,
    stageGroup: sellerStageGroup(String((sel.data as Any)?.lead_stage ?? '')), startStageGroup: ap.start_group ?? null,
    humanTouch: ((outb.data ?? []) as Any[]).some((c) => isHumanTouch(c, ids, bodies)),
  });
}

/**
 * Tonight's reactivation, for every workspace that has it on (or one, when an
 * owner presses Run now): aged leads from the picked smart lists, up to the
 * daily cap, each on the reactivation agent with its plan, first looks spread
 * across the sending window.
 */
async function reactivateRun(admin: SupabaseClient, onlyWs: number | null): Promise<Record<string, number>> {
  let q = admin.from('ai_autopilot_settings').select('workspace_id, settings');
  if (onlyWs) q = q.eq('workspace_id', onlyWs);
  const { data, error } = await q;
  if (error) throw error;
  const tally: Record<string, number> = { workspaces: 0, enrolled: 0, skipped: 0 };
  for (const w of (data ?? []) as Any[]) {
    const ws = Number(w.workspace_id);
    const s = normalizeAutopilot(w.settings);
    if (!s.reactivation.enabled || !s.reactivation.lists.length) continue;
    tally.workspaces++;
    const now = Date.now();
    const { count: today } = await admin.from('ai_autopilot_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('program', 'reactivation').gte('queued_at', new Date(now - 20 * 3_600_000).toISOString());
    const room = s.reactivation.daily_cap - (today ?? 0);
    if (room <= 0) continue;
    const { data: cands, error: cErr } = await admin.rpc('ai_autopilot_reactivation_candidates', { p_ws: ws, p_lists: s.reactivation.lists, p_sources: s.reactivation.sources, p_idle_days: s.reactivation.idle_days, p_limit: room * 3 });
    if (cErr) throw cErr;
    const agent = programAgent(await loadAgents(admin, ws), s.reactivation.agent_key, ['reactivation', 'lead_manager']);
    if (!agent) continue;
    const tz = tzOf(agent);
    let n = 0;
    for (const c of (cands ?? []) as Any[]) {
      if (n >= room) break;
      const el = reactivationEligible({ ...c, enrolled: false, reactivated_before: false }, s, { dnc: isDoNotEngage({ tags: c.tags }), nowMs: now });
      if (!el.ok) { tally.skipped++; continue; }
      const { data: lead, error: lErr } = await admin.from('ai_autopilot_leads').insert({ workspace_id: ws, seller_id: c.id, program: 'reactivation', status: 'enrolled', lead_created_at: c.created_at, agent_key: agent.agent_key, detail: { list: el.list, stage: c.lead_stage, last_touch_at: c.last_touch_at } }).select('id').maybeSingle();
      if (lErr || !lead) { tally.skipped++; continue; }
      const sender = await autopilotSender(admin, ws, s, c.assigned_to ?? null);
      const rep = await firstNameOf(admin, sender);
      const nowIso = new Date().toISOString();
      const idleDays = c.last_touch_at ? Math.floor((now - Date.parse(c.last_touch_at)) / 86_400_000) : s.reactivation.idle_days;
      const row: Record<string, unknown> = {
        workspace_id: ws, record_kind: 'seller', record_id: c.id, agent_key: agent.agent_key, status: 'active', mode: 'custom', channels: cleanChannels(s.reactivation.channels),
        plan: cadencePlan('reactivation', REACTIVATION_CADENCE, s.reactivation.channels, canCallNow(agent)),
        chat: [{ role: 'agent', text: `AI Autopilot: reactivation from the ${LIST_LABEL[el.list]} list.`, at: nowIso }],
        instructions: reactivationInstructions({ stage: c.lead_stage, idleDays, rep }), touches: 0, max_touches: s.reactivation.max_touches,
        last_action_at: null, last_inbound_seen_at: nowIso, stop_reason: null, stopped_at: null, stopped_by: null, started_at: nowIso, started_by: null, claimed_at: null,
        next_action_at: firstLookAt(spreadAt(now, n), tz), program: 'reactivation',
        autopilot: { phase: 'followup', sender, start_group: sellerStageGroup(String(c.lead_stage ?? '')), list: el.list, source: c.source },
      };
      const { data: ex } = await admin.from('ai_agent_enrollments').select('id').eq('workspace_id', ws).eq('record_kind', 'seller').eq('record_id', c.id).maybeSingle();
      const { data: saved, error: sErr } = ex
        ? await admin.from('ai_agent_enrollments').update(row).eq('id', (ex as Any).id).select('id').maybeSingle()
        : await admin.from('ai_agent_enrollments').insert(row).select('id').maybeSingle();
      if (sErr || !saved) {
        await admin.from('ai_autopilot_leads').update({ status: 'skipped', skip_reason: String(sErr?.message ?? 'not saved').slice(0, 300) }).eq('id', (lead as Any).id);
        tally.skipped++; continue;
      }
      if (ex) await clearRelayed(admin, Number((saved as Any).id));
      await admin.from('ai_autopilot_leads').update({ enrollment_id: (saved as Any).id }).eq('id', (lead as Any).id);
      await record(admin, { ws, agent: { agent_key: agent.agent_key, name: agent.name }, enrollmentId: Number((saved as Any).id), kind: 'seller', id: Number(c.id), channel: 'system', action: 'started', summary: `AI Autopilot reactivation (${LIST_LABEL[el.list]}${c.lead_stage ? `, ${c.lead_stage}` : ''}): no contact for ${idleDays} days. Re-engage, re-qualify and book.`, detail: { program: 'reactivation', list: el.list } });
      n++; tally.enrolled++;
    }
  }
  return tally;
}

/** Settings, the sources to pick from (with a hint of what each looks like), the agents and members, and today's numbers. */
async function autopilotView(admin: SupabaseClient, ws: number, canEdit: boolean): Promise<Record<string, unknown>> {
  const ap = await loadAutopilot(admin, ws);
  const agents = (await loadAgents(admin, ws)).filter((a) => audienceServes(a.audience, 'seller'));
  const s = ap.settings;
  let sources: { source: string; leads: number; last_at: string | null }[] = [];
  const src = await admin.rpc('ai_autopilot_sources', { p_ws: ws });
  if (!src.error) sources = ((src.data ?? []) as Any[]).map((r) => ({ source: String(r.source), leads: Number(r.leads ?? 0), last_at: r.last_at ?? null }));
  else {
    // Before migration 146: count what the newest sellers say.
    const { data } = await admin.from('sellers').select('source, created_at').eq('workspace_id', ws).not('source', 'is', null).order('created_at', { ascending: false }).limit(5000);
    const by = new Map<string, { leads: number; last_at: string | null }>();
    for (const r of (data ?? []) as Any[]) { const k = String(r.source).trim(); if (!k) continue; const e = by.get(k) ?? { leads: 0, last_at: r.created_at }; e.leads++; by.set(k, e); }
    sources = [...by.entries()].map(([source, v]) => ({ source, ...v }));
  }
  for (const k of [...s.speed.sources, ...s.reactivation.sources]) if (!sources.some((x) => x.source.toLowerCase() === k.toLowerCase())) sources.push({ source: k, leads: 0, last_at: null });
  const { data: members } = await admin.from('workspace_members').select('user_id, role').eq('workspace_id', ws);
  const ids = ((members ?? []) as Any[]).map((m) => m.user_id);
  const { data: profs } = ids.length ? await admin.from('profiles').select('id, full_name, email').in('id', ids) : { data: [] as Any[] };
  const name = new Map(((profs ?? []) as Any[]).map((p) => [p.id, String(p.full_name || p.email || 'Member')]));

  // Today, from local midnight in the first seller agent's zone.
  const tz = agents[0] ? tzOf(agents[0]) : DEFAULT_TZ;
  const midnight = localMidnightIso(tz);
  let today: Record<string, number | null> | null = null;
  let running = 0;
  if (ap.migrated) {
    const [leads, acts, booked, run] = await Promise.all([
      admin.from('ai_autopilot_leads').select('program, status, lead_created_at, first_touch_at').eq('workspace_id', ws).gte('queued_at', midnight).limit(5000),
      admin.from('ai_agent_actions').select('action').eq('workspace_id', ws).eq('status', 'done').in('action', ['call_placed', 'sms_sent', 'email_sent']).gte('created_at', midnight).not('detail->>program', 'is', null).limit(10000),
      admin.from('appointments').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('booked_by', 'ai_agent').gte('created_at', midnight),
      admin.from('ai_agent_enrollments').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('status', 'active').not('program', 'is', null),
    ]);
    const L = (leads.data ?? []) as Any[];
    const A = (acts.data ?? []) as Any[];
    const speed = L.filter((r) => r.program === 'speed');
    today = {
      speed_enrolled: speed.filter((r) => ['touched', 'enrolled'].includes(r.status)).length,
      speed_skipped: speed.filter((r) => r.status === 'skipped').length,
      reactivated: L.filter((r) => r.program === 'reactivation' && r.status === 'enrolled').length,
      calls: A.filter((a) => a.action === 'call_placed').length, texts: A.filter((a) => a.action === 'sms_sent').length, emails: A.filter((a) => a.action === 'email_sent').length,
      booked: booked.error ? null : booked.count ?? 0,
      median_first_touch_s: funnel({ newLeads: 0, speed, touched: new Set(), conversations: new Set(), qualified: new Set(), booked: new Set(), transferred: new Set(), contracts: new Set(), reactivated: new Set() }).median_first_touch_s,
    };
    running = run.count ?? 0;
  }
  return {
    migrated: ap.migrated, can_edit: canEdit, settings: s, updated_at: ap.updated_at,
    sources: sources.map((x) => ({ ...x, kind: sourceKind(x.source), speed: s.speed.sources.some((k) => k.toLowerCase() === x.source.toLowerCase()) })),
    agents: agents.map((a) => agentOut(a)),
    defaults: {
      speed: programAgent(agents, null, ['lead_manager', 'speed_to_lead'])?.agent_key ?? null,
      reactivation: programAgent(agents, null, ['reactivation', 'lead_manager'])?.agent_key ?? null,
    },
    members: ((members ?? []) as Any[]).map((m) => ({ user_id: m.user_id, role: m.role, name: name.get(m.user_id) ?? 'Member' })),
    lists: REACTIVATION_LISTS.map((l) => ({ id: l, label: LIST_LABEL[l] })),
    today, running,
  };
}

function localMidnightIso(tz: string): string {
  const now = Date.now();
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    return new Date(now - ((g('hour') * 60 + g('minute')) * 60 + g('second')) * 1000).toISOString();
  } catch {
    return new Date(now - (now % 86_400_000)).toISOString();
  }
}

/**
 * The AI funnel for the report: new leads → contacted by AI (and the median
 * seconds to the first speed touch) → conversations → qualified →
 * appointments and live transfers → contracts signed, and reactivated leads
 * that replied or booked. Distinct sellers, from tables that already exist;
 * migration 146 adds the speed ledger and the booked-by-AI mark.
 */
async function reportFunnel(admin: SupabaseClient, ws: number, since: string, acts: ActionRow[], calls: Any[], o: { tz: string; days: number }) {
  const seller = (r: { record_kind: string | null; record_id: number | null }) => (r.record_kind === 'seller' && r.record_id != null ? String(r.record_id) : null);
  const setOf = (pick: (r: ActionRow) => boolean) => new Set(acts.filter(pick).map(seller).filter((x): x is string => !!x));
  const touched = setOf((r) => r.status === 'done' && ['sms_sent', 'email_sent', 'call_placed'].includes(r.action));
  const conversations = setOf((r) => r.action === 'reply_seen');
  for (const c of calls) if (c.seller_id && Number(c.duration_s) >= 30) { conversations.add(String(c.seller_id)); touched.add(String(c.seller_id)); }
  const qualified = setOf((r) => r.status === 'done' && ['qualification_saved', 'relayed', 'handoff'].includes(r.action));
  const booked = setOf((r) => r.status === 'done' && r.action === 'appointment_booked');
  const transferred = new Set(calls.filter((c) => c.transferred && c.seller_id).map((c) => String(c.seller_id)));
  for (const c of calls) if (c.booked && c.seller_id) booked.add(String(c.seller_id));

  const [newLeads, speed, appts, react] = await Promise.all([
    admin.from('sellers').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).gte('created_at', since),
    admin.from('ai_autopilot_leads').select('seller_id, lead_created_at, first_touch_at, status').eq('workspace_id', ws).eq('program', 'speed').gte('queued_at', since).limit(20000),
    admin.from('appointments').select('seller_id').eq('workspace_id', ws).eq('booked_by', 'ai_agent').gte('created_at', since).limit(20000),
    admin.from('ai_autopilot_leads').select('seller_id').eq('workspace_id', ws).eq('program', 'reactivation').eq('status', 'enrolled').gte('queued_at', since).limit(20000),
  ]);
  for (const a of (appts.data ?? []) as Any[]) if (a.seller_id) booked.add(String(a.seller_id));

  // Contracts signed by sellers the agents worked: a completed contract in the window, or the stage is under contract or closed.
  const contracts = new Set<string>();
  const worked = [...new Set([...touched, ...booked])].slice(0, 5000);
  for (let i = 0; i < worked.length; i += 400) {
    const chunk = worked.slice(i, i + 400).map(Number);
    const [{ data: ct }, { data: st }] = await Promise.all([
      admin.from('contracts').select('seller_id').eq('workspace_id', ws).eq('status', 'completed').gte('completed_at', since).in('seller_id', chunk),
      admin.from('sellers').select('id, lead_stage').eq('workspace_id', ws).in('id', chunk),
    ]);
    for (const c of (ct ?? []) as Any[]) if (c.seller_id) contracts.add(String(c.seller_id));
    for (const r of (st ?? []) as Any[]) if (['contract', 'closed'].includes(sellerStageGroup(String(r.lead_stage ?? '')))) contracts.add(String(r.id));
  }
  return {
    ...funnel({
      newLeads: newLeads.count ?? 0, speed: (speed.data ?? []) as Any[], touched, conversations, qualified, booked, transferred, contracts,
      reactivated: new Set(((react.data ?? []) as Any[]).map((r) => String(r.seller_id))),
      tz: o.tz, days: o.days, aiCalls: acts.filter((r) => r.status === 'done' && r.action === 'call_placed').length,
    }),
    autopilot: !speed.error,
  };
}
