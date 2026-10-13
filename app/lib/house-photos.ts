/** A photo row: COMPR's own set (a pointer at their store) or a link we saved. */
export type PhotoRef = { url?: string | null; source?: string | null; cover?: boolean | null; position?: number | null };

const COMPR_PHOTO = /thecompr\.com\/api\/photo/i;
const isCompr = (r: PhotoRef) => r.source === 'compr' || COMPR_PHOTO.test(r.url ?? '');

/**
 * Stable identity for a photo URL. COMPR proxy links rotate `token=` but are
 * the same shot when lead_id + pos match — without this, Pull COMPR photos
 * stacks identical fanned tiles after each refresh.
 */
/** A URL the gallery can draw. A Drive folder, Dropbox album or listing page is a link, not a tile. */
// A Supabase storage URL is an upload; only photo rows (image/* on upload) reach the gallery.
const GALLERY_IMAGE = /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)(\?|$)|\/storage\/v1\/object\/(sign|public|authenticated)\/|thecompr\.com\/api\/photo|googleusercontent\.com\/d\/|maps\.googleapis\.com\/maps\/api\/streetview|streetviewpixels/i;

export function isGalleryImage(url: string | null | undefined): boolean {
  const u = (url ?? '').trim();
  return !!u && u !== '—' && GALLERY_IMAGE.test(u);
}

const HTTP_URL = /https?:\/\/[^\s,<>"']+/g;

/** Every http(s) link in a blob, trailing punctuation peeled off, duplicates dropped. */
export function urlsIn(text: string | null | undefined): string[] {
  const found = (text ?? '').match(HTTP_URL) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const u = raw.replace(/[).,;]+$/, '');
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** URLs on "Photos:" lines (Podio notes, a seller's intake notes). */
export function photosLineUrls(notes: string | null | undefined): string[] {
  const lines = (notes ?? '').match(/Photos:[^\n]*/gi) ?? [];
  return urlsIn(lines.join('\n'));
}

export function photoKey(url: string | null | undefined): string {
  const u = (url ?? '').trim();
  if (!u) return '';
  try {
    const parsed = new URL(u);
    if (/thecompr\.com$/i.test(parsed.hostname) && parsed.pathname.includes('/api/photo')) {
      const lead = parsed.searchParams.get('lead_id') ?? '';
      const pos = parsed.searchParams.get('pos') ?? '';
      if (lead) return `compr:${lead}:${pos}`;
    }
    // An upload's signed URL gets a new token each time the album is read; the
    // file is the same one, so the same photo is not shown twice.
    const stored = parsed.pathname.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/(.+)$/);
    if (stored) return `storage:${decodeURIComponent(stored[1])}`;
  } catch { /* keep the raw URL */ }
  return u;
}

/** Where `current` sits in `photos` by photo identity (rotated tokens match), else 0. */
export function photoIndexOf(photos: readonly string[], current: string | null | undefined): number {
  const key = photoKey(current);
  if (!key) return 0;
  return Math.max(0, photos.findIndex((u) => photoKey(u) === key));
}

/**
 * One gallery, never both copies, front of the house first.
 * The cover (the first row marked as the front) leads. COMPR's photo set, in
 * COMPR's order, wins when a report has one — those URLs point at COMPR's
 * storage, so CLOZR does not keep a second file. Durable Drive/upload thumbs
 * ride along so an expired COMPR token set does not leave only broken tiles.
 */
export function canonicalPhotos(rows: PhotoRef[]): string[] {
  const cover = rows.find((r) => r.cover && (r.url ?? '').trim());
  // A Drive folder's photos land in one insert with one created_at, so their
  // position is the only order they have; uploads all sit at 0 and keep theirs.
  const byPosition = (list: PhotoRef[]) => list.map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.position ?? Number.MAX_SAFE_INTEGER) - (b.r.position ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
    .map((x) => x.r);
  const compr = byPosition(rows.filter(isCompr));
  const links = byPosition(rows.filter((r) => !isCompr(r)));
  const set = compr.length ? [...compr, ...links] : links;
  return collectPhotos([cover?.url, ...set.map((r) => r.url)]);
}

/** Photos we already have on a property, in display order, with duplicates dropped. */
export function collectPhotos(urls: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const u = (raw ?? '').trim();
    if (!u || u === '—') continue;
    const key = photoKey(u);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/** The sample graph has one exterior per house. A short interior set makes the slideshow real in the demo. */
export function demoGallery(hero: string, rooms: string[], salt: number): string[] {
  if (!hero) return [];
  const n = rooms.length;
  if (!n) return [hero];
  const extra = [0, 1, 2].map((k) => rooms[(salt + k) % n]);
  return collectPhotos([hero, ...extra]);
}
