// Genius discovery methods: labels, the deed-chain double close, the grantee
// ranking, the Homefull fold-in, and the assignment parser against the three
// contract shapes the Dispositions Drive holds (the fixtures keep the forms'
// layout; the people, emails and phones on them are made up).
//
//   npx tsx tools/genius-methods.test.ts

import type { Candidate, Hit, Purchase } from '../supabase/functions/_shared/genius-core';
import {
  type DeedTransaction, type Labelled, applyHomefull, detectDoubleClose, entityKey, familyOf, granteeCandidate, headline, homefullTargets, isConveyance,
  label, landlords, legOf, parseAssignmentText, parseMethods, parsePublicSearch, rankGrantees, reverseLlc, saleRows, sameHouse, snipeTargets, snipedBuyer, splitProperty,
} from '../supabase/functions/_shared/genius-methods';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const purchase = (over: Partial<Purchase>): Purchase => ({
  reapi_id: 'p1', role: 'hold', address: '12 Oak St', city: 'San Antonio', state: 'TX', zip: '78210', lat: 29.4, lng: -98.47, distance_mi: 0.4,
  property_type: 'SFR', beds: 3, baths: 2, sqft: 1200, year_built: 1960, price: 150000, price_source: 'recorded', non_disclosure: false, date: '2026-03-01',
  resale_price: null, resale_date: null, days_held: null, financed: null, est_value: 200000, pct_of_arv: 68, price_per_sqft: 125, agent: null, zillow: '', ...over,
});
const cand = (over: Partial<Candidate>): Labelled => ({
  key: 'k', owner_name: 'Oak Holdings LLC', people: [], kind: 'flipper', corporate: true, institutional: false, absentee: true, mailing: null, mail_parts: null,
  purchases: [purchase({})], purchase_count: 1, flips: 0, holds: 1, builds: 0, last_purchase: '2026-03-01', nearest_mi: 0.4, lat: 29.4, lng: -98.47,
  avg_price: 150000, min_price: 150000, max_price: 150000, avg_ppsf: 125, avg_days_held: null, cash: true, non_disclosure: false,
  portfolio_count: 4, portfolio_value: 800000, likelihood: 60, smart_match: false, smart_rank: null, pct_of_arv: 68, reasons: [],
  matched_buyer_id: null, match_by: null, contacts: null, contacts_at: null, ...over,
});

// ---- methods and labels ----
eq('parseMethods keeps known run methods once, in order', parseMethods(['homefull', 'bogus', 'wholesale_snipe', 'homefull', 'genius']), ['homefull', 'wholesale_snipe']);
eq('parseMethods reads a comma list', parseMethods('landlord,reverse_llc'), ['landlord', 'reverse_llc']);
{
  const c = label(label(cand({}), { method: 'reverse_llc', summary: 'cash LLC' }), { method: 'homefull', summary: 'flip ok' });
  eq('label keeps the first method as the headline and lists both', [c.method, c.methods], ['reverse_llc', ['reverse_llc', 'homefull']]);
  eq('headline prefers the stronger proof', headline(c)?.method, 'homefull');
}

// ---- reverse LLC ----
{
  const [hit] = reverseLlc([cand({})]);
  check('cash LLC with a portfolio is Reverse LLC', hit.methods?.includes('reverse_llc') === true, hit.evidence?.[0]?.summary);
  const [one] = reverseLlc([cand({ portfolio_count: 1, purchase_count: 1 })]);
  check('one-house LLC is not', !one.methods);
  const [person] = reverseLlc([cand({ corporate: false, owner_name: 'Ann Lee' })]);
  check('a person is not Reverse LLC', !person.methods);
  const [financed] = reverseLlc([cand({ cash: false, purchases: [purchase({ financed: true })] })]);
  check('a financed LLC is not', !financed.methods);
}

