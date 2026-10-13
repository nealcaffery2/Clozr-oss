// The Drive deals folder's pure half: which folders are houses, and what a file becomes.
// Run with:  npx tsx tools/drive-tree.test.ts

import { fileRow, folderAddress, folderIdOf, galleryFolder } from '../supabase/functions/_shared/drive-tree';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};

check('folder link → id', folderIdOf('https://drive.google.com/drive/folders/1EXAMPLEfolderIdForContracts0000?usp=sharing') === '1EXAMPLEfolderIdForContracts0000');
check('bare id and junk', folderIdOf('1EXAMPLEfolderIdForContracts0000') === '1EXAMPLEfolderIdForContracts0000' && folderIdOf('not a link') === null);

const a = folderAddress('2016 Meadow lane, Richmond, Tx 77469');
check('address folder', a?.line1 === '2016 Meadow lane' && a.city === 'Richmond' && a.zip === '77469', a);
check('address folder without zip', folderAddress('311 Station St, Heath Springs, SC')?.line1 === '311 Station St');
check('zip only after the street', folderAddress('1410 Dover St. San Antonio, 78210') !== null);
for (const n of ['Wholesale Active Contracts', 'Photos', '18 Property Portfolio - Mangesh Khedikar', 'Chris', '2026 Deals'])
  check(`not a house: ${n}`, folderAddress(n) === null);

check('photos folder is gallery, comps is not', galleryFolder('Photos') && !galleryFolder('Comps') && !galleryFolder('Title docs'));

const pdf = fileRow({ id: 'f1', name: '2016 Meadow ln Title Commitment (3).pdf', mimeType: 'application/pdf', size: '553978', webViewLink: 'https://drive.google.com/file/d/f1/view' }, 11, 7, true);
check('a PDF is a file with its doc type', pdf?.kind === 'file' && pdf.category === 'title_commitment' && pdf.byte_size === 553978 && pdf.visible_to_buyers === false && pdf.source_id === 'drive:f1', pdf);
const jpg = fileRow({ id: 'p1', name: 'IMG_1.jpg', mimeType: 'image/jpeg' }, 11, 7, true);
check('a picture in the gallery is a photo', jpg?.kind === 'photo' && String(jpg.url).includes('p1'));
check('a picture under Comps is a file', fileRow({ id: 'p2', name: 'comp.jpg', mimeType: 'image/jpeg' }, 11, 7, false)?.kind === 'file');
check('folders and shortcuts are skipped', fileRow({ id: 'x', name: 'x', mimeType: 'application/vnd.google-apps.shortcut' }, 11, 7, true) === null);

console.log(failed ? `\n${failed} failed` : '\nall passed');
if (failed) process.exit(1);
