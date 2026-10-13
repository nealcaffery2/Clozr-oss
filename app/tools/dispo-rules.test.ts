// Dispo campaign rules: levels, probability, facts, fallback intros, message
// splitting, scheduling and the buyer trigger-event helpers.
// Run with:  npx tsx tools/dispo-rules.test.ts
import assert from 'node:assert/strict';
import {
  activeAgainWithin, agoLabel, avoidedIn, bestReplyTime, buyerFacts, chooseIntro, dispoBuyerFields, distanceLabel, firstName, GENERIC_INTRO,
  GENERIC_INTRO_NO_NAME, intoWindow, inventedNumbers, levelOf, localHM, lowballStreak, noResponseLastN, notInterestedLastN, notSentInDays,
  citesAddress, geniusBuyerMatch, offerAsk, podioPurchases, probabilityToBuy, propertyTypeLabel, purchaseNote, purchasesFor, respondingNoStatusLastN, rotate, smartTime, splitIntro, strategyOf, stripEmoji,
  type BuyerStats, type SentDeal,
} from '../supabase/functions/_shared/dispo-rules';

const now = new Date('2026-09-13T15:00:00Z');
const stats = (p: Partial<BuyerStats> = {}): BuyerStats => ({ dealsSent: 0, dealsReplied: 0, dealsOffered: 0, closed: 0, purchases: 0, vip: false, vetted: false, score: null, ...p });

// ---- levels
assert.deepEqual(levelOf(stats()), { level: 1, label: 'New' });
assert.equal(levelOf(stats({ dealsSent: 4 })).level, 2);
assert.equal(levelOf(stats({ dealsSent: 4, dealsReplied: 1 })).level, 3);
assert.equal(levelOf(stats({ dealsSent: 4, dealsOffered: 1 })).level, 4);
assert.equal(levelOf(stats({ closed: 1 })).level, 5);
assert.equal(levelOf(stats({ dealsSent: 1, vip: true })).level, 3, 'VIP adds a level');
assert.equal(levelOf(stats({ closed: 2, vip: true })).level, 5, 'capped at 5');

// ---- probability
assert.equal(probabilityToBuy(stats({ dealsSent: 1, score: 90 })), null, 'too little history');
assert.equal(probabilityToBuy(stats({ dealsSent: 4, dealsReplied: 2, dealsOffered: 1, score: 80 })), Math.round((0.35 * 0.8 + 0.25 * 0.5 + 0.3 * 0.25) * 100));
assert.equal(probabilityToBuy(stats({ dealsSent: 2, dealsReplied: 2, dealsOffered: 2, closed: 3, score: 100 })), 95, 'capped');
assert.ok(probabilityToBuy(stats({ dealsOffered: 1 })) !== null, 'an offer alone is enough to say something');

// ---- facts
assert.equal(firstName('chris anderson'), 'Chris');
assert.equal(firstName('Harbor Capital LLC'), '', 'companies are not greeted by a first name');
assert.equal(propertyTypeLabel('single_family'), 'SFH');
assert.equal(propertyTypeLabel(null), '');
assert.equal(propertyTypeLabel('Single Family Mobile Home'), 'mobile home');
assert.equal(propertyTypeLabel('Multi-Family'), 'multifamily');
assert.equal(propertyTypeLabel('https://drive.google.com/x'), '', 'a link in the type column is not a type');
assert.equal(strategyOf(['fix_and_flip'], null), 'flip');
assert.equal(strategyOf(['buy_and_hold'], null), 'rental');
assert.equal(strategyOf(['fix_and_flip', 'buy_and_hold'], null), null, 'both is unknown');
assert.equal(agoLabel('2026-08-01T00:00:00Z', now), '6 weeks');
assert.equal(agoLabel('2025-09-01T00:00:00Z', now), '1 year');
assert.equal(agoLabel(null, now), null);
assert.equal(distanceLabel(0.84), '0.8 miles');
assert.equal(distanceLabel(1), '1 mile');
assert.equal(distanceLabel(null), '');
assert.deepEqual(podioPurchases('Imported\nPast purchase: 12 Elm St, Dallas TX\nother').map((p) => p.address), ['12 Elm St, Dallas TX']);

