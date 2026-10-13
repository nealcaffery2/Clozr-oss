/**
 * Public records through Claude, for every county we have no adapter for.
 *
 * Genius reads deeds and parcel owners three ways, cheapest first:
 *   1. an API we hold (ATTOM, RealEstateAPI, a publicsearch.us portal)
 *   2. this file: Claude with the server-side web_search and web_fetch tools
 *      finds the county's own register of deeds or assessor site and reads it
 *   3. buyr/scraper (Playwright on Railway) for the portals that only answer
 *      a real browser
 *
 * Three jobs, each one Messages call that may pause and resume:
 *   deedsByAgent   every deed a set of grantors signed in one county
 *   ownerByAgent   who owns a parcel, from the assessor or GIS record
 *   listingByAgent the resale listing of a house: photos, remarks, a verdict
 *
 * Env: ANTHROPIC_API_KEY (ANTHROPIC_WORKSPACE_ID when the key spans several).
 * A missing key, a refusal or an unreadable answer is an `error`, never an
 * empty result. The normalizers are pure so tools/records-agent.test.ts runs
 * them without the network.
 */
import { CLAUDE_MODEL } from './models.ts';
import { WRITING_RULE } from './no-ai-slop.ts';
import type { DeedTransaction } from './genius-methods.ts';

// deno-lint-ignore no-explicit-any
type Any = any;
const env = (k: string) => ((globalThis as Any).Deno?.env.get(k) ?? '').trim();

export type AgentRun<T> = { data: T | null; error: string | null; searches: number; fetches: number };

const S = { type: ['string', 'null'] } as const;
const N = { type: ['number', 'null'] } as const;

/**
 * One agent call: web_search and web_fetch on, the answer held to `schema`.
 * A pause_turn (the server's tool loop ran long) is resumed up to three times.
 */
export async function webAgent<T>(system: string, prompt: string, schema: Record<string, unknown>, opts: { searches?: number; fetches?: number; timeoutMs?: number } = {}): Promise<AgentRun<T>> {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) return { data: null, error: 'ANTHROPIC_API_KEY is not set on the Supabase project', searches: 0, fetches: 0 };
  const ws = env('ANTHROPIC_WORKSPACE_ID');
  const messages: Any[] = [{ role: 'user', content: prompt }];
  const deadline = Date.now() + (opts.timeoutMs ?? 110_000);
  let searches = 0; let fetches = 0;
  for (let turn = 0; turn < 4; turn++) {
    const left = deadline - Date.now();
    if (left < 5_000) return { data: null, error: 'the records search ran out of time', searches, fetches };
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(ws ? { 'anthropic-workspace-id': ws } : {}) },
        body: JSON.stringify({
          model: CLAUDE_MODEL, max_tokens: 16000, system,
          output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
          tools: [
            { type: 'web_search_20260209', name: 'web_search', max_uses: opts.searches ?? 6 },
            { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: opts.fetches ?? 10, max_content_tokens: 30000 },
          ],
          messages,
        }),
        signal: AbortSignal.timeout(left),
      });
    } catch (e) {
      return { data: null, error: (e as Error)?.name === 'TimeoutError' ? 'the records search ran out of time' : 'could not reach Claude', searches, fetches };
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { /* raw */ }
      return { data: null, error: res.status === 401 ? 'the ANTHROPIC_API_KEY secret is invalid' : res.status === 429 ? 'Claude is rate limiting this account; try again in a minute' : `Claude ${res.status}: ${msg}`, searches, fetches };
    }
    const out: Any = JSON.parse(text);
    searches += Number(out?.usage?.server_tool_use?.web_search_requests) || 0;
    fetches += Number(out?.usage?.server_tool_use?.web_fetch_requests) || 0;
    if (out.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: out.content }); continue; }
    if (out.stop_reason === 'refusal') return { data: null, error: 'Claude declined this records search', searches, fetches };
    const raw = (out.content ?? []).filter((c: Any) => c.type === 'text').map((c: Any) => c.text ?? '').join('');
    try { return { data: JSON.parse(raw) as T, error: null, searches, fetches }; }
    catch { return { data: null, error: 'Claude sent an answer we could not read', searches, fetches }; }
  }
  return { data: null, error: 'the records search did not finish', searches, fetches };
}

