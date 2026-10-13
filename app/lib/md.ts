// A small markdown reader for the assistants' answers (Ask CLOZR, Lane).
//
// The models write light markdown: **bold**, *italics*, `code`, [links](url),
// "#" headings, "-" / "*" bullets and "1." lists. This turns it into a plain
// tree that components/Markdown.tsx renders as React elements, so model text
// never reaches the page as HTML. Pure, so tools/md.test.ts pins it.
//
// Text streams in, so a "**" or "`" with no closing mark yet is shown as the
// characters it is, and the next chunk that closes it turns it into bold.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] };

/** Only web and mail links; anything else (javascript:, data:) stays text. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

/** Inline marks in one line of text. Unclosed marks are left as literal text. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && /[*_`[\]\\]/.test(s[i + 1]!)) { buf += s[i + 1]; i += 2; continue; }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push({ t: 'code', v: s.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] === ch) {
      const mark = ch + ch;
      const end = s.indexOf(mark, i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'strong', c: parseInline(s.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if (ch === '*' || ch === '_') {
      // Single-mark italics: not a word-internal underscore (snake_case), not "* " list-ish spacing.
      const prev = i > 0 ? s[i - 1]! : ' ';
      const next = s[i + 1] ?? ' ';
      if (!/\w/.test(prev) || ch === '*') {
        if (next !== ' ' && next !== ch) {
          let end = i + 1;
          while ((end = s.indexOf(ch, end)) !== -1) {
            const after = s[end + 1] ?? ' ';
            if (s[end - 1] !== ' ' && s[end + 1] !== ch && (ch === '*' || !/\w/.test(after))) break;
            end++;
          }
          if (end > i + 1) { flush(); out.push({ t: 'em', c: parseInline(s.slice(i + 1, end)) }); i = end + 1; continue; }
        }
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        const href = safeHref(m[2]!);
        flush();
        if (href) out.push({ t: 'link', href, c: parseInline(m[1]!) });
        else out.push(...parseInline(m[1]!));
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Blocks: paragraphs (lines joined with breaks kept as "\n"), headings and lists. */
export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) { blocks.push({ t: 'p', c: parseInline(para.join('\n')) }); para = []; }
  };
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { endPara(); continue; }
    const h = HEADING.exec(line);
    if (h) {
      endPara();
      blocks.push({ t: 'h', level: Math.min(3, h[1]!.length) as 1 | 2 | 3, c: parseInline(h[2]!) });
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      endPara();
      const last = blocks[blocks.length - 1];
      if (last?.t === 'ul') last.items.push(parseInline(b[1]!));
      else blocks.push({ t: 'ul', items: [parseInline(b[1]!)] });
      continue;
    }
    const n = NUMBERED.exec(line);
    if (n) {
      endPara();
      const last = blocks[blocks.length - 1];
      if (last?.t === 'ol') last.items.push(parseInline(n[2]!));
      else blocks.push({ t: 'ol', start: Number(n[1]), items: [parseInline(n[2]!)] });
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  return blocks;
}
