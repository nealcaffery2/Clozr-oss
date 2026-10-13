import assert from 'node:assert/strict';
import { commLineName, commRep, lineBook, suggestLineOwner } from '../lib/comm-rep';

const lines = lineBook([
  { phone10: '2105550175', user_id: 'alex', label: 'Alex Main' },
  { phone10: '8325550177', user_id: null, label: 'Texas' },
  { phone10: '2105550176', user_id: 'taylor-gone', label: 'Taylor Main' },
]);
const sellerRep = (id: number | null) => (id === 7 ? 'quinn' : null);
const team = new Set(['alex', 'quinn', 'david']);
const isMember = (id: string | null | undefined) => !!id && team.has(id);

// The rep on the row wins, even on someone else's line or seller.
assert.equal(commRep({ rep_id: 'david', seller_id: 7, direction: 'outbound', from_phone: '+12105550175' }, lines, sellerRep, isMember), 'david');
// A dispo call to a buyer (no seller) from Alex's line is Alex's.
assert.equal(commRep({ rep_id: null, seller_id: null, direction: 'outbound', from_phone: '+1 (210) 555-0175' }, lines, sellerRep, isMember), 'alex');
// Inbound: the line it reached.
assert.equal(commRep({ rep_id: null, seller_id: null, direction: 'inbound', from_phone: '+15550001111', to_phone: '+12105550175' }, lines, sellerRep, isMember), 'alex');
// A line nobody owns falls back to the seller's rep.
assert.equal(commRep({ rep_id: null, seller_id: 7, direction: 'outbound', from_phone: '+18325550177' }, lines, sellerRep, isMember), 'quinn');
// A former teammate's line is not credited to them.
assert.equal(commRep({ rep_id: null, seller_id: null, direction: 'outbound', from_phone: '+12105550176' }, lines, sellerRep, isMember), null);
// Nothing at all: null, reported under the line's name.
const texas = { rep_id: null, seller_id: null, direction: 'outbound', from_phone: '+18325550177' };
assert.equal(commRep(texas, lines, sellerRep, isMember), null);
assert.equal(commLineName(texas, lines), 'Texas line');
assert.equal(commLineName({ rep_id: null, seller_id: null, direction: 'outbound', from_phone: '+19999999999' }, lines), null);

// A line named for exactly one teammate suggests them; two Chrises suggest nobody.
const people = [{ user_id: 's', full_name: 'diego' }, { user_id: 'c1', full_name: 'Chris Collins' }, { user_id: 'c2', full_name: 'Chris Alvarez' }];
assert.equal(suggestLineOwner('Diego Main', people)?.user_id, 's');
assert.equal(suggestLineOwner('Chris', people), null);
assert.equal(suggestLineOwner('Texas', people), null);
assert.equal(suggestLineOwner('', people), null);

console.log('comm-rep.test.ts ok');
