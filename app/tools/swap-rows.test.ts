// Field saves never leave zero fields (docs-plus template_fields_save, pdf-contracts saveDraftFields).
// Run: npx tsx tools/swap-rows.test.ts
import { swapRows, type SwapClient } from '../supabase/functions/_shared/swap-rows';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// An in-memory table: ids 1..n already there.
function table(n: number, opts: { failInsert?: boolean; failDeleteOf?: number } = {}) {
  const rows = new Map<number, Record<string, unknown>>();
  for (let i = 1; i <= n; i++) rows.set(i, { id: i, old: true });
  let next = n + 1;
  const deletes: number[][] = [];
  const client: SwapClient = {
    from: () => ({
      insert: (add) => ({
        select: async () => {
          if (opts.failInsert) return { data: null, error: { message: 'null value in column "role"' } };
          const made = add.map((r) => ({ ...r, id: next++ }));
          for (const r of made) rows.set(r.id, r);
          return { data: made.map((r) => ({ id: r.id })), error: null };
        },
      }),
      delete: () => ({
        in: async (_col, ids) => {
          deletes.push(ids);
          if (opts.failDeleteOf != null && ids.includes(opts.failDeleteOf)) return { error: { message: 'trigger refused' } };
          for (const id of ids) rows.delete(id);
          return { error: null };
        },
      }),
    }),
  };
  return { client, rows, deletes };
}

const fresh = (k: number) => Array.from({ length: k }, (_, i) => ({ sort: i }));

{
  const t = table(3);
  eq('swap succeeds', await swapRows(t.client, 'doc_template_fields', [1, 2, 3], fresh(2)), null);
  eq('only the new rows are left', [...t.rows.values()].map((r) => [r.id, !!r.old]), [[4, false], [5, false]]);
}
{
  const t = table(3, { failInsert: true });
  eq('a failed insert reports insert', await swapRows(t.client, 'doc_template_fields', [1, 2, 3], fresh(2)), { stage: 'insert', error: { message: 'null value in column "role"' } });
  eq('a failed insert keeps every old row', [...t.rows.keys()], [1, 2, 3]);
  eq('and deletes nothing', t.deletes.length, 0);
}
{
  const t = table(3, { failDeleteOf: 2 });
  eq('a failed delete reports delete', await swapRows(t.client, 'contract_fields', [1, 2, 3], fresh(2)), { stage: 'delete', error: { message: 'trigger refused' } });
  eq('a failed delete takes the new rows back out', [...t.rows.keys()], [1, 2, 3]);
}
{
  const t = table(450);
  const old = [...t.rows.keys()];
  eq('many old rows', await swapRows(t.client, 'doc_template_fields', old, fresh(1)), null);
  eq('deleted in chunks of 200', t.deletes.map((d) => d.length), [200, 200, 50]);
  eq('one row left', t.rows.size, 1);
}
{
  const t = table(2);
  eq('saving no fields clears them', await swapRows(t.client, 'doc_template_fields', [1, 2], []), null);
  eq('none left', t.rows.size, 0);
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
