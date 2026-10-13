/**
 * One spelling for every place.
 *
 * City, state and market are typed by hand, pasted from spreadsheets, mapped
 * from Podio and Jotform, and posted by partners, and nothing between those
 * doors and the filters agreed on a spelling. The same market arrived as
 * "San Antonio", "san antonio tx", "San Antonio, TX", "SAN ANTONIO TX 78254"
 * and "San antonio tX", and every one of them became its own entry in a menu.
 *
 * This module is the one answer, shared by the screens (crm.ts reads through
 * it), the write paths (crm-write, import, Quick Add) and the tests. (Not
 * lib/places.ts, which is the Google Places autocomplete on the address box.) Migration
 * 122 carries the same rules into Postgres (`place_split`, `place_city`,
 * `place_market` and the triggers behind them), so a row written by an edge
 * function or a webhook ends up spelled the same way as one typed here.
 *
 * The rules:
 *   - A state is its USPS code in storage ("TX") and its name on screen
 *     ("Texas"). "tx", "Tx.", "texas" and "TEXAS" all mean TX.
 *   - A city holds only the city. A state or ZIP typed into the city column
 *     moves to its own column; "San Antonio Tx" is city "San Antonio", state
 *     "TX".
 *   - A city is spelled the way the Census spells it when the state is known
 *     ("McAllen", "DeSoto", "St. Louis", "Winston-Salem"); otherwise it is
 *     title-cased with the usual care for Mc, O' and hyphens.
 *   - A market token is one of: a state code ("TX"), "City, ST", "X County,
 *     ST" or a ZIP. A bare city with no state stays a bare, canonical city —
 *     guessing its state is lib/market-geo's job, with the workspace's own
 *     address history as evidence.
 */

import { STATE_NAMES, stateOfZip } from './market-geo';
import { citiesIn, countiesIn } from './us-cities';

// ---- states ----------------------------------------------------------------

const CODE_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

/** Strict: a real USPS code or a state name, else null. "Tx." → "TX", "texas" → "TX", "xx" → null. */
export function stateCodeOf(raw: string | null | undefined): string | null {
  const t = String(raw ?? '').trim().replace(/\.+$/, '').replace(/\s+/g, ' ');
  if (!t) return null;
  const up = t.toUpperCase();
  if (up.length === 2 && STATE_NAMES[up]) return up;
  return CODE_BY_NAME[t.toLowerCase()] ?? null;
}

/** "TX" → "Texas". Anything that is not a state comes back as typed. */
export function stateNameOf(code: string | null | undefined): string {
  const c = stateCodeOf(code);
  return c ? STATE_NAMES[c] : String(code ?? '').trim();
}

// ---- spelling ------------------------------------------------------------------

/** Tokens the Census writes one way and people another. Applied to both sides of a lookup. */
const TOKEN_ALIASES: Record<string, string> = {
  saint: 'st', sainte: 'ste', ft: 'fort', mt: 'mount', pt: 'point', hts: 'heights', spgs: 'springs', jct: 'junction',
};

/** The comparison form of a place name: lower case, punctuation gone, aliases applied, one space between words. */
export function placeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => TOKEN_ALIASES[w] ?? w)
    .join(' ');
}

/** Regional markets people type as initials; title-casing them would be wrong. */
const ACRONYMS = new Set(['DFW', 'RGV', 'OKC', 'STL', 'NOLA', 'SWFL', 'NWA', 'ATL', 'PNW']);

/** Words that stay lower case inside a name ("Lake of the Woods"). */
const SMALL_WORDS = new Set(['of', 'the', 'and', 'at', 'on', 'in', 'by', 'for', 'du', 'des']);

