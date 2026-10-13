// Builds lib/us-cities.ts — the city and county pick lists behind the buyer
// buy-box location picker — from the Census Bureau's population estimates.
// Run from app/:  node tools/gen-us-cities.mjs [sub-est.csv] [co-est-alldata.csv]
// With no paths it downloads both files (Node's fetch ignores HTTPS_PROXY, so
// behind a proxy curl them first and pass the paths).
import { readFileSync, writeFileSync } from 'node:fs';

const VINTAGE = 2024;
const SUB_URL = `https://www2.census.gov/programs-surveys/popest/datasets/2020-${VINTAGE}/cities/totals/sub-est${VINTAGE}.csv`;
const CO_URL = `https://www2.census.gov/programs-surveys/popest/datasets/2020-${VINTAGE}/counties/totals/co-est${VINTAGE}-alldata.csv`;
const MIN_POP = 5000;
const OUT = new URL('../lib/us-cities.ts', import.meta.url);

const load = async (path, url) => (path ? readFileSync(path, 'latin1') : (await fetch(url)).text());

// Quoted fields carry commas ("Islamorada, Village of Islands village").
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const row = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else cur += c;
    }
    row.push(cur);
    rows.push(row);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// Consolidated governments go by their city's everyday name, which is what a
// deal's address carries.
const RENAME = {
  'Athens-Clarke County unified government (balance)': 'Athens',
  'Augusta-Richmond County consolidated government (balance)': 'Augusta',
  'Cusseta-Chattahoochee County unified government': 'Cusseta',
  'Macon-Bibb County': 'Macon',
  'Urban Honolulu CDP': 'Honolulu',
  'Lexington-Fayette urban county': 'Lexington',
  'Louisville/Jefferson County metro government (balance)': 'Louisville',
  'Anaconda-Deer Lodge County': 'Anaconda',
  'Butte-Silver Bow (balance)': 'Butte',
  'Hartsville/Trousdale County': 'Hartsville',
  'Lynchburg, Moore County metropolitan government': 'Lynchburg',
  'Nashville-Davidson metropolitan government (balance)': 'Nashville',
  'Greeley County unified government (balance)': 'Tribune',
  'Islamorada, Village of Islands village': 'Islamorada',
  'San Buenaventura (Ventura) city': 'Ventura',
  'El Paso de Robles (Paso Robles) city': 'Paso Robles',
};

// Only the trailing legal-type word goes: "Kansas City city" → "Kansas City",
// "Carson City" and "Princeton" have none and stay whole.
const TYPE_SUFFIX = / (city and borough|city|town|village|borough|municipality|corporation|metro township|township|CDP)$/;
function placeName(raw) {
  if (RENAME[raw]) return RENAME[raw];
  return raw.replace(/ \(balance\)$/, '').replace(TYPE_SUFFIX, '');
}

const sub = parseCsv(await load(process.argv[2], SUB_URL));
const co = parseCsv(await load(process.argv[3], CO_URL));
const POP = `POPESTIMATE${VINTAGE}`;

const STATES = [...new Set(sub.filter((r) => r.SUMLEV === '040').map((r) => r.STNAME))];
const code = {};
// State FIPS → USPS for the 50 states + DC (the files carry FIPS and names only).
const FIPS = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY' };
for (const r of sub) if (r.SUMLEV === '040') code[r.STNAME] = FIPS[r.STATE];
if (STATES.length !== 51 || Object.values(code).some((c) => !c)) throw new Error('expected 50 states + DC');

