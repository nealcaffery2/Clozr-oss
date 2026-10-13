// The plain-words read of Settings → Outbound OS → Email deliverability.
//
// In everyday terms: this file looks at the numbers the server already sent
// back (each outreach inbox, each domain, the buyer-blast checklist) and turns
// them into the sentence at the top of the page, the short list of problems
// with a link to the box that fixes each, the one button for the most urgent
// thing, and the plain error lines next to each inbox. It asks the server for
// nothing new, so it can never disagree with the rows below it.
//
// The cold-email facts (which inboxes can send, when each one clears warmup,
// what blocks sending) come from coldReadiness() in lib/cold-pool.ts, so the
// page has one opinion about readiness. This file only words it.
//
// Pure functions only, so tools/deliverability-summary.test.ts can run them.

import { type ColdDomain, type ColdHealthRow, type ColdMailbox, type ColdOverview, type ColdSection, type WarmupReading, coldReadiness } from './cold-pool';
import { type Overview, type Postmaster, campaignChecklist } from './deliverability';
// Vendor rows can carry an object where a string belongs (#321); every value we print goes through this.
import { textValue } from '../supabase/functions/_shared/resend-rules';

/** problem = someone has to act. notice = it fixes itself. ok = nothing to say. */
export type Level = 'problem' | 'notice' | 'ok';
export type Tone = 'good' | 'warn' | 'bad' | 'muted';

// The worker writes these exact strings (cold-campaign-tick, cold-transport).
const REPLY_CHECK_FAILED = 'Reply check failed';
const NEEDS_RECONNECT = 'The mailbox needs to be connected again.';

/** "Oct 24", the way the owner reads a date. */
export const shortDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What is wrong with one outreach inbox, said so a non-technical owner knows
 * whether to do anything. Null when nothing is wrong.
 */
export function mailboxIssue(m: ColdMailbox, live?: WarmupReading): { level: Level; text: string } | null {
  const reason = textValue(m.paused_reason);
  const lastError = textValue(m.last_error);
  if (m.paused) return { level: 'problem', text: `Paused${reason ? `: ${reason.replace(/\.$/, '')}` : ''}. It sends nothing until someone presses Resume.` };
  if (m.status === 'error' || lastError === NEEDS_RECONNECT) return { level: 'problem', text: 'Lost its login. Import it again or reconnect it so it can keep sending.' };
  if (live?.warming === false) return { level: 'problem', text: 'Warmup is switched off for this inbox in Instantly. Turn it back on there.' };
  if (lastError.startsWith(REPLY_CHECK_FAILED)) return { level: 'notice', text: "Couldn't check replies yet. Retrying automatically, nothing to do." };
  if (lastError) return { level: 'problem', text: `Last send failed (${lastError.replace(/\.$/, '')}). It tries again on the next run. If this stays, check the inbox password.` };
  return null;
}

/** The pill on one inbox row: a word, never a colour alone. */
export function mailboxPill(m: ColdMailbox, minDays: number): { tone: Tone; label: string } {
  if (m.paused) return { tone: 'bad', label: 'Paused' };
  if (m.status === 'error') return { tone: 'bad', label: 'Needs login' };
  if (m.status === 'active') return { tone: 'good', label: 'Sending' };
  if (m.status === 'warming') {
    if (m.warmup_gate?.ready) return { tone: 'good', label: 'Ready' };
    if (m.warmup_gate && m.warmup_started_at && m.warmup_gate.daysWarming < minDays) return { tone: 'muted', label: `Warming, day ${m.warmup_gate.daysWarming + 1} of ${minDays}` };
    return { tone: 'muted', label: 'Warming' };
  }
  return { tone: 'muted', label: textValue(m.status) || 'Unknown' };
}

