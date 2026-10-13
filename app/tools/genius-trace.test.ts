// Skip trace written back onto a buyer who is already in the CRM.
// Run: npx tsx tools/genius-trace.test.ts
import assert from 'node:assert/strict';
import { hasSkipTraceContact, matchPropertyRuns, samePropertyAddress, streetKey, traceWrites, type Candidate } from '../lib/genius';

const cand = (phones: { number: string; dnc?: boolean; status?: 'good' | 'wrong' }[], emails: string[] = []): Candidate => ({
  contacts: [{ name: 'Derek Ross', phones: phones.map((p) => ({ number: p.number, type: 'Wireless', dnc: !!p.dnc, score: null, status: p.status })), emails, mailing: null }],
} as unknown as Candidate);

const blank = { phone: null, email: null, phoneKeys: [] as string[] };

assert.deepEqual(
  traceWrites(cand([{ number: '(469) 555-0181' }], ['derek.ross@outlook.com']), blank),
  {
    phone: '(469) 555-0181',
    email: 'derek.ross@outlook.com',
    insert: [{ phone: '(469) 555-0181', kind: 'Wireless', dnc: false, verified: false }],
  },
);

const again = traceWrites(cand([{ number: '4695550181' }, { number: '(214) 555-0199', status: 'good' }], ['other@outlook.com']), {
  phone: '(469) 555-0181', email: 'derek.ross@outlook.com', phoneKeys: ['4695550181'],
});
assert.equal(again.phone, null, 'a phone already on the record is not replaced');
assert.equal(again.email, null, 'an email already on the record is not replaced');
assert.deepEqual(again.insert.map((p) => p.phone), ['(214) 555-0199']);

assert.deepEqual(
  traceWrites(cand([{ number: '(469) 555-0181', status: 'wrong' }]), blank).insert,
  [],
  'a number marked wrong is not written',
);

assert.equal(hasSkipTraceContact({ contacts: null } as Candidate), false, 'not traced yet');
assert.equal(hasSkipTraceContact(cand([])), false, 'traced, nothing found');
assert.equal(hasSkipTraceContact(cand([{ number: '555' }])), false, 'too short to dial');
assert.equal(hasSkipTraceContact(cand([{ number: '(469) 555-0181', status: 'wrong' }])), false, 'wrong number only');
assert.equal(hasSkipTraceContact(cand([{ number: '(469) 555-0181' }])), true);
assert.equal(hasSkipTraceContact(cand([], ['a@b.co'])), true, 'an email is enough');

assert.equal(streetKey('344 Copper Ridge Lane, Dallas'), streetKey('344 Copper Ridge Ln'));
assert.equal(samePropertyAddress('344 Copper Ridge Lane', '344 Copper Ridge Ln, Dallas'), true);
assert.equal(samePropertyAddress('344 Copper Ridge Lane', '150 Quartz'), false);
assert.equal(samePropertyAddress('12', '12'), false, 'a house number alone is not a match');

assert.deepEqual(
  matchPropertyRuns([
    { id: 1, deal_id: 9, address: '150 Quartz St' },
    { id: 2, deal_id: null, address: '344 Copper Ridge Ln, Dallas' },
    { id: 2, deal_id: null, address: '344 Copper Ridge Ln, Dallas' },
    { id: 3, deal_id: 4, address: 'Other Rd' },
  ], 4, '344 Copper Ridge Lane').map((r) => r.id),
  [2, 3],
);

console.log('genius-trace: ok');
