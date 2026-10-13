// One spelling for every place. Run: npx tsx tools/place-names.test.ts
import assert from 'node:assert/strict';
import {
  canonicalCity, canonicalMarket, cityStateLabel, dealMarketLabel, marketLabel, normalizeMarkets, normalizePlace,
  placeKey, splitMarketCell, splitPlace, stateCodeOf, stateNameOf, titleCasePlace,
} from '../lib/place-names';

// ---- states ----------------------------------------------------------------
for (const v of ['TX', 'tx', 'Tx', 'tX', 'Tx.', ' texas ', 'TEXAS', 'Texas']) assert.equal(stateCodeOf(v), 'TX', v);
assert.equal(stateCodeOf('North Carolina'), 'NC');
assert.equal(stateCodeOf('district of columbia'), 'DC');
assert.equal(stateCodeOf('Puerto Rico'), 'PR');
// Two letters that are not a state are not a state; neither is a city.
assert.equal(stateCodeOf('xx'), null);
assert.equal(stateCodeOf('San Antonio'), null);
assert.equal(stateCodeOf(''), null);
assert.equal(stateCodeOf(null), null);
assert.equal(stateNameOf('tx'), 'Texas');
assert.equal(stateNameOf('Texas'), 'Texas');

// ---- spelling ------------------------------------------------------------------
assert.equal(placeKey('St. Louis'), 'st louis');
assert.equal(placeKey('Saint Louis'), 'st louis');
assert.equal(placeKey('Ft Worth'), 'fort worth');
assert.equal(placeKey('  SAN   ANTONIO '), 'san antonio');
// "La Mesa" and "Lamesa" are two Texas-sized different places; the key keeps the space.
assert.notEqual(placeKey('La Mesa'), placeKey('Lamesa'));

assert.equal(titleCasePlace('san antonio'), 'San Antonio');
assert.equal(titleCasePlace('SAN ANTONIO'), 'San Antonio');
assert.equal(titleCasePlace('mcallen'), 'McAllen');
assert.equal(titleCasePlace("o'fallon"), "O'Fallon");
assert.equal(titleCasePlace('winston-salem'), 'Winston-Salem');
assert.equal(titleCasePlace('lake of the woods'), 'Lake of the Woods');
assert.equal(titleCasePlace('st louis'), 'St. Louis');
assert.equal(titleCasePlace('macon'), 'Macon');
assert.equal(titleCasePlace('dfw'), 'DFW');
assert.equal(titleCasePlace('DFW'), 'DFW');
// A capitalised state code after the first word is an abbreviation ("Washington DC"), not a word.
assert.equal(titleCasePlace('Washington DC'), 'Washington DC');
assert.equal(titleCasePlace('WASHINGTON DC'), 'Washington DC');
assert.equal(titleCasePlace('LA MESA'), 'La Mesa');
assert.equal(canonicalMarket('Washington DC, WA'), 'Washington DC, WA');
// Live values from the buyers table.
assert.equal(canonicalMarket('77469, TX'), '77469');
assert.deepEqual(splitPlace('77469, TX'), { city: null, state: 'TX', zip: '77469' });
assert.equal(canonicalMarket('St. Louis Park'), 'St. Louis Park');
assert.equal(canonicalMarket('Honea Path, SC'), 'Honea Path, SC');
assert.equal(canonicalMarket('St. Louis County'), 'St. Louis County');
assert.deepEqual(normalizePlace({ city: 'Nc 27101', state: 'NC', zip: null }), { city: null, state: 'NC', zip: '27101' });
assert.deepEqual(normalizePlace({ city: 'Ga 30331.', state: null, zip: null }), { city: null, state: 'GA', zip: '30331' });
assert.deepEqual(normalizePlace({ city: 'St Louis Mo', state: null, zip: null }), { city: 'St. Louis', state: 'MO', zip: null });
assert.deepEqual(normalizePlace({ city: 'Mcallen', state: 'TX', zip: null }), { city: 'McAllen', state: 'TX', zip: null });
// A run of digits that is not a ZIP is not a city either.
assert.deepEqual(normalizePlace({ city: '3222', state: 'FL', zip: '32225' }), { city: null, state: 'FL', zip: '32225' });
assert.deepEqual(splitPlace('3222'), { city: null, state: null, zip: null });

