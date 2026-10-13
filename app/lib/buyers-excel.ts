// Buyer lists → one CLOZR buyer per real buyer. Two sources, one plan:
//   podio        the Podio "Buyers List" Excel export (markets / locations, history, notes)
//   dispogenius  the DispoGenius buyers CSV (the current buy box, engagement, contact preferences)
// Pure: no IO, so the dry run (tools/buyers-excel-import.ts) and tools/buyers-excel.test.ts share it.
//
// Dedupe across both files (the SQL repeats the same keys against the database at run time):
//   phone / email  rows sharing an E.164 phone or an email fold together, but only when the
//                  names agree (first names within one typo, and a shared surname when both
//                  have one). Spouses and partners on one line stay apart and are listed.
//   name + company exact normalized name and company (both blank counts as equal), when the
//                  name has two words or there is a company. Company alone never merges.
// Folded rows keep every phone, email, market and note. For single values (price, beds, year,
// contact preferences) DispoGenius wins, then the earliest Podio row.

import { createHash } from 'node:crypto';
import { CHANNEL_MAP, DG_CHIPS, FUNDING_MAP, RESTRICTION_MAP, STRATEGY_MAP, TYPE_MAP, normalizeBuyBox, summarizeBuyBox, type BuyBox, type LocationPref } from './buyer-profile';
import { STATES, emailKey, personKey, phoneKey, phoneOut } from './podio-excel';

export type Row = Record<string, unknown>;
export type Source = 'podio' | 'dispogenius';

