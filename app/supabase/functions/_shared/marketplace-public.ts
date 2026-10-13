/**
 * The public marketplace card.
 *
 * This is the only shape a buyer-facing page is allowed to render. Photos,
 * the COMPR buyer report, and the comps PDF are included. Contracts, deeds,
 * disclosures, and assignment documents are not — a URL or field that looks
 * like one is dropped, even if a rep marked the file visible.
 */

const BLOCKED = /(contract|agreement|assignment|addendum|disclosure|promissory|\bdeed\b)/i;

export type Listing = {
  id: string;
  slug: string;
  url: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  market: string;
  lat: number | null;
  lng: number | null;
  price: number | null;
  arv: number | null;
  repairs: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  photos: string[];
  buyerReportUrl: string | null;
  compsUrl: string | null;
  occupancy: string | null;
  status: string;
  updatedAt: string | null;
  county: string;
  yearBuilt: number | null;
  lotSqft: number | null;
  propertyType: string | null;
  condition: string | null;
  description: string | null;
  listedAt: string | null;
  views: number;
  photoCount: number;
  hasReport: boolean;
  hasComps: boolean;
  allowOffers: boolean;
  /** Buyer has not joined the list yet: street address, extra photos and documents are held back. */
  locked: boolean;
};

export type MarketSource = {
  slug: string;
  url: string;
  showAddress: boolean;
  headline: string | null;
  workspaceId: number;
  dealId: number;
  stage: string;
  asking: unknown;
  marketed: unknown;
  offer: unknown;
  arv: unknown;
  rehab: unknown;
  occupancy: string | null;
  heroUrl: string | null;
  buyerReportUrl: string | null;
  cmaUrl: string | null;
  updatedAt: string | null;
  line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  beds: unknown;
  baths: unknown;
  sqft: unknown;
  lat: unknown;
  lng: unknown;
  photos: unknown[];
  county?: string | null;
  yearBuilt?: unknown;
  lotSqft?: unknown;
  propertyType?: string | null;
  condition?: string | null;
  description?: string | null;
  listedAt?: string | null;
  views?: unknown;
  allowOffers?: boolean;
};

export function isBuyerPhoto(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  return /^https:\/\//i.test(u) && !BLOCKED.test(u);
}

export function moneyAmount(n: unknown): number | null {
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.round(n);
  if (typeof n === 'string') {
    const v = Number(n.replace(/[$,\s]/g, ''));
    return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  }
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

export function moneyLabel(n: number | null): string | null {
  return n ? '$' + n.toLocaleString('en-US') : null;
}

/** Pin label: $170K, $1.3M. */
export function compactMoney(n: number | null): string | null {
  if (!n) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    const text = m >= 10 ? String(Math.round(m)) : m.toFixed(1).replace(/\.0$/, '');
    return `$${text}M`;
  }
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return moneyLabel(n);
}

export function marketStatus(stage: string): string {
  if (stage === 'Buyer Under Contract') return 'Sale Pending';
  if (stage === 'Ready To Market' || stage === 'Under Contract Seller') return 'Available';
  return stage;
}

function countOf(n: unknown): number | null {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function coord(n: unknown): number | null {
  const v = Number(n);
  if (!Number.isFinite(v) || Math.abs(v) < 0.01 || Math.abs(v) > 180) return null;
  return Math.round(v * 1e6) / 1e6;
}

function publicHttps(url: unknown): string | null {
  return isBuyerPhoto(url) ? url.trim() : null;
}

/** "2016 Meadow lane · Richmond, TX" from the older feed, split back apart. */
export function parseLegacyPlace(title: string, cityLine: string): { address: string; city: string; state: string } {
  const parts = cityLine.split('·').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const loc = parts[parts.length - 1];
    const m = /^(.*),\s*([A-Z]{2})$/.exec(loc);
    return { address: parts[0] || title, city: m ? m[1] : loc, state: m ? m[2] : '' };
  }
  return { address: title || cityLine, city: '', state: '' };
}

function bedsBaths(beds: unknown): { beds: number | null; baths: number | null } {
  if (typeof beds === 'string') {
    const b = /(\d+(?:\.\d+)?)\s*bd/.exec(beds);
    const a = /(\d+(?:\.\d+)?)\s*ba/.exec(beds);
    return { beds: b ? Number(b[1]) : null, baths: a ? Number(a[1]) : null };
  }
  return { beds: countOf(beds), baths: null };
}

