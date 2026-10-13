// Buy-box answers from a flat buyer.create. Run: npx tsx tools/buybox-flat.test.ts
import { buyBoxFromFlat, fillOnly } from '../supabase/functions/_shared/flat';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const box = buyBoxFromFlat({
  event: 'buyer.create', name: 'Ann', property_types: 'Single Family Residential, Condo', strategy_types: ["Fix n' Flip"],
  min_purchase_price: '$50,000', max_purchase_price: '250k', beds_min: '3', baths_min: '2', sqft_min: '', year_built_min: '1980',
  preferred_channel: 'SMS',
});
eq('lists split', box.property_types, ['Single Family Residential', 'Condo']);
eq('array stays an array', box.strategy_types, ["Fix n' Flip"]);
eq('money parses', [box.min_purchase_price, box.max_purchase_price], [50000, 250000]);
eq('numbers parse', [box.beds_min, box.baths_min, box.year_built_min], [3, 2, 1980]);
eq('blank answers are left out', 'sqft_min' in box, false);
eq('channel lowercased', box.preferred_channel, 'sms');
eq('unknown channel dropped', buyBoxFromFlat({ preferred_channel: 'fax' }).preferred_channel, undefined);
eq('nothing asked, nothing filled', buyBoxFromFlat({ name: 'x' }), {});
eq('fill only empty columns', fillOnly({ beds_min: 2, property_types: [], max_purchase_price: null }, { beds_min: 3, property_types: ['Land'], max_purchase_price: 9 }), { property_types: ['Land'], max_purchase_price: 9 });
if (failed) process.exit(1);
