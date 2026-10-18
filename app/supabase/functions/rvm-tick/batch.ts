// What rvm-tick decides a drop on, read for a whole batch at once (one read
// per table instead of a read per drop), the caller line, the claim, and the
// small helpers around them. Apart from index.ts because that file starts a
// server on import, so tools/rvm-tick-batch.test.ts could not reach it.

import { reputationE164 } from '../../../lib/rvm.ts';
import { pickPoolLine, type PoolLine, type PoolTier } from '../../../lib/rvm-pool.ts';
import { loadRvmPerson, type RvmGateDb, type RvmPerson, type RvmPersonRow } from '../_shared/rvm-gate.ts';

/** A read that failed. The drop is held and looked at again, never sent on a guess. */
export class ReadFailed extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The rows, or a ReadFailed when the read failed. */
export function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new ReadFailed('check_failed', `could not check ${what}: ${res.error.message}`);
  return res.data;
}

type Res = { data: unknown; error: { message: string; code?: string } | null };
/** The few supabase-js calls made here, so a test can stand in for the client. */
export type Chain = PromiseLike<Res> & {
  select(columns: string): Chain;
  update(patch: Record<string, unknown>): Chain;
  in(column: string, values: readonly unknown[]): Chain;
  eq(column: string, value: unknown): Chain;
  or(filters: string): Chain;
  gte(column: string, value: unknown): Chain;
  order(column: string, options: { ascending: boolean }): Chain;
  limit(count: number): Chain;
};
export type GateDb = { from(table: string): Chain; rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res> };

export type GateDrop = { id: number; workspace_id: number; seller_id: number | null; buyer_id: number | null };
export type Prior = { library_id: number | null; status: string; sent_at: string | null };
/** The person's row as loadRvmPerson reads it, plus a buyer's opt-in for the consent check. */
export type GateRow = RvmPersonRow & { opted_in_at?: string | null };
export type Gate = {
  /** The shared blacklist and do-not-call verdict (rvm-gate.ts) over the row read for the batch. */
  person: Extract<RvmPerson, { ok: true }>;
  /** The workspace runs the Compr agent (migration 228), so a drop needs consent. */
  consentNeeded: boolean;
  /** Their dropped and answered drops in this workspace (grouped per recording and status, latest sent_at). */
  prior: Prior[];
  /** Their latest call of 20 s or more, in any workspace (as the per-drop read had it). */
  lastTalk: string | null;
};

/** loadRvmPerson's columns, so the batch read feeds it the same row. */
const SELLER_COLUMNS = 'phone, tags, properties(state, zip)';
const BUYER_COLUMNS = 'phone, tags, blacklisted_at, wants_calls, markets';

const uniq = <T>(xs: readonly (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x != null))];
const missingFn = (e: { message: string; code?: string }) => /PGRST202|could not find the function/i.test(`${e.code ?? ''} ${e.message}`);

type History = { prior: Prior[]; lastTalk: string | null };

/**
 * Earlier drops and the last call for each drop: rvm_gate_history (migration
 * 331), one row per drop however long the history, so no row cap applies.
 * Before the migration a batch is not read (each drop then reads its own) and
 * one drop reads as it always did: every earlier drop, and the latest call
 * with `limit(1)`.
 */
