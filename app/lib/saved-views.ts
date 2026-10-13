// Saved views — a named look at the Deals, People or Buyers table, the way
// Podio keeps them: which columns show and in what order, the filters that
// were set and, on Deals, whether it opens as the table or the board.
//
// Signed in, views live in `saved_views` (migration 77): yours, plus any a
// teammate shared. Migrations here are applied by hand while the code deploys
// on merge, so until 77 is there — and always in the /demo sample, which has no
// workspace — views are kept in this browser's localStorage instead. The menu
// works the same either way; `store` says which one it is.
//
// Which view is open is remembered per screen in localStorage, so the table
// comes back the way it was left.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { firstThisSession } from './screen-memory';
import { isSmartListConfig } from './smart-lists';

export type ViewScreen = 'deals' | 'people' | 'buyers';

export type SavedView<C> = {
  id: string;
  name: string;
  config: C;
  /** Shown to every member of the workspace. */
  shared: boolean;
  /** Saved by the signed-in user, so they can update or delete it. */
  mine: boolean;
};

/** Postgres "relation does not exist" — migration 77 has not been applied here. */
const isMissingTable = (err: { code?: string; message?: string } | null): boolean =>
  err?.code === '42P01' || err?.code === 'PGRST205' || /does not exist|could not find the table/i.test(err?.message ?? '');

const listKey = (screen: ViewScreen, ws: number | null) => `clozr.views.${screen}.${ws ?? 'demo'}`;
const activeKey = (screen: ViewScreen, ws: number | null) => `clozr.view.${screen}.${ws ?? 'demo'}`;

function readLocal<C>(screen: ViewScreen, ws: number | null): SavedView<C>[] {
  try {
    const raw = localStorage.getItem(listKey(screen, ws));
    const list = raw ? (JSON.parse(raw) as SavedView<C>[]) : [];
    return Array.isArray(list) ? list.map((v) => ({ ...v, shared: false, mine: true })) : [];
  } catch {
    return [];
  }
}

function writeLocal<C>(screen: ViewScreen, ws: number | null, list: SavedView<C>[]) {
  try { localStorage.setItem(listKey(screen, ws), JSON.stringify(list)); } catch { /* private mode: this session only */ }
}

/** Whether a screen has had its view put on this session (`oncePerSession`). */
const sessionKey = (screen: ViewScreen, ws: number | null) => `saved-views.${screen}.${ws ?? 'demo'}`;

function readActive(screen: ViewScreen, ws: number | null): string | null {
  try { return localStorage.getItem(activeKey(screen, ws)); } catch { return null; }
}

function writeActive(screen: ViewScreen, ws: number | null, id: string | null) {
  try {
    if (id) localStorage.setItem(activeKey(screen, ws), id);
    else localStorage.removeItem(activeKey(screen, ws));
  } catch { /* ignore */ }
}

export type SavedViews<C> = {
  views: SavedView<C>[];
  /** The open view, or null for the screen's default. */
  active: SavedView<C> | null;
  /** Open a view (null = the default look). The screen applies its config. */
  select: (id: string | null) => void;
  /** Save the current look under a new name; resolves to the new view. */
  create: (name: string, config: C, shared: boolean) => Promise<SavedView<C> | null>;
  /** Overwrite a view you own with the current look. */
  update: (id: string, config: C) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  /** True once the list has loaded (immediately for the browser store). */
  ready: boolean;
  /** 'workspace' when views are in the database; 'browser' when they are in localStorage. */
  store: 'workspace' | 'browser';
};

/**
 * `onLoad` is called once the list is in, with the remembered view's config,
 * so the screen can put that view back on when it opens. It is not called
 * when no view was open (the screen is already on its default).
 *
 * With `oncePerSession`, that happens only the first time the screen opens
 * this session. A screen that keeps its own look while the rep is away
 * (lib/screen-memory) would otherwise have the view laid back over the
 * filters and layout they had changed each time they came back to it.
 */
