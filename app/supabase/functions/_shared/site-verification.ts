/**
 * Domain verification for Gmail Postmaster, done for the user.
 *
 * Postmaster only reports on a domain the connected Google account has
 * verified. A domain verified through Google's Site Verification API (or
 * Search Console) for that account counts, so CLOZR:
 *
 *   1. lists what the account already verified (GET /webResource). The cold
 *      domains carry InboxKit's google-site-verification TXT already, and may
 *      be verified here before anything is written.
 *   2. asks Google for the DNS_TXT token (POST /token, site type INET_DOMAIN)
 *   3. writes it as a TXT at the domain's DNS host: InboxKit (Cloudflare) for
 *      the cold domains, Vercel DNS for the company domains
 *   4. asks Google to verify (POST /webResource?verificationMethod=DNS_TXT).
 *      A miss right after writing is DNS propagation: the row stays pending
 *      and the next Postmaster load tries again.
 *
 * Needs the https://www.googleapis.com/auth/siteverification scope on the
 * Google connection, and the Site Verification API enabled on the Google
 * Cloud project. Postmaster has no API to add a domain, so after this the
 * domain is added once at postmaster.google.com (it shows as verified).
 *
 * Pure: no Deno, no database. Tests: npx tsx tools/site-verification.test.ts
 */
import type { FetchLike } from './instantly.ts';
import type { InboxkitClient } from './inboxkit.ts';

export const SITE_VERIFICATION_API = 'https://www.googleapis.com/siteVerification/v1';
export const VERCEL_API = 'https://api.vercel.com';

export type VerifyStatus = 'verified' | 'pending' | 'needs_dns' | 'error';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The registrable domain and the record name under it. Two labels for the
 * apex covers .com / .ai / .io; a two-part public suffix (.co.uk) is not
 * handled and would be written at the wrong level.
 */
export function apexOf(domain: string): { apex: string; host: string } {
  const labels = domain.trim().toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return { apex: labels.join('.'), host: '' };
  return { apex: labels.slice(-2).join('.'), host: labels.slice(0, -2).join('.') };
}

/** Domains in a GET /webResource body, lowercased. Only INET_DOMAIN sites. */
export function readVerifiedSites(payload: unknown): Set<string> {
  const out = new Set<string>();
  const items = rec(payload)?.items;
  for (const item of Array.isArray(items) ? items : []) {
    const site = rec(rec(item)?.site);
    if (str(site?.type) === 'INET_DOMAIN' && str(site?.identifier)) out.add(str(site?.identifier).toLowerCase());
  }
  return out;
}

export class GoogleVerifyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GoogleVerifyError';
  }
}

export type SiteVerificationClient = {
  verifiedDomains(): Promise<Set<string>>;
  /** The full TXT value, e.g. "google-site-verification=abc". */
  token(domain: string): Promise<string>;
  /** True when Google verified it; false when the TXT is not visible yet. */
  verify(domain: string): Promise<boolean>;
};