const deal = { address: '1 Main', city: 'Dallas', zip: '75211', lat: 32.75, lng: -96.9, sqft: 1500, beds: 3, baths: 2, propertyType: 'SFH' };
const f = buyerFacts({ name: 'Chris A', strategies: ['fix_and_flip'] }, [
  { address: 'Old Podio St', date: null, from: 'podio' },
  { address: '9 Oak', date: '2026-06-01', lat: 32.76, lng: -96.9, sqft: 1400, from: 'clozr_deal' },
  { address: '4 Pine', date: '2025-01-01', from: 'genius', distanceMi: 3 },
], deal, now);
assert.equal(f.lastPurchase?.address, '9 Oak', 'newest dated purchase wins over undated');
assert.equal(f.lastPurchase?.type, 'flip');
assert.ok(f.lastPurchase?.distanceMi && f.lastPurchase.distanceMi > 0.6 && f.lastPurchase.distanceMi < 0.8, 'distance from coordinates');
assert.equal(f.lastPurchase?.similarSize, true);
const noCoords = buyerFacts({ name: 'Pat' }, [{ address: 'X', date: '2026-01-01', from: 'genius' }], { ...deal, lat: null, lng: null }, now);
assert.equal(noCoords.lastPurchase?.distanceMi, null, 'no invented distance without coordinates');
assert.equal(dispoBuyerFields(noCoords).deal_distance, '');
assert.equal(buyerFacts({ name: 'Pat' }, [], deal, now).lastPurchase, null);

// ---- the purchase call-out every text can carry: only what is on file, never a hole
assert.equal(f.purchaseCount, 3, 'every purchase with an address counts, dated or not');
assert.equal(purchaseNote(f), "It's 0.7 miles from the flip you did at 9 Oak 3 months ago.");
const rental = buyerFacts({ name: 'Pat', strategies: ['buy_and_hold'] }, [{ address: '4 Pine', date: null, from: 'genius', distanceMi: 3 }], deal, now);
assert.equal(purchaseNote(rental), "It's 3 miles from your rental at 4 Pine.", 'no date: no "ago"');
const undated = buyerFacts({ name: 'Pat' }, [{ address: '4 Pine', date: null, from: 'genius', distanceMi: 3 }], deal, now);
assert.equal(purchaseNote(undated), "It's 3 miles from your purchase at 4 Pine.");
const area = buyerFacts({ name: 'Pat' }, [{ address: '7 Elm', city: 'Dallas', date: '2026-08-01', from: 'clozr_deal' }], deal, now);
assert.equal(purchaseNote(area), "It's in the same area as 7 Elm, which you picked up 6 weeks ago.", 'same city, no coordinates: no invented distance');
const podio = buyerFacts({ name: 'Pat' }, [{ address: 'Old Podio St', date: null, from: 'podio' }], deal, now);
assert.equal(purchaseNote(podio), 'I saw you picked up Old Podio St.', 'nothing relates it to the deal: the purchase alone');
assert.equal(purchaseNote(buyerFacts({ name: 'Pat' }, [], deal, now)), '', 'no purchase, no sentence');
assert.equal(
  offerAsk(f, '1 Main'),
  'I saw you bought 9 Oak about 3 months ago, 0.7 miles from our property on 1 Main. Looks like it fits your criteria. Want to make an offer?',
);
assert.equal(offerAsk(buyerFacts({ name: 'Pat' }, [], deal, now), '1 Main'), '', 'no purchase, no offer ask');
assert.equal(citesAddress('I saw you bought 322 Main St', '322 Main St'), true);
assert.equal(citesAddress("I've got a deal in Dallas", '322 Main St'), false);
assert.equal(geniusBuyerMatch(
  { id: 4, name: 'Chris Anderson', company: 'Quick Flip LLC', source: 'genius' },
  { owner_name: 'Quick Flip LLC', people: ['Chris Anderson'] },
), true, 'the LLC on the run is the company on the buyer');
assert.equal(geniusBuyerMatch(
  { id: 4, name: 'Chris Anderson', company: null, source: 'Manual' },
  { owner_name: 'Chris Anderson' },
), false, 'a name match is not enough unless Genius or Buyr filed them, or the run links the buyer');
const fromGenius = purchasesFor(
  { id: 4, name: 'Chris Anderson', company: 'Quick Flip LLC', notes: null, source: 'genius' },
  [],
  [{ deal_id: null, candidates: [{ owner_name: 'Quick Flip LLC', people: ['Chris Anderson'], kind: 'flipper', purchases: [{ address: '322 Main St', date: '2026-06-01', lat: 32.76, lng: -96.9, distance_mi: 9 }] }] }],
  99,
);
assert.equal(fromGenius[0]?.address, '322 Main St');
assert.equal(fromGenius[0]?.distanceMi, null, 'a distance measured against a different subject is not this deal');
const near = buyerFacts({ name: 'Chris Anderson' }, fromGenius, deal, now);
assert.ok(near.lastPurchase && near.lastPurchase.distanceMi != null && near.lastPurchase.distanceMi < 1, 'coordinates still measure the distance to this deal');
assert.match(offerAsk(near, '1 Main'), /322 Main St/);
assert.match(offerAsk(near, '1 Main'), /1 Main/);
const bf = dispoBuyerFields(f);
assert.equal(bf.purchase_note, purchaseNote(f));
assert.equal(bf.purchase_count, '3');
assert.equal(dispoBuyerFields(buyerFacts({ name: 'Pat' }, [], deal, now)).purchase_count, '');
assert.ok(GENERIC_INTRO.includes('{{purchase_note}}') && GENERIC_INTRO_NO_NAME.includes('{{purchase_note}}'), 'the generic intro still calls out a purchase when one is on file');

