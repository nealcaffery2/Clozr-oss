// The local patch and record refresh that replace a full workspace reload
// after a save (lib/crm.ts mergeSlice, withGallery; lib/use-crm.ts patchRows;
// lib/talkr-sync.ts threadMoved).
import { mergeSlice, withGallery, type SellerSlice } from '../lib/crm';
import { patchRows } from '../lib/use-crm';
import { threadMoved } from '../lib/talkr-sync';
import type { Deal, Person } from '../lib/clozr-types';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

const person = (id: string, extra: Partial<Person> = {}) => ({ id, name: 'P' + id, stage: 'New Lead', ...extra }) as unknown as Person;
const deal = (id: string, extra: Partial<Deal> = {}) => ({ id, personId: 's1', stage: 'Prospect', ...extra }) as unknown as Deal;

const data = {
  people: [person('s1'), person('s2', { stage: 'Contacted' })],
  deals: [deal('d10', { photos: ['https://x/a.jpg'], photoUrl: 'https://x/a.jpg', listingUrl: 'L' } as Partial<Deal>), deal('d11', { personId: 's2' })],
  tasks: [],
};

{
  const slice: SellerSlice = { sellerId: 2, person: person('s2', { stage: 'Qualified' }), deals: [deal('d11', { personId: 's2', stage: 'Under Contract' })] };
  const next = mergeSlice(data, slice);
  eq('the saved seller is replaced in place', next.people.map((p) => [p.id, p.stage]), [['s1', 'New Lead'], ['s2', 'Qualified']]);
  eq('their deal takes the fresh fields', next.deals.find((d) => d.id === 'd11')?.stage, 'Under Contract');
  eq('other sellers keep the same objects', next.people[0] === data.people[0] && next.deals[0] === data.deals[0], true);
  eq('lists the slice does not read are untouched', next.tasks === data.tasks, true);
}
{
  const slice: SellerSlice = { sellerId: 1, person: person('s1'), deals: [deal('d10', { stage: 'Dispo' })] };
  const d = mergeSlice(data, slice).deals.find((x) => x.id === 'd10') as Deal & { listingUrl?: string };
  eq('enriched photos survive a refresh', [d.stage, d.photos, d.photoUrl, d.listingUrl], ['Dispo', ['https://x/a.jpg'], 'https://x/a.jpg', 'L']);
}
{
  const slice: SellerSlice = { sellerId: 3, person: person('s3'), deals: [deal('d12', { personId: 's3' })] };
  const next = mergeSlice(data, slice);
  eq('a new lead goes to the top', next.people.map((p) => p.id), ['s3', 's1', 's2']);
  eq('and its deal is added', next.deals.map((x) => x.id), ['d10', 'd11', 'd12']);
}
eq('an archived (or gone) seller leaves People', mergeSlice(data, { sellerId: 2, person: null, deals: [] }).people.map((p) => p.id), ['s1']);

{
  const rows = [{ id: 'k1', done: false, title: 'a' }, { id: 'k2', done: false, title: 'b' }];
  const next = patchRows(rows, { id: 'k2', done: true });
  eq('patchRows changes one row', next, [{ id: 'k1', done: false, title: 'a' }, { id: 'k2', done: true, title: 'b' }]);
  eq('patchRows keeps the other row object', next?.[0] === rows[0], true);
  eq('patchRows on a missing id returns the same list', patchRows(rows, { id: 'k9', done: true }) === rows, true);
}

{
  const d = deal('d10', { heroUrl: 'https://x/hero.jpg', photos: ['https://x/intake.jpg'] } as Partial<Deal>);
  const g = withGallery(d, [
    { deal_id: 10, url: 'https://x/2.jpg', source: 'drive', is_cover: false, position: 2 },
    { deal_id: 10, url: 'https://x/1.jpg', source: 'compr', is_cover: false, position: 1 },
    { deal_id: 99, url: 'https://x/other.jpg' },
  ]);
  eq('gallery: this deal only, intake photos kept', g.photos?.includes('https://x/other.jpg'), false);
  eq('gallery: has the loaded photos and the intake one', ['https://x/1.jpg', 'https://x/2.jpg', 'https://x/intake.jpg'].every((u) => g.photos?.includes(u)), true);
  eq('gallery: no rows, same deal', withGallery(d, []) === d, true);
}

eq('a thread never seen is read', threadMoved({}, { id: 'c1', last_message_at: '2026-10-09T10:00:00Z' }), true);
eq('an unchanged thread is skipped', threadMoved({ c1: '2026-10-09T10:00:00Z' }, { id: 'c1', last_message_at: '2026-10-09T10:00:00Z' }), false);
eq('a thread with a newer message is read', threadMoved({ c1: '2026-10-09T10:00:00Z' }, { id: 'c1', last_message_at: '2026-10-09T10:05:00Z' }), true);
eq('a thread with no time is always read', threadMoved({ c1: '' }, { id: 'c1', last_message_at: null }), true);
