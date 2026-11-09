// The Acme Homes marketplace sign-in link. A buyer who already joined types
// their email or phone on the log-in screen; listing /access sends this link
// to that email or phone instead of handing the access token to whoever typed
// it. The token rides in the URL fragment, so it never reaches a server log
// or a Referer header, and the marketplace page stores it on open.
//
// Pure, so the listing function and tools/market-signin.test.ts share it.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** First name only, or null. */
export const firstName = (name: string | null | undefined): string | null => String(name ?? '').trim().split(/\s+/)[0] || null;

/** `${app}/marketplace#access=<token>&name=<first name>`. */
export function marketSigninUrl(app: string, token: string, name?: string | null): string {
  const h = new URLSearchParams({ access: token });
  const first = firstName(name);
  if (first) h.set('name', first.slice(0, 40));
  return `${app.replace(/\/+$/, '')}/marketplace#${h.toString()}`;
}

/** Reads the fragment marketSigninUrl writes. Null when it carries no token. */
export function readSigninHash(hash: string): { token: string; name: string | null } | null {
  const h = new URLSearchParams(hash.replace(/^#/, ''));
  const token = (h.get('access') ?? '').trim();
  if (!token || token.length > 400) return null;
  return { token, name: (h.get('name') ?? '').trim().slice(0, 40) || null };
}

export function signinEmail(p: { name: string | null | undefined; url: string }): { subject: string; text: string; html: string } {
  const who = firstName(p.name);
  const hi = who ? `Hi ${who},` : 'Hi,';
  const line = 'Open this link to sign in to the Acme Homes marketplace and see full addresses, every photo and the COMPR report.';
  const ignore = 'If you did not ask for this, ignore this email and nothing changes.';
  return {
    subject: 'Your Acme Homes marketplace link',
    text: `${hi}\n\n${line}\n\n${p.url}\n\n${ignore}\n\nAcme Homes`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;font-size:15px;line-height:1.55;color:#18181b;max-width:520px">`
      + `<p style="margin:0 0 12px">${esc(hi)}</p>`
      + `<p style="margin:0 0 18px">${esc(line)}</p>`
      + `<p style="margin:0 0 18px"><a href="${esc(p.url)}" style="display:inline-block;background:#c2410c;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Sign in to the marketplace</a></p>`
      + `<p style="margin:0 0 12px;color:#71717a;font-size:13px">${esc(ignore)}</p>`
      + `<p style="margin:0;color:#71717a;font-size:13px">Acme Homes</p></div>`,
  };
}

export function signinText(url: string): string {
  return `Acme Homes: open this link to sign in to the marketplace. ${url}`;
}
