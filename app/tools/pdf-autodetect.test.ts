// Auto-mapping uploaded contracts. Run: npx tsx tools/pdf-autodetect.test.ts
//
// Layouts are synthetic but copy the shapes of real Acme Homes paper: a PSA
// with underscore blanks and a drawn signature rule, an amendment whose
// blanks are drawn boxes, a TREC-style footer of initials, side-by-side and
// stacked signature blocks, and a leaseback's "Seller (Tenant):" lines.
import assert from 'node:assert/strict';
import { assignRoles, classify, detectFields, sideOf, tidyLabel, whoIn, type Side, type TextItem } from '../lib/pdf-autodetect';
import type { Shape } from '../lib/pdf-shapes';
import { autoMapText } from '../lib/doc-text-import';
import { docName, replacedBuiltIn } from '../lib/template-import';
import { guessKind } from '../lib/contracts';

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log('ok  ', name); };
const W = 612, H = 792, page = { width: W, height: H };
const run = (p: number, str: string, x: number, y: number): TextItem => ({ page: p, str, x, y, w: str.length * 5, h: 10 });

const acq: { ctx: null; inSignBlock: boolean; side: Side; kind: string } = { ctx: null, inSignBlock: false, side: 'acquisition', kind: 'psa' };
const ACQ_ROLES = [{ role: 'seller', label: 'Seller', party: 'seller' }, { role: 'buyer', label: 'Buyer', party: 'company' }];

ok('labels and parties', () => {
  assert.equal(tidyLabel('1. Purchase Price: $'), 'Purchase Price');
  assert.equal(whoIn('Seller (Tenant):'), 'seller');
  assert.equal(whoIn('Buyer (Landlord):'), 'buyer');
  assert.equal(whoIn('Title Company'), null, '"company" alone is not us');
  assert.equal(sideOf('Acme Homes Disposition Purchase Agreement', 'psa'), 'disposition');
  assert.equal(sideOf('Acme Homes PSA 2026', 'psa'), 'acquisition');
});

ok('record values and types', () => {
  const v = (l: string, o: Parameters<typeof classify>[1] = acq) => { const c = classify(l, o); return 'variable_key' in c ? c.variable_key : null; };
  assert.equal(v('Property Address:'), 'property.address');
  assert.equal(v('Purchase Price: $'), 'deal.purchase_price');
  assert.equal(v('Earnest Money: $'), 'deal.inhouse_emd', 'Acme Homes deposits on a purchase');
  assert.equal(v('Earnest Money: $', { ...acq, side: 'disposition' }), 'deal.buyer_emd');
  assert.equal(v('Closing Date:'), 'deal.close_date');
  assert.equal(v('Title Company:'), 'title.company');
  assert.equal(v('Seller Name'), 'seller.name');
  assert.equal(v('Buyer Name'), 'company.entity', 'on a purchase, Acme Homes is the buyer');
  assert.equal(v('Buyer Name', { ...acq, side: 'disposition' }), 'buyer.name');
  assert.equal(v('This Addendum is entered into on'), 'doc.date');
  assert.equal(v('payable by Buyer at closing'), null, 'a sentence that mentions the buyer is not their name');
  assert.equal(v('Sales Price', { ...acq, kind: 'amendment' }), null, 'an amendment agrees a new price; it does not repeat the old one');
  assert.equal(classify('Daily Rent Amount: $', acq).type, 'currency');
  assert.equal(classify('vacate within', { ...acq, after: ' calendar days following' }).type, 'number');
  assert.equal(classify('Seller shall pay $', { ...acq, after: ' per day as holdover rent' }).type, 'currency');
  assert.deepEqual(classify('Seller Signature', acq), { type: 'signature', who: 'seller' });
  assert.deepEqual(classify('Initialed for identification by Buyer', acq), { type: 'initials', who: 'buyer' });
  assert.deepEqual(classify('Date', { ...acq, ctx: 'seller', inSignBlock: true }), { type: 'date_signed', who: 'seller' });
});

