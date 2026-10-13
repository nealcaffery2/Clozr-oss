// Keyset ("seek") paging for PostgREST reads.
//
// An OFFSET page makes Postgres walk, and build, every row before it: page 14
// of the sellers read built all 14,000 rows (properties embed included) to
// return the last 1,000, about 1 s a page and quadratic in the table. A
// keyset page starts after the previous page's last row instead, so every
// page costs the same ~40 ms.
//
// Pure, so it is testable without a database (tools/keyset.test.ts).

/**
 * One column of the read's ORDER BY, in order. The last one must be unique
 * and never null (`id`). Only the first may be `nullable`: its null rows are
 * read as their own run (keysetPhases), where Postgres puts them (`nullsFirst`,
 * default Postgres's own: first for a descending column, last for ascending).
 */
export type KeyCol = { col: string; asc: boolean; nullable?: boolean; nullsFirst?: boolean };

/** The filters that resume a read after `last`: a plain bound the index can use, and the exact tie-break. */
export type KeysetFilter = {
  /** `col op value` on the leading key; for one key this is the whole condition. */
  bound: { col: string; op: 'gt' | 'lt' | 'gte' | 'lte'; value: string };
  /** For two or more keys, a PostgREST `or=(…)` body that settles ties on the leading key. */
  or: string | null;
};

/** A value quoted for a PostgREST logic tree (`,` `:` `+` `(` are reserved there). */
export function quoteValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Where the next page starts, after the row `last`. Null when a key is
 * missing on that row, which keysetPhases keeps from happening for a
 * nullable leading key; an empty string is a value like any other.
 */
export function keysetAfter(keys: KeyCol[], last: Record<string, unknown> | null | undefined): KeysetFilter | null {
  if (!keys.length || !last) return null;
  const values: string[] = [];
  for (const k of keys) {
    const v = last[k.col];
    if (v === null || v === undefined) return null;
    values.push(String(v));
  }
  const [first] = keys;
  if (keys.length === 1) return { bound: { col: first.col, op: first.asc ? 'gt' : 'lt', value: values[0] }, or: null };
  // (k1 > v1) or (k1 = v1 and k2 > v2) or (k1 = v1 and k2 = v2 and k3 > v3) …
  const branches = keys.map((k, i) => {
    const eqs = keys.slice(0, i).map((e, j) => `${e.col}.eq.${quoteValue(values[j])}`);
    const step = `${k.col}.${k.asc ? 'gt' : 'lt'}.${quoteValue(values[i])}`;
    return eqs.length ? `and(${[...eqs, step].join(',')})` : step;
  });
  return { bound: { col: first.col, op: first.asc ? 'gte' : 'lte', value: values[0] }, or: branches.join(',') };
}

/**
 * One run of a keyset read. A nullable leading key splits the read in two:
 * the rows where it is set, paged on every key, and the rows where it is null,
 * paged on the keys after it (they all tie on the null). Each run is a plain
 * keyset read, so a buyer with no name no longer sends the rest of the list
 * back to OFFSET pages.
 */
export type KeysetPhase = { nulls: { col: string; only: boolean } | null; keys: KeyCol[] };
export function keysetPhases(keys: KeyCol[]): KeysetPhase[] {
  const [lead, ...rest] = keys;
  if (!lead?.nullable || !rest.length) return [{ nulls: null, keys }];
  const set: KeysetPhase = { nulls: { col: lead.col, only: false }, keys };
  const unset: KeysetPhase = { nulls: { col: lead.col, only: true }, keys: rest };
  return (lead.nullsFirst ?? !lead.asc) ? [unset, set] : [set, unset];
}

export type Page = { data: unknown[] | null; error: { message: string } | null; status?: number };
/** The filter methods a keyset page adds to a read before its range. */
export type Seekable<T> = {
  range: (from: number, to: number) => PromiseLike<T>;
  gt: (col: string, v: string) => Seekable<T>;
  lt: (col: string, v: string) => Seekable<T>;
  gte: (col: string, v: string) => Seekable<T>;
  lte: (col: string, v: string) => Seekable<T>;
  or: (filters: string) => Seekable<T>;
  is: (col: string, v: null) => Seekable<T>;
  not: (col: string, op: string, v: null) => Seekable<T>;
};

/**
 * Every row of a read, keyset page after keyset page. `make` builds the read
 * with its ORDER BY (which `keys` restates); `fetchPage` runs one page and is
 * where the caller's retries and connection cap live. A row with a key
 * missing (a misdeclared key) reads the rest of its run by OFFSET, which the
 * same order keeps exact.
 */
export async function keysetRead<T extends Page>(
  make: () => { range: (from: number, to: number) => PromiseLike<T> },
  keys: KeyCol[],
  opts: { pageSize: number; cap?: number; fetchPage: (page: () => PromiseLike<T>) => Promise<T> },
): Promise<T> {
  const { pageSize, fetchPage } = opts;
  const cap = opts.cap ?? Number.POSITIVE_INFINITY;
  const rows: unknown[] = [];
  let last: T | null = null;
  for (const phase of keysetPhases(keys)) {
    const base = () => {
      let q = make() as unknown as Seekable<T>;
      if (phase.nulls) q = phase.nulls.only ? q.is(phase.nulls.col, null) : q.not(phase.nulls.col, 'is', null);
      return q;
    };
    let got = 0;
    for (;;) {
      const tail = got ? rows[rows.length - 1] as Record<string, unknown> : null;
      const seek = tail ? keysetAfter(phase.keys, tail) : null;
      const from = got;
      const r: T = tail && !seek
        ? await fetchPage(() => base().range(from, from + pageSize - 1))
        : await fetchPage(() => {
          let q = base();
          if (seek) {
            q = q[seek.bound.op](seek.bound.col, seek.bound.value);
            if (seek.or) q = q.or(seek.or);
          }
          return q.range(0, pageSize - 1);
        });
      if (r.error) return r;
      last = r;
      const page = r.data ?? [];
      rows.push(...page);
      got += page.length;
      if (rows.length >= cap) return { ...r, data: rows.slice(0, cap) };
      if (page.length < pageSize) break;
    }
  }
  return { ...(last as T), data: rows };
}
