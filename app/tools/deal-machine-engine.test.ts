// Deal Machine's judgement on CLOZR's side (supabase/functions/_shared/deal-machine-engine.ts):
// reading a Facebook post, mapping an InvestorLift row, the lender / listed / land
// gates, the fund buy box and the MAO, and what lands under each policy.
// Run: npx tsx tools/deal-machine-engine.test.ts
import assert from 'node:assert/strict';
import {
  type Candidate, type JudgeSettings, blockedCategory, fbPosterBlock, fromFacebookPost, fromInvestorLift, isDealPost, judge,
  looksLikeStreet, maoOf, matchesBuybox, money, normalizeCityKey, notSfr, parsePostText, shouldLand, toEnvelope,
} from '../supabase/functions/_shared/deal-machine-engine';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const S: JudgeSettings = {
  deal: { maoPct: 70, minArv: 80_000, maxArv: 600_000 },
  markets: { enabledStates: ['TX', 'GA', 'NC', 'TN', 'OH', 'MO', 'FL'], enabledCities: [], mode: 'strict' },
};

const base = (patch: Partial<Candidate> = {}): Candidate => ({
  source: 'investorlift', sourceId: 'investorlift:abc', line1: '123 Oak St', city: 'Houston', state: 'TX', zip: '77002', county: null,
  place: [patch.line1 === undefined ? '123 Oak St' : patch.line1, patch.city ?? 'Houston', patch.state ?? 'TX'].filter(Boolean).join(', '), beds: 3, baths: 2, sqft: 1400, yearBuilt: 1985, propertyType: 'Single Family',
  asking: 120_000, arv: 240_000, rehab: 30_000, contactName: 'Jane Wholesaler', phone: '7135550100', email: null,
  url: 'https://investorlift.com/marketplace/deal/abc', photos: [], text: 'Great flip in a strong area.', postedAt: null, group: null, raw: {},
  ...patch,
});

// ---- small readers ----

test('money reads $, commas and k', () => {
  assert.equal(money('$186,000'), 186000);
  assert.equal(money('186k'), 186000);
  assert.equal(money(0), null);
  assert.equal(money('call me'), null);
});

test('a street is a number and a street type', () => {
  assert.equal(looksLikeStreet('123 Oak St'), true);
  assert.equal(looksLikeStreet('Houston, TX'), false);
  assert.equal(looksLikeStreet('Harris County'), false);
});

test('city keys fold Ft/Fort and St/Saint', () => {
  assert.equal(normalizeCityKey('Ft. Worth'), normalizeCityKey('Fort Worth'));
  assert.equal(normalizeCityKey('St Louis'), normalizeCityKey('Saint Louis'));
});

test('MAO is 70% ARV − rehab − 20k, rounded', () => {
  assert.equal(maoOf(240_000, 30_000), 118_000);
  assert.equal(maoOf(345_000, 0), 221_500);
  assert.equal(maoOf(null, 10_000), null);
});

// ---- Facebook posts ----

const post = `🔥 OFF MARKET DEAL 🔥
4521 Maple Dr, San Antonio, TX 78228
3/2 · 1,450 sqft · built 1978
Asking: $145,000
ARV: $260k
Rehab: $35k
Call or text 210-555-0136`;

test('a deal post is read: street, city, money, specs, phone', () => {
  assert.equal(isDealPost(post), true);
  const f = parsePostText(post);
  assert.equal(f.line1, '4521 Maple Dr');
  assert.equal(f.city, 'San Antonio');
  assert.equal(f.state, 'TX');
  assert.equal(f.zip, '78228');
  assert.equal(f.asking, 145_000);
  assert.equal(f.arv, 260_000);
  assert.equal(f.rehab, 35_000);
  assert.equal(f.beds, 3);
  assert.equal(f.baths, 2);
  assert.equal(f.sqft, 1450);
  assert.equal(f.yearBuilt, 1978);
  assert.equal(f.phone, '2105550136');
});

test('a date is not beds/baths', () => {
  const f = parsePostText('Closing 10/8/2026 in Dallas, TX asking $150k');
  assert.equal(f.beds, null);
  assert.equal(f.baths, null);
});

test('a bare dollar figure is the asking price', () => {
  assert.equal(parsePostText('Cash deal in Memphis, TN — $89,500 takes it').asking, 89_500);
});

test('chit-chat is not a deal post', () => {
  assert.equal(isDealPost('Good morning everyone, hope you all have a blessed week'), false);
});

