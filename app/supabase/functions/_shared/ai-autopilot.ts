// AI Autopilot (migration 146): the rules that put new and aged leads on an AI
// agent without anyone switching it on. Three programs per workspace:
//
//   speed         a new seller from a lead source the owner picked is called
//                 (or texted) within seconds, inside the legal calling window
//                 in the lead's own time zone, weekends included. A call that
//                 is not answered gets a text; outside the window a text goes
//                 out (when the owner allows it) and the call waits for the
//                 window to open.
//   followup      a speed lead that was not reached or not booked stays on an
//                 agent with a cadence (day 0 call + text, 1, 2, 4, 7, 14, 30,
//                 then monthly) until a stop rule fires.
//   reactivation  every night, aged leads from the People smart lists
//                 (Reactivation, Dead Leads, No Contact: lib/reactivation.ts,
//                 the same rules) quiet for N days, up to a daily cap, go on
//                 an agent to re-engage, re-qualify and book.
//
// Pure: no I/O, so tools/ai-autopilot.test.ts runs it under tsx. ai-agent/index.ts
// does the reading, sending and writing; the cadence and the stop rules sit on
// top of the existing tick, so every guard rail of _shared/ai-agent.ts (DNC, the
// sending window, the 20-hour gap, the touch cap, no prices in writing, the
// opt-out line) still holds for every touch after the first.
import { zoneForRvm } from '../../../lib/rvm.ts';
import { NEVER_REACTIVATE, REACTIVATION_LISTS, reactivationListsOf, type ReactivationList } from '../../../lib/reactivation.ts';
import { sellerStageGroup } from '../../../lib/stages.ts';
import { CHANNELS, RVM_GAP_DAYS, mentionsMoney, type Channel, type Plan, type PlanStep } from './ai-agent.ts';

export type Program = 'speed' | 'followup' | 'reactivation';
export const PROGRAMS: readonly Program[] = ['speed', 'followup', 'reactivation'];

/** The speed-to-lead schedule: hours (in the lead's own time zone) and the days it runs. No days given: every day. */
export type Window = { start: string; end: string; days?: string[] };
export const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** The TCPA calling window (8am to 9pm, the called party's local time). The owner may narrow it, never widen it. */
export const LEGAL_WINDOW: Window = { start: '08:00', end: '21:00' };
/** The default schedule: 24/7, inside the legal window. */
export const DEFAULT_SCHEDULE: Window = { start: '08:00', end: '21:00', days: [...WEEK] };
export const DEFAULT_CADENCE = [0, 1, 2, 4, 7, 14, 30, 60];
/** The reactivation cadence: days from the first look. */
export const REACTIVATION_CADENCE = [0, 3, 7, 14, 30];

export type AutopilotSettings = {
  /** The member texts and emails go out as when the lead has no rep. Null: the workspace owner. */
  send_as: string | null;
  /**
   * The workspace's daily ceiling on what the AI agents spend, counted from
   * local midnight across every agent and program (a rep's own switch too).
   * touches: texts, emails, calls and ringless voicemails sent (SMS, voice minutes, drops).
   * steps: every turn an agent takes on a lead (each one is a Claude call).
   * Over either, the rest wait for tomorrow morning instead of running.
   */
  limits: { daily_touches: number; daily_steps: number };
  speed: {
    enabled: boolean;
    /** sellers.source values (case-insensitive). Nothing is speed-dialed until the owner picks a source. */
    sources: string[];
    /** Null: the workspace's lead manager. */
    agent_key: string | null;
    /** In order of preference: a call first when the agent can call, else a text right away. */
    channels: Channel[];
    window: Window;
    /** Outside the window: text now and call when it opens (true), or wait for the window (false). */
    after_hours_text: boolean;
    /** How long to wait for an unanswered call before the fallback text. */
    fallback_minutes: number;
    /** A lead older than this when its turn comes is not new: it is skipped. */
    max_lead_age_hours: number;
  };
  followup: {
    enabled: boolean;
    /** Null: the speed agent keeps the lead. */
    agent_key: string | null;
    cadence_days: number[];
    max_touches: number;
    channels: Channel[];
  };
  reactivation: {
    enabled: boolean;
    agent_key: string | null;
    /** Which People smart lists it draws from (lib/reactivation.ts). */
    lists: ReactivationList[];
    /** Empty: any source. */
    sources: string[];
    idle_days: number;
    daily_cap: number;
    channels: Channel[];
    max_touches: number;
  };
};

export const DEFAULT_AUTOPILOT: AutopilotSettings = {
  send_as: null,
  limits: { daily_touches: 150, daily_steps: 500 },
  speed: {
    enabled: false, sources: [], agent_key: null, channels: ['call', 'sms', 'email'], window: { ...DEFAULT_SCHEDULE }, after_hours_text: true,
    fallback_minutes: 3, max_lead_age_hours: 48,
  },
  followup: { enabled: true, agent_key: null, cadence_days: [...DEFAULT_CADENCE], max_touches: 20, channels: ['call', 'sms', 'email'] },
  reactivation: {
    enabled: false, agent_key: null, lists: [...REACTIVATION_LISTS], sources: [], idle_days: 90, daily_cap: 25, channels: ['sms', 'email'], max_touches: 8,
  },
};

const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== null && v !== '' && v !== undefined ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
const strList = (v: unknown, max = 100, len = 120): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = String(x ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, len);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};
const key = (v: unknown) => (typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v) ? v : null);
const uuid = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null);
const hhmm = (v: unknown, dflt: string) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : dflt);
const minsOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Channels in the order given, known ones only, no repeats. Empty input gives the fallback. */
export function orderedChannels(v: unknown, fallback: Channel[]): Channel[] {
  const out: Channel[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const c = String(x).toLowerCase();
    if ((CHANNELS as readonly string[]).includes(c) && !out.includes(c as Channel)) out.push(c as Channel);
  }
  return out.length ? out : [...fallback];
}

