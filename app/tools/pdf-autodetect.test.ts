// Auto-mapping uploaded contracts. Run: npx tsx tools/pdf-autodetect.test.ts
//
// Layouts are synthetic but copy the shapes of real Acme Homes paper: a PSA
// with underscore blanks and a drawn signature rule, an amendment whose
// blanks are drawn boxes, a TREC-style footer of initials, side-by-side and
// stacked signature blocks, and a leaseback's "Seller (Tenant):" lines.
import assert from 'node:assert/strict';
import { assignRoles, classify, detectFields, sideOf, tidyLabel, whoIn, type Side, type TextItem } from '../lib/pdf-autodetect';
import { isOutlined, type Shape } from '../lib/pdf-shapes';
import { mergeOcr, wordsOf } from '../lib/pdf-ocr';
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
  assert.deepEqual(classify('Seller Signature', acq), { type: 'signature', who: 'seller', explicit: true });
  assert.deepEqual(classify('Initialed for identification by Buyer', acq), { type: 'initials', who: 'buyer', explicit: true });
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

// A TXR seller's disclosure from zipForm: every printed word is an outline, so
// the labels below come from OCR (marked `ocr`) and the only real text is what
// the listing agent typed in. It needs initials on every page and the
// signature blocks, nothing else (it once came back with 192 fields).
const word = (p: number, str: string, x: number, y: number, w = str.length * 4): TextItem => ({ page: p, str, x, y, w, h: 9, ocr: true });
const fill = (p: number, str: string, x: number, y: number): TextItem => ({ page: p, str, x, y, w: str.length * 6, h: 9 });
const footer = (p: number): { items: TextItem[]; shapes: Shape[] } => ({
  items: [word(p, 'Initialed', 150, 742), word(p, 'by:', 190, 742), word(p, 'Buyer:', 229, 742, 23), word(p, 'and', 337, 742, 14), word(p, 'Seller:', 355, 742, 24)],
  shapes: [257, 299, 382, 425].map((x) => ({ page: p, kind: 'rule' as const, x, y: 744, w: 35, h: 0.5 })),
});
const disclosure = (filled: boolean) => {
  const f1 = footer(1), f2 = footer(2);
  const items: TextItem[] = [
    ...f1.items, ...f2.items,
    word(1, 'Dishwasher', 40, 300, 50), word(1, 'If', 220, 322, 8), word(1, 'yes,', 230, 322, 16), word(1, 'explain:', 250, 322, 30),
    word(2, 'Signature', 37, 502, 36), word(2, 'of', 76, 502, 8), word(2, 'Seller', 86, 502, 22), word(2, 'Date', 270, 502, 16),
    word(2, 'Signature', 340, 502, 36), word(2, 'of', 379, 502, 8), word(2, 'Seller', 389, 502, 22), word(2, 'Date', 555, 502, 16),
    word(2, 'Printed', 37, 546, 28), word(2, 'Name:', 68, 546, 24), word(2, 'Printed', 340, 546, 28), word(2, 'Name:', 371, 546, 24),
    ...(filled ? [fill(1, 'X', 100, 300), fill(1, 'Unknown', 300, 320), fill(1, 'X', 230, 360)] : []),
  ];
  const shapes: Shape[] = [
    ...f1.shapes, ...f2.shapes,
    { page: 1, kind: 'box', x: 95, y: 290, w: 30, h: 14 },
    { page: 1, kind: 'rule', x: 285, y: 322, w: 250, h: 0.5 },
    { page: 1, kind: 'rule', x: 252, y: 362, w: 338, h: 0.5 },
    { page: 2, kind: 'rule', x: 37, y: 490, w: 208, h: 0.5 }, { page: 2, kind: 'rule', x: 239, y: 490, w: 55, h: 0.5 },
    { page: 2, kind: 'rule', x: 306, y: 490, w: 208, h: 0.5 }, { page: 2, kind: 'rule', x: 520, y: 490, w: 58, h: 0.5 },
    { page: 2, kind: 'rule', x: 96, y: 548, w: 200, h: 0.5 }, { page: 2, kind: 'rule', x: 399, y: 548, w: 180, h: 0.5 },
  ];
  return detectFields(items, [page, page], shapes, { name: "Seller's Disclosure Notice", kind: 'disclosure', outlined: [1, 2] });
};

