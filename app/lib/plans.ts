// Action plans: the builder's model, its reads and writes, and the shape it
// exchanges with the draft-action-plan edge function.
//
// A plan in the builder is a PlanDraft — the editable, in-memory thing. It
// becomes rows in action_plans and action_plan_steps on Save and nothing
// before. Delays are "after the previous step", which is how a person reads
// a sequence top to bottom and what makes a `wait` step a step like any
// other; delay_hours (cumulative, since enrolment) is still written for the
// older readers in lib/crm.ts.

import type { Json } from './database.types';
import { pauseEnrollment, resumeEnrollment } from './crm-write';
import { supabase } from './supabase';
import { ACTION_PLAN_CATALOG } from './action-plan-catalog';
import { pinnedGroup } from './rvm-pick';
import { CAPABILITIES, CAPABILITY_LABEL, cleanAllowed, type Capability } from '../supabase/functions/_shared/plan-agent-rules';

export { CAPABILITIES, CAPABILITY_LABEL, type Capability };

// ---- model -------------------------------------------------------------------

export type StepType = 'sms' | 'email' | 'call' | 'task' | 'wait' | 'stage' | 'tag' | 'assign' | 'compr_report' | 'rvm' | 'ai_agent';
export type DelayUnit = 'minutes' | 'hours' | 'days' | 'weeks';
export type TriggerType = 'manual' | 'stage' | 'tag' | 'new_lead' | 'form';
export type Priority = 'low' | 'normal' | 'high';

export const STEP_TYPES: { v: StepType; label: string; color: string; bg: string; hint: string }[] = [
  { v: 'sms', label: 'Text', color: '#e6142e', bg: '#ffe9ec', hint: 'A text the rep sends from the record' },
  { v: 'email', label: 'Email', color: '#2563eb', bg: '#eff6ff', hint: 'An email with a subject line' },
  { v: 'call', label: 'Call', color: '#7c3aed', bg: '#f5f3ff', hint: 'Talking points for a call' },
  { v: 'task', label: 'Task', color: '#b45309', bg: '#fffbeb', hint: 'Something for the rep to do' },
  { v: 'wait', label: 'Wait', color: '#71717a', bg: '#f4f4f5', hint: 'Nothing happens until the delay passes' },
  { v: 'stage', label: 'Stage', color: '#0e7490', bg: '#ecfeff', hint: 'Move the seller to a stage' },
  { v: 'tag', label: 'Tag', color: '#be185d', bg: '#fdf2f8', hint: 'Add a tag to the seller' },
  { v: 'assign', label: 'Assign', color: '#4d7c0f', bg: '#f7fee7', hint: 'Hand the seller to a teammate' },
  { v: 'compr_report', label: 'Compr report', color: '#4338ca', bg: '#eef2ff', hint: 'Sends the Compr Seller or Compr Buyer report link' },
  { v: 'rvm', label: 'RVM', color: '#b45309', bg: '#fff7ed', hint: 'Leaves a ringless voicemail. Skips do-not-call, a recent conversation, and hours outside 8am–8pm their time.' },
  { v: 'ai_agent', label: 'AI agent', color: '#0f766e', bg: '#f0fdfa', hint: 'Give the AI a goal. When the lead reaches this step it reads their history and sends one text, adds one task or changes the status — or does nothing — and says why.' },
];
export const stepMeta = (t: string) => STEP_TYPES.find((s) => s.v === t) ?? STEP_TYPES[3];

export const DELAY_UNITS: { v: DelayUnit; label: string; minutes: number }[] = [
  { v: 'minutes', label: 'minutes', minutes: 1 },
  { v: 'hours', label: 'hours', minutes: 60 },
  { v: 'days', label: 'days', minutes: 60 * 24 },
  { v: 'weeks', label: 'weeks', minutes: 60 * 24 * 7 },
];

export const TRIGGERS: { v: TriggerType; label: string; hint: string }[] = [
  { v: 'manual', label: 'Manual enrollment', hint: 'Started by a rep from a record or the People list' },
  { v: 'stage', label: 'Stage enters…', hint: 'Starts when a seller moves into the stage' },
  { v: 'tag', label: 'Tag added…', hint: 'Starts when the tag is added to a seller' },
  { v: 'new_lead', label: 'New lead', hint: 'Starts for every seller created in the workspace' },
  { v: 'form', label: 'Form submitted', hint: 'Starts when a website form creates the lead' },
];

export const MERGE_FIELDS = ['first_name', 'name', 'address', 'city', 'state', 'zip', 'rep_name', 'rep_phone', 'company'];

export type PlanStepDraft = {
  /** Local identity for React keys and drag state; not the row id. */
  key: string;
  type: StepType;
  delay: number;
  unit: DelayUnit;
  title: string;
  /** The text / email body / talking points / task notes. */
  body: string;
  subject: string;
  priority: Priority;
  /** A teammate's user id, or '' for whoever owns the lead. */
  assignee: string;
  stage: string;
  tag: string;
  /** compr_report: whose report (the seller's, or the buyer version for the deal's buyer) and how it goes. */
  audience?: 'seller' | 'buyer';
  via?: 'sms' | 'email';
  /** rvm: recordings that share a group rotate, so the same person does not hear the same one twice. */
  variantGroup?: string;
  /** rvm: the one saved recording this step drops (vm_library.id). Set, it wins over the rotation group. */
  libraryId?: number | null;
  /** ai_agent: what the agent is told to get done; blank lets it decide from the record history. */
  goal?: string;
  /**
   * ai_agent: what the AI may do when it decides once at this step (migration
   * 140): at most one of each. Absent means the older hand-off, which switches
   * the conversational AI agent on for the record instead.
   */
  allowed?: Capability[];
  /**
   * ai_agent hand-off (no `allowed`): how the AI agent may reach the lead
   * (action_plan_steps.config.channels, migration 330). Absent on older steps,
   * which keeps their text and email only.
   */
  channels?: HandoffChannel[];
};

