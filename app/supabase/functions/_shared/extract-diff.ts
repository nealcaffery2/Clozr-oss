// What the AI read off a contract, against what the deal sheet says.
//
// docs-extract stores one row per term (contract_extractions). This file
// knows the terms, cleans what the model returned into rows, and lines each
// single-valued term up with the deal column it belongs in — so "PDF says
// close 10/21/2026, deal says 10/24" is one row a person can apply.
//
// Money, dates, names, emails and phones are compared normalized: "$85,000.00"
// is 85000, "October 21, 2026" is 2026-10-21, "ACME HOLDINGS, LLC" is
// "Acme Holdings LLC". Pure: no I/O, shared by the function and the app.
import { contractSide, parseContractDate, parseMoney, type Side } from './contract-apply.ts';

export type FieldKind = 'money' | 'date' | 'name' | 'email' | 'phone' | 'text' | 'days';
export type FieldDef = { key: string; label: string; kind: FieldKind; many?: boolean };

/** Every term docs-extract asks for. `many` terms can appear more than once (two sellers). */
export const EXTRACT_FIELDS: FieldDef[] = [
  { key: 'seller', label: 'Seller', kind: 'name', many: true },
  { key: 'buyer', label: 'Buyer', kind: 'name', many: true },
  { key: 'assignee', label: 'Assignee', kind: 'name', many: true },
  { key: 'entity', label: 'Entity', kind: 'name', many: true },
  { key: 'purchase_price', label: 'Purchase price', kind: 'money' },
  { key: 'assignment_fee', label: 'Assignment fee', kind: 'money' },
  { key: 'emd_amount', label: 'Earnest money', kind: 'money' },
  { key: 'emd_due_date', label: 'Earnest money due', kind: 'date' },
  { key: 'option_fee', label: 'Option fee', kind: 'money' },
  { key: 'option_period_days', label: 'Option period (days)', kind: 'days' },
  { key: 'option_period_end', label: 'Option period ends', kind: 'date' },
  { key: 'contract_date', label: 'Contract date', kind: 'date' },
  { key: 'close_date', label: 'Close date', kind: 'date' },
  { key: 'title_company', label: 'Title company', kind: 'name' },
  { key: 'title_contact', label: 'Title contact', kind: 'name' },
  { key: 'title_email', label: 'Title email', kind: 'email' },
  { key: 'title_phone', label: 'Title phone', kind: 'phone' },
  { key: 'property_address', label: 'Property address', kind: 'text' },
  { key: 'special_term', label: 'Special term', kind: 'text', many: true },
];
export const FIELD_KEYS = EXTRACT_FIELDS.map((f) => f.key);
const DEF = new Map(EXTRACT_FIELDS.map((f) => [f.key, f]));
export const fieldLabel = (key: string) => DEF.get(key)?.label ?? key.replace(/_/g, ' ');
export const fieldKind = (key: string): FieldKind => DEF.get(key)?.kind ?? 'text';

