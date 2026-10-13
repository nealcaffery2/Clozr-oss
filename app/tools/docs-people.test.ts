// Delivery by text, delegation, recipients added mid-flow, approvals.  Run:  npx tsx tools/docs-people.test.ts
import assert from 'node:assert/strict';
import {
  approvalDecision, codeText, contactChanges, defaultCrmKind, delegatedRole, insertAt, maskPhone, normalizeDelivery,
  phoneE164, phoneGateOk, phoneKey, phonesMatch, sideOfRole, signingText, wantsEmail, wantsSms,
} from '../supabase/functions/_shared/docs-people';

// Delivery: email is the default; sms needs a textable number.
assert.equal(normalizeDelivery(null), 'email');
assert.equal(normalizeDelivery('SMS'), 'email', 'only the exact values');
assert.equal(normalizeDelivery('both'), 'both');
assert.equal(wantsEmail({ email: 'a@b.co' }), true);
assert.equal(wantsEmail({ delivery: 'sms', email: 'a@b.co', phone: '2105550100' }), false);
assert.equal(wantsEmail({ delivery: 'both', email: '' }), false);
assert.equal(wantsSms({ delivery: 'sms', phone: '(210) 555-0100' }), true);
assert.equal(wantsSms({ delivery: 'both', phone: '555-0100' }), false, 'seven digits cannot take a text');
assert.equal(wantsSms({ phone: '2105550100' }), false, 'email delivery never texts');

// Phones.
assert.equal(phoneE164('(210) 555-0100'), '+12105550100');
assert.equal(phoneE164('1-210-555-0100'), '+12105550100');
assert.equal(phoneE164('555-0100'), null);
assert.equal(phoneKey('+1 210 555 0100'), '2105550100');
assert.equal(maskPhone('210-555-0100'), '•••-•••-0100');
assert.equal(phonesMatch('+12105550100', '(210) 555-0100'), true);
assert.equal(phonesMatch('+12105550100', '210-555-0199'), false);
assert.equal(phonesMatch(null, ''), false);
assert.equal(phoneGateOk({ phone: '2105550100', phone_verified_at: '2026-09-30T00:00:00Z', access_gate: 'g1' }, 'g1'), true);
assert.equal(phoneGateOk({ phone: '2105550100', phone_verified_at: null, access_gate: 'g1' }, 'g1'), false);
assert.equal(phoneGateOk({ phone: null, phone_verified_at: '2026-09-30T00:00:00Z', access_gate: 'g1' }, 'g1'), false);

// The text itself: "{Company}: {Name}, please review and sign {doc}: {link}".
const url = 'https://clozr.app/sign/?t=abc';
assert.equal(signingText({ company: 'Acme Homes', name: 'Karen Daniels', doc: 'Purchase Agreement', url }), `Acme Homes: Karen, please review and sign Purchase Agreement: ${url}`);
assert.equal(signingText({ company: 'Acme Homes', name: 'Karen', doc: 'PSA', url, reminder: true }), `Acme Homes: Reminder, Karen: please review and sign PSA: ${url}`);
assert.equal(signingText({ company: '', name: null, doc: 'Assignment', url, approve: true }), `CLOZR: Please review and approve Assignment: ${url}`);
assert.ok(signingText({ company: 'Acme Homes', name: 'K', doc: 'x'.repeat(200), url }).length < 140, 'long names are cut');
assert.match(codeText('Acme Homes', 'PSA', '123456'), /^Acme Homes: your code to open PSA is 123456\. It expires in 10 minutes\.$/);

// CRM side for "save as a new Person or Buyer?".
assert.equal(sideOfRole('seller'), 'seller');
assert.equal(sideOfRole('seller2'), 'seller');
assert.equal(sideOfRole('buyer'), 'buyer');
assert.equal(sideOfRole('assignee'), 'buyer');
assert.equal(sideOfRole('company'), null);
assert.equal(defaultCrmKind('assignee'), 'buyer');
assert.equal(defaultCrmKind('extra1'), 'seller');

// Adding a recipient mid-flow.
const rows = [{ id: 1, sort: 1 }, { id: 2, sort: 2 }, { id: 3, sort: 3 }];
assert.deepEqual(insertAt(rows, null), { sort: 4, shift: [] }, 'no position appends');
assert.deepEqual(insertAt(rows, 9), { sort: 4, shift: [] });
assert.deepEqual(insertAt(rows, 2), { sort: 2, shift: [{ id: 2, sort: 3 }, { id: 3, sort: 4 }] });
assert.deepEqual(insertAt(rows, 1), { sort: 1, shift: [{ id: 1, sort: 2 }, { id: 2, sort: 3 }, { id: 3, sort: 4 }] });
assert.deepEqual(insertAt([], 1), { sort: 1, shift: [] });

// Delegation frees the role for the new person.
assert.equal(delegatedRole('seller', 42), 'seller~delegated42');

// Approvals: a rejection needs a reason.
assert.deepEqual(approvalDecision('approve', ''), { ok: true, approve: true, reason: null });
assert.deepEqual(approvalDecision('reject', '  price is wrong '), { ok: true, approve: false, reason: 'price is wrong' });
assert.equal(approvalDecision('reject', '').ok, false);
assert.equal(approvalDecision('maybe', 'x').ok, false);

// What changed on a recipient.
assert.deepEqual(contactChanges({ name: 'Karen', email: 'k@x.co', phone: '2105550100' }, { email: 'K@x.co ', phone: '+1 (210) 555-0100' }), []);
assert.deepEqual(contactChanges({ name: 'Karen', email: 'k@x.co', phone: null }, { name: 'Karen D', email: 'k@y.co', phone: '2105550100' }), ['name', 'email', 'phone']);

console.log('docs-people ok');
