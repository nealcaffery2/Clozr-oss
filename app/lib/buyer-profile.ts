// The buyer profile vocabulary and the buy-box shape stored in buyers.criteria.
//
// One normaliser for every writer (the profile form, imports, Genius Mode) so
// the matcher in the database (score_buyer_deal) always reads the same shape:
// location rows with a Restricted flag are flattened into `locations` and
// `restricted` lists, ranges are numbers or null, chip lists are string arrays.

import { stateCode } from './us-states';
export { stateCode } from './us-states';

export const BUYER_TYPES = [
  ['investor', 'Individual investor'], ['flipper', 'Flipper'], ['landlord', 'Landlord / buy & hold'], ['institutional', 'Institutional'],
  ['fund', 'Fund'], ['ibuyer', 'iBuyer'], ['developer', 'Builder / developer'], ['wholesaler', 'Wholesaler'], ['agent', 'Agent / broker'],
  ['realtors', 'Realtors'], ['other', 'Other'],
] as const;

/** Spreadsheet words that should land on a BUYER_TYPES code. */
const BUYER_TYPE_ALIASES: Record<string, string> = {
  realtor: 'realtors',
  realtors: 'realtors',
};

/** "Realtors" / "Realtor" → `realtors`. Anything else is the same slug the importer already stored. */
export function buyerTypeCode(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!slug) return null;
  return BUYER_TYPE_ALIASES[slug] ?? slug;
}
export const ENTITY_TYPES = [['individual', 'Individual'], ['llc', 'LLC'], ['corporation', 'Corporation'], ['trust', 'Trust'], ['fund', 'Fund'], ['other', 'Other']] as const;
export const STRATEGIES = [
  ['fix_and_flip', "Fix n' Flip"], ['buy_and_hold', "Buy n' Hold"], ['brrrr', 'BRRRR'], ['short_term_rental', 'Short-term rental'],
  ['wholetail', 'Wholetail'], ['subject_to', 'Subject-to / creative'], ['new_construction', 'New construction'], ['land_development', 'Land development'], ['owner_finance', 'Owner finance'],
] as const;
export const PROPERTY_TYPES = [
  ['single_family', 'Single Family Residential'], ['multi_family_2_4', 'Multi-Family 2-4 Units'], ['multi_family_5_plus', 'Multi-Family 5+ Units'],
  ['townhouse', 'Townhouse'], ['condo', 'Condo'], ['mobile_home', 'Mobile Home'], ['land', 'Land'], ['commercial', 'Commercial'],
] as const;
export const REHAB_LEVELS = [['move_in', 'Move-in ready'], ['cosmetic', 'Cosmetic'], ['medium', 'Medium'], ['heavy', 'Heavy'], ['gut', 'Full gut']] as const;
export const SPECIALTY_REHABS = [
  ['foundation', 'Foundation'], ['fire_damage', 'Fire damage'], ['mold', 'Mold'], ['roof', 'Roof'], ['termites', 'Termites'], ['sinkhole', 'Sinkhole'],
  ['asbestos', 'Asbestos'], ['flood_damage', 'Flood damage'], ['structural', 'Structural'], ['septic', 'Septic'], ['hoarder', 'Hoarder'], ['drug_infected', 'Drug infected'],
] as const;
export const LOCATION_CHIPS = [
  ['flood_zone', 'Flood Zone'], ['near_main_road', 'Near a Main Road'], ['hoa', 'HOA Community'], ['55_plus', '55+ Community'],
  ['near_commercial', 'Near Commercial'], ['water_front', 'Water Front'], ['near_railroad', 'Near Railroad'],
] as const;
export const PROPERTY_CHIPS = [
  ['pool', 'Pool'], ['garage', 'Garage'], ['solar_panels', 'Solar Panels'], ['wood_frame', 'Wood Frame'], ['driveway', 'Driveway'], ['city_water', 'City Water'],
  ['well_water', 'Well Water'], ['septic_tank', 'Septic Tank'], ['drug_infected', 'Drug Infected'], ['basement', 'Basement'], ['tenant_occupied', 'Tenant Occupied'],
] as const;
export const STRICT_OPTIONS = [
  ['locations', 'Strict locations'], ['pricing', 'Strict pricing'], ['beds_baths', 'Strict bed & bath count'],
  ['sqft', 'Strict square footage range'], ['year_built', 'Strict year built'], ['all', 'Strict all'],
] as const;
export const FUNDING = [['cash', 'Cash'], ['hard_money', 'Hard money'], ['private', 'Private money'], ['dscr', 'DSCR loan'], ['conventional', 'Conventional'], ['line_of_credit', 'Line of credit']] as const;
export const PURCHASE_METHODS = [['assignment', 'Assignment'], ['double_close', 'Double close'], ['novation', 'Novation'], ['subject_to', 'Subject-to'], ['jv', 'JV']] as const;
export const CHANNELS = [['email_and_sms', 'Email and SMS'], ['email_only', 'Email only'], ['sms_only', 'SMS only']] as const;

