// Bulk assign: one teammate, an even split, or N each in consecutive blocks.
// Run: npx tsx tools/bulk-assign.test.ts
import assert from 'node:assert/strict';
import { blockRanges, countOf, firstN, inListOrder, inRole, splitBlocks, wanted } from '../lib/bulk-assign';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const ids = (n: number) => Array.from({ length: n }, (_, i) => 's' + (i + 1));

test('typed counts', () => {
  assert.equal(countOf('200'), 200);
  assert.equal(countOf('1,000'), 1000);
  assert.equal(countOf(' 12 '), 12);
  assert.equal(countOf('12.9'), 12);
  assert.equal(countOf('0'), null);
  assert.equal(countOf(''), null);
  assert.equal(countOf('abc'), null);
  assert.equal(countOf(-5), null);
});
test('200 each for three people: consecutive blocks in list order', () => {
  const b = splitBlocks(ids(600), ['quinn', 'chris', 'david'], 200);
  assert.deepEqual(b.map((x) => [x.userId, x.ids.length, x.ids[0], x.ids.at(-1)]), [
    ['quinn', 200, 's1', 's200'], ['chris', 200, 's201', 's400'], ['david', 200, 's401', 's600'],
  ]);
});
test('N each with too few rows: the last gets fewer, later people none', () => {
  const b = splitBlocks(ids(450), ['a', 'b', 'c'], 200);
  assert.deepEqual(b.map((x) => [x.userId, x.ids.length]), [['a', 200], ['b', 200], ['c', 50]]);
  assert.deepEqual(splitBlocks(ids(150), ['a', 'b', 'c'], 200).map((x) => x.userId), ['a']);
});
test('N each with more rows than needed leaves the rest out', () => {
  const b = splitBlocks(ids(1000), ['a', 'b'], 300);
  assert.equal(b.reduce((n, x) => n + x.ids.length, 0), 600);
  assert.equal(b[1].ids.at(-1), 's600');
});
test('even split: sizes differ by at most one, earlier people take the extra', () => {
  const b = splitBlocks(ids(10), ['a', 'b', 'c'], null);
  assert.deepEqual(b.map((x) => x.ids.length), [4, 3, 3]);
  assert.deepEqual(b.flatMap((x) => x.ids), ids(10));
  assert.deepEqual(splitBlocks(ids(2), ['a', 'b', 'c'], null).map((x) => x.userId), ['a', 'b']);
});
test('every id lands once, no overlap', () => {
  const b = splitBlocks(ids(997), ['a', 'b', 'c', 'd'], null);
  const all = b.flatMap((x) => x.ids);
  assert.equal(all.length, 997);
  assert.equal(new Set(all).size, 997);
});
test('a person picked twice counts once; Unassigned (null) is a person', () => {
  assert.deepEqual(splitBlocks(ids(4), ['a', 'a', null], null).map((x) => [x.userId, x.ids.length]), [['a', 2], [null, 2]]);
});
test('nothing to split', () => {
  assert.deepEqual(splitBlocks([], ['a'], null), []);
  assert.deepEqual(splitBlocks(ids(3), [], 2), []);
});
test('how many rows a split wants', () => {
  assert.equal(wanted(3, 200, 50), 600);
  assert.equal(wanted(3, null, 50), 50);
});
test('the preview ranges', () => {
  assert.deepEqual(blockRanges(splitBlocks(ids(5), ['a', 'b'], 3)), [
    { userId: 'a', count: 3, from: 1, to: 3 }, { userId: 'b', count: 2, from: 4, to: 5 },
  ]);
});
test('select the first N, optionally skipping rows with an owner', () => {
  const rows = [{ id: 'a', owner: 'x' }, { id: 'b', owner: null }, { id: 'c', owner: null }, { id: 'd', owner: 'y' }, { id: 'e', owner: null }];
  assert.deepEqual(firstN(rows, 2), ['a', 'b']);
  assert.deepEqual(firstN(rows, 2, (r) => !r.owner), ['b', 'c']);
  assert.deepEqual(firstN(rows, 10, (r) => !r.owner), ['b', 'c', 'e']);
});
test('the selection in list order', () => {
  assert.deepEqual(inListOrder(['a', 'b', 'c', 'd'], { d: true, b: true, c: false }), ['b', 'd']);
  assert.deepEqual(inListOrder(['a', 'b', 'c'], new Set(['c', 'a'])), ['a', 'c']);
});
test('teammates by workspace role', () => {
  const team = [{ id: '1', memberRole: 'acquisitions' }, { id: '2', memberRole: 'owner' }, { id: '3', memberRole: 'acquisitions' }, { id: '4' }];
  assert.deepEqual(inRole(team, 'acquisitions').map((m) => m.id), ['1', '3']);
});

console.log(`bulk-assign: ${passed} passed`);
