// textTone: status fills used as text read in their --tx-* shade (DESIGN.md §2).
// Run: npx tsx tools/text-tone.test.ts
import assert from 'node:assert/strict';
import { textTone } from '../lib/text-tone';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

// WCAG relative luminance, to prove each mapped shade holds 4.5:1 on white.
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const onWhite = (hex: string) => 1.05 / (lum(hex) + 0.05);
const fallback = (v: string) => /#([0-9a-f]{6})\)$/i.exec(v)?.[0].slice(0, 7) ?? '';

test('fills that fail on white map to their text shade', () => {
  assert.equal(textTone('#16a34a'), 'var(--tx-green, #15803d)');
  assert.equal(textTone('#d97706'), 'var(--tx-amber, #b45309)');
  assert.equal(textTone('#ea580c'), 'var(--tx-orange, #c2410c)');
  assert.equal(textTone('#FF7A45'), 'var(--tx-orange, #c2410c)');
  assert.equal(textTone('#a1a1aa'), 'var(--meta, #71717a)');
  assert.equal(textTone('var(--subtle, #a1a1aa)'), 'var(--meta, #71717a)');
  assert.equal(textTone('#FF233B'), 'var(--tx-red, #b91c1c)');
});

test('every mapped shade holds 4.5:1 on white', () => {
  for (const c of ['#16a34a', '#d97706', '#ea580c', '#ff7a45', '#dc2626', '#2563eb', '#0284c7', '#0891b2', '#0d9488', '#a1a1aa', '#ca8a04']) {
    const hex = fallback(textTone(c)!);
    assert.ok(hex, c + ' has a fallback');
    assert.ok(onWhite(hex) >= 4.5, `${c} -> ${hex} is ${onWhite(hex).toFixed(2)}:1`);
  }
});

test('unknown colours and tokens pass through', () => {
  assert.equal(textTone('var(--ink, #18181b)'), 'var(--ink, #18181b)');
  assert.equal(textTone('#7c3aed'), '#7c3aed');
  assert.equal(textTone(undefined), undefined);
  assert.equal(textTone(''), '');
});

console.log(`text-tone: ${passed} passed`);
