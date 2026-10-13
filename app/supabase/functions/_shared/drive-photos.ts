// Google Drive photo folders as image URLs. Ported from COMPR's resolver
// (comp-engine services/intake/photoResolver.ts, resolveDriveFolderScrape),
// so a Podio "Photos" folder shows on the deal without a COMPR run.
//
// No API key and no OAuth: drive.google.com/embeddedfolderview renders a
// public ("anyone with the link") folder as plain HTML, one flip-entry per
// item. Files and subfolders are told apart by their markup, and subfolders
// are walked breadth first, because agents nest (Photos > Kitchen, or one
// folder per visit date).
//
// Runtime-neutral: global fetch only, so the edge function and the Node
// tests share it.

export type DriveLink = { kind: 'folder' | 'file' | 'either'; id: string };
export type DriveEntry = { id: string; name: string; folder: boolean; mime: string | null };
export type DrivePhoto = { id: string; name: string; url: string };
export type DriveResult = { photos: DrivePhoto[]; folders: number; failed: number };

const ID = '[A-Za-z0-9_-]{10,}';
const FOLDER_RE = new RegExp(`drive\\.google\\.com/(?:drive/(?:[^/?#]+/)*folders/|(?:embedded)?folderview\\?(?:[^#]*&)?id=)(${ID})`, 'i');
const FILE_RE = new RegExp(`drive\\.google\\.com/(?:file/d/|uc\\?(?:[^#]*&)?id=)(${ID})`, 'i');
// open?id= is the share shape for files AND folders alike; the caller probes.
const EITHER_RE = new RegExp(`drive\\.google\\.com/open\\?(?:[^#]*&)?id=(${ID})`, 'i');

