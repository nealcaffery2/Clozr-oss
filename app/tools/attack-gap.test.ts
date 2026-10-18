// Run: npx tsx tools/attack-gap.test.ts
import assert from 'node:assert/strict';
import { gapLine, gapPasses, room } from '../lib/attack-gap';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

test('asking 100k and we can offer 120k is a +20k gap', () => assert.equal(room(120_000, 100_000), 20_000));
test('short of their ask is negative', () => assert.equal(room(80_000, 100_000), -20_000));
test('no ask is not a gap', () => assert.equal(room(120_000, null), null));
test('at or above their ask', () => {
  assert.equal(gapPasses(20_000, 'At or above their ask'), true);
  assert.equal(gapPasses(-1, 'At or above their ask'), false);
  assert.equal(gapPasses(null, 'At or above their ask'), false);
});
test('within $20k is either side', () => {
  assert.equal(gapPasses(20_000, 'Within $20k'), true);
  assert.equal(gapPasses(-20_000, 'Within $20k'), true);
  assert.equal(gapPasses(20_001, 'Within $20k'), false);
});
test('Any does not drop a deal with no numbers', () => assert.equal(gapPasses(null, 'Any'), true));
test('the card line names both gaps', () => assert.equal(gapLine(100_000, 120_000, 130_000), 'Ask $100k · Offer +$20k · UW high +$30k'));

console.log(`${passed} attack-gap tests passed`);
