/**
 * Read receipts, CLOZR's own: a pixel for opens, rewritten links for clicks.
 *
 * Pure apart from reading SUPABASE_URL, so the rewriting can be tested with
 * `deno run supabase/functions/_shared/email-track.test.ts`.
 *
 * A tracked send gets a random token (migration 82 email_tracking). The HTML
 * part gains a 1×1 image at
 *   <SUPABASE_URL>/functions/v1/email-track/o/<token>.gif
 * and every http(s) link becomes
 *   <SUPABASE_URL>/functions/v1/email-track/c/<token>/<n>
 * which the `email-track` function counts and redirects to the n-th URL as it
 * was stored at send time. The destination is read from the table, never from
 * the request, so the redirect cannot be pointed anywhere else.
 *
 * Left alone: mailto/tel links, and unsubscribe links (a recipient opting out
 * should reach the opt-out, not a counter). The plain-text part is not
 * rewritten; a client that only shows text reports neither.
 */

export const trackBase = (projectUrl = Deno.env.get('SUPABASE_URL') ?? '') => `${projectUrl.replace(/\/$/, '')}/functions/v1/email-track`;

/** 24 random bytes as hex: unguessable, so the token alone is the credential for counting. */
export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export const isToken = (t: string) => /^[0-9a-f]{48}$/.test(t);

const skip = (url: string) => /\/deliverability\/unsubscribe|[?&]unsubscribe|\/unsubscribe\b/i.test(url);

/**
 * The HTML with its links rewritten and the pixel appended, and the original
 * URLs in link order. `base` is trackBase().
 */
export function instrument(html: string, token: string, base: string): { html: string; links: string[] } {
  const links: string[] = [];
  const out = html.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (whole, pre: string, q: string, url: string) => {
    const decoded = url.replace(/&amp;/g, '&');
    if (skip(decoded) || links.length >= 100) return whole;
    links.push(decoded);
    return `${pre}${q}${base}/c/${token}/${links.length - 1}${q}`;
  });
  const pixel = `<img src="${base}/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />`;
  return { html: /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel, links };
}

/** What a request to the function asks for: an open, or the n-th link of a token. */
export function parsePath(pathname: string): { kind: 'open'; token: string } | { kind: 'click'; token: string; idx: number } | null {
  const m = pathname.match(/\/email-track\/(o|c)\/([0-9a-f]{48})(?:\.gif)?(?:\/(\d{1,3}))?\/?$/);
  if (!m) return null;
  if (m[1] === 'o') return m[3] == null ? { kind: 'open', token: m[2] } : null;
  return m[3] == null ? null : { kind: 'click', token: m[2], idx: Number(m[3]) };
}

/**
 * Whether an open should count. The first seconds after a send belong to
 * the sender's own mail client and to scanners that fetch every image as the
 * message arrives, not to a reader.
 */
export const countsAsOpen = (sentAt: string | Date, now = new Date()) => now.getTime() - new Date(sentAt).getTime() > 8_000;
