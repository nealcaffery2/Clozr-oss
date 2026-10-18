// The call clock's arithmetic. Run: npx tsx tools/call-clock.test.ts
import assert from 'node:assert/strict';
import { callSeconds, endedCallClock, formatCallClock } from '../lib/call-clock';

// m:ss.
assert.equal(formatCallClock(0), '0:00');
assert.equal(formatCallClock(7), '0:07');
assert.equal(formatCallClock(65), '1:05');
assert.equal(formatCallClock(3600), '60:00', 'minutes keep counting past the hour');

// Whole seconds since the start; nothing before the call connects.
const t0 = 1_700_000_000_000;
assert.equal(callSeconds(null, t0), 0, 'ringing, or never answered');
assert.equal(callSeconds(t0, t0 + 999), 0);
assert.equal(callSeconds(t0, t0 + 1000), 1);
assert.equal(callSeconds(t0, t0 + 125_400), 125);
assert.equal(callSeconds(t0, t0 - 500), 0, 'a clock read a moment before the start is not negative');

// The wrap-up's length: fixed at the end, 0:00 while the call still runs.
assert.equal(endedCallClock({ startedAt: t0, endedAt: t0 + 95_000 }), '1:35');
assert.equal(endedCallClock({ startedAt: t0, endedAt: null }), '0:00');
assert.equal(endedCallClock({ startedAt: null, endedAt: t0 }), '0:00', 'ended before anyone picked up');

console.log('call-clock: all passed');
