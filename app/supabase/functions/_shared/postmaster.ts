/**
 * Gmail Postmaster Tools v2: the client, and adding a domain for the user.
 *
 * v2 lists, adds and verifies domains itself (domains.create,
 * domains.getVerificationToken, domains.verify; Google marks these three as
 * Developer Preview). CLOZR adds each workspace domain Postmaster does not
 * list, then verifies it: first by asking Postmaster to check (a domain the
 * account verified through Site Verification passes straight away), then by
 * writing Postmaster's own TXT at InboxKit or Vercel DNS and asking again.
 *
 * When Google refuses domains.create for this Cloud project (403, 404 or
 * 501: the project is not in the preview), the domain is `manual`: it is
 * added once at postmaster.google.com, and CLOZR stops asking for the rest
 * of that load.
 *
 * Scopes: postmaster.domain (list, add, verify), postmaster.traffic.readonly
 * (domainStats). Pure: no Deno, no database.
 * Tests: npx tsx tools/postmaster.test.ts
 */
import type { FetchLike } from './instantly.ts';
import type { DnsWriter } from './site-verification.ts';

export const POSTMASTER_API = 'https://gmailpostmastertools.googleapis.com/v2';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export class PostmasterError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message);
    this.name = 'PostmasterError';
  }
}

export type PmState = 'VERIFIED' | 'UNVERIFIED' | 'VERIFICATION_STATE_UNSPECIFIED';
export type PmDomain = { domain: string; state: PmState };

/** Stats are read for a listed domain unless Google says it is unverified. */
export const pmReadable = (d: PmDomain | undefined) => !!d && d.state !== 'UNVERIFIED';

const domainFrom = (v: unknown): PmDomain | null => {
  const r = rec(v);
  const name = str(r?.name).replace(/^domains\//, '').toLowerCase();
  if (!name) return null;
  const s = str(r?.verificationState);
  return { domain: name, state: s === 'VERIFIED' || s === 'UNVERIFIED' ? s : 'VERIFICATION_STATE_UNSPECIFIED' };
};

export type PostmasterClient = {
  /** Every domain on the account, all pages. */
  listDomains(): Promise<PmDomain[]>;
  /** Adds the domain. ALREADY_EXISTS comes back as an UNVERIFIED domain so the caller verifies it. */
  createDomain(domain: string): Promise<PmDomain>;
  /** The TXT value Postmaster wants on the domain. */
  verificationToken(domain: string): Promise<string>;
  /** True when Google verified it; false when the record is not visible yet. */
  verifyDomain(domain: string): Promise<boolean>;
  queryStats(domain: string, body: unknown): Promise<unknown>;
};

export function postmasterClient(accessToken: string, fetchFn: FetchLike = (i, init) => fetch(i, init as RequestInit), maxPages = 20): PostmasterClient {
  const call = async (path: string, init?: { method?: string; body?: unknown }) => {
    const res = await fetchFn(`${POSTMASTER_API}/${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const e = rec(rec(body)?.error);
      throw new PostmasterError(res.status, str(e?.status), str(e?.message) || `Postmaster ${res.status}`);
    }
    return body;
  };
  const path = (domain: string) => `domains/${encodeURIComponent(domain)}`;
  return {
    async listDomains() {
      const out: PmDomain[] = [];
      let token = '';
      for (let page = 0; page < maxPages; page++) {
        const body = rec(await call(`domains?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`));
        for (const d of Array.isArray(body?.domains) ? body.domains : []) {
          const x = domainFrom(d);
          if (x) out.push(x);
        }
        token = str(body?.nextPageToken);
        if (!token) break;
      }
      return out;
    },
    async createDomain(domain) {
      try {
        return domainFrom(await call('domains', { method: 'POST', body: { domainId: domain } })) ?? { domain, state: 'UNVERIFIED' };
      } catch (err) {
        if (err instanceof PostmasterError && (err.status === 409 || err.reason === 'ALREADY_EXISTS')) return { domain, state: 'UNVERIFIED' };
        throw err;
      }
    },
    async verificationToken(domain) {
      const body = rec(await call(`${path(domain)}/verificationToken?verificationMethod=TXT`));
      const t = str(body?.token);
      if (!t) throw new PostmasterError(200, '', 'Postmaster returned no verification token.');
      return t;
    },
    async verifyDomain(domain) {
      try {
        await call(`${path(domain)}:verify`, { method: 'POST', body: { verificationMethod: 'TXT' } });
        return true;
      } catch (err) {
        // The record is not there yet (or not visible to Google yet).
        if (err instanceof PostmasterError && [400, 404, 409, 412].includes(err.status)) return false;
        throw err;
      }
    },
    async queryStats(domain, body) {
      return call(`${path(domain)}/domainStats:query`, { method: 'POST', body });
    },
  };
}

/** Google will not let this project add domains (the methods are Developer Preview). */
export const addRefused = (err: unknown) => err instanceof PostmasterError && [403, 404, 501].includes(err.status);

export type PmAdd = 'ready' | 'added' | 'manual' | 'error';
export type RegisterOutcome = { postmaster: PmAdd; detail: string };

export const MANUAL_ADD = 'Add it once at postmaster.google.com. Google already counts it as verified, so it is accepted straight away.';

/**
 * Puts one domain in Postmaster and verifies it there. `listed` is its
 * domains.list entry, if any. `blocked` is shared across a run: the first
 * refusal of domains.create marks it, and the rest skip straight to manual.
 * Never throws.
 */
export async function registerDomain(domain: string, deps: { pm: PostmasterClient; writers: DnsWriter[]; listed?: PmDomain; blocked: { reason: string | null } }): Promise<RegisterOutcome> {
  try {
    let state = deps.listed?.state;
    if (!deps.listed) {
      if (deps.blocked.reason) return { postmaster: 'manual', detail: `${MANUAL_ADD} (Google would not let CLOZR add it: ${deps.blocked.reason})` };
      try {
        state = (await deps.pm.createDomain(domain)).state;
      } catch (err) {
        if (!addRefused(err)) throw err;
        deps.blocked.reason = (err as Error).message.slice(0, 160) || String((err as PostmasterError).status);
        return { postmaster: 'manual', detail: `${MANUAL_ADD} (Google would not let CLOZR add it: ${deps.blocked.reason})` };
      }
    }
    if (state !== 'UNVERIFIED') return { postmaster: 'ready', detail: 'In Postmaster and verified.' };
    if (await deps.pm.verifyDomain(domain)) return { postmaster: 'ready', detail: 'In Postmaster and verified.' };
    let writer: DnsWriter | null = null;
    for (const w of deps.writers) if (await w.hosts(domain)) { writer = w; break; }
    if (!writer) return { postmaster: 'added', detail: 'Added to Postmaster. It verifies once the Site Verification TXT record is on the domain.' };
    await writer.ensureTxt(domain, await deps.pm.verificationToken(domain));
    if (await deps.pm.verifyDomain(domain)) return { postmaster: 'ready', detail: 'In Postmaster and verified.' };
    return { postmaster: 'added', detail: 'Added to Postmaster. Waiting for DNS to reach Google.' };
  } catch (err) {
    const status = err instanceof PostmasterError ? err.status : 0;
    const msg = err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
    return { postmaster: 'error', detail: status === 401 ? 'Google needs this connection approved again. Press Connect Postmaster.' : `Postmaster did not add it: ${msg}` };
  }
}

/** Runs `fn` over `items`, `limit` at a time, in order of the input. Items started after `deadline` (ms epoch) are skipped and come back undefined. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, deadline = Infinity, now: () => number = Date.now): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      if (now() > deadline) continue;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
