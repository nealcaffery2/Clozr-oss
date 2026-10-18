#!/usr/bin/env node
// theme-codemod: moves the screens' inline neutral colour literals onto the
// theme tokens in app/clozr/tokens.css, so dark mode (RULES.md theme
// contract) reaches code that was generated with hex colours.
//
//   node tools/theme-codemod.mjs <paths...>          rewrite, print a count per file
//   node tools/theme-codemod.mjs --check <paths...>  list files still carrying
//                                                    neutral literals (exit 1 if any)
//
// Paths may be files or folders (.ts, .tsx, .css inside). Each literal becomes
// `var(--token, #literal)`: the token's light value is the literal, so light is
// unchanged, and the fallback keeps a file readable on its own. Idempotent.
//
// What it touches: the zinc neutrals used as surfaces, text, borders and row
// dividers, plus the coloured text shades that fail 4.5:1 on a dark surface
// (only where they are `color`, `fill` or `stroke`). Brand, status, heat and
// chart fills keep their literal.
//
// How it reads context: for each literal it finds the innermost `{ ... }`
// block (an inline style object, a CSS rule) and looks at that block's own
// `background`. A block painted with a brand or status colour is an island
// and is left whole, so white text on a green button stays white. A block
// painted with the hero near-black (#141419) moves that fill to --ink-hero
// and pins its white text. Everything else converts.
//
// A line with `theme:keep` in it is skipped. Lines that paint a <canvas> or a
// map (fillStyle, strokeStyle, 'circle-color' ...) are skipped: CSS variables
// do not reach them.

import fs from 'node:fs';
import path from 'node:path';

// literal (lower case) -> token. Light token values equal these literals.
const NEUTRAL = {
  '#fff': '--surface', '#ffffff': '--surface',
  '#fafafa': '--canvas',
  '#f4f4f5': '--surface-2',
  '#f0f0f1': '--divider-2',
  '#e4e4e7': '--divider',
  '#d4d4d8': '--line',
  '#f2f4f8': '--page', '#f6f8fb': '--band', '#dde2ea': '--edge', '#e3e8ef': '--band-line',
  '#a1a1aa': '--subtle',
  '#71717a': '--meta',
  '#62626c': '--muted-2',
  '#52525b': '--muted',
  '#3f3f46': '--ink-3',
  '#27272a': '--ink-2',
  '#18181b': '--ink',
  '#1c1d1f': '--ink-deep',
  '#3c4043': '--ink-4', '#dadce0': '--line-2', '#fcfcfd': '--surface-1',
  // Soft status and accent fills that already have a token (light value is the
  // literal; dark is a translucent tint of the same hue, so the colour keeps its meaning).
  '#e7f8f1': '--mint-dim', '#e7f5ef': '--c-action-soft', '#f0faf5': '--c-genius-soft', '#a7dcc5': '--c-action-line',
  '#fef3c7': '--caution-soft', '#fee2e2': '--negative-soft', '#dcfce7': '--positive-soft',
  '#fff1ea': '--orange-soft', '#ffe9ec': '--c-talkr-soft', '#fdf2f8': '--c-lane-soft', '#fbcfe8': '--c-lane-line',
  '#eaf8f1': '--ok-bg', '#b4e3cd': '--ok-line', '#fff6df': '--warn-bg', '#f1d58a': '--warn-line',
  '#fdeeee': '--danger-bg', '#f4bdbd': '--danger-line', '#ecf2ff': '--info-bg', '#bfd2fa': '--info-line',
  '#d6f1e4': '--chip-ok', '#fbe7b0': '--chip-warn', '#f9d0d0': '--chip-danger', '#d5e2fd': '--chip-info',
  // The Tailwind pastels the screens use for status surfaces (tokens.css --tint-*).
  '#fef2f2': '--tint-red', '#fecaca': '--tint-red-2', '#fffbeb': '--tint-amber', '#fde68a': '--tint-amber-2',
  '#ecfdf5': '--tint-green', '#f0fdf4': '--tint-green-2', '#bbf7d0': '--tint-green-3', '#fff7ed': '--tint-orange',
  '#ffedd5': '--tint-orange-2', '#fed7aa': '--tint-orange-3', '#fecdd3': '--tint-rose', '#ede9fe': '--tint-violet',
  '#eff6ff': '--tint-blue', '#dbeafe': '--tint-blue-2', '#e0f2fe': '--tint-sky', '#fef9c3': '--tint-yellow',
};
const LIGHT = new Set(['#fff', '#ffffff', '#fafafa', '#f4f4f5', '#f0f0f1', '#e4e4e7', '#d4d4d8', '#f2f4f8', '#f6f8fb', '#dde2ea', '#e3e8ef', '#dadce0', '#fcfcfd']);
const HERO = '#141419';
const HERO_TOKEN = '--ink-hero';
const WHITE = new Set(['#fff', '#ffffff']);

