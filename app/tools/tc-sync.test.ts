// Checklist ↔ task matching and sent-doc stage rules.
// Run with:  npx tsx tools/tc-sync.test.ts
import { teamTc } from '../lib/team';
import {
  checklistIdForTitle, checklistItemById, normTcTitle,
  offerWriteMovesStage, sellerMayAdvance, sentDocStages, submissionMovesToOfferMade,
} from '../lib/tc-sync';

let failed = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
};

check(normTcTitle('  Send EMD  ') === 'send emd', 'title normalisation');
check(!!checklistItemById('a11')?.t.toLowerCase().includes('emd'), 'catalog has EMD line');
check(checklistIdForTitle('Send EMD to title; confirm wire/check receipt in writing') === 'a11', 'exact title maps to a11');
check(checklistIdForTitle('Send EMD to title; confirm wire/check receipt in writing extra') === 'a11', 'prefixed title still maps');
check(checklistIdForTitle('totally unrelated task') === null, 'unknown title does not invent a line');

check(sentDocStages('offer')?.seller === 'Offer Made', 'sending an offer → Offer Made');
check(!offerWriteMovesStage('INSERT', 'Draft'), 'a draft offer letter does not move the stage');
check(!offerWriteMovesStage('INSERT', ' draft '), 'draft status is matched ignoring case and space');
check(offerWriteMovesStage('INSERT', 'Sent'), 'a sent insert still moves the stage');
check(offerWriteMovesStage('INSERT', null), 'a missing status on insert still moves the stage');
check(offerWriteMovesStage('UPDATE', 'Sent', 'Draft'), 'marking a draft sent moves the submission');
check(offerWriteMovesStage('UPDATE', 'Sent', ' draft '), 'leaving draft ignores case');
check(!offerWriteMovesStage('UPDATE', 'Sent', 'Sent'), 'a second sent write does not move again');
check(!offerWriteMovesStage('UPDATE', 'Draft', 'Draft'), 'editing a draft does not move the stage');
check(!offerWriteMovesStage('UPDATE', 'Accepted', 'Sent'), 'accepting a sent offer does not move it to Offer Made again');
check(submissionMovesToOfferMade('Underwriting'), 'underwriting submissions move to Offer Made when the offer is sent');
check(submissionMovesToOfferMade('Underwrite Declined'), 'a declined submission reopens to Offer Made when the offer is sent');
check(!submissionMovesToOfferMade('Offer Accepted'), 'an accepted submission stays');
check(!submissionMovesToOfferMade(null), 'a deal with no submission stage is not moved');
check(sentDocStages('addendum')?.ping === 'Addendum sent', 'addendum pings, no forced stage');
check(sentDocStages('termination')?.deal === 'Terminated', 'cancellation terminates the deal');
check(sellerMayAdvance('Make Offer', 'Offer Made'), 'Make Offer may advance to Offer Made');
check(!sellerMayAdvance('Under Contract - Seller', 'Offer Made'), 'does not walk an under-contract seller back');
check(!sellerMayAdvance('Closed', 'Terminated'), 'does not terminate a closed file');

const roster = {
  w: { id: 'w', name: 'Casey Park', role: 'Transaction coordinator', dept: 'TC' },
  a: { id: 'a', name: 'Alex Acq', role: 'Acquisitions', dept: 'Acquisitions' },
};
check(teamTc(roster)?.name === 'Casey Park', 'teamTc picks the TC role, not a hardcoded name');
check(teamTc({ a: roster.a }) === null, 'no TC on the roster → null, never Robin');

if (failed) {
  console.log(failed + ' failed');
  process.exit(1);
}
console.log('ok');