ok('a PSA: underscores, a drawn signature rule, a printed name and a checkbox', () => {
  const items = [
    run(1, 'Property Address: ______________________________', 54, 110),
    run(1, 'Purchase Price: $____________   Earnest Money: $__________', 54, 130),
    run(1, 'Closing Date: ____________', 54, 150),
    run(1, '☐ Seller will provide a survey', 54, 200),
    run(2, 'SELLER:', 54, 600),
    run(2, 'Seller Signature                                     Date', 54, 652),
    run(2, 'Printed Name: ____________________', 54, 672),
  ];
  const shapes: Shape[] = [{ page: 2, kind: 'rule', x: 54, y: 640, w: 250, h: 0.5 }];
  const { found, side } = detectFields(items, [page, page], shapes, { name: 'Acme Homes PSA 2026', kind: 'psa' });
  const fields = assignRoles(found, ACQ_ROLES, side);
  const has = (p: (f: (typeof fields)[number]) => boolean, msg: string) => assert.ok(fields.some(p), msg);
  has((f) => f.variable_key === 'property.address' && !!f.read_only, 'address bound and locked');
  has((f) => f.variable_key === 'deal.purchase_price' && f.type === 'currency', 'price');
  has((f) => f.variable_key === 'deal.close_date' && f.type === 'date', 'close date');
  has((f) => f.type === 'checkbox', 'checkbox');
  has((f) => f.type === 'signature' && f.role === 'seller' && f.page === 2, 'seller signs on the drawn rule');
  has((f) => f.type === 'date_signed' && f.role === 'seller', 'date beside the signature');
  has((f) => f.variable_key === 'seller.name' && f.role === 'seller', 'printed name is the seller\'s name');
  for (const f of fields) assert.ok(f.page >= 1 && f.x >= 0 && f.y >= 0 && f.x + f.w <= 1.0001 && f.y + f.h <= 1.0001, 'on the page');
  // Values the record fills go to the side that prepares the paper (Acme Homes, the buyer here).
  assert.equal(fields.find((f) => f.variable_key === 'deal.purchase_price')?.role, 'buyer');
});

ok('an amendment drawn as boxes, labelled above', () => {
  const items = [
    run(1, 'TO CONTRACT CONCERNING THE PROPERTY AT', 120, 135),
    run(1, 'A. Cash portion of Sales Price payable by Buyer at closing', 75, 225),
    run(1, '(3) The closing date of the contract is changed to', 50, 325),
  ];
  const shapes: Shape[] = [
    { page: 1, kind: 'box', x: 73, y: 147, w: 467, h: 23 },
    { page: 1, kind: 'box', x: 78, y: 237, w: 467, h: 22 },
    { page: 1, kind: 'box', x: 78, y: 337, w: 467, h: 22 },
    { page: 1, kind: 'box', x: 11, y: 9, w: 176, h: 100 }, // the logo's frame
  ];
  const { found } = detectFields(items, [page], shapes, { name: 'Acme Homes Amendment', kind: 'amendment' });
  assert.equal(found.length, 3, 'three blanks, not the logo');
  assert.equal(found[0].variable_key, 'property.address');
  assert.equal(found[1].type, 'currency');
  assert.equal(found[1].label, 'Cash portion of sales price');
  assert.equal(found[2].type, 'date');
});

