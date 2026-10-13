// Converts the Claude Design "DC" template (sc-for / sc-if / {{ }}) into React JSX.
// The prototype's inline styles are preserved verbatim so the port stays pixel-faithful;
// style-hover / style-focus become generated CSS rules instead.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.argv[2];
const OUTDIR = process.argv[3];

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'path', 'line', 'circle', 'polyline', 'polygon', 'rect', 'ellipse', 'use', 'stop', 'area', 'col', 'source']);

// ---------- parse ----------
function parse(src) {
  let i = 0;
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end).trim();
      // pop to matching tag
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      i = end + 1;
      continue;
    }
    // open tag — find the closing '>' that is not inside a quoted attribute value
    let j = lt + 1, quote = null;
    while (j < src.length) {
      const ch = src[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    const raw = src.slice(lt + 1, j);
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body);
    const tag = m[1];
    const attrs = parseAttrs(body.slice(tag.length));
    const node = { tag, attrs, children: [] };
    top().children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
    i = j + 1;
  }
  return root;

  function pushText(t) {
    if (!t) return;
    top().children.push({ tag: '#text', text: t });
  }
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    if (!m[1]) continue;
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
  }
  return attrs;
}

// ---------- expressions ----------
const LITERAL = /^(true|false|null|undefined|-?\d+(\.\d+)?)$/;

function expr(raw, scope) {
  let e = raw.trim();
  // isStep.0 -> isStep[0]
  e = e.replace(/\.(\d+)\b/g, '[$1]');
  if (LITERAL.test(e)) return e;
  const rootId = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(e);
  if (!rootId) return e;
  if (scope.has(rootId[0])) return e;
  return 'V.' + e;
}

const BIND = /\{\{([^}]*)\}\}/g;

