// Floor notification switches. Run: npx tsx tools/floor-notify.test.ts
import assert from 'node:assert/strict';
import { floorBellMutes, floorEventSilenced, withFloorBellMutes, type FloorNotifyPrefs } from '../lib/floor-notify';

const on: FloorNotifyPrefs = { leaderboard: true, badges: true };
const off: FloorNotifyPrefs = { leaderboard: false, badges: false };

assert.equal(floorEventSilenced('pass', on), false);
assert.equal(floorEventSilenced('badge', on), false);
assert.equal(floorEventSilenced('digest', on), false);
assert.equal(floorEventSilenced('contract', on), false);
assert.equal(floorEventSilenced('nudge', on), false);

assert.equal(floorEventSilenced('pass', { leaderboard: false, badges: true }), true);
assert.equal(floorEventSilenced('badge', { leaderboard: false, badges: true }), false);
assert.equal(floorEventSilenced('contract', { leaderboard: false, badges: true }), false);

assert.equal(floorEventSilenced('badge', { leaderboard: true, badges: false }), true);
assert.equal(floorEventSilenced('digest', { leaderboard: true, badges: false }), true);
assert.equal(floorEventSilenced('pass', { leaderboard: true, badges: false }), false);
assert.equal(floorEventSilenced('contract', off), false);
assert.equal(floorEventSilenced('nudge', off), false);

assert.deepEqual(floorBellMutes(on), {});
assert.deepEqual(floorBellMutes({ leaderboard: false, badges: true }), { Leaderboard: true });
assert.deepEqual(floorBellMutes({ leaderboard: true, badges: false }), { Badge: true });
assert.deepEqual(withFloorBellMutes({ SMS: true }, { leaderboard: false, badges: false }), {
  SMS: true, Leaderboard: true, Badge: true,
});
assert.deepEqual(withFloorBellMutes({ Call: true }, on), { Call: true });

console.log('floor-notify ok');
