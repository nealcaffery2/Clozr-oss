// The browser's side of the ai-agent edge function (migration 123): the
// per-record switch and its chat, bulk switching for buyers, agent avatars and
// the AI agents report. Every call returns { ok, ... } or { ok: false, error }
// and never throws, so a screen can show the reason next to the control.
import { invokeFn } from '@/app/components/phone/ui';
import { forgetAgentFaces } from '@/lib/crm';

export type RecordKind = 'seller' | 'buyer';
export type Channel = 'call' | 'rvm' | 'sms' | 'email';
export type EnrollmentStatus = 'draft' | 'active' | 'paused' | 'stopped' | 'done';

export type AgentInfo = {
  agent_key: string; name: string; role: string; role_label: string; avatar_url: string | null; audience: 'sellers' | 'buyers' | 'both' | string;
  enabled: boolean; live: boolean; can_call: boolean; active: number;
  /** The agent this one hands a record to when its stage is done, and when (migration 124). Null hands to a person. */
  handoff_to?: string | null; handoff_on?: HandoffTrigger[];
};
export type HandoffTrigger = 'ready' | 'qualified';
export type PlanStep = { day: number; channel: Channel; purpose: string };
export type Plan = { summary: string; goal: string; steps: PlanStep[]; stop_when: string };
export type ChatTurn = { role: 'rep' | 'agent'; text: string; at: string; by?: string | null };
export type Enrollment = {
  id: number; record_kind: RecordKind; record_id: number; agent_key: string; status: EnrollmentStatus; mode: 'auto' | 'custom';
  instructions: string; channels: Channel[]; plan: Plan; chat: ChatTurn[]; touches: number; max_touches: number;
  next_action_at: string | null; last_action_at: string | null; stop_reason: string | null; started_at: string | null; stopped_at: string | null;
};
export type AgentAction = { id: number; agent_key: string; channel: string; action: string; status: 'done' | 'skipped' | 'failed'; summary: string; created_at: string };
export type Reach = { phone: boolean; email: boolean; call: boolean };
export type RecordStatus = {
  enrollment: Enrollment | null; agents: AgentInfo[]; agent: AgentInfo | null; eligible: { ok: true } | { ok: false; reason: string; code: string };
  reach: Reach; channels: Channel[]; record: { kind: RecordKind; id: number; name: string }; actions: AgentAction[];
  /** How the agent opens a call: as the rep set it (null: not set), and what the history suggests (migration 258). */
  contact?: Contact | null; contact_suggested?: Contact;
};
/** 'first': a new lead or cold call, they have never talked with us. 'known': a follow-up, we know it's them. */
export type Contact = 'first' | 'known';
export type AgentReportRow = AgentInfo & {
  texts: number; emails: number; calls: number; voicemails?: number; replies: number; booked: number; handoffs: number; dnc: number; records_touched: number; failed: number;
  by_day: { day: string; touches: number }[]; enrollments: { active: number; total: number; done: number; stopped: number };
  voice_calls: number; voice_booked: number; transferred: number; talk_minutes: number; touches: number; reply_rate: number;
};

/** The AI funnel on the report (migration 146 adds the speed ledger; the rest reads tables that already exist). */
export type AiFunnel = {
  new_leads: number; speed_queued: number; contacted: number; median_first_touch_s: number | null; under_60s: number;
  conversations: number; qualified: number; appointments: number; transfers: number; contracts: number;
  reactivated: number; reactivated_replied: number; reactivated_booked: number; autopilot: boolean;
  /** Conversations as a share of the sellers the agents reached out to. */
  contact_rate?: number;
  /** Speed leads by when they came in. */
  by_time?: Record<'business' | 'after_hours' | 'weekend', { leads: number; contacted: number; booked: number }>;
  ai_calls?: number; ai_calls_per_day?: number;
};