export function useSavedViews<C>(screen: ViewScreen, workspaceId: number | null, userId: string | null, onLoad?: (config: C) => void, opts?: { oncePerSession?: boolean }): SavedViews<C> {
  const once = !!opts?.oncePerSession;
  const live = !!supabase && workspaceId != null && !!userId;
  const [views, setViews] = useState<SavedView<C>[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [store, setStore] = useState<'workspace' | 'browser'>(live ? 'workspace' : 'browser');
  const onLoadRef = useRef(onLoad);
  useEffect(() => { onLoadRef.current = onLoad; });

  useEffect(() => {
    let alive = true;
    void (async () => {
      let list: SavedView<C>[] | null = null;
      let where: 'workspace' | 'browser' = 'browser';
      if (live) {
        const { data, error } = await supabase!.from('saved_views')
          .select('id, name, config, shared, user_id')
          .eq('workspace_id', workspaceId!).eq('screen', screen)
          .order('name');
        if (!error) {
          where = 'workspace';
          // People's saved smart lists share the table (lib/smart-lists.ts); they are not views.
          list = (data ?? []).filter((r) => !isSmartListConfig(r.config)).map((r) => ({
            id: String(r.id), name: r.name, config: r.config as C, shared: r.shared, mine: r.user_id === userId,
          }));
        } else if (!isMissingTable(error)) {
          console.warn('saved_views', error.message);
        }
      } else {
        await Promise.resolve();
      }
      if (!alive) return;
      const final = list ?? readLocal<C>(screen, workspaceId);
      const remembered = readActive(screen, workspaceId);
      setStore(where);
      setViews(final);
      const open = remembered ? final.find((v) => v.id === remembered) ?? null : null;
      setActiveId(open ? open.id : null);
      setReady(true);
      if (open && (!once || firstThisSession(sessionKey(screen, workspaceId)))) onLoadRef.current?.(open.config);
    })();
    return () => { alive = false; };
  }, [live, screen, workspaceId, userId, once]);

  const select = useCallback((id: string | null) => {
    // The screen applies a view the rep picks itself; coming back to the
    // screen later must not lay it on again (see `oncePerSession`).
    firstThisSession(sessionKey(screen, workspaceId));
    setActiveId(id);
    writeActive(screen, workspaceId, id);
  }, [screen, workspaceId]);

  const create = useCallback(async (name: string, config: C, shared: boolean) => {
    const clean = name.trim().slice(0, 80);
    if (!clean) return null;
    let made: SavedView<C>;
    if (store === 'workspace') {
      const { data, error } = await supabase!.from('saved_views')
        .insert({ workspace_id: workspaceId!, screen, name: clean, config: config as Record<string, unknown>, shared })
        .select('id').single();
      if (error || !data) return null;
      made = { id: String(data.id), name: clean, config, shared, mine: true };
      setViews((v) => [...v, made].sort((a, b) => a.name.localeCompare(b.name)));
    } else {
      made = { id: 'lv' + Date.now().toString(36), name: clean, config, shared: false, mine: true };
      setViews((v) => {
        const next = [...v, made].sort((a, b) => a.name.localeCompare(b.name));
        writeLocal(screen, workspaceId, next);
        return next;
      });
    }
    firstThisSession(sessionKey(screen, workspaceId));
    setActiveId(made.id);
    writeActive(screen, workspaceId, made.id);
    return made;
  }, [store, screen, workspaceId]);

  const update = useCallback(async (id: string, config: C) => {
    if (store === 'workspace') {
      const { error } = await supabase!.from('saved_views').update({ config: config as Record<string, unknown> }).eq('id', Number(id));
      if (error) return false;
      setViews((v) => v.map((x) => (x.id === id ? { ...x, config } : x)));
      return true;
    }
    setViews((v) => {
      const next = v.map((x) => (x.id === id ? { ...x, config } : x));
      writeLocal(screen, workspaceId, next);
      return next;
    });
    return true;
  }, [store, screen, workspaceId]);

  const remove = useCallback(async (id: string) => {
    if (store === 'workspace') {
      const { error } = await supabase!.from('saved_views').delete().eq('id', Number(id));
      if (error) return false;
      setViews((v) => v.filter((x) => x.id !== id));
    } else {
      setViews((v) => {
        const next = v.filter((x) => x.id !== id);
        writeLocal(screen, workspaceId, next);
        return next;
      });
    }
    if (activeId === id) { setActiveId(null); writeActive(screen, workspaceId, null); }
    return true;
  }, [store, screen, workspaceId, activeId]);

  return { views, active: views.find((v) => v.id === activeId) ?? null, select, create, update, remove, ready, store };
}

/**
 * Keep only the keys a screen still knows, in the saved order. A view saved
 * before a column was renamed or removed still opens; the stale key is dropped.
 * An empty result falls back to the default so a view can never blank the table.
 */
export function cleanColumns(saved: unknown, known: readonly string[], fallback: readonly string[]): string[] {
  const list = Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string' && known.includes(k)) : [];
  const unique = Array.from(new Set(list));
  return unique.length ? unique : [...fallback];
}
