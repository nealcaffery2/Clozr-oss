// Fields placed on an uploaded PDF (TREC forms, county forms): what they are,
// where they sit, what a valid value looks like, and how they are drawn onto
// the page when the contract completes. No I/O: tools/pdf-fields.test.ts
// covers it; the contracts and esign functions, the field editor and the
// signing page all use it.
//
// Coordinates
//   x, y, w, h are fractions (0..1) of the page AS IT IS DISPLAYED — pdf.js's
//   viewport, which applies the page's /Rotate — measured from the top-left
//   corner. One number works at any zoom, on any screen, and for the
//   flattener, which maps it back to PDF points (bottom-left origin, crop box,
//   rotation undone) with toPdfPoint().
//
// Values are stored canonically and formatted only for display:
//   text → as typed · number, currency → "85000.5" · date → "2026-10-21"
//   checkbox → "true" or "" · dropdown → one of options
//   signature, initials → a PNG data URL · date_signed → "2026-10-21", set by
//   the server at the moment the signer finishes

import { type Conditions, validateParity } from './parity/field-logic.ts';
import { defaultFormat, type Vars } from './doc-vars.ts';

export type FieldType = 'signature' | 'initials' | 'date_signed' | 'text' | 'number' | 'currency' | 'date' | 'checkbox' | 'dropdown'
  // PandaDoc parity (migration 179): validated by parity/field-logic.ts validateParity
  | 'radio' | 'attachment' | 'stamp' | 'formula' | 'email' | 'phone';
export const FIELD_TYPES: FieldType[] = ['signature', 'initials', 'date_signed', 'text', 'number', 'currency', 'date', 'checkbox', 'dropdown', 'radio', 'attachment', 'stamp', 'formula', 'email', 'phone'];

/** Palette label and default size in PDF points (a Letter page is 612 × 792). */
export const FIELD_META: Record<FieldType, { label: string; w: number; h: number; signs: boolean }> = {
  signature: { label: 'Signature', w: 170, h: 34, signs: true },
  initials: { label: 'Initials', w: 54, h: 28, signs: true },
  date_signed: { label: 'Date signed', w: 90, h: 18, signs: true },
  text: { label: 'Text', w: 150, h: 18, signs: false },
  number: { label: 'Number', w: 80, h: 18, signs: false },
  currency: { label: 'Currency', w: 96, h: 18, signs: false },
  date: { label: 'Date', w: 90, h: 18, signs: false },
  checkbox: { label: 'Checkbox', w: 13, h: 13, signs: false },
  dropdown: { label: 'Dropdown', w: 130, h: 18, signs: false },
  radio: { label: 'Radio', w: 13, h: 13, signs: false },
  attachment: { label: 'Collect file', w: 130, h: 22, signs: false },
  stamp: { label: 'Stamp', w: 110, h: 110, signs: true },
  formula: { label: 'Formula', w: 96, h: 18, signs: false },
  email: { label: 'Email', w: 170, h: 18, signs: false },
  phone: { label: 'Phone', w: 110, h: 18, signs: false },
};

export type Validation = {
  min?: number | null; max?: number | null; maxLength?: number | null;
  /** A regex the whole value must match, and what to say when it does not. */
  pattern?: string | null; patternMessage?: string | null;
  /** Checkbox groups: how many must be ticked. */
  minChecked?: number | null; maxChecked?: number | null;
};

/** One field as the editor and the tables hold it. */
export type FieldDef = {
  id?: number | string | null;
  /** Template role this field belongs to (templates), or the signer's role (contracts). */
  role: string;
  type: FieldType;
  page: number;
  x: number; y: number; w: number; h: number;
  required?: boolean;
  read_only?: boolean;
  label?: string | null;
  default_value?: string | null;
  /** A Clozr Docs variable (doc-vars.ts), e.g. deal.purchase_price: pre-filled and read-only. */
  variable_key?: string | null;
  options?: string[] | null;
  validation?: Validation | null;
  /** Stable name other fields' conditions and formulas use ({price}). */
  field_key?: string | null;
  /** Radios with one group_key are one question; checkboxes with one form a group. */
  group_key?: string | null;
  /** Show or require this field only when the condition holds (parity/field-logic.ts). */
  conditions?: Conditions;
  /** Formula fields: "{gross} * {pct} / 100"; calculated, never typed. */
  formula?: string | null;
  placeholder?: string | null;
  /** On a draft contract: what the field holds now (from the record, or typed by the sender while preparing it). */
  value?: string | null;
};

