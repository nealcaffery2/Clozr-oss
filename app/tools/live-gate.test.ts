// The live-transcript gate: Deepgram opens on a real back-and-forth or after
// LIVE_GATE_SECONDS, never on a greeting alone.
// Run: npx tsx tools/live-gate.test.ts
import assert from 'node:assert/strict';
import { ConversationGate, LIVE_GATE_SECONDS, rms } from '../lib/live-transcript';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL', name);
    throw e;
  }
};

const FRAME_MS = 85;
const QUIET = 0.002;
const LOUD = 0.2;
/** Feed `ms` of one pattern, return whether the gate opened at any point. */
function feed(gate: ConversationGate, ms: number, levels: [number, number]): boolean {
  let open = false;
  for (let t = 0; t < ms; t += FRAME_MS) open = gate.frame(levels, FRAME_MS) || open;
  return open;
}

test('seller, rep, seller opens the gate well before the timer', () => {
  const g = new ConversationGate();
  assert.equal(feed(g, 500, [QUIET, QUIET]), false);
  assert.equal(feed(g, 900, [LOUD, QUIET]), false); // "Hello?"
  assert.equal(feed(g, 800, [QUIET, QUIET]), false);
  assert.equal(feed(g, 2000, [QUIET, LOUD]), false); // "Hi, is this Mark?"
  assert.equal(feed(g, 800, [QUIET, QUIET]), false);
  assert.equal(feed(g, 700, [LOUD, QUIET]), true); // "Yeah"
});

test('a voicemail greeting then the rep talking does not open it early', () => {
  const g = new ConversationGate();
  assert.equal(feed(g, 6000, [LOUD, QUIET]), false);
  assert.equal(feed(g, 1000, [QUIET, QUIET]), false);
  assert.equal(feed(g, 10_000, [QUIET, LOUD]), false);
});

test('the timer opens it at LIVE_GATE_SECONDS regardless', () => {
  const g = new ConversationGate();
  assert.equal(feed(g, LIVE_GATE_SECONDS * 1000 - 200, [QUIET, QUIET]), false);
  assert.equal(feed(g, 400, [QUIET, QUIET]), true);
  assert.equal(g.frame([QUIET, QUIET], FRAME_MS), true);
});

test('a click shorter than a turn is not speech', () => {
  const g = new ConversationGate();
  for (let i = 0; i < 8; i++) {
    g.frame([LOUD, QUIET], FRAME_MS);
    feed(g, 700, [QUIET, QUIET]);
    g.frame([QUIET, LOUD], FRAME_MS);
    feed(g, 700, [QUIET, QUIET]);
  }
  assert.equal(g.passed, false);
});

test('rms', () => {
  assert.equal(rms(new Float32Array(0)), 0);
  assert.ok(Math.abs(rms(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9);
});

console.log(passed + ' passed');