test('an Apify group post becomes a candidate with the poster as contact', () => {
  const now = Date.parse('2026-10-08T15:00:00Z');
  const c = fromFacebookPost({ postId: '987', url: 'https://www.facebook.com/groups/txdeals/posts/987/', text: post, time: '2026-10-07T12:00:00Z', user: { name: 'Mike Flipper' }, groupTitle: 'Texas Wholesale Deals' }, now);
  assert.ok(c);
  assert.equal(c.sourceId, 'fb:987');
  assert.equal(c.contactName, 'Mike Flipper');
  assert.equal(c.group, 'Texas Wholesale Deals');
  assert.equal(c.line1, '4521 Maple Dr');
});

test('an old post is skipped', () => {
  const now = Date.parse('2026-10-08T15:00:00Z');
  assert.equal(fromFacebookPost({ postId: '1', text: post, time: '2026-09-20T12:00:00Z' }, now), null);
});

// ---- InvestorLift rows ----

test('an InvestorLift row maps price, ARV, specs, contact and photos', () => {
  const c = fromInvestorLift({
    property_url: 'https://investorlift.com/marketplace/deal/xyz-123', full_address: null, public_address: 'Harris County, Houston, TX 77016',
    city: 'Houston', state: 'tx', zip: '77016', county: 'Harris', bedrooms: 3, bathrooms: '2', sq_footage: 1320, year_built: 1965,
    property_type: 'Single Family', price: 135000, arv_estimate: 245000, phone_number: '7135550199', email: 'Dispo@Example.com',
    images: ['https://img.example.com/1.jpg', 'not a url'], description: 'Needs roof and HVAC', status: 'available',
  });
  assert.ok(c);
  assert.equal(c.sourceId, 'investorlift:xyz-123');
  assert.equal(c.line1, null);
  assert.equal(c.state, 'TX');
  assert.equal(c.asking, 135000);
  assert.equal(c.arv, 245000);
  assert.equal(c.baths, 2);
  assert.equal(c.email, 'dispo@example.com');
  assert.deepEqual(c.photos, ['https://img.example.com/1.jpg']);
});

test('an off-market InvestorLift row is dropped', () => {
  assert.equal(fromInvestorLift({ property_url: 'https://investorlift.com/marketplace/deal/z', available: false }), null);
});

// ---- gates ----

test('lenders, events and owner finance are blocked', () => {
  assert.equal(blockedCategory(null, 'We are a hard money lender, rates as low as 9%'), 'lender');
  assert.equal(blockedCategory(null, 'Join our REI club webinar this Thursday'), 'meeting or event');
  assert.equal(blockedCategory(null, 'Seller finance available, entry: $15,000'), 'owner finance');
  assert.equal(blockedCategory(null, 'No owner finance, cash only. ARV 200k'), null);
  assert.equal(blockedCategory('https://newwestern.com/x', 'nice house'), 'blacklisted company');
});

test('MLS listings and realtors are not deals', () => {
  assert.equal(fbPosterBlock('Just listed! MLS #123456, call your agent'), 'MLS or realtor listing');
  assert.equal(fbPosterBlock('Off market 3/2 ARV 200k asking 120k'), null);
});

test('condos, land, 5+ units and sub-to are not single-family', () => {
  assert.ok(notSfr('Condo', ''));
  assert.ok(notSfr(null, 'Vacant lot for sale, buildable lot'));
  assert.ok(notSfr(null, '8 units, great cap rate'));
  assert.ok(notSfr(null, 'Subject to deal, low entry'));
  assert.equal(notSfr('Single Family', '3 bed 2 bath brick ranch'), null);
});

// ---- buy box ----

test('a Houston 3/2 under the TX cap is in the buy box', () => {
  const m = matchesBuybox(base());
  assert.equal(m.ok, true);
  if (m.ok) { assert.equal(m.market, 'Houston'); assert.equal(m.maxPrice, 500_000); }
});

test('a suburb maps to its metro', () => {
  const m = matchesBuybox(base({ city: 'Katy' }));
  assert.equal(m.ok && m.market, 'Houston');
});

test('a city outside the markets is not in the buy box', () => {
  const m = matchesBuybox(base({ city: 'Amarillo' }));
  assert.equal(m.ok, false);
});

test('Greenville SC has its own $300k cap', () => {
  assert.equal(matchesBuybox(base({ city: 'Greenville', state: 'SC', asking: 320_000, beds: 3, baths: 2, yearBuilt: 2000 })).ok, false);
  assert.equal(matchesBuybox(base({ city: 'Greenville', state: 'SC', asking: 280_000, beds: 3, baths: 2, yearBuilt: 2000 })).ok, true);
});

