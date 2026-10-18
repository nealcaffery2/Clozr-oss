// deal-machine `optins`: one upsert on (workspace_id, domain) leaves the same
// rows as the old read-then-insert-or-update per domain.
// Run: npx tsx tools/deal-machine-optins.test.ts
import assert from 'node:assert/strict';
import { type Optin, type OptinHave, type OptinRow, mergeOptins } from '../supabase/functions/deal-machine/optins';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const CTX = { workspace_id: 11, run_id: 7, device_id: 'dev-1' };
const item = (domain: string, over: Partial<Optin> = {}): Optin =>
  ({ domain, url: `https://${domain}/sell`, status: 'opted_in', method: 'form', detail: 'filled 4', at: '2026-10-17T12:00:00.000Z', ...over });
const row = (domain: string, over: Partial<OptinRow> = {}): OptinRow => ({
  ...CTX, domain, url: 'https://old/', status: 'failed', method: 'carrot', detail: 'old', attempts: 3, first_at: '2026-10-01T00:00:00.000Z', last_at: '2026-10-02T00:00:00.000Z', ...over,
});
const haveOf = (rows: OptinRow[]) => new Map<string, OptinHave>(rows.map((r) => [r.domain, r]));

/** The old handler, one domain at a time, against an in-memory dm_optins. */
function oldWay(table: Map<string, OptinRow>, items: Optin[]) {
  for (const it of items) {
    const have = table.get(it.domain);
    if (have) {
      table.set(it.domain, {
        ...have, status: have.status === 'opted_in' ? 'opted_in' : it.status,
        ...(it.url === null ? {} : { url: it.url }), method: it.method, detail: it.detail,
        attempts: have.attempts + 1, run_id: CTX.run_id, device_id: CTX.device_id, last_at: it.at,
      });
    } else {
      table.set(it.domain, { ...CTX, domain: it.domain, url: it.url, status: it.status, method: it.method, detail: it.detail, attempts: 1, first_at: it.at, last_at: it.at });
    }
  }
}
/** The new handler: one preload, the merge, one upsert (every listed column replaced). */
function newWay(table: Map<string, OptinRow>, items: Optin[]) {
  for (const r of mergeOptins(items, haveOf([...table.values()]), CTX)) table.set(r.domain, { ...r });
}

test('a new domain is inserted with one attempt', () => {
  assert.deepEqual(mergeOptins([item('a.com')], new Map(), CTX), [{
    ...CTX, domain: 'a.com', url: 'https://a.com/sell', status: 'opted_in', method: 'form', detail: 'filled 4',
    attempts: 1, first_at: '2026-10-17T12:00:00.000Z', last_at: '2026-10-17T12:00:00.000Z',
  }]);
});
test('a known domain gets one more attempt and keeps its first_at', () => {
  const [r] = mergeOptins([item('a.com', { status: 'no_form' })], haveOf([row('a.com')]), CTX);
  assert.equal(r.attempts, 4);
  assert.equal(r.first_at, '2026-10-01T00:00:00.000Z');
  assert.equal(r.status, 'no_form');
});
test('an opt-in that once succeeded stays succeeded', () => {
  const [r] = mergeOptins([item('a.com', { status: 'no_form' })], haveOf([row('a.com', { status: 'opted_in' })]), CTX);
  assert.equal(r.status, 'opted_in');
});
test('an item without a url keeps the stored one', () => {
  assert.equal(mergeOptins([item('a.com', { url: null })], haveOf([row('a.com')]), CTX)[0].url, 'https://old/');
});
test('the same domain twice in a batch is one row, counted twice', () => {
  const rows = mergeOptins([item('a.com', { at: 't1' }), item('a.com', { status: 'failed', url: null, at: 't2' })], new Map(), CTX);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].attempts, rows[0].first_at, rows[0].last_at, rows[0].status, rows[0].url], [2, 't1', 't2', 'opted_in', 'https://a.com/sell']);
});
test('every row carries the same columns (a bulk upsert nulls a missing one)', () => {
  const rows = mergeOptins([item('a.com'), item('b.com', { url: null })], haveOf([row('b.com')]), CTX);
  const keys = rows.map((r) => Object.keys(r).sort().join(','));
  assert.equal(new Set(keys).size, 1);
});
test('same end rows as the per-domain loop', () => {
  const seed = [row('known.com'), row('won.com', { status: 'opted_in' }), row('nourl.com', { url: null })];
  const batch = [
    item('new.com'), item('known.com', { status: 'no_form', url: null }), item('won.com', { status: 'failed' }),
    item('new.com', { status: 'skipped', url: 'https://new.com/2', at: 't9' }), item('nourl.com', { url: null, method: null, detail: null }),
    item('twice.com', { status: 'failed' }), item('twice.com', { status: 'opted_in', at: 't5' }), item('twice.com', { status: 'no_form', url: null, at: 't6' }),
  ];
  const a = new Map(seed.map((r) => [r.domain, { ...r }]));
  const b = new Map(seed.map((r) => [r.domain, { ...r }]));
  oldWay(a, batch);
  newWay(b, batch);
  assert.deepEqual(b, a);
  // A second batch on top: still the same.
  oldWay(a, batch);
  newWay(b, batch);
  assert.deepEqual(b, a);
});

console.log(`deal-machine-optins: ${passed} passed`);
