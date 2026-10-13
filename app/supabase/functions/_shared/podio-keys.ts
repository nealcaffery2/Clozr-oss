/**
 * Podio keys: the normalizers both Podio importers match on. Pure, no imports,
 * so the Excel importer (lib/podio-excel.ts, run with tsx) and the live sync
 * (podio-import's `sync`, Deno) compute the same address key, partner key and
 * stage — which is how a live Podio item finds the row the Excel snapshot of
 * 2026-09-13 wrote.
 *
 * Moved out of lib/podio-excel.ts unchanged; that file re-exports all of it.
 */
// ---------------------------------------------------------------- values

export const clean = (v: unknown) => (v == null ? '' : String(v).replace(/\r/g, '').replace(/[ \t ]+/g, ' ').trim());
export const one = (v: unknown) => clean(v).replace(/\s+/g, ' ');
/**
 * A dollar figure partners often type in thousands: "160" means $160,000 and
 * "1.3" means $1.3M. Values under 10 are millions, under `floor` thousands.
 * Rehab uses a lower floor (a $500 rehab is plausible, a $500k one on a $380k
 * house is not typed as "500").
 */
export const thousands = (n: number | null, floor = 5000): number | null =>
  n == null || n <= 0 ? n : n < 10 ? n * 1_000_000 : n < floor ? n * 1000 : n;

export const num = (v: unknown): number | null => {
  const t = one(v);
  if (!/\d/.test(t)) return null;
  const n = Number(t.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
export const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(one(v)) ? one(v).slice(0, 10) : null);
export const money = (n: number | null) => (n == null ? '' : '$' + Math.round(n).toLocaleString('en-US'));
/** A Podio multi-value cell ("Morgan Lane;\nAlex Lee") → its values. */
export const multi = (v: unknown) => clean(v).split(/;\s*\n?|\n/).map((x) => x.trim()).filter(Boolean);
export const yes = (v: unknown) => /^yes$/i.test(one(v));

/** Last ten digits of a US phone; null for placeholders (0000000000) and anything that isn't ten digits. */
export function phoneKey(v: unknown): string | null {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10 || /^(\d)\1{9}$/.test(d) || d === '1234567890') return null;
  return d;
}
export const phoneOut = (k: string | null) => (k ? '+1' + k : null);

export const INTERNAL_EMAIL = /@yourcompany\.com$/;
/** Lowercased email; null for blanks, "NA", and Acme Homes' own addresses (a teammate typed them into the form). */
export function emailKey(v: unknown): string | null {
  const m = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(String(v ?? ''));
  const e = m?.[0].toLowerCase() ?? null;
  return e && !INTERNAL_EMAIL.test(e) ? e : null;
}

/** "Diego Ortiz III" → "diego nava" — for matching people across files. */
export const personKey = (v: unknown) =>
  one(v).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ').replace(/\s+/g, ' ').trim();
/** A contact name worth keeping: two real words, not "j a" or "Offerpad Offerpad". */
export const realPerson = (v: string) => {
  const t = personKey(v).split(' ');
  return t.length >= 2 && t.every((w) => w.length >= 2) && new Set(t).size === t.length;
};

// ------------------------------------------------------------- addresses

export const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
export const CODES = new Set(Object.values(STATES));
export const STATE_ALT = Object.keys(STATES).sort((x, y) => y.length - x.length).map((n) => n.replace(/ /g, '\\s+')).join('|');
export const stateCode = (v: string) => {
  const t = v.trim().replace(/\.$/, '');
  return CODES.has(t.toUpperCase()) ? t.toUpperCase() : STATES[t.toLowerCase()] ?? null;
};

export type Address = { line1: string; city: string | null; state: string | null; zip: string | null };

/**
 * "1102 E Kessler Avenue, Fort Worth, Texas, 76104" / "103 Pell St, Seneca, SC 29678, USA" /
 * "330 Vista Dr Shepherd, TX 77371" → parts. The city is a best guess; the key only needs line1 + zip.
 */
