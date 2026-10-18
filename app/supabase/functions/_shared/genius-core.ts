/**
 * Genius Mode v2 — the rules, with no I/O.
 *
 * genius-discover pulls records from RealEstateAPI and hands them here: a
 * PropertySearch row becomes a Hit, a Hit becomes zero, one or two purchase
 * events (the flipper who sold it, the investor who owns it now), events are
 * grouped by owner into buyers, and each buyer is scored against the subject.
 * Everything is a pure function of its inputs so the rules can be tested
 * without a key (genius-core.test.ts) and a saved run can be rebuilt later.
 *
 * Field names are RealEstateAPI's (developer.realestateapi.com): PropertySearch
 * rows are flat (lastSaleAmount, priorOwnerMonthsOwned, mlsSoldPrice, ...);
 * PropertyDetail nests saleHistory / mlsHistory / linkedProperties. Skip
 * trace is split: LLCs and other entities on BatchData (mapSkipBatch, the call
 * is in batchdata.ts). Individuals on RealEstateAPI; LLCs try RealEstateAPI
 * at the mail/property address (no name), then BatchData, merged (mapSkipReapi).
 *
 * Three rules the v1 function got wrong, and why this file exists:
 *  - A sale with no recorded price is still a sale. Texas and the other
 *    non-disclosure states record $0; v1 dropped every one, so a Richmond TX
 *    run scanned 1,250 sales and kept 10. The price is filled from the MLS
 *    sold price when there is one, else left null and tagged non_disclosure.
 *  - A flipped house's current owner is a retail buyer, not a cash buyer. The
 *    flipper is the PRIOR owner, who held it under flip_months and resold.
 *  - An absentee owner is not automatically a landlord, a married couple is not
 *    an entity, and an IRA custodian or relocation company is not a buyer.
 */

// deno-lint-ignore no-explicit-any
export type Any = any;

export type Kind = 'flipper' | 'landlord' | 'builder';
export type Role = 'flip' | 'hold' | 'build';
export type Strategy = 'flip' | 'rental' | 'build' | 'any';
export type PriceSource = 'recorded' | 'mls' | null;
/** Which screen asked for the search. Saved on the run so the list can say how the buyer was found. */
export type FoundVia = 'buyr' | 'facebook' | 'genius' | 'homefull';

export const PROPERTY_TYPES = ['SFR', 'CONDO', 'MFR', 'MOBILE', 'LAND'] as const;
export const DEFAULT_PROPERTY_TYPES = ['SFR'];

/** States that do not record sale prices publicly. A $0 there means "not disclosed", never "free". */
export const NON_DISCLOSURE = new Set(['AK', 'ID', 'KS', 'LA', 'MS', 'MO', 'MT', 'NM', 'ND', 'TX', 'UT', 'WY']);

export type Filters = {
  radius_mi: number;
  months: number;
  kinds: Kind[];
  property_types: string[];
  strategy: Strategy;
  asking_price: number | null;
  include_non_arms_length: boolean;
  include_institutional: boolean;
  flip_months: number;
  beds_min: number | null; beds_max: number | null;
  baths_min: number | null; baths_max: number | null;
  price_min: number | null; price_max: number | null;
  min_portfolio: number;
  /** Already-flipped houses: keep the flipper, drop the retail end buyer. */
  homefull: boolean;
  /** Buyr, Facebook, Genius, or an old Homefull run. Null on runs saved before this field. */
  found_via: FoundVia | null;
};

const clampNum = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const optNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Request body → filters, with every bound enforced here rather than trusted. */
export function parseFilters(b: Any): Filters {
  const kinds = (Array.isArray(b?.kinds) ? b.kinds : ['flipper', 'landlord']).map(String)
    .filter((k: string): k is Kind => k === 'flipper' || k === 'landlord' || k === 'builder');
  const types = (Array.isArray(b?.property_types) && b.property_types.length ? b.property_types : DEFAULT_PROPERTY_TYPES)
    .map((t: unknown) => String(t).toUpperCase()).filter((t: string) => (PROPERTY_TYPES as readonly string[]).includes(t));
  const strategy = ['flip', 'rental', 'build', 'any'].includes(b?.strategy) ? b.strategy as Strategy : 'any';
  const homefull = b?.homefull === true;
  const via = typeof b?.found_via === 'string' ? b.found_via : '';
  const found_via: FoundVia | null = via === 'buyr' || via === 'facebook' || via === 'genius' || via === 'homefull' ? via : null;
  // Homefull is the flipper search: already-flipped houses, contact the person
  // who fixed and resold, never the retail buyer who lives there now.
  const finalKinds: Kind[] = homefull ? ['flipper'] : (kinds.length ? kinds : ['flipper', 'landlord']);
  // Land is a builder's purchase. Without Builder selected it is noise (the
  // $3.7M acreage buyer at the top of a Bristol Rd run), so it is never pulled.
  const finalTypes = types.filter((t: string) => t !== 'LAND' || finalKinds.includes('builder'));
  if (finalKinds.includes('builder') && !finalTypes.includes('LAND')) finalTypes.push('LAND');
  return {
    radius_mi: clampNum(b?.radius_mi, 0.25, 10, 2),
    months: Math.round(clampNum(b?.months, 1, 36, 24)),
    kinds: finalKinds,
    property_types: finalTypes.length ? finalTypes : [...DEFAULT_PROPERTY_TYPES],
    strategy: homefull ? 'flip' : strategy,
    asking_price: optNum(b?.asking_price) || null,
    include_non_arms_length: b?.include_non_arms_length === true,
    include_institutional: b?.include_institutional === true,
    flip_months: Math.round(clampNum(b?.flip_months, 3, 36, 18)),
    beds_min: optNum(b?.beds_min), beds_max: optNum(b?.beds_max),
    baths_min: optNum(b?.baths_min), baths_max: optNum(b?.baths_max),
    price_min: optNum(b?.price_min), price_max: optNum(b?.price_max),
    min_portfolio: Math.round(clampNum(b?.min_portfolio, 0, 10000, 0)),
    homefull,
    found_via,
  };
}

// ---- small helpers ------------------------------------------------------------

/** A positive number, else null. Sale amounts under $1,000 are nominal consideration ($10 quitclaims), not prices. */
export const money = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n >= 1000 ? n : null; };
export const pos = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
/** Coordinates can be negative (every US longitude); zero is "missing". */
export const coord = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};
const bool = (v: unknown): boolean | null => (v === true || v === 'true' || v === 1 ? true : v === false || v === 'false' || v === 0 ? false : null);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const isoDate = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
export const daysBetween = (a: string | null, b: string | null): number | null =>
  a && b ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 864e5) : null;

export function miles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3959; const d2r = (x: number) => (x * Math.PI) / 180;
  const dLat = d2r(b.lat - a.lat); const dLng = d2r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(d2r(a.lat)) * Math.cos(d2r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ---- names -----------------------------------------------------------------------

const ENTITY = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|lp|llp|ltd|limited|pllc|holdings?|propert(?:y|ies)|investments?|investors?|homes|capital|group|partners|partnership|ventures|realty|rentals?|solutions|enterprises?|fund|trust|reit|equities|acquisitions?|development|builders?|construction|management|assets|residential|renovations?|remodel(?:ing)?|housing|estates?)\b/i;

/**
 * Not buyers at all: the IRA custodian holding title for someone, the relocation
 * company that owns a transferee's house for a month, lenders, securitisation
 * trusts, government and title companies. Always hidden.
 */
const NON_BUYER = /\b(relocation|cartus|sirva|weichert workforce|equity trust|ira\b|custodian|title (?:co|company|insurance)|bank\b|bancorp|mortgage|lending|lender|loan|credit union|federal national|federal home|fannie mae|freddie mac|secretary of|housing and urban|hud\b|veterans affairs|county of|city of|state of|school district|church|habitat for humanity|borrower\b|servicing|fsb\b|national association|n\.a\.|estate of|deceased|unknown)\b/i;

