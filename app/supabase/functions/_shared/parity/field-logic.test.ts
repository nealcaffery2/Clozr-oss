import { assert, assertEquals } from 'jsr:@std/assert@1';
import { blockers, computeFormulas, evalFormula, isVisible, type LogicField, radioSiblings, validateParity, valueMap } from './field-logic.ts';
import { prepareForFlatten } from './flatten-prep.ts';

const f = (o: Partial<LogicField> & { id: number; type: LogicField['type'] }): LogicField => ({ signer_id: 1, page: 1, ...o });

Deno.test('formula math and refs', () => {
  assertEquals(evalFormula('{price} - {fee}', (k) => ({ price: 180000, fee: 19500 } as Record<string, number>)[k] ?? 0), 160500);
  assertEquals(evalFormula('round({a} * 0.25, 2)', () => 1875), 468.75);
  assertEquals(evalFormula('max(1, 2) + min(3, 4) * 2', () => 0), 8);
  assertEquals(evalFormula('{{deal.purchase_price}} / 0', () => 5), 0);
});

Deno.test('computeFormulas uses field values and variables', () => {
  const fields = [
    f({ id: 1, type: 'currency', field_key: 'gross', value: '1875.00' }),
    f({ id: 2, type: 'number', field_key: 'pct', value: '25' }),
    f({ id: 3, type: 'formula', field_key: 'payout', formula: 'round({gross} * {pct} / 100, 2)' }),
  ];
  assertEquals(computeFormulas(fields).get(3), '468.75');
});

Deno.test('radio group: choose exactly one, siblings cleared', () => {
  const fields = [
    f({ id: 1, type: 'radio', group_key: 'pay', label: 'Wise', required: true }),
    f({ id: 2, type: 'radio', group_key: 'pay', label: 'PayPal', required: true }),
  ];
  assertEquals(blockers(fields, 1).length, 1);
  fields[0].value = 'true';
  assertEquals(blockers(fields, 1).length, 0);
  assertEquals(valueMap(fields).get('pay'), 'Wise');
  assertEquals(radioSiblings(fields, fields[1]).map((x) => x.id), [1]);
});

Deno.test('conditional show and require', () => {
  const fields = [
    f({ id: 1, type: 'checkbox', field_key: 'has_tenant' }),
    f({ id: 2, type: 'text', field_key: 'lease_end', required: true, conditions: { all: [{ field: 'has_tenant', op: 'checked' }], action: 'show' } }),
    f({ id: 3, type: 'text', field_key: 'hoa_name', conditions: { all: [{ field: 'has_tenant', op: 'checked' }], action: 'require' } }),
  ];
  assertEquals(isVisible(fields[1], valueMap(fields)), false);
  assertEquals(blockers(fields, 1).length, 0);
  fields[0].value = 'true';
  assertEquals(blockers(fields, 1).map((b) => b.id).sort(), [2, 3]);
});

Deno.test('checkbox group min/max', () => {
  const fields = [1, 2, 3].map((id) => f({ id, type: 'checkbox', group_key: 'g', validation: { minChecked: 2, maxChecked: 2 } }));
  fields[0].value = 'true';
  assertEquals(blockers(fields, 1)[0].reason, 'tick at least 2');
  fields[1].value = 'true'; fields[2].value = 'true';
  assertEquals(blockers(fields, 1)[0].reason, 'tick at most 2');
});

Deno.test('email, phone, pattern validation', () => {
  assert(validateParity(f({ id: 1, type: 'email' }), 'A@B.co').ok);
  assert(!validateParity(f({ id: 1, type: 'email' }), 'nope').ok);
  const p = validateParity(f({ id: 1, type: 'phone' }), '210.555.0168');
  assert(p.ok && p.value === '(210) 555-0168');
  assert(!validateParity(f({ id: 1, type: 'text', validation: { pattern: '\\d{5}' } }), '7822').ok);
  assert(validateParity(f({ id: 1, type: 'text', validation: { pattern: '\\d{5}' } }), '78228').ok);
});

Deno.test('flatten prep maps new types and blanks hidden fields', () => {
  const out = prepareForFlatten([
    { id: 1, type: 'checkbox', page: 1, x: 0, y: 0, w: 0.1, h: 0.1, value: '', field_key: 'x' },
    { id: 2, type: 'text', page: 1, x: 0, y: 0, w: 0.1, h: 0.1, value: 'secret', conditions: { all: [{ field: 'x', op: 'checked' }], action: 'show' } },
    { id: 3, type: 'radio', page: 1, x: 0, y: 0, w: 0.1, h: 0.1, value: 'true', group_key: 'g' },
    { id: 4, type: 'attachment', page: 1, x: 0, y: 0, w: 0.1, h: 0.1, value: '9' },
  ], new Map([[9, 'POF.pdf']]));
  assertEquals(out[1].value, null);
  assertEquals(out[2].type, 'checkbox');
  assertEquals(out[3].value, 'See attachment: POF.pdf');
});