/** A window inside the legal one: the owner may start later or end earlier, never call before 8am or after 9pm. */
export function clampWindow(v: unknown): Window {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const list = Array.isArray(o.days) ? o.days.map((d) => String(d).toLowerCase().slice(0, 3)) : [...WEEK];
  const days = WEEK.filter((d) => list.includes(d));
  let start = hhmm(o.start, LEGAL_WINDOW.start);
  let end = hhmm(o.end, LEGAL_WINDOW.end);
  if (minsOf(start) < minsOf(LEGAL_WINDOW.start)) start = LEGAL_WINDOW.start;
  if (minsOf(end) > minsOf(LEGAL_WINDOW.end)) end = LEGAL_WINDOW.end;
  if (minsOf(end) - minsOf(start) < 60) return { ...LEGAL_WINDOW, days: days.length ? days : [...WEEK] };
  return { start, end, days: days.length ? days : [...WEEK] };
}

/** The cadence, cleaned: whole days 0 to 60, ascending, unique, starting at day 0, at most 12. */
export function cleanCadence(v: unknown): number[] {
  const days = (Array.isArray(v) ? v : []).map((d) => Math.round(Number(d))).filter((d) => Number.isFinite(d) && d >= 0 && d <= 60);
  const out = [...new Set([0, ...days])].sort((a, b) => a - b).slice(0, 12);
  return out.length > 1 ? out : [...DEFAULT_CADENCE];
}

/** Whatever is stored (or posted) as settings, made whole and safe. Unknown keys are dropped. */
export function normalizeAutopilot(raw: unknown): AutopilotSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | unknown>;
  const sp = (o.speed && typeof o.speed === 'object' ? o.speed : {}) as Record<string, unknown>;
  const fu = (o.followup && typeof o.followup === 'object' ? o.followup : {}) as Record<string, unknown>;
  const re = (o.reactivation && typeof o.reactivation === 'object' ? o.reactivation : {}) as Record<string, unknown>;
  const li = (o.limits && typeof o.limits === 'object' ? o.limits : {}) as Record<string, unknown>;
  const d = DEFAULT_AUTOPILOT;
  return {
    send_as: uuid(o.send_as),
    limits: {
      daily_touches: num(li.daily_touches, 0, 5000, d.limits.daily_touches), daily_steps: num(li.daily_steps, 0, 20000, d.limits.daily_steps),
    },
    speed: {
      enabled: bool(sp.enabled, d.speed.enabled), sources: strList(sp.sources), agent_key: key(sp.agent_key),
      channels: orderedChannels(sp.channels, d.speed.channels), window: clampWindow(sp.window), after_hours_text: bool(sp.after_hours_text, d.speed.after_hours_text),
      fallback_minutes: num(sp.fallback_minutes, 1, 30, d.speed.fallback_minutes), max_lead_age_hours: num(sp.max_lead_age_hours, 1, 168, d.speed.max_lead_age_hours),
    },
    followup: {
      enabled: bool(fu.enabled, d.followup.enabled), agent_key: key(fu.agent_key), cadence_days: Array.isArray(fu.cadence_days) ? cleanCadence(fu.cadence_days) : [...DEFAULT_CADENCE],
      max_touches: num(fu.max_touches, 2, 60, d.followup.max_touches), channels: orderedChannels(fu.channels, d.followup.channels),
    },
    reactivation: {
      enabled: bool(re.enabled, d.reactivation.enabled), agent_key: key(re.agent_key),
      lists: Array.isArray(re.lists) ? REACTIVATION_LISTS.filter((l) => (re.lists as unknown[]).includes(l)) : [...REACTIVATION_LISTS], sources: strList(re.sources),
      idle_days: num(re.idle_days, 30, 3650, d.reactivation.idle_days), daily_cap: num(re.daily_cap, 1, 500, d.reactivation.daily_cap),
      channels: orderedChannels(re.channels, d.reactivation.channels), max_touches: num(re.max_touches, 1, 60, d.reactivation.max_touches),
    },
  };
}

