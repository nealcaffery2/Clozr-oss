// Spreadsheet files for the importer, read in the browser with no library.
//
// Partners send their submission lists as whatever their own system exports:
// .xlsx from Excel or Google, .xls from older tools, .ods from LibreOffice,
// sometimes a CSV. The importer used to take CSV only and say "save as CSV
// first", which is a step nobody on a phone can do. This turns each of those
// into rows of strings, the same shape a pasted table becomes.
//
// .xlsx / .xlsm / .ods are zip files of XML: unzipped with the browser's own
// DecompressionStream and read with a few regular expressions (no DOMParser,
// so the tests run under node). .xls is the binary BIFF8 format inside a
// compound file; the records that hold cell values are read and the rest
// (formatting, charts, macros) skipped. Dates come out as YYYY-MM-DD, numbers
// as plain digits, booleans as TRUE / FALSE, formulas as their cached value.

export type SheetRows = { sheet: string; rows: string[][] };

const TEXT_TYPES = /\.(csv|tsv|txt|tab|psv)$/i;

/** True for a file the importer reads as text (CSV and friends). */
export const isTextTable = (name: string, type = '') => TEXT_TYPES.test(name) || /^text\//.test(type);

/**
 * Every sheet in a spreadsheet file, first sheet first. Text files are not
 * handled here (parseTable reads them); anything unrecognised throws with a
 * message the importer can show.
 */
export async function readSpreadsheet(name: string, buf: ArrayBuffer): Promise<SheetRows[]> {
  const b = new Uint8Array(buf);
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return readXls(b);
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b) {
    const zip = await unzip(b);
    if (zip.has('xl/workbook.xml')) return readXlsx(zip);
    if (zip.has('content.xml')) return readOds(zip);
    if (zip.has('word/document.xml')) throw new Error('That is a Word document, not a spreadsheet.');
    throw new Error('That zip file is not a spreadsheet.');
  }
  throw new Error(`${name} is not a spreadsheet CLOZR can read. Upload .xlsx, .xls, .ods or .csv.`);
}

/** Rows as CSV text, so a spreadsheet goes through the same parser as a paste. */
export function rowsToCsv(rows: string[][]): string {
  const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(q).join(',')).join('\n');
}

/** The sheet with the most filled rows: a workbook's first tab is often a cover or a summary. */
export function bestSheet(sheets: SheetRows[]): SheetRows | null {
  let best: SheetRows | null = null; let n = -1;
  for (const s of sheets) {
    const filled = s.rows.filter((r) => r.some((v) => v.trim())).length;
    if (filled > n) { best = s; n = filled; }
  }
  return best;
}

// ---- zip ----------------------------------------------------------------------

type Zip = Map<string, () => Promise<Uint8Array>>;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function unzip(b: Uint8Array): Promise<Zip> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file is damaged (no zip directory).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: Zip = new Map();
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen)).replace(/^\/+/, '');
    p += 46 + nameLen + extraLen + commentLen;
    out.set(name, async () => {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = b.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflate(data);
      throw new Error('That file uses a compression CLOZR cannot read. Save it again as .xlsx.');
    });
  }
  return out;
}

const text = async (zip: Zip, name: string): Promise<string | null> => {
  const f = zip.get(name);
  return f ? new TextDecoder().decode(await f()) : null;
};

