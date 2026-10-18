// A small worker pool, and the lanes that keep one person's turns in order
// inside it. Pure, so tools/tick-pool.test.ts runs it under tsx.

/** Run `fn` over `items`, at most `n` at a time. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

/**
 * Items that share any key (a phone, an email, the record) in one lane, so a
 * pool works them one after another in their original order. Lanes come out in
 * the order of their first item.
 */
export function lanes<T>(items: T[], keysOf: (t: T) => string[]): T[][] {
  const parent = items.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  const first = new Map<string, number>();
  items.forEach((t, i) => {
    for (const k of keysOf(t)) {
      const j = first.get(k);
      if (j === undefined) first.set(k, i);
      else parent[root(i)] = root(j);
    }
  });
  const byRoot = new Map<number, T[]>();
  items.forEach((t, i) => {
    const r = root(i);
    const lane = byRoot.get(r);
    if (lane) lane.push(t); else byRoot.set(r, [t]);
  });
  return [...byRoot.values()];
}
