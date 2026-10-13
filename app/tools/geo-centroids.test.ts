import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGazetteer, resolveMarket } from '../lib/market-geo';
import { bareCensusName, boundsOf, fanOut, insidePolygon, locate, parsePlaces, parseZips, placeKey } from '../lib/geo-centroids';

assert.equal(placeKey('St. Petersburg'), 'saint petersburg');
assert.equal(placeKey('St Petersburg'), 'saint petersburg');
assert.equal(placeKey('Winston-Salem'), placeKey('Winston Salem'));
assert.equal(placeKey("Coeur d'Alene"), 'coeur dalene');
assert.equal(bareCensusName('Abbeville city'), 'Abbeville');
assert.equal(bareCensusName('Nashville-Davidson metropolitan government (balance)'), 'Nashville-Davidson');
assert.equal(bareCensusName('Spring CDP'), 'Spring');

const idx = {
  places: parsePlaces(readFileSync('public/geo/places.txt', 'utf8')),
  zips: parseZips(readFileSync('public/geo/zips.txt', 'utf8')),
};
const gaz = buildGazetteer([{ city: 'San Antonio', state: 'TX' }]);
const at = (token: string) => locate(resolveMarket(token, gaz), idx);
const near = (token: string, lat: number, lng: number) => {
  const hit = at(token);
  assert.ok(hit, `${token} is placed`);
  assert.ok(Math.abs(hit.lat - lat) < 0.35 && Math.abs(hit.lng - lng) < 0.35, `${token} near ${lat},${lng}: got ${hit.lat},${hit.lng}`);
  return hit;
};
near('Phoenix, AZ', 33.45, -112.07);
near('St. Petersburg, FL', 27.77, -82.64);
near('Nashville, TN', 36.16, -86.78);
near('Oklahoma, OK', 35.47, -97.52);
near('Washington DC, WA', 38.9, -77.03);
near('San Antonio', 29.42, -98.49);
assert.equal(near('Hidalgo County, TX', 26.4, -98.2).precision, 'county');
assert.equal(near('77469, TX', 29.5, -95.7).precision, 'zip');
assert.equal(near('78501', 26.2, -98.2).precision, 'zip');
assert.equal(near('TX', 31.4, -99.3).precision, 'state');
assert.equal(at('Nowheresville, TX'), null, 'an unknown city is not dropped in the middle of its state');
assert.equal(at('Springfield'), null, 'a bare city we cannot place stays off the map');

const fanned = fanOut([{ lat: 30, lng: -98 }, { lat: 30, lng: -98 }, { lat: 30, lng: -98 }]);
assert.deepEqual(fanned[0], { lat: 30, lng: -98 });
assert.notDeepEqual(fanned[1], fanned[0]);
assert.notDeepEqual(fanned[2], fanned[1]);
assert.ok(Math.abs(fanned[2].lat - 30) < 0.01, 'the fan stays inside the city');
assert.deepEqual(boundsOf([{ lat: 1, lng: 2 }, { lat: -1, lng: 5 }]), { n: 1, s: -1, e: 5, w: 2 });
assert.equal(boundsOf([]), null);

const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
assert.equal(insidePolygon(5, 5, square), true);
assert.equal(insidePolygon(15, 5, square), false);
const vee = [{ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
assert.equal(insidePolygon(5, 2, vee), false, 'the notch of a concave lasso is outside');
assert.equal(insidePolygon(5, 9, vee), true);

console.log('geo-centroids ok');
