// Pure pieces the webhooks and the admin function share about WHICH agent a
// call belongs to and what that agent may do on it: agent resolution from the
// payload, the offer range, calling hours, and the stats roll-up.
import { DEFAULT_AGENT_KEY, type AgentSettings } from './voice-agent-settings.ts';

// ---- Which agent ----------------------------------------------------------------

type AgentRow = { workspace_id: number; agent_key: string };

/**
 * The agent a webhook is for. ElevenLabs sends the agent id in every payload
 * (personalize body, post-call data, and the tool's system__agent_id), so that
 * decides it. `byAgentId` are the rows holding that id; `inWorkspace` are the
 * workspace's agents, used only when a stored secret pinned the workspace and
 * the payload named no agent we know: then the workspace's default agent, or its
 * only one. A row from another workspace than the pinned one never matches.
 */
export function pickAgent<T extends AgentRow>(byAgentId: T[], inWorkspace: T[], pinnedWs: number | null): T | null {
  const hit = byAgentId.find((r) => pinnedWs == null || Number(r.workspace_id) === pinnedWs);
  if (hit) return hit;
  if (pinnedWs == null) return null;
  const mine = inWorkspace.filter((r) => Number(r.workspace_id) === pinnedWs);
  return mine.find((r) => r.agent_key === DEFAULT_AGENT_KEY) ?? (mine.length === 1 ? mine[0] : null);
}

/**
 * True when the owner switched a LIVE agent off. A never-published row is not
 * "off": it sits at enabled=false from creation, and the workspace fallback in
 * pickAgent can hand that row to a call from a hand-built agent, which must
 * keep behaving as before agents existed.
 */
export function agentSwitchedOff(a: { enabled?: boolean; live_version?: number } | null | undefined): boolean {
  return !!a && a.enabled === false && Number(a.live_version ?? 0) > 0;
}

/**
 * The enabled flag a publish writes. Only the first publish of a never-live
 * agent turns it on; after that the owner's switch is theirs, so a later
 * publish or rollback must not quietly re-enable an agent they turned off.
 */
export function enabledAfterPublish(row: { enabled: boolean; live_version: number }): boolean {
  return Number(row.live_version) === 0 ? true : row.enabled;
}

/** set_enabled input: `enabled` must be a real boolean, never "false" or 0. */
export function parseSetEnabled(body: Record<string, unknown>): { enabled: boolean } | { error: string } {
  return typeof body.enabled === 'boolean' ? { enabled: body.enabled } : { error: 'enabled must be true or false' };
}

// ---- Offer range ----------------------------------------------------------------

export const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

/**
 * What the agent is allowed to say on this call, from the seller's latest deal
 * MAO (the Compr underwrite's ceiling) and the agent's floor percentage. Empty
 * strings when the agent may not make offers or there is no MAO: the prompt
 * then tells it to quote nothing.
 */
export function offerRange(o: AgentSettings['offer_authority'], mao: number | null | undefined): { offer_low: string; offer_high: string } {
  const m = Number(mao);
  if (o.mode === 'none' || !Number.isFinite(m) || m <= 0) return { offer_low: '', offer_high: '' };
  return { offer_low: money(m * o.floor_pct_of_mao / 100), offer_high: money(m) };
}

// ---- Lead source ----------------------------------------------------------------

/**
 * {{lead_source}} for the acquisitions script: "form" when the seller's own
 * lead source reads like a web form, "outbound" for any other source on a call
 * we placed, and empty (an inbound call, source unknown) so the script does not
 * claim they filled anything in.
 */
export function leadSourceLabel(raw: unknown, direction: 'inbound' | 'outbound'): string {
  if (/\b(form|web|website|site|landing|ppc|google|facebook|online|inbound lead|lead ?gen|zillow)\b/i.test(String(raw ?? ''))) return 'form';
  return direction === 'outbound' ? 'outbound' : '';
}

// ---- Hours ----------------------------------------------------------------------