// ---- landlord ----
{
  const hits = new Map<string, Hit>([['p1', { rented_after_purchase: true } as Hit]]);
  const [l] = landlords([cand({ kind: 'landlord' })], hits);
  check('a hold listed for rent after purchase is a Landlord', l.methods?.includes('landlord') === true && (l.evidence?.[0]?.confidence ?? 0) >= 0.9, l.evidence?.[0]?.summary);
  const [weak] = landlords([cand({ kind: 'landlord', purchases: [purchase({}), purchase({ reapi_id: 'p2' })] })], new Map());
  check('two absentee holds is a weaker Landlord', weak.methods?.includes('landlord') === true && (weak.evidence?.[0]?.confidence ?? 1) < 0.9);
  const [flipper] = landlords([cand({ kind: 'flipper' })], hits);
  check('a flipper is never labelled Landlord', !flipper.methods);
}

// ---- Homefull ----
{
  const flip = cand({ key: 'f', purchases: [purchase({ reapi_id: 'h1', role: 'flip', price: 100000, resale_price: 140000, resale_date: '2026-06-01', days_held: 90 })], flips: 1, holds: 0, likelihood: 50 });
  const hold = cand({ key: 'h' });
  const targets = homefullTargets([hold, flip]);
  eq('only completed flips are photo-check targets', targets.map((t) => [t.key, t.reapi_id]), [['f', 'h1']]);
  const yes = applyHomefull([flip, hold], new Map([['h1', { renovated: true, confidence: 0.9, signals: ['new kitchen', 'new floors'], photos: 6, source: 'zillow' }]]), targets);
  check('a confirmed renovation labels the flipper Homefull and lifts them', yes[0].methods?.includes('homefull') === true && yes[0].likelihood === 60, yes[0].evidence?.[0]?.summary);
  check('the summary names the margin', /resold \+40%/.test(yes[0].evidence?.[0]?.summary ?? ''), yes[0].evidence?.[0]?.summary);
  const no = applyHomefull([flip], new Map([['h1', { renovated: false, confidence: 0.8, signals: [], photos: 4, source: 'zillow' }]]), targets);
  check('a flip the photos deny loses a little and gets no label', !no[0].methods && no[0].likelihood === 42);
  const unknown = applyHomefull([flip], new Map(), targets);
  check('no verdict changes nothing', !unknown[0].methods && unknown[0].likelihood === 50);
}

