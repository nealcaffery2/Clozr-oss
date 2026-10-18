// The main photo ("money shot") of a deal email: a picture from the deal's
// photo folder, or one the rep uploads. An upload is cropped to the email's
// 3:2 hero frame around its centre and scaled to 1200 × 800, so it fills the
// slot the same way every time, then stored where an inbox can load it (the
// public deal-public bucket; deal-files is private) and added to the deal's
// photos so it is in the folder next time.

import { supabase } from './supabase';
import { attachPhotoLinks, pullDrivePhotos } from './deal-files';

export const HERO_W = 1200;
export const HERO_H = 800;

export type DealPhoto = { id: number; name: string; url: string };

/** Where an uploaded hero lands in the public bucket. */
export const heroPath = (workspaceId: number, dealId: number, stamp: number) => `ws/${workspaceId}/deals/${dealId}/email/hero-${stamp}.jpg`;

/** The centred crop that turns a w × h picture into the 3:2 hero frame. */
export function coverCrop(w: number, h: number, ratio = HERO_W / HERO_H): { sx: number; sy: number; sw: number; sh: number } {
  if (w <= 0 || h <= 0) return { sx: 0, sy: 0, sw: 0, sh: 0 };
  if (w / h > ratio) {
    const sw = Math.round(h * ratio);
    return { sx: Math.round((w - sw) / 2), sy: 0, sw, sh: h };
  }
  const sh = Math.round(w / ratio);
  return { sx: 0, sy: Math.round((h - sh) / 2), sw: w, sh };
}

/** A public photo an email can show: https, and not a signed or private storage link. */
export const emailablePhoto = (url: string | null | undefined) =>
  !!url && /^https:\/\//.test(url) && !/\/storage\/v1\/object\/(?:sign|authenticated)\//i.test(url);

async function toHero(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const { sx, sy, sw, sh } = coverCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  // Never upscale a small photo past its own pixels.
  const scale = Math.min(1, HERO_W / sw);
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('This browser cannot resize the photo.');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the photo.'))), 'image/jpeg', 0.86));
}

/** Crop, upload and file a new hero. Returns its public URL. */
export async function uploadHeroPhoto(workspaceId: number, dealId: number, file: File): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (!/^image\//.test(file.type)) return { ok: false, message: `${file.name} is not a photo. Pick a JPG, PNG or WebP.` };
  if (file.size > 25 * 1024 * 1024) return { ok: false, message: `${file.name} is over 25 MB. Pick a smaller photo.` };
  let blob: Blob;
  try { blob = await toHero(file); } catch (e) { return { ok: false, message: `Could not read ${file.name}: ${(e as Error).message}` }; }
  const path = heroPath(workspaceId, dealId, Date.now());
  const up = await supabase.storage.from('deal-public').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (up.error) return { ok: false, message: `Upload failed: ${up.error.message}` };
  const url = supabase.storage.from('deal-public').getPublicUrl(path).data.publicUrl;
  await attachPhotoLinks(workspaceId, dealId, [url], 'upload').catch(() => {});
  return { ok: true, url };
}

/**
 * A photo from the folder, framed the same way as an upload: fetched, cropped
 * to 3:2 and stored as the hero. A host that will not hand the browser its
 * pixels (no CORS) keeps the photo as it is, and the email scales it to the
 * column width.
 */
export async function heroFromUrl(workspaceId: number, dealId: number, src: string): Promise<{ url: string; framed: boolean }> {
  if (!supabase || /\/deal-public\/ws\/\d+\/deals\/\d+\/email\/hero-/.test(src)) return { url: src, framed: true };
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await toHero(await res.blob());
    const path = heroPath(workspaceId, dealId, Date.now());
    const up = await supabase.storage.from('deal-public').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (up.error) throw up.error;
    return { url: supabase.storage.from('deal-public').getPublicUrl(path).data.publicUrl, framed: true };
  } catch {
    return { url: src, framed: false };
  }
}

/** The deal's photos an email can use, COMPR's first, newest last. */
export async function loadEmailPhotos(dealId: number): Promise<DealPhoto[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('deal_files').select('id, name, url, source').eq('deal_id', dealId).eq('kind', 'photo').not('url', 'is', null).order('id');
  return ((data ?? []) as { id: number; name: string | null; url: string; source: string | null }[])
    .filter((x) => emailablePhoto(x.url))
    .sort((a, b) => Number(b.source === 'compr') - Number(a.source === 'compr'))
    .map((x) => ({ id: x.id, name: x.name ?? 'Photo', url: x.url }));
}

/** Pull the deal's linked photo folder (Drive, Podio) into its photos, then read them. */
export async function refreshFromFolder(workspaceId: number, dealId: number): Promise<{ ok: true; photos: DealPhoto[]; note: string } | { ok: false; message: string }> {
  const r = await pullDrivePhotos(workspaceId, dealId, true);
  if (!r.ok) return { ok: false, message: r.message };
  const photos = await loadEmailPhotos(dealId);
  return { ok: true, photos, note: r.linked ? `${r.count} photos in the folder${r.failed ? `, ${r.failed} could not be read` : ''}.` : 'This deal has no photo folder linked. Add one on the Files tab.' };
}