const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function localParts(nowMs: number, tz: string): { day: string; minutes: number } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { day: get('weekday').toLowerCase().slice(0, 3), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is `nowMs` inside the window on one of its days, in its time zone. A window that ends before it starts runs past midnight. */
export function withinHours(h: { days?: string[]; start: string; end: string; tz: string }, nowMs: number): boolean {
  let lp: { day: string; minutes: number };
  try { lp = localParts(nowMs, h.tz); } catch { return true; }
  if (!DAY.includes(lp.day)) return true;
  const a = mins(h.start); const b = mins(h.end);
  const inside = a <= b ? lp.minutes >= a && lp.minutes < b : lp.minutes >= a || lp.minutes < b;
  if (!h.days || !h.days.length) return inside;
  // Past midnight, the early hours belong to the previous day's window.
  const day = a > b && lp.minutes < b ? DAY[(DAY.indexOf(lp.day) + 6) % 7] : lp.day;
  return inside && h.days.includes(day);
}

/** May the agent place an OUTBOUND call now: inside quiet hours (when on) and inside its call hours. Inbound calls are never held back. */
export function outboundAllowedNow(s: AgentSettings, nowMs: number): boolean {
  const q = s.rules.compliance.quiet_hours;
  if (q.enabled && !withinHours({ start: q.start, end: q.end, tz: q.tz }, nowMs)) return false;
  return withinHours(s.call_handling.call_hours, nowMs);
}

// ---- Numbers that never connect --------------------------------------------------

/**
 * Why an outbound call never rang through, from the error ElevenLabs gives
 * back: 'busy' when the far end refused it (SIP 486/600 busy, 603 declined,
 * which is what a call blocker or a full line answers every time), 'unreachable'
 * when the carrier never answered or has no such line (timed out, 404, 408,
 * 410, 480, 484). Anything else (a 5xx, a refused request, ElevenLabs down) is
 * our side or theirs for a moment, never the lead's number: null.
 */
export type DialFailure = 'busy' | 'unreachable';
export function dialFailure(reason: string): DialFailure | null {
  const r = reason.toLowerCase();
  if (/\b(486|600|603)\b/.test(r) || /\bbusy\b|\bdeclined?\b/.test(r)) return 'busy';
  if (/\b(404|408|410|480|484)\b/.test(r) || /timed out|timeout|not found|temporarily unavailable|no answer/.test(r)) return 'unreachable';
  return null;
}

/** Dial failures in a row on one number before the agent stops calling it. */
export const DIAL_FAILURE_LIMIT = 3;
/** A busy or dead line is not retried sooner than this: the same number answers the same way six hours later. */
export const DIAL_RETRY_HOURS = 24;

/** The tag a dial failure's reason carries, so a new number on the record starts a fresh count. */
export const dialedTag = (key: string) => `[to ${key}]`;
const TAG_RE = /\[to (\d+)\]/;

/**
 * How many dial failures in a row the number `key` has had, from the record's
 * call_placed actions, newest first. A placed call ends the run. Failures that
 * say nothing about the number (outside call hours, a paused line, ElevenLabs
 * trouble) are passed over. A failure tagged with another number is passed over
 * too; an untagged one (written before the tag) counts, since the number on file
 * then is the number on file now unless someone changed it.
 */
export function dialFailureStreak(rows: { status: string; summary: string | null }[], key: string): number {
  let n = 0;
  for (const r of rows) {
    if (r.status === 'done') break;
    if (r.status !== 'failed') continue;
    const s = r.summary ?? '';
    if (!dialFailure(s)) continue;
    const tagged = TAG_RE.exec(s)?.[1];
    if (tagged && tagged !== key) continue;
    n++;
  }
  return n;
}

// ---- Stats ----------------------------------------------------------------------

export type CallRow = {
  agent_key: string; duration_s: number | null; booked: boolean; transferred: boolean; dnc_requested: boolean; not_interested: boolean;
};
export type AgentStats = {
  agent_key: string; calls: number; avg_duration_s: number; booked: number; transferred: number; dnc_requests: number; not_interested: number;
};

/** Per-agent counts over the rows given (the caller passes the last 30 days). Average duration counts only calls that connected (duration above 0). */
export function aggregateStats(rows: CallRow[]): AgentStats[] {
  const by = new Map<string, { s: AgentStats; dur: number; n: number }>();
  for (const r of rows) {
    const e = by.get(r.agent_key) ?? { s: { agent_key: r.agent_key, calls: 0, avg_duration_s: 0, booked: 0, transferred: 0, dnc_requests: 0, not_interested: 0 }, dur: 0, n: 0 };
    e.s.calls++;
    if (r.booked) e.s.booked++;
    if (r.transferred) e.s.transferred++;
    if (r.dnc_requested) e.s.dnc_requests++;
    if (r.not_interested) e.s.not_interested++;
    if (r.duration_s && r.duration_s > 0) { e.dur += r.duration_s; e.n++; }
    by.set(r.agent_key, e);
  }
  return [...by.values()].map((e) => ({ ...e.s, avg_duration_s: e.n ? Math.round(e.dur / e.n) : 0 })).sort((a, b) => a.agent_key.localeCompare(b.agent_key));
}
