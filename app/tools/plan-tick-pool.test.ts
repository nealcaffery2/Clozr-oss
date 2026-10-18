// plan-tick's pool: claimed rows five at a time, one workspace's inbox pool
// read once per tick and counted locally, the bounded cold_sends read, the
// health hold before a claim, two overlapping ticks that must not send
// anything twice, and a sent step whose done write fails.
// Run: npx tsx tools/plan-tick-pool.test.ts
import assert from 'node:assert/strict';
import {
  HELD_AS_SENT, POOL, afterThrow, buildPool, closeSent, dropPool, eachClaimed, holdUnhealthy, noteSend, readHealth, sendsSince, sentSteps, serial, withPool,
  type Pool, type PoolSlot, type SendRow,
} from '../supabase/functions/plan-tick/pool';
import {
  DEFAULT_COLD_DELIVERABILITY, mailboxDayStart, mailboxGapSeconds, mailboxSkip, pickPoolMailbox, poolPauseReason,
  type ColdDeliverability, type ColdMailbox,
} from '../supabase/functions/_shared/cold-campaign';
import type { Health } from '../supabase/functions/cold-campaign-tick/tick';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

const NOW = new Date('2026-10-06T15:00:00.000Z'); // Tuesday 10:00 in Chicago
const POLICY: ColdDeliverability = { ...DEFAULT_COLD_DELIVERABILITY, restDays: false, jitterPct: 0, warmupDaily: 0 };
const NO_GAP: ColdDeliverability = { ...POLICY, gapMinSeconds: 0, gapMaxSeconds: 0 };

type Box = Record<string, string | number | boolean | null>;
const box = (id: number, domainId: number, over: Box = {}): Box => ({
  id, domain_id: domainId, email: `rep${id}@d${domainId}.com`, paused: false, status: 'active',
  daily_cap: 3, hourly_cap: 2, min_gap_seconds: 0, timezone: 'America/Chicago',
  ramp_enabled: false, ramp_start: 3, ramp_increase_pct: 0, ramp_target: 3, ramp_started_on: '2026-09-01',
  warmup_daily: null, rest_weekday: null, signature: null, ...over,
});
const dom = (id: number, cap = 5) => ({ id, domain: `d${id}.com`, daily_cap: cap, paused: false, blocking: [], checked_at: '2026-10-12T00:00:00.000Z', tracking_domain: null });
const pick = (pool: Pool, policy: ColdDeliverability, busy: ReadonlySet<number> = new Set()) =>
  pickPoolMailbox(pool.mailboxes.filter((m) => !busy.has(m.id)), pool.domains, [], 0, NOW, policy)?.mailbox ?? null;

// ---------------------------------------------------------------- locks
await test('serial runs jobs one at a time in call order, and a throw does not stop the next', async () => {
  const run = serial();
  const log: string[] = [];
  const a = run(async () => { log.push('a1'); await sleep(10); log.push('a2'); });
  const b = run(async () => { log.push('b1'); throw new Error('boom'); });
  const c = run(async () => { log.push('c1'); return 7; });
  await a;
  await assert.rejects(b, /boom/);
  assert.equal(await c, 7);
  assert.deepEqual(log, ['a1', 'a2', 'b1', 'c1']);
});

await test('eachClaimed: every row once, at most POOL in flight, one record never overlaps and keeps claim order', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, record: `r${i % 3}` }));
  let live = 0; let peak = 0;
  const active = new Set<string>();
  const order = new Map<string, number[]>();
  const seen: number[] = [];
  await eachClaimed(rows, (r) => r.record, async (r) => {
    assert.ok(!active.has(r.record), `record ${r.record} ran twice at once`);
    active.add(r.record); live++; peak = Math.max(peak, live); seen.push(r.id);
    order.set(r.record, [...(order.get(r.record) ?? []), r.id]);
    await sleep(1 + (r.id % 5));
    active.delete(r.record); live--;
  });
  assert.ok(peak <= POOL && peak > 1, `peak ${peak}`);
  assert.deepEqual([...seen].sort((a, b) => a - b), rows.map((r) => r.id));
  for (const ids of order.values()) assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

