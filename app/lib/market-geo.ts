/**
 * Where a market string actually is.
 *
 * Buyers carry `markets` as free text, and after years of imports that one
 * column holds four different kinds of thing at once: bare state codes ("SC",
 * "MO"), cities ("San Antonio"), counties ("Hidalgo County", "Bexar") and ZIP
 * codes ("63135"). A flat list of those reads as noise — 346 distinct values in
 * this workspace, with no way to ask "who buys in Texas".
 *
 * This resolves each token to a state, and a city inside it where there is one,
 * so the buyer list can be organised state → city. Nothing is thrown away: a
 * token that cannot be placed comes back as `unknown` and stays visible under
 * its own heading rather than disappearing from the filters.
 */

export type PlaceKind = 'state' | 'city' | 'zip' | 'county' | 'unknown';

export type Place = {
  /** The token exactly as it was stored, so a filter can still match the row. */
  token: string;
  kind: PlaceKind;
  /** Two-letter code, or null when the token could not be placed. */
  state: string | null;
  /** Present for a city or a ZIP we could name; null for a whole state. */
  city: string | null;
  /** What to show: "San Antonio, TX", "Texas", "Hidalgo County, TX". */
  label: string;
};

export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};

const BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

/**
 * USPS ZIP prefixes by state, as inclusive ranges over the first three digits.
 * Checked against every ZIP on this workspace's properties: the ranges agree
 * with the recorded state everywhere except a handful of rows where the
 * property itself is mistyped (a 350xx filed under SC, a 641xx under KS), which
 * is the reason a ZIP is resolved from this table rather than from our own
 * address history.
 */