/** What is wrong with a sending domain. Every one of these stops its inboxes sending. */
export function domainIssue(d: ColdDomain): string | null {
  const reason = textValue(d.paused_reason);
  const blocking = (d.blocking ?? []).map(textValue).filter(Boolean);
  if (d.paused) return `Paused${reason ? `: ${reason.replace(/\.$/, '')}` : ''}. Its inboxes send nothing until it is resumed.`;
  if (blocking.length) return `The DNS check failed: ${blocking[0].replace(/\.$/, '')}. Fix it at the domain host, then press Check now under Sending domains.`;
  if (!d.checked_at) return 'DNS has not been checked yet. Press Check now under Sending domains so its inboxes are allowed to send.';
  return null;
}

export type DomainGroup = {
  /** Null for inboxes whose domain row is missing. */
  domain: ColdDomain | null;
  name: string;
  mailboxes: ColdMailbox[];
  level: Level;
  pill: { tone: Tone; label: string };
  issue: string | null;
};

const RANK: Record<Level, number> = { problem: 0, notice: 1, ok: 2 };

/**
 * Inboxes grouped under their domain, with one health pill per domain.
 * Domains that need someone come first, then ones fixing themselves, then
 * the healthy ones; inside a domain, problem inboxes come first too.
 */
export function groupByDomain(cold: Pick<ColdOverview, 'domains' | 'mailboxes' | 'health'>): DomainGroup[] {
  const live = cold.health?.warmup ?? {};
  const issueOf = (m: ColdMailbox) => mailboxIssue(m, live[textValue(m.email).toLowerCase()]);
  const levelOf = (m: ColdMailbox): Level => issueOf(m)?.level ?? 'ok';
  const byId = new Map(cold.domains.map((d) => [d.id, d]));
  const buckets = new Map<number | null, ColdMailbox[]>(cold.domains.map((d) => [d.id, []]));
  for (const m of cold.mailboxes) {
    const key = byId.has(m.domain_id) ? m.domain_id : null;
    buckets.set(key, [...(buckets.get(key) ?? []), m]);
  }
  const groups: DomainGroup[] = [];
  for (const [id, boxes] of buckets) {
    const domain = id == null ? null : byId.get(id) ?? null;
    if (!domain && !boxes.length) continue;
    const sorted = [...boxes].sort((a, b) => RANK[levelOf(a)] - RANK[levelOf(b)] || textValue(a.email).localeCompare(textValue(b.email)));
    const problems = boxes.filter((m) => levelOf(m) === 'problem').length;
    const notices = boxes.filter((m) => levelOf(m) === 'notice').length;
    const issue = domain ? domainIssue(domain) : null;
    const level: Level = issue || problems ? 'problem' : notices ? 'notice' : 'ok';
    let pill: DomainGroup['pill'];
    if (domain?.paused) pill = { tone: 'bad', label: 'Paused' };
    else if (domain && (domain.blocking ?? []).length) pill = { tone: 'bad', label: 'DNS problem' };
    else if (domain && !domain.checked_at) pill = { tone: 'warn', label: 'DNS not checked' };
    else if (problems) pill = { tone: 'bad', label: `${problems} need${problems === 1 ? 's' : ''} you` };
    else if (!boxes.length) pill = { tone: 'muted', label: 'No inboxes' };
    else if (boxes.some((m) => m.status === 'active' && !m.paused)) pill = { tone: 'good', label: 'Sending' };
    else pill = { tone: 'muted', label: 'Warming' };
    groups.push({ domain, name: textValue(domain?.domain) || 'Domain not listed', mailboxes: sorted, level, pill, issue });
  }
  // A broken domain outranks a domain with one broken inbox: it stops all of them.
  return groups.sort((a, b) => RANK[a.level] - RANK[b.level] || Number(!a.issue) - Number(!b.issue) || a.name.localeCompare(b.name));
}