// The Census spelling wins when the state is known…
assert.equal(canonicalCity('san antonio', 'TX'), 'San Antonio');
assert.equal(canonicalCity('SAN ANTONIO', 'tx'), 'San Antonio');
assert.equal(canonicalCity('desoto', 'TX'), 'DeSoto');
assert.equal(canonicalCity('de soto', 'MO'), 'De Soto');
assert.equal(canonicalCity('mcallen', 'TX'), 'McAllen');
assert.equal(canonicalCity('saint louis', 'MO'), 'St. Louis');
assert.equal(canonicalCity('ft worth', 'TX'), 'Fort Worth');
assert.equal(canonicalCity('fort  worth', 'TX'), 'Fort Worth');
// …and across states when every state spells it the same…
assert.equal(canonicalCity('san antonio'), 'San Antonio');
assert.equal(canonicalCity('kansas city'), 'Kansas City');
assert.equal(canonicalCity('desoto'), 'DeSoto');
// …but a key two states spell differently falls back to title case ("LaFayette" in Georgia, "Lafayette" elsewhere).
assert.equal(canonicalCity('lafayette'), 'Lafayette');
assert.equal(canonicalCity('lafayette', 'GA'), 'LaFayette');
assert.equal(canonicalCity('lafayette', 'LA'), 'Lafayette');
// Unlisted places are title-cased, not dropped.
assert.equal(canonicalCity('la vernia', 'TX'), 'La Vernia');
assert.equal(canonicalCity('bexar', 'TX'), 'Bexar');

// ---- splitting ----------------------------------------------------------------
const sa = { city: 'San Antonio', state: 'TX', zip: null };
for (const v of ['San Antonio Tx', 'San antonio tX', 'san antonio tx', 'SAN ANTONIO TX', 'San Antonio, TX', 'San Antonio,TX',
  'San Antonio, Texas', 'San Antonio Texas', 'san antonio, texas', 'San Antonio - TX', 'San Antonio TX, USA', 'San Antonio, TX, United States']) {
  assert.deepEqual(splitPlace(v), sa, v);
}
assert.deepEqual(splitPlace('San Antonio TX 78254'), { city: 'San Antonio', state: 'TX', zip: '78254' });
assert.deepEqual(splitPlace('San Antonio, TX 78254-1234'), { city: 'San Antonio', state: 'TX', zip: '78254' });
assert.deepEqual(splitPlace('San Antonio 78254'), { city: 'San Antonio', state: 'TX', zip: '78254' }); // the ZIP names the state
assert.deepEqual(splitPlace('San Antonio'), { city: 'San Antonio', state: null, zip: null });
assert.deepEqual(splitPlace('TX'), { city: null, state: 'TX', zip: null });
assert.deepEqual(splitPlace('texas'), { city: null, state: 'TX', zip: null });
assert.deepEqual(splitPlace('78254'), { city: null, state: null, zip: '78254' });
assert.deepEqual(splitPlace(''), { city: null, state: null, zip: null });
assert.deepEqual(splitPlace('Kansas City Missouri'), { city: 'Kansas City', state: 'MO', zip: null });
assert.deepEqual(splitPlace('Charlotte North Carolina'), { city: 'Charlotte', state: 'NC', zip: null });
assert.deepEqual(splitPlace('Washington, DC'), { city: 'Washington', state: 'DC', zip: null });
// A city named like a state stays a city when it is not the whole string.
assert.deepEqual(splitPlace('Washington, NC'), { city: 'Washington', state: 'NC', zip: null });
assert.deepEqual(splitPlace('Nevada, MO'), { city: 'Nevada', state: 'MO', zip: null });
// A city whose last word is not a state is left whole.
assert.deepEqual(splitPlace('Terre Haute'), { city: 'Terre Haute', state: null, zip: null });
assert.deepEqual(splitPlace('Saint Jo, TX'), { city: 'Saint Jo', state: 'TX', zip: null });
assert.deepEqual(splitPlace('La Vernia'), { city: 'La Vernia', state: null, zip: null });
// Counties keep their word.
assert.deepEqual(splitPlace('Hidalgo County, TX'), { city: 'Hidalgo County', state: 'TX', zip: null });

