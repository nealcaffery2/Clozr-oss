// Vendors attached as sellers on a deal show on the submission and do not replace the seller.
// Run with: npx tsx tools/vendor-sellers.test.ts

import assert from 'node:assert/strict';
import { submissionIdentity, submissionOpenTarget, vendorSellersByDeal } from '../lib/vendor-sellers';

const vendors = [
  { id: 9, business_name: 'Offerpad', contact_name: 'Pat Offer', email: 'pat@offerpad.test', phone: '5551112222' },
  { id: 4, business_name: 'Mark Spain', contact_name: null, email: null, phone: null },
];

const byDeal = vendorSellersByDeal([
  { deal_id: 12, vendor_id: 9, role: 'seller', name: null, company: null, email: null, phone: null },
  { deal_id: 12, vendor_id: 9, role: 'seller', name: 'Pat Offer', company: 'Offerpad', email: null, phone: null },
  { deal_id: 12, vendor_id: 4, role: 'seller', name: null, company: null, email: 'spain@mark.test', phone: '5550001111' },
  { deal_id: 12, vendor_id: 3, role: 'wholesaler', name: 'Not a seller', company: 'Wholesaler Co', email: null, phone: null },
  { deal_id: 8, vendor_id: null, role: 'seller', name: 'Homeowner', company: null, email: null, phone: null },
], vendors);

const on12 = byDeal.get(12) ?? [];
assert.equal(on12.length, 2, 'one row per vendor, wholesaler and a seller with no vendor stay off');
assert.equal(on12[0].id, 'v9');
assert.equal(on12[0].name, 'Pat Offer');
assert.equal(on12[0].company, 'Offerpad');
assert.equal(on12[0].phone, '5551112222');
assert.equal(on12[1].name, 'Mark Spain');
assert.equal(on12[1].email, 'spain@mark.test');
assert.equal(byDeal.has(8), false);

const kept = submissionIdentity(
  { name: 'Jane Homeowner', phone: '5553334444', email: 'jane@home.test' },
  on12,
  '10 Oak St',
);
assert.equal(kept.name, 'Jane Homeowner');
assert.equal(kept.phone, '5553334444');
assert.equal(kept.email, 'jane@home.test');
assert.deepEqual(kept.vendorLabels, ['Pat Offer · Offerpad', 'Mark Spain']);

const filled = submissionIdentity({ name: 'No name', phone: '—', email: '' }, on12, '10 Oak St');
assert.equal(filled.name, 'Pat Offer');
assert.equal(filled.phone, '5551112222');
assert.equal(filled.email, 'pat@offerpad.test');
assert.deepEqual(filled.vendorLabels, ['Mark Spain'], 'the vendor used as the name is not listed twice');

const addrOnly = submissionIdentity(undefined, [], '10 Oak St');
assert.equal(addrOnly.name, '10 Oak St');
assert.equal(addrOnly.phone, '—');
assert.deepEqual(addrOnly.vendorLabels, []);

assert.equal(submissionOpenTarget('s3', true), 'person');
assert.equal(submissionOpenTarget('s3', false), 'sheet');
assert.equal(submissionOpenTarget('', false), 'sheet');

console.log('vendor-sellers.test.ts ok');
