// Cold email pool, from the browser. Writes go through the cold-pool function,
// which checks the caller's role. The locked domains (your company's own; edit the list) are the same list
// the worker refuses (supabase/functions/_shared/cold-campaign.ts).

import { supabase } from './supabase';
import type { Check } from '../supabase/functions/_shared/deliverability-rules';
// Vendor rows can carry an object where a string belongs (#321); every value put into a sentence goes through this.
import { textValue } from '../supabase/functions/_shared/resend-rules';

export const LOCKED_SENDING_DOMAINS = ['yourcompany.com'] as const;

export type ColdDomain = {
  id: number; domain: string; daily_cap: number; dkim_selectors: string[]; score: number | null;
  blocking: string[]; checked_at: string | null; paused: boolean; paused_reason: string | null; paused_auto: boolean;
  /** The full DNS report, when the overview sends it. The page falls back to the matching email_domains row. */
  report?: { checks: Check[]; provider: string } | null;
};
export type ColdMailbox = {
  id: number; domain_id: number; email: string; display_name: string | null; provider: 'google_oauth' | 'microsoft_oauth' | 'smtp';
  status: string; daily_cap: number; hourly_cap: number; min_gap_seconds: number; timezone: string;
  ramp_start: number; ramp_increase_pct: number; ramp_target: number; ramp_started_on: string;
  paused: boolean; paused_reason: string | null; smtp_host: string | null; imap_host: string | null; last_error: string | null;
  warmup_started_at: string | null; warmup_score: number | null; warmup_checked_at: string | null;
  warmup_sent_14d: number | null; warmup_spam_14d: number | null; warmup_spam_pct: number | null;
  /** Null when the workspace does not warm through Instantly. */
  warmup_gate: { ready: boolean; daysWarming: number; reason: string } | null;
};
/** One live Instantly reading, keyed by lowercased email in health.warmup. */
export type WarmupReading = { email: string; warming: boolean | null; score: number | null; sent14: number; spam14: number; spam_pct: number | null; checked_at: string };
export type WarmupSync = {
  ok: boolean; called: boolean; checked: number; promoted: string[]; paused: string[]; unlisted: string[]; error: string | null;
  /** Warmup was off on Instantly and the sync switched it back on. */
  rewarmed?: string[];
  /** Auto-paused for warmup Spam earlier, back under the limit, unpaused. */
  resumed?: string[];
};
export type ColdStep = { id?: number; position: number; delay_business_days: number; subject: string; body: string; variants: { key: string; subject: string; body: string; weight: number }[] };
export type ColdCampaign = {
  id: number; name: string; status: string; audience_kind: 'tag' | 'saved_view'; audience_tag: string | null;
  saved_view_id: number | null; window_start: number; window_end: number; window_days: number[];
  fallback_timezone: string; steps: ColdStep[]; enrolled: number;
};
export type ColdHealthRow = { email?: string; domain?: string; sent_7d: number; bounced_7d: number; replied_7d: number; complaints_7d: number; bounceRate: number; replyRate: number; complaintRate: number; paused?: boolean };
export type ColdOverview = {
  admin: boolean;
  locked_domains: string[];
  blocked: string[];
  blocked_extra: string[];
  fallback_timezone: string;
  warmup: {
    provider: string; api_base: string | null; instantly_tag: string | null; key_set: boolean; calls_vendor: boolean; placement?: string; daily?: number; combined_ceiling?: number;
    gate?: { on: boolean; min_days: number; min_score: number; spam_pause_pct: number }; synced_at?: string | null; sync_error?: string | null;
  };
  inboxkit?: { configured: boolean; workspace_uid: string | null };
  physical_address?: string;
  google: { configured: boolean; redirect_uri: string };
  microsoft: { configured: boolean; redirect_uri: string };
  domains: ColdDomain[];
  mailboxes: ColdMailbox[];
  campaigns: ColdCampaign[];
  saved_views: { id: number; name: string; shared: boolean }[];
  health: { mailboxes: ColdHealthRow[]; domains: ColdHealthRow[]; calls_vendor?: boolean; warmup?: Record<string, WarmupReading>; warmup_error?: string };
};

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export async function coldPool<T>(workspaceId: number, action: string, body: Record<string, unknown> = {}): Promise<Result<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('cold-pool', { body: { workspace_id: workspaceId, action, ...body } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const payload = data as { error?: string };
  if (payload?.error) return { ok: false, message: payload.error };
  return { ok: true, data: data as T };
}

// ---- The one-glance read at the top of the page ---------------------------

/** Days a cold mailbox ramps from its start volume to its cap (COLD_RAMP_DAYS in _shared/cold-campaign.ts). */
const COLD_RAMP_DAYS = 21;
const DAY = 86_400_000;

export type ColdSection = 'inboxes' | 'domains' | 'warmup' | 'rules';
/** `inboxId` marks a line about one inbox being paused or broken, so a caller with its own words for that can skip it. */
export type ColdIssue = { level: 'block' | 'warn'; text: string; section: ColdSection; inboxId?: number };
export type InboxState = 'ready' | 'ramping' | 'warming' | 'paused' | 'error' | 'domain';
/** One inbox in plain words. `clears` is when it can send (warming) or reaches full volume (ramping). */
export type InboxRead = { id: number; email: string; state: InboxState; detail: string; clears: string | null; sendable: boolean };
export type ColdReadiness = { verdict: 'none' | 'blocked' | 'warn' | 'ok'; sendable: number; issues: ColdIssue[]; inboxes: InboxRead[] };

const iso = (t: number) => new Date(t).toISOString();

/**
 * Is cold email safe to send, what blocks it, and when each inbox clears
 * warmup. Read-only over the cold-pool overview; the worker still enforces.
 * Check: npx tsx tools/cold-readiness.test.ts
 */
export function coldReadiness(c: ColdOverview, now = new Date()): ColdReadiness {
  const t = now.getTime();
  const gate = c.warmup.gate;
  const minDays = gate?.min_days ?? 14;
  const minScore = gate?.min_score ?? 90;
  const issues: ColdIssue[] = [];
  const domainOk = new Map<number, boolean>();

  for (const d of c.domains) {
    const name = textValue(d.domain);
    const reason = textValue(d.paused_reason);
    const blocking = (d.blocking ?? []).map(textValue).filter(Boolean);
    domainOk.set(d.id, !d.paused && !!d.checked_at && blocking.length === 0);
    if (d.paused) issues.push({ level: 'block', section: 'domains', text: `${name} is paused${reason ? `: ${reason}` : '.'}` });
    else if (!d.checked_at) issues.push({ level: 'block', section: 'domains', text: `${name} has never had its DNS checked.` });
    else if (blocking.length) issues.push({ level: 'block', section: 'domains', text: blocking.length > 1 ? `${name}: ${blocking[0].replace(/\.$/, '')} (and ${blocking.length - 1} more).` : `${name}: ${blocking[0]}` });
    else if (d.score != null && d.score < 70) issues.push({ level: 'warn', section: 'domains', text: `${name} scores ${d.score} of 100. Fixing its warnings gets it to 70 or more.` });
    if (d.checked_at && !d.paused && t - Date.parse(d.checked_at) > 7 * DAY) issues.push({ level: 'warn', section: 'domains', text: `${name} was last checked over a week ago.` });
  }

  const inboxes: InboxRead[] = c.mailboxes.map((m): InboxRead => {
    const base = { id: m.id, email: textValue(m.email) };
    const g = m.warmup_gate;
    if (m.paused) return { ...base, state: 'paused', detail: textValue(m.paused_reason) || 'Paused.', clears: null, sendable: false };
    if (m.status === 'error') return { ...base, state: 'error', detail: textValue(m.last_error) || 'The last send or sync failed.', clears: null, sendable: false };
    if (domainOk.get(m.domain_id) === false) return { ...base, state: 'domain', detail: 'Its domain is failing DNS or paused.', clears: null, sendable: false };
    if (m.status === 'warming' && g && !g.ready) {
      const left = Math.max(0, minDays - g.daysWarming);
      const detail = left > 0
        ? `Day ${g.daysWarming + 1} of ${minDays}. Then it needs a warmup score of ${minScore} or more.`
        : `Warmed ${g.daysWarming} days. Waiting for a score of ${minScore} (now ${m.warmup_score ?? 'none'}).`;
      // Count from the day warmup began when we know it, so the date does not drift with the time of day.
      const started = Date.parse(String(m.warmup_started_at ?? ''));
      const clears = left <= 0 ? null : Number.isFinite(started) ? iso(started + minDays * DAY) : iso(t + left * DAY);
      return { ...base, state: 'warming', detail, clears, sendable: false };
    }
    const started = Date.parse(`${m.ramp_started_on}T00:00:00Z`);
    const full = Number.isFinite(started) ? started + COLD_RAMP_DAYS * DAY : NaN;
    if (Number.isFinite(full) && full > t) return { ...base, state: 'ramping', detail: `Sending a reduced daily volume while it ramps to ${m.daily_cap} a day.`, clears: iso(full), sendable: true };
    return { ...base, state: 'ready', detail: `Full volume, ${m.daily_cap} a day.`, clears: null, sendable: true };
  });

  for (const i of inboxes) {
    if (i.state === 'paused') issues.push({ level: 'block', section: 'inboxes', inboxId: i.id, text: `${i.email} is paused: ${i.detail}` });
    if (i.state === 'error') issues.push({ level: 'block', section: 'inboxes', inboxId: i.id, text: `${i.email} has an error: ${i.detail}` });
  }
  if (gate?.on && !c.warmup.key_set) issues.push({ level: 'block', section: 'warmup', text: 'Instantly warmup is on but no API key is saved, so no inbox can clear warmup.' });
  if (gate?.on && textValue(c.warmup.sync_error)) issues.push({ level: 'warn', section: 'warmup', text: `The last Instantly sync failed: ${textValue(c.warmup.sync_error)}` });
  if (textValue(c.health.warmup_error)) issues.push({ level: 'warn', section: 'warmup', text: `The live Instantly read failed: ${textValue(c.health.warmup_error)}` });
  if (!textValue(c.physical_address).trim()) issues.push({ level: 'warn', section: 'rules', text: 'The footer has no physical address. Cold mail must carry one.' });
  for (const h of c.health.mailboxes) {
    if (!h.sent_7d) continue;
    if (h.bounceRate > 0.02) issues.push({ level: 'warn', section: 'inboxes', text: `${textValue(h.email) || 'An inbox'} bounced ${(h.bounceRate * 100).toFixed(1)}% this week. Over 2% pauses it.` });
    if (h.complaintRate >= 0.001) issues.push({ level: 'warn', section: 'inboxes', text: `${textValue(h.email) || 'An inbox'} drew spam complaints this week. 0.1% pauses it.` });
  }

  if (!c.mailboxes.length) issues.unshift({ level: 'block', section: 'inboxes', text: 'No cold inboxes yet. Add them under Inboxes.' });
  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'block' ? -1 : 1));
  const sendable = inboxes.filter((i) => i.sendable).length;
  const verdict = !c.mailboxes.length ? 'none' : sendable === 0 ? 'blocked' : issues.length ? 'warn' : 'ok';
  return { verdict, sendable, issues, inboxes };
}