// The property-level fix.
assert.deepEqual(normalizePlace({ city: 'San Antonio Tx', state: null, zip: null }), { city: 'San Antonio', state: 'TX', zip: null });
assert.deepEqual(normalizePlace({ city: 'San antonio tX', state: '', zip: '' }), { city: 'San Antonio', state: 'TX', zip: null });
assert.deepEqual(normalizePlace({ city: 'san antonio', state: 'texas', zip: '78254-1234' }), { city: 'San Antonio', state: 'TX', zip: '78254' });
assert.deepEqual(normalizePlace({ city: 'SAN ANTONIO, TX 78254', state: null, zip: null }), { city: 'San Antonio', state: 'TX', zip: '78254' });
// A state already in its column is kept; the city only loses its suffix.
assert.deepEqual(normalizePlace({ city: 'Dallas, TX', state: 'GA', zip: null }), { city: 'Dallas', state: 'GA', zip: null });
// The state column holding "TX 78254".
assert.deepEqual(normalizePlace({ city: 'Houston', state: 'TX 77084', zip: null }), { city: 'Houston', state: 'TX', zip: '77084' });
// Nothing but a state in the city column moves over.
assert.deepEqual(normalizePlace({ city: 'TX', state: null, zip: null }), { city: null, state: 'TX', zip: null });
assert.deepEqual(normalizePlace({ city: 'Texas', state: null, zip: null }), { city: null, state: 'TX', zip: null });
// A clean row is untouched.
assert.deepEqual(normalizePlace({ city: 'San Antonio', state: 'TX', zip: '78254' }), { city: 'San Antonio', state: 'TX', zip: '78254' });
// A city that shares a state's name stays a city when the state column names another state…
assert.deepEqual(normalizePlace({ city: 'Washington', state: 'NC', zip: null }), { city: 'Washington', state: 'NC', zip: null });
assert.deepEqual(normalizePlace({ city: 'Nevada', state: 'MO', zip: null }), { city: 'Nevada', state: 'MO', zip: null });
assert.deepEqual(normalizePlace({ city: 'washington', state: 'dc', zip: null }), { city: 'Washington', state: 'DC', zip: null });
// …and a state repeated in both columns is only a state.
assert.deepEqual(normalizePlace({ city: 'TX', state: 'TX', zip: null }), { city: null, state: 'TX', zip: null });
// Fixing a fixed row changes nothing.
for (const dirty of [
  { city: 'San Antonio Tx', state: null, zip: null }, { city: 'Washington, NC', state: null, zip: null }, { city: 'TX', state: null, zip: null },
  { city: 'mcallen', state: 'tx', zip: '78501' }, { city: 'SAN ANTONIO, TX 78254', state: null, zip: null }, { city: 'Houston', state: 'TX 77084', zip: null },
]) {
  const once = normalizePlace(dirty);
  assert.deepEqual(normalizePlace(once), once, JSON.stringify(dirty));
}
assert.deepEqual(normalizePlace({ city: null, state: null, zip: null }), { city: null, state: null, zip: null });
// A ZIP that lost its leading zero to a spreadsheet.
assert.deepEqual(normalizePlace({ city: 'Boston', state: 'MA', zip: '2101' }), { city: 'Boston', state: 'MA', zip: '02101' });

