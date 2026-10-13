/**
 * Deal Machine's judgement, on CLOZR's side.
 *
 * The Chrome extension used to be the only thing that knew what a good deal
 * is: which Facebook posts are deals, which are a lender or a realtor in
 * disguise, which houses fit the buy box, and whether the asking price
 * clears the MAO. That made every find depend on one office Chrome being open
 * and logged in. This is that knowledge as pure functions, so the cloud runner
 * (`deal-machine-cloud`) can pull InvestorLift and Facebook groups through
 * Apify on a server and decide for itself what lands.
 *
 * Ported from the upstream deal-machine site repo:
 *   chrome-extension/buybox-config.js     the buy box, metro aliases, matchesBuybox
 *   chrome-extension/content-facebook.js  isDealPost, parseDealFromPost, the vendor / listed / type gates
 *   chrome-extension/background.js        isDealFromBlockedCategory, isSfrDeal, the blacklist
 *   api/_apify.js                         apifyItemToDeal (InvestorLift actor rows)
 * Keep them in step: a rule changed there should change here.
 *
 * No imports, no I/O: tools/deal-machine-engine.test.ts runs it under tsx.
 */

// ---- shapes ---------------------------------------------------------------------

export type DmSource = 'investorlift' | 'facebook';

/** One find, whatever it came from, before judgement. */
export type Candidate = {
  source: DmSource;
  /** Stable per find: the listing or post id. A re-scrape updates the same deal. */
  sourceId: string;
  line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  /** The best place text there is, for the log when there is no street. */
  place: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  propertyType: string | null;
  asking: number | null;
  arv: number | null;
  rehab: number | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  url: string | null;
  photos: string[];
  /** Listing description or post text: what the keyword gates read. */
  text: string;
  postedAt: string | null;
  /** The Facebook group the post came from. */
  group: string | null;
  raw: unknown;
};

/** The settings the judge reads (a subset of lib/deal-machine.ts DmSettings). */
export type JudgeSettings = {
  deal: { maoPct: number; minArv: number; maxArv: number };
  markets: { enabledStates: string[]; enabledCities: string[]; mode: 'strict' | 'loose' };
};

export type Verdict = {
  /**
   * qualified: in the buy box and asking ≤ MAO.
   * buybox:    in the buy box; the MAO misses or cannot be worked (no ARV / no asking).
   * valid:     a real house deal, outside the buy box.
   * rejected:  not a deal we want at all (lender, listed, land, owner finance…).
   */
  status: 'qualified' | 'buybox' | 'valid' | 'rejected';
  reason: string;
  market: string | null;
  maxPrice: number | null;
  mao: number | null;
  clears: boolean | null;
};

export type LandPolicy = 'qualified' | 'buybox' | 'valid';