export async function readHistory(db: GateDb, drops: readonly GateDrop[]): Promise<Map<number, History>> {
  const res = await db.rpc('rvm_gate_history', { p_drop_ids: drops.map((d) => d.id) });
  if (!res.error) {
    const out = new Map<number, History>();
    for (const h of (res.data ?? []) as { id: number; last_talk: string | null; prior: Prior[] | null }[]) {
      out.set(Number(h.id), { prior: h.prior ?? [], lastTalk: h.last_talk ?? null });
    }
    for (const d of drops) if (!out.has(d.id)) throw new ReadFailed('check_failed', 'could not check their earlier drops and calls: the drop was not found');
    return out;
  }
  if (!missingFn(res.error)) throw new ReadFailed('check_failed', `could not check their earlier drops and calls: ${res.error.message}`);
  if (drops.length !== 1) throw new ReadFailed('check_failed', 'could not check a batch of earlier drops and calls: rvm_gate_history is not in the database yet');
  const d = drops[0]!;
  const [prior, talks] = await Promise.all([
    db.from('rvm_drops').select('library_id, status, sent_at').eq('workspace_id', d.workspace_id)
      .or(d.seller_id ? `seller_id.eq.${d.seller_id}` : `buyer_id.eq.${d.buyer_id}`).in('status', ['dropped', 'answered']),
    db.from('communications').select('occurred_at').eq(d.seller_id ? 'seller_id' : 'buyer_id', d.seller_id ?? d.buyer_id)
      .eq('channel', 'call').gte('duration_s', 20).order('occurred_at', { ascending: false }).limit(1),
  ]);
  const last = (must(talks, 'their last call') as { occurred_at: string }[] | null)?.[0]?.occurred_at ?? null;
  return new Map([[d.id, { prior: (must(prior, 'their earlier drops') ?? []) as Prior[], lastTalk: last }]]);
}

/**
 * Person rows, earlier drops, last calls and the consent flag for these drops:
 * one read each for sellers, buyers and history, where each drop used to read
 * its own. Throws ReadFailed when any read fails.
 */
export async function readGates(db: GateDb, drops: readonly GateDrop[], consentNeeded: (workspaceId: number) => Promise<boolean>): Promise<Map<number, Gate>> {
  const sellers = uniq(drops.map((d) => d.seller_id));
  const buyers = uniq(drops.filter((d) => !d.seller_id).map((d) => d.buyer_id));
  const workspaces = uniq(drops.map((d) => d.workspace_id));
  const none: Res = { data: [], error: null };
  const [sellerRes, buyerRes, history, flags] = await Promise.all([
    sellers.length ? db.from('sellers').select(`id, ${SELLER_COLUMNS}`).in('id', sellers) : none,
    buyers.length ? db.from('buyers').select(`id, ${BUYER_COLUMNS}, opted_in_at`).in('id', buyers) : none,
    readHistory(db, drops),
    Promise.all(workspaces.map((ws) => consentNeeded(ws))),
  ]);

  const rows = new Map<string, GateRow>();
  for (const r of (sellerRes.data ?? []) as (GateRow & { id: number })[]) rows.set(`s${r.id}`, r);
  for (const r of (buyerRes.data ?? []) as (GateRow & { id: number })[]) rows.set(`b${r.id}`, r);
  // loadRvmPerson over the rows just read, so its blacklist and do-not-call rule stays the one shared rule.
  const fromRows: RvmGateDb = {
    from: (table) => ({
      select: () => ({
        eq: (_column, id) => ({
          maybeSingle: async () => ({ data: rows.get(`${table === 'sellers' ? 's' : 'b'}${id}`) ?? null, error: (table === 'sellers' ? sellerRes : buyerRes).error }),
        }),
      }),
    }),
  };
  const out = new Map<number, Gate>();
  for (const d of drops) {
    const person = await loadRvmPerson(fromRows, d);
    if (!person.ok) throw new ReadFailed('blacklist_check_failed', person.message);
    const h = history.get(d.id)!;
    out.set(d.id, { person, consentNeeded: flags[workspaces.indexOf(d.workspace_id)]!, prior: h.prior, lastTalk: h.lastTalk });
  }
  return out;
}

/** What their earlier drops say: the recordings they heard and when, the last drop, the last answered call. */
export function historyFacts(history: readonly Prior[]) {
  const heardAt: Record<string, string> = {};
  for (const p of history) {
    if (p.status !== 'dropped' || !p.library_id || !p.sent_at) continue;
    const id = String(p.library_id);
    if (!heardAt[id] || p.sent_at > heardAt[id]) heardAt[id] = p.sent_at;
  }
  const heard = history.filter((p) => p.status === 'dropped' && p.library_id).map((p) => String(p.library_id));
  const lastDrop = history.filter((p) => p.status === 'dropped').map((p) => p.sent_at).filter(Boolean).sort().at(-1) ?? null;
  const lastAnswered = history.filter((p) => p.status === 'answered').map((p) => p.sent_at).filter(Boolean).sort().at(-1) ?? null;
  return { heard, heardAt, lastDrop, lastAnswered };
}

