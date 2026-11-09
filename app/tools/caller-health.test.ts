import assert from 'node:assert/strict';
import { lineLoads, loadShare, localMatchRate, startOfToday, uncoveredAreaCodes } from '../lib/caller-health';

const now = Date.parse('2026-10-29T15:00:00');
const today = new Date(startOfToday(now) + 3_600_000).toISOString();
const yesterday = new Date(startOfToday(now) - 3_600_000).toISOString();

const lines = [
  { id: 'a', phone_e164: '+12105550100', area_code: '210' },
  { id: 'b', phone_e164: '+14045550200', area_code: null },
];
const calls = [
  { at: today, from_number: '+12105550100', to_number: '+12105550001', user_id: 'me' },
  { at: today, from_number: '(210) 555-0100', to_number: '+13145550002', user_id: 'me' },
  { at: yesterday, from_number: '+12105550100', to_number: '+13145550003', user_id: 'me' },
  { at: yesterday, from_number: '+14045550200', to_number: '+14045550004', user_id: 'other' },
  { at: yesterday, from_number: '+19995550999', to_number: '+14055550005', user_id: 'me' },
];

const loads = lineLoads(lines, calls, now);
assert.deepEqual(loads, { a: { today: 2, week: 3 }, b: { today: 0, week: 1 } });

// My calls only: 1 of 4 with a matching area code (the 999 line is not ours but still a call I made).
assert.equal(localMatchRate(calls, 'me'), 0.25);
// Everyone: 2 of 5.
assert.equal(localMatchRate(calls, null), 0.4);
assert.equal(localMatchRate([], 'me'), null);

assert.deepEqual(uncoveredAreaCodes(lines, calls), [{ area: '314', calls: 2 }, { area: '405', calls: 1 }]);

assert.equal(loadShare(36, 60), 0.6);
assert.equal(loadShare(250, 100), 1);
assert.equal(loadShare(10, null), 0.1);

console.log('caller-health ok');
