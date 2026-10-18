// Run: npx tsx tools/date-window.test.ts
import assert from 'node:assert/strict';
import { inDateWindow } from '../lib/date-window';

const now = new Date(2026, 9, 14, 15, 0, 0); // 14 Oct 2026, local
const day = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

test('Any matches a missing date', () => assert.equal(inDateWindow(null, 'Any', undefined, undefined, now), true));
test('Today is the local day', () => {
  assert.equal(inDateWindow(day(2026, 10, 14, 1), 'Today', undefined, undefined, now), true);
  assert.equal(inDateWindow(day(2026, 10, 13, 23), 'Today', undefined, undefined, now), false);
});
test('Last 7 days includes today and six days back', () => {
  assert.equal(inDateWindow(day(2026, 10, 8), 'Last 7 days', undefined, undefined, now), true);
  assert.equal(inDateWindow(day(2026, 10, 7), 'Last 7 days', undefined, undefined, now), false);
});
test('This month and last month', () => {
  assert.equal(inDateWindow(day(2026, 10, 1), 'This month', undefined, undefined, now), true);
  assert.equal(inDateWindow(day(2026, 9, 30), 'This month', undefined, undefined, now), false);
  assert.equal(inDateWindow(day(2026, 9, 30), 'Last month', undefined, undefined, now), true);
});
test('Custom is inclusive, and open on a missing end', () => {
  assert.equal(inDateWindow(day(2026, 10, 1), 'Custom', '2026-10-01', '2026-10-10', now), true);
  assert.equal(inDateWindow(day(2026, 10, 10, 23), 'Custom', '2026-10-01', '2026-10-10', now), true);
  assert.equal(inDateWindow(day(2026, 10, 11), 'Custom', '2026-10-01', '2026-10-10', now), false);
  assert.equal(inDateWindow(day(2026, 11, 2), 'Custom', '2026-10-01', '', now), true);
});
test('a window excludes a record with no date', () => assert.equal(inDateWindow(null, 'Today', undefined, undefined, now), false));

console.log(`${passed} date-window tests passed`);
