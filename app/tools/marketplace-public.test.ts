// Public marketplace cards keep photos and COMPR, and drop contracts.
// Run with: npx tsx tools/marketplace-public.test.ts

import assert from 'node:assert/strict';
import { compactMoney, daysSince, fromFeed, hideStreet, isBuyerPhoto, lockCard, mentionsStreet, parseLegacyPlace, toMarketCard, type MarketSource } from '../lib/marketplace-public';

assert.equal(isBuyerPhoto('https://cdn.example.com/front.jpg'), true);
assert.equal(isBuyerPhoto('http://cdn.example.com/front.jpg'), false);
assert.equal(isBuyerPhoto('https://files.example.com/assignment-contract.pdf'), false);
assert.equal(isBuyerPhoto('https://thecompr.com/v/report'), true);

assert.equal(compactMoney(170000), '$170K');
assert.equal(compactMoney(1300000), '$1.3M');
assert.deepEqual(parseLegacyPlace('2016 Meadow lane', '2016 Meadow lane · Richmond, TX'), {
  address: '2016 Meadow lane', city: 'Richmond', state: 'TX',
});

const src: MarketSource = {
  slug: 'abc', url: 'https://example.com/listing/abc', showAddress: true, headline: null,
  workspaceId: 11, dealId: 9, stage: 'Ready To Market',
  asking: null, marketed: 170000, offer: null, arv: 236518, rehab: 57812,
  occupancy: 'Vacant', heroUrl: 'https://cdn.example.com/hero.jpg',
  buyerReportUrl: 'https://thecompr.com/v/report',
  cmaUrl: 'https://cdn.example.com/comps.pdf',
  updatedAt: '2026-09-01T00:00:00Z',
  line1: '486 Bristol Rd', city: 'Honea Path', state: 'SC', zip: '29654',
  beds: 3, baths: 2, sqft: 1880, lat: 34.507876, lng: -82.298221,
  photos: ['https://cdn.example.com/hero.jpg', 'https://cdn.example.com/Purchase-Agreement.pdf', 'not-a-url'],
};

const card = toMarketCard(src);
assert.equal(card.askingPrice, 170000);
assert.equal(card.lat, 34.507876);
assert.deepEqual(card.photos, ['https://cdn.example.com/hero.jpg']);
assert.equal(card.buyerReportUrl, 'https://thecompr.com/v/report');
assert.equal(card.compsUrl, 'https://cdn.example.com/comps.pdf');
assert.equal(card.status, 'Available');
assert.equal('contractUrl' in card, false);

const hidden = toMarketCard({ ...src, showAddress: false });
assert.equal(hidden.address, 'Address on request');
assert.equal(hidden.lat, null);
assert.equal(hidden.lng, null);

const listing = fromFeed({
  title: '2016 Meadow lane',
  city: '2016 Meadow lane · Richmond, TX',
  price: '$290,000',
  arv: '$395,000',
  beds: '3 bd / 2 ba',
  photo: 'https://cdn.example.com/a.jpg',
  photos: ['https://cdn.example.com/deed.pdf'],
  buyer_report_url: 'https://thecompr.com/v/ok',
  cma_url: 'https://cdn.example.com/assignment.pdf',
  deal_id: 3692,
  slug: 'fva',
  url: 'https://example.com/market/fva',
});
assert.equal(listing.address, '2016 Meadow lane');
assert.equal(listing.city, 'Richmond');
assert.equal(listing.state, 'TX');
assert.equal(listing.price, 290000);
assert.equal(listing.beds, 3);
assert.equal(listing.baths, 2);
assert.deepEqual(listing.photos, ['https://cdn.example.com/a.jpg']);
assert.equal(listing.buyerReportUrl, 'https://thecompr.com/v/ok');
assert.equal(listing.compsUrl, null);
assert.equal(listing.id, '3692');

const pending = fromFeed(toMarketCard({ ...src, stage: 'Buyer Under Contract' }));
assert.equal(pending.status, 'Sale Pending');
assert.equal(pending.sqft, 1880);
assert.equal(pending.repairs, 57812);

const locked = lockCard(toMarketCard({ ...src, photos: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'] }));
assert.equal(locked.address, 'Address on request');
assert.equal(locked.title, 'Honea Path, SC');
assert.equal(locked.buyerReportUrl, null);
assert.equal(locked.compsUrl, null);
assert.equal(locked.url, '');
assert.equal(locked.slug, '');
assert.equal(locked.hasReport, true);
assert.equal(locked.hasComps, true);
assert.equal(locked.lat, 34.51);
assert.equal(locked.lng, -82.3);
assert.deepEqual(locked.photos, ['https://cdn.example.com/hero.jpg']);
assert.equal(locked.photoCount, 3);
assert.equal(JSON.stringify(locked).includes('486 Scott'), false);
// City and state only: nothing that narrows it to one house.
assert.equal(locked.zip, '');
assert.equal(locked.county, '');
assert.equal(locked.yearBuilt, null);
assert.equal(locked.description, null);

const teaser = fromFeed(locked);
assert.equal(teaser.locked, true);
assert.equal(teaser.photoCount, 3);
assert.equal(teaser.hasReport, true);
assert.equal(teaser.buyerReportUrl, null);
// The teaser pins where lockCard put it (about a kilometre off), not nowhere.
assert.equal(teaser.lng, -82.3);
assert.equal(teaser.lat, locked.lat);

assert.equal(daysSince('2026-09-20T00:00:00Z', Date.parse('2026-09-27T12:00:00Z')), 7);
assert.equal(daysSince(null), null);

// Hidden address: the street never reaches public copy, however it was typed.
assert.equal(mentionsStreet('2016 Meadow Lane', '2016 Meadow lane'), true);
assert.equal(mentionsStreet('Great flip at 2016 MEADOW, Richmond', '2016 Meadow lane'), true);
assert.equal(mentionsStreet('3 bed flip in Richmond', '2016 Meadow lane'), false);
assert.equal(mentionsStreet('Meadow views', '2016 Meadow lane'), false);
assert.equal(mentionsStreet('20160 Meadow lane', '2016 Meadow lane'), false);
assert.equal(hideStreet('Walk 2016 Meadow Lane today. 2016 meadow is vacant.', '2016 Meadow lane', 'Richmond, TX'),
  'Walk Richmond, TX today. Richmond, TX is vacant.');
assert.equal(mentionsStreet('Flip at 123 Main St', '123 N Main St'), true);
assert.equal(hideStreet('Vacant at 123 N Main, needs roof', '123 N Main St', 'Richmond, VA'), 'Vacant at Richmond, VA, needs roof');
assert.equal(mentionsStreet('Lot 123 N of town', '123 N Main St'), false);
// The direction typed the other way round from how it was saved.
assert.equal(mentionsStreet('Flip at 123 North Main Street', '123 N Main St'), true);
assert.equal(hideStreet('Vacant at 123 North Main Street, needs roof', '123 N Main St', 'Richmond, VA'), 'Vacant at Richmond, VA, needs roof');
assert.equal(hideStreet('Vacant at 123 N Main St', '123 North Main Street', 'Richmond, VA'), 'Vacant at Richmond, VA');
const quiet = toMarketCard({ ...src, showAddress: false, description: 'Vacant at 486 Bristol Road, needs roof.' });
assert.equal(quiet.description, 'Vacant at Honea Path, SC, needs roof.');
assert.equal(String(quiet.title).includes('Scott'), false);

console.log('marketplace-public ok');
