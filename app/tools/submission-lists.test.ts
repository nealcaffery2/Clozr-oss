// People › Submissions counts deals by lead_stage, not sellers.
// Run with: npx tsx tools/submission-lists.test.ts

import assert from 'node:assert/strict';
import { clozrHeldStage, nativeSubmissionDeals, podioItemInList, podioRowStage, podioStageLabel, submissionListMatch } from '../lib/stages';

assert.equal(submissionListMatch('Offer Made', 'Offer Made'), true);
assert.equal(submissionListMatch('Offer Made', 'Offer Declined'), false);
assert.equal(submissionListMatch('New Submission', 'New Submissions'), true);
assert.equal(submissionListMatch('Underwriting', 'New Submissions'), true);
assert.equal(submissionListMatch('Offer Made', 'New Submissions'), false);
assert.equal(submissionListMatch('Offer Accepted', 'Total Submissions'), true);
assert.equal(submissionListMatch('Auction.com', 'Total Submissions'), true);
assert.equal(submissionListMatch(null, 'Total Submissions'), false);
assert.equal(submissionListMatch('New Submission', 'US'), false);
assert.equal(submissionListMatch('  Offer Declined  ', 'Offer Declined'), true);
// 405 Birchwood Ave: accepted, then Under Contract - Seller. On its own tab and on Total.
assert.equal(submissionListMatch('Under Contract - Seller', 'Under Contract - Seller'), true);
assert.equal(submissionListMatch('Under Contract - Seller', 'Offer Accepted'), false);
assert.equal(submissionListMatch('Under Contract - Seller', 'Total Submissions'), true);
assert.equal(podioStageLabel('under contract - seller'), 'Under Contract - Seller');
// Further along, a submission stays on Offer Accepted, as Podio kept it.
assert.equal(submissionListMatch('Under Contract - Buyer', 'Offer Accepted'), true);
assert.equal(submissionListMatch('Closed', 'Offer Accepted'), true);
assert.equal(submissionListMatch('Under Contract - Seller', 'Offer Made'), false);
assert.equal(submissionListMatch('Terminated', 'Total Submissions'), false);
// 404 N Magnolia St: accepted, then the contract was terminated. Not accepted or under contract any more.
assert.equal(submissionListMatch('Offer Accepted', 'Offer Accepted', 'Terminated'), false);
assert.equal(submissionListMatch('Under Contract - Seller', 'Under Contract - Seller', 'Terminated'), false);
assert.equal(submissionListMatch('Under Contract - Buyer', 'Offer Accepted', 'Realtor Referral'), false);
assert.equal(submissionListMatch('Offer Accepted', 'Total Submissions', 'Terminated'), true);
assert.equal(submissionListMatch('Offer Accepted', 'Offer Accepted', 'Ready To Market'), true);
assert.equal(submissionListMatch('Offer Declined', 'Offer Declined', 'Terminated'), true);

// Podio's own items (podio_items): every Podio Category label counts where Podio counts it.
assert.equal(podioStageLabel('offer made'), 'Offer Made');
assert.equal(podioStageLabel('  Underwriting  -  Need Info '), 'Underwriting - Need Info');
assert.equal(podioStageLabel('US'), 'US');
assert.equal(podioStageLabel(null), '');
assert.equal(podioStageLabel('Something New'), 'Something New');
assert.equal(podioItemInList('US', 'US'), true);
assert.equal(podioItemInList('US', 'New Submission'), false);
assert.equal(podioItemInList('Underwriting Complete', 'Underwriting Complete'), true);
assert.equal(podioItemInList('', 'Total Submissions'), true);
assert.equal(podioItemInList('Something New', 'Total Submissions'), true);
assert.equal(podioItemInList('New Submission', 'New Submissions'), true);
assert.equal(podioItemInList('Offer Made', 'New Submissions'), false);
// Podio's numbers from the user's screen add up the same way.
const podio = { 'New Submission': 16, 'Underwrite Declined': 405, 'Underwriting - Need Info': 129, 'Underwriting Complete': 3, 'Offer Made': 2508, 'Pending Response': 5, 'Offer Declined': 1384, 'Offer Accepted': 69, 'Auction.com': 1, US: 11 };
const items = Object.entries(podio).flatMap(([stage, n]) => Array.from({ length: n }, () => podioStageLabel(stage)));
assert.equal(items.filter((st) => podioItemInList(st, 'Total Submissions')).length, 4531);
for (const [stage, n] of Object.entries(podio)) assert.equal(items.filter((st) => podioItemInList(st, stage)).length, n, stage);
assert.equal(items.filter((st) => podioItemInList(st, 'New Submissions')).length, 16);

// A house moved in CLOZR leaves Podio's list: CLOZR never writes the move back to Podio.
// 1001 Green Acre: Podio (via the sync) set Underwrite Declined, then Chris moved it to Offer Declined.
assert.equal(clozrHeldStage('Offer Declined', 'Offer Declined'), 'Offer Declined');
const greenAcre = { itemId: 1, dealId: 'd1', stage: 'Underwrite Declined', createdOn: null, note: null, clozrStage: clozrHeldStage('Offer Declined', 'Offer Declined') };
assert.equal(podioRowStage(greenAcre), 'Offer Declined');
assert.equal(podioItemInList(podioRowStage(greenAcre), 'Underwrite Declined'), false);
assert.equal(podioItemInList(podioRowStage(greenAcre), 'Offer Declined'), true);
assert.equal(podioItemInList(podioRowStage(greenAcre), 'Total Submissions'), true);
// Podio changed the stage after the person's move (the sync moved the deal on): Podio's again.
assert.equal(clozrHeldStage('Offer Made', 'Offer Declined'), null);
// Never moved by a person: Podio's stage, so resubmissions keep Podio's own counts.
assert.equal(clozrHeldStage('Offer Made', null), null);
assert.equal(clozrHeldStage(null, 'Offer Made'), null);
assert.equal(podioRowStage({ ...greenAcre, clozrStage: null }), 'Underwrite Declined');
// A move made this session shows before the save lands.
assert.equal(podioRowStage({ ...greenAcre, clozrStage: null }, 'Offer Accepted'), 'Offer Accepted');
assert.equal(podioRowStage(greenAcre, 'Offer Accepted'), 'Offer Accepted');
// CLOZR's spelling is put in Podio's list label.
assert.equal(clozrHeldStage('offer  declined', 'offer  declined'), 'Offer Declined');

// A vendor sheet writes deals Podio has no item for. They belong on the same lists.
const podioDeals = new Set(['d1']);
const sheet = [
  { id: 'd1', leadStage: 'New Submission', archived: false },
  { id: 'd2', leadStage: 'New Submission', archived: false },
  { id: 'd3', leadStage: 'Offer Made', archived: false },
  { id: 'd4', leadStage: 'New Submission', archived: true },
  { id: 'd5', leadStage: 'Lead', archived: false },
];
assert.deepEqual(nativeSubmissionDeals(sheet, podioDeals, 'New Submissions').map((d) => d.id), ['d2']);
assert.deepEqual(nativeSubmissionDeals(sheet, podioDeals, 'Total Submissions').map((d) => d.id), ['d2', 'd3']);
assert.deepEqual(nativeSubmissionDeals(sheet, podioDeals, 'Offer Made').map((d) => d.id), ['d3']);

console.log('submission-lists ok');
