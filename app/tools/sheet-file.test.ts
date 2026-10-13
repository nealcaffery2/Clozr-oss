// Spreadsheet files for the importer: .xlsx and .ods built here as real zips
// (deflated with node's zlib, read back with the browser's DecompressionStream),
// plus the number and date rules. .xls was checked against xlwt output by hand;
// its reader is the same put/numText/serialDate path.
// Run: npx tsx tools/sheet-file.test.ts
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { bestSheet, isDateFormat, numText, readSpreadsheet, rowsToCsv, serialDate } from '../lib/sheet-file';
import { parseTable } from '../lib/import';

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

/** A minimal zip: deflated entries, one central directory. */
function zip(files: Record<string, string>): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Buffer[] = []; const central: Buffer[] = [];
  let off = 0;
  for (const [name, body] of Object.entries(files)) {
    const n = Buffer.from(enc.encode(name)); const raw = Buffer.from(enc.encode(body)); const data = deflateRawSync(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); central.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const all = Buffer.concat([...locals, cd, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const XLSX = {
  'xl/workbook.xml': '<workbook><sheets><sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="Offerpad &amp; Co" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Address</t></si><si><t>Phone</t></si><si><r><t>12 </t></r><r><rPr/><t xml:space="preserve">Oak &amp; Elm</t></r></si><si><t>Submitted</t></si></sst>',
  'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>read me</t></is></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>7135550192</v></c><c r="C2" s="2"><v>185000</v></c><c r="D2" s="1"><v>46295</v></c></row>'
    + '<row r="4"><c r="A4" t="str"><f>A2</f><v>12 Oak &amp; Elm</v></c><c r="B4" t="b"><v>1</v></c></row>'
    + '</sheetData></worksheet>',
};

test('xlsx: the busiest tab, shared and inline strings, gaps kept, dates and numbers as typed', async () => {
  const sheets = await readSpreadsheet('subs.xlsx', zip(XLSX));
  assert.deepEqual(sheets.map((s) => s.sheet), ['Notes', 'Offerpad & Co']);
  const s = bestSheet(sheets)!;
  assert.equal(s.sheet, 'Offerpad & Co');
  assert.deepEqual(s.rows[0], ['Address', 'Phone', '', 'Submitted']);
  assert.deepEqual(s.rows[1], ['12 Oak & Elm', '7135550192', '185000', '2026-09-30']);
  assert.deepEqual(s.rows[2], ['', '', '', '']);
  assert.deepEqual(s.rows[3], ['12 Oak & Elm', 'TRUE', '', '']);
});

test('xlsx rows go through the same parser as a paste', async () => {
  const s = bestSheet(await readSpreadsheet('subs.xlsx', zip(XLSX)))!;
  const t = parseTable(rowsToCsv(s.rows));
  assert.deepEqual(t.headers, ['Address', 'Phone', '', 'Submitted']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][0], '12 Oak & Elm');
});

test('ods: repeated cells and rows, typed values, trailing blanks dropped', async () => {
  const content = '<office:document-content><office:body><office:spreadsheet><table:table table:name="Subs">'
    + '<table:table-row><table:table-cell office:value-type="string"><text:p>Address</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2" office:value-type="string"><text:p>X</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16380"/></table:table-row>'
    + '<table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="string"><text:p>9<text:s text:c="2"/>Pine</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="0.1"/><table:table-cell office:value-type="date" office:date-value="2026-09-30T00:00:00"/></table:table-row>'
    + '<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>'
    + '</table:table></office:spreadsheet></office:body></office:document-content>';
  const [s] = await readSpreadsheet('subs.ods', zip({ 'content.xml': content, mimetype: 'application/vnd.oasis.opendocument.spreadsheet' }));
  assert.equal(s.rows.length, 3);
  assert.deepEqual(s.rows[0], ['Address', 'X', 'X']);
  assert.deepEqual(s.rows[1], ['9  Pine', '0.1', '2026-09-30']);
  assert.deepEqual(s.rows[2], s.rows[1]);
});

test('anything else is refused with a reason', async () => {
  await assert.rejects(readSpreadsheet('a.pdf', new TextEncoder().encode('%PDF-1.7').buffer as ArrayBuffer), /not a spreadsheet/);
  await assert.rejects(readSpreadsheet('a.docx', zip({ 'word/document.xml': '<w/>' })), /Word document/);
});

test('numbers read the way a person typed them', () => {
  assert.equal(numText(7135550192), '7135550192');
  assert.equal(numText(0.1 + 0.2), '0.3');
  assert.equal(numText(170236.5), '170236.5');
  assert.equal(numText(NaN), '');
});

test('date formats by id and by code; currency and General are not dates', () => {
  assert.ok(isDateFormat(14, undefined));
  assert.ok(isDateFormat(164, 'mm/dd/yyyy'));
  assert.ok(isDateFormat(170, '[$-409]d-mmm-yy;@'));
  assert.ok(!isDateFormat(165, '"$"#,##0'));
  assert.ok(!isDateFormat(0, 'General'));
  assert.ok(!isDateFormat(171, '#,##0.00 "days"'));
  assert.equal(serialDate(46295), '2026-09-30');
  assert.equal(serialDate(46295.5), '2026-09-30 12:00');
  assert.equal(serialDate(44833, true), '2026-09-30');
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
}
console.log(`sheet-file: ${passed} passed`);