// ---------------------------------------------------- the bounded read
await test('sendsSince: the rows it drops change no count, no skip, no pick and no claim gap test', () => {
  const raw = [box(1, 1), box(2, 1, { timezone: 'America/Los_Angeles' }), box(3, 2, { timezone: 'Pacific/Auckland' }), box(4, 2, { daily_cap: 40, ramp_target: 40, hourly_cap: 40 })];
  const domains = [dom(1, 50), dom(2, 50)];
  const r = rand(42);
  for (let trial = 0; trial < 300; trial++) {
    const now = new Date(NOW.getTime() + Math.floor(r() * 7 * 86_400_000));
    const policy = trial % 2 ? POLICY : { ...POLICY, gapMinSeconds: 600, gapMaxSeconds: 7200 };
    const rows: SendRow[] = Array.from({ length: Math.floor(r() * 30) }, () => ({
      mailbox_id: 1 + Math.floor(r() * 4), sent_at: new Date(now.getTime() - Math.floor(r() * 26 * 3_600_000)).toISOString(),
    }));
    const since = sendsSince(raw, now, policy.gapMaxSeconds).getTime();
    const full = buildPool(raw, domains, rows, now, false);
    const bounded = buildPool(raw, domains, rows.filter((s) => Date.parse(s.sent_at) >= since), now, false);
    for (const [i, m] of full.mailboxes.entries()) {
      const b = bounded.mailboxes[i]!;
      assert.equal(b.sentToday, m.sentToday);
      assert.equal(b.sentLastHour, m.sentLastHour);
      assert.equal(mailboxSkip(b, bounded.domains.find((d) => d.id === b.domainId), [], now, policy),
        mailboxSkip(m, full.domains.find((d) => d.id === m.domainId), [], now, policy), `skip, trial ${trial}`);
      if (b.lastSentAt !== m.lastSentAt) assert.ok(b.lastSentAt === null && Date.parse(m.lastSentAt!) < since);
      // cold_send_claim's gap test, given the gap each pool would pass it.
      const start = Math.min(mailboxDayStart(m.settings, now).getTime(), now.getTime() - 3_600_000);
      const vLast = rows.filter((s) => s.mailbox_id === m.id && Date.parse(s.sent_at) >= start).reduce((x, s) => Math.max(x, Date.parse(s.sent_at)), 0);
      const blocks = (gap: number) => gap > 0 && vLast > 0 && vLast > now.getTime() - gap * 1000;
      assert.equal(blocks(mailboxGapSeconds(b, now, policy)), blocks(mailboxGapSeconds(m, now, policy)), `claim gap, trial ${trial}`);
    }
    assert.deepEqual(bounded.domains.map((d) => d.sentToday), full.domains.map((d) => d.sentToday));
    assert.equal(pickPoolMailbox(bounded.mailboxes, bounded.domains, [], trial, now, policy)?.mailbox.id,
      pickPoolMailbox(full.mailboxes, full.domains, [], trial, now, policy)?.mailbox.id);
  }
});

// ------------------------------------------------- local cap accounting
await test('noteSend: the tick pool picks what a fresh read of cold_sends would pick, send after send', () => {
  for (const policy of [POLICY, NO_GAP]) {
    const raw = [box(1, 1), box(2, 1), box(3, 2), box(4, 2, { hourly_cap: 1 })];
    const domains = [dom(1, 4), dom(2, 5)];
    const rows: SendRow[] = [{ mailbox_id: 3, sent_at: new Date(NOW.getTime() - 20 * 60_000).toISOString() }];
    const cached = buildPool(raw, domains, rows, NOW, false);
    const used: number[] = [];
    for (;;) {
      const fresh = buildPool(raw, domains, rows, NOW, false);
      const a = pick(cached, policy);
      const b = pick(fresh, policy);
      assert.equal(a?.id ?? null, b?.id ?? null, `send ${used.length + 1}`);
      if (!a) break;
      const at = NOW.toISOString();
      noteSend(cached, a.id, at);
      rows.push({ mailbox_id: a.id, sent_at: at });
      used.push(a.id);
    }
    // POLICY: each inbox once (gap). NO_GAP: hourly caps 2, 2, 1 left, 1, and domain 1 stops at 4.
    assert.deepEqual(used, policy === POLICY ? [1, 2, 3, 4] : [1, 1, 2, 2, 3, 4]);
    assert.deepEqual(cached.domains.map((d) => d.sentToday), buildPool(raw, domains, rows, NOW, false).domains.map((d) => d.sentToday));
  }
});

