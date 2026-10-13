/**
 * What an ingest envelope's `deal` section writes onto public.deals (the Deal
 * Tracker columns, migrations 45 and 49) and public.deal_files (photo and
 * listing links). Pure, so the mapping is testable without a database:
 *   deno run supabase/functions/_shared/ingest-deal.test.ts
 */

/** envelope key -> deals column. Contract price is the seller price, offer_amount. */
const MONEY: Record<string, string> = {
  asking_price: 'asking_price', contract_price: 'offer_amount', offer_amount: 'offer_amount',
  arv: 'arv', rehab: 'rehab', mao: 'mao', assignment_fee: 'assignment_fee',
  marketed_price: 'marketed_price', marketed_fee: 'marketed_fee', dispo_fee: 'dispo_fee', earnest_money: 'earnest_money',
};
const TEXT = ['transaction_type', 'contract_status', 'lead_source', 'acq_agent', 'dispo_agent', 'lead_manager',
  'coordinator', 'motivation', 'market', 'notes'];

function money(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** The deals columns this section sets. Absent or blank fields are left out, so they never blank a value. */
export function dealColumns(deal: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!deal) return out;
  for (const [k, col] of Object.entries(MONEY)) {
    const n = money(deal[k]);
    if (n !== null && out[col] === undefined) out[col] = n;
  }
  for (const k of TEXT) {
    const s = typeof deal[k] === 'string' ? (deal[k] as string).trim() : '';
    if (s) out[k] = k === 'notes' ? s.slice(0, 8000) : s.slice(0, 500);
  }
  return out;
}

const httpUrl = (v: unknown): string | null =>
  typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim().slice(0, 2000) : null;

/** deal_files rows to add: every photo link (kind photo) and the listing (kind link). */
export function dealLinks(deal: Record<string, unknown> | undefined): { kind: 'photo' | 'link'; name: string; url: string }[] {
  if (!deal) return [];
  const raw = Array.isArray(deal.photos) ? deal.photos : Array.isArray(deal.photo_urls) ? deal.photo_urls : [];
  const photos = Array.from(new Set(raw.map(httpUrl).filter((u): u is string => !!u))).slice(0, 50);
  const rows: { kind: 'photo' | 'link'; name: string; url: string }[] = photos.map((url, i) => ({ kind: 'photo', name: `Photo ${i + 1}`, url }));
  const listing = httpUrl(deal.listing_url);
  if (listing && !photos.includes(listing)) rows.push({ kind: 'link', name: 'Listing', url: listing });
  return rows;
}

/** Whether the section says anything a deal row should carry (beyond what ingest_apply already puts on the contact). */
export function hasDealFacts(deal: Record<string, unknown> | undefined): boolean {
  const cols = dealColumns(deal);
  delete cols.notes;
  delete cols.motivation;
  return Object.keys(cols).length > 0 || dealLinks(deal).length > 0;
}

const STREET = /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|ct|court|cir|circle|pl|place|pkwy|parkway|hwy|highway|ter|terrace|trl|trail|loop)\b/i;

/** A contact's name is a person or company, never the property address (migration 47). */
export function nameIsAddress(name: unknown, line1?: unknown): boolean {
  if (typeof name !== 'string' || !name.trim()) return false;
  const squash = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (line1 && squash(name) === squash(line1)) return true;
  return /^\s*\d+\s+\S/.test(name) && STREET.test(name);
}

/** PostgREST ilike with the value taken literally. */
export const ilikeExact = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
