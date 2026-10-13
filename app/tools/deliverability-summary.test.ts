// The plain-words read at the top of Settings → Outbound OS → Email
// deliverability: the status sentence, the next action, inbox grouping and
// the plain error lines. Every sentence it builds also has to pass the
// no-AI-slop check, since the owner reads it.
// Run with:  npx tsx tools/deliverability-summary.test.ts
import assert from 'node:assert/strict';
import type { ColdDomain, ColdMailbox, ColdOverview } from '../lib/cold-pool';
import { coldStatus, groupByDomain, healthLine, mailboxIssue, mailboxPill, nextAction } from '../lib/deliverability-summary';
import { slopFindings } from '../supabase/functions/_shared/no-ai-slop';

const STARTED = '2026-10-10T12:00:00.000Z';
const REPLY_ERR = 'Reply check failed. It will be tried again.';
/** The page is read a few hours after the owner's last DNS check. */
const NOW = new Date('2026-10-10T18:00:00Z');

function domain(id: number, patch: Partial<ColdDomain> = {}): ColdDomain {
  return { id, domain: `outreach${id}.com`, daily_cap: 60, dkim_selectors: [], score: 92, blocking: [], checked_at: '2026-10-09T00:00:00Z', paused: false, paused_reason: null, paused_auto: false, ...patch };
}
function mailbox(id: number, domainId: number, patch: Partial<ColdMailbox> = {}): ColdMailbox {
  return {
    id, domain_id: domainId, email: `rep${id}@outreach${domainId}.com`, display_name: null, provider: 'smtp', status: 'warming', daily_cap: 20, hourly_cap: 5, min_gap_seconds: 240, timezone: 'America/Chicago',
    ramp_start: 5, ramp_increase_pct: 20, ramp_target: 20, ramp_started_on: '2026-10-10', paused: false, paused_reason: null, smtp_host: 'smtp.gmail.com', imap_host: 'imap.gmail.com', last_error: null,
    warmup_started_at: STARTED, warmup_score: null, warmup_checked_at: null, warmup_sent_14d: 0, warmup_spam_14d: 0, warmup_spam_pct: null,
    warmup_gate: { ready: false, daysWarming: 0, reason: 'Warming, day 1 of 14, no score yet.' }, ...patch,
  };
}

/** The owner's pool on 2026-10-10: 25 warming inboxes on 9 domains, 8 retrying a reply check. */
function pool(patch: Partial<ColdOverview> = {}): ColdOverview {
  const domains = Array.from({ length: 9 }, (_, i) => domain(i + 1));
  const mailboxes = Array.from({ length: 25 }, (_, i) => mailbox(i + 1, (i % 9) + 1, i < 8 ? { last_error: REPLY_ERR } : {}));
  return {
    admin: true, locked_domains: [], blocked: [], blocked_extra: [], fallback_timezone: 'America/Chicago', physical_address: '2100 Ross Ave, Dallas TX 75201',
    warmup: { provider: 'instantly', api_base: null, instantly_tag: null, key_set: true, calls_vendor: true, daily: 20, combined_ceiling: 40, gate: { on: true, min_days: 14, min_score: 90, spam_pause_pct: 3 } },
    google: { configured: false, redirect_uri: '' }, microsoft: { configured: false, redirect_uri: '' },
    domains, mailboxes, campaigns: [], saved_views: [],
    health: { mailboxes: mailboxes.map((m) => ({ email: m.email, sent_7d: 0, bounced_7d: 0, replied_7d: 0, complaints_7d: 0, bounceRate: 0, replyRate: 0, complaintRate: 0 })), domains: [] },
    ...patch,
  };
}

const clean = (text: string) => assert.deepEqual(slopFindings(text), [], `slop in: ${text}`);

// ---- the top sentence for the owner's real pool
{
  const s = coldStatus(pool(), NOW);
  assert.equal(s.line, '25 inboxes warming. Ready to send cold email around Oct 24. 0 problems.');
  assert.equal(s.problems, 0);
  assert.equal(s.retrying, 8, 'reply-check retries are counted apart, not as problems');
  clean(s.line);
  assert.equal(nextAction(pool(), { configured: false, line: '', blocking: 0 }), null, 'nothing to press while everything is warming');
}

// ---- dates spread over a week read as a range
{
  const p = pool();
  p.mailboxes[0] = { ...p.mailboxes[0], warmup_started_at: '2026-10-06T12:00:00.000Z' };
  assert.match(coldStatus(p, NOW).line, /between Oct 20 and Oct 24/);
}