// ----------------------------------------------------------- withPool
await test('withPool: reads once per tick, reads again only when a claim on the old read is refused', async () => {
  let loads = 0;
  const empty = (): Promise<Pool> => { loads++; return Promise.resolve({ mailboxes: [], domains: [], raw: [] }); };
  const slot: PoolSlot = { pool: null, lock: serial() };
  assert.equal(await withPool(slot, empty, async () => 'sent'), 'sent');
  assert.equal(await withPool(slot, empty, async () => 'sent'), 'sent');
  assert.equal(loads, 1, 'the second step uses the tick read');
  let tries = 0;
  assert.equal(await withPool(slot, empty, async () => (++tries === 1 ? 'refused' : 'sent')), 'sent');
  assert.equal(loads, 2, 'a refusal on the old read reads again');
  tries = 0;
  assert.equal(await withPool(slot, empty, async () => { tries++; return 'refused'; }), 'refused');
  assert.equal(tries, 2, 'one retry, no more');
  await dropPool(slot);
  tries = 0;
  assert.equal(await withPool(slot, empty, async () => { tries++; return 'refused'; }), 'refused');
  assert.equal(tries, 1, 'a refusal on a read made for this step is final');
  assert.equal(loads, 4);
  await dropPool(slot);
  await assert.rejects(withPool(slot, () => Promise.reject(new Error('unread')), async () => 'sent'), /unread/);
  assert.equal(slot.pool, null, 'a failed read is not kept');
});

await test('withPool: picks and claims of one workspace never overlap', async () => {
  const slot: PoolSlot = { pool: null, lock: serial() };
  let inside = 0;
  await Promise.all(Array.from({ length: 12 }, (_, i) => withPool(slot, async () => ({ mailboxes: [], domains: [], raw: [] }), async () => {
    inside++;
    assert.equal(inside, 1);
    await sleep(i % 3);
    inside--;
    return i;
  })));
});