// ---- the deed chain ----
{
  const rows = saleRows([
    { saleDate: '2026-04-02', saleAmount: 215000, buyerNames: 'Rivera Capital LLC', sellerNames: 'Goldline Investments LLC', documentType: 'Warranty Deed' },
    { saleDate: '2026-04-01', saleAmount: 170000, buyerNames: 'Goldline Investments LLC', sellerNames: 'Garcia, Jose', documentType: 'Warranty Deed' },
    { saleDate: '2015-05-10', saleAmount: 90000, buyerNames: 'Garcia, Jose', sellerNames: 'Smith, Ann' },
  ]);
  eq('saleRows sorts newest first and reads names', rows.map((r) => [r.date, r.buyer]), [['2026-04-02', 'Rivera Capital LLC'], ['2026-04-01', 'Goldline Investments LLC'], ['2015-05-10', 'Jose Garcia']]);
  const dc = detectDoubleClose(rows);
  check('a next-day resale with a markup is a double close', !!dc && dc.wholesaler === 'Goldline Investments LLC' && dc.end_buyer === 'Rivera Capital LLC' && dc.gap_days === 1 && dc.spread === 45000, dc);
  check('the original seller rides along', dc?.seller === 'Jose Garcia');
  const loss = detectDoubleClose(saleRows([
    { saleDate: '2026-04-02', saleAmount: 150000, buyerNames: 'Rivera Capital LLC', sellerNames: 'Goldline Investments LLC' },
    { saleDate: '2026-04-01', saleAmount: 170000, buyerNames: 'Goldline Investments LLC', sellerNames: 'Garcia, Jose' },
  ]));
  check('a resale at a loss is not a snipe', loss === null);
  const slow = detectDoubleClose(saleRows([
    { saleDate: '2026-08-02', saleAmount: 250000, buyerNames: 'Rivera Capital LLC', sellerNames: 'Fixer LLC' },
    { saleDate: '2026-02-01', saleAmount: 170000, buyerNames: 'Fixer LLC', sellerNames: 'Garcia, Jose' },
  ]));
  check('a six-month hold is a flip, not a snipe', slow === null);
  const nd = detectDoubleClose(saleRows([
    { saleDate: '2026-04-02', saleAmount: 0, buyerNames: 'Rivera Capital LLC', sellerNames: 'Goldline Investments LLC' },
    { saleDate: '2026-04-02', saleAmount: 0, buyerNames: 'Goldline Investments LLC', sellerNames: 'Garcia, Jose' },
  ]));
  check('Texas (no prices) same-day chain still reads as a double close', !!nd && nd.gap_days === 0 && nd.spread === null);
  const broken = detectDoubleClose(saleRows([
    { saleDate: '2026-04-02', saleAmount: 215000, buyerNames: 'Rivera Capital LLC', sellerNames: 'Someone Else' },
    { saleDate: '2026-04-01', saleAmount: 170000, buyerNames: 'Goldline Investments LLC', sellerNames: 'Garcia, Jose' },
  ]));
  check('a chain that does not link (B is not the seller on the second deed) is not a snipe', broken === null);
  const assigned = detectDoubleClose(saleRows([
    { saleDate: '2026-04-02', saleAmount: 215000, buyerNames: 'Rivera Capital LLC', sellerNames: 'Goldline Investments LLC', documentType: 'Assignment of Contract' },
    { saleDate: '2026-03-20', saleAmount: 170000, buyerNames: 'Goldline Investments LLC', sellerNames: 'Garcia, Jose' },
  ]));
  eq('an assignment deed is the other shape of the trade', assigned?.kind, 'assignment');

  const existing = cand({ key: entityKey('Rivera Capital LLC'), owner_name: 'Rivera Capital LLC', likelihood: 30 });
  const sniped = snipedBuyer(dc!, purchase({ reapi_id: 'x9', address: '109 N Mill Ln' }), existing);
  check('the end buyer is labelled Wholesale snipe with the wholesaler named', sniped.methods?.includes('wholesale_snipe') === true && /from Goldline Investments LLC 1 day after/.test(sniped.evidence?.[0]?.summary ?? ''), sniped.evidence?.[0]?.summary);
  check('the sniped buyer is lifted to at least 55', sniped.likelihood === 55 && sniped.purchases.some((p) => p.reapi_id === 'x9'));
  const fresh = snipedBuyer(dc!, purchase({ reapi_id: 'x9' }), null);
  eq('a new end buyer becomes a candidate of their own', [fresh.owner_name, fresh.corporate, fresh.purchase_count], ['Rivera Capital LLC', true, 1]);

  const hits = new Map<string, Hit>([['p1', { enriched: true, prior_owner_months: 1 } as Hit], ['p2', { enriched: true, prior_owner_months: 14 } as Hit]]);
  eq('snipe targets: unenriched purchases and quick prior holds', snipeTargets([cand({ purchases: [purchase({ reapi_id: 'p1' }), purchase({ reapi_id: 'p2' }), purchase({ reapi_id: 'p3' })] })], hits), ['p1', 'p3']);
}

