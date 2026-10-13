// AI contract extraction against the deal sheet.  Run:  npx tsx tools/extract-diff.test.ts
import assert from 'node:assert/strict';
import { cleanExtraction, columnFor, dealDiff, normDate, normMoney, normName, normPhone, patchFor, type Extraction } from '../supabase/functions/_shared/extract-diff';

// ---- normalizing
assert.equal(normMoney('$85,000.00'), 85000);
assert.equal(normMoney('85000'), 85000);
assert.equal(normMoney('n/a'), null);
assert.equal(normDate('October 21, 2026'), '2026-10-21');
assert.equal(normDate('10/21/2026'), '2026-10-21');
assert.equal(normDate('10/21/26'), '2026-10-21');
assert.equal(normDate('2026-10-21T00:00:00Z'), '2026-10-21');
assert.equal(normName('ACME HOLDINGS, LLC'), 'acme holdings llc');
assert.equal(normName('Smith & Sons'), 'smith and sons');
assert.equal(normPhone('+1 (210) 555-0136'), '2105550136');

// ---- model output
const rows = cleanExtraction({ fields: [
  { key: 'close_date', value: 'October 21, 2026', confidence: 0.94, page: 3, bbox: [0.1, 0.2, 0.3, 0.05] },
  { key: 'close_date', value: 'October 24, 2026', confidence: 0.5, page: 5 },   // a second single-valued term is dropped
  { key: 'seller', value: 'Sam Seller', confidence: 0.99, page: 1 },
  { key: 'seller', value: 'Sally Seller', confidence: 0.97, page: 1 },          // many: both kept
  { key: 'seller', value: 'SAM SELLER', confidence: 0.9, page: 7 },              // same name again: dropped
  { key: 'purchase_price', value: '$85,000', confidence: 92, page: 2 },         // percent → 0.92
  { key: 'made_up', value: 'x' },                                               // unknown key
  { key: 'assignment_fee', value: 'N/A' },                                      // empty
  { key: 'title_email', value: '  jane@title.example ', page: 0 },              // page 0 → null
]});
assert.deepEqual(rows.map((r) => r.field_key), ['close_date', 'seller', 'seller', 'purchase_price', 'title_email']);
assert.equal(rows[0].confidence, 0.94);
assert.deepEqual(rows[0].bbox, [0.1, 0.2, 0.3, 0.05]);
assert.equal(rows[3].confidence, 0.92);
assert.equal(rows[4].page, null);
assert.equal(rows[4].value, 'jane@title.example');
assert.deepEqual(cleanExtraction(null), []);

// ---- columns by side
assert.equal(columnFor('purchase_price', 'seller'), 'offer_amount');
assert.equal(columnFor('purchase_price', 'buyer'), 'sold_price');
assert.equal(columnFor('option_period_end', 'buyer'), 'buyer_option_ends_on');
assert.equal(columnFor('emd_amount', 'buyer'), null);
assert.equal(columnFor('seller', 'seller'), null);

// ---- the diff: "PDF says close 10/21/2026, deal says 10/24"
let id = 0;
const x = (field_key: string, value: string, more: Partial<Extraction> = {}): Extraction => ({ id: ++id, field_key, value, confidence: 0.9, page: 1, bbox: null, ...more });
const deal = {
  id: 7, offer_amount: 85000, assignment_fee: null, earnest_money: 1000, contract_date: '2026-09-29', close_date: '2026-10-24',
  option_ends_on: null, title_contact: 'Jane Doe', title_email: 'Jane@Title.example', title_phone: '(210) 555-0100', sold_price: 97500,
};
const diff = dealDiff({
  kind: 'psa', deal,
  context: { titleCompany: 'Carolina Title', propertyAddress: '912 Cordial Rd' },
  extractions: [
    x('close_date', 'October 21, 2026', { page: 3 }),
    x('purchase_price', '$85,000.00'),                       // same money
    x('emd_amount', '$2,500'),                               // differs
    x('contract_date', '9/29/2026'),                         // same date
    x('option_period_end', '10/6/2026'),                     // deal empty → applyable
    x('title_email', 'jane@title.example'),                  // same email
    x('title_phone', '210.555.0100'),                        // same phone
    x('title_company', 'Carolina Title Company, LLC'),       // same name
    x('property_address', '912 Cordial Rd, Eden, NC 27288'), // same street
    x('seller', 'Sam Seller'),                               // parties are not diffed
    x('assignment_fee', '$12,500', { dismissed_at: '2026-09-30T00:00:00Z' }), // dismissed
    x('close_date', 'October 22, 2026', { applied_to_deal_at: '2026-09-30T00:00:00Z' }), // applied
  ],
});
assert.deepEqual(diff.map((d) => d.field_key), ['close_date', 'emd_amount', 'option_period_end']);
const close = diff[0];
assert.equal(close.column, 'close_date');
assert.equal(close.pdf_display, '10/21/2026');
assert.equal(close.deal_display, '10/24/2026');
assert.equal(close.page, 3);
assert.deepEqual(patchFor(close), { close_date: '2026-10-21' });
assert.deepEqual(patchFor(diff[1]), { earnest_money: 2500 });
assert.equal(diff[2].deal_display, '—');

// An assignment compares the price with what the buyer pays.
const buyerSide = dealDiff({ kind: 'assignment', deal, extractions: [x('purchase_price', '$97,500'), x('assignment_fee', '$12,500'), x('option_period_end', '10/10/2026')] });
assert.deepEqual(buyerSide.map((d) => d.column), ['assignment_fee', 'buyer_option_ends_on']);

// Title company is informational: shown when the deal names a different one, never applied.
const title = dealDiff({ kind: 'psa', deal, context: { titleCompany: 'Carolina Title' }, extractions: [x('title_company', 'Stewart Title of Texas')] });
assert.equal(title.length, 1);
assert.equal(title[0].column, null);
assert.equal(patchFor(title[0]), null);
assert.deepEqual(dealDiff({ kind: 'psa', deal, context: {}, extractions: [x('title_company', 'Stewart Title')] }), []);

// Names and phones are written as printed, not as compared.
const contact = dealDiff({ kind: 'psa', deal: { ...deal, title_contact: null, title_phone: null }, extractions: [x('title_contact', 'Mary O\'Neil'), x('title_phone', '2105550199')] });
assert.deepEqual(patchFor(contact[0]), { title_contact: 'Mary O\'Neil' });
assert.deepEqual(patchFor(contact[1]), { title_phone: '(210) 555-0199' });

assert.deepEqual(dealDiff({ kind: 'psa', deal: null, extractions: [x('close_date', '10/21/2026')] }), []);

console.log('extract-diff ok');
