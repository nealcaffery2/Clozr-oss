// "Clozr for today": the rules' candidates, the top six, and what the model may change.
// Run: npx tsx tools/focus.test.ts
import { applyFocusRank, checkFocusWhy, focusCandidates, focusTop, motivationScore, rulesFocus, type FocusInput } from '../lib/focus';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// Saturday 4 October 2026, 10:00 in San Antonio (15:00Z).
const now = new Date('2026-10-04T15:00:00Z');
const tz = 'America/Chicago';
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

const input: FocusInput = {
  now, tz,
  tasks: [
    { id: 1, title: 'Call back about the roof', task_type: 'call', due_at: '2026-10-02T15:00:00Z', seller_id: 10, deal_id: null, seller_name: 'Kara Mitchell' },
    { id: 2, title: 'Send the offer', task_type: 'todo', due_at: '2026-10-04T20:30:00Z', seller_id: 11, deal_id: null, seller_name: 'Ronald Moore' },
    { id: 3, title: 'Tomorrow thing', task_type: 'todo', due_at: '2026-10-05T16:00:00Z', seller_id: 12, deal_id: null, seller_name: 'Not today' },
    // The same seller as the overdue one: shown once.
    { id: 4, title: 'Second task on Kara', task_type: 'todo', due_at: '2026-10-04T18:00:00Z', seller_id: 10, deal_id: null, seller_name: 'Kara Mitchell' },
  ],
  appointments: [
    { id: 7, title: 'Walkthrough', starts_at: '2026-10-04T19:00:00Z', seller_id: 13, seller_name: 'Harold Kim', location: '9021 Brookhollow' },
    { id: 8, title: 'Yesterday', starts_at: '2026-10-03T19:00:00Z', seller_id: 14, seller_name: 'Old', location: null },
  ],
  newLeads: [{ id: 20, name: 'Dana Ortiz', lead_stage: 'Lead', motivation: null, property_address: '12 Elm St', last_touch_at: null, created_at: '2026-10-04T13:00:00Z', source: 'PPC' }],
  coldLeads: [
    { id: 30, name: 'Low Motive', lead_stage: 'Qualified', motivation: 'low', property_address: null, last_touch_at: ago(9), created_at: ago(30) },
    { id: 31, name: 'Hot Motive', lead_stage: 'Qualified', motivation: 'Hot — divorce', property_address: null, last_touch_at: ago(4), created_at: ago(30) },
    { id: 32, name: 'Touched yesterday', lead_stage: 'Qualified', motivation: '9', property_address: null, last_touch_at: ago(1), created_at: ago(30) },
  ],
  closings: [
    { id: 40, stage: 'In Escrow', close_date: '2026-10-06', stage_entered_at: ago(10), address: '1803 Cypress Ln', seller_id: 2, seller_name: 'Ronald', offer_amount: 186000 },
    { id: 41, stage: 'In Escrow', close_date: '2026-10-20', stage_entered_at: ago(10), address: 'Far away', seller_id: 3, seller_name: 'X', offer_amount: null },
  ],
  staleDeals: [
    { id: 50, stage: 'Ready To Market', close_date: null, stage_entered_at: ago(20), address: '615 Lake Ridge', seller_id: 4, seller_name: 'Gary', offer_amount: 120000 },
    { id: 51, stage: 'Ready To Market', close_date: null, stage_entered_at: ago(5), address: 'Fresh', seller_id: 5, seller_name: 'Y', offer_amount: null },
  ],
};

const c = focusCandidates(input);
eq('rules order: overdue, appointment, new lead, due today, closing, cold (hot first), stale deal',
  c.map((x) => x.id),
  ['task:1', 'appointment:7', 'new_lead:20', 'task:2', 'closing:40', 'cold_lead:31', 'cold_lead:30', 'stale_deal:50']);
eq('overdue task line', c[0].detail, 'Call back about the roof, 2 days overdue.');
eq('a record shows once, in its first source', c.filter((x) => x.record.kind === 'seller' && x.record.id === 10).length, 1);
eq('appointment clock time is the rep\'s zone', c[1].detail, 'Walkthrough at 2:00 PM, 9021 Brookhollow.');
eq('closing line keeps the date and the money', c[4].detail, 'In Escrow, closes in 2 days (2026-10-06), under contract at $186,000.');
eq('cold lead line', c[5].detail, 'Qualified, no touch in 4 days. Motivation: Hot — divorce.');
eq('deal records open deals', c[4].record, { kind: 'deal', id: 40 });

eq('motivation: numbers, words, blank', [motivationScore('7/10'), motivationScore('HIGH'), motivationScore('warm'), motivationScore(''), motivationScore('not really')], [7, 8, 5, 0, 2]);

const top = focusTop(c);
eq('top six, at most two of a kind first, rules order kept', top.map((x) => x.id), ['task:1', 'appointment:7', 'new_lead:20', 'task:2', 'closing:40', 'cold_lead:31']);
eq('rules result', { source: rulesFocus(c).source, n: rulesFocus(c).items.length, g: rulesFocus(c).greeting }, { source: 'rules', n: 6, g: '6 things to do first out of 8, 1 of them overdue.' });
eq('rules result with nothing', rulesFocus([]).greeting, 'Nothing is pressing. A good day to work the cold list.');

eq('why: a number the item does not have is refused', checkFocusWhy(c[4], 'Closing in 3 days at $190,000'), null);
eq('why: its own numbers are fine', checkFocusWhy(c[4], 'Closes in 2 days at $186,000. Confirm title.'), 'Closes in 2 days at $186,000. Confirm title.');
eq('why: too long or not a string', [checkFocusWhy(c[0], 'x'.repeat(200)), checkFocusWhy(c[0], 5)], [null, null]);

const ai = applyFocusRank(c, {
  greeting: 'A closing and an overdue callback lead the day.',
  items: [
    { id: 'closing:40', why: 'Closes in 2 days. Confirm title has the payoff.' },
    { id: 'made-up:1', why: 'invented' },
    { id: 'closing:40', why: 'twice' },
    { id: 'task:1', why: 'Promised a callback 9 days ago' },
  ],
});
eq('ai: its order, only known ids, each once, topped up to three', ai && ai.items.map((x) => x.id), ['closing:40', 'task:1', 'appointment:7']);
eq('ai: a line with a foreign number falls back to the rule line', ai && ai.items[1].why, 'Call back about the roof, 2 days overdue.');
eq('ai: names stay the database\'s', ai && ai.items[0].title, '1803 Cypress Ln');
eq('ai: source and greeting', ai && [ai.source, ai.greeting], ['ai', 'A closing and an overdue callback lead the day.']);
eq('ai: a greeting with an invented number is replaced', applyFocusRank(c, { greeting: '17 deals close today', items: [{ id: 'task:1', why: '' }] })?.greeting, '3 things to do first out of 8, 1 of them overdue.');
eq('ai: nothing usable is null', applyFocusRank(c, { items: [{ id: 'nope' }] }), null);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