// ---- the deed index ----
{
  const json = { hits: [
    { id: 'A1', fileDate: '2026-05-20T00:00:00', docType: 'WARRANTY DEED', propertyAddress: '109 N MILL LN NEW BRAUNFELS TX 78130', parties: [{ type: 'GRANTOR', name: 'GOLDLINE INVESTMENTS LLC' }, { type: 'GRANTEE', name: 'RIVERA CAPITAL LLC' }], docAmount: '125000' },
    { id: 'A2', fileDate: '2026-06-02', docType: 'RELEASE OF LIEN', parties: [{ type: 'GRANTOR', name: 'GOLDLINE INVESTMENTS LLC' }, { type: 'GRANTEE', name: 'BANK OF TEXAS' }] },
    { id: 'A3', fileDate: '2026-07-11', docType: 'SPECIAL WARRANTY DEED', parties: [{ type: 'GRANTOR', name: 'SOUP TO NUTS LLC' }, { type: 'GRANTEE', name: 'Rivera Capital, LLC' }] },
    { id: 'A4', fileDate: '2026-07-12', docType: 'WARRANTY DEED', parties: [{ type: 'GRANTOR', name: 'SOUP TO NUTS LLC' }, { type: 'GRANTEE', name: 'GOLDLINE INVESTMENTS LLC' }] },
    { id: 'A5', fileDate: '2026-08-01', docType: 'WARRANTY DEED', parties: [{ type: 'GRANTOR', name: 'SOUP TO NUTS LLC' }, { type: 'GRANTEE', name: 'Tran, Linh' }] },
  ], total: 5 };
  const txs = parsePublicSearch(json, 'GOLDLINE INVESTMENTS LLC', 'Bexar', 'TX', 'https://bexar.tx.publicsearch.us');
  eq('publicsearch rows parse with grantor, grantee, date and amount', txs.map((t) => [t.grantor, t.grantee, t.date, t.price]).slice(0, 2),
    [['GOLDLINE INVESTMENTS LLC', 'RIVERA CAPITAL LLC', '2026-05-20', 125000], ['GOLDLINE INVESTMENTS LLC', 'BANK OF TEXAS', '2026-06-02', null]]);
  check('a release of lien is not a conveyance', !isConveyance('RELEASE OF LIEN') && isConveyance('WARRANTY DEED') && isConveyance(null));
  const ranked = rankGrantees(txs, { aliasOf: (n) => familyOf(n) ?? n });
  eq('grantees rank by deals across the wholesaler family, shells and banks dropped', ranked.map((g) => [g.name, g.deals, g.wholesalers]),
    [['Rivera Capital LLC', 2, ['New Western']], ['Linh Tran', 1, ['New Western']]]);
  const c = granteeCandidate(ranked[0], null, { lat: 29.4, lng: -98.47 });
  check('a ranked grantee becomes a Wholesaler-buyers candidate', c.methods?.includes('wholesaler_buyers') === true && c.likelihood >= 56 && /Bought 2 deals from New Western/.test(c.evidence?.[0]?.summary ?? ''), c.evidence?.[0]?.summary);
  eq('familyOf rolls shells up', [familyOf('Goldline Investments LLC'), familyOf('Soup to Nuts LLC'), familyOf('Rivera Capital LLC')], ['New Western', 'New Western', null]);
  eq('entityKey ignores punctuation and suffixes', [entityKey('Acme Holdings, LLC'), entityKey('ACME HOLDINGS L.L.C.'), entityKey('Acme Holdings LLC')], ['acme holdings', 'acme holdings', 'acme holdings']);
}