const txt = (v: unknown) => {
  const t = v == null ? '' : String(v).replace(/\r/g, '').trim();
  return /^null$/i.test(t) ? '' : t;
};
const list = (v: unknown) => txt(v).split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
/** Numbers; "No Max", "Any", "NULL" and blanks are null. */
const num = (v: unknown) => { const t = txt(v).replace(/[$,\s]/g, ''); const n = Number(t); return t && Number.isFinite(n) ? n : null; };
const flag = (v: unknown) => { if (v === true || v === 1) return true; const t = txt(v).toLowerCase(); return t === '1' || t === '1.0' || t === 'true' || t === 'yes'; };
const stateCode = (v: unknown) => { const t = txt(v); return /^[A-Za-z]{2}$/.test(t) ? t.toUpperCase() : STATES[t.toLowerCase()] ?? null; };
const titleIfLower = (s: string) => (s === s.toLowerCase() ? s.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

export { STRATEGY_MAP, TYPE_MAP };
/** Podio "Buyer Status" → buyer_type when it says what they are. */
const STATUS_TYPE: Record<string, string> = { 'hedge fund': 'fund', wholesaler: 'wholesaler', realtor: 'agent', 'novation realtor': 'agent' };

// ------------------------------------------------------------------ names

const PLACEHOLDER = /^(null|unk|unknown|na)$/;
const tokens = (n: string) => personKey(n).split(' ').filter((t) => t.length > 1 && !PLACEHOLDER.test(t));
function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const close = (a: string, b: string) => lev(a, b) <= 1;
/** Could these be the same person? "Mathew Brandt"/"Matthew Brandt", "Darnell Null"/"Darnell" yes; "Pedro Ruiz"/"Selene Ruiz" no. */
export function compatibleNames(a: string, b: string): boolean {
  const x = tokens(a); const y = tokens(b);
  if (!x.length || !y.length) return true;
  if (!close(x[0], y[0])) return false;
  if (x.length < 2 || y.length < 2) return true;
  return x.slice(1).some((s) => y.slice(1).some((t) => close(s, t)));
}
/** "Darnell Null" → "Darnell", "Jacob Dillon?" → "Jacob Dillon". */
export const cleanName = (v: unknown) =>
  txt(v).replace(/\s+/g, ' ').split(' ').filter((w) => !PLACEHOLDER.test(w.toLowerCase())).join(' ').replace(/\?+$/, '').trim();
const looksLikeAddress = (s: string) => /^\d+\s+\S+/.test(s);

// ------------------------------------------------------------------ one row

type Range = { min: number | null; max: number | null };
type Draft = {
  source: Source; row: number; ref: string; sourceId: string | null;
  name: string; company: string | null; phones: string[]; emails: string[];
  statuses: string[]; tags: string[]; creators: { name: string; email: string }[]; website: string | null;
  vip: boolean; vettedAt: string | null; blacklisted: boolean; inactive: boolean;
  wantsCalls: boolean | null; wantsFollowUps: boolean | null; channel: string | null;
  strategies: string[]; types: string[]; locs: LocationPref[]; restrictions: string[]; requirements: string[]; funding: string[];
  price: Range; year: Range; sqft: Range; lot: Range; beds: number | null; baths: number | null; garages: number | null; timeline: number | null;
  notes: string[]; critNotes: string[]; defaults: string[];
};
export type Skip = { source: Source; row: number; reason: string; detail: string };

const blankDraft = (source: Source, row: number): Omit<Draft, 'name' | 'company'> => ({
  source, row, ref: `${source} row ${row}`, sourceId: null, phones: [], emails: [], statuses: [], tags: [], creators: [], website: null,
  vip: false, vettedAt: null, blacklisted: false, inactive: false, wantsCalls: null, wantsFollowUps: null, channel: null,
  strategies: [], types: [], locs: [], restrictions: [], requirements: [], funding: [],
  price: { min: null, max: null }, year: { min: null, max: null }, sqft: { min: null, max: null }, lot: { min: null, max: null },
  beds: null, baths: null, garages: null, timeline: null, notes: [], critNotes: [], defaults: [],
});

const emailsIn = (v: unknown) => [...txt(v).replace(/,(com|net|org)\b/gi, '.$1').matchAll(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)]
  .map((m) => emailKey(m[0])).filter((e): e is string => !!e);

/** Shared by both sources: strategy / property type vocab, and the Podio form defaults that would wreck matching. */
function buyBoxBasics(d: Draft, strategy: unknown, propertyType: unknown) {
  for (const s of list(strategy)) { const c = STRATEGY_MAP[s.toLowerCase()]; if (c) d.strategies.push(c); else d.critNotes.push('Strategy: ' + s); }
  for (const s of list(propertyType)) { const c = TYPE_MAP[s.toLowerCase()]; if (c) d.types.push(c); else d.critNotes.push('Property type: ' + s); }
  // A 10,000 sqft minimum and built 1900–2024 are the form's defaults, not a buyer's criteria.
  if (d.sqft.min != null && d.sqft.min >= 10000) { d.defaults.push('min sqft ' + d.sqft.min); d.sqft = { min: null, max: d.sqft.max === 10000 ? null : d.sqft.max }; }
  if (d.year.min === 1900 && d.year.max === 2024) { d.defaults.push('year built 1900–2024'); d.year = { min: null, max: null }; }
}

const PHONE_COLS = ['Mobile', 'Main', 'Work', 'Home', 'Other'].map((k) => 'Buyer Phone Number - ' + k);
const EMAIL_COLS = ['Work', 'Home', 'Other'].map((k) => 'Buyer Email - ' + k);

/** A Podio Buyers List row (headers trimmed). */
export function podioDraft(r: Row, row: number): Draft | Skip {
  const g = (k: string) => txt(r[k]);
  const company = g('Company Name') || g('Entity Name') || null;
  let name = cleanName(r['Buyer Name']);
  if (!name || looksLikeAddress(name)) name = company ?? '';
  if (!name) return { source: 'podio', row, reason: 'no buyer name or company', detail: txt(r['Buyer Name']) };

  const d: Draft = { ...blankDraft('podio', row), name, company };
  const bad: string[] = [];
  for (const c of PHONE_COLS) for (const p of list(r[c])) { const e = phoneOut(phoneKey(p)); if (e) d.phones.push(e); else bad.push(p); }
  d.phones = [...new Set(d.phones)];
  d.emails = [...new Set(EMAIL_COLS.flatMap((c) => emailsIn(r[c])))];
  d.statuses = list(r['Buyer Status']);
  d.vip = d.statuses.some((s) => /^a-list buyer$/i.test(s));
  d.website = g('Website') || null;
  const mails = list(r['Who Created the buyer? - mail']);
  d.creators = list(r['Who Created the buyer? - name']).map((n, i) => ({ name: n, email: mails[i] ?? '' }));
  d.price = { min: num(r['Min Price']), max: num(r['Max Price']) };
  d.year = { min: num(r['Min Year Build']), max: num(r['Max Year Build']) };
  d.sqft = { min: num(r['Min Sqft']), max: num(r['Max Sqft']) };
  d.beds = num(r['Min Bedrooms']); d.baths = num(r['Min Bathroom']); d.garages = num(r['Garage Minimum']);
  buyBoxBasics(d, r['Strategy'], r['Property Type']);
  for (const s of list(r['Location Restrictions'])) { const c = RESTRICTION_MAP[s.toLowerCase()]; if (c) d.restrictions.push(c); else d.critNotes.push('Location restriction: ' + s); }
  for (const k of ['Buying Restrictions', 'Property Characteristics']) if (g(k)) d.critNotes.push(`${k}: ${g(k)}`);

  // Market: one location at the granularity Podio says (City / County / State; "Zip Code" rows carry no zip, so their city).
  const mState = stateCode(r['Market State']); const mCity = titleIfLower(g('Market City')); const mCounty = g('Mark');
  const restricted = g('Market Restrictions') === '1';
  const kind = g('Buyer Market Location Type').toLowerCase();
  const push = (p: LocationPref) => { if (!d.locs.some((x) => x.type === p.type && x.name.toLowerCase() === p.name.toLowerCase() && x.state === p.state)) d.locs.push(p); };
  const at = (name: string, type: LocationPref['type'], state: string | null, r2 = restricted) =>
    push({ name: type === 'city' ? titleIfLower(name) : name, type, ...(state && type !== 'state' ? { state } : {}), ...(r2 ? { restricted: true } : {}) });
  if (kind === 'state' && mState) at(mState, 'state', null);
  else if (kind === 'county' && mCounty) at(mCounty, 'county', mState);
  else if (mCity) at(mCity, 'city', mState);
  else if (mCounty) at(mCounty, 'county', mState);
  else if (mState) at(mState, 'state', null);
  // Buying Locations 1: a Google place. City + state is the market; a street address is a property, kept in notes.
  const bl1City = g('Buying Locations 1 - City');
  if (bl1City) at(bl1City, 'city', stateCode(r['Buying Locations 1 - State']) ?? mState ?? stateCode(r['State']), false);
  const bl1Addr = g('Buying Locations 1 - Address'); const bl1Zip = g('Buying Locations 1 - Postal Code');
  if (/\d/.test(bl1Addr)) d.notes.push(`Buying location address: ${bl1Addr}${bl1Zip && !bl1Addr.includes(bl1Zip) ? ' ' + bl1Zip : ''}`);
  // Buying Locations 2 / 3 repeat Market City / Market State; only a different value adds a market.
  const bl2 = g('Buying Locations 2');
  if (bl2 && bl2.toLowerCase() !== mCity.toLowerCase()) { const [c, s] = bl2.split(',').map((x) => x.trim()); at(c, 'city', stateCode(s?.slice(0, 2)) ?? mState, false); }
  const bl3 = stateCode(r['Buying Locations 3']);
  if (bl3 && bl3 !== mState) at(bl3, 'state', null, false);

  for (const k of ['Buyer Notes', 'Notes', 'Buying Criteria', 'Offers']) if (g(k)) d.notes.push(g(k));
  if (g('Title')) d.notes.push('Title: ' + g('Title'));
  if (g('Entity Name') && g('Entity Name') !== company) d.notes.push('Entity: ' + g('Entity Name'));
  if (g('Buyer Bought Address')) d.notes.push('Past purchase: ' + g('Buyer Bought Address'));
  if (bad.length) d.notes.push('Unrecognized phone: ' + bad.join(', '));
  return d;
}

const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(txt(v)) ? txt(v).slice(0, 10) : null);