/** Feed row from /listing/market.json, old or new. Contracts never survive. */
export function fromFeed(row: Record<string, unknown>): Listing {
  const title = String(row.title ?? row.address ?? '').trim();
  const cityLine = String(row.city ?? '');
  const parsed = row.address ? null : parseLegacyPlace(title, cityLine);
  const address = String(row.address ?? parsed?.address ?? title);
  const city = String(row.cityName ?? (row.address ? row.city : parsed?.city) ?? '');
  const state = String(row.state ?? parsed?.state ?? '');
  const zip = String(row.zip ?? '');
  const pair = bedsBaths(row.bedsCount ?? row.beds);
  const photos = [
    ...(Array.isArray(row.photos) ? row.photos : []),
    row.imageUrl,
    row.photo,
    row.heroUrl,
  ].filter(isBuyerPhoto);
  const unique = [...new Set(photos)];
  // A teaser's coordinates were already rounded to about a kilometre by
  // lockCard (and are null where the rep hid the address), so they are safe
  // to pin. Dropping them sent every visitor's map to the browser geocoder:
  // one Nominatim call at a time, twelve deals at most, the rest never pinned.
  const reveal = row.locked === true || (row.showAddress !== false && address !== 'Address on request');
  return {
    id: String(row.deal_id ?? row.id ?? row.slug ?? address),
    slug: String(row.slug ?? ''),
    url: String(row.url ?? ''),
    address: address || 'Address on request',
    city,
    state,
    zip,
    market: [city, state].filter(Boolean).join(', ') || 'Other',
    lat: reveal ? coord(row.lat ?? row.latitude) : null,
    lng: reveal ? coord(row.lng ?? row.longitude) : null,
    price: moneyAmount(row.priceAmount ?? row.askingPrice ?? row.price),
    arv: moneyAmount(row.arvAmount ?? row.arv),
    repairs: moneyAmount(row.repairs ?? row.rehab),
    beds: pair.beds,
    baths: countOf(row.bathsCount ?? row.baths) ?? pair.baths,
    sqft: countOf(row.sqft),
    photos: unique.slice(0, 24),
    buyerReportUrl: publicHttps(row.buyerReportUrl ?? row.buyer_report_url),
    compsUrl: publicHttps(row.compsUrl ?? row.cma_url ?? row.cmaUrl),
    occupancy: row.occupancy ? String(row.occupancy) : null,
    status: String(row.status ?? 'Available'),
    updatedAt: row.updatedAt ? String(row.updatedAt) : null,
    county: String(row.county ?? ''),
    yearBuilt: countOf(row.yearBuilt),
    lotSqft: countOf(row.lotSqft),
    propertyType: row.propertyType ? String(row.propertyType) : null,
    condition: row.condition ? String(row.condition) : null,
    description: row.description ? String(row.description) : null,
    listedAt: row.listedAt ? String(row.listedAt) : null,
    views: countOf(row.views) ?? 0,
    photoCount: Math.max(countOf(row.photoCount) ?? 0, unique.length),
    hasReport: row.hasReport === true || !!publicHttps(row.buyerReportUrl ?? row.buyer_report_url),
    hasComps: row.hasComps === true || !!publicHttps(row.compsUrl ?? row.cma_url ?? row.cmaUrl),
    allowOffers: row.allowOffers !== false,
    locked: row.locked === true,
  };
}

/**
 * What a visitor who has not joined the buyers list gets: the city and county,
 * a pin within about a kilometre, the cover photo and the numbers. The street
 * address, the rest of the photos, the listing link and the COMPR documents
 * wait for sign-up.
 */
export function lockCard(card: Record<string, unknown>): Record<string, unknown> {
  const photos = Array.isArray(card.photos) ? card.photos : [];
  const blur = (n: unknown) => (typeof n === 'number' ? Math.round(n * 100) / 100 : null);
  const city = String(card.cityName ?? '');
  const state = String(card.state ?? '');
  const area = [city, state].filter(Boolean).join(', ') || 'Address on request';
  return {
    ...card,
    title: area,
    city: area,
    address: 'Address on request',
    // City and state only, as the SOP says for anything public: a zip, the
    // county, the year built and the write-up were enough to find the house.
    zip: '',
    county: '',
    yearBuilt: null,
    year_built: null,
    description: null,
    lat: blur(card.lat),
    lng: blur(card.lng),
    photos: photos.slice(0, 1),
    photo: photos[0] ?? null,
    imageUrl: photos[0] ?? null,
    photoCount: photos.length,
    buyerReportUrl: null,
    buyer_report_url: null,
    compsUrl: null,
    cma_url: null,
    hasReport: !!card.buyerReportUrl,
    hasComps: !!card.compsUrl,
    slug: '',
    url: '',
    packageUrl: '',
    locked: true,
  };
}