// ---- lead sources ---------------------------------------------------------------------

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** Is this lead's source one the owner picked. Case and spacing do not matter; a lead with no source never matches. */
export function sourceSelected(source: string | null | undefined, selected: readonly string[]): boolean {
  const s = norm(source);
  return !!s && selected.some((x) => norm(x) === s);
}

/**
 * What a source looks like, for the picker's hint only (the owner decides):
 * `inbound` reads like a person asked to hear from us (a form, PPC, a PPL
 * vendor, a webhook), `list` like a purchased or pulled list (cold calling a
 * list needs its own consent), `unknown` otherwise.
 */
export function sourceKind(source: string | null | undefined): 'inbound' | 'list' | 'unknown' {
  const s = norm(source);
  if (!s) return 'unknown';
  if (/\b(propstream|batch ?leads?|list ?source|skip|pull|list|cold ?call|cold|podio|import|deal[-_ ]?tracker|probate|pre-?forc?losure|tired landlord|absentee|vacant|tax)\b/.test(s)) return 'list';
  if (/\b(form|web|website|site|landing|ppc|ppl|google|facebook|meta|fb|instagram|zapier|jotform|inbound|lead ?gen|zillow|seller ?form|call ?in|direct mail call|referral)\b/.test(s)) return 'inbound';
  return 'unknown';
}

// ---- speed to lead ------------------------------------------------------------------------

export type SpeedSkip = 'disabled' | 'source' | 'archived' | 'dnc' | 'no_reach' | 'enrolled' | 'old';
export type SpeedLead = {
  source: string | null; archived_at: string | null; created_at: string | null; phone: string | null; email: string | null;
};

/**
 * May this new lead be speed-dialed now. `dnc` is the caller's do-not-engage
 * answer (DNC tag or blacklist); `onAgent` is true when an agent is already
 * working the record (a rep switched one on, or it was enrolled before).
 */
export function speedEligibility(s: AutopilotSettings, lead: SpeedLead, f: { dnc: boolean; onAgent: boolean; nowMs: number }): { ok: true } | { ok: false; code: SpeedSkip; reason: string } {
  if (!s.speed.enabled) return { ok: false, code: 'disabled', reason: 'speed to lead is switched off' };
  if (!sourceSelected(lead.source, s.speed.sources)) return { ok: false, code: 'source', reason: `source "${lead.source ?? 'none'}" is not one picked for speed to lead` };
  if (lead.archived_at) return { ok: false, code: 'archived', reason: 'the record is archived' };
  if (f.dnc) return { ok: false, code: 'dnc', reason: 'do-not-contact or blacklisted' };
  if (!lead.phone && !lead.email) return { ok: false, code: 'no_reach', reason: 'no phone or email on file' };
  if (f.onAgent) return { ok: false, code: 'enrolled', reason: 'an agent is already working this record' };
  const born = lead.created_at ? Date.parse(lead.created_at) : NaN;
  if (Number.isFinite(born) && f.nowMs - born > s.speed.max_lead_age_hours * 3_600_000) return { ok: false, code: 'old', reason: `the lead is older than ${s.speed.max_lead_age_hours} hours` };
  return { ok: true };
}

/** The lead's own time zone: the property's state, else the area code, else the fallback. */
export const leadZone = (phone: string | null | undefined, state: string | null | undefined, fallback = 'America/Chicago') => zoneForRvm(phone, fallback, state);

function localClock(nowMs: number, tz: string): { minutes: number; day: string } {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    return { minutes: Number(g('hour')) * 60 + Number(g('minute')), day: g('weekday').toLowerCase().slice(0, 3) };
  } catch {
    return localClock(nowMs, 'America/Chicago');
  }
}
const localMinutes = (nowMs: number, tz: string) => localClock(nowMs, tz).minutes;

/** Inside the schedule, in the lead's zone: its hours, on its days (every day when none are given). */
export function inCallWindow(nowMs: number, tz: string, w: Window = LEGAL_WINDOW): boolean {
  const c = localClock(nowMs, tz);
  if (w.days && w.days.length && !w.days.includes(c.day)) return false;
  return c.minutes >= minsOf(w.start) && c.minutes < minsOf(w.end);
}

/** The next moment the window opens in the lead's zone (now when it is open), to the minute. */
export function nextWindowOpen(nowMs: number, tz: string, w: Window = LEGAL_WINDOW): number {
  if (inCallWindow(nowMs, tz, w)) return nowMs;
  const m = localMinutes(nowMs, tz);
  const start = minsOf(w.start);
  const wait = (start - m + 1440) % 1440 || 1440;
  // Land on the minute, then step forward across a DST shift if the clock disagrees.
  let t = Math.floor(nowMs / 60_000) * 60_000 + wait * 60_000;
  // A day off in the schedule: the same opening on the next day it runs.
  for (let d = 0; d < 8; d++) {
    let u = t + d * 86_400_000;
    for (let i = 0; i < 180 && !inCallWindow(u, tz, w); i++) u += 60_000;
    if (inCallWindow(u, tz, w)) return u;
  }
  return t;
}