ok('a footer of initials, and blocks side by side and stacked', () => {
  const items = [
    run(1, 'Initialed for identification by Buyer', 36, 760), run(1, 'and Seller', 310, 760),
    run(2, 'SELLER (TENANT):', 54, 500),
    run(2, 'Signature: ______________________________', 54, 520),
    run(2, 'Date: ______________', 54, 540),
    run(2, 'BUYER (LANDLORD):', 54, 570),
    run(2, 'Signature: ______________________________', 54, 590),
    run(2, 'Date: ______________', 54, 610),
  ];
  const shapes: Shape[] = [
    { page: 1, kind: 'rule', x: 228, y: 762, w: 35, h: 0.5 }, { page: 1, kind: 'rule', x: 268, y: 762, w: 35, h: 0.5 },
    { page: 1, kind: 'rule', x: 365, y: 762, w: 35, h: 0.5 }, { page: 1, kind: 'rule', x: 405, y: 762, w: 35, h: 0.5 },
  ];
  const { found } = detectFields(items, [page, page], shapes, { name: 'Temporary Leaseback Addendum', kind: 'addendum' });
  const initials = found.filter((f) => f.type === 'initials').map((f) => f.who);
  assert.deepEqual(initials, ['buyer', 'seller', 'seller2'], 'one buyer (Acme Homes), two sellers');
  const blocks = found.filter((f) => f.page === 2).map((f) => `${f.type}:${f.who}`);
  assert.deepEqual(blocks, ['signature:seller', 'date_signed:seller', 'signature:buyer', 'date_signed:buyer'], 'the buyer heading starts the buyer block');
});

ok('a Word document becomes a template with variables and fill-ins', () => {
  const t = autoMapText([
    'ASSIGNMENT OF CONTRACT',
    'This assignment is made for the property at ______________________.',
    'Assignment Fee: $__________',
    'Holdback Purpose: ____________',
    '',
    'Assignor Signature: ______________________',
    'Date: ____________',
    '',
    'Assignee Signature: ________________________________',
  ].join('\n'), { name: '2026 Acme Homes Assignment', kind: 'assignment' });
  assert.ok(t.body_md.includes('### ASSIGNMENT OF CONTRACT'));
  assert.ok(t.body_md.includes('{{property.address}}'), t.body_md);
  assert.ok(t.body_md.includes('{{deal.assignment_fee}}'));
  assert.ok(t.body_md.includes('[Fill.HoldbackPurpose]'));
  assert.ok(t.body_md.includes('{{sign:assignor}}') && t.body_md.includes('{{sign:assignee}}'));
  assert.ok(!/Date: _/.test(t.body_md), 'the signing date prints with the block');
  assert.deepEqual(t.signers.map((s) => [s.role, s.party]), [['assignor', 'company'], ['assignee', 'buyer']]);
});

ok('a stack of PandaDoc exports: type, and the built-in each replaces', () => {
  const builtIns = ['psa', 'assignment', 'termination', 'offer_letter', 'authorization', 'amendment', 'option', 'leaseback', 'escrow_holdback', 'seller_info', 'trec_1_4'].map((key) => ({ key }));
  const cases: [string, string, string][] = [
    ['Home_Pros_PSA_2026_2.pdf', 'psa', 'psa'],
    ['TREC_One_to_Four_2026.pdf', 'psa', 'trec_1_4'],
    ['Non-Exclusive_Option_to_Purchase_Agreement_1.pdf', 'option', 'option'],
    ['Home_Pros_Termination_Agreement_2.pdf', 'termination', 'termination'],
    ['Home_Pros_Amendment_2.pdf', 'amendment', 'amendment'],
    ['Temporary_Leasenback_ADDENDUM_2.pdf', 'addendum', 'leaseback'],
    ['ESCROW_HOLD_BACK_ADDENDUM_3.pdf', 'addendum', 'escrow_holdback'],
    ['Seller_Information_Form_1.pdf', 'disclosure', 'seller_info'],
  ];
  for (const [file, kind, key] of cases) {
    const name = docName(file);
    assert.equal(guessKind(name), kind, name);
    assert.equal(replacedBuiltIn(name, builtIns), key, name);
  }
  assert.equal(docName('TREC_One_to_Four_2026.pdf'), 'TREC One to Four 2026', 'a year stays; a copy number goes');
  assert.equal(replacedBuiltIn('Lead intake checklist', builtIns), null);
});

console.log(`pdf-autodetect: ${n} groups passed`);