// -------------------------------------------- two overlapping ticks
// A fake database: plan_send_claim (claim older than 10 minutes is free
// again, two ticks never take one task), cold_send_claim (counts cold_sends
// under its mailbox lock, which JS gives for free), and an inbox send.
type Task = { id: number; record: string; claimedAt: number | null; done: boolean };
type Row = { id: number; mailbox_id: number; sent_at: string; status: 'queued' | 'sent' | 'failed'; task: number };
function world(policy: ColdDeliverability, failEvery = 0) {
  const raw = [box(1, 1), box(2, 1), box(3, 2), box(4, 2), box(5, 3), box(6, 3)];
  const domains = [dom(1, 3), dom(2, 5), dom(3, 5)];
  const tasks: Task[] = Array.from({ length: 34 }, (_, i) => ({ id: i + 1, record: `b${1 + (i % 4)}`, claimedAt: null, done: false }));
  const db = { rows: [] as Row[], next: 1, sends: new Map<number, number>(), loads: 0 };
  const planClaim = (limit: number) => {
    const free = tasks.filter((t) => !t.done && (t.claimedAt === null || t.claimedAt < NOW.getTime() - 600_000)).slice(0, limit);
    for (const t of free) t.claimedAt = NOW.getTime();
    return free.map((t) => ({ ...t }));
  };
  const live = () => db.rows.filter((r) => r.status !== 'failed');
  const loadPool = async () => {
    db.loads++;
    await sleep(1);
    const since = sendsSince(raw, NOW, policy.gapMaxSeconds).getTime();
    return buildPool(raw, domains, live().filter((r) => Date.parse(r.sent_at) >= since), NOW, false);
  };
  const coldClaim = (m: ColdMailbox, gap: number, task: number) => {
    const mine = live().filter((r) => r.mailbox_id === m.id);
    const dayStart = mailboxDayStart(m.settings, NOW).getTime();
    const today = mine.filter((r) => Date.parse(r.sent_at) >= dayStart).length;
    const hour = mine.filter((r) => Date.parse(r.sent_at) >= NOW.getTime() - 3_600_000).length;
    const last = mine.reduce((x, r) => Math.max(x, Date.parse(r.sent_at)), 0);
    const domainToday = live().filter((r) => raw.find((b) => b.id === r.mailbox_id)!.domain_id === m.domainId && Date.parse(r.sent_at) >= dayStart).length;
    const cap = domains.find((d) => d.id === m.domainId)!.daily_cap;
    if (today + 1 > m.settings.daily_cap || hour + 1 > m.settings.hourly_cap || domainToday + 1 > cap || (gap > 0 && last > NOW.getTime() - gap * 1000)) return null;
    const row: Row = { id: db.next++, mailbox_id: m.id, sent_at: NOW.toISOString(), status: 'queued', task };
    db.rows.push(row);
    return row;
  };
  // index.ts coldEmail from the pick to the send, on the fakes.
  type Tick = PoolSlot & { busy: Set<number>; flight: Set<number> };
  const step = async (t: Task, ws: Tick) => {
    const got = await withPool(ws, loadPool, async (pool) => {
      const m = pick(pool, policy, ws.busy);
      if (!m) return { wait: 'no warmed inbox has room' };
      await sleep(1); // cold_send_claim round trip
      const row = coldClaim(m, mailboxGapSeconds(m, NOW, policy), t.id);
      if (!row) return 'refused';
      noteSend(pool, m.id, row.sent_at);
      ws.busy.add(m.id);
      return { row, m };
    });
    const task = tasks.find((x) => x.id === t.id)!;
    if (got === 'refused' || 'wait' in got) { task.claimedAt = null; task.done = true; return; } // released 15 min: out of this test
    const { row, m } = got;
    try {
      assert.ok(!ws.flight.has(m.id), `inbox ${m.id} had two sends in flight`);
      ws.flight.add(m.id);
      await sleep(1 + (t.id % 4));
      ws.flight.delete(m.id);
      if (failEvery && t.id % failEvery === 0) {
        db.rows = db.rows.filter((r) => r.id !== row.id);
        await dropPool(ws);
        task.claimedAt = null; task.done = true;
        return;
      }
      row.status = 'sent';
      db.sends.set(t.id, (db.sends.get(t.id) ?? 0) + 1);
      task.done = true; task.claimedAt = null;
    } finally {
      ws.busy.delete(m.id);
    }
  };
  const tick = async () => {
    const rows = planClaim(20);
    const ws: Tick = { pool: null, lock: serial(), busy: new Set(), flight: new Set() };
    const active = new Set<string>();
    await eachClaimed(rows, (r) => r.record, async (r) => {
      assert.ok(!active.has(r.record), `record ${r.record} overlapped`);
      active.add(r.record);
      await sleep(r.id % 3); // stillRunning, loadPerson, suppressions
      await step(r, ws);
      active.delete(r.record);
    });
    return rows.map((r) => r.id);
  };
  // Today's loop: one row at a time, a fresh pool read for every step.
  const serialTick = async () => {
    for (const r of planClaim(20)) await step(r, { pool: null, lock: serial(), busy: new Set(), flight: new Set() });
  };
  const capsHeld = () => {
    for (const b of raw) {
      const mine = live().filter((r) => r.mailbox_id === b.id);
      assert.ok(mine.length <= Number(b.daily_cap) && mine.length <= Number(b.hourly_cap), `inbox ${b.id} over its cap`);
    }
    for (const d of domains) assert.ok(live().filter((r) => raw.find((b) => b.id === r.mailbox_id)!.domain_id === d.id).length <= d.daily_cap, `domain ${d.id} over its cap`);
  };
  return { db, tasks, tick, serialTick, capsHeld };
}

await test('two overlapping ticks take disjoint rows and send each step at most once, under every cap', async () => {
  for (const [policy, failEvery] of [[POLICY, 0], [NO_GAP, 0], [NO_GAP, 5]] as const) {
    const w = world(policy, failEvery);
    const a = w.tick();
    await sleep(2); // the second tick starts while the first is mid-send
    const b = w.tick();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.filter((id) => rb.includes(id)).length, 0, 'a task claimed by both ticks');
    assert.ok(ra.length === 20 && rb.length === 14);
    for (const n of w.db.sends.values()) assert.equal(n, 1, 'a step sent twice');
    assert.equal([...w.db.sends.keys()].length, w.db.rows.filter((r) => r.status === 'sent').length);
    w.capsHeld();
  }
});

