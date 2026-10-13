// Buyers system lists: which lists show, their names and who is on them.
// Run: npx tsx tools/buyer-list-profile.test.ts
import { buyerListIds, buyerListLabelOf, effectiveBuyerList, inBuyerList } from '../lib/buyer-list-profile';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('default lists', buyerListIds(), ['buyers', 'buyer-prospect', 'capital-raise-prospect', 'realtors']);
eq('default labels', [buyerListLabelOf('buyers'), buyerListLabelOf('realtors')], ['Buyers', 'Realtors']);
eq('an unknown list has no label', buyerListLabelOf('nope'), null);

eq('a prospect sits on its pen, not Buyers', [inBuyerList('buyers', { prospectList: 'buyer-prospect' }), inBuyerList('buyer-prospect', { prospectList: 'buyer-prospect' })], [false, true]);
eq('a buyer with no pen is on Buyers', inBuyerList('buyers', { prospectList: null }), true);

eq('an unknown list falls back to Buyers', effectiveBuyerList('nope'), 'buyers');
eq('a system list stays', effectiveBuyerList('buyer-prospect'), 'buyer-prospect');
eq('an extra list stays', effectiveBuyerList('saved-1', ['saved-1']), 'saved-1');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
