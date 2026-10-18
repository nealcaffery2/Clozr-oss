// podio-import's page reads (supabase/functions/podio-import/page.ts): a page
// of Podio deals reads its sellers once, keeps every row it writes, and each
// item still matches the seller the old one-item-at-a-time reads matched.
// Also the Communications guard that stops the sync rewriting unchanged rows.
// Run: npx tsx tools/podio-import-page.test.ts
import assert from 'node:assert/strict';
import {
  KINDS, ROW_CAP, absorb, addrSig, candidates, findRow, keep, newPeople, partyKeys, unasked, unchangedComms, type Keys, type People,
} from '../supabase/functions/podio-import/page';
import { phoneKey, type PodioPerson } from '../supabase/functions/_shared/podio-map';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

// ---- a sellers table and the four lookups matchParties makes ----------------------

type Seller = { id: number; name: string; email: string | null; phone: string | null; phone_key: string | null; source: string | null; source_id: string | null };
type Party = PodioPerson & { role: 'seller' };
const party = (source_id: string, name: string, phone: string | null = null, email: string | null = null): Party =>
  ({ ref: 'item', source_id, name, phone, email, company: null, role: 'seller' });

/** What `.in(kind, keys)` returns: matching rows in table (heap) order, as copies. */
const lookup = (db: Seller[], kind: (typeof KINDS)[number], keys: string[]) =>
  db.filter((r) => (kind === 'source_id' ? r.source === 'podio' && keys.includes(r.source_id!) : keys.includes((r as never)[kind]))).map((r) => ({ ...r }));

/** The old matchParties rows(): four queries for this item's keys, merged first answer first. */
function oldRead(db: Seller[], keys: Keys): Seller[] {
  const got = new Map<number, Seller>();
  for (const k of KINDS) if (keys[k].length) for (const r of lookup(db, k, keys[k])) got.set(r.id, r);
  return [...got.values()];
}

/** The page's read: only the keys it has not asked, absorbed into the pool. */
function pageRead(db: Seller[], pool: People, keys: Keys) {
  const want = unasked(pool, keys);
  for (const k of KINDS) if (want[k].length) absorb(pool, k, want[k], lookup(db, k, want[k]));
}

/** writeDeal's seller step: fill what the match has empty, else insert. Returns the row as the database would. */
function write(db: Seller[], match: Seller | undefined, p: Party): Seller {
  if (match) {
    const cur = db.find((r) => r.id === match.id)!;
    if (cur.email == null && p.email) cur.email = p.email;
    if (cur.phone == null && p.phone) { cur.phone = p.phone; cur.phone_key = phoneKey(p.phone); }
    if (!cur.source_id) { cur.source = 'podio'; cur.source_id = p.source_id; }
    return { ...cur };
  }
  const row: Seller = { id: Math.max(0, ...db.map((r) => r.id)) + 1, name: p.name, email: p.email, phone: p.phone, phone_key: phoneKey(p.phone), source: 'podio', source_id: p.source_id };
  db.push(row);
  return { ...row };
}

const find = (list: Seller[], p: Party) => findRow(list, p, ['name'], (x) => x.phone_key);

/** Run items the old way: every item reads its own keys right before it writes. */
function runOld(start: Seller[], items: Party[][]) {
  const db = start.map((r) => ({ ...r }));
  const picks = items.map((parties) => {
    const list = oldRead(db, partyKeys(parties));
    return parties.map((p) => { const m = find(list, p); write(db, m, p); return m?.id ?? 'new'; });
  });
  return { db, picks };
}

/** Run items as a page: one read for the page's keys up front (or none: the sync reads per item), writes kept. */
function runPage(start: Seller[], items: Party[][], prime: boolean) {
  const db = start.map((r) => ({ ...r }));
  const pool = newPeople();
  if (prime) pageRead(db, pool, partyKeys(items.flat()));
  const picks = items.map((parties) => {
    const keys = partyKeys(parties);
    pageRead(db, pool, keys);
    const list = candidates(pool, keys) as Seller[];
    return parties.map((p) => { const m = find(list, p); keep(pool, write(db, m, p)); return m?.id ?? 'new'; });
  });
  return { db, picks };
}

