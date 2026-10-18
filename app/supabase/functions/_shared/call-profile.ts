/**
 * Who is on the line, from the live transcript: the pure half of the
 * `call-profile` edge function. No network, no database, no Deno, no imports,
 * so the dialer (lib/call-profile.ts) and the test
 * (`npx tsx tools/call-profile.test.ts`) run the same code the function does.
 *
 * The model reads the call and says what kind of contact the other party is
 * (a buyer, a seller, an agent…) and what they said about themselves: name,
 * company, email, and for a buyer the buy box. Every field it returns carries
 * the words it came from, and a field whose words are not in the transcript is
 * dropped here: a profile is filled from what was said, never from a guess.
 */

export const PROFILE_KINDS = ['buyer', 'seller', 'agent', 'wholesaler', 'vendor', 'unknown'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

// The codes lib/buyer-profile.ts stores in buyers.criteria, so a suggestion
// drops straight into the profile form.
export const STRATEGY_CODES = ['fix_and_flip', 'buy_and_hold', 'brrrr', 'new_construction', 'short_term_rental', 'wholetail', 'owner_finance', 'subject_to'] as const;
export const PROPERTY_TYPE_CODES = ['single_family', 'multi_family_2_4', 'multi_family_5_plus', 'townhouse', 'condo', 'mobile_home', 'land', 'commercial'] as const;
/** The heaviest rehab they will take, lightest first (buyer-profile REHAB_LEVELS). */
export const REHAB_CODES = ['move_in', 'cosmetic', 'medium', 'heavy', 'gut'] as const;
export const FUNDING_CODES = ['cash', 'hard_money', 'private', 'dscr', 'conventional', 'line_of_credit'] as const;
/** buyer-profile BUYER_TYPES; `developer` is the app's "Builder / developer". */
export const BUYER_TYPE_CODES = ['flipper', 'landlord', 'developer', 'institutional', 'fund', 'investor', 'wholesaler', 'agent'] as const;

export type ProfileField =
  | 'name' | 'company' | 'email' | 'buyerType'
  | 'markets' | 'price' | 'propertyTypes' | 'strategies' | 'rehabTolerance' | 'closingDays' | 'funding';

export const PROFILE_FIELDS: readonly ProfileField[] = [
  'name', 'company', 'email', 'buyerType', 'markets', 'price', 'propertyTypes', 'strategies', 'rehabTolerance', 'closingDays', 'funding',
];

export type CallBuyBox = {
  markets: string[];
  priceMin: number | null;
  priceMax: number | null;
  propertyTypes: string[];
  strategies: string[];
  rehabTolerance: string | null;
  /** How fast they close, in days. */
  closingDays: number | null;
  funding: string[];
};

export type CallProfile = {
  kind: ProfileKind;
  /** 0–1: how sure the model is about `kind`. */
  confidence: number;
  name: string | null;
  company: string | null;
  email: string | null;
  buyerType: string | null;
  buyBox: CallBuyBox;
  /** One or two plain sentences on anything else worth keeping. */
  notes: string | null;
  /** The words each field came from, as said on the call. */
  evidence: Partial<Record<ProfileField, string>>;
};

export const emptyProfile = (): CallProfile => ({
  kind: 'unknown', confidence: 0, name: null, company: null, email: null, buyerType: null,
  buyBox: { markets: [], priceMin: null, priceMax: null, propertyTypes: [], strategies: [], rehabTolerance: null, closingDays: null, funding: [] },
  notes: null, evidence: {},
});

/** The fields that hold something, in display order. */
export function filledFields(p: CallProfile): ProfileField[] {
  const b = p.buyBox;
  const has: Record<ProfileField, boolean> = {
    name: !!p.name, company: !!p.company, email: !!p.email, buyerType: !!p.buyerType,
    markets: b.markets.length > 0, price: b.priceMin != null || b.priceMax != null, propertyTypes: b.propertyTypes.length > 0,
    strategies: b.strategies.length > 0, rehabTolerance: !!b.rehabTolerance, closingDays: b.closingDays != null, funding: b.funding.length > 0,
  };
  return PROFILE_FIELDS.filter((f) => has[f]);
}

// ---- the transcript ---------------------------------------------------------------

export const TRANSCRIPT_MAX = 6000;

/** The call as "Rep: …" / "Caller: …" lines. */
export function transcriptText(lines: readonly { rep: boolean; text: string }[], repLabel = 'Rep', otherLabel = 'Caller'): string {
  return lines
    .map((l) => ({ who: l.rep ? repLabel : otherLabel, text: String(l.text ?? '').replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text)
    .map((l) => `${l.who}: ${l.text}`)
    .join('\n');
}

/** The last `max` characters, cut at a line start so no line arrives half said. */
export function tailTranscript(text: string, max = TRANSCRIPT_MAX): string {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(t.length - max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
}

/** Lowercase words only, so a quote matches whatever the punctuation and curly quotes did. */
export const normalizeSpeech = (s: string) => String(s ?? '').toLowerCase().replace(/['‘’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** True when the quote (its first 80 characters) was said on the call. */
export function quoteInTranscript(quote: string | null | undefined, transcript: string): boolean {
  const full = normalizeSpeech(quote ?? '');
  // The first 80 characters, back to a whole word.
  const q = full.length > 80 ? full.slice(0, 80).replace(/\s+\S*$/, '') : full;
  if (q.length < 3) return false;
  return ` ${normalizeSpeech(transcript)} `.includes(` ${q} `);
}

// ---- the model's answer, checked -----------------------------------------------------

const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null => {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
};
const pickAll = <T extends string>(v: unknown, allowed: readonly T[], max = 8): T[] =>
  Array.from(new Set((Array.isArray(v) ? v : []).map((x) => pick(x, allowed)).filter((x): x is T => !!x))).slice(0, max);

/** Dollars. "180" in a price conversation is $180,000; anything under $5,000 is read as thousands. */
export function dollars(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = n < 5000 ? n * 1000 : n;
  return d > 100_000_000 ? null : Math.round(d);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export type ParseOptions = {
  /** False drops the notes (the function passes its slop check here). */
  notesOk?: (notes: string) => boolean;
};

/**
 * The model's tool input as a CallProfile. Unknown values become null, enum
 * values off the list are dropped, and every field without a quote that is
 * really in the transcript is dropped with its quote.
 */
export function parseCallProfile(raw: unknown, transcript: string, opts: ParseOptions = {}): CallProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bb = (r.buyBox && typeof r.buyBox === 'object' ? r.buyBox : {}) as Record<string, unknown>;
  const ev = (r.evidence && typeof r.evidence === 'object' ? r.evidence : {}) as Record<string, unknown>;
  const p = emptyProfile();

  p.kind = pick(r.kind, PROFILE_KINDS) ?? 'unknown';
  const c = Number(r.confidence);
  p.confidence = p.kind === 'unknown' || !Number.isFinite(c) ? 0 : Math.max(0, Math.min(1, c > 1 ? c / 100 : c));

  const name = str(r.name, 60);
  p.name = name && !/\d/.test(name) && name.length >= 2 ? name : null;
  p.company = str(r.company, 80);
  const email = str(r.email, 120)?.toLowerCase() ?? null;
  p.email = email && EMAIL.test(email) ? email : null;
  p.buyerType = pick(r.buyerType, BUYER_TYPE_CODES);

  const markets = (Array.isArray(bb.markets) ? bb.markets : []).map((m) => str(m, 60)).filter((m): m is string => !!m);
  const seen = new Set<string>();
  p.buyBox.markets = markets.filter((m) => (seen.has(m.toLowerCase()) ? false : (seen.add(m.toLowerCase()), true))).slice(0, 10);
  let lo = dollars(bb.priceMin);
  let hi = dollars(bb.priceMax);
  if (lo != null && hi != null && lo > hi) [lo, hi] = [hi, lo];
  p.buyBox.priceMin = lo;
  p.buyBox.priceMax = hi;
  p.buyBox.propertyTypes = pickAll(bb.propertyTypes, PROPERTY_TYPE_CODES);
  p.buyBox.strategies = pickAll(bb.strategies, STRATEGY_CODES);
  p.buyBox.rehabTolerance = pick(bb.rehabTolerance, REHAB_CODES);
  const days = Math.round(Number(bb.closingDays));
  p.buyBox.closingDays = bb.closingDays != null && bb.closingDays !== '' && Number.isFinite(days) && days >= 1 && days <= 365 ? days : null;
  p.buyBox.funding = pickAll(bb.funding, FUNDING_CODES);

  // Every field needs its words on the call.
  for (const f of PROFILE_FIELDS) {
    const quote = str(ev[f], 200);
    if (quote && quoteInTranscript(quote, transcript)) p.evidence[f] = quote;
  }
  const keep = (f: ProfileField) => !!p.evidence[f];
  if (!keep('name')) p.name = null;
  if (!keep('company')) p.company = null;
  if (!keep('email')) p.email = null;
  if (!keep('buyerType')) p.buyerType = null;
  if (!keep('markets')) p.buyBox.markets = [];
  if (!keep('price')) { p.buyBox.priceMin = null; p.buyBox.priceMax = null; }
  if (!keep('propertyTypes')) p.buyBox.propertyTypes = [];
  if (!keep('strategies')) p.buyBox.strategies = [];
  if (!keep('rehabTolerance')) p.buyBox.rehabTolerance = null;
  if (!keep('closingDays')) p.buyBox.closingDays = null;
  if (!keep('funding')) p.buyBox.funding = [];
  const filled = new Set(filledFields(p));
  for (const f of PROFILE_FIELDS) if (!filled.has(f)) delete p.evidence[f];

  const notes = str(r.notes, 300);
  p.notes = notes && (opts.notesOk ? opts.notesOk(notes) : true) ? notes : null;
  return p;
}

/**
 * Two answers about the same call as one. The later answer wins a field it
 * has; a field it lost (the transcript window moved past it) keeps the earlier
 * value and quote. Lists are joined, since a later window often names only the
 * markets said since.
 */
export function mergeProfiles(a: CallProfile, b: CallProfile): CallProfile {
  const out = emptyProfile();
  const later = b.kind !== 'unknown';
  out.kind = later ? b.kind : a.kind;
  out.confidence = later ? b.confidence : a.confidence;
  const ev: Partial<Record<ProfileField, string>> = {};
  const scalar = <K extends 'name' | 'company' | 'email' | 'buyerType'>(k: K) => {
    out[k] = b[k] ?? a[k];
    const q = b[k] != null ? b.evidence[k] : a.evidence[k];
    if (out[k] != null && q) ev[k] = q;
  };
  scalar('name'); scalar('company'); scalar('email'); scalar('buyerType');
  const list = (k: 'markets' | 'propertyTypes' | 'strategies' | 'funding') => {
    const seen = new Set<string>();
    out.buyBox[k] = [...a.buyBox[k], ...b.buyBox[k]].filter((x) => (seen.has(x.toLowerCase()) ? false : (seen.add(x.toLowerCase()), true)));
    const q = b.buyBox[k].length ? b.evidence[k] : a.evidence[k];
    if (out.buyBox[k].length && q) ev[k] = q;
  };
  list('markets'); list('propertyTypes'); list('strategies'); list('funding');
  const bPrice = b.buyBox.priceMin != null || b.buyBox.priceMax != null;
  out.buyBox.priceMin = bPrice ? b.buyBox.priceMin : a.buyBox.priceMin;
  out.buyBox.priceMax = bPrice ? b.buyBox.priceMax : a.buyBox.priceMax;
  const priceQ = bPrice ? b.evidence.price : a.evidence.price;
  if ((out.buyBox.priceMin != null || out.buyBox.priceMax != null) && priceQ) ev.price = priceQ;
  out.buyBox.rehabTolerance = b.buyBox.rehabTolerance ?? a.buyBox.rehabTolerance;
  const rq = b.buyBox.rehabTolerance ? b.evidence.rehabTolerance : a.evidence.rehabTolerance;
  if (out.buyBox.rehabTolerance && rq) ev.rehabTolerance = rq;
  out.buyBox.closingDays = b.buyBox.closingDays ?? a.buyBox.closingDays;
  const cq = b.buyBox.closingDays != null ? b.evidence.closingDays : a.evidence.closingDays;
  if (out.buyBox.closingDays != null && cq) ev.closingDays = cq;
  out.notes = b.notes ?? a.notes;
  out.evidence = ev;
  return out;
}

// ---- the prompt ---------------------------------------------------------------------

/** The function appends UNTRUSTED_RULE and WRITING_RULE to this. */
export const CALL_PROFILE_SYSTEM = `You listen to a live phone call between a rep at Acme Homes (a real estate wholesaler in Texas) and someone who may not be in the CRM yet, and fill in a contact profile for that other person from what they say.

Rules:
- kind: what the other person is to Acme Homes. "buyer" buys houses from us (investor, flipper, landlord, builder, fund). "seller" owns a house and may sell it to us. "agent" is a real estate agent or broker. "wholesaler" sells us contracts or deals they found. "vendor" is a title company, contractor, lender or other service. "unknown" until the call makes it clear. confidence 0 to 1.
- Fill a field only when the call actually says it. Never guess, never infer from the area code or the company name, never fill a field from the rep's own details. Leave anything not said as null or an empty list.
- Every field you fill gets an entry in evidence under the same key: the exact words from the transcript it came from, copied verbatim, at most 20 words. A field without a verbatim quote is thrown away.
- name: the other person's full name as they said it. company: their company. email: as an address (they may spell it out, "marcus at alamo ridge dot com" is marcus@alamoridge.com).
- buyerType (buyers only): flipper, landlord (buy and hold), developer (builder), institutional, fund, investor (other individual investor), wholesaler, agent.
- buyBox (buyers only): markets are the cities, counties, ZIP codes or states they buy in, as said ("San Antonio", "Bexar County", "78209"). priceMin and priceMax in whole dollars ("120 to 180" is 120000 and 180000; "up to 200" is only priceMax). propertyTypes, strategies, rehabTolerance (the heaviest rehab they take: move_in, cosmetic, medium, heavy, gut) and funding use only the listed codes. closingDays: how many days they need to close ("two weeks" is 14).
- evidence keys: name, company, email, buyerType, markets, price (for priceMin and priceMax), propertyTypes, strategies, rehabTolerance, closingDays, funding.
- notes: at most two short plain sentences on anything else the team should keep (what they avoid, how they like deals sent, a follow-up they asked for). null when there is nothing.
- When the rep already knows the record type, take it as the kind unless the call clearly says otherwise.`;

const nullableString = { type: ['string', 'null'] } as const;
const codes = (xs: readonly string[]) => ({ type: 'array', items: { type: 'string', enum: [...xs] } });

/** The one tool the model answers with. */
export const CALL_PROFILE_TOOL = {
  name: 'profile',
  description: 'The contact profile filled from what was said on the call, with the quote behind every field.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...PROFILE_KINDS] },
      confidence: { type: 'number' },
      name: nullableString,
      company: nullableString,
      email: nullableString,
      buyerType: { type: ['string', 'null'], enum: [...BUYER_TYPE_CODES, null] },
      buyBox: {
        type: 'object',
        properties: {
          markets: { type: 'array', items: { type: 'string' } },
          priceMin: { type: ['number', 'null'] },
          priceMax: { type: ['number', 'null'] },
          propertyTypes: codes(PROPERTY_TYPE_CODES),
          strategies: codes(STRATEGY_CODES),
          rehabTolerance: { type: ['string', 'null'], enum: [...REHAB_CODES, null] },
          closingDays: { type: ['number', 'null'] },
          funding: codes(FUNDING_CODES),
        },
      },
      notes: nullableString,
      evidence: {
        type: 'object',
        properties: Object.fromEntries(PROFILE_FIELDS.map((f) => [f, { type: 'string' }])),
      },
    },
    required: ['kind', 'confidence', 'evidence'],
  },
} as const;
