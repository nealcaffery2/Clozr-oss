// The role a contact picked onto a deal team starts with.
// Run with: npx tsx tools/deal-party-role.test.ts

import assert from 'node:assert/strict';
import { roleForContact } from '../lib/deal-parties';

assert.equal(roleForContact('seller'), 'seller');
assert.equal(roleForContact('buyer'), 'buyer');
assert.equal(roleForContact('vendor', 'Title Company'), 'title');
assert.equal(roleForContact('vendor', 'Title'), 'title');
assert.equal(roleForContact('vendor', 'Realtor'), 'listing_agent');
assert.equal(roleForContact('vendor', 'Novation Realtor'), 'listing_agent');
assert.equal(roleForContact('vendor', 'Wholesaler'), 'wholesaler');
assert.equal(roleForContact('vendor', 'Photographer/Notary'), 'photographer');
assert.equal(roleForContact('vendor', 'Hard Money Lender'), 'lender');
assert.equal(roleForContact('vendor', 'Transactional Funder'), 'transactional_funder');
assert.equal(roleForContact('vendor', 'Institutional seller'), 'seller');
assert.equal(roleForContact('vendor', 'Attorney'), 'attorney');
assert.equal(roleForContact('vendor', null), 'other');
assert.equal(roleForContact('team', 'tc'), 'tc');
assert.equal(roleForContact('team', 'dispositions'), 'dispositions');
assert.equal(roleForContact('team', 'admin'), 'acquisitions');
console.log('deal-party-role: ok');
