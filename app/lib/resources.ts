// Lane resources: the team's reference docs (TC Bible, scripts, title company
// vetting, SOPs, contract templates) behind Lane's Resources button, and the
// docs Lane searches when it answers.
//
// Signed in, docs live in `resources` / `resource_chunks` (migration 400):
// reads go straight to the tables under RLS, search goes through
// search_resources(), and adding or removing a doc goes through the
// `lane-resources` edge function, which extracts the text (PDF, Word,
// Markdown, plain text, a Google Drive file) and cuts it into sections.
// The /demo workspace (workspaceId null) has no database behind it: it shows
// the two sample docs in resources-sample.ts plus whatever is pasted in this
// session, and searches them with searchLocal.

import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { SAMPLE_RESOURCES } from './resources-sample';
import { DEFAULT_CATEGORIES, searchLocal, titleFromFile, titleFromMarkdown, type LocalDoc } from '../supabase/functions/_shared/resource-text';

export type ResourceCategory = { id: string; name: string; position: number };
export type ResourceSource = 'upload' | 'paste' | 'drive' | 'import';
export type ResourceDoc = {
  id: string;
  title: string;
  categoryId: string | null;
  source: ResourceSource;
  fileName: string | null;
  mimeType: string | null;
  driveUrl: string | null;
  chars: number;
  updatedAt: string;
  /** Pinned to the top of Resources (the TC Bible set). */
  pinned: boolean;
};
export type ResourceFull = ResourceDoc & { body: string; fileUrl: string | null };
export type ResourceHit = { resourceId: string; title: string; category: string | null; heading: string; snippet: string };
export type Library = { categories: ResourceCategory[]; docs: ResourceDoc[]; driveConnected: boolean };

/** File types the panel accepts, by extension and the MIME type stored with them. */
export const ACCEPT = '.pdf,.docx,.md,.markdown,.txt';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export function mimeFor(name: string, given = ''): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  if (ext === 'txt') return 'text/plain';
  return /^(application\/pdf|text\/(plain|markdown))$/.test(given) ? given : null;
}

// ─── The panel's open state, outside the workspace view model ────────────────

type PanelState = { open: boolean; docId: string | null; seq: number };
let panel: PanelState = { open: false, docId: null, seq: 0 };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Open Resources: the library, or one doc (a Lane citation). */
export function openResources(docId: string | null = null) {
  panel = { open: true, docId, seq: panel.seq + 1 };
  emit();
}
export function closeResources() {
  panel = { ...panel, open: false, docId: null };
  emit();
}
export function toggleResources() {
  if (panel.open) closeResources(); else openResources();
}
export const useResourcesPanel = () => useSyncExternalStore(subscribe, () => panel, () => panel);

// ─── The demo's in-memory library ────────────────────────────────────────────

const demo = {
  categories: DEFAULT_CATEGORIES.map((name, i) => ({ id: `c${i}`, name, position: i })) as ResourceCategory[],
  docs: SAMPLE_RESOURCES.map((r) => ({ ...r })) as { id: string; title: string; category: string; source: ResourceSource; updatedAt: string; body: string; pinned: boolean; fileName?: string | null }[],
};
const demoCatId = (name: string) => demo.categories.find((c) => c.name === name)?.id ?? null;
const demoDoc = (d: (typeof demo.docs)[number]): ResourceDoc => ({
  id: d.id, title: d.title, categoryId: demoCatId(d.category), source: d.source, fileName: d.fileName ?? null, mimeType: null,
  driveUrl: null, chars: d.body.length, updatedAt: d.updatedAt, pinned: d.pinned,
});
/** Pinned first, then the latest. */
const byPin = (a: ResourceDoc, b: ResourceDoc) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt);

/** The demo's docs, for Lane's stub to search. */
export function demoDocs(): LocalDoc[] {
  return demo.docs.map((d) => ({ id: d.id, title: d.title, category: d.category, body: d.body }));
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/* The resources tables are newer than lib/database.types.ts; read them untyped. */
type Row = Record<string, unknown>;
type Q = PromiseLike<{ data: unknown; error: { message: string } | null }> & Record<string, (...a: unknown[]) => Q>;
const from = (t: string) => (supabase as unknown as { from: (t: string) => Q }).from(t);
const rpc = (fn: string, args: Row) => (supabase as unknown as { rpc: (f: string, a: Row) => Q }).rpc(fn, args);

const DOC_COLS = 'id, title, category_id, source, file_name, mime_type, drive_url, chars, updated_at, pinned';
const toDoc = (r: Row): ResourceDoc => ({
  id: String(r.id), title: String(r.title ?? 'Untitled'), categoryId: r.category_id == null ? null : String(r.category_id),
  source: (r.source as ResourceSource) ?? 'paste', fileName: (r.file_name as string) ?? null, mimeType: (r.mime_type as string) ?? null,
  driveUrl: (r.drive_url as string) ?? null, chars: Number(r.chars ?? 0), updatedAt: String(r.updated_at ?? new Date().toISOString()),
  pinned: r.pinned === true,
});

async function invoke<T>(body: Row): Promise<T> {
  if (!supabase) throw new Error('Resources need a signed-in workspace.');
  const { data, error } = await supabase.functions.invoke('lane-resources', { body });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    if (/Failed to send|FunctionsFetchError|404/i.test(message)) message = 'The lane-resources function is not deployed yet. It deploys with the next merge to main.';
    throw new Error(message);
  }
  const r = data as T & { error?: string };
  if (r && typeof r === 'object' && 'error' in r && r.error) throw new Error(r.error);
  return r;
}

