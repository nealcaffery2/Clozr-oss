// Multi-pick list filters (People and Buyers): one string per filter, old
// single-pick values still read, 'Any' is off.
// Run: npx tsx tools/multi-filter.test.ts
import assert from 'node:assert/strict';
import { ANY, PICK_SEP, isPicked, joinPicks, keepPicks, matchesAnyPick, matchesPick, picksLabel, picksOf, togglePick } from '../lib/multi-filter';
import { matchesContactFilters } from '../lib/contact-presence';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

test('Any and nothing are no picks; an old saved value is one pick', () => {
  assert.deepEqual(picksOf(ANY), []);
  assert.deepEqual(picksOf(undefined), []);
  assert.deepEqual(picksOf(''), []);
  assert.deepEqual(picksOf('New Lead'), ['New Lead']);
});
test('several picks round-trip in order, without duplicates or Any', () => {
  const v = joinPicks(['Hot', 'New Lead', 'Hot', ANY]);
  assert.equal(v, ['Hot', 'New Lead'].join(PICK_SEP));
  assert.deepEqual(picksOf(v), ['Hot', 'New Lead']);
  assert.equal(joinPicks([]), ANY);
});
test('toggling adds, removes, and Any clears', () => {
  let v = togglePick(ANY, 'Hot');
  assert.equal(v, 'Hot');
  v = togglePick(v, 'Warm');
  assert.deepEqual(picksOf(v), ['Hot', 'Warm']);
  v = togglePick(v, 'Hot');
  assert.equal(v, 'Warm');
  v = togglePick(v, 'Warm');
  assert.equal(v, ANY);
  assert.equal(togglePick(joinPicks(['A', 'B']), ANY), ANY);
});
test('isPicked: Any is on only when nothing is', () => {
  assert.equal(isPicked(ANY, ANY), true);
  assert.equal(isPicked('Hot', ANY), false);
  assert.equal(isPicked(joinPicks(['Hot', 'Warm']), 'Warm'), true);
  assert.equal(isPicked(joinPicks(['Hot', 'Warm']), 'Cold'), false);
});
test('one value passes when it is any of the picks', () => {
  const v = joinPicks(['New Lead', 'Offer Made']);
  assert.equal(matchesPick(v, 'Offer Made'), true);
  assert.equal(matchesPick(v, 'Dead'), false);
  assert.equal(matchesPick(v, null), false);
  assert.equal(matchesPick(ANY, 'anything'), true);
  assert.equal(matchesPick('Dead', 'Dead'), true);
});
test('a record with several values (tags) passes when it has any pick', () => {
  const v = joinPicks(['DNC', 'Probate']);
  assert.equal(matchesAnyPick(v, ['Vacant', 'Probate']), true);
  assert.equal(matchesAnyPick(v, ['Vacant']), false);
  assert.equal(matchesAnyPick(v, []), false);
  assert.equal(matchesAnyPick(ANY, []), true);
});
test('the chip label', () => {
  assert.equal(picksLabel(ANY), ANY);
  assert.equal(picksLabel('Hot'), 'Hot');
  assert.equal(picksLabel(joinPicks(['Hot', 'Warm'])), 'Hot, Warm');
  assert.equal(picksLabel(joinPicks(['Hot', 'Warm', 'Cold'])), 'Hot +2');
});
test('picks no longer offered are dropped', () => {
  assert.equal(keepPicks(joinPicks(['Hot', 'Gone']), ['Any', 'Hot', 'Warm']), 'Hot');
  assert.equal(keepPicks('Gone', ['Any', 'Hot']), ANY);
});
test('contact filters take several picks: either one passes', () => {
  assert.equal(matchesContactFilters('2105550100', '', 'Has phone', ANY), true);
  assert.equal(matchesContactFilters('', '', 'Has phone', ANY), false);
  // Both picked is the same as neither.
  assert.equal(matchesContactFilters('', '', joinPicks(['Has phone', 'No phone']), ANY), true);
  assert.equal(matchesContactFilters('2105550100', 'a@b.co', ANY, joinPicks(['No email'])), false);
  assert.equal(matchesContactFilters('2105550100', 'a@b.co', ANY, joinPicks(['No email', 'Has email'])), true);
});

console.log(`multi-filter: ${passed} passed`);
