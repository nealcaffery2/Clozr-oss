// Where a market is on a map.
//
// Buyers and realtors carry markets as text ("Phoenix, AZ", "Bexar County",
// "78501", "TX"), never coordinates, so the map places each one at the Census
// Bureau's internal point for that city, county, ZIP or state (2023 Gazetteer,
// built by scripts/build-geo.ts into public/geo). The files are fetched only
// when a map opens, and the ZIP file only when a market is a ZIP: the list
// views never pay for them.
//
// A pin at a market's centre says "buys in Phoenix", not "lives at this
// corner", and every title says which it is.

import type { Place } from './market-geo';
import { STATE_NAMES } from './market-geo';

export type LatLng = { lat: number; lng: number };
export type Located = LatLng & { precision: 'point' | 'city' | 'county' | 'zip' | 'state'; label: string };

/**
 * One spelling for a place name on both sides of the lookup: the Census writes
 * "St. Petersburg city" and a buyer writes "St Petersburg" or "Saint
 * Petersburg"; both become "saint petersburg".
 */
export function placeKey(name: string): string {
  return ` ${name.toLowerCase()} `
    .replace(/[’']/g, '')
    .replace(/\sst\.?\s/g, ' saint ')
    .replace(/\sste\.?\s/g, ' sainte ')
    .replace(/\sft\.?\s/g, ' fort ')
    .replace(/\smt\.?\s/g, ' mount ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The Census's legal descriptor, which nobody types: "Abbeville city", "Abanda CDP", "Nashville-Davidson metropolitan government (balance)". */
const DESCRIPTOR = /\s+(city and borough|consolidated government|metropolitan government|metro government|unified government|urban county|city|town|village|cdp|borough|municipality|plantation|corporation|comunidad|zona urbana)(\s+\(balance\))?$/i;
export const bareCensusName = (name: string) => name.replace(/\s*\(balance\)$/i, '').replace(DESCRIPTOR, '').trim();

/** Names the Census does not use for a place people do. */
const ALIASES: Record<string, [string, string]> = {
  'washington dc': ['DC', 'washington'], 'dc': ['DC', 'washington'], 'district of columbia': ['DC', 'washington'],
  'dfw': ['TX', 'dallas'], 'dallas fort worth': ['TX', 'dallas'], 'nyc': ['NY', 'new york'], 'okc': ['OK', 'oklahoma city'],
  'honolulu': ['HI', 'urban honolulu'], 'slc': ['UT', 'salt lake city'],
};

export type CentroidIndex = {
  /** "TX|san antonio" → point; counties as "TX|~bexar"; states as "TX|". */
  places: Map<string, LatLng>;
  zips: Map<string, LatLng> | null;
};

/** Parse a places file: "#ST" starts a state, then "key|lat|lng" lines; a line with an empty key is the state's own centre. */
export function parsePlaces(text: string): Map<string, LatLng> {
  const out = new Map<string, LatLng>();
  let st = '';
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line[0] === '#') { st = line.slice(1).trim(); continue; }
    const [k, a, b] = line.split('|');
    const lat = Number(a); const lng = Number(b);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = `${st}|${k}`;
    if (!out.has(key)) out.set(key, { lat, lng });
  }
  return out;
}

export function parseZips(text: string): Map<string, LatLng> {
  const out = new Map<string, LatLng>();
  for (const line of text.split('\n')) {
    const [z, a, b] = line.split('|');
    const lat = Number(a); const lng = Number(b);
    if (z && Number.isFinite(lat) && Number.isFinite(lng)) out.set(z, { lat, lng });
  }
  return out;
}

/**
 * A resolved market (lib/market-geo) on the map, or null when it cannot be
 * placed. A city we cannot find falls back to its county of the same name,
 * then to "<name> city" ("Oklahoma, OK"), never to the middle of its state: a
 * pin in central Texas for a city we could not read is worse than no pin.
 */
export function locate(place: Place, idx: CentroidIndex): Located | null {
  const st = place.state;
  const raw = place.token.trim();
  const alias = ALIASES[placeKey(raw.replace(/,\s*[A-Za-z]{2}$/, ''))];
  if (alias) {
    const hit = idx.places.get(`${alias[0]}|${alias[1]}`);
    if (hit) return { ...hit, precision: 'city', label: place.label };
  }
  if (place.kind === 'state' && st) {
    const hit = idx.places.get(`${st}|`);
    return hit ? { ...hit, precision: 'state', label: STATE_NAMES[st] ?? st } : null;
  }
  // "77469, TX" reads as a city named 77469.
  const zip = place.kind === 'zip' ? raw.slice(0, 5) : /^\d{5}$/.test(place.city ?? '') ? place.city : null;
  if (zip) {
    const hit = idx.zips?.get(zip);
    return hit ? { ...hit, precision: 'zip', label: place.label } : null;
  }
  if (!st) return null;
  if (place.kind === 'county') {
    const name = placeKey(raw.replace(/,\s*[A-Za-z]{2}$/, '').replace(/\b(county|parish|borough)\b/i, ''));
    const hit = idx.places.get(`${st}|~${name}`);
    return hit ? { ...hit, precision: 'county', label: place.label } : null;
  }
  if (place.kind === 'city' && place.city) {
    const k = placeKey(place.city);
    const hit = idx.places.get(`${st}|${k}`) ?? idx.places.get(`${st}|${k} city`);
    if (hit) return { ...hit, precision: 'city', label: place.label };
    const county = idx.places.get(`${st}|~${k}`);
    if (county) return { ...county, precision: 'county', label: place.label };
  }
  return null;
}

let placesP: Promise<Map<string, LatLng>> | null = null;
let zipsP: Promise<Map<string, LatLng>> | null = null;

const fetchText = (path: string) => fetch(path).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${path} ${r.status}`))));

/** The index, fetched once per page. ZIPs load only when asked for. A failed fetch is retried on the next call. */
export async function loadCentroids(withZips: boolean): Promise<CentroidIndex> {
  placesP ??= fetchText('/geo/places.txt').then(parsePlaces).catch((e) => { placesP = null; throw e; });
  if (withZips) zipsP ??= fetchText('/geo/zips.txt').then(parseZips).catch((e) => { zipsP = null; throw e; });
  const [places, zips] = await Promise.all([placesP, withZips ? zipsP : Promise.resolve(null)]);
  return { places, zips: zips ?? null };
}

/**
 * Pins that share a point (fifty buyers in "San Antonio, TX") fanned out on a
 * small spiral so each can be seen, clicked and lassoed. The spread is a few
 * hundred metres, well inside any city, and the same buyer lands in the same
 * place every time.
 */
export function fanOut<T extends LatLng>(items: T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((p) => {
    const key = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
    const i = seen.get(key) ?? 0;
    seen.set(key, i + 1);
    if (i === 0) return p;
    const r = 0.0028 * Math.sqrt(i);
    const a = i * 2.39996; // the golden angle, so rings never line up
    return { ...p, lat: p.lat + r * Math.sin(a), lng: p.lng + (r * Math.cos(a)) / Math.cos((p.lat * Math.PI) / 180) };
  });
}

/** The box around a set of points, or null for none. */
export function boundsOf(points: LatLng[]): { n: number; s: number; e: number; w: number } | null {
  if (!points.length) return null;
  let n = -90; let s = 90; let e = -180; let w = 180;
  for (const p of points) {
    if (p.lat > n) n = p.lat; if (p.lat < s) s = p.lat;
    if (p.lng > e) e = p.lng; if (p.lng < w) w = p.lng;
  }
  return { n, s, e, w };
}

/** Is (x, y) inside the polygon? Ray casting; the lasso's points are screen pixels. */
export function insidePolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]; const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
