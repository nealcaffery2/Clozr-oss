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
import { everyRow } from '../_shared/every-row.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { corsFor, fence, jsonWith, rateLimit, serverError, tooMany, UNTRUSTED_RULE } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, cachedSystem, toolRule } from '../_shared/models.ts';
import { recordUsage } from '../_shared/ai-usage.ts';
import { gatherHistory } from '../_shared/lead-memory.ts';
import { historyText } from '../../../lib/lead-memory.ts';
import { BLACKLIST_UNREAD, isDoNotEngage } from '../../../lib/blacklist.ts';
import { textRecipient } from '../_shared/docs-flow.ts';
import { phoneE164 } from '../_shared/docs-people.ts';
import { withOptOut } from '../_shared/sms-compliance.ts';
import { slopFindings, slopReport } from '../_shared/no-ai-slop.ts';
import { SCOPE, accessFor, has, messageIdOf, sendMail, textToHtml, type Account } from '../_shared/google.ts';
import { guardSend, release, unsubscribeToken, unsubscribeUrl } from '../_shared/mailguard.ts';
import { phoneKey, resolveCaller } from '../_shared/voice-agent.ts';
import { initiationFor, loadCandidates, missingRelation } from '../_shared/voice-agent-db.ts';
import { DIAL_FAILURE_LIMIT, DIAL_RETRY_HOURS, agentSwitchedOff, dialFailure, dialFailureStreak, dialedTag, outboundAllowedNow } from '../_shared/voice-agent-calls.ts';
import { cleanText, settingsFromRow, type AgentSettings } from '../_shared/voice-agent-settings.ts';
import { ROLE_LABEL } from '../_shared/voice-agent-prompt.ts';
import { EL_BASE, ElevenError, elJson } from '../_shared/voice-agent-admin.ts';
import { aiCallCap, pickLocalNumber } from '../_shared/agent-lines.ts';
import { DNC_TAG, withDncTag } from '../_shared/voice-agent-tools.ts';
import { hasDnc } from '../../../lib/rvm.ts';
import { emailRep } from '../_shared/rep-alert.ts';
import { alertPause } from '../_shared/send-alert.ts';
import {
  autopilotStop, cadencePlan, callOutcome, reviewCall, CALL_LABEL, CALL_NEXT, type CallReview, firstTouch, followupInstructions, type Funnel, inCallWindow, isHumanTouch, leadZone, nextWindowOpen, normalizeAutopilot,
  reactivationEligible, reactivationInstructions, sourceKind, speedCallGoal, speedEligibility, speedEmail, speedText, spreadAt, whoOf, REACTIVATION_CADENCE,
  nextMorningMs, spendCheck, type AutopilotSettings, type Program, type SpendToday,
} from '../_shared/ai-autopilot.ts';
import { SELLER_STAGES, sellerStageGroup } from '../../../lib/stages.ts';
import { LIST_LABEL, REACTIVATION_LISTS } from '../../../lib/reactivation.ts';
import {
  AVATAR_SYSTEM, AVATAR_TOOL, CHANNELS, DECIDE_TOOL, DEFAULT_TZ, EMPTY_PLAN, MAX_BULK, MAX_TOUCHES_DEFAULT, PLAN_TOOL, RVM_GAP_DAYS,
  activityLine, type AgentReport, appendChat, asksToStop, audienceServes, avatarPrompt, cleanChannels, deciderSystem, deciderUser, eligibility,
  firstLookAt, gateDecision, instructionsFrom, nextLookAt, nowLabel, parseDecision, parsePlan, personaOf, plannerSystem, plannerUser, readChat,
  readPlan, sanitizeSvg, svgDataUri, cleanTriggers, handoffDue, handoffTarget, mayQualify, relayPatch, prettyPhone,
  type Channel, type ChatTurn, type Decision, type HandoffTrigger, type NextStage, type Persona, type Plan, type Reach, type RecordKind,
} from '../_shared/ai-agent.ts';

import {
  BOOKER_NAME, COMPR_DECIDE_TOOL, allShut, DEFAULT_BOOKING_HOURS, isComprWorkspace, DEMO_MINUTES, avatarOf, bookingCheck, channelGate, checkMessage, composeEmail, comprSystemPrompt, demoSlots,
  emailRefusal, emailVerified, findAddress, hotSignal, inboxDailyCap, inboxPauseReason, isComprRole, isOptOut, jitterMinutes, numberPauseReason, parseComprDecision,
  runSummary, shareableReport, spokenSlot, threadSubject,
  type BookingAsk, type ComprAction, type ComprDecision, type Consent, type GateChannel, type MessageCheck, type OfferedSlot, type UsAddress,
} from '../_shared/compr-agent.ts';
import { localDate, type Busy } from '../_shared/voice-agent-tools.ts';
import { dayStartUtc } from '../_shared/deliverability-rules.ts';
import { stateOf } from '../_shared/cold-campaign.ts';
import type { Hours } from '../_shared/voice-agent-settings.ts';
import { lanes, pool } from './pool.ts';
import { LINE_DAILY_CAP, lastLineTo, loadLines, pickLine } from '../plan-tick/lines.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// deno-lint-ignore no-explicit-any
type Any = any;
type Body = Record<string, unknown> & { action?: string; workspace_id?: number | string };

const READ = ['agents', 'status', 'log', 'report', 'autopilot', 'compr_settings'];
const WRITE = ['chat', 'start', 'stop', 'handoff', 'bulk_start', 'bulk_stop', 'generate_avatar', 'set_audience', 'set_handoff', 'set_autopilot', 'run_reactivation', 'test_call', 'set_compr_settings'];
// test_call is any member's (owner call 2026-10-26): it rings the rep's own phone and writes nothing.
const ADMIN_ONLY = ['generate_avatar', 'set_audience', 'set_handoff', 'set_autopilot', 'run_reactivation', 'set_compr_settings'];
const NOT_MIGRATED = 'AI agents are not set up: apply migration 123 (ai_agent_enrollments).';
/** How the agent opens a call (migration 258): a first call, or a follow-up where we know it's them. */
type Contact = 'first' | 'known';
const contactOf = (v: unknown): Contact | null => (v === 'first' || v === 'known' ? v : null);
/** Read on its own so a database without migration 258 still works (null: the agent decides from the history). */
async function readContact(admin: SupabaseClient, enrollmentId: number): Promise<Contact | null> {
  const { data, error } = await admin.from('ai_agent_enrollments').select('contact').eq('id', enrollmentId).maybeSingle();
  return error ? null : contactOf((data as Any)?.contact);
}
/** What the toggle starts on: a follow-up once they have called or texted us, or we have had a real call with them. */
async function suggestedContact(admin: SupabaseClient, ws: number, kind: RecordKind, id: number): Promise<Contact> {
  const { data } = await admin.from('communications').select('id').eq('workspace_id', ws).eq(kind === 'seller' ? 'seller_id' : 'buyer_id', id)
    .or('direction.eq.inbound,duration_s.gte.30').limit(1);
  return (data ?? []).length ? 'known' : 'first';
}

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
  // The text, email or voicemail itself names the agent that sent it (migration
  // 269), so the activity log shows the agent's face on it instead of the rep's.
  const agentKey = i.agent.agent_key;
  if (i.communicationId) await stampAgent(admin, 'communications', i.communicationId, agentKey);
  const dropId = Number(i.detail?.rvm_drop_id);
  if (i.channel === 'rvm' && dropId > 0) await stampAgent(admin, 'rvm_drops', dropId, agentKey);
  if (i.timeline === false) return;
  // A sent text or email is already on the timeline as the message, under the
  // agent; a second "AI agent sent a text" line would only repeat it. The why
  // stays in the agent's own log (ai_agent_actions).
  if (i.communicationId && (i.status ?? 'done') === 'done' && (i.action === 'sms_sent' || i.action === 'email_sent')) return;
  const line = activityLine(i.agent.name, i.status === 'failed' ? 'failed' : i.status === 'skipped' && i.action !== 'stopped' ? 'skipped' : i.action, i.summary, i.actorName);
  const row: Record<string, unknown> = {
    workspace_id: i.ws, entity_type: i.kind, entity_id: i.id, kind: 'ai_agent', title: line.title, body: line.body || null, actor_id: i.actorId ?? null, ai_agent_key: agentKey,
  };
  let { error: aErr } = await admin.from('activity').insert(row);
  if (aErr && /ai_agent_key/.test(aErr.message)) {
    // Before migration 269: keep the line, lose only the agent's face.
    delete row.ai_agent_key;
    ({ error: aErr } = await admin.from('activity').insert(row));
  }
  if (aErr) console.error('ai-agent activity', aErr.message);
}

/** Name the agent on a message or a queued voicemail. Best effort: before migration 269 the column is missing and the row keeps the rep. */
async function stampAgent(admin: SupabaseClient, table: 'communications' | 'rvm_drops', id: number, agentKey: string): Promise<void> {
  const { error } = await admin.from(table).update({ ai_agent_key: agentKey }).eq('id', id);
  if (error && !/ai_agent_key/.test(error.message)) console.error('ai-agent stamp', table, error.message);
}

const planText = (p: Plan) => [p.summary, p.goal ? `Goal: ${p.goal}` : '', ...p.steps.map((s) => `Day ${s.day} · ${s.channel === 'sms' ? 'text' : s.channel === 'rvm' ? 'voicemail' : s.channel}: ${s.purpose}`), p.stop_when ? `Stops when: ${p.stop_when}` : ''].filter(Boolean).join('\n');

/** The history as the model reads it: fenced, because it is what other people wrote. */
async function historyFor(admin: SupabaseClient, ws: number, kind: RecordKind, id: number): Promise<string> {
  const h = await gatherHistory(admin, ws, kind, id);
  return h ? fence('history', historyText(h, 200), 90_000) : '(no history on file)';
}

/**
 * The ai_usage features that are an agent's step on a lead, for the daily
 * ceiling (AI Autopilot, limits): a plan, a decision, a Compr decision. Drawing
 * an avatar is a person's request, not a step.
 */
const STEP_FEATURES = [...new Set([PLAN_TOOL.name, DECIDE_TOOL.name, COMPR_DECIDE_TOOL.name].map((n) => `ai_agent_${n}`))];
/** Step calls this isolate made, by workspace: the tick adds the ones since its count to today's steps. */
const stepCalls = new Map<number, number>();

/** One forced-by-prompt tool call; the tool's input, or null. `ws` files its ai_usage row under the workspace. */
async function claudeTool(client: Anthropic, system: string, tool: { name: string; description: string; input_schema: unknown }, user: string, maxTokens = 1800, ws: number | null = null): Promise<Record<string, unknown> | null> {
  const res = await client.messages.create({
    model: CLAUDE_MODEL, thinking: CLAUDE_THINKING, max_tokens: maxTokens,
    system: cachedSystem(toolRule(tool.name) + system + UNTRUSTED_RULE),
    tools: [tool as unknown as Anthropic.Tool], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: user }],
  });
  const feature = `ai_agent_${tool.name}`;
  if (ws !== null && STEP_FEATURES.includes(feature)) stepCalls.set(ws, (stepCalls.get(ws) ?? 0) + 1);
  await recordUsage(null, { ws, feature, model: res.model, usage: res.usage });
  const use = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === tool.name);
  return use ? use.input as Record<string, unknown> : null;
}

