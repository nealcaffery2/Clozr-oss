// HTML email, as a string the UI can render.
//
// Gmail stores a designed message as text/html (often beside a one-line
// text/plain). Painted as text, that document shows up as tags or as the
// stub plain part, which is the "HTML isn't loading" report on the record
// and in the inbox. A signing email is often just paragraphs, a bold line
// and a link — no <table> or <html> — and that still has to count.
// This module is the one definition of "this string is HTML", of the plain
// words inside it (list snippets, search), and of the document an iframe
// is allowed to show.
//
// The iframe is the security boundary (no scripts). Sanitizing first means
// a missed sandbox flag still has nothing to run.

// Block and inline tags a mail client actually sends. A sentence that
// mentions one tag does not reach four of these.
const MAIL_TAG = /<\/?(?:p|div|br|table|td|tr|th|img|style|span|a|strong|em|b|i|u|ul|ol|li|h[1-6]|blockquote|font|center|html|body|head)\b/gi;

/**
 * A designed message, not a sentence that happens to mention one tag.
 * Keep the rules identical to looksLikeHtml in supabase/functions/_shared/google.ts.
 */
export function looksLikeHtml(raw: string | null | undefined): boolean {
  const s = String(raw ?? '').trim();
  if (s.length < 12) return false;
  if (/^<!doctype\s+html\b/i.test(s) || /<html[\s>]/i.test(s) || /<body[\s>]/i.test(s)) return true;
  const tags = s.match(MAIL_TAG);
  return !!tags && tags.length >= 4;
}

/** Visible words of an HTML document, for a snippet or a plain-text fallback. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, '\n')
    .replace(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_w, a: string, b: string, c: string, label: string) => {
      const href = a || b || c || '';
      const text = label.replace(/<[^>]+>/g, '').trim();
      return href && text && !text.includes(href) ? `${text} (${href})` : text || href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_w, n: string) => {
      const c = Number(n);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text unchanged; HTML reduced to its words. */
export function emailPlain(raw: string | null | undefined): string {
  const s = String(raw ?? '');
  return looksLikeHtml(s) ? htmlToPlain(s) : s;
}

const DROP_TAGS = /<(script|iframe|object|embed|applet|link|meta|base|form|noscript|svg|math|template|frameset)\b[^>]*>[\s\S]*?<\/\1>/gi;
const DROP_TAGS_VOID = /<(script|iframe|object|embed|applet|link|meta|base|form|noscript|svg|math|template|frameset)\b[^>]*\/?>/gi;

function safeUrl(raw: string): string | null {
  const v = raw.trim().replace(/[\u0000-\u001f\s]+/g, '');
  if (!v || v.length > 2000) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^mailto:/i.test(v)) return v;
  if (/^tel:/i.test(v)) return v;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v)) return v.replace(/\s+/g, '');
  return null;
}

function cleanStyle(css: string): string {
  return css
    .replace(/<\/?style/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/@import[^;]+;?/gi, '')
    .replace(/behavior\s*:[^;]+;?/gi, '')
    .replace(/-moz-binding\s*:[^;]+;?/gi, '');
}

/**
 * HTML a sandboxed iframe may show: structure, inline styles, and links to
 * http(s), mailto, tel, or an inline image. Scripts, frames, and event
 * handlers are removed.
 */
export function sanitizeEmailHtml(raw: string): string {
  let html = String(raw ?? '');
  const styles: string[] = [];
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_w, css: string) => {
    const clean = cleanStyle(css).trim();
    if (clean) styles.push(clean);
    return '';
  });
  // A full document contributes its body; the head (except styles, already
  // lifted) is not part of the message.
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
  html = body ? body[1] : html.replace(/<head\b[\s\S]*?<\/head>/gi, '').replace(/<\/?html\b[^>]*>/gi, '');
  for (let i = 0; i < 4; i++) {
    const next = html.replace(DROP_TAGS, '').replace(DROP_TAGS_VOID, '');
    if (next === html) break;
    html = next;
  }
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Event handlers, quoted or not. `onerror=alert(1)` and `onerror="alert(1)"`.
  html = html.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\s+(srcset|formaction|xlink:href|poster|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\s+(href|src|action)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (whole, attr: string, _q: string, dq: string, sq: string, uq: string) => {
    const url = safeUrl(dq ?? sq ?? uq ?? '');
    if (!url) return '';
    const name = attr.toLowerCase() === 'action' ? 'href' : attr.toLowerCase();
    return ` ${name}="${url.replace(/"/g, '%22')}"`;
  });
  html = html.replace(/\s+target\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/<a\b/gi, '<a target="_blank" rel="noopener noreferrer"');
  const styleBlock = styles.length ? `<style>${styles.join('\n')}</style>` : '';
  return styleBlock + html;
}

/** A document for an iframe srcdoc. The parent's CSP still applies. */
export function emailSrcDoc(raw: string): string {
  const inner = sanitizeEmailHtml(raw);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>
    html,body{margin:0;padding:12px;background:#fff;color:#18181b;}
    body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;}
    img{max-width:100%;height:auto;}
    table{max-width:100%;}
    a{color:#1a73e8;}
  </style></head><body>${inner}</body></html>`;
}
