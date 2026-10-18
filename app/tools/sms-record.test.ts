// lib/sms-record.ts: the row every sent text is written as, and how its line and sender resolve.
// Run with:  npx tsx tools/sms-record.test.ts
import assert from 'node:assert/strict';
import { fromLine, sentTextRow, talkrUserMap } from '../lib/sms-record-rules';

const lines = [
  { id: 'n-morgan', phone_e164: '+12105550125' },
  { id: 'n-jamie', phone_e164: '+12105550321' },
];

// ---- the line a text left from ----
assert.equal(fromLine({ from_number: '+12105550321' }, 'n-morgan', lines), '+12105550321', 'what Talkr says on the message wins');
assert.equal(fromLine({}, 'n-morgan', lines), '+12105550125', 'else the line the sender picked');
assert.equal(fromLine(null, null, lines, '+12105550321'), '+12105550321', 'else the thread’s own number');
assert.equal(fromLine(null, 'n-gone', lines, null), null, 'an unknown pick and no thread: nothing to say');
assert.equal(fromLine(undefined, undefined, undefined), null);

// ---- the row ----
const row = sentTextRow({
  workspaceId: 11, buyerId: 7, to: '+12105550100', body: 'Hi Cy', mediaUrls: [],
  msg: { id: 'm1', status: 'queued', created_by: 'talkr-morgan', from_number: '+12105550125' },
  repId: 'uid-morgan', fromPhone: '+12105550125', now: '2026-10-16T18:00:00.000Z',
});
assert.deepEqual(row, {
  workspace_id: 11, seller_id: null, buyer_id: 7, vendor_id: null, deal_id: null,
  channel: 'sms', direction: 'outbound', occurred_at: '2026-10-16T18:00:00.000Z',
  rep_id: 'uid-morgan', talkr_user_id: 'talkr-morgan', from_phone: '+12105550125', to_phone: '+12105550100',
  body: 'Hi Cy', status: 'queued', source: 'talkr', source_id: 'msg:m1',
});
assert.equal(sentTextRow({ workspaceId: 11, to: '+1', body: 'x', msg: { id: 'm2' }, repId: null, fromPhone: null }).status, 'queued', 'no status from Talkr reads as queued');
assert.equal(sentTextRow({ workspaceId: 11, to: '+1', body: 'x', msg: { id: 'm2', status: '' }, repId: null, fromPhone: null }).status, 'queued');
assert.equal(sentTextRow({ workspaceId: 11, to: '+1', body: 'x', msg: { id: 'm3' }, repId: 'u', fromPhone: null }).talkr_user_id, null, 'no created_by: no Talkr user');

// ---- Talkr seat → CLOZR user ----
const map = talkrUserMap(
  [{ id: 't-morgan', email: 'Morgan@YourCompany.com' }, { id: 't-riley', email: null }, { id: 't-guest', email: 'guest@elsewhere.com' }],
  [{ user_id: 'u-morgan', email: 'morgan@yourcompany.com' }, { user_id: 'u-casey', email: 'casey@yourcompany.com' }],
);
assert.equal(map.get('t-morgan'), 'u-morgan', 'matched on the address, any case');
assert.equal(map.has('t-riley'), false, 'a seat with no address maps to nobody');
assert.equal(map.has('t-guest'), false, 'an address not on the roster maps to nobody');
assert.equal(talkrUserMap(null, undefined).size, 0);

console.log('sms-record: ok');