// With the send gap on (production clamps it to 30 s or more), the pooled
// tick uses the same inboxes as the old loop.
await test('one pooled tick sends what the serial loop sent, with far fewer pool reads', async () => {
  {
    const pooled = world(POLICY);
    await pooled.tick();
    const old = world(POLICY);
    await old.serialTick();
    const used = (w: ReturnType<typeof world>) => w.db.rows.filter((r) => r.status === 'sent').map((r) => r.mailbox_id).sort((x, y) => x - y);
    assert.deepEqual(used(pooled), used(old));
    assert.equal(old.db.loads, 20, 'the serial loop read the pool for every step');
    assert.ok(pooled.db.loads <= 2, `pooled loads ${pooled.db.loads}`);
    pooled.capsHeld();
  }
});

// ------------------------------------------ the health hold before a claim
const counts = { sent7d: 3, bounced7d: 0, hardInLast50: 0, bulk30d: 3, unsub30d: 0, complaints7d: 0, replied7d: 0 };
const health = (): Health => ({
  mailboxes: [
    { id: 1, domainId: 1, email: null, paused: false, ...counts, bounced7d: 3, hardInLast50: 3 },
    { id: 2, domainId: 1, email: null, paused: false, ...counts, bounced7d: 2, hardInLast50: 2 },
    { id: 3, domainId: 2, email: null, paused: false, ...counts },
    { id: 4, domainId: 2, email: null, paused: true, ...counts, hardInLast50: 5 },
    { id: 5, domainId: 3, email: null, paused: false, ...counts },
  ],
  domains: [
    { id: 1, paused: false, ...counts, sent7d: 6, bounced7d: 5, hardInLast50: 5 },
    { id: 2, paused: false, ...counts },
    { id: 3, paused: false, ...counts, complaints7d: 1 },
  ],
});
const quietly = async <T>(fn: () => Promise<T>): Promise<{ value: T; logged: unknown[][] }> => {
  const keep = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try { return { value: await fn(), logged }; } finally { console.error = keep; }
};

await test('holdUnhealthy: marks off what the health pass would pause now, and nothing else', () => {
  const pool = buildPool([box(1, 1), box(2, 1), box(3, 2), box(4, 2, { paused: true }), box(5, 3)], [dom(1), dom(2), dom(3)], [], NOW, false);
  const h = health();
  const held = holdUnhealthy(pool, h, POLICY);
  // Three hard bounces in the last 50 (mailbox 1, domain 1); a complaint (domain 3). Mailbox 4 was paused already.
  assert.deepEqual(held, { mailboxes: [1], domains: [1, 3] });
  for (const b of h.mailboxes) if (!b.paused) assert.equal(held.mailboxes.includes(b.id), !!poolPauseReason({ ...b, policy: POLICY }), `mailbox ${b.id}`);
  for (const d of h.domains) assert.equal(held.domains.includes(d.id), !!poolPauseReason({ ...d, policy: POLICY }), `domain ${d.id}`);
  // The pick skips both: mailbox 2 sits on held domain 1, mailbox 5 on held domain 3.
  assert.equal(pick(pool, POLICY)?.id, 3);
  assert.deepEqual(holdUnhealthy(pool, h, POLICY), { mailboxes: [], domains: [] }, 'held once; it only ever marks off');
  // Without the hold (no reading) the same pool picks mailbox 1 first, as before.
  assert.equal(pick(buildPool([box(1, 1), box(2, 1), box(3, 2)], [dom(1), dom(2)], [], NOW, false), POLICY)?.id, 1);
});

await test('readHealth: a failed or missing cold_pool_health is logged and holds nothing back', async () => {
  const h = health();
  const ok = { rpc: async (name: string, args: Record<string, string>) => {
    assert.equal(name, 'cold_pool_health');
    assert.equal(Date.parse(args.p_since7), NOW.getTime() - 7 * 86_400_000);
    assert.equal(Date.parse(args.p_since30), NOW.getTime() - 30 * 86_400_000);
    return { data: h, error: null };
  } };
  assert.equal(await readHealth(ok, 13, NOW), h);
  for (const fails of [
    { rpc: async () => ({ data: null, error: { message: 'canceling statement due to statement timeout' } }) },
    { rpc: async () => ({ data: null, error: { message: 'Could not find the function public.cold_pool_health' } }) },
    { rpc: async () => { throw new Error('fetch failed'); } },
  ]) {
    const { value, logged } = await quietly(() => readHealth(fails, 13, NOW));
    assert.equal(value, null);
    assert.equal(logged.length, 1, 'logged');
  }
});

