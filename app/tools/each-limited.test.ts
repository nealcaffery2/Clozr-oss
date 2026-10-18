// The rolling pool behind bulk enrol, bulk texts and the CSV import, and the
// tag rule crm_edit_tags (migration 302) mirrors.
// Run: npx tsx tools/each-limited.test.ts
import assert from 'node:assert/strict';
import { eachLimited } from '../lib/each-limited';
import { nextTags } from '../lib/crm-write';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await test('results keep the input order whatever order the jobs finish in', async () => {
  const out = await eachLimited([30, 5, 20, 1, 10], 3, async (ms) => { await sleep(ms); return ms * 2; });
  assert.deepEqual(out, [60, 10, 40, 2, 20]);
});

await test('never more than `limit` jobs at once, and every item runs once', async () => {
  let live = 0; let peak = 0; const seen: number[] = [];
  await eachLimited(Array.from({ length: 40 }, (_, i) => i), 6, async (i) => {
    live++; peak = Math.max(peak, live); seen.push(i);
    await sleep(1 + (i % 4));
    live--;
  });
  assert.equal(peak, 6);
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
});

await test('rolling, not lockstep: a slow item does not hold the next group', async () => {
  // Limit 2: item 0 takes 60 ms; items 1..4 take 5 ms each. Lockstep would
  // start item 2 only after item 0. A rolling pool runs 1..4 beside it.
  const started: number[] = [];
  const t0 = Date.now();
  await eachLimited([60, 5, 5, 5, 5], 2, async (ms) => { started.push(Date.now() - t0); await sleep(ms); });
  assert.ok(started[4]! < 50, `item 4 started at ${started[4]} ms, after the slow item`);
});

await test('items start in order', async () => {
  const order: number[] = [];
  await eachLimited([0, 1, 2, 3, 4, 5, 6], 3, async (i) => { order.push(i); await sleep(7 - i); });
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6]);
});

await test('a job that throws stops new jobs and rejects with its error', async () => {
  const ran: number[] = [];
  await assert.rejects(eachLimited([0, 1, 2, 3, 4, 5, 6, 7], 2, async (i) => {
    ran.push(i);
    await sleep(2);
    if (i === 1) throw new Error('boom');
  }), /boom/);
  await sleep(20);
  assert.ok(ran.length <= 4, `ran ${ran.join(',')} after the throw`);
});

await test('nothing to do is an empty result', async () => {
  assert.deepEqual(await eachLimited([], 6, async () => 1), []);
});

await test('nextTags: add appends once, exact match', () => {
  assert.deepEqual(nextTags(['a', 'b'], 'c', true), ['a', 'b', 'c']);
  assert.equal(nextTags(['a', 'c'], 'c', true), null);
  assert.deepEqual(nextTags(['a', 'C'], 'c', true), ['a', 'C', 'c']);
  assert.deepEqual(nextTags(null, 'c', true), ['c']);
  assert.deepEqual(nextTags([], 'c', true), ['c']);
});

await test('nextTags: remove takes every copy, a missing tag changes nothing', () => {
  assert.deepEqual(nextTags(['a', 'c', 'b', 'c'], 'c', false), ['a', 'b']);
  assert.deepEqual(nextTags(['c'], 'c', false), []);
  assert.equal(nextTags(['a'], 'c', false), null);
  assert.equal(nextTags(null, 'c', false), null);
  assert.equal(nextTags(['C'], 'c', false), null);
});

console.log(`each-limited: ${passed} passed`);
