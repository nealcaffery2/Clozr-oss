// Pages a custom report's Embed element can frame.
//
// The browser only frames what the site's Content-Security-Policy lists in
// frame-src; anything else draws a blank box. Every entry here is also in
// frame-src of both CSP headers in vercel.json (the site-wide one and the
// /sign one), and tools/csp-headers.test.ts fails when they drift apart.

/** CSP source expressions, as they appear in vercel.json. `*.` matches subdomains only. */
export const EMBED_SOURCES = [
  'https://docs.google.com',
  'https://lookerstudio.google.com',
  'https://datastudio.google.com',
  'https://*.notion.site',
  'https://airtable.com',
  'https://*.airtable.com',
  'https://app.hex.tech',
  'https://*.metabaseapp.com',
  'https://public.tableau.com',
] as const;

/** The same list in words, for the hint under the URL field. */
export const EMBED_SERVICES = 'Google Docs, Sheets and Slides, Looker Studio, public Notion pages, Airtable, Hex, Metabase Cloud and Tableau Public';

export type EmbedCheck =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'insecure' | 'host'; host?: string };

function hostAllowed(host: string): boolean {
  return EMBED_SOURCES.some((src) => {
    const h = src.slice('https://'.length);
    if (h.startsWith('*.')) {
      const base = h.slice(2);
      return host.endsWith(`.${base}`) && host.length > base.length + 1;
    }
    return host === h;
  });
}

/** Whether the report can frame `raw`, and why not when it can't. */
export function checkEmbedUrl(raw: string): EmbedCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'empty' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol === 'http:') return { ok: false, reason: 'insecure', host: url.hostname };
  if (url.protocol !== 'https:' || !url.hostname) return { ok: false, reason: 'invalid' };
  // A port other than 443 is a different CSP source than the host alone.
  if (url.port || !hostAllowed(url.hostname.toLowerCase())) return { ok: false, reason: 'host', host: url.host };
  return { ok: true, url: url.href };
}

/** What to tell the person when the check fails; null when there is nothing to say. */
export function embedProblem(check: EmbedCheck): string | null {
  if (check.ok || check.reason === 'empty') return null;
  if (check.reason === 'invalid') return 'Paste the full link, starting with https://.';
  if (check.reason === 'insecure') return 'Use the https:// version of the link. Reports only frame secure pages.';
  return `Reports can’t frame pages from ${check.host}. Embeds work with ${EMBED_SERVICES}.`;
}
