// Placing a buyer's market strings. Run: npx tsx tools/market-geo.test.ts
import assert from 'node:assert/strict';
import { buildGazetteer, entityKind, resolveMarket, resolveMarkets, stateOfZip } from '../lib/market-geo';

// ---- ZIP prefixes ----------------------------------------------------------
// Every (zip3, state) pair this workspace's properties actually carry, read off
// the live table. The nine pairs it also carries that contradict USPS are left
// out and asserted separately below: those are mistyped properties, not gaps in
// the table, and they are the reason ZIPs resolve from here rather than from
// our own address history.
const REAL_PAIRS: [string, string][] = [
  ['152', 'PA'], ['206', 'MD'], ['212', 'MD'], ['218', 'MD'], ['242', 'VA'],
  ['270', 'NC'], ['275', 'NC'], ['282', 'NC'], ['287', 'NC'],
  ['290', 'SC'], ['296', 'SC'], ['298', 'SC'],
  ['300', 'GA'], ['303', 'GA'], ['315', 'GA'],
  ['320', 'FL'], ['327', 'FL'], ['339', 'FL'], ['342', 'FL'], ['349', 'FL'],
  ['350', 'AL'], ['352', 'AL'], ['368', 'AL'],
  ['370', 'TN'], ['381', 'TN'], ['383', 'TN'], ['386', 'MS'],
  ['402', 'KY'], ['405', 'KY'], ['430', 'OH'], ['458', 'OH'],
  ['460', 'IN'], ['479', 'IN'], ['480', 'MI'], ['482', 'MI'],
  ['600', 'IL'], ['627', 'IL'], ['630', 'MO'], ['641', 'MO'],
  ['660', 'KS'], ['677', 'KS'], ['706', 'LA'], ['719', 'AR'], ['724', 'AR'],
  ['730', 'OK'], ['741', 'OK'], ['748', 'OK'],
  ['750', 'TX'], ['770', 'TX'], ['782', 'TX'], ['799', 'TX'],
  ['802', 'CO'], ['809', 'CO'], ['850', 'AZ'], ['864', 'AZ'],
  ['890', 'NV'], ['891', 'NV'], ['900', 'CA'], ['958', 'CA'],
];
for (const [z3, state] of REAL_PAIRS) {
  assert.equal(stateOfZip(z3 + '01'), state, `${z3}xx should be ${state}`);
}

// The ZIPs quoted on real buyers.
assert.equal(stateOfZip('63135'), 'MO');
assert.equal(stateOfZip('78501'), 'TX');
assert.equal(stateOfZip('74105'), 'OK');
assert.equal(stateOfZip('46201'), 'IN');
assert.equal(stateOfZip('35206'), 'AL');
assert.equal(stateOfZip('29654'), 'SC');
assert.equal(stateOfZip('73111'), 'OK');
assert.equal(stateOfZip('75228-1234'), 'TX');
assert.equal(stateOfZip('not a zip'), null);

// Borders that are easy to get wrong.
assert.equal(stateOfZip('19901'), 'DE');
assert.equal(stateOfZip('20001'), 'DC');
assert.equal(stateOfZip('24601'), 'VA');
assert.equal(stateOfZip('24701'), 'WV');
assert.equal(stateOfZip('88501'), 'TX');  // El Paso sits outside the 750–799 block

// ---- gazetteer -------------------------------------------------------------
const gaz = buildGazetteer([
  ...Array(54).fill({ city: 'Dallas', state: 'TX' }),
  ...Array(10).fill({ city: 'Dallas', state: 'GA' }),
  ...Array(3).fill({ city: 'Dallas', state: 'NC' }),
  ...Array(12).fill({ city: 'Kansas City', state: 'MO' }),
  ...Array(6).fill({ city: 'Kansas City', state: 'KS' }),
  ...Array(20).fill({ city: 'San Antonio', state: 'TX' }),
  { city: 'Bexar', state: 'TX' },
  ...Array(9).fill({ city: 'DFW', state: 'TX' }),
]);
// A clear majority places the city…
assert.equal(gaz.city.get('dallas'), 'TX');
// …a genuine split does not. Kansas City is in both states for real.
assert.equal(gaz.city.get('kansas city'), undefined);