export type FirstTouch = {
  /** What goes out now. */
  now: Channel | null;
  /** What waits for the window, and when. */
  later: 'call' | 'sms' | null; later_at: number | null;
  reason: string;
};

/**
 * The first touch for a new lead. Inside the window: a call when the agent can
 * call (the fallback text follows if it is not answered), else a text, else an
 * email. Outside it: a text now when the owner allows after-hours texts, and
 * the call (or the text) when the window opens; an email may go any time.
 */
export function firstTouch(i: {
  nowMs: number; tz: string; window: Window; channels: Channel[]; canCall: boolean; hasPhone: boolean; hasEmail: boolean; afterHoursText: boolean;
}): FirstTouch {
  // A ringless voicemail is never the first touch: it comes on the cadence, after a call or a text.
  const may = (c: Channel) => i.channels.includes(c) && (c === 'call' ? i.canCall && i.hasPhone : c === 'sms' ? i.hasPhone : c === 'email' ? i.hasEmail : false);
  const order = i.channels.filter(may);
  if (!order.length) return { now: null, later: null, later_at: null, reason: 'no channel can reach them' };
  if (inCallWindow(i.nowMs, i.tz, i.window)) return { now: order[0], later: null, later_at: null, reason: 'inside the calling window' };
  const open = nextWindowOpen(i.nowMs, i.tz, i.window);
  const later: 'call' | 'sms' | null = may('call') ? 'call' : may('sms') ? 'sms' : null;
  if (i.afterHoursText && may('sms')) return { now: 'sms', later: may('call') ? 'call' : null, later_at: may('call') ? open : null, reason: 'outside the calling window: a text now, the call when it opens' };
  if (may('email')) return { now: 'email', later, later_at: later ? open : null, reason: 'outside the calling window: an email now, the rest when it opens' };
  return { now: null, later, later_at: later ? open : null, reason: 'outside the calling window: waiting for it to open' };
}

/**
 * Did the speed call connect. `call` is the post-call row (communications or
 * voice_agent_calls) when it has landed: a conversation of 20 seconds or more
 * counts as answered (a voicemail drop is shorter, or flagged). With nothing
 * filed yet it is `pending` for up to `graceMin` after the call, then `missed`.
 */
export function callOutcome(call: { duration_s?: number | null; status?: string | null; voicemail?: boolean | null } | null, placedAtMs: number, nowMs: number, graceMin = 12): 'answered' | 'missed' | 'pending' {
  if (call) {
    const st = norm(call.status);
    if (call.voicemail || /voicemail|no[-_ ]?answer|busy|failed|canceled|cancelled/.test(st)) return 'missed';
    return Number(call.duration_s ?? 0) >= 20 ? 'answered' : 'missed';
  }
  return nowMs - placedAtMs < graceMin * 60_000 ? 'pending' : 'missed';
}

// ---- the words of a first touch --------------------------------------------------------------

export type Who = { first_name: string; agent: string; company: string; street: string; inbound: boolean };

const firstWord = (n: string) => String(n ?? '').trim().split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, '') ?? '';
/** "1204 Oak St" from "1204 Oak St, San Antonio, TX 78209". */
export const streetOf = (address: string | null | undefined) => String(address ?? '').split(',')[0]!.trim().slice(0, 80);

export function whoOf(i: { name: string | null; agent: string; company: string; address: string | null; source: string | null }): Who {
  return { first_name: firstWord(i.name ?? ''), agent: firstWord(i.agent) || 'the team', company: i.company || 'our team', street: streetOf(i.address), inbound: sourceKind(i.source) === 'inbound' };
}

/**
 * The fixed first-touch texts. No price, no promise, under 300 characters with
 * the opt-out line the caller appends (withOptOut); the agent's name and
 * company, and the property when we have it.
 */
export function speedText(kind: 'first' | 'missed_call' | 'after_hours', w: Who): string {
  const hi = w.first_name ? `Hi ${w.first_name}` : 'Hi';
  const me = `this is ${w.agent} with ${w.company}`;
  const about = w.street ? `your property at ${w.street}` : 'your property';
  const lead = w.inbound ? `Thanks for reaching out about ${about}.` : `I'm reaching out about ${about}.`;
  let t: string;
  if (kind === 'missed_call') t = `${hi}, ${me}. I just tried calling about ${about}. Is now a good time to talk, or is there a better time today?`;
  else if (kind === 'after_hours') t = `${hi}, ${me}. ${lead} I'll give you a call in the morning; if another time works better, just reply here.`;
  else t = `${hi}, ${me}. ${lead} Do you have a few minutes for a quick call today?`;
  return mentionsMoney(t) ? t.replace(/\d/g, '') : t.slice(0, 300);
}