// SUMLEV 162 is every incorporated place (plus the consolidated-city balances
// and Urban Honolulu CDP, which stands in for Honolulu).
const cities = {};
for (const r of sub) {
  if (r.SUMLEV !== '162') continue;
  const pop = Number(r[POP]);
  if (!(pop >= MIN_POP)) continue;
  const st = code[r.STNAME];
  const name = placeName(r.NAME);
  if (/[|:()]/.test(name) || / (County|government)\b/.test(name)) throw new Error('unhandled place name: ' + r.NAME);
  const m = (cities[st] ??= new Map());
  m.set(name, Math.max(m.get(name) ?? 0, pop));
}
// Every county and county-equivalent, whatever its size ("Dallas County",
// "Orleans Parish", "Richmond city" in VA, Connecticut's planning regions).
const counties = {};
for (const r of co) {
  if (r.SUMLEV !== '050') continue;
  const st = code[r.STNAME];
  const m = (counties[st] ??= new Map());
  m.set(r.CTYNAME, Number(r[POP]));
}

const pack = (m) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n, p]) => `${n}:${p}`).join('|');
const block = (o) => Object.keys(o).sort().map((st) => `  ${st}: ${JSON.stringify(pack(o[st]))},`).join('\n');
const nCities = Object.values(cities).reduce((s, m) => s + m.size, 0);
const nCounties = Object.values(counties).reduce((s, m) => s + m.size, 0);

const out = `// GENERATED by tools/gen-us-cities.mjs — do not edit by hand.
//
// US Census Bureau, Population Estimates Program, Vintage ${VINTAGE}
// (July 1, ${VINTAGE} resident population):
//   cities:   ${SUB_URL}
//             incorporated places (SUMLEV 162) with ${MIN_POP.toLocaleString('en-US')}+ people, ${nCities} in all
//   counties: ${CO_URL}
//             every county / county-equivalent (SUMLEV 050), ${nCounties} in all
// 50 states + DC. Place names lose only their trailing legal type
// ("Kansas City city" → "Kansas City"); consolidated governments use the
// city's common name ("Nashville", "Louisville"). Each state packs
// "Name:population|…", largest first.

const CITIES: Record<string, string> = {
${block(cities)}
};

const COUNTIES: Record<string, string> = {
${block(counties)}
};

export type GeoPlace = { name: string; pop: number };

const cache = new Map<string, GeoPlace[]>();
const unpack = (key: string, packed: string | undefined): GeoPlace[] => {
  let v = cache.get(key);
  if (!v) {
    v = packed ? packed.split('|').map((s) => { const i = s.lastIndexOf(':'); return { name: s.slice(0, i), pop: Number(s.slice(i + 1)) }; }) : [];
    cache.set(key, v);
  }
  return v;
};

/** Incorporated places in a state (USPS code), largest first. */
export const citiesIn = (state: string): GeoPlace[] => unpack('c' + state.toUpperCase(), CITIES[state.toUpperCase()]);
/** Counties and county-equivalents in a state, largest first. */
export const countiesIn = (state: string): GeoPlace[] => unpack('k' + state.toUpperCase(), COUNTIES[state.toUpperCase()]);

/** Type-ahead: names starting with the query, then a word starting with it,
 *  then containing it — each group largest first. Empty query → the biggest. */
export function searchPlaces(list: GeoPlace[], q: string, limit = 8): GeoPlace[] {
  const t = q.trim().toLowerCase().replace(/^st\\.? /, 'st. ');
  if (!t) return list.slice(0, limit);
  const a: GeoPlace[] = []; const b: GeoPlace[] = []; const c: GeoPlace[] = [];
  for (const p of list) {
    const n = p.name.toLowerCase();
    if (n.startsWith(t)) a.push(p);
    else if (n.includes(' ' + t) || n.includes('-' + t)) b.push(p);
    else if (n.includes(t)) c.push(p);
  }
  return [...a, ...b, ...c].slice(0, limit);
}

/** 1326087 → "1.3M", 245310 → "245K", 8204 → "8.2K". */
export function formatPop(n: number): string {
  if (n >= 999_500) return (n / 1e6).toFixed(1).replace(/\\.0$/, '') + 'M';
  if (n >= 1e5) return Math.round(n / 1e3) + 'K';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\\.0$/, '') + 'K';
  return String(n);
}
`;
writeFileSync(OUT, out);
console.log(`lib/us-cities.ts: ${nCities} cities, ${nCounties} counties, ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`);