export type HandoffChannel = 'sms' | 'email' | 'call';
export const HANDOFF_CHANNELS: { v: HandoffChannel; label: string }[] = [{ v: 'sms', label: 'Text' }, { v: 'email', label: 'Email' }, { v: 'call', label: 'Call' }];
const cleanChannels = (v: unknown[]): HandoffChannel[] => HANDOFF_CHANNELS.map((c) => c.v).filter((c) => v.includes(c));

/** Where a lead goes when the plan ends (migration 142, action_plans.on_complete). */
export type RouteMode = 'none' | 'fixed' | 'smart';
export type OnComplete = {
  mode: RouteMode;
  /** fixed: the plan to continue in. */
  plan_id: number | null;
  /** smart: the plans the AI may pick from. */
  candidate_ids: number[];
  /** Route a run that was stopped early (a reply, a call, a stage change) too. A rep's own Stop never routes. */
  also_when_stopped: boolean;
};
export const NO_ROUTE: OnComplete = { mode: 'none', plan_id: null, candidate_ids: [], also_when_stopped: false };

/** The stored route, or the 34-era next plan read as a fixed route. */
export function parseOnComplete(j: Json | null | undefined, legacyNext: number | null = null): OnComplete {
  const o = (j && typeof j === 'object' && !Array.isArray(j) ? j : {}) as Record<string, Json | undefined>;
  const mode: RouteMode = o.mode === 'fixed' || o.mode === 'smart' || o.mode === 'none' ? o.mode : legacyNext ? 'fixed' : 'none';
  const pid = Number(o.plan_id);
  return {
    mode,
    plan_id: Number.isInteger(pid) && pid > 0 ? pid : legacyNext,
    candidate_ids: Array.isArray(o.candidate_ids) ? [...new Set(o.candidate_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [],
    also_when_stopped: o.also_when_stopped === true,
  };
}

/** The route as saved: no plan pointing at itself, nothing a mode does not use. */
export function cleanOnComplete(oc: OnComplete, selfId: number | null): OnComplete {
  const notSelf = (id: number | null) => (id && id !== selfId ? id : null);
  if (oc.mode === 'fixed') return { mode: 'fixed', plan_id: notSelf(oc.plan_id), candidate_ids: [], also_when_stopped: oc.also_when_stopped };
  if (oc.mode === 'smart') return { mode: 'smart', plan_id: null, candidate_ids: oc.candidate_ids.filter((id) => id !== selfId), also_when_stopped: oc.also_when_stopped };
  return { ...NO_ROUTE };
}

/** "then Cold lead — 7 touches" / "then AI picks from 3 plans" / "" for nothing. */
export function routeSummary(oc: OnComplete, plans: { id: number; name: string }[]): string {
  const name = (id: number | null) => plans.find((p) => p.id === id)?.name ?? 'another plan';
  const stopped = oc.also_when_stopped ? ', also when stopped' : '';
  if (oc.mode === 'fixed' && oc.plan_id) return `then “${name(oc.plan_id)}”${stopped}`;
  if (oc.mode === 'smart' && oc.candidate_ids.length) return `then AI picks from ${oc.candidate_ids.length} plan${oc.candidate_ids.length === 1 ? '' : 's'}${stopped}`;
  return '';
}

export type PlanSettings = {
  stop_on_reply: boolean;
  stop_on_call: boolean;
  stop_on_stage: boolean;
  /** Hours the steps are meant to land in; a hint for the rep and the AI. */
  business_hours: { enabled: boolean; start: string; end: string; days: number[] };
  tone: string;
  /** seller | buyer | tc | source. Catalog plans set this; a hand-built plan can leave it blank. */
  audience?: string;
  /** Auto-enroll skips a seller who already wears one of these tags. National sources use this. */
  skip_tags?: string[];
  /** A Compr campaign plan: the Suggested bucket on the Compr Buyers screen it starts for (migration 271). */
  compr_bucket?: string;
};

export type PlanDraft = {
  id: number | null;
  name: string;
  description: string;
  trigger_type: TriggerType;
  trigger_value: string;
  active: boolean;
  /** Kept equal to a fixed route's plan for older readers; on_complete is the truth. */
  on_end_next_plan_id: number | null;
  on_complete: OnComplete;
  settings: PlanSettings;
  steps: PlanStepDraft[];
};

export type PlanSummary = {
  id: number; name: string; description: string; active: boolean;
  trigger_type: TriggerType; trigger_value: string; trigger_label: string;
  step_count: number; enrolled_count: number; updated_at: string;
  on_end_next_plan_id: number | null;
  settings: PlanSettings;
};

export type EnrolledRow = {
  /** Exactly one of seller_id and buyer_id is set (migration 50). */
  id: number; seller_id: number | null; buyer_id?: number | null; name: string; addr: string;
  status: string; step: number; total: number; enrolled_at: string; stopped_reason: string | null;
  /** Migration 142: where the lead went when this run ended, and why. */
  routed?: { plan_id: number | null; reason: string; pending: boolean } | null;
  /** Migration 142: the decide-once AI steps on this run, oldest first. */
  agent?: AgentRunNote[];
};

/** One AI decision on a run, for the run table. */
export type AgentRunNote = { at: string; status: string; reason: string; actions: { kind: string; ok: boolean; detail: string }[] };

export const DEFAULT_SETTINGS: PlanSettings = {
  stop_on_reply: true, stop_on_call: false, stop_on_stage: false,
  business_hours: { enabled: true, start: '08:00', end: '20:00', days: [1, 2, 3, 4, 5, 6] },
  tone: '',
};

let keySeq = 0;
export const stepKey = () => 'k' + Date.now().toString(36) + (keySeq++).toString(36);

export function blankStep(type: StepType = 'sms'): PlanStepDraft {
  return {
    key: stepKey(), type, delay: type === 'wait' ? 1 : 0, unit: 'days', title: '', body: '', subject: '', priority: 'normal', assignee: '', stage: '', tag: '',
    // A new AI step decides once, and may do any of the three.
    ...(type === 'ai_agent' ? { goal: '', allowed: [...CAPABILITIES] } : {}),
  };
}

export function blankPlan(): PlanDraft {
  return {
    id: null, name: 'Untitled plan', description: '', trigger_type: 'manual', trigger_value: '', active: true,
    on_end_next_plan_id: null, on_complete: { ...NO_ROUTE },
    settings: { ...DEFAULT_SETTINGS, audience: 'seller', business_hours: { ...DEFAULT_SETTINGS.business_hours } },
    steps: [blankStep('sms')],
  };
}

export function triggerLabel(type: TriggerType, value: string): string {
  if (type === 'stage') return value ? `Stage → ${value}` : 'Stage enters…';
  if (type === 'tag') return value ? `Tag "${value}" added` : 'Tag added…';
  return TRIGGERS.find((t) => t.v === type)?.label ?? 'Manual enrollment';
}

export const stepMinutes = (st: { delay: number; unit: DelayUnit }) =>
  Math.max(0, Math.round(st.delay)) * (DELAY_UNITS.find((u) => u.v === st.unit)?.minutes ?? 1440);

/** "2 days" / "45 minutes" / "immediately". */
export function delayLabel(st: { delay: number; unit: DelayUnit }): string {
  if (!st.delay) return 'immediately';
  const n = Math.round(st.delay);
  const unit = n === 1 ? st.unit.replace(/s$/, '') : st.unit;
  return `${n} ${unit}`;
}

/** Minutes since enrolment → the largest unit that divides it. */
export function minutesToDelay(m: number): { delay: number; unit: DelayUnit } {
  if (m <= 0) return { delay: 0, unit: 'days' };
  if (m % (60 * 24 * 7) === 0) return { delay: m / (60 * 24 * 7), unit: 'weeks' };
  if (m % (60 * 24) === 0) return { delay: m / (60 * 24), unit: 'days' };
  if (m % 60 === 0) return { delay: m / 60, unit: 'hours' };
  return { delay: m, unit: 'minutes' };
}

/** "Day 3" / "2 hours" / "1 week" / "Immediately" → minutes since enrolment. */
export function parseDelayText(delay: string): number {
  const d = (delay || '').trim().toLowerCase();
  if (!d || /^(immediately|now|0|right away|asap)$/.test(d)) return 0;
  const day = /^day\s*(\d+)/.exec(d);
  if (day) return Math.max(0, Number(day[1]) - 1) * 1440;
  const m = /(\d+(?:\.\d+)?)\s*(minute|min|hour|hr|day|week|wk)s?/.exec(d);
  if (!m) return 0;
  const n = Number(m[1]);
  const u = m[2];
  if (/min/.test(u)) return Math.round(n);
  if (/h/.test(u)) return Math.round(n * 60);
  if (/w/.test(u)) return Math.round(n * 1440 * 7);
  return Math.round(n * 1440);
}

/** A one-line description of a step for lists, canvases and the AI diff. */
export function stepSummary(st: PlanStepDraft): string {
  const meta = stepMeta(st.type);
  if (st.type === 'wait') return `Wait ${delayLabel(st)}`;
  if (st.type === 'stage') return `Move to ${st.stage || '…'}`;
  if (st.type === 'tag') return `Add tag "${st.tag || '…'}"`;
  if (st.type === 'assign') return st.assignee ? 'Reassign the seller' : 'Assign to the lead owner';
  if (st.type === 'compr_report') return `Compr ${st.audience ?? 'seller'} report by ${st.via === 'email' ? 'email' : 'text'}`;
  if (st.type === 'rvm') return `RVM: ${st.title || st.body.replace(/\s+/g, ' ').slice(0, 60) || 'voicemail'}`;
  if (st.type === 'ai_agent' && st.allowed) return `AI decides: ${st.goal?.replace(/\s+/g, ' ').trim().slice(0, 60) || 'from the record history'}`;
  if (st.type === 'ai_agent') return `AI agent: ${st.goal?.replace(/\s+/g, ' ').trim().slice(0, 60) || 'decides from the record history'}`;
  const text = st.title || st.subject || st.body.replace(/\s+/g, ' ').slice(0, 60) || meta.label;
  return `${meta.label}: ${text}`;
}

/** What settings the plan carries, in words, for the list and the canvas. */
export function settingsSummary(s: PlanSettings): string[] {
  const out: string[] = [];
  if (s.stop_on_reply) out.push('stops on reply');
  if (s.stop_on_call) out.push('stops when a call connects');
  if (s.stop_on_stage) out.push('stops on stage change');
  if (s.business_hours.enabled) out.push(`${s.business_hours.start}–${s.business_hours.end}`);
  if (s.audience) out.push(s.audience);
  if (s.skip_tags?.length) out.push('skips ' + s.skip_tags.join(', '));
  return out;
}

// ---- rows <-> draft -------------------------------------------------------------

type PlanRow = {
  id: number; name: string; description: string | null; active: boolean;
  trigger_type: string; trigger_value: string | null; trigger_event: string | null;
  settings: Json; on_end_next_plan_id: number | null; updated_at: string;
  on_complete?: Json;
};
type StepRow = {
  id: number; position: number; channel: string; delay_hours: number; delay_minutes: number;
  title: string | null; body: string | null; subject: string | null; config: Json;
};

const isTrigger = (t: string): t is TriggerType => TRIGGERS.some((x) => x.v === t);
const isStepType = (t: string): t is StepType => STEP_TYPES.some((x) => x.v === t);

export function parseSettings(j: Json | null | undefined): PlanSettings {
  const o = (j && typeof j === 'object' && !Array.isArray(j) ? j : {}) as Record<string, Json | undefined>;
  const bh = (o.business_hours && typeof o.business_hours === 'object' && !Array.isArray(o.business_hours) ? o.business_hours : {}) as Record<string, Json | undefined>;
  return {
    stop_on_reply: typeof o.stop_on_reply === 'boolean' ? o.stop_on_reply : DEFAULT_SETTINGS.stop_on_reply,
    stop_on_call: o.stop_on_call === true,
    stop_on_stage: o.stop_on_stage === true,
    business_hours: {
      enabled: typeof bh.enabled === 'boolean' ? bh.enabled : DEFAULT_SETTINGS.business_hours.enabled,
      start: typeof bh.start === 'string' ? bh.start : DEFAULT_SETTINGS.business_hours.start,
      end: typeof bh.end === 'string' ? bh.end : DEFAULT_SETTINGS.business_hours.end,
      days: Array.isArray(bh.days) ? bh.days.filter((d): d is number => typeof d === 'number') : [...DEFAULT_SETTINGS.business_hours.days],
    },
    tone: typeof o.tone === 'string' ? o.tone : '',
    ...(typeof o.audience === 'string' && o.audience ? { audience: o.audience } : {}),
    ...(Array.isArray(o.skip_tags) ? { skip_tags: o.skip_tags.filter((t): t is string => typeof t === 'string' && t.length > 0) } : {}),
    ...(typeof o.compr_bucket === 'string' && o.compr_bucket ? { compr_bucket: o.compr_bucket } : {}),
  };
}

export function stepFromRow(r: StepRow): PlanStepDraft {
  const cfg = (r.config && typeof r.config === 'object' && !Array.isArray(r.config) ? r.config : {}) as Record<string, Json | undefined>;
  const d = minutesToDelay(r.delay_minutes ?? 0);
  const pr = cfg.priority;
  return {
    key: 'row' + r.id,
    type: isStepType(r.channel) ? r.channel : 'task',
    delay: d.delay, unit: d.unit,
    title: r.title ?? '', body: r.body ?? '', subject: r.subject ?? '',
    priority: pr === 'low' || pr === 'high' ? pr : 'normal',
    assignee: typeof cfg.assignee === 'string' ? cfg.assignee : '',
    stage: typeof cfg.stage === 'string' ? cfg.stage : '',
    tag: typeof cfg.tag === 'string' ? cfg.tag : '',
    ...(r.channel === 'compr_report' ? { audience: cfg.audience === 'buyer' ? 'buyer' : 'seller', via: cfg.via === 'email' ? 'email' : 'sms' } as const : {}),
    ...(r.channel === 'rvm' && typeof cfg.variant_group === 'string' && !/^clip-\d+$/.test(cfg.variant_group) ? { variantGroup: cfg.variant_group } : {}),
    ...(r.channel === 'rvm' && typeof cfg.library_id === 'number' ? { libraryId: cfg.library_id } : {}),
    ...(r.channel === 'ai_agent' ? { goal: typeof cfg.goal === 'string' ? cfg.goal : '' } : {}),
    ...(r.channel === 'ai_agent' && Array.isArray(cfg.allowed) ? { allowed: cleanAllowed(cfg.allowed) } : {}),
    ...(r.channel === 'ai_agent' && Array.isArray(cfg.channels) ? { channels: cleanChannels(cfg.channels) } : {}),
  };
}

function catalogSettings(p: (typeof ACTION_PLAN_CATALOG)[number]): PlanSettings {
  return {
    ...DEFAULT_SETTINGS,
    stop_on_reply: p.stop_on_reply,
    stop_on_stage: p.stop_on_stage,
    tone: p.tone,
    audience: p.audience,
    business_hours: { ...DEFAULT_SETTINGS.business_hours, days: [...DEFAULT_SETTINGS.business_hours.days] },
    ...(p.skip_tags.length ? { skip_tags: [...p.skip_tags] } : {}),
  };
}

/** The Acme Homes catalog as a local list, for a session with no workspace. */
export function catalogPreviewPlans(): PlanSummary[] {
  return ACTION_PLAN_CATALOG.map((p, i) => ({
    id: i + 1,
    name: p.name,
    description: p.description,
    active: p.active,
    trigger_type: p.trigger_type,
    trigger_value: p.trigger_value,
    trigger_label: triggerLabel(p.trigger_type, p.trigger_value),
    step_count: p.steps.length,
    enrolled_count: 0,
    updated_at: new Date(0).toISOString(),
    on_end_next_plan_id: null,
    settings: catalogSettings(p),
  }));
}

export function catalogPreviewDraft(id: number): PlanDraft | null {
  const p = ACTION_PLAN_CATALOG[id - 1];
  if (!p) return null;
  return {
    id,
    name: p.name,
    description: p.description,
    trigger_type: p.trigger_type,
    trigger_value: p.trigger_value,
    active: p.active,
    on_end_next_plan_id: null,
    on_complete: { ...NO_ROUTE },
    settings: catalogSettings(p),
    steps: p.steps.map((st, n) => ({
      key: `cat${id}s${n}`,
      type: st.type,
      delay: st.delay,
      unit: st.unit,
      title: st.title,
      body: st.body,
      subject: st.subject ?? '',
      priority: st.priority ?? 'normal',
      assignee: '',
      stage: '',
      tag: '',
    })),
  };
}

function summaryFromRow(r: PlanRow, stepCount: number, enrolled: number): PlanSummary {
  const tt = isTrigger(r.trigger_type) ? r.trigger_type : 'manual';
  return {
    id: r.id, name: r.name, description: r.description ?? '', active: r.active,
    trigger_type: tt, trigger_value: r.trigger_value ?? '',
    trigger_label: tt === 'manual' && r.trigger_event && r.trigger_event !== 'Manual' && r.trigger_event !== 'Manual enrollment'
      ? r.trigger_event : triggerLabel(tt, r.trigger_value ?? ''),
    step_count: stepCount, enrolled_count: enrolled, updated_at: r.updated_at,
    on_end_next_plan_id: r.on_end_next_plan_id, settings: parseSettings(r.settings),
  };
}

// ---- reads ----------------------------------------------------------------------------

/** A database without migration 142: its columns and table read as absent, not as an error. */
const before142 = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42703' || e.code === '42P01' || e.code === 'PGRST204' || e.code === 'PGRST205' || /on_complete|routed_|route_state|plan_agent_runs/.test(e.message ?? ''));

const PLAN_COLS = 'id,name,description,active,trigger_type,trigger_value,trigger_event,settings,on_end_next_plan_id,updated_at,on_complete' as const;
const PLAN_COLS_139 = 'id,name,description,active,trigger_type,trigger_value,trigger_event,settings,on_end_next_plan_id,updated_at' as const;

const catalogEnsured = new Set<number>();

/**
 * Insert any Acme Homes catalog plan this workspace does not already have,
 * matched by name. An edited plan keeps its name and is not overwritten.
 * A Compr workspace sells software, not houses: it gets none of them
 * (migration 271 seeds its own plans).
 */
export async function ensureCatalogPlans(workspaceId: number, userId: string | null): Promise<void> {
  if (!supabase || catalogEnsured.has(workspaceId)) return;
  catalogEnsured.add(workspaceId);
  const ws = await supabase.from('workspaces').select('buyer_profile:settings->>buyer_profile').eq('id', workspaceId).maybeSingle();
  if (ws.error) { catalogEnsured.delete(workspaceId); return; }
  if ((ws.data as { buyer_profile?: unknown } | null)?.buyer_profile === 'compr') return;
  const { data, error } = await supabase.from('action_plans').select('name').eq('workspace_id', workspaceId);
  if (error) { catalogEnsured.delete(workspaceId); return; }
  const have = new Set((data ?? []).map((r) => r.name));
  for (const plan of ACTION_PLAN_CATALOG) {
    if (have.has(plan.name)) continue;
    const draft: PlanDraft = {
      id: null,
      name: plan.name,
      description: plan.description,
      trigger_type: plan.trigger_type,
      trigger_value: plan.trigger_value,
      active: plan.active,
      on_end_next_plan_id: null,
      on_complete: { ...NO_ROUTE },
      settings: {
        ...DEFAULT_SETTINGS,
        business_hours: { ...DEFAULT_SETTINGS.business_hours },
        stop_on_reply: plan.stop_on_reply,
        stop_on_stage: plan.stop_on_stage,
        tone: plan.tone,
        audience: plan.audience,
        skip_tags: [...plan.skip_tags],
      },
      steps: plan.steps.map((st, i) => ({
        key: plan.audience + '-' + i,
        type: st.type,
        delay: st.delay,
        unit: st.unit,
        title: st.title,
        body: st.body,
        subject: st.subject ?? '',
        priority: st.priority ?? 'normal',
        assignee: '',
        stage: '',
        tag: '',
      })),
    };
    const saved = await savePlanDraft(workspaceId, draft, userId);
    if (!saved.ok) catalogEnsured.delete(workspaceId);
  }
}

export async function listPlans(workspaceId: number): Promise<{ ok: boolean; plans: PlanSummary[]; message?: string }> {
  if (!supabase) return { ok: false, plans: [], message: 'Supabase is not configured.' };
  const readPlans = async () => {
    const r = await supabase!.from('action_plans').select(PLAN_COLS).eq('workspace_id', workspaceId).order('updated_at', { ascending: false });
    return before142(r.error) ? supabase!.from('action_plans').select(PLAN_COLS_139).eq('workspace_id', workspaceId).order('updated_at', { ascending: false }) : r;
  };
  const [{ data: plans, error }, { data: steps }, { data: enrolled }] = await Promise.all([
    readPlans(),
    supabase.from('action_plan_steps').select('plan_id').eq('workspace_id', workspaceId),
    supabase.from('enrollments').select('plan_id').eq('workspace_id', workspaceId).in('status', ['active', 'paused']),
  ]);
  if (error) return { ok: false, plans: [], message: error.message };
  const count = (rows: { plan_id: number }[] | null) => {
    const m = new Map<number, number>();
    for (const r of rows ?? []) m.set(r.plan_id, (m.get(r.plan_id) ?? 0) + 1);
    return m;
  };
  const sc = count(steps);
  const ec = count(enrolled);
  return { ok: true, plans: (plans ?? []).map((p) => summaryFromRow(p as PlanRow, sc.get(p.id) ?? 0, ec.get(p.id) ?? 0)) };
}

export async function loadPlan(planId: number): Promise<{ ok: boolean; plan?: PlanDraft; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const readPlan = async () => {
    const r = await supabase!.from('action_plans').select(PLAN_COLS).eq('id', planId).maybeSingle();
    return before142(r.error) ? supabase!.from('action_plans').select(PLAN_COLS_139).eq('id', planId).maybeSingle() : r;
  };
  const [{ data: p, error }, { data: steps }] = await Promise.all([
    readPlan(),
    supabase.from('action_plan_steps')
      .select('id,position,channel,delay_hours,delay_minutes,title,body,subject,config')
      .eq('plan_id', planId).order('position'),
  ]);
  if (error) return { ok: false, message: error.message };
  if (!p) return { ok: false, message: 'That plan is gone.' };
  const row = p as PlanRow;
  return {
    ok: true,
    plan: {
      id: row.id, name: row.name, description: row.description ?? '',
      trigger_type: isTrigger(row.trigger_type) ? row.trigger_type : 'manual',
      trigger_value: row.trigger_value ?? '', active: row.active,
      on_end_next_plan_id: row.on_end_next_plan_id, on_complete: parseOnComplete(row.on_complete, row.on_end_next_plan_id),
      settings: parseSettings(row.settings),
      steps: ((steps ?? []) as StepRow[]).map(stepFromRow),
    },
  };
}

export async function listEnrolled(planId: number): Promise<EnrolledRow[]> {
  if (!supabase) return [];
  type Row = {
    id: number; seller_id: number | null; buyer_id: number | null; status: string; step_index: number; enrolled_at: string; stopped_reason: string | null;
    sellers: unknown; buyers: unknown; routed_plan_id?: number | null; routed_reason?: string | null; route_state?: string | null;
  };
  let rows: Row[] = [];
  const r = await supabase.from('enrollments')
    .select('id,seller_id,buyer_id,status,step_index,enrolled_at,stopped_reason,routed_plan_id,routed_reason,route_state,sellers(name,property_address),buyers(name,company,email)')
    .eq('plan_id', planId).order('enrolled_at', { ascending: false }).limit(200);
  if (before142(r.error)) {
    const old = await supabase.from('enrollments')
      .select('id,seller_id,buyer_id,status,step_index,enrolled_at,stopped_reason,sellers(name,property_address),buyers(name,company,email)')
      .eq('plan_id', planId).order('enrolled_at', { ascending: false }).limit(200);
    rows = (old.data ?? []) as Row[];
  } else rows = (r.data ?? []) as Row[];
  const { count } = await supabase.from('action_plan_steps').select('id', { count: 'exact', head: true }).eq('plan_id', planId).neq('channel', 'wait');

  // The AI decisions on these runs, oldest first.
  const notes = new Map<number, AgentRunNote[]>();
  const ids = rows.map((e) => e.id);
  if (ids.length) {
    const { data: runs, error } = await supabase.from('plan_agent_runs')
      .select('enrollment_id,status,reason,actions,created_at,finished_at').in('enrollment_id', ids).order('created_at', { ascending: true }).limit(1000);
    if (!error) {
      for (const run of runs ?? []) {
        if (run.enrollment_id == null) continue;
        const acts = (Array.isArray(run.actions) ? run.actions : []) as { kind?: unknown; ok?: unknown; detail?: unknown }[];
        const list = notes.get(run.enrollment_id) ?? [];
        list.push({
          at: run.finished_at ?? run.created_at, status: run.status, reason: run.reason ?? '',
          actions: acts.map((a) => ({ kind: String(a.kind ?? ''), ok: a.ok === true, detail: String(a.detail ?? '') })),
        });
        notes.set(run.enrollment_id, list);
      }
    }
  }

  return rows.filter((e) => e.seller_id !== null || e.buyer_id !== null).map((e) => {
    const s = e.sellers as { name: string; property_address: string | null } | null;
    const b = e.buyers as { name: string | null; company: string | null; email: string | null } | null;
    const who = e.seller_id !== null
      ? { name: s?.name ?? 'Seller', addr: s?.property_address ?? '' }
      : { name: b?.name?.trim() || b?.email || 'Buyer', addr: b?.company?.trim() || b?.email || '' };
    return {
      id: e.id, seller_id: e.seller_id, buyer_id: e.buyer_id, ...who,
      status: e.status, step: e.step_index, total: count ?? 0, enrolled_at: e.enrolled_at, stopped_reason: e.stopped_reason,
      routed: e.routed_reason ? { plan_id: e.routed_plan_id ?? null, reason: e.routed_reason, pending: e.route_state === 'pending' } : null,
      agent: notes.get(e.id) ?? [],
    };
  });
}

export type SellerPick = { id: number; name: string; addr: string; stage: string; tags: string[] };

export async function listSellerPicks(workspaceId: number): Promise<SellerPick[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('sellers').select('id,name,property_address,lead_stage,tags')
    .eq('workspace_id', workspaceId).is('archived_at', null).order('name').limit(2000);
  return (data ?? []).map((s) => ({ id: s.id, name: s.name, addr: s.property_address ?? '', stage: s.lead_stage, tags: s.tags ?? [] }));
}

export type Teammate = { id: string; name: string };

export async function listTeammates(workspaceId: number): Promise<Teammate[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('workspace_roster').select('user_id,full_name,email').eq('workspace_id', workspaceId);
  return (data ?? []).map((r) => ({ id: r.user_id, name: r.full_name || r.email || 'Teammate' }));
}

// ---- writes ---------------------------------------------------------------------------

export type SaveResult = { ok: boolean; id?: number; message?: string };

/**
 * Create or replace a plan and its steps. Steps are replaced wholesale — a
 * plan is edited as one thing, and diffing rows buys nothing but the chance
 * to leave a stale one behind. Queued tasks keep their plan_step_id only
 * through ON DELETE SET NULL; the task itself stays.
 */
export async function savePlanDraft(workspaceId: number, plan: PlanDraft, userId: string | null): Promise<SaveResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const name = plan.name.trim() || 'Untitled plan';
  const route = cleanOnComplete(plan.on_complete ?? parseOnComplete(null, plan.on_end_next_plan_id), plan.id);
  const head = {
    name,
    description: plan.description.trim() || null,
    trigger_type: plan.trigger_type,
    trigger_value: plan.trigger_type === 'stage' || plan.trigger_type === 'tag' ? plan.trigger_value.trim() || null : null,
    trigger_event: triggerLabel(plan.trigger_type, plan.trigger_value),
    active: plan.active,
    on_end_next_plan_id: route.mode === 'fixed' ? route.plan_id : null,
    settings: plan.settings as unknown as Json,
  };
  // Before migration 142 the route column is missing: save without it (a fixed route still chains through on_end_next_plan_id).
  const withRoute = { ...head, on_complete: route as unknown as Json };
  let planId = plan.id;
  if (planId) {
    const stamp = new Date().toISOString();
    let { error } = await supabase.from('action_plans').update({ ...withRoute, updated_at: stamp }).eq('id', planId);
    if (before142(error)) ({ error } = await supabase.from('action_plans').update({ ...head, updated_at: stamp }).eq('id', planId));
    if (error) return { ok: false, message: error.message };
    const { error: delErr } = await supabase.from('action_plan_steps').delete().eq('plan_id', planId);
    if (delErr) return { ok: false, message: delErr.message };
  } else {
    let made = await supabase.from('action_plans')
      .insert({ workspace_id: workspaceId, created_by: userId, ...withRoute }).select('id').single();
    if (before142(made.error)) made = await supabase.from('action_plans').insert({ workspace_id: workspaceId, created_by: userId, ...head }).select('id').single();
    if (made.error) return { ok: false, message: made.error.message };
    planId = made.data.id;
  }
  if (plan.steps.length) {
    let cumulative = 0;
    const rows = plan.steps.map((st, i) => {
      const mins = stepMinutes(st);
      cumulative += mins;
      const config: Record<string, Json> = {};
      if (st.type === 'task' || st.type === 'call' || st.type === 'sms' || st.type === 'email') config.priority = st.priority;
      if (st.assignee) config.assignee = st.assignee;
      if (st.type === 'stage') config.stage = st.stage;
      if (st.type === 'tag') config.tag = st.tag;
      if (st.type === 'compr_report') { config.audience = st.audience ?? 'seller'; config.via = st.via ?? 'sms'; }
      // A picked recording pins the step to it (lib/rvm-pick.ts); otherwise the group rotates.
      if (st.type === 'rvm' && st.libraryId) { config.library_id = st.libraryId; config.variant_group = pinnedGroup(st.libraryId); }
      else if (st.type === 'rvm') config.variant_group = st.variantGroup?.trim() || 'default';
      if (st.type === 'ai_agent') config.goal = st.goal?.trim() ?? '';
      if (st.type === 'ai_agent' && st.allowed) config.allowed = cleanAllowed(st.allowed);
      if (st.type === 'ai_agent' && !st.allowed && st.channels) config.channels = cleanChannels(st.channels);
      return {
        workspace_id: workspaceId, plan_id: planId!, position: i,
        channel: st.type, delay_minutes: mins, delay_hours: Math.round(cumulative / 60),
        title: st.title.trim() || null, body: st.body.trim() || null,
        subject: st.type === 'email' || (st.type === 'compr_report' && st.via === 'email') ? st.subject.trim() || null : null,
        config: config as Json,
      };
    });
    const { error } = await supabase.from('action_plan_steps').insert(rows);
    if (error) return { ok: false, message: error.message };
  }
  return { ok: true, id: planId! };
}

export async function deletePlanById(planId: number): Promise<SaveResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('action_plans').delete().eq('id', planId);
  return error ? { ok: false, message: error.message } : { ok: true };
}

