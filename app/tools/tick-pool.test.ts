// The ai-agent tick and lead-memory pool: at most n at once, and one person's
// turns (same record, phone or email) in one lane, in their original order.
// Run: npx tsx tools/tick-pool.test.ts
import assert from 'node:assert/strict';
import { lanes, pool } from '../supabase/functions/ai-agent/pool';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const tickOnce = () => new Promise((r) => setTimeout(r, 1));

type Item = { id: number; keys: string[] };
const ids = (ls: Item[][]) => ls.map((l) => l.map((i) => i.id));

await test('the pool runs every item, keeps result order, never more than n at once', async () => {
  let active = 0; let peak = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++; peak = Math.max(peak, active);
    await tickOnce();
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.equal(peak, 3);
});

await test('the pool with fewer items than workers, and with none', async () => {
  assert.deepEqual(await pool([1], 3, async (n) => n), [1]);
  assert.deepEqual(await pool([], 3, async (n: number) => n), []);
});

await test('different people get their own lanes, in due order', () => {
  const items: Item[] = [
    { id: 1, keys: ['seller:1', 'phone:2105550101'] },
    { id: 2, keys: ['seller:2', 'phone:2105550102'] },
    { id: 3, keys: ['buyer:3', 'email:a@x.com'] },
  ];
  assert.deepEqual(ids(lanes(items, (i) => i.keys)), [[1], [2], [3]]);
});

await test('two records with one phone share a lane, in due order', () => {
  const items: Item[] = [
    { id: 1, keys: ['seller:1', 'phone:2105550101'] },
    { id: 2, keys: ['seller:2', 'phone:2105550199'] },
    { id: 3, keys: ['buyer:9', 'phone:2105550101'] },
  ];
  assert.deepEqual(ids(lanes(items, (i) => i.keys)), [[1, 3], [2]]);
});

await test('a chain of shared keys is one lane: phone links 1 and 2, email links 2 and 4', () => {
  const items: Item[] = [
    { id: 1, keys: ['seller:1', 'phone:1'] },
    { id: 2, keys: ['seller:2', 'phone:1', 'email:b@x.com'] },
    { id: 3, keys: ['seller:3'] },
    { id: 4, keys: ['buyer:4', 'email:b@x.com'] },
    { id: 5, keys: ['buyer:5', 'phone:5'] },
  ];
  assert.deepEqual(ids(lanes(items, (i) => i.keys)), [[1, 2, 4], [3], [5]]);
});

await test('a later item can join two lanes that formed apart', () => {
  const items: Item[] = [
    { id: 1, keys: ['phone:1'] },
    { id: 2, keys: ['phone:2'] },
    { id: 3, keys: ['phone:3'] },
    { id: 4, keys: ['phone:2', 'phone:1'] },
  ];
  assert.deepEqual(ids(lanes(items, (i) => i.keys)), [[1, 2, 4], [3]]);
});

await test('one shared key (a Compr workspace, or a failed read) puts everything in one lane', () => {
  const items: Item[] = [1, 2, 3, 4].map((id) => ({ id, keys: [`seller:${id}`, 'ws:11'] }));
  assert.deepEqual(ids(lanes(items, (i) => i.keys)), [[1, 2, 3, 4]]);
  assert.deepEqual(ids(lanes(items, () => ['all'])), [[1, 2, 3, 4]]);
});

await test('pooled lanes: one lane is never worked twice at once, and keeps its order', async () => {
  const items: Item[] = [
    { id: 1, keys: ['phone:1'] }, { id: 2, keys: ['phone:2'] }, { id: 3, keys: ['phone:1'] },
    { id: 4, keys: ['phone:3'] }, { id: 5, keys: ['phone:1'] }, { id: 6, keys: ['phone:4'] },
  ];
  const busy = new Set<string>(); const seen: number[] = []; let active = 0; let peak = 0;
  await pool(lanes(items, (i) => i.keys), 3, async (lane) => {
    for (const it of lane) {
      const k = it.keys[0]!;
      assert.ok(!busy.has(k), `${k} worked twice at once`);
      busy.add(k); active++; peak = Math.max(peak, active);
      await tickOnce();
      seen.push(it.id); busy.delete(k); active--;
    }
  });
  assert.deepEqual(seen.filter((id) => [1, 3, 5].includes(id)), [1, 3, 5]);
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6]);
  assert.equal(peak, 3);
});

console.log(`tick-pool: ${passed} passed`);
