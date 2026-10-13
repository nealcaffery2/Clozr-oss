/**
 * Canonical CLOZR web origin for emails and redirects.
 *
 * Invite CTAs, magic-link fallbacks and similar must never open Talkr
 * (talkrdialer.com / Talkr Vercel hosts). APP_URL has been mis-set to a Talkr
 * origin before; this helper refuses those hosts and falls back to production.
 */

/** Fallback CLOZR origin when neither APP_URL nor SITE_URL is set. Replace with your deployment. */
export const CLOZR_APP_ORIGIN = 'https://your-clozr-site.example.com';

function isTalkrHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'talkrdialer.com' || h.endsWith('.talkrdialer.com')) return true;
  if (h.includes('talkr-platform') || h.includes('talkrphone')) return true;
  // Talkr web / API Vercel projects — never a Clozr invite target.
  if (/(^|\.)talkr.*\.vercel\.app$/i.test(h)) return true;
  return false;
}

/**
 * Normalize a candidate origin. Returns '' when the value is missing, not
 * http(s), or belongs to Talkr.
 */
export function sanitizeClozrOrigin(raw: unknown): string {
  const s = String(raw ?? '').trim().replace(/\/$/, '');
  if (!s) return '';
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (isTalkrHost(url.hostname)) return '';
  // Allow Clozr hosts, localhost (dev), and other non-Talkr APP_URL values
  // (preview aliases / custom domains). Talkr hosts already returned ''.
  return `${url.protocol}//${url.host}`;
}

/**
 * Resolve the CLOZR app origin for invite / auth emails.
 *
 * Preference order:
 *   1. caller-supplied origin (browser window.location.origin when inviting)
 *   2. APP_URL secret
 *   3. SITE_URL secret (legacy alias)
 *   4. CLOZR_APP_ORIGIN
 *
 * Talkr hosts are never returned.
 */
export function clozrAppOrigin(...preferred: Array<string | null | undefined>): string {
  for (const p of preferred) {
    const ok = sanitizeClozrOrigin(p);
    if (ok) return ok;
  }
  const fromEnv = sanitizeClozrOrigin(Deno.env.get('APP_URL'))
    || sanitizeClozrOrigin(Deno.env.get('SITE_URL'));
  if (fromEnv) return fromEnv;
  return CLOZR_APP_ORIGIN;
}

/** Absolute CLOZR login URL for teammate / notary invite emails. */
export function clozrLoginUrl(...preferred: Array<string | null | undefined>): string {
  return `${clozrAppOrigin(...preferred)}/login`;
}
