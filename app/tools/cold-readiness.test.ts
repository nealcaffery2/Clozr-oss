// The status read at the top of Email deliverability: is cold email safe to
// send, what blocks it, and when each inbox clears warmup.
// Run: npx tsx tools/cold-readiness.test.ts
import assert from 'node:assert/strict';
import { coldReadiness, type ColdDomain, type ColdMailbox, type ColdOverview } from '../lib/cold-pool';

const now = new Date('2026-10-10T12:00:00Z');
const domain = (p: Partial<ColdDomain> = {}): ColdDomain => ({ id: 1, domain: 'outreach.example.com', daily_cap: 500, dkim_selectors: [], score: 92, blocking: [], checked_at: '2026-10-10T06:00:00Z', paused: false, paused_reason: null, paused_auto: false, ...p });
const box = (p: Partial<ColdMailbox> = {}): ColdMailbox => ({
  id: 1, domain_id: 1, email: 'a@outreach.example.com', display_name: null, provider: 'smtp', status: 'active', daily_cap: 20, hourly_cap: 5, min_gap_seconds: 240, timezone: 'America/Chicago',
  ramp_start: 5, ramp_increase_pct: 0, ramp_target: 20, ramp_started_on: '2026-08-01', paused: false, paused_reason: null, smtp_host: null, imap_host: null, last_error: null,
  warmup_started_at: null, warmup_score: null, warmup_checked_at: null, warmup_sent_14d: null, warmup_spam_14d: null, warmup_spam_pct: null, warmup_gate: null, ...p,
});
const overview = (p: Partial<ColdOverview> = {}): ColdOverview => ({
  admin: true, locked_domains: [], blocked: [], blocked_extra: [], fallback_timezone: 'America/Chicago',
  warmup: { provider: 'instantly', api_base: null, instantly_tag: null, key_set: true, calls_vendor: true, gate: { on: true, min_days: 14, min_score: 90, spam_pause_pct: 3 } },
  physical_address: '1 Main St, Dallas TX', google: { configured: false, redirect_uri: '' }, microsoft: { configured: false, redirect_uri: '' },
  domains: [domain()], mailboxes: [box()], campaigns: [], saved_views: [], health: { mailboxes: [], domains: [] }, ...p,
});

// Healthy: one inbox at full volume.
let r = coldReadiness(overview(), now);
assert.equal(r.verdict, 'ok');
assert.equal(r.sendable, 1);
assert.equal(r.inboxes[0].state, 'ready');

// No inboxes.
r = coldReadiness(overview({ mailboxes: [] }), now);
assert.equal(r.verdict, 'none');
assert.equal(r.issues[0].level, 'block');

// Warming on day 4 of 14: clears in 10 days, not sendable, so blocked.
r = coldReadiness(overview({ mailboxes: [box({ status: 'warming', warmup_gate: { ready: false, daysWarming: 4, reason: '' } })] }), now);
assert.equal(r.verdict, 'blocked');
assert.equal(r.inboxes[0].state, 'warming');
assert.equal(r.inboxes[0].clears, '2026-10-20T12:00:00.000Z');

// Warmed 20 days but score 72: no date, says what it waits for.
r = coldReadiness(overview({ mailboxes: [box({ status: 'warming', warmup_score: 72, warmup_gate: { ready: false, daysWarming: 20, reason: '' } })] }), now);
assert.equal(r.inboxes[0].clears, null);
assert.match(r.inboxes[0].detail, /score of 90 \(now 72\)/);

// Failing DNS blocks the domain and its inbox, problem listed first.
r = coldReadiness(overview({ domains: [domain({ blocking: ['SPF is missing.'] })] }), now);
assert.equal(r.verdict, 'blocked');
assert.equal(r.inboxes[0].state, 'domain');
assert.equal(r.issues[0].text, 'outreach.example.com: SPF is missing.');

// Ramping inbox is sendable with a full-volume date; missing address only warns.
r = coldReadiness(overview({ physical_address: '', mailboxes: [box({ ramp_started_on: '2026-10-01' })] }), now);
assert.equal(r.verdict, 'warn');
assert.equal(r.inboxes[0].state, 'ramping');
assert.equal(r.inboxes[0].clears, '2026-10-22T00:00:00.000Z');
assert.equal(r.issues.every((i) => i.level === 'warn'), true);

// Gate on without a key is a blocker.
r = coldReadiness(overview({ warmup: { ...overview().warmup, key_set: false } }), now);
assert.equal(r.issues[0].level, 'block');
assert.equal(r.issues[0].section, 'warmup');

console.log('cold readiness: all assertions passed');