/** Ask the agent for a plan: its reply to the rep and the plan, or a plain fallback when the model is not there. */
async function draftPlan(client: Anthropic | null, i: { ws: number; persona: Persona; kind: RecordKind; agent: AgentLite; history: string; chat: ChatTurn[]; mode: 'auto' | 'custom'; channels: Channel[]; reach: Reach; tz: string }): Promise<{ reply: string; plan: Plan }> {
  if (!client) {
    const plan: Plan = { summary: 'A light follow-up: one touch now, then every few days.', goal: 'Reconnect and set the next step.', stop_when: 'They reply (a person takes over) or the plan runs out.', steps: i.channels.filter((c) => c !== 'call').slice(0, 1).flatMap((c) => [0, 3, 7, 14].map((day) => ({ day, channel: c, purpose: day ? 'Check back in' : 'Reconnect' }))) };
    return { reply: 'The AI model is not configured (ANTHROPIC_API_KEY), so I set a simple follow-up plan. An admin can connect the model for plans written from the history.', plan };
  }
  const input = await claudeTool(client, plannerSystem(i.persona, i.kind, i.agent.settings), PLAN_TOOL, plannerUser({ kind: i.kind, history: i.history, chat: i.chat, mode: i.mode, channels: i.channels, reach: i.reach, nowLabel: nowLabel(Date.now(), i.tz) }), 1800, i.ws);
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
    // The dispo message id is the idempotency key: the tick gives up on this request after 25 s
    // and asks again an hour later, while a slow dial may well have gone through. A call already
    // placed for that message is answered again, not rung again. A failed check holds the call.
    const messageId = Number(body.message_id) || null;
    if (messageId) {
      const { data: placed, error: placedErr } = await admin.from('ai_agent_actions').select('agent_key, conversation_id, detail')
        .eq('workspace_id', ws).eq('record_kind', 'buyer').eq('record_id', buyerId).eq('action', 'call_placed').eq('status', 'done')
        .eq('detail->>message_id', String(messageId)).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (placedErr) return json({ error: `could not check whether this call was already placed: ${placedErr.message}`, retry_hours: 1 }, 503);
      if (placed) {
        const d = (placed.detail ?? {}) as Any;
        return json({ ok: true, agent_key: placed.agent_key, conversation_id: placed.conversation_id ?? null, from: { market: d.from_market ?? null, phone: d.from_number ?? null }, already_placed: true });
      }
    }
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
    if (!r.ok) {
      const stop = !!r.stop || !!r.deadNumber;
      // A busy or dead line goes in the agent's log, so the next campaign's call to this buyer counts it.
      if (r.deadNumber || dialFailure(r.reason)) {
        await record(admin, { ws, agent: { agent_key: agent.agent_key, name: agent.name }, enrollmentId: null, kind: 'buyer', id: buyerId, channel: 'call', action: 'call_placed', status: callStatus(r), summary: `Call not placed: ${r.reason}.` }).catch((e) => console.error('ai-agent deal_call record', String(e)));
        if (r.deadNumber?.justNow) await flagDeadNumber(admin, ws, rec, agent.name, r.deadNumber.phone);
      }
      return json({ error: r.reason, retry_hours: r.retryHours, stop }, stop ? 409 : 503);
    }
    await record(admin, { ws, agent: { agent_key: agent.agent_key, name: agent.name }, enrollmentId: null, kind: 'buyer', id: buyerId, channel: 'call', action: 'call_placed', summary: `Calling ${rec.phone} about deal ${Number(body.deal_id) || ''}: ${goal.slice(0, 300)}`, conversationId: r.conversationId, detail: { goal, message_id: messageId, campaign_id: Number(body.campaign_id) || null, deal_id: Number(body.deal_id) || null, from_number: r.from.phone, from_market: r.from.market } }).catch((e) => console.error('ai-agent deal_call record', String(e)));
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
        const [contact, contactSuggested] = await Promise.all([e ? readContact(admin, Number(e.id)) : Promise.resolve(null), suggestedContact(admin, ws, kind, id)]);
        return json({
          contact, contact_suggested: contactSuggested,
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
          const said = contactOf(body.contact);
          const contactLine = said === 'known' ? "The rep says this is a follow-up: we have talked with them before and know it's them. Do not open as a first contact.\n\n"
            : said === 'first' ? 'The rep says this is a first contact (a new lead or a cold call): they have never talked with us, so the first touch introduces us and why we are reaching out.\n\n' : '';
          const drafted = await draftPlan(anthropic(), { ws, persona, kind, agent, history: contactLine + await historyFor(admin, ws, kind, id), chat, mode, channels, reach: reachOf(rec, agent), tz: tzOf(agent) });
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
        // First call or follow-up, as the rep set it; saved on its own so a database without migration 258 still starts.
        const contact = body.contact === null ? null : contactOf(body.contact);
        if (contact || body.contact === null) {
          const { error: ce } = await admin.from('ai_agent_enrollments').update({ contact }).eq('id', e.id);
          if (ce) console.error('ai-agent contact', ce.message);
        }
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
        const agents = await loadAgents(admin, ws);
        const tz = agents[0] ? tzOf(agents[0]) : DEFAULT_TZ;
        // Counted in SQL (migration 391): the ledger read stopped at PostgREST's 1,000 rows. The seller
        // stages that mean under contract or closed go along so the funnel's contracts match sellerStageGroup.
        const rep = await admin.rpc('ai_agent_report', {
          p_ws: ws, p_since: since, p_tz: tz, p_contract_stages: SELLER_STAGES.filter((s) => ['contract', 'closed'].includes(s.grp)).map((s) => s.label),
        });
        if (rep.error) throw rep.error;
        const R = rep.data as {
          agents: (Omit<AgentReport, 'by_day'> & { by_day: Record<string, number> })[];
          enrollments: { agent_key: string; active: number; total: number; done: number; stopped: number }[];
          voice: { agent_key: string; calls: number; booked: number; transferred: number; seconds: number }[];
          funnel: Omit<Funnel, 'contact_rate' | 'ai_calls_per_day'>;
        };
        // The by-day axis: the last 30 days at most, in the agents' zone, like aggregateActions.
        const dayOf = (ms: number) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); } catch { return new Date(ms).toISOString().slice(0, 10); } };
        const axis: string[] = [];
        for (let i = Math.min(days, 30) - 1; i >= 0; i--) axis.push(dayOf(Date.now() - i * 86_400_000));
        const per = new Map((R.agents ?? []).map((r) => [r.agent_key, { ...r, by_day: axis.map((day) => ({ day, touches: r.by_day?.[day] ?? 0 })) }]));
        const load = new Map((R.enrollments ?? []).map((e) => [e.agent_key, { active: e.active, total: e.total, done: e.done, stopped: e.stopped }]));
        const voice = new Map((R.voice ?? []).map((v) => [v.agent_key, { calls: v.calls, booked: v.booked, transferred: v.transferred, minutes: v.seconds / 60 }]));
        const empty = { texts: 0, emails: 0, calls: 0, voicemails: 0, replies: 0, booked: 0, handoffs: 0, dnc: 0, records_touched: 0, failed: 0, by_day: [] as { day: string; touches: number }[] };
        const f = R.funnel;
        const fun: Funnel & { autopilot: boolean } = {
          ...f,
          contact_rate: f.contacted ? Math.round((f.conversations / f.contacted) * 100) : 0,
          ai_calls_per_day: Math.round((f.ai_calls / Math.max(1, days)) * 10) / 10,
          autopilot: true,
        };
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
          const from = await callerNumberFor(admin, ws, to, agent.live.channels.phone_number_id) ?? { id: agent.live.channels.phone_number_id, market: null, phone: null };
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

      // The Compr demo setter's settings (migration 228): whose calendar, hours, length, postal address, 10DLC, opt-in sources.
      case 'compr_settings': {
        const { data, error } = await admin.from('compr_agent_settings').select('booking_user_id, booking_email, booking_hours, demo_minutes, physical_address, ten_dlc_approved_at, opt_in_sources, updated_at').eq('workspace_id', ws).maybeSingle();
        if (error) return missingRelation(error.message) ? json({ error: COMPR_NOT_MIGRATED }, 503) : (() => { throw error; })();
        return json({ ok: true, settings: data ?? null, defaults: { booking_hours: DEFAULT_BOOKING_HOURS, demo_minutes: DEMO_MINUTES } });
      }

      case 'set_compr_settings': {
        const patch: Record<string, unknown> = { workspace_id: ws, updated_at: new Date().toISOString(), updated_by: userId };
        if (body.booking_user_id !== undefined) {
          const who = body.booking_user_id === null ? null : String(body.booking_user_id);
          if (who) {
            const { data: m } = await admin.from('workspace_members').select('user_id').eq('workspace_id', ws).eq('user_id', who).maybeSingle();
            if (!m) return json({ error: 'The booking calendar has to belong to a member of this workspace.' }, 422);
          }
          patch.booking_user_id = who;
        }
        if (body.booking_hours !== undefined) {
          const h = validHours(body.booking_hours);
          if (!h) return json({ error: 'booking_hours needs days (mon to sun), start and end as HH:MM with start before end, and an IANA tz' }, 422);
          patch.booking_hours = h;
        }
        if (body.demo_minutes !== undefined) {
          const m = Math.round(Number(body.demo_minutes));
          if (!Number.isFinite(m) || m < 10 || m > 60) return json({ error: 'demo_minutes is 10 to 60' }, 422);
          patch.demo_minutes = m;
        }
        if (body.physical_address !== undefined) patch.physical_address = cleanText(body.physical_address, 300) || null;
        if (body.ten_dlc_approved !== undefined) patch.ten_dlc_approved_at = body.ten_dlc_approved ? new Date().toISOString() : null;
        if (body.opt_in_sources !== undefined) {
          patch.opt_in_sources = Array.isArray(body.opt_in_sources) ? [...new Set(body.opt_in_sources.map((x) => cleanText(x, 80).toLowerCase()).filter(Boolean))].slice(0, 50) : [];
        }
        const { data, error } = await admin.from('compr_agent_settings').upsert(patch, { onConflict: 'workspace_id' }).select('booking_user_id, booking_hours, demo_minutes, physical_address, ten_dlc_approved_at, opt_in_sources, updated_at').maybeSingle();
        if (error) return missingRelation(error.message) ? json({ error: COMPR_NOT_MIGRATED }, 503) : (() => { throw error; })();
        return json({ ok: true, settings: data });
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

// More agents per two-minute tick; TICK_BUDGET_MS still ends a long one.
const TICK_BATCH = 36;
const TICK_BUDGET_MS = 110_000;
const LEASE_MS = 10 * 60_000;
/** A rep's or a plan's text or email this recent means the agent stays out of the thread. */
const OTHER_SENDER_QUIET_MS = 2 * 3_600_000;
/** Anthropic's wording when the account is out of credits: not a per-record failure, so no per-record retry. */
const BILLING_REFUSAL = /credit balance|insufficient_quota|billing/i;
const BILLING_HOLD_MS = 6 * 3_600_000;
/** Enrollments worked at once. Each one is still claimed before it is worked; one person's turns share a lane. */
const TICK_PARALLEL = 3;

type Due = { id: number; workspace_id: number; record_kind: RecordKind; record_id: number; agent_key: string };

/**
 * What puts two due enrollments in one lane of the pool: the record, every
 * phone and email it is reached on (a stop on one record blocks a call to the
 * same number on another), and the whole workspace when a Compr setter is due
 * there (it reads its booking calendar, inbox ramp and number hourly count
 * before it acts). One read per table for the batch; a failed read puts
 * everything in one lane, one at a time as before the pool.
 */
async function laneKeys(admin: SupabaseClient, due: Due[]): Promise<(d: Due) => string[]> {
  const idsOf = (k: RecordKind) => [...new Set(due.filter((d) => d.record_kind === k).map((d) => Number(d.record_id)))];
  const sellerIds = idsOf('seller'); const buyerIds = idsOf('buyer');
  const none = Promise.resolve({ data: [] as Any[], error: null });
  const [sellers, buyers, phones, agents] = await Promise.all([
    sellerIds.length ? admin.from('sellers').select('id, phone, email').in('id', sellerIds) : none,
    buyerIds.length ? admin.from('buyers').select('id, phone, email').in('id', buyerIds) : none,
    buyerIds.length ? admin.from('buyer_phones').select('buyer_id, phone').in('buyer_id', buyerIds) : none,
    due.length ? admin.from('voice_agent_settings').select('workspace_id, agent_key, role').in('workspace_id', [...new Set(due.map((d) => Number(d.workspace_id)))]) : none,
  ]);
  const failed = sellers.error ?? buyers.error ?? phones.error ?? agents.error;
  if (failed) {
    console.error('ai-agent lanes', failed.message);
    return () => ['all'];
  }
  const reach = new Map<string, string[]>();
  const add = (rk: string, ...keys: (string | null)[]) => reach.set(rk, [...(reach.get(rk) ?? []), ...keys.filter((k): k is string => !!k)]);
  const phone = (p: unknown) => { const k = phoneKey(String(p ?? '')); return k ? `phone:${k}` : null; };
  const email = (v: unknown) => { const m = String(v ?? '').trim().toLowerCase(); return m ? `email:${m}` : null; };
  for (const r of (sellers.data ?? []) as Any[]) add(`seller:${r.id}`, phone(r.phone), email(r.email));
  for (const r of (buyers.data ?? []) as Any[]) add(`buyer:${r.id}`, phone(r.phone), email(r.email));
  for (const r of (phones.data ?? []) as Any[]) add(`buyer:${r.buyer_id}`, phone(r.phone));
  const compr = new Set(((agents.data ?? []) as Any[]).filter((a) => isComprRole(a.role)).map((a) => `${a.workspace_id}:${a.agent_key}`));
  const comprWs = new Set(due.filter((d) => compr.has(`${d.workspace_id}:${d.agent_key}`)).map((d) => Number(d.workspace_id)));
  return (d) => {
    const rk = `${d.record_kind}:${d.record_id}`;
    return [rk, ...(reach.get(rk) ?? []), ...(comprWs.has(Number(d.workspace_id)) ? [`ws:${d.workspace_id}`] : [])];
  };
}

async function tick(admin: SupabaseClient): Promise<Record<string, number>> {
  const started = Date.now();
  const tally = { looked: 0, texts: 0, emails: 0, calls: 0, voicemails: 0, waits: 0, finished: 0, stopped: 0, failed: 0, relayed: 0, capped: 0 };
  const { data: due, error } = await admin.from('ai_agent_enrollments').select('id, workspace_id, record_kind, record_id, agent_key').eq('status', 'active').lte('next_action_at', new Date().toISOString())
    .order('next_action_at').limit(TICK_BATCH * 2);
  if (error) throw error;
  const client = anthropic();
  // The workspace's daily spend ceiling (AI Autopilot, limits): today's texts, emails, calls and steps.
  // One read per workspace, shared by its lanes; `inflight` is the steps being worked right now, so
  // three at once never pass the ceiling together.
  type Spend = { limits: AutopilotSettings['limits']; today: SpendToday; tz: string; noted: boolean; inflight: number; steps0: number; calls0: number };
  const spend = new Map<number, Promise<Spend>>();
  const spendFor = (ws: number) => {
    let g = spend.get(ws);
    if (!g) {
      g = (async () => {
        // Today starts at midnight in the workspace's zone: the first seller agent's, as the Autopilot screen counts it.
        const agents = await loadAgents(admin, ws);
        const first = agents.find((a) => audienceServes(a.audience, 'seller')) ?? agents[0];
        const tz = first ? tzOf(first) : DEFAULT_TZ;
        const since = localMidnightIso(tz);
        const [{ settings }, touches, steps] = await Promise.all([
          loadAutopilot(admin, ws),
          admin.from('ai_agent_actions').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('status', 'done').in('action', ['call_placed', 'sms_sent', 'email_sent', 'rvm_sent']).gte('created_at', since),
          // A step is a Claude call: each plan or decision files one ai_usage row (migration 425). Ledger
          // rows are not: a reply seen, a scripted speed text or a failed send made no call, and a
          // decision to wait writes a system row.
          admin.from('ai_usage').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).in('feature', STEP_FEATURES).gte('created_at', since),
        ]);
        // A failed count is not a zero: nothing goes out on it.
        if (touches.error) throw new Error(`ai_agent_actions count: ${touches.error.message}`);
        if (steps.error) throw new Error(`ai_usage count: ${steps.error.message}`);
        const steps0 = steps.count ?? 0;
        return { limits: settings.limits, today: { touches: touches.count ?? 0, steps: steps0 }, tz, noted: false, inflight: 0, steps0, calls0: stepCalls.get(ws) ?? 0 };
      })();
      spend.set(ws, g);
    }
    return g;
  };
  /** Let go of a claimed row without working it; it is still due, so the next tick looks again. */
  const free = (id: number) => admin.from('ai_agent_enrollments').update({ claimed_at: null }).eq('id', id);
  const rows = (due ?? []) as Due[];
  /** Set when Anthropic refused for billing: the other lanes stop too, nothing else is worth a call. */
  let halted = false;
  await pool(lanes(rows, await laneKeys(admin, rows)), TICK_PARALLEL, async (lane) => {
    for (const { id } of lane) {
      if (halted || Date.now() - started > TICK_BUDGET_MS || tally.looked >= TICK_BATCH) return;
      // Counted before the claim's await, so the lanes never look at more than TICK_BATCH between them.
      tally.looked++;
      // The lease: only one tick works a record at a time, and a crashed one frees it after ten minutes.
      const claim = (cols: string) => admin.from('ai_agent_enrollments').update({ claimed_at: new Date().toISOString() })
        .eq('id', id).eq('status', 'active').lte('next_action_at', new Date().toISOString())
        .or(`claimed_at.is.null,claimed_at.lt.${new Date(Date.now() - LEASE_MS).toISOString()}`)
        .select(cols).maybeSingle();
      // With migration 146 the row carries its autopilot program; before it, the plain columns.
      let r = await claim(has146 === false ? ENROLL_COLS : ENROLL_COLS_146);
      if (r.error && lacks146(r.error)) { has146 = false; r = await claim(ENROLL_COLS); }
      const claimed = r.data;
      if (!claimed) { tally.looked--; continue; }
      const e = claimed as Any;
      let g: Spend;
      try {
        g = await spendFor(Number(e.workspace_id));
      } catch (err) {
        tally.failed++;
        console.error('ai-agent daily limit read', e.workspace_id, String(err));
        await free(e.id);
        continue;
      }
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
      if (!spendCheck(g.limits, { touches: g.today.touches + g.inflight, steps: g.today.steps + g.inflight }).ok) {
        // At the ceiling only if every step in flight sends: hold it, and the next tick decides on the real count.
        tally.capped++;
        await free(e.id);
        continue;
      }
      g.inflight++;
      try {
        const outcome = await work(admin, client, e);
        tally[outcome]++;
        // The Claude calls made since the count, by every lane of this workspace: a wait decided without one is not a step.
        g.today.steps = g.steps0 + (stepCalls.get(Number(e.workspace_id)) ?? 0) - g.calls0;
        if (outcome === 'texts' || outcome === 'emails' || outcome === 'calls' || outcome === 'voicemails') g.today.touches++;
      } catch (err) {
        tally.failed++;
        console.error('ai-agent work', e.id, String(err));
        if (BILLING_REFUSAL.test(String(err))) {
          // Anthropic refused for money, not for this record. Hold every agent in the workspace for six hours
          // instead of letting each enrollment retry on the hour (208 failed looks in three days on Compr).
          halted = true;
          const hold = new Date(Date.now() + BILLING_HOLD_MS).toISOString();
          await admin.from('ai_agent_enrollments').update({ claimed_at: null, next_action_at: hold }).eq('workspace_id', e.workspace_id).eq('status', 'active');
          await record(admin, { ws: e.workspace_id, agent: { agent_key: e.agent_key, name: e.agent_key }, enrollmentId: e.id, kind: e.record_kind, id: Number(e.record_id), channel: 'system', action: 'failed', status: 'failed', summary: 'Anthropic refused the request: the API credit balance is too low. Every agent in this workspace is holding for six hours. Add credits at console.anthropic.com.', detail: { error: String(err).slice(0, 300) }, timeline: false });
          return;
        }
        await admin.from('ai_agent_enrollments').update({ claimed_at: null, next_action_at: new Date(Date.now() + 3_600_000).toISOString() }).eq('id', e.id);
        await record(admin, { ws: e.workspace_id, agent: { agent_key: e.agent_key, name: e.agent_key }, enrollmentId: e.id, kind: e.record_kind, id: Number(e.record_id), channel: 'system', action: 'failed', status: 'failed', summary: 'Something went wrong on this step; it will try again in an hour.', detail: { error: String(err).slice(0, 300) }, timeline: false });
      } finally {
        g.inflight--;
      }
    }
  });
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
    if (asksToStop(said) || (isComprRole(agent.role) && isOptOut(said))) {
      await applyStop(admin, ws, rec, said, replies[0]?.channel ?? null);
      await end('stopped', 'asked not to be contacted');
      await record(admin, { ...base, channel: 'system', action: 'marked_dnc', summary: `They asked not to be contacted ("${said.replace(/\s+/g, ' ').slice(0, 160)}"). Tagged ${DNC_TAG}; nothing else will go out.` });
      return 'stopped';
    }
  }

  // Someone else is already talking to them: a text or email on this record in the last two hours that no
  // agent sent (a rep typing in the inbox, or a plan step). The agent stays out of that thread rather than
  // answering beside them; it looks again once the thread has been quiet for two hours.
  const { data: other } = await admin.from('communications').select('id').eq('workspace_id', ws).eq(col, id).eq('direction', 'outbound')
    .in('channel', ['sms', 'email']).is('ai_agent_key', null).gt('occurred_at', new Date(now - OTHER_SENDER_QUIET_MS).toISOString()).limit(1);
  if ((other ?? []).length) {
    await save({ next_action_at: new Date(now + OTHER_SENDER_QUIET_MS).toISOString() });
    await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: 'A teammate or a plan texted or emailed them in the last two hours; staying out of that thread.', timeline: false });
    return 'waits';
  }

  // The Compr demo setter has its own turn: run the address, offer two times, book, or hand a hot lead to Alex.
  if (isComprRole(agent.role)) return await comprWork(admin, client, { e, ws, id, agent, rec, base, save, end, replies, repliedSince, seenAt, channels, reach, now });

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

  // Inside the 20-hour gap, or outside 9am to 8pm, with nothing new to answer: the model could only say wait,
  // and it would be sent the whole history to say it. Decide that here, with no call.
  if (!repliedSince) {
    const early = gateDecision({ action: 'sms', body: '', subject: '', call_goal: '', next_check_hours: 1, reason: '' }, { nowMs: now, tz, lastActionAt: e.last_action_at, repliedSince, touches, maxTouches });
    if (early.action === 'wait') {
      await save({ next_action_at: nextLookAt(now, early.next_check_hours, tz), last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: `Holding: ${early.reason}.`, timeline: false });
      return 'waits';
    }
    // At the touch cap any touch the model chose would be gated to finish, so finish here without the call.
    // With a next stage set the model still decides, since it may hand the record on instead.
    if (early.action === 'finish' && !nextStage) {
      await end('done', early.reason);
      await save({ last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: 'finished', summary: early.reason });
      return 'finished';
    }
  }

  const persona = await personaFor(admin, ws, agent, e.started_by ?? rec.assigned_to);
  const history = await historyFor(admin, ws, kind, id);
  let plan = readPlan(e.plan, channels);
  let chat = readChat(e.chat);
  if (!plan.steps.length && !plan.summary) {
    const drafted = await draftPlan(client, { ws, persona, kind, agent, history, chat, mode: e.mode === 'custom' ? 'custom' : 'auto', channels, reach, tz });
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
    }), 1500, ws);
    decision = parseDecision(input, channels, reach);
    // No AI slop (_shared/no-ai-slop.ts): a drafted text or email with a slop pattern is rewritten once with the findings, then held.
    let slop = decision.action === 'sms' || decision.action === 'email' ? slopFindings(`${decision.subject}\n${decision.body}`) : [];
    if (slop.length) {
      const retry = await claudeTool(client, deciderSystem(persona, kind, agent.settings, nextStage), DECIDE_TOOL, deciderUser({
        kind, history, plan, instructions: String(e.instructions ?? ''), channels, reach, touches, maxTouches, startedAt: e.started_at, nowMs: now,
        nowLabel: nowLabel(now, tz), repliedSince, firstText: !textedBefore,
      }) + `\n\nYour last draft was held and was not sent, it reads like AI slop: ${slopReport(slop)}. Write it again without those.`, 1500, ws);
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
      if (!(await isComprWorkspace(admin, ws))) await admin.from('tasks').insert({ workspace_id: ws, ...link, title: `Call ${rec.name || 'the ' + kind}${phone}: ${agent.name} says they're ready`.slice(0, 200), task_type: 'call', priority: 'high', due_at: new Date().toISOString(), assigned_to: who, created_by: who, notes: note });
      await emailRep(admin, who, { subject: `Call ${rec.name || 'this ' + kind} now${phone}: ${agent.name} says they're ready`, lines: note.split('\n'), name: rec.name || 'them', phone: rec.phone, kind, id, key: `handoff:${e.id}:${seenAt}` });
      await record(admin, { ...base, channel: 'system', action: 'handoff', summary: note });
      return 'finished';
    }
    case 'sms': {
      const body = textedBefore ? decision.body : withOptOut(decision.body);
      const sent = await textRecipient(admin, { workspace_id: ws, created_by: sender }, { phone: rec.phone, seller_id: kind === 'seller' ? id : null, buyer_id: kind === 'buyer' ? id : null }, body, sender, { contractsLine: false, fromPhoneNumberId: await aiTextLine(admin, ws, sender, kind, id, rec.phone) });
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
      const r = await placeCall(admin, ws, agent, rec, decision, persona, { contact: await readContact(admin, Number(e.id)) });
      if (!r.ok) {
        await record(admin, { ...base, channel: 'call', action: 'call_placed', status: callStatus(r), summary: `Call not placed: ${r.reason}.` });
        if (r.stop) { await save({ last_inbound_seen_at: seenAt }); await end('stopped', r.reason); return 'stopped'; }
        if (r.deadNumber) {
          // The number is done: calls come off this record and the agent keeps going on what is left, or stops when nothing is.
          await flagDeadNumber(admin, ws, rec, agent.name, r.deadNumber.phone);
          const rest = channels.filter((c) => c !== 'call');
          if (!rest.length) { await save({ last_inbound_seen_at: seenAt }); await end('stopped', r.reason); return 'stopped'; }
          await save({ channels: rest, next_action_at: nextLookAt(now, 1, tz), last_inbound_seen_at: seenAt });
          return 'failed';
        }
        await save({ next_action_at: nextLookAt(now, r.retryHours, tz), last_inbound_seen_at: seenAt });
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
  const { data } = await admin.from('google_accounts').select('id, workspace_id, user_id, email, scopes, calendar_id, status, gmail_send').eq('workspace_id', ws).eq('user_id', sender).eq('shared', false).eq('status', 'active').limit(1).maybeSingle();
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
 * else the agent's own default, among the numbers still under today's call cap
 * (aiCallCap); another number under the cap when those are full. Null when
 * every number has made its calls for the day. Before migration 150, always
 * the default.
 */
async function callerNumberFor(admin: SupabaseClient, ws: number, to: string | null, fallback: string): Promise<{ id: string; market: string | null; phone: string | null } | null> {
  const { data, error } = await admin.from('voice_agent_numbers').select('market, state, area_code, covers, status, el_phone_number_id, phone_number, created_at')
    .eq('workspace_id', ws).eq('status', 'active');
  if (error || !data?.length) return { id: fallback, market: null, phone: null };
  type PoolRow = Parameters<typeof pickLocalNumber>[0][number] & { created_at: string | null };
  const pool = data as PoolRow[];
  const phones = pool.map((r) => r.phone_number).filter((p): p is string => !!p);
  const used = new Map<string, number>();
  if (phones.length) {
    const calls = await everyRow<{ from_phone: string }>(() => admin.from('communications').select('from_phone').eq('channel', 'call').eq('direction', 'outbound')
      .in('from_phone', phones).gte('occurred_at', new Date(Date.now() - 86_400_000).toISOString()).order('id')).catch(() => [] as { from_phone: string }[]);
    for (const c of calls) used.set(c.from_phone, (used.get(c.from_phone) ?? 0) + 1);
  }
  const open = pool.filter((r) => !r.phone_number || (used.get(r.phone_number) ?? 0) < aiCallCap(r.created_at));
  const hit = pickLocalNumber(open, to);
  if (hit) return { id: hit.el_phone_number_id, market: hit.market, phone: hit.phone_number };
  // The agent's default: name it too when it is one of the pool's numbers.
  const own = pool.find((r) => r.el_phone_number_id === fallback);
  if (!own || open.includes(own)) return { id: fallback, market: own?.market ?? null, phone: own?.phone_number ?? null };
  const spare = open.find((r) => r.status === 'active' && r.el_phone_number_id);
  return spare ? { id: spare.el_phone_number_id!, market: spare.market, phone: spare.phone_number } : null;
}

/**
 * An outbound call by the agent's ElevenLabs number (SIP trunk), with the
 * same initiation data /personalize would give plus why we are calling. The
 * number is checked like an inbound call: a do-not-engage match stops it.
 * The post-call webhook files the transcript on the record as usual.
 * A number that was busy or never answered by the carrier DIAL_FAILURE_LIMIT
 * times in a row is not dialled again: `deadNumber` says so (`justNow` on the
 * attempt that reached the limit), and a busy or dead line waits a day, not six
 * hours, between tries.
 */
async function placeCall(admin: SupabaseClient, ws: number, a: AgentLite, rec: Rec, d: Decision, p: Persona, opts: { leadWindowChecked?: boolean; contact?: Contact | null } = {}): Promise<{ ok: true; conversationId: string | null; from: { market: string | null; phone: string | null } } | { ok: false; reason: string; retryHours: number; stop?: boolean; deadNumber?: DeadNumber }> {
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
  const streak = await dialStreak(admin, ws, rec, key);
  if (streak >= DIAL_FAILURE_LIMIT) return { ok: false, reason: deadNumberReason(rec.phone, streak), retryHours: 24 * 7, deadNumber: { phone: rec.phone, justNow: false } };
  const match = res.status === 'one' ? res.match : res.status === 'many' ? res.matches.find((c) => c.kind === rec.kind && c.id === rec.id) : undefined;
  const rn = a.live.rules.compliance.recording_notice;
  const init = await initiationFor(admin, ws, match ? { status: 'one', match } : { status: 'none' }, { direction: 'outbound', ours: '', theirs: key }, {
    agentName: p.name, company: p.company, introduceAs: a.live.identity.introduce_as, recordingNotice: rn.enabled ? rn.text : null,
    ...(opts.contact ? { contact: opts.contact } : {}),
  }, a.live, d.call_goal);
  try {
    const from = await callerNumberFor(admin, ws, rec.phone, a.live.channels.phone_number_id);
    if (!from) return { ok: false, reason: 'every AI number has made its calls for today; more would get them flagged as spam', retryHours: 12 };
    if (from.market) console.log('ai-agent local presence', { ws, market: from.market });
    const r = await elJson<{ success?: boolean; message?: string; conversation_id?: string | null }>({ apiKey, baseUrl: Deno.env.get('ELEVENLABS_API_BASE') || EL_BASE }, 'POST', '/v1/convai/sip-trunk/outbound-call', {
      agent_id: a.agent_id, agent_phone_number_id: from.id, to_number: rec.phone,
      conversation_initiation_client_data: { dynamic_variables: init.dynamic_variables, conversation_config_override: init.conversation_config_override },
    });
    if (r.success === false) return dialRefused(`ElevenLabs: ${String(r.message ?? 'refused').slice(0, 200)}`, rec.phone, key, streak);
    return { ok: true, conversationId: r.conversation_id ?? null, from: { market: from.market, phone: from.phone } };
  } catch (e) {
    return dialRefused(e instanceof ElevenError ? `ElevenLabs: ${e.message}` : 'could not reach ElevenLabs', rec.phone, key, streak);
  }
}

type DeadNumber = { phone: string; justNow: boolean };

/** Dial failures in a row on this record's number (voice-agent-calls dialFailureStreak). */
async function dialStreak(admin: SupabaseClient, ws: number, rec: Rec, key: string): Promise<number> {
  const { data } = await admin.from('ai_agent_actions').select('status, summary').eq('workspace_id', ws).eq('record_kind', rec.kind).eq('record_id', rec.id)
    .eq('channel', 'call').eq('action', 'call_placed').order('created_at', { ascending: false }).limit(20);
  return dialFailureStreak((data ?? []) as { status: string; summary: string | null }[], key);
}

// Worded so dialFailure() does not read it as one more failed dial.
const deadNumberReason = (phone: string, n: number) =>
  `${phone} did not connect on the last ${n} tries, so the agent stopped calling it; a rep should check the number`;

/** A call that was refused before dialling (the number is already done) is logged as skipped, so it does not count as another try. */
const callStatus = (r: { deadNumber?: DeadNumber }): 'failed' | 'skipped' => (r.deadNumber && !r.deadNumber.justNow ? 'skipped' : 'failed');

/** Tells the record's rep, once, that the agent gave up on a number: a call task to check it, and the bell. */
async function flagDeadNumber(admin: SupabaseClient, ws: number, rec: Rec, agentName: string, phone: string): Promise<void> {
  const who = rec.assigned_to;
  const link = { seller_id: rec.kind === 'seller' ? rec.id : null, buyer_id: rec.kind === 'buyer' ? rec.id : null };
  const name = rec.name || `this ${rec.kind}`;
  const title = `Check ${name}'s number ${phone}: ${agentName} could not get through`.slice(0, 200);
  const note = [
    `${agentName} called ${phone} ${DIAL_FAILURE_LIMIT} times in a row and it never connected. The line refused the call or the carrier never put it through, which usually means a call blocker, a disconnected line or a wrong number.`,
    `Find a better number or email and update the record. Once the number is fixed, turn calls back on for ${agentName} on this record.`,
  ].join('\n');
  const { error } = await isComprWorkspace(admin, ws) ? { error: null }
    : await admin.from('tasks').insert({ workspace_id: ws, ...link, title, task_type: 'call', priority: 'high', due_at: new Date().toISOString(), assigned_to: who, created_by: who, notes: note });
  if (error) console.error('ai-agent dead number task', error.message);
  if (who) await admin.from('notifications').insert({ workspace_id: ws, user_id: who, category: 'AI agent', title: title.slice(0, 120), body: note.slice(0, 500), ...link });
}

/** A failed dial. A busy or dead line is tagged with the number and waits a day; the try that reaches the limit says the number is done. */
function dialRefused(reason: string, phone: string, key: string, prior: number): { ok: false; reason: string; retryHours: number; deadNumber?: DeadNumber } {
  if (!dialFailure(reason)) return { ok: false, reason, retryHours: 6 };
  const tagged = `${reason} ${dialedTag(key)}`;
  if (prior + 1 < DIAL_FAILURE_LIMIT) return { ok: false, reason: tagged, retryHours: DIAL_RETRY_HOURS };
  return { ok: false, reason: `${tagged}. ${deadNumberReason(phone, prior + 1)}`, retryHours: 24 * 7, deadNumber: { phone, justNow: true } };
}

// ---- Compr demo setter (migration 228, docs/compr-agent.md) -------------------------------------
//
// The agent with role compr_demo_setter does not follow a drafted plan: every
// look it reads what they said, runs their address when they give one, offers
// two times from the booking person's calendar (Alex), books once it has a
// time, a name, an email and a deal, and hands a hot lead to Alex at once.
// Every message goes through checkMessage and every touch through channelGate
// (compr-agent.ts) before anything is sent.

const COMPR_NOT_MIGRATED = 'The Compr agent is not set up: apply migration 228 (compr_agent).';
const COMPR_UNDERWRITE_URL = 'https://underwriting.example.com/api/v1/underwrite';
/** Runs of their own addresses per enrollment. The first run on the site is free; this is a taste, not a free plan. */
const COMPR_MAX_RUNS = 2;

type ComprSettings = {
  migrated: boolean; bookingUserId: string | null; hours: Hours; minutes: number; physicalAddress: string;
  tenDlcApproved: boolean; optInSources: string[];
  /** The owner took on reaching cold numbers (compr_agent_settings.outreach_without_consent_at). */
  outreachWithoutConsent: boolean;
};

const validHours = (v: unknown): Hours | null => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const days = Array.isArray(o.days) ? o.days.map((d) => String(d).toLowerCase()).filter((d) => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(d)) : [];
  const hm = (x: unknown) => (typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : null);
  const tz = typeof o.tz === 'string' && o.tz ? o.tz : null;
  try { if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return null; }
  const start = hm(o.start); const end = hm(o.end);
  return days.length && start && end && tz && start < end ? { days, start, end, tz } : null;
};

async function comprSettings(admin: SupabaseClient, ws: number): Promise<ComprSettings> {
  const { data, error } = await admin.from('compr_agent_settings')
    .select('booking_user_id, booking_hours, demo_minutes, physical_address, ten_dlc_approved_at, opt_in_sources, outreach_without_consent_at').eq('workspace_id', ws).maybeSingle();
  const r = (data ?? {}) as Any;
  return {
    migrated: !error || !missingRelation(error.message),
    bookingUserId: r.booking_user_id ?? null,
    hours: validHours(r.booking_hours) ?? DEFAULT_BOOKING_HOURS,
    minutes: Number(r.demo_minutes) || DEMO_MINUTES,
    physicalAddress: String(r.physical_address ?? '').trim(),
    tenDlcApproved: !!r.ten_dlc_approved_at,
    optInSources: Array.isArray(r.opt_in_sources) ? r.opt_in_sources.map((x: unknown) => String(x).toLowerCase()) : [],
    outreachWithoutConsent: !!r.outreach_without_consent_at,
  };
}

/** What the gate needs about the person: where they are, whether they asked to hear from us or replied, and whether the email is verified. */
async function comprFacts(admin: SupabaseClient, ws: number, rec: Rec, optInSources: string[], ownerOverride = false) {
  const { data } = await admin.from('buyers').select('markets, source, opted_in_at, email_safe_to_send, email_status').eq('id', rec.id).eq('workspace_id', ws).maybeSingle();
  const b = (data ?? {}) as Any;
  const { count: inbound } = await admin.from('communications').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('buyer_id', rec.id).eq('direction', 'inbound');
  const source = String(b.source ?? '').toLowerCase();
  return {
    state: stateOf(null, b.markets ?? null),
    consent: { optedIn: !!b.opted_in_at || (!!source && optInSources.includes(source)), replied: (inbound ?? 0) > 0, ownerOverride } as Consent,
    emailVerified: emailVerified(b),
  };
}

/** Did this phone or email ever opt out in this workspace (contact_opt_outs), on any record. */
async function optedOutAnywhere(admin: SupabaseClient, ws: number, rec: Rec): Promise<boolean> {
  const checks = [
    rec.phone ? admin.from('contact_opt_outs').select('id').eq('workspace_id', ws).eq('phone_key', rec.phone).limit(1) : null,
    rec.email ? admin.from('contact_opt_outs').select('id').eq('workspace_id', ws).eq('email', rec.email).limit(1) : null,
  ].filter(Boolean);
  for (const q of await Promise.all(checks)) if ((q as Any)?.data?.length) return true;
  return false;
}

/** The booking person's appointments (Clozr's and their synced Google events) around the next ten days. */
async function busyFor(admin: SupabaseClient, ws: number, userId: string): Promise<Busy[]> {
  const now = Date.now();
  const { data } = await admin.from('appointments').select('starts_at, ends_at').eq('workspace_id', ws).eq('assigned_to', userId).is('deleted_at', null)
    .gte('starts_at', new Date(now - 86_400_000).toISOString()).lte('starts_at', new Date(now + 11 * 86_400_000).toISOString()).limit(2000);
  return ((data ?? []) as Any[]).map((r) => {
    const start = Date.parse(r.starts_at);
    const end = r.ends_at ? Date.parse(r.ends_at) : start + 30 * 60_000;
    return { start, end: Math.max(end, start + 60_000) };
  }).filter((b) => Number.isFinite(b.start));
}

/**
 * Health of one sending number: the number guard's verdict (paused, an "At risk" or poor grade, a high
 * carrier spam risk on number_health or the caller line), then the hang-up and block rates Clozr logged
 * on it over the last 7 days.
 */
async function numberHealth(admin: SupabaseClient, ws: number, phone: string | null): Promise<{ sentLastHour: number; paused: string | null }> {
  if (!phone) return { sentLastHour: 0, paused: null };
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const [{ data: rows }, { count: lastHour }, { data: guard }, { data: line }] = await Promise.all([
    admin.from('communications').select('channel, duration_s, status').eq('workspace_id', ws).eq('from_phone', phone).eq('direction', 'outbound').gte('occurred_at', since).limit(5000),
    admin.from('communications').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('from_phone', phone).eq('direction', 'outbound').eq('channel', 'sms').gte('occurred_at', hourAgo),
    admin.from('number_health').select('paused, grade, spam_risk, spam_category').eq('workspace_id', ws).eq('phone_e164', phone).limit(1).maybeSingle(),
    admin.from('caller_lines').select('spam_risk, spam_category').eq('workspace_id', ws).eq('phone_e164', phone).limit(1).maybeSingle(),
  ]);
  const g = (guard ?? {}) as Any; const l = (line ?? {}) as Any;
  const grade = String(g.grade ?? '').toLowerCase();
  const high = [g.spam_risk, l.spam_risk].some((r) => String(r ?? '').toLowerCase() === 'high');
  const spamLabel = g.paused ? 'paused by the number guard'
    : grade === 'at_risk' || grade === 'poor' ? `reputation ${grade.replace('_', ' ')}`
    : high ? `spam risk high${g.spam_category || l.spam_category ? ` (${g.spam_category || l.spam_category})` : ''}` : null;
  const list = (rows ?? []) as Any[];
  const calls = list.filter((r) => r.channel === 'call' && Number(r.duration_s) > 0);
  const texts = list.filter((r) => r.channel === 'sms');
  return {
    sentLastHour: lastHour ?? 0,
    paused: numberPauseReason({
      answered: calls.length, quickHangups: calls.filter((r) => Number(r.duration_s) <= 10).length,
      texts: texts.length, blocked: texts.filter((r) => /fail|undeliver|block|filter|spam|reject/i.test(String(r.status ?? ''))).length,
      spamLabel,
    }),
  };
}

/**
 * The rep's line an AI text goes out on, picked like a plan text
 * (plan-tick/lines.ts): the line the person already hears from, else one in
 * their area code or state, else the least-used one, each under its ramp cap.
 * Null keeps the rep's default line (no rep, no Talkr lines, or all full).
 */
async function aiTextLine(admin: SupabaseClient, ws: number, sender: string | null, kind: 'seller' | 'buyer', id: number, phone: string | null): Promise<string | null> {
  if (!sender) return null;
  try {
    const { data: w } = await admin.from('workspaces').select('settings').eq('id', ws).maybeSingle();
    const lines = await loadLines(admin, ws, sender, ((w as Any)?.settings ?? {}) as Record<string, unknown>);
    if (!lines.length) return null;
    const last = await lastLineTo(admin, ws, { buyer_id: kind === 'buyer' ? id : null, seller_id: kind === 'seller' ? id : null });
    return pickLine(lines, LINE_DAILY_CAP, last, phone)?.id ?? null;
  } catch {
    return null;
  }
}

/** The line a rep's texts go out from: their caller-ID line (migration 200), else any line they own. */
async function senderLine(admin: SupabaseClient, ws: number, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { data } = await admin.from('rep_phone_numbers').select('phone_e164, is_caller_id').eq('workspace_id', ws).eq('user_id', userId).limit(10);
  const rows = (data ?? []) as Any[];
  return (rows.find((r) => r.is_caller_id) ?? rows[0])?.phone_e164 ?? null;
}

/** Run their address through Compr. The same lead id for the same address, so a retry replays instead of billing again. */
async function comprRun(ws: number, id: number, a: UsAddress): Promise<{ ok: true; summary: string; prices: number[]; reportUrl: string | null } | { ok: false; reason: string; retry: boolean }> {
  const key = Deno.env.get('COMPR_API_KEY');
  if (!key) return { ok: false, reason: 'COMPR_API_KEY is not set', retry: false };
  const slug = `${a.street} ${a.city} ${a.state} ${a.zip}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  try {
    const res = await fetch(COMPR_UNDERWRITE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ address: { street: a.street, city: a.city, state: a.state, zip: a.zip }, lead_id: `clozr-compr-agent-w${ws}-b${id}-${slug}` }),
      signal: AbortSignal.timeout(75_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('compr agent run', { status: res.status, body: text.slice(0, 300) });
      return { ok: false, reason: res.status === 422 ? 'Compr could not resolve that address' : res.status === 429 ? 'Compr is busy or out of runs' : `Compr answered ${res.status}`, retry: res.status === 429 || res.status >= 500 };
    }
    const r = runSummary(text ? JSON.parse(text) : {});
    return { ok: true, summary: r.summary, prices: r.prices, reportUrl: shareableReport(r.reportUrl) };
  } catch (err) {
    return { ok: false, reason: (err as Error).name === 'TimeoutError' ? 'the run is still going' : 'could not reach Compr', retry: true };
  }
}

type InboxState = { paused: string | null; sentToday: number; dailyCap: number };

/**
 * The sending inbox, as the gate needs it: paused (over 2% bounces or any spam complaint in 7 days pauses it
 * here, as well as a pause already on the mailbox), today's sends, and today's cap on the 5/10/15/20 ramp.
 */
async function inboxState(admin: SupabaseClient, accountId: number): Promise<InboxState> {
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const today = localDate(Date.now(), DEFAULT_TZ);
  const [{ data: log }, { count: complaints }, { data: box }] = await Promise.all([
    admin.from('email_send_log').select('sent_at, bounced_at').eq('account_id', accountId).gte('sent_at', since7).limit(5000),
    admin.from('email_suppressions').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('reason', 'complaint').gte('created_at', since7),
    admin.from('mailbox_settings').select('paused, paused_reason, ramp_started_on').eq('account_id', accountId).maybeSingle(),
  ]);
  const sends = (log ?? []) as Any[];
  const pause = inboxPauseReason({ sent: sends.length, bounced: sends.filter((r) => r.bounced_at).length, complaints: complaints ?? 0 });
  if (pause && !(box as Any)?.paused) {
    await admin.from('mailbox_settings').update({ paused: true, paused_auto: true, paused_reason: `Auto-paused: ${pause}.`, paused_at: new Date().toISOString() }).eq('account_id', accountId);
    const { data: acct } = await admin.from('google_accounts').select('workspace_id, email').eq('id', accountId).maybeSingle();
    if (acct) await alertPause(admin, Number((acct as Any).workspace_id), 'gmail_mailbox', accountId, String((acct as Any).email || 'A Gmail mailbox'), pause);
  }
  const startOfDay = dayStartUtc(new Date(), DEFAULT_TZ).toISOString();
  return {
    paused: pause ?? ((box as Any)?.paused ? String((box as Any).paused_reason || 'paused') : null),
    sentToday: sends.filter((r) => r.sent_at >= startOfDay).length,
    dailyCap: inboxDailyCap((box as Any)?.ramp_started_on ?? null, today),
  };
}

/** The inbox the agent would send from (the sender's Gmail), or null when they have none that can send. */
async function senderInbox(admin: SupabaseClient, ws: number, sender: string | null): Promise<InboxState | null> {
  if (!sender) return null;
  const { data } = await admin.from('google_accounts').select('id, scopes, gmail_send').eq('workspace_id', ws).eq('user_id', sender).eq('shared', false).eq('status', 'active').limit(1).maybeSingle();
  const a = data as Account | null;
  return a && a.gmail_send && has(a, SCOPE.gmailSend) ? await inboxState(admin, a.id) : null;
}

/** An email for the Compr agent: plain text only, in the same thread as the last one, CAN-SPAM footer, verified address, healthy inbox under its ramp. */
async function sendComprEmail(admin: SupabaseClient, ws: number, sender: string | null, rec: Rec, msg: { subject: string; body: string }, p: Persona, s: ComprSettings, verified: boolean): Promise<{ ok: true; communicationId: number | null } | { ok: false; reason: string; retryHours: number }> {
  if (!rec.email) return { ok: false, reason: 'no email on file', retryHours: 24 };
  const refused = emailRefusal({ verified, physicalAddress: s.physicalAddress, body: msg.body });
  if (refused) return { ok: false, reason: refused, retryHours: 24 };
  if (!sender) return { ok: false, reason: 'no rep to send as', retryHours: 24 };
  const { data } = await admin.from('google_accounts').select('id, workspace_id, user_id, email, scopes, calendar_id, status, gmail_send').eq('workspace_id', ws).eq('user_id', sender).eq('shared', false).eq('status', 'active').limit(1).maybeSingle();
  const account = data as Account | null;
  if (!account || !account.gmail_send || !has(account, SCOPE.gmailSend)) return { ok: false, reason: 'the rep has no Gmail connected with sending on (Settings, Google)', retryHours: 24 };
  const inbox = await inboxState(admin, account.id);
  const gate = channelGate({
    channel: 'email', consent: { optedIn: false, replied: false }, optedOut: false, tenDlcApproved: false, nowMs: Date.now(), leadTz: DEFAULT_TZ, emailVerified: verified, inbox,
  });
  if (!gate.ok) return { ok: false, reason: gate.reason, retryHours: gate.code === 'inbox_cap' ? 12 : 24 };
  const token = await accessFor(admin, account);
  if (!token) return { ok: false, reason: 'Gmail needs reconnecting', retryHours: 24 };
  const claim = await guardSend(admin, account, [rec.email], 'bulk');
  if (!claim.ok) return { ok: false, reason: claim.message, retryHours: claim.code === 'suppressed' ? 24 * 14 : 6 };
  // Follow-ups reply in the same thread: the newest email on this record from or to this mailbox.
  const { data: prior } = await admin.from('communications').select('subject, thread_id, source_id, from_email, to_email').eq('workspace_id', ws).eq('buyer_id', rec.id)
    .eq('channel', 'email').not('thread_id', 'is', null).order('occurred_at', { ascending: false }).limit(10);
  const mine = account.email.toLowerCase();
  const thread = ((prior ?? []) as Any[]).find((c) => String(c.from_email ?? '').toLowerCase() === mine || String(c.to_email ?? '').toLowerCase().includes(mine)) ?? null;
  const subject = threadSubject(thread?.subject, msg.subject || 'Running comps on your deals');
  const link = unsubscribeUrl(await unsubscribeToken({ w: ws, e: rec.email, a: account.id }));
  const text = composeEmail(msg.body, { signature: `${p.name}\n${p.company}`, physicalAddress: s.physicalAddress, unsubscribeUrl: link });
  const sent = await sendMail(token, {
    to: rec.email, subject, text, html: textToHtml(text), plainOnly: true,
    from: `"${`${p.name} · ${p.company}`.replace(/["\r\n<>]/g, '')}" <${account.email}>`,
    threadId: thread?.thread_id ?? null, inReplyTo: /^<[^>]+>$/.test(String(thread?.source_id ?? '')) ? thread.source_id : null,
    headers: { 'List-Unsubscribe': `<${link}>, <mailto:${account.email}?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
  if (!sent) { await release(admin, claim.ids); return { ok: false, reason: 'Gmail refused that send', retryHours: 6 }; }
  const messageId = (await messageIdOf(token, sent.id)) ?? `gmail:${sent.id}`;
  const { data: comm } = await admin.from('communications').upsert({
    workspace_id: ws, buyer_id: rec.id, rep_id: account.user_id, channel: 'email', direction: 'outbound', occurred_at: new Date().toISOString(), subject, body: text.slice(0, 20_000),
    from_email: mine, to_email: rec.email, status: 'sent', source: 'gmail', source_id: messageId, thread_id: sent.threadId,
  }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
  return { ok: true, communicationId: (comm as Any)?.id ?? null };
}

/** A hot lead or a booking: Alex hears about it now, with everything he needs to pick up the phone. */
async function tellBooker(admin: SupabaseClient, ws: number, who: string | null, rec: Rec, a: { title: string; lines: string[]; key: string; due: string; priority: 'Urgent' | 'high' }) {
  if (!who) return;
  const link = { seller_id: null, buyer_id: rec.id };
  const body = a.lines.filter(Boolean).join('\n');
  await admin.from('notifications').insert({ workspace_id: ws, user_id: who, category: 'AI agent', title: a.title.slice(0, 120), body: body.slice(0, 500), ...link });
  // No task: in Compr Alex sets his own call tasks (isComprWorkspace). The bell and the email carry it.
  await emailRep(admin, who, { subject: a.title, lines: a.lines.filter(Boolean), name: rec.name || 'them', phone: rec.phone, kind: 'buyer', id: rec.id, key: a.key });
  // The lead is Alex's from here.
  await admin.from('buyers').update({ assigned_to: who }).eq('id', rec.id).eq('workspace_id', ws).is('assigned_to', null);
}

/** Put the demo on the booking person's calendar, with the prospect as an attendee so Google sends them the invite. */
async function comprBook(admin: SupabaseClient, ws: number, agent: AgentLite, rec: Rec, b: BookingAsk, s: ComprSettings, phone: string | null): Promise<{ ok: true; id: number | null } | { ok: false; reason: string }> {
  if (!s.bookingUserId) return { ok: false, reason: 'no booking calendar set (compr_agent_settings.booking_user_id)' };
  const start = Date.parse(b.starts_at);
  if ((await busyFor(admin, ws, s.bookingUserId)).some((x) => x.start < start + s.minutes * 60_000 && start < x.end)) return { ok: false, reason: 'that time was just taken' };
  const row: Record<string, unknown> = {
    workspace_id: ws, seller_id: null, buyer_id: rec.id, title: `Compr demo with ${b.name}`.slice(0, 300), kind: 'Call',
    starts_at: new Date(start).toISOString(), ends_at: new Date(start + s.minutes * 60_000).toISOString(), location: null,
    notes: [`Booked by the AI agent ${agent.name}.`, `Email: ${b.email}`, phone ? `Phone: ${prettyPhone(phone)}` : '', `Deal to run: ${b.deal}`].filter(Boolean).join('\n'),
    source: 'clozr', assigned_to: s.bookingUserId, created_by: null, attendees: [{ email: b.email, name: b.name }],
    booked_by: 'ai_agent', ai_agent_key: agent.agent_key,
  };
  let { data, error } = await admin.from('appointments').insert(row).select('id').maybeSingle();
  if (error && /booked_by|ai_agent_key/.test(error.message)) {
    const { booked_by: _b, ai_agent_key: _k, ...older } = row;
    ({ data, error } = await admin.from('appointments').insert(older).select('id').maybeSingle());
  }
  if (error) return { ok: false, reason: error.message };
  // Fill what the record was missing.
  const { data: cur } = await admin.from('buyers').select('name, email').eq('id', rec.id).maybeSingle();
  const patch: Record<string, unknown> = {};
  if (!(cur as Any)?.email) patch.email = b.email;
  if (!(cur as Any)?.name) patch.name = b.name;
  if (Object.keys(patch).length) await admin.from('buyers').update(patch).eq('id', rec.id).eq('workspace_id', ws);
  return { ok: true, id: (data as Any)?.id ?? null };
}

type ComprState = {
  offered?: OfferedSlot[]; booking?: Partial<BookingAsk>;
  run?: { address: string; summary: string; reportUrl: string | null; prices: number[]; at: string } | null;
  runs?: number; held_for?: string | null; failed_address?: string | null;
};

/** The Compr agent's turn on one record. Called from work() after the shared checks (eligibility, a stop request). */
async function comprWork(admin: SupabaseClient, client: Anthropic | null, c: {
  e: Any; ws: number; id: number; agent: AgentLite; rec: Rec; base: { ws: number; agent: { agent_key: string; name: string }; enrollmentId: number; kind: RecordKind; id: number };
  save: (patch: Record<string, unknown>) => PromiseLike<unknown>; end: (status: 'stopped' | 'done', reason: string) => Promise<void>;
  replies: Any[]; repliedSince: boolean; seenAt: string; channels: Channel[]; reach: Reach; now: number;
}): Promise<Outcome> {
  const { e, ws, id, agent, rec, base, save, end, replies, repliedSince, seenAt, channels, reach, now } = c;
  const s = await comprSettings(admin, ws);
  if (!s.migrated) {
    await save({ next_action_at: new Date(now + 6 * 3_600_000).toISOString() });
    await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: COMPR_NOT_MIGRATED, timeline: false });
    return 'waits';
  }
  if (await optedOutAnywhere(admin, ws, rec)) {
    await end('stopped', 'opted out on another record or channel');
    await record(admin, { ...base, channel: 'system', action: 'marked_dnc', summary: 'This phone or email asked us to stop before. Nothing goes to them on any channel.' });
    return 'stopped';
  }
  const facts = await comprFacts(admin, ws, rec, s.optInSources, s.outreachWithoutConsent);
  const leadTz = leadZone(rec.phone, facts.state, DEFAULT_TZ);
  const { data: row } = await admin.from('ai_agent_enrollments').select('compr').eq('id', e.id).maybeSingle();
  const st: ComprState = ((row as Any)?.compr && typeof (row as Any).compr === 'object' ? (row as Any).compr : {}) as ComprState;
  const saveState = (patch: Record<string, unknown>, next: Partial<ComprState> = {}) => save({ ...patch, compr: { ...st, ...next } });
  const said = replies.map((r) => String(r.body || r.summary || r.transcript || '')).join('\n').trim();
  const lastChannel = replies[0]?.channel === 'email' ? 'email' : replies[0]?.channel === 'sms' ? 'sms' : null;

  // Nothing answers a fresh reply on the minute: a person takes a couple of minutes.
  if (repliedSince && st.held_for !== seenAt) {
    const wait = jitterMinutes(`${e.id}:${seenAt}`, true);
    await saveState({ next_action_at: new Date(now + wait * 60_000).toISOString() }, { held_for: seenAt });
    return 'waits';
  }

  const hot = said ? hotSignal(said) : null;
  const persona = await personaFor(admin, ws, agent, e.started_by ?? rec.assigned_to);
  const sender = e.started_by ?? rec.assigned_to ?? s.bookingUserId ?? null;
  const touches = Number(e.touches ?? 0); const maxTouches = Number(e.max_touches ?? MAX_TOUCHES_DEFAULT);

  // Their address: run it before deciding, so the reply can quote it.
  const addr = said ? findAddress(said) : null;
  const addrLine = addr ? `${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}`.trim() : '';
  if (addr && st.run?.address !== addrLine && st.failed_address !== addrLine && (st.runs ?? 0) < COMPR_MAX_RUNS) {
    const r = await comprRun(ws, id, addr);
    if (r.ok) {
      st.run = { address: addrLine, summary: r.summary, reportUrl: r.reportUrl, prices: r.prices, at: new Date().toISOString() };
      st.runs = (st.runs ?? 0) + 1;
      await record(admin, { ...base, channel: 'system', action: 'compr_run', summary: `Ran ${addrLine}: ${r.summary}${r.reportUrl ? ` ${r.reportUrl}` : ''}` });
    } else if (r.retry) {
      await saveState({ next_action_at: new Date(now + 3 * 60_000).toISOString() });
      await record(admin, { ...base, channel: 'system', action: 'compr_run', status: 'skipped', summary: `Could not run ${addrLine} yet: ${r.reason}. Trying again in a few minutes.`, timeline: false });
      return 'waits';
    } else {
      st.failed_address = addrLine;
      await record(admin, { ...base, channel: 'system', action: 'compr_run', status: 'failed', summary: `Could not run ${addrLine}: ${r.reason}.` });
    }
  }

  // Two times from the booking calendar, in their zone.
  const offered = s.bookingUserId ? demoSlots({ nowMs: now, busy: await busyFor(admin, ws, s.bookingUserId), hours: s.hours, leadTz, minutes: s.minutes, previous: st.offered }) : [];
  const history = await historyFor(admin, ws, 'buyer', id);
  const avatar = avatarOf(`${said}\n${history.slice(-6000)}`);

  // What each channel would say right now, so the model only picks one that is open.
  const line = await senderLine(admin, ws, sender);
  const health = await numberHealth(admin, ws, line);
  const inbox = reach.email && channels.includes('email') ? await senderInbox(admin, ws, sender) : null;
  const gateFor = (channel: GateChannel) => channelGate({
    channel, consent: facts.consent, optedOut: false, tenDlcApproved: s.tenDlcApproved, nowMs: now, leadTz,
    number: channel === 'sms' ? health : { sentLastHour: 0, paused: null }, emailVerified: facts.emailVerified,
    ...(channel === 'email' && inbox ? { inbox } : {}),
  });
  const open = (ch: Channel) => channels.includes(ch) && (ch === 'sms' || ch === 'rvm' ? reach.phone : ch === 'email' ? reach.email : reach.call);
  const gateLine = (['sms', 'email', 'call', 'rvm'] as Channel[]).map((ch) => {
    if (!open(ch)) return `${ch}: not available`;
    const g = gateFor(ch);
    return `${ch}: ${g.ok ? 'open now' : `closed (${g.reason})`}`;
  }).join('; ');

  const system = comprSystemPrompt({ agentName: persona.name, slots: offered, booking: st.booking, run: st.run ?? null, avatar, hot });
  const user = [
    `Now: ${nowLabel(now, leadTz)} (their time zone).`,
    `Touches so far: ${touches} of at most ${maxTouches}.`,
    `Channels right now: ${gateLine}.`,
    repliedSince ? `They wrote since your last touch${lastChannel ? ` (by ${lastChannel === 'sms' ? 'text' : 'email'}, answer there)` : ''}:\n${fence('reply', said, 4000)}` : 'No reply since your last touch.',
    touches === 0 ? 'You have not reached out before: say your first name and that you are with Compr.' : '',
    st.failed_address ? `Their address ${st.failed_address} could not be run: ask them to double-check the street, city, state and ZIP, or say Alex will run it on the demo.` : '',
    `Their record and history:\n${history}`,
  ].filter(Boolean).join('\n\n');

  // No reply to read, not hot, and every channel shut: the model could only say wait, and it would be sent the
  // whole history to say it. Wait for the soonest channel to open instead (a day when none opens on its own).
  if (!repliedSince && !hot) {
    // Email has no hours gate of its own, so without this the setter asked the model what to do every hour overnight.
    const early = gateDecision({ action: 'email', body: '', subject: '', call_goal: '', next_check_hours: 1, reason: '' }, { nowMs: now, tz: leadTz, lastActionAt: e.last_action_at, repliedSince, touches, maxTouches: Number(e.max_touches ?? MAX_TOUCHES_DEFAULT) });
    if (early.action === 'wait') {
      const at = new Date(Date.parse(nextLookAt(now, early.next_check_hours, leadTz)) + jitterMinutes(`${e.id}:${now}`, false) * 60_000).toISOString();
      await saveState({ next_action_at: at, last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: `Holding: ${early.reason}. Next look ${at}.`, timeline: false });
      return 'waits';
    }
    const shut = allShut((['sms', 'email', 'call', 'rvm'] as Channel[]).filter(open).map(gateFor));
    if (shut) {
      const hours = shut.retryAtMs ? Math.max(1, (shut.retryAtMs - now) / 3_600_000) : 24;
      const at = new Date(Date.parse(nextLookAt(now, hours, leadTz)) + jitterMinutes(`${e.id}:${now}`, false) * 60_000).toISOString();
      await saveState({ next_action_at: at, last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: `No channel is open (${shut.reasons.join('; ')}). Next look ${at}.`, timeline: false });
      return 'waits';
    }
  }

  let d: ComprDecision = { action: 'wait', body: '', subject: '', call_goal: '', address: '', booking: {}, next_check_hours: 24, reason: 'the AI model is not configured (ANTHROPIC_API_KEY)' };
  let check: MessageCheck | null = null;
  const replyChannel: 'sms' | 'email' | null = (lastChannel && open(lastChannel) && gateFor(lastChannel).ok) ? lastChannel
    : open('email') && gateFor('email').ok ? 'email' : open('sms') && gateFor('sms').ok ? 'sms' : null;
  const bodyChannel = (a: ComprAction): 'sms' | 'email' | 'call' | 'rvm' | null => (a === 'sms' || a === 'email' || a === 'call' || a === 'rvm' ? a : a === 'book' || a === 'handoff' ? replyChannel : null);
  if (client) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const extra = attempt && check ? `\n\nYour last draft was held and was not sent: ${check.problems.join('; ')}. Write it again without those problems.` : '';
      d = parseComprDecision(await claudeTool(client, system, COMPR_DECIDE_TOOL, user + extra, 1500, ws));
      if (hot && !['book', 'handoff', 'finish'].includes(d.action)) d = { ...d, action: 'handoff', reason: `hot: ${hot}${d.reason ? `; ${d.reason}` : ''}` };
      const ch = bodyChannel(d.action);
      if (!d.body || !ch || ch === 'call') { check = null; break; }
      check = checkMessage(d.body, { channel: ch, theySaid: said, runPrices: st.run?.prices ?? [] });
      if (!check.problems.length) { d.body = check.text; break; }
    }
  }
  if (check?.problems.length && hot && d.action === 'handoff') {
    // A hot lead goes to Alex now even when the reply could not be written within the rules: no message, just the hand-off.
    await record(admin, { ...base, channel: 'system', action: 'skipped', status: 'skipped', summary: `Held the hand-off message (${check.problems.join('; ')}); handing to ${BOOKER_NAME} without it.`, detail: { body: d.body }, timeline: false });
    d = { ...d, body: '' };
    check = null;
  }
  if (check?.problems.length) {
    // The reply stays unread (last_inbound_seen_at does not move), so the next look answers it again: a hot lead
    // is still handed to Alex and what they gave toward a booking is still read.
    await saveState({ next_action_at: new Date(now + 60 * 60_000).toISOString() });
    await record(admin, { ...base, channel: 'system', action: 'skipped', status: 'skipped', summary: `Held a message that broke the rules: ${check.problems.join('; ')}. Trying again in an hour.`, detail: { body: d.body } });
    return 'waits';
  }

  const nextAt = (hours: number, reply = false) => new Date(Date.parse(nextLookAt(now, hours, leadTz)) + jitterMinutes(`${e.id}:${now}`, reply) * 60_000).toISOString();
  /** Send the body on a channel after the gate; the communication id, or why not. */
  const deliver = async (ch: 'sms' | 'email', body: string, subject: string): Promise<{ ok: true; comm: number | null } | { ok: false; reason: string; retryAtMs: number | null; optedOut?: boolean }> => {
    const g = gateFor(ch);
    if (!g.ok) return { ok: false, reason: g.reason, retryAtMs: g.retryAtMs, optedOut: g.code === 'opted_out' };
    if (ch === 'sms') {
      const { count: textedBefore } = await admin.from('ai_agent_actions').select('id', { count: 'exact', head: true }).eq('enrollment_id', e.id).eq('action', 'sms_sent').eq('status', 'done');
      const sent = await textRecipient(admin, { workspace_id: ws, created_by: sender }, { phone: rec.phone, seller_id: null, buyer_id: id }, textedBefore ? body : withOptOut(body), sender, { contractsLine: false, fromPhoneNumberId: await aiTextLine(admin, ws, sender, 'buyer', id, rec.phone) });
      return sent.ok ? { ok: true, comm: sent.communication_id ?? null } : { ok: false, reason: sent.reason, retryAtMs: now + 6 * 3_600_000, optedOut: /opted out/.test(sent.reason) };
    }
    const r = await sendComprEmail(admin, ws, sender, rec, { subject, body }, persona, s, facts.emailVerified);
    return r.ok ? { ok: true, comm: r.communicationId } : { ok: false, reason: r.reason, retryAtMs: now + r.retryHours * 3_600_000 };
  };

  switch (d.action) {
    case 'wait': {
      await saveState({ next_action_at: nextAt(d.next_check_hours), last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: d.reason || 'Waiting.', timeline: false });
      return 'waits';
    }
    case 'finish': {
      await end('done', d.reason || 'nothing more to do');
      await save({ last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: 'finished', summary: d.reason || 'Done.' });
      return 'finished';
    }
    case 'run_address': {
      const a = findAddress(d.address);
      if (!a || (st.runs ?? 0) >= COMPR_MAX_RUNS) {
        await saveState({ next_action_at: new Date(now + 2 * 60_000).toISOString(), last_inbound_seen_at: seenAt }, { failed_address: a ? null : d.address || 'the address they gave' });
        return 'waits';
      }
      const r = await comprRun(ws, id, a);
      const line2 = `${a.street}, ${a.city}, ${a.state} ${a.zip}`.trim();
      if (r.ok) {
        await saveState({ next_action_at: new Date(now + 60_000).toISOString() }, { run: { address: line2, summary: r.summary, reportUrl: r.reportUrl, prices: r.prices, at: new Date().toISOString() }, runs: (st.runs ?? 0) + 1 });
        await record(admin, { ...base, channel: 'system', action: 'compr_run', summary: `Ran ${line2}: ${r.summary}${r.reportUrl ? ` ${r.reportUrl}` : ''}` });
      } else {
        await saveState({ next_action_at: new Date(now + (r.retry ? 3 : 1) * 60_000).toISOString() }, r.retry ? {} : { failed_address: line2 });
        await record(admin, { ...base, channel: 'system', action: 'compr_run', status: r.retry ? 'skipped' : 'failed', summary: `Could not run ${line2}: ${r.reason}.`, timeline: !r.retry });
      }
      return 'waits';
    }
    case 'book': {
      const merged: Partial<BookingAsk> = { ...st.booking, ...Object.fromEntries(Object.entries(d.booking).filter(([, v]) => v)) };
      const ok = bookingCheck(merged, offered);
      if (!ok.ok) {
        // Not enough to book yet: what they gave is kept, and the message (asking for the rest) goes out like any reply.
        if (!d.body || !replyChannel) {
          await saveState({ next_action_at: nextAt(1, true), last_inbound_seen_at: seenAt }, { booking: merged, offered });
          await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: `Not booked yet, missing ${ok.missing.join(', ')}.`, timeline: false });
          return 'waits';
        }
        d = { ...d, action: replyChannel };
        st.booking = merged; st.offered = offered;
        break;
      }
      const made = await comprBook(admin, ws, agent, rec, ok.booking, s, rec.phone);
      if (!made.ok) {
        await saveState({ next_action_at: new Date(now + 2 * 60_000).toISOString(), last_inbound_seen_at: seenAt }, { booking: { ...merged, starts_at: undefined }, offered: [] });
        await record(admin, { ...base, channel: 'system', action: 'failed', status: 'failed', summary: `Could not book ${ok.booking.starts_at}: ${made.reason}. Offering new times.` });
        return 'waits';
      }
      const label = spokenSlot(Date.parse(ok.booking.starts_at), now, leadTz);
      await tellBooker(admin, ws, s.bookingUserId, rec, {
        title: `Compr demo booked: ${ok.booking.name}, ${label}`, priority: 'high', due: ok.booking.starts_at, key: `compr-book:${e.id}:${ok.booking.starts_at}`,
        lines: [`${agent.name} booked ${ok.booking.name} for ${label} (${s.minutes} minutes).`, `Email: ${ok.booking.email}`, rec.phone ? `Phone: ${prettyPhone(rec.phone)}` : '', `Deal to run: ${ok.booking.deal}`, st.run ? `Ran ${st.run.address}: ${st.run.summary}` : '', hot ? `Hot: ${hot}.` : ''],
      });
      await record(admin, { ...base, channel: 'system', action: 'appointment_booked', summary: `Booked a ${s.minutes}-minute demo with ${BOOKER_NAME} for ${label}: ${ok.booking.name}, ${ok.booking.email}, ${ok.booking.deal}.`, detail: { appointment_id: made.id, starts_at: ok.booking.starts_at } });
      if (d.body && replyChannel) {
        const sent = await deliver(replyChannel, d.body, 'Your Compr demo');
        if (sent.ok) await record(admin, { ...base, channel: replyChannel, action: replyChannel === 'sms' ? 'sms_sent' : 'email_sent', summary: `"${d.body}"`, communicationId: sent.comm });
      }
      await end('done', `booked: demo ${label}`);
      await save({ last_inbound_seen_at: seenAt, compr: { ...st, booking: ok.booking, offered: [] } });
      return 'finished';
    }
    case 'handoff': {
      if (d.body && replyChannel) {
        const sent = await deliver(replyChannel, d.body, 'Alex will reach out');
        if (sent.ok) await record(admin, { ...base, channel: replyChannel, action: replyChannel === 'sms' ? 'sms_sent' : 'email_sent', summary: `"${d.body}"`, communicationId: sent.comm });
      }
      const why = hot ?? d.reason ?? 'ready to talk';
      await tellBooker(admin, ws, s.bookingUserId ?? sender, rec, {
        title: `Call ${rec.name || 'this lead'} now${rec.phone ? ` · ${prettyPhone(rec.phone)}` : ''}: hot Compr lead`, priority: 'Urgent', due: new Date().toISOString(), key: `compr-hot:${e.id}:${seenAt}`,
        lines: [`${rec.name || 'This lead'} is hot: ${why}.`, said ? `They said: "${said.replace(/\s+/g, ' ').slice(0, 220)}"` : '', rec.email ? `Email: ${rec.email}` : '', st.run ? `Ran ${st.run.address}: ${st.run.summary}` : '', offered.length ? `Open times we could offer: ${offered.map((o) => o.label).join(' or ')}.` : '', `${agent.name} has stopped; the conversation is on their record.`],
      });
      await end('done', `handed to ${BOOKER_NAME}: ${why}`);
      await save({ last_inbound_seen_at: seenAt });
      await record(admin, { ...base, channel: 'system', action: 'handoff', summary: `Hot, handed to ${BOOKER_NAME} now: ${why}.` });
      return 'finished';
    }
  }

  // A text, an email, a call or a voicemail: the shared spacing and touch cap (in their zone), then the Compr gate.
  const shared = gateDecision({ action: d.action as Channel, body: d.body, subject: d.subject, call_goal: d.call_goal, next_check_hours: d.next_check_hours, reason: d.reason }, { nowMs: now, tz: leadTz, lastActionAt: e.last_action_at, repliedSince, touches, maxTouches });
  if (shared.action === 'finish') { await end('done', shared.reason); await record(admin, { ...base, channel: 'system', action: 'finished', summary: shared.reason }); return 'finished'; }
  if (shared.action === 'wait') {
    await saveState({ next_action_at: nextAt(shared.next_check_hours), last_inbound_seen_at: seenAt }, { offered });
    await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: shared.reason, timeline: false });
    return 'waits';
  }
  const keep = { offered, booking: st.booking };
  if (d.action === 'call') {
    const g = gateFor('call');
    if (!g.ok) {
      await saveState({ next_action_at: g.retryAtMs ? new Date(g.retryAtMs).toISOString() : nextAt(24), last_inbound_seen_at: seenAt }, keep);
      await record(admin, { ...base, channel: 'call', action: 'call_placed', status: 'skipped', summary: `Call not placed: ${g.reason}.`, timeline: false });
      return 'waits';
    }
    const from = agent.live?.channels.phone_number_id ? await callerNumberFor(admin, ws, rec.phone, agent.live.channels.phone_number_id) : null;
    const h = await numberHealth(admin, ws, from?.phone ?? null);
    if (h.paused) {
      await saveState({ next_action_at: nextAt(6), last_inbound_seen_at: seenAt }, keep);
      await record(admin, { ...base, channel: 'call', action: 'call_placed', status: 'skipped', summary: `Call not placed: the number ${from?.phone ?? ''} is paused (${h.paused}).` });
      return 'waits';
    }
    const r = await placeCall(admin, ws, agent, rec, { action: 'call', body: '', subject: '', call_goal: d.call_goal || 'Ask what they are working on and book a 15-minute demo with Alex.', next_check_hours: d.next_check_hours, reason: d.reason }, persona, { leadWindowChecked: true });
    if (!r.ok) {
      await saveState({ next_action_at: nextAt(r.retryHours), last_inbound_seen_at: seenAt }, keep);
      await record(admin, { ...base, channel: 'call', action: 'call_placed', status: callStatus(r), summary: `Call not placed: ${r.reason}.` });
      if (r.deadNumber?.justNow) await flagDeadNumber(admin, ws, rec, agent.name, r.deadNumber.phone);
      if (r.stop) { await end('stopped', r.reason); return 'stopped'; }
      return 'failed';
    }
    await saveState({ touches: touches + 1, last_action_at: new Date().toISOString(), next_action_at: nextAt(d.next_check_hours), last_inbound_seen_at: seenAt }, keep);
    await record(admin, { ...base, channel: 'call', action: 'call_placed', summary: `Calling ${rec.phone}: ${d.call_goal}\n\nWhy: ${d.reason}`, conversationId: r.conversationId, detail: { from_number: r.from.phone } });
    return 'calls';
  }
  if (d.action === 'rvm') {
    if (await rvmRecently(admin, ws, rec.kind, id, now)) {
      await saveState({ next_action_at: nextAt(24), last_inbound_seen_at: seenAt }, keep);
      await record(admin, { ...base, channel: 'system', action: 'waited', status: 'skipped', summary: `A voicemail went out in the last ${RVM_GAP_DAYS} days; waiting.`, timeline: false });
      return 'waits';
    }
    const g = gateFor('rvm');
    const r = g.ok ? await dropVoicemail(admin, ws, rec, d.body, sender) : { ok: false as const, reason: g.reason };
    if (!r.ok) {
      await saveState({ next_action_at: !g.ok && g.retryAtMs ? new Date(g.retryAtMs).toISOString() : nextAt(6), last_inbound_seen_at: seenAt }, keep);
      await record(admin, { ...base, channel: 'rvm', action: 'rvm_sent', status: g.ok ? 'failed' : 'skipped', summary: `Voicemail not queued: ${r.reason}.`, detail: { body: d.body }, timeline: g.ok });
      return g.ok ? 'failed' : 'waits';
    }
    await saveState({ touches: touches + 1, last_action_at: new Date().toISOString(), next_action_at: nextAt(d.next_check_hours), last_inbound_seen_at: seenAt }, keep);
    await record(admin, { ...base, channel: 'rvm', action: 'rvm_sent', summary: `"${d.body}"\n\nWhy: ${d.reason}`, detail: { body: d.body, rvm_drop_id: r.dropId, library_id: r.libraryId } });
    return 'voicemails';
  }
  const ch = d.action as 'sms' | 'email';
  const sent = await deliver(ch, d.body, d.subject);
  if (!sent.ok) {
    await saveState({ next_action_at: sent.retryAtMs ? new Date(sent.retryAtMs).toISOString() : nextAt(6), last_inbound_seen_at: seenAt, ...(sent.optedOut && ch === 'sms' ? { channels: channels.filter((x) => x !== 'sms').length ? channels.filter((x) => x !== 'sms') : channels } : {}) }, keep);
    await record(admin, { ...base, channel: ch, action: ch === 'sms' ? 'sms_sent' : 'email_sent', status: 'skipped', summary: `${ch === 'sms' ? 'Text' : 'Email'} not sent: ${sent.reason}.`, detail: { body: d.body }, timeline: false });
    return 'waits';
  }
  await saveState({ touches: touches + 1, last_action_at: new Date().toISOString(), next_action_at: nextAt(d.next_check_hours), last_inbound_seen_at: seenAt }, keep);
  await record(admin, { ...base, channel: ch, action: ch === 'sms' ? 'sms_sent' : 'email_sent', summary: `${ch === 'email' ? `Subject: ${d.subject}\n\n` : ''}"${d.body}"\n\nWhy: ${d.reason}`, detail: { body: d.body }, communicationId: sent.comm });
  return ch === 'sms' ? 'texts' : 'emails';
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
    await record(admin, { ...base, channel: 'call', action: 'call_placed', status: callStatus(r), summary: `Speed call not placed: ${r.reason}. Texting instead.`, detail: { program: 'speed' } });
    if (r.deadNumber?.justNow) await flagDeadNumber(admin, ws, rec, agent.name, r.deadNumber.phone);
  }
  // A text: the first touch, the after-hours one, or the stand-in for a call that could not be placed.
  if ((ft.now === 'sms' || ft.now === 'call') && rec.phone && channels.includes('sms')) {
    const kind = inCallWindow(now, tz, s.speed.window) ? 'first' : 'after_hours';
    if (kind === 'first' || s.speed.after_hours_text) {
      const body = withOptOut(speedText(kind, who));
      const sent = await textRecipient(admin, { workspace_id: ws, created_by: sender }, { phone: rec.phone, seller_id: id }, body, sender, { contractsLine: false, fromPhoneNumberId: await aiTextLine(admin, ws, sender, 'seller', id, rec.phone) });
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
    const sent = await textRecipient(admin, { workspace_id: ws, created_by: sender }, { phone: rec.phone, seller_id: rec.id }, body, sender, { contractsLine: false, fromPhoneNumberId: await aiTextLine(admin, ws, sender, 'seller', rec.id, rec.phone) });
    if (!sent.ok) {
      await record(admin, { ...base, channel: 'sms', action: 'sms_sent', status: 'failed', summary: `Text not sent: ${sent.reason}.`, detail: { body, program: 'speed' } });
      if (/quiet hours/.test(sent.reason) || sent.reason === BLACKLIST_UNREAD) {
        // Not a no: the same text waits for the window, or five minutes for the blacklist to read.
        const at = sent.reason === BLACKLIST_UNREAD ? now + 5 * 60_000 : nextWindowOpen(now + 60_000, tz, s.speed.window);
        await save({ autopilot: { ...ap, phase: 'text_at_open', text_kind: kind }, next_action_at: new Date(at).toISOString(), last_inbound_seen_at: i.seenAt });
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
        await record(admin, { ...base, channel: 'call', action: 'call_placed', status: callStatus(r), summary: `Call not placed: ${r.reason}.`, detail: { program: 'speed' } });
        if (r.deadNumber?.justNow) await flagDeadNumber(admin, ws, rec, agent.name, r.deadNumber.phone);
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
    const [t, booked, run] = await Promise.all([
      // Counted in SQL (migration 391): the leads and actions reads stopped at PostgREST's 1,000 rows.
      admin.rpc('ai_autopilot_today', { p_ws: ws, p_since: midnight }),
      admin.from('appointments').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('booked_by', 'ai_agent').gte('created_at', midnight),
      admin.from('ai_agent_enrollments').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('status', 'active').not('program', 'is', null),
    ]);
    if (t.error) console.error('ai-agent autopilot today', t.error.message);
    const T = (t.data ?? {}) as Record<string, number | null | undefined>;
    today = {
      speed_enrolled: T.speed_enrolled ?? 0,
      speed_skipped: T.speed_skipped ?? 0,
      reactivated: T.reactivated ?? 0,
      calls: T.calls ?? 0, texts: T.texts ?? 0, emails: T.emails ?? 0,
      booked: booked.error ? null : booked.count ?? 0,
      median_first_touch_s: T.median_first_touch_s ?? null,
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

