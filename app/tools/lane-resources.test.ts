// Lane resources (migration 400, _shared/resource-text.ts): how a doc is cut
// into searchable sections, Word text, titles and categories for imports,
// Drive links, the demo's local search and the [[match]] snippets, the
// importer's folder plan, and the demo stub answering from a doc.
// Run: npx tsx tools/lane-resources.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHUNK_MAX, DEFAULT_CATEGORIES, chunkText, cleanTitle, docxText, driveFileId, fixMojibake, guessCategory, normalizeText, parseImported, PINNED_CATEGORY,
  searchLocal, snippetOf, snippetParts, terms, titleFromFile, titleFromMarkdown,
} from '../supabase/functions/_shared/resource-text';
import { planFolder } from '../scripts/import-resources';
import { SAMPLE_RESOURCES } from '../lib/resources-sample';
import { slopFindings } from '../supabase/functions/_shared/no-ai-slop';

let passed = 0;
const pending: Promise<void>[] = [];
const test = (name: string, fn: () => void | Promise<void>) => {
  const fail = (e: unknown) => { console.error('FAIL', name); throw e; };
  try {
    const r = fn();
    if (r instanceof Promise) pending.push(r.then(() => { passed++; }, fail)); else passed++;
  } catch (e) { fail(e); }
};

test('text is normalised: CRLF, trailing spaces, runs of blank lines, NULs', () => {
  assert.equal(normalizeText('a  \r\nb\u0000\r\n\r\n\r\n\r\nc  '), 'a\nb\n\nc');
  assert.equal(normalizeText(''), '');
});

test('headings start sections and ride along as a path', () => {
  const md = '# Title company vetting\n\nIntro line.\n\n## Before the first file\n\n- Ask turn time.\n- Ask underwriter.\n\n### Wire safety\n\nCall to confirm.\n\n## Red flags\n\nNo underwriter named.';
  const c = chunkText('Title company vetting', md);
  assert.deepEqual(c.map((x) => x.heading), [
    'Title company vetting',
    'Title company vetting > Before the first file',
    'Title company vetting > Before the first file > Wire safety',
    'Title company vetting > Red flags',
  ]);
  assert.equal(c[1].body, '- Ask turn time.\n- Ask underwriter.');
  assert.deepEqual(c.map((x) => x.ord), [0, 1, 2, 3]);
});

test('a heading sharing a block with its first paragraph, and bold headings', () => {
  const c = chunkText('Doc', '# **Phase 1: Title**\nFirst line under it.');
  assert.equal(c.length, 1);
  assert.equal(c[0].heading, 'Doc > Phase 1: Title');
  assert.equal(c[0].body, 'First line under it.');
});

test('paragraphs pack up to the limit and long ones split on sentences', () => {
  const para = 'Sentence one is here. '.repeat(30).trim(); // ~660 chars
  const c = chunkText('Doc', [para, para, para].join('\n\n'));
  assert.ok(c.length >= 2);
  for (const x of c) assert.ok(x.body.length <= CHUNK_MAX, `section of ${x.body.length}`);
  const huge = 'Word '.repeat(1000).trim() + '.';
  const h = chunkText('Doc', huge);
  assert.ok(h.length >= 3);
  for (const x of h) assert.ok(x.body.length <= CHUNK_MAX);
  assert.deepEqual(chunkText('Doc', '   '), []);
});

test('Word: paragraphs, heading styles, lists, tabs and entities', () => {
  const xml = '<w:document><w:body>'
    + '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>TC Handbook</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">Day </w:t></w:r><w:r><w:t>0</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Send it to title &amp; the buyer.</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Second</w:t><w:tab/><w:t>x</w:t></w:r></w:p>'
    + '<w:p/>'
    + '</w:body></w:document>';
  assert.equal(docxText(xml), '# TC Handbook\n\n## Day 0\n\nSend it to title & the buyer.\n\n- First\n- Second\tx');
});

test('titles from file names, H1s and shouting exports', () => {
  assert.equal(titleFromFile('tc-bible_v3.md'), 'Tc bible v3');
  assert.equal(titleFromFile(''), 'Untitled');
  assert.equal(titleFromMarkdown('intro\n# **The Bible**\n'), 'The Bible');
  assert.equal(titleFromMarkdown('no heading'), null);
  assert.equal(cleanTitle('📸 INVESTOR PHOTO INSTRUCTIONS – ACME HOMES.pdf'), 'Investor photo instructions – Acme Homes');
  assert.equal(cleanTitle('AcmeHomes_TC_Checklists.docx.pdf'), 'Acme Homes TC Checklists');
  assert.equal(cleanTitle('seller thank you tc email template'), 'Seller thank you TC email template');
  assert.equal(cleanTitle('Closing Script.docx'), 'Closing Script');
});

