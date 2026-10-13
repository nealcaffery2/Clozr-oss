// Which workspace is on screen when a person belongs to more than one.
//
// The database does not pick: a membership query with no order can return
// either row first. The choice is the id this browser saved, when that id is
// still one of their memberships, otherwise the oldest workspace — the lowest
// id — so a second membership never steals the session.

export type WorkspaceStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** localStorage key for the workspace this browser last chose. */
export const ACTIVE_WORKSPACE_KEY = 'clozr.activeWorkspace';

export type MembershipRow = {
  role: string;
  workspaces: { id: number; name: string; owner_id: string } | { id: number; name: string; owner_id: string }[] | null;
};

/** One row per membership, oldest workspace first. A row whose workspace did not come back is skipped. */
export function membershipsFromRows(rows: readonly MembershipRow[] | null | undefined): { id: number; name: string; owner_id: string; role: string }[] {
  const out: { id: number; name: string; owner_id: string; role: string }[] = [];
  for (const row of rows ?? []) {
    const ws = Array.isArray(row.workspaces) ? row.workspaces[0] : row.workspaces;
    const id = Number(ws?.id);
    if (!ws || !Number.isInteger(id)) continue;
    out.push({ id, name: ws.name, owner_id: ws.owner_id, role: row.role });
  }
  return orderMemberships(out);
}

export function orderMemberships<T extends { id: number }>(memberships: readonly T[]): T[] {
  return [...memberships].sort((a, b) => a.id - b.id);
}

/**
 * The workspace to open. `savedId` is whatever the browser remembered; an id
 * that is not in `memberships` (removed, stale, or never valid) is ignored.
 * With nothing saved, the lowest id wins, independent of the array's order.
 */
export function pickActiveWorkspace<T extends { id: number }>(
  memberships: readonly T[],
  savedId: number | null,
): T | null {
  if (!memberships.length) return null;
  const ordered = orderMemberships(memberships);
  if (savedId != null) {
    const hit = ordered.find((m) => m.id === savedId);
    if (hit) return hit;
  }
  return ordered[0];
}

export function readSavedWorkspaceId(storage: WorkspaceStore | null): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ACTIVE_WORKSPACE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeSavedWorkspaceId(storage: WorkspaceStore | null, id: number): void {
  if (!storage) return;
  try { storage.setItem(ACTIVE_WORKSPACE_KEY, String(id)); } catch { /* private mode */ }
}

export function browserWorkspaceStore(): WorkspaceStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// The id the rest of the tab should read when a call has no workspace argument
// of its own (line names, teammate photos). Session writes it on every render
// and before a switch, so a reset that reloads those caches sees the new id.
let notedId: number | null = null;

export function noteActiveWorkspace(id: number | null): void {
  notedId = id;
}

export function notedWorkspaceId(): number | null {
  return notedId;
}

type Reset = () => void;
const resets = new Set<Reset>();

/** Run `fn` the next time the active workspace changes. Returns the unsubscribe. */
export function onWorkspaceReset(fn: Reset): () => void {
  resets.add(fn);
  return () => { resets.delete(fn); };
}

/**
 * Drop workspace-scoped caches, queries and realtime subscriptions. One
 * listener throwing does not skip the rest.
 */
export function resetWorkspaceScope(): void {
  for (const fn of [...resets]) {
    try { fn(); } catch { /* keep going */ }
  }
}

/**
 * Remember `id` and reset workspace-scoped state. Returns the membership, or
 * null when `id` is not one of them — then nothing is saved and nothing resets.
 */
export function commitWorkspaceSwitch<T extends { id: number }>(
  memberships: readonly T[],
  id: number,
  storage: WorkspaceStore | null,
): T | null {
  const next = memberships.find((m) => m.id === id) ?? null;
  if (!next) return null;
  writeSavedWorkspaceId(storage, next.id);
  // Before the reset, so a listener that reloads a cache reads this id.
  noteActiveWorkspace(next.id);
  resetWorkspaceScope();
  return next;
}