/**
 * Turn a plan on or off.
 *
 * Off holds everyone currently running it (their open steps come off the
 * list) and stops triggers from starting anyone new. On puts those held
 * people back, and leaves anyone who was paused by hand still paused.
 */
export async function setPlanActive(planId: number, active: boolean): Promise<SaveResult & { held?: number }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('action_plans').update({ active, updated_at: new Date().toISOString() }).eq('id', planId);
  if (error) return { ok: false, message: error.message };
  if (!active) {
    const { data } = await supabase.from('enrollments').select('id').eq('plan_id', planId).eq('status', 'active');
    const ids = (data ?? []).map((r) => r.id);
    for (const id of ids) {
      const r = await pauseEnrollment(id, 'plan_paused');
      if (!r.ok) return { ok: false, message: r.message, held: ids.length };
    }
    return { ok: true, held: ids.length };
  }
  const { data } = await supabase.from('enrollments').select('id').eq('plan_id', planId).eq('status', 'paused').eq('stopped_reason', 'plan_paused');
  let held = 0;
  for (const row of data ?? []) {
    const r = await resumeEnrollment(row.id);
    if (!r.ok) return { ok: false, message: r.message, held };
    held += 1;
  }
  return { ok: true, held };
}

/** A copy of a plan, inactive, ready to edit. */
export function duplicateDraft(plan: PlanDraft): PlanDraft {
  return {
    ...plan, id: null, name: `${plan.name} (copy)`, active: false,
    settings: { ...plan.settings, business_hours: { ...plan.settings.business_hours, days: [...plan.settings.business_hours.days] } },
    steps: plan.steps.map((st) => ({ ...st, key: stepKey() })),
  };
}

