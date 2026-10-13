// The deal sheet Buyer menu is the Buyers list. Run: npx tsx tools/deal-sheet-buyers.test.ts
import assert from 'node:assert/strict';
import { sheetBuyerOptions } from '../lib/deal-sheet';

const buyers = [
  { id: 'b1', name: 'Chris Anderson', company: 'Harbor Capital', createdAt: '2026-08-01T00:00:00Z' },
  { id: 'b2', name: 'Jordan Lee', company: '—', prospectList: 'buyer-prospect' },
  { id: 'b3', name: '—', company: 'Amherst' },
  { id: 'b1', name: 'Chris Anderson', company: 'Harbor Capital' },
];

const opts = sheetBuyerOptions(buyers, 9);
assert.deepEqual(opts.map((o) => o.id), [1, 3, 9]);
assert.equal(opts[0]?.label, 'Harbor Capital · Chris Anderson');
assert.equal(opts[1]?.label, 'Amherst');
assert.equal(opts[2]?.label, 'Buyer 9');
assert.equal(opts[0]?.at, Date.parse('2026-08-01T00:00:00Z'));
assert.deepEqual(sheetBuyerOptions(buyers, 1).map((o) => o.id), [1, 3]);

console.log('deal-sheet-buyers ok');
