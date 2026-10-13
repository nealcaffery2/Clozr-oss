import { keysetAfter, quoteValue } from '../lib/keyset';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

eq('one key ascending', keysetAfter([{ col: 'id', asc: true }], { id: 42 }), {
  bound: { col: 'id', op: 'gt', value: '42' }, or: null,
});

eq('one key descending', keysetAfter([{ col: 'item_id', asc: false }], { item_id: 9 }), {
  bound: { col: 'item_id', op: 'lt', value: '9' }, or: null,
});

eq('two keys: created_at desc, id desc', keysetAfter(
  [{ col: 'created_at', asc: false }, { col: 'id', asc: false }],
  { created_at: '2026-02-12T17:49:45+00:00', id: 13854 },
), {
  bound: { col: 'created_at', op: 'lte', value: '2026-02-12T17:49:45+00:00' },
  or: 'created_at.lt."2026-02-12T17:49:45+00:00",and(created_at.eq."2026-02-12T17:49:45+00:00",id.lt."13854")',
});

eq('three keys, mixed directions', keysetAfter(
  [{ col: 'a', asc: true }, { col: 'b', asc: false }, { col: 'id', asc: true }],
  { a: 1, b: 2, id: 3 },
)?.or, 'a.gt."1",and(a.eq."1",b.lt."2"),and(a.eq."1",b.eq."2",id.gt."3")');

eq('a missing key falls back', keysetAfter([{ col: 'created_at', asc: false }, { col: 'id', asc: false }], { id: 5 }), null);
eq('a null key falls back', keysetAfter([{ col: 'id', asc: true }], { id: null }), null);
eq('no row, no filter', keysetAfter([{ col: 'id', asc: true }], null), null);

eq('quotes and backslashes are escaped', quoteValue('a"b\\c'), '"a\\"b\\\\c"');

// ── keysetRead against an in-memory table ──────────────────────────────────
// The fake builder evaluates the same PostgREST filters a page sends, so the
// paging (null runs, ties, page boundaries, the cap) is checked end to end.
import { keysetPhases, keysetRead, type KeyCol, type Page } from '../lib/keyset';

type Row = Record<string, string | number | null>;
const cmp = (a: unknown, b: unknown) => {
  const na = Number(a), nb = Number(b);
  if (typeof a === 'number' || (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb) && typeof b !== 'string')) return na - nb;
  if (typeof a === 'number') return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};
/** Split a PostgREST logic body at top-level commas, keeping quoted values whole. */
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i]; } else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v);
function evalCond(row: Row, cond: string): boolean {
  if (cond.startsWith('and(')) return splitTop(cond.slice(4, -1)).every((c) => evalCond(row, c));
  const [col, op, ...rest] = cond.split('.');
  const v = unquote(rest.join('.'));
  return test(row[col], op, v);
}
function test(have: unknown, op: string, v: unknown): boolean {
  if (have === null || have === undefined) return false; // SQL: a comparison with null is not true
  const asNum = typeof have === 'number' ? Number(v) : v;
  const d = cmp(have, asNum);
  return op === 'eq' ? d === 0 : op === 'gt' ? d > 0 : op === 'lt' ? d < 0 : op === 'gte' ? d >= 0 : d <= 0;
}
function fakeRead(table: Row[], order: KeyCol[], log: string[]) {
  return () => {
    const filters: ((r: Row) => boolean)[] = [];
    const q = {
      gt: (c: string, v: string) => { filters.push((r) => test(r[c], 'gt', v)); return q; },
      lt: (c: string, v: string) => { filters.push((r) => test(r[c], 'lt', v)); return q; },
      gte: (c: string, v: string) => { filters.push((r) => test(r[c], 'gte', v)); return q; },
      lte: (c: string, v: string) => { filters.push((r) => test(r[c], 'lte', v)); return q; },
      or: (body: string) => { filters.push((r) => splitTop(body).some((c) => evalCond(r, c))); return q; },
      is: (c: string) => { filters.push((r) => r[c] === null); return q; },
      not: (c: string) => { filters.push((r) => r[c] !== null); return q; },
      range: (from: number, to: number): PromiseLike<Page> => {
        log.push(`range ${from}-${to}`);
        const sorted = table.filter((r) => filters.every((f) => f(r))).sort((a, b) => {
          for (const k of order) {
            const av = a[k.col], bv = b[k.col];
            if (av === null || bv === null) {
              if (av === bv) continue;
              const nullsFirst = k.nullsFirst ?? !k.asc;
              return (av === null) === nullsFirst ? -1 : 1;
            }
            const d = cmp(av, bv);
            if (d) return k.asc ? d : -d;
          }
          return 0;
        });
        return Promise.resolve({ data: sorted.slice(from, to + 1), error: null });
      },
    };
    return q;
  };
}
const direct = <T,>(page: () => PromiseLike<T>) => Promise.resolve(page());

