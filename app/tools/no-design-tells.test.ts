// DESIGN.md §1's banned tells, held by a ratchet over app/app/**/*.tsx:
//   1. tracked caps: textTransform 'uppercase' with letterSpacing of .05em
//      or more in the same style object (use SectionLabel or Badge);
//   2. glyph icons: ⏸ ▶ ⏹ ✦ (use a Lucide icon);
//   3. gradients written in inline styles (flat surfaces).
// Each file may keep at most the count in tools/no-design-tells.baseline.json
// (what was left when the rule landed); a new tell anywhere fails, and a file
// that drops below its count has to lower the baseline, so it only shrinks.
// Run: npx tsx tools/no-design-tells.test.ts   (--update rewrites the baseline)
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCAN = join(ROOT, 'app');
const BASELINE = join(HERE, 'no-design-tells.baseline.json');

// Gradients that are not decoration, so they never count. Each names its
// file and a piece of the line, so a new gradient in the same file still fails.
const GRADIENT_ALLOW: { file: string; match: string; why: string }[] = [
  { file: 'app/clozr/FloorShow.tsx', match: 'conic-gradient(${stops', why: 'the prize wheel: each conic stop is a slice of the wheel, so the gradient is the data' },
  { file: 'app/components/record/PropertyCard.tsx', match: 'rgba(0,0,0,.55)', why: 'a scrim under the caption laid over a house photo, so the white text reads on any photo' },
  { file: 'app/components/voice-agent/kit.tsx', match: '.va-skel', why: 'the skeleton shimmer of a loading state (DESIGN.md §7 states), not a surface' },
];

export type Tell = 'tracked-caps' | 'glyph' | 'gradient';
const GLYPHS = /[⏸▶⏹✦]/u;

/** The tells in one file's source, by kind. Pure, for the test below. */
export function findTells(src: string, file = ''): { kind: Tell; line: number; text: string }[] {
  const out: { kind: Tell; line: number; text: string }[] = [];
  const lines = src.split('\n');
  lines.forEach((raw, i) => {
    const line = raw.replace(/(^|\s)\/\/.*$/, '');
    if (/^\s*(\*|\/\*)/.test(raw)) return; // comment lines
    if (GLYPHS.test(line)) out.push({ kind: 'glyph', line: i + 1, text: raw.trim() });
    const allowed = GRADIENT_ALLOW.some((a) => file === a.file && line.includes(a.match));
    if (!allowed && /(radial|linear|conic)-gradient\(/.test(line) && /style=|background|Image:|: ['"`]/.test(line)) {
      out.push({ kind: 'gradient', line: i + 1, text: raw.trim() });
    }
  });
  // Tracked caps: an inline style object (one {{ … }} or a const object) that
  // both uppercases and tracks out by .05em or more.
  const objs = src.matchAll(/\{[^{}]*textTransform:\s*['"]uppercase['"][^{}]*\}/g);
  for (const m of objs) {
    const ls = /letterSpacing:\s*['"]?(-?[0-9.]+)(em|px)?['"]?/.exec(m[0]);
    if (!ls) continue;
    const v = parseFloat(ls[1]);
    const em = ls[2] === 'px' ? v / 11 : v; // px tracking on ~11px caps
    if (em >= 0.05) out.push({ kind: 'tracked-caps', line: src.slice(0, m.index).split('\n').length, text: m[0].slice(0, 120) });
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, acc); }
    else if (p.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

test('findTells catches each tell and leaves plain styles alone', () => {
  const caps = `<span style={{fontSize: "10.5px", letterSpacing: "0.14em", textTransform: "uppercase"}}>x</span>`;
  assert.deepEqual(findTells(caps).map((t) => t.kind), ['tracked-caps']);
  assert.deepEqual(findTells(`<b style={{ textTransform: 'uppercase', letterSpacing: '.02em' }} />`), []);
  assert.deepEqual(findTells(`<b style={{ letterSpacing: '.1em' }} />`), []);
  assert.deepEqual(findTells(`<Btn>⏸ Pause</Btn>`).map((t) => t.kind), ['glyph']);
  assert.deepEqual(findTells(`<div style={{ background: 'radial-gradient(120% 90% at 90% -10%, red, transparent)' }} />`).map((t) => t.kind), ['gradient']);
  assert.deepEqual(findTells(`// a comment about ✦ and radial-gradient(`), []);
  assert.deepEqual(findTells(`<span style={{ background: 'linear-gradient(180deg,transparent 40%,rgba(0,0,0,.55))' }} />`, 'app/components/record/PropertyCard.tsx'), []);
  assert.deepEqual(findTells(`<span style={{ background: 'linear-gradient(red, blue)' }} />`, 'app/components/record/PropertyCard.tsx').map((t) => t.kind), ['gradient']);
});

const counts: Record<string, Partial<Record<Tell, number>>> = {};
for (const f of walk(SCAN)) {
  const rel = relative(ROOT, f);
  const tells = findTells(readFileSync(f, 'utf8'), rel);
  for (const t of tells) (counts[rel] ??= {})[t.kind] = ((counts[rel] ??= {})[t.kind] ?? 0) + 1;
}

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  console.log('baseline written:', Object.keys(sorted).length, 'files');
} else {
  const base: typeof counts = JSON.parse(readFileSync(BASELINE, 'utf8'));
  test('no new tracked caps, glyph icons or inline gradients (DESIGN.md §1)', () => {
    const over: string[] = [];
    const under: string[] = [];
    for (const file of new Set([...Object.keys(counts), ...Object.keys(base)])) {
      for (const kind of ['tracked-caps', 'glyph', 'gradient'] as Tell[]) {
        const now = counts[file]?.[kind] ?? 0;
        const was = base[file]?.[kind] ?? 0;
        if (now > was) {
          const where = findTells(readFileSync(join(ROOT, file), 'utf8'), file).filter((t) => t.kind === kind).map((t) => `    ${file}:${t.line}  ${t.text.slice(0, 100)}`);
          over.push(`${file}: ${kind} ${was} -> ${now}\n${where.join('\n')}`);
        } else if (now < was) under.push(`${file}: ${kind} ${was} -> ${now}`);
      }
    }
    assert.equal(over.length, 0, 'New design tells (DESIGN.md §1). Use SectionLabel/Badge, a Lucide icon or a flat surface:\n' + over.join('\n'));
    assert.equal(under.length, 0, 'Fewer tells than the baseline: run `npx tsx tools/no-design-tells.test.ts --update` to lower it:\n' + under.join('\n'));
  });
}

console.log(`no-design-tells: ${passed} passed`);