// Coloured text shades: literal -> token (light value is the literal).
const TEXT = {
  '#0a8560': '--tx-mint', '#08694c': '--tx-mint-deep',
  '#15803d': '--tx-green', '#1f7a4d': '--tx-green-deep', '#0e7a57': '--tx-green-2',
  '#b91c1c': '--tx-red', '#991b1b': '--tx-red-deep', '#dc2626': '--tx-hot',
  '#b45309': '--tx-amber', '#92400e': '--tx-amber-deep',
  '#c2410c': '--tx-orange', '#9a3412': '--tx-orange-deep',
  '#1d4ed8': '--tx-blue', '#07345c': '--tx-navy', '#2563eb': '--tx-cold',
  '#0369a1': '--tx-sky', '#6d28d9': '--tx-violet', '#0f766e': '--tx-teal',
  '#0b6045': '--ok-ink', '#8a3f0a': '--warn-ink', '#a71d1d': '--danger-ink', '#1e40af': '--info-ink',
};

const TEXT_PROPS = new Set(['color', 'fill', 'stroke', 'caretcolor', 'caret-color', 'accentcolor', 'accent-color', '-webkit-text-fill-color', 'webkittextfillcolor', 'textdecorationcolor', 'text-decoration-color']);
const BG_PROPS = /\b(background(?:-?color|-?image)?|backgroundColor|backgroundImage)\s*[:=]/g;
const SKIP_LINE = /fillStyle|strokeStyle|'circle-|'line-color'|'fill-color'|'text-color'|'icon-color'|theme-color|themeColor|theme:keep/;
const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?![0-9a-fA-F\w-])|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)/g;
/** `rgb(r, g, b)` as six-digit lower-case hex; hex comes back lower-cased. */
const toHex = (lit) => {
  if (lit[0] === '#') return lit.toLowerCase();
  const [r, g, b] = lit.match(/\d{1,3}/g).map((n) => Math.min(255, +n));
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
};

const check = process.argv.includes('--check');
const args = process.argv.slice(2).filter((a) => a !== '--check');
if (!args.length) {
  console.error('usage: node tools/theme-codemod.mjs [--check] <file-or-folder>...');
  process.exit(2);
}

function* walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      yield* walk(path.join(p, n));
    }
  } else if (/\.(tsx?|css)$/.test(p) && !/\.test\.tsx?$/.test(p)) yield p;
}

