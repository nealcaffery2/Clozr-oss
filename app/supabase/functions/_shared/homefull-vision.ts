/**
 * The Homefull photo check: was this house actually renovated before it
 * resold? Listing photos in, a verdict out.
 *
 * Photos come from the resale listing, cheapest first:
 *   1. Apify's Zillow detail actor (maxcopell~zillow-detail-scraper, the one
 *      Compr runs), APIFY_TOKEN, by the house's Zillow search URL
 *   2. Firecrawl's image scrape of that URL (FIRECRAWL_API_KEY)
 *   3. Claude with web search and fetch (_shared/records-agent.ts), which
 *      finds the listing on any site, returns its photos and reads its remarks
 *   4. nothing: the verdict is null and the buyer keeps the base label
 * Neither key is required: without them every house goes to step 3.
 *
 * The verdict is Gemini Flash (GEMINI_API_KEY or GEMENI_API_KEY, the key the
 * avatar generator already uses; GEMINI_VISION_MODEL overrides the model) on
 * at most six photos, else Claude on the same photos, asked the one question
 * Compr's comp gate asks: is this a renovated, move-in-ready retail product,
 * and what in the pictures says so. With no photo readable, the listing
 * remarks Claude read decide it. Every verdict is cached 180 days in genius_property_cache under
 * `homefull:<reapi_id>`, so a run pays once per house.
 */
import type { HomefullTarget, RenovationVerdict } from './genius-methods.ts';
import { CLAUDE_MODEL } from './models.ts';
import { listingByAgent } from './records-agent.ts';

// deno-lint-ignore no-explicit-any
type Any = any;
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
export const MAX_PHOTOS = 6;

export type PhotoSet = { urls: string[]; source: 'apify' | 'firecrawl' | 'claude' | null; listing_url: string | null; note: string | null };

/** Listing photos for a house, by its Zillow search URL. */
export async function listingPhotos(zillowUrl: string, opts: { signal?: AbortSignal } = {}): Promise<PhotoSet> {
  const notes: string[] = [];
  const apify = env('APIFY_TOKEN');
  if (apify) {
    try {
      const actor = env('ZILLOW_APIFY_ACTOR') || 'maxcopell~zillow-detail-scraper';
      const res = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(apify)}&timeout=90&memory=1024`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startUrls: [{ url: zillowUrl }], maxItems: 1 }),
        signal: opts.signal ?? AbortSignal.timeout(100_000),
      });
      const items: Any[] = res.ok ? await res.json().catch(() => []) : [];
      const item = Array.isArray(items) ? items[0] : null;
      const urls = photoUrlsOf(item);
      if (urls.length) return { urls: urls.slice(0, MAX_PHOTOS * 2), source: 'apify', listing_url: item?.url ?? item?.detailUrl ?? zillowUrl, note: null };
      notes.push(res.ok ? 'Apify found no photos' : `Apify answered ${res.status}`);
    } catch (e) {
      notes.push(`Apify: ${(e as Error)?.name === 'TimeoutError' ? 'timed out' : 'unreachable'}`);
    }
  }
  const fire = env('FIRECRAWL_API_KEY');
  if (fire) {
    try {
      const res = await fetch(`${env('FIRECRAWL_API_BASE') || 'https://api.firecrawl.dev'}/v2/scrape`, {
        method: 'POST', headers: { authorization: `Bearer ${fire}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: zillowUrl, formats: ['images'], onlyMainContent: true, timeout: 45_000 }),
        signal: opts.signal ?? AbortSignal.timeout(60_000),
      });
      const j: Any = res.ok ? await res.json().catch(() => null) : null;
      const imgs: string[] = Array.isArray(j?.data?.images) ? j.data.images : [];
      const urls = imgs.filter((u) => /photos\.zillowstatic\.com|zillow.*\.(?:jpg|jpeg|webp)/i.test(u) && !/\b(?:p_[a-c]|_192|_96|avatar|logo|badge|map)\b/i.test(u));
      if (urls.length) return { urls: dedupeZillow(urls).slice(0, MAX_PHOTOS * 2), source: 'firecrawl', listing_url: zillowUrl, note: null };
      notes.push(res.ok ? 'Firecrawl found no listing photos' : `Firecrawl answered ${res.status}`);
    } catch (e) {
      notes.push(`Firecrawl: ${(e as Error)?.name === 'TimeoutError' ? 'timed out' : 'unreachable'}`);
    }
  }
  return { urls: [], source: null, listing_url: zillowUrl, note: notes.join('; ') };
}

