// Field logic PandaDoc has and Clozr did not: radio groups, checkbox groups,
// conditional show/require, formulas, email/phone/pattern validation, file
// fields and stamps. Pure functions, no I/O, so the signing page (browser) and
// the edge functions (Deno) run the exact same rules. Copy this file into the
// app at lib/docs/field-logic.ts as well.

export type ParityFieldType =
  | 'signature' | 'initials' | 'date_signed' | 'text' | 'number' | 'currency' | 'date' | 'checkbox' | 'dropdown'
  | 'radio' | 'attachment' | 'stamp' | 'formula' | 'email' | 'phone';

export const PARITY_FIELD_META: Record<ParityFieldType, { label: string; w: number; h: number; signs: boolean; fillable: boolean }> = {
  signature: { label: 'Signature', w: 170, h: 34, signs: true, fillable: true },
  initials: { label: 'Initials', w: 54, h: 28, signs: true, fillable: true },
  date_signed: { label: 'Date signed', w: 90, h: 18, signs: true, fillable: false },
  text: { label: 'Text', w: 150, h: 18, signs: false, fillable: true },
  number: { label: 'Number', w: 80, h: 18, signs: false, fillable: true },
  currency: { label: 'Currency', w: 96, h: 18, signs: false, fillable: true },
  date: { label: 'Date', w: 90, h: 18, signs: false, fillable: true },
  checkbox: { label: 'Checkbox', w: 13, h: 13, signs: false, fillable: true },
  dropdown: { label: 'Dropdown', w: 130, h: 18, signs: false, fillable: true },
  radio: { label: 'Radio', w: 13, h: 13, signs: false, fillable: true },
  attachment: { label: 'Collect file', w: 130, h: 22, signs: false, fillable: true },
  stamp: { label: 'Stamp', w: 110, h: 110, signs: true, fillable: true },
  formula: { label: 'Formula', w: 96, h: 18, signs: false, fillable: false },
  email: { label: 'Email', w: 170, h: 18, signs: false, fillable: true },
  phone: { label: 'Phone', w: 110, h: 18, signs: false, fillable: true },
};

export type ConditionOp = 'eq' | 'neq' | 'filled' | 'empty' | 'checked' | 'unchecked' | 'gt' | 'lt';
export type Condition = { field: string; op: ConditionOp; value?: string | number | null };
export type Conditions = { all?: Condition[]; any?: Condition[]; action?: 'show' | 'require' } | null;

export type ParityValidation = {
  min?: number | null; max?: number | null; maxLength?: number | null;
  /** A JS regex source, anchored for you. Max 200 chars. */
  pattern?: string | null; patternMessage?: string | null;
  /** Checkbox groups: how many of the group must be ticked. */
  minChecked?: number | null; maxChecked?: number | null;
};

export type LogicField = {
  id: number | string;
  field_key?: string | null;
  group_key?: string | null;
  type: ParityFieldType;
  signer_id?: number | null;
  role?: string | null;
  required?: boolean | null;
  read_only?: boolean | null;
  variable_key?: string | null;
  label?: string | null;
  value?: string | null;
  options?: string[] | null;
  validation?: ParityValidation | null;
  conditions?: Conditions;
  formula?: string | null;
  page?: number;
};

const blank = (v: unknown) => v == null || String(v).trim() === '';

/** Matches pdf-fields effectiveReadOnly (keep in sync). */
function signerMayEdit(f: LogicField): boolean {
  if (f.type === 'date_signed' || f.type === 'formula') return false;
  if (!f.read_only) return true;
  if (f.variable_key && (f.type === 'text' || f.type === 'date' || f.type === 'email' || f.type === 'phone')) return true;
  return false;
}
const keyOf = (f: LogicField) => String(f.field_key || f.id);

/** Value lookup by field_key (radio groups resolve to the chosen option). */
export function valueMap(fields: LogicField[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of fields) {
    if (f.type === 'radio' && f.group_key) {
      if (String(f.value ?? '') === 'true') m.set(f.group_key, String(f.label ?? f.options?.[0] ?? 'true'));
      else if (!m.has(f.group_key)) m.set(f.group_key, '');
      continue;
    }
    m.set(keyOf(f), String(f.value ?? ''));
  }
  return m;
}

function test(c: Condition, vals: Map<string, string>): boolean {
  const v = vals.get(c.field) ?? '';
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  const target = c.value == null ? '' : String(c.value);
  switch (c.op) {
    case 'eq': return v.trim().toLowerCase() === target.trim().toLowerCase();
    case 'neq': return v.trim().toLowerCase() !== target.trim().toLowerCase();
    case 'filled': return !blank(v);
    case 'empty': return blank(v);
    case 'checked': return v === 'true';
    case 'unchecked': return v !== 'true';
    case 'gt': return Number.isFinite(n) && n > Number(target);
    case 'lt': return Number.isFinite(n) && n < Number(target);
    default: return true;
  }
}

