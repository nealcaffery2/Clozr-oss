// heldBuyers (components/dispo-campaign/logic.ts): the buyers a campaign
// holds for 12+ hours, so a blast on the VIP head start reads as waiting.
// The case is the Gleason blast of 2026-10-21: 3 VIPs now, the rest a day later.
// Run with:  npx tsx tools/dispo-held.test.ts
import assert from 'node:assert/strict';
import { heldBuyers } from '../components/dispo-campaign/logic';

const launch = '2026-10-21T18:45:00Z';
type Status = Parameters<typeof heldBuyers>[0][number]['status'];
const m = (recipient_id: number, status: Status, send_at: string, sent_at: string | null = null) => ({ recipient_id, status, send_at, sent_at });

const hb = heldBuyers([
  m(1, 'delivered', '2026-10-21T18:45:00Z', '2026-10-21T18:46:00Z'), m(1, 'queued', '2026-10-21T19:50:00Z'),
  m(2, 'queued', '2026-10-22T14:00:00Z'), m(2, 'sent', '2026-10-21T18:50:00Z', '2026-10-21T18:51:00Z'),
  m(3, 'queued', '2026-10-21T19:10:00Z'),
  m(4, 'queued', '2026-10-22T18:45:44Z'), m(4, 'queued', '2026-10-22T18:50:00Z'),
  m(5, 'queued', '2026-10-22T18:45:05Z'),
  m(6, 'cancelled', '2026-10-22T18:46:00Z'),
], launch);
assert.equal(hb.held, 2, 'only buyers nothing has reached, starting 12+ hours out');
assert.equal(hb.at, '2026-10-22T18:45:05.000Z', 'the first of them');
assert.deepEqual(heldBuyers([m(1, 'queued', '2026-10-21T19:00:00Z')], launch), { held: 0, at: null }, 'a normal drip is not held');

console.log('dispo-held: all assertions passed');