/** The photo URLs an Apify Zillow item carries, whichever field the actor used. */
export function photoUrlsOf(item: Any): string[] {
  if (!item || typeof item !== 'object') return [];
  const out: string[] = [];
  const push = (u: unknown) => { if (typeof u === 'string' && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u); };
  for (const k of ['photos', 'images', 'responsivePhotos', 'hugePhotos', 'originalPhotos', 'photoUrls', 'imgSrc']) {
    const v = item[k];
    if (typeof v === 'string') push(v);
    for (const p of Array.isArray(v) ? v : []) {
      if (typeof p === 'string') push(p);
      else if (p && typeof p === 'object') {
        push(p.url ?? p.src ?? p.mixedSources?.jpeg?.slice?.(-1)?.[0]?.url ?? p.mixedSources?.jpeg?.[0]?.url);
      }
    }
  }
  return dedupeZillow(out);
}

/** Zillow serves one photo at many sizes; keep each photo once, largest first by name. */
function dedupeZillow(urls: string[]): string[] {
  const seen = new Map<string, string>();
  for (const u of urls) {
    const key = u.replace(/-cc_ft_\d+|-p_[a-z]|_\d{2,4}(?=\.(?:jpg|jpeg|webp))/gi, '').replace(/\?.*$/, '');
    const have = seen.get(key);
    if (!have || /cc_ft_1536|cc_ft_1344|cc_ft_960|_1536|_1344/.test(u)) seen.set(key, u);
  }
  return [...seen.values()];
}

const PROMPT = `You grade house listing photos for a real-estate investor. Decide whether this house was RENOVATED before it was listed: a fix-and-flip retail product (new kitchen cabinets and counters, new flooring, fresh paint throughout, updated bathrooms, new fixtures, staged or empty and clean), as opposed to an as-is or dated house (original kitchen and baths, worn carpet, old fixtures, deferred maintenance, clutter).
Answer only from what the photos show. If the photos are not of a house interior (a map, a logo, a street view only), say renovated is null.
Reply with JSON: {"renovated": true|false|null, "confidence": 0..1, "signals": ["short phrases naming what you saw", ...], "condition": "C1".."C6"} where C2 means recently renovated with modern finishes and C4 or worse means dated or as-is.`;

/** The verdict for one house, from up to MAX_PHOTOS of its photos. */
export async function renovationVerdict(photos: string[], opts: { signal?: AbortSignal } = {}): Promise<RenovationVerdict> {
  const key = env('GEMINI_API_KEY') || env('GEMENI_API_KEY');
  const urls = photos.slice(0, MAX_PHOTOS);
  if (!urls.length) return { renovated: null, confidence: 0, signals: ['no photos'], photos: 0, source: null };
  if (!key) return claudeVerdict(urls, opts);
  const parts: Any[] = [{ text: PROMPT }];
  let fetched = 0;
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const mime = (r.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
      if (!/^image\//.test(mime)) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > 6_000_000 || bytes.length < 2_000) continue;
      parts.push({ inline_data: { mime_type: mime, data: b64(bytes) } });
      fetched++;
    } catch { /* one bad photo never fails the house */ }
  }
  if (!fetched) return { renovated: null, confidence: 0, signals: ['photos could not be read'], photos: 0, source: null };
  const model = env('GEMINI_VISION_MODEL') || 'gemini-2.5-flash';
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 400 } }),
      signal: opts.signal ?? AbortSignal.timeout(50_000),
    });
    const j: Any = await res.json().catch(() => null);
    if (!res.ok) return { renovated: null, confidence: 0, signals: [`Gemini ${res.status}: ${String(j?.error?.message ?? '').slice(0, 120)}`], photos: fetched, source: null };
    const text = String(j?.candidates?.[0]?.content?.parts?.map((p: Any) => p?.text ?? '').join('') ?? '');
    const m = /\{[\s\S]*\}/.exec(text);
    const out: Any = m ? JSON.parse(m[0]) : null;
    if (!out) return { renovated: null, confidence: 0, signals: ['no verdict'], photos: fetched, source: null };
    const renovated = out.renovated === true ? true : out.renovated === false ? false : null;
    const grade = String(out.condition ?? '').toUpperCase();
    const signals = (Array.isArray(out.signals) ? out.signals : []).map(String).map((s: string) => s.trim().slice(0, 60)).filter(Boolean).slice(0, 6);
    if (grade && !signals.includes(grade)) signals.push(grade);
    return { renovated, confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)), signals, photos: fetched, source: null };
  } catch (e) {
    return { renovated: null, confidence: 0, signals: [`Gemini: ${(e as Error)?.name === 'TimeoutError' ? 'timed out' : 'unreachable'}`], photos: fetched, source: null };
  }
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['renovated', 'confidence', 'signals', 'condition'],
  properties: { renovated: { type: ['boolean', 'null'] }, confidence: { type: 'number' }, signals: { type: 'array', items: { type: 'string' } }, condition: { type: ['string', 'null'] } },
};

