// Native e-sign field mapping. Run: npx tsx tools/esign-map.test.ts
import assert from 'node:assert/strict';
import { buildTokens, fill, mappedFromRecord, partySigner } from '../supabase/functions/_shared/esign-map';

const company = { name: 'Acme Homes', legal: 'Acme Homes LLC', address: '1 Main', signer: 'Casey', email: 'tc@acmehomes.com', phone: '555', escrow: 'Acme Homes Escrow' };
const tokens = buildTokens({
  seller: { name: 'Kara Mitchell', email: 'kara@example.com', phone: '214-555-0101', property_address: '8813 Magnolia Falls' },
  seller2: { name: 'Jon Mitchell', email: 'jon@example.com', phone: '214-555-0102' },
  buyer: { name: 'Luis Ortega', company: 'Northvale Homes', email: 'luis@northvale.com', phone: '972-555-0199' },
  prop: { line1: '8813 Magnolia Falls', city: 'Fort Worth', state: 'TX', zip: '76120' },
  deal: { offer_amount: 240000, earnest_money: 1000, assignment_fee: 15000, close_date: '2026-10-15' },
}, company);

const by = new Map(tokens.map((t) => [t.name, t.value]));
assert.equal(by.get('Seller.Name'), 'Kara Mitchell');
assert.equal(by.get('Seller2.Name'), 'Jon Mitchell');
assert.equal(by.get('Seller2.Email'), 'jon@example.com');
assert.equal(by.get('Buyer.Company'), 'Northvale Homes');
assert.equal(by.get('Buyer.Phone'), '972-555-0199');
assert.equal(by.get('Property.FullAddress'), '8813 Magnolia Falls, Fort Worth, TX 76120');
assert.equal(by.get('Deal.PurchasePrice'), '$240,000');
assert.equal(by.get('Deal.AssignmentPrice'), '$255,000');
assert.equal(by.get('Company.Signer'), 'Casey');

const body = 'Seller [Seller.Name] and [Seller2.Name] sell [Property.FullAddress] to [Buyer.Company] for [Deal.PurchasePrice]. EMD in [Deal.EMDDays] days.';
const filled = fill(body, tokens);
assert.equal(filled.text.includes('Kara Mitchell'), true);
assert.equal(filled.text.includes('[Seller.Name]'), false);
assert.deepEqual(filled.missing, ['Deal.EMDDays']);
assert.equal(filled.text.includes('______________'), true);

const used = ['Seller.Name', 'Seller2.Name', 'Property.FullAddress', 'Buyer.Company', 'Deal.PurchasePrice', 'Deal.EMDDays'];
assert.deepEqual(mappedFromRecord(tokens, used).map((t) => t.name), ['Seller.Name', 'Seller2.Name', 'Property.FullAddress', 'Buyer.Company', 'Deal.PurchasePrice']);

const s2 = partySigner({ role: 'seller2', label: 'Seller 2', party: 'seller2', optional: true }, { seller2: { name: 'Jon Mitchell', email: 'jon@example.com', phone: '214-555-0102' }, company });
assert.equal(s2.name, 'Jon Mitchell');
assert.equal(s2.email, 'jon@example.com');
const absent = partySigner({ role: 'seller2', label: 'Seller 2', party: 'seller2', optional: true }, { company });
assert.equal(absent.name, null);

console.log('esign-map.test.ts ok');
