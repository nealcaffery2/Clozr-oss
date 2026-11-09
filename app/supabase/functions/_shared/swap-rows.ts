// Replace a set of rows (a template's or a draft's fields) without a window
// where there are none. The new rows go in first; only then are the old ids,
// read before the insert, deleted. A failed insert leaves the old rows as they
// were. A failed delete takes the new rows back out, so the set is never
// doubled, and reports the error.
//
// No Deno global here: tools/swap-rows.test.ts imports this file.

type Err = { message: string } | null;

/** The slice of the Supabase client this uses. */
export type SwapClient = {
  from: (table: string) => {
    insert: (rows: Record<string, unknown>[]) => { select: (cols: string) => PromiseLike<{ data: { id: number }[] | null; error: Err }> };
    delete: () => { in: (col: string, ids: number[]) => PromiseLike<{ error: Err }> };
  };
};

const CHUNK = 200;

async function deleteIds(admin: SwapClient, table: string, ids: number[]): Promise<Err> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error } = await admin.from(table).delete().in('id', ids.slice(i, i + CHUNK));
    if (error) return error;
  }
  return null;
}

/**
 * Insert `rows` into `table`, then delete `oldIds`. Returns where it failed
 * (`insert` or `delete`) and the error, or null when the swap is done.
 */
export async function swapRows(
  admin: SwapClient, table: string, oldIds: number[], rows: Record<string, unknown>[],
): Promise<{ stage: 'insert' | 'delete'; error: { message: string } } | null> {
  let added: number[] = [];
  if (rows.length) {
    const { data, error } = await admin.from(table).insert(rows).select('id');
    if (error) return { stage: 'insert', error };
    added = (data ?? []).map((r) => r.id);
  }
  const delErr = await deleteIds(admin, table, oldIds);
  if (delErr) {
    await deleteIds(admin, table, added);
    return { stage: 'delete', error: delErr };
  }
  return null;
}