const clean = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);
const money = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
const ymd = (v: unknown) => {
  const s = clean(v, 40); if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const url = (v: unknown) => { const s = clean(v, 600); return s && /^https?:\/\//.test(s) ? s : null; };

// ---- deeds by grantor -------------------------------------------------------------------------------

const DEED_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['index_url', 'transactions', 'note'],
  properties: {
    index_url: S,
    note: S,
    transactions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['grantor', 'grantee', 'date', 'price', 'address', 'doc_type', 'instrument', 'source_url'],
        properties: { grantor: { type: 'string' }, grantee: { type: 'string' }, date: S, price: N, address: S, doc_type: S, instrument: S, source_url: S },
      },
    },
  },
};

const DEED_SYSTEM = `You search county land records for a real-estate investor. Use web_search to find the official register of deeds (recorder, county clerk) online index for the county you are given, then web_fetch its search pages and results to list deeds where one of the given names is the GRANTOR (the seller). Prefer the county's own index; a state or vendor portal the county links to (for example publicsearch.us, Laredo, Landmark Web, Courthouse Computer Systems, BIS, Avenu, Fidlar, iDocMarket) is fine. Tax or GIS sale lists that name buyer and seller count when the index cannot be read.
Only report deeds you actually saw on a page. Never guess a grantee, a date or a price. If the index needs a login, a paid account, a CAPTCHA or a browser form you cannot submit, return no transactions, set index_url to the index page and say so in note in one plain sentence. Dates are YYYY-MM-DD. Price is the consideration or the excise or transfer tax converted to a price only when the page states the price; otherwise null.${WRITING_RULE}`;

/** Every deed these grantors signed in one county, read by Claude off the county's own index. */
export async function deedsByAgent(county: string, state: string, names: string[], opts: { since?: string | null } = {}): Promise<{ transactions: DeedTransaction[]; index_url: string | null; note: string | null; error: string | null; calls: number }> {
  const list = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean))).slice(0, 12);
  if (!list.length) return { transactions: [], index_url: null, note: null, error: null, calls: 0 };
  const prompt = `County: ${county} County, ${state}.
Grantor names to search (each is a wholesaler or an entity of one; search each name):
${list.map((n) => `- ${n}`).join('\n')}
${opts.since ? `Only deeds recorded on or after ${opts.since}.` : ''}
Return every deed you find with one of these names as grantor, at most 150.`;
  const r = await webAgent<Any>(DEED_SYSTEM, prompt, DEED_SCHEMA, { searches: 5, fetches: 14 });
  const calls = r.searches + r.fetches;
  if (!r.data) return { transactions: [], index_url: null, note: null, error: r.error, calls };
  return { ...normalizeAgentDeeds(r.data, county, state, list), error: null, calls };
}

