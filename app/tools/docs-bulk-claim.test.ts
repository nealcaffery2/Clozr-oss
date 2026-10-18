// docs-plus bulk send: the row claim between bulk_create's own first batch
// and an overlapping cron bulk_tick, a run killed mid-send, and a failed claim.
// Run with:  npx tsx tools/docs-bulk-claim.test.ts
import assert from 'node:assert/strict';
import { UNKNOWN_OUTCOME, claimBulkItem } from '../supabase/functions/docs-plus/bulk';

type Row = Record<string, unknown>;
/**
 * Just enough supabase-js for a conditional update and the tick's queued read:
 * from().update().eq().select() and from().select().eq(). The update filters
 * and writes with no await in between, so it is atomic the way one UPDATE
 * under its row lock is.
 */
function fakeDb(rows: Row[], error: { message: string } | null = null) {
  return {
    from(table: string) {
      assert.equal(table, 'bulk_send_items');
      let patch: Row | null = null;
      const where: ((r: Row) => boolean)[] = [];
      const q = {
        update(p: Row) { patch = p; return q; },
        eq(col: string, v: unknown) { where.push((r) => r[col] === v); return q; },
        select() { return q; },
        then(done: (v: { data: Row[] | null; error: { message: string } | null }) => void) {
          if (error) return done({ data: null, error });
          const hit = rows.filter((r) => where.every((w) => w(r)));
          if (patch) for (const r of hit) Object.assign(r, patch);
          done({ data: hit.map((r) => ({ ...r })), error: null });
        },
      };
      return q;
    },
  };
}

const yieldTurn = () => new Promise<void>((done) => setTimeout(done, 0));
const items = (): Row[] => [1, 2, 3, 4].map((id) => ({ id, bulk_send_id: 7, status: 'queued', error: null, contract_id: null }));

/**
 * One run over its read of queued rows, in bulkTick's order: claim, create and
 * send the contract (the slow part), then mark the row sent.
 */
async function run(db: ReturnType<typeof fakeDb>, snapshot: Row[], name: string, sent: string[]): Promise<void> {
  for (const it of snapshot) {
    if (!(await claimBulkItem(db, Number(it.id)))) continue;
    await yieldTurn();
    sent.push(`${it.id}:${name}`);
    await db.from('bulk_send_items').update({ status: 'sent', contract_id: Number(it.id) * 100, error: null }).eq('id', it.id);
  }
}

async function main() {
  {
    // bulk_create's first batch and the cron's tick read the same queued rows, then run side by side.
    const rows = items();
    const db = fakeDb(rows);
    const sent: string[] = [];
    await Promise.all([run(db, items(), 'create', sent), run(db, items(), 'cron', sent)]);
    const ids = sent.map((s) => s.split(':')[0]).sort();
    assert.deepEqual(ids, ['1', '2', '3', '4'], `each contract once, got ${sent.join(', ')}`);
    assert.ok(rows.every((r) => r.status === 'sent' && r.error === null), 'every row ends sent, the claim note cleared');
  }
  {
    // The cron read the rows before bulk_create's batch ran; that batch finishes first. The cron sends nothing.
    const db = fakeDb(items());
    const sent: string[] = [];
    const cronRead = items();
    await run(db, items(), 'create', sent);
    await run(db, cronRead, 'cron', sent);
    assert.deepEqual(sent, ['1:create', '2:create', '3:create', '4:create']);
  }
  {
    // Three runs at once still send each row once.
    const db = fakeDb(items());
    const sent: string[] = [];
    await Promise.all(['A', 'B', 'C'].map((n) => run(db, items(), n, sent)));
    assert.equal(sent.length, 4);
    assert.equal(new Set(sent.map((s) => s.split(':')[0])).size, 4);
  }
  {
    // A run killed after its claim (wall clock) leaves the row failed with the honest note, and no later tick sends it.
    const rows = items();
    const db = fakeDb(rows);
    assert.equal(await claimBulkItem(db, 2), true);
    assert.equal(rows[1].status, 'failed');
    assert.equal(rows[1].error, UNKNOWN_OUTCOME);
    const { data: queued } = await db.from('bulk_send_items').select().eq('status', 'queued');
    assert.deepEqual((queued ?? []).map((r) => r.id), [1, 3, 4], "the next tick's read skips it");
    assert.equal(await claimBulkItem(db, 2), false, 'and a stale read cannot claim it again');
    const sent: string[] = [];
    await run(db, items(), 'next', sent);
    assert.deepEqual(sent, ['1:next', '3:next', '4:next']);
  }
  {
    // A run killed after claiming the batch's last queued row: nothing is queued, so docs_bulk_kick
    // never calls bulk_tick again and no tick recounts the batch. The kick settles it from its rows
    // instead (355, proved in a rolled-back block: running 0/0 becomes done 1 sent / 1 failed).
    const rows = items().slice(0, 2);
    rows[0].status = 'sent';
    const db = fakeDb(rows);
    assert.equal(await claimBulkItem(db, 2), true);
    const { data: queued } = await db.from('bulk_send_items').select().eq('status', 'queued');
    assert.deepEqual(queued, [], 'no queued row is left for a tick to find');
    assert.deepEqual(rows.map((r) => [r.status, r.error]), [['sent', null], ['failed', UNKNOWN_OUTCOME]], 'the rows the settle counts: 1 sent, 1 failed');
  }
  {
    // A claim that errors is not a claim: nothing sends, and the row is left queued.
    const rows = items();
    const sent: string[] = [];
    await run(fakeDb(rows, { message: 'connection reset' }), items(), 'A', sent);
    assert.deepEqual(sent, []);
    assert.ok(rows.every((r) => r.status === 'queued'));
  }
  {
    // Rows already sent, skipped or failed are never claimed.
    const rows: Row[] = ['sent', 'skipped', 'failed'].map((status, i) => ({ id: i + 1, status }));
    const db = fakeDb(rows);
    for (const r of rows) assert.equal(await claimBulkItem(db, Number(r.id)), false);
    assert.deepEqual(rows.map((r) => r.status), ['sent', 'skipped', 'failed']);
  }
  console.log('docs-bulk-claim: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
