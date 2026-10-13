// Pipeline section reminders. Run: npx tsx tools/section-gaps.test.ts
import { sectionGaps, soldToEndBuyer, underContractBlanks, type GapDeal, type GapFacts, type SheetFacts } from '../lib/section-gaps';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n  got ${JSON.stringify(got)}\n  exp ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const full: GapFacts = {
  earnest: 1000, condition: 'dated', occupancy: 'vacant',
  dispoRep: 'dispo', tcRep: 'tc',
  titleVendor: true, titleContact: 'Courtney', titleEmail: 'c@title.com', titlePhone: '555',
  marketingStarted: '2026-09-01',
};
const empty: GapFacts = {
  earnest: null, condition: null, occupancy: null,
  dispoRep: null, tcRep: null,
  titleVendor: false, titleContact: null, titleEmail: null, titlePhone: null,
  marketingStarted: null,
};

const deal = (over: Partial<GapDeal>): GapDeal => ({
  id: 'd1', personId: 's1', stage: 'Under Contract Seller', addr: '912 Cordial Rd',
  owner: 'acq', contract: 100000, arv: 180000, rehab: 0, close: 'Oct 20',
  optionEndsOn: '2026-10-10', underwritingUrl: 'https://docs', buyerId: undefined,
  tracker: { contractDate: '2026-09-23', dispoPrice: null },
  facts: full,
  ...over,
});

eq('a filled acquisitions deal has no acquisitions reminder', sectionGaps([deal({})], 'acq', false).map((g) => g.cat), []);
eq('not sold, so dispo is quiet', soldToEndBuyer(deal({})), false);
eq('buyer under contract counts as sold', soldToEndBuyer(deal({ stage: 'Buyer Under Contract' })), true);
eq('a sold price counts as sold', soldToEndBuyer(deal({ tracker: { contractDate: '2026-09-23', dispoPrice: 140000 } })), true);

const blank = deal({ facts: empty, owner: 'acq', contract: null, arv: null, rehab: null, close: null, optionEndsOn: null, underwritingUrl: null, tracker: { contractDate: null, dispoPrice: null } });
eq('the assigned acquisitions rep hears the blanks', sectionGaps([blank], 'acq', false).map((g) => g.cat), ['Acquisitions']);
eq('a TC section with nobody on it goes to the owner', sectionGaps([blank], 'owner', true).map((g) => g.cat), ['Coordination']);
eq('a teammate does not hear someone else\'s acquisitions blanks', sectionGaps([blank], 'other', false).map((g) => g.cat), []);
eq('ready to market with no buyer does not hammer dispo', sectionGaps([deal({ stage: 'Ready To Market', facts: empty, owner: 'acq' })], 'acq', false).some((g) => g.cat === 'Dispositions'), false);

const sold = deal({
  stage: 'In Escrow', buyerId: 'b1',
  tracker: { contractDate: '2026-09-23', dispoPrice: null },
  facts: { ...full, dispoRep: 'dispo', marketingStarted: null },
  buyerOptionEndsOn: null,
});
eq('the dispo rep hears a sold deal with disposition blanks', sectionGaps([sold], 'dispo', false).filter((g) => g.cat === 'Dispositions').map((g) => g.missing), [['sold price', 'buyer option', 'marketing started']]);
eq('the acquisitions rep is not hammered for dispo', sectionGaps([sold], 'acq', false).some((g) => g.cat === 'Dispositions'), false);

const naked = deal({ owner: null, facts: { ...empty } });
eq('an owner sees a section with nobody assigned', sectionGaps([naked], 'owner', true).map((g) => g.cat), ['Acquisitions', 'Coordination']);
eq('a closed deal is off the live board', sectionGaps([deal({ stage: 'Closed', facts: empty, owner: 'acq' })], 'acq', false), []);
eq('an archived deal stays quiet', sectionGaps([deal({ archived: true, facts: empty, owner: 'acq' })], 'acq', false), []);
eq('the sample graph has no facts and no reminders', sectionGaps([deal({ facts: undefined })], 'acq', true), []);

// Under contract: the deal sheet's prompt (deal type at the top, then Acquisition).
const sheet: SheetFacts = {
  transaction_type: 'Assignment', owner_id: 'acq', offer_amount: 85000, arv: 142747, rehab: 35000, earnest_money: 1000,
  contract_date: '2026-10-08', option_ends_on: '2026-10-18', close_date: '2026-11-07',
  underwriting_url: 'https://docs', condition_notes: 'boarded window', occupancy_notes: 'vacant',
};
eq('a filled sheet needs nothing', underContractBlanks(sheet), []);
eq('a fresh submission sheet lists the deal type first', underContractBlanks({ ...sheet, transaction_type: null, offer_amount: null, earnest_money: null }), ['deal type', 'under contract price', 'earnest money']);
eq('a zero rehab is filled in, a zero price is not', underContractBlanks({ ...sheet, rehab: 0, offer_amount: 0 }), ['under contract price']);

if (failed) {
  console.error(`section-gaps: ${failed} failed`);
  process.exit(1);
}
console.log('section-gaps: ok');
