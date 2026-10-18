/**
 * The pure parts of plan-tick: the claimed-row pool, the per-tick warmed
 * inbox pool and its health hold, the locks that keep both safe, and the
 * done write after a send. Apart from index.ts so
 * tools/plan-tick-pool.test.ts can run them under tsx.
 *
 * A tick reads a workspace's inbox pool once and counts its own sends into
 * it, where it used to read cold_domains, cold_mailboxes and 26 hours of
 * cold_sends for every due step. cold_send_claim stays the gate: it locks
 * the mailbox and the domain and counts cold_sends itself, so a stale pool
 * can only make a claim fail, never let a cap through.
 */
import { eachLimited } from '../../../lib/each-limited.ts';
import { mailboxDayStart, poolPauseReason, type ColdDeliverability, type ColdDomain, type ColdMailbox } from '../_shared/cold-campaign.ts';
import { domainOf } from '../_shared/deliverability-rules.ts';
import type { Health } from '../cold-campaign-tick/tick.ts';

type Any = any;

/** Claimed rows in flight at once. */
export const POOL = 5;

export type Pool = { mailboxes: ColdMailbox[]; domains: ColdDomain[]; raw: Any[] };
export type SendRow = { mailbox_id: number | string; sent_at: string };
export type Serial = <T>(job: () => Promise<T>) => Promise<T>;

/** Jobs run one at a time, in the order they were handed in. A job that throws does not stop the next. */
export function serial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** serial() per key. */
export function serialBy<K>(): <T>(key: K, job: () => Promise<T>) => Promise<T> {
  const chains = new Map<K, Serial>();
  return <T>(key: K, job: () => Promise<T>): Promise<T> => {
    let chain = chains.get(key);
    if (!chain) chains.set(key, chain = serial());
    return chain(job);
  };
}

/**
 * Every claimed row once, POOL at a time. Rows that share a key (one record)
 * keep the claim order and never overlap, so a tag step and an email step on
 * the same buyer read and write its tags one after the other, as the serial
 * loop did.
 */
export function eachClaimed<R>(rows: readonly R[], key: (row: R) => string, job: (row: R) => Promise<void>): Promise<void[]> {
  const inOrder = serialBy<string>();
  return eachLimited(rows, POOL, (row) => inOrder(key(row), () => job(row)));
}

export function asSettings(m: Any) {
  return {
    daily_cap: Number(m.daily_cap), hourly_cap: Number(m.hourly_cap), min_gap_seconds: Number(m.min_gap_seconds),
    window_start: 0, window_end: 24, window_days: [0, 1, 2, 3, 4, 5, 6], timezone: m.timezone || 'America/Chicago',
    ramp_enabled: !!m.ramp_enabled, ramp_start: Number(m.ramp_start), ramp_increase_pct: Number(m.ramp_increase_pct),
    ramp_target: Number(m.ramp_target), ramp_started_on: String(m.ramp_started_on ?? '').slice(0, 10),
    paused: !!m.paused, paused_reason: m.paused_reason ?? null,
  };
}

/**
 * The oldest cold_sends row the pool can use. The daily count starts at each
 * mailbox's local midnight, the hourly count an hour back, and the gap test
 * looks back at most gapMaxSeconds (the policy clamps it to 2 hours). A send
 * older than all three changes no count and no pick, and cold_send_claim's
 * own gap test passes it too, so the read stops here instead of 26 hours back.
 */
export function sendsSince(raw: readonly Any[], now: Date, gapMaxSeconds: number): Date {
  let t = now.getTime() - Math.max(3600, gapMaxSeconds) * 1000;
  for (const m of raw) t = Math.min(t, mailboxDayStart(asSettings(m), now).getTime());
  return new Date(t);
}

/** The rotation pool from the rows loadPool read. `now` must be the one sendsSince used. */
export function buildPool(raw: Any[], domains: readonly Any[], sent: readonly SendRow[], now: Date, gate: boolean): Pool {
  const domainSent = new Map<number, number>();
  const mailboxes: ColdMailbox[] = raw.map((m) => {
    const start = mailboxDayStart(asSettings(m), now).getTime();
    const hour = now.getTime() - 3_600_000;
    const mine = sent.filter((s) => Number(s.mailbox_id) === Number(m.id));
    const todayRows = mine.filter((s) => Date.parse(s.sent_at) >= start);
    domainSent.set(Number(m.domain_id), (domainSent.get(Number(m.domain_id)) ?? 0) + todayRows.length);
    return {
      id: Number(m.id), domainId: Number(m.domain_id), domain: domainOf(m.email), email: m.email,
      paused: !!m.paused, status: String(m.status), settings: asSettings(m),
      signature: m.signature ?? null, restWeekday: m.rest_weekday == null ? null : Number(m.rest_weekday),
      warmupDaily: m.warmup_daily == null ? null : Number(m.warmup_daily),
      warmupGated: gate && String(m.status) === 'warming',
      sentToday: todayRows.length, sentLastHour: mine.filter((s) => Date.parse(s.sent_at) >= hour).length,
      lastSentAt: mine.reduce((max: string | null, s) => !max || s.sent_at > max ? s.sent_at : max, null),
    };
  });
  const coldDomains: ColdDomain[] = domains.map((d) => ({
    id: Number(d.id), domain: String(d.domain), dailyCap: Number(d.daily_cap), sentToday: domainSent.get(Number(d.id)) ?? 0,
    paused: !!d.paused, blocking: (d.blocking ?? []) as string[], checkedAt: d.checked_at ?? null, trackingDomain: d.tracking_domain ?? null,
  }));
  for (const m of mailboxes) {
    const d = coldDomains.find((x) => x.id === m.domainId);
    if (d) m.domain = d.domain;
  }
  return { mailboxes, domains: coldDomains, raw };
}

