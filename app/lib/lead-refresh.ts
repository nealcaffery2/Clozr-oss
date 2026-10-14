// How a burst of new sellers is brought on screen.
//
// A handful are read one at a time. A larger burst is read by id, 200 at a
// time. Past the hold line the tab does not read at all: it asks for a click,
// because an import of a thousand rows used to re-read the whole workspace
// on every open tab.

/** New leads arriving within this long of each other are handled together. */
export const LEAD_BATCH_MS = 1500;
/** At or under this, each new seller is its own small read. */
export const LEAD_REFRESH_MAX = 5;
/** A by-id read asks for this many sellers at once. */
export const LEAD_CHUNK = 200;
/** More new leads than this waits for a click instead of reading. */
export const LEAD_HOLD_AT = 500;
/** Full reloads coalesce for at least this long. */
export const RELOAD_DEBOUNCE_MS = 3_000;

export type LeadPlan = 'each' | 'byIds' | 'hold';

export function planLeadRefresh(count: number): LeadPlan {
  if (count > LEAD_HOLD_AT) return 'hold';
  if (count > LEAD_REFRESH_MAX) return 'byIds';
  return 'each';
}

export function chunkIds(ids: number[], size = LEAD_CHUNK): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
