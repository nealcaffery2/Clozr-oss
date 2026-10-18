// Saved smart lists on People and Buyers: a name, the filters that were on
// and the columns that showed, plus who on the team may open it.
//
// They are `saved_views` rows (migration 77) on screen 'people' or 'buyers', told apart
// from the Views menu's own rows by `config.kind = 'smart-list'`
// (lib/saved-views.ts skips them). The table has one `shared` flag rather
// than a list of people, so "who can open it" is kept twice: `shared` is on
// when anyone other than the owner was picked (or nobody, which means
// everyone), which is what lets a teammate's browser read the row at all, and
// the picked ids ride in `config.access` so the rail shows it only to them.
// That narrower part is the app's choice, not row-level security: any member
// can read a shared row.
//
// The /demo sample has no workspace, so its lists live in this browser's
// localStorage, as they do anywhere the table cannot be read.
'use client';

import { supabase } from './supabase';

export const SMART_LIST_KIND = 'smart-list';

export type SmartList<F extends object = Record<string, string>> = {
  id: string;
  name: string;
  filters: F;
  cols: string[];
  /** Team ids allowed to open it. Empty means everyone. */
  access?: string[];
  /** Saved by the signed-in user, so they can delete it. */
  mine?: boolean;
  /** Buyers only: the system list the filters narrow (lib/buyer-list-profile.ts). */
  base?: string;
  /** People: the collection heading the rail files it under. Empty means ungrouped. */
  group?: string;
};

/** The screens that keep smart lists: People, and Buyers (the rail's own lists). */
export type SmartListScreen = 'people' | 'buyers';

type SmartListConfig = { kind: typeof SMART_LIST_KIND; filters: Record<string, string>; cols: string[]; access: string[]; base?: string; group?: string };

/** A `saved_views.config` that holds a smart list rather than a view. */
export function isSmartListConfig(c: unknown): c is SmartListConfig {
  return !!c && typeof c === 'object' && (c as { kind?: unknown }).kind === SMART_LIST_KIND;
}

/** Whether teammates need to read the row: anyone but the owner picked, or nobody (everyone). */
export function smartListShared(access: readonly string[], me: string): boolean {
  return !access.length || access.some((id) => id !== me);
}

/** Who sees it on the rail: its owner, and whoever it was opened to. */
export function smartListVisible(l: { access?: readonly string[]; mine?: boolean }, me: string): boolean {
  return l.mine !== false || !l.access?.length || l.access.includes(me);
}

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);

/** A saved_views row as a smart list, or null when the row is a view or is malformed. */
export function smartListFromRow<F extends object = Record<string, string>>(
  r: { id: number | string; name: string; config: unknown; user_id?: string | null }, me: string | null,
): SmartList<F> | null {
  if (!isSmartListConfig(r.config) || !r.name) return null;
  const c = r.config;
  const filters = c.filters && typeof c.filters === 'object' ? c.filters : {};
  const out: SmartList<F> = { id: String(r.id), name: r.name, filters: filters as F, cols: strings(c.cols), access: strings(c.access), mine: !r.user_id || r.user_id === me };
  if (typeof c.base === 'string' && c.base) out.base = c.base;
  if (typeof c.group === 'string' && c.group) out.group = c.group;
  return out;
}

export function smartListConfig(l: { filters: object; cols: string[]; access?: string[]; base?: string; group?: string }): SmartListConfig {
  const c: SmartListConfig = { kind: SMART_LIST_KIND, filters: { ...(l.filters as Record<string, string>) }, cols: [...l.cols], access: [...(l.access ?? [])] };
  if (l.base) c.base = l.base;
  if (l.group) c.group = l.group;
  return c;
}

const localKey = (screen: SmartListScreen) => (screen === 'people' ? 'clozr.smartLists.demo' : `clozr.smartLists.${screen}.demo`);

function readLocal<F extends object>(screen: SmartListScreen): SmartList<F>[] {
  try {
    const raw = localStorage.getItem(localKey(screen));
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    return Array.isArray(list)
      ? list.flatMap((x) => {
        const r = x as { id: string; name: string; config: unknown };
        const l = smartListFromRow<F>({ id: r.id, name: r.name, config: r.config }, null);
        return l ? [l] : [];
      })
      : [];
  } catch {
    return [];
  }
}

function writeLocal<F extends object>(screen: SmartListScreen, list: SmartList<F>[]) {
  try {
    localStorage.setItem(localKey(screen), JSON.stringify(list.map((l) => ({ id: l.id, name: l.name, config: smartListConfig(l) }))));
  } catch { /* private mode: this session only */ }
}

/** Every smart list this user can read: theirs, plus any a teammate shared. */
export async function loadSmartLists<F extends object>(workspaceId: number | null, me: string | null, screen: SmartListScreen = 'people'): Promise<SmartList<F>[] | null> {
  if (!supabase || workspaceId == null || !me) return readLocal<F>(screen);
  const { data, error } = await supabase.from('saved_views')
    .select('id, name, config, user_id')
    .eq('workspace_id', workspaceId).eq('screen', screen)
    .order('name');
  if (error) { console.warn('smart lists', error.message); return null; }
  return (data ?? []).flatMap((r) => {
    const l = smartListFromRow<F>(r, me);
    return l ? [l] : [];
  });
}

/** Save a new list; resolves to its id, or null when it did not save. */
export async function insertSmartList<F extends object>(workspaceId: number | null, me: string | null, l: SmartList<F>, all: SmartList<F>[], screen: SmartListScreen = 'people'): Promise<string | null> {
  if (!supabase || workspaceId == null || !me) {
    const id = 'll' + Date.now().toString(36);
    writeLocal(screen, [...all.filter((x) => x.id !== l.id), { ...l, id }]);
    return id;
  }
  const { data, error } = await supabase.from('saved_views')
    .insert({ workspace_id: workspaceId, screen, name: l.name.slice(0, 80), config: smartListConfig(l) as unknown as Record<string, unknown>, shared: smartListShared(l.access ?? [], me) })
    .select('id').single();
  if (error || !data) return null;
  return String(data.id);
}

export async function deleteSmartList<F extends object>(workspaceId: number | null, me: string | null, id: string, all: SmartList<F>[], screen: SmartListScreen = 'people'): Promise<boolean> {
  if (!supabase || workspaceId == null || !me) {
    writeLocal(screen, all.filter((x) => x.id !== id));
    return true;
  }
  const { error } = await supabase.from('saved_views').delete().eq('id', Number(id));
  return !error;
}
