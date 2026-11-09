// Run: npx tsx tools/double-close.test.ts
import assert from 'node:assert/strict';
import { type DoubleClose, doubleCloseRows, monthWindows } from '../supabase/functions/_shared/double-close.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; void name; };

const row = (patch: Partial<DoubleClose> = {}): DoubleClose => ({
  source: 'mecklenburg_sales', state: 'NC', county_code: '119', apn: '12345678', situs_addr: '123 OAK ST', situs_city: 'CHARLOTTE', situs_zip: '28205',
  wholesaler: 'INVESTCAR LLC', bought_on: '2026-03-02', bought_for: 180000, end_buyer: 'BLUE DOOR HOMES LLC', sold_on: '2026-03-02', sold_for: 205000,
  gap_days: 0, fee: 25000, ...patch,
});

test('a double close makes a wholesaler, a buyer and one deed leg with the fee', () => {
  const { entities, deals } = doubleCloseRows(11, [row()]);
  assert.deepEqual(entities.map((e) => [e.name, e.kind]), [['INVESTCAR LLC', 'wholesaler'], ['BLUE DOOR HOMES LLC', 'buyer']]);
  assert.equal(deals.length, 1);
  assert.equal(deals[0].assignment_fee, 25000);
  assert.equal(deals[0].purchase_price, 180000);
  assert.equal(deals[0].total_price, 205000);
  assert.equal(deals[0].source_id, 'compr:mecklenburg_sales:12345678:2026-03-02:2026-03-02');
});

test('a roll with no price keeps the deal and leaves the fee empty', () => {
  const { deals } = doubleCloseRows(11, [row({ bought_for: null, sold_for: 240000, fee: null })]);
  assert.equal(deals[0].assignment_fee, null);
  assert.equal(deals[0].total_price, 240000);
});

test('two owners on the end deed name the first one', () => {
  const { entities } = doubleCloseRows(11, [row({ end_buyer: 'SMITH, JOHN;SMITH, JANE' })]);
  assert.equal(entities[1].name, 'SMITH, JOHN');
});

test('the same company on both sides is not a double close', () => {
  const { deals } = doubleCloseRows(11, [row({ end_buyer: 'Investcar, LLC' })]);
  assert.equal(deals.length, 0);
});

test('a re-read of the same pair of sales is one deal', () => {
  assert.equal(doubleCloseRows(11, [row(), row()]).deals.length, 1);
});

test('month windows walk back from today to the start, newest first', () => {
  assert.deepEqual(monthWindows('2026-08-15', '2026-10-30'), [
    { from: '2026-09-30', to: '2026-10-30' },
    { from: '2026-08-30', to: '2026-09-30' },
    { from: '2026-08-15', to: '2026-08-30' },
  ]);
});

console.log(`double-close: ${passed} passed`);