/** Institutional single-family operators and iBuyers. Real buyers, but not ones a dispo rep calls. Hidden unless asked for. */
const INSTITUTIONAL = /\b(invitation homes|american homes 4 rent|amh (?:\d|borrower|tr)|progress residential|tricon|firstkey|first key homes|home partners of america|hpa (?:borrower|us|ii)|vinebrook|main street renewal|opendoor|offerpad|pretium|cerberus|sfr jv|mynd|roofstock|redfin now|zillow homes|knock|orchard|homeward|yellowstone|bridge single|conrex|amherst|siebert williams|rhino ?(?:jv|sfr)|nb partners|fundrise|arrived homes|pathlight|brandywine homes|reliant|mcg homes|havenbrook|sylvan homes|fkh sfr|fkh|ih\d? borrower|srp sub)\b/i;

export const isEntity = (name: string) => ENTITY.test(name);
export const isNonBuyer = (name: string) => NON_BUYER.test(name);
export const isInstitutional = (name: string) => INSTITUTIONAL.test(name);

const cap = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bLlc\b/g, 'LLC').replace(/\bLp\b/g, 'LP').replace(/\bIi\b/g, 'II').replace(/\bIii\b/g, 'III');

/**
 * "Marlow, Elizabeth; Marlow, Sid" is two people, not an ENTITY. Deed names
 * come Last, First and joined with ';' or '&'. Returns the people as "First Last",
 * or null when the string is an entity or not in that shape.
 */
