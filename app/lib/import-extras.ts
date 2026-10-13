// What an import brings beyond the core lead fields, and where it lands
// (migration 134).
//
//   sellers.mailing_line1 / _city / _state / _zip, do_not_mail
//                       the owner's mailing address (PropStream's "Mailing …")
//   sellers.owner2_name  a second owner of record
//   sellers.other_emails every email after the first, in file order
//   sellers.import_extra every column the import had no field for, by its
//                        header, so nothing in a file is ever dropped
//   properties.facts     what a list says about the house that has no column:
//                        value, equity, loans, last sale, MLS, vacant, and a
//                        partner sheet's market, garage, occupancy, listed on
//                        MLS / InvestorLift, one property or portfolio
//
// A seller's numbers after the first go to seller_phones (migration 129).
//
// The app never reads these with the workspace: the record asks for one
// seller's (loadImportInfo), so the main load is the same on a database
// without migration 134. A write that meets a database without them keeps
// everything anyway, as a "From the import" block in the notes
// (withoutImportColumns).

import { supabase } from './supabase';

/** What a list says about the house that has no column of its own (properties.facts). */
export type PropertyFacts = Partial<{
  est_value: number; assessed_value: number; est_equity: number; ltv: number;
  open_loans: number; loan_balance: number; lien_amount: number; monthly_rent: number;
  last_sale_date: string; last_sale_price: number;
  mls_status: string; mls_date: string; mls_amount: number;
  vacant: boolean | string; absentee: boolean | string; owner_occupied: boolean | string;
  // What a partner's submission sheet says (Podio, Mark Spain…).
  market: string; garage: string; occupancy: boolean | string; listed_mls: boolean | string;
  on_investorlift: boolean | string; portfolio: string;
}>;
export type FactKey = keyof PropertyFacts;

/** Facts in the order the record lists them, with their label. */
export const FACTS: { key: FactKey; label: string; kind: 'money' | 'pct' | 'count' | 'date' | 'text' | 'flag' }[] = [
  { key: 'est_value', label: 'Est. value', kind: 'money' },
  { key: 'assessed_value', label: 'Assessed value', kind: 'money' },
  { key: 'est_equity', label: 'Est. equity', kind: 'money' },
  { key: 'ltv', label: 'Est. loan-to-value', kind: 'pct' },
  { key: 'open_loans', label: 'Open loans', kind: 'count' },
  { key: 'loan_balance', label: 'Loan balance', kind: 'money' },
  { key: 'lien_amount', label: 'Liens', kind: 'money' },
  { key: 'monthly_rent', label: 'Monthly rent', kind: 'money' },
  { key: 'last_sale_price', label: 'Last sale', kind: 'money' },
  { key: 'last_sale_date', label: 'Last sale date', kind: 'date' },
  { key: 'mls_status', label: 'MLS status', kind: 'text' },
  { key: 'mls_amount', label: 'MLS amount', kind: 'money' },
  { key: 'mls_date', label: 'MLS date', kind: 'date' },
  { key: 'vacant', label: 'Vacant', kind: 'flag' },
  { key: 'absentee', label: 'Absentee owner', kind: 'flag' },
  { key: 'owner_occupied', label: 'Owner occupied', kind: 'flag' },
  { key: 'market', label: 'Market', kind: 'text' },
  { key: 'garage', label: 'Garage', kind: 'text' },
  { key: 'occupancy', label: 'Occupied', kind: 'flag' },
  { key: 'listed_mls', label: 'Listed on MLS', kind: 'flag' },
  { key: 'on_investorlift', label: 'On InvestorLift', kind: 'flag' },
  { key: 'portfolio', label: 'One property or portfolio', kind: 'text' },
];
export const FACT_KEYS = FACTS.map((f) => f.key);

const usd = (n: number) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');

