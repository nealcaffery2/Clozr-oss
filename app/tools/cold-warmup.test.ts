// Cold pool warmup: the Instantly client, the InboxKit client, the gate, the
// Spam pause, and the locked sending domains on every import path.
// Run with:  npx tsx tools/cold-warmup.test.ts
import assert from 'node:assert/strict';
import {
  INSTANTLY_API_BASE, instantlyClient, readAccountsPage, readWarmupAnalytics, type FetchLike,
} from '../supabase/functions/_shared/instantly';
import {
  INBOXKIT_API_BASE, INBOXKIT_CREDENTIALS_PATH, INBOXKIT_LIST_PATH, INBOXKIT_WORKSPACES_PATH, INBOXKIT_DNS_ADD_PATH, INBOXKIT_HEALTH_PATH, inboxkitClient, listInboxkitWorkspaces, pickInboxkitWorkspace, readInboxkitDns, readInboxkitHealth, readInboxkitMailboxes, readInboxkitPassword, readInboxkitWorkspaces,
} from '../supabase/functions/_shared/inboxkit';
import {
  DEFAULT_BLOCKED_SENDING_DOMAINS, WARMUP_GATE_MIN_DAYS, WARMUP_GATE_MIN_SCORE, WARMUP_SPAM_PAUSE_PCT, blockedSendingDomains, coldDeliverability, importRefusal, mailboxSkip, poolAlerts,
  warmupDaysSince, warmupGate, warmupGateOn, warmupSpamPause, warmupSpamPct, type ColdDomain, type ColdMailbox,
} from '../supabase/functions/_shared/cold-campaign';

const NOW = new Date('2026-10-10T15:00:00.000Z');
const DAYS = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(answer: (call: Call) => { status?: number; body: unknown }): { fetchFn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const a = answer(call);
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
  };
  return { fetchFn, calls };
}