export function speedEmail(w: Who, rep: string): { subject: string; body: string } {
  const about = w.street ? `your property at ${w.street}` : 'your property';
  return {
    subject: w.street ? `About ${w.street}` : 'About your property',
    body: `${w.first_name ? `Hi ${w.first_name},` : 'Hi,'}\n\n${w.inbound ? `Thanks for reaching out about ${about}.` : `I'm reaching out about ${about}.`} I'd love to learn a little about the place and what you have in mind, and set up a quick call with ${rep || 'our acquisitions team'}.\n\nWhat's a good time to talk?\n\n${w.agent}\n${w.company}`,
  };
}

/** What the voice agent is told the speed call is for ({{call_goal}}). */
export function speedCallGoal(i: { source: string | null; minutesOld: number; transferOn: boolean }): string {
  const fresh = i.minutesOld <= 1 ? 'just now' : `${Math.round(i.minutesOld)} minutes ago`;
  const src = i.source ? ` from ${i.source.slice(0, 40)}` : '';
  return `Speed to lead: they came in ${fresh}${src}. Qualify fast: owner and address, still interested, motivation, timeline, condition, the price they have in mind. Then book a time with an acquisitions rep${i.transferOn ? ', or transfer them live if they want to talk now' : ''}. Never name a number.`;
}

// ---- the cadence ----------------------------------------------------------------------------

/**
 * The plan the follow-up (or reactivation) agent works from: one step per
 * cadence day on the channels it has (a call and a text on day 0 when it can
 * call; otherwise the first channel), alternating afterwards so it never feels
 * like the same message twice. A ringless voicemail, when it is on, is its own
 * touch: the follow-up drops one on the second cadence day (the first when
 * there is only one), after the first call or text, and the reactivation one
 * on its first day; never two within RVM_GAP_DAYS, and never on the same day
 * as another step.
 */
export function cadencePlan(program: 'followup' | 'reactivation', days: number[], channels: Channel[], canCall: boolean): Plan {
  const usable = channels.filter((c) => c !== 'rvm' && (c !== 'call' || canCall));
  const ch = usable.length ? usable : (['sms'] as Channel[]);
  const rvm = channels.includes('rvm');
  const steps: PlanStep[] = [];
  let lastRvm = -Infinity;
  const rvmPurpose = program === 'reactivation' ? 'Voicemail: say who you are, that you are checking in about the property, and that a text or email follows' : 'Voicemail: say who you are, why you are reaching out, and that the details follow by text or email';
  days.forEach((day, i) => {
    const c = ch[i % ch.length]!;
    const purpose = program === 'reactivation'
      ? (i === 0 ? 'Re-engage: pick up where the last conversation left off, ask if selling is still on their mind' : i === days.length - 1 ? 'Last check-in for now; leave the door open' : 'Check back in, re-qualify (timeline, condition, price in mind), offer a time to talk')
      : (i === 0 ? 'First touch: reach them and book a call' : i === days.length - 1 ? 'Monthly check-in from here on' : 'Follow up: reach them, qualify, book a call with the acquisitions rep');
    steps.push({ day, channel: c, purpose });
    if (day === 0 && program === 'followup' && c === 'call' && ch.includes('sms')) steps.push({ day, channel: 'sms', purpose: 'Text after the call if they did not pick up' });
    const rvmDay = program === 'reactivation' ? i === 0 : (days.length === 1 ? i === 0 : i === 1);
    if (rvm && rvmDay && day - lastRvm >= RVM_GAP_DAYS) {
      steps.push({ day, channel: 'rvm', purpose: rvmPurpose });
      lastRvm = day;
    }
  });
  const summary = program === 'reactivation'
    ? `Reactivation: re-engage an aged lead on days ${days.join(', ')}, re-qualify and book.`
    : `Follow-up cadence on days ${days.join(', ')}, then monthly, until they book, say not interested, or a rep takes over.`;
  return {
    summary, goal: 'A booked appointment (or a live transfer) with the acquisitions rep.',
    steps: steps.slice(0, 12),
    stop_when: 'They book, ask to stop, say they are not interested, the lead goes to a dead stage, or a rep takes over.',
  };
}

/** The day the next step falls on, from days since the start: the next cadence day, then every 30 days after the last. */
export function nextCadenceDay(daysSinceStart: number, cadence: number[]): number {
  const c = cleanCadence(cadence);
  const next = c.find((d) => d > daysSinceStart);
  if (next !== undefined) return next;
  const last = c[c.length - 1]!;
  return last + Math.ceil((daysSinceStart - last + 1) / 30) * 30;
}

export function followupInstructions(i: { source: string | null; reached: boolean; days: number[]; rep: string }): string {
  return [
    `AI Autopilot follow-up. This seller came in${i.source ? ` from ${i.source}` : ''} and ${i.reached ? 'was reached but did not book yet' : 'was not reached on the first call'}.`,
    `Work the cadence on days ${i.days.join(', ')} from the start, then once a month until the touch limit. Vary the channel and the wording; never repeat a message.`,
    `Goal: reach them, qualify (confirm they own the property, still interested, motivation, timeline, condition, the price they have in mind) and book a call or appointment with ${i.rep || 'the acquisitions rep'}. When they are ready to talk, hand off.`,
    'Finish when they say they are not interested or the timing is far off; never argue.',
  ].join('\n');
}