/** Every Drive folder or file a block of text links, once each, in order. */
export function driveLinks(text: string): DriveLink[] {
  const out: DriveLink[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(/https?:\/\/[^\s<>"',;]+/gi) ?? []) {
    const m = FOLDER_RE.exec(raw);
    const f = m ? null : FILE_RE.exec(raw);
    const e = m || f ? null : EITHER_RE.exec(raw);
    const link: DriveLink | null = m ? { kind: 'folder', id: m[1] } : f ? { kind: 'file', id: f[1] } : e ? { kind: 'either', id: e[1] } : null;
    if (link && !seen.has(link.id)) { seen.add(link.id); out.push(link); }
  }
  return out;
}

/**
 * The image a browser can show for a Drive file. lh3 transcodes on the way
 * out, so an iPhone HEIC arrives as a JPEG (the raw download is HEIC, which
 * no browser draws). Not drive.google.com/thumbnail: that answers with a
 * redirect to this same URL, and the Files card reads a drive.google.com
 * link as a folder.
 */
export const drivePhotoUrl = (id: string) => `https://lh3.googleusercontent.com/d/${id}=w1600`;

const decode = (s: string) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/**
 * embeddedfolderview HTML as entries. A folder row is known by any of its
 * markers (a folders/ link, aria-label="Folder", the folder sprite, the old
 * google-apps.folder icon): Google has dropped markers before, and a "Pics"
 * subfolder read as a file is a folder never walked. A file's type comes from
 * its list icon (drive-thirdparty.../type/image/jpeg).
 */
export function parseDriveEmbed(html: string): DriveEntry[] {
  const byId = new Map<string, DriveEntry>();
  for (const m of html.matchAll(/id="entry-([A-Za-z0-9_-]{10,})"([\s\S]*?)(?=id="entry-|$)/g)) {
    const block = m[2];
    const folder = /drive\.google\.com\/drive\/(?:[^/"]*\/)*folders\//i.test(block)
      || /aria-label="Folder"/i.test(block) || /drive-sprite-folder/i.test(block) || /vnd\.google-apps\.folder/i.test(block);
    const name = decode(/flip-entry-title[^>]*>([^<]*)</.exec(block)?.[1] ?? '').trim();
    const mime = /\/type\/([a-z]+\/[a-z0-9.+-]+)/i.exec(block)?.[1]?.toLowerCase() ?? null;
    byId.set(m[1], { id: m[1], name, folder, mime: folder ? null : mime });
  }
  // Leaner markup without flip-entry wrappers: the links alone still say file or folder.
  if (!byId.size) {
    for (const m of html.matchAll(/href="([^"]+)"/gi)) {
      const file = new RegExp(`/file/d/(${ID})`).exec(m[1]);
      const folder = new RegExp(`/folders/(${ID})`).exec(m[1]);
      const id = file?.[1] ?? folder?.[1];
      if (id && !byId.has(id)) byId.set(id, { id, name: '', folder: !file, mime: null });
    }
  }
  return [...byId.values()];
}

const IMAGE_NAME = /\.(jpe?g|jfif|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;

/** A photo, not a video, a PDF or a spreadsheet that happens to share the folder. */
export function isPhotoEntry(e: DriveEntry): boolean {
  if (e.folder) return false;
  if (e.mime) return e.mime.startsWith('image/');
  return !e.name || IMAGE_NAME.test(e.name);
}

// Folders that read like a photo bucket or a room are walked first; ones
// that read like paperwork are never walked, so a sibling "Comps" folder
// cannot put someone else's house in the gallery. Same lists as COMPR.
const PHOTO_FOLDER = /\b(photos?|pics?|pictures?|images?|imgs?|gallery|media|interior|exterior|kitchen|bath(?:room)?s?|bed(?:room)?s?|living|dining|garage|basement|attic|laundry|yard|backyard|front|rooms?|property|walkthrough|tour|renovat(?:e|ion)s?|before|after|house|home)\b/i;
const DENY_FOLDER = /\b(comps?|comparable|offers?|docs?|documents?|paperwork|contracts?|closing|financials?|reports?|analysis|titles?|insurance)\b/i;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function fetchDriveFolder(id: string, fetcher: typeof fetch = fetch): Promise<DriveEntry[]> {
  const res = await fetcher(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(15_000),
  });
  // A folder that is not shared with "anyone with the link" answers with a sign-in page or a 404.
  if (!res.ok) throw new Error(`Drive folder ${res.status}`);
  return parseDriveEmbed(await res.text());
}

export type WalkOptions = {
  /** Photos kept per deal. COMPR grades 100; the gallery takes a whole shoot. */
  max?: number;
  /** Levels below the shared folder. Parcel > Photos > Kitchen is common. */
  depth?: number;
  /** Folder pages fetched in all, so a huge or looping tree stays bounded. */
  fetches?: number;
  fetcher?: typeof fetch;
};

/**
 * Every photo under the given Drive links: the files themselves, then each
 * folder's own photos before its subfolders', photo and room folders first.
 * A folder that will not load counts in `failed` and the rest still resolve.
 */
export async function resolveDrivePhotos(links: DriveLink[], opts: WalkOptions = {}): Promise<DriveResult> {
  const max = opts.max ?? 200;
  const maxDepth = opts.depth ?? 6;
  let budget = opts.fetches ?? 40;
  const fetcher = opts.fetcher ?? fetch;
  const photos = new Map<string, DrivePhoto>();
  const add = (id: string, name: string) => { if (photos.size < max && !photos.has(id)) photos.set(id, { id, name, url: drivePhotoUrl(id) }); };
  const seen = new Set<string>();
  let folders = 0;
  let failed = 0;

  type Item = { id: string; photoLine: boolean; probe: boolean };
  let level: Item[] = [];
  for (const l of links) {
    if (l.kind === 'file') add(l.id, '');
    else level.push({ id: l.id, photoLine: false, probe: l.kind === 'either' });
  }

  for (let depth = 0; depth <= maxDepth && level.length && photos.size < max; depth++) {
    const preferred: Item[] = [];
    const rest: Item[] = [];
    // Four folder pages at a time: a deal with a dozen visit folders used to
    // walk them one after another inside a request with a wall clock.
    for (let i = 0; i < level.length && photos.size < max; i += 4) {
      const batch = level.slice(i, i + 4).filter((it) => !seen.has(it.id) && budget > 0);
      for (const it of batch) { seen.add(it.id); budget--; }
      const pages = await Promise.all(batch.map(async (it) => {
        try { return { it, entries: await fetchDriveFolder(it.id, fetcher) }; } catch { return { it, entries: null }; }
      }));
      for (const { it, entries } of pages) {
        if (!entries) {
          // An open?id= link that is not a folder is a single file.
          if (it.probe) add(it.id, ''); else failed++;
          continue;
        }
        if (it.probe && !entries.length) { add(it.id, ''); continue; }
        folders++;
        for (const e of entries) if (isPhotoEntry(e)) add(e.id, e.name);
        for (const e of entries) {
          if (!e.folder || seen.has(e.id) || DENY_FOLDER.test(e.name)) continue;
          const photoLine = it.photoLine || PHOTO_FOLDER.test(e.name);
          (photoLine ? preferred : rest).push({ id: e.id, photoLine, probe: false });
        }
      }
    }
    level = preferred.concat(rest);
  }
  return { photos: [...photos.values()], folders, failed };
}