// ---- AI Autopilot (migration 146) ----
export type AutopilotWindow = { start: string; end: string; days?: string[] };
export type ReactivationListId = 'reactivation' | 'dead_leads' | 'no_contact';
export type AutopilotSettings = {
  send_as: string | null;
  /** The daily ceiling on what every AI agent spends together (texts, emails, calls; steps = Claude turns). */
  limits?: { daily_touches: number; daily_steps: number };
  speed: { enabled: boolean; sources: string[]; agent_key: string | null; channels: Channel[]; window: AutopilotWindow; after_hours_text: boolean; fallback_minutes: number; max_lead_age_hours: number };
  followup: { enabled: boolean; agent_key: string | null; cadence_days: number[]; max_touches: number; channels: Channel[] };
  reactivation: { enabled: boolean; agent_key: string | null; lists: ReactivationListId[]; sources: string[]; idle_days: number; daily_cap: number; channels: Channel[]; max_touches: number };
};
export type AutopilotSource = { source: string; leads: number; last_at: string | null; kind: 'inbound' | 'list' | 'unknown'; speed: boolean };
export type AutopilotToday = {
  speed_enrolled: number; speed_skipped: number; reactivated: number; calls: number; texts: number; emails: number; booked: number | null; median_first_touch_s: number | null;
};
export type AutopilotView = {
  migrated: boolean; can_edit: boolean; settings: AutopilotSettings; updated_at: string | null; sources: AutopilotSource[]; agents: AgentInfo[];
  defaults: { speed: string | null; reactivation: string | null }; members: { user_id: string; role: string; name: string }[];
  lists: { id: ReactivationListId; label: string }[]; today: AutopilotToday | null; running: number;
};

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const FN = 'ai-agent';

async function call<T>(body: Record<string, unknown>): Promise<Result<T>> {
  const { data, error } = await invokeFn<Record<string, unknown>>(FN, body);
  if (error || !data) return { ok: false, error: error || 'No answer from the AI agent service.' };
  if (typeof data.error === 'string') return { ok: false, error: data.error };
  return { ok: true, ...(data as T) };
}

