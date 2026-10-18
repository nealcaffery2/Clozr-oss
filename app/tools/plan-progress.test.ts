// Action-plan send and reply totals.
// Run: npx tsx tools/plan-progress.test.ts
import { buildPlanProgress, channelWord, replySnippet, type ProgressEnrollment } from '../lib/plan-progress';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const enrolled = (over: Partial<ProgressEnrollment> & Pick<ProgressEnrollment, 'id' | 'planId'>): ProgressEnrollment => ({
  buyerId: 7, sellerId: null, name: 'Fahad', status: 'active', enrolledAt: '2026-10-01T15:00:00.000Z', stoppedReason: null, ...over,
});

const base = {
  steps: [
    { id: 1, channel: 'email' },
    { id: 2, channel: 'sms' },
    { id: 3, channel: 'rvm' },
    { id: 4, channel: 'ai_agent' },
    { id: 5, channel: 'call' },
  ],
  drops: [],
  coldReplies: [],
};

const one = (extra: Partial<Parameters<typeof buildPlanProgress>[0]>) => {
  const plans = buildPlanProgress({
    enrollments: [enrolled({ id: 10, planId: 61 })],
    tasks: [],
    comms: [],
    ...base,
    ...extra,
  });
  return plans[0];
};

eq('channel words', [channelWord('sms'), channelWord('rvm'), channelWord('ai_agent')], ['Text', 'Voicemail', 'AI agent']);
eq('reply snippet keeps the subject and flattens the body', replySnippet('Re: your account', 'Yes.\nSend it.'), 'Re: your account. Yes. Send it.');

const sent = one({
  tasks: [
    { id: 1, enrollmentId: 10, planStepId: 1, done: true, taskType: 'email', completedAt: '2026-10-01T16:00:00.000Z', dueAt: null, title: 'Intro', notes: 'Hello' },
    { id: 2, enrollmentId: 10, planStepId: 2, done: false, taskType: 'text', completedAt: null, dueAt: '2026-10-03T15:00:00.000Z', title: 'Nudge', notes: null },
    { id: 5, enrollmentId: 10, planStepId: 5, done: false, taskType: 'call', completedAt: null, dueAt: null, title: 'Call', notes: null },
  ],
  comms: [
    { id: 1, buyerId: 7, sellerId: null, direction: 'outbound', channel: 'email', status: 'sent', sourceId: 'plan:1', occurredAt: '2026-10-01T16:00:00.000Z', subject: 'Hello', body: 'Hello' },
    { id: 2, buyerId: 7, sellerId: null, direction: 'inbound', channel: 'email', status: 'received', sourceId: 'gmail:2', occurredAt: '2026-10-02T12:00:00.000Z', subject: 'Re: Hello', body: 'I am in.', fromEmail: 'fahad@example.com' },
  ],
});
eq('a filed email is a send, an open text is waiting, a call is not a send', { reached: sent.reached, sent: sent.sent, waiting: sent.waiting, replies: sent.replies }, { reached: 1, sent: 1, waiting: 1, replies: 1 });
eq('the reply list is the inbound message', sent.people[0].replies.map((r) => r.snippet), ['Re: Hello. I am in.']);

const skipped = one({
  tasks: [
    { id: 3, enrollmentId: 10, planStepId: 1, done: true, taskType: 'email', completedAt: '2026-10-01T16:00:00.000Z', dueAt: null, title: 'Intro', notes: 'Hello Fahad\nThis address already left the warmed sequence.' },
    { id: 4, enrollmentId: 10, planStepId: 2, done: true, taskType: 'text', completedAt: '2026-10-01T17:00:00.000Z', dueAt: null, title: 'Nudge', notes: 'number opted out of texts' },
  ],
  comms: [],
});
eq('a finished email or text with no message is a no-send', { sent: skipped.sent, notSent: skipped.notSent, reached: skipped.reached }, { sent: 0, notSent: 2, reached: 0 });
eq('the no-send reason is the last line of the task', skipped.people[0].attempts.map((a) => a.reason), [
  'This address already left the warmed sequence.',
  'number opted out of texts',
]);