/** Categories (seeded with the defaults on first open), docs, and whether Drive is connected. */
export async function loadLibrary(workspaceId: number | null): Promise<Library> {
  if (workspaceId === null || !supabase) {
    await new Promise((r) => setTimeout(r, 200));
    return { categories: [...demo.categories], docs: demo.docs.map(demoDoc).sort(byPin), driveConnected: false };
  }
  const [cats, docs, status] = await Promise.all([
    rpc('resource_categories_ensure', { p_workspace: workspaceId }),
    from('resources').select(DOC_COLS).eq('workspace_id', workspaceId).order('pinned', { ascending: false }).order('updated_at', { ascending: false }).limit(500),
    invoke<{ drive_connected?: boolean }>({ action: 'status', workspace_id: workspaceId }).catch(() => ({ drive_connected: false })),
  ]);
  if (cats.error) throw new Error(/resource_categories_ensure|does not exist/i.test(cats.error.message)
    ? 'Resources are not set up on this database yet: migration 400_lane_resources has not been applied.' : cats.error.message);
  if (docs.error) throw new Error(docs.error.message);
  return {
    categories: ((cats.data ?? []) as Row[]).map((c) => ({ id: String(c.id), name: String(c.name), position: Number(c.position ?? 0) })),
    docs: ((docs.data ?? []) as Row[]).map(toDoc),
    driveConnected: !!status.drive_connected,
  };
}

/** One doc with its text, and a short-lived link to the original file when there is one. */
export async function loadDoc(workspaceId: number | null, id: string): Promise<ResourceFull> {
  if (workspaceId === null || !supabase) {
    const d = demo.docs.find((x) => x.id === id);
    if (!d) throw new Error('That doc is not in this workspace any more.');
    return { ...demoDoc(d), body: d.body, fileUrl: null };
  }
  const { data, error } = await from('resources').select(`${DOC_COLS}, body, file_path`).eq('workspace_id', workspaceId).eq('id', Number(id)).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('That doc is not in this workspace any more.');
  const r = data as Row;
  let fileUrl: string | null = null;
  if (typeof r.file_path === 'string' && r.file_path) {
    const s = await supabase.storage.from('resources').createSignedUrl(r.file_path, 60 * 10);
    fileUrl = s.data?.signedUrl ?? null;
  }
  return { ...toDoc(r), body: String(r.body ?? ''), fileUrl };
}

