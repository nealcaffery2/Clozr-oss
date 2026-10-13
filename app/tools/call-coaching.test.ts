// Post-call coaching: the cleaner, the ten scores, the card Sam approved.
// Run: npx tsx tools/call-coaching.test.ts
import assert from 'node:assert/strict';
import {
  COACHING_CATEGORIES, COACHING_SYSTEM, buildReview, cleanCoachingCopy, copyIsClean, demoCoachingReview,
  firstName, formatCoaching, isConversation, isVoicemailDrop, measureTalkSplit, shouldRefreshCoaching,
} from '../lib/call-coaching';

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

const SAMPLE = [
  'Ed: Hey Carl, Ed with Acme Homes. You still looking at selling the place on Oak?',
  'Carl: Yeah I mean maybe. HR has me in limbo and we might move to the coast.',
  'Ed: Totally get that. What is HR saying about the timing?',
  'Carl: They will not confirm the transfer until next month. And the coast house is not locked.',
  'Ed: If we could close around your HR date, would the price we talked about still be the issue?',
  'Carl: Your number is just too far off. I need closer to what the other guy said.',
  'Ed: We could probably come up a little if that helps you feel better about it.',
  'Carl: I do not know. Call me after HR gets back.',
  'Ed: Ok I will check in sometime next week.',
].join('\n');