export function aiAgentApi(workspaceId: number) {
  const at = (action: string, more: Record<string, unknown> = {}) => ({ action, workspace_id: workspaceId, ...more });
  return {
    agents: () => call<{ agents: AgentInfo[]; can_edit: boolean }>(at('agents')),
    status: (kind: RecordKind, id: number) => call<RecordStatus>(at('status', { record_kind: kind, record_id: id })),
    log: (kind: RecordKind, id: number, limit = 50) => call<{ actions: AgentAction[] }>(at('log', { record_kind: kind, record_id: id, limit })),
    chat: (kind: RecordKind, id: number, i: { agent_key?: string; message?: string; mode?: 'auto' | 'custom'; channels?: Channel[]; contact?: Contact }) =>
      call<{ reply: string | null; enrollment: Enrollment; agent: AgentInfo }>(at('chat', { record_kind: kind, record_id: id, ...i })),
    start: (kind: RecordKind, id: number, i: { agent_key?: string; message?: string; mode?: 'auto' | 'custom'; channels?: Channel[]; contact?: Contact }) =>
      call<{ reply: string | null; enrollment: Enrollment; agent: AgentInfo }>(at('start', { record_kind: kind, record_id: id, ...i })),
    stop: (kind: RecordKind, id: number) => call<{ enrollment: Enrollment | null }>(at('stop', { record_kind: kind, record_id: id })),
    /** Switch an agent on for many records of one kind (buyers by default). */
    bulkStart: (ids: (number | string)[], i: { kind?: RecordKind; agent_key?: string; message?: string; channels?: Channel[] }) => {
      const { kind = 'buyer', ...rest } = i;
      return call<{ started: number; started_ids: number[]; skipped: { id: number; name: string; reason: string }[]; agent: AgentInfo }>(at('bulk_start', { record_kind: kind, ids, ...rest }));
    },
    /** Hand a running record to another agent now: the one named, else the agent's own next agent. */
    handoff: (kind: RecordKind, id: number, agentKey?: string) =>
      call<{ enrollment: Enrollment; agent: AgentInfo }>(at('handoff', { record_kind: kind, record_id: id, ...(agentKey ? { agent_key: agentKey } : {}) })),
    /** Owners and admins: who an agent hands to (null: a person) and when. */
    setHandoff: (agentKey: string, handoffTo: string | null, handoffOn: HandoffTrigger[]) =>
      call<{ agent_key: string; handoff_to: string | null; handoff_on: HandoffTrigger[] }>(at('set_handoff', { agent_key: agentKey, handoff_to: handoffTo, handoff_on: handoffOn })),
    bulkStop: (ids: { buyer_ids?: (number | string)[]; seller_ids?: (number | string)[] }) => call<{ stopped: number }>(at('bulk_stop', ids)),
    report: (days = 30) => call<{ days: number; agents: AgentReportRow[]; funnel?: AiFunnel | null }>(at('report', { days })),
    /** AI Autopilot: settings, sources, agents and today's numbers. */
    autopilot: () => call<AutopilotView>(at('autopilot')),
    /** Owners and admins: save the AI Autopilot settings (normalized by the function). */
    setAutopilot: (settings: AutopilotSettings) => call<AutopilotView>(at('set_autopilot', { settings })),
    /** Owners and admins: run tonight's reactivation now. */
    runReactivation: () => call<{ workspaces: number; enrolled: number; skipped: number }>(at('run_reactivation')),
    /** Owners and admins: "Call me now", the speed-to-lead agent calls this phone with a sample lead. */
    testCall: (phone: string, agentKey?: string | null) => call<{ note: string; conversation_id: string | null }>(at('test_call', { phone, ...(agentKey ? { agent_key: agentKey } : {}) })),
    /** style: a realistic headshot (default) or an illustration. */
    // A new picture shows on the activity logs from the next load, not the next sign-in.
    generateAvatar: (agentKey: string, prompt?: string, style: 'realistic' | 'illustrated' = 'realistic') => call<{ agent_key: string; avatar_url: string; provider: string }>(at('generate_avatar', { agent_key: agentKey, prompt, style }))
      .finally(() => forgetAgentFaces(workspaceId)),
    setAudience: (agentKey: string, audience: 'sellers' | 'buyers' | 'both') => call<{ agent_key: string; audience: string }>(at('set_audience', { agent_key: agentKey, audience })),
  };
}
export type AiAgentApi = ReturnType<typeof aiAgentApi>;

// ---- pure helpers the screens share (tools/ai-agent.test.ts) ----------------------------

/** VIP buyers and funds never go on an agent. The server and the database refuse them too; this keeps them off the screen's count. */
export function isProtectedBuyer(b: { vip?: boolean | null; buyerType?: string | null; entityType?: string | null; buyer_type?: string | null; entity_type?: string | null; type?: string | null }): boolean {
  if (b.vip) return true;
  const words = [b.buyerType, b.entityType, b.buyer_type, b.entity_type].map((x) => String(x ?? '').trim().toLowerCase());
  if (words.some((w) => w === 'fund' || w === 'institutional')) return true;
  // The list's label ("Fund · Flip + Rental", "Institutional · SFR Rental") when the raw columns are not on the row.
  return /^(fund|institutional)\b/i.test(String(b.type ?? '').trim());
}

export const CHANNEL_LABEL: Record<Channel, string> = { call: 'Call', rvm: 'Voicemail', sms: 'Text', email: 'Email' };
/** The ringless voicemail channel, in one line: what it does and what it needs. */
export const RVM_HELP = 'Lands as a voicemail without ringing. Needs a recording in Phone numbers, RVM, or the agent speaks the script.';
export const CHANNEL_ORDER: readonly Channel[] = ['call', 'rvm', 'sms', 'email'];

