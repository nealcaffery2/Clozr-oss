// Every page of a PostgREST read. A bare select, and any .limit() over the
// project's max-rows, stops at 1,000 rows: a cap counted from such a read is
// low once the day is busy, and a "read everything" read quietly leaves the
// rest out. `make` builds the query fresh each page (a builder is one-shot).
export async function everyRow<T>(
  make: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> },
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await make().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return out;
  }
}

/**
 * everyRow as the `{ data, error }` a builder resolves to, so a paged read sits
 * beside bare ones in a Promise.all and the caller's own error check stays.
 */
export async function everyRowResult<T>(
  make: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> },
  pageSize = 1000,
): Promise<{ data: T[] | null; error: { message: string } | null }> {
  try {
    return { data: await everyRow<T>(make, pageSize), error: null };
  } catch (e) {
    return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
  }
}
