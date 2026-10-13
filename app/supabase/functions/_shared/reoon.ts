/**
 * Reoon email verification (power mode only).
 *
 * REOON_API_KEY is read from the function environment. When it is missing this
 * module does not call Reoon: verifyEmails returns a clear error and writes
 * nothing. Quick mode is never used.
 *
 *   one address   GET  /api/v1/verify?email=&key=&mode=power
 *   many          POST /api/v1/create-bulk-verification-task/
 *                 GET  /api/v1/get-result-bulk-verification-task/?key=&task_id=
 *
 * safe is the only status that may be sent. catch_all, unknown and
 * role_account are parked (email_safe_to_send false), and so are invalid,
 * disabled, disposable, inbox_full and spamtrap. The raw status is kept on
 * email_status so a parked address is still distinguishable from a dead one.
 *
 * verifyRecords loads the addresses on the given buyers and sellers and
 * writes the four columns onto every row in this workspace whose email is
 * that address (buyers, buyer_emails, buyer_contacts, sellers).
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

type Any = any;

const BASE = 'https://emailverifier.reoon.com/api/v1';
/** Hard-coded. There is no caller-supplied mode. */
const MODE = 'power';
export const VERIFY_PROVIDER = 'reoon';
export const MISSING_KEY_ERROR = 'REOON_API_KEY is not set, so nothing was verified.';

const PARKED = new Set(['catch_all', 'unknown', 'role_account']);
const DEAD = new Set(['invalid', 'disabled', 'disposable', 'inbox_full', 'spamtrap']);

export type StatusClass = 'safe' | 'parked' | 'unsafe' | 'unknown';

export type VerifyResult = { email: string; status: string; safe: boolean; provider: typeof VERIFY_PROVIDER };

export type VerifyOutcome =
  | { ok: true; results: VerifyResult[]; missing: string[] }
  | { ok: false; error: string; missingKey?: boolean; pending?: boolean; task_id?: number | string | null };