/** Sections that match a query, best first, one or two per doc. */
export async function searchResources(workspaceId: number | null, q: string, limit = 12): Promise<ResourceHit[]> {
  if (!q.trim()) return [];
  if (workspaceId === null || !supabase) {
    return searchLocal(demoDocs(), q, limit, 1).map((h) => ({ resourceId: h.resourceId, title: h.title, category: h.category, heading: h.heading, snippet: h.snippet }));
  }
  const { data, error } = await rpc('search_resources', { p_workspace: workspaceId, p_query: q, p_limit: limit, p_per_doc: 1 });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map((h) => ({
    resourceId: String(h.resource_id), title: String(h.title), category: (h.category as string) ?? null,
    heading: String(h.heading ?? ''), snippet: String(h.snippet ?? ''),
  }));
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export type AddInput =
  | { kind: 'file'; files: File[]; title: string; categoryId: string | null }
  | { kind: 'text'; text: string; title: string; categoryId: string | null }
  | { kind: 'drive'; link: string; title: string; categoryId: string | null };

const safeName = (n: string) => n.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(-120) || 'file';

/**
 * Add one doc per file (or the pasted text, or the Drive file). Returns the
 * ids added. A title given with several files is ignored: each takes its own.
 */
export async function addResources(workspaceId: number | null, input: AddInput): Promise<string[]> {
  if (workspaceId === null || !supabase) {
    const cat = demo.categories.find((c) => c.id === input.categoryId)?.name ?? 'Other';
    const now = new Date().toISOString();
    if (input.kind === 'drive') throw new Error('Drive links need a signed-in workspace with Google Drive connected.');
    const items = input.kind === 'text'
      ? [{ name: null as string | null, text: input.text }]
      : await Promise.all(input.files.map(async (f) => {
        if (!/^text\/(plain|markdown)$/.test(mimeFor(f.name, f.type) ?? '')) throw new Error(`${f.name}: the sample workspace reads Markdown and text files. Sign in to add PDF and Word files.`);
        return { name: f.name, text: await f.text() };
      }));
    const ids: string[] = [];
    for (const it of items) {
      const id = `demo-${Date.now()}-${ids.length}`;
      const title = (items.length === 1 && input.title.trim()) || titleFromMarkdown(it.text) || (it.name ? titleFromFile(it.name) : 'Untitled');
      demo.docs.unshift({ id, title, category: cat, source: it.name ? 'upload' : 'paste', updatedAt: now, body: it.text, pinned: false, fileName: it.name });
      ids.push(id);
    }
    return ids;
  }
  const base = { action: 'add', workspace_id: workspaceId, category_id: input.categoryId ? Number(input.categoryId) : null };
  if (input.kind === 'text') {
    const r = await invoke<{ id: number }>({ ...base, kind: 'text', title: input.title, text: input.text });
    return [String(r.id)];
  }
  if (input.kind === 'drive') {
    const r = await invoke<{ id: number }>({ ...base, kind: 'drive', title: input.title, link: input.link });
    return [String(r.id)];
  }
  const ids: string[] = [];
  for (const f of input.files) {
    const mime = mimeFor(f.name, f.type);
    if (!mime) throw new Error(`${f.name}: CLOZR reads PDF, Word (.docx), Markdown and text files.`);
    if (f.size > MAX_FILE_BYTES) throw new Error(`${f.name} is over 25 MB.`);
    const path = `ws/${workspaceId}/${crypto.randomUUID()}/${safeName(f.name)}`;
    const up = await supabase.storage.from('resources').upload(path, f, { contentType: mime, upsert: false });
    if (up.error) throw new Error(`${f.name} did not upload: ${up.error.message}`);
    const r = await invoke<{ id: number }>({
      ...base, kind: 'file', file_path: path, file_name: f.name, mime_type: mime,
      title: input.files.length === 1 ? input.title : '',
    });
    ids.push(String(r.id));
  }
  return ids;
}

export async function updateResource(workspaceId: number | null, id: string, patch: { title?: string; categoryId?: string | null; pinned?: boolean }): Promise<void> {
  if (workspaceId === null || !supabase) {
    const d = demo.docs.find((x) => x.id === id);
    if (!d) return;
    if (patch.title !== undefined) d.title = patch.title;
    if (patch.categoryId !== undefined) d.category = demo.categories.find((c) => c.id === patch.categoryId)?.name ?? 'Other';
    if (patch.pinned !== undefined) d.pinned = patch.pinned;
    return;
  }
  const row: Row = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.categoryId !== undefined) row.category_id = patch.categoryId ? Number(patch.categoryId) : null;
  if (patch.pinned !== undefined) row.pinned = patch.pinned;
  const { error } = await from('resources').update(row).eq('workspace_id', workspaceId).eq('id', Number(id));
  if (error) throw new Error(error.message);
}

export async function removeResource(workspaceId: number | null, id: string): Promise<void> {
  if (workspaceId === null || !supabase) {
    demo.docs = demo.docs.filter((d) => d.id !== id);
    return;
  }
  await invoke({ action: 'remove', workspace_id: workspaceId, id: Number(id) });
}

// ─── Categories (owners and admins) ──────────────────────────────────────────

export async function saveCategory(workspaceId: number | null, c: { id?: string; name: string; position: number }): Promise<void> {
  const name = c.name.trim();
  if (!name) throw new Error('A category needs a name.');
  if (workspaceId === null || !supabase) {
    const hit = c.id ? demo.categories.find((x) => x.id === c.id) : null;
    if (hit) hit.name = name; else demo.categories.push({ id: `c${Date.now()}`, name, position: c.position });
    return;
  }
  const q = c.id
    ? from('resource_categories').update({ name, position: c.position }).eq('workspace_id', workspaceId).eq('id', Number(c.id))
    : from('resource_categories').insert({ workspace_id: workspaceId, name, position: c.position });
  const { error } = await q;
  if (error) throw new Error(/duplicate|unique/i.test(error.message) ? `There is already a category called ${name}.` : error.message);
}

export async function removeCategory(workspaceId: number | null, id: string): Promise<void> {
  if (workspaceId === null || !supabase) {
    const name = demo.categories.find((c) => c.id === id)?.name;
    demo.categories = demo.categories.filter((c) => c.id !== id);
    for (const d of demo.docs) if (d.category === name) d.category = '';
    return;
  }
  const { error } = await from('resource_categories').delete().eq('workspace_id', workspaceId).eq('id', Number(id));
  if (error) throw new Error(error.message);
}