/** A contract field: bound to one signer, and possibly filled. */
export type ContractField = FieldDef & {
  id: number;
  signer_id: number;
  value?: string | null;
  filled_at?: string | null;
};

/** Distinct, print-friendly colors per recipient, in signing order. */
export const RECIPIENT_COLORS = ['#2563eb', '#d97706', '#9333ea', '#0d9488', '#db2777', '#65a30d', '#dc2626', '#0891b2'];
export const recipientColor = (index: number) => RECIPIENT_COLORS[((index % RECIPIENT_COLORS.length) + RECIPIENT_COLORS.length) % RECIPIENT_COLORS.length];

/** Form fillers type values in; they never sign, so no signature, initials or date-signed boxes. */
export const fieldAllowedFor = (type: FieldType, recipientType: string | null | undefined) =>
  !(String(recipientType ?? 'signer') === 'filler' && FIELD_META[type].signs);

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const MIN_SIDE = 0.004;

/** Keep a box on its page and at least a few points across. */
export function clampRect(r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const w = Math.min(1, Math.max(MIN_SIDE, Number.isFinite(r.w) ? r.w : MIN_SIDE));
  const h = Math.min(1, Math.max(MIN_SIDE, Number.isFinite(r.h) ? r.h : MIN_SIDE));
  const x = Math.min(1 - w, clamp01(Number.isFinite(r.x) ? r.x : 0));
  const y = Math.min(1 - h, clamp01(Number.isFinite(r.y) ? r.y : 0));
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/** A new field of `type`, centered on the drop point, sized from points to page fractions. */
export function newField(type: FieldType, role: string, page: number, at: { x: number; y: number }, pageSize: { width: number; height: number }): FieldDef {
  const m = FIELD_META[type];
  const w = m.w / Math.max(1, pageSize.width);
  const h = m.h / Math.max(1, pageSize.height);
  return { role, type, page, ...clampRect({ x: at.x - w / 2, y: at.y - h / 2, w, h }), required: type !== 'checkbox', read_only: false, options: type === 'dropdown' ? ['Option 1', 'Option 2'] : null };
}

/**
 * Check a field coming from the editor. Returns the cleaned field, or what is
 * wrong with it. `pages` is the document's page count when known.
 */
export function normalizeField(raw: unknown, pages?: number | null): { ok: true; field: FieldDef } | { ok: false; error: string } {
  const f = (raw ?? {}) as Record<string, unknown>;
  const type = String(f.type ?? '') as FieldType;
  if (!FIELD_TYPES.includes(type)) return { ok: false, error: `unknown field type "${String(f.type ?? '')}"` };
  const role = String(f.role ?? '').trim();
  if (!role) return { ok: false, error: 'every field needs a recipient' };
  const page = Math.floor(Number(f.page));
  if (!Number.isFinite(page) || page < 1 || (pages && page > pages)) return { ok: false, error: `field is on page ${String(f.page)}, which the document does not have` };
  const nums = ['x', 'y', 'w', 'h'].map((k) => Number(f[k]));
  if (nums.some((n) => !Number.isFinite(n))) return { ok: false, error: 'field position is not a number' };
  const rect = clampRect({ x: nums[0], y: nums[1], w: nums[2], h: nums[3] });
  const variable = typeof f.variable_key === 'string' && /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(f.variable_key) ? f.variable_key : null;
  if (variable && FIELD_META[type].signs) return { ok: false, error: 'a signature, initials or date-signed field cannot be bound to a variable' };
  let options: string[] | null = null;
  if (type === 'dropdown') {
    options = Array.from(new Set((Array.isArray(f.options) ? f.options : []).map((o) => String(o ?? '').trim()).filter(Boolean))).slice(0, 50).map((o) => o.slice(0, 120));
    if (!options.length) return { ok: false, error: 'a dropdown needs at least one option' };
  }
  const v = (f.validation ?? {}) as Record<string, unknown>;
  const num = (x: unknown) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  const str = (x: unknown, max: number) => (x == null || String(x).trim() === '' ? null : String(x).trim().slice(0, max));
  const validation: Validation = {
    min: num(v.min), max: num(v.max), maxLength: num(v.maxLength),
    pattern: str(v.pattern, 200), patternMessage: str(v.patternMessage, 200), minChecked: num(v.minChecked), maxChecked: num(v.maxChecked),
  };
  const cleanValidation = Object.values(validation).some((x) => x != null) ? validation : null;
  const def = f.default_value == null || f.default_value === '' ? null : String(f.default_value).slice(0, 1000);
  const key = (x: unknown) => { const s = str(x, 60); return s ? s.replace(/[^a-z0-9_.]/gi, '_') : null; };
  const group = key(f.group_key);
  if (type === 'radio' && !group) return { ok: false, error: 'a radio button needs a group (the question it answers)' };
  const formula = str(f.formula, 500);
  if (type === 'formula' && !formula) return { ok: false, error: 'a formula field needs a formula' };
  const cond = f.conditions && typeof f.conditions === 'object' ? f.conditions as Conditions : null;
  const conditions = cond && ((cond.all?.length ?? 0) + (cond.any?.length ?? 0)) > 0 ? cond : null;
  return {
    ok: true,
    field: {
      ...(f.id != null && f.id !== '' ? { id: f.id as number | string } : {}),
      role, type, page, ...rect,
      required: FIELD_META[type].signs && type !== 'date_signed' ? f.required !== false : !!f.required,
      read_only: !!variable || type === 'date_signed' || type === 'formula' || !!f.read_only,
      label: f.label == null || f.label === '' ? null : String(f.label).slice(0, 120),
      default_value: def,
      variable_key: variable,
      options,
      validation: cleanValidation,
      field_key: key(f.field_key), group_key: group, conditions,
      formula: type === 'formula' ? formula : null,
      placeholder: str(f.placeholder, 120),
    },
  };
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
export const MAX_PNG = 400_000;

/**
 * Is `raw` a valid value for this field? Returns the canonical value. An empty
 * value clears the field (whether that is allowed is a required-field check at
 * the end, not here, so a signer can change their mind).
 */
export function validateValue(f: Pick<FieldDef, 'type' | 'options' | 'validation' | 'label'>, raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  const name = f.label || FIELD_META[f.type].label;
  if (raw == null || (typeof raw === 'string' && raw.trim() === '') || raw === false) return { ok: true, value: null };
  const s = String(raw).trim();
  const v = f.validation ?? {};
  switch (f.type) {
    case 'text': {
      const max = v.maxLength && v.maxLength > 0 ? v.maxLength : 1000;
      if (s.length > max) return { ok: false, error: `${name} is longer than ${max} characters` };
      return { ok: true, value: s };
    }
    case 'number': case 'currency': {
      const n = Number(s.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(n)) return { ok: false, error: `${name} must be a number` };
      if (v.min != null && n < v.min) return { ok: false, error: `${name} must be at least ${v.min}` };
      if (v.max != null && n > v.max) return { ok: false, error: `${name} must be at most ${v.max}` };
      return { ok: true, value: String(f.type === 'currency' ? Math.round(n * 100) / 100 : n) };
    }
    case 'date': case 'date_signed': {
      const m = s.match(ISO_DAY);
      const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
      if (!m || !d || d.getUTCMonth() !== Number(m[2]) - 1) return { ok: false, error: `${name} must be a date` };
      return { ok: true, value: s };
    }
    case 'checkbox':
      return { ok: true, value: s === 'true' || s === '1' || s === 'on' || raw === true ? 'true' : null };
    case 'dropdown':
      if (!(f.options ?? []).includes(s)) return { ok: false, error: `${name}: pick one of the options` };
      return { ok: true, value: s };
    case 'signature': case 'initials':
      if (!PNG.test(s)) return { ok: false, error: `${name} must be an image of your ${f.type === 'initials' ? 'initials' : 'signature'}` };
      if (s.length > MAX_PNG) return { ok: false, error: `${name} image is too large` };
      return { ok: true, value: s };
    case 'radio': case 'attachment': case 'stamp': case 'formula': case 'email': case 'phone': {
      // Imported lazily-free: field-logic.ts has no I/O.
      return validateParity({ id: 0, type: f.type, label: f.label, validation: f.validation as never }, raw);
    }
  }
  return { ok: false, error: 'unknown field type' };
}

/** Required fields this signer still has to fill. date_signed is stamped by the server, so it never blocks. */
export function missingRequired<T extends Pick<ContractField, 'signer_id' | 'type' | 'required' | 'read_only' | 'value'>>(fields: T[], signerId: number): T[] {
  return fields.filter((f) => f.signer_id === signerId && f.required && !f.read_only && f.type !== 'date_signed' && !(f.value ?? '').trim());
}

/** A variable's value, canonical for the field's type. Null when the record has no answer. */
export function bindValue(type: FieldType, key: string | null | undefined, vars: Vars): string | null {
  if (!key) return null;
  const v = vars[key];
  if (!v || v.value == null || v.value === '') return null;
  if (type === 'number' || type === 'currency') {
    const n = Number(String(v.value).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? String(n) : null;
  }
  if (type === 'date') {
    const s = String(v.value);
    if (ISO_DAY.test(s.slice(0, 10))) return s.slice(0, 10);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (type === 'checkbox') return v.value ? 'true' : null;
  return defaultFormat(v) || null;
}

export type BoundRow = Omit<FieldDef, 'id' | 'role'> & { signer_id: number; template_field_id: number | null; value: string | null; sort: number };

/**
 * Template (or editor) fields → rows for one contract: each field goes to the
 * signer holding its role, variable-bound fields take the record's value, and
 * anything that cannot be placed is reported rather than silently dropped —
 * a role nobody was named for, a CC or viewer (they never fill anything), or
 * a signature box on a form filler.
 */
export function bindToSigners(
  defs: FieldDef[],
  signers: Array<{ id: number; role: string; recipient_type?: string | null }>,
  vars: Vars,
  /** The defs are doc_template_fields rows: remember which one each field came from. */
  opts: { fromTemplate?: boolean } = {},
): { rows: BoundRow[]; skipped: Array<{ role: string; type: FieldType; reason: string }>; unresolved: string[] } {
  const rows: BoundRow[] = [];
  const skipped: Array<{ role: string; type: FieldType; reason: string }> = [];
  const unresolved = new Set<string>();
  defs.forEach((f, i) => {
    const s = signers.find((x) => x.role === f.role);
    const rt = String(s?.recipient_type ?? 'signer');
    if (!s) { skipped.push({ role: f.role, type: f.type, reason: 'no one is filling that role' }); return; }
    if (rt === 'cc' || rt === 'viewer') { skipped.push({ role: f.role, type: f.type, reason: `a ${rt === 'cc' ? 'CC' : 'viewer'} does not fill fields` }); return; }
    if (!fieldAllowedFor(f.type, rt)) { skipped.push({ role: f.role, type: f.type, reason: 'a form filler does not sign' }); return; }
    const bound = f.variable_key ? bindValue(f.type, f.variable_key, vars) : null;
    if (f.variable_key && bound == null) unresolved.add(f.variable_key);
    const def = f.default_value && !FIELD_META[f.type].signs ? validateValue(f, f.default_value) : null;
    rows.push({
      signer_id: s.id,
      template_field_id: opts.fromTemplate && typeof f.id === 'number' ? f.id : null,
      type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
      required: !!f.required,
      // A binding the record could not answer stays open for the recipient to type.
      read_only: f.type === 'date_signed' || (!!f.variable_key && bound != null) || (!f.variable_key && !!f.read_only),
      label: f.label ?? null, default_value: f.default_value ?? null, variable_key: f.variable_key ?? null,
      options: f.options ?? null, validation: f.validation ?? null,
      field_key: f.field_key ?? null, group_key: f.group_key ?? null, conditions: f.conditions ?? null, formula: f.formula ?? null, placeholder: f.placeholder ?? null,
      value: bound ?? (def && def.ok ? def.value : null),
      sort: i,
    });
  });
  return { rows, skipped, unresolved: [...unresolved] };
}

/** Today in Central time as YYYY-MM-DD, the value a date-signed box gets. */
export const signingDay = (at: Date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Chicago' }).format(at);

const usd = (x: number) => x.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(x) ? 0 : 2, maximumFractionDigits: 2 });

/** How a stored value reads on the page. */
export function displayValue(f: Pick<FieldDef, 'type'>, value: string | null | undefined): string {
  if (value == null || value === '') return '';
  switch (f.type) {
    case 'currency': { const n = Number(value); return Number.isFinite(n) ? usd(n) : value; }
    case 'number': { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('en-US') : value; }
    case 'date': case 'date_signed': { const m = value.match(ISO_DAY); return m ? `${m[2]}/${m[3]}/${m[1]}` : value; }
    case 'checkbox': return value === 'true' ? 'X' : '';
    default: return value;
  }
}

// ------------------------------------------------------------ PDF geometry

/** A page as pdf-lib sees it: crop box in points and its /Rotate. */
export type PageBox = { x0: number; y0: number; width: number; height: number; rotation: number };

const rot = (r: number) => ((Math.round(r / 90) * 90) % 360 + 360) % 360;

/** Size of the page as displayed (rotation applied), in points. */
export function displaySize(p: PageBox): { width: number; height: number } {
  return rot(p.rotation) % 180 === 0 ? { width: p.width, height: p.height } : { width: p.height, height: p.width };
}

/**
 * A point given as fractions of the displayed page (top-left origin) → PDF
 * user space (bottom-left origin, unrotated). The four cases are the four
 * ways /Rotate turns the page clockwise for display.
 */
export function toPdfPoint(p: PageBox, u: number, v: number): { x: number; y: number } {
  const { x0, y0, width: W, height: H } = p;
  switch (rot(p.rotation)) {
    case 90: return { x: x0 + v * W, y: y0 + u * H };
    case 180: return { x: x0 + (1 - u) * W, y: y0 + v * H };
    case 270: return { x: x0 + (1 - v) * W, y: y0 + (1 - u) * H };
    default: return { x: x0 + u * W, y: y0 + (1 - v) * H };
  }
}

export type DrawOp =
  | { op: 'text'; page: number; x: number; y: number; size: number; rotate: number; text: string }
  | { op: 'image'; page: number; x: number; y: number; width: number; height: number; rotate: number; png: string }
  | { op: 'line'; page: number; start: { x: number; y: number }; end: { x: number; y: number }; thickness: number };

/**
 * What to draw for each filled field: text sized to fit its box, a check
 * drawn as two strokes, a signature image scaled into its box. `measure`
 * is the font's width at a size (pdf-lib's widthOfTextAtSize), injected so
 * this stays pure. Pages are 1-based; fields on missing pages are skipped.
 */
export function planFlatten(
  fields: Array<Pick<ContractField, 'type' | 'page' | 'x' | 'y' | 'w' | 'h' | 'value'> & { imageSize?: { width: number; height: number } | null }>,
  pages: PageBox[],
  measure: (text: string, size: number) => number,
): DrawOp[] {
  const ops: DrawOp[] = [];
  for (const f of fields) {
    const p = pages[f.page - 1];
    const value = (f.value ?? '').trim();
    if (!p || !value) continue;
    const r = rot(p.rotation);
    const d = displaySize(p);
    const bw = f.w * d.width, bh = f.h * d.height;
    if (f.type === 'signature' || f.type === 'initials') {
      if (!value.startsWith('data:image/png;base64,')) continue;
      const iw = f.imageSize?.width || bw, ih = f.imageSize?.height || bh;
      const scale = Math.min(bw / iw, bh / ih);
      const w = iw * scale, h = ih * scale;
      // Centered in the box; drawImage anchors at the image's bottom-left.
      const u = f.x + (bw - w) / 2 / d.width;
      const v = f.y + f.h - (bh - h) / 2 / d.height;
      const at = toPdfPoint(p, u, v);
      ops.push({ op: 'image', page: f.page, x: at.x, y: at.y, width: w, height: h, rotate: r, png: value });
      continue;
    }
    if (f.type === 'checkbox') {
      if (value !== 'true') continue;
      const pt = (a: number, b: number) => toPdfPoint(p, f.x + a * f.w, f.y + b * f.h);
      const thickness = Math.max(0.8, Math.min(bw, bh) * 0.12);
      ops.push({ op: 'line', page: f.page, start: pt(0.18, 0.55), end: pt(0.42, 0.8), thickness });
      ops.push({ op: 'line', page: f.page, start: pt(0.42, 0.8), end: pt(0.84, 0.2), thickness });
      continue;
    }
    let text = displayValue(f, value).replace(/\s+/g, ' ');
    if (!text) continue;
    let size = Math.max(4, Math.min(11, bh * 0.72));
    const room = Math.max(1, bw - 4);
    const wide = measure(text, size);
    if (wide > room) size = Math.max(4, size * room / wide);
    // Still too wide at the smallest legible size: cut it short rather than run off the box.
    if (measure(text, size) > room) {
      while (text.length > 1 && measure(`${text}…`, size) > room) text = text.slice(0, -1);
      text = `${text.trimEnd()}…`;
    }
    // Baseline a little above the bottom of the box, left-aligned with padding.
    const u = f.x + 2 / d.width;
    const v = f.y + f.h - Math.max(1, (bh - size) / 2 + size * 0.18) / d.height;
    const at = toPdfPoint(p, u, v);
    ops.push({ op: 'text', page: f.page, x: at.x, y: at.y, size: Math.round(size * 100) / 100, rotate: r, text });
  }
  return ops;
}