export { pauseEnrollment, resumeEnrollment };

/** Stop one enrolment by hand: the row is done, the queued work is gone. */
export async function stopEnrollment(enrollmentId: number): Promise<SaveResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('enrollments')
    .update({ status: 'done', completed_at: new Date().toISOString(), stopped_reason: 'manual' })
    .eq('id', enrollmentId);
  if (error) return { ok: false, message: error.message };
  await supabase.from('tasks').delete().eq('enrollment_id', enrollmentId).eq('done', false);
  return { ok: true };
}

/**
 * stopEnrollment for many (the bulk bars): one update and one task delete per
 * 200 ids instead of two requests each. `done` counts the ids in batches that
 * saved; `ok` is false, with the first refusal in `message`, when any batch
 * was refused (the others still go).
 */
export async function stopEnrollments(enrollmentIds: number[]): Promise<SaveResult & { done: number }> {
  if (!supabase) return { ok: false, done: 0, message: 'Supabase is not configured.' };
  let done = 0;
  let message: string | undefined;
  for (let i = 0; i < enrollmentIds.length; i += 200) {
    const ids = enrollmentIds.slice(i, i + 200);
    const { error } = await supabase.from('enrollments')
      .update({ status: 'done', completed_at: new Date().toISOString(), stopped_reason: 'manual' })
      .in('id', ids);
    if (error) { message ??= error.message; continue; }
    await supabase.from('tasks').delete().in('enrollment_id', ids).eq('done', false);
    done += ids.length;
  }
  return message ? { ok: false, done, message } : { ok: true, done };
}