export type Opt = readonly (readonly [string, string])[];
export const labelOf = (list: Opt, code: string) => list.find(([c]) => c === code)?.[1] ?? code.replace(/_/g, ' ');

const fromLabels = (list: Opt): Record<string, string> => Object.fromEntries(list.map(([c, l]) => [l.toLowerCase(), c]));

/** Spreadsheet labels (Podio / DispoGenius) → strategy codes. */
export const STRATEGY_MAP: Record<string, string> = {
  ...fromLabels(STRATEGIES),
  subto: 'subject_to', 'new developments': 'new_construction', 'short term rental': 'short_term_rental', 'owner finance': 'owner_finance',
};
export const TYPE_MAP: Record<string, string> = {
  ...fromLabels(PROPERTY_TYPES),
  'town house': 'townhouse', 'manufactured homes': 'mobile_home', 'mobile home': 'mobile_home',
};
export const RESTRICTION_MAP: Record<string, string> = {
  ...fromLabels(LOCATION_CHIPS), ...fromLabels(PROPERTY_CHIPS),
  'double yellow lined road': 'near_main_road', hoa: 'hoa',
};
/** DispoGenius `no_*` / `req_*` column suffix → CLOZR location / property chip. */
export const DG_CHIPS: Record<string, string> = {
  flood_zone: 'flood_zone', hoa: 'hoa', main_roads: 'near_main_road', old_communities: '55_plus', wood_frames: 'wood_frame', pools: 'pool',
  city_water: 'city_water', driveway: 'driveway', garage: 'garage', near_commercial: 'near_commercial', septic_tank: 'septic_tank',
  solar_panels: 'solar_panels', water_front: 'water_front', well_water: 'well_water', near_railroad: 'near_railroad', drug_infected: 'drug_infected',
};
export const FUNDING_MAP: Record<string, string> = {
  ...fromLabels(FUNDING), private: 'private',
};
export const CHANNEL_MAP: Record<string, string> = {
  ...fromLabels(CHANNELS), 'email & sms': 'email_and_sms', email: 'email_only', sms: 'sms_only',
};

export function codeOf(raw: string, map: Record<string, string>): string | null {
  const k = raw.trim().toLowerCase();
  if (Object.values(map).includes(k)) return k;
  return map[k] ?? null;
}

export type LocationType = 'city' | 'county' | 'state' | 'zip';
export type LocationPref = { name: string; type: LocationType; state?: string; restricted?: boolean };
export type Range = { min?: number | null; max?: number | null };
export type Economics = {
  funding?: string[]; emd_typical?: number | null; close_days?: number | null; inspection_days?: number | null;
  max_arv_pct?: number | null; min_discount_pct?: number | null; target_roi_pct?: number | null; min_cap_rate?: number | null;
  min_cashflow?: number | null; max_rehab_level?: string | null; max_rehab_budget?: number | null; min_rent?: number | null; min_garages?: number | null;
};
export type BuyBox = {
  location_prefs: LocationPref[];
  locations: { cities: string[]; counties: string[]; states: string[]; zips: string[] };
  restricted: { cities: string[]; counties: string[]; states: string[]; zips: string[] };
  strategies: string[]; property_types: string[];
  price: Range; beds: { min?: number | null }; baths: { min?: number | null }; sqft: Range; year_built: Range; lot_sqft: Range;
  rehab: { avoided: string[] }; specialty_avoid: string[]; restrictions: string[]; requirements: string[]; strict: string[];
  purchase_methods: string[]; timeline_days?: number | null; economics: Economics; notes?: string;
};

