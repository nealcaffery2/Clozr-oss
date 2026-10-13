// scoreBuyerDeal + normalizeBuyBox state folding. Mirrors migration 98.
//
//   npx tsx tools/buyer-score.test.ts

import { normalizeBuyBox, scoreBuyerDeal, summarizeBuyBox } from '../lib/buyer-profile';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};

const okc = {
  price: 120000, city: 'Oklahoma City', state: 'OK', zip: '73111', beds: 3, baths: 2, type: 'single_family',
};
const stl = { price: 120000, city: 'St. Louis', state: 'MO', zip: '63101', beds: 3, baths: 2, type: 'single_family' };
const springfieldOk = { price: 120000, city: 'Springfield', state: 'OK', beds: 3, baths: 2, type: 'single_family' };
const springfieldMo = { price: 120000, city: 'Springfield', state: 'MO', beds: 3, baths: 2, type: 'single_family' };

const moCity = {
  location_prefs: [{ name: 'St. Louis', type: 'city', state: 'MO' }],
  property_types: ['single_family'],
  price: { min: 50000, max: 200000 },
  beds: { min: 3 },
};
const okCity = {
  location_prefs: [{ name: 'Oklahoma City', type: 'city', state: 'OK' }],
  property_types: ['single_family'],
  price: { min: 50000, max: 200000 },
  beds: { min: 3 },
};
const scState = {
  location_prefs: [{ name: 'SC', type: 'state' }],
  property_types: ['single_family'],
  price: { min: 50000, max: 200000 },
  beds: { min: 3 },
};
const noLoc = { property_types: ['single_family'], price: { min: 50000, max: 200000 }, beds: { min: 3 } };
const springfieldMoOnly = {
  location_prefs: [{ name: 'Springfield', type: 'city', state: 'Missouri' }],
  property_types: ['single_family'],
  price: { min: 50000, max: 200000 },
  beds: { min: 3 },
};
const bothStates = {
  location_prefs: [
    { name: 'Dallas', type: 'city', state: 'TX' },
    { name: 'OK', type: 'state' },
  ],
  property_types: ['single_family'],
  price: { min: 50000, max: 200000 },
  beds: { min: 3 },
};

const mo = scoreBuyerDeal(moCity, okc);
check('Missouri city buyer vs Oklahoma City is 0', mo.score === 0 && mo.reasons.includes('wrong state'), mo);
const ok = scoreBuyerDeal(okCity, okc);
check('Oklahoma City buyer vs Oklahoma City is in market and above 55', ok.score >= 55 && ok.reasons.includes('in market'), ok);
const sc = scoreBuyerDeal(scState, okc);
check('South Carolina-only buyer vs Oklahoma is 0', sc.score === 0 && sc.reasons.includes('wrong state'), sc);
const priceOnly = scoreBuyerDeal(moCity, { ...okc, city: 'Tulsa', state: 'OK' });
check('price + type + beds cannot rescue a geo miss', priceOnly.score === 0, priceOnly);

const collision = scoreBuyerDeal(springfieldMoOnly, springfieldOk);
check('Springfield, MO does not match Springfield, OK', collision.score === 0 && collision.reasons.includes('wrong state'), collision);
const sameCity = scoreBuyerDeal(springfieldMoOnly, springfieldMo);
check('Springfield, MO matches Springfield, MO', sameCity.score >= 55 && sameCity.reasons.includes('in market'), sameCity);

const inState = scoreBuyerDeal(scState, { price: 120000, city: 'Charleston', state: 'SC', beds: 3, baths: 2, type: 'single_family' });
check('state-level pref scores in-state on a city in that state', inState.score >= 55 && inState.reasons.includes('in state'), inState);

const kcVsSpringfield = scoreBuyerDeal(moCity, springfieldMo);
check('city-only MO buyer does not match a different MO city', kcVsSpringfield.score === 0 && kcVsSpringfield.reasons.includes('outside buy area'), kcVsSpringfield);

const home = scoreBuyerDeal(moCity, stl);
check('St. Louis buyer matches St. Louis', home.score >= 55 && home.reasons.includes('in market'), home);

const multi = scoreBuyerDeal(bothStates, okc);
check('buyer who listed OK as a state still matches Oklahoma', multi.score >= 55 && multi.reasons.includes('in state'), multi);

const open = scoreBuyerDeal(noLoc, okc);
check('buyer with no buy area scores 0, not a national match', open.score === 0 && open.reasons.includes('no buy area'), open);

const stlCounty = {
  location_prefs: [{ name: 'St. Louis County', type: 'county', state: 'MO' }],
  property_types: ['single_family'], price: { min: 50000, max: 200000 }, beds: { min: 3 },
};
const countyNoData = scoreBuyerDeal(stlCounty, stl);
check('county-only buyer matches in its state while the deal has no county', countyNoData.score >= 55 && countyNoData.reasons.includes('county not on file'), countyNoData);
const countyOtherState = scoreBuyerDeal(stlCounty, okc);
check('county-only buyer still refuses another state', countyOtherState.score === 0 && countyOtherState.reasons.includes('wrong state'), countyOtherState);
const countyKnownMiss = scoreBuyerDeal(stlCounty, { ...stl, county: 'Jackson County' });
check('county-only buyer misses a deal in a different known county', countyKnownMiss.score === 0 && countyKnownMiss.reasons.includes('outside buy area'), countyKnownMiss);
check('strict criteria only when a strict setting killed it', !mo.reasons.includes('strict criteria') && !open.reasons.includes('strict criteria'), [mo.reasons, open.reasons]);

const folded = normalizeBuyBox(moCity);
check('normalizeBuyBox folds city state onto locations.states', folded.locations.states.includes('MO') && folded.locations.cities.includes('St. Louis'), folded.locations);
const missouriName = normalizeBuyBox({ location_prefs: [{ name: 'Missouri', type: 'state' }] });
check('full state name becomes MO', missouriName.location_prefs[0]?.name === 'MO' && missouriName.locations.states.includes('MO'), missouriName.location_prefs);
check('market label includes the state', summarizeBuyBox(folded).markets[0] === 'St. Louis, MO', summarizeBuyBox(folded).markets);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