export function parseAddress(raw: unknown): Address | null {
  let t = clean(raw).replace(/\n/g, ', ').replace(/[,\s]+(usa|united states)\.?$/i, '').trim();
  if (!/^\d/.test(t.split(',')[0].trim())) return null;
  let zip: string | null = null; let state: string | null = null;
  // The tail, commas or not: "…, Fort Worth, Texas, 76104" / "…, Atlanta GA 30314" / "… Shepherd, TX 77371" / "…, SC".
  // A bare two letters only after a comma or before a zip, so "12 Elm Ct" keeps its Ct.
  const m = new RegExp(`^(.*?)([,\\s]+)(${STATE_ALT}|[A-Za-z]{2})\\.?(?:[,\\s]+(\\d{5})(?:-\\d{4})?)?$`, 'i').exec(t);
  if (m && stateCode(m[3]) && (m[4] || m[2].includes(',') || m[3].length > 2)) { t = m[1]; state = stateCode(m[3]); zip = m[4] ?? null; }
  else {
    const z = /^(.*?)[,\s]+(\d{5})(?:-\d{4})?$/.exec(t);
    if (z) { t = z[1]; zip = z[2]; }
  }
  // Podio sometimes repeats the location ("3235 Kemper Ave, Cincinnati, OH 45207, Cincinnati, Ohio, 45207"): the street is the first segment.
  const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  return { line1: parts[0], city: parts[1] ?? null, state, zip };
}

// public.normalize_address — USPS suffixes/directionals, same order.
export const SUBS: [string, string][] = [
  ['NORTHEAST', 'NE'], ['NORTHWEST', 'NW'], ['SOUTHEAST', 'SE'], ['SOUTHWEST', 'SW'], ['NORTH', 'N'], ['SOUTH', 'S'], ['EAST', 'E'], ['WEST', 'W'],
  ['STREET', 'ST'], ['AVENUE', 'AVE'], ['BOULEVARD', 'BLVD'], ['DRIVE', 'DR'], ['ROAD', 'RD'], ['LANE', 'LN'], ['COURT', 'CT'], ['CIRCLE', 'CIR'],
  ['PLACE', 'PL'], ['TERRACE', 'TER'], ['TRAIL', 'TRL'], ['PARKWAY', 'PKWY'], ['HIGHWAY', 'HWY'], ['SQUARE', 'SQ'], ['CROSSING', 'XING'], ['LOOP', 'LOOP'],
  ['APARTMENT', 'APT'], ['SUITE', 'STE'], ['BUILDING', 'BLDG'], ['FLOOR', 'FL'], ['NUMBER', '#'],
];
export function normalizeAddress(raw: string): string | null {
  let s = raw.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  for (const [a, b] of SUBS) s = s.replace(new RegExp(`(?<![A-Z0-9_])${a}(?![A-Z0-9_])`, 'g'), b);
  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}
/** public.address_key(line1, city, state, zip) with the city/state the properties_tidy trigger would store. */
export function addressKey(a: Address): string | null {
  const n = normalizeAddress(a.line1);
  if (!n) return null;
  const zip = (a.zip ?? '').replace(/\D/g, '');
  return zip ? `${n}|${zip.slice(0, 5)}` : `${n}|${(a.state ?? '').toUpperCase()}|${(a.city ?? '').trim().toUpperCase()}`;
}
/** House number + first street word + zip — only for linking a Deals row to its submission when the text differs. */
export const looseKey = (a: Address | null) => {
  const m = a && /^(\d+)\s+(?:[NSEW]\s+)?([A-Za-z0-9]+)/.exec(a.line1);
  return m && a!.zip ? `${m[1]}|${m[2].toUpperCase()}|${a!.zip}` : null;
};

// -------------------------------------------------------------- entities

/**
 * Reviewed folds normalization alone can't make: typos, acronyms, one brand's
 * several spellings. Compact key → canonical key. These are examples; add the
 * spellings your own partners' Podio rows actually use.
 */
export const ALIASES: Record<string, string> = {
  ifnder: 'ifinder', ifinderoffers: 'ifinder',
  arizonapropertyadvsiors: 'arizonapropertyadvisors',
  ch: 'completehomes', chh: 'completehomes', chhcompletehomes: 'completehomes', cmplthomes: 'completehomes', completehome: 'completehomes',
  otpg: 'oceantrust', oceantrustproperty: 'oceantrust',
  bshb: 'bigstate',
  legadobuilder: 'legadobuilders',
};
/** Display names where the most common spelling isn't the right one. */
export const DISPLAY: Record<string, string> = {
  markspain: 'Mark Spain', ifinder: 'iFinder', exp: 'eXp Realty (Off Market)', completehomes: 'Complete Homes Holdings LLC',
  oceantrust: 'Ocean Trust Property Group, LLC', bigstate: 'Big State Home Buyers', offerpad: 'Offerpad', auctioncom: 'Auction.com',
};
/** Entity text that names nobody: the row is attributed by its contact instead. */
export const JUNK = new Set(['', 'na', 'n', 'none', 'self', 'o', 'colorado', 'homebuyers', 'unknown', 'onep', 'oneproperty']);
export const INSTITUTIONAL = new Set(['offerpad', 'opendoor', 'markspain', 'orchard', 'auctioncom', 'placeinstitutional']);
export const BROKERAGE = new Set(['exp']);