// --------------------------------- a sent step whose done write fails
// The tasks table as plan_send_claim and plan_kick read it: a task is free
// when it is not done and its claim is null or older than 10 minutes. In SQL
// 'infinity' is never older than anything; here it parses to Infinity.
type PlanTask = { id: number; done: boolean; plan_claim_at: string | null };
const claimedAt = (v: string) => (v === 'infinity' ? Infinity : Date.parse(v));
function taskDb(fails: (patch: Record<string, unknown>) => boolean | 'throw') {
  const tasks: PlanTask[] = [{ id: 1, done: false, plan_claim_at: null }, { id: 2, done: false, plan_claim_at: null }];
  const admin = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: number) => {
          assert.equal(table, 'tasks');
          const fail = fails(patch);
          if (fail === 'throw') throw new TypeError('fetch failed');
          if (fail) return { error: { message: 'plan_on_task_done: canceling statement due to statement timeout' } };
          Object.assign(tasks.find((t) => t.id === id)!, patch);
          return { error: null };
        },
      }),
    }),
  };
  const claim = (at: number) => tasks
    .filter((t) => !t.done && (t.plan_claim_at === null || claimedAt(t.plan_claim_at) < at - 600_000))
    .map((t) => { t.plan_claim_at = new Date(at).toISOString(); return t.id; });
  return { tasks, admin, claim };
}
const DONE = { done: true, completed_at: NOW.toISOString(), notes: null, plan_claim_at: null };
/** One plan-tick run: claim, send (always works here), then the done write. */
async function planRun(db: ReturnType<typeof taskDb>, at: number, sent: number[], close: (id: number) => Promise<unknown>) {
  for (const id of db.claim(at)) {
    sent.push(id);
    await close(id);
  }
}
const MIN = 60_000;

await test('a sent step whose done write keeps failing is held as sent: the next runs send nothing', async () => {
  const db = taskDb((p) => 'done' in p && p.done === true);
  const sent: number[] = [];
  const waits: number[] = [];
  const close = (id: number) => closeSent(db.admin, id, DONE, async (ms) => { waits.push(ms); });
  const { logged } = await quietly(async () => {
    await planRun(db, NOW.getTime(), sent, close);
    await planRun(db, NOW.getTime() + 11 * MIN, sent, close); // the reclaim that used to send again
    await planRun(db, NOW.getTime() + 2 * 86_400_000, sent, close);
  });
  assert.deepEqual(sent, [1, 2], 'each step sent once');
  for (const t of db.tasks) assert.deepEqual(t, { id: t.id, done: false, plan_claim_at: HELD_AS_SENT });
  assert.deepEqual(waits, [300, 1000, 300, 1000], 'three tries of the done write per step, then the hold');
  assert.equal(logged.length, 2, 'each hold is logged');
});

await test('before: the dropped error left the claim to lapse, and the step sent again 10 minutes later', async () => {
  const db = taskDb((p) => 'done' in p);
  const sent: number[] = [];
  const oldFinish = async (id: number) => { await db.admin.from('tasks').update(DONE).eq('id', id); };
  await planRun(db, NOW.getTime(), sent, oldFinish);
  await planRun(db, NOW.getTime() + 11 * MIN, sent, oldFinish);
  assert.deepEqual(sent, [1, 2, 1, 2]);
});

await test('a done write that fails twice lands on the third try; the step closes as before', async () => {
  let failures = 2;
  const db = taskDb((p) => 'done' in p && failures-- > 0);
  const sent: number[] = [];
  const { logged } = await quietly(async () => {
    await planRun(db, NOW.getTime(), sent, (id) => closeSent(db.admin, id, DONE, async () => {}));
    await planRun(db, NOW.getTime() + 11 * MIN, sent, (id) => closeSent(db.admin, id, DONE, async () => {}));
  });
  assert.deepEqual(sent, [1, 2]);
  assert.ok(db.tasks.every((t) => t.done && t.plan_claim_at === null));
  assert.equal(logged.length, 0);
});

await test('closeSent: false and logged only when neither the done write nor the hold lands', async () => {
  const db = taskDb(() => true);
  const { value, logged } = await quietly(() => closeSent(db.admin, 1, DONE, async () => {}));
  assert.equal(value, false);
  assert.equal(logged.length, 1);
  assert.deepEqual(db.tasks[0], { id: 1, done: false, plan_claim_at: null });
});