const texted = one({
  tasks: [
    { id: 8, enrollmentId: 10, planStepId: 2, done: true, taskType: 'text', completedAt: '2026-10-01T16:00:00.000Z', dueAt: null, title: 'Nudge', notes: 'Hi' },
  ],
  comms: [
    { id: 8, buyerId: 7, sellerId: null, direction: 'outbound', channel: 'sms', status: 'delivered', sourceId: 'msg:abc', occurredAt: '2026-10-01T16:02:00.000Z', subject: null, body: 'Hi' },
  ],
});
eq('a Talkr text near the finished task counts as sent', texted.people[0].attempts.map((a) => a.outcome), ['sent']);

const textFailed = one({
  tasks: [
    { id: 8, enrollmentId: 10, planStepId: 2, done: true, taskType: 'text', completedAt: '2026-10-01T16:00:00.000Z', dueAt: null, title: 'Nudge', notes: 'Hi' },
  ],
  comms: [
    { id: 8, buyerId: 7, sellerId: null, direction: 'outbound', channel: 'sms', status: 'failed', sourceId: 'msg:abc', occurredAt: '2026-10-01T16:02:00.000Z', subject: null, body: 'Hi' },
  ],
});
eq('a carrier failure is a failed send', textFailed.failed, 1);

const mailFailed = one({
  tasks: [
    { id: 1, enrollmentId: 10, planStepId: 1, done: true, taskType: 'email', completedAt: '2026-10-01T16:00:00.000Z', dueAt: null, title: 'Intro', notes: 'Hello' },
  ],
  comms: [
    { id: 1, buyerId: 7, sellerId: null, direction: 'outbound', channel: 'email', status: 'bounced', sourceId: 'plan:1', occurredAt: '2026-10-01T16:00:00.000Z', subject: 'Hello', body: 'Hello' },
  ],
});
eq('a bounced plan email is a failed send', mailFailed.failed, 1);

const drops = one({
  tasks: [
    { id: 9, enrollmentId: 10, planStepId: 3, done: true, taskType: 'rvm', completedAt: '2026-10-01T18:00:00.000Z', dueAt: null, title: 'Voicemail', notes: null },
  ],
  drops: [
    { id: 1, enrollmentId: 10, planStepId: 3, status: 'failed', skipReason: null, lastError: 'Carrier refused the drop', sentAt: null, buyerId: 7, sellerId: null },
    { id: 2, enrollmentId: 10, planStepId: null, status: 'skipped', skipReason: 'no_phone', lastError: null, sentAt: null, buyerId: 7, sellerId: null },
    { id: 3, enrollmentId: 10, planStepId: 99, status: 'dropped', skipReason: null, lastError: null, sentAt: '2026-10-02T15:00:00.000Z', buyerId: 7, sellerId: null },
    { id: 4, enrollmentId: 10, planStepId: 98, status: 'queued', skipReason: null, lastError: null, sentAt: null, buyerId: 7, sellerId: null },
  ],
});
eq('a drop is counted once, including skips and ones still queued', drops.people[0].attempts.map((a) => a.outcome).sort(), ['failed', 'not_sent', 'sent', 'waiting']);
eq('a skipped drop says why', drops.people[0].attempts.find((a) => a.outcome === 'not_sent')?.reason, 'No phone number');

const agent = one({
  tasks: [
    { id: 11, enrollmentId: 10, planStepId: 4, done: true, taskType: 'todo', completedAt: '2026-10-01T16:00:00.000Z', dueAt: null, title: 'AI agent', notes: 'Let it decide' },
    { id: 12, enrollmentId: 10, planStepId: 4, done: true, taskType: 'todo', completedAt: '2026-10-01T17:00:00.000Z', dueAt: null, title: 'AI agent', notes: 'AI agent not started: no AI agent works buyers in this workspace' },
  ],
});
eq('a started agent is a send and a refused one is a no-send', agent.people[0].attempts.map((a) => a.outcome), ['sent', 'not_sent']);

