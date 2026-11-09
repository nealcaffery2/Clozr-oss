// deleteBuyers (lib/crm-write) never hard-deletes a buyer that a deal, offer,
// deal party, transaction or contract names, however many references the batch
// has. A bare select stops at 1,000 rows, so a buyer named only past the first
// 1,000 was deleted. Against a fake client that caps an unpaged read at 1,000.
// Run: npx tsx tools/delete-buyers.test.ts
import assert from 'node:assert/strict';
import { deleteBuyers } from '../lib/crm-write';
import { supabase } from '../lib/supabase';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const MAX_ROWS = 1000;

/** refs: table -> buyer ids, one row per entry (repeats allowed). */
function fakeDb(refs: Record<string, number[]>) {
  const deleted: number[] = [];
  const deactivated: number[] = [];
  const from = (table: string) => {
    let op: 'select' | 'update' | 'delete' = 'select';
    let ids: number[] = [];
    let range: [number, number] | null = null;
    const q = {
      select: () => q,
      update: () => { op = 'update'; return q; },
      delete: () => { op = 'delete'; return q; },
      in: (_k: string, v: number[]) => { ids = v; return q; },
      order: () => q,
      range: (a: number, b: number) => { range = [a, b]; return q; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        const answer = () => {
          if (table === 'buyers' && op === 'delete') { deleted.push(...ids); return { data: ids.map((id) => ({ id })), error: null }; }
          if (table === 'buyers' && op === 'update') { deactivated.push(...ids); return { data: ids.map((id) => ({ id })), error: null }; }
          const rows = (refs[table] ?? []).filter((id) => ids.includes(id)).map((buyer_id) => ({ buyer_id }));
          const [a, b] = range ?? [0, MAX_ROWS - 1];
          return { data: rows.slice(a, Math.min(b + 1, a + MAX_ROWS)), error: null };
        };
        return Promise.resolve().then(answer).then(res, rej);
      },
    };
    return q;
  };
  return { from, deleted, deactivated };
}

async function withDb<T>(db: ReturnType<typeof fakeDb>, fn: () => Promise<T>): Promise<T> {
  const client = supabase as unknown as { from: unknown };
  const real = client.from;
  client.from = db.from;
  try { return await fn(); } finally { client.from = real; }
}

await test('a buyer named only after 1,000 other references is set Inactive, not deleted', async () => {
  // Buyer 1 is on 1,200 offers; buyer 2 is on one offer, listed after them.
  const db = fakeDb({ offers: [...Array(1200).fill(1), 2] });
  const out = await withDb(db, () => deleteBuyers(['b1', 'b2', 'b3']));
  assert.deepEqual(db.deleted, [3]);
  assert.deepEqual(db.deactivated.sort(), [1, 2]);
  assert.equal(out.ok, true);
  assert.equal(out.deleted, 1);
  assert.equal(out.deactivated, 2);
});

await test('references in each table count', async () => {
  const db = fakeDb({ deals: [1], deal_parties: [2], transactions: [3], contracts: [4] });
  await withDb(db, () => deleteBuyers(['b1', 'b2', 'b3', 'b4', 'b5']));
  assert.deepEqual(db.deleted, [5]);
  assert.deepEqual(db.deactivated.sort(), [1, 2, 3, 4]);
});

await test('batches of 200 still apply', async () => {
  const db = fakeDb({});
  const ids = Array.from({ length: 450 }, (_, i) => 'b' + (i + 1));
  const out = await withDb(db, () => deleteBuyers(ids));
  assert.equal(out.deleted, 450);
  assert.equal(db.deactivated.length, 0);
});

console.log(`delete-buyers: ${passed} passed`);
