// A reload reads only what changed in the big tables.
//
// Every save used to re-read the whole workspace: 13,000 sellers and 12,000
// buyers, ~38 MB, about 1,300 times a day across the team. A reload now asks
// for the table's ids (to see deletes and archives) and the rows whose
// updated_at moved since the last read (sellers, buyers and vendors keep it
// with a trigger), and reuses the rest.

type Row = { id: number; updated_at?: string | null };

export type RowCache<T extends Row> = {
  ws: number;
  /** When the full read landed; past DELTA_MAX_AGE_MS a reload reads everything again. */
  at: number;
  /** The newest updated_at the cache has seen (server time, so no clock skew). */
  cursor: string | null;
  rows: Map<number, T>;
};

/** A full read at least this often, as a backstop for anything the delta cannot see. */
export const DELTA_MAX_AGE_MS = 10 * 60_000;
/** Read back this far before the cursor: a transaction that started earlier commits later. */
export const DELTA_OVERLAP_MS = 2 * 60_000;

export function newestStamp(rows: Iterable<Row>, start: string | null = null): string | null {
  let max = start;
  for (const r of rows) if (r.updated_at && (!max || r.updated_at > max)) max = r.updated_at;
  return max;
}

/** The delta's lower bound: the cursor less the overlap. */
export function sinceOf(cursor: string | null): string | null {
  if (!cursor) return null;
  const t = Date.parse(cursor);
  return Number.isFinite(t) ? new Date(t - DELTA_OVERLAP_MS).toISOString() : null;
}

/**
 * The table as it stands: the cached rows still in `ids`, each replaced by its
 * changed copy when there is one. `missing` lists ids the cache never had and
 * the delta did not return; the caller reads those by id.
 */
export function mergeDelta<T extends Row>(cache: Map<number, T>, ids: Iterable<number>, changed: T[]): { rows: Map<number, T>; missing: number[] } {
  const fresh = new Map(changed.map((r) => [r.id, r] as const));
  const rows = new Map<number, T>();
  const missing: number[] = [];
  for (const id of ids) {
    const r = fresh.get(id) ?? cache.get(id);
    if (r) rows.set(id, r);
    else missing.push(id);
  }
  return { rows, missing };
}
