// Builds public/geo/places.txt and public/geo/zips.txt from the Census
// Bureau's 2023 Gazetteer files, for the buyer and people maps
// (lib/geo-centroids.ts).
//
//   curl -O https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip
//   curl -O https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_counties_national.zip
//   curl -O https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip
//   unzip -o '*.zip'
//   npx tsx scripts/build-geo.ts <folder with the three .txt files>
//
// Points are the Census internal points, rounded to 3 decimals (about 100 m).
// A state's own centre is the land-weighted mean of its counties' points.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bareCensusName, placeKey } from '../lib/geo-centroids';

const dir = process.argv[2];
if (!dir) throw new Error('usage: npx tsx scripts/build-geo.ts <gazetteer folder>');

const rows = (file: string) => {
  const [head, ...lines] = readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l.trim());
  const cols = head.split('\t').map((c) => c.trim());
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v.trim()])) as Record<string, string>);
};
const r3 = (n: number) => String(Math.round(n * 1000) / 1000);

type Entry = { st: string; key: string; lat: number; lng: number; rank: number };
const entries: Entry[] = [];

// Places: an incorporated place beats a CDP of the same name, then the larger one wins.
for (const p of rows('2023_Gaz_place_national.txt')) {
  const name = bareCensusName(p.NAME);
  const lat = Number(p.INTPTLAT); const lng = Number(p.INTPTLONG);
  if (!name || !Number.isFinite(lat)) continue;
  const rank = (p.FUNCSTAT === 'A' ? 1e15 : 0) + Number(p.ALAND || 0);
  entries.push({ st: p.USPS, key: placeKey(name), lat, lng, rank });
  // "Nashville-Davidson", "Louisville/Jefferson County", "Athens-Clarke County": people say the first half.
  const first = name.split(/[-/]/)[0].trim();
  if (first !== name) entries.push({ st: p.USPS, key: placeKey(first), lat, lng, rank: rank - 1e15 - 1 });
}

const counties = rows('2023_Gaz_counties_national.txt');
const stateSum = new Map<string, { lat: number; lng: number; w: number }>();
for (const c of counties) {
  const lat = Number(c.INTPTLAT); const lng = Number(c.INTPTLONG); const w = Number(c.ALAND || 0);
  if (!Number.isFinite(lat)) continue;
  const bare = c.NAME.replace(/\s+(county|parish|borough|city and borough|census area|municipality|municipio|planning region)$/i, '');
  entries.push({ st: c.USPS, key: '~' + placeKey(bare), lat, lng, rank: w });
  const s = stateSum.get(c.USPS) ?? { lat: 0, lng: 0, w: 0 };
  s.lat += lat * w; s.lng += lng * w; s.w += w;
  stateSum.set(c.USPS, s);
}
for (const [st, s] of stateSum) if (s.w > 0) entries.push({ st, key: '', lat: s.lat / s.w, lng: s.lng / s.w, rank: Infinity });

entries.sort((a, b) => a.st.localeCompare(b.st) || b.rank - a.rank);
const out: string[] = [];
let st = '';
const seen = new Set<string>();
for (const e of entries) {
  if (e.st !== st) { st = e.st; out.push('#' + st); }
  const k = `${e.st}|${e.key}`;
  if (seen.has(k)) continue;
  seen.add(k);
  out.push(`${e.key}|${r3(e.lat)}|${r3(e.lng)}`);
}

const zips = rows('2023_Gaz_zcta_national.txt').map((z) => `${z.GEOID}|${r3(Number(z.INTPTLAT))}|${r3(Number(z.INTPTLONG))}`);

mkdirSync('public/geo', { recursive: true });
writeFileSync('public/geo/places.txt', out.join('\n') + '\n');
writeFileSync('public/geo/zips.txt', zips.join('\n') + '\n');
console.log(`places.txt: ${out.length} lines · zips.txt: ${zips.length} lines`);