type Env = { get(name: string): string | undefined };
type FetchLike = typeof fetch;
export type ReoonDeps = {
  env?: Env;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** How many times to read a bulk task before giving up. */
  polls?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lower-cased address, or null when it is not one. */
export function normalizeEmail(raw: unknown): string | null {
  const v = String(raw ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** Which pile a Reoon power-mode status belongs in. */
export function statusClass(status: string): StatusClass {
  const s = status.trim().toLowerCase();
  if (s === 'safe') return 'safe';
  if (PARKED.has(s)) return 'parked';
  if (DEAD.has(s)) return 'unsafe';
  return 'unknown';
}

/**
 * email_safe_to_send. Only `safe` is true. Parked statuses and hard failures
 * are false. Anything Reoon did not document is false too, so an unfamiliar
 * status is never treated as safe.
 */
export function safeToSend(status: string): boolean {
  return statusClass(status) === 'safe';
}

function resultOf(email: string, status: string): VerifyResult {
  return { email: normalizeEmail(email) ?? email.trim().toLowerCase(), status: status.trim().toLowerCase(), safe: safeToSend(status), provider: VERIFY_PROVIDER };
}

async function readJson(res: Response): Promise<Any> {
  return await res.json().catch(() => ({}));
}

/** One address, power mode. */
export async function verifyOne(email: string, key: string, fetchImpl: FetchLike): Promise<VerifyOutcome> {
  const url = `${BASE}/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}&mode=${MODE}`;
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    return { ok: false, error: `Reoon did not answer (${err instanceof Error ? err.message : 'unreachable'}).` };
  }
  const body = await readJson(res);
  if (!res.ok || body?.status === 'error') {
    return { ok: false, error: `Reoon refused that lookup${body?.reason ? `: ${body.reason}` : ` (${res.status})`}.` };
  }
  const status = String(body?.status ?? '').trim();
  if (!status) return { ok: false, error: 'Reoon returned no status for that address.' };
  return { ok: true, results: [resultOf(String(body?.email ?? email), status)], missing: [] };
}

function listed(results: unknown): Any[] {
  if (Array.isArray(results)) return results;
  if (results && typeof results === 'object') return Object.values(results as Record<string, unknown>);
  return [];
}

/** Many addresses. Reoon verifies a bulk task in power mode; this only polls it. */
export async function verifyBulk(emails: string[], key: string, deps: ReoonDeps = {}): Promise<VerifyOutcome> {
  const fetchImpl = deps.fetch ?? fetch;
  const pause = deps.sleep ?? sleep;
  const polls = deps.polls ?? 12;
  let created: Response;
  try {
    created = await fetchImpl(`${BASE}/create-bulk-verification-task/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name: 'CLOZR verify', emails, key }),
    });
  } catch (err) {
    return { ok: false, error: `Reoon did not answer (${err instanceof Error ? err.message : 'unreachable'}).` };
  }
  const createdBody = await readJson(created);
  if (!(created.status === 201 || created.ok) || createdBody?.status === 'error' || createdBody?.task_id == null) {
    return { ok: false, error: `Reoon did not start a verification${createdBody?.reason ? `: ${createdBody.reason}` : ` (${created.status})`}.` };
  }
  const taskId = createdBody.task_id as number | string;
  for (let i = 0; i < polls; i++) {
    if (i) await pause(2_000);
    let res: Response;
    try {
      res = await fetchImpl(`${BASE}/get-result-bulk-verification-task/?key=${encodeURIComponent(key)}&task_id=${encodeURIComponent(String(taskId))}`);
    } catch (err) {
      return { ok: false, error: `Reoon did not answer (${err instanceof Error ? err.message : 'unreachable'}).`, task_id: taskId };
    }
    const body = await readJson(res);
    if (!res.ok || body?.status === 'error') {
      return { ok: false, error: `Reoon refused that task${body?.reason ? `: ${body.reason}` : ` (${res.status})`}.`, task_id: taskId };
    }
    const state = String(body?.status ?? '');
    if (state === 'file_not_found' || state === 'file_loading_error') {
      return { ok: false, error: `Reoon could not read that task (${state}).`, task_id: taskId };
    }
    if (state !== 'completed') continue;
    const rows = listed(body?.results);
    const results = rows
      .map((row) => resultOf(String(row?.email ?? ''), String(row?.status ?? '')))
      .filter((row) => row.email.includes('@') && row.status);
    const have = new Set(results.map((r) => r.email));
    return { ok: true, results, missing: emails.filter((e) => !have.has(e)) };
  }
  return { ok: false, error: 'Reoon is still verifying that list.', pending: true, task_id: taskId };
}

/**
 * Verify these addresses. No key: a no-op with MISSING_KEY_ERROR, and fetch
 * is not called. One address uses the single lookup; more than one uses bulk.
 */
export async function verifyEmails(emails: string[], deps: ReoonDeps = {}): Promise<VerifyOutcome> {
  const env = deps.env ?? Deno.env;
  const key = (env.get('REOON_API_KEY') ?? '').trim();
  if (!key) return { ok: false, error: MISSING_KEY_ERROR, missingKey: true };
  const list = [...new Set(emails.map(normalizeEmail).filter((e): e is string => !!e))];
  if (!list.length) return { ok: true, results: [], missing: [] };
  if (list.length === 1) return verifyOne(list[0], key, deps.fetch ?? fetch);
  return verifyBulk(list, key, deps);
}

const ID_CAP = 200;
const EMAIL_CAP = 100;

function idList(raw: unknown): number[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > ID_CAP) return null;
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    out.push(n);
  }
  return [...new Set(out)];
}

function addEmail(into: Set<string>, raw: unknown) {
  const e = normalizeEmail(raw);
  if (e) into.add(e);
}

/** Every address on these buyer and seller rows, in this workspace. */
export async function collectAddresses(admin: SupabaseClient, workspaceId: number, buyerIds: number[], sellerIds: number[]): Promise<{ ok: true; emails: string[] } | { ok: false; error: string }> {
  const emails = new Set<string>();
  const take = async (table: string, column: string, ids: number[], fields: string) => {
    if (!ids.length) return;
    const { data, error } = await admin.from(table).select(fields).eq('workspace_id', workspaceId).in(column, ids);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Any[]) {
      addEmail(emails, row.email);
      if (Array.isArray(row.other_emails)) for (const extra of row.other_emails) addEmail(emails, extra);
    }
  };
  try {
    await take('buyers', 'id', buyerIds, 'email');
    await take('buyer_emails', 'buyer_id', buyerIds, 'email');
    await take('buyer_contacts', 'buyer_id', buyerIds, 'email');
    await take('sellers', 'id', sellerIds, 'email, other_emails');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not read those records.' };
  }
  const list = [...emails];
  if (list.length > EMAIL_CAP) return { ok: false, error: `That is ${list.length} addresses. Verify at most ${EMAIL_CAP} at a time.` };
  return { ok: true, emails: list };
}

const ADDRESS_TABLES = ['buyers', 'buyer_emails', 'buyer_contacts', 'sellers'] as const;

function sameAddress(row: Any, email: string): boolean {
  const own = normalizeEmail(row.email);
  const key = normalizeEmail(row.email_key);
  return own === email || key === email;
}

/**
 * Write email_status, email_safe_to_send, email_verified_at and
 * email_verify_provider onto every row in this workspace with that address.
 * Reads finish before the first update, so a failed read leaves the rows alone.
 */
export async function writeVerification(admin: SupabaseClient, workspaceId: number, results: VerifyResult[], at: Date = new Date()): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  const wanted = results.filter((r) => normalizeEmail(r.email));
  if (!wanted.length) return { ok: true, updated: 0 };
  const when = at.toISOString();
  const plan: { table: string; ids: number[]; patch: Record<string, unknown> }[] = [];
  for (const table of ADDRESS_TABLES) {
    const fields = table === 'buyer_emails' ? 'id, email, email_key' : 'id, email';
    let q = admin.from(table).select(fields).eq('workspace_id', workspaceId);
    q = table === 'buyer_emails'
      ? q.in('email_key', wanted.map((r) => r.email))
      : q.or(wanted.map((r) => `email.ilike.${r.email}`).join(','));
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as Any[];
    for (const result of wanted) {
      const ids = rows.filter((row) => sameAddress(row, result.email)).map((row) => Number(row.id)).filter((id) => Number.isInteger(id));
      if (!ids.length) continue;
      plan.push({
        table,
        ids,
        patch: {
          email_status: result.status,
          email_safe_to_send: result.safe,
          email_verified_at: when,
          email_verify_provider: VERIFY_PROVIDER,
        },
      });
    }
  }
  let updated = 0;
  for (const step of plan) {
    const { error } = await admin.from(step.table).update(step.patch).eq('workspace_id', workspaceId).in('id', step.ids);
    if (error) return { ok: false, error: error.message };
    updated += step.ids.length;
  }
  return { ok: true, updated };
}

export type VerifyRecordsResult =
  | { ok: true; verified: number; updated: number; results: VerifyResult[]; missing: string[] }
  | { ok: false; error: string; missingKey?: boolean; pending?: boolean; task_id?: number | string | null };

/** The deliverability `verify_emails` action: ids in, four columns written on every matching row. */
export async function verifyRecords(admin: SupabaseClient, workspaceId: number, body: { buyer_ids?: unknown; seller_ids?: unknown }, deps: ReoonDeps = {}): Promise<VerifyRecordsResult> {
  const buyerIds = idList(body.buyer_ids);
  const sellerIds = idList(body.seller_ids);
  if (!buyerIds || !sellerIds) return { ok: false, error: `buyer_ids and seller_ids must be lists of at most ${ID_CAP} ids.` };
  if (!buyerIds.length && !sellerIds.length) return { ok: false, error: 'Pass buyer_ids or seller_ids.' };
  const collected = await collectAddresses(admin, workspaceId, buyerIds, sellerIds);
  if (!collected.ok) return collected;
  if (!collected.emails.length) return { ok: true, verified: 0, updated: 0, results: [], missing: [] };
  const verified = await verifyEmails(collected.emails, deps);
  if (!verified.ok) return verified;
  const stored = await writeVerification(admin, workspaceId, verified.results, deps.now?.() ?? new Date());
  if (!stored.ok) return stored;
  return { ok: true, verified: verified.results.length, updated: stored.updated, results: verified.results, missing: verified.missing };
}