test('categories: the most specific hint wins', () => {
  const g = (t: string) => guessCategory(t, '');
  assert.equal(g('TC Training'), 'TC Bible');
  assert.equal(g('Acme Homes TC Handbook'), 'TC Bible');
  assert.equal(g('Lane TC Prompt'), 'Training');
  assert.equal(g('Acme Homes TC Checklists'), 'SOPs & checklists');
  assert.equal(g('TC Into Script'), 'Scripts');
  assert.equal(g('TC Title Handoff Template'), 'Title companies');
  assert.equal(g('Title company vetting checklist'), 'Title companies');
  assert.equal(g('Text Templates'), 'Templates');
  assert.equal(g('Contract to Closing Workflow V2'), 'SOPs & checklists');
  assert.equal(g('Video Walkthrough for Field Agent'), 'Field agents');
  assert.equal(g('Quarterly notes'), 'Other');
  assert.equal(guessCategory('Quarterly notes', 'This is our closing script for sellers.'), 'Scripts');
  assert.equal(guessCategory('Scripts', '', ['Scripts', 'Misc']), 'Scripts');
  assert.equal(guessCategory('Nothing', '', ['A', 'B']), 'B');
  assert.equal(DEFAULT_CATEGORIES.length, 8);
  assert.equal(DEFAULT_CATEGORIES[0], PINNED_CATEGORY);
});

test('Drive links: Docs, files, open?id, bare ids, and junk', () => {
  assert.equal(driveFileId('https://docs.google.com/document/d/1ExampleDriveFileId111111111111111111111111/edit?usp=drivesdk'), '1ExampleDriveFileId111111111111111111111111');
  assert.equal(driveFileId('https://drive.google.com/file/d/1ExampleDriveFolderId22222222222/view'), '1ExampleDriveFolderId22222222222');
  assert.equal(driveFileId('https://docs.google.com/spreadsheets/u/0/d/abcdefghijkl12345/edit'), 'abcdefghijkl12345');
  assert.equal(driveFileId('https://drive.google.com/open?id=abcdefghijkl12345'), 'abcdefghijkl12345');
  assert.equal(driveFileId('1ExampleDriveFolderId22222222222'), '1ExampleDriveFolderId22222222222');
  assert.equal(driveFileId('https://example.com/doc'), null);
  assert.equal(driveFileId(''), null);
});

test('an exported Drive doc: header becomes title and link, body is the rest', () => {
  const raw = '# 📸 INVESTOR PHOTO INSTRUCTIONS – ACME HOMES.pdf\n\nSource: Google Drive file id `1ExampleDriveFileId33333333333333`\nLink: https://drive.google.com/file/d/1ExampleDriveFileId33333333333333/view?usp=drivesdk\n\n---\n\n## Exterior\n\nShoot all four sides.';
  const d = parseImported('INVESTOR-PHOTO.pdf.md', raw);
  assert.equal(d.title, 'Investor photo instructions – Acme Homes');
  assert.equal(d.driveUrl, 'https://drive.google.com/file/d/1ExampleDriveFileId33333333333333/view?usp=drivesdk');
  assert.equal(d.driveId, '1ExampleDriveFileId33333333333333');
  assert.equal(d.body, '## Exterior\n\nShoot all four sides.');
  // A plain Markdown file keeps its text.
  const p = parseImported('notes.md', '# Notes\n\nOne.\n\n---\n\nTwo.');
  assert.equal(p.title, 'Notes');
  assert.equal(p.driveUrl, null);
  assert.equal(p.body, '# Notes\n\nOne.\n\n---\n\nTwo.');
});

test('mojibake from a Latin-1 round trip is repaired, real accents are not', () => {
  const broken = (s: string) => [...new TextEncoder().encode(s)].map((b) => String.fromCharCode(b)).join('');
  assert.equal(fixMojibake(broken('# 🔁 Contract to Closing')), '# 🔁 Contract to Closing');
  assert.equal(fixMojibake('donâ€™t'), 'don’t');
  assert.equal(fixMojibake('Café, señor, Zürich'), 'Café, señor, Zürich');
  assert.equal(fixMojibake('plain'), 'plain');
  const c = chunkText('Contract to Closing Workflow V2', '# 🔁 Contract to Closing Workflow V2\n\n## 2. Post-Execution Handoff\n\nSend it.');
  assert.equal(c[0].heading, 'Contract to Closing Workflow V2 > 2. Post-Execution Handoff');
});

