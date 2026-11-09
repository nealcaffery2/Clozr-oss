// GIPHY results for the SMS composer's GIF picker. Pure, so the edge function
// (gif-search) and the browser share it and tools/giphy.test.ts covers it.

export interface Gif {
  id: string;
  title: string;
  /** What goes out as MMS media. */
  url: string;
  /** The small rendition the picker grid shows. */
  preview: string;
}

/** Carriers drop MMS media much past 1 MB, so a heavier GIF sends at its small size. */
export const GIF_SEND_MAX_BYTES = 1024 * 1024;

const GIPHY_MEDIA = /^https:\/\/media[0-9]*\.giphy\.com\/[A-Za-z0-9/._-]+$/;

/** A GIPHY media URL with its query string stripped, or null for anything else. */
export function cleanGif(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.split('?')[0]!;
  return GIPHY_MEDIA.test(url) ? url : null;
}

interface Rendition { url?: string; size?: string }
interface GiphyItem { id?: string; title?: string; images?: { fixed_height?: Rendition; fixed_height_small?: Rendition } }

/** GIPHY's `data` array to the picker's list; anything off the GIPHY CDN is dropped. */
export function gifsFrom(data: unknown): Gif[] {
  if (!Array.isArray(data)) return [];
  const out: Gif[] = [];
  for (const item of data as GiphyItem[]) {
    const big = item.images?.fixed_height;
    const small = item.images?.fixed_height_small;
    const preview = cleanGif(small?.url) ?? cleanGif(big?.url);
    const full = Number(big?.size) <= GIF_SEND_MAX_BYTES ? cleanGif(big?.url) : null;
    const url = full ?? cleanGif(small?.url);
    if (!url || !preview) continue;
    out.push({ id: String(item.id ?? url), title: String(item.title ?? 'GIF'), url, preview });
  }
  return out;
}
