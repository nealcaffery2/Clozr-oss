/**
 * BatchData skip trace (developer.batchdata.com), for LLCs and other entity
 * owners (and individuals when RealEstateAPI is out of credits): genius-discover's
 * trace() routes them here. Request bodies come from skipTarget() and answers
 * are mapped by mapSkipBatch(), both in genius-core.ts.
 *
 * v3, not v1, for one reason: only v3 returns the per-phone `dnc` and `tcpa`
 * flags, so a do-not-call number keeps showing as DNC instead of arriving
 * unmarked and dialable. v3 also returns up to 3 persons per property (v1
 * returns one) and carries a per-item requestId, so an answer belongs to the
 * owner it was asked for rather than to its position in the array.
 *
 * A dead key, empty wallet, rate limit, timeout or unreadable answer is a
 * BatchDataError, so the caller never caches it or shows it as "no contact found".
 */

import type { Any, SkipRequest } from './genius-core.ts';

export type { SkipRequest };

const SKIP_TRACE = 'https://api.batchdata.com/api/v3/property/skip-trace';
const PER_CALL = 25;              // BatchData takes up to 100; smaller calls stay well inside the timeout.

export class BatchDataError extends Error { constructor(msg: string, public status = 502) { super(msg); } }

/** Errors that will fail every other call too, so a batch stops instead of burning through targets. */
export const fatal = (e: unknown): boolean => e instanceof BatchDataError && [503, 429, 402].includes(e.status);

function key(): string {
  const k = (Deno.env.get('BATCHDATA_API_KEY') ?? '').trim();
  if (!k) throw new BatchDataError('Skip tracing is not connected: set the BATCHDATA_API_KEY secret on the Supabase project.', 503);
  return k;
}

/** What BatchData sent back for one requested owner (a result.data item), or the error its call hit. */
export type SkipAnswer = Any | BatchDataError;

/** A request BatchData bills: matched, no item error, and at least one person came back. */
export const billable = (d: SkipAnswer): boolean =>
  !(d instanceof BatchDataError) && d?.meta?.error !== true && d?.meta?.matched !== false && (d?.persons?.length ?? 0) > 0;

/**
 * One BatchData call for up to PER_CALL requests, writing each answer into
 * `out` at its request's index. Answers are matched back by the requestId we
 * set, so a reordered or short response can never put one owner's phones on
 * another. Returns what BatchData says it billed for the call.
 */
async function call(requests: SkipRequest[], from: number, out: SkipAnswer[]): Promise<number> {
  let res: Response;
  const body = {
    requests: requests.map((r, i) => ({ ...r, requestId: String(from + i) })),
    // TCPA-flagged numbers stay in the answer so they show as DNC; excluding
    // them would hide the number instead of marking it.
    options: { includeTCPABlacklistedPhones: true },
  };
  try {
    res = await fetch(SKIP_TRACE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    if (e instanceof BatchDataError) throw e;
    if ((e as Error)?.name === 'TimeoutError') throw new BatchDataError('BatchData took too long to answer the skip trace. Try again in a moment.', 504);
    throw new BatchDataError('Could not reach BatchData for the skip trace. Try again in a moment.', 502);
  }
  if (res.status === 401 || res.status === 403) throw new BatchDataError('BatchData rejected the key — check BATCHDATA_API_KEY on the Supabase project.', 503);
  if (res.status === 402) throw new BatchDataError('BatchData is out of credits — top up the wallet at app.batchdata.com, then skip trace again.', 402);
  if (res.status === 429) throw new BatchDataError('BatchData is rate limiting this account right now. Try again in a minute.', 429);
  if (!res.ok) throw new BatchDataError(`BatchData answered ${res.status} on the skip trace.`);
  const j = await res.json().catch(() => null);
  const data = j?.result?.data;
  if (!Array.isArray(data)) throw new BatchDataError('BatchData sent back a skip trace answer we could not read. Try again in a moment.');
  const missing = new BatchDataError('BatchData left this owner out of its skip trace answer. Try again in a moment.');
  for (let i = 0; i < requests.length; i++) out[from + i] = missing;
  for (const d of data) {
    const i = Number(d?.input?.requestId ?? d?.requestId);
    if (Number.isInteger(i) && i >= from && i < from + requests.length) out[i] = d;
  }
  const billed = Number(j?.result?.meta?.results?.matchCount);
  return Number.isFinite(billed) && billed >= 0 ? billed : data.filter(billable).length;
}

/**
 * Skip trace every request, PER_CALL per BatchData call, `concurrency` calls at
 * a time. `billed` is what BatchData says it charged for the calls that went
 * through, so the caller logs real spend even when a later call fails. After a
 * fatal error (key, credits, rate limit) no new calls start and every request
 * not yet sent carries an error rather than reading as "nothing found".
 */
export async function skipTrace(requests: SkipRequest[], concurrency = 2): Promise<{ answers: SkipAnswer[]; billed: number }> {
  const answers: SkipAnswer[] = new Array(requests.length);
  const chunks: number[] = [];
  for (let i = 0; i < requests.length; i += PER_CALL) chunks.push(i);
  let next = 0; let billed = 0; let stop: BatchDataError | null = null;
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (next < chunks.length && !stop) {
      const from = chunks[next++];
      const part = requests.slice(from, from + PER_CALL);
      try {
        billed += await call(part, from, answers);
      } catch (e) {
        const err = e instanceof BatchDataError ? e : new BatchDataError('Skip trace failed on our side. Try again in a moment.');
        part.forEach((_, i) => { answers[from + i] = err; });
        if (fatal(err)) stop = err;
      }
    }
  }));
  const left: BatchDataError = stop ?? new BatchDataError('Skip trace stopped before this owner. Try again in a moment.');
  for (let i = 0; i < answers.length; i++) if (answers[i] === undefined) answers[i] = left;
  return { answers, billed };
}
