// npx tsx tools/delta-rows.test.ts
import assert from 'node:assert/strict';
import { mergeDelta, newestStamp, sinceOf } from '../lib/delta-rows';

const cache = new Map([
  [1, { id: 1, name: 'a', updated_at: '2026-10-10T10:00:00Z' }],
  [2, { id: 2, name: 'b', updated_at: '2026-10-10T10:01:00Z' }],
  [3, { id: 3, name: 'c', updated_at: '2026-10-10T10:02:00Z' }],
]);

// 2 edited, 3 deleted or archived (not in ids), 4 new and returned, 5 new and not returned.
const { rows, missing } = mergeDelta(cache, [1, 2, 4, 5], [
  { id: 2, name: 'b2', updated_at: '2026-10-10T11:00:00Z' },
  { id: 4, name: 'd', updated_at: '2026-10-10T11:01:00Z' },
  { id: 3, name: 'c2', updated_at: '2026-10-10T11:02:00Z' }, // changed, then left the list: stays out
]);
assert.deepEqual([...rows.keys()], [1, 2, 4]);
assert.equal(rows.get(2)?.name, 'b2');
assert.equal(rows.get(1), cache.get(1));
assert.deepEqual(missing, [5]);

assert.equal(newestStamp(rows.values()), '2026-10-10T11:01:00Z');
assert.equal(newestStamp([], null), null);
assert.equal(sinceOf('2026-10-10T11:01:00Z'), '2026-10-10T10:59:00.000Z');
assert.equal(sinceOf(null), null);
console.log('delta-rows ok');