/** The same verdict from Claude, when Gemini is not connected. Claude reads the photo URLs itself. */
export async function claudeVerdict(photos: string[], opts: { signal?: AbortSignal } = {}): Promise<RenovationVerdict> {
  const apiKey = env('ANTHROPIC_API_KEY');
  const urls = photos.slice(0, MAX_PHOTOS);
  if (!apiKey) return { renovated: null, confidence: 0, signals: ['no vision model connected'], photos: urls.length, source: null };
  const ws = env('ANTHROPIC_WORKSPACE_ID');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(ws ? { 'anthropic-workspace-id': ws } : {}) },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 2000, output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
        messages: [{ role: 'user', content: [...urls.map((u) => ({ type: 'image', source: { type: 'url', url: u } })), { type: 'text', text: PROMPT }] }],
      }),
      signal: opts.signal ?? AbortSignal.timeout(50_000),
    });
    const j: Any = await res.json().catch(() => null);
    if (!res.ok) return { renovated: null, confidence: 0, signals: [`Claude ${res.status}: ${String(j?.error?.message ?? '').slice(0, 120)}`], photos: urls.length, source: null };
    const out: Any = JSON.parse((j?.content ?? []).filter((c: Any) => c.type === 'text').map((c: Any) => c.text ?? '').join('') || 'null');
    if (!out) return { renovated: null, confidence: 0, signals: ['no verdict'], photos: urls.length, source: null };
    const grade = String(out.condition ?? '').toUpperCase();
    const signals = (Array.isArray(out.signals) ? out.signals : []).map(String).map((s: string) => s.trim().slice(0, 60)).filter(Boolean).slice(0, 6);
    if (grade && !signals.includes(grade)) signals.push(grade);
    return { renovated: out.renovated === true ? true : out.renovated === false ? false : null, confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)), signals, photos: urls.length, source: null };
  } catch (e) {
    return { renovated: null, confidence: 0, signals: [`Claude: ${(e as Error)?.name === 'TimeoutError' ? 'timed out' : 'unreachable'}`], photos: urls.length, source: null };
  }
}

/**
 * Photos then the verdict, for one house; `source` on the verdict says where
 * the photos came from. `calls` counts the web searches and fetches Claude
 * made, so the caller can bill them.
 */
export async function checkHouse(t: Pick<HomefullTarget, 'zillow' | 'address' | 'city' | 'state' | 'zip' | 'resale_date'>): Promise<RenovationVerdict & { listing_url: string | null; note: string | null; calls: number }> {
  const photos = await listingPhotos(t.zillow);
  if (photos.urls.length) {
    const v = await renovationVerdict(photos.urls);
    return { ...v, source: photos.source, listing_url: photos.listing_url, note: null, calls: 0 };
  }
  // No Apify or Firecrawl answer: Claude finds the listing wherever it is.
  const where = [t.address, t.city, [t.state, t.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const r = await listingByAgent(where, { sold_date: t.resale_date });
  const l = r.listing;
  if (!l) return { renovated: null, confidence: 0, signals: ['no listing found'], photos: 0, source: null, listing_url: null, note: r.error ? `Homefull could not read listings: ${r.error}` : null, calls: r.calls };
  if (l.photo_urls.length) {
    const v = await renovationVerdict(l.photo_urls);
    if (v.renovated !== null) return { ...v, source: 'claude', listing_url: l.listing_url, note: null, calls: r.calls };
  }
  return { renovated: l.renovated, confidence: l.renovated === null ? 0 : Math.min(l.confidence, 0.8), signals: l.signals.length ? l.signals : ['listing remarks'], photos: 0, source: 'claude', listing_url: l.listing_url, note: null, calls: r.calls };
}
