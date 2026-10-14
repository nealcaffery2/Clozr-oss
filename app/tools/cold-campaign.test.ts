// Cold campaigns: rotation, caps, ramp, sequence stops, recipient windows,
// the mailguard verification gate, reply classification, and blocked domains.
// Run with:  npx tsx tools/cold-campaign.test.ts
import assert from 'node:assert/strict';
import { blockUnverified, dailyAllowance, type MailboxSettings } from '../supabase/functions/_shared/deliverability-rules';
import {
  COLD_DAILY_CAP, COLD_GAP_MAX_SECONDS, COLD_GAP_MIN_SECONDS, COLD_RAMP_DAYS, COLD_RAMP_INCREASE_PCT, COLD_RAMP_START, COLD_RAMP_TARGET, DEFAULT_BLOCKED_SENDING_DOMAINS,
  DEFAULT_COLD_DELIVERABILITY, GOOGLE_WORKSPACE_IMAP, assignOnReply, GOOGLE_WORKSPACE_SMTP, applyMerge, applySpintax, blockedSendingDomains, bodyFingerprint, bodyTooCommon, businessWindowOpen, buyerInAudience,
  classifyReply, coldAudienceBlocked, coldDailyAllowance, coldMessageId, coldSendRoom, composeColdText, countsAsComplaint, createWarmupProvider, domainBlocked, healthRates, inRecipientWindow,
  isCatchAllStatus, isInstantlyWarmup, isRoleAddress, isThreadedFollowUp, lintColdCopy, mailboxGapSeconds, matchReply, oooResumeAt, parseMailboxCsv, pickPoolMailbox, pickVariant, placementPausesRamp, plainHtml, planColdSend, poolPauseReason,
  prospectReply, recipientCompanyDomain, recipientProvider, renderStep, replyOwner, replySubject, rewriteTrackedLinks, seeded, sendGapSeconds, sequenceStop, stateOf, withOpenPixel, zoneForState,
  type ColdDeliverability, type ColdDomain, type ColdMailbox, type ColdStep, type ColdWindow,
} from '../supabase/functions/_shared/cold-campaign';

const NOW = new Date('2026-10-06T15:00:00.000Z'); // Tuesday 10:00 America/Chicago
const WINDOW: ColdWindow = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };

function settings(over: Partial<MailboxSettings> = {}): MailboxSettings {
  return {
    daily_cap: 150, hourly_cap: 30, min_gap_seconds: 60,
    window_start: 8, window_end: 18, window_days: [1, 2, 3, 4, 5], timezone: 'America/Chicago',
    ramp_enabled: true, ramp_start: 50, ramp_increase_pct: 20, ramp_target: 150, ramp_started_on: '2026-10-06',
    paused: false, paused_reason: null,
    ...over,
  };
}

function domain(over: Partial<ColdDomain> = {}): ColdDomain {
  return { id: 1, domain: 'outreach.example.com', dailyCap: 500, sentToday: 0, paused: false, blocking: [], checkedAt: '2026-10-06T12:00:00.000Z', ...over };
}

function box(over: Partial<ColdMailbox> = {}): ColdMailbox {
  return {
    id: 1, domainId: 1, domain: 'outreach.example.com', email: 'a@outreach.example.com',
    paused: false, status: 'active', settings: settings(), sentToday: 0, sentLastHour: 0, lastSentAt: null,
    ...over,
  };
}

const step1: ColdStep = { position: 1, delayBusinessDays: 0, subject: 'Hello {{first_name}}', body: '{Hi|Hey} {{first_name}}', variants: [] };
const step2: ColdStep = { position: 2, delayBusinessDays: 2, subject: 'Re: Hello', body: 'Following up', variants: [] };

type PlanInput = Parameters<typeof planColdSend>[0];
function plan(over: {
  now?: Date;
  enrollment?: Partial<PlanInput['enrollment']>;
  steps?: PlanInput['steps'];
  campaign?: Partial<PlanInput['campaign']>;
  mailboxes?: PlanInput['mailboxes'];
  domains?: PlanInput['domains'];
  blockedDomains?: PlanInput['blockedDomains'];
  requireVerified?: boolean;
  cursor?: number;
  fields?: PlanInput['fields'];
  policy?: ColdDeliverability;
  recentBodies?: PlanInput['recentBodies'];
  recipientDomainSentToday?: number;
} = {}) {
  const base = {
    now: NOW,
    enrollment: {
      id: 7, status: 'active', email: 'pat@buyer.test', state: 'TX', stepPosition: 1,
      lastSentAt: null, enrolledAt: '2026-10-06T14:00:00.000Z', threadMessageId: null,
      suppressed: false, safety: 'safe' as const,
    },
    steps: [step1, step2],
    campaign: { status: 'active', window: WINDOW, fallbackTimezone: 'America/Chicago' },
    mailboxes: [box(), box({ id: 2, email: 'b@outreach.example.com' })],
    domains: [domain()],
    blockedDomains: blockedSendingDomains([]),
    requireVerified: false,
    cursor: 0,
    fields: { first_name: 'Pat' },
    policy: { ...DEFAULT_COLD_DELIVERABILITY, physicalAddress: '100 Congress Ave, Austin, TX 78701', restDays: false },
    recentBodies: [] as PlanInput['recentBodies'],
  };
  return planColdSend({
    ...base,
    ...over,
    enrollment: { ...base.enrollment, ...over.enrollment },
    campaign: { ...base.campaign, ...over.campaign },
    policy: over.policy ?? base.policy,
    recentBodies: over.recentBodies ?? base.recentBodies,
    recipientDomainSentToday: over.recipientDomainSentToday,
  });
}

