// Tire kicker: low response after enough sends, or offers that never close.
// Run with: npx tsx tools/tire-kicker.test.ts
import assert from 'node:assert/strict';
import { isTireKicker } from '../lib/tire-kicker';

assert.equal(isTireKicker({ sent: 8, responsePct: 18, offers: 0, purchases: 0 }), true, '18% after 8 sends');
assert.equal(isTireKicker({ sent: 3, responsePct: 0, offers: 0, purchases: 0 }), false, 'thin send history');
assert.equal(isTireKicker({ sent: 8, responsePct: 40, offers: 1, purchases: 1 }), false, 'replies and closes');
assert.equal(isTireKicker({ sent: null, responsePct: 74, offers: 4, purchases: 0 }), true, 'offers and never closes');
assert.equal(isTireKicker({ sent: null, responsePct: 74, offers: 1, purchases: 0 }), false, 'one open offer is not a pattern');
assert.equal(isTireKicker({ sent: null, responsePct: 18, offers: 4, purchases: 2 }), false, 'response percent alone, without a send count, does not label');

console.log('tire-kicker: all assertions passed');