export function reactivationInstructions(i: { stage: string | null; idleDays: number; rep: string }): string {
  return [
    `AI Autopilot reactivation. This is an aged lead${i.stage ? ` (stage ${i.stage})` : ''} with no contact for at least ${i.idleDays} days.`,
    'Re-engage gently: reference the earlier conversation from the history when there was one, and ask whether selling is still on their mind. Do not pretend nothing happened, and do not reopen an old offer number.',
    `If they are open to it, re-qualify (timeline, condition, the price they have in mind, what changed) and book a call or appointment with ${i.rep || 'the acquisitions rep'}. When they are ready to talk, hand off.`,
    'Finish politely on "not interested" or "already sold". Keep it to a few touches over the plan.',
  ].join('\n');
}

// ---- stop rules ------------------------------------------------------------------------------

export type StopFacts = {
  /** An appointment on the record made after the enrollment started (by the agent or a rep). */
  booked: boolean;
  dnc: boolean;
  archived: boolean;
  /** A call or save_qualification said not interested / do not contact since the start. */
  notInterested: boolean;
  /** seller_stages.grp of the record's stage now. */
  stageGroup: string | null;
  /** A rep called, texted or emailed the person after the enrollment started (not the agent). */
  humanTouch: boolean;
  /** The seller's stage at enrollment, so a stage that was already dead (reactivation) is not a reason to stop. */
  startStageGroup?: string | null;
};

/** Stage groups that mean a person has the lead now: an offer is being worked, a contract, a close. */
export const PAST_QUALIFICATION = new Set(['offer', 'contract', 'closed', 'referral']);
export const DEAD_GROUPS = new Set(['dead', 'refund']);

/** Why an autopilot enrollment stops now, or null. Checked on every tick before anything is sent. */
export function autopilotStop(f: StopFacts): { reason: string; status: 'done' | 'stopped' } | null {
  if (f.dnc) return { reason: 'do-not-contact', status: 'stopped' };
  if (f.archived) return { reason: 'the record was archived', status: 'stopped' };
  if (f.booked) return { reason: 'booked: an appointment is on the calendar', status: 'done' };
  if (f.notInterested) return { reason: 'not interested', status: 'done' };
  if (f.humanTouch) return { reason: 'a rep took the lead (called, texted or emailed them)', status: 'done' };
  if (f.stageGroup && PAST_QUALIFICATION.has(f.stageGroup)) return { reason: 'the lead moved past qualification', status: 'done' };
  if (f.stageGroup && DEAD_GROUPS.has(f.stageGroup) && !(f.startStageGroup && DEAD_GROUPS.has(f.startStageGroup))) return { reason: 'the lead was moved to a dead stage', status: 'stopped' };
  return null;
}

/**
 * Was this outbound row a person on the team, not the agent: the agent's own
 * texts, emails and calls are in its ledger (communication ids) or are the
 * ElevenLabs calls it placed; anything else outbound after the start is a rep.
 */
export function isHumanTouch(c: { id: number; direction: string | null; source: string | null; channel: string | null; body?: string | null }, agentCommIds: ReadonlySet<number>, agentBodies: ReadonlySet<string> = new Set()): boolean {
  if (c.direction !== 'outbound') return false;
  if (!['call', 'sms', 'email'].includes(String(c.channel))) return false;
  if (agentCommIds.has(Number(c.id))) return false;
  if (norm(c.source) === 'elevenlabs') return false;
  const b = String(c.body ?? '').trim();
  if (b && agentBodies.has(b)) return false;
  return true;
}

// ---- reactivation ----------------------------------------------------------------------------

export type ReactivationRow = {
  id: number; lead_stage: string | null; source: string | null; tags: string[] | null; archived_at: string | null; phone: string | null; email: string | null;
  /** The last call, text or email either way; null: never. */
  last_touch_at: string | null; created_at: string | null; enrolled: boolean; reactivated_before: boolean;
};

/**
 * May this aged lead be reactivated tonight, and from which list. It must be
 * on one of the smart lists the owner picked (with their quiet period), never
 * under contract, closed or a wholesaler/buyer stage, and quiet that long: a
 * lead nobody reached must also be that old. `dnc` is the do-not-engage
 * answer for its tags.
 */
