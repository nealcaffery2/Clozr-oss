/**
 * Run `job` over `items`, `limit` at a time, as a rolling pool: a slot is
 * taken by the next item the moment its job ends, so one slow item never
 * holds the rest of a group. Results come back in the items' order. A job
 * that throws stops new jobs from starting (the ones already running finish)
 * and the call rejects with that error, as a group-by-group loop would stop
 * after the group that threw.
 */
export async function eachLimited<T, R>(items: readonly T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await job(items[i]!);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