const seed: Seller[] = [
  // Matched by phone by one item, carries a mixed-case email another item has lowercased.
  { id: 1, name: 'Lee Fox', email: 'Lee@Fox.com', phone: '(555) 000-0009', phone_key: '+15550000009', source: null, source_id: null },
  // A name exactly one seller carries.
  { id: 2, name: 'Kim Lee', email: null, phone: null, phone_key: null, source: null, source_id: null },
  // A Podio contact from an earlier run.
  { id: 3, name: 'Ray Cole', email: null, phone: null, phone_key: null, source: 'podio', source_id: 'item:777' },
  // Has a phone, no email: an item fills the email, a later one matches on it.
  { id: 4, name: 'Bo Diaz', email: null, phone: '555-000-0044', phone_key: '+15550000044', source: null, source_id: null },
];
const items: Party[][] = [
  [party('item:1', 'Dana Kline', '555-010-0001')], // new
  [party('item:2', 'Dana K', '(555) 010-0001')], // the seller the first item made, by phone
  [party('item:3', 'L. Fox', null, 'lee@fox.com')], // no exact email row: new (a merged page read would have matched seller 1)
  [party('item:4', 'Lee Fox', '5550000009')], // seller 1 by phone
  [party('item:5', 'Kim Lee', '555-020-0005')], // seller 2 by name, phone filled in
  [party('item:6', 'K. Lee', '555 020 0005')], // seller 2 by the phone the item before filled in
  [party('item:777', 'Raymond Cole')], // seller 3 by Podio source id
  [party('item:8', 'Bo Diaz', '555-000-0044', 'bo@d.com')], // seller 4 by phone, email filled in
  [party('item:9', 'Robert Diaz', null, 'bo@d.com')], // seller 4 by that email
  [party('item:10', 'Ana Ruiz', null, 'ana@r.com')], // new
  [party('item:10', 'Ana Ruiz', null, 'ana@r.com')], // the same item twice on a page: the seller it made
  [party('item:11', 'Jo Park', '555-030-0011'), party('item:12', 'Jo Park', null)], // one item's sellers are matched before either is written: both new
];

test('partyKeys: source ids, phone keys, lowercased emails, names and companies, each once', () => {
  const k = partyKeys([
    { source_id: 'item:1', name: 'A', phone: '555-010-0001', email: 'X@Y.com', company: 'Acme' },
    { source_id: 'item:1', name: 'A', phone: '(555) 010-0001', email: null, company: null },
  ]);
  assert.deepEqual(k, { source_id: ['item:1'], phone_key: ['+15550100001'], email: ['x@y.com'], name: ['A', 'Acme'] });
});

test('a page matches every item the way per-item reads did, and writes the same rows', () => {
  const old = runOld(seed, items);
  assert.deepEqual(old.picks, [['new'], [5], ['new'], [1], [2], [2], [3], [4], [4], ['new'], [7], ['new', 'new']]);
  for (const prime of [true, false]) {
    const page = runPage(seed, items, prime);
    assert.deepEqual(page.picks, old.picks, prime ? 'one read up front' : 'read per item');
    assert.deepEqual(page.db, old.db);
  }
});

test('the old merge order: source id answer first, then phone, email, name', () => {
  const pool = newPeople();
  absorb(pool, 'name', ['Lee Fox'], [{ id: 1, name: 'Lee Fox', source: null }]);
  absorb(pool, 'source_id', ['item:9'], [{ id: 9, name: 'X', source: 'podio', source_id: 'item:9' }]);
  const keys = { source_id: ['item:9'], phone_key: [], email: [], name: ['Lee Fox'] };
  assert.deepEqual(candidates(pool, keys).map((r) => r.id), [9, 1]);
});

test('a key the page read is not read again; a new key is', () => {
  const pool = newPeople();
  absorb(pool, 'phone_key', ['+15550100001'], []);
  const want = unasked(pool, { source_id: ['item:1'], phone_key: ['+15550100001', '+15550100002'], email: [], name: [] });
  assert.deepEqual(want, { source_id: ['item:1'], phone_key: ['+15550100002'], email: [], name: [] });
});

test('an answer cut at PostgREST\'s 1,000 rows leaves its keys for each item to read again', () => {
  const pool = newPeople();
  absorb(pool, 'name', ['Common Name'], Array.from({ length: ROW_CAP }, (_, i) => ({ id: i + 1, name: 'Common Name' })));
  assert.equal(pool.asked.name.has('Common Name'), false);
  absorb(pool, 'name', ['Rare Name'], [{ id: 5000, name: 'Rare Name' }]);
  assert.equal(pool.asked.name.has('Rare Name'), true);
});