/** Does the condition hold? No conditions means always. */
export function conditionHolds(cond: Conditions | undefined, vals: Map<string, string>): boolean {
  if (!cond) return true;
  const all = cond.all ?? [];
  const any = cond.any ?? [];
  if (all.length && !all.every((c) => test(c, vals))) return false;
  if (any.length && !any.some((c) => test(c, vals))) return false;
  return true;
}

/** Is this field on screen? A "show" field whose condition fails is hidden and skipped. */
export function isVisible(f: LogicField, vals: Map<string, string>): boolean {
  if (!f.conditions || (f.conditions.action ?? 'show') !== 'show') return true;
  return conditionHolds(f.conditions, vals);
}

/** Required right now: required and visible, or a "require" condition that holds. */
export function isRequiredNow(f: LogicField, vals: Map<string, string>): boolean {
  if (!isVisible(f, vals)) return false;
  if (f.conditions && f.conditions.action === 'require') return conditionHolds(f.conditions, vals);
  return !!f.required;
}

// ------------------------------------------------------------------ formulas
// Grammar: numbers, {field_key} references, + - * / ( ), and round(x, n),
// min(a,b), max(a,b). No eval: a tiny recursive-descent parser.
type Tok = { t: 'num'; v: number } | { t: 'ref'; v: string } | { t: 'op'; v: string } | { t: 'fn'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw new Error('unclosed {');
      out.push({ t: 'ref', v: src.slice(i + 1, j).replace(/^\{|\}$/g, '').trim() });
      i = j + 1;
      if (src[i] === '}') i++; // tolerate {{var}}
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j; continue;
    }
    if (/[a-z]/i.test(ch)) {
      let j = i;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      const name = src.slice(i, j).toLowerCase();
      if (!['round', 'min', 'max', 'abs'].includes(name)) throw new Error(`unknown function ${name}`);
      out.push({ t: 'fn', v: name });
      i = j; continue;
    }
    if ('+-*/(),'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new Error(`unexpected ${ch}`);
  }
  return out;
}

export function evalFormula(src: string, lookup: (key: string) => number): number {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p++];
    if (!t || (v && t.v !== v)) throw new Error(`expected ${v ?? 'token'}`);
    return t;
  };
  const expr = (): number => {
    let v = term();
    while (peek()?.t === 'op' && (peek()!.v === '+' || peek()!.v === '-')) v = eat().v === '+' ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek()?.t === 'op' && (peek()!.v === '*' || peek()!.v === '/')) {
      const op = eat().v; const r = factor();
      v = op === '*' ? v * r : (r === 0 ? 0 : v / r);
    }
    return v;
  };
  const factor = (): number => {
    const t = peek();
    if (!t) throw new Error('unexpected end');
    if (t.t === 'op' && t.v === '-') { eat(); return -factor(); }
    if (t.t === 'op' && t.v === '(') { eat('('); const v = expr(); eat(')'); return v; }
    if (t.t === 'num') { eat(); return t.v as number; }
    if (t.t === 'ref') { eat(); return lookup(String(t.v)); }
    if (t.t === 'fn') {
      eat(); eat('(');
      const args = [expr()];
      while (peek()?.v === ',') { eat(','); args.push(expr()); }
      eat(')');
      switch (t.v) {
        case 'round': { const d = Math.max(0, Math.min(6, args[1] ?? 0)); const k = 10 ** d; return Math.round(args[0] * k) / k; }
        case 'min': return Math.min(...args);
        case 'max': return Math.max(...args);
        case 'abs': return Math.abs(args[0]);
      }
    }
    throw new Error('bad expression');
  };
  const v = expr();
  if (p !== toks.length) throw new Error('trailing input');
  return Number.isFinite(v) ? v : 0;
}