// ---- xml helpers ----------------------------------------------------------------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? _);
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`).exec(tag);
  return m ? unxml(m[1]) : null;
};
/** All <t> text inside a fragment (rich text runs included, phonetic runs not). */
const tText = (frag: string) => {
  let s = '';
  for (const m of frag.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) s += m[1] ? unxml(m[1]) : '';
  return s;
};

// ---- numbers and dates ----------------------------------------------------------

const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
/** A number format that shows a date or time, by its code. */
export function isDateFormat(id: number, code: string | undefined): boolean {
  if (DATE_IDS.has(id)) return true;
  if (!code) return false;
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_.|\*./g, '');
  return !/^general$/i.test(bare.trim()) && /[dmyhs]/i.test(bare);
}

/** An Excel serial day as YYYY-MM-DD (YYYY-MM-DD HH:MM when it carries a time). */
export function serialDate(n: number, mode1904 = false): string {
  const ms = Math.round((n + (mode1904 ? 1462 : 0) - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(n);
  const iso = d.toISOString();
  const frac = n % 1;
  return frac > 1e-6 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** A float as the digits a person typed: no 0.30000000000000004, no 7.1355e+9. */
export function numText(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
  return String(parseFloat(n.toPrecision(15)));
}

/** "AB12" → column 27 (0-based). */
const colOf = (ref: string) => {
  let c = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
};

function put(rows: string[][], r: number, c: number, v: string) {
  if (r < 0 || c < 0 || r > 1_000_000 || c > 16_384) return;
  while (rows.length <= r) rows.push([]);
  const row = rows[r];
  while (row.length < c) row.push('');
  row[c] = v;
}

const tidy = (rows: string[][]) => {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r));
};

// ---- xlsx -----------------------------------------------------------------------

async function readXlsx(zip: Zip): Promise<SheetRows[]> {
  const wb = (await text(zip, 'xl/workbook.xml')) ?? '';
  const rels = (await text(zip, 'xl/_rels/workbook.xml.rels')) ?? '';
  const target: Record<string, string> = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'); const t = attr(m[0], 'Target');
    if (id && t) target[id] = t.startsWith('/') ? t.slice(1) : `xl/${t}`.replace(/\/\.\//g, '/');
  }
  const mode1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wb);

  const shared: string[] = [];
  const sst = await text(zip, 'xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? tText(m[1]) : '');

  const dateXf: boolean[] = [];
  const styles = await text(zip, 'xl/styles.xml');
  if (styles) {
    const codes: Record<number, string> = {};
    for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) codes[Number(attr(m[0], 'numFmtId'))] = attr(m[0], 'formatCode') ?? '';
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
    for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
      const id = Number(attr(m[0], 'numFmtId') ?? 0);
      dateXf.push(isDateFormat(id, codes[id]));
    }
  }

  const out: SheetRows[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet ${out.length + 1}`;
    const rid = attr(m[0], 'r:id');
    const path = rid ? target[rid] : null;
    const xml = path ? await text(zip, path) : null;
    if (!xml) continue;
    const rows: string[][] = [];
    let rIdx = -1;
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      const rn = row[1] ? attr(`<row${row[1]}>`, 'r') : null;
      rIdx = rn ? Number(rn) - 1 : rIdx + 1;
      let cIdx = -1;
      for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = `<c${c[1]}>`;
        const ref = attr(head, 'r');
        cIdx = ref ? colOf(ref) : cIdx + 1;
        const body = c[2] ?? '';
        const t = attr(head, 't') ?? 'n';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let val = '';
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = tText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
        else if (t === 'str' || t === 'e') val = v != null ? unxml(v) : '';
        else if (t === 'b') val = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
        else if (t === 'd') val = v ? unxml(v).slice(0, 10) : '';
        else if (v != null && v !== '') {
          const n = Number(v);
          val = dateXf[Number(attr(head, 's') ?? 0)] ? serialDate(n, mode1904) : numText(n);
        }
        if (val !== '') put(rows, rIdx, cIdx, val);
      }
    }
    out.push({ sheet: name, rows: tidy(rows.map((r) => r ?? [])) });
  }
  return out;
}

// ---- ods ------------------------------------------------------------------------

