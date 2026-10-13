// The ring guard: when to hang up a rep left alone on an outbound call. Run: npx tsx tools/ring-guard.test.ts
import assert from 'node:assert/strict';
import { NEVER_DIALED_AFTER_MS, ringOutReason, ringVerdict } from '../lib/ring-guard';

const rep = { role: 'agent', state: 'joined' };
const seller = (state: string) => ({ role: 'customer', state });

// The seller's leg is over: hang the rep up whatever the roster says.
assert.equal(ringVerdict({ status: 'no_answer', roster: null, upForMs: 30_000 })?.reason, 'no_answer');
assert.equal(ringVerdict({ status: 'busy', roster: [rep, seller('left')], upForMs: 5_000 })?.reason, 'busy');
assert.equal(ringVerdict({ status: 'failed', roster: [], upForMs: 1_000 })?.reason, 'failed');
assert.equal(ringOutReason('no-answer'), 'no_answer', 'carrier spelling');
assert.equal(ringOutReason('cancelled'), 'canceled');

// A live call is left alone.
assert.equal(ringVerdict({ status: 'in_progress', roster: [rep, seller('ringing')], upForMs: 25_000 }), null);
assert.equal(ringVerdict({ status: 'completed', roster: [rep, seller('left')], upForMs: 60_000 }), null, 'completed is the seller hanging up after a talk; the room ends itself');

// The seller was never dialled: the rep is alone in the room past the retry.
assert.equal(ringVerdict({ status: 'in_progress', roster: [rep], upForMs: NEVER_DIALED_AFTER_MS - 1 }), null, 'Talkr retries the dial at 5 s');
assert.equal(ringVerdict({ status: 'in_progress', roster: [rep], upForMs: NEVER_DIALED_AFTER_MS })?.reason, 'never_dialed');
assert.equal(ringVerdict({ status: 'in_progress', roster: [rep, seller('ringing')], upForMs: 40_000 }), null);
// No room (Twilio or bridge mode), or the roster was not read: no seller row says nothing.
assert.equal(ringVerdict({ status: 'in_progress', roster: [], upForMs: 60_000 }), null);
assert.equal(ringVerdict({ status: 'in_progress', roster: null, upForMs: 60_000 }), null);

console.log('ring-guard ok');
