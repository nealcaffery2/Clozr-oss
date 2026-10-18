// Fields on uploaded PDFs: validation, coordinates, flattening.  Run:  npx tsx tools/pdf-fields.test.ts
import assert from 'node:assert/strict';
import { docVars } from '../supabase/functions/_shared/doc-vars';
import {
  bindToSigners, bindValue, clampRect, displaySize, displayValue, effectiveReadOnly, fieldAllowedFor, missingRequired, newField, normalizeField, planFlatten,
  recipientColor, signingDay, toPdfPoint, validateValue, type PageBox,
} from '../supabase/functions/_shared/pdf-fields';

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≈ ${b}`);

// ------------------------------------------------------------ normalizing
const ok = normalizeField({ role: 'seller', type: 'text', page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.02, required: true, label: 'Buyer entity' }, 9);
assert.ok(ok.ok);
if (ok.ok) { assert.equal(ok.field.page, 2); assert.equal(ok.field.required, true); assert.equal(ok.field.read_only, false); }
assert.equal(normalizeField({ role: 'seller', type: 'hologram', page: 1, x: 0, y: 0, w: 0.1, h: 0.1 }).ok, false, 'unknown type');
// PandaDoc parity types (migration 179): a radio needs its question, a formula its formula, and both keep their logic.
assert.equal(normalizeField({ role: 'seller', type: 'radio', page: 1, x: 0, y: 0, w: 0.02, h: 0.02 }).ok, false, 'radio needs a group');
assert.equal(normalizeField({ role: 'seller', type: 'formula', page: 1, x: 0, y: 0, w: 0.1, h: 0.02 }).ok, false, 'formula needs a formula');
const radio = normalizeField({ role: 'seller', type: 'radio', page: 1, x: 0, y: 0, w: 0.02, h: 0.02, group_key: 'pay method', label: 'Wise', conditions: { action: 'show', all: [{ field: 'paid', op: 'checked' }] } });
assert.ok(radio.ok && radio.field.group_key === 'pay_method' && radio.field.conditions?.all?.[0]?.field === 'paid');
const sum = normalizeField({ role: 'seller', type: 'formula', page: 1, x: 0, y: 0, w: 0.1, h: 0.02, formula: '{gross} * {pct} / 100', field_key: 'payout' });
assert.ok(sum.ok && sum.field.read_only && sum.field.formula === '{gross} * {pct} / 100' && sum.field.field_key === 'payout', 'formula is calculated, never typed');
const stamp = normalizeField({ role: 'company', type: 'stamp', page: 1, x: 0, y: 0, w: 0.2, h: 0.2 });
assert.ok(stamp.ok && stamp.field.required, 'a stamp is signed, so required by default');
const empty = normalizeField({ role: 'seller', type: 'text', page: 1, x: 0, y: 0, w: 0.1, h: 0.02, conditions: { all: [] } });
assert.ok(empty.ok && empty.field.conditions === null, 'an empty condition is dropped');
assert.equal(normalizeField({ role: '', type: 'text', page: 1, x: 0, y: 0, w: 0.1, h: 0.1 }).ok, false, 'needs a recipient');
assert.equal(normalizeField({ role: 'seller', type: 'text', page: 10, x: 0, y: 0, w: 0.1, h: 0.1 }, 9).ok, false, 'page past the end');
assert.equal(normalizeField({ role: 'seller', type: 'dropdown', page: 1, x: 0, y: 0, w: 0.1, h: 0.1, options: ['', ' '] }).ok, false, 'dropdown needs options');
assert.equal(normalizeField({ role: 'seller', type: 'signature', page: 1, x: 0, y: 0, w: 0.1, h: 0.1, variable_key: 'seller.name' }).ok, false, 'signature cannot bind');
// A variable binding makes it read-only; signatures default to required.
const bound = normalizeField({ role: 'company', type: 'currency', page: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.02, variable_key: 'deal.purchase_price' });
assert.ok(bound.ok && bound.field.read_only && bound.field.variable_key === 'deal.purchase_price');
const sig = normalizeField({ role: 'seller', type: 'signature', page: 1, x: 0.95, y: 0.99, w: 0.3, h: 0.05 });
assert.ok(sig.ok && sig.field.required === true);
// Off the edge: pulled back onto the page, size kept.
if (sig.ok) { near(sig.field.x, 0.7); near(sig.field.y, 0.95); near(sig.field.w, 0.3); }
assert.deepEqual(clampRect({ x: -1, y: 2, w: 0, h: 5 }), { x: 0, y: 0, w: 0.004, h: 1 });

// newField: points → fractions, centered on the drop.
const nf = newField('signature', 'seller', 3, { x: 0.5, y: 0.5 }, { width: 612, height: 792 });
near(nf.w, 170 / 612); near(nf.x, 0.5 - 170 / 612 / 2); assert.equal(nf.page, 3); assert.equal(nf.required, true);
assert.equal(newField('checkbox', 'seller', 1, { x: 0.5, y: 0.5 }, { width: 612, height: 792 }).required, false);

// Fillers never get signature boxes.
assert.equal(fieldAllowedFor('signature', 'filler'), false);
assert.equal(fieldAllowedFor('date_signed', 'filler'), false);
assert.equal(fieldAllowedFor('text', 'filler'), true);
assert.equal(fieldAllowedFor('signature', 'signer'), true);
assert.notEqual(recipientColor(0), recipientColor(1));
assert.equal(recipientColor(8), recipientColor(0));

// ------------------------------------------------------------ values
assert.deepEqual(validateValue({ type: 'currency' }, '$85,000.456'), { ok: true, value: '85000.46' });
assert.deepEqual(validateValue({ type: 'number', validation: { min: 1, max: 30 } }, '10'), { ok: true, value: '10' });
assert.equal(validateValue({ type: 'number', validation: { min: 1, max: 30 } }, '31').ok, false);
assert.equal(validateValue({ type: 'number' }, 'ten').ok, false);
assert.deepEqual(validateValue({ type: 'date' }, '2026-10-21'), { ok: true, value: '2026-10-21' });
assert.equal(validateValue({ type: 'date' }, '2026-02-30').ok, false, 'no Feb 30');
assert.equal(validateValue({ type: 'date' }, '10/21/2026').ok, false);
assert.deepEqual(validateValue({ type: 'checkbox' }, true), { ok: true, value: 'true' });
assert.deepEqual(validateValue({ type: 'checkbox' }, false), { ok: true, value: null });
assert.deepEqual(validateValue({ type: 'dropdown', options: ['Cash', 'Conventional'] }, 'Cash'), { ok: true, value: 'Cash' });
assert.equal(validateValue({ type: 'dropdown', options: ['Cash'] }, 'FHA').ok, false);
assert.equal(validateValue({ type: 'text', validation: { maxLength: 3 } }, 'abcd').ok, false);
assert.deepEqual(validateValue({ type: 'text' }, '  '), { ok: true, value: null }, 'blank clears');
assert.equal(validateValue({ type: 'signature' }, 'hello').ok, false);
assert.equal(validateValue({ type: 'signature' }, 'data:image/png;base64,iVBORw0KGgo=').ok, true);
assert.equal(validateValue({ type: 'initials' }, 'data:image/png;base64,' + 'A'.repeat(400_001)).ok, false, 'too big');

assert.equal(displayValue({ type: 'currency' }, '85000'), '$85,000');
assert.equal(displayValue({ type: 'currency' }, '85000.5'), '$85,000.50');
assert.equal(displayValue({ type: 'date' }, '2026-10-21'), '10/21/2026');
assert.equal(displayValue({ type: 'checkbox' }, 'true'), 'X');
assert.equal(signingDay(new Date('2026-10-01T03:00:00Z')), '2026-09-30', 'Central time');

// Required: my empty required fields only; read-only and date-signed never block.
const fields = [
  { id: 1, signer_id: 7, type: 'signature' as const, required: true, read_only: false, value: null },
  { id: 2, signer_id: 7, type: 'text' as const, required: true, read_only: false, value: 'x' },
  { id: 3, signer_id: 7, type: 'date_signed' as const, required: true, read_only: true, value: null },
  { id: 4, signer_id: 7, type: 'currency' as const, required: true, read_only: true, value: null },
  { id: 5, signer_id: 8, type: 'text' as const, required: true, read_only: false, value: null },
  { id: 6, signer_id: 7, type: 'checkbox' as const, required: false, read_only: false, value: null },
];
assert.deepEqual(missingRequired(fields, 7).map((f) => f.id), [1]);

// Variable bindings from the record.
const vars = docVars({ deal: { offer_amount: 85000, close_date: '2026-10-21T00:00:00Z' }, buyer: { name: 'Bo', company: 'Acme Holdings LLC' } }, { legal: 'Acme Homes LLC' });
assert.equal(bindValue('currency', 'deal.purchase_price', vars), '85000');
assert.equal(bindValue('text', 'deal.purchase_price', vars), '$85,000');
assert.equal(bindValue('date', 'deal.close_date', vars), '2026-10-21');
assert.equal(bindValue('text', 'buyer.entity', vars), 'Acme Holdings LLC');
assert.equal(bindValue('text', 'deal.assignment_fee', vars), null, 'no answer');
assert.equal(bindValue('text', null, vars), null);

// Template fields → one contract's signers.
const tplFields = [
  { id: 11, role: 'seller', type: 'signature' as const, page: 1, x: 0.1, y: 0.9, w: 0.3, h: 0.04, required: true },
  { id: 12, role: 'company', type: 'currency' as const, page: 1, x: 0.5, y: 0.2, w: 0.2, h: 0.02, variable_key: 'deal.purchase_price' },
  { id: 13, role: 'title', type: 'text' as const, page: 2, x: 0.1, y: 0.1, w: 0.3, h: 0.02, variable_key: 'deal.assignment_fee', required: true },
  { id: 14, role: 'title', type: 'signature' as const, page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.04 },
  { id: 15, role: 'lender', type: 'text' as const, page: 1, x: 0, y: 0, w: 0.1, h: 0.02 },
  { id: 16, role: 'seller2', type: 'initials' as const, page: 1, x: 0, y: 0, w: 0.1, h: 0.02 },
  { id: 17, role: 'seller', type: 'dropdown' as const, page: 1, x: 0, y: 0.5, w: 0.1, h: 0.02, options: ['Cash', 'FHA'], default_value: 'Cash' },
];
const bindSigners = [
  { id: 101, role: 'seller', recipient_type: 'signer' }, { id: 102, role: 'company', recipient_type: 'signer' },
  { id: 103, role: 'title', recipient_type: 'filler' }, { id: 104, role: 'lender', recipient_type: 'viewer' },
];
const b = bindToSigners(tplFields, bindSigners, vars, { fromTemplate: true });
assert.equal(bindToSigners(tplFields, bindSigners, vars).rows[0].template_field_id, null, 'editor ids are not template ids');
assert.deepEqual(b.rows.map((r) => [r.template_field_id, r.signer_id]), [[11, 101], [12, 102], [13, 103], [17, 101]]);
assert.equal(b.rows[1].value, '85000'); assert.equal(b.rows[1].read_only, true, 'bound currency: locked');
const dateBound = bindToSigners([{ id: 20, role: 'seller', type: 'date', page: 1, x: 0, y: 0, w: 0.1, h: 0.02, variable_key: 'deal.close_date' }], bindSigners.slice(0, 1), vars, { fromTemplate: true });
assert.equal(dateBound.rows[0].read_only, false, 'bound date stays editable');
assert.equal(effectiveReadOnly({ type: 'date', read_only: true, variable_key: 'deal.close_date' }), false);
assert.equal(effectiveReadOnly({ type: 'currency', read_only: true, variable_key: 'deal.purchase_price' }), true);
assert.equal(b.rows[2].value, null); assert.equal(b.rows[2].read_only, false, 'bound but unanswered: the filler types it');
assert.deepEqual(b.unresolved, ['deal.assignment_fee']);
assert.equal(b.rows[3].value, 'Cash', 'default value');
assert.deepEqual(b.skipped.map((s) => s.reason), ['a form filler does not sign', 'a viewer does not fill fields', 'no one is filling that role']);

// ------------------------------------------------------------ geometry
const letter: PageBox = { x0: 0, y0: 0, width: 612, height: 792, rotation: 0 };
assert.deepEqual(toPdfPoint(letter, 0, 0), { x: 0, y: 792 }, 'top-left of the screen is the top-left of the page');
assert.deepEqual(toPdfPoint(letter, 1, 1), { x: 612, y: 0 });
assert.deepEqual(toPdfPoint({ ...letter, x0: 10, y0: 20 }, 0.5, 0.5), { x: 316, y: 416 }, 'crop box offset');
// Rotated 90° clockwise: displayed landscape (792 wide); the screen's top-left is the PDF's bottom-left.
const r90: PageBox = { ...letter, rotation: 90 };
assert.deepEqual(displaySize(r90), { width: 792, height: 612 });
assert.deepEqual(toPdfPoint(r90, 0, 0), { x: 0, y: 0 });
assert.deepEqual(toPdfPoint(r90, 1, 0), { x: 0, y: 792 });
assert.deepEqual(toPdfPoint(r90, 0, 1), { x: 612, y: 0 });
assert.deepEqual(toPdfPoint({ ...letter, rotation: 180 }, 0, 0), { x: 612, y: 0 });
assert.deepEqual(toPdfPoint({ ...letter, rotation: 270 }, 0, 0), { x: 612, y: 792 });
assert.deepEqual(toPdfPoint({ ...letter, rotation: -90 }, 0, 0), { x: 612, y: 792 }, '-90 is 270');

// ------------------------------------------------------------ flatten plan
const measure = (t: string, size: number) => t.length * size * 0.5;
const png = 'data:image/png;base64,iVBORw0KGgo=';
const plan = planFlatten([
  { type: 'currency', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 20 / 792, value: '85000' },
  { type: 'checkbox', page: 1, x: 0.5, y: 0.5, w: 12 / 612, h: 12 / 792, value: 'true' },
  { type: 'checkbox', page: 1, x: 0.6, y: 0.5, w: 12 / 612, h: 12 / 792, value: null },
  { type: 'signature', page: 2, x: 0.1, y: 0.8, w: 200 / 612, h: 40 / 792, value: png, imageSize: { width: 400, height: 40 } },
  { type: 'text', page: 3, x: 0, y: 0, w: 0.1, h: 0.1, value: 'no such page' },
  { type: 'text', page: 1, x: 0.1, y: 0.3, w: 40 / 612, h: 20 / 792, value: 'A very long name that will not fit' },
], [letter, letter], measure);
assert.equal(plan.length, 5, 'currency, two check strokes, signature, long text');
const money = plan[0];
assert.ok(money.op === 'text');
if (money.op === 'text') {
  assert.equal(money.text, '$85,000');
  assert.equal(money.size, 11, 'capped at 11pt');
  near(money.x, 0.1 * 612 + 2);
  assert.ok(money.y > 792 - 0.1 * 792 - 20 && money.y < 792 - 0.1 * 792, 'baseline inside the box');
}
assert.equal(plan[1].op, 'line');
const s2 = plan[3];
assert.ok(s2.op === 'image');
if (s2.op === 'image') {
  assert.equal(s2.page, 2);
  near(s2.width, 200); near(s2.height, 20, 'scaled to the box width, aspect kept');
  near(s2.x, 0.1 * 612);
  near(s2.y, 792 - (0.8 * 792 + 40) + 10, 'vertically centered');
}
const long = plan[4];
assert.ok(long.op === 'text' && long.size < 11 && measure(long.text, long.size) <= 36 + 1e-9, 'shrunk to fit');
// Rotated page: text is turned with the page so it reads upright.
const rp = planFlatten([{ type: 'text', page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.03, value: 'Hi' }], [r90], measure);
assert.ok(rp[0].op === 'text' && rp[0].rotate === 90);

console.log('pdf-fields ok');
