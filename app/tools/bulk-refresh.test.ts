// The merges behind the bulk re-reads (lib/use-crm.ts refreshSellers,
// refreshBuyers): an unchanged re-read hands back the same object, a changed
// row is replaced, a realtor from the corpus page never joins the buyer list,
// and an archived seller who still owns an open deal moves to archivedPeople
// the way the full load puts them there.
import { lastTouchOf, mergeBuyerSlice, mergeBuyerSlices, mergeSlice, type BuyerSlice, type SellerSlice } from '../lib/crm';
import type { Buyer, Deal, Person } from '../lib/clozr-types';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

const buyer = (id: string, extra: Partial<Buyer> = {}) => ({
  id, name: 'B' + id, status: 'Active', assigned: null,
  activity: { calls: 3, texts: 4, emails: 5, viewed: 0, offers: 0, purchases: 0, declines: 0, walkthroughs: 0, clicks: 0 },
  ...extra,
}) as unknown as Buyer & { assigned: string | null };
const fresh = (id: string, extra: Partial<Buyer> = {}) =>
  buyer(id, { activity: { calls: 0, texts: 0, emails: 0, viewed: 0, offers: 0, purchases: 0, declines: 0, walkthroughs: 0, clicks: 0 } as Buyer['activity'], ...extra });
const slice = (n: number, b: (Buyer & { assigned: string | null }) | null): BuyerSlice => ({ buyerId: n, buyer: b });

const buyers = { buyers: [buyer('b1'), buyer('b2')] };

{
  // The slice reads no messages, so its counts are zero; the list's stay.
  const next = mergeBuyerSlice(buyers, slice(1, fresh('b1')));
  eq('an unchanged buyer re-read returns the same object', next === buyers, true);
}

{
  const next = mergeBuyerSlice(buyers, slice(1, fresh('b1', { assigned: 'u9' } as Partial<Buyer>)));
  eq('a changed buyer returns new data', next !== buyers, true);
  eq('the new owner lands', (next.buyers[0] as Buyer & { assigned: string | null }).assigned, 'u9');
  eq('the message counts the list had are kept', next.buyers[0].activity.texts, 4);
  eq('the other buyer is the same object', next.buyers[1] === buyers.buyers[1], true);
}

{
  const next = mergeBuyerSlices(buyers, [slice(1, fresh('b1')), slice(2, fresh('b2')), slice(7, fresh('b7'))]);
  eq('a bulk re-read with nothing new returns the same object', next === buyers, true);
  eq('a realtor not on the list is not added', next.buyers.map((b) => b.id), ['b1', 'b2']);
}

{
  const next = mergeBuyerSlices(buyers, [slice(1, null), slice(2, fresh('b2', { status: 'VIP' }))]);
  eq('an archived buyer leaves and a changed one is replaced', next.buyers.map((b) => b.id + ':' + b.status), ['b2:VIP']);
}

const person = (id: string) => ({ id, name: 'P' + id, stage: 'New Lead' }) as unknown as Person;
const deal = (id: string, extra: Partial<Deal> = {}) => ({ id, personId: 's1', stage: 'Prospect', archived: false, ...extra }) as unknown as Deal;
const crm: { people: Person[]; deals: Deal[]; archivedPeople?: Person[] } = { people: [person('s1'), person('s2')], deals: [deal('d10'), deal('d11', { personId: 's2' })] };

{
  const s: SellerSlice = { sellerId: 1, person: null, deals: [deal('d10')] };
  const next = mergeSlice(crm, s);
  eq('an archived seller leaves People', next.people.map((p) => p.id), ['s2']);
  eq('with a deal still open they move to archivedPeople', (next.archivedPeople ?? []).map((p) => p.id), ['s1']);
  eq('a second read of the same archive changes nothing', mergeSlice(next, s) === next, true);
}

{
  const next = mergeSlice(crm, { sellerId: 1, person: null, deals: [deal('d10', { archived: true })] });
  eq('archived with every deal archived, they are nowhere', [next.people.map((p) => p.id), next.archivedPeople ?? []], [['s2'], []]);
}

{
  const archived = { ...crm, people: [person('s2')], archivedPeople: [person('s1')] };
  const next = mergeSlice(archived, { sellerId: 1, person: null, deals: [deal('d10', { archived: true })] });
  eq('their last open deal archived, they leave archivedPeople', next.archivedPeople, []);
}

{
  // Bugbot on #434: the row's touch alone could be older than the message the
  // full load showed from its newest 500. The re-read takes the later one.
  const row = { last_touch_at: '2026-10-10T10:00:00Z', last_touch_channel: 'email' };
  const newer = { channel: 'sms', occurred_at: '2026-10-12T09:00:00Z' };
  const older = { channel: 'call', occurred_at: '2026-10-01T09:00:00Z' };
  eq('a newer message beats an older row touch', lastTouchOf(row, newer), newer);
  eq('a newer row touch beats an older message', lastTouchOf(row, older), { channel: 'email', occurred_at: '2026-10-10T10:00:00Z' });
  eq('no row touch: the newest message', lastTouchOf({ last_touch_at: null }, newer), newer);
  eq('a row touch with no channel reads as a note', lastTouchOf({ last_touch_at: '2026-10-10T10:00:00Z' }, null), { channel: 'note', occurred_at: '2026-10-10T10:00:00Z' });
  eq('neither: no contact yet', lastTouchOf({}, undefined), null);
}
