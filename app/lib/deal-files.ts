// What a deal carries: uploaded files and links (migration 45, table deal_files).
//
// Uploads go to the private deal-files bucket under ws/<workspace>/deals/<deal>/,
// the path shape its storage policy checks. A photo link is just a row with a
// url — Podio's photo folders and Drive/Dropbox links work without a download,
// and a Drive folder is also read into one photo row per image (pullDrivePhotos).

import { supabase } from './supabase';
import { canonicalPhotos, type PhotoRef } from './house-photos';
import { DOC_LABEL, DOC_TYPES, type DocType, classifyDoc } from '../supabase/functions/_shared/deal-docs';

export { DOC_LABEL, DOC_TYPES, type DocType };

export type DealFile = {
  id: number; deal_id: number; kind: 'file' | 'photo' | 'link'; name: string;
  url: string | null; storage_path: string | null; content_type: string | null;
  byte_size: number | null; created_at: string;
  /** A document's type (deal-docs.ts) on files and links; a listing photo's category on photos. */
  category: string | null;
  /** 'upload' | 'link' | 'gmail' (filed off a deal's email by the sync) | … */
  source: string | null;
  communication_id: number | null;
  needs_notary?: boolean | null; notary_status?: string | null;
  /** The front of the house: the photo every deal, dispo and record screen leads with. */
  is_cover?: boolean | null;
  /** COMPR's photo order on its own set. */
  position?: number | null;
};

type Result = { ok: true; count: number } | { ok: false; message: string };

export async function listDealFiles(dealId: number): Promise<DealFile[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('deal_files')
    .select('id,deal_id,kind,name,url,storage_path,content_type,byte_size,created_at,category,source,communication_id,needs_notary,notary_status,is_cover,position')
    .eq('deal_id', dealId).order('created_at', { ascending: false });
  return (data as DealFile[]) ?? [];
}

const isImage = (type: string, name: string) => type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(name);

/** Upload any number of files at once; each lands as its own row. */
export async function uploadDealFiles(workspaceId: number, dealId: number, files: File[]): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sb = supabase;
  const one = async (file: File): Promise<string | null> => {
    const safe = file.name.replace(/[^\w.\- ]+/g, '_');
    const path = `ws/${workspaceId}/deals/${dealId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safe}`;
    const up = await sb.storage.from('deal-files').upload(path, file, { contentType: file.type || undefined });
    if (up.error) return `${file.name}: ${up.error.message}`;
    const { error } = await sb.from('deal_files').insert({
      workspace_id: workspaceId, deal_id: dealId, kind: isImage(file.type, file.name) ? 'photo' : 'file',
      name: file.name, storage_path: path, content_type: file.type || null, byte_size: file.size, source: 'upload',
      // A dropped "Title Commitment.pdf" is labelled the way an emailed one is.
      ...(isImage(file.type, file.name) ? {} : { category: classifyDoc(file.name, '', file.type) }),
    });
    if (error) {
      await sb.storage.from('deal-files').remove([path]);
      return `${file.name}: ${error.message}`;
    }
    return null;
  };
  // Four at a time: a drop of twenty photos used to upload one after another.
  const queue = files.slice();
  const failures: string[] = [];
  let count = 0;
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const err = await one(f);
      if (err) failures.push(err); else count++;
    }
  }));
  if (failures.length) return { ok: false, message: failures.length === 1 ? failures[0] : `${failures.length} files failed: ${failures[0]}` };
  return { ok: true, count };
}

