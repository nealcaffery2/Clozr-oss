// Request contract from the dialer: auto-fill, the TC pick, the payload.
// Run: npx tsx tools/contract-request.test.ts
import {
  type RequestContext, type RequestRecord, addressLine, autofillRequest, pickBuyerDeal, withDeal, buildRequestPayload, callStillLive, closingDateFrom, kindFor, priceSource,
  requestLine, requestProblems, requestSummary, requestTitle, requestTokens, streetOf, tcFirstNames, tcRecipients,
} from '../lib/contract-request';
import { notifLink } from '../lib/notif-target';
import { slopFindings } from '../supabase/functions/_shared/no-ai-slop';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const today = new Date(2026, 9, 14); // Oct 14, 2026
const kara: RequestRecord = {
  side: 'seller', sellerId: 41, buyerId: null, dealId: 9, name: 'Kara Mitchell', phone: '(210) 555-0136', email: 'kara.mitchell@gmail.com',
  address: '123 Oakview Drive, San Antonio, TX 78254', offer: null, mao: 152400, asking: 235000, desiredClose: '30 days',
};
const ctx = (o: Partial<RequestContext> = {}): RequestContext => ({
  record: kara, callId: 'call_77', requesterId: 'u-taylor', requesterName: 'Taylor Reed',
  transcript: [
    { who: 'Taylor', text: 'Is now still good?' }, { who: 'Kara', text: 'Yes. We need to be out before September 30th.' },
    { who: 'Taylor', text: 'Understood.' }, { who: 'Kara', text: 'Certainty matters more than price…' },
  ],
  summary: null, demo: false, ...o,
});

// ---- auto-fill -------------------------------------------------------------
const f = autofillRequest(ctx(), today);
eq('a seller on the line gets a purchase agreement', f.kind, 'psa');
eq('a buyer on the line gets an assignment', kindFor('buyer'), 'assignment');
eq('the party fills from the record', [f.partyName, f.partyPhone, f.partyEmail], ['Kara Mitchell', '(210) 555-0136', 'kara.mitchell@gmail.com']);
eq('the address fills from the record', f.address, '123 Oakview Drive, San Antonio, TX 78254');
eq('no offer: the price is the MAO', f.price, '152,400');
eq('the offer wins over the MAO', autofillRequest(ctx({ record: { ...kara, offer: 181000 } }), today).price, '181,000');
eq('price source names the MAO', priceSource(kara), 'From the MAO');
eq('price source names the offer', priceSource({ ...kara, offer: 1 }), 'From the offer on the deal');
eq('"30 days" becomes a date 30 days out', f.closingDate, '2026-11-13');
eq('"Sept 30" already past rolls to next year', closingDateFrom('Sept 30', today), '2027-09-30');
eq('"Before Nov 20" reads the date', closingDateFrom('Before Nov 20', today), '2026-11-20');
eq('a vague timeline is no date', closingDateFrom('Flexible', today), '');
eq('no record: an empty form', [autofillRequest(ctx({ record: null }), today).partyName, autofillRequest(ctx({ record: null }), today).price], ['', '']);

// ---- the call so far --------------------------------------------------------
eq('no summary: the last lines of the transcript, as said', f.summary,
  'Taylor: Is now still good?\nKara: Yes. We need to be out before September 30th.\nTaylor: Understood.\nKara: Certainty matters more than price');
eq('a summary wins over the transcript', requestSummary('Seller wants a Sept 30 close.', ctx().transcript), 'Seller wants a Sept 30 close.');
eq('"Summarising the call…" is not a summary', requestSummary('Summarising the call…', [{ who: 'A', text: 'b' }]), 'A: b');
eq('only the last n lines', requestSummary(null, ctx().transcript, 1), 'Kara: Certainty matters more than price');
eq('the request summary reads clean (no-ai-slop)', slopFindings(f.summary).map((x) => x.pattern), []);

