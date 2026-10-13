/**
 * County deed index, searched by grantor name: who a wholesaler sold to.
 *
 * The portals that answer JSON without a browser are wired here; the ones
 * that need Playwright stay in buyr/scraper (the Python runner on Railway)
 * and this file says so. One adapter so far:
 *
 *   publicsearch.us (GovOS)  Bexar TX, Dallas TX, and any county on that
 *                            platform: GET /api/search?searchType=name&q=…
 *
 * Every call is a network read of a public record. A portal that errors or
 * rate limits comes back as `error`, never as "nobody bought from them".
 * The parsing is pure (genius-methods.ts parsePublicSearch) so it is tested
 * without a portal.
 */
import { type DeedTransaction, parsePublicSearch } from './genius-methods.ts';

export type Portal = { county: string; state: string; platform: 'publicsearch'; base: string };

/** Counties this function can read itself. The key is `${county}|${state}`, lower case. */
export const PORTALS: Record<string, Portal> = {
  'bexar|tx': { county: 'Bexar', state: 'TX', platform: 'publicsearch', base: 'https://bexar.tx.publicsearch.us' },
  'dallas|tx': { county: 'Dallas', state: 'TX', platform: 'publicsearch', base: 'https://dallas.tx.publicsearch.us' },
  'tarrant|tx': { county: 'Tarrant', state: 'TX', platform: 'publicsearch', base: 'https://tarrant.tx.publicsearch.us' },
  'denton|tx': { county: 'Denton', state: 'TX', platform: 'publicsearch', base: 'https://denton.tx.publicsearch.us' },
  'collin|tx': { county: 'Collin', state: 'TX', platform: 'publicsearch', base: 'https://collin.tx.publicsearch.us' },
  'williamson|tx': { county: 'Williamson', state: 'TX', platform: 'publicsearch', base: 'https://williamson.tx.publicsearch.us' },
  'hays|tx': { county: 'Hays', state: 'TX', platform: 'publicsearch', base: 'https://hays.tx.publicsearch.us' },
  'comal|tx': { county: 'Comal', state: 'TX', platform: 'publicsearch', base: 'https://comal.tx.publicsearch.us' },
  'guadalupe|tx': { county: 'Guadalupe', state: 'TX', platform: 'publicsearch', base: 'https://guadalupe.tx.publicsearch.us' },
  'fort bend|tx': { county: 'Fort Bend', state: 'TX', platform: 'publicsearch', base: 'https://fortbend.tx.publicsearch.us' },
  'montgomery|tx': { county: 'Montgomery', state: 'TX', platform: 'publicsearch', base: 'https://montgomery.tx.publicsearch.us' },
  'oklahoma|ok': { county: 'Oklahoma', state: 'OK', platform: 'publicsearch', base: 'https://oklahoma.ok.publicsearch.us' },
  'cleveland|ok': { county: 'Cleveland', state: 'OK', platform: 'publicsearch', base: 'https://cleveland.ok.publicsearch.us' },
};

/** Counties buyr's Python scraper reads (a browser or a county-specific form), so Genius can say where to look. */
export const PYTHON_ONLY = ['Harris TX', 'Travis TX', 'Hillsborough FL', 'Duval FL', 'Orange FL', 'Maricopa AZ', 'Pima AZ', 'Denver CO', 'Fulton GA', 'Chatham GA', 'Mecklenburg NC', 'Wake NC', 'Guilford NC', 'Forsyth NC', 'Durham NC', 'Davidson TN', 'Shelby TN', 'Knox TN', 'Hamilton TN', 'Greenville SC', 'Richland SC', 'Charleston SC', 'St. Louis MO', 'Jackson MO', 'Jefferson AL', 'Madison AL', 'Marion IN', 'Franklin OH', 'Hamilton OH', 'Montgomery OH', 'Pulaski AR', 'Tulsa OK'];

export const portalFor = (county: string | null | undefined, state: string | null | undefined): Portal | null =>
  PORTALS[`${String(county ?? '').toLowerCase().replace(/\s+county$/, '').trim()}|${String(state ?? '').toLowerCase().trim()}`] ?? null;

export type DeedSearch = { transactions: DeedTransaction[]; pages: number; error: string | null };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

/**
 * Every deed with this grantor on a publicsearch.us portal, newest first,
 * `maxPages` pages of 100. `since` (YYYY-MM-DD) stops the paging once the
 * rows are older than it, since the portal returns newest first.
 */
export async function searchGrantor(portal: Portal, grantor: string, opts: { maxPages?: number; since?: string | null; signal?: AbortSignal } = {}): Promise<DeedSearch> {
  const out: DeedTransaction[] = [];
  const maxPages = Math.max(1, Math.min(10, opts.maxPages ?? 3));
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams({ searchType: 'name', q: grantor, docGroup: 'DEED', page: String(page), perPage: '100', partyType: 'GRANTOR' });
    let res: Response;
    try {
      res = await fetch(`${portal.base}/api/search?${q}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: opts.signal ?? AbortSignal.timeout(20_000) });
    } catch (e) {
      return { transactions: out, pages, error: `${portal.county} County: ${(e as Error)?.name === 'TimeoutError' ? 'the deed index took too long' : 'could not reach the deed index'}` };
    }
    if (res.status === 429) return { transactions: out, pages, error: `${portal.county} County: the deed index is rate limiting (try again in a few minutes)` };
    if (!res.ok) return { transactions: out, pages, error: `${portal.county} County: the deed index answered ${res.status}` };
    const json = await res.json().catch(() => null);
    if (!json) return { transactions: out, pages, error: `${portal.county} County: the deed index sent an answer we could not read` };
    pages++;
    const rows = parsePublicSearch(json, grantor, portal.county, portal.state, portal.base);
    out.push(...rows);
    const total = Number(json?.total ?? json?.totalCount ?? NaN);
    const oldest = rows.map((r) => r.date).filter(Boolean).sort()[0] ?? null;
    if (rows.length < 100 || (Number.isFinite(total) && page * 100 >= total) || (opts.since && oldest && oldest < opts.since)) break;
    await new Promise((r) => setTimeout(r, 600 + Math.random() * 600));
  }
  return { transactions: out, pages, error: null };
}

/**
 * Every wholesaler name (the family and each alias) against one portal,
 * deduplicated by instrument. A portal error on one name is noted on the
 * result and the other names still run.
 */
export async function searchGrantors(portal: Portal, names: string[], opts: { maxPages?: number; since?: string | null } = {}): Promise<DeedSearch & { per_name: Record<string, number> }> {
  const seen = new Set<string>();
  const transactions: DeedTransaction[] = [];
  const per_name: Record<string, number> = {};
  const errors: string[] = [];
  let pages = 0;
  for (const name of Array.from(new Set(names.map((n) => n.trim()).filter(Boolean))).slice(0, 25)) {
    const r = await searchGrantor(portal, name, opts);
    pages += r.pages;
    per_name[name] = r.transactions.length;
    if (r.error) errors.push(r.error);
    for (const t of r.transactions) {
      const k = t.instrument ? `${t.instrument}` : `${t.grantor}|${t.grantee}|${t.date}|${t.address ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k); transactions.push(t);
    }
  }
  return { transactions, pages, per_name, error: errors.length ? Array.from(new Set(errors)).join('; ') : null };
}