/** Every http(s) link in a pasted blob — one per line, comma or space separated. */
export function parseLinks(text: string): string[] {
  return Array.from(new Set((text.match(/https?:\/\/[^\s,<>"']+/g) ?? []).map((u) => u.replace(/[).,;]+$/, ''))));
}

// lh3.googleusercontent.com/d/<id> is a photo read out of a Drive folder (migration 120).
export const IMAGE_URL = /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)(\?|$)|thecompr\.com\/api\/photo|googleusercontent\.com\/d\//i;
/** Where a shared photo folder or album lives: Podio / Drive / Dropbox / Google Photos… */
export const FOLDER_HOST = /drive\.google\.com|docs\.google\.com|dropbox\.com|photos\.app\.goo\.gl|photos\.google\.com|icloud\.com|companycam|onedrive|sharepoint|1drv\.ms|podio\.com/i;

/**
 * An imported photo link as a deal_files row. A real image is a photo. A
 * folder (Drive, Dropbox…) or a listing page is a link filed under photos:
 * the Photos button opens it, and the drive-photos cron still reads a Drive
 * folder into one image per file. Keeping the folder as kind=photo painted a
 * broken image on the deal card.
 */
export function photoLinkRow(workspaceId: number, dealId: number, url: string, source = 'import') {
  let name = url;
  try { name = decodeURIComponent(url.split('?')[0].split('/').filter(Boolean).pop() || url); } catch { /* keep the url */ }
  const photo = IMAGE_URL.test(url);
  return {
    workspace_id: workspaceId, deal_id: dealId, url, source, name: name.slice(0, 200),
    ...(photo ? { kind: 'photo' as const } : { kind: 'link' as const, category: 'photos', name: FOLDER_HOST.test(url) ? 'Photos' : name.slice(0, 200) }),
  };
}

/** A link row the Photos button should open: filed under photos, or named Photos. */
export function isSourcePhotoLink(f: { kind: string; category?: string | null; name?: string | null; url?: string | null }): boolean {
  if (f.kind !== 'link' || !(f.url ?? '').trim()) return false;
  return f.category === 'photos' || /^(podio )?photos$/i.test(f.name ?? '');
}

/** Images plus source photo links, with signed URLs filled in for uploads. */
export async function loadDealAlbum(dealId: number): Promise<string[]> {
  const files = await listDealFiles(dealId);
  const rows = await Promise.all(
    files.filter((f) => (f.kind === 'photo' || isSourcePhotoLink(f)) && (f.url || f.storage_path)).map(async (f) => ({
      url: f.url || await fileUrl(f), source: f.source, cover: !!f.is_cover, position: f.position,
    })),
  );
  return canonicalPhotos(rows);
}

/** Slideshow URLs for one deal's files: images and the source photo links. */
export function albumFromFiles(files: Pick<DealFile, 'kind' | 'name' | 'url' | 'source' | 'category' | 'is_cover' | 'position'>[]): string[] {
  const rows: PhotoRef[] = [];
  for (const f of files) {
    if (!f.url) continue;
    if (f.kind === 'photo' || isSourcePhotoLink(f)) rows.push({ url: f.url, source: f.source, cover: f.is_cover, position: f.position });
  }
  return canonicalPhotos(rows);
}

/** Put a row's photo links on its deal; links already there are skipped.
 * Insert, not upsert: the unique index on (deal_id, url) is partial, and
 * PostgREST's ON CONFLICT cannot infer it, so the upsert failed and the
 * links never landed. */
export async function attachPhotoLinks(workspaceId: number, dealId: number, urls: string[], source = 'import'): Promise<void> {
  if (!supabase || !urls.length) return;
  const { data } = await supabase.from('deal_files').select('url').eq('deal_id', dealId).in('url', urls);
  const have = new Set((data ?? []).map((r) => r.url).filter((u): u is string => !!u));
  const rows = urls.filter((u) => !have.has(u)).map((url) => photoLinkRow(workspaceId, dealId, url, source));
  if (!rows.length) return;
  await supabase.from('deal_files').insert(rows);
  const first = urls.find((u) => /^https?:\/\//i.test(u));
  if (first) await supabase.from('deals').update({ photos_url: first }).eq('id', dealId).is('photos_url', null);
}

/** Add pasted links. `photo` links render as photos in property media. Links already on the deal are skipped. */
export async function addDealLinks(workspaceId: number, dealId: number, text: string, kind: 'photo' | 'link'): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const urls = parseLinks(text);
  if (!urls.length) return { ok: false, message: 'Paste at least one link starting with http.' };
  // Insert what is new, not upsert: the (deal_id, url) unique index is partial,
  // so ON CONFLICT cannot use it and every paste failed (see attachPhotoLinks).
  const { data: had, error: readErr } = await supabase.from('deal_files').select('url').eq('deal_id', dealId).in('url', urls);
  if (readErr) return { ok: false, message: readErr.message };
  const have = new Set((had ?? []).map((r) => r.url).filter((u): u is string => !!u));
  const fresh = urls.filter((u) => !have.has(u));
  if (!fresh.length) return { ok: true, count: 0 };
  const nameOf = (url: string) => { try { return decodeURIComponent(url.split('?')[0].split('/').filter(Boolean).pop() || url).slice(0, 200); } catch { return url.slice(0, 200); } };
  // A pasted Drive folder or album under Photos is a photo link, not a broken image tile.
  const rows = fresh.map((url) => (kind === 'photo'
    ? photoLinkRow(workspaceId, dealId, url, 'link')
    : { workspace_id: workspaceId, deal_id: dealId, kind, url, source: 'link', name: nameOf(url) }));
  const { data, error } = await supabase.from('deal_files').insert(rows).select('id');
  return error ? { ok: false, message: error.message } : { ok: true, count: data?.length ?? 0 };
}

/** A viewable address: the link itself, or a short-lived signed URL for an upload. */
export async function fileUrl(f: DealFile, seconds = 3600): Promise<string | null> {
  if (f.url) return f.url;
  if (!supabase || !f.storage_path) return null;
  const { data } = await supabase.storage.from('deal-files').createSignedUrl(f.storage_path, seconds);
  return data?.signedUrl ?? null;
}

export async function removeDealFile(f: DealFile): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (f.storage_path) await supabase.storage.from('deal-files').remove([f.storage_path]);
  const { error } = await supabase.from('deal_files').delete().eq('id', f.id);
  return error ? { ok: false, message: error.message } : { ok: true, count: 1 };
}

/**
 * Make this photo the front of the house. The database clears the other
 * covers; a photo with a public link also becomes the deal's hero, which is
 * what Deals, Dispo, blasts and the listing page lead with.
 */
export async function setDealFileCover(f: DealFile): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('deal_files').update({ is_cover: true }).eq('id', f.id);
  if (error) return { ok: false, message: error.message };
  if (f.url && /^https:\/\//i.test(f.url)) {
    const { error: e2 } = await supabase.from('deals').update({ hero_image_url: f.url }).eq('id', f.deal_id);
    if (e2) return { ok: false, message: e2.message };
  }
  return { ok: true, count: 1 };
}

/** COMPR's photo set and front photo for a deal with a COMPR report. No run, nothing billed. */
export async function pullComprPhotos(workspaceId: number, dealId: number): Promise<Result & { linked?: boolean }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('compr-underwrite', { body: { action: 'deal_photos', workspace_id: workspaceId, deal_id: dealId } });
  if (error) return { ok: false, message: error.message };
  const r = data as { ok?: boolean; linked?: boolean; photos?: string[]; error?: string } | null;
  if (!r?.ok) return { ok: false, message: r?.error ?? 'COMPR did not answer.' };
  if (!r.linked) return { ok: false, linked: false, message: 'This deal has no COMPR report yet. Run COMPR on it first.' };
  return { ok: true, linked: true, count: r.photos?.length ?? 0 };
}

export type DrivePull = { ok: true; linked: boolean; count: number; urls: string[]; failed: number } | { ok: false; message: string };
const drivePulls = new Map<number, Promise<DrivePull>>();

/**
 * The deal's Google Drive photo folder, subfolders included, read into photo
 * rows (drive-photos function, migration 120). Nothing is copied or billed.
 * One call per deal at a time: the record card and its Files card both ask
 * when a deal opens with no photos. `force` reads it even when the deal has a
 * COMPR set, which is otherwise the gallery.
 */
export function pullDrivePhotos(workspaceId: number, dealId: number, force = false): Promise<DrivePull> {
  const running = drivePulls.get(dealId);
  if (running) return running;
  const sb = supabase;
  const call = (async (): Promise<DrivePull> => {
    if (!sb) return { ok: false, message: 'Supabase is not configured.' };
    const { data, error } = await sb.functions.invoke('drive-photos', { body: { action: 'deal', workspace_id: workspaceId, deal_id: dealId, force } });
    if (error) return { ok: false, message: error.message };
    const r = data as { ok?: boolean; linked?: boolean; photos?: number; urls?: string[]; failed?: number; error?: string } | null;
    if (!r?.ok) return { ok: false, message: r?.error ?? 'Drive did not answer.' };
    return { ok: true, linked: !!r.linked, count: r.photos ?? 0, urls: r.urls ?? [], failed: r.failed ?? 0 };
  })().finally(() => drivePulls.delete(dealId));
  drivePulls.set(dealId, call);
  return call;
}

/** Mark a file as needing a notary, or clear that flag. */
export async function setDealFileNotary(id: number, needs: boolean): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('deal_files').update({
    needs_notary: needs,
    notary_status: needs ? 'needed' : null,
  }).eq('id', id);
  return error ? { ok: false, message: error.message } : { ok: true, count: 1 };
}

/** Relabel a document (the Files card's type picker); null clears the label. */
export async function setDealFileType(id: number, type: DocType | null): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  // Read the row back: an update policy that matches nothing is not an error,
  // and the picker used to say "Labelled" over a label that never saved.
  const { data, error } = await supabase.from('deal_files').update({ category: type }).eq('id', id).select('id');
  if (error) return { ok: false, message: error.message };
  return data?.length ? { ok: true, count: 1 } : { ok: false, message: 'That label did not save. Reload and try again.' };
}

/** The label a file shows: its document type, or nothing for photos and unlabelled rows. */
export const docLabelOf = (f: Pick<DealFile, 'kind' | 'category'>): string | null =>
  f.kind !== 'photo' && f.category && f.category in DOC_LABEL ? DOC_LABEL[f.category as DocType] : null;
