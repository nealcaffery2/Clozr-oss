// Clozr Docs variables.  Run:  npx tsx tools/doc-vars.test.ts
import assert from 'node:assert/strict';
import { docVars, moneyWords, renderVars, varsIn } from '../supabase/functions/_shared/doc-vars';

const vars = docVars({
  deal: { offer_amount: 85000, assignment_fee: 12500, close_date: '2026-10-21', contract_date: '2026-09-29', title_contact: 'Jane Doe', title_email: 'jane@title.example' },
  seller: { name: 'Sam Seller', email: 'sam@example.com' },
  prop: { line1: '912 Cordial Rd', city: 'Eden', state: 'NC', zip: '27288', county: 'Rockingham' },
  buyer: { name: 'Bo Buyer', company: 'Acme Holdings LLC' },
  title: { business_name: 'Carolina Title' },
}, { legal: 'Acme Homes LLC', signer: 'Sam' }, { date: '2026-09-30', ref: 'AC-1042' });

// The 912 Cordial Rd values the TC used to type by hand.
assert.equal(renderVars('{{property.address}}', vars).text, '912 Cordial Rd, Eden, NC 27288');
assert.equal(renderVars('{{deal.purchase_price}}', vars).text, '$85,000');
assert.equal(renderVars('{{deal.assignment_total|currency}}', vars).text, '$97,500');
assert.equal(renderVars('{{deal.purchase_price|words}}', vars).text, 'Eighty-five thousand dollars');
assert.equal(renderVars('{{deal.close_date}}', vars).text, '10/21/2026');
assert.equal(renderVars('{{deal.close_date|date:long}}', vars).text, 'October 21, 2026');
assert.equal(renderVars('{{title.company}}', vars).text, 'Carolina Title');
assert.equal(renderVars('{{buyer.entity|upper}}', vars).text, 'ACME HOLDINGS LLC');
assert.equal(renderVars('{{property.state_name}}', vars).text, 'North Carolina');
assert.equal(renderVars('{{company.entity}} · {{doc.ref}}', vars).text, 'Acme Homes LLC · AC-1042');

// Missing values: a visible blank and a report, unless |default says otherwise.
const miss = renderVars('EMD {{deal.buyer_emd}} / {{seller2.name|default:"N/A"}}', vars);
assert.equal(miss.text, 'EMD ______________ / N/A');
assert.deepEqual(miss.missing, ['deal.buyer_emd']);

// A document's own value overrides the record.
assert.equal(renderVars('{{deal.buyer_emd|currency}}', vars, { 'deal.buyer_emd': '5000' }).text, '$5,000');

// State riders.
const rider = '{{#if property.state == "TX"}}Texas rider{{else}}No rider{{/if}}';
assert.equal(renderVars(rider, vars).text, 'No rider');
assert.equal(renderVars(rider, docVars({ prop: { state: 'TX' } }, {})).text, 'Texas rider');
assert.equal(renderVars('{{#if seller2.name}}Seller 2: {{seller2.name}}{{/if}}', vars).text, '');
assert.equal(renderVars('{{#if property.state != "TX"}}A{{#if seller.name}}B{{/if}}{{/if}}', vars).text, 'AB');

// Signature blocks and old tokens are left for the other passes.
assert.equal(renderVars('{{sign:seller}} [Deal.EMD]', vars).text, '{{sign:seller}} [Deal.EMD]');
assert.deepEqual(varsIn('{{deal.purchase_price|currency}} {{sign:buyer}} {{seller.name}} {{deal.purchase_price}}'), ['deal.purchase_price', 'seller.name']);

assert.equal(moneyWords(1), 'One dollar');
assert.equal(moneyWords(1250.5), 'One thousand two hundred fifty dollars and 50/100');

console.log('doc-vars ok');
