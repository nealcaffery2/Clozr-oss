// Ask CLOZR's plan picker. Run: npx tsx tools/plan-match.test.ts
import { matchPlan } from '../supabase/functions/_shared/plan-match';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const plans = [
  { id: 1, name: 'New Lead Follow-Up' },
  { id: 2, name: 'Offer Made Follow-Up' },
  { id: 3, name: 'Buyer Welcome' },
  { id: 4, name: 'Offer Made' },
];
const ids = (m: ReturnType<typeof matchPlan>) =>
  'plan' in m ? m.plan.id : 'ambiguous' in m ? m.ambiguous.map((p) => p.id) : null;

eq('id as number', ids(matchPlan(plans, 3)), 3);
eq('id as string', ids(matchPlan(plans, '2')), 2);
eq('exact name beats a longer one', ids(matchPlan(plans, 'offer made')), 4);
eq('punctuation and case ignored', ids(matchPlan(plans, 'NEW LEAD follow up')), 1);
eq('words in one name', ids(matchPlan(plans, 'buyer')), 3);
eq('words in two names is ambiguous', ids(matchPlan(plans, 'follow up')), [1, 2]);
eq('no match', ids(matchPlan(plans, 'probate')), null);
eq('empty is no match', ids(matchPlan(plans, '  ')), null);
eq('unknown id falls back to name', ids(matchPlan(plans, '99')), null);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