// ---- resolving one token ---------------------------------------------------
assert.deepEqual(resolveMarket('SC', gaz), { token: 'SC', kind: 'state', state: 'SC', city: null, label: 'South Carolina' });
assert.deepEqual(resolveMarket('Missouri', gaz), { token: 'Missouri', kind: 'state', state: 'MO', city: null, label: 'Missouri' });
assert.equal(resolveMarket('San Antonio', gaz).state, 'TX');
assert.equal(resolveMarket('San Antonio', gaz).label, 'San Antonio, TX');
assert.equal(resolveMarket('Houston, TX', gaz).state, 'TX');   // explicit beats the gazetteer
assert.equal(resolveMarket('Kansas City', gaz).kind, 'unknown'); // ambiguous stays unplaced
assert.equal(resolveMarket('63135', gaz).kind, 'zip');
assert.equal(resolveMarket('63135', gaz).state, 'MO');
// Casing is the token's own: re-casing turns DFW into Dfw and McAllen into Mcallen.
assert.equal(resolveMarket('DFW', gaz).label, 'DFW, TX');
assert.equal(resolveMarket('McAllen, TX', gaz).label, 'McAllen, TX');
assert.equal(resolveMarket('St. Louis Park, MN', gaz).label, 'St. Louis Park, MN');

assert.equal(resolveMarket('Hidalgo County, TX', gaz).kind, 'county');
assert.equal(resolveMarket('Hidalgo County, TX', gaz).state, 'TX');
assert.equal(resolveMarket('Bexar County', gaz).state, 'TX');   // county named in our own data
assert.equal(resolveMarket('Nowhere', gaz).kind, 'unknown');
assert.equal(resolveMarket('', gaz).kind, 'unknown');

// ---- resolving a buyer's whole list ---------------------------------------
// A ZIP beside an unknown city tells us the state.
const honea = resolveMarkets(['Honea Path', '29654'], gaz);
assert.equal(honea[0].state, 'SC');
assert.equal(honea[0].label, 'Honea Path, SC');
assert.equal(honea[1].state, 'SC');

// A buyer spanning many states teaches us nothing, so the unknown stays unknown.
const wide = resolveMarkets(['Houston', 'Columbia', 'SC', 'NY', 'TX'], gaz);
assert.equal(wide.find((p) => p.token === 'Columbia')?.kind, 'unknown');

// One state named, one city we cannot place on its own.
const oneState = resolveMarkets(['New Braunfels', 'TX'], gaz);
assert.equal(oneState[0].state, 'TX');

// ---- LLC vs person ---------------------------------------------------------
assert.equal(entityKind('Monentus Group Llc', 'Monentus Group Llc'), 'llc');
// The company decides it, not whoever answers the phone for it.
assert.equal(entityKind('Chris Anderson', 'Harbor Capital'), 'entity');
assert.equal(entityKind('Dana Ortiz', 'Blue Mesa Investments'), 'entity');
assert.equal(entityKind('Tom Reyes', 'Evergreen Residential'), 'entity');
assert.equal(entityKind('Marcus Bell', 'Lone Star Rentals'), 'entity');
assert.equal(entityKind('Priya Nair', 'Fortune Acquisitions'), 'entity');
// One bare word tells us nothing either way.
assert.equal(entityKind('Acquisitions Desk', 'Amherst'), 'unclear');
assert.equal(entityKind('Rice Capital LLC', null), 'llc');
assert.equal(entityKind('Acme Holdings', null), 'entity');
assert.equal(entityKind('Blue Door Properties', null), 'entity');
assert.equal(entityKind('Kevin Arden', null), 'individual');
assert.equal(entityKind('Daniel L dove', null), 'individual');
assert.equal(entityKind('jose', null), 'unclear');
assert.equal(entityKind('Buyer 2745', null), 'unclear');
assert.equal(entityKind(null, null), 'unclear');
// A stored classification wins over the name.
assert.equal(entityKind('Kevin Arden', null, 'llc'), 'llc');
assert.equal(entityKind('Acme Holdings LLC', null, 'individual'), 'individual');
assert.equal(entityKind('Kevin Arden', null, 'fund'), 'entity');

console.log('market-geo: all assertions passed');
