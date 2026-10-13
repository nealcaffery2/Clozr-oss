/**
 * InboxKit, the Google Workspace reseller the pool buys inboxes from. Two
 * reads: the mailbox list for one InboxKit workspace, and one mailbox's
 * app password, which the pool seals and uses for SMTP and IMAP.
 *
 * From docs.inboxkit.com (read 2026-10-10):
 *   POST /v1/api/mailboxes/list, headers Authorization: Bearer <key> and
 *        X-Workspace-Id: <workspace uid>, body { page, limit, status }
 *        -> { error, message, mailboxes: [{ uid, username, domain_name,
 *             first_name, last_name, platform, status }], total, pages,
 *             current_page, limit }
 *   GET  /v1/api/workspaces/list (no X-Workspace-Id)
 *        -> { error, message, workspaces: [{ uid, name, domains }] }
 *   GET  /v1/api/mailboxes/show-credentials?uid=<uid> (same headers)
 *        -> { error, message, password, secret, app_password }
 *
 * Pure: no Deno, no database. Passwords pass through this module and are
 * never logged or put on an error message.
 *
 * Tests: npx tsx tools/cold-warmup.test.ts
 */
import type { FetchLike } from './instantly.ts';

export const INBOXKIT_API_BASE = 'https://api.inboxkit.com/v1';
export const INBOXKIT_LIST_PATH = '/api/mailboxes/list';
export const INBOXKIT_CREDENTIALS_PATH = '/api/mailboxes/show-credentials';
/** Team-wide, no X-Workspace-Id: { error, message, workspaces: [{ uid, name, domains, ... }] }. */
export const INBOXKIT_WORKSPACES_PATH = '/api/workspaces/list';

export type InboxkitWorkspace = { uid: string; name: string; domains: number | null };

export type InboxkitMailbox = {
  uid: string;
  email: string;
  firstName: string;
  lastName: string;
  /** GOOGLE or MICROSOFT, as InboxKit labels it. */
  platform: string;
  status: string;
};

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** One page of the mailbox list. A row without a usable email is dropped. */
export function readInboxkitMailboxes(payload: unknown): { mailboxes: InboxkitMailbox[]; pages: number | null } {
  const body = rec(payload);
  const raw = Array.isArray(body?.mailboxes) ? body!.mailboxes : Array.isArray(body?.data) ? body!.data : [];
  const out: InboxkitMailbox[] = [];
  for (const row of raw) {
    const r = rec(row);
    if (!r) continue;
    const explicit = str(r.email).toLowerCase();
    const user = str(r.username).toLowerCase();
    const domain = str(r.domain_name ?? r.domain).toLowerCase();
    const email = explicit.includes('@') ? explicit : user && domain ? `${user}@${domain}` : '';
    if (!email.includes('@')) continue;
    out.push({
      uid: str(r.uid ?? r.id),
      email,
      firstName: str(r.first_name),
      lastName: str(r.last_name),
      platform: str(r.platform).toUpperCase() || 'GOOGLE',
      status: str(r.status).toLowerCase(),
    });
  }
  const pages = typeof body?.pages === 'number' && Number.isFinite(body.pages) ? body.pages : null;
  return { mailboxes: out, pages };
}

/** The app password first, then the account password. Null when neither came back. */
export function readInboxkitPassword(payload: unknown): string | null {
  const body = rec(payload);
  const app = str(body?.app_password);
  if (app) return app;
  const pw = str(body?.password);
  return pw || null;
}

/** The team's workspaces. A row without a uid is dropped. */
export function readInboxkitWorkspaces(payload: unknown): InboxkitWorkspace[] {
  const body = rec(payload);
  const raw = Array.isArray(body?.workspaces) ? body!.workspaces : Array.isArray(body?.data) ? body!.data : [];
  const out: InboxkitWorkspace[] = [];
  for (const row of raw) {
    const r = rec(row);
    const uid = str(r?.uid ?? r?.id);
    if (!uid) continue;
    const domains = typeof r?.domains === 'number' && Number.isFinite(r.domains) ? r.domains : null;
    out.push({ uid, name: str(r?.name), domains });
  }
  return out;
}

/**
 * Which workspace an import uses when none was given: the only one, else the
 * only one holding domains. Null when that still leaves a choice.
 */
export function pickInboxkitWorkspace(list: readonly InboxkitWorkspace[]): InboxkitWorkspace | null {
  if (list.length === 1) return list[0];
  const withDomains = list.filter((w) => (w.domains ?? 0) > 0);
  return withDomains.length === 1 ? withDomains[0] : null;
}

export class InboxkitError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'InboxkitError';
  }
}