export const emptyBuyBox = (): BuyBox => ({
  location_prefs: [], locations: { cities: [], counties: [], states: [], zips: [] }, restricted: { cities: [], counties: [], states: [], zips: [] },
  strategies: [], property_types: ['single_family'], price: {}, beds: {}, baths: {}, sqft: {}, year_built: {}, lot_sqft: {},
  rehab: { avoided: [] }, specialty_avoid: [], restrictions: [], requirements: [], strict: [], purchase_methods: [],
  timeline_days: null, economics: { funding: [] }, notes: '',
});

const numOrNull = (v: unknown): number | null => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const strArr = (v: unknown, max = 50): string[] => (Array.isArray(v) ? Array.from(new Set(v.map((x) => String(x).trim()).filter(Boolean))).slice(0, max) : []);
const range = (v: unknown): Range => { const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>; return { min: numOrNull(o.min), max: numOrNull(o.max) }; };

/** Anything (form state, stored JSON, an import) into the canonical shape. */
export function normalizeBuyBox(raw: unknown): BuyBox {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const box = emptyBuyBox();
  let prefs: LocationPref[] = Array.isArray(r.location_prefs)
    ? (r.location_prefs as unknown[]).map((p) => {
      const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
      const type = (['city', 'county', 'state', 'zip'] as const).includes(o.type as LocationType) ? (o.type as LocationType) : 'city';
      const rawName = String(o.name ?? '').trim();
      const name = type === 'state' ? (stateCode(rawName) ?? rawName.toUpperCase()) : rawName;
      const state = type === 'state' ? undefined : (o.state ? stateCode(o.state) ?? undefined : undefined);
      return { name, type, state, restricted: Boolean(o.restricted) };
    }).filter((p) => p.name)
    : [];
  if (!prefs.length && r.locations && typeof r.locations === 'object') {
    const l = r.locations as Record<string, unknown>;
    prefs = [
      ...strArr(l.cities).map((name) => ({ name, type: 'city' as const })),
      ...strArr(l.counties).map((name) => ({ name, type: 'county' as const })),
      ...strArr(l.states).map((name) => ({ name: stateCode(name) ?? name.toUpperCase(), type: 'state' as const })),
      ...strArr(l.zips, 200).map((name) => ({ name, type: 'zip' as const })),
    ];
  }
  box.location_prefs = prefs.slice(0, 300);
  for (const p of box.location_prefs) {
    const target = p.restricted ? box.restricted : box.locations;
    const key = p.type === 'city' ? 'cities' : p.type === 'county' ? 'counties' : p.type === 'state' ? 'states' : 'zips';
    const val = p.type === 'state' ? (stateCode(p.name) ?? p.name.toUpperCase()) : p.name;
    if (!target[key].includes(val)) target[key].push(val);
    // City / county / zip rows carry the state they belong to so the matcher
    // can refuse another state's deal even when loc.states was never filled.
    if (p.type !== 'state' && p.state) {
      const st = stateCode(p.state);
      if (st && !target.states.includes(st)) target.states.push(st);
    }
  }
  box.strategies = strArr(r.strategies, 20);
  box.property_types = strArr(r.property_types, 20);
  box.price = range(r.price);
  box.beds = { min: numOrNull((r.beds as Record<string, unknown> | undefined)?.min) };
  box.baths = { min: numOrNull((r.baths as Record<string, unknown> | undefined)?.min) };
  box.sqft = range(r.sqft); box.year_built = range(r.year_built); box.lot_sqft = range(r.lot_sqft);
  box.rehab = { avoided: strArr((r.rehab as Record<string, unknown> | undefined)?.avoided, 10) };
  box.specialty_avoid = strArr(r.specialty_avoid, 30);
  box.restrictions = strArr(r.restrictions, 40);
  box.requirements = strArr(r.requirements, 40);
  box.strict = strArr(r.strict, 10).filter((s) => STRICT_OPTIONS.some(([c]) => c === s));
  box.purchase_methods = strArr(r.purchase_methods, 10);
  box.timeline_days = numOrNull(r.timeline_days);
  const e = (r.economics && typeof r.economics === 'object' ? r.economics : {}) as Record<string, unknown>;
  box.economics = {
    funding: strArr(e.funding, 10), emd_typical: numOrNull(e.emd_typical), close_days: numOrNull(e.close_days), inspection_days: numOrNull(e.inspection_days),
    max_arv_pct: numOrNull(e.max_arv_pct), min_discount_pct: numOrNull(e.min_discount_pct), target_roi_pct: numOrNull(e.target_roi_pct),
    min_cap_rate: numOrNull(e.min_cap_rate), min_cashflow: numOrNull(e.min_cashflow),
    max_rehab_level: typeof e.max_rehab_level === 'string' && REHAB_LEVELS.some(([c]) => c === e.max_rehab_level) ? e.max_rehab_level : null,
    max_rehab_budget: numOrNull(e.max_rehab_budget), min_rent: numOrNull(e.min_rent), min_garages: numOrNull(e.min_garages),
  };
  box.notes = typeof r.notes === 'string' ? r.notes.slice(0, 4000) : '';
  return box;
}