function hasBinding(s) { return /\{\{/.test(s); }

// A whole attribute value that is exactly one binding -> raw expression.
function soleBinding(v) {
  const m = /^\s*\{\{([^}]*)\}\}\s*$/.exec(v);
  return m ? m[1] : null;
}

// Mixed text/binding -> a template literal.
function templateLit(v, scope) {
  let out = '`';
  let last = 0;
  BIND.lastIndex = 0;
  let m;
  while ((m = BIND.exec(v))) {
    out += escTpl(v.slice(last, m.index));
    out += '${' + expr(m[1], scope) + '}';
    last = m.index + m[0].length;
  }
  out += escTpl(v.slice(last)) + '`';
  return out;
}

function escTpl(s) { return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${'); }

// ---------- styles ----------
function splitDecls(css) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of css) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function splitDecl(d) {
  const idx = d.indexOf(':');
  if (idx === -1) return null;
  return [d.slice(0, idx).trim(), d.slice(idx + 1).trim()];
}

function cssPropToJs(p) {
  if (p.startsWith('--')) return `'${p}'`;
  return p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function styleObject(css, scope) {
  const parts = [];
  for (const d of splitDecls(css)) {
    const kv = splitDecl(d);
    if (!kv) continue;
    const [prop, value] = kv;
    const key = cssPropToJs(prop);
    const sole = soleBinding(value);
    let v;
    if (sole !== null) v = expr(sole, scope);
    else if (hasBinding(value)) v = templateLit(value, scope);
    else v = JSON.stringify(value);
    parts.push(`${key}: ${v}`);
  }
  return '{' + parts.join(', ') + '}';
}

// ---------- attribute name mapping ----------
const ATTR_MAP = {
  class: 'className',
  for: 'htmlFor',
  contenteditable: 'contentEditable',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  autocomplete: 'autoComplete',
  spellcheck: 'spellCheck',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  srcset: 'srcSet',
  crossorigin: 'crossOrigin',
};

// React types these as numbers rather than strings.
const NUMERIC_ATTRS = new Set(['rows', 'cols', 'tabIndex', 'span', 'maxLength', 'minLength', 'colSpan', 'rowSpan']);

function attrName(n) {
  if (ATTR_MAP[n]) return ATTR_MAP[n];
  if (n.startsWith('data-') || n.startsWith('aria-')) return n;
  if (n.includes('-')) return n.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return n;
}

// ---------- CSS class generation for hover/focus ----------
const cssRules = [];
let cssSeq = 0;
const cssCache = new Map();

function pseudoClass(decls) {
  const key = JSON.stringify(decls);
  if (cssCache.has(key)) return cssCache.get(key);
  const cls = 'dc' + ++cssSeq;
  for (const [pseudo, css] of decls) {
    const body = splitDecls(css).map((d) => {
      const kv = splitDecl(d);
      return kv ? `${kv[0]}:${kv[1]} !important` : null;
    }).filter(Boolean).join(';');
    cssRules.push(`.${cls}:${pseudo}{${body}}`);
  }
  cssCache.set(key, cls);
  return cls;
}

// ---------- emit ----------
function emitChildren(node, scope, indent) {
  const parts = [];
  for (const c of node.children) {
    const s = emit(c, scope, indent);
    if (s) parts.push(s);
  }
  return parts;
}

function emitText(text, scope, indent) {
  // Collapse pure whitespace between elements.
  if (!text.trim()) return null;
  if (!hasBinding(text)) {
    const t = text.replace(/\s+/g, ' ');
    return indent + jsxText(t);
  }
  const out = [];
  let last = 0, m;
  BIND.lastIndex = 0;
  while ((m = BIND.exec(text))) {
    const before = text.slice(last, m.index);
    if (before.trim()) out.push(jsxText(before.replace(/\s+/g, ' ')));
    else if (/\s/.test(before) && out.length) out.push("{' '}");
    out.push('{' + expr(m[1], scope) + '}');
    last = m.index + m[0].length;
  }
  const after = text.slice(last);
  if (after.trim()) out.push(jsxText(after.replace(/\s+/g, ' ')));
  return indent + out.join('');
}

function jsxText(t) {
  // Braces and angle brackets are JSX syntax; quotes and apostrophes are legal
  // but trip react/no-unescaped-entities. Emit all of them as string literals.
  if (/[{}<>'"]/.test(t)) return '{' + JSON.stringify(t) + '}';
  return t;
}

function emit(node, scope, indent) {
  if (node.tag === '#text') return emitText(node.text, scope, indent);

  if (node.tag === 'sc-for') {
    const listRaw = soleBinding(node.attrs.list || '');
    const as = node.attrs.as || 'item';
    const inner = new Set(scope);
    inner.add(as);
    const kids = emitChildren(node, inner, indent + '  ');
    const list = listRaw === null ? '[]' : expr(listRaw, scope);
    return `${indent}{(${list} || []).map((${as}, ${as}__i) => (\n${indent}  <React.Fragment key={${as}__i}>\n${kids.join('\n')}\n${indent}  </React.Fragment>\n${indent}))}`;
  }

  if (node.tag === 'sc-if') {
    const valRaw = soleBinding(node.attrs.value || '');
    const cond = valRaw === null ? 'false' : expr(valRaw, scope);
    const kids = emitChildren(node, scope, indent + '  ');
    return `${indent}{(${cond}) ? (\n${indent}  <>\n${kids.join('\n')}\n${indent}  </>\n${indent}) : null}`;
  }

  if (node.tag === 'x-import') {
    const full = node.attrs['component-from-global-scope'] || '';
    const comp = full.split('.').pop();
    const props = [];
    for (const [k, v] of Object.entries(node.attrs)) {
      if (k === 'component-from-global-scope' || k.startsWith('hint-')) continue;
      const name = k === 'on-change' ? 'onChange' : attrName(k);
      const sole = soleBinding(v);
      if (sole !== null) props.push(`${name}={${expr(sole, scope)}}`);
      else if (hasBinding(v)) props.push(`${name}={${templateLit(v, scope)}}`);
      else props.push(`${name}=${JSON.stringify(v)}`);
    }
    const kids = emitChildren(node, scope, indent + '  ');
    if (!kids.length) return `${indent}<${comp} ${props.join(' ')} />`;
    return `${indent}<${comp} ${props.join(' ')}>\n${kids.join('\n')}\n${indent}</${comp}>`;
  }

  // regular element
  const tag = node.tag;
  const props = [];
  const pseudo = [];
  let styleCss = null;

  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.startsWith('hint-')) continue;
    if (k === 'style') { styleCss = v; continue; }
    if (k === 'style-hover') { pseudo.push(['hover', v]); continue; }
    if (k === 'style-focus') { pseudo.push(['focus-within', v]); pseudo.push(['focus', v]); continue; }
    if (k === 'style-active') { pseudo.push(['active', v]); continue; }

    // The prototype's only `ref` binding exists to focus the ⌘K search input
    // when it mounts. React's autoFocus does that without a callback ref —
    // which also keeps the view-model free of ref values.
    if (k === 'ref') { props.push('autoFocus'); continue; }

    const name = attrName(k);
    const sole = soleBinding(v);
    if (sole !== null) {
      let e = expr(sole, scope);
      if (name === 'checked') e = `!!(${e})`;
      props.push(`${name}={${e}}`);
    } else if (hasBinding(v)) {
      props.push(`${name}={${templateLit(v, scope)}}`);
    } else if (v === '') {
      props.push(name);
    } else if (NUMERIC_ATTRS.has(name) && /^-?\d+$/.test(v)) {
      props.push(`${name}={${v}}`);
    } else {
      props.push(`${name}=${JSON.stringify(v)}`);
    }
  }

  if (pseudo.length) props.unshift(`className=${JSON.stringify(pseudoClass(pseudo))}`);
  if (styleCss !== null) props.push(`style={${styleObject(styleCss, scope)}}`);

  // React needs a value/onChange pair or readOnly; the prototype always supplies onChange
  // where it binds a value, except for the few display-only fields.
  const hasValue = props.some((p) => p.startsWith('value='));
  const hasOnChange = props.some((p) => p.startsWith('onChange='));
  if (hasValue && !hasOnChange) props.push('readOnly');
  if (props.some((p) => p.startsWith('checked=')) && !hasOnChange) props.push('readOnly');

  const open = `<${tag}${props.length ? ' ' + props.join(' ') : ''}`;

  if (VOID.has(tag)) {
    // The design pins exact pixel sizes for its art; next/image's layout
    // behaviour would change it, so plain <img> is deliberate here.
    if (tag === 'img') return `${indent}{/* eslint-disable-next-line @next/next/no-img-element */}\n${indent}${open} />`;
    return `${indent}${open} />`;
  }

  // textarea: value must be a prop, never a child
  const kids = emitChildren(node, scope, indent + '  ').filter(Boolean);
  if (!kids.length) return `${indent}${open}></${tag}>`;
  return `${indent}${open}>\n${kids.join('\n')}\n${indent}</${tag}>`;
}

// ---------- run ----------
const src = readFileSync(SRC, 'utf8');
const tree = parse(src);
const rootDiv = tree.children.find((c) => c.tag === 'div');

// Split each screen (an sc-if wrapping a single <section data-screen-label>) into its own file.
const screens = [];
function screenName(label) {
  return label.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase());
}

function extractScreens(node) {
  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    if (c.tag === 'sc-if') {
      const el = c.children.find((k) => k.tag !== '#text');
      const label = el && el.attrs && el.attrs['data-screen-label'];
      if (label && el.tag === 'section') {
        const name = screenName(label);
        screens.push({ name, node: el, cond: soleBinding(c.attrs.value) });
        c.children = [{ tag: '#screen', name }];
        continue;
      }
    }
    if (c.children) extractScreens(c);
  }
}

// custom emitter hook for the placeholder
const origEmit = emit;
function emitWrapped(node, scope, indent) {
  if (node.tag === '#screen') return `${indent}<${node.name} V={V} />`;
  return origEmit(node, scope, indent);
}
// rebind (emit is referenced internally through the module-level name)
emit = emitWrapped;

extractScreens(rootDiv);

mkdirSync(join(OUTDIR, 'screens'), { recursive: true });

const header = (imports) => `// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React from 'react';
${imports}
`;

// The prototype referenced bundled art as `public/x.png`; Next serves that at `/x.png`.
//
// Nullable view-model fields the template only ever reads inside a sibling
// `sc-if` guard (hasAiAnswer / hasAccepted / isCall). TypeScript can't correlate
// the guard with the access, so assert non-null at the access site.
const GUARDED = [
  ['V.aiAnswer.', 'V.aiAnswer!.'],
  ['V.acceptedOffer.', 'V.acceptedOffer!.'],
  ['t.ai.', 't.ai!.'],
];

const fixAssets = (src) => {
  let out = src.replace(/(["'(])public\//g, '$1/');
  for (const [from, to] of GUARDED) out = out.split(from).join(to);
  return out;
};

const dsUsed = new Set();
for (const s of screens) {
  const body = emit(s.node, new Set(), '    ');
  const usesDs = /<(OfferHero|ExitSelector|ConditionBadge)\b/.test(body);
  if (usesDs) {
    for (const m of body.matchAll(/<(OfferHero|ExitSelector|ConditionBadge)\b/g)) dsUsed.add(m[1]);
  }
  const dsNames = ['OfferHero', 'ExitSelector', 'ConditionBadge'].filter((n) => new RegExp(`<${n}\\b`).test(body));
  const imports = [`import type { ClozrView } from '@/app/clozr/view';`]
    .concat(dsNames.length ? [`import { ${dsNames.join(', ')} } from '@/components/ds';`] : [])
    .join('\n');
  const file = `${header(imports)}
export function ${s.name}({ V }: { V: ClozrView }) {
  return (
${body}
  );
}
`;
  writeFileSync(join(OUTDIR, 'screens', `${s.name}.tsx`), fixAssets(file));
}

// The shell takes children so the app can mount extra (live-data) screens in
// the main area without hand-editing generated code.
const shellBody = emit(rootDiv, new Set(), '    ').replace(/\n(\s*)<\/main>/, '\n$1  {children}\n$1</main>');
const shellImports = [
  `import type { ClozrView } from '@/app/clozr/view';`,
  ...screens.map((s) => `import { ${s.name} } from './screens/${s.name}';`),
].join('\n');

writeFileSync(join(OUTDIR, 'ClozrShell.tsx'), fixAssets(`${header(shellImports)}
export function ClozrShell({ V, children }: { V: ClozrView; children?: React.ReactNode }) {
  return (
${shellBody}
  );
}
`));

writeFileSync(join(OUTDIR, 'clozr.css'), `/* Generated hover/focus styles for the CLOZR prototype port. */\n${cssRules.join('\n')}\n`);

console.log('screens:', screens.map((s) => s.name).join(', '));
console.log('css rules:', cssRules.length);