// ---- assignment contracts: the three shapes in the Drive ----
const OPERATOR_AB = `Acme Homes 100 Commerce Way, Suite 200 Springfield, IL, 62701

ASSIGNMENT OF CONTRACT FOR PURCHASE AND SALE OF REAL ESTATE

This Assignment of Contract for Purchase and Sale of Real Estate (this "Assignment") is dated \\_\\_\\_\\_ (the "Effective Date") and is made between:

Assignor (Wholesaler): \\_\\_\\_\\_\\_\\_

Assignee (Buyer): \\_\\_\\_\\_\\_\\_

Property: \\_\\_\\_\\_\\_\\_

2.1 Property Purchase Price. $\\_\\_\\_\\_ (as stated in the Underlying Contract).

1 of 4

09/04/2026

rapid homebuyers llc

Acme Holdings LLC

1716 Ashby Pl, Oklahoma City, OK 73111-6230

06-26-2026

Avery Gold

48,000.00 4,000.00

5

Document Ref: YMALD-BFPHG-BKEUC-JYV5K Page 1 of 5

500.00

52,000.00

7.1 Closing Date. Closing shall occur on or before \\_\\_\\_\\_ (the "Closing Date"), subject to extensions approved by Assignee.

10/05/2026

Oklahoma Abstract in Edmond

SIGNATURES

ASSIGNOR:

Company: \\_\\_\\_\\_

ASSIGNEE:

Company: \\_\\_\\_\\_

4 of 4

Rapid home buyers

dispo

09-04-2026

Acme Holdings, LLC

Taylor Reed COO

09-04-2026

STANDING MUTUAL RELEASE & EARNEST MONEY DISBURSEMENT AUTHORIZATION

Rapid Home Buyers LLC Acme Holdings LLC

DOCUMENT REF. NUMBER

SIGNER TIMESTAMP SIGNATURE

JAMIE CARTER

EMAIL JAMIE@EXAMPLE-WHOLESALER.COM

PHONE +14055550123

SENT 04 SEP 2026 18:24:31

TAYLOR REED

EMAIL OURS@YOURCOMPANY.COM

PHONE +12105550100

SENT 04 SEP 2026 18:24:31

Signed with PandaDoc PAGE 1 OF 1`;

const OPERATOR_BC = `Acme Homes 100 Commerce Way, Suite 200 Springfield, IL, 62701

ASSIGNMENT AGREEMENT

This Assignment Agreement ("Agreement") is entered into as of \\_\\_\\_\\_ (Effective Date), by and between:

Assignor: \\_\\_\\_\\_

Assignee: \\_\\_\\_\\_

Property: \\_\\_\\_\\_

1.1 Total Consideration

As consideration for this Assignment, Assignee agrees to pay a total amount of $\\_\\_\\_\\_ (Purchase Price + Assignment Fee)

1 of 5

09/29/2026

Acme Holdings LLC Jordan Bell

912 Cordial Rd Eden North Carolina 27288

5,000.00

Document Ref: SVXTQ-GE2CX-2WAAE-KMPOK Page 1 of 5

85,000.00

4.1 Closing Date

Closing shall occur on or before \\_\\_\\_\\_.

10/21/2026

Seth M. Woodall & Associates, PLLC

SIGNATURES

Assignor (Seller):

Company: \\_\\_\\_\\_

Assignee (Buyer):

Company: \\_\\_\\_\\_

5 of 5

Acme Holdings, Llc

Taylor Reed

09-29-2026

NCNP, Inc.

Jordan Bell

09-30-2026

DOCUMENT REF. NUMBER

SIGNER TIMESTAMP SIGNATURE

TAYLOR REED

EMAIL OURS@YOURCOMPANY.COM

PHONE +12105550100

SENT 30 SEP 2026 15:51:46

Signed with PandaDoc PAGE 1 OF 1`;

const NEW_WESTERN = `Clear Form

ASSIGNMENT OF CONTRACT FOR PURCHASE AND SALE OF REAL ESTATE

"Assignment") This Assignment dated 5/20/25

\\_\\_\\_\\_ of Contract for Purchase is made and between Sale ACME \\_\\_\\_\\_

of Real HOLDINGS Estate Agreement LLC

(the

("Assignor") and GOLDLINE \\_\\_\\_\\_ INVESTMENTS LLC

("Assignee"), regarding the property located at: 109 \\_\\_\\_\\_, N MILL LN NEW BRAUNFELS TX 78130

and otherwise described as:

WHEREAS, Assignor, as buyer, entered into that certain real estate purchase and sale agreement dated 5/10/15

\\_\\_\\_\\_ (the "Purchase Agreement") with JOSE \\_\\_\\_\\_,

GARCIA as seller (the "Original Seller") for the purchase of the Property for the amount of $\\_\\_\\_\\_ 106,400.00

("Property Purchase Price"); and

1. ASSIGNMENT FEE: Assignee shall pay and deliver to Assignor a contract assignment fee in the amount of $\\_\\_\\_\\_ 18,600.00("Assignment Fee"), which shall be collected at closing and itemized on the settlement statement. The Property Purchase Price plus the Assignment Fee shall be $\\_\\_\\_\\_ 125,000

("Total Purchase Price").

5. CLOSING DATE: Closing is to take place on or before \\_\\_\\_\\_ ("Closing Date").

MAY 30 2025

OPTION TITLE - DAGNEY MADDOX

Assignment of Contract for Purchase and Sale of Real Estate Page 4 of 10 © 2025 New Western v20250327

IN WITNESS WHEREOF, the Assignee and the Assignor have entered into this Assignment as of the Effective Date.

ASSIGNEE:

\\_\\_\\_\\_ Assignee Entity

ASSIGNOR:

\\_\\_\\_\\_ Assignor Entity

GOLDLINE INVESTMENTS LLC

5/20/2025

ACME HOLDINGS LLC

5/20/2025

Assignment of Contract for Purchase and Sale of Real Estate Page 10 of 10 © 2025 New Western v20250327`;