const k = (n: number | null | undefined) => (n == null ? null : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}K`);

/** The one-line and row summaries the buyer screens show. */
export function summarizeBuyBox(box: BuyBox) {
  const locLabel = (p: LocationPref) => (p.type !== 'state' && p.state ? `${p.name}, ${p.state}` : p.name);
  const locs = box.location_prefs.filter((p) => !p.restricted).map(locLabel);
  const price = box.price.min == null && box.price.max == null ? '—' : `${k(box.price.min) ?? '$0'} – ${k(box.price.max) ?? 'no max'}`;
  const rng = (r: Range) => (r.min == null && r.max == null ? '—' : `${r.min ?? 0} – ${r.max ?? 'no max'}`);
  return {
    markets: locs,
    price,
    exit: box.strategies.map((s) => labelOf(STRATEGIES, s)).join(' / ') || '—',
    type: box.property_types.map((s) => labelOf(PROPERTY_TYPES, s)).join(', ') || '—',
    rehab: box.rehab.avoided.length ? 'Not ' + box.rehab.avoided.map((s) => labelOf(REHAB_LEVELS, s)).join(', ') : box.economics.max_rehab_level ? 'Up to ' + labelOf(REHAB_LEVELS, box.economics.max_rehab_level) : 'Any',
    beds: box.beds.min != null ? `${box.beds.min}+` : 'Any',
    baths: box.baths.min != null ? `${box.baths.min}+` : 'Any',
    sqft: rng(box.sqft), year: rng(box.year_built),
    minCap: box.economics.min_cap_rate != null ? `${box.economics.min_cap_rate}%` : '—',
    maxArv: box.economics.max_arv_pct != null ? `${box.economics.max_arv_pct}% of ARV` : '—',
    minCashFlow: box.economics.min_cashflow != null ? `$${box.economics.min_cashflow}/mo` : '—',
    avoid: [...box.specialty_avoid.map((s) => labelOf(SPECIALTY_REHABS, s)), ...box.restrictions.map((s) => labelOf([...LOCATION_CHIPS, ...PROPERTY_CHIPS], s))],
    oneLine: [locs.slice(0, 3).join(', ') + (locs.length > 3 ? ` +${locs.length - 3}` : ''), price !== '—' ? price : '', box.strategies.map((s) => labelOf(STRATEGIES, s)).join(' / ')].filter(Boolean).join(' · '),
  };
}

export type DealFacts = {
  price?: number | null; arv?: number | null;
  city?: string | null; state?: string | null; zip?: string | null; county?: string | null;
  beds?: number | null; baths?: number | null; sqft?: number | null; year?: number | null;
  type?: string | null; condition?: string | null; attrs?: string[] | null;
};

const eqi = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const prefOpen = (p: LocationPref) => !p.restricted;
const stateOf = (v: unknown) => stateCode(v);

/** Same 0–100 rules as public.score_buyer_deal (migration 98). A buyer with
 *  known buy-area states cannot match a deal in another state; city / county
 *  names are not national; no buy area scores 0. Price + type + beds cannot
 *  rescue a geo miss. */
export function scoreBuyerDeal(raw: unknown, deal: DealFacts): { score: number; reasons: string[] } {
  const box = normalizeBuyBox(raw);
  const prefs = box.location_prefs;
  const loc = box.locations;
  const rloc = box.restricted;
  const dealSt = stateOf(deal.state);
  const filterStates = new Set<string>();
  const explicitStates = new Set<string>();
  for (const p of prefs) {
    if (!prefOpen(p)) continue;
    if (p.type === 'state') { const s = stateOf(p.name); if (s) { filterStates.add(s); explicitStates.add(s); } }
    if (p.state) { const s = stateOf(p.state); if (s) filterStates.add(s); }
  }
  for (const s of loc.states) { const c = stateOf(s); if (c) filterStates.add(c); }
  const cityCountyZip = prefs.some((p) => prefOpen(p) && p.type !== 'state');
  if (!cityCountyZip) for (const s of loc.states) { const c = stateOf(s); if (c) explicitStates.add(c); }

  const hasLoc = prefs.some(prefOpen) || loc.cities.length + loc.counties.length + loc.states.length + loc.zips.length > 0;
  const wrongState = !!(dealSt && filterStates.size && !filterStates.has(dealSt));

  const stateOk = (p: LocationPref) => !p.state || !dealSt || stateOf(p.state) === dealSt;
  const named = (type: LocationType, name: string | null | undefined) =>
    !!name && prefs.some((p) => prefOpen(p) && p.type === type && eqi(p.name, name) && stateOk(p));
  const listHit = (names: string[], name: string | null | undefined, type: LocationType) =>
    !!name && names.some((x) => eqi(x, name)) && !prefs.some((p) => prefOpen(p) && p.type === type && eqi(p.name, name) && !stateOk(p));

  let geo = 0;
  let countyUnknown = false;
  if (!wrongState) {
    if (deal.zip && (named('zip', deal.zip) || listHit(loc.zips, deal.zip, 'zip'))) geo = 40;
    else if (deal.city && (named('city', deal.city) || listHit(loc.cities, deal.city, 'city'))) geo = 34;
    else if (deal.county && (named('county', deal.county) || listHit(loc.counties, deal.county, 'county'))) geo = 34;
    else if (dealSt && explicitStates.has(dealSt)) geo = 18;
    else if (!deal.county && dealSt && prefs.some((p) => prefOpen(p) && p.type === 'county' && stateOf(p.state) === dealSt)) { geo = 18; countyUnknown = true; }
  }

  const restricted = !!(
    (deal.zip && rloc.zips.includes(deal.zip))
    || (deal.city && rloc.cities.some((x) => eqi(x, deal.city!)))
    || (deal.county && rloc.counties.some((x) => eqi(x, deal.county!)))
    || (dealSt && rloc.states.some((x) => stateOf(x) === dealSt))
  );

  const pmin = box.price.min ?? null; const pmax = box.price.max ?? null;
  let priceFit = 0;
  if (pmin == null && pmax == null) priceFit = 8;
  else if (deal.price == null) priceFit = 8;
  else if (deal.price >= (pmin ?? 0) && deal.price <= (pmax ?? 1e12)) priceFit = 25;
  else if (deal.price <= (pmax ?? 1e12) * 1.1) priceFit = 12;

  const types = box.property_types;
  const t = deal.type ?? '';
  let typeFit = 0;
  if (!t || !types.length) typeFit = 8;
  else if (types.some((x) => x.replace(/_/g, ' ').toLowerCase() === t.replace(/_/g, ' ').toLowerCase()
    || (x === 'single_family' && ['sfr', 'single family', 'single family residential', 'single_family'].includes(t.toLowerCase())))) typeFit = 15;

  let sizeFit = 0;
  if (deal.beds == null || box.beds.min == null) sizeFit = 5;
  else if (deal.beds >= box.beds.min && (box.baths.min == null || deal.baths == null || deal.baths >= box.baths.min)) sizeFit = 10;

  const sqftOk = deal.sqft == null || ((box.sqft.min == null || deal.sqft >= box.sqft.min) && (box.sqft.max == null || deal.sqft <= box.sqft.max));
  const yearOk = deal.year == null || ((box.year_built.min == null || deal.year >= box.year_built.min) && (box.year_built.max == null || deal.year <= box.year_built.max));
  const rehabRank: Record<string, number> = { move_in: 0, cosmetic: 1, medium: 2, heavy: 3, gut: 4 };
  const cond = deal.condition ?? '';
  const maxRank = box.economics.max_rehab_level ? rehabRank[box.economics.max_rehab_level] : undefined;
  const attrs = deal.attrs ?? [];
  const broken = (cond && box.rehab.avoided.includes(cond))
    || (cond in rehabRank && maxRank != null && rehabRank[cond] > maxRank)
    || attrs.some((a) => box.specialty_avoid.includes(a) || box.restrictions.includes(a))
    || (deal.arv != null && deal.arv > 0 && deal.price != null && box.economics.max_arv_pct != null && deal.price > deal.arv * box.economics.max_arv_pct / 100);
  const econOk = deal.arv != null && deal.arv > 0 && deal.price != null && box.economics.max_arv_pct != null && deal.price <= deal.arv * box.economics.max_arv_pct / 100;
  const missingReq = box.requirements.length > 0 && !box.requirements.every((x) => attrs.includes(x));
  const strict = box.strict;
  const dead = !!(broken || restricted || wrongState || !hasLoc || geo === 0
    || ((strict.includes('all') || strict.includes('locations')) && geo === 0)
    || ((strict.includes('all') || strict.includes('pricing')) && priceFit < 25 && priceFit !== 8)
    || ((strict.includes('all') || strict.includes('beds_baths')) && sizeFit === 0)
    || ((strict.includes('all') || strict.includes('sqft')) && !sqftOk)
    || ((strict.includes('all') || strict.includes('year_built')) && !yearOk));

  const r: string[] = [];
  if (geo >= 34) r.push('in market'); else if (geo === 18) r.push('in state');
  if (countyUnknown) r.push('county not on file');
  if (!hasLoc) r.push('no buy area');
  else if (wrongState) r.push('wrong state');
  else if (geo === 0) r.push('outside buy area');
  if (restricted) r.push('restricted location');
  if (priceFit === 25) r.push('price in band'); else if (priceFit === 12) r.push('price near band');
  if (typeFit === 15) r.push('property type match');
  if (sizeFit === 10) r.push('beds/baths ok');
  if (!sqftOk) r.push('sqft out of range');
  if (!yearOk) r.push('year built out of range');
  if (missingReq) r.push('missing a requirement');
  if (econOk) r.push('under max % of ARV');
  if (broken) r.push('deal breaker');
  else if (dead && hasLoc && !wrongState && !restricted && geo > 0) r.push('strict criteria');

  const score = dead ? 0 : Math.max(0, Math.min(100,
    geo + priceFit + typeFit + sizeFit + 10
    - (sqftOk ? 0 : 10) - (yearOk ? 0 : 10) - (missingReq ? 15 : 0)));
  return { score, reasons: r };
}
