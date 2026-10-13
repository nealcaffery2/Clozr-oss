// A record's Activity feed folds an email thread into one card: the newest
// message in place, the rest behind it oldest first.
// Run: npx tsx tools/email-thread.test.ts
import assert from 'node:assert/strict';
import { baseSubject, emailThreadKey, foldEmailThreads, replySubject } from '../lib/email-thread';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL', name);
    throw e;
  }
};

const mail = (id: string, inbound: boolean, subject: string, who = 'seller@example.com') => ({
  id,
  email: inbound
    ? { inbound, from: who, to: ['rep@clozr.app'], subject }
    : { inbound, from: 'rep@clozr.app', to: [who], subject },
});

test('Re:/Fwd: prefixes do not split a thread', () => {
  assert.equal(baseSubject('Re: RE: Fwd: 123 Oak St'), '123 Oak St');
  assert.equal(emailThreadKey(mail('a', true, 'Re: 123 Oak St').email), emailThreadKey(mail('b', false, '123 Oak St').email));
});

test('a reply subject never stacks Re:', () => {
  assert.equal(replySubject('Re: Re: 123 Oak St'), 'Re: 123 Oak St');
  assert.equal(replySubject(''), 'Re: (no subject)');
});

test('newest message keeps its place and carries the rest oldest first', () => {
  const feed = [
    mail('m3', true, 'Re: 123 Oak St'),
    { id: 'call1', email: null },
    mail('m2', false, 'Re: 123 Oak St'),
    mail('x1', true, 'Different house'),
    mail('m1', true, '123 Oak St'),
  ];
  const out = foldEmailThreads(feed);
  assert.deepEqual(out.map((t) => t.id), ['m3', 'call1', 'x1']);
  assert.deepEqual(out[0].earlier.map((t) => t.id), ['m1', 'm2']);
  assert.deepEqual(out[2].earlier, []);
});

test('the same subject with a different person is a different thread', () => {
  const out = foldEmailThreads([mail('a', true, 'Offer', 'one@example.com'), mail('b', true, 'Offer', 'two@example.com')]);
  assert.equal(out.length, 2);
});

test('a pinned message stays on its own', () => {
  const feed = [mail('m2', true, 'Re: Oak'), { ...mail('m1', true, 'Oak'), pinned: true }];
  const out = foldEmailThreads(feed);
  assert.deepEqual(out.map((t) => t.id), ['m2', 'm1']);
  assert.equal(out[0].earlier.length, 0);
});

console.log(`email-thread: ${passed} passed`);