// ---- fallback template choice
const T1 = "Hey {{first_name}} - It's {{rep_first_name}}. I noticed you wrapped up a flip on {{last_purchase_address}} about {{last_purchase_ago}} ago.";
const full = { first_name: 'Chris', rep_first_name: 'Morgan', last_purchase_address: '9 Oak', last_purchase_ago: '3 months' };
assert.deepEqual(chooseIntro(T1, full), { body: T1, fallback: false, missing: [] });
const partial = chooseIntro(T1, { ...full, last_purchase_ago: '' });
assert.equal(partial.fallback, true);
assert.equal(partial.body, GENERIC_INTRO);
assert.deepEqual(partial.missing, ['last_purchase_ago']);
assert.equal(chooseIntro(T1, { ...full, first_name: '', last_purchase_ago: '' }).body, GENERIC_INTRO_NO_NAME);
assert.equal(chooseIntro('Hi {{first_name}}, new deal at {{address}}', { first_name: 'A', address: '' }).fallback, false, 'non-personal blanks do not force a fallback');

// ---- splitting
const two = 'Hey Chris - it is Morgan. I have a flip nearby. Want details?';
assert.deepEqual(splitIntro(two, 'never', 1), [two]);
const parts = splitIntro(two, 'frequently', 1);
assert.equal(parts.length, 2);
assert.equal(parts.join(' '), two);
assert.deepEqual(splitIntro('One sentence only', 'frequently', 1), ['One sentence only']);
const some = Array.from({ length: 40 }, (_, i) => splitIntro(two, 'sometimes', i).length);
assert.ok(some.includes(1) && some.includes(2), 'sometimes splits some, not all');
assert.deepEqual(splitIntro(two, 'sometimes', 7), splitIntro(two, 'sometimes', 7), 'stable per buyer');