/** "in 3 hours", "tomorrow 9:00 AM", "Oct 9" for the next step line. */
export function whenLabel(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = t - nowMs;
  if (diff <= 90_000) return 'any minute now';
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)} min`;
  if (diff < 12 * 3_600_000) return `in ${Math.round(diff / 3_600_000)} hours`;
  const d = new Date(t);
  const tomorrow = new Date(nowMs + 86_400_000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ` ${time}`;
}

/** "2h ago", "3d ago". */
export function agoLabel(iso: string, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export const ACTION_TEXT: Record<string, string> = {
  started: 'Switched on', stopped: 'Switched off', auto_stopped: 'Stopped on its own', plan_created: 'Drafted the plan', plan_updated: 'Updated the plan', chat: 'Got instructions',
  sms_sent: 'Sent a text', email_sent: 'Sent an email', call_placed: 'Placed a call', rvm_sent: 'Dropped a voicemail', waited: 'Waiting', finished: 'Finished the plan', handoff: 'Handed off to a rep',
  relayed: 'Handed off to the next agent', took_over: 'Took over',
  call_reviewed: 'Reviewed the call', reply_seen: 'Saw a reply', marked_dnc: 'Asked not to be contacted', appointment_booked: 'Booked an appointment', qualification_saved: 'Saved what it learned', failed: 'Hit a problem',
};
export const actionText = (a: Pick<AgentAction, 'action' | 'status'>) =>
  a.status === 'failed' ? `${ACTION_TEXT[a.action] ?? a.action.replace(/_/g, ' ')} (failed)` : a.status === 'skipped' && a.action !== 'waited' ? `${ACTION_TEXT[a.action] ?? a.action} (skipped)` : ACTION_TEXT[a.action] ?? a.action.replace(/_/g, ' ');

/** Initials and a stable gradient for an agent with no picture yet. */
export function avatarFallback(name: string): { initials: string; from: string; to: string } {
  const words = String(name || 'AI').trim().split(/\s+/);
  const initials = ((words[0]?.[0] ?? 'A') + (words[1]?.[0] ?? '')).toUpperCase();
  let h = 0;
  for (const c of name || 'AI') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const PAIRS: [string, string][] = [['#0A8560', '#34d399'], ['#4f46e5', '#a78bfa'], ['#db2777', '#f9a8d4'], ['#0891b2', '#67e8f9'], ['#d97706', '#fcd34d'], ['#7c3aed', '#c4b5fd']];
  const [from, to] = PAIRS[h % PAIRS.length]!;
  return { initials, from, to };
}

/** Quick asks for the chat, by record kind. */
export const QUICK_ASKS: Record<RecordKind, string[]> = {
  seller: [
    'Follow up on our last conversation and get a call booked with me this week.',
    'They went quiet. Re-engage gently by text, then email, over two weeks.',
    'Confirm the property details and timeline, then set an appointment.',
  ],
  buyer: [
    'Warm them up: confirm they are still buying and get their current buy box.',
    'Re-engage this buyer. They have not replied in a while; keep it light.',
    'Ask what areas and price range they want right now and if they can close in 14 days.',
  ],
};

/** "8s", "1m 05s", "2h 10m" for speed to first touch. */
export function secondsLabel(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '–';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** One line for the autopilot's live status: what it did today. */
export function autopilotStatusLine(t: AutopilotToday | null, running: number): string {
  if (!t) return 'Apply migration 146 to switch AI Autopilot on.';
  const parts = [
    `${t.speed_enrolled} new lead${t.speed_enrolled === 1 ? '' : 's'} worked today`,
    t.median_first_touch_s !== null ? `first touch in ${secondsLabel(t.median_first_touch_s)} (median)` : '',
    `${t.calls} call${t.calls === 1 ? '' : 's'}, ${t.texts} text${t.texts === 1 ? '' : 's'}${t.emails ? `, ${t.emails} email${t.emails === 1 ? '' : 's'}` : ''}`,
    t.booked !== null ? `${t.booked} booked` : '',
    t.reactivated ? `${t.reactivated} reactivated` : '',
    `${running} on autopilot now`,
  ];
  return parts.filter(Boolean).join(' · ');
}
