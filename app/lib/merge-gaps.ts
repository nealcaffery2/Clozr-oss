// Where each merge field gets its value, and which ones would go out blank.
//
// A dispo blast with {{beds}} {{baths}} {{sqft}} used to go out with those
// spots empty, and nothing on screen said which record was missing what.
// These helpers name the field, the record it reads from and where to fill
// it in, so the composer can say "Beds and Sq ft are empty on 5323 Sage Hill
// Road" before anything sends. Pure: tools/merge-gaps.test.ts runs them.

/** The place a field is fixed: the deal's property facts, the deal itself, the person's record, or nowhere a rep edits. */
export type MergeFix = 'property' | 'deal' | 'contact' | 'buyer' | 'sender' | 'auto';

export type MergeSource = {
  label: string;
  /** Finishes "{{beds}} comes from …". */
  from: string;
  fix: MergeFix;
  /** The record field a quick fill saves to (lib/crm-write saveWhatWeKnow keys). */
  field?: 'property.beds' | 'property.baths' | 'property.sqft' | 'property.year' | 'property.type';
};

const P = (label: string, from: string, field?: MergeSource['field']): MergeSource => ({ label, from, fix: 'property', field });
const D = (label: string, from: string): MergeSource => ({ label, from, fix: 'deal' });

export const MERGE_SOURCES: Record<string, MergeSource> = {
  first_name: { label: 'First name', from: "the recipient's name on their record", fix: 'contact' },
  name: { label: 'Full name', from: "the recipient's name on their record", fix: 'contact' },
  contact_name: { label: 'Full name', from: "the recipient's name on their record", fix: 'contact' },
  address: P('Address', "the property's street address on the deal"),
  full_address: P('Full address', "the property's street, city, state and ZIP on the deal"),
  city: P('City', "the property's city on the deal"),
  state: P('State', "the property's state on the deal"),
  zip: P('Zip', "the property's ZIP on the deal"),
  beds: P('Beds', "the property's Beds on the deal", 'property.beds'),
  baths: P('Baths', "the property's Baths on the deal", 'property.baths'),
  sqft: P('Sq ft', "the property's Sqft on the deal", 'property.sqft'),
  year_built: P('Year built', "the property's Year on the deal", 'property.year'),
  property_type: P('Property type', "the property's Type on the deal", 'property.type'),
  specs: P('Beds / baths / sq ft', "the property's Beds, Baths and Sqft on the deal, with any that are empty left out"),
  beds_baths: P('Beds and baths', "the property's Beds and Baths on the deal, with either left out when empty"),
  asking_price: D('Asking', "the deal's marketed price (else contract plus assignment)"),
  price: D('Price', "the deal's marketed price (else contract plus assignment)"),
  cash_price: D('Cash price', "the deal's marketed price (else contract plus assignment)"),
  offer: D('Offer', "the deal's contract price"),
  close_date: D('Close date', "the deal's scheduled close"),
  title_company: D('Title co.', "the title company on the transaction"),
  arv: D('ARV', "the deal's ARV (COMPR)"),
  garage: D('Garage', 'Garage spaces in the deal\'s marketing'),
  headline: D('Headline', "the marketing headline on the deal"),
  description: D('Description', "the marketing description on the deal"),
  photo_url: D('Photo', "the deal's hero photo, else its first public photo"),
  marketing_link: D('View Full Deal', "the deal's COMPR buyer report, else its marketing link"),
  photos_link: D('Photos link', "the deal's COMPR photo set, else its buyer report"),
  comps_link: D('Comps link', "the deal's COMPR CMA PDF, else its buyer report"),
  deal_link: D('Deal page link', "the deal's buyer page (each buyer gets a tracked copy)"),
  rep_name: { label: 'Rep name', from: 'your profile', fix: 'sender' },
  rep_first_name: { label: 'Rep first name', from: 'your profile', fix: 'sender' },
  rep_phone: { label: 'Rep phone', from: 'your profile', fix: 'sender' },
  rep_email: { label: 'Rep email', from: 'the email you sign in with', fix: 'sender' },
  company: { label: 'Company', from: "the workspace's name", fix: 'sender' },
  last_purchase_address: { label: 'Last purchase', from: "the buyer's latest purchase on file (blank when there is none)", fix: 'buyer' },
  last_purchase_ago: { label: 'Bought … ago', from: "the buyer's latest purchase date (blank when there is none)", fix: 'buyer' },
  last_purchase_type: { label: 'Flip / rental', from: "the buyer's latest purchase (blank when there is none)", fix: 'buyer' },
  deal_distance: { label: 'Distance to deal', from: "the miles between the deal and the buyer's latest purchase", fix: 'buyer' },
  similar_size: { label: 'Similar-size line', from: "the buyer's latest purchase size against the deal's Sqft", fix: 'buyer' },
  purchase_note: { label: 'Purchase sentence', from: "the buyer's latest purchase and its distance to the deal (dropped when there is none)", fix: 'buyer' },
  purchase_count: { label: 'Purchases on file', from: "the buyer's purchase history", fix: 'buyer' },
};

/** "{{beds}} comes from the property's Beds on the deal." Null for a field nobody fills. */
export function sourceLine(token: string): string | null {
  const name = token.replace(/[{}\s]/g, '').toLowerCase();
  const s = MERGE_SOURCES[name];
  return s ? `{{${name}}} comes from ${s.from}.` : null;
}

