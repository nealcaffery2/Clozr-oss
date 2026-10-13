// The recipient typeahead across People, Buyers, Vendors and the team.  Run:  npx tsx tools/contact-search.test.ts
import assert from 'node:assert/strict';
import { type Contact, ilikeSafe, isLinked, linkOf, parseQuery, rankContacts } from '../lib/contact-search';

const karenSeller: Contact = { kind: 'seller', id: 11, name: 'Karen Daniels', email: 'rlee2014@example.com', phone: '(210) 555-0100', sub: '12 Oak St' };
const karenBuyer: Contact = { kind: 'buyer', id: 21, name: 'Karen Holt', email: 'kh@fund.co', phone: null, sub: 'Holt Capital' };
const dan: Contact = { kind: 'buyer', id: 22, name: 'Dan Karenson', email: null, phone: '2105550199', sub: null };
const coo: Contact = { kind: 'team', id: 'u-1', name: 'Karen Ops', email: 'ops@acmehomes.com', phone: null, sub: 'COO' };
const title: Contact = { kind: 'vendor', id: 31, name: 'Alamo Title', email: 'close@alamo.com', phone: '2105550300', sub: 'Title' };
const all = [dan, coo, karenBuyer, karenSeller, title, karenSeller];

// Words: every word must match; People first at a tie; duplicates collapse.
assert.deepEqual(rankContacts(all, 'karen').map((c) => `${c.kind}:${c.id}`), ['seller:11', 'buyer:21', 'team:u-1', 'buyer:22']);
assert.deepEqual(rankContacts(all, 'karen holt').map((c) => c.id), [21]);
assert.deepEqual(rankContacts(all, 'oak').map((c) => c.id), [11], 'the second line counts');
assert.deepEqual(rankContacts(all, 'rlee2014@example.com').map((c) => c.id), [11]);
// Phones: digits match anywhere in the number, whatever the format.
assert.deepEqual(rankContacts(all, '555-0199').map((c) => c.id), [22]);
assert.deepEqual(rankContacts(all, '(210) 555').map((c) => c.id).sort(), [11, 22, 31].sort());
assert.deepEqual(rankContacts(all, '   '), []);
assert.equal(rankContacts(all, 'karen', 2).length, 2);

assert.deepEqual(parseQuery('210 555 0100'), { terms: ['210', '555', '0100'], digits: '2105550100' });
assert.equal(parseQuery('karen 55').digits, null, 'words are not a phone');
assert.equal(ilikeSafe('a,b(c)%_*'), 'a b c');

// Links.
assert.deepEqual(linkOf(karenSeller), { seller_id: 11 });
assert.deepEqual(linkOf(karenBuyer), { buyer_id: 21 });
assert.deepEqual(linkOf(title), { vendor_id: 31 });
assert.deepEqual(linkOf(coo), { user_id: 'u-1' });
assert.equal(isLinked({ seller_id: null, buyer_id: null }), false);
assert.equal(isLinked({ buyer_id: 3 }), true);

console.log('contact-search ok');
