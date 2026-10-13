// The house a screen is on rides in the address. Run: npx tsx tools/url-deal.test.ts
import assert from 'node:assert/strict';
import { dealPinsFor, recordListOf, urlDealOf } from '../lib/url-deal';

const pins = { personDealId: 'd1', dealSheetDealId: 'd2', tcDealId: 'd3', dispoDealId: 'd4' };
assert.equal(urlDealOf({ screen: 'person', ...pins }), 'd1');
assert.equal(urlDealOf({ screen: 'dealSheet', ...pins }), 'd2');
assert.equal(urlDealOf({ screen: 'tc', ...pins }), 'd3');
assert.equal(urlDealOf({ screen: 'dispoProperty', ...pins }), 'd4');
assert.equal(urlDealOf({ screen: 'people', ...pins }), null, 'a list names no house');
assert.equal(urlDealOf({ screen: 'person' }), null, 'an unpinned record names none');

// Restoring sets only that screen's pin, and clears it when the hash names no house.
assert.deepEqual(dealPinsFor('person', 'd9'), { personDealId: 'd9' });
assert.deepEqual(dealPinsFor('person', null), { personDealId: null });
assert.deepEqual(dealPinsFor('dealSheet', 'd9'), { dealSheetDealId: 'd9' });
assert.deepEqual(dealPinsFor('tc', 'd9'), { tcDealId: 'd9' });
assert.deepEqual(dealPinsFor('dispoProperty', null), { dispoDealId: null });
assert.deepEqual(dealPinsFor('home', 'd9'), {});

// A missing or archived record lands on its own list, not Home.
assert.equal(recordListOf('buyer'), 'buyers');
for (const sc of ['person', 'dealSheet', 'dispoProperty', 'tc']) assert.equal(recordListOf(sc), 'people');
assert.equal(recordListOf('deals'), null);

console.log('url-deal ok');
