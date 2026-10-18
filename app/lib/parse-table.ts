// CSV / TSV / pasted-spreadsheet parser. No network, so a worker can import it
// without pulling the Supabase client in with it.

export type Table = { headers: string[]; rows: string[][]; delimiter: string };

/**
 * Handles quoted fields with embedded commas, quotes and newlines. Picks the
 * delimiter that splits the first line into the most columns, which is what a
 * paste from Excel or Sheets (tabs) and a real CSV (commas) both want.
 */
export function parseTable(text: string): Table {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n').find((l) => l.trim()) ?? '';
  // Count candidates outside quoted fields, so a quoted header like
  // "Notes; misc" can't outvote the real delimiter.
  const unquoted = firstLine.replace(/"(?:[^"]|"")*"?/g, '');
  const delimiter = [',', '\t', ';', '|'].map((d) => ({ d, n: unquoted.split(d).length }))
    .sort((a, b) => b.n - a.n)[0]?.d ?? ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let fieldStart = true; // a quote only opens a quoted field at its first character
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && fieldStart) {
      quoted = true;
    } else if (c === delimiter) {
      row.push(cell); cell = ''; fieldStart = true; continue;
    } else if (c === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; fieldStart = true; continue;
    } else cell += c;
    fieldStart = false;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  const headers = (nonEmpty[0] ?? []).map((h) => h.trim());
  const body = nonEmpty.slice(1).map((r) => headers.map((_, i) => (r[i] ?? '').trim()));
  return { headers, rows: body, delimiter };
}