ok('a filled-in disclosure drawn as outlines: initials and signatures only', () => {
  const { found, signOnly } = disclosure(true);
  assert.ok(signOnly, 'typed-in values on an outlined form: it is filled in');
  const at = (p: number) => found.filter((f) => f.page === p).map((f) => `${f.type}:${f.who}${f.printedName ? ':name' : ''}`);
  assert.deepEqual(at(1), ['initials:buyer', 'initials:seller', 'initials:seller2'], 'the comma between two initials blanks is not a label; Acme Homes initials once');
  assert.deepEqual(at(2), [
    'signature:seller', 'signature:seller2', 'date_signed:seller', 'date_signed:seller2', 'text:seller:name', 'text:seller2:name',
    'initials:buyer', 'initials:seller', 'initials:seller2',
  ], '"Signature of Seller" twice on a row is the second seller, with their own date and name');
  assert.ok(!found.some((f) => f.page === 1 && f.type === 'signature'), 'an "X" typed in a box is a check mark, not "X ____" to sign on');
});

ok('the same outlined form left blank still maps its blanks', () => {
  const { found, signOnly } = disclosure(false);
  assert.ok(!signOnly);
  assert.ok(found.some((f) => f.page === 1 && f.type === 'text' && /explain/i.test(f.label ?? '')), 'the "If yes, explain" line');
  assert.ok(found.some((f) => f.type === 'signature' && f.who === 'seller'));
});

ok('an outlined form OCR could not read maps nothing, not a nameless box on every line', () => {
  const shapes: Shape[] = [{ page: 1, kind: 'rule', x: 285, y: 322, w: 250, h: 0.5 }, { page: 1, kind: 'rule', x: 36, y: 400, w: 200, h: 0.5 }, ...footer(1).shapes];
  assert.equal(detectFields([], [page], shapes, { name: "Seller's Disclosure Notice", kind: 'disclosure', outlined: [1] }).found.length, 0, 'blank and unread');
  assert.equal(detectFields([fill(1, 'Unknown', 300, 320)], [page], shapes, { kind: 'disclosure', outlined: [1] }).found.length, 0, 'filled in and unread');
  assert.ok(detectFields([], [page], shapes, { kind: 'disclosure' }).found.length > 0, 'the same lines on a page that is not outlined still map');
});

ok('stacked generic signature blocks: the second is the buyer, with their own date and name', () => {
  const items = [
    run(1, 'Signature: ______________________________', 54, 500),
    run(1, 'Date: ______________', 54, 520),
    run(1, 'Printed Name: ____________________', 54, 540),
    run(1, 'Signature: ______________________________', 54, 580),
    run(1, 'Date: ______________', 54, 600),
    run(1, 'Printed Name: ____________________', 54, 620),
  ];
  const { found, side } = detectFields(items, [page], [], { name: 'Acme Homes PSA 2026', kind: 'psa' });
  assert.deepEqual(found.map((f) => `${f.type}:${f.who}`), [
    'signature:seller', 'date_signed:seller', 'text:seller',
    'signature:buyer', 'date_signed:buyer', 'text:buyer',
  ], 'generic blocks split seller then buyer, dates and names follow their block');
  const fields = assignRoles(found, ACQ_ROLES, side);
  assert.equal(fields.filter((f) => f.type === 'signature' && f.role === 'seller').length, 1);
  assert.equal(fields.filter((f) => f.type === 'signature' && f.role === 'buyer').length, 1, 'the buyer signature is not on the seller side');
});

ok('OCR words: one row per line, misreads and typed-in text dropped', () => {
  assert.ok(isOutlined(99, 29652), 'a zipForm page: tens of thousands of curves, a few typed values');
  assert.ok(!isOutlined(2400, 900), 'a normal page with a logo');
  const words = wordsOf(1, [{ baseline: { x0: 0, y0: 200, x1: 1000, y1: 204 }, words: [
    { text: 'Seller:', bbox: { x0: 100, y0: 180, x1: 150, y1: 206 } }, { text: '.', bbox: { x0: 160, y0: 198, x1: 162, y1: 202 } },
    { text: 'i', bbox: { x0: 170, y0: 190, x1: 172, y1: 202 } }, { text: 'Unknown', bbox: { x0: 600, y0: 184, x1: 680, y1: 206 } },
  ] }], 2);
  assert.deepEqual(words.map((w) => w.str), ['Seller:', 'Unknown'], 'a comma read as "i" is dropped');
  assert.equal(words[0].y, 100.25, 'on the baseline, in points');
  const merged = mergeOcr([fill(1, 'Unknown', 300, 101)], words);
  assert.deepEqual(merged.map((w) => `${w.str}${w.ocr ? '*' : ''}`), ['Unknown', 'Seller:*'], 'OCR of the typed-in "Unknown" is the same text twice');
});

console.log(`pdf-autodetect: ${n} groups passed`);
