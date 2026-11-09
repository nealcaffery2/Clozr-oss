/**
 * The readable text of a raw email: the text/plain part (else the HTML part
 * as text), with base64 and quoted-printable decoded in the part's charset.
 *
 * IMAP hands back BODY[TEXT] as it sits on the wire. Gmail replies and
 * bounces are multipart with base64 parts, so storing that raw put MIME
 * boundaries and base64 in the reply snippet, and the reply classifier
 * (unsubscribe, out of office, interested) never matched a word of it.
 */

/** Text of a message from its header block and its body. Bodies cut short (a partial FETCH) decode as far as they go. */
export function mimeText(header: string, body: string): string {
  // No Content-Type to go on (a stored body without its headers): a body that opens on a boundary line is multipart.
  const sniffed = !/^content-type:/im.test(header) ? /^\s*--([^\s]+)\r?\n/.exec(body)?.[1] : undefined;
  const got = walk(sniffed ? `Content-Type: multipart/mixed; boundary="${sniffed}"` : header, body, 0);
  const text = got.plain ?? (got.html != null ? htmlAsText(got.html) : body);
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

type Found = { plain?: string; html?: string };

function walk(header: string, body: string, depth: number): Found {
  const head = header.replace(/\r?\n[ \t]+/g, ' ');
  const type = (/^content-type:\s*([^;\s]+)/im.exec(head)?.[1] ?? 'text/plain').toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = /boundary="?([^";\r\n]+)"?/i.exec(head)?.[1];
    if (!boundary || depth > 5) return {};
    const out: Found = {};
    const parts = body.split(`--${boundary}`).slice(1);
    for (const raw of parts) {
      if (raw.startsWith('--')) break;
      const cut = raw.search(/\r?\n\r?\n/);
      if (cut < 0) continue;
      const sub = walk(raw.slice(0, cut), raw.slice(cut).replace(/^\r?\n\r?\n/, ''), depth + 1);
      out.plain ??= sub.plain;
      out.html ??= sub.html;
      if (out.plain != null) break;
    }
    return out;
  }
  if (!type.startsWith('text/')) return {};
  const encoding = (/^content-transfer-encoding:\s*(\S+)/im.exec(head)?.[1] ?? '').toLowerCase();
  const charset = /charset="?([^";\s]+)"?/i.exec(head)?.[1] ?? 'utf-8';
  const text = decode(body, encoding, charset);
  return type === 'text/html' ? { html: text } : { plain: text };
}

function decode(body: string, encoding: string, charset: string): string {
  let bytes: Uint8Array;
  if (encoding === 'base64') {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, '');
    const whole = clean.slice(0, clean.length - (clean.length % 4));
    try {
      const bin = atob(whole);
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return body;
    }
  } else if (encoding === 'quoted-printable') {
    const soft = body.replace(/=\r?\n/g, '');
    const out: number[] = [];
    for (let i = 0; i < soft.length; i++) {
      const hex = soft[i] === '=' ? /^[0-9A-Fa-f]{2}/.exec(soft.slice(i + 1, i + 3)) : null;
      if (hex) { out.push(parseInt(hex[0], 16)); i += 2; } else out.push(soft.charCodeAt(i) & 0xff);
    }
    bytes = Uint8Array.from(out);
  } else {
    return body;
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function htmlAsText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