export type CallerPool = {
  /** Every caller line, for the pre-pool rotation (7-day least used, area code first). */
  lines: string[]; counts: Record<string, number>; seq: number;
  /** caller_lines.pool = 'rvm' lines with today's cap. Empty means no pool is set up. */
  rvm: PoolLine[]; usedToday: Record<string, number>;
};
export type TakenLine = { from: string | null; full: boolean; noLine?: boolean; tier?: PoolTier | null; release?: () => void };

/**
 * Caller ID for this drop from the tick's pool, counted forward so a batch
 * spreads out and six workers never pass a line's warm-up cap together.
 * `release` gives the count back: rvm-tick calls it when the drop is not
 * claimed after all (held on a failed read, lost to another run, left ready),
 * so a drop that never went out does not fill a line for the rest of the tick.
 */
export function takeLine(pool: CallerPool, dest: string | null, state: string | null): TakenLine {
  const seq = pool.seq++;
  if (pool.rvm.length) {
    const pick = pickPoolLine(pool.rvm, { state, phone: dest }, pool.usedToday, seq);
    if (pick.ok) {
      const line = pick.e164;
      pool.usedToday[line] = (pool.usedToday[line] ?? 0) + 1;
      return { from: line, full: false, tier: pick.tier, release: () => { pool.usedToday[line] = (pool.usedToday[line] ?? 1) - 1; } };
    }
    if (pick.reason === 'pool_full') return { from: null, full: true };
    // Every pool line paused, flagged or retired. This used to fall back to
    // the main caller lines, which put ringless drops (and their spam
    // reports) on the lines reps call from. The drop waits for the pool:
    // rvm-pool rotates a replacement in, or an admin fixes a line.
    return { from: null, full: false, noLine: true };
  }
  const line = reputationE164(pool.lines, pool.counts, dest, seq);
  if (!line) return { from: null, full: false };
  pool.counts[line] = (pool.counts[line] ?? 0) + 1;
  return { from: line, full: false, release: () => { pool.counts[line] = (pool.counts[line] ?? 1) - 1; } };
}

/**
 * The claim: queued to sending in one conditional update that returns the row.
 * Only the run that gets the row back may send it; a batch read never stands in for this.
 */
export async function claimQueued(db: GateDb, id: number, patch: Record<string, unknown>): Promise<boolean> {
  let claimed = await db.from('rvm_drops').update(patch).eq('id', id).eq('status', 'queued').select('id');
  // Before migration 198 there is no pool_tier: claim without it rather than lose the drop.
  if (claimed.error && /pool_tier/.test(claimed.error.message)) {
    delete patch.pool_tier;
    claimed = await db.from('rvm_drops').update(patch).eq('id', id).eq('status', 'queued').select('id');
  }
  return Array.isArray(claimed.data) && claimed.data.length > 0;
}

/** One load per key for this tick, shared by the workers. A failed load is forgotten, so the next drop asks again. */
export function once<T>(cache: Map<string, Promise<unknown>>, key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key) as Promise<T> | undefined;
  if (!hit) {
    const p = load();
    hit = p;
    cache.set(key, p);
    p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
  }
  return hit;
}

/** Recording links are signed for an hour, like each drop's own link was. */
export const SIGNED_URL_SECONDS = 3600;
/** A link made earlier in the tick is reused only with 55 minutes left, so a carrier fetching the audio late still gets it. */
export const signedUrlUsable = (s: { expiresAt: number }, now = Date.now()) => s.expiresAt - now >= 55 * 60_000;

/** Talkr's failure notes: one update per distinct note instead of one per drop. */
export function notesByText(results: readonly { ref: string; ok: boolean; note: string | null }[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of results) {
    if (r.ok || !r.note) continue;
    const id = Number(r.ref.replace(/^rvm:/, ''));
    if (!Number.isFinite(id)) continue;
    const note = r.note.slice(0, 300);
    out.set(note, [...(out.get(note) ?? []), id]);
  }
  return out;
}
