// People's State / Market filters and the Top 25% cut (lib/market-pick).
// Run: npx tsx tools/market-pick.test.ts
import assert from 'node:assert/strict';
import { marketStateCode, marketsInStates, searchOptions, stateOptions, topQuartile } from '../lib/market-pick';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const MARKETS = ['Anderson, SC', 'Greenville, SC', 'Anderson, IN', 'San Antonio, TX', 'Charlotte, NC'];

test('a market names its state', () => {
  assert.equal(marketStateCode('Anderson, SC'), 'SC');
  assert.equal(marketStateCode('South Carolina'), 'SC');
  assert.equal(marketStateCode('—'), null);
  assert.equal(marketStateCode(''), null);
});
test('states come off the markets, by name', () => {
  assert.deepEqual(stateOptions(MARKETS), ['Indiana', 'North Carolina', 'South Carolina', 'Texas']);
});
test('a state pick narrows the markets; none picked keeps them all', () => {
  assert.deepEqual(marketsInStates(MARKETS, ['South Carolina']), ['Anderson, SC', 'Greenville, SC']);
  assert.deepEqual(marketsInStates(MARKETS, []), MARKETS);
});
test('typing "anderson" finds both Andersons; with SC picked, only Anderson, SC', () => {
  assert.deepEqual(searchOptions(MARKETS, 'anderson'), ['Anderson, SC', 'Anderson, IN']);
  assert.deepEqual(searchOptions(marketsInStates(MARKETS, ['South Carolina']), ' Anderson '), ['Anderson, SC']);
});
test('top 25%: the best quarter by spread, best first, unscored rows out', () => {
  const rows = [10, 50, null, 30, 80, 20, 70, 40, 60].map((s, i) => ({ id: i, s }));
  assert.deepEqual(topQuartile(rows, (r) => r.s).map((r) => r.s), [80, 70]);
  assert.deepEqual(topQuartile([{ s: 5 }, { s: -3 }], (r) => r.s).map((r) => r.s), [5]);
  assert.deepEqual(topQuartile([{ s: null }], (r) => r.s), []);
});

console.log(`market-pick: ${passed} passed`);