/** The innermost `{ ... }` around index i, or null. Quoted text is skipped so a brace in a string does not count. */
function blockAround(src, i) {
  let depth = 0;
  let start = -1;
  for (let k = i - 1, n = 0; k >= 0 && n < 6000; k--, n++) {
    const c = src[k];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) { start = k; break; }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  let quote = null;
  for (let k = start + 1, n = 0; k < src.length && n < 6000; k++, n++) {
    const c = src[k];
    if (quote) { if (c === quote && src[k - 1] !== '\\') quote = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { if (depth === 0) return src.slice(start + 1, k); depth--; }
  }
  return null;
}

/** The value after `background:` up to the next `,` or `;` at depth 0 (quotes and brackets skipped). */
function valueAfter(text, from) {
  let depth = 0;
  let quote = null;
  let k = from;
  for (; k < text.length; k++) {
    const c = text[k];
    if (quote) { if (c === quote && text[k - 1] !== '\\') quote = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if ((c === ',' || c === ';') && depth === 0) break;
  }
  return text.slice(from, k);
}

/** { kind: 'normal' | 'island' | 'hero', fill: boolean } from the block's own background; fill says it paints a neutral. */
function classify(block) {
  if (block == null) return { kind: 'normal', fill: false };
  const hexes = [];
  let keywordOnly = true;
  let hasBg = false;
  for (const m of block.matchAll(BG_PROPS)) {
    hasBg = true;
    const v = valueAfter(block, m.index + m[0].length);
    const found = (v.match(HEX) || []).map(toHex);
    hexes.push(...found);
    const bare = v.replace(/['"`\s]/g, '');
    if (found.length === 0 && bare && !/^(transparent|none|inherit|unset|initial|var\(--(surface|canvas|page|band|inset|rail|trough|ink|divider|c-btn-bg|c-menu-bg|c-thead)[\w-]*\)|\$\{[^}]*\}|[a-zA-Z_.?:\s]+)$/.test(bare)) keywordOnly = false;
  }
  const fill = hexes.length > 0;
  if (!hasBg) return { kind: 'normal', fill };
  if (hexes.some((h) => h === HERO)) return { kind: 'hero', fill };
  const foreign = hexes.filter((h) => !(h in NEUTRAL));
  if (foreign.length) return { kind: 'island', fill };
  if (hexes.length === 0 && !keywordOnly) return { kind: 'island', fill };
  return { kind: 'normal', fill };
}

/** The property this literal is a value of ("color", "border", "fill" ...), or ''. */
function propBefore(src, i) {
  const lineStart = src.lastIndexOf('\n', i) + 1;
  const before = src.slice(Math.max(lineStart, i - 240), i);
  // The nearest `name:` / `name=` not inside the value we are in. Values are
  // quoted strings, so the last `name:` or `name=` before the opening quote wins.
  const q = Math.max(before.lastIndexOf('\''), before.lastIndexOf('"'), before.lastIndexOf('`'));
  // Inside a string that is itself CSS text (an attribute selector, a
  // template), the property is in the string: `[style*=';color:#0A8560']`.
  const inner = q >= 0 ? before.slice(q + 1).match(/([A-Za-z-]+)\s*:\s*[^:;]*$/) : null;
  if (inner) return inner[1].toLowerCase();
  const head = q >= 0 ? before.slice(0, q) : before;
  const m = head.match(/([A-Za-z-]+)\s*[:=]\s*(?:\{\s*)?(?:[^:=;,{]*)$/);
  return m ? m[1].toLowerCase() : '';
}

function convert(src) {
  let count = 0;
  // Earlier runs kept the literal's case; the selectors need lower case.
  src = src.replace(/(var\(--[\w-]+, )(#[0-9A-Fa-f]{3,6})(?=\))/g, (m, a, h) => a + h.toLowerCase());
  const out = src.replace(HEX, (lit, i) => {
    const low = toHex(lit);
    const isNeutral = low in NEUTRAL;
    const isText = low in TEXT;
    if (!isNeutral && !isText && low !== HERO) return lit;
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const lineEnd = src.indexOf('\n', i);
    const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
    if (SKIP_LINE.test(line)) return lit;
    if (/^\s*--[\w-]+\s*:/.test(line)) return lit; // a token definition (tokens.css)
    // An attribute selector ([style*='color:#71717a']) matches what React writes
    // into the style attribute. Sources that keep their literal still need
    // the old form, so the selector keeps it; surfaces.css carries the var()
    // twins by hand.
    if (/\[style[^\]]*$/.test(src.slice(Math.max(0, i - 160), i))) return lit;
    if (/var\(--[\w-]+,\s*$/.test(src.slice(Math.max(0, i - 40), i))) return lit; // already converted
    if (/^\s*(\/\/|\*|\/\*)/.test(line) && !/[:=]\s*['"`]/.test(line)) return lit; // a comment
    const block = blockAround(src, i);
    const { kind, fill } = classify(block);
    const prop = propBefore(src, i);
    const textProp = TEXT_PROPS.has(prop);
    let token = null;
    if (kind === 'island') return lit;
    if (kind === 'hero') {
      if (low === HERO) token = HERO_TOKEN;
      else if (WHITE.has(low) && textProp) token = '--on-dark';
      else return lit;
    } else if (low === HERO) {
      token = HERO_TOKEN;
    } else if (isText) {
      if (!textProp) return lit;
      token = TEXT[low];
    } else if (WHITE.has(low) && textProp) {
      // White text: on an ink fill it inverts with the fill; with no fill in
      // this block it sits on a coloured parent and must stay white.
      token = fill ? '--surface' : '--on-dark';
    } else {
      token = NEUTRAL[low];
    }
    count++;
    // Inside an attribute selector ([style*='color: rgb(113, 113, 122)']) the
    // rgb() form matched the browser's serialisation of a hex literal. The
    // browser keeps a var() fallback verbatim, so the selector must carry the
    // hex the source was written with.
    // The fallback is always the lower-case hex: React writes the value
    // verbatim into the style attribute, and the surfaces.css selectors that
    // match on it are generated from the same lower-case form.
    return `var(${token}, ${low})`;
  });
  return { out, count };
}

let total = 0;
const pending = [];
for (const a of args) {
  for (const f of walk(a)) {
    const src = fs.readFileSync(f, 'utf8');
    const { out, count } = convert(src);
    if (out === src) continue;
    total += count;
    if (check) pending.push(`${f}: ${count}`);
    else {
      fs.writeFileSync(f, out);
      console.log(`${f}: ${count}`);
    }
  }
}
if (check) {
  if (pending.length) {
    console.log(pending.join('\n'));
    console.log(`${pending.length} file(s) still carry neutral literals (${total}). Run without --check to convert.`);
    process.exit(1);
  }
  console.log('clean: no neutral literals left');
} else console.log(`converted ${total} literal(s)`);