// The tick's loop for one claimed row (index.ts): the step, and afterThrow in its catch. `release` is a
// spy that clears the claim the way a working release() would, so a wrong release shows up as a resend.
async function loopRun(db: ReturnType<typeof taskDb>, at: number, sent: number[], released: number[], throwAt: 'before' | 'after' | null) {
  for (const id of db.claim(at)) {
    const row = { task_id: id };
    try {
      if (throwAt === 'before') throw new Error('buyer unread: fetch failed');
      sent.push(id);
      sentSteps.add(row);
      if (throwAt === 'after') throw new Error('cold_sends: fetch failed');
      await closeSent(db.admin, id, DONE, async () => {});
    } catch {
      await afterThrow(row,
        async () => { released.push(id); db.tasks.find((t) => t.id === id)!.plan_claim_at = null; },
        () => closeSent(db.admin, id, DONE, async () => {}));
    }
  }
}

await test('closeSent: a write that throws counts as a failed one, and the hold still lands', async () => {
  const db = taskDb((p) => ('done' in p ? 'throw' : false));
  const sent: number[] = [];
  const { value } = await quietly(async () => {
    await planRun(db, NOW.getTime(), sent, (id) => closeSent(db.admin, id, DONE, async () => {}));
    await planRun(db, NOW.getTime() + 11 * MIN, sent, (id) => closeSent(db.admin, id, DONE, async () => {}));
    return closeSent(db.admin, 1, DONE, async () => {});
  });
  assert.deepEqual(sent, [1, 2]);
  assert.equal(value, true);
  for (const t of db.tasks) assert.equal(t.plan_claim_at, HELD_AS_SENT);
});

await test('done and hold updates both throw: nothing is released, and the next run sends nothing', async () => {
  const db = taskDb(() => 'throw');
  const sent: number[] = [];
  const released: number[] = [];
  const { logged } = await quietly(async () => {
    await assert.doesNotReject(closeSent(db.admin, 1, DONE, async () => {}));
    await loopRun(db, NOW.getTime(), sent, released, 'after'); // sent, then a throw, then every write throws
    await loopRun(db, NOW.getTime() + 5 * MIN, sent, released, null);
    await loopRun(db, NOW.getTime() + 9 * MIN, sent, released, null);
  });
  assert.deepEqual(sent, [1, 2], 'the claim left in place keeps the next runs off it');
  assert.deepEqual(released, [], 'a row that sent is never released');
  for (const t of db.tasks) assert.equal(t.plan_claim_at, NOW.toISOString(), 'claim untouched');
  assert.ok(logged.some((l) => String(l[2]).startsWith('SENT BUT NOT RECORDED')), 'logged loudly');
  // The ceiling, as before this change: a claim nothing could write lapses after 10 minutes.
  assert.deepEqual(db.claim(NOW.getTime() + 11 * MIN), [1, 2]);
});

await test('a throw after the send closes or holds the row; a throw before it releases it for a retry, as before', async () => {
  {
    const db = taskDb(() => false);
    const sent: number[] = []; const released: number[] = [];
    await loopRun(db, NOW.getTime(), sent, released, 'after');
    await loopRun(db, NOW.getTime() + 11 * MIN, sent, released, null);
    assert.deepEqual(sent, [1, 2]);
    assert.deepEqual(released, []);
    assert.ok(db.tasks.every((t) => t.done), 'closed by the catch');
  }
  {
    const db = taskDb((p) => 'done' in p);
    const sent: number[] = []; const released: number[] = [];
    await quietly(async () => {
      await loopRun(db, NOW.getTime(), sent, released, 'after');
      await loopRun(db, NOW.getTime() + 11 * MIN, sent, released, null);
    });
    assert.deepEqual(sent, [1, 2]);
    assert.ok(db.tasks.every((t) => t.plan_claim_at === HELD_AS_SENT), 'held by the catch');
  }
  {
    const db = taskDb(() => false);
    const sent: number[] = []; const released: number[] = [];
    await loopRun(db, NOW.getTime(), sent, released, 'before');
    assert.deepEqual(released, [1, 2], 'nothing sent: released');
    await loopRun(db, NOW.getTime() + MIN, sent, released, null);
    assert.deepEqual(sent, [1, 2], 'and the retry sends it once');
  }
});

console.log(`plan-tick-pool: ${passed} passed`);
