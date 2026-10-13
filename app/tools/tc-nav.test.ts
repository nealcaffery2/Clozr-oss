import assert from 'node:assert/strict';
import { openTcFiles, stepTc, tcPlace } from '../lib/tc-nav';

const cols = [
  { stage: 'Under Contract Seller', ids: ['a', 'b'] },
  { stage: 'Ready To Market', ids: [] },
  { stage: 'In Escrow', ids: ['c'] },
];

assert.equal(tcPlace(cols, 'b')?.stage, 'Under Contract Seller');
assert.equal(tcPlace(cols, 'b')?.index, 1);
assert.equal(tcPlace(cols, 'b')?.canNextDeal, false);
assert.equal(tcPlace(cols, 'b')?.canNextStage, true);
assert.equal(stepTc(cols, 'a', 'deal', 1), 'b');
assert.equal(stepTc(cols, 'b', 'deal', 1), null);
assert.equal(stepTc(cols, 'b', 'stage', 1), 'c', 'down skips an empty stage and lands on its deal');
assert.equal(stepTc(cols, 'a', 'stage', 1), 'c', 'the same slot in the next stage, clamped when it is shorter');
assert.equal(stepTc(cols, 'c', 'stage', -1), 'a', 'up lands on the same slot, which is the first deal when this stage has one');
assert.equal(stepTc(cols, 'c', 'stage', 1), null);

// "Transaction coordination (N)" counts and opens the files still being worked, soonest close first.
const deals: Record<string, { stage: string; archived?: boolean }> = {
  d1: { stage: 'Closed' }, d2: { stage: 'In Escrow' }, d3: { stage: 'Under Contract Seller' },
  d4: { stage: 'In Escrow', archived: true }, d5: { stage: 'Terminated' }, d6: { stage: 'Buyer Under Contract' },
};
const files = [
  { dealId: 'd1', closingIso: '2026-01-05' },
  { dealId: 'd6', closingIso: null },
  { dealId: 'd2', closingIso: '2026-10-20' },
  { dealId: 'd3', closingIso: '2026-10-12T00:00:00Z' },
  { dealId: 'd4', closingIso: '2026-10-01' },
  { dealId: 'd5', closingIso: '2026-09-01' },
  { dealId: 'd9', closingIso: '2026-11-01' },
];
assert.deepEqual(openTcFiles(files, (id) => deals[id]).map((t) => t.dealId), ['d3', 'd2', 'd9', 'd6'],
  'closed, terminated and archived drop out; an unreadable deal stays; no close date goes last');
assert.deepEqual(openTcFiles([], () => undefined), []);

console.log('tc-nav ok');