/** The send cold_send_claim just queued, counted the way the next read of cold_sends would count it. */
export function noteSend(pool: Pool, mailboxId: number, at: string): void {
  const m = pool.mailboxes.find((x) => x.id === mailboxId);
  if (!m) return;
  m.sentToday++;
  m.sentLastHour++;
  m.lastSentAt = at;
  const d = pool.domains.find((x) => x.id === m.domainId);
  if (d) d.sentToday++;
}

export type PoolSlot = { pool: Pool | null; lock: Serial };

/**
 * Pick a mailbox and claim it, one step of the workspace at a time, from the
 * tick's pool. `attempt` picks and runs cold_send_claim, and returns
 * 'refused' when the claim says no. A refusal on a pool read earlier in the
 * tick (another sender may have used that inbox since) reads again and tries
 * once more, so a step is only turned away on a fresh read, as it was when
 * every step read its own pool.
 */
export function withPool<T>(slot: PoolSlot, load: () => Promise<Pool>, attempt: (pool: Pool) => Promise<T | 'refused'>): Promise<T | 'refused'> {
  return slot.lock(async () => {
    const cached = slot.pool;
    slot.pool = cached ?? await load();
    const first = await attempt(slot.pool);
    if (first !== 'refused' || !cached) return first;
    slot.pool = await load();
    return attempt(slot.pool);
  });
}

/** Forget the tick's pool after a claimed send was taken back, so the next step reads cold_sends again. */
export function dropPool(slot: PoolSlot): Promise<void> {
  return slot.lock(async () => { slot.pool = null; });
}

/**
 * The workspace's cold_pool_health (migration 333), read with the pool, or
 * null. A failed read is logged and the steps go on under the pause flags
 * and caps, as cold-campaign-tick's sends do when its health pass fails.
 */
export async function readHealth(admin: Any, wsId: number, now: Date): Promise<Health | null> {
  try {
    const { data, error } = await admin.rpc('cold_pool_health', {
      p_workspace: wsId, p_since7: new Date(now.getTime() - 7 * 86_400_000).toISOString(), p_since30: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    });
    if (error) throw new Error(error.message);
    return data as Health;
  } catch (err) {
    console.error('plan-tick cold health', wsId, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Marks off in this tick's pool every mailbox and domain that
 * cold-campaign-tick's health pass would pause right now (poolPauseReason on
 * the same counts), so a plan step never sends from one in the up to 15
 * minutes before that pass writes the pause. Only ever marks off; the pass
 * still writes it. Returns the ids held.
 */
export function holdUnhealthy(pool: Pool, health: Health, policy: ColdDeliverability): { mailboxes: number[]; domains: number[] } {
  const held = { mailboxes: [] as number[], domains: [] as number[] };
  for (const b of health.mailboxes) {
    const m = pool.mailboxes.find((x) => x.id === Number(b.id));
    if (!m || m.paused || b.paused || !poolPauseReason({ ...b, policy })) continue;
    m.paused = true;
    held.mailboxes.push(m.id);
  }
  for (const h of health.domains) {
    const d = pool.domains.find((x) => x.id === Number(h.id));
    if (!d || d.paused || h.paused || !poolPauseReason({ ...h, policy })) continue;
    d.paused = true;
    held.domains.push(d.id);
  }
  return held;
}

/** plan_send_claim and plan_kick take a task whose plan_claim_at is null or 10 minutes old; this is neither, ever. */
export const HELD_AS_SENT = 'infinity';

/**
 * A sent step's done write (index.ts finish), tried three times. If it
 * never lands, plan_claim_at moves to HELD_AS_SENT, a write without `done`
 * (so the done triggers, which may be what failed, do not run): the step is
 * never claimed again, so the text or email does not go out twice. The task
 * stays open for a person to close. A write that throws counts as one that
 * failed. False only when neither write landed; it never throws.
 */
export async function closeSent(admin: Any, taskId: number, done: Record<string, unknown>, wait: (ms: number) => Promise<unknown> = sleep): Promise<boolean> {
  for (const patch of [done, { plan_claim_at: HELD_AS_SENT }]) {
    for (const ms of [0, 300, 1000]) {
      try {
        if (ms) await wait(ms);
        const { error } = await admin.from('tasks').update(patch).eq('id', taskId);
        if (error) continue;
      } catch {
        continue;
      }
      if (patch !== done) console.error('plan-tick', taskId, 'sent, but the done write failed; held so it is not sent again');
      return true;
    }
  }
  console.error('plan-tick', taskId, 'SENT BUT NOT RECORDED: neither the done write nor the hold landed; the claim stays and lapses in 10 minutes');
  return false;
}

/**
 * Claimed rows whose send has returned (index.ts adds each one the moment
 * it does). From then on nothing may release the row: a reclaim would send
 * it again.
 */
export const sentSteps = new WeakSet<object>();

/**
 * The tick's catch for a claimed row that threw. Before its send the row is
 * released for a retry, as before. After it, never: `close` writes it done
 * or holds it (closeSent), and if even that fails the claim is left in place
 * and lapses after 10 minutes, as a claim always did.
 */
export async function afterThrow(row: object, release: () => Promise<void>, close: () => Promise<boolean>): Promise<'released' | 'closed' | 'kept'> {
  if (!sentSteps.has(row)) {
    await release();
    return 'released';
  }
  return (await close()) ? 'closed' : 'kept';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