const SUFFIX = '(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|trl|trail|pkwy|parkway|hwy|highway)';
const streetNorm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);
const DIRECTION_ALIAS: Record<string, string> = {
  n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
  north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

/**
 * The forms of a street address worth hiding, longest first: the whole line,
 * then the house number with the street's name, with and without a leading
 * direction ("123 N Main St", "123 N Main", "123 Main"). Nothing without a
 * house number, so "Main" alone never blanks a sentence, and never a number
 * with only a direction ("123 N").
 */
function streetForms(line1: string | null | undefined): string[] {
  const street = streetNorm(line1);
  if (!street || !/^\d/.test(street)) return [];
  const [num, ...rest] = street.split(' ');
  const dir = rest.length > 1 && DIRECTIONS.has(rest[0]) ? rest[0] : null;
  const name = dir ? rest[1] : rest[0];
  // "N" saved, "North" written (or the other way round) is the same street.
  const dirs = dir ? [dir, DIRECTION_ALIAS[dir]].filter(Boolean) : [];
  const forms = [street, ...dirs.map((d) => (name ? `${num} ${d} ${name}` : null)), name ? `${num} ${name}` : null];
  return [...new Set(forms.filter((f): f is string => !!f && f.split(' ').length >= 2))];
}

/** Does free text (a headline, a description) carry the street address? Case and punctuation do not hide it. */
export function mentionsStreet(text: string | null | undefined, line1: string | null | undefined): boolean {
  const t = ` ${streetNorm(text)} `;
  return streetForms(line1).some((f) => t.includes(` ${f} `));
}

/**
 * Public copy shows the city and state only unless the rep turned the full
 * address on. Every mention of the street becomes `place` (the city and
 * state), however it was typed.
 */
export function hideStreet(text: string, line1: string | null | undefined, place: string): string {
  let out = text;
  for (const f of streetForms(line1)) {
    const pattern = f.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+');
    // A street type typed differently ("Rd" saved, "Road" written) goes with it.
    out = out.replace(new RegExp(`(^|[^a-z0-9])${pattern}(?:[^a-z0-9]+${SUFFIX})?(?=$|[^a-z0-9])`, 'gi'), (_m, pre) => `${pre}${place}`);
  }
  return out;
}

/** What the listing function puts on market.json. Legacy keys stay for the old grid. */
export function toMarketCard(s: MarketSource): Record<string, unknown> {
  const reveal = s.showAddress;
  const address = reveal ? (s.line1 || s.headline || 'Investment property') : 'Address on request';
  const city = s.city || '';
  const state = s.state || '';
  const price = moneyAmount(s.asking ?? s.marketed ?? s.offer);
  const arv = moneyAmount(s.arv);
  const repairs = moneyAmount(s.rehab);
  const beds = countOf(s.beds);
  const baths = countOf(s.baths);
  const photos = [...new Set([s.heroUrl, ...s.photos].filter(isBuyerPhoto))].slice(0, 24);
  const place = reveal
    ? [s.line1, [city, state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
    : [city, state].filter(Boolean).join(', ') || 'Address on request';
  return {
    slug: s.slug,
    url: s.url,
    title: (reveal ? s.headline || s.line1 : null) || place,
    city: place,
    price: moneyLabel(price),
    arv: moneyLabel(arv),
    photo: photos[0] ?? null,
    beds: beds && baths ? `${beds} bd / ${baths} ba` : null,
    buyer_report_url: publicHttps(s.buyerReportUrl),
    cma_url: publicHttps(s.cmaUrl),
    workspace_id: s.workspaceId,
    deal_id: s.dealId,
    id: String(s.dealId),
    address,
    cityName: city,
    state,
    zip: s.zip || '',
    lat: reveal ? coord(s.lat) : null,
    lng: reveal ? coord(s.lng) : null,
    showAddress: reveal,
    priceAmount: price,
    askingPrice: price,
    arvAmount: arv,
    repairs,
    bedsCount: beds,
    bathsCount: baths,
    sqft: countOf(s.sqft),
    imageUrl: photos[0] ?? null,
    photos,
    occupancy: s.occupancy,
    buyerReportUrl: publicHttps(s.buyerReportUrl),
    compsUrl: publicHttps(s.cmaUrl),
    status: marketStatus(s.stage),
    updatedAt: s.updatedAt,
    packageUrl: s.url,
    county: s.county || '',
    yearBuilt: countOf(s.yearBuilt),
    lotSqft: countOf(s.lotSqft),
    propertyType: s.propertyType || null,
    condition: s.condition || null,
    description: s.description ? (reveal ? String(s.description) : hideStreet(String(s.description), s.line1, [city, state].filter(Boolean).join(', ') || 'this area')).slice(0, 4000) : null,
    listedAt: s.listedAt || null,
    views: countOf(s.views) ?? 0,
    photoCount: photos.length,
    hasReport: !!publicHttps(s.buyerReportUrl),
    hasComps: !!publicHttps(s.cmaUrl),
    allowOffers: s.allowOffers !== false,
    locked: false,
  };
}

/** Days since a listing went up, for "Listed 3 days ago" and the Just listed badge. */
export function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
}
