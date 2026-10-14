// The dial box's name lookup.  Run:  npx tsx tools/dial-lookup.test.ts
import assert from 'node:assert/strict';
import { type Contact } from '../lib/contact-search';
import { dialKindLabel, isNameQuery, mergeDialMatches, partyTrade, talkrContact, whoseNumber } from '../lib/dial-lookup';
import type { ContactDto } from '../lib/talkr-web/api';

const localKaren: Contact = { kind: 'seller', id: 'p11', name: 'Karen Daniels', email: null, phone: '(210) 555-0100', sub: '12 Oak St' };
const dbKaren: Contact = { kind: 'seller', id: 11, name: 'Karen Daniels', email: null, phone: '2105550100', sub: '12 Oak St' };
const buyerSameNumber: Contact = { kind: 'buyer', id: 4, name: 'Karen Daniels', email: null, phone: '+1 210 555 0100', sub: 'KD Homes' };
const lender: Contact = { kind: 'vendor', id: 31, name: 'Rita Lowe', email: null, phone: '210-555-0300', sub: 'Lone Star Lending · Lender', trade: 'Lender' };
const noPhone: Contact = { kind: 'buyer', id: 5, name: 'Karen Holt', email: 'kh@fund.co', phone: null, sub: null };
const teammate: Contact = { kind: 'team', id: 'u-1', name: 'Karen Ops', email: null, phone: null, sub: 'COO' };

assert.equal(isNameQuery('karen'), true);
assert.equal(isNameQuery('(210) 555-01'), false);
assert.equal(isNameQuery('+44 20'), false);

// Loaded first; the database's copy of the same seller collapses; no number, no row.
assert.deepEqual(
  mergeDialMatches([localKaren], [dbKaren, buyerSameNumber, noPhone, teammate, lender]).map((c) => `${c.kind}:${c.id}`),
  ['seller:p11', 'buyer:4', 'vendor:31'],
);
assert.equal(mergeDialMatches([], [lender, dbKaren], 1).length, 1);

// A typed number finds its owner, whatever the format; a partial number finds nobody.
assert.equal(whoseNumber('2105550300', [dbKaren, lender])?.id, 31);
assert.equal(whoseNumber('12105550100', [dbKaren])?.id, 11);
assert.equal(whoseNumber('210555', [dbKaren]), null);
assert.equal(whoseNumber('2105550999', [dbKaren]), null);

assert.equal(dialKindLabel(dbKaren), 'Seller');
assert.equal(dialKindLabel(buyerSameNumber), 'Buyer');
assert.equal(dialKindLabel(lender), 'Lender');
assert.equal(dialKindLabel({ ...lender, trade: null }), 'Vendor');

// Many loaded matches still leave room for the database's vendors.
const many: Contact[] = Array.from({ length: 8 }, (_, i) => ({ kind: 'seller', id: `p${i}`, name: `Karen ${i}`, email: null, phone: `21055501${10 + i}`, sub: null }));
const merged = mergeDialMatches(many, [lender]);
assert.equal(merged.length, 8);
assert.ok(merged.some((c) => c.kind === 'vendor'), 'a vendor makes the list');
assert.equal(mergeDialMatches(many, []).length, 8, 'with nothing from the database, loaded rows fill the list');

// Deal parties and Talkr contacts.
assert.equal(partyTrade('lender'), 'Lender');
assert.equal(partyTrade('buyers_agent'), "Buyer's agent");
assert.equal(partyTrade('something_new'), 'Deal contact');
const tc = {
  id: 'c1', display_name: 'Sam Ortiz', type: 'title', company: 'Alamo Title', primary_phone: '+12105550400',
  phones: [{ id: 'p2', phone_e164: '+12105550401', label: 'Office', is_primary: false }, { id: 'p1', phone_e164: '+12105550400', label: null, is_primary: true }],
} as unknown as ContactDto;
const rows = talkrContact(tc);
assert.deepEqual(rows.map((r) => r.phone), ['+12105550400', '+12105550401'], 'primary first, every number');
assert.equal(dialKindLabel(rows[0]), 'Title');
assert.equal(rows[1].sub, 'Office number · Alamo Title');
assert.equal(talkrContact({ ...tc, type: 'seller' } as ContactDto)[0].kind, 'seller');
assert.deepEqual(talkrContact({ ...tc, phones: [], primary_phone: null } as unknown as ContactDto), []);

console.log('dial-lookup: ok');
