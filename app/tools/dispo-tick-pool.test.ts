// dispo-campaign-tick's send loop (supabase/functions/dispo-campaign-tick/pool.ts):
// waves, the per-wave blacklist read, and two overlapping ticks against a fake
// client that sends each message once.
// Run with:  npx tsx tools/dispo-tick-pool.test.ts
import assert from 'node:assert/strict';
import { loadBlocked, type BlacklistDb } from '../lib/blacklist';
import { POOL, claim, laneKey, nextWave, once, runWaves, unclaim } from '../supabase/functions/dispo-campaign-tick/pool';

type Row = { id: number; workspace_id: number; campaign_id: number; recipient_id: number; channel: string; buyer_id: number; status: string };
type Buyer = { id: number; tags: string[]; blacklisted_at: string | null };
type Gate = Awaited<ReturnType<typeof loadBlocked>>;

const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 3));

/** The tables the loop touches. An update matches and writes in one step, as Postgres does under the row lock. */
function fakeDb(rows: Row[], buyers: Buyer[], failBuyers = false) {
  const reads: number[][] = [];
  const campaigns = new Map<number, string>(rows.map((r) => [r.campaign_id, 'running']));
  return {
    reads,
    campaigns,
    // dispo_campaign_finish: done only when nothing of the campaign is queued or sending.
    rpc: async (name: string, args: { p_campaign_id: number }) => {
      assert.equal(name, 'dispo_campaign_finish');
      if (campaigns.get(args.p_campaign_id) === 'running' && !rows.some((r) => r.campaign_id === args.p_campaign_id && (r.status === 'queued' || r.status === 'sending'))) campaigns.set(args.p_campaign_id, 'done');
      return { data: null, error: null };
    },
    from(table: string): unknown {
      if (table === 'buyers') {
        return {
          select: () => ({
            in: async (_c: string, ids: number[]) => {
              reads.push(ids);
              await jitter();
              return failBuyers ? { data: null, error: { message: 'boom' } } : { data: buyers.filter((b) => ids.includes(b.id)), error: null };
            },
          }),
        };
      }
      return {
        update(patch: Partial<Row>) {
          const where: [string, unknown][] = [];
          const run = async () => {
            await jitter();
            const hit = rows.filter((r) => where.every(([c, v]) => (r as Record<string, unknown>)[c] === v));
            for (const r of hit) Object.assign(r, patch);
            return { data: hit.map((r) => ({ id: r.id })), error: null };
          };
          const q = {
            eq(c: string, v: unknown) { where.push([c, v]); return q; },
            select: () => run(),
            then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => run().then(ok, bad),
          };
          return q;
        },
      };
    },
  };
}

/** One tick: its own due snapshot, the real claim and wave reads, and a send that gates like index.ts. */
function tickRun(rows: Row[], db: ReturnType<typeof fakeDb>, opts: { late?: () => boolean; throwOn?: number } = {}) {
  const sent: number[] = [];
  const keysInFlight = new Set<string>();
  const doneAtRead = new Map<number, number>();
  let inFlight = 0, peak = 0, keyOverlap = false, readBeforeClaim = false, waitedAfterClaim = false, waves = 0, finished = 0;
  const due = rows.filter((r) => r.status === 'queued').map((r) => ({ ...r }));
  const row = (id: number) => rows.find((r) => r.id === id)!;
  const done = runWaves<Row, Gate>(due, {
    db,
    late: opts.late ?? (() => false),
    prepare: async (won) => {
      waves++;
      if (won.some((m) => row(m.id).status !== 'sending')) readBeforeClaim = true;
      for (const m of won) doneAtRead.set(m.id, finished);
      return loadBlocked(db as unknown as BlacklistDb, { buyerIds: won.map((m) => m.buyer_id) });
    },
    send: async (m, gate) => {
      // Nothing else of this tick finished between the wave's read and this send starting.
      if (doneAtRead.get(m.id) !== finished) waitedAfterClaim = true;
      if (!gate.ok) { row(m.id).status = 'queued'; return; }
      if (gate.blocked.buyers.has(m.buyer_id)) { row(m.id).status = 'skipped'; return; }
      const k = laneKey(m);
      if (keysInFlight.has(k)) keyOverlap = true;
      keysInFlight.add(k);
      peak = Math.max(peak, ++inFlight);
      await jitter();
      inFlight--;
      keysInFlight.delete(k);
      finished++;
      if (m.id === opts.throwOn) throw new Error('provider blew up after sending');
      sent.push(m.id);
      row(m.id).status = 'sent';
    },
  });
  return { done, sent, stats: () => ({ peak, keyOverlap, readBeforeClaim, waitedAfterClaim, waves }) };
}

