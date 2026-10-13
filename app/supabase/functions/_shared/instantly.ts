/**
 * Instantly API v2, the two reads the cold pool needs: the account list
 * (is this inbox warming on Instantly, and what score does it carry) and
 * warmup analytics (how many warmup mails went out, and how many of those
 * landed in Spam, over the last 14 days).
 *
 * Pure: no Deno, no database. The caller hands in the Bearer key, already
 * unsealed, and a fetch. Every field read is defensive: a shape we do not
 * recognise reads as null or zero, never as a throw inside the tick. An
 * HTTP failure does throw, with the status in the message, so the caller
 * can record a warmup_error instead of a number.
 *
 * Documented shapes (developer.instantly.ai, api-reference/account):
 *   GET  /accounts?limit=100&starting_after=…  -> { items: [{ email, status,
 *        warmup_status, stat_warmup_score, timestamp_warmup_start,
 *        warmup: { limit }, daily_limit }], next_starting_after }
 *   POST /accounts/warmup-analytics { emails } -> { email_date_data:
 *        { [email]: { [yyyy-mm-dd]: { sent, landed_inbox, landed_spam } } },
 *        aggregate_data: { [email]: { sent, landed_inbox, landed_spam, health_score } } }
 *
 * Tests: npx tsx tools/cold-warmup.test.ts
 */

export const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2';
/** Instantly's warmup_status for an inbox whose warmup is running. */
export const INSTANTLY_WARMUP_ACTIVE = 1;
export const WARMUP_WINDOW_DAYS = 14;

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export type InstantlyAccount = {
  email: string;
  /** Instantly account status; 1 is active. */
  status: number | null;
  /** 1 when Instantly is warming the inbox. */
  warmupStatus: number | null;
  warming: boolean;
  warmupLimit: number | null;
  dailyLimit: number | null;
  /** stat_warmup_score, 0 to 100. */
  warmupScore: number | null;
  warmupStartedAt: string | null;
};

export type WarmupAnalytics = {
  email: string;
  /** health_score from aggregate_data, 0 to 100. */
  score: number | null;
  /** Warmup mails sent in the window. */
  sent: number;
  /** Of those, the ones that landed in the inbox. */
  inbox: number;
  /** Of those, the ones that landed in Spam. */
  spam: number;
  /** Days with data inside the window. 0 means the aggregate was used as is. */
  days: number;
};

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function count(v: unknown): number {
  const n = num(v);
  return n == null || n < 0 ? 0 : Math.floor(n);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function emailOf(v: unknown): string | null {
  const s = str(v)?.toLowerCase() ?? null;
  return s && s.includes('@') ? s : null;
}

/** One page of GET /accounts, read defensively. Unknown rows are dropped. */
export function readAccountsPage(payload: unknown): { items: InstantlyAccount[]; next: string | null } {
  const body = rec(payload);
  const raw = Array.isArray(body?.items) ? body!.items : Array.isArray(payload) ? payload : [];
  const items: InstantlyAccount[] = [];
  for (const row of raw) {
    const r = rec(row);
    const email = emailOf(r?.email);
    if (!r || !email) continue;
    const warmupStatus = num(r.warmup_status);
    const warm = rec(r.warmup);
    items.push({
      email,
      status: num(r.status),
      warmupStatus,
      warming: warmupStatus === INSTANTLY_WARMUP_ACTIVE,
      warmupLimit: num(warm?.limit),
      dailyLimit: num(r.daily_limit),
      warmupScore: num(r.stat_warmup_score),
      warmupStartedAt: str(r.timestamp_warmup_start),
    });
  }
  return { items, next: str(body?.next_starting_after) };
}

/**
 * Per-email totals over the last `windowDays` ending at `now`. The day
 * buckets are summed when the vendor sends them; otherwise the aggregate
 * is taken as the window. health_score is the aggregate's.
 */
export function readWarmupAnalytics(payload: unknown, now: Date = new Date(), windowDays = WARMUP_WINDOW_DAYS): Map<string, WarmupAnalytics> {
  const out = new Map<string, WarmupAnalytics>();
  const body = rec(payload);
  const aggregate = rec(body?.aggregate_data) ?? {};
  const byDate = rec(body?.email_date_data) ?? {};
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const emails = new Set<string>([...Object.keys(aggregate), ...Object.keys(byDate)].map((e) => e.toLowerCase()));
  for (const email of emails) {
    if (!email.includes('@')) continue;
    const agg = rec(aggregate[email] ?? aggregate[Object.keys(aggregate).find((k) => k.toLowerCase() === email) ?? '']);
    const days = rec(byDate[email] ?? byDate[Object.keys(byDate).find((k) => k.toLowerCase() === email) ?? '']);
    let sent = 0;
    let inbox = 0;
    let spam = 0;
    let n = 0;
    if (days) {
      for (const [day, v] of Object.entries(days)) {
        const d = rec(v);
        if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < since) continue;
        sent += count(d.sent);
        inbox += count(d.landed_inbox);
        spam += count(d.landed_spam);
        n++;
      }
    }
    if (!n && agg) {
      sent = count(agg.sent);
      inbox = count(agg.landed_inbox);
      spam = count(agg.landed_spam);
    }
    out.set(email, { email, score: num(agg?.health_score), sent, inbox, spam, days: n });
  }
  return out;
}

