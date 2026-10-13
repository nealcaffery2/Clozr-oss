// Email bodies as the Gmail sync stores them are raw text/plain: CRLF line
// ends, the whole quoted thread under every reply, a signature, and the
// artefacts mail clients leave behind — "<(424)%20555-0162>" after a phone
// number, "<mailto:x@y.com>" after an address, "*bold*" markers. Drawn as-is
// they read as a wall of noise. This splits a body into what the person
// actually wrote and the rest (signature, quoted history), and tidies both.

export type CleanEmail = {
  /** What they wrote this time. */
  text: string;
  /** Signature and quoted earlier messages, folded behind a "···" toggle. Empty when there are none. */
  rest: string;
};

/** Where the quoted thread or the signature starts, as a line test. */
const CUT: RegExp[] = [
  /^-- ?$/, //                                         signature delimiter
  /^On .{6,200}wrote:\s*$/i, //                        Gmail / Apple Mail reply header
  /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i, // Outlook / forward
  /^_{10,}\s*$/, //                                    Outlook rule above the quoted header
  /^From: .+$/i, //                                    Outlook quoted header (checked with Sent:/Date: next)
  /^Sent from my (iPhone|iPad|Android|Galaxy|mobile)/i,
  /^Get Outlook for /i,
];

const tidy = (s: string) => s
  // "(424) 555-0162 <(424)%20555-0162>" and "Name <name@x.com>" duplicates: drop the <...> echo.
  .replace(/\s*<\((\d{3})\)%20[\d-]+>/g, '')
  .replace(/\s*<mailto:[^>\s]+>/gi, '')
  .replace(/\s*<tel:[^>\s]+>/gi, '')
  // *Purchase Price:* → Purchase Price:
  .replace(/\*([^*\n]{1,80})\*/g, '$1')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/**
 * Plain-text mail is hard-wrapped at ~76 columns, so a paragraph arrives as
 * lines broken mid-sentence. A line that ran long and is followed by more
 * words (not a blank line, a list item or a new "Label:") was wrapped, not ended.
 */
function unwrap(s: string): string {
  const lines = s.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const joinable = prev !== undefined && prev.length >= 60 && line.trim() !== ''
      && !/[:.!?]$/.test(prev.trim()) && !/^\s*([-*•>]|\d+[.)]\s)/.test(line);
    if (joinable) out[out.length - 1] = prev.replace(/\s+$/, '') + ' ' + line.trim();
    else out.push(line);
  }
  return out.join('\n');
}

export function cleanEmail(raw: string | null | undefined): CleanEmail {
  const lines = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('>')) { cut = i; break; }
    // "From:" alone is too common in a body; it counts only as a quoted header.
    if (/^From: /i.test(l) && !/^(Sent|Date|To|Subject): /i.test((lines[i + 1] ?? '').trim())) continue;
    if (CUT.some((re) => re.test(l))) { cut = i; break; }
  }
  // Never fold the whole message away: a body that starts with a quote is all rest.
  const text = tidy(unwrap(lines.slice(0, cut).join('\n')));
  const rest = tidy(lines.slice(cut).join('\n').replace(/^-- ?\n+/, ''));
  return text ? { text, rest } : { text: rest, rest: '' };
}

// ---------------------------------------------------------------- HTML bodies
// Some mail lands as HTML (PandaDoc, DocuSign, newsletters): the whole
// document, head and styles included. Where a message shows as a line or a
// card it is reduced to its words first.

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", zwnj: '', zwj: '', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™' };

export const looksHtml = (s: string) => /<(!doctype|html|body|div|p|table|br|span|td)\b/i.test(s);

/** HTML to plain text: head, styles, scripts and hidden preheaders dropped; blocks become line breaks; quoted Gmail history goes too. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(div|span|p)\b[^>]*display:\s*none[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(div|blockquote)\b[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : ' '; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The words of this one message, HTML or not, without the thread quoted under it. */
export function emailGist(body: string | null | undefined): string {
  if (!body) return '';
  return cleanEmail(looksHtml(body) ? htmlToText(body) : body).text;
}

/**
 * An HTML reply without the thread quoted under it: Gmail's gmail_quote,
 * Outlook's divRplyFwdMsg / appendonsend and everything after, Apple Mail's
 * blockquote type="cite". Null when there is nothing to cut.
 */
export function stripQuotedHtml(html: string): string | null {
  const marks = [
    /<div[^>]*class="[^"]*gmail_quote[^"]*"/i,
    /<blockquote[^>]*class="[^"]*gmail_quote[^"]*"/i,
    /<div[^>]*id="(divRplyFwdMsg|appendonsend)"/i,
    /<blockquote[^>]*type="cite"/i,
    /<div[^>]*class="[^"]*(yahoo_quoted|moz-cite-prefix)[^"]*"/i,
    /<hr[^>]*id="stopSpelling"/i,
  ];
  let cut = -1;
  for (const re of marks) { const m = re.exec(html); if (m && (cut < 0 || m.index < cut)) cut = m.index; }
  if (cut <= 0) return null;
  const head = html.slice(0, cut);
  // Keep the document valid enough to render: close what the cut left open.
  return /<\/body>/i.test(head) ? head : head + '</body></html>';
}
