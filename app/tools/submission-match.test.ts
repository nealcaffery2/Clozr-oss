// Re-importing a partner's sheet matches the houses CLOZR already has (lib/submission-match).
// Run with: npx tsx tools/submission-match.test.ts

import assert from 'node:assert/strict';
import { addSubmission, indexSubmissions, matchSubmission, submissionCounts, type ExistingSubmission } from '../lib/submission-match';

// Offerpad's contact is seller 23; Mark Spain's is seller 40. Property 501 is 4410 Ridgecrest Dr.
const deals: ExistingSubmission[] = [
  { id: 900, sellerId: 23, propertyId: 501, sourceId: null, archived: false },
  { id: 901, sellerId: 23, propertyId: 502, sourceId: 'OP-77', archived: false },
  { id: 902, sellerId: 40, propertyId: 503, sourceId: null, archived: false },
  // A house the team archived: sent again, it is a new submission.
  { id: 903, sellerId: 23, propertyId: 504, sourceId: 'OP-80', archived: true },
];
const idx = indexSubmissions(deals);

// The same house from the same partner: that deal.
assert.deepEqual(matchSubmission(idx, { sellerId: 23, propertyId: 501, sourceId: null }), { id: 900, by: 'address' });
// The row's own id wins, even when the address on the sheet was spelled into another property.
assert.deepEqual(matchSubmission(idx, { sellerId: 23, propertyId: 999, sourceId: 'OP-77' }), { id: 901, by: 'record id' });
assert.deepEqual(matchSubmission(idx, { sellerId: 23, propertyId: null, sourceId: ' op-77 ' }), { id: 901, by: 'record id' });
// Another partner's house at the same address, or its row ids, are not this partner's.
assert.equal(matchSubmission(idx, { sellerId: 40, propertyId: 501, sourceId: null }), null);
assert.equal(matchSubmission(idx, { sellerId: 40, propertyId: 777, sourceId: 'OP-77' }), null);
// A new house, a house with no property yet, a partner not in CLOZR: new.
assert.equal(matchSubmission(idx, { sellerId: 23, propertyId: 600, sourceId: 'OP-99' }), null);
assert.equal(matchSubmission(idx, { sellerId: 23, propertyId: null, sourceId: null }), null);
assert.equal(matchSubmission(idx, { sellerId: null, propertyId: 501, sourceId: null }), null);
// Archived: not matched by house or by id.
assert.equal(matchSubmission(idx, { sellerId: 23, propertyId: 504, sourceId: null }), null);
assert.equal(matchSubmission(idx, { sellerId: 23, propertyId: 600, sourceId: 'OP-80' }), null);

// Two open deals on one house: the newest is the one being resent.
const twice = indexSubmissions([
  { id: 950, sellerId: 23, propertyId: 700, sourceId: null, archived: false },
  { id: 940, sellerId: 23, propertyId: 700, sourceId: null, archived: false },
]);
assert.equal(matchSubmission(twice, { sellerId: 23, propertyId: 700, sourceId: null })?.id, 950);

// A deal made earlier in the same import is found by a later row with the same house.
const run = indexSubmissions([]);
assert.equal(matchSubmission(run, { sellerId: 23, propertyId: 800, sourceId: null }), null);
addSubmission(run, { id: 960, sellerId: 23, propertyId: 800, sourceId: null, archived: false });
assert.equal(matchSubmission(run, { sellerId: 23, propertyId: 800, sourceId: null })?.id, 960);

assert.equal(submissionCounts(12, 38), '12 new, 38 already in CLOZR (updated)');
assert.equal(submissionCounts(1200, 0), '1,200 new, 0 already in CLOZR (updated)');

console.log('submission-match: all checks passed');
