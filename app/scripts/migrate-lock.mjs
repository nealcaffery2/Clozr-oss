// One migration run at a time, for scripts/migrate.mjs. The Vercel production
// build (deploy-supabase.mjs) and the "Apply database migrations" workflow can
// both start on the same merge; without a lock both read the ledger and apply
// the same pending files at once.
//
// The lock is the one row of public.migration_lock (migration 435), not a
// pg_advisory_lock: the Management API path sends each statement as its own
// request, a session of its own, so a session lock would not last the run.
// A runner takes the row with a conditional UPDATE, refreshes locked_at before
// each file and clears it when done. A row held longer than STALE_MIN belongs
// to a runner that died, and the next one takes it over.
//
// The database calls come in as `rows(sql)` and `exec(sql)`, so the logic is
// tested without a database in tools/migrate-lock.test.ts.

import { randomBytes } from 'node:crypto';

export const LOCK_TABLE = 'public.migration_lock';
/** A lock older than this belongs to a runner that died. */
export const STALE_MIN = 30;
/** How long a runner waits for another one to finish. */
export const WAIT_MS = 15 * 60_000;
export const POLL_MS = 10_000;

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Who holds the lock: this Vercel deployment, this workflow run, or a random id.
 * @param {Record<string, string | undefined>} [env]
 * @param {() => string} [random]
 */
export function lockHolder(env = process.env, random = () => randomBytes(6).toString('hex')) {
  if (env.VERCEL_DEPLOYMENT_ID) return `vercel:${env.VERCEL_DEPLOYMENT_ID}`;
  if (env.GITHUB_RUN_ID) return `github:${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT ? `.${env.GITHUB_RUN_ATTEMPT}` : ''}`;
  return `local:${random()}`;
}

/**
 * The conditional take. psql's rows() wraps a query in a SELECT, where an
 * UPDATE … RETURNING cannot go, so the caller reads the row back after it;
 * the WHERE is re-checked under the row lock, so of two runners racing only
 * one ends up the holder.
 */
export function takeSql(holder, staleMin = STALE_MIN) {
  return `insert into ${LOCK_TABLE} (id) values (1) on conflict (id) do nothing;
update ${LOCK_TABLE} set holder = ${lit(holder)}, locked_at = now()
  where id = 1 and (holder is null or holder = ${lit(holder)} or locked_at is null or locked_at < now() - interval '${Number(staleMin)} minutes');
`;
}

export const readSql = `select holder, locked_at from ${LOCK_TABLE} where id = 1`;
export const presentSql = `select to_regclass(${lit(LOCK_TABLE)}) is not null as present`;
export const heartbeatSql = (holder) => `update ${LOCK_TABLE} set locked_at = now() where id = 1 and holder = ${lit(holder)};\n`;
export const releaseSql = (holder) => `update ${LOCK_TABLE} set holder = null, locked_at = null where id = 1 and holder = ${lit(holder)};\n`;

/**
 * Take the lock, waiting for another runner up to `waitMs`. Returns
 * { taken: true } once held, { taken: false } when the table does not exist
 * yet (the run that applies 435), and throws when the wait runs out.
 */
export async function acquireLock({ rows, exec, holder, sleep, now = Date.now, waitMs = WAIT_MS, pollMs = POLL_MS, staleMin = STALE_MIN, log = () => {} }) {
  const [state] = await rows(presentSql);
  if (!state?.present) return { taken: false };
  const until = now() + waitMs;
  for (;;) {
    await exec(takeSql(holder, staleMin));
    const [row] = await rows(readSql);
    if (row?.holder === holder) return { taken: true };
    if (now() >= until) throw new Error(`waited ${Math.round(waitMs / 60_000)} minutes for the migration lock held by ${row?.holder} since ${row?.locked_at}; nothing applied.`);
    log(`another migration run (${row?.holder}, since ${row?.locked_at}) holds the lock; waiting.`);
    await sleep(pollMs);
  }
}

/** Refresh locked_at; throws when another runner has taken the lock over. */
export async function keepLock({ rows, exec, holder }) {
  await exec(heartbeatSql(holder));
  const [row] = await rows(readSql);
  if (row?.holder !== holder) throw new Error(`lost the migration lock to ${row?.holder ?? 'nobody'}; stopping so two runs do not apply the same files.`);
}
