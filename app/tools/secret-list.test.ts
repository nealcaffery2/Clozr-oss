// The secret blacklist is a tag the People and Buyers screens do not show.
// Run with: npx tsx tools/secret-list.test.ts
import assert from 'node:assert/strict';
import { isSecretBlacklisted, secretListCsv, visibleTags } from '../lib/secret-list';

assert.equal(isSecretBlacklisted(['cash', 'secret-blacklist']), true);
assert.equal(isSecretBlacklisted(['Secret-Blacklist']), true);
assert.equal(isSecretBlacklisted(['vip']), false);
assert.deepEqual(visibleTags(['cash', 'secret-blacklist', 'repeat']), ['cash', 'repeat']);
const csv = secretListCsv([{ name: 'Jordan "JL" Lee', kind: 'Buyer', phone: '(972) 555-0210', email: 'jordan@northlinehomes.com', detail: 'Northline Homes' }]);
assert.ok(csv.startsWith('name,kind,phone,email,detail,reason\n'));
assert.ok(csv.includes('"Jordan ""JL"" Lee"'));
assert.equal(csv.split('\n').length, 2);

console.log('secret-list: all assertions passed');
