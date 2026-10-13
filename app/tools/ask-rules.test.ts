// Ask CLOZR's tool loop: the explicit-yes gate, stage matching, the Today context, the thread and the cards.
// Run: npx tsx tools/ask-rules.test.ts
import { cleanCards, focusContext, matchStage, saidYes, threadFrom } from '../supabase/functions/_shared/ask-rules';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('yes: plain yes and friends', ['yes', 'Yes please', 'yep', 'ok', 'Go ahead', 'confirm', 'do it'].map(saidYes), [true, true, true, true, true, true, true]);
eq('yes: a request is not a yes', saidYes('enroll Kara in the cold lead plan'), false);
eq('yes: a no wins', ['no', 'yes, but wait', "don't", 'not yet', 'cancel that'].map(saidYes), [false, false, false, false, false]);
eq('yes: inside a sentence', saidYes('Yes — put her on it'), true);

const stages = ['Lead', 'Offer Made - Follow Up', 'Closed'];
eq('stage: exact', matchStage(stages, 'Closed'), 'Closed');
eq('stage: case and punctuation', matchStage(stages, 'offer made follow up'), 'Offer Made - Follow Up');
eq('stage: unknown or blank', [matchStage(stages, 'Dead'), matchStage(stages, '')], [null, null]);

eq('focus context: numbered, ids kept, junk dropped', focusContext([
  { id: 'task:1', kind: 'overdue_task', record: { kind: 'seller', id: 10 }, title: 'Kara Mitchell', why: 'Call back about the roof, 2 days overdue.' },
  { id: 'x', record: { kind: 'seller', id: 'nope' }, title: 'bad' },
  { id: 'closing:40', kind: 'closing', record: { kind: 'deal', id: 40 }, title: '1803 Cypress Ln', detail: 'Closes in 2 days.' },
]), '1. Kara Mitchell — Call back about the roof, 2 days overdue. [seller_id 10, overdue_task]\n3. 1803 Cypress Ln — Closes in 2 days. [deal_id 40, closing]');
eq('focus context: not a list', focusContext(null), '');

eq('thread: last six, user first, same roles merged', threadFrom([
  { role: 'clozr', text: 'stray' }, { role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'clozr', text: 'c' }, { role: 'system', text: 'x' },
]), [{ role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'c' }]);

eq('cards: only rows a tool returned, each once, six at most', cleanCards([
  { kind: 'seller', id: 10, title: 'Kara', subtitle: 'Qualified' },
  { kind: 'seller', id: 10, title: 'Kara again', subtitle: '' },
  { kind: 'deal', id: 99, title: 'made up', subtitle: '' },
  { kind: 'vendor', id: 1, title: 'nope', subtitle: '' },
  { kind: 'deal', id: '40', title: 'Cypress', subtitle: 5 },
], new Set(['seller:10', 'deal:40'])), [{ kind: 'seller', id: 10, title: 'Kara', subtitle: 'Qualified' }, { kind: 'deal', id: 40, title: 'Cypress', subtitle: '' }]);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
