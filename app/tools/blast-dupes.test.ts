// One property, one blast per buyer (lib/blast-dupes.ts): the launch warning
// and the tick's guard. The case is campaigns 8 and 9 of 2026-10-21, same deal,
// same buyers, minutes apart.
// Run with:  npx tsx tools/blast-dupes.test.ts
import assert from 'node:assert/strict';
import { blastDupes, dupeWarning, waveRepeats } from '../lib/blast-dupes';

// ---- the launch warning
const morgan = (buyer_id: number, sent_at = '2026-10-20T18:00:00Z', campaign_id = 8) => ({ buyer_id, campaign_id, sent_at, by: 'Morgan' });
const prior = [
  ...Array.from({ length: 48 }, (_, i) => morgan(i + 1)),
  morgan(1, '2026-10-21T15:00:00Z'), // a follow-up to the same buyer counts once
  morgan(500), // not in the new blast
];
const d = blastDupes(Array.from({ length: 100 }, (_, i) => i + 1), prior);
assert.equal(d.ids.size, 48);
assert.ok(!d.ids.has(49) && !d.ids.has(500));
assert.equal(dupeWarning(d, '3430 Peachwood Trace'), '48 of these buyers already got a blast for 3430 Peachwood Trace from Morgan on Oct 20.');

// Two senders: each buyer on their first send, biggest group first.
const two = blastDupes([1, 2, 3], [morgan(1), morgan(2), { buyer_id: 3, campaign_id: 9, sent_at: '2026-10-21T16:00:00Z', by: 'you' }, { buyer_id: 2, campaign_id: 9, sent_at: '2026-10-21T16:00:00Z', by: 'you' }]);
assert.equal(dupeWarning(two, '3430 Peachwood Trace'), '3 of these buyers already got a blast for 3430 Peachwood Trace: 2 from Morgan on Oct 20, 1 from you on Oct 21.');
// A day near midnight reads in the campaign's zone: 03:00Z is still Oct 20 in Chicago.
assert.equal(blastDupes([1], [morgan(1, '2026-10-21T03:00:00Z')]).groups[0].day, 'Oct 20');
// A sent row with no sent_at is not "the earliest": the dated send names the sender and the day.
const undated = { buyer_id: 1, campaign_id: 7, sent_at: null, by: null };
assert.equal(dupeWarning(blastDupes([1], [undated, morgan(1)]), 'x'), '1 of these buyers already got a blast for x from Morgan on Oct 20.');
assert.equal(dupeWarning(blastDupes([1], [morgan(1), undated]), 'x'), '1 of these buyers already got a blast for x from Morgan on Oct 20.');
// Only undated sends: still counted, under "an earlier day".
assert.equal(dupeWarning(blastDupes([1], [undated]), 'x'), '1 of these buyers already got a blast for x from a teammate on an earlier day.');
// Unknown sender, nothing prior.
assert.equal(dupeWarning(blastDupes([1], [{ buyer_id: 1, campaign_id: 8, sent_at: '2026-10-20T18:00:00Z', by: null }]), ''), '1 of these buyers already got a blast for this property from a teammate on Oct 20.');
assert.equal(dupeWarning(blastDupes([1], []), 'x'), '');

// ---- the tick's guard
const msg = (id: number, campaign_id: number, buyer_id: number, kind = 'intro', channel = 'sms', deal_id = 77) => ({ id, campaign_id, buyer_id, kind, channel, deal_id });
const { id: _id, ...sentIntro } = msg(0, 8, 1); void _id;

// Campaign 9's intro text to buyer 1 after campaign 8's went out: skipped, and says why.
let r = waveRepeats([msg(10, 9, 1)], [sentIntro]);
assert.equal(r.get(10), 'buyer already got this intro text for this property from campaign 8');
// Campaign 8's own next message is not a repeat of itself.
assert.equal(waveRepeats([msg(11, 8, 1)], [sentIntro]).size, 0);
// Another kind, another channel, another buyer or another deal is fine.
assert.equal(waveRepeats([msg(12, 9, 1, 'brief'), msg(13, 9, 1, 'intro', 'email'), msg(14, 9, 2), msg(15, 9, 1, 'intro', 'sms', 78)], [sentIntro]).size, 0);
// Both campaigns due in one wave, nothing sent yet: the first in due order goes, the twin is skipped.
r = waveRepeats([msg(20, 8, 5, 'intro', 'email'), msg(21, 9, 5, 'intro', 'email'), msg(22, 9, 6, 'intro', 'email')], []);
assert.deepEqual([...r.keys()], [21]);
assert.match(r.get(21)!, /intro email .* campaign 8$/);

console.log('blast-dupes: ok');
