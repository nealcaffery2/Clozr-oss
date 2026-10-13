/**
 * Which record, and which deal, an email belongs to.
 *
 * Pure: no Supabase, no Gmail. google.ts loads the workspace into a `Book`
 * and asks this file about each message, so the rules can be tested with
 * `deno run supabase/functions/_shared/gmail-match.test.ts`.
 *
 * The rules, in the order they are tried:
 *   people   every address on the message (From, To and Cc) against every
 *            seller, buyer and vendor address in the workspace, lower-cased.
 *   deal     a street named in the subject: first among the deals the people
 *            on the message are on, then any one deal in the workspace (a
 *            buyer asking about a different property files there, not on the
 *            deal they already hold); then a street named in the body among
 *            the people's deals; then the seller's latest deal, or the one
 *            deal a buyer, vendor or deal party (title, agent, lender) is on;
 *            last, a body naming exactly one deal in the workspace. Bulk mail
 *            never files on a street alone. A buyer or title company on
 *            several deals with no street named is left for the AI fallback
 *            (`candidates`) rather than guessed.
 *   thread   a message that matches nothing on its own (the title officer's
 *            assistant replying all, a forward to the lender) inherits the
 *            link of the thread it is in: its Gmail thread-mates, the stored
 *            message it replies to, or a stored message with the same
 *            counterpart and subject (`conversationKey`). `mergeLink` fills
 *            only what the message's own match left empty.
 *   reroute  routing is re-run as deals change. A row the rules or the AI
 *            filed moves only when a street now names another deal
 *            (`reroute`); a row a person filed never moves.
 */

export type Link = {
  seller_id: number | null; buyer_id: number | null; vendor_id: number | null;
  deal_id: number | null; property_id: number | null;
};

export type DealRef = {
  id: number; property_id: number | null; seller_id: number | null;
  /** streetKey() of the property's line1, or null when there is none worth matching. */
  street: string | null;
  /** The property's line1 as written, for the AI fallback's candidate list. */
  label?: string | null;
  /**
   * How far along the pipeline the deal is (dealRank): when two deals carry
   * the same street (a sheet import and a Podio submission of one house), the
   * one further along gets the mail rather than neither.
   */
  rank?: number;
};

/** A deal stage as a tie-break between deals on the same street: the live pipeline first, Prospect next, dead last. */
export function dealRank(stage: string | null | undefined): number {
  switch (stage) {
    case 'In Escrow': return 6;
    case 'Buyer Under Contract': return 5;
    case 'Ready To Market': return 4;
    case 'Under Contract Seller': return 3;
    case 'Closed': return 2;
    case 'Prospect': case null: case undefined: case '': return 1;
    default: return 0;
  }
}

/** How a deal was chosen: a street named in the message, or the people on it. */
export type Why = 'street' | 'person' | null;

/** A link, why its deal was chosen, and the deals it could not choose between. */
export type Route = { link: Link; why: Why; candidates: DealRef[] };

export type Book = {
  sellers: Map<string, number>; buyers: Map<string, number>; vendors: Map<string, number>;
  /** Addresses on a deal without a CRM row of their own (deal_parties.email, transactions.title_email) → deal ids. */
  parties: Map<string, number[]>;
  /** Newest first per person, as loaded. */
  dealsBySeller: Map<number, DealRef[]>;
  dealsByBuyer: Map<number, DealRef[]>;
  dealsByVendor: Map<number, DealRef[]>;
  deals: Map<number, DealRef>;
  /** Our own side: every connected mailbox, every member's login, and every blast from-address. Never a match, never "inbound". */
  ours: Set<string>;
  /** Those addresses → the rep who owns them. Optional so a book built before this field still matches. */
  reps?: Map<string, string>;
};

/**
 * House number → deals on that number. Built once per `deals` map.
 * Matching a street by scanning every deal on every message is what pushed
 * Gmail sync over the edge isolate's CPU budget (HTTP 546) on a workspace
 * with thousands of deals. Keyed on the map itself so a copied book with a
 * new `deals` map does not reuse a stale index.
 */