// ---- who hears about it -----------------------------------------------------
const team = [
  { id: 'u-sam', name: 'Sam Carter', memberRole: 'owner' },
  { id: 'u-taylor', name: 'Taylor Reed', memberRole: 'acquisitions' },
  { id: 'u-casey', name: 'Casey Park', memberRole: 'tc' },
  { id: 'u-avery', name: 'Avery Nguyen', memberRole: 'tc' },
];
eq('every TC member', tcRecipients(team, 'u-taylor').map((m) => m.id), ['u-casey', 'u-avery']);
eq('never the person asking', tcRecipients(team, 'u-avery').map((m) => m.id), ['u-casey']);
const noTc = [{ id: 'u-sam', name: 'Sam Carter', memberRole: 'owner' }, { id: 'u-w', name: 'Casey Park', memberRole: 'member' }, { id: 'u-n', name: 'Taylor Reed', memberRole: 'acquisitions' }];
eq('no TC role: the teammate named Casey', tcRecipients(noTc, 'u-n').map((m) => m.id), ['u-w']);
eq('neither: the owner', tcRecipients([noTc[0], noTc[2]], 'u-n').map((m) => m.id), ['u-sam']);
eq('the sample team: TC by department', tcRecipients([{ id: 'taylor', name: 'Taylor Reed', role: 'Acquisitions', dept: 'Acquisitions' }, { id: 'casey', name: 'Casey Park', role: 'Transaction Coordinator', dept: 'TC' }], 'taylor').map((m) => m.id), ['casey']);
eq('names in the popup', [tcFirstNames([{ name: 'Casey Park' }]), tcFirstNames([{ name: 'Casey Park' }, { name: 'Avery Nguyen' }]), tcFirstNames([])], ['Casey', 'Casey or Avery', 'the TC']);

// ---- title, tokens, payload ---------------------------------------------------
eq('the alert headline', requestTitle('Morgan Lane', '151 Juniper Trl, San Antonio, TX 78254'), 'Contract request from Morgan · 151 Juniper Trl');
eq('no address: the party', requestTitle('Morgan Lane', '', 'Harbor Capital'), 'Contract request from Morgan · Harbor Capital');
eq('street of an address', streetOf('151 Juniper Trl, San Antonio, TX'), '151 Juniper Trl');
const typed = { ...f, emd: '1k', notes: '  Co-heir brother signs too.  ', terms: { 'Trec.OptionDays': '7', 'Fill.Blank': ' ' } };
eq('tokens: price, EMD, close, typed terms; the unchanged address stays the record’s', requestTokens(typed, kara.address), [
  { name: 'Deal.PurchasePrice', value: '$152,400' }, { name: 'Trec.SalesPrice', value: '$152,400' }, { name: 'Offer.Amount', value: '$152,400' },
  { name: 'Deal.EMD', value: '$1,000' }, { name: 'Trec.EarnestMoney', value: '$1,000' }, { name: 'Offer.EMD', value: '$1,000' },
  { name: 'Deal.ClosingDate', value: 'November 13, 2026' }, { name: 'Trec.ClosingDate', value: 'November 13, 2026' },
  { name: 'Trec.OptionDays', value: '7' },
]);
eq('an assignment fills the assignment price and buyer EMD', requestTokens({ ...typed, kind: 'assignment', terms: {} }, kara.address).map((t) => t.name).slice(0, 2), ['Deal.AssignmentPrice', 'Deal.BuyerEMD']);
eq('a changed address goes in', requestTokens({ ...f, address: '151 Juniper Trl, San Antonio, TX', price: '', closingDate: '' }, kara.address), [{ name: 'Property.FullAddress', value: '151 Juniper Trl, San Antonio, TX' }]);
const p = buildRequestPayload(typed, ctx(), { contractId: 512, sellerId: 41, buyerId: null, dealId: 9 });
eq('payload: numbers, dates and trimmed text', [p.price, p.emd, p.closing_date, p.notes, p.terms], [152400, 1000, '2026-11-13', 'Co-heir brother signs too.', { 'Trec.OptionDays': '7' }]);
eq('payload: ids, call and who asked', [p.contract_id, p.seller_id, p.deal_id, p.call_id, p.requester_name, p.title], [512, 41, 9, 'call_77', 'Taylor Reed', 'Contract request from Taylor · 123 Oakview Drive']);
eq('payload: party email lower-cased', buildRequestPayload({ ...f, partyEmail: ' Kara@Gmail.com ' }, ctx(), { contractId: null, sellerId: null, buyerId: null, dealId: null }).party.email, 'kara@gmail.com');
eq('one line for the alert', requestLine(p), 'Kara Mitchell · $152,400 · close Nov 13');

