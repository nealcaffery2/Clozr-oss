// Offer band math. Run: npx tsx tools/offer-band.test.ts
import assert from 'node:assert/strict';
import { OFFER_BAND_GAP, bandOfRow, editOfferBand, offerBand, offerBandColumns } from '../lib/offer-band';

assert.equal(OFFER_BAND_GAP, 20_000);

const pick = (b: ReturnType<typeof offerBand>) => ({ low: b.low, high: b.high });

assert.deepEqual(pick(offerBand({ mao: 172_000 })), { low: 152_000, high: 172_000 }, 'high = COMPR offer, low = offer − $20k');

assert.deepEqual(
  pick(offerBand({ mao: 119_876, low: 129_413, high: 119_876 })),
  { low: 99_876, high: 119_876 },
  'a band COMPR wrote low-above-high follows the MAO',
);

assert.deepEqual(
  pick(offerBand({ mao: 150_000, low: 130_000, high: 190_000 })),
  { low: 130_000, high: 150_000 },
  'nobody set them: the MAO the sliders moved is the high, low follows it',
);

// 403 Laurel St: Alex typed $60k / $80k under a $69,469 MAO.
const alex = offerBand({ mao: 69_469, low: 60_000, high: 80_000, lowSet: true, highSet: true });
assert.deepEqual(pick(alex), { low: 60_000, high: 80_000 }, 'a typed low and high are kept over the MAO');
assert.deepEqual(
  pick(offerBand({ mao: 75_000, low: 60_000, high: 80_000, lowSet: true, highSet: true })),
  { low: 60_000, high: 80_000 },
  'a COMPR edit that moves the MAO leaves a hand-set band alone',
);

assert.deepEqual(
  pick(offerBand({ mao: 69_469, low: 49_469, high: 85_000, highSet: true })),
  { low: 65_000, high: 85_000 },
  'a hand-set high pulls an untouched low with it',
);
assert.deepEqual(
  pick(offerBand({ mao: 69_469, low: 52_000, high: 69_469, lowSet: true })),
  { low: 52_000, high: 69_469 },
  'a hand-set low stays while the high tracks the MAO',
);
assert.deepEqual(pick(offerBand({ mao: 90_000, low: 52_000, high: 69_469, lowSet: true })), { low: 52_000, high: 90_000 });

// Editing.
const auto = { mao: 100_000, low: 80_000, high: 100_000 };
assert.deepEqual(pick(editOfferBand(auto, 'high', 110_000)), { low: 90_000, high: 110_000 }, 'typing the high');
assert.ok(editOfferBand(auto, 'high', 110_000).highSet && !editOfferBand(auto, 'high', 110_000).lowSet);
assert.deepEqual(pick(editOfferBand(auto, 'low', 70_000)), { low: 70_000, high: 100_000 }, 'typing the low');
const handHigh = { ...auto, high: 110_000, low: 90_000, highSet: true };
assert.deepEqual(pick(editOfferBand(handHigh, 'high', null)), { low: 80_000, high: 100_000 }, 'clearing a field hands it back to COMPR');
assert.equal(editOfferBand(handHigh, 'high', null).highSet, false);

// No MAO yet: what is stored stands.
assert.deepEqual(pick(offerBand({ low: 140_000, high: 155_000, lowSet: true, highSet: true })), { low: 140_000, high: 155_000 });
assert.deepEqual(pick(offerBand({ low: 155_000, high: 140_000 })), { low: 140_000, high: 155_000 }, 'a swapped pair is put right');
assert.deepEqual(pick(offerBand({ high: 150_000 })), { low: 130_000, high: 150_000 });
assert.deepEqual(pick(offerBand({})), { low: null, high: null });
assert.deepEqual(pick(offerBand({ mao: 0, low: -11_666, high: 39_618 })), { low: 0, high: 0 }, 'a zero MAO is an offer of nothing, not a negative low');

assert.deepEqual(offerBandColumns(offerBand({ mao: 172_000 })), { wholesale_offer: 152_000, institutional_offer: 172_000 });
assert.deepEqual(offerBandColumns(offerBand({})), {}, 'nothing to write is no write');

assert.deepEqual(
  bandOfRow({ mao: '69469', wholesale_offer: '60000', institutional_offer: '80000', offer_low_set_at: '2026-10-08T15:09:00Z', offer_high_set_at: null }),
  { mao: 69_469, low: 60_000, high: 80_000, lowSet: true, highSet: false },
);

console.log('offer-band ok');