const channels = ['email', 'sms', 'email', 'rvm', 'ai_call', 'email', 'sms'];
const makeRows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({
  id: i + 1, workspace_id: i % 3 === 0 ? 2 : 1, campaign_id: 1 + (i % 4), recipient_id: 1000 + (i % 20), channel: channels[i % channels.length], buyer_id: 100 + (i % 9), status: 'queued',
}));
const buyers: Buyer[] = [{ id: 103, tags: [], blacklisted_at: '2026-01-01' }, { id: 105, tags: ['secret-blacklist'], blacklisted_at: null }];

async function main() {
  // Waves: due order, one per lane, at most POOL. Texts and AI calls share a lane per workspace; email and drops per recipient.
  {
    const m = (id: number, workspace_id: number, channel: string, recipient_id = id) => ({ id, workspace_id, campaign_id: 1, channel, recipient_id });
    const due = [m(1, 1, 'sms'), m(2, 1, 'email'), m(3, 2, 'sms'), m(4, 1, 'sms'), m(5, 1, 'ai_call'), m(6, 1, 'ai_call'), m(7, 1, 'email', 2), m(8, 1, 'rvm'), m(9, 1, 'email')];
    const first = nextWave(due);
    assert.deepEqual(first.wave.map((x) => x.id), [1, 2, 3, 5, 8], 'one text per workspace, one AI call, one email per recipient, five in all');
    assert.deepEqual(first.rest.map((x) => x.id), [4, 6, 7, 9], 'the rest keep due order');
    const second = nextWave(first.rest);
    assert.deepEqual(second.wave.map((x) => x.id), [4, 6, 7, 9]);
    assert.deepEqual(second.rest, []);
    assert.equal(laneKey(m(10, 4, 'sms')), laneKey(m(11, 4, 'sms')));
    assert.notEqual(laneKey(m(10, 4, 'email')), laneKey(m(11, 4, 'email')));
    assert.equal(laneKey(m(10, 4, 'email', 7)), laneKey(m(11, 4, 'email', 7)));
  }

  // once: callers side by side share one load.
  {
    let loads = 0;
    const get = once(async (k: number) => { loads++; await jitter(); return k * 2; });
    assert.deepEqual(await Promise.all([get(1), get(1), get(2), get(1)]), [2, 2, 4, 2]);
    assert.equal(loads, 2);
  }

  // claim / unclaim: one winner; a handed-back claim is queued again; a sent row is never touched.
  {
    const rows = makeRows(2);
    const db = fakeDb(rows, []);
    assert.deepEqual(await Promise.all([claim(db, 1), claim(db, 1)]).then((x) => x.sort()), [false, true]);
    await unclaim(db, 1);
    assert.equal(rows[0].status, 'queued');
    rows[1].status = 'sent';
    await unclaim(db, 2);
    assert.equal(rows[1].status, 'sent');
  }

  // The blacklist map: one read for the wave's buyers, duplicates folded; a failed read is not "clear".
  {
    const db = fakeDb([], buyers);
    const gate = await loadBlocked(db as unknown as BlacklistDb, { buyerIds: [103, 104, 103, 105, 106] });
    assert.equal(db.reads.length, 1);
    assert.deepEqual(db.reads[0], [103, 104, 105, 106]);
    assert.ok(gate.ok && [...gate.blocked.buyers].sort().join() === '103,105');
    const bad = await loadBlocked(fakeDb([], buyers, true) as unknown as BlacklistDb, { buyerIds: [104] });
    assert.equal(bad.ok, false);
  }

  // Two overlapping ticks over the same due list: every message sent once, blacklisted buyers never.
  for (let round = 0; round < 25; round++) {
    const rows = makeRows(60);
    const db = fakeDb(rows, buyers);
    const a = tickRun(rows, db);
    const b = tickRun(rows, db);
    await Promise.all([a.done, b.done]);
    const all = [...a.sent, ...b.sent];
    const clear = rows.filter((r) => r.buyer_id !== 103 && r.buyer_id !== 105).map((r) => r.id);
    assert.equal(new Set(all).size, all.length, 'no message sent twice');
    assert.deepEqual([...all].sort((x, y) => x - y), clear, 'every clear message sent');
    assert.ok(rows.filter((r) => r.buyer_id === 103 || r.buyer_id === 105).every((r) => r.status === 'skipped'), 'blacklisted skipped');
    assert.ok(rows.every((r) => r.status !== 'sending' && r.status !== 'queued'), 'nothing left claimed or due');
    assert.ok([...db.campaigns.values()].every((v) => v === 'done'), 'every campaign ends done');
    for (const t of [a, b]) {
      const s = t.stats();
      assert.ok(s.peak <= POOL, `at most ${POOL} at once`);
      assert.equal(s.keyOverlap, false, 'one lane never runs two at once');
      assert.equal(s.readBeforeClaim, false, 'the blacklist is read after the wave is claimed');
      assert.equal(s.waitedAfterClaim, false, 'a claimed message never waits behind another send');
    }
    assert.equal(db.reads.length, a.stats().waves + b.stats().waves, 'one blacklist read per wave');
    assert.ok(db.reads.every((ids) => ids.length <= POOL));
  }

  // Out of time: no more claims, nothing left claimed; the next tick sends the rest, each once.
  {
    const rows = makeRows(25);
    const db = fakeDb(rows, []);
    const so: { sent: number[] } = { sent: [] };
    const first = tickRun(rows, db, { late: () => so.sent.length >= 3 });
    so.sent = first.sent;
    await first.done;
    assert.ok(first.sent.length >= 3 && first.sent.length < 25, 'stops at the budget');
    assert.ok(rows.every((r) => r.status === 'sent' || r.status === 'queued'), 'no claim left behind');
    const second = tickRun(rows, db);
    await second.done;
    const all = [...first.sent, ...second.sent];
    assert.equal(all.length, 25);
    assert.equal(new Set(all).size, 25);
  }

  // A send that throws stays claimed (it may have gone out); the rest still send.
  {
    const rows = makeRows(12);
    const db = fakeDb(rows, []);
    const quiet = console.error;
    console.error = () => {};
    const t = tickRun(rows, db, { throwOn: 2 });
    await t.done;
    console.error = quiet;
    assert.equal(rows.find((r) => r.id === 2)!.status, 'sending');
    assert.equal(t.sent.length, 11);
  }

  // A failed blacklist read sends nothing and holds the wave.
  {
    const rows = makeRows(8);
    const db = fakeDb(rows, buyers, true);
    const t = tickRun(rows, db);
    await t.done;
    assert.equal(t.sent.length, 0);
    assert.ok(rows.every((r) => r.status === 'queued'));
  }

  // The last wave of a campaign mixes channels: the email's own finish (inside dispo_message_sent) sees the
  // drop still sending, and a drop never asks. The finish after the wave still marks the campaign done.
  {
    const rows: Row[] = [
      { id: 1, workspace_id: 1, campaign_id: 7, recipient_id: 1, channel: 'email', buyer_id: 100, status: 'queued' },
      { id: 2, workspace_id: 1, campaign_id: 7, recipient_id: 2, channel: 'rvm', buyer_id: 101, status: 'queued' },
    ];
    const db = fakeDb(rows, []);
    let emailDone!: () => void;
    const emailSent = new Promise<void>((r) => { emailDone = r; });
    let afterEmailFinish = '';
    await runWaves<Row, Gate>(rows.map((r) => ({ ...r })), {
      db, late: () => false,
      prepare: async (won) => loadBlocked(db as unknown as BlacklistDb, { buyerIds: won.map((x) => x.buyer_id) }),
      send: async (x) => {
        const r = rows.find((y) => y.id === x.id)!;
        if (x.channel === 'email') {
          r.status = 'sent';
          await db.rpc('dispo_campaign_finish', { p_campaign_id: 7 });
          afterEmailFinish = db.campaigns.get(7)!;
          emailDone();
        } else {
          await emailSent;
          r.status = 'sent';
        }
      },
    });
    assert.equal(afterEmailFinish, 'running', 'the race: the email saw the drop still sending');
    assert.equal(db.campaigns.get(7), 'done', 'finished once the wave settled');
  }

  // A wave read that throws hands the claims back; nothing is sent.
  {
    const rows = makeRows(4);
    const db = fakeDb(rows, []);
    const quiet = console.error;
    console.error = () => {};
    await runWaves(rows.map((r) => ({ ...r })), { db, late: () => false, prepare: async () => { throw new Error('network'); }, send: async () => { throw new Error('must not send'); } });
    console.error = quiet;
    assert.ok(rows.every((r) => r.status === 'queued'));
  }

  console.log('dispo tick pool tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
