/**
 * Lane resources: the pure text half, shared by the lane-resources edge
 * function, the import script (scripts/import-resources.ts), the panel
 * (lib/resources.ts) and the /demo sample. No Deno or browser APIs here, so
 * all four use the same chunking and tools/resources.test.ts covers it.
 *
 * A doc's text is cut into sections of about CHUNK_MAX characters along its
 * own structure: Markdown headings start a section (the heading path rides
 * along, "Title company vetting > Red flags"), paragraphs are packed into a
 * section until it is full, and a paragraph longer than that is split on
 * sentences. Postgres searches those sections (search_resources, migration
 * 400); the demo, which has no database, scores them here with searchLocal.
 */

export const CHUNK_MAX = 1400;

export type Chunk = { ord: number; heading: string; body: string };

/** The default shelves (resource_categories_ensure seeds the same list). */
export const DEFAULT_CATEGORIES = ['TC Bible', 'Training', 'Scripts', 'SOPs & checklists', 'Templates', 'Title companies', 'Field agents', 'Other'] as const;

/**
 * The TC Bible is a set (TC Training and the Acme Homes TC Handbook): the
 * importer pins whatever it files there so the set sits at the top.
 */
export const PINNED_CATEGORY = 'TC Bible';

/** Unix newlines, no trailing spaces, at most one blank line in a row, no NULs. */
export function normalizeText(raw: string): string {
  return String(raw ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Split text over `max` on sentence ends, then hard. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (s.length > max) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + 1 + s.length > max) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Cut a doc into searchable sections. `title` heads every section's heading
 * path so a hit on the doc's name finds it; a top heading equal to the title
 * is not repeated.
 */
export function chunkText(title: string, text: string, max = CHUNK_MAX): Chunk[] {
  const body = normalizeText(text);
  const name = String(title ?? '').trim();
  const chunks: Chunk[] = [];
  const path: { level: number; text: string }[] = [];
  let paras: string[] = [];
  let size = 0;
  const headingOf = () => [name, ...path.map((h) => h.text).filter((h) => h.toLowerCase() !== name.toLowerCase())].filter(Boolean).join(' > ');
  const flush = () => {
    if (paras.length) chunks.push({ ord: chunks.length, heading: headingOf(), body: paras.join('\n\n') });
    paras = []; size = 0;
  };
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n');
    // A heading can open a block that also holds its first paragraph.
    while (lines.length && HEADING.test(lines[0])) {
      const m = HEADING.exec(lines.shift()!)!;
      flush();
      const level = m[1].length;
      while (path.length && path[path.length - 1].level >= level) path.pop();
      // Emoji bullets in headings ("🔁 Contract to Closing") stay in the text, not the path.
      path.push({ level, text: m[2].replace(/\*\*|__|[*`]/g, '').replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/\s+/g, ' ').trim() });
    }
    const rest = lines.join('\n').trim();
    if (!rest) continue;
    for (const piece of splitLong(rest, max)) {
      if (size && size + 2 + piece.length > max) flush();
      paras.push(piece); size += piece.length + 2;
    }
  }
  flush();
  return chunks;
}

/** "tc-bible_v3.md" → "Tc bible v3"; keeps a name that is already readable. */
export function titleFromFile(name: string): string {
  const base = String(name ?? '').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return 'Untitled';
  return base[0].toUpperCase() + base.slice(1);
}

/**
 * A readable title from an exported file name or heading:
 * "📸 INVESTOR PHOTO INSTRUCTIONS – ACME HOMES.pdf" → "Investor photo instructions – Acme Homes",
 * "AcmeHomes_TC_Checklists.docx.pdf" → "AcmeHomes TC Checklists".
 */
export function cleanTitle(raw: string): string {
  let s = String(raw ?? '')
    .replace(/[*_`]{2,}/g, '')
    .replace(/(\.(docx?|pdf|md|markdown|txt|gdoc))+\s*$/i, '')
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Shouting titles read as sentence case; short all-caps words (TC, LLC) stay.
  if (s.length > 6 && s === s.toUpperCase() && /[A-Z]{3}/.test(s)) {
    s = s.toLowerCase().replace(/\bacme homes\b/g, 'Acme Homes');
  }
  s = s.replace(/\bAcmeHomes\b/g, 'Acme Homes').replace(/\btc\b/gi, 'TC').replace(/^\p{Ll}/u, (m) => m.toUpperCase());
  return s || 'Untitled';
}

/**
 * Undo UTF-8 read as Latin-1 ("ðŸ“¸" → "📸", "â€™" → "’"), which exports
 * that passed through a Windows tool carry. Only a run that decodes as valid
 * UTF-8 is replaced, so real accented text is left alone.
 */
export function fixMojibake(s: string): string {
  if (!/[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]/.test(s)) return s;
  // Windows-1252 puts these characters on bytes 0x80–0x9F.
  const CP1252: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89,
    0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  };
  const byteOf = (c: string) => { const n = c.charCodeAt(0); return n <= 0xff ? n : CP1252[n] ?? -1; };
  const dec = new TextDecoder('utf-8', { fatal: true });
  return s.replace(/[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]{1,3}/g, (run) => {
    const bytes = [...run].map(byteOf);
    if (bytes.some((b) => b < 0)) return run;
    try { return dec.decode(new Uint8Array(bytes)); } catch { return run; }
  });
}

export type ImportedDoc ={ title: string; body: string; driveUrl: string | null; driveId: string | null };

/**
 * One exported Markdown doc. Files collected from Drive start with a header:
 *
 *   # Title
 *   Source: Google Drive file id `abc…`
 *   Link: https://docs.google.com/document/d/abc…/edit
 *   ---
 *
 * The header becomes the title and the source link; the body is the rest. A
 * plain Markdown file (no header) keeps its text, titled by its H1 or file name.
 */
export function parseImported(fileName: string, raw: string): ImportedDoc {
  const text = normalizeText(fixMojibake(raw));
  const head = text.slice(0, 1200);
  const link = /^Link:\s*(\S+)/m.exec(head)?.[1] ?? null;
  const id = /^Source:.*?`([A-Za-z0-9_-]{10,})`/m.exec(head)?.[1] ?? (link ? driveFileId(link) : null);
  const h1 = titleFromMarkdown(head);
  let body = text;
  if (link || id) {
    const rule = /^-{3,}\s*$/m.exec(text);
    if (rule && rule.index < 1200) body = text.slice(rule.index + rule[0].length).trim();
    else body = text.replace(/^#\s+.*\n/, '').replace(/^Source:.*\n?/m, '').replace(/^Link:.*\n?/m, '').trim();
  }
  return {
    title: cleanTitle(h1 ?? titleFromFile(fileName)),
    body,
    driveUrl: link ?? (id ? `https://drive.google.com/file/d/${id}/view` : null),
    driveId: id,
  };
}

/** The first Markdown H1, when a doc has one. */
export function titleFromMarkdown(text: string): string | null {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(String(text ?? ''));
  return m ? m[1].replace(/\*\*|__|[*`]/g, '').trim() || null : null;
}

// First match wins, most specific first: "TC Title Handoff Template" is a
// title doc, "TC Into Script" a script, "TC Training" and the handbook are
// the TC Bible, and only then does "TC" mean training.
const CATEGORY_HINTS: [RegExp, string][] = [
  [/\b(field agent|photo|video|walkthrough|walk through)/i, 'Field agents'],
  [/\b(title (co|company|companies|handoff|hand off)|vetting|vet\b|escrow|underwrit)/i, 'Title companies'],
  [/\b(script|rebuttal|objection|call flow|voicemail)/i, 'Scripts'],
  [/\b(template|addendum|agreement form|psa\b)/i, 'Templates'],
  [/\b(tc bible|bible|handbook|tc training)\b/i, 'TC Bible'],
  [/\b(sop|process|procedure|how to|checklist|workflow)/i, 'SOPs & checklists'],
  [/\b(training|playbook|prompt|onboarding|transaction coordinat|tc)\b/i, 'Training'],
];

/**
 * The shelf a doc most likely belongs on, from its title first and then its
 * opening text, among the names given. Falls back to "Other" (or the last
 * name) so an import never leaves a doc unfiled.
 */
export function guessCategory(title: string, text: string, names: readonly string[] = DEFAULT_CATEGORIES): string {
  const has = (n: string) => names.find((x) => x.toLowerCase() === n.toLowerCase());
  for (const src of [title, String(text ?? '').slice(0, 600)]) {
    for (const [re, cat] of CATEGORY_HINTS) if (re.test(src) && has(cat)) return has(cat)!;
  }
  return has('Other') ?? names[names.length - 1] ?? 'Other';
}

// ─── Word (.docx) ───────────────────────────────────────────────────────────

const decodeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

/**
 * word/document.xml → Markdown-ish text: one paragraph per <w:p>, Heading1–3
 * styles (and Title) as #–###, list paragraphs as "- ", tabs and breaks kept.
 * Enough for search and for reading in the panel; layout is not the point.
 */
export function docxText(xml: string): string {
  const out: string[] = [];
  const paras = String(xml ?? '').match(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];
  for (const p of paras) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    let raw = '';
    for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>/g)) {
      raw += m[1] !== undefined ? m[1] : m[0].startsWith('<w:tab') ? '\t' : '\n';
    }
    const text = decodeXml(raw).trim();
    if (!text) { out.push(''); continue; }
    const h = /^Title$/i.test(style) ? 1 : Number(/^Heading([1-6])$/i.exec(style)?.[1] ?? 0);
    const list = /<w:numPr>/.test(p) || /List/i.test(style);
    out.push(h ? `${'#'.repeat(Math.min(h, 3))} ${text}` : list ? `- ${text}` : text);
  }
  // Paragraphs are blocks; consecutive list items stay together.
  let s = '';
  let prev = '';
  for (const l of out) {
    if (!l) continue;
    if (s) s += prev.startsWith('- ') && l.startsWith('- ') ? '\n' : '\n\n';
    s += l;
    prev = l;
  }
  return normalizeText(s);
}

// ─── Google Drive links ─────────────────────────────────────────────────────

/** The file id in a Drive or Docs link (or a bare id), else null. */
export function driveFileId(link: string): string | null {
  const s = String(link ?? '').trim();
  const m = /\/(?:document|spreadsheets|presentation|file|drawings|forms)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/.exec(s)
    ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

// ─── Search without a database (the /demo sample) ───────────────────────────

const STOP = new Set(('a an and are as at be but by can do does for from had has have how i if in into is it its me my of on or our so that the their them then there these they this to us was we were what when where which who why will with you your should would could about need needs').split(' '));

/** Lowercased content words, lightly stemmed ("vetting" → "vet", "companies" → "compani"). */
export function terms(q: string): string[] {
  const words = String(q ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const stem = (w: string) => w
    .replace(/ies$/, 'i').replace(/y$/, 'i')
    .replace(/(ing|ed)$/, '').replace(/([^s])s$/, '$1')
    .replace(/(.)\1$/, '$1');
  return [...new Set(words.filter((w) => w.length > 1 && !STOP.has(w)).map(stem).filter((w) => w.length > 1))];
}

export type LocalDoc = { id: string; title: string; category: string | null; body: string };
export type LocalHit = { resourceId: string; title: string; category: string | null; heading: string; body: string; snippet: string; rank: number };

/** The best few sections across docs: share of query terms found, heading hits count double. */
export function searchLocal(docs: readonly LocalDoc[], query: string, limit = 6, perDoc = 2): LocalHit[] {
  const q = terms(query);
  if (!q.length) return [];
  const hits: LocalHit[] = [];
  for (const d of docs) {
    const scored = chunkText(d.title, d.body).map((c) => {
      const head = terms(c.heading);
      const words = terms(c.body);
      const bag = new Set(words);
      let score = 0;
      for (const t of q) {
        if (head.includes(t)) score += 2;
        if (bag.has(t)) score += 1 + Math.min(words.filter((w) => w === t).length - 1, 3) * 0.15;
      }
      return { c, score: score / (q.length * 3) };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, perDoc);
    for (const { c, score } of scored) {
      hits.push({ resourceId: d.id, title: d.title, category: d.category, heading: c.heading, body: c.body, snippet: snippetOf(c.body, q), rank: score });
    }
  }
  return hits.sort((a, b) => b.rank - a.rank).slice(0, limit);
}

/**
 * About 220 characters around the first term found, the terms wrapped in
 * [[ ]] the way search_resources' ts_headline marks them.
 */
export function snippetOf(body: string, q: readonly string[], len = 220): string {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of q) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, at < 0 ? 0 : at - Math.floor(len / 3));
  let s = flat.slice(start, start + len);
  if (start > 0) s = '…' + s.replace(/^\S*\s/, '');
  if (start + len < flat.length) s = s.replace(/\s\S*$/, '') + '…';
  if (!q.length) return s;
  const re = new RegExp(`\\b(${q.map((t) => t.replace(/[^a-z0-9]/g, '')).filter(Boolean).join('|')})[a-z]*`, 'gi');
  return s.replace(re, (m) => `[[${m}]]`);
}

/** Split a [[marked]] snippet into plain and matched runs for rendering. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  for (const part of String(snippet ?? '').split(/(\[\[[\s\S]*?\]\])/)) {
    if (!part) continue;
    const m = /^\[\[([\s\S]*)\]\]$/.exec(part);
    out.push(m ? { text: m[1], hit: true } : { text: part, hit: false });
  }
  return out;
}
