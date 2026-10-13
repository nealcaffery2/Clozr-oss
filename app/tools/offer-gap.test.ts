// The People gap filters' arithmetic. Run: npx tsx tools/offer-gap.test.ts
import assert from 'node:assert/strict';
import { closeCallsNeeded, gapOf, withinOf } from '../lib/offer-gap';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const g = (ask: number, offer: number, high: number | null) => ({ ask, offer, high });

test('ask above the offer is the dollar gap', () => assert.equal(gapOf(g(250_000, 240_000, null), 'Actual offer'), 10_000));
test('an offer at or above the ask is no gap, not a negative or absolute one', () => {
  assert.equal(gapOf(g(200_000, 230_000, null), 'Actual offer'), 0);
  assert.equal(gapOf(g(200_000, 200_000, null), 'Actual offer'), 0);
});
test('UW high with no ceiling drops out', () => assert.equal(gapOf(g(250_000, 240_000, null), 'UW high'), null));
test('UW high measures against the ceiling', () => assert.equal(gapOf(g(290_000, 240_000, 276_000), 'UW high'), 14_000));
test('Either takes the closer basis', () => assert.equal(gapOf(g(290_000, 240_000, 276_000), 'Either'), 14_000));
test('Either with no ceiling is the offer gap', () => assert.equal(gapOf(g(250_000, 240_000, null), undefined), 10_000));
test('no ask is no gap', () => assert.equal(gapOf(g(0, 240_000, 250_000), 'Either'), null));
test('no offer falls back to the ceiling on Either', () => assert.equal(gapOf(g(250_000, 0, 245_000), 'Either'), 5_000));
test('within: labels and the default', () => {
  assert.equal(withinOf('Within $5k'), 5_000);
  assert.equal(withinOf('Any gap'), Infinity);
  assert.equal(withinOf(undefined), 20_000);
  assert.equal(withinOf('nonsense'), 20_000);
});
test('close calls: explicit count wins', () => assert.equal(closeCallsNeeded({ closeCalls: '3+' }), 3));
test('close calls: all defaults is off', () => assert.equal(closeCallsNeeded({ closeCalls: 'Any', gapBasis: 'Either', gapWithin: 'Within $20k' }), 0));
test('close calls: a threshold alone means at least one', () => assert.equal(closeCallsNeeded({ closeCalls: 'Any', gapWithin: 'Within $5k' }), 1));
test('close calls: a basis alone means at least one', () => assert.equal(closeCallsNeeded({ gapBasis: 'Actual offer' }), 1));

console.log(`offer-gap: ${passed} checks passed`);
