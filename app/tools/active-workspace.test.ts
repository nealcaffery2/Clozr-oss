import {
  commitWorkspaceSwitch,
  membershipsFromRows,
  notedWorkspaceId,
  onWorkspaceReset,
  orderMemberships,
  pickActiveWorkspace,
  readSavedWorkspaceId,
  resetWorkspaceScope,
  writeSavedWorkspaceId,
  type WorkspaceStore,
} from '../lib/active-workspace';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

function memStore(initial: Record<string, string> = {}): WorkspaceStore & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    dump: () => Object.fromEntries(m),
  };
}

const memberships = [
  { id: 40, name: 'Compr', role: 'owner' },
  { id: 11, name: 'Acme Homes', role: 'owner' },
  { id: 27, name: 'Other', role: 'admin' },
];

eq('saved valid id wins, even when it is not the oldest', pickActiveWorkspace(memberships, 40), memberships[0]);
eq('saved id that is not a membership falls back to the oldest', pickActiveWorkspace(memberships, 99)?.id, 11);
eq('a stale saved id falls back to the oldest', pickActiveWorkspace(memberships, 3)?.id, 11);
eq('nothing saved opens the lowest workspace id', pickActiveWorkspace(memberships, null)?.id, 11);
eq('a non-positive saved id is not a workspace', pickActiveWorkspace(memberships, 0)?.id, 11);
eq('empty memberships have no workspace', pickActiveWorkspace([], 11), null);
eq('input order does not decide the oldest', pickActiveWorkspace([{ id: 20 }, { id: 8 }, { id: 11 }], null)?.id, 8);
eq('ordering is by id ascending', orderMemberships(memberships).map((m) => m.id), [11, 27, 40]);
eq('membership rows skip a missing workspace and order by id', membershipsFromRows([
  { role: 'owner', workspaces: { id: 40, name: 'Compr', owner_id: 'u' } },
  { role: 'member', workspaces: null },
  { role: 'owner', workspaces: [{ id: 11, name: 'Acme Homes', owner_id: 'u' }] },
]).map((m) => m.id), [11, 40]);

const store = memStore();
eq('unreadable store is nothing saved', readSavedWorkspaceId(null), null);
eq('blank store is nothing saved', readSavedWorkspaceId(store), null);
writeSavedWorkspaceId(store, 11);
eq('a saved id reads back', readSavedWorkspaceId(store), 11);
writeSavedWorkspaceId(store, 40);
eq('the saved choice is the active one', pickActiveWorkspace(memberships, readSavedWorkspaceId(store))?.id, 40);
store.setItem('clozr.activeWorkspace', 'nope');
eq('garbage in storage is nothing saved', readSavedWorkspaceId(store), null);
store.setItem('clozr.activeWorkspace', '11');
eq('a numeric string is the id', readSavedWorkspaceId(store), 11);

let resets = 0;
let survived = 0;
const off = onWorkspaceReset(() => { resets += 1; });
const offBoom = onWorkspaceReset(() => { throw new Error('cache exploded'); });
const offSurvivor = onWorkspaceReset(() => { survived += 1; });

const switched = commitWorkspaceSwitch(memberships, 40, store);
eq('switch returns that membership', switched?.name, 'Compr');
eq('switch persists the id', readSavedWorkspaceId(store), 40);
eq('switch resets every cache listener', resets, 1);
eq('one cache throwing does not skip the others', survived, 1);

eq('an id they are not in does not switch', commitWorkspaceSwitch(memberships, 99, store), null);
eq('a refused switch leaves the saved id', readSavedWorkspaceId(store), 40);
eq('a refused switch does not reset again', resets, 1);

off();
offBoom();
offSurvivor();
resetWorkspaceScope();
eq('unsubscribed listeners do not run', resets, 1);
eq('unsubscribed survivor does not run', survived, 1);

let notedAtReset: number | null = null;
let notedRuns = 0;
const offNoted = onWorkspaceReset(() => { notedRuns += 1; notedAtReset = notedWorkspaceId(); });
commitWorkspaceSwitch(memberships, 11, store);
eq('a reset reads the workspace just chosen', notedAtReset, 11);
eq('switching back persists the oldest id', readSavedWorkspaceId(store), 11);
eq('that switch reset caches once', notedRuns, 1);
offNoted();
resetWorkspaceScope();
eq('removing the reset listener stops it', notedRuns, 1);
