import assert from 'node:assert/strict';
import { canonicalPhotos, collectPhotos, demoGallery, isGalleryImage, photoIndexOf, photoKey, photosLineUrls, urlsIn } from '../lib/house-photos';

assert.deepEqual(collectPhotos(['', '—', ' a ', 'a', 'b', null, 'a']), ['a', 'b']);
assert.deepEqual(demoGallery('front', ['k', 'b', 'l'], 1), ['front', 'b', 'l', 'k']);
assert.deepEqual(demoGallery('', ['k'], 0), []);

const compr = 'https://thecompr.com/api/photo?lead_id=1&pos=0&token=t';
const compr2 = 'https://thecompr.com/api/photo?lead_id=1&pos=0&token=other';
const link = 'https://cdn.example/front.jpg';
assert.equal(photoKey(compr), photoKey(compr2), 'COMPR tokens do not make a new photo');
assert.deepEqual(
  collectPhotos([compr, compr2, link]),
  [compr, link],
  'same COMPR shot with a new token is one tile',
);
assert.deepEqual(
  canonicalPhotos([{ url: compr, source: 'compr' }, { url: link, source: 'link' }, { url: compr2, source: 'compr' }]),
  [compr, link],
  'COMPR leads, durable links ride along once, tokens dedupe',
);
assert.deepEqual(
  canonicalPhotos([{ url: link, source: 'link' }, { url: 'https://drive.example/2.jpg', source: 'link' }]),
  [link, 'https://drive.example/2.jpg'],
  'photo links are the gallery when there is no COMPR report',
);
const p = (pos: number, token = 't') => `https://thecompr.com/api/photo?lead_id=1&pos=${pos}&token=${token}`;
assert.deepEqual(
  canonicalPhotos([
    { url: p(2), source: 'compr', position: 2 },
    { url: p(0), source: 'compr', position: 0 },
    { url: p(5), source: 'compr', position: 5, cover: true },
  ]),
  [p(5), p(0), p(2)],
  'the front of the house leads, then COMPR order',
);
assert.deepEqual(
  canonicalPhotos([{ url: p(0), source: 'compr', position: 0 }, { url: p(3), source: 'compr', position: 3 }, { url: p(3, 'x'), source: null, cover: true }]),
  [p(3, 'x'), p(0)],
  'the saved hero is the front; same COMPR pos with a new token is one tile',
);
assert.deepEqual(
  canonicalPhotos([{ url: p(0), source: 'compr', position: 0 }, { url: link, source: 'link', cover: true }]),
  [link, p(0)],
  'a link picked as the front still leads a COMPR set',
);
const g = (n: number) => `https://lh3.googleusercontent.com/d/file${n}=w1600`;
assert.deepEqual(
  canonicalPhotos([
    { url: g(2), source: 'drive', position: 2 },
    { url: g(0), source: 'drive', position: 0, cover: true },
    { url: g(1), source: 'drive', position: 1 },
  ]),
  [g(0), g(1), g(2)],
  'a Drive folder keeps its own order, which arrives as position, not as created_at',
);
assert.equal(isGalleryImage(compr), true);
assert.equal(isGalleryImage(link), true);
assert.equal(isGalleryImage('https://drive.google.com/drive/folders/abc'), false, 'a Drive folder is a link, not a tile');
assert.equal(isGalleryImage('https://www.zillow.com/homedetails/1-Main'), false);
assert.deepEqual(
  urlsIn('see https://drive.google.com/drive/folders/abc, and https://x.com/a.jpg).'),
  ['https://drive.google.com/drive/folders/abc', 'https://x.com/a.jpg'],
);
assert.deepEqual(
  photosLineUrls('Notes\nPhotos: https://dropbox.com/scl/fo/1 https://photos.example/2\nOther: https://nope.example'),
  ['https://dropbox.com/scl/fo/1', 'https://photos.example/2'],
);

// An upload is signed again each time the album loads: same file, one tile.
const signed = (t: string) => `https://abc.supabase.co/storage/v1/object/sign/deal-files/ws/1/deals/9/123-IMG_0001?token=${t}`;
assert.equal(photoKey(signed('a')), photoKey(signed('b')), 'a re-signed upload is the same photo');
assert.deepEqual(collectPhotos([signed('a'), signed('b')]), [signed('a')]);
assert.equal(isGalleryImage(signed('a')), true, 'an upload with no extension is still a photo');
assert.equal(isGalleryImage('https://x.example/a.HEIF'), true);
// The slideshow keeps its place when the full album loads with new tokens.
assert.equal(photoIndexOf([link, p(1, 'new'), p(2, 'new')], p(2, 'old')), 2, 'a rotated COMPR token keeps the photo in view');
assert.equal(photoIndexOf([link, signed('b')], signed('a')), 1);
assert.equal(photoIndexOf([link], 'https://gone.example/x.jpg'), 0, 'a photo that left the set falls back to the first');
console.log('house-photos ok');