export function reactivationEligible(r: ReactivationRow, s: AutopilotSettings, f: { dnc: boolean; nowMs: number }): { ok: true; list: ReactivationList } | { ok: false; reason: string } {
  const re = s.reactivation;
  if (!re.enabled) return { ok: false, reason: 'reactivation is switched off' };
  if (r.archived_at) return { ok: false, reason: 'archived' };
  if (f.dnc) return { ok: false, reason: 'do-not-contact or blacklisted' };
  if (r.enrolled) return { ok: false, reason: 'an agent is already working it' };
  if (r.reactivated_before) return { ok: false, reason: 'already reactivated once' };
  if (!r.phone && !r.email) return { ok: false, reason: 'no phone or email' };
  const stage = String(r.lead_stage ?? '');
  if (NEVER_REACTIVATE.has(sellerStageGroup(stage))) return { ok: false, reason: `stage "${stage || 'none'}" is never reactivated` };
  if (re.sources.length && !sourceSelected(r.source, re.sources)) return { ok: false, reason: 'source not picked' };
  const quietMin = re.idle_days * 1440;
  const last = r.last_touch_at ? Date.parse(r.last_touch_at) : NaN;
  const lastMin = Number.isFinite(last) ? (f.nowMs - last) / 60_000 : null;
  const born = r.created_at ? Date.parse(r.created_at) : NaN;
  if (lastMin === null && Number.isFinite(born) && f.nowMs - born < quietMin * 60_000) return { ok: false, reason: `newer than ${re.idle_days} days` };
  const list = reactivationListsOf(stage, lastMin, quietMin).find((l) => re.lists.includes(l));
  if (!list) return { ok: false, reason: lastMin !== null && lastMin <= quietMin ? `touched in the last ${re.idle_days} days` : 'not on a picked list' };
  return { ok: true, list };
}

/** First looks for tonight's reactivations: spread `gapMin` apart from `startMs`, so a cap of 100 does not text 100 people in one minute. */
export const spreadAt = (startMs: number, index: number, gapMin = 4) => startMs + index * gapMin * 60_000;

// ---- after every AI call: read it, score it, decide ------------------------------------------

export type CallLabel = 'hot' | 'warm' | 'nurture' | 'not_interested' | 'wrong_number' | 'dnc' | 'no_answer';
export type CallNext = 'booked' | 'follow_up' | 'nurture' | 'drop';
export type CallReview = { label: CallLabel; next: CallNext; reason: string };

export const CALL_LABEL: Record<CallLabel, string> = {
  hot: 'Hot', warm: 'Warm', nurture: 'Long-term nurture', not_interested: 'Not interested', wrong_number: 'Wrong number', dnc: 'Do not contact', no_answer: 'No answer',
};
export const CALL_NEXT: Record<CallNext, string> = {
  booked: 'booked or transferred: the team has it', follow_up: 'follow up on the cadence', nurture: 'long-term nurture: check back in about a month', drop: 'drop: no more outreach',
};

/** A timeline that is months away: "6 months", "next year", "not until spring", "someday". */
export function timelineFar(t: string | null | undefined): boolean {
  const s = norm(t);
  if (!s) return false;
  if (/\b(next|in a) year\b|\byears?\b|\bsomeday|\bnot (any ?time soon|for a while|yet)\b|\blong[- ]term\b|\bafter (the )?(holidays|summer|winter|spring)\b/.test(s)) return true;
  const m = /(\d+)\s*(?:-|to)?\s*\d*\s*months?/.exec(s);
  return !!m && Number(m[1]) >= 3;
}

/**
 * What one AI call came to, from the post-call flags (voice_agent_calls), the
 * outcome the agent saved (save_qualification) and the seller's timeline: a
 * label and the next move, with the reason, for the record's timeline.
 */
export function reviewCall(c: {
  answered: boolean; booked?: boolean | null; transferred?: boolean | null; dnc_requested?: boolean | null; not_interested?: boolean | null;
  outcome?: string | null; timeline?: string | null; voicemail?: boolean | null;
}): CallReview {
  const o = norm(c.outcome);
  if (c.dnc_requested || o === 'do_not_contact') return { label: 'dnc', next: 'drop', reason: 'they asked not to be contacted' };
  if (c.booked || c.transferred || o === 'booked' || o === 'signed' || o === 'agreement_sent') return { label: 'hot', next: 'booked', reason: c.transferred ? 'transferred live to a person' : 'an appointment is booked' };
  if (o === 'wrong_person') return { label: 'wrong_number', next: 'drop', reason: 'wrong person or wrong number' };
  if (c.not_interested || o === 'not_interested') return { label: 'not_interested', next: 'drop', reason: 'not interested in selling' };
  if (!c.answered || o === 'no_answer') return { label: 'no_answer', next: 'follow_up', reason: c.voicemail ? 'voicemail' : 'no answer' };
  if (timelineFar(c.timeline)) return { label: 'nurture', next: 'nurture', reason: `the timeline is months away (${String(c.timeline).slice(0, 60)})` };
  if (o === 'callback' || o === 'above_range') return { label: 'warm', next: 'follow_up', reason: o === 'callback' ? 'asked for a callback' : 'their number is above what we can do yet' };
  return { label: 'warm', next: 'follow_up', reason: 'talked, not booked yet' };
}