/** One fact as the record shows it. Null when there is nothing to show. */
export function factText(key: FactKey, v: unknown): string | null {
  if (v == null || v === '') return null;
  const f = FACTS.find((x) => x.key === key);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') {
    if (f?.kind === 'money') return usd(v);
    if (f?.kind === 'pct') return `${Math.round(v * 10) / 10}%`;
    // "Total Open Loans" is a count in one export and a dollar total in another.
    if (f?.kind === 'count') return v > 50 ? usd(v) : String(v);
    return String(v);
  }
  if (f?.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
    return new Date(String(v) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return String(v);
}

/** The facts with a value, as label / text pairs, in FACTS order. */
export function factRows(facts: unknown): { k: string; v: string }[] {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return [];
  const bag = facts as Record<string, unknown>;
  return FACTS.flatMap((f) => { const v = factText(f.key, bag[f.key]); return v ? [{ k: f.label, v }] : []; });
}

// ---- writing on a database without migration 134 --------------------------------

/** The seller columns migration 134 adds. */
export const SELLER_IMPORT_COLUMNS = ['mailing_line1', 'mailing_city', 'mailing_state', 'mailing_zip', 'do_not_mail', 'owner2_name', 'other_emails', 'import_extra'] as const;

/** PostgREST's answer to a column this database does not have yet ("Could not find the 'x' column…", or Postgres 42703). */
export function isMissingColumn(err: { message?: string; code?: string } | null | undefined, columns: readonly string[]): boolean {
  if (!err) return false;
  const m = err.message ?? '';
  return (err.code === 'PGRST204' || err.code === '42703' || /column|schema cache/i.test(m)) && columns.some((c) => m.includes(c));
}

/** "Key: value" lines for what a row carries beyond the columns, for a notes block. */
export function importLines(row: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const mail = [row.mailing_line1, row.mailing_city, [row.mailing_state, row.mailing_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (mail) lines.push(`Mailing address: ${mail}`);
  if (row.do_not_mail != null) lines.push(`Do not mail: ${row.do_not_mail ? 'Yes' : 'No'}`);
  if (row.owner2_name) lines.push(`Owner 2: ${row.owner2_name}`);
  if (Array.isArray(row.other_emails) && row.other_emails.length) lines.push(`Other emails: ${row.other_emails.join(', ')}`);
  const extra = row.import_extra;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) if (v != null && v !== '') lines.push(`${k}: ${String(v)}`);
  }
  return lines;
}

/** A notes block, or null when there is nothing in it. */
export const importBlock = (lines: string[]): string | null => (lines.length ? ['From the import:', ...lines].join('\n') : null);

/**
 * A seller row without the migration 134 columns, for a database that does not
 * have them yet: what they held goes into the notes instead, so it is still on
 * the record.
 */
export function withoutImportColumns(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  const block = importBlock(importLines(row));
  for (const c of SELLER_IMPORT_COLUMNS) delete out[c];
  if (block) out.notes = [typeof row.notes === 'string' ? row.notes.trim() : '', block].filter(Boolean).join('\n');
  return out;
}

// ---- reading, for one record ----------------------------------------------------

export type ImportInfo = {
  mailing: { line1: string | null; city: string | null; state: string | null; zip: string | null } | null;
  doNotMail: boolean | null;
  owner2: string | null;
  otherEmails: string[];
  extra: Record<string, string>;
  facts: { k: string; v: string }[];
  lotSqft: number | null;
  county: string | null;
};

/**
 * One seller's import fields and their property's facts. Null on a database
 * without migration 134 (or with nothing to read): the record shows nothing
 * extra, as before.
 */
export async function loadImportInfo(workspaceId: number, sellerId: number): Promise<ImportInfo | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('sellers')
    .select('property_id,mailing_line1,mailing_city,mailing_state,mailing_zip,do_not_mail,owner2_name,other_emails,import_extra')
    .eq('workspace_id', workspaceId).eq('id', sellerId).maybeSingle();
  if (error || !data) return null;
  const s = data as unknown as {
    property_id: number | null; mailing_line1: string | null; mailing_city: string | null; mailing_state: string | null; mailing_zip: string | null;
    do_not_mail: boolean | null; owner2_name: string | null; other_emails: string[] | null; import_extra: Record<string, unknown> | null;
  };
  let facts: { k: string; v: string }[] = [];
  let lotSqft: number | null = null;
  let county: string | null = null;
  if (s.property_id) {
    const { data: p } = await supabase.from('properties').select('facts,lot_sqft,county').eq('id', s.property_id).maybeSingle();
    const prop = p as unknown as { facts?: unknown; lot_sqft?: number | null; county?: string | null } | null;
    facts = factRows(prop?.facts);
    lotSqft = prop?.lot_sqft ?? null;
    county = prop?.county ?? null;
  }
  const extra: Record<string, string> = {};
  if (s.import_extra && typeof s.import_extra === 'object' && !Array.isArray(s.import_extra)) {
    for (const [k, v] of Object.entries(s.import_extra)) if (v != null && v !== '') extra[k] = String(v);
  }
  const hasMail = !!(s.mailing_line1 || s.mailing_city || s.mailing_state || s.mailing_zip);
  return {
    mailing: hasMail ? { line1: s.mailing_line1, city: s.mailing_city, state: s.mailing_state, zip: s.mailing_zip } : null,
    doNotMail: s.do_not_mail, owner2: s.owner2_name, otherEmails: s.other_emails ?? [], extra, facts, lotSqft, county,
  };
}