/** Every box the status line can point at. The ids live on the sections in DeliverabilitySettings and its children. */
export type Target = 'cold-inboxes' | 'cold-warmup' | 'cold-rules' | 'cold-campaigns' | 'sending-domains' | 'warm-checklist' | 'warm-resend';
const SECTION_TARGET: Record<ColdSection, Target> = { inboxes: 'cold-inboxes', domains: 'sending-domains', warmup: 'cold-warmup', rules: 'cold-rules' };

/** One line in the status box: what is wrong, and which box fixes it. */
export type Problem = { level: 'block' | 'warn'; text: string; target: Target };

export type ColdStatus = {
  configured: boolean;
  /** The one sentence for the top of the page. */
  line: string;
  problems: number;
  /** The problems behind that count, worst first, each pointing at the box that fixes it. */
  list: Problem[];
  /** Inboxes retrying something on their own. */
  retrying: number;
  warming: number;
  sending: number;
};

/** The cold-email half of the top sentence. `now` is for tests. */
export function coldStatus(cold: ColdOverview | null, now = new Date()): ColdStatus {
  const empty = { problems: 0, list: [], retrying: 0, warming: 0, sending: 0 };
  if (!cold) return { configured: false, line: '', ...empty };
  const boxes = cold.mailboxes;
  if (!boxes.length) return { configured: false, line: 'Cold email is not set up: no outreach inboxes yet.', ...empty };
  const read = coldReadiness(cold, now);
  const live = cold.health?.warmup ?? {};
  const issues = boxes.map((m) => ({ m, i: mailboxIssue(m, live[textValue(m.email).toLowerCase()]) }));
  // Inbox trouble in the row's own words; coldReadiness says the rest
  // (domains, the Instantly key and sync, the footer address, bounce limits).
  const list: Problem[] = [
    ...issues.filter((x) => x.i?.level === 'problem').map((x): Problem => ({ level: 'block', text: `${textValue(x.m.email)}: ${x.i!.text}`, target: 'cold-inboxes' })),
    ...read.issues.filter((i) => i.inboxId == null).map((i): Problem => ({ level: i.level, text: i.text, target: SECTION_TARGET[i.section] })),
  ].sort((a, b) => Number(a.level === 'warn') - Number(b.level === 'warn'));
  const retrying = issues.filter((x) => x.i?.level === 'notice').length;
  const warming = read.inboxes.filter((i) => i.state === 'warming');
  const ramping = read.inboxes.filter((i) => i.state === 'ramping');
  const sending = read.sendable;
  const parts: string[] = [];
  if (warming.length) parts.push(`${plural(warming.length, 'inbox', 'inboxes')} warming`);
  if (sending) parts.push(`${plural(sending, 'inbox', 'inboxes')} sending`);
  const head = parts.length ? `${parts.join(', ')}.` : `${plural(boxes.length, 'inbox', 'inboxes')}, none sending.`;
  const dates = (rows: typeof warming) => rows.map((i) => i.clears).filter((d): d is string => !!d).sort().map((d) => shortDate(new Date(d)));
  let when = '';
  if (warming.length) {
    const ready = dates(warming);
    if (ready.length) {
      const first = ready[0];
      const last = ready[ready.length - 1];
      when = first === last ? ` Ready to send cold email around ${last}.` : ` Ready to send cold email between ${first} and ${last}.`;
    }
    const waiting = warming.length - ready.length;
    if (waiting > 0) when += ` ${plural(waiting, 'inbox', 'inboxes')} waiting on a warmup score.`;
  } else if (ramping.length) {
    const full = dates(ramping);
    if (full.length) when = ` Each one sends a little more every day, all at full volume by ${full[full.length - 1]}.`;
  }
  const tail = ` ${list.length === 0 ? '0 problems' : plural(list.length, 'problem')}.`;
  return { configured: true, line: `${head}${when}${tail}`, problems: list.length, list, retrying, warming: warming.length, sending };
}

export type WarmStatus = { configured: boolean; line: string; blocking: number };

