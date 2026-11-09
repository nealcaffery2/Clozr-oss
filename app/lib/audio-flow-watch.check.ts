// node --experimental-strip-types lib/audio-flow-watch.check.ts
import assert from 'node:assert/strict';
import { nextFlow, type FlowState } from './audio-flow-watch.ts';

let s: FlowState = { packets: null, still: 0, stalledAt: null };
const step = (p: number | null, t: number) => {
  const r = nextFlow(s, p, t);
  s = r.state;
  return r.event;
};

assert.equal(step(100, 0), null); // first reading
assert.equal(step(150, 2000), null); // flowing
assert.equal(step(150, 4000), null); // one still tick: not yet
assert.deepEqual(step(150, 6000), { type: 'stall' }); // two: stall, once
assert.equal(step(150, 8000), null); // still stalled, no repeat
assert.equal(step(null, 9000), null); // unreadable stats change nothing
assert.deepEqual(step(160, 10000), { type: 'resume', silentMs: 4000 });
assert.equal(step(170, 12000), null);
console.log('audio-flow-watch ok');
