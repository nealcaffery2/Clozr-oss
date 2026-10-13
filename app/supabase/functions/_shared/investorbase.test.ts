// node --experimental-strip-types supabase/functions/_shared/investorbase.test.ts
import assert from 'node:assert/strict';
import { buyersFromSearch, phoneParts, searchBody, type IbPurchase } from './investorbase.ts';

const flip = (p: Partial<IbPurchase>): IbPurchase => ({
  buyer_first_name: 'John', buyer_last_name: 'Doe', buyer_entity_name: 'JD Properties LLC',
  buyer_phone_number: 8435550123, buyer_email: 'john@example.com', address: '123 Investor Way',
  miles_from_subject: 1.2, buyer_type: 'flipper',
  flip_purchase_transaction_date: '2022-12-01', flip_purchase_transaction_price: 150000,
  flip_sale_transaction_date: '2023-06-01', flip_sale_transaction_price: 250000,
  ...p,
});

assert.deepEqual(phoneParts(8435550123), { display: '(843) 555-0123', key: '8435550123' });
assert.equal(phoneParts('1-843-555-0123')?.key, '8435550123');
assert.equal(phoneParts(null), null);

const rows = buyersFromSearch([
  flip({}),
  flip({ address: '9 Oak', flip_purchase_transaction_price: 90000, miles_from_subject: 0.4 }),
  flip({
    buyer_first_name: 'Ann', buyer_last_name: 'Lee', buyer_entity_name: null, buyer_phone_number: 2105550199,
    buyer_email: 'ann@example.com', buyer_type: 'landlord', address: '5 Elm',
    rental_purchase_transaction_date: '2024-03-15', rental_purchase_transaction_price: 310000,
    flip_purchase_transaction_date: null, flip_purchase_transaction_price: null,
    flip_sale_transaction_date: null, flip_sale_transaction_price: null,
  }),
  flip({ buyer_first_name: null, buyer_last_name: null, buyer_entity_name: null, buyer_phone_number: null, buyer_email: null }),
], '133 Main St, Charleston, SC');

assert.equal(rows.length, 2, 'same phone folds, a nameless row drops');
const john = rows.find((r) => r.phoneKey === '8435550123')!;
assert.equal(john.name, 'John Doe');
assert.equal(john.company, 'JD Properties LLC');
assert.equal(john.entity_type, 'llc');
assert.equal(john.buyer_type, 'flipper');
assert.equal(john.status, 'Prospect');
assert.deepEqual(john.tags, ['investorbase', 'buyer-prospect']);
assert.ok(john.notes.includes('Found by InvestorBase near 133 Main St'));
assert.ok(john.notes.includes('123 Investor Way'));
assert.ok(john.notes.includes('9 Oak'));
assert.equal(john.criteria.price.min, Math.round(90000 * 0.7));
assert.equal(john.criteria.strategies[0], 'fix_and_flip');

const ann = rows.find((r) => r.name === 'Ann Lee')!;
assert.equal(ann.buyer_type, 'landlord');
assert.equal(ann.company, null);
assert.equal(ann.entity_type, 'individual');
assert.ok(ann.notes.includes('5 Elm'));

const body = searchBody({
  address: '133 Main St', radius_miles: 25, lookback_years: 0.5,
  buyer_types: ['flipper', 'landlord', 'builder'], property_types: ['SFR', 'nope'],
  min_purchase_price: 100000,
});
assert.equal(body.address, '133 Main St');
assert.equal(body.radius_miles, 10);
assert.equal(body.lookback_years, 0.5);
assert.equal(body.buyer_types, undefined);
assert.deepEqual(body.property_types, ['SFR']);
assert.equal(body.min_purchase_price, 100000);

const only = searchBody({ latitude: 32.7, longitude: -79.9, buyer_types: ['landlord'] });
assert.equal(only.address, undefined);
assert.deepEqual(only.buyer_types, ['landlord']);

console.log('investorbase: all assertions passed');
