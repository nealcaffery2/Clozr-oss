// The pure half of lib/buyer-contacts.ts: email keys, what the record lists
// under the primary, and why a typed number or address is refused.
// Run: npx tsx tools/buyer-contacts.test.ts
import assert from 'node:assert/strict';
import { emailKey, emailProblem, otherEmails, phoneKeyOf, phoneProblem } from '../lib/buyer-contacts';

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };

t('emailKey lower-cases and trims, and refuses non-addresses', () => {
  assert.equal(emailKey('  Ann@Example.COM '), 'ann@example.com');
  assert.equal(emailKey('ann@example'), null);
  assert.equal(emailKey(''), null);
  assert.equal(emailKey(null), null);
});

t('otherEmails: in position order, each once, never the primary', () => {
  const rows = [
    { id: 3, email: 'b@x.com', position: 3 },
    { id: 1, email: 'ANN@x.com', position: 2 },
    { id: 2, email: 'a@x.com', position: 2 },
    { id: 4, email: 'B@X.com', position: 4 },
  ];
  assert.deepEqual(otherEmails('ann@x.com', rows).map((r) => r.id), [2, 3]);
  assert.deepEqual(otherEmails('', rows).map((r) => r.id), [1, 2, 3]);
});

t('emailProblem names the reason, or null', () => {
  const have = [{ email: 'two@x.com' }];
  assert.equal(emailProblem('one@x.com', have, 'nope'), 'That is not an email address.');
  assert.equal(emailProblem('one@x.com', have, 'ONE@x.com'), 'That is already their main email.');
  assert.equal(emailProblem('one@x.com', have, ' two@X.com'), 'That email is already on file.');
  assert.equal(emailProblem('one@x.com', have, 'three@x.com'), null);
  assert.equal(emailProblem(null, [], 'first@x.com'), null);
});

t('phoneProblem names the reason, or null', () => {
  const have = [{ phone: '+12105550101' }];
  assert.equal(phoneProblem('(210) 555-0100', have, '555-0100'), 'That is not a full phone number.');
  assert.equal(phoneProblem('(210) 555-0100', have, '210.555.0100'), 'That is already their main number.');
  assert.equal(phoneProblem('(210) 555-0100', have, '1 210 555 0101'), 'That number is already on file.');
  assert.equal(phoneProblem('(210) 555-0100', have, '(210) 555-0102'), null);
});

t('phone_key is the E.164 number, as the other writers store it', () => {
  assert.equal(phoneKeyOf('+12105550100'), '+12105550100');
});

console.log(`\nall ${n} buyer-contacts checks passed`);
