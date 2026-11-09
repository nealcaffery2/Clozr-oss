// Bulk SMS campaign expander: batch size, cadence, window in the recipient's
// zone, line and template rotation, the per-line daily cap.
// npx tsx tools/sms-campaign.test.ts
import assert from 'node:assert/strict';
import { dueAt, estimateSpan, planBatch, renderMerge, unknownFields, type CampaignPlanInput, type PendingRecipient } from '../supabase/functions/_shared/sms-campaign';

const base: CampaignPlanInput = {
  id: 1, tz: 'America/Chicago', start_at: null, send_all_at_once: false, batch_size: 3, batch_every_minutes: 30,
  window_start: 9, window_end: 20, window_days: [1, 2, 3, 4, 5], template_ids: [10, 11], from_numbers: ['A', 'B'], placed: 0,
};
const tpls = [{ id: 10, body: 'Hi {{first_name}}, still own {{address}}?' }, { id: 11, body: 'Hey {first_name}, quick question about {{address}}.' }];
const rec = (id: number, state: string | null = 'TX'): PendingRecipient => ({ id, seller_id: id, phone: `+1512555000${id}`, state, fields: { first_name: 'Ann', address: `${id} Main St` } });
// Tuesday 2026-10-20 15:00Z = 10:00 Chicago, 11:00 New York, 08:00 Los Angeles.
const tue10 = new Date('2026-10-20T15:00:00.000Z');

// Merge fields
assert.equal(renderMerge('Hi {{first_name}}, {x}', { first_name: 'Ann' }), 'Hi Ann, {x}');
assert.deepEqual(unknownFields('{{first_name}} {{nope}} {bad}', ['first_name']), ['nope', 'bad']);

// Batch size, rotation of lines and templates
const p = planBatch(base, [rec(1), rec(2), rec(3), rec(4), rec(5)], tpls, {}, 200, tue10);
assert.equal(p.rows.length, 3);
assert.deepEqual(p.rows.map((r) => r.from_number), ['A', 'B', 'A']);
assert.deepEqual(p.rows.map((r) => r.template_id), [10, 11, 10]);
assert.equal(p.rows[0].body, 'Hi Ann, still own 1 Main St?');
assert.equal(p.rows[0].send_at, tue10.toISOString(), 'inside the window: sends now');
assert.equal(p.next_batch_at, new Date(tue10.getTime() + 30 * 60_000).toISOString());
assert.equal(p.capped, 0);

// Rotation continues from what was placed before
const p2 = planBatch({ ...base, placed: 3 }, [rec(4), rec(5)], tpls, {}, 200, tue10);
assert.deepEqual(p2.rows.map((r) => r.from_number), ['B', 'A']);
assert.deepEqual(p2.rows.map((r) => r.template_id), [11, 10]);
assert.equal(p2.next_batch_at, null, 'the last batch leaves nothing to come back for');

// Window in the recipient's own zone: 08:00 in LA waits for 09:00 LA (16:00Z)
assert.equal(dueAt(tue10, base, 'CA')!.toISOString(), '2026-10-20T16:00:00.000Z');
// A state with no zone falls back to the campaign zone
assert.equal(dueAt(tue10, base, null)!.toISOString(), tue10.toISOString());
// Weekend: Saturday 2026-10-24 15:00Z waits for Monday 09:00 Chicago (14:00Z)
assert.equal(dueAt(new Date('2026-10-24T15:00:00.000Z'), base, 'TX')!.toISOString(), '2026-10-26T14:00:00.000Z');
// After the window closes: 20:30 Chicago (01:30Z next day) waits for 09:00 next morning
assert.equal(dueAt(new Date('2026-10-21T01:30:00.000Z'), base, 'TX')!.toISOString(), '2026-10-21T14:00:00.000Z');

// start_at in the future wins over now
const later = planBatch({ ...base, start_at: '2026-10-21T15:00:00Z' }, [rec(1)], tpls, {}, 200, tue10);
assert.equal(later.rows[0].send_at, '2026-10-21T15:00:00.000Z');

// Per-line daily cap: A is full, everything goes on B; both full, nothing goes and we look again in an hour
const cappedA = planBatch(base, [rec(1), rec(2)], tpls, { A: 200 }, 200, tue10);
assert.deepEqual(cappedA.rows.map((r) => r.from_number), ['B', 'B']);
const allFull = planBatch(base, [rec(1)], tpls, { A: 200, B: 200 }, 200, tue10);
assert.equal(allFull.rows.length, 0);
assert.equal(allFull.capped, 1);
assert.equal(allFull.next_batch_at, new Date(tue10.getTime() + 60 * 60_000).toISOString());

// Send all at once ignores batch size
const all = planBatch({ ...base, send_all_at_once: true }, [rec(1), rec(2), rec(3), rec(4), rec(5)], tpls, {}, 200, tue10);
assert.equal(all.rows.length, 5);
assert.equal(all.next_batch_at, null);

// No line or no template: nothing planned, nothing to come back for
assert.equal(planBatch({ ...base, from_numbers: [] }, [rec(1)], tpls, {}, 200, tue10).rows.length, 0);

// Estimate
assert.equal(estimateSpan(3, base), 'within the first window');
assert.equal(estimateSpan(9, base), 'about 60 minutes'.replace('60 minutes', '1 hours'));
assert.equal(estimateSpan(5000, { ...base, batch_size: 100, batch_every_minutes: 30 }), 'about 3 days');

console.log('sms-campaign: ok');
