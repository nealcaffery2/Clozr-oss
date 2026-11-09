// lib/contract-name.ts: street parsing, default names, amendment names.
// Run with:  npx tsx tools/contract-name.test.ts
import {
  amendmentChanges, amendmentName, cleanPhrase, cleanTemplateName, defaultContractName, otherModifications, streetOf, tokenFields, uniqueName,
} from '../lib/contract-name';

let failed = 0;
let passed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

// streets
eq('street: city cut', streetOf('2016 Meadow lane, Richmond, TX 77469'), '2016 Meadow Lane');
eq('street: no commas', streetOf('5056 Larch Ave East Point Ga 30344'), '5056 Larch Ave');
eq('street: direction kept', streetOf('7441 Wren Ln SW Atlanta GA'), '7441 Wren Ln SW');
eq('street: casing left alone', streetOf('6737 Prairie Avenue Northeast'), '6737 Prairie Avenue Northeast');
eq('street: empty', streetOf('  '), null);

// defaults
eq('template copy counter', cleanTemplateName('Acme Homes Amendment (1)'), 'Acme Homes Amendment');
eq('default: psa', defaultContractName({ kind: 'psa', templateName: 'Acme Homes PSA 2026', address: '2384 Fern Hollow Road, Longs, South Carolina' }), '2384 Fern Hollow Road purchase agreement');
eq('default: assignment', defaultContractName({ kind: 'assignment', templateName: '2026 Acme Homes Assignment', address: '327 S Hillcrest Dr' }), '327 S Hillcrest Dr assignment');
eq('default: disclosure keeps template', defaultContractName({ kind: 'disclosure', templateName: 'Seller Information Form (5)', address: '2384 Fern Hollow Road' }), '2384 Fern Hollow Road Seller Information Form');
eq('default: no address', defaultContractName({ kind: 'termination', templateName: 'Acme Homes Termination Agreement (1)', party: 'Morgan Lane' }), 'Acme Homes Termination Agreement - Morgan Lane');

// amendments, from real signed ones (contract_fields)
const f272 = [
  { type: 'text', label: 'Property address', key: 'property.address', value: '2016 Meadow lane, Richmond, TX 77469' },
  { type: 'date', label: 'Closing date', value: '2026-11-30' },
  { type: 'date', label: 'Date signed', key: 'doc.date', value: '2026-10-30' },
  { type: 'signature', value: 'data:image/png;base64,xx' },
];
eq('272: closing date only', amendmentName('2016 Meadow Lane', amendmentChanges(f272)), '2016 Meadow Lane closing date change to 11/30');
eq('272: no free text', otherModifications(f272), null);

const f264 = [
  { type: 'currency', label: 'Cash portion of sales price', value: '135000' },
  { type: 'text', label: 'Expense, shall complete the following repairs', value: 'N/A' },
  { type: 'date', label: 'Closing date', value: '2026-10-28' },
  { type: 'text', label: 'Waived (yes / no)', value: 'N/A' },
  { type: 'text', label: 'Other Modifications:', value: 'Lender is to pay Acme holdings $750.00' },
];
eq('264: N/A fields skipped', amendmentChanges(f264).map((c) => c.short), ['price', 'closing date']);
eq('264: two changes read short', amendmentName('5056 Larch Ave', amendmentChanges(f264)), '5056 Larch Ave price and closing date change');
eq('264: with the free-text phrase', amendmentName('5056 Larch Ave', amendmentChanges(f264), 'lender credit $750'), '5056 Larch Ave price, closing date and lender credit $750');
eq('264: free text found', otherModifications(f264), 'Lender is to pay Acme holdings $750.00');

const f262 = [{ type: 'text', label: 'Other Modifications:', value: 'Optioon date to extend 2BD until end of day on 10/27/2026' }];
eq('262: only free text', amendmentName('3430 Peachwood Trace', amendmentChanges(f262), 'option extension to 10/27'), '3430 Peachwood Trace option extension to 10/27');
eq('262: no phrase falls back to the kind', amendmentName('3430 Peachwood Trace', amendmentChanges(f262), null), '3430 Peachwood Trace amendment');
eq('unlabeled overflow text joins the free text', otherModifications([{ type: 'text', label: 'Other Modifications:', value: 'The Option Period is extended' }, { type: 'text', value: 'five days' }]), 'The Option Period is extended five days');

// markdown template tokens
const toks = tokenFields([{ name: 'Amend.SalesPrice', value: '150000' }, { name: 'Amend.OptionWaiver', value: 'Yes' }, { name: 'Seller.Name', value: 'x' }]);
eq('tokens: price and waiver', amendmentChanges(toks).map((c) => c.long), ['price change to $150,000', 'option waived']);
eq('tokens: option end', amendmentChanges(tokenFields([{ name: 'Amend.OptionEnd', value: '10/27/2026' }]))[0].long, 'option extended to 10/27');

// duplicates
eq('unique: free name kept', uniqueName('486 Scott Rd price change', ['486 Scott Rd purchase agreement'], '2026-10-13'), '486 Scott Rd price change');
eq('unique: second one dated', uniqueName('486 Scott Rd amendment', ['486 Scott Rd Amendment'], '2026-10-13'), '486 Scott Rd amendment signed 10/13');

// model phrases
eq('phrase: cleaned', cleanPhrase('Lender credit $750.'), 'lender credit $750');
eq('phrase: too long dropped', cleanPhrase('this amendment extends the option period by two business days and also'), null);
eq('phrase: acronym kept', cleanPhrase('HOA fee split'), 'HOA fee split');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
