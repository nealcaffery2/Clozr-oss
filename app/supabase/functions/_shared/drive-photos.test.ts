// The Drive photo resolver.  Run:  node --experimental-strip-types supabase/functions/_shared/drive-photos.test.ts
import { driveLinks, drivePhotoUrl, isPhotoEntry, parseDriveEmbed, resolveDrivePhotos } from './drive-photos.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

const A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

eq('links: every share shape, notes text around them, one each', driveLinks(
  `Photos: https://drive.google.com/drive/folders/${A}?usp=sharing, https://drive.google.com/drive/u/0/folders/${A}
   also https://drive.google.com/file/d/${B}/view and https://drive.google.com/open?id=${C}; https://docs.google.com/spreadsheets/d/${C}/edit`,
), [{ kind: 'folder', id: A }, { kind: 'file', id: B }, { kind: 'either', id: C }]);
eq('links: mobile app folder link', driveLinks(`https://drive.google.com/drive/mobile/folders/${A}`), [{ kind: 'folder', id: A }]);
eq('links: none in a Dropbox link', driveLinks('https://www.dropbox.com/scl/fo/abc/xyz?dl=0'), []);

const entry = (id: string, inner: string) => `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info">${inner}</div></div>`;
const file = (id: string, name: string, mime: string) => entry(id,
  `<a href="https://drive.google.com/file/d/${id}/view?usp=drive_web"><div class="flip-entry-thumb"><img src="https://lh3.googleusercontent.com/x=s190"/></div>`
  + `<div class="flip-entry-list-icon"><img src="https://drive-thirdparty.googleusercontent.com/16/type/${mime}" alt=""/></div><div class="flip-entry-title">${name}</div></a>`);
const folder = (id: string, name: string) => entry(id,
  `<a href="https://drive.google.com/drive/folders/${id}"><div class="flip-entry-icon"><div aria-label="Folder" class="drive-sprite-folder-grid-shared-icon"></div></div>`
  + `<div class="flip-entry-title">${name}</div></a>`);

const page = file(A, 'IMG_1.JPG', 'image/jpeg') + file(B, 'IMG_2.MOV', 'video/quicktime') + folder(C, 'Kitchen &amp; Bath');
eq('parse: files, a video, a folder with an entity in its name', parseDriveEmbed(page), [
  { id: A, name: 'IMG_1.JPG', folder: false, mime: 'image/jpeg' },
  { id: B, name: 'IMG_2.MOV', folder: false, mime: 'video/quicktime' },
  { id: C, name: 'Kitchen & Bath', folder: true, mime: null },
]);
eq('parse: lean markup falls back to the links', parseDriveEmbed(
  `<a href="https://drive.google.com/file/d/${A}/view">x</a><a href="https://drive.google.com/drive/folders/${C}">y</a>`,
), [{ id: A, name: '', folder: false, mime: null }, { id: C, name: '', folder: true, mime: null }]);

eq('photo: an image type', isPhotoEntry({ id: A, name: 'x', folder: false, mime: 'image/heif' }), true);
eq('photo: a video is not', isPhotoEntry({ id: A, name: 'IMG.MOV', folder: false, mime: 'video/quicktime' }), false);
eq('photo: a PDF is not', isPhotoEntry({ id: A, name: 'Inspection.pdf', folder: false, mime: 'application/pdf' }), false);
eq('photo: no icon, an image name', isPhotoEntry({ id: A, name: 'front.heic', folder: false, mime: null }), true);
eq('photo: no icon, a document name', isPhotoEntry({ id: A, name: 'contract.docx', folder: false, mime: null }), false);

// A shared folder: two photos and a video at the top, a "Pics" folder, a "Comps" folder and a dated visit folder.
const ids = (n: number) => String(n).repeat(20);
const tree: Record<string, string> = {
  [ids(1)]: file(ids(2), 'front.jpg', 'image/jpeg') + file(ids(3), 'walk.mov', 'video/mp4') + folder(ids(4), '4/20/26')
    + folder(ids(5), 'Comps') + folder(ids(6), 'Pics') + file(ids(7), 'side.png', 'image/png'),
  [ids(4)]: file(ids(8), 'visit.jpg', 'image/jpeg'),
  [ids(5)]: file(ids(9), 'neighbour.jpg', 'image/jpeg'),
  [ids(6)]: file(ids(10), 'kitchen.jpg', 'image/jpeg') + folder(ids(11), 'Upstairs'),
  [ids(11)]: file(ids(12), 'bed.jpg', 'image/jpeg'),
};
const fake = ((input: string | URL | Request) => {
  const id = new URL(String(input)).searchParams.get('id') ?? '';
  return Promise.resolve(tree[id] === undefined ? new Response('', { status: 401 }) : new Response(tree[id], { status: 200 }));
}) as typeof fetch;

const walked = await resolveDrivePhotos([{ kind: 'folder', id: ids(1) }], { fetcher: fake });
eq('walk: own photos first, photo folders before others, Comps never, videos never',
  walked.photos.map((p) => p.name), ['front.jpg', 'side.png', 'kitchen.jpg', 'visit.jpg', 'bed.jpg']);
eq('walk: counts', [walked.folders, walked.failed], [4, 0]);
eq('walk: urls draw in a browser', walked.photos[0].url, drivePhotoUrl(ids(2)));
eq('walk: capped', (await resolveDrivePhotos([{ kind: 'folder', id: ids(1) }], { fetcher: fake, max: 2 })).photos.length, 2);
eq('walk: a private folder fails, a file link still lands',
  await resolveDrivePhotos([{ kind: 'folder', id: ids(99) }, { kind: 'file', id: ids(98) }], { fetcher: fake }),
  { photos: [{ id: ids(98), name: '', url: drivePhotoUrl(ids(98)) }], folders: 0, failed: 1 });
eq('walk: open?id= that is not a folder is a file',
  (await resolveDrivePhotos([{ kind: 'either', id: ids(97) }], { fetcher: fake })).photos.map((p) => p.id), [ids(97)]);

if (failed) {
  console.log(`${failed} failed`);
  throw new Error('drive-photos tests failed');
}
console.log('drive-photos ok');