// ---- markets ------------------------------------------------------------------
for (const v of ['San Antonio Tx', 'san antonio, texas', 'SAN ANTONIO TX', 'San Antonio, TX']) assert.equal(canonicalMarket(v), 'San Antonio, TX', v);
assert.equal(canonicalMarket('San Antonio'), 'San Antonio');
assert.equal(canonicalMarket('san antonio', 'TX'), 'San Antonio, TX');
assert.equal(canonicalMarket('texas'), 'TX');
assert.equal(canonicalMarket('tx'), 'TX');
assert.equal(canonicalMarket('Missouri'), 'MO');
assert.equal(canonicalMarket('63135'), '63135');
assert.equal(canonicalMarket('San Antonio TX 78254'), 'San Antonio, TX');
assert.equal(canonicalMarket('hidalgo county, tx'), 'Hidalgo County, TX');
assert.equal(canonicalMarket('Hidalgo County'), 'Hidalgo County');
assert.equal(canonicalMarket('bexar county', 'TX'), 'Bexar County, TX');
assert.equal(canonicalMarket('east baton rouge parish, LA'), 'East Baton Rouge Parish, LA');
assert.equal(canonicalMarket('DFW'), 'DFW');
assert.equal(canonicalMarket('dfw'), 'DFW');
assert.equal(canonicalMarket('McAllen, TX'), 'McAllen, TX');
assert.equal(canonicalMarket('mcallen tx'), 'McAllen, TX');
assert.equal(canonicalMarket('  '), null);
assert.equal(canonicalMarket(null), null);

assert.deepEqual(splitMarketCell('DFW, Houston'), ['DFW', 'Houston']);
assert.deepEqual(splitMarketCell('San Antonio, TX, Austin, TX'), ['San Antonio, TX', 'Austin, TX']);
assert.deepEqual(splitMarketCell('TX; OK'), ['TX', 'OK']);
assert.deepEqual(splitMarketCell('San Antonio, TX'), ['San Antonio, TX']);
assert.deepEqual(splitMarketCell('TX, OK, MO'), ['TX', 'OK', 'MO']);
assert.deepEqual(splitMarketCell('78254, 78255'), ['78254', '78255']);

assert.deepEqual(normalizeMarkets(['San Antonio Tx', 'san antonio, TX', 'SAN ANTONIO, Texas', 'TX', 'texas', '', '  ']), ['San Antonio, TX', 'TX']);
assert.deepEqual(normalizeMarkets(['DFW, Houston', 'houston']), ['DFW', 'Houston']);
assert.deepEqual(normalizeMarkets(['Dallas', 'Dallas, TX']), ['Dallas', 'Dallas, TX']); // without a state we do not guess
assert.deepEqual(normalizeMarkets(['SC', 'MO', 'Missouri']), ['SC', 'MO']);
assert.deepEqual(normalizeMarkets(null), []);

assert.equal(marketLabel('TX'), 'Texas');
assert.equal(marketLabel('San Antonio, TX'), 'San Antonio, TX');
assert.equal(cityStateLabel('San Antonio', 'TX'), 'San Antonio, TX');
assert.equal(cityStateLabel('San Antonio', null), 'San Antonio');
assert.equal(cityStateLabel(null, 'tx'), 'Texas');
assert.equal(cityStateLabel('', ''), '');
assert.equal(dealMarketLabel('North Carolina', 'Charlotte', 'NC'), 'Charlotte, NC');
assert.equal(dealMarketLabel('NC', 'Charlotte', 'North Carolina'), 'Charlotte, NC');
assert.equal(dealMarketLabel('Charlotte, North Carolina', null, null), 'Charlotte, NC');
assert.equal(dealMarketLabel(null, 'Charlotte', 'NC'), 'Charlotte, NC');
assert.equal(dealMarketLabel('NC', null, 'NC'), 'NC');
assert.equal(dealMarketLabel(null, null, null), '');

console.log('place-names: ok');