/** Recompute every formula field from the others (and variables). Returns id → new value. */
export function computeFormulas(fields: LogicField[], vars: Record<string, string | number | null | undefined> = {}): Map<LogicField['id'], string> {
  const vals = valueMap(fields);
  const num = (k: string) => {
    const raw = vals.has(k) ? vals.get(k) : vars[k];
    const n = Number(String(raw ?? '').replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const out = new Map<LogicField['id'], string>();
  // Two passes so a formula may depend on another formula.
  for (let pass = 0; pass < 2; pass++) {
    for (const f of fields) {
      if (f.type !== 'formula' || !f.formula) continue;
      try {
        const v = evalFormula(f.formula, num);
        const s = String(Math.round(v * 100) / 100);
        out.set(f.id, s);
        vals.set(keyOf(f), s);
      } catch { out.set(f.id, ''); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- validation
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (s: string) => s.replace(/\D/g, '');

/** Extra checks on top of pdf-fields.ts validateValue (which still runs for the base types). */
export function validateParity(f: LogicField, raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  const label = f.label || PARITY_FIELD_META[f.type]?.label || 'Field';
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return { ok: true, value: null };
  switch (f.type) {
    case 'email':
      return EMAIL.test(s) ? { ok: true, value: s.toLowerCase() } : { ok: false, error: `${label}: enter a valid email.` };
    case 'phone': {
      const d = digits(s);
      if (d.length === 10) return { ok: true, value: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` };
      if (d.length === 11 && d.startsWith('1')) return { ok: true, value: `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` };
      return { ok: false, error: `${label}: enter a 10 digit phone number.` };
    }
    case 'radio':
      return s === 'true' || s === '' ? { ok: true, value: s || null } : { ok: false, error: `${label}: invalid choice.` };
    case 'attachment':
      return /^\d+$/.test(s) ? { ok: true, value: s } : { ok: false, error: `${label}: upload the file again.` };
    case 'stamp':
      return s.startsWith('data:image/png;base64,') && s.length < 600_000 ? { ok: true, value: s } : { ok: false, error: `${label}: the stamp image is invalid.` };
    case 'formula':
      return { ok: false, error: `${label} is calculated for you.` };
  }
  const pat = f.validation?.pattern;
  if (pat && pat.length <= 200) {
    try {
      if (!new RegExp(`^(?:${pat})$`).test(s)) return { ok: false, error: f.validation?.patternMessage || `${label} is not in the right format.` };
    } catch { /* a bad pattern in the template should not block signing */ }
  }
  return { ok: true, value: s };
}

/** When one radio in a group is chosen, every sibling is cleared. Returns the siblings to clear. */
export function radioSiblings(fields: LogicField[], chosen: LogicField): LogicField[] {
  if (chosen.type !== 'radio' || !chosen.group_key) return [];
  return fields.filter((f) => f.id !== chosen.id && f.type === 'radio' && f.group_key === chosen.group_key && f.signer_id === chosen.signer_id);
}

/**
 * What still blocks this recipient from finishing, with conditions, radio
 * groups and checkbox-group counts applied. Replaces pdf-contracts.ts
 * missingRequired for the new types.
 */
export function blockers(all: LogicField[], signerId: number): Array<{ id: LogicField['id']; page?: number; label: string; reason: string }> {
  const vals = valueMap(all);
  const mine = all.filter((f) => f.signer_id === signerId);
  const out: Array<{ id: LogicField['id']; page?: number; label: string; reason: string }> = [];
  const groupsSeen = new Set<string>();
  for (const f of mine) {
    if (!signerMayEdit(f)) continue;
    if (!isVisible(f, vals)) continue;
    if (f.group_key && (f.type === 'radio' || f.type === 'checkbox')) {
      if (groupsSeen.has(f.group_key)) continue;
      groupsSeen.add(f.group_key);
      const group = mine.filter((g) => g.group_key === f.group_key && g.type === f.type && isVisible(g, vals));
      const ticked = group.filter((g) => String(g.value ?? '') === 'true').length;
      const req = group.some((g) => isRequiredNow(g, vals));
      const min = f.type === 'radio' ? (req ? 1 : 0) : Math.max(req ? 1 : 0, Number(f.validation?.minChecked ?? 0));
      const max = f.type === 'radio' ? 1 : Number(f.validation?.maxChecked ?? Infinity);
      if (ticked < min) out.push({ id: f.id, page: f.page, label: f.label || f.group_key, reason: f.type === 'radio' ? 'choose one' : `tick at least ${min}` });
      else if (ticked > max) out.push({ id: f.id, page: f.page, label: f.label || f.group_key, reason: `tick at most ${max}` });
      continue;
    }
    if (isRequiredNow(f, vals) && blank(f.value)) out.push({ id: f.id, page: f.page, label: f.label || PARITY_FIELD_META[f.type]?.label || 'Field', reason: 'required' });
  }
  return out;
}

/** Fields hidden by a failed "show" condition are drawn blank on the final PDF. */
export function hiddenAtCompletion(all: LogicField[]): Set<LogicField['id']> {
  const vals = valueMap(all);
  return new Set(all.filter((f) => !isVisible(f, vals)).map((f) => f.id));
}

/** Guided signing: the next field this recipient has to touch, in page then reading order. */
export function nextField(all: LogicField[] & Array<{ y?: number; x?: number }>, signerId: number): LogicField | null {
  const open = blockers(all, signerId);
  if (!open.length) return null;
  const ids = new Set(open.map((o) => o.id));
  const ordered = all.filter((f) => ids.has(f.id))
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || ((a as { y?: number }).y ?? 0) - ((b as { y?: number }).y ?? 0) || ((a as { x?: number }).x ?? 0) - ((b as { x?: number }).x ?? 0));
  return ordered[0] ?? null;
}
