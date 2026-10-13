// The Deals table's calculated columns, checked against the 2026 Deal Tracker.
// Run: npx tsx tools/deal-tracker-sheet.test.ts
import assert from 'node:assert/strict';
import { DEAL_COL_LABELS, DEAL_TABLE_DEFAULT, bookedSpread, daysToClose, trackerSheet } from '../lib/deal-tracker-sheet';

assert.equal(DEAL_COL_LABELS.length, 35);
assert.ok(DEAL_TABLE_DEFAULT.every((label) => (DEAL_COL_LABELS as readonly string[]).includes(label)));

// Property 1: closed wholesale. Days use the actual close, not the scheduled one.
assert.equal(daysToClose('2025-12-31', '2026-02-24', '2026-02-23'), 54);
const p1 = trackerSheet({
  contractDate: '2025-12-31', scheduledClose: '2026-02-24', closedOn: '2026-02-23',
  sellerPrice: 225000, priceDrop: -15000, marketedPrice: 245000, dispoPrice: 235000, dispoFee: 25000,
  transactionType: 'Wholesale', contractStatus: 'Closed',
});
assert.equal(p1.closingMonth, '2026-02');
assert.equal(p1.schedMo, 'Feb');
assert.equal(p1.bookedSpread, 25000);
assert.equal(p1.closeMo, 'Feb');
assert.equal(p1.writtenMo, 'Dec');
assert.equal(p1.weekSort, null);

// Property 2: terminated, no dispo price, so the marketed price is the buyer price.
assert.equal(daysToClose('2026-01-12', '2026-01-31', null), 19);
const p2 = trackerSheet({
  contractDate: '2026-01-12', scheduledClose: '2026-01-31', closedOn: null,
  sellerPrice: 100000, priceDrop: null, marketedPrice: 119000, dispoPrice: null, dispoFee: null,
  transactionType: 'Wholesale', contractStatus: 'Terminated',
});
assert.equal(p2.daysToClose, 19);
assert.equal(p2.closingMonth, null);
assert.equal(p2.schedMo, 'Jan');
assert.equal(p2.bookedSpread, 19000);
assert.equal(p2.closeMo, null);
assert.equal(p2.writtenMo, 'Jan');

// Property 3: closed novation with a dispo fee keeps the fee, not the 8% formula.
assert.equal(bookedSpread({
  sellerPrice: 135000, priceDrop: -25000, marketedPrice: 165000, dispoPrice: 155000, dispoFee: 32600,
  transactionType: 'Novation', contractStatus: 'Closed',
}), 32600);

// A novation still out: buyer price minus seller minus drop, then 8% of the buyer price.
assert.equal(bookedSpread({
  sellerPrice: 80000, priceDrop: 0, marketedPrice: 100000, dispoPrice: null, dispoFee: null,
  transactionType: 'Novation', contractStatus: 'Under Contract',
}), 12000);

// Pipeline words count as the sheet's status words.
assert.equal(bookedSpread({
  sellerPrice: 100000, marketedPrice: 119000, transactionType: 'Assignment', contractStatus: 'In Escrow',
}), 19000);
assert.equal(bookedSpread({
  sellerPrice: 100000, marketedPrice: 119000, contractStatus: 'Ready To Market',
}), 0);

// Week sort: Monday Oct 5 2026, so Sunday Oct 4 through Saturday Oct 10.
const now = new Date(2026, 9, 5, 15, 0, 0);
assert.equal(trackerSheet({ contractStatus: 'Escrow', scheduledClose: '2026-10-05' }, now).weekSort, '2026-10-05');
assert.equal(trackerSheet({ contractStatus: 'In Escrow', scheduledClose: '2026-10-10' }, now).weekSort, '2026-10-10');
assert.equal(trackerSheet({ contractStatus: 'Escrow', scheduledClose: '2026-10-11' }, now).weekSort, null);
assert.equal(trackerSheet({ contractStatus: 'Closed', scheduledClose: '2026-10-05' }, now).weekSort, null);
assert.equal(daysToClose(null, '2026-10-05', null), null);

console.log('deal-tracker-sheet: ok');