// ---- the report ------------------------------------------------------------------------------

/** When a lead came in, by the workspace's clock: business hours (weekdays 9 to 5), after hours, or the weekend. */
export function timeBucket(iso: string | null | undefined, tz: string): 'business' | 'after_hours' | 'weekend' | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const c = localClock(t, tz);
  if (c.day === 'sat' || c.day === 'sun') return 'weekend';
  return c.minutes >= 9 * 60 && c.minutes < 17 * 60 ? 'business' : 'after_hours';
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : Math.round((v[m - 1]! + v[m]!) / 2);
}

export type Bucket = { leads: number; contacted: number; booked: number };
export type Funnel = {
  new_leads: number; speed_queued: number; contacted: number; median_first_touch_s: number | null; under_60s: number;
  conversations: number; qualified: number; appointments: number; transfers: number; contracts: number;
  /** Conversations as a share of the sellers the agents reached out to (0 to 100). */
  contact_rate: number;
  reactivated: number; reactivated_replied: number; reactivated_booked: number;
  /** Speed leads by when they came in: what came in, how many the AI reached, how many booked. */
  by_time: { business: Bucket; after_hours: Bucket; weekend: Bucket };
  ai_calls: number; ai_calls_per_day: number;
};

/**
 * The AI funnel over one window: new leads → contacted by AI (and how fast) →
 * conversations → qualified → appointments and live transfers → contracts, and
 * what reactivation brought back. Counts are distinct sellers.
 */
export function funnel(i: {
  newLeads: number;
  speed: { seller_id?: number | string | null; lead_created_at: string | null; first_touch_at: string | null; status: string }[];
  touched: Set<string>; conversations: Set<string>; qualified: Set<string>; booked: Set<string>; transferred: Set<string>; contracts: Set<string>;
  reactivated: Set<string>; tz?: string; aiCalls?: number; days?: number;
}): Funnel {
  const by_time = { business: { leads: 0, contacted: 0, booked: 0 }, after_hours: { leads: 0, contacted: 0, booked: 0 }, weekend: { leads: 0, contacted: 0, booked: 0 } };
  for (const r of i.speed) {
    const b = timeBucket(r.lead_created_at, i.tz ?? 'America/Chicago');
    if (!b) continue;
    by_time[b].leads++;
    if (r.first_touch_at) by_time[b].contacted++;
    if (r.seller_id != null && i.booked.has(String(r.seller_id))) by_time[b].booked++;
  }
  const aiCalls = i.aiCalls ?? 0;
  const secs = i.speed.filter((r) => r.first_touch_at && r.lead_created_at).map((r) => (Date.parse(r.first_touch_at!) - Date.parse(r.lead_created_at!)) / 1000).filter((s) => s >= 0);
  const inter = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;
  return {
    new_leads: i.newLeads, speed_queued: i.speed.length, contacted: i.touched.size, median_first_touch_s: median(secs), under_60s: secs.filter((s) => s <= 60).length,
    conversations: i.conversations.size, qualified: i.qualified.size, appointments: i.booked.size, transfers: i.transferred.size, contracts: i.contracts.size,
    contact_rate: i.touched.size ? Math.round((i.conversations.size / i.touched.size) * 100) : 0,
    reactivated: i.reactivated.size, reactivated_replied: inter(i.reactivated, i.conversations), reactivated_booked: inter(i.reactivated, i.booked),
    by_time, ai_calls: aiCalls, ai_calls_per_day: Math.round((aiCalls / Math.max(1, i.days ?? 1)) * 10) / 10,
  };
}

/** "8s", "1m 05s", "2h 10m" for the speed tile. */
export function secondsLabel(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return '–';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;
}

// ---- the daily spend ceiling -----------------------------------------------------------

export type SpendToday = { touches: number; steps: number };

/**
 * Whether the workspace's AI agents may take another turn today. A limit of
 * 0 stops them all; `outcome` names which ceiling was reached.
 */
export function spendCheck(limits: AutopilotSettings['limits'], today: SpendToday): { ok: true } | { ok: false; outcome: 'touches' | 'steps'; reason: string } {
  if (today.touches >= limits.daily_touches) return { ok: false, outcome: 'touches', reason: `the daily limit of ${limits.daily_touches} AI texts, emails and calls is reached; more go out tomorrow` };
  if (today.steps >= limits.daily_steps) return { ok: false, outcome: 'steps', reason: `the daily limit of ${limits.daily_steps} AI steps is reached; the rest run tomorrow` };
  return { ok: true };
}

/** The next 9am in the zone, as a UTC ms timestamp: when capped work tries again. */
export function nextMorningMs(nowMs: number, tz: string, hour = 9): number {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    const mins = g('hour') * 60 + g('minute');
    const until = (hour * 60 - mins + 24 * 60) % (24 * 60) || 24 * 60;
    return nowMs + until * 60_000;
  } catch {
    return nowMs + 12 * 3_600_000;
  }
}
