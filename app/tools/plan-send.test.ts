// Action-plan sends: who gets warmed cold mail, who gets the workspace mail,
// and what is held back. Run with: npx tsx tools/plan-send.test.ts
import assert from 'node:assert/strict';
import {
  autoSendOn, coldHold, emailLane, enrollmentOpen, enrollTitle, fillMerge, planBlock, planSender, subjectOf, tagToAdd, windowState,
  type PlanPerson,
} from '../supabase/functions/_shared/plan-send';

const person = (over: Partial<PlanPerson> = {}): PlanPerson => ({
  kind: 'buyer', tags: [], email: 'ada@example.com', phone: '2105550142',
  archived: false, blacklisted: false, optedIn: true, hasSignup: false, emailSafe: true, emailStatus: 'valid',
  ...over,
});
const open = { suppressed: false, requireVerified: false };
const hours = { enabled: true, start: '08:00', end: '21:00', days: [1, 2, 3, 4, 5] };

assert.equal(emailLane(person({ tags: ['compr-free-trial'] }), true), 'relationship', 'a free trial is relationship mail');
assert.equal(emailLane(person({ tags: ['compr-paid'], hasSignup: true }), true), 'relationship');
assert.equal(emailLane(person({ tags: ['compr-cold', 'compr-free-trial'] }), true), 'relationship', 'a customer tag wins over compr-cold');
assert.equal(emailLane(person({ tags: ['compr-cold'] }), true), 'cold');
assert.equal(emailLane(person(), true), 'cold', 'a Compr buyer with no account is a prospect');
assert.equal(emailLane(person({ kind: 'seller' }), true), 'relationship', 'a seller is not cold mail');
assert.equal(emailLane(person(), false), 'relationship', 'outside Compr a buyer is relationship mail');

assert.equal(autoSendOn(true, {}), true);
assert.equal(autoSendOn(true, { auto_send: false }), false);
assert.equal(autoSendOn(false, {}), false);
assert.equal(autoSendOn(false, { auto_send: true }), true);

assert.equal(planBlock(person(), 'email', 'cold', open), null);
assert.equal(planBlock(person({ email: 'info@shop.com' }), 'email', 'cold', open), 'role address');
assert.equal(planBlock(person({ email: 'info@shop.com' }), 'email', 'relationship', open), null, 'a customer may use a shared inbox');
assert.equal(planBlock(person({ emailStatus: 'catch_all' }), 'email', 'cold', open), 'catch-all address');
assert.equal(planBlock(person({ emailSafe: null }), 'email', 'cold', { suppressed: false, requireVerified: true }), 'address is not verified');
assert.equal(planBlock(person({ emailSafe: false }), 'email', 'cold', open), 'address is not safe to send');
assert.equal(planBlock(person({ tags: ['compr-master-exclude'] }), 'email', 'cold', open), 'excluded from Compr sends');
assert.equal(planBlock(person({ tags: ['DNC'] }), 'sms', 'relationship', open), 'do not contact');
assert.equal(planBlock(person({ optedIn: false }), 'sms', 'relationship', open), 'no text consent on file');
assert.equal(planBlock(person({ optedIn: false }), 'sms', 'relationship', { ...open, textWithoutConsent: true }), null);
assert.equal(planBlock(person({ optedIn: false, blacklisted: true }), 'sms', 'relationship', { ...open, textWithoutConsent: true }), 'do not contact');
assert.equal(planBlock(person({ kind: 'seller', optedIn: false, phone: '2105550142' }), 'sms', 'relationship', open), null);
assert.equal(planBlock(person({ phone: '' }), 'sms', 'relationship', open), 'no mobile number');
assert.equal(planBlock(person(), 'email', 'cold', { suppressed: true, requireVerified: false }), 'email unsubscribed or bounced');

assert.equal(tagToAdd(person(), 'cold'), 'compr-cold');
assert.equal(tagToAdd(person({ tags: ['compr-cold'] }), 'cold'), null);
assert.equal(tagToAdd(person({ tags: ['compr-free-trial'] }), 'cold'), null);
assert.equal(tagToAdd(person(), 'relationship'), null);

assert.equal(fillMerge('Hi {{first_name}}, {{rep_name}}', { first_name: 'Ada', rep_name: 'Alex' }), 'Hi Ada, Alex');
assert.equal(fillMerge('Hi {{unknown}}', {}), 'Hi {{unknown}}');
assert.equal(subjectOf('your first {{first_name}} run', 'ignored', { first_name: 'Ada' }), 'your first Ada run');
assert.equal(subjectOf('', 'First run', {}), 'First run');
assert.equal(enrollTitle('Compr · Activate new signups'), 'Started "Compr · Activate new signups"');
assert.equal(coldHold('active'), 'Already on a warmed sequence, so this step did not send a second one.');
assert.equal(coldHold('bounced') !== null, true);
assert.equal(coldHold('unsubscribed') !== null, true);
assert.equal(coldHold('suppressed') !== null, true);
assert.equal(coldHold('replied') !== null, true);
assert.equal(coldHold('stopped') !== null, true);
assert.equal(coldHold('completed'), null);
assert.equal(coldHold(null), null);

assert.equal(planSender({ compr: true, repId: 'alex', taskAssignee: 'sam', createdBy: 'sam' }), 'alex', 'a Compr step replies to the rep');
assert.equal(planSender({ compr: true, stepAssignee: 'ada', repId: 'alex', taskAssignee: 'sam' }), 'ada', 'a named step assignee wins');
assert.equal(planSender({ compr: false, repId: 'alex', taskAssignee: 'sam' }), 'sam');
assert.equal(enrollmentOpen('active'), true);
assert.equal(enrollmentOpen('paused'), false);
assert.equal(enrollmentOpen('done'), false);

// Thursday 15 Oct 2026 15:00 UTC is 10:00 in Chicago, inside the weekday window.
const thu = windowState(new Date('2026-10-15T15:00:00.000Z'), hours, 'America/Chicago');
assert.equal(thu.open, true);
// Sunday 18 Oct 2026 15:00 UTC is 10:00 in Chicago. Next open is Monday 08:00 Chicago, 13:00 UTC.
const sun = windowState(new Date('2026-10-18T15:00:00.000Z'), hours, 'America/Chicago');
assert.equal(sun.open, false);
assert.equal(sun.nextAt, '2026-10-19T13:00:00.000Z');
assert.equal(windowState(new Date('2026-10-18T15:00:00.000Z'), { enabled: false }, 'America/Chicago').open, true);

console.log('plan-send: ok');