// ---- small helpers ----------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** "$186,000", "186k", 186000 → 186000. Zero, negative and junk are null. */
export function money(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (isNum(v)) return v > 0 ? v : null;
  const s = String(v).trim().toLowerCase().replace(/[$,\s]/g, '');
  const k = /k$/.test(s);
  const n = parseFloat(s.replace(/k$/, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return k ? n * 1000 : n;
}

/** Beds and baths stay fractional (2.5 baths is not 3). */
function count(v: unknown): number | null {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const text = (v: unknown, max = 500): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

const httpUrl = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 2000) : null;
};

/** First present value along a list of dotted paths. */
function firstOf(obj: unknown, keys: string[]): unknown {
  for (const k of keys) {
    const v = k.split('.').reduce<unknown>((o, part) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[part] : undefined), obj);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

const STREET_TYPE = /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|pl|place|cir|circle|pkwy|parkway|hwy|highway|ter|terrace|trl|trail|loop)\b\.?/i;

/** "123 Oak St" — a house number and a street type. "Houston, TX" is not a street. */
export function looksLikeStreet(s: string | null | undefined): boolean {
  const t = String(s ?? '').trim();
  return /^\d{1,6}\s+\S/.test(t) && STREET_TYPE.test(t);
}

// ---- the buy box ------------------------------------------------------------------
//
// An example buy box. Replace it with the criteria your own buyers give you:
// per-state max purchase price, and per-city criteria sets, any one of which
// passing is enough. A suburb counts toward the metro METRO_ALIASES names.

type Criteria = { minBeds?: number; minBaths?: number; minSqft?: number; minYear?: number; maxPriceOverride?: number };
type StateBox = { maxPrice: number; markets: Record<string, Criteria[]> };

export const BUYBOX: Record<string, StateBox> = {
  CA: { maxPrice: 600000, markets: {
    'Central Valley': [{ minBeds: 3, minBaths: 1.5, minSqft: 1000, minYear: 1960 }],
  } },
  FL: { maxPrice: 400000, markets: {
    'Tampa': [{ minBeds: 3, minBaths: 1, minSqft: 1000, minYear: 1960 }],
    'Orlando': [{ minBeds: 3, minBaths: 1, minSqft: 1000, minYear: 1960 }],
  } },
  SC: { maxPrice: 400000, markets: {
    'Columbia': [{ minBeds: 3, minBaths: 1.5, minSqft: 1000, minYear: 1970 }],
    // A city can carry its own cap below the state's.
    'Greenville': [{ minBeds: 3, minBaths: 2, minYear: 1995, maxPriceOverride: 300000 }],
  } },
  TX: { maxPrice: 500000, markets: {
    'Austin': [{ minBeds: 3, minBaths: 1.5, minSqft: 1000, minYear: 1960 }],
    'Dallas': [{ minBeds: 3, minBaths: 1, minSqft: 1000, minYear: 1950 }],
    'Fort Worth': [{ minBeds: 3, minBaths: 1, minSqft: 1000, minYear: 1950 }],
    'Houston': [{ minBeds: 3, minBaths: 1.5, minSqft: 1000, minYear: 1960 }, { minBeds: 2, minBaths: 1.5, minSqft: 1000, minYear: 1970 }],
    'San Antonio': [{ minBeds: 3, minBaths: 2, minYear: 1950 }],
  } },
};

/** The states the buy box covers: what the InvestorLift pull is scoped to. */
export const BUYBOX_STATES = Object.keys(BUYBOX);

// Suburb → the metro the buy box names. Keys are normalizeCityKey output.
const METRO_ALIASES: Record<string, Record<string, string>> = {
  CA: {
    'fresno': 'Central Valley', 'modesto': 'Central Valley', 'stockton': 'Central Valley', 'bakersfield': 'Central Valley',
  },
  TX: {
    'mesquite': 'Dallas', 'garland': 'Dallas', 'irving': 'Dallas', 'plano': 'Dallas', 'richardson': 'Dallas', 'carrollton': 'Dallas',
    'mckinney': 'Dallas', 'frisco': 'Dallas', 'allen': 'Dallas', 'grand prairie': 'Dallas', 'rowlett': 'Dallas', 'desoto': 'Dallas',
    'duncanville': 'Dallas', 'cedar hill': 'Dallas', 'lancaster': 'Dallas', 'farmers branch': 'Dallas', 'addison': 'Dallas',
    'university park': 'Dallas', 'highland park': 'Dallas',
    'arlington': 'Fort Worth', 'mansfield': 'Fort Worth', 'hurst': 'Fort Worth', 'euless': 'Fort Worth', 'bedford': 'Fort Worth',
    'grapevine': 'Fort Worth', 'north richland hills': 'Fort Worth', 'haltom city': 'Fort Worth', 'keller': 'Fort Worth',
    'southlake': 'Fort Worth', 'colleyville': 'Fort Worth',
    'pasadena': 'Houston', 'pearland': 'Houston', 'sugar land': 'Houston', 'spring': 'Houston', 'cypress': 'Houston', 'humble': 'Houston',
    'katy': 'Houston', 'missouri city': 'Houston', 'baytown': 'Houston', 'la porte': 'Houston', 'deer park': 'Houston',
    'channelview': 'Houston', 'tomball': 'Houston', 'friendswood': 'Houston', 'league city': 'Houston', 'webster': 'Houston',
    'rosenberg': 'Houston', 'stafford': 'Houston', 'bellaire': 'Houston',
    'helotes': 'San Antonio', 'live oak': 'San Antonio', 'universal city': 'San Antonio', 'leon valley': 'San Antonio',
    'shavano park': 'San Antonio', 'kirby': 'San Antonio', 'converse': 'San Antonio', 'schertz': 'San Antonio', 'cibolo': 'San Antonio',
    'round rock': 'Austin', 'cedar park': 'Austin', 'pflugerville': 'Austin', 'leander': 'Austin', 'georgetown': 'Austin',
    'bee cave': 'Austin', 'lakeway': 'Austin', 'kyle': 'Austin', 'buda': 'Austin', 'manor': 'Austin',
  },
  FL: {
    'lake magdalene': 'Tampa', 'town and country': 'Tampa', 'brandon': 'Tampa', 'riverview': 'Tampa', 'plant city': 'Tampa',
    'temple terrace': 'Tampa', 'carrollwood': 'Tampa', 'lutz': 'Tampa', 'wesley chapel': 'Tampa',
    'kissimmee': 'Orlando', 'sanford': 'Orlando', 'altamonte springs': 'Orlando', 'apopka': 'Orlando', 'winter park': 'Orlando',
    'winter garden': 'Orlando', 'oviedo': 'Orlando', 'ocoee': 'Orlando', 'casselberry': 'Orlando', 'lake mary': 'Orlando',
    'maitland': 'Orlando', 'longwood': 'Orlando',
    'orange park': 'Jacksonville', 'fleming island': 'Jacksonville', 'middleburg': 'Jacksonville', 'jacksonville beach': 'Jacksonville',
    'atlantic beach': 'Jacksonville', 'neptune beach': 'Jacksonville',
  },
  SC: {
    'mount pleasant': 'Charleston', 'north charleston': 'Charleston', 'james island': 'Charleston', 'goose creek': 'Charleston',
    'summerville': 'Charleston', 'lexington': 'Columbia', 'irmo': 'Columbia', 'cayce': 'Columbia',
    'mauldin': 'Greenville', 'simpsonville': 'Greenville', 'greer': 'Greenville', 'easley': 'Greenville', 'taylors': 'Greenville',
  },
};

// Text-only disqualifiers from the spreadsheet; the GIS ones (flood maps, tracks) are not wired.
const BUYBOX_DISQUALIFIERS = [
  /\bflood\s*zone\b/i,
  /\b(train|railroad)\s+tracks?\b/i,
  /\bbacks?\s+(?:up\s+)?to\s+(?:train|railroad|creek)/i,
  /\bdouble\s+yellow\b/i,
  /\bbusy\s+(?:road|street|hwy|highway)\b/i,
];

/** "Ft. Worth" and "Fort Worth", "St Louis" and "Saint Louis" are one key. */
export function normalizeCityKey(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[.,]/g, '').replace(/\bft\b/g, 'fort').replace(/\bst\b/g, 'saint').replace(/\s+/g, ' ').trim();
}