const decideOnce = one({
  tasks: [
    { id: 13, enrollmentId: 10, planStepId: 4, done: true, taskType: 'todo', completedAt: '2026-10-01T17:00:00.000Z', dueAt: null, title: 'First call', notes: 'Call them\nAI step not run: decide-once AI steps work seller leads only' },
  ],
});
eq('a decide-once step plan-agent skipped is a no-send, not a reach', decideOnce.people[0].attempts.map((a) => a.outcome), ['not_sent']);
eq('the skipped decide-once step says why', decideOnce.people[0].attempts[0].reason, 'decide-once AI steps work seller leads only');

const noise = one({
  tasks: [],
  comms: [
    { id: 3, buyerId: 7, sellerId: null, direction: 'inbound', channel: 'email', status: 'received', sourceId: 'cold-reply:1:x', occurredAt: '2026-10-02T12:00:00.000Z', subject: 'Undeliverable', body: 'bounce', fromEmail: 'mailer-daemon@example.com' },
    { id: 4, buyerId: 7, sellerId: null, direction: 'inbound', channel: 'email', status: 'received', sourceId: 'cold-reply:1:y', occurredAt: '2026-09-01T12:00:00.000Z', subject: 'Old', body: 'Before the plan', fromEmail: 'fahad@example.com' },
    { id: 5, buyerId: 7, sellerId: null, direction: 'inbound', channel: 'sms', status: 'received', sourceId: 'msg:in', occurredAt: '2026-10-02T13:00:00.000Z', subject: null, body: 'Stop please', fromEmail: null },
  ],
  coldReplies: [
    { buyerId: 7, communicationId: 6, classification: 'bounce', receivedAt: '2026-10-02T12:00:00.000Z', subject: 'bounce', snippet: 'no such user', fromEmail: 'a@b.com' },
    { buyerId: 7, communicationId: 7, classification: 'out_of_office', receivedAt: '2026-10-02T12:30:00.000Z', subject: 'OOO', snippet: 'away', fromEmail: 'fahad@example.com' },
    { buyerId: 7, communicationId: null, classification: 'interested', receivedAt: '2026-10-02T18:00:00.000Z', subject: 'Yes', snippet: 'Book me in', fromEmail: 'fahad@example.com' },
  ],
});
eq('bounces, out of office, machine mail, and earlier threads are not replies', noise.people[0].replies.map((r) => r.snippet), ['Yes. Book me in', 'Stop please']);

const stopped = buildPlanProgress({
  enrollments: [enrolled({ id: 10, planId: 61, status: 'done', stoppedReason: 'reply' })],
  steps: [], tasks: [], comms: [], drops: [], coldReplies: [],
});
eq('a reply stop with no stored message still shows in the list', stopped[0].people[0].replies[0].snippet, 'They replied, and the plan stopped.');

const two = buildPlanProgress({
  enrollments: [
    enrolled({ id: 10, planId: 61, name: 'Fahad', enrolledAt: '2026-10-01T15:00:00.000Z' }),
    enrolled({ id: 11, planId: 61, name: 'Fahad', enrolledAt: '2026-10-10T15:00:00.000Z' }),
    enrolled({ id: 12, planId: 62, buyerId: 8, name: 'Lana', enrolledAt: '2026-10-01T15:00:00.000Z' }),
  ],
  steps: [], tasks: [], drops: [], coldReplies: [],
  comms: [
    { id: 20, buyerId: 7, sellerId: null, direction: 'inbound', channel: 'sms', status: 'received', sourceId: 'msg:20', occurredAt: '2026-10-05T12:00:00.000Z', subject: null, body: 'First run', fromEmail: null },
    { id: 21, buyerId: 7, sellerId: null, direction: 'inbound', channel: 'sms', status: 'received', sourceId: 'msg:21', occurredAt: '2026-10-11T12:00:00.000Z', subject: null, body: 'Second run', fromEmail: null },
  ],
});
const fahad = two.find((p) => p.planId === 61)!;
eq('a later enrollment on the same plan keeps the newer reply', fahad.people.map((p) => p.replies.map((r) => r.snippet)), [['First run'], ['Second run']]);
eq('another plan is its own tally', two.find((p) => p.planId === 62)!.replies, 0);
eq('reached is people, sends are steps', { enrolled: fahad.enrolled, reached: fahad.reached }, { enrolled: 2, reached: 0 });

console.log(failed ? `${failed} failed` : 'plan-progress: ok');
if (failed) process.exit(1);
