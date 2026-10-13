// Bulk assign on People and Buyers (app/components/bulk/AssignPanel.tsx):
// everything selected to one teammate, or the selection split across
// several in consecutive blocks, in list order. "200 each for Quinn, Avery
// and Blake" gives Quinn the first 200, Avery the next 200, Blake the 200
// after that, so each gets a run of the list rather than every third row.
// Pure: the panel previews with these and the screens write each block.

/** One teammate's share. `userId` null is "Unassigned". */
export type AssignBlock = { userId: string | null; ids: string[] };

/** The largest "N each" the panel accepts: more than any list holds. */
export const MAX_EACH = 100_000;

/** A typed count: a whole number from 1, else null. */
export function countOf(text: string | number | null | undefined): number | null {
  const n = typeof text === 'number' ? text : Number(String(text ?? '').replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  return whole >= 1 ? Math.min(whole, MAX_EACH) : null;
}

/**
 * Split `ids` (already in list order) across `people` (in the order picked).
 * `each` null shares them evenly: sizes differ by at most one, the earlier
 * people taking the extra. A number gives each person that many, in turn,
 * until the ids run out (the last may get fewer, later people none); ids
 * past people × each are left out. People with no ids are dropped.
 */
export function splitBlocks(ids: readonly string[], people: readonly (string | null)[], each: number | null): AssignBlock[] {
  const uniq = Array.from(new Set(people));
  if (!uniq.length || !ids.length) return [];
  const out: AssignBlock[] = [];
  if (each == null) {
    const base = Math.floor(ids.length / uniq.length);
    const extra = ids.length % uniq.length;
    let at = 0;
    uniq.forEach((userId, i) => {
      const size = base + (i < extra ? 1 : 0);
      if (size) out.push({ userId, ids: ids.slice(at, at + size) });
      at += size;
    });
    return out;
  }
  const size = Math.max(1, Math.floor(each));
  uniq.forEach((userId, i) => {
    const chunk = ids.slice(i * size, (i + 1) * size);
    if (chunk.length) out.push({ userId, ids: chunk });
  });
  return out;
}

/** How many rows a split wants: people × each, or (even split) everything selected. */
export function wanted(people: number, each: number | null, selected: number): number {
  return each == null ? selected : people * each;
}

/** The preview: who gets how many, and which rows of the selection (1-based, inclusive). */
export function blockRanges(blocks: readonly AssignBlock[]): { userId: string | null; count: number; from: number; to: number }[] {
  let at = 0;
  return blocks.map((b) => {
    const from = at + 1;
    at += b.ids.length;
    return { userId: b.userId, count: b.ids.length, from, to: at };
  });
}

/**
 * The first `n` ids of a list in order, optionally skipping rows that already
 * have an owner, so "select 200" after assigning a batch takes the next 200.
 */
export function firstN<T extends { id: string }>(rows: readonly T[], n: number, keep?: (row: T) => boolean): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (out.length >= n) break;
    if (!keep || keep(r)) out.push(r.id);
  }
  return out;
}

/** The ids of the selection in list order (selection maps are unordered). */
export function inListOrder(listIds: readonly string[], selected: ReadonlySet<string> | Record<string, boolean>): string[] {
  const has = selected instanceof Set ? (id: string) => selected.has(id) : (id: string) => !!(selected as Record<string, boolean>)[id];
  return listIds.filter(has);
}

/** Teammates in a workspace role, for "All acquisitions" and the like. */
export function inRole<T extends { memberRole?: string }>(team: readonly T[], role: string): T[] {
  return team.filter((m) => m.memberRole === role);
}
