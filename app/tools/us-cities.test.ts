// The Census city / county pick lists behind the buy-box location picker.
// Run: npx tsx tools/us-cities.test.ts
import assert from 'node:assert/strict';
import { STATE_NAMES } from '../lib/market-geo';
import { citiesIn, countiesIn, formatPop, searchPlaces } from '../lib/us-cities';

const names = (st: string) => citiesIn(st).map((p) => p.name);

// Every state + DC has cities and counties; Puerto Rico is not in the files.
const states = Object.keys(STATE_NAMES).filter((s) => s !== 'PR');
assert.equal(states.length, 51);
for (const st of states) {
  assert.ok(citiesIn(st).length > 0, `${st} has cities`);
  assert.ok(countiesIn(st).length > 0, `${st} has counties`);
  const pops = citiesIn(st).map((p) => p.pop);
  assert.deepEqual(pops, [...pops].sort((a, b) => b - a), `${st} cities largest first`);
  assert.ok(pops.every((n) => n >= 5000), `${st} cities over the cutoff`);
  assert.equal(new Set(names(st)).size, names(st).length, `${st} has no duplicate names`);
}
assert.ok(citiesIn('tx').length > 0, 'lowercase code works');

// Ordering and names: only the trailing legal type is stripped.
const tx = names('TX');
assert.deepEqual(tx.slice(0, 3), ['Houston', 'San Antonio', 'Dallas']);
assert.ok(tx.indexOf('Houston') < tx.indexOf('Dallas'));
assert.ok(names('MO').includes('Kansas City') && names('MO').includes('North Kansas City'));
assert.ok(names('KS').includes('Kansas City'));
assert.ok(names('UT').includes('Salt Lake City'));
assert.ok(names('NV').includes('Carson City'));
assert.ok(names('OK').includes('Oklahoma City'));
assert.ok(names('MO').includes('St. Louis'));
assert.ok(names('TN').includes('Nashville') && names('KY').includes('Louisville'));
assert.ok(names('HI').includes('Honolulu') && names('AK').includes('Juneau'));
assert.equal(names('DC')[0], 'Washington');
for (const st of states) for (const n of names(st)) assert.ok(!/ (city|town|village|borough|CDP|\(balance\))$/.test(n), `${st} ${n}`);

// Counties keep their Census name, which is what the matcher compares.
assert.equal(countiesIn('TX')[0].name, 'Harris County');
assert.ok(countiesIn('TX').some((c) => c.name === 'Hidalgo County'));
assert.ok(countiesIn('LA').some((c) => c.name === 'Orleans Parish'));

// Type-ahead: prefix first, then word start, by population.
assert.deepEqual(searchPlaces(citiesIn('TX'), 'san', 2).map((p) => p.name), ['San Antonio', 'San Angelo']);
assert.equal(searchPlaces(citiesIn('MO'), 'kansas')[0].name, 'Kansas City');
assert.equal(searchPlaces(citiesIn('MO'), 'st louis')[0].name, 'St. Louis');
assert.ok(searchPlaces(citiesIn('TX'), 'worth').some((p) => p.name === 'Fort Worth'));
assert.equal(searchPlaces(citiesIn('TX'), '').length, 8);

assert.equal(formatPop(1326087), '1.3M');
assert.equal(formatPop(999_800), '1M');
assert.equal(formatPop(245310), '245K');
assert.equal(formatPop(8204), '8.2K');

console.log('us-cities: all checks passed');
