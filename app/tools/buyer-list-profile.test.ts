// Buyers by workspace profile: which lists show, their names and who is on them.
// Run: npx tsx tools/buyer-list-profile.test.ts
import { COMPR_ALL_LIST, COMPR_CONTACTED_LIST, COMPR_IN_PLAN_LIST, COMPR_INTERESTED_LIST, COMPR_NOT_CONTACTED_LIST, COMPR_NOT_INTERESTED_LIST, COMPR_PAID_LIST, COMPR_TRIAL_LIST, buyerListIds, isComprPaying, buyerListLabelOf, buyerListProfileOf, effectiveBuyerList, inBuyerList } from '../lib/buyer-list-profile';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('compr setting is the compr profile', buyerListProfileOf('compr'), 'compr');
eq('no setting is the default', buyerListProfileOf(undefined), 'default');
eq('an unknown value is the default', buyerListProfileOf('realtors'), 'default');

eq('default lists are unchanged', buyerListIds('default'), ['buyers', 'compr-customer-prospect', 'buyer-prospect', 'capital-raise-prospect', 'realtors']);
eq('compr lists: the seven buckets, then everyone', buyerListIds('compr'), [COMPR_NOT_CONTACTED_LIST, COMPR_IN_PLAN_LIST, COMPR_CONTACTED_LIST, COMPR_INTERESTED_LIST, COMPR_NOT_INTERESTED_LIST, COMPR_TRIAL_LIST, COMPR_PAID_LIST, COMPR_ALL_LIST]);
eq('compr labels', buyerListIds('compr').map((id) => buyerListLabelOf(id, 'compr')), ['Not contacted', 'In an action plan', 'Contacted', 'Interested', 'Not interested', 'Free trial', 'Paid users', 'All contacts']);
const bucket = (row: object) => buyerListIds('compr').filter((id) => id !== COMPR_ALL_LIST && inBuyerList(id, row, 'compr'));
eq('compr: everyone is on exactly one bucket', [bucket({}), bucket({ stage: 'Contacted' }), bucket({ stage: 'Contacted', comprInPlan: true }), bucket({ stage: 'Not contacted', comprInPlan: true })], [[COMPR_NOT_CONTACTED_LIST], [COMPR_CONTACTED_LIST], [COMPR_IN_PLAN_LIST], [COMPR_IN_PLAN_LIST]]);
eq('compr: what they said beats a running plan', [bucket({ stage: 'Not interested', comprInPlan: true }), bucket({ stage: 'Interested', comprInPlan: true })], [[COMPR_NOT_INTERESTED_LIST], [COMPR_INTERESTED_LIST]]);
eq('compr: paid and trial beat the stage', [bucket({ stage: 'Not interested', comprPaid: true }), bucket({ stage: 'Contacted', comprTrial: true }), bucket({ stage: 'Paid' })], [[COMPR_PAID_LIST], [COMPR_TRIAL_LIST], [COMPR_PAID_LIST]]);
eq('compr: the paid list is paying now', [inBuyerList(COMPR_PAID_LIST, { comprPaid: true }, 'compr'), inBuyerList(COMPR_PAID_LIST, { comprPaid: false }, 'compr')], [true, false]);
eq('a lapsed plan is off the paid list', [isComprPaying(['compr-paid']), isComprPaying(['compr-paid', 'compr-free-trial'])], [true, false]);
eq('default labels', [buyerListLabelOf('buyers', 'default'), buyerListLabelOf('realtors', 'default')], ['Buyers', 'Realtors']);

eq('default: a prospect sits on its pen, not Buyers', [inBuyerList('buyers', { prospectList: 'buyer-prospect' }, 'default'), inBuyerList('buyer-prospect', { prospectList: 'buyer-prospect' }, 'default')], [false, true]);
eq('compr: the trial list is the trial tag', [inBuyerList(COMPR_TRIAL_LIST, { comprTrial: true }, 'compr'), inBuyerList(COMPR_TRIAL_LIST, { comprTrial: false }, 'compr')], [true, false]);
eq('compr: all contacts holds prospects too', inBuyerList(COMPR_ALL_LIST, { prospectList: 'compr-customer-prospect' }, 'compr'), true);

eq('the default buyers list opens Not contacted', effectiveBuyerList('buyers', 'compr'), COMPR_NOT_CONTACTED_LIST);
eq('realtors from People opens Not contacted too', effectiveBuyerList('realtors', 'compr'), COMPR_NOT_CONTACTED_LIST);
eq('a compr list on a default workspace falls back to Buyers', effectiveBuyerList(COMPR_TRIAL_LIST, 'default'), 'buyers');
eq('a list the profile has stays', effectiveBuyerList('buyer-prospect', 'default'), 'buyer-prospect');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
