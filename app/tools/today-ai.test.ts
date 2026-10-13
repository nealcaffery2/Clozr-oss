// Clozr AI's order merged into Today's rules list. Run: npx tsx tools/today-ai.test.ts
import { mergeTodayAi, todayCandidates, type TodayRow } from '../lib/today';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const row = (pid: string, group: TodayRow['group'], extra: Partial<TodayRow> = {}): TodayRow => ({
  pid, group, name: pid.toUpperCase(), stage: 'New Lead', tag: 'Today', tagTone: 'muted', reason: 'r ' + pid, why: 'w ' + pid,
  task: null, claim: false, target: { name: pid, phone: '', personId: pid }, address: '', ...extra,
});
const rules = [row('a', 'now'), row('b', 'now'), row('c', 'due'), row('d', 'due'), row('e', 'offers', { tag: '$150,000', tagTone: 'money' })];
const ids = (rows: TodayRow[]) => rows.map((r) => r.pid);

eq('no ranking keeps the rules', ids(mergeTodayAi(rules, null)), ['a', 'b', 'c', 'd', 'e']);

const ai = { greeting: 'Two new leads.', items: [{ id: 'd', why: 'Promised a call back at 2' }, { id: 'b', why: 'Fresh lead' }, { id: 'zz', why: 'made up' }, { id: 'b', why: 'dupe' }] };
const merged = mergeTodayAi(rules, ai);
eq('ranked inside each group, groups stand', ids(merged), ['b', 'a', 'd', 'c', 'e']);
eq('unknown ids are dropped', merged.length, 5);
eq('why rides on ranked rows, first mention wins', merged.map((r) => r.aiWhy ?? null), ['Fresh lead', null, 'Promised a call back at 2', null, null]);
eq('rules rows untouched', rules.some((r) => r.aiWhy), false);

const withDone = [row('a', 'now', { done: { label: 'Talked' } }), ...rules.slice(1)];
const cands = todayCandidates(withDone);
eq('saved rows are not candidates', cands.map((c) => c.id), ['b', 'c', 'd', 'e']);
eq('candidate fields', cands[3], { id: 'e', kind: 'offers', label: 'E', due: '$150,000', stage: 'New Lead', value: '$150,000', detail: 'r e. w e' });

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