// ------------------------------------------------------------ normalizing
export const normMoney = (v: unknown): number | null => (v == null ? null : parseMoney(String(v)));
export function normDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  // 10/21/26
  const short = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (short) return `20${short[3]}-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}`;
  return parseContractDate(s);
}
/** Case, punctuation and spacing do not make two names different. */
export function normName(v: unknown): string {
  return String(v ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
export const normEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();
export function normPhone(v: unknown): string {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
export function normDays(v: unknown): number | null {
  const m = String(v ?? '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** A comparable value for one kind, or null when there is nothing to compare. */
export function normalize(kind: FieldKind, v: unknown): string | number | null {
  if (v == null || v === '') return null;
  switch (kind) {
    case 'money': return normMoney(v);
    case 'date': return normDate(v);
    case 'days': return normDays(v);
    case 'name': case 'text': return normName(v) || null;
    case 'email': return normEmail(v) || null;
    case 'phone': return normPhone(v) || null;
  }
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 ? 2 : 0 });
/** How a normalized value reads on screen. */
export function display(kind: FieldKind, v: string | number | null, raw?: unknown): string {
  if (v == null) return raw == null || raw === '' ? '—' : String(raw);
  if (kind === 'money' && typeof v === 'number') return usd(v);
  if (kind === 'date' && typeof v === 'string') { const [y, m, d] = v.split('-'); return `${Number(m)}/${Number(d)}/${y}`; }
  if (kind === 'phone' && typeof v === 'string' && v.length === 10) return `(${v.slice(0, 3)}) ${v.slice(3, 6)}-${v.slice(6)}`;
  return raw != null && raw !== '' ? String(raw) : String(v);
}

// ------------------------------------------------------------ model output
export type ExtractedRow = { field_key: string; value: string; confidence: number | null; page: number | null; bbox: unknown | null };

/**
 * The model's answer as rows: unknown keys, empty values and duplicates
 * dropped, confidence clamped to 0..1, pages positive integers.
 */
export function cleanExtraction(raw: unknown): ExtractedRow[] {
  const list = Array.isArray((raw as { fields?: unknown })?.fields) ? (raw as { fields: unknown[] }).fields : Array.isArray(raw) ? raw : [];
  const out: ExtractedRow[] = [];
  const seen = new Set<string>();
  for (const f of list as Record<string, unknown>[]) {
    const key = String(f?.key ?? f?.field_key ?? '').trim();
    const value = String(f?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!DEF.has(key) || !value || /^(n\/?a|none|null|unknown|—|-)$/i.test(value)) continue;
    const dedupe = `${key}|${normName(value)}`;
    if (seen.has(dedupe)) continue;
    // A single-valued term keeps its first (the model lists the governing one first).
    if (!DEF.get(key)!.many && out.some((r) => r.field_key === key)) continue;
    seen.add(dedupe);
    const c = Number(f?.confidence);
    const p = Number(f?.page);
    const bbox = Array.isArray(f?.bbox) && (f.bbox as unknown[]).length === 4 && (f.bbox as unknown[]).every((n) => Number.isFinite(Number(n)))
      ? (f.bbox as unknown[]).map(Number) : null;
    out.push({
      field_key: key, value,
      confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c > 1 && c <= 100 ? c / 100 : c)) : null,
      page: Number.isInteger(p) && p > 0 ? p : null,
      bbox,
    });
  }
  return out;
}

// ------------------------------------------------------------ against the deal
/** The deal columns a term can be applied to, by which side of the deal the contract is. */
export function columnFor(key: string, side: Side): string | null {
  switch (key) {
    case 'purchase_price': return side === 'buyer' ? 'sold_price' : 'offer_amount';
    case 'assignment_fee': return 'assignment_fee';
    // The deal sheet has one earnest money figure: ours to the seller.
    case 'emd_amount': return side === 'seller' ? 'earnest_money' : null;
    case 'option_period_end': return side === 'buyer' ? 'buyer_option_ends_on' : 'option_ends_on';
    case 'contract_date': return 'contract_date';
    case 'close_date': return 'close_date';
    case 'title_contact': return 'title_contact';
    case 'title_email': return 'title_email';
    case 'title_phone': return 'title_phone';
    default: return null;
  }
}

export type Extraction = ExtractedRow & { id: number; applied_to_deal_at?: string | null; dismissed_at?: string | null };
export type DealLike = Record<string, unknown> & { id?: number | null };
export type DiffRow = {
  extraction_id: number; field_key: string; label: string; kind: FieldKind;
  /** The deal column Apply writes, or null when it only informs (title company, address). */
  column: string | null;
  pdf: string | number | null; deal: string | number | null;
  /** The value as printed, which is what a name or email is written as. */
  raw: string;
  pdf_display: string; deal_display: string;
  confidence: number | null; page: number | null;
};

/** What the deal holds for a term that is not a column of its own. */
type Context = { titleCompany?: string | null; propertyAddress?: string | null };

/**
 * The terms that disagree with the deal (or that the deal is missing), one
 * row each. Applied and dismissed rows, multi-valued terms (parties, special
 * terms) and terms the deal has no place for are left out.
 */
export function dealDiff(input: {
  extractions: Extraction[]; deal: DealLike | null; kind: string; roles?: string[]; context?: Context;
}): DiffRow[] {
  if (!input.deal) return [];
  const side = contractSide(input.kind, input.roles ?? []);
  const out: DiffRow[] = [];
  for (const x of input.extractions) {
    if (x.applied_to_deal_at || x.dismissed_at) continue;
    const def = DEF.get(x.field_key);
    if (!def || def.many) continue;
    const column = columnFor(x.field_key, side);
    let dealRaw: unknown;
    if (column) dealRaw = input.deal[column];
    else if (x.field_key === 'title_company') dealRaw = input.context?.titleCompany;
    else if (x.field_key === 'property_address') dealRaw = input.context?.propertyAddress;
    else continue;
    const pdf = normalize(def.kind, x.value);
    if (pdf == null) continue;
    const deal = normalize(def.kind, dealRaw);
    if (same(def.kind, pdf, deal)) continue;
    // Informational rows are only worth showing when the deal has something to disagree with.
    if (!column && deal == null) continue;
    out.push({
      extraction_id: x.id, field_key: x.field_key, label: def.label, kind: def.kind, column,
      pdf, deal, raw: x.value, pdf_display: display(def.kind, pdf, x.value), deal_display: display(def.kind, deal, dealRaw),
      confidence: x.confidence, page: x.page,
    });
  }
  return out;
}

function same(kind: FieldKind, a: string | number | null, b: string | number | null): boolean {
  if (a == null || b == null) return a === b;
  if (kind === 'money') return Math.abs(Number(a) - Number(b)) < 0.005;
  // An address on the deal sheet is often just the street line.
  if (kind === 'text') return String(a).startsWith(String(b)) || String(b).startsWith(String(a));
  // "Carolina Title" on the deal, "Carolina Title Company, LLC" on the PDF.
  if (kind === 'name') {
    const strip = (s: string) => s.replace(/\b(llc|inc|co|company|corp|corporation|ltd|lp|pllc|the)\b/g, '').replace(/\s+/g, ' ').trim();
    return strip(String(a)) === strip(String(b));
  }
  return a === b;
}

/** The deal update Apply makes for one row. */
export function patchFor(d: Pick<DiffRow, 'column' | 'kind' | 'pdf' | 'raw'>): Record<string, string | number> | null {
  if (!d.column || d.pdf == null) return null;
  if (d.kind === 'phone') return { [d.column]: display('phone', d.pdf, d.raw) };
  if (d.kind === 'name' || d.kind === 'text') return { [d.column]: d.raw.trim() };
  return { [d.column]: d.pdf };
}