/** The buyer-blast (Resend) half of the top sentence. */
export function warmStatus(o: Overview | null, pm: Postmaster | null, accountId: number | null): WarmStatus {
  if (!o) return { configured: false, line: '', blocking: 0 };
  if (!o.resend?.configured) return { configured: false, line: 'Buyer blasts are not set up yet.', blocking: 0 };
  const blocking = campaignChecklist(o, pm, accountId).filter((i) => i.blocking && !i.ok).length;
  const senders = (o.resend.senders?.length ? o.resend.senders : o.resend.sender ? [o.resend.sender] : []).filter((s) => s.active && !s.settings.paused).length;
  if (blocking) return { configured: true, line: `Buyer blasts are on hold: ${plural(blocking, 'check')} to fix first.`, blocking };
  return { configured: true, line: `Buyer blasts are ready from ${plural(senders, 'address', 'addresses')}.`, blocking };
}

/** Where the "do this next" button scrolls to. */
export type NextAction = { label: string; target: Target };

/** The single most useful thing to do now, or null when there is nothing. */
export function nextAction(cold: ColdOverview | null, warm: WarmStatus): NextAction | null {
  if (cold) {
    const badDomain = cold.domains.find((d) => domainIssue(d) && cold.mailboxes.some((m) => m.domain_id === d.id));
    if (badDomain) return { label: `Fix ${textValue(badDomain.domain) || 'the sending domain'}`, target: 'sending-domains' };
    const live = cold.health?.warmup ?? {};
    const stuck = cold.mailboxes.filter((m) => mailboxIssue(m, live[textValue(m.email).toLowerCase()])?.level === 'problem').length;
    if (stuck) return { label: `Review ${plural(stuck, 'inbox', 'inboxes')} that need${stuck === 1 ? 's' : ''} you`, target: 'cold-inboxes' };
    if (cold.warmup.gate?.on && !cold.warmup.key_set) return { label: 'Add the Instantly key', target: 'cold-warmup' };
  }
  if (warm.configured && warm.blocking) return { label: 'See what holds up buyer blasts', target: 'warm-checklist' };
  if (cold && !cold.mailboxes.length) return { label: 'Add outreach inboxes', target: 'cold-inboxes' };
  if (cold && cold.mailboxes.some((m) => m.status === 'active' && !m.paused) && !cold.campaigns.some((c) => c.status === 'active')) {
    return { label: 'Write a cold campaign', target: 'cold-campaigns' };
  }
  return null;
}

/** Limits the worker pauses at (cold-campaign.ts): bounces over 2%, complaints at 0.1%. */
export const overLimit = (r: ColdHealthRow) => r.bounceRate > 0.02 || r.complaintRate >= 0.001;

/** "0 sent in the last 7 days. No bounces or complaints." for the health card. */
export function healthLine(rows: ColdHealthRow[]): { line: string; flagged: number } {
  const sent = rows.reduce((n, r) => n + Number(r.sent_7d ?? 0), 0);
  const bounced = rows.reduce((n, r) => n + Number(r.bounced_7d ?? 0), 0);
  const replied = rows.reduce((n, r) => n + Number(r.replied_7d ?? 0), 0);
  const complaints = rows.reduce((n, r) => n + Number(r.complaints_7d ?? 0), 0);
  const flagged = rows.filter(overLimit).length;
  if (!rows.length) return { line: 'Nothing sent yet.', flagged };
  if (!sent) return { line: `0 sent in the last 7 days across ${plural(rows.length, 'inbox', 'inboxes')}. No bounces or complaints.`, flagged };
  const pctOf = (n: number) => `${((n / sent) * 100).toFixed(1)}%`;
  const over = flagged ? ` ${plural(flagged, 'inbox', 'inboxes')} over the safe limit.` : ' All inside the safe limits.';
  return { line: `${sent.toLocaleString('en-US')} sent in the last 7 days. ${pctOf(bounced)} bounced, ${plural(replied, 'reply', 'replies')}, ${plural(complaints, 'spam complaint')}.${over}`, flagged };
}