// ---- the AI's shape --------------------------------------------------------------------

/**
 * What draft-action-plan sends and receives. Delays are text relative to
 * enrolment ("Immediately", "2 hours", "Day 3") because that is how the
 * model reads and writes a sequence; the builder differences them into
 * per-step waits and back.
 */
export type AiStep = {
  channel: string; delay: string; title: string; content: string;
  subject?: string; stage?: string; tag?: string; priority?: string;
  /** compr_report only. */
  audience?: string; via?: string;
};
export type AiPlan = {
  name: string; trigger: string; description: string; steps: AiStep[];
  settings?: { stop_on_reply?: boolean; stop_on_call?: boolean; stop_on_stage?: boolean; tone?: string };
};

/** Model → draft. Keeps the plan's id, trigger and next-plan link. */
export function draftFromAi(ai: AiPlan, base: PlanDraft | null): PlanDraft {
  const prev = base ?? blankPlan();
  let last = 0;
  const steps: PlanStepDraft[] = ai.steps.map((s) => {
    const abs = parseDelayText(s.delay);
    const rel = Math.max(0, abs - last);
    last = Math.max(last, abs);
    const type: StepType = isStepType(s.channel) ? s.channel : 'task';
    const d = minutesToDelay(rel);
    const pr = s.priority;
    const agent = type === 'ai_agent';
    return {
      key: stepKey(), type, delay: d.delay, unit: d.unit,
      title: s.title ?? '', body: agent ? '' : s.content ?? '', subject: s.subject ?? '',
      priority: pr === 'low' || pr === 'high' ? pr : 'normal',
      assignee: '', stage: s.stage ?? '', tag: s.tag ?? '',
      ...(type === 'compr_report' ? { audience: s.audience === 'buyer' ? 'buyer' : 'seller', via: s.via === 'email' ? 'email' : 'sms' } as const : {}),
      ...(agent ? { goal: s.content ?? '', allowed: [...CAPABILITIES] } : {}),
    };
  });
  const trig = triggerFromText(ai.trigger, prev);
  return {
    ...prev,
    name: ai.name?.trim() || prev.name,
    description: ai.description ?? prev.description,
    trigger_type: trig.type, trigger_value: trig.value,
    settings: {
      ...prev.settings,
      stop_on_reply: ai.settings?.stop_on_reply ?? prev.settings.stop_on_reply,
      stop_on_call: ai.settings?.stop_on_call ?? prev.settings.stop_on_call,
      stop_on_stage: ai.settings?.stop_on_stage ?? prev.settings.stop_on_stage,
      tone: ai.settings?.tone ?? prev.settings.tone,
    },
    steps: steps.length ? steps : prev.steps,
  };
}

