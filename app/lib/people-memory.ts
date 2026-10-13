// Where People was left: the list, its filters (sort among them) and the
// search, kept per user in this browser so a reload does not throw a rep back
// to My Leads with every filter cleared. Read once the workspace and the role
// are in, and used only when that list still exists and the role may open it.

export type PeopleMemory = { list: string; pf: Partial<Record<string, string>>; q: string };

export const peopleMemoryKey = (userId: string | null | undefined) => `clozr.people.last.${userId || 'demo'}`;

/**
 * The remembered state, or null when there is none or it no longer fits:
 * a bad blob, or a list that is gone or that this role cannot open. Filter
 * keys the screen no longer knows are dropped; values must be strings.
 */
export function readPeopleMemory(raw: string | null, listOk: (list: string) => boolean, knownFilters: readonly string[]): PeopleMemory | null {
  if (!raw) return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const m = j as { list?: unknown; pf?: unknown; q?: unknown };
  if (typeof m.list !== 'string' || !m.list || !listOk(m.list)) return null;
  const pf: Record<string, string> = {};
  if (m.pf && typeof m.pf === 'object') {
    for (const [k, v] of Object.entries(m.pf as Record<string, unknown>)) {
      if (knownFilters.includes(k) && typeof v === 'string') pf[k] = v;
    }
  }
  return { list: m.list, pf, q: typeof m.q === 'string' ? m.q.slice(0, 200) : '' };
}

export function writePeopleMemory(userId: string | null | undefined, m: PeopleMemory) {
  try { localStorage.setItem(peopleMemoryKey(userId), JSON.stringify(m)); } catch { /* private mode: not remembered */ }
}

export function loadPeopleMemoryRaw(userId: string | null | undefined): string | null {
  try { return localStorage.getItem(peopleMemoryKey(userId)); } catch { return null; }
}
