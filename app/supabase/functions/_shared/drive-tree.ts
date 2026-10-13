/**
 * A Drive deals folder → files on deals: the pure half (drive-photos' `tree`
 * action does the IO; app/tools/drive-tree.test.ts runs this with `npx tsx`).
 *
 *   folderIdOf(url)      a folder link (or a bare id) → the folder id
 *   folderAddress(name)  "2016 Meadow lane, Richmond, Tx 77469" → its address;
 *                        null for "Wholesale Active Contracts", "Photos",
 *                        "18 Property Portfolio - Mangesh Khedikar"
 *   fileRow(item, …)     a Drive file → the deal_files row it becomes
 */
import { type Address, parseAddress } from './podio-keys.ts';
import { classifyDoc } from './deal-docs.ts';
import { drivePhotoUrl } from './drive-photos.ts';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export type DriveItem = {
  id: string; name: string; mimeType: string; modifiedTime?: string; size?: string; webViewLink?: string; parents?: string[];
};

/** "https://drive.google.com/drive/folders/1Ueed…?usp=…", "…/u/0/folders/1Ueed…", "?id=1Ueed…" or the id itself. */
export function folderIdOf(raw: string): string | null {
  const t = (raw ?? '').trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(t) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(t);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(t) ? t : null;
}

/**
 * A folder named for a property. It must start with a house number and say
 * where — a comma, a state or a zip — so a "Photos" folder, a status folder or
 * "18 Property Portfolio - Mangesh Khedikar" is not a house.
 */
export function folderAddress(name: string): Address | null {
  const t = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!/^\d+[A-Za-z]?\s+[A-Za-z0-9]/.test(t)) return null;
  if (!/,|\b\d{5}\b/.test(t)) return null;
  const a = parseAddress(t);
  return a && /^\d/.test(a.line1) ? a : null;
}

// Subfolders that hold other houses or paperwork: their pictures are files, not the deal's gallery.
const NOT_GALLERY = /\b(comps?|comparables?|offers?|docs?|documents?|contracts?|closing|title|reports?|analysis)\b/i;
export const galleryFolder = (name: string) => !NOT_GALLERY.test(name ?? '');

/** The deal_files row for a Drive file; null for what is not a file to keep (shortcuts, folders). */
export function fileRow(f: DriveItem, ws: number, dealId: number, inGallery: boolean): Record<string, unknown> | null {
  if (f.mimeType === FOLDER_MIME || f.mimeType === 'application/vnd.google-apps.shortcut') return null;
  const base = { workspace_id: ws, deal_id: dealId, name: f.name, source: 'drive', source_id: 'drive:' + f.id, content_type: f.mimeType, byte_size: f.size ? Number(f.size) : null };
  if (f.mimeType.startsWith('image/') && inGallery) return { ...base, kind: 'photo', url: drivePhotoUrl(f.id) };
  return {
    ...base, kind: 'file', url: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
    category: classifyDoc(f.name, '', f.mimeType), visible_to_buyers: false,
  };
}