async function main() {
  // ---------------------------------------------------------- instantly
  {
    const page = readAccountsPage({
      items: [
        { email: 'A@Pool.example.com', status: 1, warmup_status: 1, stat_warmup_score: 93, warmup: { limit: 40 }, daily_limit: 30, timestamp_warmup_start: '2026-09-20T00:00:00.000Z' },
        { email: 'b@pool.example.com', status: -1, warmup_status: 0, stat_warmup_score: '61' },
        { email: 'not-an-email', warmup_status: 1 },
        null, 'junk', { warmup_status: 1 },
      ],
      next_starting_after: '2026-09-20T00:00:00.000Z&b@pool.example.com',
    });
    assert.equal(page.items.length, 2, 'rows without an email are dropped');
    assert.deepEqual(page.items[0], {
      email: 'a@pool.example.com', status: 1, warmupStatus: 1, warming: true, warmupLimit: 40, dailyLimit: 30, warmupScore: 93, warmupStartedAt: '2026-09-20T00:00:00.000Z',
    });
    assert.equal(page.items[1].warming, false);
    assert.equal(page.items[1].warmupScore, 61, 'a numeric string reads as a number');
    assert.equal(page.next, '2026-09-20T00:00:00.000Z&b@pool.example.com');
    assert.deepEqual(readAccountsPage(null), { items: [], next: null });
    assert.deepEqual(readAccountsPage({ items: 'nope' }), { items: [], next: null });
    assert.deepEqual(readAccountsPage([{ email: 'c@x.com' }]).items.map((i) => i.email), ['c@x.com'], 'a bare array still reads');
  }
  {
    const read = readWarmupAnalytics({
      email_date_data: {
        'a@pool.example.com': {
          '2026-10-09': { sent: 10, landed_inbox: 8, landed_spam: 2 },
          '2026-10-01': { sent: 5, landed_inbox: 5 },
          '2026-09-01': { sent: 100, landed_spam: 100 }, // outside the window
          'garbage': { sent: 9 },
        },
      },
      aggregate_data: {
        'a@pool.example.com': { sent: 115, landed_spam: 102, health_score: 87, health_score_label: '87%' },
        'B@pool.example.com': { sent: 7, landed_spam: 1, health_score: 100 },
      },
    }, NOW);
    const a = read.get('a@pool.example.com')!;
    assert.deepEqual(a, { email: 'a@pool.example.com', score: 87, sent: 15, inbox: 13, spam: 2, days: 2 }, 'day buckets inside 14 days win over the aggregate');
    const b = read.get('b@pool.example.com')!;
    assert.deepEqual(b, { email: 'b@pool.example.com', score: 100, sent: 7, inbox: 0, spam: 1, days: 0 }, 'no day buckets: the aggregate is the window');
    assert.equal(readWarmupAnalytics(null, NOW).size, 0);
    assert.equal(readWarmupAnalytics({ aggregate_data: 'x', email_date_data: [] }, NOW).size, 0);
  }
  {
    // The client pages with starting_after, sends the Bearer key, chunks analytics by 100, and reports HTTP failures by status.
    const pages: Record<string, unknown> = {
      '': { items: [{ email: 'a@x.com', warmup_status: 1 }], next_starting_after: 'cur1' },
      cur1: { items: [{ email: 'b@x.com', warmup_status: 0 }], next_starting_after: 'cur2' },
      cur2: { items: [], next_starting_after: null },
    };
    const f = fakeFetch((c) => {
      const u = new URL(c.url);
      if (u.pathname.endsWith('/accounts')) return { body: pages[u.searchParams.get('starting_after') ?? ''] };
      if (u.pathname.endsWith('/accounts/warmup-analytics')) {
        const emails = (c.body as { emails: string[] }).emails;
        return { body: { aggregate_data: Object.fromEntries(emails.map((e) => [e, { sent: 1, health_score: 95 }])) } };
      }
      return { status: 404, body: { message: 'Resource not found' } };
    });
    const client = instantlyClient('secret-key', { fetchFn: f.fetchFn });
    const accounts = await client.listAccounts();
    assert.deepEqual(accounts.map((a) => a.email), ['a@x.com', 'b@x.com']);
    assert.equal(f.calls.length, 3, 'three pages, the last one empty');
    assert.equal(f.calls[0].headers.Authorization, 'Bearer secret-key');
    assert.ok(f.calls[0].url.startsWith(`${INSTANTLY_API_BASE}/accounts?`));
    assert.ok(f.calls[1].url.includes('starting_after=cur1'));
    const many = Array.from({ length: 150 }, (_, i) => `m${i}@x.com`);
    const stats = await client.warmupAnalytics([...many, 'M0@x.com', 'bad'], NOW);
    assert.equal(stats.size, 150, 'duplicates and junk fold away');
    assert.equal(f.calls.length, 5, 'two analytics chunks of at most 100');
    assert.equal((f.calls[3].body as { emails: string[] }).emails.length, 100);
    assert.equal(stats.get('m7@x.com')?.score, 95);
    const bad = instantlyClient('k', { fetchFn: fakeFetch(() => ({ status: 401, body: { message: 'Missing Authorization header' } })).fetchFn });
    await assert.rejects(bad.listAccounts(), /Instantly 401: the key was refused/);
    const paid = instantlyClient('k', { fetchFn: fakeFetch(() => ({ status: 402, body: {} })).fetchFn });
    await assert.rejects(paid.warmupAnalytics(['a@x.com']), /Instantly 402: the Instantly plan is not active/);
    const weird = instantlyClient('k', { fetchFn: fakeFetch(() => ({ body: 'not json shaped' })).fetchFn });
    assert.deepEqual(await weird.listAccounts(), [], 'an unknown 200 shape is empty, not a throw');
  }

  // ----------------------------------------------------------- inboxkit
  {
    const read = readInboxkitMailboxes({
      error: false,
      mailboxes: [
        { uid: 'u1', username: 'Marvin', domain_name: 'Myzyng.net', first_name: 'marvin', last_name: 'kassulke', platform: 'GOOGLE', status: 'active' },
        { uid: 'u2', email: 'ann@other.net', platform: 'microsoft', status: 'Active' },
        { uid: 'u3', username: 'nodomain' },
        'junk',
      ],
      pages: 3,
    });
    assert.deepEqual(read.mailboxes, [
      { uid: 'u1', email: 'marvin@myzyng.net', firstName: 'marvin', lastName: 'kassulke', platform: 'GOOGLE', status: 'active' },
      { uid: 'u2', email: 'ann@other.net', firstName: '', lastName: '', platform: 'MICROSOFT', status: 'active' },
    ]);
    assert.equal(read.pages, 3);
    assert.deepEqual(readInboxkitMailboxes(null), { mailboxes: [], pages: null });
    assert.equal(readInboxkitPassword({ app_password: ' abcd efgh ijkl mnop ', password: 'x' }), 'abcd efgh ijkl mnop');
    assert.equal(readInboxkitPassword({ password: 'plain' }), 'plain');
    assert.equal(readInboxkitPassword({}), null);
    assert.equal(readInboxkitPassword('nope'), null);

    const f = fakeFetch((c) => {
      const u = new URL(c.url);
      if (u.pathname === `/v1${INBOXKIT_LIST_PATH}`) {
        const page = (c.body as { page: number }).page;
        return { body: { error: false, pages: 2, mailboxes: page === 1 ? [{ uid: 'u1', username: 'a', domain_name: 'x.com', platform: 'GOOGLE', status: 'active' }] : [{ uid: 'u2', username: 'b', domain_name: 'x.com', platform: 'GOOGLE', status: 'active' }] } };
      }
      if (u.pathname === `/v1${INBOXKIT_CREDENTIALS_PATH}`) return { body: { error: false, app_password: `pw-${u.searchParams.get('uid')}` } };
      return { status: 404, body: { error: true, message: 'Record Not Found' } };
    });
    const client = inboxkitClient('ik-key', '33333333-3333-4333-8333-333333333333', { fetchFn: f.fetchFn });
    const boxes = await client.listMailboxes();
    assert.deepEqual(boxes.map((b) => b.email), ['a@x.com', 'b@x.com']);
    assert.equal(f.calls.length, 2, 'stops at pages');
    assert.equal(f.calls[0].method, 'POST');
    assert.ok(f.calls[0].url.startsWith(INBOXKIT_API_BASE));
    assert.equal(f.calls[0].headers['X-Workspace-Id'], '33333333-3333-4333-8333-333333333333');
    assert.equal(f.calls[0].headers.Authorization, 'Bearer ik-key');
    assert.equal(await client.appPassword('u2'), 'pw-u2');
    assert.equal(await client.appPassword(''), null);
    const vendorError = inboxkitClient('k', 'ws', { fetchFn: fakeFetch(() => ({ body: { error: true, message: 'Workspace not found' } })).fetchFn });
    await assert.rejects(vendorError.listMailboxes(), /InboxKit: Workspace not found/);
    const denied = inboxkitClient('k', 'ws', { fetchFn: fakeFetch(() => ({ status: 401, body: {} })).fetchFn });
    await assert.rejects(denied.listMailboxes(), /InboxKit 401: the key was refused/);
  }

  // --------------------------------------------------------------- gate
  {
    assert.equal(WARMUP_GATE_MIN_DAYS, 14);
    assert.equal(WARMUP_GATE_MIN_SCORE, 90);
    assert.equal(WARMUP_SPAM_PAUSE_PCT, 3);
    assert.equal(warmupGateOn('instantly'), true);
    assert.equal(warmupGateOn(' Instantly '), true);
    assert.equal(warmupGateOn('stub'), false);
    assert.equal(warmupGateOn(null), false);
    assert.equal(warmupDaysSince(DAYS(3.5), NOW), 3);
    assert.equal(warmupDaysSince(null, NOW), 0);
    assert.equal(warmupDaysSince('garbage', NOW), 0);

    assert.equal(warmupGate({ startedAt: null, score: 99, now: NOW }).ready, false, 'no start date never passes');
    const young = warmupGate({ startedAt: DAYS(13.9), score: 99, now: NOW });
    assert.equal(young.ready, false, '13 days is not 14');
    assert.equal(young.daysWarming, 13);
    assert.match(young.reason, /day 14 of 14, score 99/);
    assert.equal(warmupGate({ startedAt: DAYS(14), score: 89, now: NOW }).ready, false, 'score 89 is under 90');
    assert.equal(warmupGate({ startedAt: DAYS(14), score: null, now: NOW }).ready, false, 'no score never passes');
    assert.match(warmupGate({ startedAt: DAYS(14), score: null, now: NOW }).reason, /waiting for a score/);
    const ready = warmupGate({ startedAt: DAYS(14), score: 90, now: NOW });
    assert.equal(ready.ready, true, '14 days and 90 opens it');
    assert.equal(ready.daysWarming, 14);
    assert.match(ready.reason, /Cold mail can start/);
    assert.equal(warmupGate({ startedAt: DAYS(40), score: 100, now: NOW }).ready, true);

    assert.equal(warmupSpamPct(0, 0), null);
    assert.equal(warmupSpamPct(200, 6), 3);
    assert.equal(warmupSpamPct(200, 7), 3.5);
    assert.equal(warmupSpamPct(10, 50), 100, 'spam never exceeds sent');
    assert.equal(warmupSpamPause(200, 6), null, 'exactly 3% does not pause');
    assert.match(warmupSpamPause(200, 7) ?? '', /3\.5%.*limit 3%/);
    assert.equal(warmupSpamPause(0, 0), null);
  }
  {
    // The planner: a gated warming mailbox cannot send; the same mailbox on the stub provider ramps as before.
    const domain: ColdDomain = { id: 1, domain: 'outreach.example.com', dailyCap: 500, sentToday: 0, paused: false, blocking: [], checkedAt: '2026-10-10T12:00:00.000Z' };
    const box: ColdMailbox = {
      id: 1, domainId: 1, domain: 'outreach.example.com', email: 'a@outreach.example.com', paused: false, status: 'warming',
      settings: {
        daily_cap: 20, hourly_cap: 6, min_gap_seconds: 240, window_start: 0, window_end: 24, window_days: [0, 1, 2, 3, 4, 5, 6], timezone: 'America/Chicago',
        ramp_enabled: true, ramp_start: 5, ramp_increase_pct: 20, ramp_target: 20, ramp_started_on: '2026-10-10', paused: false, paused_reason: null,
      },
      sentToday: 0, sentLastHour: 0, lastSentAt: null,
    };
    assert.equal(mailboxSkip({ ...box, warmupGated: true }, domain, [], NOW), 'warming');
    assert.equal(mailboxSkip({ ...box, warmupGated: false }, domain, [], NOW), null);
    assert.equal(mailboxSkip(box, domain, [], NOW), null, 'no gate flag: the old ramp');
    assert.equal(mailboxSkip({ ...box, status: 'active', warmupGated: true }, domain, [], NOW), null, 'the flag only holds a warming mailbox');
  }

  // ------------------------------------------------------ locked domains
  {
    for (const d of ['yourcompany.com']) {
      assert.ok((DEFAULT_BLOCKED_SENDING_DOMAINS as readonly string[]).includes(d), `${d} is always blocked`);
      assert.ok(blockedSendingDomains([]).includes(d));
      assert.ok(blockedSendingDomains([`-${d}`, '!' + d, 'allow:' + d]).includes(d), 'blocked_extra can only add');
      // Every import path (CSV, Google, Microsoft, InboxKit) asks importRefusal with the workspace list, extra or not.
      assert.equal(importRefusal(`alex@${d}`, []), 'Blocked sending domain.');
      assert.equal(importRefusal(`Alex@${d.toUpperCase()}`, []), 'Blocked sending domain.');
      assert.equal(importRefusal(`x@mail.${d}`, []), 'Blocked sending domain.', 'subdomains too');
      assert.equal(importRefusal(`x@${d}`, ['other.com']), 'Blocked sending domain.');
    }
    assert.equal(importRefusal('x@outreach.example.com', []), null);
    assert.equal(importRefusal('x@outreach.example.com', ['outreach.example.com']), 'Blocked sending domain.');
    assert.equal(importRefusal('nope', []), 'Not an email address.');
    assert.equal(importRefusal('x@localhost', []), 'Not a domain name.');
  }

  // ------------------------------------------------- inboxkit workspaces
  {
    const read = readInboxkitWorkspaces({ workspaces: [{ uid: 'ws_1', name: 'Compr', domains: 5 }, { name: 'no uid' }, { uid: 'ws_2', name: 'Empty', domains: 0 }] });
    assert.deepEqual(read, [{ uid: 'ws_1', name: 'Compr', domains: 5 }, { uid: 'ws_2', name: 'Empty', domains: 0 }]);
    assert.deepEqual(readInboxkitWorkspaces(null), []);
    assert.equal(pickInboxkitWorkspace([{ uid: 'a', name: '', domains: null }])?.uid, 'a');
    assert.equal(pickInboxkitWorkspace(read)?.uid, 'ws_1');
    assert.equal(pickInboxkitWorkspace([{ uid: 'a', name: '', domains: 2 }, { uid: 'b', name: '', domains: 3 }]), null);
    assert.equal(pickInboxkitWorkspace([]), null);

    const { fetchFn, calls: seen } = fakeFetch(() => ({ body: { error: false, workspaces: [{ uid: 'ws_9', name: 'Main', domains: 1 }] } }));
    const list = await listInboxkitWorkspaces('ik-key', { fetchFn });
    assert.deepEqual(list, [{ uid: 'ws_9', name: 'Main', domains: 1 }]);
    assert.equal(seen[0].url, `${INBOXKIT_API_BASE}${INBOXKIT_WORKSPACES_PATH}`);
    assert.equal(seen[0].headers['X-Workspace-Id'], undefined);
    assert.equal(seen[0].headers.Authorization, 'Bearer ik-key');
  }

  // Per-workspace gate days, enableWarmup, and the alert mail's lines.
  {
    assert.equal(coldDeliverability({}).warmupGateDays, WARMUP_GATE_MIN_DAYS);
    assert.equal(coldDeliverability({ warmup_gate_days: 3 }).warmupGateDays, 3);
    assert.equal(coldDeliverability({ warmup_gate_days: 0 }).warmupGateDays, 1);
    assert.equal(warmupGate({ startedAt: DAYS(3), score: 100, now: NOW, minDays: 3 }).ready, true);
    assert.equal(warmupGate({ startedAt: DAYS(2), score: 100, now: NOW, minDays: 3 }).ready, false);

    const { fetchFn, calls: seen } = fakeFetch(() => ({ body: { id: 'job' } }));
    await instantlyClient('k', { fetchFn }).enableWarmup(['a@x.com']);
    assert.equal(seen[0].url, `${INSTANTLY_API_BASE}/accounts/warmup/enable`);
    assert.deepEqual(seen[0].body, { emails: ['a@x.com'] });

    const quiet = poolAlerts({
      sync: { error: null, unlisted: [], rewarmed: [], resumed: [], promoted: [] },
      mailboxes: [{ email: 'a@x.com', status: 'warming', paused: false, paused_reason: null, warmup_score: 100, warmup_started_at: DAYS(1) }],
      domains: [{ domain: 'x.com', paused: false, paused_reason: null, blocking: [], checked_at: NOW.toISOString() }],
      minDays: 3, minScore: 90, now: NOW,
    });
    assert.deepEqual(quiet, { problems: [], healed: [] });

    const loud = poolAlerts({
      sync: { error: 'Instantly 401: the key was refused', unlisted: ['b@x.com'], rewarmed: ['c@x.com'], resumed: [], promoted: ['d@x.com'] },
      mailboxes: [
        { email: 'e@x.com', status: 'warming', paused: true, paused_reason: 'Auto-paused: bounces.', warmup_score: 100, warmup_started_at: DAYS(5) },
        { email: 'f@x.com', status: 'warming', paused: false, paused_reason: null, warmup_score: 70, warmup_started_at: DAYS(5) },
      ],
      domains: [{ domain: 'x.com', paused: false, paused_reason: null, blocking: ['x.com is listed on Spamhaus DBL.'], checked_at: null }],
      minDays: 3, minScore: 90, now: NOW,
    });
    assert.equal(loud.problems.length, 6);
    assert.ok(loud.problems.some((p) => p.includes('f@x.com') && p.includes('70')));
    assert.equal(loud.healed.length, 2);
  }

  // InboxKit mailbox health and DNS (docs.inboxkit.com, read 2026-10-11).
  {
    const health = readInboxkitHealth({ success: true, data: [
      { mailbox_id: 'mb_1', status: 'healthy', sent_7d: 271, bounce_7d: 5, bounce_rate_percent: 1.85, reply_rate_percent: 7.74, last_event_at: '2026-10-09T09:41:22Z' },
      { mailbox_id: 'mb_2', status: 'INACTIVE', last_event_at: '0001-01-01T00:00:00Z' },
      { status: 'healthy' },
    ] });
    assert.deepEqual(health, [
      { uid: 'mb_1', status: 'healthy', sent7: 271, bounce7: 5, bounceRatePct: 1.85, replyRatePct: 7.74, lastEventAt: '2026-10-09T09:41:22Z' },
      { uid: 'mb_2', status: 'inactive', sent7: 0, bounce7: 0, bounceRatePct: null, replyRatePct: null, lastEventAt: null },
    ], 'a row without a mailbox id is dropped; the zero date reads as no activity');
    assert.deepEqual(readInboxkitHealth(null), []);
    assert.deepEqual(readInboxkitDns({ dns_record: { records: [{ host: '@', type: 'txt', value: 'google-site-verification=x', status: 'propagated' }] } }), [{ host: '@', type: 'TXT', value: 'google-site-verification=x', status: 'propagated' }]);
    assert.deepEqual(readInboxkitDns({ dns_record: null }), []);

    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.url.includes('/api/dns/list') && call.url.includes('missing.com')) return { status: 404, body: { error: true } };
      if (call.url.includes('/api/dns/list')) return { body: { error: false, dns_record: { records: [] } } };
      if (call.url.endsWith(INBOXKIT_DNS_ADD_PATH)) return { status: 409, body: { error: true, message: 'exists' } };
      if (call.url.includes(INBOXKIT_HEALTH_PATH)) return { body: { success: true, data: [{ mailbox_id: 'm', status: 'healthy' }] } };
      return { body: {} };
    });
    const kit = inboxkitClient('k', 'ws_9', { fetchFn });
    assert.equal(await kit.dnsRecords('missing.com'), null, '404 means the domain is not in this InboxKit workspace');
    assert.deepEqual(await kit.dnsRecords('getcompr.com'), []);
    await kit.addDnsRecord('getcompr.com', { host: '@', type: 'TXT', value: 'google-site-verification=x' });
    const add = calls.find((c) => c.url.endsWith(INBOXKIT_DNS_ADD_PATH))!;
    assert.deepEqual(add.body, { domain: 'getcompr.com', records: [{ ttl: 300, host: '@', type: 'TXT', value: 'google-site-verification=x' }] }, '409 already there is not an error');
    assert.equal(add.headers['X-Workspace-Id'], 'ws_9');
    assert.equal((await kit.mailboxesHealth()).length, 1);
    assert.ok(calls.some((c) => c.url.includes(`${INBOXKIT_HEALTH_PATH}?page=1&limit=1000`)));
  }

  console.log('cold-warmup: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
