// Which deals stay on the Dispo lists, and which realtors a push can reach.
// Run with:  npx tsx tools/dispo-board.test.ts
import assert from 'node:assert/strict';
import { offDispo, onDispoBoard } from '../lib/stages';
import { isRealtor, realtorInMarket } from '../lib/dispo-campaign';

assert.equal(onDispoBoard('Ready To Market'), true);
assert.equal(onDispoBoard('Under Contract Seller', 'Under Contract - Seller', null, 'Executed'), true);
assert.equal(onDispoBoard('Closed'), false, 'a closed deal drops off');
assert.equal(onDispoBoard('Terminated'), false, 'a terminated deal drops off');
assert.equal(onDispoBoard('Under Contract Seller', 'Memo Filed / Legal'), false, 'a deal in legal drops off even at an active deal stage');
assert.equal(onDispoBoard('In Escrow', 'Under Contract - Buyer', null, 'Terminated'), false, 'a terminated contract status drops it');
assert.equal(onDispoBoard('Ready To Market', 'Terminated - Price Drop'), false);
assert.equal(offDispo('Under Contract - Seller'), false);
assert.equal(offDispo('Contract Sent to Seller'), false);

assert.equal(isRealtor({ tags: ['Realtors'], buyerType: null }), true);
assert.equal(isRealtor({ tags: [], buyerType: 'realtor' }), true);
assert.equal(isRealtor({ tags: ['flipper'], buyerType: 'investor' }), false);
const deal = { city: 'Dallas', zip: '75211' };
assert.equal(realtorInMarket({ markets: ['Dallas, TX'], cities: [], zips: [] }, deal), true);
assert.equal(realtorInMarket({ markets: [], cities: [], zips: ['75211'] }, deal), true);
assert.equal(realtorInMarket({ markets: ['Houston'], cities: [], zips: [] }, deal), false);
console.log('dispo-board: all passed');