const TOKEN = /\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}/g;

/** The merge fields a text names, lower-cased, in order, once each. */
export function fieldsIn(...texts: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const t of texts) for (const m of (t ?? '').matchAll(TOKEN)) { const n = m[1].toLowerCase(); if (!out.includes(n)) out.push(n); }
  return out;
}

/**
 * The fields a text uses that would render blank for these values: empty, or
 * a field CLOZR fills elsewhere that this composer has no value for at all
 * (renderMerge would send that one as literal braces). `skip` leaves out
 * fields that are blank by design, such as a buyer's purchase sentence.
 */
export function blankFields(texts: Array<string | null | undefined>, fields: Record<string, string>, skip: readonly string[] = []): string[] {
  return blankNames(fieldsIn(...texts), fields, skip);
}

/** blankFields over names already pulled out of the text (a bulk send checks one template against every recipient). */
export function blankNames(names: readonly string[], fields: Record<string, string>, skip: readonly string[] = []): string[] {
  return names.filter((n) => {
    if (skip.includes(n)) return false;
    const v = fields[n];
    return v === undefined ? !!MERGE_SOURCES[n] : !String(v).trim();
  });
}

/** Just the blanks a rep can fix on the deal or its property, not on a buyer or a profile. */
export const dealGaps = (blank: readonly string[]) => blank.filter((n) => { const f = MERGE_SOURCES[n]?.fix; return f === 'property' || f === 'deal'; });

export const labelOf = (name: string) => MERGE_SOURCES[name]?.label ?? name;

/** "Beds", "Beds and Baths", "Beds, Baths and Sq ft". */
export function listLabels(names: readonly string[]): string {
  const ls = names.map(labelOf);
  if (ls.length <= 1) return ls[0] ?? '';
  return `${ls.slice(0, -1).join(', ')} and ${ls[ls.length - 1]}`;
}

/** "Beds, Baths and Sq ft are empty on 123 Oak St." */
export function gapNotice(blank: readonly string[], where: string): string {
  if (!blank.length) return '';
  const place = where.trim() || 'this deal';
  return `${listLabels(blank)} ${blank.length === 1 ? 'is' : 'are'} empty on ${place}.`;
}

/**
 * The pre-send line for a bulk send: per field, how many recipients' emails
 * would show it blank. `counts` is field → recipients affected; `total` is
 * everyone getting the email. Fields with the same count share a sentence.
 *
 *   "12 of 40 buyers' emails would show blank Sq ft because the deal has none."
 */
export function bulkGapSummary(counts: Record<string, number>, total: number, noun = 'buyers', opts: { noDeal?: boolean } = {}): string[] {
  const groups = new Map<string, string[]>();
  for (const [name, n] of Object.entries(counts)) {
    if (!n || !total) continue;
    const own = MERGE_SOURCES[name]?.fix;
    const key = `${Math.min(n, total)}|${own === 'property' || own === 'deal' ? 'deal' : 'record'}`;
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return Array.from(groups.entries())
    .sort((a, b) => Number(b[0].split('|')[0]) - Number(a[0].split('|')[0]))
    .map(([key, names]) => {
      const [n, why] = key.split('|');
      const count = Number(n);
      const who = count === total ? (total === 1 ? `The ${noun.replace(/s$/, '')}'s email` : `All ${total} ${noun}' emails`) : `${count} of ${total} ${noun}' emails`;
      // With no deal attached a deal field has no value at all, and renderMerge
      // leaves the tag as typed rather than guessing.
      if (why === 'deal' && opts.noDeal) return `${who} would show the merge tags for ${listLabels(names)} as typed because no deal is attached.`;
      return `${who} would show blank ${listLabels(names)} ${why === 'deal' ? 'because the deal has none' : 'because their record has none'}.`;
    });
}

/** "3 bd / 2 ba / 1,400 sf" with the empty parts left out; '' when all three are empty. */
export function specsLine(f: { beds?: string | number | null; baths?: string | number | null; sqft?: string | number | null }): string {
  const s = (v: string | number | null | undefined) => (v == null || v === 0 || v === '0' ? '' : String(v).trim());
  return [s(f.beds) && `${s(f.beds)} bd`, s(f.baths) && `${s(f.baths)} ba`, s(f.sqft) && `${s(f.sqft)} sf`].filter(Boolean).join(' / ');
}

/** "3 bd / 2 ba", "3 bd", or ''. */
export function bedsBathsLine(f: { beds?: string | number | null; baths?: string | number | null }): string {
  return specsLine({ beds: f.beds, baths: f.baths });
}

/** The property facts of a merge set, as the composer passes them: '' for a zero or a dash. */
export function factFields(p: { beds?: number | null; baths?: number | null; sqft?: number | null; year?: number | null; type?: string | null }): Record<string, string> {
  const n = (v: number | null | undefined) => (v ? String(v) : '');
  const sqft = p.sqft ? p.sqft.toLocaleString('en-US') : '';
  const type = p.type && p.type !== '—' ? p.type : '';
  return {
    beds: n(p.beds), baths: n(p.baths), sqft, year_built: n(p.year), property_type: type,
    specs: specsLine({ beds: p.beds, baths: p.baths, sqft }), beds_baths: bedsBathsLine({ beds: p.beds, baths: p.baths }),
  };
}