function metroCityFor(state: string, city: string | null): string | null {
  if (!city) return city;
  return METRO_ALIASES[state]?.[normalizeCityKey(city)] ?? city;
}

export type BuyboxMatch =
  | { ok: true; market: string; state: string; criteriaIndex: number; maxPrice: number }
  | { ok: false; reason: string };

/** The fund buy box: state cap, metro, then the first criteria set that passes. A missing fact passes (a person reviews it). */
export function matchesBuybox(c: Pick<Candidate, 'state' | 'city' | 'line1' | 'place' | 'asking' | 'beds' | 'baths' | 'sqft' | 'yearBuilt' | 'text'>): BuyboxMatch {
  const state = String(c.state ?? '').toUpperCase().slice(0, 2);
  const box = BUYBOX[state];
  if (!state || !box) return { ok: false, reason: `state not in buy box: ${state || 'unknown'}` };

  const extracted = cityFromAddress(c.place ?? c.line1);
  const candidates = [c.city, metroCityFor(state, c.city), extracted, metroCityFor(state, extracted)].filter((x): x is string => !!x);
  let market: { name: string; criteria: Criteria[] } | null = null;
  for (const city of candidates) {
    const key = normalizeCityKey(city);
    const name = Object.keys(box.markets).find((m) => normalizeCityKey(m) === key);
    if (name) { market = { name, criteria: box.markets[name] }; break; }
  }
  if (!market) return { ok: false, reason: `city not in ${state} markets: ${candidates[0] ?? 'unknown'}` };

  for (const re of BUYBOX_DISQUALIFIERS) if (re.test(c.text)) return { ok: false, reason: `disqualifier: ${re.source}` };

  const asking = c.asking ?? 0, beds = c.beds ?? 0, baths = c.baths ?? 0, sqft = c.sqft ?? 0, year = c.yearBuilt ?? 0;
  for (let i = 0; i < market.criteria.length; i++) {
    const k = market.criteria[i];
    const maxPrice = k.maxPriceOverride ?? box.maxPrice;
    if (asking > 0 && asking > maxPrice) continue;
    if (k.minBeds && beds > 0 && beds < k.minBeds) continue;
    if (k.minBaths && baths > 0 && baths < k.minBaths) continue;
    if (k.minSqft && sqft > 0 && sqft < k.minSqft) continue;
    if (k.minYear && year > 0 && year < k.minYear) continue;
    return { ok: true, market: market.name, state, criteriaIndex: i, maxPrice };
  }
  return { ok: false, reason: `${market.name}: no criteria set passed (price / beds / baths / sqft / year)` };
}

