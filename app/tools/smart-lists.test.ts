// Saved smart lists and the remembered People state. Run: npx tsx tools/smart-lists.test.ts
import { isSmartListConfig, smartListConfig, smartListFromRow, smartListShared, smartListVisible } from '../lib/smart-lists';
import { peopleMemoryKey, readPeopleMemory } from '../lib/people-memory';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// Who can open it, as the one `shared` flag the table has.
eq('nobody picked means everyone, so shared', smartListShared([], 'u1'), true);
eq('only me is private', smartListShared(['u1'], 'u1'), false);
eq('me and a teammate is shared', smartListShared(['u1', 'u2'], 'u1'), true);
eq('a teammate alone is shared', smartListShared(['u2'], 'u1'), true);

// The rail: the owner always, then whoever it was opened to.
eq('my own list shows', smartListVisible({ access: ['u2'], mine: true }, 'u1'), true);
eq('a teammate list for everyone shows', smartListVisible({ access: [], mine: false }, 'u1'), true);
eq('a teammate list picked for me shows', smartListVisible({ access: ['u1', 'u3'], mine: false }, 'u1'), true);
eq('a teammate list not for me is hidden', smartListVisible({ access: ['u3'], mine: false }, 'u1'), false);

// Rows: smart lists are told apart from Views menu rows on the same screen.
const cfg = smartListConfig({ filters: { stage: 'Lead', owner: 'Any' }, cols: ['name', 'stage'], access: ['u1'] });
eq('config is marked as a smart list', isSmartListConfig(cfg), true);
eq('a view config is not', isSmartListConfig({ list: 'My Leads', filters: {}, cols: [] }), false);
eq('a row reads back', smartListFromRow({ id: 7, name: 'Hot TX', config: cfg, user_id: 'u1' }, 'u1'),
  { id: '7', name: 'Hot TX', filters: { stage: 'Lead', owner: 'Any' }, cols: ['name', 'stage'], access: ['u1'], mine: true });
eq('a teammate row is not mine', smartListFromRow({ id: 8, name: 'Theirs', config: cfg, user_id: 'u2' }, 'u1')?.mine, false);
eq('a view row is skipped', smartListFromRow({ id: 9, name: 'View', config: { list: 'My Leads' }, user_id: 'u1' }, 'u1'), null);
// Buyers lists carry the system list their filters narrow.
const buyerCfg = smartListConfig({ filters: { buyerType: 'Wholesaler' }, cols: ['buyer'], access: [], base: 'buyer-prospect' });
eq('a Buyers list keeps its base list', buyerCfg.base, 'buyer-prospect');
eq('a People list has no base key', 'base' in cfg, false);
eq('the base reads back', smartListFromRow({ id: 3, name: 'Prospect wholesalers', config: buyerCfg, user_id: 'u1' }, 'u1')?.base, 'buyer-prospect');
eq('junk in the arrays is dropped', smartListFromRow({ id: 1, name: 'X', config: { kind: 'smart-list', filters: {}, cols: ['a', 3], access: [null, 'u1'] } }, 'u1')?.cols, ['a']);

// Remembered People state.
const ok = (l: string) => ['My Leads', 'Hot Leads', 'Hot TX'].includes(l);
const known = ['stage', 'owner', 'sort'];
eq('per user key', peopleMemoryKey('u1'), 'clozr.people.last.u1');
eq('demo key', peopleMemoryKey(null), 'clozr.people.last.demo');
eq('nothing saved', readPeopleMemory(null, ok, known), null);
eq('bad json', readPeopleMemory('{', ok, known), null);
eq('a list that is gone', readPeopleMemory(JSON.stringify({ list: 'Old list', pf: {}, q: '' }), ok, known), null);
eq('restores list, filters, sort and search',
  readPeopleMemory(JSON.stringify({ list: 'Hot Leads', pf: { stage: 'Lead', sort: 'Name', gone: 'x', owner: 3 }, q: 'smith' }), ok, known),
  { list: 'Hot Leads', pf: { stage: 'Lead', sort: 'Name' }, q: 'smith' });
eq('missing search is empty', readPeopleMemory(JSON.stringify({ list: 'My Leads' }), ok, known), { list: 'My Leads', pf: {}, q: '' });

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('smart-lists: all passed');
