// The Tasks screen's "Complete all shown": which ids it ticks (lib/task-views
// openShownIds), the bulk write in batches of 500 with the ids that did not
// save (lib/crm-write setTasksDone, against a fake client), and a failed write
// putting back only those ids (revertFailed).
// Run: npx tsx tools/tasks-bulk-done.test.ts
import assert from 'node:assert/strict';
import { setTasksDone } from '../lib/crm-write';
import { supabase } from '../lib/supabase';
import { D, type TcChecklist } from '../lib/clozr-types';
import { openShownIds, revertFailed } from '../lib/task-views';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

type Call = { table: string; op: 'select' | 'update'; patch: Record<string, unknown> | null; ids: number[]; cols: string };

/**
 * A pretend tasks table. `refuse(n)` fails the n-th update (0-based) whole, as
 * a statement does; `hidden` rows match no update (gone, or another
 * workspace's), so the update answers without them.
 */
function fakeDb(opts: { refuse?: (n: number) => boolean; hidden?: number[]; titles?: Record<number, string> } = {}) {
  const calls: Call[] = [];
  let updates = 0;
  const from = (table: string) => {
    const c: Call = { table, op: 'select', patch: null, ids: [], cols: '' };
    const q = {
      update: (patch: Record<string, unknown>) => { c.op = 'update'; c.patch = patch; return q; },
      select: (cols: string) => { c.cols = cols; return q; },
      in: (_k: string, v: number[]) => { c.ids = v; return q; },
      eq: () => q, order: () => q, limit: () => q,
      maybeSingle: () => q,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        calls.push(c);
        const answer = (): { data: unknown; error: { message: string } | null } => {
          if (table !== 'tasks') return { data: null, error: null };
          if (opts.refuse?.(updates++)) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
          const rows = c.ids.filter((id) => !(opts.hidden ?? []).includes(id))
            .map((id) => ({ id, title: opts.titles?.[id] ?? 'Plain task ' + id, seller_id: 1, deal_id: null, workspace_id: 11 }));
          return { data: rows, error: null };
        };
        return Promise.resolve().then(answer).then(res, rej);
      },
    };
    return q;
  };
  return { from, calls };
}

async function withDb<T>(db: ReturnType<typeof fakeDb>, fn: () => Promise<T>): Promise<T> {
  const client = supabase as unknown as { from: unknown };
  const real = client.from;
  client.from = db.from;
  try { return await fn(); } finally { client.from = real; }
}

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => 'k' + (from + i));
const updatesOf = (calls: Call[]) => calls.filter((c) => c.table === 'tasks' && c.op === 'update');

await test('1,201 tasks are three updates of 500, 500 and 201, one after another, and all save', async () => {
  const db = fakeDb();
  const out = await withDb(db, () => setTasksDone(ids(1201), true, 'u1'));
  const ups = updatesOf(db.calls);
  assert.deepEqual(ups.map((c) => c.ids.length), [500, 500, 201]);
  assert.deepEqual(ups[0]!.ids.slice(0, 2), [1, 2]);
  assert.deepEqual(out.failed, []);
  assert.equal(out.message, undefined);
});

await test('the same columns as one tick: done and completed_at, nothing else', async () => {
  const db = fakeDb();
  await withDb(db, () => setTasksDone(ids(3), true, 'u1'));
  const [up] = updatesOf(db.calls);
  assert.deepEqual(Object.keys(up!.patch!).sort(), ['completed_at', 'done']);
  assert.equal(up!.patch!.done, true);
  assert.ok(!Number.isNaN(Date.parse(String(up!.patch!.completed_at))));
  const db2 = fakeDb();
  await withDb(db2, () => setTasksDone(ids(3), false, 'u1'));
  assert.deepEqual(updatesOf(db2.calls)[0]!.patch, { done: false, completed_at: null });
});

await test('a refused batch fails its own 500 ids; the batches around it still save', async () => {
  const db = fakeDb({ refuse: (n) => n === 1 });
  const out = await withDb(db, () => setTasksDone(ids(1201), true, 'u1'));
  assert.equal(updatesOf(db.calls).length, 3);
  assert.deepEqual(out.failed, ids(500, 501));
  assert.match(out.message ?? '', /statement timeout/);
});

await test('a row the update does not come back with, and an id that is not a task, did not save', async () => {
  const db = fakeDb({ hidden: [2] });
  const out = await withDb(db, () => setTasksDone(['k1', 'k2', 'k_demo', 'k3'], true, 'u1'));
  assert.deepEqual(out.failed.sort(), ['k2', 'k_demo']);
  assert.deepEqual(updatesOf(db.calls)[0]!.ids, [1, 2, 3]);
});

await test('a TC checklist task still ticks its line; other tasks read no file', async () => {
  const line = Object.values(D.tcChecklists as Record<string, TcChecklist>)[0]!.phases[0]!.tasks[0]!.t;
  const db = fakeDb({ titles: { 2: line } });
  await withDb(db, () => setTasksDone(ids(3), true, 'u1'));
  assert.equal(db.calls.filter((c) => c.table === 'transactions').length, 1);
});

await test('"shown" is the open rows the list draws, in its order; a done or fading row is left out', () => {
  const rows = [{ id: 'k3', done: false }, { id: 'k1', done: true }, { id: 'k2', done: false }];
  assert.deepEqual(openShownIds(rows), ['k3', 'k2']);
  assert.deepEqual(openShownIds([{ id: 'k1', done: true }]), []);
});

await test('a failed write puts back only the ids that failed', () => {
  // Ticked done in bulk: a and b were open when loaded; c was loaded done and
  // re-opened earlier this session, so only its override says it was open.
  const over = { a: true, b: true, c: true, d: false };
  const loaded: Record<string, boolean> = { a: false, b: false, c: true, d: true };
  const next = revertFailed(over, ['b', 'c'], true, (id) => loaded[id]);
  assert.deepEqual(next, { a: true, c: false, d: false });
  assert.deepEqual(over, { a: true, b: true, c: true, d: false }, 'the old overrides are not changed in place');
  assert.equal(revertFailed(over, [], true, (id) => loaded[id]), over, 'nothing failed: the same object, no redraw');
  // Undo (re-open) that failed: the task is done in the database.
  assert.deepEqual(revertFailed({ a: false }, ['a'], false, () => false), { a: true });
});

console.log(`tasks-bulk-done: ${passed} passed`);