{
  const ab = parseAssignmentText(OPERATOR_AB);
  eq('Acme Homes AB: the other wholesaler is the assignor, Acme Homes the assignee', [ab.template, ab.assignor, ab.assignee], ['operator', 'Rapid Home Buyers LLC', 'Acme Holdings LLC']);
  eq('Acme Homes AB: property, prices, closing', [ab.property, ab.purchase_price, ab.assignment_fee, ab.total_price, ab.closing_date], ['1716 Ashby Pl, Oklahoma City, OK 73111-6230', 48000, 4000, 52000, '2026-10-05']);
  eq('Acme Homes AB: the counterparty signer with email and phone', [ab.assignor_person, ab.assignor_email, ab.assignor_phone], ['Jamie Carter', 'jamie@example-wholesaler.com', '+14055550123']);
  eq('Acme Homes AB: leg', legOf(ab), 'AB');
  const bc = parseAssignmentText(OPERATOR_BC);
  eq('Acme Homes BC: Acme Homes assigns to the end buyer', [bc.assignor, bc.assignee, legOf(bc)], ['Acme Holdings LLC', 'NCNP Inc', 'BC']);
  eq('Acme Homes BC: the end buyer signer, total and closing', [bc.assignee_person, bc.total_price, bc.closing_date], ['Jordan Bell', 85000, '2026-10-21']);
  const nw = parseAssignmentText(NEW_WESTERN);
  eq('New Western: Acme Homes assigns to a New Western shell', [nw.template, nw.assignor, nw.assignee, legOf(nw)], ['new_western', 'Acme Holdings LLC', 'Goldline Investments LLC', 'BC']);
  eq('New Western: price, fee, total, property', [nw.purchase_price, nw.assignment_fee, nw.total_price, nw.property], [106400, 18600, 125000, '109 N MILL LN NEW BRAUNFELS TX 78130']);
  eq('New Western: the original seller and the title company', [nw.original_seller, nw.title_company], ['JOSE GARCIA', 'OPTION TITLE']);
  eq('New Western: the assignee rolls up to the New Western family', familyOf(nw.assignee), 'New Western');
}

// ---- addresses ----
eq('splitProperty reads a full line', splitProperty('1716 Ashby Pl, Oklahoma City, OK 73111-6230'), { address: '1716 Ashby Pl', city: 'Oklahoma City', state: 'OK', zip: '73111' });
eq('splitProperty reads a state name', splitProperty('710 Seaside Way, Palm Harbor, Florida, 34685'), { address: '710 Seaside Way', city: 'Palm Harbor', state: 'FL', zip: '34685' });
check('sameHouse matches on street and zip', sameHouse('109 N Mill Ln, New Braunfels, TX 78130', '109 N MILL LN NEW BRAUNFELS TX 78130') && !sameHouse('109 N Mill Ln, New Braunfels, TX 78130', '110 N Mill Ln, New Braunfels, TX 78130'));

void (null as unknown as DeedTransaction);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
