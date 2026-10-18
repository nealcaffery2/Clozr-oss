// npx tsx tools/people-page.test.ts
// serverFilters: which lists and filters the server pages, and what it is asked.
import assert from 'node:assert/strict';
import { serverFilters } from '../lib/people-page.ts';
import { PICK_SEP } from '../lib/multi-filter.ts';

const base = {
  list: 'Sellers', saved: false, q: '', me: 'u1', teamIds: { Nat: 'u1', Sam: 'u2' }, hiddenIds: [] as string[],
  stageOrder: ['Lead', 'Offer Made'], now: new Date(2026, 9, 18, 15, 0),
};
const pf = (over: Record<string, string | undefined> = {}) => ({ owner: 'Any', stage: 'Any', source: 'Any', tag: 'Any', date: 'Any', sort: 'Recent', ...over });

// Every list the server pages, and the ones it leaves in memory.
assert.deepEqual(serverFilters({ ...base, pf: pf() })?.filters.not_tags, ['secret-blacklist']);
assert.deepEqual(serverFilters({ ...base, list: 'My Leads', pf: pf() })?.filters.owners, ['u1']);
assert.equal(serverFilters({ ...base, list: 'My Leads', me: null, pf: pf() }), null);
assert.ok(serverFilters({ ...base, list: 'New Leads', pf: pf() })!.filters.stages!.includes('Lead - No Contact'));
assert.ok(!serverFilters({ ...base, list: 'New Leads', pf: pf() })!.filters.stages!.includes('Offer Made'));
assert.equal(serverFilters({ ...base, list: 'Follow Up Today', pf: pf() })!.filters.due_before, new Date(2026, 9, 19).toISOString());
assert.equal(serverFilters({ ...base, list: 'No Contact', pf: pf() })!.filters.touch, 'none');
assert.equal(serverFilters({ ...base, list: 'Appointments', pf: pf() })!.filters.stage_prefix, 'Appointment');
assert.ok(serverFilters({ ...base, list: 'Dead Leads', pf: pf() })!.filters.stages!.includes('Terminated'));
assert.ok(serverFilters({ ...base, list: 'Reactivation', pf: pf() })!.filters.not_stages!.includes('Closed'));
assert.equal(serverFilters({ ...base, list: 'Reactivation', pf: pf() })!.filters.touch_quiet_min, 4000);
assert.equal(serverFilters({ ...base, list: 'Hot Leads', pf: pf() }), null);
assert.equal(serverFilters({ ...base, list: 'Total Submissions', pf: pf() }), null);
assert.deepEqual(serverFilters({ ...base, list: 'A saved list', saved: true, pf: pf({ stage: 'Lead' }) })!.filters.stages, ['Lead']);

// Filters: picks, intersections, the ones with no server side.
const owned = serverFilters({ ...base, pf: pf({ owner: 'Sam' + PICK_SEP + 'Unassigned' }) })!.filters;
assert.deepEqual([owned.owners, owned.unassigned], [['u2'], true]);
assert.equal(serverFilters({ ...base, pf: pf({ owner: 'Nobody' }) }), null);
assert.deepEqual(serverFilters({ ...base, list: 'New Leads', pf: pf({ stage: 'Lead' + PICK_SEP + 'Offer Made' }) })!.filters.stages, ['Lead']);
assert.deepEqual(serverFilters({ ...base, list: 'Appointments', pf: pf({ stage: 'Appointment Set' + PICK_SEP + 'Lead' }) })!.filters.stages, ['Appointment Set']);
assert.equal(serverFilters({ ...base, pf: pf({ date: 'Contacted today' }) })!.filters.touch_within_min, 600);
assert.equal(serverFilters({ ...base, pf: pf({ date: 'Contacted today' + PICK_SEP + 'Created today' }) }), null);
assert.equal(serverFilters({ ...base, pf: pf({ phone: 'Has phone', email: 'No email' }) })!.filters.phone, 'has');
assert.equal(serverFilters({ ...base, pf: pf({ phone: 'Has phone', email: 'No email' }) })!.filters.email, 'none');
assert.equal(serverFilters({ ...base, pf: pf({ compr: 'Run' }) })!.filters.compr, 'run');
assert.equal(serverFilters({ ...base, pf: pf({ compr: 'Run, no offer' }) }), null);
assert.equal(serverFilters({ ...base, pf: pf({ heat: 'Hot' }) }), null);
assert.equal(serverFilters({ ...base, pf: pf({ uwTriage: 'Review' }) }), null);
assert.equal(serverFilters({ ...base, pf: pf({ offer: '100k+' }) }), null);
assert.equal(serverFilters({ ...base, pf: pf({ addedWhen: 'Last 7 days' }) })!.filters.created_from, new Date(2026, 9, 12).toISOString());
assert.equal(serverFilters({ ...base, pf: pf({ addedWhen: 'Custom', addedFrom: '2026-01-01', addedTo: '2026-01-31' }) })!.filters.created_to, new Date(2026, 1, 1).toISOString());
assert.deepEqual(serverFilters({ ...base, hiddenIds: ['s12', 's40'], pf: pf() })!.filters.not_ids, [12, 40]);

// Search and sorts.
assert.deepEqual(serverFilters({ ...base, q: 'John  Smith', pf: pf() })!.filters.terms, ['john', 'smith']);
assert.equal(serverFilters({ ...base, q: '(214) 555-12', pf: pf() })!.filters.digits, '21455512');
const byName = serverFilters({ ...base, pf: pf({ sort: 'Name' }) })!;
assert.deepEqual([byName.sort, byName.dir], ['name', 'asc']);
const oldest = serverFilters({ ...base, pf: pf({ sort: 'Oldest' }) })!;
assert.deepEqual([oldest.sort, oldest.dir], ['touch', 'asc']);
assert.equal(serverFilters({ ...base, pf: pf({ sort: 'ARV (high to low)' }) }), null);

console.log('people-page ok');
