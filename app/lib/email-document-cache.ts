// HTML fetched from Gmail for a stored email, keyed by communication id.
// A workspace switch drops it: the next open asks again for the workspace
// that is on screen, and a row from the previous one cannot be reused.

const cache = new Map<number, string | null>();

/** The stored HTML, or undefined when this id has not been fetched. */
export function cachedEmailHtml(id: number): string | null | undefined {
  return cache.has(id) ? (cache.get(id) ?? null) : undefined;
}

export function storeEmailHtml(id: number, html: string | null): void {
  cache.set(id, html);
}

export function emailHtmlCached(id: number): boolean {
  return cache.has(id);
}

export function clearEmailHtmlCache(): void {
  cache.clear();
}
