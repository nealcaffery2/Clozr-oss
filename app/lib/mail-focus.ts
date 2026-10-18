// When the browser asks Google for new mail on its own: the inbox or an open
// record coming back into view. The server reads new mail every minute
// anyway (migration 273); this covers the minute before that tick, and the
// throttle keeps tab switching from turning into a request per switch.

/** At most one focus-triggered mail check per workspace per this long. The server's fast-lane lock is 55s. */
export const MAIL_ON_FOCUS_MS = 60_000;

/** True when `key` was not asked for in the last `every` ms, and marks it asked now. */
export function dueNow<K>(asked: Map<K, number>, key: K, now: number, every = MAIL_ON_FOCUS_MS): boolean {
  const last = asked.get(key);
  if (last != null && now - last < every) return false;
  asked.set(key, now);
  return true;
}