/** A DispoGenius buyers CSV row. */
export function dispoDraft(r: Row, row: number): Draft | Skip {
  const g = (k: string) => txt(r[k]);
  if (flag(r.is_deleted)) return { source: 'dispogenius', row, reason: 'deleted in DispoGenius', detail: g('full_name') };
  const company = g('company_name') || null;
  const name = cleanName(g('full_name') || `${g('first_name')} ${g('last_name')}`) || company || '';
  if (!name) return { source: 'dispogenius', row, reason: 'no name or company', detail: g('customer_id') };

  const d: Draft = { ...blankDraft('dispogenius', row), name, company, sourceId: g('customer_id') ? 'dispogenius:' + g('customer_id') : null };
  const phone = phoneOut(phoneKey(g('phone')));
  d.phones = phone ? [phone] : [];
  d.emails = emailsIn(r.email);
  d.tags = list(r.tags);
  d.vip = g('type') === 'vip_buyer' || d.tags.includes('vip buyer');
  if (/vetted|vip/.test(g('type'))) d.vettedAt = day(r.buyer_added) ?? day(r.created_at);
  d.blacklisted = flag(r.is_blacklist);
  d.inactive = ['0', '0.0', 'false', 'no'].includes(g('is_active').toLowerCase());
  if (flag(r.dnd)) { d.wantsCalls = false; d.tags.push('dnd'); }
  if (flag(r.no_follow_ups)) d.wantsFollowUps = false;
  if (flag(r.no_notifications)) d.tags.push('no-notifications');
  d.channel = CHANNEL_MAP[g('notification_method').toLowerCase()] ?? null;

  d.price = { min: num(r.min_price), max: num(r.max_price) };
  d.year = { min: num(r.min_year_build), max: num(r.max_year_build) };
  d.sqft = { min: num(r.min_sqft), max: num(r.max_sqft) };
  const acre = (v: unknown) => { const a = num(v); return a == null ? null : Math.round(a * 43560); };
  d.lot = { min: num(r.min_lot_size) ?? acre(r.min_acre), max: num(r.max_lot_size) ?? acre(r.max_acre) };
  d.beds = num(r.min_bedroom); d.baths = num(r.min_bathroom);
  d.timeline = num(g('timeline_to_close').replace(/\D+/g, ' ').trim().split(' ')[0]);
  buyBoxBasics(d, r.strategy, r.property_type);
  for (const [suffix, chip] of Object.entries(DG_CHIPS)) {
    if (flag(r['no_' + suffix])) d.restrictions.push(chip);
    if (flag(r['req_' + suffix])) d.requirements.push(chip);
  }
  for (const f of list(r.finance_type)) { const c = FUNDING_MAP[f.toLowerCase()]; if (c) d.funding.push(c); else d.critNotes.push('Finance: ' + f); }
  if (g('restrict_rehab_level')) d.critNotes.push('DispoGenius restrict rehab level: ' + g('restrict_rehab_level'));
  if (g('restrict_criteria')) d.critNotes.push('DispoGenius restrict criteria: ' + g('restrict_criteria'));
  if (g('market_status_preference')) d.critNotes.push('Deal status preference: ' + g('market_status_preference'));
  if (g('estimated_annual_volume')) d.critNotes.push('Estimated annual volume: ' + g('estimated_annual_volume'));

  if (g('remarks')) d.notes.push(g('remarks'));
  const kv = (label: string, k: string) => (g(k) && g(k) !== '0' ? `${label} ${g(k)}` : '');
  d.notes.push(['DispoGenius:', [
    kv('type', 'type'), kv('engagement score', 'engagement_score'), kv('stars', 'stars'), kv('engagement', 'engagement_category'),
    kv('deals sent', 'amount_of_deals_sent'), kv('closed deals', 'closed_deals_count'), kv('assignment fees', 'total_assignment_fees'),
    kv('source', 'source'), kv('first contact', 'method_of_first_contact'), kv('assigned to', 'assigned_to_user_id'),
    flag(r.no_intro_sms) ? 'no intro SMS' : '', flag(r.no_pending_deals) ? 'no pending deals' : '', flag(r.no_notifications) ? 'no notifications' : '',
    flag(r.no_follow_ups) ? 'no follow-ups' : '', flag(r.dnd) ? 'do not disturb' : '',
    kv('added', 'buyer_added'), kv('updated', 'buyer_updated'), kv('id', 'customer_id'),
  ].filter(Boolean).join(', ')].join(' '));
  return d;
}

