// Clozr Docs template library: versions, families and a line diff.
//
// A template is a family of rows in `doc_templates`. The first row is the
// family root (parent_id null); every later version points at it through
// parent_id and carries version = the family's highest + 1. Exactly one row
// per family and workspace is the current one (superseded_at null). A
// superseded row keeps its text but moves out of the way: its key becomes
// `<key>~v<version>` so the unique (workspace, key) index and every lookup by
// key keep answering with the current version, and it is marked inactive.
//
// Editing a version no contract has been made from changes it in place.
// Editing one that has been used — or a built-in, which this workspace cannot
// change — makes the next version instead, so a signed contract always points
// at the exact text it was made from.
//
// No I/O: tools/doc-library.test.ts covers it.

export type TplRow = {
  id: number; workspace_id: number | null; key: string; name: string; version?: number | null; parent_id?: number | null;
  superseded_at?: string | null; archived_at?: string | null; sort?: number | null;
};

/** The family a row belongs to: its root's id. */
export const familyOf = (t: Pick<TplRow, 'id' | 'parent_id'>): number => Number(t.parent_id ?? t.id);

/** The key a superseded version is parked under. */
export const supersededKey = (key: string, version: number) => `${baseKey(key)}~v${version}`;
/** A key without any `~vN` suffix. */
export const baseKey = (key: string) => String(key).replace(/~v\d+$/, '');

export type SaveMode = 'update' | 'new_version';

/**
 * How saving an edit to `cur` lands:
 *   update       — change this row (a workspace version nothing was made from)
 *   new_version  — insert version + 1 in the same family and park `cur`
 * A built-in (or another workspace's row) is never changed from here, and an
 * old version is never edited — restoring it makes a new version instead.
 */
export function saveMode(cur: TplRow, ws: number, usedCount: number): SaveMode {
  if (cur.workspace_id == null || Number(cur.workspace_id) !== ws) return 'new_version';
  if (cur.superseded_at) return 'new_version';
  return usedCount > 0 ? 'new_version' : 'update';
}

/** The next version number in a family. */
export const nextVersion = (family: Array<Pick<TplRow, 'version'>>): number =>
  family.reduce((m, r) => Math.max(m, Number(r.version ?? 1)), 0) + 1;

/**
 * The templates a workspace picks from: current versions only, built-ins
 * plus this workspace's rows, a workspace row replacing the built-in with the
 * same key. Archived rows stay in (the caller hides them) so they can be restored.
 */
export function latestByKey<T extends TplRow>(rows: T[], ws: number): T[] {
  const byKey = new Map<string, T>();
  for (const t of rows) {
    if (t.superseded_at) continue;
    if (t.workspace_id != null && Number(t.workspace_id) !== ws) continue;
    const k = baseKey(t.key);
    const cur = byKey.get(k);
    if (!cur || (cur.workspace_id == null && t.workspace_id != null)) byKey.set(k, t);
  }
  return Array.from(byKey.values()).sort((a, b) => Number(a.sort ?? 100) - Number(b.sort ?? 100) || a.name.localeCompare(b.name));
}

/** A key for a new template from its name, not colliding with any taken. */
export function keyFor(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (k) => baseKey(k)));
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'template';
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${used.size + 1}`;
}

/** "v3 · used 12×" */
export function versionLabel(version: number | null | undefined, used: number): string {
  return `v${Number(version ?? 1)} · ${used ? `used ${used}×` : 'not used yet'}`;
}

// ------------------------------------------------------------------ diff

export type DiffLine = { op: 'same' | 'add' | 'del'; text: string; a?: number; b?: number };

/**
 * Line-by-line diff of two template bodies (longest common subsequence).
 * `a` / `b` are 1-based line numbers in the old and new text. Templates are
 * a few hundred lines, so the plain O(n·m) table is fine; past 4,000 lines on
 * either side it falls back to "all removed, all added".
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const A = String(oldText ?? '').split('\n');
  const B = String(newText ?? '').split('\n');
  const n = A.length; const m = B.length;
  if (n * m > 16_000_000) return [...A.map((text, i) => ({ op: 'del' as const, text, a: i + 1 })), ...B.map((text, j) => ({ op: 'add' as const, text, b: j + 1 }))];
  // L[i][j] = LCS length of A[i..] and B[j..], in one flat array.
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: 'same', text: A[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { out.push({ op: 'del', text: A[i], a: i + 1 }); i++; }
    else { out.push({ op: 'add', text: B[j], b: j + 1 }); j++; }
  }
  while (i < n) { out.push({ op: 'del', text: A[i], a: i + 1 }); i++; }
  while (j < m) { out.push({ op: 'add', text: B[j], b: j + 1 }); j++; }
  return out;
}

/** "+3 −1" for a diff, for the history list. */
export function diffStat(d: DiffLine[]): { added: number; removed: number } {
  return { added: d.filter((x) => x.op === 'add').length, removed: d.filter((x) => x.op === 'del').length };
}

// ------------------------------------------------------------------ folders

export type Folder = { id: number; name: string; parent_id: number | null; sort?: number | null };

/** Folders as a flat list in tree order, each with its depth, for an indented tree or a <select>. */
export function folderTree(folders: Folder[]): Array<Folder & { depth: number; path: string }> {
  const kids = new Map<number | null, Folder[]>();
  const ids = new Set(folders.map((f) => f.id));
  for (const f of folders) {
    // A parent that is gone (or a loop) puts the folder at the top.
    const p = f.parent_id != null && ids.has(f.parent_id) && f.parent_id !== f.id ? f.parent_id : null;
    kids.set(p, [...(kids.get(p) ?? []), f]);
  }
  for (const list of kids.values()) list.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0) || a.name.localeCompare(b.name));
  const out: Array<Folder & { depth: number; path: string }> = [];
  const seen = new Set<number>();
  const walk = (p: number | null, depth: number, path: string) => {
    for (const f of kids.get(p) ?? []) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const here = path ? `${path} / ${f.name}` : f.name;
      out.push({ ...f, depth, path: here });
      walk(f.id, depth + 1, here);
    }
  };
  walk(null, 0, '');
  return out;
}

/** A folder and every folder under it. */
export function folderAndBelow(folders: Folder[], id: number): Set<number> {
  const out = new Set<number>([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of folders) if (f.parent_id != null && out.has(f.parent_id) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}
