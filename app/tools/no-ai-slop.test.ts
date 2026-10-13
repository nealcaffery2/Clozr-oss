// The no-AI-slop rules every agent writes and talks by (adapted from
// github.com/petergyang/no-ai-slop): each pattern is caught, plain writing is not.
// Run: npx tsx tools/no-ai-slop.test.ts
import assert from 'node:assert/strict';
import { MESSAGE_RULES, SLOP_PATTERNS, SPOKEN_RULES, WRITING_RULE, slopFindings, slopReport } from '../supabase/functions/_shared/no-ai-slop';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const caught = (t: string) => slopFindings(t).map((f) => f.pattern);

test('each pattern is caught', () => {
  const cases: [string, string][] = [
    ['We leverage public records to get you comps.', 'banned word'],
    ['Let me delve into the numbers.', 'banned word'],
    ['It will elevate your offers.', 'banned word'],
    ["It's worth noting the roof is new.", 'empty phrase'],
    ['At the end of the day, speed wins.', 'empty phrase'],
    ['When it comes to comps, we are fast.', 'empty phrase'],
    ["It's not about price, it's about speed.", 'binary contrast'],
    ["This isn't a CMA. It's a max offer.", 'binary contrast'],
    ['It gives you not just comps but a full MAO.', 'binary contrast'],
    ["Here's the thing, most offers go out slow.", 'throat-clearing opener'],
    ["I'll be honest, the roof is rough.", 'throat-clearing opener'],
    ["Here's what nobody tells you about ARV.", 'faux-insight setup'],
    ['The best part: it runs on your phone.', 'colon reveal'],
    ['We added batch runs, highlighting our focus on speed.', 'superficial analysis'],
    ['The launch marks a pivotal moment for us.', 'importance puffery'],
    ['It is a testament to the team.', 'importance puffery'],
    ['As you can see, the numbers work.', 'reader guidance'],
    ['Experts agree this market is hot.', 'weasel attribution'],
    ['Studies show faster offers win.', 'weasel attribution'],
    ['The app serves as a hub for your deals.', 'fake-strong verb'],
    ['Not a CMA. Not a guess. A real offer.', 'negative listing'],
    ['What if I told you comps take a minute?', 'rhetorical setup'],
    ['Plot twist: it was the roof.', 'rhetorical setup'],
    ['We went over the comps. Ultimately, the house works.', 'summary ending'],
    ['In conclusion, we should talk.', 'summary ending'],
    ['The roof is new — the HVAC is not.', 'em dash'],
    ['That house is **way** under market.', 'decorative bold'],
    ['Great deal \u{1F525}', 'emoji'],
  ];
  for (const [t, p] of cases) assert.ok(caught(t).includes(p), `${p}: ${t} -> ${caught(t).join(', ')}`);
});

test('plain, specific writing passes', () => {
  for (const t of [
    "Hey Dana, it's Cody with Compr. What are you working on right now?",
    'Ran 918 Champions Way. ARV came back about $545,200 and the wholesale offer about $362,400.',
    'Got you Thursday at 10am CDT. What email should the invite go to?',
    'The roof is 12 years old and the HVAC was replaced in 2021.',
    'Comps ran 3-5 miles out because the area is rural.',
    'Not interested? No problem, I will not reach out again.',
    'We closed on the Oak St house Friday. The seller netted $41,000.',
    'Their foster kids are moving out in June, so they want to sell after that.',
    'It is an elevated lot, so flood insurance is cheap.',
  ]) assert.deepEqual(caught(t), [], t);
});

test('a quoted example in backticks does not count', () => {
  assert.deepEqual(caught('Never write `leverage` in a text.'), []);
});

test('the report names the pattern, quotes it and gives the fix', () => {
  assert.match(slopReport(slopFindings('We leverage data.')), /^banned word \("leverage"\): use the plain word$/);
});

test('the prompt rules carry the lists and use none of the slop themselves outside the lists', () => {
  for (const r of [WRITING_RULE, MESSAGE_RULES, SPOKEN_RULES]) {
    assert.match(r, /delve/);
    assert.match(r, /at the end of the day/);
    assert.ok(!/[—]/.test(r), 'no em dash in the rules');
  }
  assert.ok(SLOP_PATTERNS.length >= 18);
});

console.log(`no-ai-slop: ${passed} passed`);
