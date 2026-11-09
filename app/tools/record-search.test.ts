// The one people-and-buyers search (lib/record-search.ts): what the command
// bar, the dial box and the People and Buyers boxes match on.
// Run with:  npx tsx tools/record-search.test.ts
import assert from 'node:assert/strict';
import { buyerFind, cachedPersonKey, personFind, recentRecords, recordKey, recordRank, recordRanker, searchList, searchRecords } from '../lib/record-search';

const prop = (addr: string, city: string, zip: string) => ({ addr, city, st: 'TX', zip, apn: '' });
const kara = { id: 's1', name: 'Kara Mitchell', phone: '(210) 555-0136', email: 'kara@mail.com', source: 'PPC', tags: ['hot'], market: 'San Antonio', property: prop('44 Benton Ct', 'San Antonio', '78201'), lastCommTs: 50 };
const jose = { id: 's2', name: 'José O’Brien', phone: '', email: '', source: 'Mailer', tags: [], property: prop('9 Elm St', 'Austin', '73301'), lastCommTs: 90 };
const karl = { id: 's3', name: 'Karl Bennett', phone: '512-555-9000', email: '', source: '', tags: [], property: prop('1 Main', 'Waco', '76701'), lastCommTs: null };
const people = [kara, jose, karl];
const alamo = { id: 'b1', name: 'Rita Lowe', company: 'Alamo Homes LLC', phone: '210 555 7777', email: 'rita@exampletitle.com', status: 'VIP', markets: ['Bexar'], tags: ['secret-blacklist', 'cash'] };
const key = (p: typeof kara | typeof jose | typeof karl) => ({ name: p.name, find: personFind(p) });

// Fields: phone as typed and as digits, email, address, city, ZIP, tags.
const f = personFind(kara);
for (const part of ['(210) 555-0136', '2105550136', 'kara@mail.com', '44 Benton Ct', 'San Antonio', '78201', 'hot', 'PPC']) assert.ok(f.includes(part), part);
assert.equal(cachedPersonKey(kara).find, f);
assert.equal(cachedPersonKey(kara), cachedPersonKey(kara), 'built once per record');
const bf = buyerFind(alamo, ['Bexar County, TX']);
assert.ok(bf.includes('Alamo Homes LLC') && bf.includes('2105557777') && bf.includes('Bexar County, TX'));
assert.ok(!bf.includes('secret-blacklist'), 'a hidden tag is not searchable');

// Partial, any order, phone digits however typed.
const ids = (q: string) => searchRecords(people, q, key).map((p) => p.id);
assert.deepEqual(ids('kar'), ['s1', 's3']);
assert.deepEqual(ids('ben'), ['s1', 's3'], 'a word start in the name or the address ranks the same; list order breaks the tie');
assert.deepEqual(ids('karl b'), ['s3']);
assert.deepEqual(ids('antonio kara'), ['s1']);
assert.deepEqual(ids('210-555'), ['s1']);
assert.deepEqual(ids('5550136'), ['s1']);
assert.deepEqual(ids('78201'), ['s1']);
assert.deepEqual(ids('kara@mail'), ['s1']);
// Accents and apostrophes: "jose obrien" finds José O’Brien.
assert.deepEqual(ids('jose obrien'), ['s2']);
assert.deepEqual(ids(''), []);

// Ranks: 0 the name exactly, 1 starts with, 2 a word start, 3 anywhere, -1 none.
assert.equal(recordRank('kara mitchell', kara.name, f), 0);
assert.equal(recordRank('kara', kara.name, f), 1);
assert.equal(recordRank('mitch', kara.name, f), 2);
assert.equal(recordRank('ntonio', kara.name, f), 3);
assert.equal(recordRank('zzz', kara.name, f), -1);
// The prepared key (hay lowercased once) ranks exactly as the plain one.
const rankOf = recordRanker('mitch');
assert.equal(rankOf(recordKey(kara.name, f)), 2);
assert.equal(rankOf({ name: kara.name, find: f }), 2);
assert.deepEqual(searchRecords(people, 'JOSE', (p) => recordKey(p.name, personFind(p))).map((p) => p.id), ['s2']);

// Fast enough for every lead on each keystroke: 14,000 prepared keys well under a frame budget.
const many = Array.from({ length: 14000 }, (_, i) => recordKey('Lead ' + i, personFind({ ...kara, name: 'Lead ' + i, phone: `(210) 555-${String(i).padStart(4, '0')}` })));
const t0 = performance.now();
for (const q of ['lead 12', '210-555', 'antonio', 'zz']) searchList(many, q, (k) => k);
const ms = (performance.now() - t0) / 4;
console.log(`14k records ≈ ${ms.toFixed(1)}ms a query`);
assert.ok(ms < 60, `search too slow: ${ms}ms`);

// A list's box keeps the list's order inside a rank, and a blank query keeps every row.
assert.deepEqual(searchList(people, '', key), people);
assert.deepEqual(searchList(people, '555', key).map((p) => p.id), ['s1', 's3']);

// Nothing typed: opened last first, then the latest activity, never twice.
const rec = recentRecords({ recentIds: ['buyer:b1', 'person:s3', 'person:gone'], people, buyers: [alamo] }, { limit: 4, activity: (p) => p.lastCommTs });
assert.deepEqual(rec.map((h) => h.kind + ':' + h.rec.id), ['buyer:b1', 'person:s3', 'person:s2', 'person:s1']);
const kept = recentRecords({ recentIds: ['person:s1'], people, buyers: [] }, { limit: 5, activity: (p) => p.lastCommTs, keep: (h) => h.kind === 'person' && !!h.rec.phone });
assert.deepEqual(kept.map((h) => h.rec.id), ['s1'], 'keep drops records the caller cannot use (no phone)');

console.log('record-search: all checks passed');