export function splitPeople(raw: string): string[] | null {
  const s = str(raw);
  if (!s || isEntity(s)) return null;
  const parts = s.split(/\s*(?:;|\s&\s|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  const people = parts.map((p) => {
    const m = p.match(/^([^,]+),\s*(.+)$/);
    return cap(m ? `${m[2]} ${m[1]}` : p);
  });
  return people.length ? people : null;
}

/** "Elizabeth Marlow & Sid Marlow" → "Elizabeth & Sid Marlow". */
export function joinPeople(people: string[]): string {
  if (people.length < 2) return people[0] ?? '';
  const last = (p: string) => p.split(/\s+/).slice(-1)[0];
  if (people.length === 2 && last(people[0]) === last(people[1])) {
    return `${people[0].split(/\s+/).slice(0, -1).join(' ')} & ${people[1]}`;
  }
  return people.join(' & ');
}

export type Owner = { name: string; entity: boolean; people: string[] };

/** A name from REAPI in whatever shape it came (string, {fullName}, {companyName}, [..]). */
export function ownerFrom(v: Any): Owner | null {
  if (!v) return null;
  if (Array.isArray(v)) {
    const parts = v.map(ownerFrom).filter((o): o is Owner => !!o);
    if (!parts.length) return null;
    const ent = parts.find((p) => p.entity);
    if (ent) return ent;
    const people = parts.flatMap((p) => p.people);
    return { name: joinPeople(people), entity: false, people };
  }
  if (typeof v === 'object') {
    const company = str(v.companyName ?? v.company ?? v.corporationName);
    if (company) return ownerFrom(company);
    const full = str(v.fullName ?? v.owner1FullName ?? v.name ?? [v.firstName, v.lastName].filter(Boolean).join(' '));
    return full ? ownerFrom(full) : null;
  }
  const s = str(v);
  if (!s) return null;
  if (isEntity(s)) return { name: cap(s), entity: true, people: [] };
  const people = splitPeople(s) ?? [cap(s)];
  return { name: joinPeople(people), entity: false, people };
}

/** The same owner however the deed spelled it: suffixes dropped, person names order-free. */
export function ownerKey(name: string | null | undefined, entity?: boolean): string {
  const base = str(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (entity ?? isEntity(str(name))) return base;
  return base.split(' ').filter((t) => t && t !== 'and' && t.length > 1).sort().join(' ');
}

export const addressKey = (s: string | null | undefined) =>
  str(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(street)\b/g, 'st').replace(/\b(avenue)\b/g, 'ave').replace(/\b(road)\b/g, 'rd').replace(/\b(drive)\b/g, 'dr')
    .replace(/\b(lane)\b/g, 'ln').replace(/\b(court)\b/g, 'ct').replace(/\b(boulevard)\b/g, 'blvd').replace(/\b(place)\b/g, 'pl')
    .replace(/\s+/g, ' ').trim();

export const phoneKey = (s: string | null | undefined) => { const d = str(s).replace(/\D+/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };

// ---- a PropertySearch row -------------------------------------------------------------

export type Hit = {
  reapi_id: string;
  address: string; city: string; state: string; zip: string;
  lat: number | null; lng: number | null;
  property_type: string | null; beds: number | null; baths: number | null; sqft: number | null; year_built: number | null;
  est_value: number | null; suggested_rent: number | null;
  last_sale_date: string | null; last_sale_amount: number | null; arms_length: boolean | null;
  mls_sold_price: number | null; mls_sold_date: string | null; mls_active: boolean; mls_listing_price: number | null; mls_listing_date: string | null;
  prior_sale_date: string | null; prior_sale_amount: number | null;
  prior_owner: Owner | null; prior_owner_months: number | null; prior_owner_mailing: string | null;
  owner: Owner | null; owner_mailing: string | null; owner_mail_parts: MailParts | null;
  owner_occupied: boolean | null; absentee: boolean | null; corporate: boolean; investor_buyer: boolean; cash_buyer: boolean | null;
  portfolio_count: number | null; portfolio_value: number | null;
  mortgage: boolean | null;
  // Filled by applyDetail when the property was enriched.
  agent: Agent | null; rented_after_purchase: boolean; enriched: boolean;
};
export type MailParts = { address: string; city: string; state: string; zip: string };
export type Agent = { name: string | null; phone: string | null; email: string | null; office: string | null };

function mailOf(m: Any): { line: string | null; parts: MailParts | null } {
  if (!m || typeof m !== 'object') return { line: str(m) || null, parts: null };
  const parts = { address: str(m.street ?? m.address), city: str(m.city), state: str(m.state), zip: str(m.zip) };
  const line = str(m.label) || [parts.address, parts.city, parts.state, parts.zip].filter(Boolean).join(', ');
  return { line: line || null, parts: parts.address ? parts : null };
}

export function mapHit(p: Any): Hit {
  const a = p?.address ?? {};
  const company = str(p?.companyName);
  const o1 = [p?.owner1FirstName, p?.owner1LastName].filter(Boolean).join(' ').trim();
  const o2 = [p?.owner2FirstName, p?.owner2LastName].filter(Boolean).join(' ').trim();
  let owner: Owner | null = null;
  if (company) owner = ownerFrom(company);
  if (!owner && (o1 || o2)) {
    const people = [o1, o2].filter(Boolean).map(cap);
    owner = { name: joinPeople(people), entity: false, people };
  }
  const mail = mailOf(p?.mailAddress);
  const pm = mailOf(p?.priorOwnerAddress);
  const ptype = str(p?.propertyType).toUpperCase() || null;
  return {
    reapi_id: str(p?.id ?? p?.propertyId),
    address: str(a.street ?? a.address), city: str(a.city), state: str(a.state).toUpperCase(), zip: str(a.zip),
    lat: coord(p?.latitude), lng: coord(p?.longitude),
    property_type: ptype, beds: pos(p?.bedrooms), baths: pos(p?.bathrooms), sqft: pos(p?.squareFeet), year_built: pos(p?.yearBuilt),
    est_value: money(p?.estimatedValue), suggested_rent: pos(p?.suggestedRent ?? p?.rentAmount),
    last_sale_date: isoDate(p?.lastSaleDate), last_sale_amount: money(p?.lastSaleAmount), arms_length: bool(p?.lastSaleArmsLength),
    mls_sold_price: money(p?.mlsSoldPrice), mls_sold_date: isoDate(p?.mlsLastSaleDate), mls_active: bool(p?.mlsActive) === true || bool(p?.mlsPending) === true,
    mls_listing_price: money(p?.mlsListingPrice), mls_listing_date: isoDate(p?.mlsListingDate),
    prior_sale_date: isoDate(p?.priorSaleDate), prior_sale_amount: money(p?.priorSaleAmount),
    prior_owner: ownerFrom(p?.priorOwner), prior_owner_months: pos(p?.priorOwnerMonthsOwned), prior_owner_mailing: pm.line,
    owner, owner_mailing: mail.line, owner_mail_parts: mail.parts,
    owner_occupied: bool(p?.ownerOccupied), absentee: bool(p?.absenteeOwner),
    corporate: bool(p?.corporateOwned) === true || !!owner?.entity,
    investor_buyer: bool(p?.investorBuyer) === true, cash_buyer: bool(p?.cashBuyer),
    portfolio_count: pos(p?.totalPropertiesOwned), portfolio_value: money(p?.totalPortfolioValue),
    mortgage: pos(p?.openMortgageBalance) != null ? true : bool(p?.freeClear) === true ? false : null,
    agent: null, rented_after_purchase: false, enriched: false,
  };
}

// ---- ATTOM (side-by-side comparison) ----------------------------------------------------------------
// ATTOM's Property API spells fields in mixed case across endpoints (saleTransDate,
// saleamt, absenteeInd), so fields are read case-insensitively.

/** A field from an ATTOM object, by any spelling of its name. */
export function at(o: Any, ...names: string[]): Any {
  if (!o || typeof o !== 'object') return undefined;
  for (const n of names) {
    if (o[n] !== undefined) return o[n];
    const k = Object.keys(o).find((x) => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined) return o[k];
  }
  return undefined;
}

/** ATTOM's property type words as Genius's four (SFR, CONDO, MFR, MOBILE) or LAND. */
export function attomType(...words: unknown[]): string | null {
  const w = words.map((x) => str(x).toUpperCase()).join(' ');
  if (!w.trim()) return null;
  if (/VACANT|LAND|LOT\b|AGRICULTUR/.test(w)) return 'LAND';
  if (/MOBILE|MANUFACTURED/.test(w)) return 'MOBILE';
  if (/CONDO|TOWNHOUSE|TOWNHOME|COOPERATIVE/.test(w)) return 'CONDO';
  if (/DUPLEX|TRIPLEX|QUADRUPLEX|FOURPLEX|MULTI|APARTMENT|2-4 UNIT|UNITS/.test(w)) return 'MFR';
  if (/SINGLE FAMILY|SFR|RESIDENTIAL/.test(w)) return 'SFR';
  return null;
}

/** The owner name an ATTOM record carries, from either endpoint's shape; '' when it has none. */
export function attomOwnerName(rec: Any): string {
  const own = at(at(rec, 'assessment') ?? {}, 'owner') ?? at(rec, 'owner') ?? {};
  const o1 = at(own, 'owner1') ?? {};
  return str(at(o1, 'fullName') ?? [at(o1, 'firstNameAndMi', 'firstName'), at(o1, 'lastName', 'lastNameAndSuffix')].filter(Boolean).join(' '));
}

/**
 * One ATTOM sale (sale/snapshot) and that property's owner (assessment/detail,
 * or property/detailowner when the assessment carries none)
 * as a Hit, so the rest of Genius cannot tell which source it came from. ATTOM's
 * snapshot carries the latest sale only, so an ATTOM hit finds the buyer of a
 * property, never the flipper who sold it.
 */
export function mapAttom(sale: Any, assessment: Any | null): Hit {
  const ad = at(sale, 'address') ?? {};
  const loc = at(sale, 'location') ?? {};
  const sum = at(sale, 'summary') ?? {};
  const bld = at(sale, 'building') ?? {};
  const rooms = at(bld, 'rooms') ?? {};
  const size = at(bld, 'size') ?? {};
  const sl = at(sale, 'sale') ?? {};
  const amt = at(sl, 'amount') ?? {};
  const asmt = at(assessment, 'assessment') ?? assessment ?? {};
  // assessment/detail nests the owner in `assessment`; property/detailowner puts it at the top.
  const own = at(asmt, 'owner') ?? at(assessment, 'owner') ?? {};
  const corporate = /^y/i.test(str(at(own, 'corporateIndicator')));
  const nameOf = (o: Any) => str(at(o, 'fullName') ?? [at(o, 'firstNameAndMi', 'firstName'), at(o, 'lastName', 'lastNameAndSuffix')].filter(Boolean).join(' '));
  const names = [at(own, 'owner1'), at(own, 'owner2'), at(own, 'owner3')].map(nameOf).filter(Boolean);
  let owner: Owner | null = null;
  if (names.length) {
    owner = corporate || isEntity(names[0]) ? { name: cap(names[0]), entity: true, people: [] } : ownerFrom(names.join(' & '));
  }
  const mailLine = str(at(own, 'mailingAddressOneLine')) || null;
  const absText = str(at(own, 'absenteeOwnerStatus') ?? at(sum, 'absenteeInd'));
  const absentee = absText ? /absentee|not\s*=|^a$/i.test(absText) && !/owner occupied|^o$/i.test(absText) : null;
  const ident = at(sale, 'identifier') ?? {};
  const id = str(at(ident, 'attomId', 'Id', 'obPropId'));
  const how = str(at(amt, 'cashOrMortgagePurchase', 'saleCashOrMortgage'));
  return {
    reapi_id: `attom:${id}`,
    address: str(at(ad, 'line1')), city: str(at(ad, 'locality')), state: str(at(ad, 'countrySubd')).toUpperCase(), zip: str(at(ad, 'postal1')),
    lat: coord(at(loc, 'latitude')), lng: coord(at(loc, 'longitude')),
    property_type: attomType(at(sum, 'propType', 'proptype'), at(sum, 'propSubType', 'propsubtype'), at(sum, 'propLandUse'), at(sum, 'propClass')),
    beds: pos(at(rooms, 'beds')), baths: pos(at(rooms, 'bathsTotal', 'bathstotal')), sqft: pos(at(size, 'universalSize', 'livingSize')), year_built: pos(at(sum, 'yearBuilt', 'yearbuilt')),
    est_value: money(at(at(asmt, 'market') ?? {}, 'mktTtlValue')), suggested_rent: null,
    last_sale_date: isoDate(at(sl, 'saleTransDate', 'saleSearchDate') ?? at(amt, 'saleRecDate')),
    last_sale_amount: money(at(amt, 'saleAmt', 'saleamt')),
    // Resale / New construction are real sales; a quitclaim or a non-arm's-length transfer is not a buyer.
    arms_length: /quit|non.?arm|intra|foreclos/i.test(str(at(amt, 'saleTransType'))) ? false : null,
    mls_sold_price: null, mls_sold_date: null, mls_active: false, mls_listing_price: null, mls_listing_date: null,
    prior_sale_date: null, prior_sale_amount: null, prior_owner: null, prior_owner_months: null, prior_owner_mailing: null,
    owner, owner_mailing: mailLine, owner_mail_parts: null,
    owner_occupied: absentee === null ? null : !absentee, absentee,
    corporate: corporate || !!owner?.entity,
    investor_buyer: false, cash_buyer: /cash/i.test(how) ? true : /mort/i.test(how) ? false : null,
    portfolio_count: null, portfolio_value: null, mortgage: /mort/i.test(how) ? true : null,
    agent: null, rented_after_purchase: false, enriched: false,
  };
}

/**
 * The price a buyer paid: the recorded amount, else the MLS sold price when it
 * is the same sale (within 120 days), else null. Never a reason to drop the sale.
 */
export function salePrice(recorded: number | null, date: string | null, mls: number | null, mlsDate: string | null): { price: number | null; source: PriceSource } {
  if (recorded) return { price: recorded, source: 'recorded' };
  if (mls) {
    const gap = daysBetween(mlsDate, date);
    if (gap === null || Math.abs(gap) <= 120) return { price: mls, source: 'mls' };
  }
  return { price: null, source: null };
}

/**
 * Fold a PropertyDetail answer into a hit: sale history fills a missing price or
 * prior owner, MLS history supplies the listing agent on the purchase and shows
 * whether it was put up for rent after, linked properties give the portfolio.
 * Every read is defensive — a missing block changes nothing.
 */
export function applyDetail(h: Hit, d: Any): Hit {
  if (!d || typeof d !== 'object') return h;
  const out: Hit = { ...h, enriched: true };
  const sales: Any[] = Array.isArray(d.saleHistory) ? [...d.saleHistory] : [];
  sales.sort((x, y) => str(y?.saleDate ?? y?.recordingDate).localeCompare(str(x?.saleDate ?? x?.recordingDate)));
  const last = sales[0];
  if (last) {
    if (!out.last_sale_amount) out.last_sale_amount = money(last.saleAmount);
    if (!out.last_sale_date) out.last_sale_date = isoDate(last.saleDate ?? last.recordingDate);
    if (!out.prior_owner) out.prior_owner = ownerFrom(last.sellerNames);
    if (out.arms_length === null && typeof last.armsLength === 'boolean') out.arms_length = last.armsLength;
    if (out.mortgage === null && /financ|mortgage|loan/i.test(str(last.purchaseMethod))) out.mortgage = true;
    if (out.mortgage === null && /cash/i.test(str(last.purchaseMethod))) out.mortgage = false;
  }
  const prior = sales[1];
  if (prior) {
    if (!out.prior_sale_date) out.prior_sale_date = isoDate(prior.saleDate ?? prior.recordingDate);
    if (!out.prior_sale_amount) out.prior_sale_amount = money(prior.saleAmount);
  }
  const mls: Any[] = Array.isArray(d.mlsHistory) ? d.mlsHistory : [];
  const soldNear = mls.filter((m) => /sold|closed/i.test(str(m?.status)))
    .map((m) => ({ m, gap: Math.abs(daysBetween(isoDate(m?.statusDate), out.last_sale_date) ?? 9999) }))
    .sort((a, b) => a.gap - b.gap)[0];
  if (soldNear && soldNear.gap <= 120) {
    if (!out.mls_sold_price) out.mls_sold_price = money(soldNear.m.price);
    if (!out.mls_sold_date) out.mls_sold_date = isoDate(soldNear.m.statusDate);
    const m = soldNear.m;
    if (m.agentName || m.agentPhone || m.agentEmail) {
      out.agent = { name: str(m.agentName) || null, phone: str(m.agentPhone) || null, email: str(m.agentEmail) || null, office: str(m.agentOffice) || null };
    }
  }
  out.rented_after_purchase = mls.some((m) => /rent|lease/i.test(`${str(m?.type)} ${str(m?.status)}`)
    && !!out.last_sale_date && str(isoDate(m?.statusDate)) > out.last_sale_date);
  const lp = d.linkedProperties;
  if (lp && typeof lp === 'object') {
    const n = pos(lp.totalOwned) ?? (Array.isArray(lp.ids) ? lp.ids.length : null);
    if (n && !out.portfolio_count) out.portfolio_count = n;
    const v = money(lp.totalValue);
    if (v && !out.portfolio_value) out.portfolio_value = v;
  }
  return out;
}

// ---- purchase events ---------------------------------------------------------------------

export type Purchase = {
  reapi_id: string; role: Role;
  address: string; city: string; state: string; zip: string; lat: number | null; lng: number | null; distance_mi: number | null;
  property_type: string | null; beds: number | null; baths: number | null; sqft: number | null; year_built: number | null;
  price: number | null; price_source: PriceSource; non_disclosure: boolean; date: string | null;
  resale_price: number | null; resale_date: string | null; days_held: number | null;
  financed: boolean | null; est_value: number | null; pct_of_arv: number | null; price_per_sqft: number | null;
  agent: Agent | null; zillow: string;
};

type Event = { owner: Owner; mailing: string | null; mail_parts: MailParts | null; absentee: boolean | null; investor: boolean; cash: boolean | null; portfolio_count: number | null; portfolio_value: number | null; purchase: Purchase };

export type Subject = {
  address: string; city: string | null; state: string | null; zip: string | null; lat: number; lng: number;
  reapi_id: string | null; beds: number | null; baths: number | null; sqft: number | null; year_built: number | null; property_type: string | null;
  est_value: number | null; suggested_rent: number | null;
  arv: number | null; price: number | null; deal_id: number | null;
};

const zillow = (h: { address: string; city: string; state: string; zip: string }) =>
  `https://www.zillow.com/homes/${encodeURIComponent(`${h.address} ${h.city} ${h.state} ${h.zip}`.trim().replace(/\s+/g, '-'))}_rb/`;

function pctOfArv(price: number | null, arv: number | null): number | null {
  if (!price || !arv) return null;
  const pct = Math.round((price / arv) * 100);
  // Outside 15%-200% the purchase is not the same kind of house (a lot, a
  // fourplex, a bulk deed) and the ratio is noise — v1 showed 1568%.
  return pct >= 15 && pct <= 200 ? pct : null;
}

function inWindow(date: string | null, months: number, now: Date): boolean {
  if (!date) return false;
  const start = new Date(now); start.setMonth(start.getMonth() - months);
  return date >= start.toISOString().slice(0, 10);
}

/**
 * The purchase events one property says something about.
 *
 * Flip: the last sale is in the window and the seller (prior owner) held it
 * under flip_months — the seller bought, fixed and resold, so the SELLER is the
 * buyer we want. Their buy is the prior sale, their resale the last sale.
 *
 * Hold / build: the current owner bought in the window, does not live there,
 * and looks like an investor (entity, investor/absentee flag). Builder when the
 * lot was land or the house was built after they bought it; otherwise a hold,
 * and a hold that went back on the market for sale is a flip in progress.
 *
 * Homefull: a completed flip's current owner is the retail end buyer. Keep the
 * prior owner. If nobody has resold yet, keep only a flip in progress.
 */
export function eventsOf(h: Hit, f: Filters, subject: Subject, now = new Date()): Event[] {
  const out: Event[] = [];
  const nd = NON_DISCLOSURE.has(h.state);
  const dist = h.lat && h.lng ? Number(miles(subject, { lat: h.lat, lng: h.lng }).toFixed(2)) : null;
  if (dist !== null && dist > f.radius_mi * 1.05) return out;
  if (h.arms_length === false && !f.include_non_arms_length) return out;
  const base = {
    reapi_id: h.reapi_id, address: h.address, city: h.city, state: h.state, zip: h.zip, lat: h.lat, lng: h.lng, distance_mi: dist,
    property_type: h.property_type, beds: h.beds, baths: h.baths, sqft: h.sqft, year_built: h.year_built,
    est_value: h.est_value, zillow: zillow(h),
  };
  const land = h.property_type === 'LAND';
  const lastSale = salePrice(h.last_sale_amount, h.last_sale_date, h.mls_sold_price, h.mls_sold_date);

  // --- the flipper who sold it ---
  const heldMonths = h.prior_owner_months
    ?? (h.prior_sale_date && h.last_sale_date ? Math.round((daysBetween(h.prior_sale_date, h.last_sale_date) ?? 0) / 30.4) : null);
  if (h.prior_owner && heldMonths !== null && heldMonths <= f.flip_months && inWindow(h.last_sale_date, f.months, now) && !land) {
    const buy = h.prior_sale_amount;
    // Resold for less than they paid: a relocation or a distressed exit, not a flip.
    const loss = buy && lastSale.price && lastSale.price < buy * 0.97;
    // A person who sold within a year and a half is often just a homeowner who
    // moved. Call them a flipper only on evidence: an entity, a real margin, or
    // a quick turn.
    const margin = buy && lastSale.price ? lastSale.price / buy - 1 : null;
    const evidence = h.prior_owner.entity || (margin !== null && margin >= 0.08) || heldMonths <= 9;
    if (!loss && evidence) {
      const days = daysBetween(h.prior_sale_date, h.last_sale_date) ?? Math.round(heldMonths * 30.4);
      out.push({
        owner: h.prior_owner, mailing: h.prior_owner_mailing, mail_parts: null, absentee: null, investor: true, cash: null,
        portfolio_count: null, portfolio_value: null,
        purchase: {
          ...base, role: 'flip', price: buy, price_source: buy ? 'recorded' : null, non_disclosure: nd || !buy, date: h.prior_sale_date,
          resale_price: lastSale.price, resale_date: h.last_sale_date, days_held: days, financed: null,
          pct_of_arv: pctOfArv(buy, subject.arv), price_per_sqft: buy && h.sqft ? Math.round(buy / h.sqft) : null, agent: null,
        },
      });
    }
  }

  // --- the investor who owns it now ---
  const completedFlip = out.some((e) => e.purchase.role === 'flip' && !!e.purchase.resale_date);
  const investorish = h.corporate || h.investor_buyer || h.absentee === true;
  if (h.owner && investorish && h.owner_occupied !== true && inWindow(h.last_sale_date, f.months, now) && !(f.homefull && completedFlip)) {
    const saleYear = h.last_sale_date ? Number(h.last_sale_date.slice(0, 4)) : null;
    const built = !!(saleYear && h.year_built && h.year_built >= saleYear);
    const relisted = h.mls_active && (!h.mls_listing_date || !h.last_sale_date || h.mls_listing_date > h.last_sale_date);
    const role: Role = land || built ? 'build' : relisted && !h.rented_after_purchase ? 'flip' : 'hold';
    // Homefull wants the flipper. A hold or a new build is not that person,
    // and a completed flip's current owner was already skipped above.
    if (f.homefull && role !== 'flip') return out;
    out.push({
      owner: h.owner, mailing: h.owner_mailing, mail_parts: h.owner_mail_parts, absentee: h.absentee, investor: h.investor_buyer || h.corporate,
      cash: h.cash_buyer ?? (h.mortgage === null ? null : !h.mortgage),
      portfolio_count: h.portfolio_count, portfolio_value: h.portfolio_value,
      purchase: {
        ...base, role, price: lastSale.price, price_source: lastSale.source, non_disclosure: nd || !lastSale.price, date: h.last_sale_date,
        resale_price: null, resale_date: null, days_held: null,
        financed: h.cash_buyer === true ? false : h.mortgage,
        pct_of_arv: pctOfArv(lastSale.price, subject.arv), price_per_sqft: lastSale.price && h.sqft ? Math.round(lastSale.price / h.sqft) : null,
        agent: h.agent,
      },
    });
  }
  return out;
}

// ---- buyers -----------------------------------------------------------------------------------

/** A BatchData skip-trace request item (the call itself is in batchdata.ts). */
export type SkipRequest = { propertyAddress: { street: string; city?: string; state?: string; zip?: string }; name?: { first: string; last: string } };

export type SkipPhone = { number: string; type: string | null; dnc: boolean; score: number | null };
export type SkipHit = { name: string | null; phones: SkipPhone[]; emails: string[]; mailing: string | null };

export type Candidate = {
  key: string; owner_name: string; people: string[]; kind: Kind; corporate: boolean; institutional: boolean;
  absentee: boolean | null; mailing: string | null; mail_parts: MailParts | null;
  purchases: Purchase[]; purchase_count: number; flips: number; holds: number; builds: number;
  last_purchase: string | null; nearest_mi: number | null; lat: number | null; lng: number | null;
  avg_price: number | null; min_price: number | null; max_price: number | null; avg_ppsf: number | null; avg_days_held: number | null;
  cash: boolean | null; non_disclosure: boolean;
  portfolio_count: number | null; portfolio_value: number | null;
  likelihood: number; smart_match: boolean; smart_rank: number | null; pct_of_arv: number | null; reasons: string[];
  matched_buyer_id: number | null; match_by: 'entity' | 'name' | 'phone' | 'email' | null;
  contacts: SkipHit[] | null; contacts_at: string | null;
  /** Compare mode: which data sources found this buyer's purchases. */
  sources?: Source[];
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function kindOf(flips: number, holds: number, builds: number): Kind {
  if (builds > 0 && builds >= flips && builds >= holds) return 'builder';
  if (flips > 0 && flips >= holds) return 'flipper';
  return 'landlord';
}

/** Group events by owner. Non-buyers never make it out; institutional ones are flagged. */
export function groupBuyers(events: Event[]): Candidate[] {
  const groups = new Map<string, Event[]>();
  for (const e of events) {
    if (!e.owner.name || isNonBuyer(e.owner.name)) continue;
    const k = ownerKey(e.owner.name, e.owner.entity);
    if (!k) continue;
    const list = groups.get(k) ?? [];
    // The same property twice (found by two searches) is one purchase.
    if (!list.some((x) => x.purchase.reapi_id === e.purchase.reapi_id && x.purchase.role === e.purchase.role)) list.push(e);
    groups.set(k, list);
  }
  const out: Candidate[] = [];
  for (const [key, list] of groups) {
    const purchases = list.map((e) => e.purchase).sort((a, b) => str(b.date ?? b.resale_date).localeCompare(str(a.date ?? a.resale_date)));
    const first = list.find((e) => e.mailing) ?? list[0];
    const prices = purchases.map((p) => p.price).filter((p): p is number => !!p);
    const ppsf = purchases.map((p) => p.price_per_sqft).filter((p): p is number => !!p);
    const held = purchases.map((p) => p.days_held).filter((p): p is number => p !== null && p > 0);
    const near = purchases.filter((p) => p.distance_mi !== null).sort((a, b) => a.distance_mi! - b.distance_mi!)[0] ?? purchases[0];
    const flips = purchases.filter((p) => p.role === 'flip').length;
    const holds = purchases.filter((p) => p.role === 'hold').length;
    const builds = purchases.filter((p) => p.role === 'build').length;
    const cashes = list.map((e) => e.cash).filter((c): c is boolean => c !== null);
    const pcts = purchases.map((p) => p.pct_of_arv).filter((p): p is number => p !== null);
    const lastDates = purchases.map((p) => (p.role === 'flip' ? p.resale_date ?? p.date : p.date)).filter((d): d is string => !!d).sort();
    const portfolio = Math.max(...list.map((e) => e.portfolio_count ?? 0), purchases.length);
    out.push({
      key, owner_name: first.owner.name, people: first.owner.people, kind: kindOf(flips, holds, builds),
      corporate: list.some((e) => e.owner.entity), institutional: isInstitutional(first.owner.name),
      absentee: first.absentee, mailing: first.mailing, mail_parts: first.mail_parts,
      purchases, purchase_count: purchases.length, flips, holds, builds,
      last_purchase: lastDates[lastDates.length - 1] ?? null,
      nearest_mi: near?.distance_mi ?? null, lat: near?.lat ?? null, lng: near?.lng ?? null,
      avg_price: prices.length ? Math.round(avg(prices)!) : null,
      min_price: prices.length ? Math.min(...prices) : null, max_price: prices.length ? Math.max(...prices) : null,
      avg_ppsf: ppsf.length ? Math.round(avg(ppsf)!) : null,
      avg_days_held: held.length ? Math.round(avg(held)!) : null,
      cash: cashes.length ? cashes.filter(Boolean).length >= cashes.length / 2 : null,
      non_disclosure: purchases.some((p) => p.non_disclosure),
      portfolio_count: portfolio || null, portfolio_value: Math.max(0, ...list.map((e) => e.portfolio_value ?? 0)) || null,
      likelihood: 0, smart_match: false, smart_rank: null, pct_of_arv: pcts.length ? Math.round(avg(pcts)!) : null, reasons: [],
      matched_buyer_id: null, match_by: null, contacts: null, contacts_at: null,
    });
  }
  return out;
}

/** The More filters and the buyer-type pills, applied to built buyers. Unknown values pass: a missing price never hides a buyer. */
export function applyFilters(cands: Candidate[], f: Filters): Candidate[] {
  const inRange = (v: number | null, lo: number | null, hi: number | null) => v === null || ((lo === null || v >= lo) && (hi === null || v <= hi));
  return cands.filter((c) => {
    if (!f.kinds.includes(c.kind)) return false;
    if (f.homefull && c.flips < 1) return false;
    if (c.institutional && !f.include_institutional) return false;
    if (f.min_portfolio && (c.portfolio_count ?? c.purchase_count) < f.min_portfolio) return false;
    return c.purchases.some((p) => inRange(p.price, f.price_min, f.price_max) && inRange(p.beds, f.beds_min, f.beds_max) && inRange(p.baths, f.baths_min, f.baths_max));
  });
}

/**
 * Likelihood to buy, 0-100, with the reasons that earned it. Actual behaviour
 * near this house outweighs everything: how recently, how often, how close,
 * at what price, on what kind of house, and whether the exit fits.
 */
export function score(c: Candidate, s: Subject, f: Filters, now = new Date()): Candidate {
  const reasons: string[] = [];
  let pts = 0;
  const n = c.purchase_count;
  if (n >= 5) { pts += 25; reasons.push(`${n} buys nearby`); } else if (n >= 3) { pts += 20; reasons.push(`${n} buys nearby`); } else if (n === 2) { pts += 14; reasons.push('2 buys nearby'); } else pts += 6;
  const monthsAgo = c.last_purchase ? (now.getTime() - new Date(c.last_purchase).getTime()) / (30.4 * 864e5) : 99;
  if (monthsAgo <= 3) { pts += 18; reasons.push('active in the last 90 days'); } else if (monthsAgo <= 6) { pts += 12; reasons.push('active in the last 6 months'); } else if (monthsAgo <= 12) pts += 7; else pts += 3;
  const d = c.nearest_mi;
  if (d !== null) { if (d <= 0.5) { pts += 15; reasons.push('within half a mile'); } else if (d <= 1) { pts += 11; reasons.push('within a mile'); } else if (d <= 2) pts += 7; else if (d <= 3) pts += 4; }
  const target = f.asking_price ?? s.price;
  if (c.avg_price && target) {
    const r = target / c.avg_price;
    if (r >= 0.75 && r <= 1.25) { pts += 12; reasons.push('buys at this price'); } else if (r >= 0.5 && r <= 1.6) pts += 6;
  }
  const similar = c.purchases.some((p) =>
    (s.beds === null || p.beds === null || Math.abs(p.beds - s.beds) <= 1)
    && (s.sqft === null || p.sqft === null || Math.abs(p.sqft - s.sqft) / s.sqft <= 0.2)
    && (s.year_built === null || p.year_built === null || Math.abs(p.year_built - s.year_built) <= 15));
  if (similar && (s.beds !== null || s.sqft !== null)) { pts += 8; reasons.push('buys houses like this'); }
  const port = c.portfolio_count ?? 0;
  if (port >= 10) { pts += 8; reasons.push(`${port} properties owned`); } else if (port >= 3) pts += 5;
  if (c.cash === true) { pts += 5; reasons.push('pays cash'); }
  const fit = (f.strategy === 'flip' && c.kind === 'flipper') || (f.strategy === 'rental' && c.kind === 'landlord') || (f.strategy === 'build' && c.kind === 'builder');
  if (fit) { pts += 8; reasons.push('exit fits'); }
  if (c.matched_buyer_id) { pts += 3; reasons.push('already in your buyers'); }
  if (c.contacts?.some((h) => h.phones.some((p) => !p.dnc))) pts += 2;
  return { ...c, likelihood: Math.max(0, Math.min(100, Math.round(pts))), reasons };
}

/** Top tier by score, at least 55, about the top 12% (never fewer than 5 when that many qualify). */
export function markSmartMatch(cands: Candidate[]): Candidate[] {
  const sorted = [...cands].sort((a, b) => b.likelihood - a.likelihood || b.purchase_count - a.purchase_count);
  const quota = Math.max(5, Math.ceil(sorted.length * 0.12));
  let rank = 0;
  return sorted.map((c) => {
    const smart = rank < quota && c.likelihood >= 55;
    if (smart) rank++;
    return { ...c, smart_match: smart, smart_rank: smart ? rank : null };
  });
}

// ---- matching to the workspace's buyers ------------------------------------------------------------------

export type KnownBuyer = { id: number; name: string | null; company: string | null; email: string | null; phone_keys: string[]; contact_names: string[] };

/** Entity name, person name (either order), any phone the skip trace found, then email. */
export function matchKnown(cands: Candidate[], known: KnownBuyer[]): Candidate[] {
  const byEntity = new Map<string, number>(); const byPerson = new Map<string, number>();
  const byPhone = new Map<string, number>(); const byEmail = new Map<string, number>();
  for (const b of known) {
    if (b.company) byEntity.set(ownerKey(b.company, true), b.id);
    for (const n of [b.name, ...b.contact_names]) {
      if (!n) continue;
      byPerson.set(ownerKey(n, false), b.id);
      if (isEntity(n)) byEntity.set(ownerKey(n, true), b.id);
    }
    for (const p of b.phone_keys) if (p) byPhone.set(p, b.id);
    if (b.email) byEmail.set(b.email.toLowerCase(), b.id);
  }
  return cands.map((c) => {
    let id: number | undefined; let by: Candidate['match_by'] = null;
    if (c.corporate) { id = byEntity.get(ownerKey(c.owner_name, true)); if (id) by = 'entity'; }
    if (!id) {
      for (const p of c.people.length ? c.people : [c.owner_name]) { id = byPerson.get(ownerKey(p, false)); if (id) { by = 'name'; break; } }
    }
    if (!id && c.contacts) {
      outer: for (const h of c.contacts) {
        for (const ph of h.phones) { id = byPhone.get(phoneKey(ph.number)); if (id) { by = 'phone'; break outer; } }
        for (const e of h.emails) { id = byEmail.get(e.toLowerCase()); if (id) { by = 'email'; break outer; } }
      }
    }
    return { ...c, matched_buyer_id: id ?? null, match_by: id ? by : null };
  });
}

/**
 * A flip search and an investor search can both return the same house. The
 * flip row names the prior owner; the investor row names whoever owns it now.
 * Once a resale is on file, that current owner is the retail end buyer.
 */
export function dropRetailEndBuyers(events: Event[]): Event[] {
  const flipped = new Set(events.filter((e) => e.purchase.resale_date && e.purchase.reapi_id).map((e) => e.purchase.reapi_id));
  if (!flipped.size) return events;
  return events.filter((e) => !!e.purchase.resale_date || !e.purchase.reapi_id || !flipped.has(e.purchase.reapi_id));
}

/** The whole build, from hits to ranked buyers. Pure: a saved run's hits rebuild the same list. */
export function buildBuyers(hits: Hit[], f: Filters, s: Subject, known: KnownBuyer[], contacts: Map<string, { hits: SkipHit[]; at: string }>, now = new Date()): Candidate[] {
  const raw = hits.flatMap((h) => eventsOf(h, f, s, now));
  const events = f.homefull ? dropRetailEndBuyers(raw) : raw;
  let cands = applyFilters(groupBuyers(events), f);
  cands = cands.map((c) => { const k = contacts.get(c.key); return k ? { ...c, contacts: k.hits, contacts_at: k.at } : c; });
  cands = matchKnown(cands, known);
  return markSmartMatch(cands.map((c) => score(c, s, f, now)));
}

// ---- REAPI request bodies -----------------------------------------------------------------------------------

export type SearchPlan = { label: string; body: Record<string, unknown> };

/**
 * The PropertySearch calls a run makes. REAPI ANDs its filters, so the investor
 * signals are separate searches unioned by property id; one per property type
 * because property_type takes one value. The flip search finds houses whose
 * previous owner held them under flip_months — their current owner is a
 * homeowner, so the investor-signal searches would never see them.
 */
export function searchPlans(f: Filters, lat: number, lng: number, now = new Date()): SearchPlan[] {
  const start = new Date(now); start.setMonth(start.getMonth() - f.months);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const common: Record<string, unknown> = {
    latitude: lat, longitude: lng, radius: f.radius_mi,
    last_sale_date_min: iso(start), last_sale_date_max: iso(now),
  };
  if (!f.include_non_arms_length) common.last_sale_arms_length = true;
  if (f.beds_min !== null) common.beds_min = f.beds_min;
  if (f.beds_max !== null) common.beds_max = f.beds_max;
  if (f.baths_min !== null) common.baths_min = f.baths_min;
  if (f.baths_max !== null) common.baths_max = f.baths_max;
  const signals: [string, Record<string, unknown>][] = [];
  if (f.kinds.includes('flipper')) signals.push(['flip', { prior_owner_months_owned_max: f.flip_months }]);
  signals.push(['investor', { investor_buyer: true }], ['corporate', { corporate_owned: true }], ['absentee', { absentee_owner: true }]);
  const plans: SearchPlan[] = [];
  for (const t of f.property_types) {
    for (const [label, sig] of signals) {
      if (label === 'flip' && t === 'LAND') continue;
      plans.push({ label: `${label}:${t}`, body: { ...common, ...sig, property_type: t } });
    }
  }
  return plans;
}

/** The subject from a PropertySearch row (lookup by address), merged with what the deal knows. */
export function subjectFrom(row: Any, fallback: { address: string; city?: string | null; state?: string | null; zip?: string | null; lat?: number | null; lng?: number | null; arv?: number | null; price?: number | null; beds?: number | null; deal_id?: number | null }): Subject | null {
  const h = row ? mapHit(row) : null;
  const lat = h?.lat ?? fallback.lat ?? null; const lng = h?.lng ?? fallback.lng ?? null;
  if (!lat || !lng) return null;
  return {
    address: h?.address || fallback.address, city: h?.city || fallback.city || null, state: h?.state || fallback.state || null, zip: h?.zip || fallback.zip || null,
    lat, lng, reapi_id: h?.reapi_id || null,
    beds: h?.beds ?? fallback.beds ?? null, baths: h?.baths ?? null, sqft: h?.sqft ?? null, year_built: h?.year_built ?? null, property_type: h?.property_type ?? null,
    est_value: h?.est_value ?? null, suggested_rent: h?.suggested_rent ?? null,
    arv: fallback.arv ?? h?.est_value ?? null, price: fallback.price ?? null, deal_id: fallback.deal_id ?? null,
  };
}

// ---- skip trace --------------------------------------------------------------------------------------------------

/** A DNC flag as a boolean or a string; anything that is not an explicit no counts as on the list (a TCPA miss costs more than a skipped dial). */
export function dnc(v: unknown): boolean {
  const s = str(v).toLowerCase();
  if (!s) return false;
  return !['n', 'no', 'false', '0', 'null'].includes(s);
}

/** A person's name in BatchData's shape ({ first, middle, last, full }). */
const fullName = (n: Any): string | null => str(n?.full) || [n?.first, n?.middle, n?.last].map(str).filter(Boolean).join(' ') || null;

/** One RealEstateAPI SkipTrace answer as SkipHits (individual owners are traced here, at $0.05 a hit). */
export function mapSkipReapi(j: Any): SkipHit[] {
  const persons: Any[] = Array.isArray(j?.persons) ? j.persons
    : j?.output?.identity ? [j.output.identity]
    : Array.isArray(j?.data?.persons) ? j.data.persons : [];
  return persons.map((p): SkipHit => {
    const a = p?.address ?? {};
    return {
      name: str(p?.fullName) || [p?.firstName, p?.lastName].filter(Boolean).join(' ') || null,
      phones: (p?.phones ?? []).map((ph: Any) => ({
        number: str(ph?.phone ?? ph?.phoneDisplay), type: str(ph?.phoneType) || null, dnc: dnc(ph?.phoneFtcDnc ?? ph?.doNotCall),
        score: pos(ph?.phoneUsage12Month),
      })).filter((ph: SkipPhone) => ph.number),
      emails: (p?.emails ?? []).map((e: Any) => str(typeof e === 'string' ? e : e?.email)).filter(Boolean),
      mailing: [a.streetAddress ?? a.address, a.city, a.state, a.zip].filter(Boolean).join(', ') || null,
    };
  }).filter((h) => h.phones.length || h.emails.length);
}

/**
 * One BatchData skip-trace answer (a result.data item) as SkipHits, one per
 * person it matched — empty for a genuine no-match or a person with no way to
 * reach them. A phone flagged DNC or TCPA, or any phone of a person BatchData
 * marks a litigator or deceased, stays in the list marked dnc: it still shows
 * as do-not-call, and nothing in CLOZR dials or texts a dnc number.
 */
export function mapSkipBatch(d: Any): SkipHit[] {
  if (!d || d?.meta?.matched === false || d?.meta?.error === true) return [];
  const fallbackMail = d?.property?.mailingAddress;
  const persons: Any[] = Array.isArray(d?.persons) ? d.persons : [];
  return persons.map((p: Any): SkipHit => {
    const never = dnc(p?.litigator) || dnc(p?.deceased);
    const addrs: Any[] = Array.isArray(p?.addresses) ? p.addresses : [];
    const a = addrs.find((x) => x?.propertyMailingAddress) ?? addrs[0] ?? fallbackMail ?? {};
    return {
      name: fullName(p?.name),
      phones: (Array.isArray(p?.phones) ? p.phones : []).map((ph: Any) => ({
        number: str(ph?.number), type: str(ph?.type) || null, dnc: never || dnc(ph?.dnc) || dnc(ph?.tcpa),
        // BatchData scores a phone by rank (1 is best, mobiles first) rather than
        // out of 100, and the phones arrive in that order, so there is no score to carry.
        score: null,
      })).filter((ph: SkipPhone) => ph.number),
      emails: (Array.isArray(p?.emails) ? p.emails : []).map((e: Any) => str(typeof e === 'string' ? e : e?.email)).filter(Boolean),
      mailing: str(a.fullAddress) || [a.street, a.city, a.state, a.zip].map(str).filter(Boolean).join(', ') || null,
    };
  }).filter((h: SkipHit) => h.phones.length || h.emails.length);
}

const phoneDigits = (n: string) => n.replace(/\D/g, '').slice(-10);

/** Combine RealEstateAPI and BatchData hits; dedupe phones and emails. */
export function mergeSkipHits(...lists: SkipHit[][]): SkipHit[] {
  const out: SkipHit[] = [];
  const seenPhone = new Set<string>();
  const seenEmail = new Set<string>();
  for (const h of lists.flat()) {
    const phones = h.phones.filter((p) => {
      const k = phoneDigits(p.number);
      if (k.length < 10 || seenPhone.has(k)) return false;
      seenPhone.add(k);
      return true;
    });
    const emails = h.emails.filter((e) => {
      const k = e.trim().toLowerCase();
      if (!k || seenEmail.has(k)) return false;
      seenEmail.add(k);
      return true;
    });
    if (phones.length || emails.length) out.push({ name: h.name, phones, emails, mailing: h.mailing });
  }
  return out;
}

/** RealEstateAPI SkipTrace body: individuals by name + address; LLCs by mail address only (no names). */
export function reapiSkipBody(
  c: Pick<Candidate, 'corporate'>,
  where: MailParts,
  name: { first: string; last: string } | null,
): Record<string, string> {
  const street = where.address;
  const city = where.city;
  const state = where.state;
  const zip = where.zip;
  if (c.corporate) {
    return {
      mail_address: street,
      ...(city ? { mail_city: city } : {}),
      ...(state ? { mail_state: state } : {}),
      ...(zip ? { mail_zip: zip } : {}),
      address: street,
      ...(city ? { city } : {}),
      ...(state ? { state } : {}),
      ...(zip ? { zip } : {}),
    };
  }
  return {
    address: street,
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    ...(zip ? { zip } : {}),
    ...(name ? { first_name: name.first, last_name: name.last } : {}),
  };
}

/** Parse "123 Main, Austin, TX 78701" (state case-insensitive). */
export function parseMailingLine(mailing: string): MailParts | null {
  const line = str(mailing);
  if (!line) return null;
  let m = line.match(/^(.+?),\s*([^,]+),\s*([A-Za-z]{2})\.?,?\s*(\d{5})/);
  if (m) return { address: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] };
  m = line.match(/^(.+?),\s*([^,]+),\s*([A-Za-z]{2})\s*(\d{5})/);
  if (m) return { address: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] };
  return null;
}

function mailPartsOk(parts: MailParts | null | undefined): MailParts | null {
  if (!parts?.address) return null;
  const street = str(parts.address);
  const city = str(parts.city);
  const state = str(parts.state).toUpperCase();
  const zip = str(parts.zip).slice(0, 5);
  if (!street || !(zip || (city && state))) return null;
  return { address: street, city, state, zip };
}

/** Where to trace: mailing, then any purchase (including a flip subject property for an LLC). */
export function traceMailParts(c: Pick<Candidate, 'mail_parts' | 'mailing' | 'purchases'>): MailParts | null {
  const fromParts = mailPartsOk(c.mail_parts);
  if (fromParts) return fromParts;
  if (c.mailing) {
    const parsed = parseMailingLine(c.mailing);
    const ok = mailPartsOk(parsed);
    if (ok) return ok;
  }
  const hold = c.purchases.find((p) => p.role !== 'flip') ?? c.purchases[0];
  if (hold) return mailPartsOk({ address: hold.address, city: hold.city, state: hold.state, zip: hold.zip });
  return null;
}

/** Minimal purchase row so CRM bulk skip trace can fall back to a property address. */
export function tracePurchaseStub(parts: MailParts): Purchase {
  return {
    reapi_id: '', role: 'hold', address: parts.address, city: parts.city, state: parts.state, zip: parts.zip,
    lat: null, lng: null, distance_mi: null, property_type: null, beds: null, baths: null, sqft: null, year_built: null,
    price: null, price_source: null, non_disclosure: false, date: null, resale_price: null, resale_date: null, days_held: null,
    financed: null, est_value: null, pct_of_arv: null, price_per_sqft: null, agent: null, zillow: '',
  };
}

/**
 * Who to trace for a buyer and where. An entity is traced at its mailing
 * address (that is where the person behind the LLC lives or works); a person by
 * name at their mailing address, else at the purchase. A flipper's purchase
 * address is the retail buyer's home now, so it is only the last resort.
 */
/**
 * Who traces an owner: individuals on RealEstateAPI ($0.05). LLCs try RealEstateAPI
 * (address-only) then BatchData; hits are merged when both return contacts.
 */
export type SkipProvider = 'batchdata' | 'reapi';

export function skipTarget(c: Pick<Candidate, 'owner_name' | 'corporate' | 'people' | 'mail_parts' | 'mailing' | 'purchases' | 'key'>): {
  owner_key: string; provider: SkipProvider; useBatch: boolean; body: SkipRequest; reapi: Record<string, string>;
} | null {
  const person = !c.corporate ? (c.people[0] ?? c.owner_name) : null;
  const names = person ? person.split(/\s+/) : [];
  const name = person && names.length > 1 ? { first: names[0], last: names.slice(1).join(' ') } : null;
  const nameBits = name ? { name } : {};
  const where = traceMailParts(c);
  if (!where) return null;
  const street = where.address;
  const city = where.city; const state = where.state; const zip = where.zip;
  return {
    owner_key: `${c.key}|${addressKey(`${street} ${zip}`)}`,
    provider: c.corporate ? 'batchdata' : 'reapi',
    /** LLCs always get BatchData after RealEstateAPI; individuals only when RealEstateAPI finds nothing. */
    useBatch: c.corporate,
    body: {
      propertyAddress: { street, ...(city ? { city } : {}), ...(state ? { state } : {}), ...(zip ? { zip } : {}) },
      ...nameBits,
    },
    reapi: reapiSkipBody(c, where, name),
  };
}

// ---- comparing sources ------------------------------------------------------------------------------

export type Source = 'reapi' | 'attom';

/**
 * Put ATTOM's hits beside RealEstateAPI's without duplicates: the same
 * property (street and ZIP) is one hit that both found — ATTOM only fills
 * what RealEstateAPI left blank — and only properties RealEstateAPI did not
 * have are added. Buyers are then built from the one merged set, so the same
 * owner is one buyer however many sources saw them.
 */
export function mergeAttom(hits: Map<string, Hit>, attom: Hit[], sources: Map<string, Set<Source>>): { added: number; matched: number } {
  const byAddr = new Map<string, string>();
  for (const [id, h] of hits) {
    if (!sources.has(id)) sources.set(id, new Set(['reapi']));
    if (h.address && h.zip) byAddr.set(addressKey(`${h.address} ${h.zip.slice(0, 5)}`), id);
  }
  let added = 0; let matched = 0;
  for (const a of attom) {
    if (!a.address || !a.zip) continue;
    const k = addressKey(`${a.address} ${a.zip.slice(0, 5)}`);
    const id = byAddr.get(k);
    // ATTOM listing the same property twice: already in.
    if (id?.startsWith('attom:')) continue;
    if (id) {
      const h = hits.get(id)!;
      sources.get(id)!.add('attom');
      hits.set(id, {
        ...h,
        owner: h.owner ?? a.owner, owner_mailing: h.owner_mailing ?? a.owner_mailing,
        last_sale_date: h.last_sale_date ?? a.last_sale_date, last_sale_amount: h.last_sale_amount ?? a.last_sale_amount,
        absentee: h.absentee ?? a.absentee, cash_buyer: h.cash_buyer ?? a.cash_buyer,
      });
      matched++;
    } else if (a.owner && !hits.has(a.reapi_id)) {
      // An ATTOM-only property with no owner name can't become a buyer: leave it out.
      hits.set(a.reapi_id, a);
      sources.set(a.reapi_id, new Set(['attom']));
      byAddr.set(k, a.reapi_id);
      added++;
    }
  }
  return { added, matched };
}

/** Which sources found each buyer, from the purchases they were built from. */
export function tagSources(cands: Candidate[], sources: Map<string, Set<Source>>): Candidate[] {
  return cands.map((c) => {
    const seen = new Set<Source>();
    for (const p of c.purchases) for (const x of sources.get(p.reapi_id) ?? ['reapi' as Source]) seen.add(x);
    return { ...c, sources: [...seen].sort() as Source[] };
  });
}
