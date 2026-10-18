// People has two halves: Leads (the seller smart lists and saved lists) and
// Submissions (the houses partners send in, by stage). The rail shows one half
// at a time. Which half, and the list last open on each, is kept per browser
// so a switch lands where the rep left that half.

export type PeopleSide = 'leads' | 'submissions';
export type PeopleSideMemory = { side: PeopleSide; last: Partial<Record<PeopleSide, string>> };

export const PEOPLE_SIDE_KEY = 'clozr.people.side';
export const DEFAULT_PEOPLE_SIDE: PeopleSideMemory = { side: 'leads', last: {} };

const isSide = (v: unknown): v is PeopleSide => v === 'leads' || v === 'submissions';

/**
 * The half the rail shows. Partnerships works submissions only. A list that
 * belongs to a half shows that half; a list under both (vendors, Last import)
 * keeps the half the rep last picked.
 */
export function peopleSideFor(opts: { sellerLists: boolean; listSide: PeopleSide | null; remembered: PeopleSide }): PeopleSide {
  if (!opts.sellerLists) return 'submissions';
  return opts.listSide ?? opts.remembered;
}

/**
 * Where a switch to `side` lands: the list last open on that half while it is
 * still on the rail, else the half's first list. Null when the half is empty.
 */
export function sideLanding(side: PeopleSide, mem: PeopleSideMemory, lists: readonly string[]): string | null {
  const last = mem.last[side];
  if (last && lists.includes(last)) return last;
  return lists[0] ?? null;
}

/** The memory after `list` was open on `side`. The same object back when nothing changed. */
export function noteSide(mem: PeopleSideMemory, side: PeopleSide, list: string): PeopleSideMemory {
  if (mem.side === side && mem.last[side] === list) return mem;
  return { side, last: { ...mem.last, [side]: list } };
}

/** A stored blob read back, or the default for a missing or bad one. */
export function readPeopleSide(raw: string | null): PeopleSideMemory {
  if (!raw) return DEFAULT_PEOPLE_SIDE;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return DEFAULT_PEOPLE_SIDE; }
  if (!j || typeof j !== 'object') return DEFAULT_PEOPLE_SIDE;
  const m = j as { side?: unknown; last?: unknown };
  const last: Partial<Record<PeopleSide, string>> = {};
  if (m.last && typeof m.last === 'object') {
    for (const [k, v] of Object.entries(m.last as Record<string, unknown>)) {
      if (isSide(k) && typeof v === 'string' && v) last[k] = v.slice(0, 200);
    }
  }
  return { side: isSide(m.side) ? m.side : 'leads', last };
}

export function loadPeopleSide(): PeopleSideMemory {
  try { return readPeopleSide(localStorage.getItem(PEOPLE_SIDE_KEY)); } catch { return DEFAULT_PEOPLE_SIDE; }
}

export function savePeopleSide(m: PeopleSideMemory): void {
  try { localStorage.setItem(PEOPLE_SIDE_KEY, JSON.stringify(m)); } catch { /* private mode: the half lasts this visit */ }
}