const ZIP3_RANGES: [number, number, string][] = [
  [5, 5, 'NY'], [6, 9, 'PR'],
  [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'],
  [50, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'],
  [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'],
  [200, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'],
  [270, 289, 'NC'], [290, 299, 'SC'], [300, 319, 'GA'], [320, 349, 'FL'],
  [350, 369, 'AL'], [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'],
  [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'],
  [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [570, 577, 'SD'],
  [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'],
  [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'],
  [730, 749, 'OK'], [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'],
  [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'],
  [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'],
  [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
];

/** The state a ZIP code sits in, or null if it is not a US ZIP. */
export function stateOfZip(zip: string): string | null {
  const m = /^(\d{3})\d{2}(-\d{4})?$/.exec(zip.trim());
  if (!m) return null;
  const n = Number(m[1]);
  for (const [lo, hi, st] of ZIP3_RANGES) if (n >= lo && n <= hi) return st;
  return null;
}

/**
 * City → state, learned from rows that carry both. A city name is not unique —
 * this workspace has a Lancaster in four states and a Dallas in three — so a
 * name only resolves when one state holds a clear majority of the sightings.
 * Anything closer than that (Kansas City is 12 MO to 6 KS) stays unplaced,
 * because guessing would quietly file a buyer under a state they never named.
 */
export type Gazetteer = { city: Map<string, string> };

const MAJORITY = 0.7;

export function buildGazetteer(
  sightings: { city: string | null | undefined; state: string | null | undefined }[],
): Gazetteer {
  const counts = new Map<string, Map<string, number>>();
  for (const s of sightings) {
    const city = norm(s.city ?? '');
    const state = (s.state ?? '').trim().toUpperCase();
    if (!city || !STATE_NAMES[state]) continue;
    const per = counts.get(city) ?? new Map<string, number>();
    per.set(state, (per.get(state) ?? 0) + 1);
    counts.set(city, per);
  }
  const city = new Map<string, string>();
  for (const [name, per] of counts) {
    let best = '';
    let bestN = 0;
    let total = 0;
    for (const [state, n] of per) {
      total += n;
      if (n > bestN) { best = state; bestN = n; }
    }
    if (total > 0 && bestN / total >= MAJORITY) city.set(name, best);
  }
  return { city };
}

const norm = (s: string) =>
  s.trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');

/**
 * Display keeps whatever the token was typed as. Re-casing it loses more than
 * it fixes: "DFW" becomes "Dfw", "McAllen" becomes "Mcallen" and "St. Louis"
 * loses its stop.
 */
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

const COUNTY = /\b(county|parish|borough)\b/i;

export function resolveMarket(token: string, gaz: Gazetteer): Place {
  const raw = token.trim();
  const unknown: Place = { token: raw, kind: 'unknown', state: null, city: null, label: raw || '—' };
  if (!raw) return unknown;

  // A bare state, by code or by name.
  const up = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(up) && STATE_NAMES[up]) {
    return { token: raw, kind: 'state', state: up, city: null, label: STATE_NAMES[up] };
  }
  const byName = BY_NAME[norm(raw)];
  if (byName) {
    return { token: raw, kind: 'state', state: byName, city: null, label: STATE_NAMES[byName] };
  }

  // A ZIP. The table places it even when we have never sold there.
  if (/^\d{5}(-\d{4})?$/.test(raw)) {
    const st = stateOfZip(raw);
    return st
      ? { token: raw, kind: 'zip', state: st, city: null, label: `${raw} · ${st}` }
      : unknown;
  }

  // "Hidalgo County, TX" / "Bexar County" — a county, with a state if it says one.
  const tail = /,\s*([A-Za-z]{2})$/.exec(raw);
  const head = tail ? raw.slice(0, tail.index).trim() : raw;
  const tailState = tail && STATE_NAMES[tail[1].toUpperCase()] ? tail[1].toUpperCase() : null;
  if (COUNTY.test(head)) {
    // "Bexar County" is the same place our addresses call "Bexar", so the
    // gazetteer is asked for the bare name.
    const bare = norm(head.replace(COUNTY, ''));
    const st = tailState ?? gaz.city.get(bare) ?? null;
    return st
      ? { token: raw, kind: 'county', state: st, city: null, label: `${clean(head)}, ${st}` }
      : { ...unknown, kind: 'county' };
  }

  // "San Antonio, TX" or a bare city we can place from what we have sold.
  const st = tailState ?? gaz.city.get(norm(head)) ?? null;
  if (!st) return unknown;
  const city = clean(head);
  return { token: raw, kind: 'city', state: st, city, label: `${city}, ${st}` };
}

/**
 * Markets one buyer named, resolved together. Tokens help each other: a buyer
 * who lists "Honea Path" beside "29654" has told us the state even though the
 * city alone means nothing to us — but only when everything they named that we
 * *can* place agrees on one state, so a buyer covering nineteen markets does
 * not drag an unplaced city into whichever state happens to sort first.
 */
export function resolveMarkets(tokens: string[], gaz: Gazetteer): Place[] {
  const first = tokens.map((t) => resolveMarket(t, gaz));
  const states = new Set(first.map((p) => p.state).filter((s): s is string => !!s));
  if (states.size !== 1) return first;
  const only = [...states][0];
  return first.map((p) =>
    p.kind === 'unknown' && p.token
      ? { token: p.token, kind: 'city', state: only, city: clean(p.token), label: `${clean(p.token)}, ${only}` }
      : p);
}

/**
 * LLC or a person. `entity_type` is the stored answer when someone has set it;
 * otherwise the name is the only evidence there is, and a trailing company
 * suffix is what distinguishes "Monentus Group Llc" from "Kevin Arden".
 * A name with no suffix either way stays 'unclear' rather than being counted
 * as an individual — most buyers here have never been classified, and calling
 * all of them people would make the filter lie.
 */
export type EntityKind = 'llc' | 'entity' | 'individual' | 'unclear';

const LLC = /\b(l\.?\s?l\.?\s?c|llc)\b\.?$|\bllc\b/i;
const OTHER_ENTITY =
  /\b(inc|incorporated|corp|corporation|co|ltd|limited|l\.?p|llp|plc|trust|holdings?|properties|property|capital|group|investments?|ventures?|partners|realty|realtors|homes?|housing|residential|rentals?|estates?|development|developments|builders|enterprises?|fund|funding|equity|acquisitions?|solutions|management|associates)\b\.?$/i;

export function entityKind(
  name: string | null | undefined,
  company: string | null | undefined,
  stored?: string | null,
): EntityKind {
  const set = (stored ?? '').trim().toLowerCase();
  if (set === 'llc') return 'llc';
  if (set === 'individual' || set === 'person') return 'individual';
  if (set) return 'entity';

  // The company decides it when there is one: "Harbor Capital" is a company
  // whoever answers the phone for it.
  for (const text of [company, name].map((t) => (t ?? '').trim()).filter(Boolean)) {
    if (LLC.test(text)) return 'llc';
    if (OTHER_ENTITY.test(text.replace(/[.,]+$/, ''))) return 'entity';
  }
  const person = (company ?? '').trim() || (name ?? '').trim();
  if (!person) return 'unclear';
  // Two to four plain words and no digits: a person's name.
  const words = person.split(/\s+/);
  if (words.length >= 2 && words.length <= 4 && !/\d/.test(person)) return 'individual';
  return 'unclear';
}

export const ENTITY_LABELS: Record<EntityKind, string> = {
  llc: 'LLC',
  entity: 'Other entity',
  individual: 'Individual',
  unclear: 'Unclassified',
};