function capWord(word: string, first: boolean): string {
  if (!word) return word;
  const lower = word.toLowerCase();
  if (!first && SMALL_WORDS.has(lower)) return lower;
  // "Washington DC" keeps its DC: a two-letter state code typed in capitals
  // after the first word is an abbreviation, not a word to re-case.
  if (!first && word.length === 2 && word === word.toUpperCase() && STATE_NAMES[word]) return word;
  // Mc + a capital: McAllen, McKinney. Not Mac — Macon, Mackinaw.
  if (/^mc[a-z]/.test(lower)) return 'Mc' + lower[2].toUpperCase() + lower.slice(3);
  // O'Fallon, D'Iberville keep the capital after the apostrophe.
  if (/^[a-z]'[a-z]/.test(lower)) return lower[0].toUpperCase() + "'" + lower[2].toUpperCase() + lower.slice(3);
  return lower[0].toUpperCase() + lower.slice(1);
}

/**
 * Title case for a place that the Census does not list. Handles Mc, O',
 * hyphens ("Winston-Salem"), "St." and "Ste.", keeps "of" and "the" small, and
 * leaves a known regional acronym alone.
 */
export function titleCasePlace(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (ACRONYMS.has(s.toUpperCase())) return s.toUpperCase();
  let first = true;
  const out = s.replace(/[A-Za-z][A-Za-z']*/g, (word) => {
    const w = capWord(word, first);
    first = false;
    return w;
  });
  // "St Louis" and "st. louis" are both "St. Louis"; the same for Ste.
  return out.replace(/\b(St|Ste)\b\.?(?=\s)/g, '$1.');
}

type Index = Map<string, string>;
const byState = new Map<string, Index>();
let global: Index | null = null;
const AMBIGUOUS = '\u0000';

function stateIndex(state: string): Index {
  let idx = byState.get(state);
  if (!idx) {
    idx = new Map();
    // Largest first, so a key two places share resolves to the bigger one.
    for (const p of [...citiesIn(state), ...countiesIn(state)]) {
      const k = placeKey(p.name);
      if (!idx.has(k)) idx.set(k, p.name);
    }
    byState.set(state, idx);
  }
  return idx;
}

/** Every state's names in one map; a key spelled differently in two states is marked ambiguous. */
function globalIndex(): Index {
  if (global) return global;
  global = new Map();
  for (const code of Object.keys(STATE_NAMES)) {
    for (const [k, name] of stateIndex(code)) {
      const have = global.get(k);
      if (have === undefined) global.set(k, name);
      else if (have !== name) global.set(k, AMBIGUOUS);
    }
  }
  return global;
}

/**
 * The spelling the Census uses for this city or county, when the state is
 * known and the place is listed; the one spelling every state agrees on when
 * the state is not; title case otherwise.
 */
export function canonicalCity(city: string, state?: string | null): string {
  const s = city.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const k = placeKey(s);
  if (!k) return '';
  const st = stateCodeOf(state);
  if (st) {
    const hit = stateIndex(st).get(k);
    if (hit) return hit;
  } else {
    const hit = globalIndex().get(k);
    if (hit && hit !== AMBIGUOUS) return hit;
  }
  return titleCasePlace(s);
}

// ---- splitting ----------------------------------------------------------------

export type PlaceParts = { city: string | null; state: string | null; zip: string | null };

const COUNTRY = /,?\s*\b(usa|u\.s\.a\.|united states( of america)?|us)\s*$/i;
const ZIP_TAIL = /[\s,]*\b(\d{5})(?:-\d{4})?\s*$/;

/**
 * Pull the state and ZIP out of a place written as one string.
 *
 *   "San Antonio Tx"            → { city: "San Antonio", state: "TX", zip: null }
 *   "san antonio, texas 78254"  → { city: "San Antonio", state: "TX", zip: "78254" }
 *   "San Antonio"               → { city: "San Antonio", state: null, zip: null }
 *   "TX" / "Texas"              → { city: null, state: "TX", zip: null }
 *   "78254"                     → { city: null, state: null, zip: "78254" }
 *
 * The city comes back canonical. A trailing word is read as a state only when
 * something precedes it, so a city that is also a state's name ("Washington")
 * stays a city unless it is the whole string.
 */
export function splitPlace(raw: string | null | undefined): PlaceParts {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const none: PlaceParts = { city: null, state: null, zip: null };
  if (!s) return none;
  s = s.replace(COUNTRY, '').trim();
  // "San Antonio - TX", "San Antonio / TX", "San Antonio | TX" are commas.
  s = s.replace(/\s+[-–—|/]\s+/g, ', ');
  // A stray stop or comma at the end ("Ga 30331.") is not part of the place.
  s = s.replace(/[.,\s]+$/, '');

  let zip: string | null = null;
  const z = ZIP_TAIL.exec(s);
  if (z) {
    zip = z[1];
    s = s.slice(0, z.index).trim().replace(/,$/, '').trim();
  }
  if (!s) return { ...none, zip };

  // A single state, by code or name.
  const whole = stateCodeOf(s);
  if (whole) return { city: null, state: whole, zip };

  let state: string | null = null;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const last = stateCodeOf(parts[parts.length - 1]);
    if (last) { state = last; parts.pop(); }
  }
  let city = parts.join(', ');

  if (!state) {
    // No comma: "San Antonio Tx", "San Antonio Texas", "Kansas City Missouri",
    // "Washington North Carolina". Longest state name first.
    const words = city.split(' ');
    for (const n of [3, 2, 1]) {
      if (words.length <= n) continue;
      const tail = words.slice(-n).join(' ');
      const code = stateCodeOf(tail);
      if (code) {
        state = code;
        city = words.slice(0, -n).join(' ');
        break;
      }
    }
  }

  city = city.replace(/[,\s]+$/, '').trim();
  // "77469, TX": the ZIP came first and the tail check above missed it. Any
  // other run of digits ("3222", a ZIP that lost a digit) is not a city.
  const zipOnly = /^(\d{5})(?:-\d{4})?$/.exec(city);
  if (zipOnly && !zip) { zip = zipOnly[1]; city = ''; }
  else if (/^[\d-]+$/.test(city)) city = '';
  if (!state && zip) state = stateOfZip(zip);
  return { city: city ? canonicalCity(city, state) : null, state, zip };
}