async function run() {
  // 23 buyers, names with ties and nulls, ids out of name order.
  const names = ['Ann', 'Bob', null, 'Ann', 'Cy', '', 'Bob', null, 'Dee', 'Ann', 'Eve', null, 'Cy', 'Ann', 'Fay', 'Gus', null, 'Bob', 'Hal', 'Ivy', 'Ann', 'Jo', null];
  const table: Row[] = names.map((name, i) => ({ id: 100 + ((i * 7) % 23), name }));
  const keys: KeyCol[] = [{ col: 'name', asc: true, nullable: true }, { col: 'id', asc: true }];
  const want = await fakeRead(table, keys, [])().range(0, 999).then((r) => (r.data as Row[]).map((x) => x.id));

  for (const size of [1, 2, 3, 5, 6, 7, 18, 23, 24, 50]) {
    const log: string[] = [];
    const r = await keysetRead(fakeRead(table, keys, log), keys, { pageSize: size, fetchPage: direct });
    eq(`nullable name, page ${size}: every row once, in order`, (r.data as Row[]).map((x) => x.id), want);
    eq(`nullable name, page ${size}: never an OFFSET page`, log.every((l) => l.startsWith('range 0-')), true);
  }

  const capped = await keysetRead(fakeRead(table, keys, []), keys, { pageSize: 4, cap: 10, fetchPage: direct });
  eq('cap stops at the newest N', (capped.data as Row[]).map((x) => x.id), want.slice(0, 10));

  // Descending, nulls first (Postgres's default for desc).
  const desc: KeyCol[] = [{ col: 'name', asc: false, nullable: true }, { col: 'id', asc: false }];
  const wantDesc = await fakeRead(table, desc, [])().range(0, 999).then((r) => (r.data as Row[]).map((x) => x.id));
  const rd = await keysetRead(fakeRead(table, desc, []), desc, { pageSize: 3, fetchPage: direct });
  eq('descending nullable: nulls first, every row once', (rd.data as Row[]).map((x) => x.id), wantDesc);

  // By id alone, exactly a page long: one more (empty) page ends it.
  const ids: Row[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
  const log: string[] = [];
  const byId = await keysetRead(fakeRead(ids, [{ col: 'id', asc: true }], log), [{ col: 'id', asc: true }], { pageSize: 3, fetchPage: direct });
  eq('by id, exact multiple of the page', (byId.data as Row[]).map((x) => x.id), [1, 2, 3, 4, 5, 6]);
  eq('by id, exact multiple: three reads', log.length, 3);

  // An error on a later page is the answer, not a partial list.
  let n = 0;
  const failing = await keysetRead(fakeRead(ids, [{ col: 'id', asc: true }], []), [{ col: 'id', asc: true }], {
    pageSize: 2, fetchPage: (p) => (++n === 2 ? Promise.resolve({ data: null, error: { message: 'timeout' } }) : direct(p)),
  });
  eq('a failed page fails the read', failing.error?.message, 'timeout');

  eq('phases: nullable asc reads set rows first', keysetPhases(keys).map((p) => p.nulls), [{ col: 'name', only: false }, { col: 'name', only: true }]);
  eq('phases: plain keys are one run', keysetPhases([{ col: 'id', asc: true }]).length, 1);
  eq('an empty string is a value, not a missing key', keysetAfter([{ col: 'name', asc: true }, { col: 'id', asc: true }], { name: '', id: 3 })?.bound, { col: 'name', op: 'gte', value: '' });
}
void run();