// ------------------------------------------------------------------ plan

export type PlannedBuyer = {
  source: Source; source_id: string; source_ids: string[]; rows: string[];
  name: string; company: string | null; phone: string | null; email: string | null; status: 'active' | 'inactive'; vip: boolean;
  vetted_at: string | null; blacklisted: boolean; wants_calls: boolean; wants_follow_ups: boolean; preferred_channel: string | null;
  buyer_type: string | null; website: string | null; tags: string[]; notes: string | null; created_by_email: string | null;
  criteria: BuyBox; markets: string[]; min_purchase_price: number | null; max_purchase_price: number | null; buy_box: string | null;
};
export type Merge = { into: string; intoRow: string; row: string; name: string; by: string };
export type LocationStats = { rows: number; byPhone: number; byName: number; unmatched: { row: number; name: string; phone: string; location: string; reason: string }[] };
export type Plan = {
  rows: Record<Source, number>; buyers: PlannedBuyer[]; merges: Merge[]; skipped: Skip[]; locations: LocationStats;
  excluded: { name: string; rows: string[] }[];
  review: { keptApart: { contact: string; rows: string[] }[]; nameOnlyMerges: Merge[]; defaultsDropped: Record<string, number>; possibleTests: { name: string; why: string; rows: string[] }[] };
};

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const first = <T,>(xs: (T | null | undefined)[]): T | null => xs.find((x) => x != null) ?? null;
const companyKey = (c: string | null) => (c ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A DispoGenius "Buyer Locations" row (type City / County / State / Zip Code; the zip is only in `address`). */
export function locationRowPref(r: Row): LocationPref | null {
  const type = txt(r.type).toLowerCase(); const state = stateCode(r.state ?? r.STATE); const city = txt(r.city); const county = txt(r.county);
  const zip = /\b\d{5}\b/.exec(txt(r.address))?.[0];
  const at = (name: string, t: LocationPref['type']): LocationPref => ({ name, type: t, ...(state && t !== 'state' ? { state } : {}), ...(num(r.restrict) === 1 ? { restricted: true } : {}) });
  if (type === 'zip code' && zip) return at(zip, 'zip');
  if ((type === 'city' || type === 'zip code') && city) return at(titleIfLower(city), 'city');
  if (type === 'county' && county) return at(county, 'county');
  if (type === 'state' && state) return at(state, 'state');
  return null;
}

/** Owner-confirmed test records (a buyer is dropped when any of its rows carries one of these names). Edit for your own team. */
export const TEST_NAMES = new Set(['sam carter', 'benny buyer (sam)']);
/** Listed for review only, never dropped on this alone. */
const TEST_HINT = /\btest\w*|\bdemo\b|\bfake\b|\bsample\b|\basdf|\bdummy\b|\bbuyer\b|acme ?homes|yourcompany/i;

export function buildPlan(src: { podio?: Row[]; dispogenius?: Row[]; locations?: Row[] }): Plan {
  const drafts: Draft[] = []; const skipped: Skip[] = [];
  // DispoGenius first: it is the current buy box, so first() picks it for single values.
  (src.dispogenius ?? []).forEach((r, i) => { const d = dispoDraft(r, i + 2); if ('reason' in d) skipped.push(d); else drafts.push(d); });
  (src.podio ?? []).forEach((r, i) => { const d = podioDraft(r, i + 2); if ('reason' in d) skipped.push(d); else drafts.push(d); });

  const parent = drafts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const why = new Map<number, string>(); // draft index → how it joined an earlier row
  const join = (earlier: number, later: number, by: string) => {
    const a = find(earlier); const b = find(later);
    if (a === b) return;
    parent[Math.max(a, b)] = Math.min(a, b);
    if (!why.has(later)) why.set(later, by);
  };
  const keptApart = new Map<string, Set<number>>();
  const owner = new Map<string, number>();
  drafts.forEach((d, i) => {
    for (const k of [...d.phones, ...d.emails]) {
      const o = owner.get(k);
      if (o == null) { owner.set(k, i); continue; }
      if (compatibleNames(drafts[o].name, d.name)) join(o, i, (k.includes('@') ? 'email ' : 'phone ') + k);
      else { const s = keptApart.get(k) ?? new Set([o]); s.add(i); keptApart.set(k, s); }
    }
    if (tokens(d.name).length >= 2 || d.company) {
      const k = 'name:' + tokens(d.name).join(' ') + '|' + companyKey(d.company);
      const o = owner.get(k);
      if (o == null) owner.set(k, i); else join(o, i, 'same name + company');
    }
  });

  const groups = new Map<number, number[]>();
  drafts.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });

  // Buyer location rows add markets to the buyer they belong to: phone (with an agreeing name), else a unique name.
  const extraLocs = new Map<number, LocationPref[]>();
  const locations: LocationStats = { rows: src.locations?.length ?? 0, byPhone: 0, byName: 0, unmatched: [] };
  if (src.locations?.length) {
    const byPhone = new Map<string, Set<number>>(); const byName = new Map<string, Set<number>>();
    const add = (m: Map<string, Set<number>>, k: string, g: number) => m.set(k, (m.get(k) ?? new Set<number>()).add(g));
    drafts.forEach((d, i) => { d.phones.forEach((p) => add(byPhone, p, find(i))); if (tokens(d.name).length) add(byName, tokens(d.name).join(' '), find(i)); });
    src.locations.forEach((r, i) => {
      const row = i + 2; const name = cleanName(r.full_name); const phone = phoneOut(phoneKey(txt(r.phone)));
      const miss = (reason: string) => locations.unmatched.push({ row, name, phone: phone ?? '', location: txt(r.address), reason });
      const pref = locationRowPref(r);
      if (!pref) return miss('no usable location for its type');
      const viaPhone = phone ? [...(byPhone.get(phone) ?? [])].filter((g) => groups.get(g)!.some((j) => compatibleNames(drafts[j].name, name))) : [];
      const viaName = tokens(name).length ? [...(byName.get(tokens(name).join(' ')) ?? [])] : [];
      const g = viaPhone.length === 1 ? viaPhone[0] : viaName.length === 1 ? viaName[0] : null;
      if (g == null) {
        return miss(viaPhone.length > 1 || viaName.length > 1 ? 'matches more than one buyer'
          : phone && byPhone.has(phone) ? 'phone belongs to a buyer with a different name'
          : phone ? 'no buyer with this phone or name' : 'no phone, and no buyer with this name');
      }
      if (viaPhone.length === 1) locations.byPhone++; else locations.byName++;
      extraLocs.set(g, [...(extraLocs.get(g) ?? []), pref]);
    });
  }

  const merges: Merge[] = []; const buyers: PlannedBuyer[] = []; const defaultsDropped: Record<string, number> = {};
  const excluded: Plan['excluded'] = []; const possibleTests: Plan['review']['possibleTests'] = [];
  for (const [root, idx] of groups) {
    const ds = idx.map((i) => drafts[i]);
    const test = ds.find((d) => TEST_NAMES.has(d.name.toLowerCase()));
    if (test) { excluded.push({ name: test.name, rows: ds.map((d) => d.ref) }); continue; }
    const odd = ds.find((d) => TEST_HINT.test(`${d.name} ${d.company ?? ''} ${d.emails.join(' ')}`));
    if (odd) possibleTests.push({ name: odd.name, why: `${odd.name} ${odd.company ?? ''} ${odd.emails.join(' ')}`.match(TEST_HINT)![0], rows: ds.map((d) => d.ref) });
    const head = ds[0];
    const best = [...ds].sort((a, b) => Number(/[(?]/.test(a.name)) - Number(/[(?]/.test(b.name)) || tokens(b.name).length - tokens(a.name).length || b.name.length - a.name.length)[0];
    for (const i of idx.slice(1)) merges.push({ into: best.name, intoRow: head.ref, row: drafts[i].ref, name: drafts[i].name, by: why.get(i) ?? 'linked through another row' });
    const phones = uniq(ds.flatMap((d) => d.phones)); const emails = uniq(ds.flatMap((d) => d.emails));
    const statuses = uniq(ds.flatMap((d) => d.statuses));
    const strategies = uniq(ds.flatMap((d) => d.strategies));
    for (const d of ds) for (const x of d.defaults) defaultsDropped[x] = (defaultsDropped[x] ?? 0) + 1;

    const locs: LocationPref[] = [];
    for (const p of [...ds.flatMap((d) => d.locs), ...(extraLocs.get(root) ?? [])]) if (!locs.some((x) => x.type === p.type && x.name.toLowerCase() === p.name.toLowerCase() && x.state === p.state && !!x.restricted === !!p.restricted)) locs.push(p);
    const garages = first(ds.map((d) => d.garages));
    const pick = (f: (d: Draft) => Range) => ({ min: first(ds.map((d) => f(d).min)), max: first(ds.map((d) => f(d).max)) });
    const criteria = normalizeBuyBox({
      location_prefs: locs, strategies, property_types: uniq(ds.flatMap((d) => d.types)),
      restrictions: uniq(ds.flatMap((d) => d.restrictions)), requirements: uniq(ds.flatMap((d) => d.requirements)),
      price: pick((d) => d.price), year_built: pick((d) => d.year), sqft: pick((d) => d.sqft), lot_sqft: pick((d) => d.lot),
      beds: { min: first(ds.map((d) => d.beds)) }, baths: { min: first(ds.map((d) => d.baths)) },
      timeline_days: first(ds.map((d) => d.timeline)),
      economics: { funding: uniq(ds.flatMap((d) => d.funding)), ...(garages != null ? { min_garages: garages } : {}) },
      notes: uniq(ds.flatMap((d) => d.critNotes)).join('\n'),
    });
    const sm = summarizeBuyBox(criteria);

    const onlyStrategy = strategies.length === 1 ? strategies[0] : null;
    const buyer_type = first(statuses.map((s) => STATUS_TYPE[s.toLowerCase()]))
      ?? (ds.some((d) => d.tags.includes('lender')) ? 'other' : null)
      ?? (onlyStrategy === 'fix_and_flip' ? 'flipper' : onlyStrategy === 'buy_and_hold' ? 'landlord' : onlyStrategy === 'new_construction' ? 'developer' : strategies.length ? 'investor' : null);
    const creators = uniq(ds.flatMap((d) => d.creators.map((c) => `${c.name}${c.email ? ` (${c.email})` : ''}`)));
    const notes = uniq([
      ...ds.flatMap((d) => d.notes),
      phones.length > 1 ? 'Other phones: ' + phones.slice(1).join(', ') : '',
      emails.length > 1 ? 'Other emails: ' + emails.slice(1).join(', ') : '',
      ds.some((d) => d.name !== best.name) ? 'Also listed as: ' + uniq(ds.map((d) => d.name).filter((n) => n !== best.name)).join('; ') : '',
      statuses.length ? 'Podio buyer status: ' + statuses.join(', ') : '',
      creators.length ? 'Added in Podio by ' + creators.join(', ') : '',
    ].filter(Boolean));

    const dg = ds.find((d) => d.source === 'dispogenius' && d.sourceId);
    const podioHead = ds.find((d) => d.source === 'podio');
    const podioId = podioHead ? 'buyers-list:' + createHash('sha1').update(`${tokens(podioHead.name).join(' ')}|${podioHead.phones[0] ?? ''}|${podioHead.emails[0] ?? ''}`).digest('hex').slice(0, 16) : null;
    const sourceIds = uniq([...ds.map((d) => d.sourceId).filter((x): x is string => !!x), ...(podioId ? [podioId] : [])]);
    buyers.push({
      source: dg ? 'dispogenius' : 'podio', source_id: dg?.sourceId ?? podioId!, source_ids: sourceIds,
      rows: ds.map((d) => d.ref),
      name: best.name, company: first(ds.map((d) => d.company)), phone: phones[0] ?? null, email: emails[0] ?? null,
      status: ds.every((d) => d.inactive) ? 'inactive' : 'active', vip: ds.some((d) => d.vip),
      vetted_at: first(ds.map((d) => d.vettedAt)), blacklisted: ds.some((d) => d.blacklisted),
      // A do-not-call or no-follow-up anywhere wins.
      wants_calls: !ds.some((d) => d.wantsCalls === false), wants_follow_ups: !ds.some((d) => d.wantsFollowUps === false),
      preferred_channel: first(ds.map((d) => d.channel)),
      buyer_type, website: first(ds.map((d) => d.website)),
      tags: uniq([
        ...(ds.some((d) => d.source === 'podio') ? ['podio-buyers'] : []), ...(ds.some((d) => d.source === 'dispogenius') ? ['dispogenius'] : []),
        ...statuses.filter((s) => s.toLowerCase() !== 'buyer'), ...ds.flatMap((d) => d.tags),
      ]),
      notes: notes.join('\n\n') || null,
      created_by_email: first(ds.flatMap((d) => d.creators.map((c) => c.email.toLowerCase() || null))),
      criteria, markets: sm.markets, min_purchase_price: criteria.price.min ?? null, max_purchase_price: criteria.price.max ?? null, buy_box: sm.oneLine || null,
    });
  }

  return {
    rows: { podio: src.podio?.length ?? 0, dispogenius: src.dispogenius?.length ?? 0 }, buyers, merges, skipped, locations,
    excluded,
    review: {
      possibleTests,
      keptApart: [...keptApart].map(([contact, s]) => ({ contact, rows: [...s].map((i) => `${drafts[i].ref} ${drafts[i].name}`) })),
      nameOnlyMerges: merges.filter((m) => m.by === 'same name + company'),
      defaultsDropped,
    },
  };
}

// ------------------------------------------------------------------ SQL

const q = (v: string | null) => (v == null ? 'null::text' : `'${v.replace(/'/g, "''")}'`);
const n = (v: number | null) => (v == null ? 'null::numeric' : String(v));
const arr = (xs: string[]) => `array[${xs.map(q).join(', ')}]::text[]`;

/**
 * One idempotent statement per buyer. The target is, in order: the row an earlier run wrote
 * (source podio/dispogenius + any of this buyer's source ids; updated from the files), else a buyer
 * CLOZR already had (not another buyer from these lists) with the same phone, email, or name + company (only its empty fields are
 * filled, tags are added, and do-not-contact flags are applied). Nothing matched: insert.
 */
export function buyerSql(b: PlannedBuyer, workspaceId: number): string {
  const W = Number(workspaceId);
  const fillText = (c: string) => `${c} = case when t.ours or coalesce(b.${c}, '') = '' then coalesce(v.${c}, b.${c}) else b.${c} end`;
  const fillNum = (c: string) => `${c} = case when t.ours or b.${c} is null then coalesce(v.${c}, b.${c}) else b.${c} end`;
  return `with v (source, source_id, source_ids, name, company, phone, email, buyer_type, website, notes, buy_box, min_purchase_price, max_purchase_price,
  status, vip, vetted_at, blacklisted, wants_calls, wants_follow_ups, preferred_channel, tags, markets, criteria, creator) as (
  values (${q(b.source)}, ${q(b.source_id)}, ${arr(b.source_ids)}, ${q(b.name)}, ${q(b.company)}, ${q(b.phone)}, ${q(b.email)}, ${q(b.buyer_type)}, ${q(b.website)},
    ${q(b.notes)},
    ${q(b.buy_box)}, ${n(b.min_purchase_price)}, ${n(b.max_purchase_price)},
    ${q(b.status)}, ${b.vip}, ${b.vetted_at ? q(b.vetted_at) + '::timestamptz' : 'null::timestamptz'}, ${b.blacklisted}, ${b.wants_calls}, ${b.wants_follow_ups}, ${q(b.preferred_channel)},
    ${arr(b.tags)}, ${arr(b.markets)}, ${q(JSON.stringify(b.criteria))}::jsonb, ${q(b.created_by_email)})
), t as (
  select b.id, (b.source in ('podio', 'dispogenius') and b.source_id = any(v.source_ids)) as ours
  from public.buyers b, v
  where b.workspace_id = ${W} and ((b.source in ('podio', 'dispogenius') and b.source_id = any(v.source_ids))
    or (coalesce(b.source_id, '') !~ '^(buyers-list|dispogenius):' and (
       (v.phone is not null and b.phone_key = public.normalize_phone(v.phone))
    or (v.email is not null and lower(b.email) = v.email)
    or (lower(b.name) = lower(v.name) and lower(coalesce(b.company, '')) = lower(coalesce(v.company, ''))))))
  order by ours desc, b.id limit 1
), u as (
  update public.buyers b set
    ${['name', 'company', 'phone', 'email', 'buyer_type', 'website', 'notes', 'buy_box'].map(fillText).join(',\n    ')},
    ${['min_purchase_price', 'max_purchase_price'].map(fillNum).join(',\n    ')},
    criteria = case when t.ours or b.criteria = '{}'::jsonb then v.criteria else b.criteria end,
    markets = case when t.ours or cardinality(b.markets) = 0 then v.markets else b.markets end,
    status = case when t.ours then v.status else b.status end,
    preferred_channel = case when t.ours then coalesce(v.preferred_channel, b.preferred_channel) else b.preferred_channel end,
    source = case when t.ours then v.source else b.source end,
    source_id = case when t.ours then v.source_id else b.source_id end,
    tags = array(select distinct x from unnest(b.tags || v.tags) x),
    vip = b.vip or v.vip,
    vetted_at = coalesce(b.vetted_at, v.vetted_at),
    blacklisted_at = coalesce(b.blacklisted_at, case when v.blacklisted then now() end),
    wants_calls = b.wants_calls and v.wants_calls,
    wants_follow_ups = b.wants_follow_ups and v.wants_follow_ups
  from t, v where b.id = t.id
  returning b.id
)
insert into public.buyers (workspace_id, name, company, phone, email, status, vip, vetted_at, blacklisted_at, wants_calls, wants_follow_ups, preferred_channel,
  buyer_type, website, tags, notes, criteria, markets, min_purchase_price, max_purchase_price, buy_box, source, source_id, created_by)
select ${W}, v.name, v.company, v.phone, v.email, v.status, v.vip, v.vetted_at, case when v.blacklisted then now() end, v.wants_calls, v.wants_follow_ups,
  coalesce(v.preferred_channel, 'email_and_sms'), v.buyer_type, v.website, v.tags, v.notes, v.criteria, v.markets,
  v.min_purchase_price, v.max_purchase_price, v.buy_box, v.source, v.source_id,
  (select m.user_id from public.workspace_members m join auth.users au on au.id = m.user_id where m.workspace_id = ${W} and lower(au.email) = v.creator limit 1)
from v where not exists (select 1 from t);`;
}

export function sqlFiles(buyers: PlannedBuyer[], workspaceId: number, per = 300): string[] {
  const chunks = Array.from({ length: Math.ceil(buyers.length / per) }, (_, i) => buyers.slice(i * per, i * per + per));
  return chunks.map((c, i) => [
    `-- Buyer lists (DispoGenius + Podio) → public.buyers, workspace ${workspaceId}. Part ${i + 1} of ${chunks.length} (${c.length} buyers).`,
    '-- Idempotent: re-running updates the rows this import wrote and never inserts a buyer twice.',
    '',
    ...c.map((b) => `-- ${b.rows.join(', ')}: ${b.name.replace(/\n/g, ' ')}\n${buyerSql(b, workspaceId)}\n`),
    ...(i === chunks.length - 1 ? [`-- Optional, after the last part: score the imported buyers against active inventory.\n-- select public.match_buyer(id) from public.buyers where workspace_id = ${workspaceId} and tags && array['podio-buyers', 'dispogenius'];`] : []),
  ].join('\n'));
}

// ------------------------------------------------------------------ apply (supabase-js), same rules as buyerSql

export type ExistingBuyer = {
  id: number; name: string; company: string | null; phone: string | null; phone_key: string | null; email: string | null;
  source: string | null; source_id: string | null; buyer_type: string | null; website: string | null; notes: string | null; buy_box: string | null;
  min_purchase_price: number | null; max_purchase_price: number | null; criteria: unknown; markets: string[] | null; status: string | null;
  preferred_channel: string | null; tags: string[] | null; vip: boolean; vetted_at: string | null; blacklisted_at: string | null;
  wants_calls: boolean; wants_follow_ups: boolean;
};
export const EXISTING_COLUMNS = 'id, name, company, phone, phone_key, email, source, source_id, buyer_type, website, notes, buy_box, min_purchase_price, max_purchase_price, criteria, markets, status, preferred_channel, tags, vip, vetted_at, blacklisted_at, wants_calls, wants_follow_ups';
const IMPORTED_ID = /^(buyers-list|dispogenius):/;
const lc = (v: string | null | undefined) => (v ?? '').toLowerCase();

/** The row a planned buyer lands on: this import's earlier row (ours), else a buyer CLOZR already had, lowest id first. */
export function findTarget(existing: ExistingBuyer[], b: PlannedBuyer): { row: ExistingBuyer; ours: boolean } | null {
  const byId = [...existing].sort((x, y) => x.id - y.id);
  const ours = byId.find((e) => (e.source === 'podio' || e.source === 'dispogenius') && !!e.source_id && b.source_ids.includes(e.source_id));
  if (ours) return { row: ours, ours: true };
  const other = byId.find((e) => !IMPORTED_ID.test(e.source_id ?? '') && (
    (b.phone != null && e.phone_key === b.phone) || (b.email != null && lc(e.email) === b.email)
    || (lc(e.name) === lc(b.name) && lc(e.company) === lc(b.company))));
  return other ? { row: other, ours: false } : null;
}

const isBlank = (v: unknown) => v == null || v === '';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Only the columns that change. */
export function patchFor(cur: ExistingBuyer, b: PlannedBuyer, ours: boolean, now: string): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const k of ['name', 'company', 'phone', 'email', 'buyer_type', 'website', 'notes', 'buy_box'] as const) next[k] = ours || isBlank(cur[k]) ? b[k] ?? cur[k] : cur[k];
  for (const k of ['min_purchase_price', 'max_purchase_price'] as const) next[k] = ours || cur[k] == null ? b[k] ?? cur[k] : cur[k];
  const emptyCriteria = !cur.criteria || (typeof cur.criteria === 'object' && !Object.keys(cur.criteria as object).length);
  next.criteria = ours || emptyCriteria ? b.criteria : cur.criteria;
  next.markets = ours || !cur.markets?.length ? b.markets : cur.markets;
  if (ours) { next.status = b.status; next.preferred_channel = b.preferred_channel ?? cur.preferred_channel; next.source = b.source; next.source_id = b.source_id; }
  const tags = [...new Set([...(cur.tags ?? []), ...b.tags])];
  next.tags = tags.length === (cur.tags ?? []).length ? cur.tags : tags;
  next.vip = cur.vip || b.vip;
  next.vetted_at = cur.vetted_at ?? b.vetted_at;
  next.blacklisted_at = cur.blacklisted_at ?? (b.blacklisted ? now : null);
  next.wants_calls = cur.wants_calls && b.wants_calls;
  next.wants_follow_ups = cur.wants_follow_ups && b.wants_follow_ups;
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => !same(v, cur[k as keyof ExistingBuyer])));
}

export function insertRow(b: PlannedBuyer, workspaceId: number, createdBy: string | null, now: string): Record<string, unknown> {
  return {
    workspace_id: workspaceId, name: b.name, company: b.company, phone: b.phone, email: b.email, status: b.status, vip: b.vip, vetted_at: b.vetted_at,
    blacklisted_at: b.blacklisted ? now : null, wants_calls: b.wants_calls, wants_follow_ups: b.wants_follow_ups, preferred_channel: b.preferred_channel ?? 'email_and_sms',
    buyer_type: b.buyer_type, website: b.website, tags: b.tags, notes: b.notes, criteria: b.criteria, markets: b.markets,
    min_purchase_price: b.min_purchase_price, max_purchase_price: b.max_purchase_price, buy_box: b.buy_box, source: b.source, source_id: b.source_id, created_by: createdBy,
  };
}