// ---- a broken domain is the next action and floats to the top of the list
{
  const p = pool();
  p.domains[4] = domain(5, { blocking: ['SPF is missing.'] });
  const s = coldStatus(p, NOW);
  assert.deepEqual(s.list, [{ level: 'block', text: 'outreach5.com: SPF is missing.', target: 'sending-domains' }]);
  assert.equal(s.problems, 1);
  assert.match(s.line, /1 problem\.$/);
  assert.deepEqual(nextAction(p, { configured: false, line: '', blocking: 0 }), { label: 'Fix outreach5.com', target: 'sending-domains' });
  const groups = groupByDomain(p);
  assert.equal(groups[0].name, 'outreach5.com');
  assert.equal(groups[0].pill.label, 'DNS problem');
  assert.ok(groups[0].issue && groups[0].issue.includes('SPF is missing'));
  clean(groups[0].issue!);
}

// ---- inbox errors in plain words, with what happens next
{
  const retry = mailboxIssue(mailbox(1, 1, { last_error: REPLY_ERR }));
  assert.deepEqual(retry, { level: 'notice', text: "Couldn't check replies yet. Retrying automatically, nothing to do." });
  const login = mailboxIssue(mailbox(1, 1, { status: 'error', last_error: 'The mailbox needs to be connected again.' }));
  assert.equal(login?.level, 'problem');
  const paused = mailboxIssue(mailbox(1, 1, { paused: true, paused_reason: 'Bounces passed 2%.' }));
  assert.equal(paused?.text, 'Paused: Bounces passed 2%. It sends nothing until someone presses Resume.');
  for (const i of [retry, login, paused]) clean(i!.text);
  assert.equal(mailboxIssue(mailbox(1, 1)), null);
}

// ---- pills and ready dates
{
  assert.deepEqual(mailboxPill(mailbox(1, 1, { warmup_gate: { ready: false, daysWarming: 6, reason: '' } }), 14), { tone: 'muted', label: 'Warming, day 7 of 14' });
  assert.equal(mailboxPill(mailbox(1, 1, { status: 'active' }), 14).label, 'Sending');
  const ungated = pool();
  ungated.warmup = { ...ungated.warmup, gate: { on: false, min_days: 14, min_score: 90, spam_pause_pct: 3 } };
  ungated.mailboxes = ungated.mailboxes.map((m) => ({ ...m, warmup_gate: null }));
  assert.equal(coldStatus(ungated, NOW).line, '25 inboxes sending. Each one sends a little more every day, all at full volume by Oct 31. 0 problems.', 'no Instantly gate: the volume ramp alone, no warmup date');
  const gate10 = pool();
  gate10.warmup = { ...gate10.warmup, gate: { on: true, min_days: 10, min_score: 90, spam_pause_pct: 3 } };
  assert.match(coldStatus(gate10, NOW).line, /around Oct 20\./, 'the workspace warmup gate days set the date');
  const waiting = pool();
  waiting.mailboxes = waiting.mailboxes.map((m) => ({ ...m, warmup_gate: { ready: false, daysWarming: 15, reason: '' } }));
  assert.match(coldStatus(waiting, NOW).line, /25 inboxes waiting on a warmup score\./);
}

// ---- the 7-day health line
{
  const quiet = healthLine(pool().health.mailboxes);
  assert.equal(quiet.line, '0 sent in the last 7 days across 25 inboxes. No bounces or complaints.');
  const busy = healthLine([{ email: 'a@x.com', sent_7d: 100, bounced_7d: 3, replied_7d: 4, complaints_7d: 0, bounceRate: 0.03, replyRate: 0.04, complaintRate: 0 }]);
  assert.equal(busy.flagged, 1);
  assert.equal(busy.line, '100 sent in the last 7 days. 3.0% bounced, 4 replies, 0 spam complaints. 1 inbox over the safe limit.');
  clean(quiet.line);
  clean(busy.line);
}

// ---- empty pool and a missing Instantly key
{
  const empty = pool({ mailboxes: [], domains: [] });
  assert.equal(coldStatus(empty, NOW).configured, false);
  assert.equal(nextAction(empty, { configured: false, line: '', blocking: 0 })?.label, 'Add outreach inboxes');
  const noKey = pool();
  noKey.warmup = { ...noKey.warmup, key_set: false };
  assert.equal(nextAction(noKey, { configured: false, line: '', blocking: 0 })?.label, 'Add the Instantly key');
}

// ---- problems coldReadiness finds carry a link to the box that fixes them
{
  const p = pool({ physical_address: '' });
  p.mailboxes[3] = { ...p.mailboxes[3], paused: true, paused_reason: 'Bounces passed 2%.' };
  const s = coldStatus(p, NOW);
  assert.equal(s.problems, 2);
  assert.deepEqual(s.list.map((x) => [x.level, x.target]), [['block', 'cold-inboxes'], ['warn', 'cold-rules']]);
  assert.equal(s.list[0].text, 'rep4@outreach4.com: Paused: Bounces passed 2%. It sends nothing until someone presses Resume.', 'the paused inbox is said once, in the row words');
  for (const x of s.list) clean(x.text);
}

console.log('deliverability-summary: ok');