const streetsByHouse = new WeakMap<Map<number, DealRef>, Map<string, DealRef[]>>();

function streetsOf(book: Book): Map<string, DealRef[]> {
  let by = streetsByHouse.get(book.deals);
  if (by) return by;
  by = new Map();
  for (const d of book.deals.values()) {
    const n = d.street?.split(' ')[0];
    if (!n) continue;
    const list = by.get(n);
    if (list) list.push(d);
    else by.set(n, [d]);
  }
  streetsByHouse.set(book.deals, by);
  return by;
}

/** Deals whose house number appears in `text`. `oneNamed` still requires the whole street. */
function dealsForText(book: Book, text: string): DealRef[] {
  if (!text) return [];
  const idx = streetsOf(book);
  const seen = new Set<number>();
  const out: DealRef[] = [];
  for (const w of words(text)) {
    if (!/^\d+[a-z]?$/.test(w)) continue;
    for (const d of idx.get(w) ?? []) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

export const emptyLink = (): Link => ({ seller_id: null, buyer_id: null, vendor_id: null, deal_id: null, property_id: null });
export const isLinked = (l: Link) => l.seller_id != null || l.buyer_id != null || l.vendor_id != null || l.deal_id != null;

/** A stored address as a key: trimmed, lower-cased, or '' when it is not one. */
export const addrKey = (e: unknown) => {
  const s = String(e ?? '').trim().toLowerCase();
  return /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/.test(s) ? s : '';
};

/**
 * Every address in a header, lower-cased: "Doe, Jane" <j@x.com>, b@y.com → ['j@x.com', 'b@y.com'].
 * Read by pattern rather than by splitting on commas, which a quoted display name can contain.
 */
export const addressesOf = (header: string) =>
  Array.from(new Set((String(header ?? '').match(/[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[^\s<>,;:"'()[\]]+/g) ?? []).map((a) => a.toLowerCase())));

/** In-Reply-To and References as bare Message-IDs with their angle brackets, the form communications.source_id stores. */
export const refsOf = (inReplyTo: string | undefined, references: string | undefined) =>
  Array.from(new Set(`${references ?? ''} ${inReplyTo ?? ''}`.match(/<[^<>\s]+>/g) ?? []));

const SUFFIX: Record<string, string> = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', lane: 'ln', boulevard: 'blvd', court: 'ct',
  circle: 'cir', place: 'pl', parkway: 'pkwy', terrace: 'ter', trail: 'trl', highway: 'hwy', way: 'way',
  cove: 'cv', point: 'pt', square: 'sq', crossing: 'xing', loop: 'loop', run: 'run', path: 'path',
};
const DIR: Record<string, string> = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };
const words = (s: string) => s.toLowerCase().replace(/[.,#'’]/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] ?? DIR[w] ?? w);

/**
 * "123 N. Main Street, Apt 4" → "123 n main st". Null unless it starts with a
 * house number and has a street name after it: "Main St" alone would match
 * half the mail in a market. Anything after the first comma (unit, city) is
 * dropped, since subjects rarely carry it.
 */
export function streetKey(line1: string | null | undefined): string | null {
  const w = words(String(line1 ?? '').split(',')[0]);
  if (w.length < 2 || !/^\d+[a-z]?$/.test(w[0]) || !/[a-z]/.test(w.slice(1).join(''))) return null;
  return w.join(' ');
}

/** Whether a subject names the street: the whole key, or the key without its suffix ("123 Main" for "123 Main St"). */
export function subjectNames(subject: string, street: string | null): boolean {
  if (!street) return false;
  const hay = ` ${words(subject).join(' ')} `;
  if (hay.includes(` ${street} `)) return true;
  const parts = street.split(' ');
  const last = parts[parts.length - 1];
  return parts.length >= 3 && Object.values(SUFFIX).includes(last) && hay.includes(` ${parts.slice(0, -1).join(' ')} `);
}

/**
 * The deal a text names by street: the one deal, or, when several deals share
 * that one street (duplicates of one house), the one furthest along. None when
 * it names zero streets or two different ones.
 */
function oneNamed(pool: DealRef[], text: string): DealRef | null {
  if (!text) return null;
  const named = pool.filter((d) => subjectNames(text, d.street));
  if (named.length <= 1) return named[0] ?? null;
  if (new Set(named.map((d) => d.street)).size > 1) return null;
  // Stable: equal ranks keep the pool's order, newest first as loaded.
  return named.reduce((best, d) => ((d.rank ?? 1) > (best.rank ?? 1) ? d : best));
}

/**
 * The route for one message from its own addresses, subject and body.
 * `bulk` (List-Unsubscribe / Precedence: bulk) stops a street alone from
 * filing a listing alert about the property onto the deal. `body` is the
 * plain text or Gmail's snippet; a deal is taken from it only when it names
 * exactly one. `files` is the attachments' names ("1206 Harbor Blvd - AB
 * Contract.pdf"): a street named there is as good as one in the subject.
 */
export function routeFor(book: Book, addresses: string[], subject: string, bulk = false, body = '', files = ''): Route {
  const theirs = addresses.map(addrKey).filter((a) => a && !book.ours.has(a));
  const pick = (m: Map<string, number>) => theirs.map((a) => m.get(a)).find((x) => x != null) ?? null;
  const link: Link = { ...emptyLink(), seller_id: pick(book.sellers), buyer_id: pick(book.buyers), vendor_id: pick(book.vendors) };

  const sellerDeals = link.seller_id != null ? book.dealsBySeller.get(link.seller_id) ?? [] : [];
  const others: DealRef[] = [];
  const add = (d: DealRef | undefined) => { if (d && !others.some((o) => o.id === d.id) && !sellerDeals.some((o) => o.id === d.id)) others.push(d); };
  if (link.buyer_id != null) for (const d of book.dealsByBuyer.get(link.buyer_id) ?? []) add(d);
  if (link.vendor_id != null) for (const d of book.dealsByVendor.get(link.vendor_id) ?? []) add(d);
  for (const a of theirs) for (const id of book.parties.get(a) ?? []) add(book.deals.get(id));

  const known = [...sellerDeals, ...others];
  const text = String(body ?? '').slice(0, 20_000);
  // Bulk mail never files on a street alone, so the workspace-wide lookup is skipped.
  const anywhere = (hay: string) => (bulk || !hay ? null : oneNamed(dealsForText(book, hay), hay));
  let why: Why = null;
  let deal: DealRef | null = null;
  const byStreet = oneNamed(known, subject) ?? anywhere(subject) ?? oneNamed(known, files) ?? anywhere(files) ?? oneNamed(known, text);
  if (byStreet) { deal = byStreet; why = 'street'; }
  else if (sellerDeals.length) { deal = sellerDeals[0]; why = 'person'; }
  else if (others.length === 1) { deal = others[0]; why = 'person'; }
  else {
    const inBody = anywhere(text);
    if (inBody) { deal = inBody; why = 'street'; }
  }
  if (deal) {
    link.deal_id = deal.id;
    link.property_id = deal.property_id;
    // A deal found by a street when no one matched brings its seller.
    if (link.seller_id == null && link.buyer_id == null && link.vendor_id == null && deal.seller_id != null && !known.length) link.seller_id = deal.seller_id;
  }
  return { link, why, candidates: deal || known.length < 2 ? [] : known };
}

/** The link for one message; see routeFor for the rules and for why a deal was picked. */
export function linkFor(book: Book, addresses: string[], subject: string, bulk = false, body = '', files = ''): Link {
  return routeFor(book, addresses, subject, bulk, body, files).link;
}

/** Re: / Fwd: / AW: stripped and case folded, the way a reader sees a thread's subject. */
export const baseSubject = (s: string | null | undefined) => String(s ?? '').replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '').trim().toLowerCase();

/**
 * A conversation as a reader sees it: the other party and the subject. Two
 * messages with the same key are one thread even when Gmail split them or
 * the reply dropped its References header. Null when there is no outside
 * party or the subject is too generic to join on.
 */
export function conversationKey(book: Pick<Book, 'ours'>, from: string, to: string[], subject: string): string | null {
  const base = baseSubject(subject);
  if (base.length < 4 || /^(hi|hello|hey|question|update|follow ?up|checking in|\(no subject\))$/.test(base)) return null;
  const f = addrKey(from);
  const other = f && !book.ours.has(f) ? f : to.map(addrKey).find((a) => a && !book.ours.has(a));
  return other ? `${other}|${base}` : null;
}

/**
 * Whether a row the rules or the AI already filed should move to `found`.
 * Only a named street moves it, and only onto another live deal; a row a
 * person filed ('manual') never moves, and a row filed on a deal that no
 * longer exists is treated as unfiled.
 */
export function reroute(book: Book, stored: { deal_id: number | null; routed_by?: string | null }, found: Route): boolean {
  if (stored.routed_by === 'manual') return false;
  if (found.link.deal_id == null || found.link.deal_id === stored.deal_id) return false;
  if (stored.deal_id == null || !book.deals.has(stored.deal_id)) return true;
  return found.why === 'street' && stored.routed_by != null;
}

/** The AI fallback's answer, kept only when it names one of the candidates. */
export function pickFromAi(raw: unknown, candidates: DealRef[]): number | null {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  const id = Number((v as { deal_id?: unknown } | null)?.deal_id);
  return Number.isInteger(id) && candidates.some((c) => c.id === id) ? id : null;
}

/** What `own` matched, with the gaps filled from `from` (the thread's link). A message's own match always wins. */
export function mergeLink(own: Link, from: Link | null | undefined): Link {
  if (!from) return own;
  const out = { ...own };
  for (const k of Object.keys(out) as (keyof Link)[]) if (out[k] == null && from[k] != null) out[k] = from[k];
  // property_id travels with the deal it came from, never on its own.
  if (own.deal_id != null) out.property_id = own.property_id;
  return out;
}

/** The link a thread lends its unmatched messages: the first matched message's, deal filled from any message that has one. */
export function threadLink(links: Link[]): Link | null {
  const matched = links.filter(isLinked);
  if (!matched.length) return null;
  const withDeal = matched.find((l) => l.deal_id != null);
  const base = { ...matched[0] };
  if (base.deal_id == null && withDeal) { base.deal_id = withDeal.deal_id; base.property_id = withDeal.property_id; }
  return base;
}

/**
 * Which rep this message belongs to. Outbound mail (From is ours) credits the
 * address it was sent from. Inbound mail credits the first To/Cc address that
 * is one of ours, so a reply to morgan3@ or to Morgan's real inbox files on
 * Morgan and not on the buyer.
 */
export function repFor(book: Book, from: string, to: string[]): string | null {
  const reps = book.reps;
  if (!reps?.size) return null;
  const fromKey = addrKey(from);
  if (fromKey && book.ours.has(fromKey)) return reps.get(fromKey) ?? null;
  for (const raw of to) {
    const key = addrKey(raw);
    if (key && reps.has(key)) return reps.get(key) ?? null;
  }
  return null;
}

/** Only the fields that would change a stored row: nulls there, values here. Empty when nothing new was learned. */
export function fillable(stored: Partial<Link>, found: Link): Partial<Link> {
  const out: Partial<Link> = {};
  for (const k of ['seller_id', 'buyer_id', 'vendor_id', 'deal_id'] as const) if (stored[k] == null && found[k] != null) out[k] = found[k];
  if (out.deal_id != null && stored.property_id == null && found.property_id != null) out.property_id = found.property_id;
  return out;
}