export function siteVerificationClient(accessToken: string, fetchFn: FetchLike = (i, init) => fetch(i, init as RequestInit)): SiteVerificationClient {
  const call = async (path: string, init?: { method?: string; body?: unknown }) => {
    const res = await fetchFn(`${SITE_VERIFICATION_API}${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new GoogleVerifyError(res.status, str(rec(rec(body)?.error)?.message) || `Site Verification ${res.status}`);
    return body;
  };
  const site = (domain: string) => ({ type: 'INET_DOMAIN', identifier: domain });
  return {
    async verifiedDomains() { return readVerifiedSites(await call('/webResource')); },
    async token(domain) {
      const body = rec(await call('/token', { method: 'POST', body: { site: site(domain), verificationMethod: 'DNS_TXT' } }));
      const t = str(body?.token);
      if (!t) throw new GoogleVerifyError(200, 'Google returned no verification token.');
      return t;
    },
    async verify(domain) {
      try {
        await call('/webResource?verificationMethod=DNS_TXT', { method: 'POST', body: { site: site(domain) } });
        return true;
      } catch (err) {
        // 400: "the necessary verification token could not be found", i.e. DNS has not caught up.
        if (err instanceof GoogleVerifyError && err.status === 400) return false;
        throw err;
      }
    },
  };
}

/** Somewhere CLOZR can write a TXT record. */
export type DnsWriter = {
  name: 'inboxkit' | 'vercel';
  /** True when this host serves the domain's DNS. */
  hosts(domain: string): Promise<boolean>;
  /** Adds the TXT unless an identical one is there. */
  ensureTxt(domain: string, value: string): Promise<'added' | 'present'>;
};

/** InboxKit-managed (Cloudflare) DNS, looked up across the given InboxKit workspaces. */
export function inboxkitDns(clients: InboxkitClient[]): DnsWriter {
  const owner = new Map<string, InboxkitClient | null>();
  const find = async (domain: string) => {
    if (!owner.has(domain)) {
      let hit: InboxkitClient | null = null;
      for (const c of clients) if ((await c.dnsRecords(domain)) !== null) { hit = c; break; }
      owner.set(domain, hit);
    }
    return owner.get(domain) ?? null;
  };
  return {
    name: 'inboxkit',
    async hosts(domain) { return !!(await find(domain)); },
    async ensureTxt(domain, value) {
      const c = await find(domain);
      if (!c) throw new Error(`${domain} is not in InboxKit.`);
      const have = (await c.dnsRecords(domain)) ?? [];
      if (have.some((r) => r.type === 'TXT' && ['@', '', domain].includes(r.host) && r.value.replace(/^"|"$/g, '') === value)) return 'present';
      await c.addDnsRecord(domain, { host: '@', type: 'TXT', value });
      return 'added';
    },
  };
}

/**
 * Vercel DNS: GET /v4/domains/{apex}/records, POST /v2/domains/{apex}/records
 * { name, type: 'TXT', value, ttl }. Token from VERCEL_TOKEN (with DNS write
 * access), VERCEL_TEAM_ID when the domains sit on a team.
 */
export function vercelDns(token: string, teamId: string | null, fetchFn: FetchLike = (i, init) => fetch(i, init as RequestInit)): DnsWriter {
  const q = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  const list = async (apex: string): Promise<{ name: string; type: string; value: string }[] | null> => {
    const res = await fetchFn(`${VERCEL_API}/v4/domains/${encodeURIComponent(apex)}/records${q}${q ? '&' : '?'}limit=100`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`Vercel DNS ${res.status}`);
    const rows = rec(await res.json().catch(() => null))?.records;
    return (Array.isArray(rows) ? rows : []).flatMap((r) => {
      const x = rec(r);
      return x ? [{ name: str(x.name), type: str(x.type).toUpperCase(), value: str(x.value) }] : [];
    });
  };
  return {
    name: 'vercel',
    async hosts(domain) { return (await list(apexOf(domain).apex)) !== null; },
    async ensureTxt(domain, value) {
      const { apex, host } = apexOf(domain);
      const have = (await list(apex)) ?? [];
      if (have.some((r) => r.type === 'TXT' && r.name === host && r.value === value)) return 'present';
      const res = await fetchFn(`${VERCEL_API}/v2/domains/${encodeURIComponent(apex)}/records${q}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: host, type: 'TXT', value, ttl: 60 }),
      });
      if (!res.ok) throw new Error(`Vercel refused the TXT record (${res.status}).`);
      return 'added';
    },
  };
}

export type VerifyOutcome = { status: VerifyStatus; dns_host: string | null; token: string | null; detail: string };

/**
 * One domain, start to finish. Never throws: a failure is an `error` row
 * with the reason, so one bad domain does not stop the rest.
 */
export async function autoVerifyDomain(domain: string, deps: { google: SiteVerificationClient; verified: Set<string>; writers: DnsWriter[]; knownToken?: string | null }): Promise<VerifyOutcome> {
  if (deps.verified.has(domain)) return { status: 'verified', dns_host: null, token: deps.knownToken ?? null, detail: 'Already verified for this Google account.' };
  let token: string | null = deps.knownToken ?? null;
  try {
    token = token || await deps.google.token(domain);
    let writer: DnsWriter | null = null;
    for (const w of deps.writers) if (await w.hosts(domain)) { writer = w; break; }
    if (!writer) {
      if (await deps.google.verify(domain)) return { status: 'verified', dns_host: null, token, detail: 'Verified.' };
      return { status: 'needs_dns', dns_host: null, token, detail: `CLOZR cannot write DNS for ${domain}. Add the TXT record at its DNS host and it verifies on the next check.` };
    }
    const wrote = await writer.ensureTxt(domain, token);
    if (await deps.google.verify(domain)) return { status: 'verified', dns_host: writer.name, token, detail: 'Verified.' };
    return { status: 'pending', dns_host: writer.name, token, detail: wrote === 'added' ? 'TXT record added. Waiting for DNS to reach Google.' : 'TXT record is in place. Waiting for Google to see it.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : 'Verification failed.';
    return { status: 'error', dns_host: null, token, detail: err instanceof GoogleVerifyError && err.status === 403 ? `Google refused Site Verification: ${msg}. Reconnect Postmaster so CLOZR can verify domains, and check the Site Verification API is enabled on the Google Cloud project.` : msg };
  }
}
