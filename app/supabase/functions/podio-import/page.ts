/**
 * podio-import's page reads: the pure half.
 *
 * A Podio deal used to read its own sellers and buyers (four queries a
 * table), roster, property and import line, one item at a time. A page now
 * reads each key once (.in()) and keeps what it read; every row the page
 * writes goes back in, so a later item on the page gets the answer a fresh
 * read would have given (the seller the first item made, the email it filled
 * in). The reads themselves are the caller's (index.ts); nothing here touches
 * the network.
 *
 * Also the Communications guard: the rows a page would write exactly as they
 * already are, so the ten-minute sync stops rewriting them.
 */
import { nameKey, phoneKey, type PodioPerson } from '../_shared/podio-map.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

/** matchParties' four lookups per table, in the order it merges their answers. */
export const KINDS = ['source_id', 'phone_key', 'email', 'name'] as const;
export type Kind = (typeof KINDS)[number];
export type Keys = Record<Kind, string[]>;
type KeyParty = { source_id?: string | null; phone?: string | null; email?: string | null; name?: string | null; company?: string | null };

/** One table's rows (sellers or buyers) as the page has read and written them. */
export type People = {
  rows: Map<number, Any>;
  /** The ids each lookup returned, in its order; rows the page wrote are appended to every list. */
  order: Record<Kind, number[]>;
  asked: Record<Kind, Set<string>>;
};

export const newPeople = (): People => ({
  rows: new Map(),
  order: { source_id: [], phone_key: [], email: [], name: [] },
  asked: { source_id: new Set(), phone_key: new Set(), email: new Set(), name: new Set() },
});

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

/** The keys matchParties looks these parties up by: Podio source ids, phone keys, lowercased emails, names and companies. */
export const partyKeys = (parties: KeyParty[]): Keys => ({
  source_id: uniq(parties.map((p) => p.source_id)),
  phone_key: uniq(parties.map((p) => phoneKey(p.phone))),
  email: uniq(parties.map((p) => p.email?.toLowerCase())),
  name: uniq(parties.flatMap((p) => [p.name, p.company])),
});

/** The keys the page has not read yet. */
export const unasked = (pool: People, keys: Keys): Keys =>
  Object.fromEntries(KINDS.map((k) => [k, keys[k].filter((v) => !pool.asked[k].has(v))])) as Keys;

/** PostgREST's max rows: an answer this long may be cut short. */
export const ROW_CAP = 1000;

/**
 * One lookup's answer: the keys it covered and its rows, in the order the
 * database returned them. An answer cut at ROW_CAP leaves its keys unread, so
 * each item asks for its own again, as it did before.
 */
export function absorb(pool: People, kind: Kind, asked: string[], rows: Any[]) {
  for (const r of rows) {
    pool.rows.set(r.id, r);
    if (!pool.order[kind].includes(r.id)) pool.order[kind].push(r.id);
  }
  if (rows.length < ROW_CAP) for (const v of asked) pool.asked[kind].add(v);
}

/** A row the page inserted or updated, as the database returned it. */
export function keep(pool: People, row: Any) {
  pool.rows.set(row.id, row);
  for (const k of KINDS) if (!pool.order[k].includes(row.id)) pool.order[k].push(row.id);
}

// The database's own tests: .eq('source','podio').in('source_id'), then .in() on the column (exact, case and all).
const hits = (kind: Kind, r: Any, keys: Keys) =>
  kind === 'source_id' ? r.source === 'podio' && keys.source_id.includes(r.source_id) : keys[kind].includes(r[kind]);

/** What matchParties' four queries for these keys return, merged the way it merges them: first answer first, each row once. */
export function candidates(pool: People, keys: Keys): Any[] {
  const out = new Map<number, Any>();
  for (const kind of KINDS) {
    for (const id of pool.order[kind]) {
      const r = pool.rows.get(id);
      if (r && !out.has(id) && hits(kind, r, keys)) out.set(id, r);
    }
  }
  return [...out.values()];
}

/** matchParties' rule: the Podio source id, else the phone, else the email, else a name exactly one row carries. */
export function findRow(list: Any[], p: PodioPerson, nameCols: string[], phoneOf: (r: Any) => string | null) {
  const pk = phoneKey(p.phone); const em = p.email?.toLowerCase(); const nk = nameKey(p.name); const ck = nameKey(p.company);
  return list.find((r) => r.source === 'podio' && r.source_id === p.source_id)
    ?? (pk && list.find((r) => phoneOf(r) === pk))
    ?? (em && list.find((r) => r.email?.toLowerCase() === em))
    // A name alone only counts when exactly one row carries it: "John Smith" is not an identity.
    ?? ((hits) => (hits.length === 1 ? hits[0] : undefined))(list.filter((r) => nameCols.some((c) => r[c] && ((nk && nameKey(r[c]) === nk) || (ck && nameKey(r[c]) === ck)))));
}

/** The address_key() arguments, as the key of the page's cache. */
export const addrSig = (a: { line1: string; city?: string | null; state?: string | null; zip?: string | null }) =>
  JSON.stringify([a.line1, a.city ?? '', a.state ?? '', a.zip ?? '']);

// ---- Communications --------------------------------------------------------------

/** The communications columns syncComms writes; the stored copy is read with the same list. */
export const COMM_COLS = 'workspace_id,source,source_id,channel,direction,occurred_at,from_phone,to_phone,body,summary,transcript,duration_s,recording_url,status,recording_id,seller_id,buyer_id,rep_id';
const DAY_MS = 24 * 60 * 60 * 1000;
const MARGIN_MS = 15 * 60 * 1000;

const same = (k: string, a: unknown, b: unknown) =>
  (a ?? null) === (b ?? null) || (k === 'occurred_at' && a != null && b != null && Date.parse(String(a)) === Date.parse(String(b)));

/**
 * The source_ids of rows the upsert would leave exactly as stored, so it can
 * skip them. The upsert's own triggers count: communications_rep_from_line
 * puts the line's owner on a row that names no rep (rep_phone_numbers, one
 * owner per number), and rvm_link_inbound may still file an inbound row less
 * than a day old on a ringless drop, so those always go through as before.
 */
export function unchangedComms(rows: Any[], stored: Any[], lineOwner: Map<string, string>, now: number): Set<string> {
  const have = new Map(stored.map((r) => [String(r.source_id), r]));
  const out = new Set<string>();
  for (const row of rows) {
    const cur = have.get(String(row.source_id));
    if (!cur) continue;
    if (row.direction === 'inbound' && !(Date.parse(row.occurred_at) < now - DAY_MS - MARGIN_MS)) continue;
    const ours = phoneKey(row.direction === 'inbound' ? row.to_phone : row.from_phone);
    const want = { ...row, rep_id: row.rep_id ?? (ours ? lineOwner.get(ours) ?? null : null) };
    if (Object.entries(want).every(([k, v]) => same(k, v, cur[k]))) out.add(String(row.source_id));
  }
  return out;
}