function triggerFromText(t: string | undefined, prev: PlanDraft): { type: TriggerType; value: string } {
  const s = (t ?? '').trim();
  if (!s) return { type: prev.trigger_type, value: prev.trigger_value };
  const stage = /stage\s*(?:→|->|enters|:)\s*(.+)/i.exec(s);
  if (stage) return { type: 'stage', value: stage[1].trim() };
  const tag = /tag\s*"?([^"]+?)"?\s*(?:added|applied)/i.exec(s) ?? /tag\s*(?:→|->|added|:)\s*"?([^"]+?)"?$/i.exec(s);
  if (tag) return { type: 'tag', value: tag[1].trim() };
  if (/new lead|new seller|every new/i.test(s)) return { type: 'new_lead', value: '' };
  if (/form/i.test(s)) return { type: 'form', value: '' };
  return { type: 'manual', value: '' };
}

/** Draft → what the model is shown when asked to edit. */
export function aiFromDraft(plan: PlanDraft): AiPlan {
  let cumulative = 0;
  return {
    name: plan.name, description: plan.description,
    trigger: triggerLabel(plan.trigger_type, plan.trigger_value),
    settings: { stop_on_reply: plan.settings.stop_on_reply, stop_on_call: plan.settings.stop_on_call, stop_on_stage: plan.settings.stop_on_stage, tone: plan.settings.tone },
    steps: plan.steps.map((st) => {
      cumulative += stepMinutes(st);
      const d = minutesToDelay(cumulative);
      return {
        channel: st.type, delay: cumulative === 0 ? 'Immediately' : delayLabel(d),
        title: st.title, content: st.type === 'ai_agent' ? st.goal ?? '' : st.body,
        subject: st.type === 'email' ? st.subject : undefined,
        stage: st.type === 'stage' ? st.stage : undefined,
        tag: st.type === 'tag' ? st.tag : undefined,
        priority: st.priority !== 'normal' ? st.priority : undefined,
        ...(st.type === 'compr_report' ? { audience: st.audience ?? 'seller', via: st.via ?? 'sms' } : {}),
      };
    }),
  };
}

/** Lines describing what changed between two drafts, for the review banner. */
export function diffDrafts(before: PlanDraft, after: PlanDraft): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`Renamed to "${after.name}"`);
  if (before.description !== after.description) out.push('Description rewritten');
  if (before.trigger_type !== after.trigger_type || before.trigger_value !== after.trigger_value) out.push(`Trigger → ${triggerLabel(after.trigger_type, after.trigger_value)}`);
  (['stop_on_reply', 'stop_on_call', 'stop_on_stage'] as const).forEach((k) => {
    if (before.settings[k] !== after.settings[k]) out.push(`${after.settings[k] ? 'On' : 'Off'}: ${k.replace(/_/g, ' ')}`);
  });
  const a = before.steps, b = after.steps;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (!x) { out.push(`Step ${i + 1} added — ${stepSummary(y)}`); continue; }
    if (!y) { out.push(`Step ${i + 1} removed — ${stepSummary(x)}`); continue; }
    const changed: string[] = [];
    if (x.type !== y.type) changed.push(`${stepMeta(x.type).label} → ${stepMeta(y.type).label}`);
    if (stepMinutes(x) !== stepMinutes(y)) changed.push(`wait ${delayLabel(x)} → ${delayLabel(y)}`);
    if (x.title !== y.title) changed.push('title');
    if (x.body !== y.body || x.goal !== y.goal) changed.push('message');
    if (x.subject !== y.subject) changed.push('subject');
    if (x.stage !== y.stage || x.tag !== y.tag || x.audience !== y.audience || x.via !== y.via) changed.push('target');
    if ((x.allowed ?? []).join() !== (y.allowed ?? []).join()) changed.push('what the AI may do');
    if (changed.length) out.push(`Step ${i + 1} — ${changed.join(', ')}`);
  }
  return out.length ? out : ['No changes'];
}

/** Two drafts that would save the same rows. */
export function sameDraft(a: PlanDraft, b: PlanDraft): boolean {
  const strip = (p: PlanDraft) => JSON.stringify({ ...p, steps: p.steps.map((s) => ({ ...s, key: '' })) });
  return strip(a) === strip(b);
}

// ---- a little cross-screen memory ---------------------------------------------------------

const LAST_KEY = 'clozr.plans.last';
export function rememberPlan(id: number | null) {
  try { if (id) sessionStorage.setItem(LAST_KEY, String(id)); else sessionStorage.removeItem(LAST_KEY); } catch { /* private mode */ }
}
export function lastPlan(): number | null {
  try { const v = sessionStorage.getItem(LAST_KEY); return v ? Number(v) : null; } catch { return null; }
}