/** The agent's deed list as DeedTransactions: names trimmed, dates and prices checked, duplicates and strangers dropped. */
export function normalizeAgentDeeds(j: Any, county: string, state: string, names: string[]): { transactions: DeedTransaction[]; index_url: string | null; note: string | null } {
  const wanted = names.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean);
  const looksLike = (g: string) => { const k = g.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return wanted.some((w) => k.includes(w) || w.includes(k)); };
  const seen = new Set<string>();
  const out: DeedTransaction[] = [];
  const index = url(j?.index_url);
  for (const t of Array.isArray(j?.transactions) ? j.transactions : []) {
    const grantor = clean(t?.grantor); const grantee = clean(t?.grantee);
    if (!grantor || !grantee || !looksLike(grantor) || grantor.toLowerCase() === grantee.toLowerCase()) continue;
    const date = ymd(t?.date); const instrument = clean(t?.instrument, 60);
    const k = instrument ?? `${grantor}|${grantee}|${date}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ grantor, grantee, date, price: money(t?.price), address: clean(t?.address), county, state: state.toUpperCase(), doc_type: clean(t?.doc_type, 60) ?? 'deed', instrument, source_url: url(t?.source_url) ?? index ?? '' });
  }
  return { transactions: out, index_url: index, note: clean(j?.note, 300) };
}

// ---- parcel owner -----------------------------------------------------------------------------------

export type ParcelOwner = { owner: string | null; owner2: string | null; mailing: string | null; last_sale_date: string | null; last_sale_price: number | null; parcel_id: string | null; source_url: string | null; note: string | null };

const OWNER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['owner', 'owner2', 'mailing', 'last_sale_date', 'last_sale_price', 'parcel_id', 'source_url', 'note'],
  properties: { owner: S, owner2: S, mailing: S, last_sale_date: S, last_sale_price: N, parcel_id: S, source_url: S, note: S },
};

const OWNER_SYSTEM = `You look up who owns a house from public records for a real-estate investor. Use web_search to find the county assessor, tax office or GIS parcel viewer for the address, then web_fetch the parcel record. Report the owner of record exactly as the record spells it, the second owner if there is one, the owner's mailing address, the last sale date and price, the parcel id and the page you read it on.
Only report what a page shows. Never guess an owner from a listing site, a people-search site or a name in a news story. If no record can be read, leave the fields null and say why in note in one plain sentence. Dates are YYYY-MM-DD.${WRITING_RULE}`;

/** The owner of record for one address, read off the county's assessor or GIS. */
export async function ownerByAgent(address: string): Promise<{ owner: ParcelOwner | null; error: string | null; calls: number }> {
  const r = await webAgent<Any>(OWNER_SYSTEM, `Address: ${address}`, OWNER_SCHEMA, { searches: 4, fetches: 6, timeoutMs: 80_000 });
  const calls = r.searches + r.fetches;
  if (!r.data) return { owner: null, error: r.error, calls };
  return { owner: normalizeOwner(r.data), error: null, calls };
}

export function normalizeOwner(j: Any): ParcelOwner {
  return {
    owner: clean(j?.owner), owner2: clean(j?.owner2), mailing: clean(j?.mailing, 240),
    last_sale_date: ymd(j?.last_sale_date), last_sale_price: money(j?.last_sale_price),
    parcel_id: clean(j?.parcel_id, 60), source_url: url(j?.source_url), note: clean(j?.note, 300),
  };
}

// ---- resale listing (Homefull) ----------------------------------------------------------------------

export type ListingRead = { listing_url: string | null; photo_urls: string[]; remarks: string | null; renovated: boolean | null; confidence: number; signals: string[] };

const LISTING_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['listing_url', 'photo_urls', 'remarks', 'renovated', 'confidence', 'signals'],
  properties: {
    listing_url: S, remarks: S,
    photo_urls: { type: 'array', items: { type: 'string' } },
    renovated: { type: ['boolean', 'null'] },
    confidence: { type: 'number' },
    signals: { type: 'array', items: { type: 'string' } },
  },
};

const LISTING_SYSTEM = `You check whether a house was renovated before it resold, for a real-estate investor. Use web_search to find the sale listing for the address (Redfin, Realtor.com, Homes.com, Zillow, a brokerage site or the MLS public page), then web_fetch it. Read the agent remarks and the feature list, and collect the direct photo URLs (jpg, jpeg, webp) the page carries, up to 12.
renovated is true when the remarks or features describe a fix-and-flip retail product (new kitchen, new counters, new flooring, new paint throughout, updated baths, new roof or HVAC as part of a renovation), false when they describe an as-is, investor special, needs-work or dated house, and null when you could not find the listing or it says neither. signals are short phrases quoted or paraphrased from the listing. Never invent a remark or a photo URL.`;

/** The resale listing of one house: Claude finds it, returns its photos and remarks, and judges the remarks. */
export async function listingByAgent(address: string, opts: { sold_date?: string | null } = {}): Promise<{ listing: ListingRead | null; error: string | null; calls: number }> {
  const prompt = `Address: ${address}${opts.sold_date ? `\nIt resold around ${opts.sold_date}; find that sale's listing.` : ''}`;
  const r = await webAgent<Any>(LISTING_SYSTEM, prompt, LISTING_SCHEMA, { searches: 3, fetches: 5, timeoutMs: 80_000 });
  const calls = r.searches + r.fetches;
  if (!r.data) return { listing: null, error: r.error, calls };
  return { listing: normalizeListing(r.data), error: null, calls };
}

export function normalizeListing(j: Any): ListingRead {
  const photos = (Array.isArray(j?.photo_urls) ? j.photo_urls : []).map(url).filter((u: string | null): u is string => !!u && /\.(?:jpe?g|webp|png)(?:\?|$)/i.test(u));
  return {
    listing_url: url(j?.listing_url),
    photo_urls: Array.from(new Set<string>(photos)).slice(0, 12),
    remarks: clean(j?.remarks, 1200),
    renovated: j?.renovated === true ? true : j?.renovated === false ? false : null,
    confidence: Math.max(0, Math.min(1, Number(j?.confidence) || 0)),
    signals: (Array.isArray(j?.signals) ? j.signals : []).map((s: unknown) => clean(s, 60)).filter(Boolean).slice(0, 6) as string[],
  };
}