test('prompt bans em dashes and contrast lines, and contains none', () => {
  assert.match(COACHING_SYSTEM, /em dash/i);
  assert.match(COACHING_SYSTEM, /en dash/i);
  assert.match(COACHING_SYSTEM, /it's not X, it's Y/i);
  assert.equal(COACHING_SYSTEM.includes('\u2014') || COACHING_SYSTEM.includes('\u2013'), false);
  for (const c of COACHING_CATEGORIES) assert.match(COACHING_SYSTEM, new RegExp(c.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(COACHING_CATEGORIES.length, 10);
});

test('cleaner turns an em dash into a sentence and drops a contrast', () => {
  assert.equal(cleanCoachingCopy('Lost it on urgency \u2014 and a soft next step.'), 'Lost it on urgency. And a soft next step.');
  assert.equal(cleanCoachingCopy("It's not the price, it's the timing."), "It's the timing.");
  assert.equal(copyIsClean(cleanCoachingCopy('Lost it on urgency \u2014 and a soft next step.')), true);
});

test('talk split is measured from labels and sums to 100', () => {
  const split = measureTalkSplit(SAMPLE, 'Ed', 'Carl');
  assert.ok(split);
  assert.equal(split.rep + split.prospect, 100);
  assert.ok(split.prospect > 0 && split.rep > 0);
});

test('approved card: 59, Carl 65 / Ed 35, ten scores, three fixes, no dash', () => {
  const built = buildReview({
    scores: {
      opening: 7, empathy: 7, emotion: 5, non_neediness: 8, stories: 5,
      assertive: 6, self_sell: 5, isolate: 6, close: 5, next_steps: 5,
    },
    verdict: 'Calm and honest. Listened well. Never chased the price. Lost it on urgency and a soft next step. Carl is stuck on HR timing and the coast move, and the offer was too far off. Extra sentence that should be cut because five is the max.',
    keep: ['Stayed calm when the number came up.', 'Asked about HR before defending the offer.'],
    fix: [
      'Ask what has to be true for him to move this month.',
      'Isolate the price from the HR date before you talk dollars.',
      'Leave with a day and a time, not sometime next week.',
    ],
    worst_line: 'We could probably come up a little if that helps you feel better about it.',
    better_line: 'Sounds like the number is the only gap once HR confirms. What number lets you say yes the day they do?',
    prospect_talk: 10,
  }, { repName: 'Ed Reyes', prospectName: 'Carl Jensen', talk: { prospect: 65, rep: 35 } });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const text = formatCoaching(built.review);
  assert.equal(built.review.overall, 59);
  assert.match(text, /^59\/100 · Ed ↔ Carl/);
  assert.match(text, /Talk: Carl 65 \/ Ed 35/);
  assert.match(text, /Opening 7 · Empathy 7 · Emotion 5 · Non-neediness 8 · Stories 5 · Assertive 6 · Self-sell 5 · Isolate objection 6 · Close 5 · Next steps 5/);
  assert.equal(built.review.fix.length, 3);
  assert.equal(built.review.keep.length, 2);
  assert.doesNotMatch(built.review.verdict, /Extra sentence/);
  assert.equal(copyIsClean(text), true);
  assert.equal(text.includes('\u2014'), false);
  console.log('\n--- sample scorecard ---\n' + text + '\n--- end sample ---\n');
});

test('a contrast that survives the cleaner is rejected', () => {
  const built = buildReview({
    scores: {
      opening: 5, empathy: 5, emotion: 5, non_neediness: 5, stories: 5,
      assertive: 5, self_sell: 5, isolate: 5, close: 5, next_steps: 5,
    },
    verdict: "He is stuck. It is not the house it is the timing and he said so twice more in the call today.",
    keep: ['Listened.'],
    fix: ['Ask the date.', 'Stop chasing.', 'Book Tuesday.'],
    worst_line: 'We can do better.',
    better_line: 'What date works?',
  }, { repName: 'Ed', prospectName: 'Carl', talk: { prospect: 60, rep: 40 } });
  assert.equal(built.ok, false);
});

test('recording pass replaces a live card, and a failure stays until forced', () => {
  const live = demoCoachingReview();
  live.source = 'live';
  assert.equal(shouldRefreshCoaching(live, 'recording'), true);
  assert.equal(shouldRefreshCoaching(live, 'live'), false);
  assert.equal(shouldRefreshCoaching({ status: 'failed', error: 'nope', scored_at: '' }, 'recording'), false);
  assert.equal(shouldRefreshCoaching({ status: 'failed', error: 'nope', scored_at: '' }, 'ondemand', true), true);
  assert.equal(shouldRefreshCoaching(null, 'recording'), true);
});

test('demo card is clean and uses the scripted names', () => {
  const demo = demoCoachingReview();
  assert.equal(demo.rep_name, 'Taylor');
  assert.equal(demo.prospect_name, 'Kara');
  assert.equal(copyIsClean(demo.text), true);
  assert.equal(demo.fix.length, 3);
});

test('first name only', () => {
  assert.equal(firstName('Ed Reyes', 'Rep'), 'Ed');
  assert.equal(firstName('  ', 'Rep'), 'Rep');
});

test('isConversation: a two-sided call passes, a voicemail and a quick hang-up do not', () => {
  const names = { repName: 'Taylor', prospectName: 'Kara Lee' };
  const talk = [
    'Kara: Hello, who is this calling about my house on Elm?',
    'Taylor: Hi Kara, this is Taylor with Acme Homes, you filled out a form about selling.',
    'Kara: Right, yes, we have to be out by the end of the month and the roof leaks.',
    'Taylor: Got it. What would a good outcome look like for you on timing and price?',
  ].join('\n');
  assert.equal(isConversation(talk, names), true);
  assert.equal(isConversation(talk, { ...names, durationS: 95 }), true);
  assert.equal(isConversation(talk, { ...names, durationS: 14 }), false);
  const voicemail = [
    'Kara: You have reached Kara, leave a message after the tone.',
    'Taylor: Hi Kara, Taylor with Acme Homes calling about the house on Elm, give me a call back when you get a chance, thanks so much.',
  ].join('\n');
  assert.equal(isConversation(voicemail, names), false);
  assert.equal(isConversation('Taylor: Hello? Hello?', names), false);
  assert.equal(isConversation(Array(70).fill('word').join(' '), names), true);
});

test('shouldRefreshCoaching: a skipped call is not re-coached unless forced', () => {
  const skipped = { status: 'skipped', error: 'No two-sided conversation to coach.' };
  assert.equal(shouldRefreshCoaching(skipped, 'recording'), false);
  assert.equal(shouldRefreshCoaching(skipped, 'ondemand', true), true);
});

console.log(passed + ' passed');

test("isVoicemailDrop: a greeting and the rep's message is a voicemail; a real call is not", () => {
  const vm = "[0:00] Owner: The\n[0:01] Owner: person you're trying to reach is not available.\n[0:03] Owner: At the tone, please record your message. When you have finished recording, you may hang up.\n[0:09] Owner: This is Chris. Please give me a callback. Thanks. Bye.";
  assert.equal(isVoicemailDrop({ transcript: vm, repName: 'Drew Collins', prospectName: 'Pat Lee', durationS: 38 }), true);
  assert.equal(isVoicemailDrop({ outcome: 'Left voicemail' }), true);
  assert.equal(isVoicemailDrop({ outcome: 'Appointment set' }), false);
  const talk = Array.from({ length: 8 }, (_, i) => (i % 2 ? 'Seller: I have been thinking about selling the house on Oak this spring maybe.' : 'Chris: Thanks for picking up, can you tell me more about the property and your timeline?')).join('\n');
  assert.equal(isVoicemailDrop({ transcript: talk, repName: 'Drew Collins', prospectName: 'Pat Lee', durationS: 180 }), false);
});
