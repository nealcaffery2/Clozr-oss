// The reply-based buyer score.  Run:  node --experimental-strip-types supabase/functions/_shared/buyer-score-rule.test.ts
import assert from 'node:assert/strict';
import { ruleScore } from './buyer-score-rule.ts';

const now = Date.parse('2026-09-29T12:00:00Z');
const day = (n: number) => new Date(now - n * 864e5).toISOString();

const none = ruleScore({ buyer: {}, comms: [], offers: [], deals: [], matches: [] }, now);
assert.equal(none.response_rate, null);
assert.equal(none.score, 0);
assert.equal(none.reason, 'Nothing sent yet.');

// Two texts out, one answered inside a week, one opt-out that is not an answer.
const some = ruleScore({
  buyer: {},
  comms: [
    { direction: 'outbound', occurred_at: day(20) },
    { direction: 'inbound', occurred_at: day(19), body: 'Send me the comps' },
    { direction: 'outbound', occurred_at: day(10) },
    { direction: 'inbound', occurred_at: day(9), body: 'STOP' },
  ],
  offers: [{ amount: 150000 }],
  deals: [{ stage: 'Closed' }],
  matches: [{ sent_at: day(40), replied_at: day(39) }],
}, now);
assert.equal(some.response_rate, 67);
assert.equal(some.stats.touches, 3);
assert.equal(some.stats.answered, 2);
assert.match(some.reason, /Answered 2 of 3 touches, 1 offer, 1 closed deal, last reply 19 days ago\./);
assert.ok(some.score > 40 && some.score < 70, String(some.score));

// A note the team logged is not a touch and does not drag the rate down.
const noted = ruleScore({
  buyer: {},
  comms: [
    { channel: 'sms', direction: 'outbound', occurred_at: day(5) },
    { channel: 'sms', direction: 'inbound', occurred_at: day(4), body: 'Yes send it' },
    { channel: 'note', direction: 'outbound', occurred_at: day(3), body: 'Called, left vm' },
  ],
  offers: [], deals: [], matches: [],
}, now);
assert.equal(noted.stats.touches, 1);
assert.equal(noted.response_rate, 100);

console.log('buyer-score-rule: all assertions passed');
