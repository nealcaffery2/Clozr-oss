// A call list as Talkr contacts for a multi-line session.
// Run: npx tsx tools/talkr-push.test.ts
import assert from 'node:assert/strict';
import { talkrPushRows } from '../lib/talkr-push';

const item = (name: string, phone: string, personId?: string, extra: { dnc?: boolean } = {}) => ({
  target: { name, phone, personId: personId ?? null, buyerId: null },
  ...extra,
});

const rows = talkrPushRows(
  [
    item('Ann', '(212) 555-0101', 's1'),
    item('Ann again', '(212) 555-0199', 's1'),
    item('No number', '—', 's2'),
    item('Do not call', '210-555-0103', 's3', { dnc: true }),
    item('Vendor', '210-555-0104'),
  ],
  (it) => !!it.dnc,
);

assert.equal(rows.length, 2, 'one row per person, dialable, not DNC');
assert.equal(rows[0]!.name, 'Ann');
assert.deepEqual(rows[0]!.phones, ['+12125550101'], 'first appearance wins, E.164');
assert.equal(rows[0]!.timezone, 'America/New_York', 'zone from the area code');
assert.equal(rows[1]!.timezone, 'America/Chicago');
assert.notEqual(rows[0]!.external_id, rows[1]!.external_id);
assert.equal(talkrPushRows([], () => false).length, 0);
console.log('talkr-push: all passed');