async function main() {
  // ---- ramp: 50, +20%/day, ceiling 150
  const ramp = settings();
  assert.equal(dailyAllowance(ramp, '2026-10-06'), 50);
  assert.equal(dailyAllowance(ramp, '2026-10-07'), 60);
  assert.equal(dailyAllowance(ramp, '2026-10-08'), 72);
  assert.equal(dailyAllowance({ ...ramp, ramp_started_on: '2026-01-01' }, '2026-10-06'), 150);
  assert.equal(dailyAllowance({ ...ramp, ramp_enabled: false }, '2026-10-06'), 150);

  // Cold pool: 5 a day the first week, then 10, 15 and 20 a week apart, never the shared +20% curve.
  const cold = settings({
    daily_cap: COLD_DAILY_CAP, ramp_start: COLD_RAMP_START, ramp_increase_pct: COLD_RAMP_INCREASE_PCT, ramp_target: COLD_RAMP_TARGET,
  });
  assert.equal(COLD_RAMP_START, 5);
  assert.equal(COLD_DAILY_CAP, 20);
  assert.equal(COLD_RAMP_DAYS, 21);
  assert.equal(coldDailyAllowance(cold, '2026-10-06'), 5);
  assert.equal(coldDailyAllowance(cold, '2026-10-12'), 5);
  assert.equal(coldDailyAllowance(cold, '2026-10-16'), 10);
  assert.equal(coldDailyAllowance(cold, '2026-10-20'), 15);
  assert.equal(coldDailyAllowance(cold, '2026-10-27'), 20);
  assert.equal(coldDailyAllowance({ ...cold, daily_cap: 500, ramp_target: 500 }, '2026-10-27'), 20);
  assert.equal(coldSendRoom(20, 20, 40), 20);
  assert.equal(coldSendRoom(20, 25, 40), 15);
  assert.equal(coldSendRoom(5, 20, 40), 5);
  assert.equal(coldSendRoom(20, 40, 40), 0);
  assert.equal(dailyAllowance(cold, '2026-10-07'), 6, 'the shared helper is still exponential and is not what cold sends use');
  const jittered = coldDailyAllowance(cold, '2026-10-06', { mailboxId: 4, jitterPct: 15 });
  assert.ok(jittered >= 1 && jittered <= 5);
  assert.equal(jittered, coldDailyAllowance(cold, '2026-10-06', { mailboxId: 4, jitterPct: 15 }));

  const gapA = sendGapSeconds(4, '2026-10-06T14:00:00.000Z');
  const gapB = sendGapSeconds(4, '2026-10-06T14:00:00.000Z');
  const gapC = sendGapSeconds(4, '2026-10-06T16:00:00.000Z');
  assert.equal(gapA, gapB);
  assert.ok(gapA >= COLD_GAP_MIN_SECONDS && gapA <= COLD_GAP_MAX_SECONDS);
  assert.equal(COLD_GAP_MIN_SECONDS, 4 * 60);
  assert.equal(COLD_GAP_MAX_SECONDS, 11 * 60);
  assert.notEqual(gapA, gapC);
  const coldBox = box({ settings: cold, lastSentAt: new Date(NOW.getTime() - 60_000).toISOString() });
  assert.equal(mailboxGapSeconds(coldBox, NOW) > 60, true);
  const fresh = pickPoolMailbox([coldBox, box({ id: 2, email: 'b@outreach.example.com', settings: cold, lastSentAt: null })], [domain()], [], 0, NOW);
  assert.equal(fresh?.mailbox.id, 2);
  assert.ok(fresh?.skips.includes('gap'));

  // ---- rotation and caps
  const full = box({ id: 1, sentToday: 50 });
  const paused = box({ id: 2, email: 'b@outreach.example.com', paused: true, sentToday: 0 });
  const open = box({ id: 3, email: 'c@outreach.example.com', sentToday: 10 });
  const picked = pickPoolMailbox([full, paused, open], [domain()], [], 0, NOW);
  assert.equal(picked?.mailbox.id, 3);
  assert.ok(picked?.skips.includes('daily_cap'));
  assert.ok(picked?.skips.includes('paused'));

  const both = [box({ id: 1 }), box({ id: 2, email: 'b@outreach.example.com' })];
  const noRest = { ...DEFAULT_COLD_DELIVERABILITY, restDays: false, physicalAddress: '100 Congress Ave, Austin, TX 78701' };
  assert.equal(pickPoolMailbox(both, [domain()], [], 0, NOW, noRest)?.mailbox.id, 1);
  assert.equal(pickPoolMailbox(both, [domain()], [], 1, NOW, noRest)?.mailbox.id, 2);
  const resting = pickPoolMailbox(both, [domain()], [], 0, NOW);
  assert.equal(resting?.mailbox.id, 2);
  assert.ok(resting?.skips.includes('resting'));

  const hourly = pickPoolMailbox([box({ sentLastHour: 30 }), box({ id: 2, email: 'b@outreach.example.com', sentLastHour: 0 })], [domain()], [], 0, NOW);
  assert.equal(hourly?.mailbox.id, 2);

  const gapped = pickPoolMailbox([
    box({ lastSentAt: new Date(NOW.getTime() - 10_000).toISOString() }),
    box({ id: 2, email: 'b@outreach.example.com', lastSentAt: null }),
  ], [domain()], [], 0, NOW);
  assert.equal(gapped?.mailbox.id, 2);

  const domainFull = pickPoolMailbox(
    [box({ id: 1 }), box({ id: 2, email: 'b@outreach.example.com' })],
    [domain({ sentToday: 500, dailyCap: 500 })],
    [], 0, NOW,
  );
  assert.equal(domainFull, null);

  const stale = pickPoolMailbox([box()], [domain({ checkedAt: '2026-09-01T00:00:00.000Z' })], [], 0, NOW);
  assert.equal(stale, null);
  const blocking = pickPoolMailbox([box()], [domain({ blocking: ['SPF is missing'] })], [], 0, NOW);
  assert.equal(blocking, null);

  // ---- blocked sending domains, including subdomains, always on
  const blocked = blockedSendingDomains([]);
  assert.deepEqual([...DEFAULT_BLOCKED_SENDING_DOMAINS].sort(), [...blocked].sort());
  assert.ok(blockedSendingDomains(['extra.test']).includes('extra.test'));
  for (const d of ['yourcompany.com', 'deals.yourcompany.com', 'mail.yourcompany.com']) {
    assert.equal(domainBlocked(d, blocked), true, d);
  }
  assert.equal(domainBlocked('outreach.example.com', blocked), false);
  const banned = pickPoolMailbox(
    [box({ domain: 'deals.yourcompany.com', email: 'a@deals.yourcompany.com', domainId: 9 })],
    [domain({ id: 9, domain: 'deals.yourcompany.com' })],
    blocked, 0, NOW,
  );
  assert.equal(banned, null);
  const bannedPlan = plan({
    mailboxes: [box({ domain: 'yourcompany.com', email: 'a@yourcompany.com' })],
    domains: [domain({ domain: 'yourcompany.com' })],
    blockedDomains: blocked,
  });
  assert.equal(bannedPlan.action, 'wait');

  // ---- sequence stop conditions
  assert.equal(sequenceStop({ status: 'replied', suppressed: false, safety: 'safe', requireVerified: false, stepsLeft: true })?.status, 'replied');
  assert.equal(sequenceStop({ status: 'bounced', suppressed: false, safety: 'safe', requireVerified: false, stepsLeft: true })?.status, 'bounced');
  assert.equal(sequenceStop({ status: 'unsubscribed', suppressed: false, safety: 'safe', requireVerified: false, stepsLeft: true })?.status, 'unsubscribed');
  assert.equal(sequenceStop({ status: 'active', suppressed: true, safety: 'safe', requireVerified: false, stepsLeft: true })?.status, 'suppressed');
  assert.equal(sequenceStop({ status: 'active', suppressed: false, safety: 'safe', requireVerified: false, stepsLeft: false })?.status, 'completed');
  assert.equal(sequenceStop({ status: 'active', suppressed: false, safety: 'safe', requireVerified: true, stepsLeft: true }), null);

  for (const status of ['replied', 'bounced', 'unsubscribed'] as const) {
    const r = plan({ enrollment: { status } });
    assert.equal(r.action, 'stop');
    if (r.action === 'stop') assert.equal(r.status, status);
  }
  const suppressed = plan({ enrollment: { suppressed: true } });
  assert.equal(suppressed.action, 'stop');
  if (suppressed.action === 'stop') assert.equal(suppressed.status, 'suppressed');

  // ---- mailguard: cold is bulk
  const safeties = ['safe', 'unsafe', 'unverified'] as const;
  for (const safety of safeties) {
    for (const requireVerified of [false, true]) {
      assert.equal(
        coldAudienceBlocked(safety, requireVerified),
        blockUnverified(safety, 'bulk', { requireVerified }),
        `${safety} require=${requireVerified}`,
      );
    }
  }
  assert.equal(blockUnverified('unsafe', 'bulk', {}), true);
  assert.equal(blockUnverified('unverified', 'bulk', {}), false);
  assert.equal(blockUnverified('unverified', 'bulk', { requireVerified: true }), true);
  assert.equal(blockUnverified('safe', 'bulk', { requireVerified: true }), false);
  const unsafe = plan({ enrollment: { safety: 'unsafe' } });
  assert.equal(unsafe.action, 'stop');
  const unverifiedOk = plan({ enrollment: { safety: 'unverified' }, requireVerified: false });
  assert.equal(unverifiedOk.action, 'send');
  const unverifiedNo = plan({ enrollment: { safety: 'unverified' }, requireVerified: true });
  assert.equal(unverifiedNo.action, 'stop');
  if (unverifiedNo.action === 'stop') assert.match(unverifiedNo.reason, /not verified/);

  // ---- timezone windows
  assert.equal(stateOf(null, ['Austin, TX']), 'TX');
  assert.equal(zoneForState('TX', 'America/New_York'), 'America/Chicago');
  assert.equal(zoneForState(null, 'America/Denver'), 'America/Denver');
  assert.equal(zoneForState('ZZ', 'America/Denver'), 'America/Denver');
  assert.equal(inRecipientWindow(NOW, 'America/Chicago', WINDOW), true);
  const night = new Date('2026-10-06T04:00:00.000Z'); // Monday 23:00 Chicago
  assert.equal(inRecipientWindow(night, 'America/Chicago', WINDOW), false);
  const earlyPacific = new Date('2026-10-06T15:30:00.000Z'); // 08:30 Los Angeles
  assert.equal(inRecipientWindow(earlyPacific, 'America/Los_Angeles', WINDOW), false);
  assert.equal(inRecipientWindow(earlyPacific, 'America/Chicago', WINDOW), true);

  const tx = plan({ enrollment: { state: 'TX' } });
  assert.equal(tx.action, 'send');
  const ca = plan({ now: earlyPacific, enrollment: { state: 'CA' } });
  assert.equal(ca.action, 'wait');
  if (ca.action === 'wait') assert.match(ca.reason, /Los_Angeles/);
  const unknown = plan({ now: new Date('2026-10-06T16:30:00.000Z'), enrollment: { state: null }, campaign: { fallbackTimezone: 'America/Denver' } });
  // 16:30Z is 10:30 Denver, inside 9-17
  assert.equal(unknown.action, 'send');
  const weekend = plan({ now: new Date('2026-10-10T15:00:00.000Z'), enrollment: { state: 'TX' } }); // Saturday
  assert.equal(weekend.action, 'wait');

  // ---- business-day delay: Friday + 1 business day opens Monday, not Saturday
  const friday = new Date('2026-10-09T15:00:00.000Z');
  const opened = businessWindowOpen(friday, 1, 'America/Chicago', WINDOW);
  assert.equal(opened.toISOString().slice(0, 10) >= '2026-10-12', true);
  const follow = plan({
    now: new Date('2026-10-07T15:00:00.000Z'),
    enrollment: { stepPosition: 2, lastSentAt: '2026-10-06T15:00:00.000Z' },
  });
  assert.equal(follow.action, 'wait');
  const followReady = plan({
    now: new Date('2026-10-08T15:00:00.000Z'),
    enrollment: { stepPosition: 2, lastSentAt: '2026-10-06T15:00:00.000Z', threadMessageId: '<first@outreach.example.com>' },
  });
  assert.equal(followReady.action, 'send');
  if (followReady.action === 'send') {
    assert.equal(followReady.inReplyTo, '<first@outreach.example.com>');
    assert.match(followReady.subject, /^Re:/);
    assert.equal(followReady.subject.startsWith('Re: Re:'), false);
  }
  const firstTouch = plan({
    steps: [{ ...step1, subject: 'Re: Hello {{first_name}}' }, step2],
    enrollment: { threadMessageId: '<old@someone.else>' },
  });
  assert.equal(firstTouch.action, 'send');
  if (firstTouch.action === 'send') {
    assert.equal(firstTouch.subject, 'Hello Pat');
    assert.equal(firstTouch.inReplyTo, null);
  }
  const forwarded = plan({ steps: [{ ...step1, subject: 'Fwd: Hello {{first_name}}' }, step2] });
  assert.equal(forwarded.action, 'send');
  if (forwarded.action === 'send') assert.equal(forwarded.subject, 'Hello Pat');
  const unthreaded = plan({
    now: new Date('2026-10-08T15:00:00.000Z'),
    enrollment: { stepPosition: 2, lastSentAt: '2026-10-06T15:00:00.000Z', threadMessageId: null },
  });
  assert.equal(unthreaded.action, 'send');
  if (unthreaded.action === 'send') {
    assert.equal(unthreaded.inReplyTo, null);
    assert.equal(isThreadedFollowUp(1, '<id@x>'), false);
    assert.equal(unthreaded.subject.startsWith('Re:'), false);
  }
  const pinned = plan({
    now: new Date('2026-10-08T15:00:00.000Z'),
    enrollment: { stepPosition: 2, lastSentAt: '2026-10-06T15:00:00.000Z', threadMessageId: '<first@outreach.example.com>', pinnedMailboxId: 2 },
  });
  assert.equal(pinned.action, 'send');
  if (pinned.action === 'send') assert.equal(pinned.mailboxId, 2);
  const busy = plan({ enrollment: { otherSequence: true } });
  assert.equal(busy.action, 'stop');
  if (busy.action === 'stop') assert.match(busy.reason, /active sequence/);
  const companyCap = plan({ enrollment: { email: 'pat@acme.test' }, recipientDomainSentToday: 3 });
  assert.equal(companyCap.action, 'wait');
  if (companyCap.action === 'wait') assert.match(companyCap.reason, /acme\.test/);
  const freemail = plan({ enrollment: { email: 'pat@gmail.com' }, recipientDomainSentToday: 9 });
  assert.equal(freemail.action, 'send');
  assert.equal(recipientCompanyDomain('pat@gmail.com'), null);
  assert.equal(recipientCompanyDomain('pat@acme.test'), 'acme.test');
  assert.equal(replyOwner({ buyerAssignedTo: 'assignee', buyerOwnerId: 'owner', workspaceOwnerId: 'ws' }), 'assignee');
  assert.equal(replyOwner({ buyerOwnerId: 'owner', workspaceOwnerId: 'ws' }), 'owner');
  assert.equal(replyOwner({ workspaceOwnerId: 'ws' }), 'ws');
  assert.equal(replyOwner({}), null);
  // Replies route back to the rep the inbox sends as (migration 268), after an assignee.
  assert.equal(replyOwner({ mailboxUserId: 'inbox-rep', buyerOwnerId: 'owner', workspaceOwnerId: 'ws' }), 'inbox-rep');
  assert.equal(replyOwner({ buyerAssignedTo: 'assignee', mailboxUserId: 'inbox-rep' }), 'assignee');
  assert.equal(assignOnReply({ mailboxUserId: 'inbox-rep', classification: 'interested', complaint: false }), 'inbox-rep');
  assert.equal(assignOnReply({ buyerAssignedTo: 'other-rep', mailboxUserId: 'inbox-rep', classification: 'interested', complaint: false }), null, 'never takes a contact from a rep');
  for (const c of ['bounce', 'unsubscribe', 'out_of_office']) assert.equal(assignOnReply({ mailboxUserId: 'inbox-rep', classification: c, complaint: false }), null, `${c} is not a lead`);
  assert.equal(assignOnReply({ mailboxUserId: 'inbox-rep', classification: 'reply', complaint: true }), null, 'a complaint is not a lead');
  assert.equal(assignOnReply({ classification: 'reply', complaint: false }), null);

  // ---- merge, spintax, A/B stay stable for one seed
  assert.equal(applyMerge('Hi {{first_name}}', { first_name: 'Pat' }), 'Hi Pat');
  assert.equal(applyMerge('{{missing}}', {}), '');
  const spin = applySpintax('{Hi|Hey} {there|friend}', seeded(4));
  assert.equal(spin, applySpintax('{Hi|Hey} {there|friend}', seeded(4)));
  assert.match(spin, /^(Hi|Hey) (there|friend)$/);
  const variants = [
    { key: 'a', subject: 'A', body: 'body a', weight: 1 },
    { key: 'b', subject: 'B', body: 'body b', weight: 1 },
  ];
  assert.equal(pickVariant(variants, 9)?.key, pickVariant(variants, 9)?.key);
  const rendered = renderStep({ ...step1, variants }, 9, { first_name: 'Pat' });
  assert.ok(rendered.variant === 'a' || rendered.variant === 'b');
  const sent = plan();
  assert.equal(sent.action, 'send');
  if (sent.action === 'send') {
    assert.match(sent.subject, /Pat/);
    assert.match(sent.body, /Pat/);
    assert.ok(sent.from.endsWith('@outreach.example.com'));
  }

  // ---- replies
  assert.equal(classifyReply({ from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status', body: 'Final-Recipient: rfc822; pat@buyer.test\nStatus: 5.1.1' }), 'bounce');
  assert.equal(classifyReply({ from: 'pat@buyer.test', subject: 'Re: Hello', body: 'Please unsubscribe me' }), 'unsubscribe');
  assert.equal(classifyReply({ from: 'pat@buyer.test', subject: 'Out of office', body: 'I am out of the office until Monday' }), 'out_of_office');
  assert.equal(classifyReply({ from: 'pat@buyer.test', subject: 'Re: Hello', body: 'Not interested, thanks' }), 'not_interested');
  assert.equal(classifyReply({ from: 'pat@buyer.test', subject: 'Re: Hello', body: "Yes, send me the numbers" }), 'interested');
  assert.equal(classifyReply({ from: 'pat@buyer.test', subject: 'Re: Hello', body: 'Got it' }), 'other');
  assert.equal(countsAsComplaint({ from: 'pat@buyer.test', subject: 'spam', body: 'This is spam' }), true);
  assert.equal(classifyReply({ from: 'pat@buyer.test', subject: 'spam', body: 'This is spam' }), 'unsubscribe');

  const sends = [
    { id: 1, toEmail: 'pat@buyer.test', rfcMessageId: '<one@outreach.example.com>', enrollmentId: 4 },
    { id: 2, toEmail: 'sam@buyer.test', rfcMessageId: '<two@outreach.example.com>', enrollmentId: 5 },
  ];
  assert.equal(matchReply({ from: 'other@buyer.test', inReplyTo: '<one@outreach.example.com>', subject: 'Re', providerId: 'm1' }, sends)?.id, 1);
  assert.equal(matchReply({ from: 'sam@buyer.test', inReplyTo: null, subject: 'Re', providerId: 'm2' }, sends)?.enrollmentId, 5);
  assert.equal(matchReply({ from: 'nope@buyer.test', inReplyTo: null, subject: 'Hi', providerId: 'm3' }, sends), null);

  const tag = 'quiet-harbor';
  const warmupBody = `Hope you are well.\n\n${tag}`;
  assert.equal(isInstantlyWarmup({ subject: `Quick question | ${tag}`, body: 'Hello' }, tag), true);
  assert.equal(isInstantlyWarmup({ subject: 'Quick question', body: warmupBody }, tag), true);
  assert.equal(isInstantlyWarmup({ subject: 'Quick question', body: 'Hello', headers: { 'x-custom': tag } }, tag), true);
  assert.equal(isInstantlyWarmup({ subject: 'Quick question', body: 'Hello', headers: { 'x-instantly-warmup': 'true' } }, null), true);
  assert.equal(isInstantlyWarmup({ subject: 'Quick question', body: 'Hello', labels: ['Warmup'] }, null), true);
  assert.equal(isInstantlyWarmup({ subject: 'Quick question', body: 'Hello', labels: ['\\Inbox', 'Instantly Warmup'] }, null), true);
  assert.equal(isInstantlyWarmup({ subject: 'Quick question', body: 'Hello', folder: 'Instantly Warmup' }, null), true);
  assert.equal(isInstantlyWarmup({ subject: 'Following up 8f3k2p', body: 'See you then.\n\n8f3k2p' }, null), true);
  assert.equal(isInstantlyWarmup({ subject: 'Re: Hello', body: 'Yes, send me the numbers' }, tag), false);
  assert.equal(isInstantlyWarmup({ subject: 'Re: Hello', body: 'Hello' }, null), false);

  const warmupHit = prospectReply({
    from: 'pat@buyer.test', inReplyTo: '<one@outreach.example.com>', subject: `Re: Hello | ${tag}`, providerId: 'w1',
    body: `Yes, send me the numbers\n\n${tag}`,
  }, sends, tag);
  assert.deepEqual(warmupHit, { stop: false, reason: 'warmup' });
  const realHit = prospectReply({
    from: 'pat@buyer.test', inReplyTo: '<one@outreach.example.com>', subject: 'Re: Hello', providerId: 'w2',
    body: 'Yes, send me the numbers',
  }, sends, tag);
  assert.equal(realHit.stop, true);
  if (realHit.stop) assert.equal(realHit.classification, 'interested');

  // ---- health
  assert.deepEqual(healthRates({ sent: 100, bounced: 5, replied: 10, complaints: 1 }), { bounceRate: 0.05, replyRate: 0.1, complaintRate: 0.01 });
  assert.match(poolPauseReason({ sent7d: 100, bounced7d: 6, hardInLast50: 0, bulk30d: 100, unsub30d: 0, complaints7d: 0, replied7d: 10 }) ?? '', /bounce rate 6\.0%/);
  assert.match(poolPauseReason({ sent7d: 100, bounced7d: 6, hardInLast50: 0, bulk30d: 100, unsub30d: 0, complaints7d: 0, replied7d: 10 }) ?? '', /limit 2\.0%/);
  assert.match(poolPauseReason({ sent7d: 100, bounced7d: 0, hardInLast50: 0, bulk30d: 0, unsub30d: 0, complaints7d: 1, replied7d: 10 }) ?? '', /complaint/);
  assert.match(poolPauseReason({ sent7d: 10, bounced7d: 0, hardInLast50: 0, bulk30d: 0, unsub30d: 0, complaints7d: 1, replied7d: 1 }) ?? '', /spam complaint/);
  assert.match(poolPauseReason({ sent7d: 10, bounced7d: 0, hardInLast50: 0, bulk30d: 0, unsub30d: 0, complaints7d: 1, replied7d: 1 }) ?? '', /0\.1%/);
  assert.equal(poolPauseReason({ sent7d: 2000, bounced7d: 0, hardInLast50: 0, bulk30d: 2000, unsub30d: 0, complaints7d: 1, replied7d: 40 }), null);
  assert.equal(poolPauseReason({
    sent7d: 10, bounced7d: 0, hardInLast50: 0, bulk30d: 0, unsub30d: 0, complaints7d: 1, replied7d: 1,
    policy: { ...DEFAULT_COLD_DELIVERABILITY, anyComplaintPauses: false },
  }), null);
  assert.match(poolPauseReason({ sent7d: 80, bounced7d: 0, hardInLast50: 0, bulk30d: 80, unsub30d: 0, complaints7d: 0, replied7d: 0 }) ?? '', /reply rate/);
  assert.equal(poolPauseReason({ sent7d: 40, bounced7d: 0, hardInLast50: 0, bulk30d: 40, unsub30d: 0, complaints7d: 0, replied7d: 0 }), null);

  // ---- warmup stub makes no request
  let called = 0;
  const fetchImpl = () => { called++; return Promise.reject(new Error('network')); };
  const warmup = createWarmupProvider({ provider: 'mailreach', apiBase: 'https://vendor.example' }, { fetch: fetchImpl });
  const snap = await warmup.status({ id: 1, email: 'a@outreach.example.com', rampDay: 0, allowance: 50 });
  assert.equal(warmup.name, 'stub');
  assert.equal(snap.enrolled, false);
  assert.equal(snap.dailyTarget, 50);
  assert.match(snap.note, /No external warmup call/);
  assert.equal(called, 0);
  await warmup.enroll({ id: 1, email: 'a@outreach.example.com', rampDay: 0, allowance: 50 });
  await warmup.pause({ id: 1, email: 'a@outreach.example.com', rampDay: 0, allowance: 50 });
  const placed = await warmup.placement({ id: 1, email: 'a@outreach.example.com', rampDay: 0, allowance: 20 });
  assert.equal(placed.primaryRate, null);
  assert.equal(placed.spam ?? null, null);
  assert.equal(placementPausesRamp(placed, 0.8), null);
  assert.match(placementPausesRamp({ primaryRate: 0.5, checkedAt: '2026-10-06T00:00:00.000Z', sample: 20 }, 0.8) ?? '', /Primary/);
  assert.match(placementPausesRamp({ primaryRate: null, checkedAt: '2026-10-01T00:00:00.000Z', sample: 1, spam: true }, 0.8) ?? '', /Spam/);
  assert.match(placementPausesRamp({ primaryRate: null, checkedAt: null, sample: 0, placement: 'spam' }, 0.8) ?? '', /Spam/);
  assert.equal(called, 0);

  // ---- csv
  const csv = parseMailboxCsv('email,display_name,smtp_host,smtp_port,smtp_password,imap_host\na@outreach.example.com,Ada,smtp.example.com,465,s3cret,imap.example.com\n');
  assert.equal(csv.ok, true);
  if (csv.ok) {
    assert.equal(csv.rows[0].email, 'a@outreach.example.com');
    assert.equal(csv.rows[0].smtpPort, 465);
    assert.equal(csv.rows[0].smtpPassword, 's3cret');
    assert.equal(csv.rows[0].imapHost, 'imap.example.com');
    assert.equal(csv.skipped.length, 0);
  }
  const kit = parseMailboxCsv('Email Address,First Name,Last Name,App Password\nada@outreach.example.com,Ada,Lovelace,abcd efgh ijkl mnop\nnot-an-email,Bo,Missing,zzzz zzzz zzzz zzzz\nno-pass@outreach.example.com,Cy,None,\n');
  assert.equal(kit.ok, true);
  if (kit.ok) {
    assert.equal(kit.rows.length, 1);
    assert.equal(kit.rows[0].email, 'ada@outreach.example.com');
    assert.equal(kit.rows[0].displayName, 'Ada Lovelace');
    assert.equal(kit.rows[0].smtpPassword, 'abcdefghijklmnop');
    assert.equal(kit.rows[0].smtpHost, GOOGLE_WORKSPACE_SMTP.host);
    assert.equal(kit.rows[0].smtpPort, GOOGLE_WORKSPACE_SMTP.port);
    assert.equal(kit.rows[0].imapHost, GOOGLE_WORKSPACE_IMAP.host);
    assert.equal(kit.rows[0].imapPort, GOOGLE_WORKSPACE_IMAP.port);
    assert.equal(kit.rows[0].smtpUsername, 'ada@outreach.example.com');
    assert.equal(kit.skipped.length, 2);
    assert.match(kit.skipped[0].reason, /email/i);
    assert.match(kit.skipped[1].reason, /password/i);
  }
  assert.equal(parseMailboxCsv('name\nAda').ok, false);

  // ---- audience
  const buyer = { email: 'pat@buyer.test', status: 'Active', tags: ['compr'], markets: ['Austin, TX'], buyerType: null, entityType: null, archivedAt: null, blacklistedAt: null, phone: '5125550100' };
  assert.equal(buyerInAudience(buyer, { kind: 'tag', tag: 'compr' }), true);
  assert.equal(buyerInAudience(buyer, { kind: 'tag', tag: 'other' }), false);
  assert.equal(buyerInAudience({ ...buyer, blacklistedAt: '2026-01-01' }, { kind: 'tag', tag: 'compr' }), false);
  assert.equal(buyerInAudience(buyer, { kind: 'saved_view', config: { filters: { buyerState: 'TX', buyerStatus: 'Active' } } }), true);
  assert.equal(buyerInAudience(buyer, { kind: 'saved_view', config: { filters: { buyerState: 'CA' } } }), false);
  assert.equal(buyerInAudience(buyer, { kind: 'saved_view', config: { geniusOnly: true } }), false);
  assert.equal(buyerInAudience({ ...buyer, tags: ['genius'] }, { kind: 'saved_view', config: { geniusOnly: true } }), true);
  assert.equal(buyerInAudience({ ...buyer, ownerName: 'Ada' }, { kind: 'saved_view', config: { filters: { buyerOwner: 'Ada' } } }), true);
  assert.equal(buyerInAudience({ ...buyer, ownerName: '' }, { kind: 'saved_view', config: { filters: { buyerOwner: 'Unassigned' } } }), true);
  assert.equal(buyerInAudience({ ...buyer, ownerName: 'Ada' }, { kind: 'saved_view', config: { filters: { buyerOwner: 'Unassigned' } } }), false);

  // ---- Primary inbox: links, spam, plain text, tracking, roles, providers, OOO, variants
  const address = '100 Congress Ave, Austin, TX 78701';
  const readyPolicy = { ...DEFAULT_COLD_DELIVERABILITY, physicalAddress: address, restDays: false };
  assert.equal(isRoleAddress('info@buyer.test'), true);
  assert.equal(isRoleAddress('admin@buyer.test'), true);
  assert.equal(isRoleAddress('pat@buyer.test'), false);
  assert.equal(isCatchAllStatus('catch_all'), true);
  const role = plan({ enrollment: { email: 'info@buyer.test' }, policy: readyPolicy });
  assert.equal(role.action, 'stop');
  if (role.action === 'stop') assert.match(role.reason, /Role addresses/);
  const catchAll = plan({ enrollment: { verificationStatus: 'catch_all', safety: 'safe' }, policy: readyPolicy });
  assert.equal(catchAll.action, 'stop');
  if (catchAll.action === 'stop') assert.match(catchAll.reason, /Catch-all/);

  const linked = plan({
    policy: readyPolicy,
    steps: [{ position: 1, delayBusinessDays: 0, subject: 'Hello {{first_name}}', body: 'See https://example.com/offer', variants: [] }],
  });
  assert.equal(linked.action, 'wait');
  if (linked.action === 'wait') assert.match(linked.reason, /Step 1 cannot contain a link/);
  const twoLinks = plan({
    policy: readyPolicy,
    enrollment: { stepPosition: 2, lastSentAt: '2026-10-06T15:00:00.000Z', threadMessageId: '<first@outreach.example.com>' },
    now: new Date('2026-10-08T15:00:00.000Z'),
    steps: [{ position: 2, delayBusinessDays: 2, subject: 'Following up', body: 'https://a.example/1 and https://b.example/2', variants: [] }],
  });
  assert.equal(twoLinks.action, 'wait');
  if (twoLinks.action === 'wait') assert.match(twoLinks.reason, /limit 1/);
  assert.equal(rewriteTrackedLinks('Look https://example.com/offer', { enabled: false, trackingDomain: 'track.outreach.example.com' }), 'Look https://example.com/offer');
  assert.match(rewriteTrackedLinks('Look https://example.com/offer', { enabled: true, trackingDomain: 'track.outreach.example.com' }), /https:\/\/track\.outreach\.example\.com\/c\?u=/);
  assert.match(rewriteTrackedLinks('unsubscribe: https://app.example/unsubscribe?t=1', { enabled: true, trackingDomain: 'track.outreach.example.com' }), /unsubscribe\?t=1/);

  const spammy = lintColdCopy({
    stepPosition: 1, subject: 'FREE WINNER', body: 'Act now. Click here. Guaranteed. $$$', fields: {}, policy: readyPolicy,
  });
  assert.equal(spammy.ok, false);
  assert.ok(spammy.score >= 60);
  const missing = plan({ fields: { first_name: '' }, policy: readyPolicy });
  assert.equal(missing.action, 'wait');
  if (missing.action === 'wait') assert.match(missing.reason, /Missing merge/);
  const noAddress = plan({ policy: { ...readyPolicy, physicalAddress: '' } });
  assert.equal(noAddress.action, 'wait');
  if (noAddress.action === 'wait') assert.match(noAddress.reason, /physical address/);

  const html = plainHtml('Hi Pat\n\nLine two');
  assert.match(html, /Hi Pat/);
  assert.equal(/<img/i.test(html), false);
  assert.equal(withOpenPixel(html, false, 'https://track.example/o.png'), html);
  assert.match(withOpenPixel(html, true, 'https://track.example/o.png'), /<img /);
  const text = composeColdText('Hi Pat', { signature: 'Ada Lovelace', physicalAddress: address, unsubscribeUrl: 'https://app.example/unsubscribe?t=1' });
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /100 Congress Ave/);
  assert.match(text, /List-Unsubscribe|unsubscribe/i);
  assert.equal(coldMessageId(7, 1, 'abc', 'a@outreach.example.com'), '<cold.7.1.abc@outreach.example.com>');
  assert.equal(replySubject('Hello', true), 'Re: Hello');
  assert.equal(replySubject('Re: Hello', true), 'Re: Hello');
  assert.equal(replySubject('Re: Hello', false), 'Hello');
  assert.equal(replySubject('Fwd: Re: Hello', false), 'Hello');
  assert.equal(replySubject('FW: Hello', false), 'Hello');

  assert.equal(recipientProvider('pat@gmail.com'), 'gmail');
  assert.equal(recipientProvider('pat@outlook.com'), 'outlook');
  assert.equal(recipientProvider('pat@buyer.test', 'aspmx.l.google.com'), 'google_workspace');
  assert.equal(recipientProvider('pat@buyer.test', 'buyer-com.mail.protection.outlook.com'), 'outlook');
  assert.equal(recipientProvider('pat@buyer.test'), 'other');
  const gmailHeavy = box({
    id: 4, email: 'd@outreach.example.com', settings: cold, sentByProvider: { gmail: 4 },
  });
  const spread = pickPoolMailbox([gmailHeavy], [domain()], [], 0, NOW, readyPolicy, 'gmail');
  assert.equal(spread, null);

  const same = bodyFingerprint('Hello', 'Hi Pat');
  assert.equal(bodyTooCommon(same, [
    { hash: same, sentAt: new Date(NOW.getTime() - 60_000).toISOString() },
    { hash: same, sentAt: new Date(NOW.getTime() - 120_000).toISOString() },
    { hash: same, sentAt: new Date(NOW.getTime() - 180_000).toISOString() },
  ], NOW, 3, 30 * 60_000), true);
  const rotated = plan({
    policy: readyPolicy,
    recentBodies: [
      { hash: bodyFingerprint('Hello Pat', 'Hi Pat'), sentAt: new Date(NOW.getTime() - 60_000).toISOString() },
      { hash: bodyFingerprint('Hello Pat', 'Hey Pat'), sentAt: new Date(NOW.getTime() - 120_000).toISOString() },
      { hash: bodyFingerprint('Hello Pat', 'Hi Pat'), sentAt: new Date(NOW.getTime() - 180_000).toISOString() },
    ],
    steps: [{
      position: 1, delayBusinessDays: 0, subject: 'Hello {{first_name}}', body: '{Hi|Hey} {{first_name}}',
      variants: [{ key: 'B', subject: 'Note for {{first_name}}', body: 'Different note for {{first_name}}', weight: 1 }],
    }],
  });
  assert.equal(rotated.action, 'send');

  const back = oooResumeAt('I am out until 2026-10-20', NOW, 4, 'America/Chicago');
  assert.equal(back.toISOString().slice(0, 10), '2026-10-20');
  const held = oooResumeAt('I am out of the office', new Date('2026-10-09T15:00:00.000Z'), 4, 'America/Chicago');
  assert.equal(held.toISOString().slice(0, 10) >= '2026-10-15', true);

  console.log('cold-campaign: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
