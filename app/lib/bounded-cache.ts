// Module caches that live as long as the tab. A plain Map only grows: a rep
// who searches, pages and opens threads all day held every answer until
// Chrome ran out of memory ("Aw, Snap", 2026-10-19). These keep the most
// recently written `max` entries; Map order is insertion order, so a key
// written again moves to the back and the front is the oldest.

/** Set `key`, then drop the oldest entries past `max`. */
export function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