test('a flood zone disqualifies', () => {
  assert.equal(matchesBuybox(base({ text: 'Cute house, in a flood zone' })).ok, false);
});

test('missing beds/baths pass (a person reviews it)', () => {
  assert.equal(matchesBuybox(base({ beds: null, baths: null, sqft: null, yearBuilt: null })).ok, true);
});

// ---- the judge ----

test('the MAO is worked from the deal: 240k × 70% − 30k − 20k', () => {
  assert.equal(judge(base(), S).mao, 118_000);
});

test('qualified needs asking ≤ MAO', () => {
  const v = judge(base({ asking: 100_000 }), S);
  assert.equal(v.status, 'qualified');
  assert.equal(v.clears, true);
  const over = judge(base({ asking: 150_000 }), S);
  assert.equal(over.status, 'buybox');
  assert.equal(over.clears, false);
});

test('no ARV is still in the buy box, MAO not workable', () => {
  const v = judge(base({ arv: null }), S);
  assert.equal(v.status, 'buybox');
  assert.equal(v.mao, null);
});

test('outside the buy box but a real house is valid', () => {
  assert.equal(judge(base({ city: 'Amarillo' }), S).status, 'valid');
});

test('strict markets drop a state that is not enabled', () => {
  assert.equal(judge(base({ state: 'CA', city: 'Fresno' }), S).status, 'rejected');
  assert.equal(judge(base({ state: 'CA', city: 'Fresno', asking: 200_000, arv: 400_000 }), { ...S, markets: { ...S.markets, mode: 'loose' } }).status, 'qualified');
});

test('enabled cities narrow strict markets, suburbs included', () => {
  const only = { ...S, markets: { ...S.markets, enabledCities: ['Houston'] } };
  assert.notEqual(judge(base({ city: 'Katy' }), only).status, 'rejected');
  assert.equal(judge(base({ city: 'Dallas' }), only).status, 'rejected');
});

test('ARV outside the range is rejected', () => {
  assert.equal(judge(base({ arv: 60_000, asking: 20_000 }), S).status, 'rejected');
  assert.equal(judge(base({ arv: 900_000 }), S).status, 'rejected');
});

test('no price and no ARV is rejected', () => {
  assert.equal(judge(base({ asking: null, arv: null }), S).status, 'rejected');
});

test('a Facebook realtor post is rejected even with good numbers', () => {
  assert.equal(judge(base({ source: 'facebook', text: 'Just listed on the MLS, 3/2 ARV 240k' }), S).status, 'rejected');
});

// ---- landing ----

test('land policy floors', () => {
  const q = judge(base({ asking: 100_000 }), S);
  const b = judge(base({ asking: 150_000 }), S);
  const v = judge(base({ city: 'Amarillo' }), S);
  const r = judge(base({ asking: null, arv: null }), S);
  assert.deepEqual([q, b, v, r].map((x) => shouldLand(x, 'qualified')), [true, false, false, false]);
  assert.deepEqual([q, b, v, r].map((x) => shouldLand(x, 'buybox')), [true, true, false, false]);
  assert.deepEqual([q, b, v, r].map((x) => shouldLand(x, 'valid')), [true, true, true, false]);
});

test('the envelope matches the extension contract and asks COMPR only when it can run', () => {
  const c = base({ asking: 100_000 });
  const env = toEnvelope(c, judge(c, S), { runCompr: true, maoPct: 70 }) as Record<string, Record<string, unknown> & unknown>;
  assert.equal(env.source, 'deal_machine');
  assert.equal(env.source_id, 'investorlift:abc');
  assert.equal((env.property as Record<string, unknown>).line1, '123 Oak St');
  const deal = env.deal as Record<string, unknown>;
  assert.equal(deal.lead_source, 'investorlift');
  assert.equal(deal.mao, 118_000);
  assert.equal(deal.market, 'Houston');
  assert.match(String(deal.notes), /clears/);
  assert.deepEqual(env.options, { run_compr: true });
  const noStreet = base({ line1: null });
  const hidden = toEnvelope(noStreet, judge(noStreet, S), { runCompr: true, maoPct: 70 }) as Record<string, Record<string, unknown>>;
  assert.equal(hidden.options, undefined);
  assert.equal(hidden.property.line1, 'Undisclosed (InvestorLift abc)');
  assert.equal(hidden.property.city, 'Houston');
  const nobody = base({ contactName: null, phone: null, email: null });
  assert.equal((toEnvelope(nobody, judge(nobody, S), { runCompr: false, maoPct: 70 }) as Record<string, unknown>).person, undefined);
});

console.log(`deal-machine-engine: ${passed} passed`);