async function call(fetchFn: FetchLike, key: string, workspaceUid: string, apiBase: string, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetchFn(`${apiBase.replace(/\/$/, '')}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(workspaceUid ? { 'X-Workspace-Id': workspaceUid } : {}), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const why = res.status === 401 ? 'the key was refused' : res.status === 404 ? 'not found (check the workspace id)' : 'request failed';
    throw new InboxkitError(res.status, `InboxKit ${res.status}: ${why}`);
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { return null; }
  const r = rec(body);
  if (r?.error === true) throw new InboxkitError(res.status, `InboxKit: ${str(r.message) || 'request failed'}`);
  return body;
}

/** The team's workspaces, read with the key alone, so nobody has to dig the id out of InboxKit. */
export async function listInboxkitWorkspaces(key: string, deps?: { fetchFn?: FetchLike; apiBase?: string | null }): Promise<InboxkitWorkspace[]> {
  const fetchFn: FetchLike = deps?.fetchFn ?? ((input, init) => fetch(input, init as RequestInit));
  return readInboxkitWorkspaces(await call(fetchFn, key, '', deps?.apiBase?.trim() || INBOXKIT_API_BASE, INBOXKIT_WORKSPACES_PATH));
}

/**
 * GET /v1/api/email-insights/workspace/mailboxes-health?page&limit (read
 * 2026-10-11): { success, data: [{ mailbox_id, status (healthy | low_activity
 * | inactive), sent_7d, bounce_7d, reply_rate_percent, bounce_rate_percent,
 * last_event_at }] }. Mailboxes with no events in 7 days are left out.
 */
export const INBOXKIT_HEALTH_PATH = '/api/email-insights/workspace/mailboxes-health';
/** GET ?domain= -> { dns_record: { records: [{ host, type, value, status }] } }; POST { domain, records: [{ host, type, value, ttl }] }. */
export const INBOXKIT_DNS_LIST_PATH = '/api/dns/list';
export const INBOXKIT_DNS_ADD_PATH = '/api/dns/add';

export type InboxkitHealth = {
  uid: string;
  status: string;
  sent7: number;
  bounce7: number;
  bounceRatePct: number | null;
  replyRatePct: number | null;
  lastEventAt: string | null;
};

export type InboxkitDnsRecord = { host: string; type: string; value: string; status: string };

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

export function readInboxkitHealth(payload: unknown): InboxkitHealth[] {
  const body = rec(payload);
  const raw = Array.isArray(body?.data) ? body!.data : Array.isArray(payload) ? payload : [];
  const out: InboxkitHealth[] = [];
  for (const row of raw) {
    const r = rec(row);
    const uid = str(r?.mailbox_id ?? r?.uid);
    if (!r || !uid) continue;
    const last = str(r.last_event_at);
    out.push({
      uid,
      status: str(r.status).toLowerCase() || 'inactive',
      sent7: Math.max(0, Math.floor(n(r.sent_7d) ?? 0)),
      bounce7: Math.max(0, Math.floor(n(r.bounce_7d) ?? 0)),
      bounceRatePct: n(r.bounce_rate_percent),
      replyRatePct: n(r.reply_rate_percent),
      lastEventAt: last && !last.startsWith('0001-') ? last : null,
    });
  }
  return out;
}

export function readInboxkitDns(payload: unknown): InboxkitDnsRecord[] {
  const rows = rec(rec(payload)?.dns_record)?.records;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const r = rec(row);
    return r ? [{ host: str(r.host), type: str(r.type).toUpperCase(), value: str(r.value), status: str(r.status).toLowerCase() }] : [];
  });
}

export type InboxkitClient = {
  listMailboxes(): Promise<InboxkitMailbox[]>;
  appPassword(uid: string): Promise<string | null>;
  mailboxesHealth(): Promise<InboxkitHealth[]>;
  /** Null when the domain is not in this InboxKit workspace (404). */
  dnsRecords(domain: string): Promise<InboxkitDnsRecord[] | null>;
  addDnsRecord(domain: string, record: { host: string; type: string; value: string; ttl?: number }): Promise<void>;
};

export function inboxkitClient(key: string, workspaceUid: string, deps?: { fetchFn?: FetchLike; apiBase?: string | null; maxPages?: number }): InboxkitClient {
  const fetchFn: FetchLike = deps?.fetchFn ?? ((input, init) => fetch(input, init as RequestInit));
  const apiBase = deps?.apiBase?.trim() || INBOXKIT_API_BASE;
  const maxPages = Math.max(1, deps?.maxPages ?? 20);
  return {
    async listMailboxes() {
      const all: InboxkitMailbox[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= maxPages; page++) {
        const { mailboxes, pages } = readInboxkitMailboxes(await call(fetchFn, key, workspaceUid, apiBase, INBOXKIT_LIST_PATH, { method: 'POST', body: { page, limit: 100 } }));
        let fresh = 0;
        for (const m of mailboxes) {
          if (seen.has(m.email)) continue;
          seen.add(m.email);
          all.push(m);
          fresh++;
        }
        if (!fresh || (pages != null && page >= pages)) break;
      }
      return all;
    },
    async appPassword(uid) {
      if (!uid) return null;
      const q = new URLSearchParams({ uid });
      return readInboxkitPassword(await call(fetchFn, key, workspaceUid, apiBase, `${INBOXKIT_CREDENTIALS_PATH}?${q}`));
    },
    async mailboxesHealth() {
      const all: InboxkitHealth[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const rows = readInboxkitHealth(await call(fetchFn, key, workspaceUid, apiBase, `${INBOXKIT_HEALTH_PATH}?page=${page}&limit=1000`));
        all.push(...rows);
        if (rows.length < 1000) break;
      }
      return all;
    },
    async dnsRecords(domain) {
      try {
        return readInboxkitDns(await call(fetchFn, key, workspaceUid, apiBase, `${INBOXKIT_DNS_LIST_PATH}?${new URLSearchParams({ domain })}`));
      } catch (err) {
        if (err instanceof InboxkitError && err.status === 404) return null;
        throw err;
      }
    },
    async addDnsRecord(domain, record) {
      try {
        await call(fetchFn, key, workspaceUid, apiBase, INBOXKIT_DNS_ADD_PATH, { method: 'POST', body: { domain, records: [{ ttl: 300, ...record }] } });
      } catch (err) {
        // 409: the record is already there, which is what we wanted.
        if (!(err instanceof InboxkitError && err.status === 409)) throw err;
      }
    },
  };
}
