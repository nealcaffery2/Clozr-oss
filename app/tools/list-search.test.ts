// People and Buyers search. Run: npx tsx tools/list-search.test.ts
import assert from 'node:assert/strict';
import { normSearch, parseSearch, searchKey, searchRank, searchRows } from '../lib/list-search';

const q = (s: string) => {
  const p = parseSearch(s);
  assert.ok(p, `query "${s}" parses`);
  return p;
};

// Normalizing
assert.equal(normSearch("  O'Brien,  JOSÉ  "), 'obrien jose');
assert.equal(normSearch('123 Main St. #4'), '123 main st 4');
assert.equal(normSearch(null), '');
assert.equal(parseSearch('   '), null);
assert.equal(parseSearch('—'), null);

const john = searchKey(['John Smith'], ['john@acme.com', '123 Main St', 'Dallas', 'TX', '75201', 'Hot lead'], ['+1 (214) 555-1234']);
const acme = searchKey(['Jane Doe', 'Acme Home Buyers LLC'], ['jane@acme.com', 'Fort Worth, TX'], ['817.555.0000']);
const nobody = searchKey(['—'], ['—'], ['—']);

// Case and multi-word AND, any order, across fields
assert.ok(searchRank(john, q('JOHN')) >= 0);
assert.ok(searchRank(john, q('smith dallas')) >= 0);
assert.ok(searchRank(john, q('dallas   smith')) >= 0);
assert.equal(searchRank(john, q('smith houston')), -1);
assert.ok(searchRank(john, q('main st 75201')) >= 0);
assert.ok(searchRank(john, q('hot lead')) >= 0);
assert.ok(searchRank(john, q('john@acme.com')) >= 0);
assert.ok(searchRank(acme, q('acme llc')) >= 0);
assert.ok(searchRank(acme, q('fort worth')) >= 0);

// Phones by digits, however typed
for (const s of ['(214) 555', '214555', '214-555-1234', '2145551234', '+1 214 555 1234', '555-1234']) {
  assert.ok(searchRank(john, q(s)) >= 0, `phone "${s}" matches`);
}
assert.ok(searchRank(acme, q('(817) 555-0000')) >= 0);
assert.equal(searchRank(john, q('(972) 555')), -1);
assert.ok(searchRank(john, q('john 214555')) >= 0, 'a word and a phone together');

// Placeholders never match
assert.equal(searchRank(nobody, q('a')), -1);

// Ranking: exact name, name prefix, word in a name, word starts, elsewhere
assert.equal(searchRank(john, q('john smith')), 0);
assert.equal(searchRank(john, q('john')), 1);
assert.equal(searchRank(john, q('smi')), 2);
assert.equal(searchRank(john, q('smith jo')), 3);
assert.equal(searchRank(john, q('dallas')), 4);
assert.equal(searchRank(acme, q('acme home buyers llc')), 0);
assert.equal(searchRank(acme, q('acme')), 1);

// searchRows keeps every match, best first, the list order within a rank
const rows = [
  { id: 'a', k: searchKey(['Bob Johnson'], ['Austin']) },
  { id: 'b', k: searchKey(['Mary Lee'], ['john street']) },
  { id: 'c', k: searchKey(['John'], []) },
  { id: 'd', k: searchKey(['Johnny Cash'], []) },
  { id: 'e', k: searchKey(['Pat'], ['Houston']) },
];
assert.deepEqual(searchRows(rows, (r) => r.k, q('john')).map((r) => r.id), ['c', 'd', 'a', 'b']);
assert.equal(searchRows(rows, (r) => r.k, null), rows, 'no query returns the list as is');

// 11,000 rows search fast
const many = Array.from({ length: 11000 }, (_, i) => searchKey([`Buyer ${i}`, `Company ${i} LLC`], [`buyer${i}@x.com`, 'Dallas, TX'], [`(214) 555-${String(i).padStart(4, '0')}`]));
const t0 = performance.now();
for (let n = 0; n < 20; n++) searchRows(many, (k) => k, q(n % 2 ? 'company 12' : '214 555 01'));
const per = (performance.now() - t0) / 20;
assert.ok(per < 50, `11k rows in ${per.toFixed(1)}ms`);

console.log(`list-search: all passed (11k rows ≈ ${per.toFixed(1)}ms a query)`);