/**
 * The property-level fix: city holds only the city, state is a code, ZIP is
 * five digits. Whatever was typed into the wrong column moves to the right
 * one; a column that already had a value keeps it.
 */
export function normalizePlace(p: { city?: string | null; state?: string | null; zip?: string | null }): PlaceParts {
  const typedState = stateCodeOf(p.state);
  const rawState = String(p.state ?? '').trim();
  // "TX 78254" or "Texas, 78254" in the state column.
  const stateParts = typedState ? null : rawState ? splitPlace(rawState) : null;
  let state = typedState ?? stateParts?.state ?? null;
  let zip: string | null = null;
  const zRaw = String(p.zip ?? '').replace(/\s+/g, '');
  const zm = /^(\d{5})(?:-\d{4})?$/.exec(zRaw);
  if (zm) zip = zm[1];
  else if (/^\d{4}$/.test(zRaw)) zip = '0' + zRaw; // a leading zero lost to a spreadsheet
  zip = zip ?? stateParts?.zip ?? null;

  const fromCity = splitPlace(p.city);
  let city = fromCity.city ?? (stateParts?.city ?? null);
  // A city that is also a state's name ("Washington", "Nevada") is a city when
  // the state column already names a different state; it is only a misfiled
  // state when nothing else does. Keeps the fix stable: fixing a fixed row
  // changes nothing.
  if (!city && fromCity.state && state && fromCity.state !== state) city = String(p.city).trim();
  if (!state) state = fromCity.state;
  if (!zip) zip = fromCity.zip;
  return { city: city ? canonicalCity(city, state) : null, state, zip };
}

// ---- markets ------------------------------------------------------------------