function cityFromAddress(addr: string | null | undefined): string | null {
  const m = String(addr ?? '').match(/,\s*([A-Z][a-zA-Z .'-]+)\s*,\s*[A-Z]{2}\b/);
  return m ? m[1].trim() : null;
}

// ---- gates (background.js + content-facebook.js) -------------------------------------

const BLACKLISTED_COMPANIES = [
  'new western', 'newwestern', 'new-western', 'rfp realty', 'real funds partners', 'networth realty', 'networthrealty',
  'networth-realty', 'profit homes', 'profithomes', 'profit-homes', 'we buy ugly houses', 'homevestors',
];
const BLACKLISTED_DOMAINS = [
  'newwestern.com', 'networthrealty.com', 'profithomes.com', 'rfprealty.com', 'webuyuglyhouses.com', 'homevestors.com',
];
const LENDER_KEYWORDS = [
  'hard money lend', 'private money lend', 'bridge loan', 'fix and flip loan', 'dscr loan', 'rental loan', 'private lending',
  'hard money lender', 'loan program', 'loan officer', 'origination fee', 'rates as low as', 'get pre-approved',
  'apply for a loan', 'lending partner', 'rehab loan',
];
const INSURANCE_KEYWORDS = [
  'homeowners insurance', "builder's risk", 'landlord insurance', 'insurance premium', 'insurance coverage',
  'insurance policy', 'insurance quote', 'insurance carrier', 'liability insurance', 'builder risk',
];
const VENDOR_KEYWORDS = ['book a demo', 'request a quote', 'contact sales', 'we provide services', 'our professional services'];
const OWNER_FINANCE_KEYWORDS = [
  'owner finance', 'owner-finance', 'owner financed', 'seller finance', 'seller financing', 'creative finance', 'subject to',
  'subject-to', 'seller carry', 'seller carryback', 'wraparound', 'wrap mortgage',
];
const MEETING_EVENT_KEYWORDS = [
  'eventbrite', 'meetup.com', 'meetup.co', 'lu.ma', 'evite.com', 'webinar', 'conference', 'rsvp', 'get tickets',
  'register now', 'register today', 'workshop', 'summit', 'bootcamp', 'mastermind', 'networking event', 'rei club',
  'rei meeting', 'real estate club', 'chapter meeting', 'seminar', 'live training', 'coaching program', 'virtual event',
];

/** A find that is a lender, an insurer, a vendor, an event or an owner-finance pitch. Null when it is none of those. */
export function blockedCategory(sourceUrl: string | null, body: string): string | null {
  const combined = `${sourceUrl ?? ''} ${body.slice(0, 3000)}`.toLowerCase();
  if (BLACKLISTED_COMPANIES.some((k) => combined.includes(k)) || BLACKLISTED_DOMAINS.some((d) => combined.includes(d))) return 'blacklisted company';
  if (MEETING_EVENT_KEYWORDS.some((k) => combined.includes(k))) return 'meeting or event';
  if (LENDER_KEYWORDS.some((k) => combined.includes(k))) return 'lender';
  if (INSURANCE_KEYWORDS.some((k) => combined.includes(k))) return 'insurance';
  if (VENDOR_KEYWORDS.some((k) => combined.includes(k))) return 'vendor or service';
  if (OWNER_FINANCE_KEYWORDS.some((k) => combined.includes(k))
    && !/\bno\s+(entry\s+fee|owner\s+financ|seller\s+financ|creative\s+financ)/i.test(combined)) return 'owner finance';
  if (/\bentry\s*(?:fee)?\s*:\s*\$?\s*[1-9][\d,]+/.test(combined)) return 'owner finance (entry fee)';
  return null;
}

const EXCLUDE_PROPERTY_PATTERNS = [
  /\bcondo\b/i, /\bcondominium\b/i, /\bapartment\b/i, /\bapt\.?\s*#/i, /\bunit\s*#\s*\d/i, /\bhoa\s+fees?\b/i, /\bmonthly\s+hoa\b/i,
  /\bstudio\s+(apartment|unit|condo)\b/i, /\bhigh[\s-]?rise\b/i, /\bco[\s-]?op\b/i, /\bapartment\s+complex\b/i,
  /\bcommercial\s+(property|building|space)\b/i, /\bretail\s+(space|store|property)\b/i, /\boffice\s+(space|building)\b/i,
  /\bwarehouse\b/i, /\bindustrial\s+(property|building)\b/i, /\bstrip\s+mall\b/i, /\bgas\s+station\b/i, /\bmixed[\s-]use\b/i,
  /\bnet\s+lease\b/i, /\bnnn\b/i, /\bcap\s+rate\b/i, /\bvacant\s+lot\b/i, /\braw\s+land\b/i, /\bundeveloped\s+land\b/i,
  /\blot\s+for\s+sale\b/i, /\bacreage\b/i, /\bfarm\s+(land|property)\b/i, /\bsubdivision\s+lot\b/i, /\binfill\s+lot\b/i,
  /\bbuildable\s+lot\b/i,
];
const EXCLUDED_TYPES = ['commercial', 'land', 'condo', 'condominium', 'industrial', 'retail', 'office', 'warehouse', 'lot', 'mobile', 'manufactured'];

/** Single-family only: no condo, land, commercial, 5+ units, or a creative-finance deal. Null when it is a house. */
export function notSfr(propertyType: string | null, body: string): string | null {
  const pt = String(propertyType ?? '').toLowerCase();
  if (pt && EXCLUDED_TYPES.some((e) => pt.includes(e))) return `property type: ${propertyType}`;
  if (EXCLUDE_PROPERTY_PATTERNS.some((re) => re.test(body))) return 'not single-family (condo, land or commercial)';
  if (/\b([5-9]|\d{2,})\s*units?\b/i.test(`${pt} ${body}`)) return '5+ units';
  if (/subto|subject.?to|seller.?financ|creative.?financ|owner.?financ|entry.?fee|wrap.?mortgage|wraparound/i.test(`${pt} ${body}`)) return 'creative finance';
  return null;
}

// Facebook-only: who is posting.
const FB_LENDER_SIGNALS = [
  /hard money lend/i, /private money lend/i, /bridge loan/i, /fix and flip loan/i, /dscr loan/i, /rental loan/i, /loan program/i,
  /loan officer/i, /origination fee/i, /rates as low as/i, /get (pre-?approved|approved)/i,
];
const FB_INSURANCE_SIGNALS = [/homeowners insurance/i, /builder'?s risk/i, /landlord insurance/i, /insurance (premium|coverage|policy|quote|carrier)/i];
const FB_VENDOR_SIGNALS = [
  /schedule a (free )?call/i, /free consultation/i, /book a demo/i, /get a free quote/i, /contact (sales|us today)/i,
  /we provide (services|solutions)/i, /\bcleaning\s+services?\b/i, /\bjunk\s+removal\b/i, /\bgrass\s+cutting\b/i,
  /\bweed\s*eating\b/i, /\bmulch\b.*\b(service|install)\b/i, /\b(cleaning|lawn|landscap|junk|moving|handyman)\s+services?\b/i,
  /\bservices?\b/i,
];
const FB_EVENT_SIGNALS = [
  /eventbrite\.com/i, /meetup\.com/i, /lu\.ma\//i, /evite\.com/i, /\bwebinar\b/i, /\bconference\b/i, /\brsvp\b/i, /get tickets/i,
  /register now/i, /\bworkshop\b/i, /\bsummit\b/i, /\bbootcamp\b/i, /\bmastermind\b/i, /networking event/i, /rei club/i,
  /rei meeting/i, /real estate club/i, /\bseminar\b/i, /live training/i, /virtual event/i, /chapter meeting/i,
];
const FB_LISTED_SIGNALS = [
  /\bjust listed\b/i, /\bnew (listing|listings)\b/i, /\b(listed|listing)\s+(on|with|at|this)\b/i, /\b(listed|listing)\s*[#:]\s*/i,
  /\b(property|home|house)\s+(listed|listing)\b/i, /\bmls\b/i, /\bmls\s*#?\s*\d/i, /\bmls\s+(listing|id|number)/i,
  /\bmultiple\s+listing\s+service\b/i, /\blisting\s+courtesy\s+of\b/i, /\blisting\s+agent\b/i,
];
const FB_REALTOR_SIGNALS = [
  /\brealtor\s*®?\s*(license|#|no\.?|number)/i, /\b(license|lic\.?)\s*#?\s*\d{4,}/i, /\b(license|lic\.?)\s*no\.?\s*\d+/i,
  /\bdre\s*#\s*\d+/i, /\bnmls\s*#?\s*\d+/i, /\bnrds\s*#?\s*\d+/i, /\b(state\s+)?license(d)?\s+(realtor|agent|broker)/i,
  /\b(realtor|agent|broker)\s+.*license\s*#/i, /\b\w{2}\s*license\s*#?\s*\d+/i,
];

/** A post from a lender, insurer, vendor, event, or a realtor's MLS listing. Null when it could be a deal. */
export function fbPosterBlock(body: string): string | null {
  if (FB_LENDER_SIGNALS.some((r) => r.test(body))) return 'lender post';
  if (FB_INSURANCE_SIGNALS.some((r) => r.test(body))) return 'insurance post';
  if (FB_EVENT_SIGNALS.some((r) => r.test(body))) return 'event post';
  if (FB_VENDOR_SIGNALS.filter((r) => r.test(body)).length >= 2 && !/\barv\b|wholesale|off.?market|rehab|assignment fee/i.test(body)) return 'vendor post';
  if (FB_LISTED_SIGNALS.some((r) => r.test(body)) || FB_REALTOR_SIGNALS.some((r) => r.test(body))) return 'MLS or realtor listing';
  return null;
}

const DEAL_INDICATORS = [
  /\$\s*[\d,.]+k?\b/i, /\b(asking|wholesale|cash)\s*(?:price|offer)?\s*[:$]?\s*\$?[\d,.]+/i, /\barv\b/i,
  /\bafter[\s-]?repair[\s-]?value\b/i, /\brehab\s*[:$]?\s*\$?[\d,.]+/i, /\b\d{1,2}\s*\/\s*\d{1,2}\b/i, /\b\d\s*(?:bed|bd|br)\b/i,
  /\b\d\s*(?:bath|ba)\b/i, /\bbeds?\b|\bbaths?\b|\bbd\b|\bba\b/i, /\bsq\.?\s*ft\b|\bsqft\b|\bsq\s*feet\b/i, /\bflip\b/i,
  /\bfixer\b|\bfixer[\s-]?upper\b/i, /\boff[\s-]?market\b/i, /\bcash\s*price\b|\bcash\s*deal\b|\bcash\s*buyer\b/i,
  /\binvestor\s*(?:special|opportunity|friendly|property)\b/i, /\bwholesale\b|\bassignable\b|\bassignment\b/i,
  /\bduplex\b|\btriplex\b|\bquad\b|\bmulti[\s-]?family\b/i, /\b(buy[\s-]?and[\s-]?hold|rental|brrrr|buy\s*it\s*cheap)\b/i,
  /\bmotivated[\s-]?seller\b|\bestate[\s-]?sale\b|\bprobate\b/i, /\bfor\s+sale\b|\bfsbo\b|\bby[\s-]?owner\b/i,
  /\bunder[\s-]?contract\b|\bassigning\s+(this|the)?\s*contract\b/i, /\b[A-Z][a-z]{2,}\s*,?\s+[A-Z]{2}\b.*\$\s*[\d]/,
];

/** Does this post read like a deal at all? Tolerant on purpose; the judge is the strict part. */
export function isDealPost(body: string): boolean {
  return DEAL_INDICATORS.some((re) => re.test(body));
}

// ---- reading a Facebook post ---------------------------------------------------------

function extractMoney(body: string, patterns: RegExp[]): number | null {
  for (const p of patterns) {
    const m = body.match(p);
    const v = m ? money(m[1]) : null;
    if (v !== null) return v;
  }
  return null;
}

/** A post that only says "$150,000" or "$150k" still has an asking price; the last such figure in $10k–$5M wins. */
function bareAsking(body: string): number | null {
  const re = /\$\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*k)\b/gi;
  let last: number | null = null;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const v = money(m[1]);
    if (v !== null && v >= 10_000 && v <= 5_000_000) last = v;
  }
  return last;
}

export type PostFacts = {
  line1: string | null; city: string | null; state: string | null; zip: string | null; place: string | null;
  asking: number | null; arv: number | null; rehab: number | null;
  beds: number | null; baths: number | null; sqft: number | null; yearBuilt: number | null;
  phone: string | null; email: string | null;
};

/** The deal facts in a post's text (content-facebook.js parseDealFromPost). */
export function parsePostText(body: string): PostFacts {
  const t = String(body ?? '');

  // Street: number + street type, the span bounded so it cannot swallow sentences.
  const streetM = t.match(/(\d{1,5}\s+[\w\s.]{0,40}?(?:street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|ln\.?|blvd\.?|boulevard|court|ct\.?|way|place|pl\.?|circle|cir\.?)\b)/i);
  const line1 = streetM ? streetM[1].replace(/\s+/g, ' ').trim() : null;

  // City, ST [zip] — after the street when there is one, else anywhere.
  const after = streetM ? t.slice((streetM.index ?? 0) + streetM[0].length) : t;
  const cityState = after.match(/^[,\s]+([A-Za-z][A-Za-z .'-]{1,40}?),?\s+([A-Z]{2})\b(?:\s+(\d{5}))?/)
    ?? t.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2})\b(?:\s+(\d{5}))?/);
  const city = cityState ? cityState[1].trim() : null;
  const state = cityState ? cityState[2] : null;
  const zip = cityState?.[3] ?? (t.match(/\b([A-Z]{2})\s+(\d{5})\b/)?.[2] ?? null);

  let place: string | null = [line1, [city, state].filter(Boolean).join(', ')].filter(Boolean).join(', ') || null;
  if (!place) place = t.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+County)/)?.[1] ?? t.match(/\b(?:in|near)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/)?.[1] ?? null;

  const arv = extractMoney(t, [
    /arv[:\s]*\$?([\d,.]+k?)\b/i, /a\.?r\.?v\.?\s*[:\-=]\s*\$?([\d,.]+k?)\b/i, /after[\s-]repair[\s-]value[:\s]*\$?([\d,.]+k?)\b/i,
    /(?:comp|comps|market)\s*(?:value)?[:\s]*\$?([\d,.]+k?)\b/i, /value[:\s]*\$?([\d,.]+k?)\b/i,
  ]);
  const rehab = extractMoney(t, [
    /rehab[:\s]*\$?([\d,.]+k?)\b/i, /repair[s]?[:\s]*\$?([\d,.]+k?)\b/i, /renovation[s]?[:\s]*\$?([\d,.]+k?)\b/i,
    /est(?:imated)?\s*repair[s]?[:\s]*\$?([\d,.]+k?)\b/i, /fix[\s-]?up[:\s]*\$?([\d,.]+k?)\b/i,
  ]);
  const asking = extractMoney(t, [
    /asking[:\s]*\$?([\d,.]+k?)\b/i, /ask[ing]*[:\s]*\$?([\d,.]+k?)\b/i, /wholesale[\s-]?price[:\s]*\$?([\d,.]+k?)\b/i,
    /contract[\s-]?price[:\s]*\$?([\d,.]+k?)\b/i, /purchase[\s-]?price[:\s]*\$?([\d,.]+k?)\b/i,
    /list[ing]?[\s-]?price[:\s]*\$?([\d,.]+k?)\b/i, /price[:\s]*\$?([\d,.]+k?)\b/i,
    /\$\s*([\d,.]+k?)\s*(?:obo|or best offer|firm|negotiable|cash)/i, /\$\s*([\d,.]+k?)\s*(?:as[\s-]is)/i,
  ]) ?? bareAsking(t);

  // "3/2" is beds/baths; "10/8/2026" is a date.
  const bb = t.match(/(?<![\d/])([1-9])\s*\/\s*([1-9](?:\.5)?)(?![\d/])/);
  const beds = bb ? Number(bb[1]) : count(t.match(/\b(\d{1,2})\s*(?:bed|bd|br)s?\b/i)?.[1]);
  const baths = bb ? Number(bb[2]) : count(t.match(/\b(\d(?:\.\d)?)\s*(?:bath|ba)s?\b/i)?.[1]);
  const sqftM = t.match(/\b([\d,]{3,6})\s*(?:sq\.?\s*ft|sqft|sf|square\s+feet)\b/i);
  const sqft = sqftM ? Number(sqftM[1].replace(/,/g, '')) || null : null;
  const yearM = t.match(/\b(?:built(?:\s+in)?|year\s+built|yr\s+built)[:\s]*((?:18|19|20)\d{2})\b/i);
  const yearBuilt = yearM ? Number(yearM[1]) : null;

  const email = t.match(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i)?.[1].toLowerCase() ?? null;
  const ph = t.match(/(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/);
  const phone = ph ? `${ph[1]}${ph[2]}${ph[3]}` : null;

  return { line1, city, state, zip, place, asking, arv, rehab, beds, baths, sqft, yearBuilt, phone, email };
}

// ---- Apify rows → candidates ------------------------------------------------------------

/**
 * One row of the InvestorLift actor (convertfleetdotonline~investorlift-property-scraper),
 * mapped like api/_apify.js. `full_address` is null on most rows; `public_address` is
 * "County, City, ST ZIP", so there is usually a city and no street.
 */
export function fromInvestorLift(item: Record<string, unknown>): Candidate | null {
  const url = httpUrl(item.property_url);
  const id = (url?.match(/\/marketplace\/deal\/([^/?#]+)/i) ?? [])[1] ?? text(item.id, 100);
  if (!id) return null;
  if (item.available === false || /off[_\s-]?market|sold|pending/i.test(String(item.status ?? ''))) return null;
  const full = text(item.full_address);
  const city = text(item.city, 80);
  const state = text(item.state, 2)?.toUpperCase() ?? null;
  const zip = text(item.zip, 10);
  const line1 = full && looksLikeStreet(full.split(',')[0]) ? full.split(',')[0].trim() : null;
  const description = String(item.description ?? '');
  const photos = (Array.isArray(item.images) ? item.images : [])
    .map((p) => httpUrl(typeof p === 'string' ? p : (p as Record<string, unknown> | null)?.url))
    .filter((u): u is string => !!u);
  return {
    source: 'investorlift',
    sourceId: `investorlift:${id}`,
    line1, city, state, zip, county: text(item.county, 80),
    place: full ?? ([city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || text(item.public_address)),
    beds: count(item.bedrooms), baths: count(item.bathrooms), sqft: count(item.sq_footage), yearBuilt: count(item.year_built),
    propertyType: text(item.property_type, 80),
    asking: money(item.price), arv: money(item.arv_estimate), rehab: money(firstOf(item, ['rehab', 'rehab_estimate', 'repairs'])),
    contactName: text(firstOf(item, ['contact_name', 'dispo_manager', 'agent_name', 'company_name']), 120),
    phone: text(item.phone_number, 40), email: text(item.email, 200)?.toLowerCase() ?? null,
    url, photos, text: `${text(item.title) ?? ''}\n${description}`.trim(),
    postedAt: text(item.created_at, 40), group: null, raw: item,
  };
}

/** One post from apify~facebook-groups-scraper. Only posts that read like a deal come back. */
export function fromFacebookPost(item: Record<string, unknown>, now = Date.now(), maxAgeDays = 3): Candidate | null {
  const body = String(firstOf(item, ['text', 'message', 'postText']) ?? '').trim();
  if (body.length < 20 || !isDealPost(body)) return null;
  const posted = text(firstOf(item, ['time', 'timestamp', 'date', 'createdAt']), 40);
  const postedMs = posted ? Date.parse(posted) : NaN;
  if (Number.isFinite(postedMs) && now - postedMs > maxAgeDays * 86_400_000) return null;
  const url = httpUrl(firstOf(item, ['url', 'postUrl', 'permalink']));
  const id = text(firstOf(item, ['postId', 'legacyId', 'id']), 120) ?? url;
  if (!id) return null;
  const f = parsePostText(body);
  const photos = (Array.isArray(item.attachments) ? item.attachments : [])
    .map((a) => httpUrl(firstOf(a, ['photo_image.uri', 'image.uri', 'thumbnail', 'url'])))
    .filter((u): u is string => !!u && !/facebook\.com\/(?:groups|story)/i.test(u));
  return {
    source: 'facebook',
    sourceId: `fb:${id}`.slice(0, 256),
    line1: f.line1, city: f.city, state: f.state, zip: f.zip, county: null, place: f.place,
    beds: f.beds, baths: f.baths, sqft: f.sqft, yearBuilt: f.yearBuilt, propertyType: null,
    asking: f.asking, arv: f.arv, rehab: f.rehab,
    contactName: text(firstOf(item, ['user.name', 'authorName', 'author.name']), 120),
    phone: f.phone, email: f.email,
    url, photos, text: body.slice(0, 5000), postedAt: posted,
    group: text(firstOf(item, ['groupTitle', 'groupName', 'facebookUrl']), 200), raw: item,
  };
}

// ---- the judge ---------------------------------------------------------------------------

/** asking ≤ maoPct% × ARV − rehab − $20k (the assignment fee the rule reserves). */
export function maoOf(arv: number | null, rehab: number | null, maoPct = 70): number | null {
  if (arv === null) return null;
  return Math.round(arv * (maoPct / 100) - (rehab ?? 0) - 20_000);
}

export function judge(c: Candidate, s: JudgeSettings): Verdict {
  const no = (reason: string): Verdict => ({ status: 'rejected', reason, market: null, maxPrice: null, mao: null, clears: null });

  const blocked = blockedCategory(c.url, c.text);
  if (blocked) return no(blocked);
  if (c.source === 'facebook') {
    const poster = fbPosterBlock(c.text);
    if (poster) return no(poster);
  }
  const type = notSfr(c.propertyType, c.text);
  if (type) return no(type);
  if (!c.place && !c.line1 && !c.city && !c.state) return no('no location');
  if (c.asking === null && c.arv === null) return no('no asking price or ARV');

  const state = String(c.state ?? '').toUpperCase();
  const enabled = s.markets.enabledStates.map((x) => x.toUpperCase());
  if (s.markets.mode === 'strict' && state && enabled.length && !enabled.includes(state)) return no(`${state} is not an enabled state`);
  if (s.markets.mode === 'strict' && s.markets.enabledCities.length && c.city) {
    const want = s.markets.enabledCities.map(normalizeCityKey);
    const have = [normalizeCityKey(c.city), normalizeCityKey(metroCityFor(state, c.city))];
    if (!have.some((h) => want.some((w) => w && (h === w || h.startsWith(w) || w.startsWith(h))))) return no(`${c.city} is not an enabled city`);
  }
  if (c.arv !== null && s.deal.minArv > 0 && c.arv < s.deal.minArv) return no(`ARV ${Math.round(c.arv)} under ${s.deal.minArv}`);
  if (c.arv !== null && s.deal.maxArv > 0 && c.arv > s.deal.maxArv) return no(`ARV ${Math.round(c.arv)} over ${s.deal.maxArv}`);

  const mao = maoOf(c.arv, c.rehab, s.deal.maoPct);
  const clears = mao !== null && c.asking !== null ? c.asking <= mao : null;
  const box = matchesBuybox(c);
  if (!box.ok) return { status: 'valid', reason: box.reason, market: null, maxPrice: null, mao, clears };
  const where = `${box.market} #${box.criteriaIndex + 1}`;
  if (clears === true) return { status: 'qualified', reason: `${where}, asking ≤ MAO`, market: box.market, maxPrice: box.maxPrice, mao, clears };
  return {
    status: 'buybox',
    reason: clears === false ? `${where}, asking over MAO` : `${where}, MAO not workable (${c.arv === null ? 'no ARV' : 'no asking'})`,
    market: box.market, maxPrice: box.maxPrice, mao, clears,
  };
}

const RANK: Record<Verdict['status'], number> = { rejected: 0, valid: 1, buybox: 2, qualified: 3 };
const FLOOR: Record<LandPolicy, number> = { valid: 1, buybox: 2, qualified: 3 };

/** Whether a verdict is good enough to become a CLOZR record under the workspace's policy. */
export function shouldLand(v: Verdict, policy: LandPolicy): boolean {
  return RANK[v.status] >= FLOOR[policy];
}

const usd = (n: number | null) => (n === null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));

// ---- into CLOZR -------------------------------------------------------------------------

const LEAD_SOURCE: Record<DmSource, string> = { investorlift: 'investorlift', facebook: 'fb_group' };

/**
 * Most InvestorLift rows (and many posts) hide the street until you ask.
 * CLOZR files a house by its street, so without one nothing would land. The
 * listing's own id stands in, plainly marked, until a rep fills the real
 * address in; COMPR is never asked for on one of these.
 */
export function undisclosedLine(c: Pick<Candidate, 'source' | 'sourceId'>): string {
  const id = c.sourceId.replace(/^(investorlift|fb):/, '').slice(0, 60);
  return `Undisclosed (${c.source === 'investorlift' ? 'InvestorLift' : 'Facebook post'} ${id})`;
}

/** The /ingest envelope for a find, the same shape the extension posts (adapters/README.md). */
export function toEnvelope(c: Candidate, v: Verdict, opts: { runCompr: boolean; maoPct: number }) {
  const verdictLine = v.status === 'qualified'
    ? `Deal Machine: clears — asking ${usd(c.asking)} ≤ MAO ${usd(v.mao)} (${opts.maoPct}% ARV − rehab − $20k). ${v.reason}.`
    : `Deal Machine: ${v.status === 'buybox' ? 'in the buy box' : 'outside the buy box'} — ${v.reason}.`;
  const notes = [verdictLine, c.group ? `Group: ${c.group}` : null, c.url ? `Source: ${c.url}` : null, '', c.text].filter((x) => x !== null).join('\n').slice(0, 8000);
  const person = c.contactName || c.phone || c.email
    ? { name: c.contactName ?? undefined, phone: c.phone ?? undefined, email: c.email ?? undefined }
    : undefined;
  const env: Record<string, unknown> = {
    source: 'deal_machine',
    source_id: c.sourceId,
    type: 'lead.discovered',
    occurred_at: c.postedAt && !Number.isNaN(Date.parse(c.postedAt)) ? new Date(c.postedAt).toISOString() : new Date().toISOString(),
    property: {
      line1: c.line1 ?? undisclosedLine(c), city: c.city ?? undefined, state: c.state ?? undefined, zip: c.zip ?? undefined,
      county: c.county ?? undefined, beds: c.beds ?? undefined, baths: c.baths ?? undefined,
      sqft: c.sqft ? Math.round(c.sqft) : undefined, year_built: c.yearBuilt ? Math.round(c.yearBuilt) : undefined,
      property_type: c.propertyType ?? undefined,
    },
    deal: {
      asking_price: c.asking ?? undefined, arv: c.arv ?? undefined, rehab: c.rehab ?? undefined, mao: v.mao ?? undefined,
      lead_source: LEAD_SOURCE[c.source], market: v.market ?? undefined, listing_url: c.url ?? undefined,
      photos: c.photos.length ? c.photos.slice(0, 50) : undefined, notes,
    },
    raw: c.raw,
  };
  if (person) env.person = person;
  // COMPR only when it can run: a street, a state and a named contact (ingest's gate).
  if (opts.runCompr && c.line1 && c.state && c.contactName) env.options = { run_compr: true };
  return env;
}

/** "123 Oak St, Houston, TX · $150,000 / ARV $240,000" for the log. */
export function describe(c: Candidate): string {
  const where = (c.line1 ? [c.line1, c.city, c.state].filter(Boolean).join(', ') : c.place) ?? c.sourceId;
  return `${where} · asking ${usd(c.asking)} · ARV ${usd(c.arv)}${c.rehab !== null ? ` · rehab ${usd(c.rehab)}` : ''}`;
}
