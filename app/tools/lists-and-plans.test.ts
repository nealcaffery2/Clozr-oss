// Smart lists, contact filters, deal type, source score, and the plan catalog.
// Run: npx tsx tools/lists-and-plans.test.ts
import { applySmartListDrop, layoutSmartLists, togglePinnedList } from '../lib/smart-list-layout';
import { hasEmail, hasPhone, matchesContactFilters } from '../lib/contact-presence';
import { dealTypeLabel, dispoAssignment, parseDealType, tcChecklistFor } from '../lib/deal-types';
import { assigneeForIncomingLead, flagsForStage, formatSourceScore, isNationalSource, shouldPingUnderwriteComplete, sourceGetsEmailFollowup, sourceScorecard } from '../lib/source-score';
import { ACTION_PLAN_CATALOG, catalogByAudience, planFitsRecord, plansForRecord } from '../lib/action-plan-catalog';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const defaults = ['My Leads', 'New Leads', 'Hot Leads', 'Follow Up Today', 'No Contact'];
eq('pins float to the top in saved order', layoutSmartLists(defaults, ['No Contact', 'Hot Leads', 'My Leads', 'New Leads', 'Follow Up Today'], ['Hot Leads', 'My Leads']),
  ['Hot Leads', 'My Leads', 'No Contact', 'New Leads', 'Follow Up Today']);
eq('missing saved labels are appended', layoutSmartLists(defaults, ['Hot Leads'], []),
  ['Hot Leads', 'My Leads', 'New Leads', 'Follow Up Today', 'No Contact']);

const dropped = applySmartListDrop(
  ['My Leads', 'New Leads', 'Hot Leads'],
  ['My Leads'],
  'Hot Leads',
  'My Leads',
);
eq('dropping onto a pin pins the row', dropped.pinned.includes('Hot Leads'), true);
eq('drop order puts the dragged row in front of the target', dropped.order[0], 'Hot Leads');
eq('unpin toggles', togglePinnedList(['My Leads', 'Hot Leads'], 'Hot Leads'), ['My Leads']);
eq('pin toggles on', togglePinnedList(['My Leads'], 'Hot Leads'), ['My Leads', 'Hot Leads']);

eq('seven digits is a phone', hasPhone('(210) 555-0136'), true);
eq('a dash is not a phone', hasPhone('—'), false);
eq('blank is not a phone', hasPhone(''), false);
eq('real email', hasEmail('a@acmehomes.com'), true);
eq('dash is not an email', hasEmail('—'), false);
eq('has phone filter', matchesContactFilters('2105550136', '', 'Has phone', 'Any'), true);
eq('no phone filter rejects a phone', matchesContactFilters('2105550136', 'a@b.co', 'No phone', 'Any'), false);
eq('no email filter', matchesContactFilters('', '—', 'Any', 'No email'), true);
eq('has email filter', matchesContactFilters('', 'a@b.co', 'Any', 'Has email'), true);
eq('both filters', matchesContactFilters('2105550136', '', 'Has phone', 'No email'), true);

eq('novation label', dealTypeLabel('novation'), 'Novation');
eq('double close label', dealTypeLabel('Double close'), 'Double Close');
eq('jv label', dealTypeLabel('joint venture'), 'JV');
eq('assignment label', dealTypeLabel('Wholesale'), 'Assignment');
eq('empty deal type', dealTypeLabel(''), '');
eq('novation checklist', tcChecklistFor('Novation'), 'novation');
eq('jv stays on assignment checklist', tcChecklistFor('JV'), 'assignment');
eq('double close checklist', parseDealType('double_close')?.key, 'double_close');
eq('novation dispo is the round robin', dispoAssignment('Novation'), 'round_robin');
eq('assignment dispo is whoever sells it', dispoAssignment('Assignment'), 'seller');
eq('double close dispo is whoever sells it', dispoAssignment('double close'), 'seller');
eq('jv dispo is not forced', dispoAssignment('JV'), null);

const card = sourceScorecard([
  flagsForStage('Offer Accepted', 0, true),
  flagsForStage('Offer Declined', 0, true),
  flagsForStage('Closed', 12500, true),
  flagsForStage('New Submission', 0, false),
]);
eq('brought', card.brought, 4);
eq('declined', card.declined, 1);
eq('closed', card.closed, 1);
eq('fees', card.fees, 12500);
eq('acceptance uses offers', card.acceptancePct, 67);
eq('score line', formatSourceScore(card).includes('4 brought'), true);
eq('national partner', isNationalSource({ kind: 'Institutional seller', name: 'Amherst' }), true);
eq('local wholesaler gets email', sourceGetsEmailFollowup({ kind: 'Wholesaler', name: 'Oak Street Homes' }), true);
eq('national tag skips email', sourceGetsEmailFollowup({ kind: 'Wholesaler', tags: ['National partner'] }), false);
eq('creator is the assignee', assigneeForIncomingLead('user-1'), 'user-1');
eq('blank creator stays unassigned', assigneeForIncomingLead('  '), null);
eq('underwrite ping once', shouldPingUnderwriteComplete('Underwriting', 'Underwriting Complete'), true);
eq('underwrite ping does not repeat', shouldPingUnderwriteComplete('Underwriting Complete', 'Underwriting Complete'), false);

eq('three seller plans', catalogByAudience('seller').length, 3);
eq('three buyer plans', catalogByAudience('buyer').length, 3);
eq('tc plans from the workflow', catalogByAudience('tc').length >= 3, true);
eq('source plan skips national', catalogByAudience('source')[0].skip_tags, ['National', 'National partner']);
eq('source emails are not copies', new Set(catalogByAudience('source')[0].steps.map((s) => s.subject)).size, catalogByAudience('source')[0].steps.length);
eq('tc contract plan leads with the 10 minute send', catalogByAudience('tc')[0].steps[0].title.includes('10 minutes'), true);
eq('catalog names are unique', new Set(ACTION_PLAN_CATALOG.map((p) => p.name)).size, ACTION_PLAN_CATALOG.length);

eq('seller plan on seller record', planFitsRecord('seller', 'seller'), true);
eq('seller plan not on buyer', planFitsRecord('seller', 'buyer'), false);
eq('buyer plan on buyer', planFitsRecord('buyer', 'buyer'), true);
eq('buyer plan not on seller', planFitsRecord('buyer', 'seller'), false);
eq('tc on seller', planFitsRecord('tc', 'seller'), true);
eq('tc on buyer', planFitsRecord('tc', 'buyer'), true);
eq('tc on vendor', planFitsRecord('tc', 'vendor'), true);
eq('source on vendor', planFitsRecord('source', 'vendor'), true);
eq('source not on seller', planFitsRecord('source', 'seller'), false);
eq('blank audience = seller legacy', planFitsRecord('', 'seller'), true);
eq('blank audience not buyer', planFitsRecord(undefined, 'buyer'), false);

const sample = [
  { id: '1', active: true, audience: 'seller', name: 'S' },
  { id: '2', active: true, audience: 'buyer', name: 'B' },
  { id: '3', active: true, audience: 'tc', name: 'T' },
  { id: '4', active: false, audience: 'seller', name: 'Off' },
  { id: '5', active: true, audience: 'source', name: 'Src' },
];
eq('seller dropdown lists plans that are off too (started by hand)', plansForRecord(sample, 'seller').map((p) => p.name), ['S', 'T', 'Off']);
eq('buyer dropdown', plansForRecord(sample, 'buyer').map((p) => p.name), ['B', 'T']);
eq('vendor dropdown', plansForRecord(sample, 'vendor').map((p) => p.name), ['T', 'Src']);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