const COUNTY = /\b(county|parish|borough|municipality|census area)\b/i;

/**
 * One market token in its stored form: "TX", "San Antonio, TX",
 * "Hidalgo County, TX", "78254", or a bare canonical city when no state is
 * named and `hintState` has none either. Empty input is null.
 */
export function canonicalMarket(token: string | null | undefined, hintState?: string | null): string | null {
  const raw = String(token ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const { city, state, zip } = splitPlace(raw);
  if (!city) {
    if (zip) return zip;
    return state ?? null;
  }
  const st = state ?? stateCodeOf(hintState) ?? null;
  // A county keeps its word so "Bexar County" and the city of Bexar stay apart.
  const name = COUNTY.test(city) ? canonicalCounty(city, st) : canonicalCity(city, st);
  return st ? `${name}, ${st}` : name;
}

function canonicalCounty(raw: string, state: string | null): string {
  const hit = state ? stateIndex(state).get(placeKey(raw)) : null;
  if (hit) return hit;
  const m = /^(.*?)\s*\b(county|parish|borough|municipality|census area)\b\s*$/i.exec(raw);
  if (!m) return titleCasePlace(raw);
  const kind = m[2].toLowerCase() === 'census area' ? 'Census Area' : titleCasePlace(m[2]);
  return `${titleCasePlace(m[1].trim())} ${kind}`;
}

/** A buyer's or vendor's markets, each canonical, blanks dropped, duplicates folded. */
export function normalizeMarkets(tokens: readonly (string | null | undefined)[] | null | undefined, hintState?: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens ?? []) {
    for (const piece of splitMarketCell(t)) {
      const m = canonicalMarket(piece, hintState);
      if (!m) continue;
      const k = m.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
  }
  return out;
}

/**
 * One cell can hold several markets: "DFW, Houston", "TX; OK", "San Antonio,
 * TX, Austin, TX". A comma followed by a state belongs to the place before it.
 */
export function splitMarketCell(cell: string | null | undefined): string[] {
  const parts = String(cell ?? '').split(/[;|\n]/).flatMap((p) => p.split(','));
  const out: string[] = [];
  for (const raw of parts.map((p) => p.trim()).filter(Boolean)) {
    if (out.length && stateCodeOf(raw) && !/^\d/.test(raw) && !stateCodeOf(out[out.length - 1]) && !/,/.test(out[out.length - 1])) {
      out[out.length - 1] = `${out[out.length - 1]}, ${raw}`;
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** What a market token says on screen: a state by name, everything else as stored. */
export function marketLabel(token: string | null | undefined): string {
  const t = String(token ?? '').trim();
  if (!t) return '';
  const st = stateCodeOf(t);
  return st ? STATE_NAMES[st] : t;
}

/** "San Antonio, TX" / "San Antonio" / "Texas" / "" from a city and a state. */
export function cityStateLabel(city: string | null | undefined, state: string | null | undefined): string {
  const st = stateCodeOf(state);
  const c = String(city ?? '').trim();
  if (c && st) return `${c}, ${st}`;
  if (c) return c;
  return st ? STATE_NAMES[st] : '';
}

/**
 * A deal's market on screen: the city and a state abbreviation, "Charlotte, NC".
 * A stored market that is only a state ("NC", "North Carolina") is not the
 * label — the property's city fills it in. A spelled-out state name is never
 * what this returns.
 */
export function dealMarketLabel(
  dealMarket: string | null | undefined,
  city: string | null | undefined,
  state: string | null | undefined,
): string {
  const place = normalizePlace({ city, state });
  const own = canonicalMarket(dealMarket, place.state);
  const ownIsState = !!own && !!stateCodeOf(own) && own.length <= 2;
  if (own && !ownIsState) return own;
  const st = place.state || (ownIsState ? own : null);
  if (place.city && st) return `${place.city}, ${st}`;
  if (place.city) return place.city;
  return st || '';
}
