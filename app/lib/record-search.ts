// One search over people and buyers, the one the ⌘K command bar runs.
//
// The command bar, the dial box (desk and phone), and the People and Buyers
// search boxes all match a record the same way: each record has a name and a
// "find" string (everything a query can hit: phone, digits-only phone, email,
// address, city, ZIP, APN, source, tags), and lib/command.ts ranks them
// (exact name, starts-with, word start, anywhere; a word with digits also
// matches as bare digits, so "210-555" finds (210) 555-0136).
//
// Pure: no React, no I/O. tools/record-search.test.ts runs it.

import { matchTier, parseRecent, rankRecords, searchHay, tierFor } from './command';
import { visibleTags } from './secret-list';

type Field = string | null | undefined;
const join = (xs: Field[]) => xs.filter((x): x is string => !!x && x !== '—').join(' ');
const digitsOf = (s: Field) => (s ?? '').replace(/\D/g, '');

/** The parts of a seller the search reads. */
export type FindPerson = {
  name: string; phone: string; email: string; source: string; tags: string[]; market?: string;
  property: { addr: string; city: string; st: string; zip: string; apn?: string };
};
/** The parts of a buyer the search reads. */
export type FindBuyer = {
  name: string; company: string; phone: string; email: string; status: string; type?: string;
  buyerType?: string | null; source?: string | null; markets: string[]; tags?: string[];
};

/** Everything a query can match on a seller. */
export function personFind(p: FindPerson): string {
  const pr = p.property;
  return join([p.name, p.phone, digitsOf(p.phone), p.email, pr.addr, pr.city, pr.st, pr.zip, pr.apn, p.market, p.source, ...p.tags]);
}

/** Everything a query can match on a buyer; `extra` adds what the caller knows (the Buyers list's place labels). */
export function buyerFind(b: FindBuyer, extra: Field[] = []): string {
  return join([b.company, b.name, b.phone, digitsOf(b.phone), b.email, b.type, b.buyerType, b.status, b.source, ...b.markets, ...visibleTags(b.tags ?? []), ...extra]);
}

/** What a search reads of one record: its name, its find, and both lowercased once (`hay`) for speed. */
export type RecordKey = { name: string; find: string; hay: string };
export const recordKey = (name: string, find: string): RecordKey => ({ name, find, hay: searchHay(name, find) });

/** Built once per record object: a re-read row is a new object and gets a new key. */
const personCache = new WeakMap<object, RecordKey>();
const buyerCache = new WeakMap<object, RecordKey>();
export function cachedPersonKey(p: FindPerson): RecordKey {
  let k = personCache.get(p);
  if (k === undefined) { k = recordKey(p.name, personFind(p)); personCache.set(p, k); }
  return k;
}
export function cachedBuyerKey(b: FindBuyer): RecordKey {
  let k = buyerCache.get(b);
  if (k === undefined) { k = recordKey(b.name, buyerFind(b)); buyerCache.set(b, k); }
  return k;
}

/**
 * How well one record matches, for a list that keeps its own order inside a
 * rank: -1 no match, else 0 (the name exactly) to 3 (somewhere in the find).
 */
export function recordRank(q: string, name: string, find: string): number {
  const tier = matchTier(q, name, find);
  return tier ? 4 - tier : -1;
}

/** recordRank for many records against one query: the query is read once. */
export function recordRanker(q: string): (k: { name: string; find: string; hay?: string }) => number {
  const tierOf = tierFor(q);
  return (k) => {
    const tier = tierOf(k.name, k.find, k.hay);
    return tier ? 4 - tier : -1;
  };
}

/**
 * The records that match, best first; at a tie, the one opened last, then the
 * list's own order. A blank query matches nothing (the caller shows its list).
 */
export function searchRecords<T>(items: T[], q: string, key: (t: T) => { name: string; find: string; hay?: string; recent?: number }): T[] {
  if (!q.trim()) return [];
  return rankRecords(items, q, key);
}

/**
 * A list's search box: the rows that match, best first, rows of the same rank
 * in the list's own order. A blank query returns `rows` as they are.
 */
export function searchList<T>(rows: T[], q: string, key: (t: T) => { name: string; find: string; hay?: string }): T[] {
  if (!q.trim()) return rows;
  return rankRecords(rows, q, key);
}

/** The recents list as a lookup: 'person:s12' → its place (0 is the latest). */
export const recentIndex = (recentIds: string[]) => new Map(recentIds.map((k, i) => [k, i]));

/**
 * Who to offer before anything is typed, as the command bar's Recent group:
 * the records opened last, then whoever has the latest activity.
 */
export function recentRecords<P extends { id: string }, B extends { id: string }>(
  src: { recentIds: string[]; people: P[]; buyers: B[] },
  /** `activity`: larger is more recent; null for none. */
  opts: { limit: number; activity?: (p: P) => number | null | undefined; keep?: (r: { kind: 'person'; rec: P } | { kind: 'buyer'; rec: B }) => boolean },
): Array<{ kind: 'person'; rec: P } | { kind: 'buyer'; rec: B }> {
  type Hit = { kind: 'person'; rec: P } | { kind: 'buyer'; rec: B };
  const keep = opts.keep ?? (() => true);
  const out: Hit[] = [];
  const seen = new Set<string>();
  const push = (h: Hit) => {
    const k = h.kind + ':' + h.rec.id;
    if (seen.has(k) || !keep(h)) return;
    seen.add(k);
    out.push(h);
  };
  const personById = new Map<string, P>();
  const buyerById = new Map<string, B>();
  if (src.recentIds.length) {
    for (const p of src.people) personById.set(p.id, p);
    for (const b of src.buyers) buyerById.set(b.id, b);
  }
  for (const key of src.recentIds) {
    if (out.length >= opts.limit) return out;
    const r = parseRecent(key);
    if (r?.kind === 'person') { const p = personById.get(r.id); if (p) push({ kind: 'person', rec: p }); }
    else if (r?.kind === 'buyer') { const b = buyerById.get(r.id); if (b) push({ kind: 'buyer', rec: b }); }
  }
  if (opts.activity && out.length < opts.limit) {
    const act = opts.activity;
    // The latest few by activity, without sorting every record.
    const top: { p: P; t: number }[] = [];
    const room = opts.limit * 3;
    for (const p of src.people) {
      const t = act(p);
      if (t == null) continue;
      if (top.length < room) { top.push({ p, t }); top.sort((a, b) => b.t - a.t); continue; }
      if (t > top[top.length - 1]!.t) { top[top.length - 1] = { p, t }; top.sort((a, b) => b.t - a.t); }
    }
    for (const { p } of top) {
      if (out.length >= opts.limit) break;
      push({ kind: 'person', rec: p });
    }
  }
  return out;
}