// ---- guards
assert.equal(stripEmoji('Deal 🔥 nearby 👍'), 'Deal nearby');
assert.deepEqual(avoidedIn('This is a steal of a deal', ['steal', 'cheap']), ['steal']);
assert.deepEqual(avoidedIn('stealth', ['steal']), [], 'whole words only');
assert.deepEqual(inventedNumbers('Just 0.8 miles, 3 bed', 'distance 0.8 miles; beds 3'), []);
assert.deepEqual(inventedNumbers('ARV $250,000', 'beds 3'), ['250000']);
assert.equal(rotate(['a', 'b', 'c'], 4), 'b');
assert.equal(rotate([], 1), undefined);

// ---- scheduling
const tz = 'America/Chicago';
const late = new Date('2026-09-14T03:30:00Z'); // 22:30 in Chicago
const opens = intoWindow(late, tz);
assert.equal(localHM(opens, tz).hour, 9);
assert.equal(localHM(opens, tz).minute, 0);
const inside = new Date('2026-09-13T17:00:00Z'); // noon Chicago
assert.equal(intoWindow(inside, tz).getTime(), inside.getTime());
assert.equal(bestReplyTime(['2026-09-01T19:10:00Z', '2026-09-02T19:40:00Z'], tz), null, 'under three replies');
const best = bestReplyTime(['2026-09-01T19:10:00Z', '2026-09-02T19:40:00Z', '2026-09-03T19:05:00Z', '2026-09-03T14:00:00Z'], tz);
assert.deepEqual(best, { hour: 14, weekday: null });
const smart = smartTime(inside, best, tz);
assert.equal(localHM(smart, tz).hour, 14);
assert.equal(smartTime(inside, null, tz).getTime(), inside.getTime());

// ---- trigger events
const sent = (p: Partial<SentDeal>[]): SentDeal[] => p.map((x, i) => ({ dealId: i + 1, sentAt: `2026-09-0${i + 1}T00:00:00Z`, repliedAt: null, status: 'sent', ...x }));
assert.equal(noResponseLastN(sent([{}, {}, {}]), 3), true);
assert.equal(noResponseLastN(sent([{}, {}]), 3), false, 'needs N deals sent');
assert.equal(noResponseLastN(sent([{ repliedAt: '2026-09-01T01:00:00Z' }, {}, {}, {}]), 3), true, 'only the last N count');
assert.equal(notInterestedLastN(sent([{ status: 'not_interested' }, { status: 'not_interested' }]), 2), true);
assert.equal(respondingNoStatusLastN(sent([{ repliedAt: 'x' }, { repliedAt: 'x' }]), 2, new Set()), true);
assert.equal(respondingNoStatusLastN(sent([{ repliedAt: 'x' }, { repliedAt: 'x' }]), 2, new Set([2])), false, 'an offer is a status');
assert.equal(notSentInDays(sent([{}]), 5, now), true);
assert.equal(notSentInDays([], 30, now), true, 'never sent counts');
assert.equal(notSentInDays([{ dealId: 1, sentAt: '2026-09-10T00:00:00Z', repliedAt: null, status: 'sent' }], 30, now), false);
assert.equal(activeAgainWithin('2026-09-15T00:00:00Z', 3, now), true);
assert.equal(activeAgainWithin('2026-10-15T00:00:00Z', 3, now), false);
assert.equal(lowballStreak([{ amount: 70, asking: 100, at: '2026-09-01' }, { amount: 80, asking: 100, at: '2026-09-02' }, { amount: 79, asking: 100, at: '2026-09-03' }], 3, 80), true);
assert.equal(lowballStreak([{ amount: 90, asking: 100, at: '2026-09-03' }, { amount: 70, asking: 100, at: '2026-09-02' }, { amount: 70, asking: 100, at: '2026-09-01' }], 3, 80), false, 'most recent offer broke the streak');

console.log('dispo-rules: all assertions passed');