test('a row the page deleted under it drops out; a row it changed matches on its new values', () => {
  const pool = newPeople();
  absorb(pool, 'email', ['a@b.com'], [{ id: 1, email: 'a@b.com', name: 'A' }]);
  keep(pool, { id: 1, email: 'c@d.com', name: 'A' });
  assert.deepEqual(candidates(pool, { source_id: [], phone_key: [], email: ['a@b.com'], name: [] }), []);
  assert.deepEqual(candidates(pool, { source_id: [], phone_key: [], email: ['c@d.com'], name: [] }).map((r) => r.id), [1]);
  pool.rows.delete(1);
  assert.deepEqual(candidates(pool, { source_id: [], phone_key: [], email: ['c@d.com'], name: [] }), []);
});

test('address_key() arguments: a missing city, state or zip is the empty string it is called with', () => {
  assert.equal(addrSig({ line1: '1 Main St', city: null, state: 'TX', zip: undefined }), addrSig({ line1: '1 Main St', city: '', state: 'TX', zip: '' }));
  assert.notEqual(addrSig({ line1: '1 Main St', zip: '78201' }), addrSig({ line1: '1 Main St', zip: '78202' }));
});

// ---- Communications: rows the upsert would leave as stored ---------------------------

const NOW = Date.parse('2026-10-17T19:00:00Z');
const OWNER = 'user-line-owner';
const lines = new Map([['+12105550100', OWNER]]);
const comm = (over: Record<string, unknown> = {}) => ({
  workspace_id: 1, source: 'podio', source_id: '1000000001', channel: 'sms', direction: 'outbound',
  occurred_at: '2026-10-17T13:02:18.000Z', from_phone: '+12105550100', to_phone: '+12105559999',
  body: 'Hi', summary: null, transcript: null, duration_s: null, recording_url: null, status: null, recording_id: null,
  seller_id: 42, buyer_id: null, rep_id: null, ...over,
});
// As PostgREST returns it: timestamptz with an offset, and the rep the line trigger filled in.
const stored = (over: Record<string, unknown> = {}) => comm({ occurred_at: '2026-10-17T13:02:18+00:00', rep_id: OWNER, ...over });

test('an outbound row stored as it is, the rep from its line: skipped', () => {
  assert.deepEqual([...unchangedComms([comm()], [stored()], lines, NOW)], ['1000000001']);
});
test('a field that changed in Podio: written', () => {
  assert.equal(unchangedComms([comm({ body: 'Hi there' })], [stored()], lines, NOW).size, 0);
  assert.equal(unchangedComms([comm({ seller_id: 43 })], [stored()], lines, NOW).size, 0);
  assert.equal(unchangedComms([comm({ duration_s: 12 })], [stored()], lines, NOW).size, 0);
});
test('no stored row: written', () => {
  assert.equal(unchangedComms([comm()], [], lines, NOW).size, 0);
});
test('the rep: Podio\'s owner when it names one, else the line\'s, else none', () => {
  assert.equal(unchangedComms([comm({ rep_id: 'user-b' })], [stored({ rep_id: 'user-b' })], lines, NOW).size, 1);
  assert.equal(unchangedComms([comm({ rep_id: 'user-b' })], [stored()], lines, NOW).size, 0);
  // The line changed hands since the row was written: the upsert would move it, so it is written.
  assert.equal(unchangedComms([comm()], [stored()], new Map([['+12105550100', 'user-c']]), NOW).size, 0);
  // A line with no owner leaves the rep empty.
  assert.equal(unchangedComms([comm({ from_phone: '+12105550111' })], [stored({ from_phone: '+12105550111', rep_id: null })], lines, NOW).size, 1);
  assert.equal(unchangedComms([comm({ from_phone: '+12105550111' })], [stored({ from_phone: '+12105550111' })], lines, NOW).size, 0);
});
test('an inbound row less than a day old always goes through (the ringless-drop trigger may still file it)', () => {
  const inbound = { direction: 'inbound', from_phone: '+12105559999', to_phone: '+12105550100' };
  assert.equal(unchangedComms([comm(inbound)], [stored(inbound)], lines, NOW).size, 0);
  const old = { ...inbound, occurred_at: '2026-10-15T13:02:18.000Z' };
  assert.equal(unchangedComms([comm(old)], [stored({ ...old, occurred_at: '2026-10-15T13:02:18+00:00' })], lines, NOW).size, 1);
  const unparsable = { ...inbound, occurred_at: 'not a date' };
  assert.equal(unchangedComms([comm(unparsable)], [stored(unparsable)], lines, NOW).size, 0);
});
test('a column the stored copy lacks counts as changed', () => {
  const s = stored(); delete (s as Record<string, unknown>).status;
  assert.equal(unchangedComms([comm({ status: 'delivered' })], [s], lines, NOW).size, 0);
});

console.log(`${passed} passed`);
