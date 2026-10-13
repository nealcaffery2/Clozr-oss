// lib/stages.ts: the stage lists every picker reads.
// Run with:  npx tsx tools/stages.test.ts
import {
  DEAL_STAGE_OPTIONS, LEAD_STAGE_GROUPS, LEGACY_LEAD_STAGES, SELLER_STAGE_LABELS, leadStageGroup, leadStagePicks,
} from '../lib/stages';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

// deal_stages, in the table's order.
check('deal stages match deal_stages', JSON.stringify(DEAL_STAGE_OPTIONS) === JSON.stringify([
  'Prospect', 'Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow', 'Closed', 'Terminated', 'Realtor Referral',
]), DEAL_STAGE_OPTIONS);

// Every distinct sellers.lead_stage value on the live project (read 2026-10-09).
const LIVE = [
  'Lead - No Contact', 'Lead', 'Buyer', 'Refund - Wrong Info', 'Asking Retail / Not Motivated', 'Unresponsive', 'Offer Made', 'Dead',
  'Refund - Wrong Info / Other', 'Contacted - Follow Up Needed', 'Sold Elsewhere', 'Offer Declined', 'Nurture - Long Term (3+ Months)',
  'New Submission', 'Listed on MLS - Dead', 'Lead - No Contact (Long Term)', 'Negative Equity', 'Terminated', 'Not Selling',
  'Offer Made - Retail', 'Offer Made - Follow Up', 'Closed', 'Dead - Wrong Info', 'Land', 'Underwrite Declined', 'Make Offer',
  'Under Contract - Seller', 'Appointment Set', 'Referred to Realtor', 'Bad Location', 'Ghosted', 'Refund - Not Selling',
  'Under Contract - Buyer', 'Underwriting - Need Info', 'Wholesaler', 'Self Generated', 'Terminated - Price Drop', 'Appointment Missed',
  'Memo Filed / Legal', 'Underwriting Complete', 'Duplicate Lead', 'Underwriting', 'Realtor', 'Buyer Prospect',
  'Under Contract with Other Investor', 'Pending Response', 'Contract Sent to Seller',
];
const grouped = new Set(LEAD_STAGE_GROUPS.flatMap((g) => g.stages));
check('every live value is in a group', LIVE.every((l) => grouped.has(l)), LIVE.filter((l) => !grouped.has(l)));
check('every seller_stages label is in exactly one group', SELLER_STAGE_LABELS.every((l) => LEAD_STAGE_GROUPS.filter((g) => g.stages.includes(l)).length === 1));
check('groups cover the whole table', grouped.size === SELLER_STAGE_LABELS.length, grouped.size);
check('legacy values are not picks', LEAD_STAGE_GROUPS.every((g) => g.picks.every((p) => !LEGACY_LEAD_STAGES.has(p))));
check('legacy values are real labels', [...LEGACY_LEAD_STAGES].every((l) => SELLER_STAGE_LABELS.includes(l)));

check('Lead is Active', leadStageGroup('Lead') === 'Active');
check('Appointment Set is Active', leadStageGroup('Appointment Set') === 'Active');
check('Nurture long term is Nurture', leadStageGroup('Nurture - Long Term (3+ Months)') === 'Nurture');
check('Offer Made is Offer', leadStageGroup('Offer Made') === 'Offer');
check('Closed is Contract', leadStageGroup('Closed') === 'Contract');
check('Ghosted is Dead', leadStageGroup('Ghosted') === 'Dead');
check('Refund - Listed is Refund', leadStageGroup('Refund - Listed') === 'Refund');
check('Realtor is Other', leadStageGroup('Referred to Realtor') === 'Other');
check('unknown is Other', leadStageGroup('Something old') === 'Other');
check('null is Other', leadStageGroup(null) === 'Other');

const withLegacy = leadStagePicks('Realtor');
check('a record on a legacy stage still sees it', withLegacy.find((g) => g.group === 'Other')!.stages[0] === 'Realtor');
const plain = leadStagePicks('Lead');
check('a normal stage is not duplicated', plain.find((g) => g.group === 'Active')!.stages.filter((s) => s === 'Lead').length === 1);
const unknown = leadStagePicks('Old import value');
check('an unknown stage shows under Other', unknown.find((g) => g.group === 'Other')!.stages[0] === 'Old import value');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