export const TAIL2 = [['real', 'estate'], ['off', 'market'], ['home', 'buyers'], ['home', 'buyer']];
export const TAIL1 = new Set(['llc', 'll', 'lcc', 'inc', 'corp', 'corporation', 'ltd', 'gp', 'lp', 'pllc', 'group', 'grp', 'holdings', 'realty',
  'offers', 'offer', 'homebuyers', 'homebuyer', 'buyers', 'buyer', 'offmarket']);

/** Markdown, emails and "- NC" peeled off an Entity Name cell. */
export function cleanEntity(raw: unknown): { name: string | null; email: string | null; market: string | null } {
  let t = one(raw).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_#`]/g, '').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  const email = /@/.test(t) ? emailKey(t) : null;
  if (email || /^\d+\s+\S.*,/.test(t)) return { name: null, email, market: null };
  let market: string | null = null;
  const m = /^(.*?\S)\s*-\s*(DFW|[A-Za-z]{2})$/.exec(t);
  if (m && (m[2].toUpperCase() === 'DFW' || CODES.has(m[2].toUpperCase()))) { t = m[1]; market = m[2].toUpperCase() === 'DFW' ? 'TX' : m[2].toUpperCase(); }
  return { name: t || null, email: null, market };
}

/** Compact partner key: "Mark Spain Real Estate" / "mark spain" → "markspain"; "Arizona Property Advsiors LLC" → "arizonapropertyadvisors". */
export function entityKey(name: string | null): string | null {
  if (!name) return null;
  const w = name.toLowerCase().replace(/&/g, ' and ').replace(/(\d)-(\d)/g, '$1$2').replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  for (let changed = true; changed && w.length > 1;) {
    changed = false;
    const [a, b] = [w[w.length - 2], w[w.length - 1]];
    if (w.length > 2 && TAIL2.some(([x, y]) => x === a && y === b)) { w.splice(-2); changed = true; }
    else if (TAIL1.has(b)) { w.pop(); changed = true; }
    else if (w.length > 2 && b.length === 2 && CODES.has(b.toUpperCase())) { w.pop(); changed = true; }
  }
  const key = w.join('');
  if (JUNK.has(key)) return null;
  return ALIASES[key] ?? key;
}

// ------------------------------------------------------------- stages

/** Submission stages CLOZR is missing (migration 44 inserts them into seller_stages; lib/stages.ts mirrors). */
export const NEW_SELLER_STAGES = ['New Submission', 'Underwriting - Need Info', 'Underwriting Complete', 'Pending Response',
  'Pending Inspections', 'Offer Accepted', 'Underwrite Declined', 'Offer Declined', 'Auction.com'];

export const SUBMISSION_STAGE: Record<string, string> = {
  '': 'New Submission', 'new submission': 'New Submission', underwriting: 'Underwriting', 'underwrite declined': 'Underwrite Declined',
  'underwriting - need info': 'Underwriting - Need Info', 'underwriting complete': 'Underwriting Complete', 'offer made': 'Offer Made',
  'pending response': 'Pending Response', 'pending inspections': 'Pending Inspections', 'offer declined': 'Offer Declined',
  'offer accepted': 'Offer Accepted', 'auction.com': 'Auction.com',
  // "US" is a Podio option with no meaning anyone recorded; 12 Offerpad rows bulk-loaded in one minute. Parked at New Submission, raw value kept in the notes.
  us: 'New Submission',
};
/** A Submissions "Stage" cell → CLOZR seller stage (double spaces and case folded). Unknown → null. */
export const submissionStage = (v: unknown) => SUBMISSION_STAGE[one(v).toLowerCase()] ?? null;

// ---------------------------------------------------------------- funds

export const FUNDS = ['Reination', 'Wedgewood', 'Maymont', 'Fortune', 'Bayview', 'Truehold', 'Tricon'];
export const fundsIn = (v: unknown) => {
  const t = one(v).toLowerCase().replace(/[^a-z]/g, '');
  return FUNDS.filter((f) => t.includes(f.toLowerCase()) || (f === 'Reination' && /renation|reination/.test(t)));
};

// ---------------------------------------------------------------- plan