async function readOds(zip: Zip): Promise<SheetRows[]> {
  const xml = (await text(zip, 'content.xml')) ?? '';
  const out: SheetRows[] = [];
  for (const t of xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = attr(`<x${t[1]}>`, 'table:name') ?? `Sheet ${out.length + 1}`;
    const rows: string[][] = [];
    for (const r of t[2].matchAll(/<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
      const row: string[] = [];
      for (const c of (r[2] ?? '').matchAll(/<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
        const head = `<x${c[1]}>`;
        const type = attr(head, 'office:value-type');
        let val = '';
        if (type === 'date') val = (attr(head, 'office:date-value') ?? '').replace('T', ' ').replace(/ 00:00:00$/, '').slice(0, 16);
        else if (type === 'float' || type === 'currency' || type === 'percentage') val = numText(Number(attr(head, 'office:value')));
        else if (type === 'boolean') val = attr(head, 'office:boolean-value') === 'true' ? 'TRUE' : 'FALSE';
        else {
          const paras = [...(c[2] ?? '').matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((p) =>
            unxml(p[1].replace(/<text:s\b([^>]*)\/>/g, (_, a: string) => ' '.repeat(Number(/text:c="(\d+)"/.exec(a)?.[1]) || 1)).replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<[^>]+>/g, '')));
          val = paras.join('\n');
        }
        // A run of identical cells is written once; trailing blank runs pad to 16k columns, so only filled runs repeat.
        const rep = Math.min(Number(attr(head, 'table:number-columns-repeated') ?? 1) || 1, val ? 1024 : 16_384);
        for (let i = 0; i < rep; i++) row.push(val);
      }
      while (row.length && row[row.length - 1] === '') row.pop();
      const rep = Math.min(Number(attr(`<x${r[1]}>`, 'table:number-rows-repeated') ?? 1) || 1, row.length ? 10_000 : 1);
      for (let i = 0; i < rep; i++) rows.push(row.slice());
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    out.push({ sheet: name, rows: tidy(rows) });
  }
  return out;
}

// ---- xls (BIFF8 in a compound file) ----------------------------------------------

function cfbStream(b: Uint8Array, names: string[]): Uint8Array | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ssz = 1 << dv.getUint16(30, true);
  const msz = 1 << dv.getUint16(32, true);
  const sector = (n: number) => 512 + n * ssz;
  // FAT sectors: 109 in the header, more along the DIFAT chain.
  const fatSecs: number[] = [];
  for (let i = 0; i < 109; i++) { const s = dv.getInt32(76 + i * 4, true); if (s >= 0) fatSecs.push(s); }
  let dif = dv.getInt32(68, true);
  for (let guard = 0; dif >= 0 && guard < 10_000; guard++) {
    const off = sector(dif);
    for (let i = 0; i < ssz / 4 - 1; i++) { const s = dv.getInt32(off + i * 4, true); if (s >= 0) fatSecs.push(s); }
    dif = dv.getInt32(off + ssz - 4, true);
  }
  const fat: number[] = [];
  for (const s of fatSecs) for (let i = 0; i < ssz / 4; i++) { const o = sector(s) + i * 4; fat.push(o + 4 <= b.length ? dv.getInt32(o, true) : -1); }
  const chain = (start: number, next: number[]) => {
    const out: number[] = [];
    for (let s = start; s >= 0 && out.length < next.length + 1; s = next[s] ?? -2) out.push(s);
    return out;
  };
  const readBig = (start: number, size?: number) => {
    const secs = chain(start, fat);
    const out = new Uint8Array(secs.length * ssz);
    secs.forEach((s, i) => out.set(b.subarray(sector(s), sector(s) + ssz), i * ssz));
    return size == null ? out : out.subarray(0, size);
  };
  const dir = readBig(dv.getInt32(48, true));
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const len = ddv.getUint16(o + 64, true);
    const name = String.fromCharCode(...Array.from({ length: Math.max(0, len / 2 - 1) }, (_, i) => ddv.getUint16(o + i * 2, true)));
    entries.push({ name, type: dir[o + 66], start: ddv.getInt32(o + 116, true), size: ddv.getUint32(o + 120, true) });
  }
  const hit = entries.find((e) => e.type === 2 && names.includes(e.name));
  if (!hit) return null;
  if (hit.size >= dv.getUint32(56, true)) return readBig(hit.start, hit.size);
  // A small stream lives in the mini stream, inside the root entry's data.
  const root = entries.find((e) => e.type === 5);
  if (!root) return null;
  const mini = readBig(root.start, root.size);
  const mfData = dv.getInt32(60, true) >= 0 ? readBig(dv.getInt32(60, true)) : new Uint8Array();
  const mdv = new DataView(mfData.buffer, mfData.byteOffset, mfData.byteLength);
  const mfat = Array.from({ length: mfData.length / 4 }, (_, i) => mdv.getInt32(i * 4, true));
  const secs = chain(hit.start, mfat);
  const out = new Uint8Array(secs.length * msz);
  secs.forEach((s, i) => out.set(mini.subarray(s * msz, s * msz + msz), i * msz));
  return out.subarray(0, hit.size);
}

/** Reads strings that may run on across CONTINUE records (each restarts with a flags byte). */
class Segs {
  i = 0; p = 0;
  constructor(public segs: Uint8Array[]) {}
  private cur() { while (this.i < this.segs.length && this.p >= this.segs[this.i].length) { this.i++; this.p = 0; } return this.segs[this.i]; }
  u8() { const s = this.cur(); return s ? s[this.p++] : 0; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n: number) { while (n > 0) { const s = this.cur(); if (!s) return; const k = Math.min(n, s.length - this.p); this.p += k; n -= k; } }
  chars(n: number, high: boolean): string {
    let out = '';
    while (n > 0) {
      let s = this.cur();
      if (!s) break;
      if (this.p >= s.length) continue;
      const room = s.length - this.p;
      const take = Math.min(n, high ? room >> 1 : room);
      for (let k = 0; k < take; k++) {
        out += String.fromCharCode(high ? s[this.p] | (s[this.p + 1] << 8) : s[this.p]);
        this.p += high ? 2 : 1;
      }
      n -= take;
      if (n > 0) {
        // Ran off this record: the next CONTINUE opens with a fresh flags byte.
        this.i++; this.p = 0; s = this.segs[this.i];
        if (!s) break;
        high = (s[this.p++] & 1) === 1;
      }
    }
    return out;
  }
  str(): string {
    const cch = this.u16(); const flags = this.u8();
    const runs = flags & 8 ? this.u16() : 0;
    const ext = flags & 4 ? this.u32() : 0;
    const s = this.chars(cch, (flags & 1) === 1);
    this.skip(runs * 4 + ext);
    return s;
  }
}

function xlsString(d: Uint8Array, o: number, wide: boolean): string {
  const n = wide ? d[o] | (d[o + 1] << 8) : d[o];
  let p = o + (wide ? 2 : 1);
  const high = (d[p++] & 1) === 1;
  let s = '';
  for (let k = 0; k < n && p < d.length; k++) { s += String.fromCharCode(high ? d[p] | (d[p + 1] << 8) : d[p]); p += high ? 2 : 1; }
  return s;
}

const rk = (v: number) => {
  const div = v & 1; const int = v & 2;
  let n: number;
  if (int) n = v >> 2;
  else { const buf = new DataView(new ArrayBuffer(8)); buf.setUint32(4, v & 0xfffffffc, true); n = buf.getFloat64(0, true); }
  return div ? n / 100 : n;
};

function readXls(b: Uint8Array): SheetRows[] {
  const wb = cfbStream(b, ['Workbook', 'Book']);
  if (!wb) throw new Error('That .xls has no workbook inside. Open it in Excel and save as .xlsx.');
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const recs: { type: number; data: Uint8Array; off: number }[] = [];
  for (let p = 0; p + 4 <= wb.length;) {
    const type = dv.getUint16(p, true); const len = dv.getUint16(p + 2, true);
    recs.push({ type, data: wb.subarray(p + 4, p + 4 + len), off: p });
    p += 4 + len;
  }
  const bof = recs[0];
  if (!bof || bof.type !== 0x0809) throw new Error('That .xls is from Excel 95 or older. Open it in Excel and save as .xlsx.');
  if (new DataView(bof.data.buffer, bof.data.byteOffset).getUint16(0, true) !== 0x0600) throw new Error('That .xls is from Excel 95 or older. Open it in Excel and save as .xlsx.');
  if (recs.some((r) => r.type === 0x002f)) throw new Error('That .xls is password protected. Remove the password and upload it again.');

  const sheets: { name: string; off: number }[] = [];
  const sst: string[] = [];
  const formats: Record<number, string> = {};
  const xfFmt: number[] = [];
  let mode1904 = false;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]; const d = r.data; const rv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (r.type === 0x0085) sheets.push({ off: rv.getUint32(0, true), name: d[5] === 0 ? xlsString(d, 6, false) : '' });
    else if (r.type === 0x0022) mode1904 = rv.getUint16(0, true) === 1;
    else if (r.type === 0x041e) formats[rv.getUint16(0, true)] = xlsString(d, 2, true);
    else if (r.type === 0x00e0) xfFmt.push(rv.getUint16(2, true));
    else if (r.type === 0x00fc) {
      const segs = [d.subarray(8)];
      for (let k = i + 1; k < recs.length && recs[k].type === 0x003c; k++) segs.push(recs[k].data);
      const total = rv.getUint32(4, true);
      const reader = new Segs(segs);
      for (let k = 0; k < total; k++) sst.push(reader.str());
    } else if (r.type === 0x000a) break;
  }
  const isDate = (xf: number) => { const f = xfFmt[xf] ?? 0; return isDateFormat(f, formats[f]); };
  const num = (n: number, xf: number) => (isDate(xf) ? serialDate(n, mode1904) : numText(n));

  const byOff = new Map(recs.map((r, i) => [r.off, i]));
  return sheets.map((s) => {
    const rows: string[][] = [];
    let i = byOff.get(s.off);
    if (i == null) return { sheet: s.name, rows };
    let pendingFormula: [number, number] | null = null;
    for (i++; i < recs.length; i++) {
      const r = recs[i]; const d = r.data;
      if (r.type === 0x000a) break;
      if (d.length < 6 && r.type !== 0x0207) continue;
      const rv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const row = d.length >= 4 ? rv.getUint16(0, true) : 0; const col = d.length >= 4 ? rv.getUint16(2, true) : 0;
      switch (r.type) {
        case 0x00fd: put(rows, row, col, sst[rv.getUint32(6, true)] ?? ''); break;
        case 0x0203: put(rows, row, col, num(rv.getFloat64(6, true), rv.getUint16(4, true))); break;
        case 0x027e: put(rows, row, col, num(rk(rv.getInt32(6, true)), rv.getUint16(4, true))); break;
        case 0x00bd: {
          const last = rv.getUint16(d.length - 2, true);
          for (let c = col, p = 4; c <= last && p + 6 <= d.length - 2; c++, p += 6) put(rows, row, c, num(rk(rv.getInt32(p + 2, true)), rv.getUint16(p, true)));
          break;
        }
        case 0x0204: put(rows, row, col, xlsString(d, 6, true)); break;
        case 0x0205: if (d[7] === 0) put(rows, row, col, d[6] ? 'TRUE' : 'FALSE'); break;
        case 0x0006: {
          if (rv.getUint16(12, true) !== 0xffff) put(rows, row, col, num(rv.getFloat64(6, true), rv.getUint16(4, true)));
          else if (d[6] === 0) pendingFormula = [row, col];
          else if (d[6] === 1) put(rows, row, col, d[8] ? 'TRUE' : 'FALSE');
          break;
        }
        case 0x0207: if (pendingFormula) { put(rows, pendingFormula[0], pendingFormula[1], xlsString(d, 0, true)); pendingFormula = null; } break;
      }
    }
    return { sheet: s.name, rows: tidy(rows.map((x) => x ?? [])) };
  });
}