test('the importer plans a folder: titles, categories, links, map overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-res-'));
  writeFileSync(join(dir, 'TC-Into-Script.md'), '# TC Into Script\n\nSource: Google Drive file id `1ExampleDriveFileId000000000000000000000000`\nLink: https://docs.google.com/document/d/1ExampleDriveFileId000000000000000000000000/edit\n\n---\n\nHi, this is the TC.');
  writeFileSync(join(dir, 'misc.md'), 'Just some text.');
  writeFileSync(join(dir, 'TC-Training.md'), '# TC Training\n\nSource: Google Drive file id `1ExampleDriveFileId111111111111111111111111`\nLink: https://docs.google.com/document/d/1ExampleDriveFileId111111111111111111111111/edit\n\n---\n\n# Phase 1\n\nRead the commitment.');
  writeFileSync(join(dir, 'skip.txt'), 'not markdown');
  const plan = planFolder(dir, { misc: 'SOPs & checklists' });
  assert.deepEqual(plan.map((p) => [p.file, p.title, p.category, p.pinned, p.chunks]), [
    ['TC-Into-Script.md', 'TC Into Script', 'Scripts', false, 1],
    ['TC-Training.md', 'TC Training', 'TC Bible', true, 1],
    ['misc.md', 'Misc', 'SOPs & checklists', false, 1],
  ]);
  assert.equal(plan[0].driveUrl, 'https://docs.google.com/document/d/1ExampleDriveFileId000000000000000000000000/edit');
  assert.equal(plan[0].body, 'Hi, this is the TC.');
});

test('terms drop stop words and stem lightly', () => {
  assert.deepEqual(terms('What do we check when vetting a title company?'), ['check', 'vet', 'title', 'compani']);
  assert.deepEqual(terms('companies'), terms('company'));
  assert.deepEqual(terms(''), []);
});

const docs = SAMPLE_RESOURCES.map((r) => ({ id: r.id, title: r.title, category: r.category, body: r.body }));

test('local search finds the vetting checklist for a vetting question', () => {
  const hits = searchLocal(docs, 'What do we check when vetting a title company?');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].resourceId, 'sample-title-vetting');
  assert.ok(hits[0].rank >= 0.3, `rank ${hits[0].rank}`);
  const emd = searchLocal(docs, 'earnest money receipt late');
  assert.equal(emd[0].resourceId, 'sample-tc-bible');
  assert.match(emd[0].heading, /earnest money/i);
  assert.deepEqual(searchLocal(docs, 'the and of'), []);
  assert.deepEqual(searchLocal(docs, 'zebra giraffe'), []);
});

test('snippets mark the matched words the way ts_headline does', () => {
  const s = snippetOf('Ask for the receipt; a wire confirmation from the buyer is not a receipt.', terms('receipt'));
  assert.ok(s.includes('[[receipt]]'));
  assert.deepEqual(snippetParts('the [[title]] company'), [
    { text: 'the ', hit: false }, { text: 'title', hit: true }, { text: ' company', hit: false },
  ]);
  assert.deepEqual(snippetParts(''), []);
  const long = snippetOf('word '.repeat(200) + 'needle ' + 'word '.repeat(200), ['needl']);
  assert.ok(long.startsWith('…') && long.endsWith('…'));
  assert.ok(long.includes('[[needle]]'));
});

test('the sample docs say they are samples and carry no slop', () => {
  for (const r of SAMPLE_RESOURCES) {
    assert.match(r.body, /Sample content/);
    assert.match(r.title, /sample/i);
    assert.deepEqual(slopFindings(r.body).map((f) => f.pattern), [], r.title);
  }
});

test('the demo stub answers a vetting question from the checklist and cites it', async () => {
  const { stubFromResources } = await import('../lib/lane');
  const r = stubFromResources('What do we check when vetting a title company?', false);
  assert.ok(r);
  assert.equal(r!.refs[0].target, 'resource');
  assert.equal(r!.refs[0].resourceId, 'sample-title-vetting');
  assert.match(r!.answer, /Title company vetting checklist/);
  // With a file open, a file question stays with the file.
  assert.equal(stubFromResources('Review the title commitment on this file', true), null);
});

void Promise.all(pending).then(() => console.log(`lane-resources: ${passed} passed`));