export class InstantlyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'InstantlyError';
  }
}

async function call(fetchFn: FetchLike, key: string, apiBase: string, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetchFn(`${apiBase.replace(/\/$/, '')}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = String((rec(await res.json()) ?? {}).message ?? ''); } catch { /* body was not JSON */ }
    const why = res.status === 401 ? 'the key was refused' : res.status === 402 ? 'the Instantly plan is not active' : res.status === 429 ? 'rate limited' : detail || 'request failed';
    throw new InstantlyError(res.status, `Instantly ${res.status}: ${why}`);
  }
  try { return await res.json(); } catch { return null; }
}

export type InstantlyClient = {
  listAccounts(): Promise<InstantlyAccount[]>;
  warmupAnalytics(emails: readonly string[], now?: Date): Promise<Map<string, WarmupAnalytics>>;
  /** POST /accounts/warmup/enable: turns warmup back on. Instantly runs it as a background job. */
  enableWarmup(emails: readonly string[]): Promise<void>;
};

/** `key` is the plain Bearer token; the caller unseals cold_warmup_secrets.api_key first. */
export function instantlyClient(key: string, deps?: { fetchFn?: FetchLike; apiBase?: string | null; maxPages?: number }): InstantlyClient {
  const fetchFn: FetchLike = deps?.fetchFn ?? ((input, init) => fetch(input, init as RequestInit));
  const apiBase = deps?.apiBase?.trim() || INSTANTLY_API_BASE;
  const maxPages = Math.max(1, deps?.maxPages ?? 20);
  return {
    async listAccounts() {
      const all: InstantlyAccount[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page++) {
        const q = new URLSearchParams({ limit: '100' });
        if (cursor) q.set('starting_after', cursor);
        const { items, next } = readAccountsPage(await call(fetchFn, key, apiBase, `/accounts?${q}`));
        all.push(...items);
        if (!next || !items.length || next === cursor) break;
        cursor = next;
      }
      return all;
    },
    async warmupAnalytics(emails, now = new Date()) {
      const out = new Map<string, WarmupAnalytics>();
      const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const page = readWarmupAnalytics(await call(fetchFn, key, apiBase, '/accounts/warmup-analytics', { method: 'POST', body: { emails: chunk } }), now);
        for (const [email, reading] of page) out.set(email, reading);
      }
      return out;
    },
    async enableWarmup(emails) {
      if (emails.length) await call(fetchFn, key, apiBase, '/accounts/warmup/enable', { method: 'POST', body: { emails: [...emails] } });
    },
  };
}