// ---- checks before Send to TC -----------------------------------------------
eq('a filled form sends', requestProblems(f), []);
eq('no name, no address, a bad price', requestProblems({ ...f, partyName: '', address: '', price: 'abc' }), ['Add the seller’s name.', 'Add the property address.', 'Price: Enter a dollar amount, like 185,000 or 185k.']);
eq('a buyer needs no property address', requestProblems({ ...f, side: 'buyer', address: '' }), []);

// ---- Listen / Barge --------------------------------------------------------------
eq('the call is on the live list', callStillLive('call_77', [{ call_id: 'call_77' }]), 'live');
eq('the call has ended', callStillLive('call_77', [{ call_id: 'other' }]), 'ended');
eq('no calls.monitor in Talkr', callStillLive('call_77', null), 'no-access');
eq('no call on the request', callStillLive(null, []), 'none');

// ---- the bell ----------------------------------------------------------------------
const row = (o: { contract_id?: number | null; seller_id?: number | null }) => ({ category: 'Contract request', title: 'x', seller_id: o.seller_id ?? null, contract_id: o.contract_id ?? null });
eq('the bell opens the draft in Contracts', notifLink(row({ contract_id: 512, seller_id: 41 })), { screen: 'contracts', id: 'k512' });
eq('no draft yet: Contracts', notifLink(row({})), { screen: 'contracts', id: '' });

// ---- a number with no record ----------------------------------------------------
const unknown = autofillRequest(ctx({ record: null, caller: { name: '(210) 555-0199', phone: '+12105550199' } }), today);
eq('no record: the phone on the call fills in', unknown.partyPhone, '+12105550199');
eq('no record: a name that is only the number stays blank', unknown.partyName, '');
eq('no record: a name the dialer knows fills in', autofillRequest(ctx({ record: null, caller: { name: 'Dana Ruiz', phone: '+12105550199' } }), today).partyName, 'Dana Ruiz');
eq('a record wins over the caller', autofillRequest(ctx({ caller: { name: 'Dana Ruiz', phone: '+1999' } }), today).partyPhone, '(210) 555-0136');

// ---- a buyer's deals --------------------------------------------------------------
const rank = (d: { r: number }) => d.r;
const bd = [
  { id: 'd1', buyerId: 'b7', r: 1 }, { id: 'd2', buyerId: 'b7', r: 3 }, { id: 'd3', buyerId: 'b7', r: 9, archived: true },
  { id: 'd4', buyerId: 'b8', r: 10 }, { id: 'd5', buyerId: 'b7', r: 2 },
];
eq('the deal the call is about wins', pickBuyerDeal(bd, 'b7', 'd5', rank).deal?.id, 'd5');
eq('else the best live deal, not the first', pickBuyerDeal(bd, 'b7', null, rank).deal?.id, 'd2');
eq('a call deal that is not theirs is ignored', pickBuyerDeal(bd, 'b7', 'd4', rank).deal?.id, 'd2');
eq('every live deal of theirs, best first, archived left out', pickBuyerDeal(bd, 'b7', null, rank).live.map((d) => d.id), ['d2', 'd5', 'd1']);
eq('no deals: none', pickBuyerDeal(bd, 'b9', null, rank).deal, undefined);
const buyerRec: RequestRecord = { ...kara, side: 'buyer', sellerId: null, buyerId: 7, dealId: 2, address: 'A', offer: 1, desiredClose: '' };
eq('a picked deal becomes the record the request reads', withDeal(buyerRec, { key: 'd5', dealId: 5, address: '9 Elm St, Austin, TX 78701', offer: 200000, desiredClose: '2026-12-01' }),
  { ...buyerRec, dealId: 5, address: '9 Elm St, Austin, TX 78701', offer: 200000, desiredClose: '2026-12-01' });

// ---- address line ----------------------------------------------------------------
eq('the buyer address keeps the ZIP', addressLine('151 Juniper Trl', 'San Antonio', 'TX', '78254'), '151 Juniper Trl, San Antonio, TX 78254');
eq('blanks and dashes are left out', addressLine('151 Juniper Trl', '', '—', '78254'), '151 Juniper Trl, 78254');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
