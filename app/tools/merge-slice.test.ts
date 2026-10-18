// mergeSlice (lib/crm.ts) hands back the same object when a re-read of a
// seller finds nothing new, so opening a record does not rebuild the app
// (and, keyed on that object, did not loop). A real change still lands.
import { mergeSlice, type SellerSlice } from '../lib/crm';
import type { Deal, Person } from '../lib/clozr-types';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

const person = (id: string, extra: Partial<Person> = {}) => ({ id, name: 'P' + id, stage: 'New Lead', notes: 'short', ...extra }) as unknown as Person;
const deal = (id: string, extra: Partial<Deal> = {}) => ({ id, personId: 's1', stage: 'Prospect', ...extra }) as unknown as Deal;

const data = {
  people: [person('s1'), person('s2')],
  deals: [deal('d10', { photos: ['https://x/a.jpg'], photoUrl: 'https://x/a.jpg' } as Partial<Deal>), deal('d11', { personId: 's2' })],
  tasks: [],
};

{
  // Fresh objects, same values: what a second read of an unchanged seller returns.
  const slice: SellerSlice = { sellerId: 1, person: person('s1'), deals: [deal('d10')] };
  const next = mergeSlice(data, slice);
  eq('an unchanged re-read returns the same data object', next === data, true);
  eq('the twice-merged result is still the same object', mergeSlice(next, slice) === data, true);
}

{
  const slice: SellerSlice = { sellerId: 1, person: person('s1', { notes: 'the full note' }), deals: [deal('d10')] };
  const next = mergeSlice(data, slice);
  eq('a changed seller returns new data', next !== data, true);
  eq('the full note lands', next.people[0].notes, 'the full note');
  eq('unchanged deals keep their array', next.deals === data.deals, true);
  eq('other sellers keep the same objects', next.people[1] === data.people[1], true);
}

{
  const slice: SellerSlice = { sellerId: 1, person: person('s1'), deals: [deal('d10', { stage: 'Under Contract' })] };
  const next = mergeSlice(data, slice);
  eq('a changed deal returns new data', next !== data && next.deals !== data.deals, true);
  eq('the deal takes the fresh stage', next.deals[0].stage, 'Under Contract');
  eq('the unchanged person keeps its array', next.people === data.people, true);
}

{
  const next = mergeSlice(data, { sellerId: 1, person: person('s1'), deals: [deal('d10'), deal('d12')] });
  eq('a new deal is added', next.deals.map((d) => d.id), ['d10', 'd11', 'd12']);
}
