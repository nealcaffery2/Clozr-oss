// enrollMany: bulk plan enrolment in a few requests per 200 records, with the
// same outcome per record as one at a time. Runs against a fake client.
// Run: npx tsx tools/enroll-many.test.ts
import assert from 'node:assert/strict';
import { enrollMany, enrollSellersInPlan, type EnrollJob } from '../lib/crm-write';
import { supabase } from '../lib/supabase';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

type Row = Record<string, unknown>;
type Call = { table: string; op: 'select' | 'insert' | 'upsert'; rows: Row[]; filters: [string, string, unknown][]; single: boolean };

/**
 * A pretend database: enrollments (some already running), tasks, rvm_drops.
 * `badKeys` makes an enrolment insert fail when it carries that seller; a
 * statement with any bad row fails whole, as Postgres does. `badTaskEnrollments`
 * does the same for task rows. `failRead(n)` fails the n-th already-on read
 * (0-based); `lostInsert` saves the first batch insert but answers with an
 * error, as a dropped response does. `steps` / `sellers` serve
 * enrollSellersInPlan's reads; `stepsError` / `sellersError` fail them.
 */
function fakeDb(opts: {
  running?: { id: number; seller_id: number; status: string }[]; badKeys?: number[]; badTaskEnrollments?: number[];
  failRead?: (n: number) => boolean; lostInsert?: boolean;
  steps?: Row[]; sellers?: Row[]; stepsError?: boolean; sellersError?: boolean;
} = {}) {
  const calls: Call[] = [];
  const enrollments = [...(opts.running ?? [])];
  const tasks: Row[] = [];
  const drops: Row[] = [];
  let nextId = 1000;
  let reads = 0;
  let lost = !!opts.lostInsert;
  const run = (c: Call): { data: unknown; error: { message: string } | null } => {
    if (c.table === 'action_plan_steps') return opts.stepsError ? { data: null, error: { message: 'steps read timed out' } } : { data: opts.steps ?? [], error: null };
    if (c.table === 'sellers') return opts.sellersError ? { data: null, error: { message: 'sellers read timed out' } } : { data: opts.sellers ?? [], error: null };
    if (c.table === 'enrollments' && c.op === 'select') {
      if (opts.failRead?.(reads++)) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      const ins = c.filters.find((f) => f[0] === 'in')![2] as number[];
      return { data: enrollments.filter((e) => ins.includes(e.seller_id) && e.status !== 'done').sort((a, b) => a.id - b.id), error: null };
    }
    if (c.table === 'enrollments' && c.op === 'insert') {
      if (c.rows.some((r) => (opts.badKeys ?? []).includes(r.seller_id as number))) return { data: null, error: { message: 'insert or update on table "enrollments" violates foreign key constraint' } };
      const made = c.rows.map((r) => ({ id: nextId++, seller_id: r.seller_id as number, buyer_id: null, status: 'active' }));
      enrollments.push(...made);
      if (lost) { lost = false; return { data: null, error: { message: 'Failed to fetch' } }; }
      return { data: c.single ? made[0] : made, error: null };
    }
    if (c.table === 'tasks') {
      if (c.rows.some((r) => (opts.badTaskEnrollments ?? []).includes(r.enrollment_id as number))) return { data: null, error: { message: 'tasks refused' } };
      tasks.push(...c.rows);
      return { data: null, error: null };
    }
    if (c.table === 'rvm_drops') { drops.push(...c.rows); return { data: null, error: null }; }
    throw new Error('unexpected ' + c.table + ' ' + c.op);
  };
  const from = (table: string) => {
    const c: Call = { table, op: 'select', rows: [], filters: [], single: false };
    const q = {
      select: () => q,
      insert: (rows: Row | Row[]) => { c.op = 'insert'; c.rows = Array.isArray(rows) ? rows : [rows]; return q; },
      upsert: (rows: Row[]) => { c.op = 'upsert'; c.rows = rows; return q; },
      eq: (k: string, v: unknown) => { c.filters.push(['eq', k, v]); return q; },
      neq: (k: string, v: unknown) => { c.filters.push(['neq', k, v]); return q; },
      in: (k: string, v: unknown) => { c.filters.push(['in', k, v]); return q; },
      order: () => q,
      single: () => { c.single = true; return q; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => { calls.push(c); return Promise.resolve().then(() => run(c)).then(res, rej); },
    };
    return q;
  };
  return { db: { from } as never, calls, enrollments, tasks, drops };
}

/** A seller with two steps (a text and an RVM) and one drop. */
const job = (key: number): EnrollJob => ({
  key,
  tasks: (enrollmentId, now) => [
    { seller_id: key, enrollment_id: enrollmentId, plan_step_id: 1, due_at: new Date(now).toISOString() },
    { seller_id: key, enrollment_id: enrollmentId, plan_step_id: 2, due_at: new Date(now + 60_000).toISOString() },
  ],
  drops: (enrollmentId) => [{ seller_id: key, enrollment_id: enrollmentId, plan_step_id: 2 }],
});
const count = (calls: Call[], table: string, op: Call['op']) => calls.filter((c) => c.table === table && c.op === op).length;

await test('one read, one enrolment insert, one task upsert and one drop insert for a batch', async () => {
  const f = fakeDb({ running: [{ id: 7, seller_id: 2, status: 'active' }] });
  const out = await enrollMany(11, 5, 'seller_id', [1, 2, 3].map(job), 'u1', false, f.db);
  assert.deepEqual(out.map((o) => [o.already ?? false, o.queued, !!o.error]), [[false, 2, false], [true, 0, false], [false, 2, false]]);
  assert.equal(out[1]!.id, 7);
  assert.equal(count(f.calls, 'enrollments', 'select'), 1);
  assert.equal(count(f.calls, 'enrollments', 'insert'), 1);
  assert.equal(count(f.calls, 'tasks', 'upsert'), 1);
  assert.equal(count(f.calls, 'rvm_drops', 'insert'), 1);
  // Same rows as one at a time: each new enrolment gets its own tasks and drop, keyed to its id.
  const ids = f.enrollments.filter((e) => e.id >= 1000);
  assert.deepEqual(ids.map((e) => e.seller_id), [1, 3]);
  assert.deepEqual(f.tasks.map((t) => [t.seller_id, t.enrollment_id, t.plan_step_id]), [[1, 1000, 1], [1, 1000, 2], [3, 1001, 1], [3, 1001, 2]]);
  assert.deepEqual(f.drops.map((d) => [d.seller_id, d.enrollment_id]), [[1, 1000], [3, 1001]]);
  const ins = f.calls.find((c) => c.table === 'enrollments' && c.op === 'insert')!;
  assert.deepEqual(ins.rows[0], { workspace_id: 11, plan_id: 5, seller_id: 1, created_by: 'u1' });
});

await test('a refused batch is retried one at a time: only the bad record fails', async () => {
  const f = fakeDb({ badKeys: [2] });
  const out = await enrollMany(11, 5, 'seller_id', [1, 2, 3].map(job), 'u1', false, f.db);
  assert.deepEqual(out.map((o) => [o.queued, !!o.error]), [[2, false], [0, true], [2, false]]);
  assert.match(out[1]!.error!.message, /foreign key/);
  assert.deepEqual(f.enrollments.map((e) => e.seller_id), [1, 3]);
  assert.deepEqual(f.drops.map((d) => d.seller_id), [1, 3]);
});

await test('stopAtError: nothing after the first refusal is tried, the ones before keep their tasks', async () => {
  const f = fakeDb({ badKeys: [2] });
  const out = await enrollMany(11, 5, 'seller_id', [1, 2, 3, 4].map(job), 'u1', true, f.db);
  assert.deepEqual(out.map((o) => [o.queued, !!o.error]), [[2, false], [0, true], [0, true], [0, true]]);
  assert.deepEqual(f.enrollments.map((e) => e.seller_id), [1]);
  assert.deepEqual(f.tasks.map((t) => t.seller_id), [1, 1]);
});

await test('stopAtError reaches later batches of 200 too', async () => {
  const f = fakeDb({ badKeys: [5] });
  const out = await enrollMany(11, 5, 'seller_id', Array.from({ length: 450 }, (_, i) => job(i + 1)), 'u1', true, f.db);
  assert.equal(out.filter((o) => o.queued).length, 4);
  assert.equal(out.filter((o) => o.error).length, 446);
  // The batch's check and the second check before going one by one; later batches are never read.
  assert.equal(count(f.calls, 'enrollments', 'select'), 2);
});

await test('refused tasks fail only that enrolment: no drop for it, the rest queue', async () => {
  const f = fakeDb({ badTaskEnrollments: [1001] });
  const out = await enrollMany(11, 5, 'seller_id', [1, 2, 3].map(job), 'u1', false, f.db);
  assert.deepEqual(out.map((o) => [o.id, o.queued, !!o.tasksError, !!o.error]), [[1000, 2, false, false], [1001, 0, true, false], [1002, 2, false, false]]);
  assert.deepEqual(f.drops.map((d) => d.seller_id), [1, 3]);
});

await test('a record listed twice is enrolled once, the second reads as already on it', async () => {
  const f = fakeDb();
  const out = await enrollMany(11, 5, 'seller_id', [1, 1, 2].map(job), 'u1', false, f.db);
  assert.deepEqual(out.map((o) => [o.id, o.already ?? false, o.queued]), [[1000, false, 2], [1000, true, 0], [1001, false, 2]]);
  assert.equal(f.enrollments.length, 2);
});

await test('450 records: three batches of reads and writes, not 450 of each', async () => {
  const f = fakeDb();
  const out = await enrollMany(11, 5, 'seller_id', Array.from({ length: 450 }, (_, i) => job(i + 1)), 'u1', false, f.db);
  assert.equal(out.filter((o) => o.queued === 2).length, 450);
  assert.equal(f.calls.length, 12);
  const firstIn = f.calls.find((c) => c.op === 'select')!.filters.find((x) => x[0] === 'in')![2] as number[];
  assert.equal(firstIn.length, 200);
});

await test('a plan with no steps to queue enrols and queues nothing, no drops', async () => {
  const f = fakeDb();
  const out = await enrollMany(11, 5, 'seller_id', [{ key: 9, tasks: () => [], drops: () => [{ x: 1 }] }], 'u1', false, f.db);
  assert.deepEqual([out[0]!.id, out[0]!.queued], [1000, 0]);
  assert.equal(count(f.calls, 'tasks', 'upsert'), 0);
  assert.equal(count(f.calls, 'rvm_drops', 'insert'), 0);
});

await test('an unusable id fails alone and is never sent', async () => {
  const f = fakeDb();
  const out = await enrollMany(11, 5, 'seller_id', [job(Number.NaN), job(3)], 'u1', false, f.db);
  assert.equal(out[0]!.error?.message, 'Unknown record.');
  assert.equal(out[1]!.queued, 2);
  assert.deepEqual(f.calls.find((c) => c.op === 'select')!.filters.find((x) => x[0] === 'in')![2], [3]);
});

await test('a failed already-on read fails its batch and writes nothing for it', async () => {
  const f = fakeDb({ failRead: (n) => n === 1 });
  const out = await enrollMany(11, 5, 'seller_id', Array.from({ length: 450 }, (_, i) => job(i + 1)), 'u1', false, f.db);
  assert.equal(out.slice(0, 200).filter((o) => o.queued === 2).length, 200);
  assert.ok(out.slice(200, 400).every((o) => o.queued === 0 && /statement timeout/.test(o.error?.message ?? '')));
  assert.equal(out.slice(400).filter((o) => o.queued === 2).length, 50);
  // Batch 2 inserted nothing: no enrolment, task or drop for sellers 201 to 400.
  const inBatch2 = (id: unknown) => (id as number) > 200 && (id as number) <= 400;
  assert.equal(f.enrollments.filter((e) => inBatch2(e.seller_id)).length, 0);
  assert.equal(f.tasks.filter((t) => inBatch2(t.seller_id)).length, 0);
  assert.equal(f.drops.filter((d) => inBatch2(d.seller_id)).length, 0);
  assert.equal(count(f.calls, 'enrollments', 'insert'), 2);
});

await test('a failed already-on read with stopAtError stops everything, nothing written', async () => {
  const f = fakeDb({ running: [{ id: 7, seller_id: 2, status: 'active' }], failRead: () => true });
  const out = await enrollMany(11, 5, 'seller_id', Array.from({ length: 250 }, (_, i) => job(i + 1)), 'u1', true, f.db);
  assert.ok(out.every((o) => o.error && !o.queued && !o.already));
  assert.equal(count(f.calls, 'enrollments', 'select'), 1);
  assert.equal(count(f.calls, 'enrollments', 'insert'), 0);
  assert.equal(f.tasks.length + f.drops.length, 0);
});

await test('a refused batch whose second already-on read fails writes nothing one by one', async () => {
  const f = fakeDb({ badKeys: [2], failRead: (n) => n === 1 });
  const out = await enrollMany(11, 5, 'seller_id', [1, 2, 3].map(job), 'u1', false, f.db);
  assert.ok(out.every((o) => o.error && !o.queued));
  assert.equal(count(f.calls, 'enrollments', 'insert'), 1);
  assert.equal(f.enrollments.length, 0);
});

await test('a batch saved but answered with an error is not enrolled twice', async () => {
  const f = fakeDb({ lostInsert: true });
  const out = await enrollMany(11, 5, 'seller_id', [1, 2, 3].map(job), 'u1', false, f.db);
  assert.equal(f.enrollments.length, 3);
  assert.ok(out.every((o) => o.already && !o.error));
  assert.equal(count(f.calls, 'enrollments', 'insert'), 1);
  assert.equal(f.drops.length, 0);
});

await test('enrollSellersInPlan: a failed steps or sellers read enrols nobody', async () => {
  const steps = [{ id: 1, position: 0, channel: 'sms', delay_minutes: 0, title: 'Hi', body: 'Hi {{first_name}}', config: {} }];
  const sellers = [{ id: 1, name: 'Ann', phone: '2105550101', tags: [], assigned_to: null, property_address: null, properties: null }];
  const client = supabase as unknown as { from: unknown };
  const real = client.from;
  try {
    for (const bad of [{ stepsError: true }, { sellersError: true }]) {
      const f = fakeDb({ steps, sellers, ...bad });
      client.from = (f.db as unknown as { from: unknown }).from;
      const out = await enrollSellersInPlan(11, 'ap5', ['s1'], 'u1');
      assert.equal(out[0]!.ok, false);
      assert.match(out[0]!.message ?? '', /timed out/);
      assert.equal(count(f.calls, 'enrollments', 'select') + count(f.calls, 'enrollments', 'insert'), 0);
    }
    const f = fakeDb({ steps, sellers });
    client.from = (f.db as unknown as { from: unknown }).from;
    const ok = await enrollSellersInPlan(11, 'ap5', ['s1'], 'u1');
    assert.deepEqual([ok[0]!.ok, ok[0]!.queued], [true, 1]);
  } finally {
    client.from = real;
  }
});

console.log(`enroll-many: ${passed} passed`);
