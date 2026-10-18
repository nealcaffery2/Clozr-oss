/**
 * cold-campaign-tick, the parts that hold no network of their own: the
 * per-tick memo, the pool counters a send moves, the due-row claim, the
 * write after a send and its repair, the 15-minute health slot, and the
 * health counts the 30-day pass reads.
 *
 * Tests: npx tsx tools/cold-campaign-tick.test.ts
 */
import { mailboxGapSeconds, type ColdDeliverability, type ColdDomain, type ColdMailbox, type RecipientProvider } from '../_shared/cold-campaign.ts';

type Any = any;

export type Pool = { mailboxes: ColdMailbox[]; domains: ColdDomain[]; raw: Any[] };

/** One load per key for the tick. A failed load is not kept, so the next row reads again. */
export function memo<V>(map: Map<string, Promise<V>>, key: string, load: () => Promise<V>): Promise<V> {
  let hit = map.get(key);
  if (!hit) {
    hit = load();
    map.set(key, hit);
    hit.catch(() => map.delete(key));
  }
  return hit;
}

/** The rows of a read, or a throw. A failed read must never look like "nothing there". */
export function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/**
 * Count one send in the tick's pool the way a fresh loadPool would see its
 * cold_sends row: today, the last hour, the last send, the recipient
 * provider, and the domain's day. Every later plan in the tick checks the
 * caps, the gap and the provider spread against these.
 */
export function countSend(pool: Pool, mailboxId: number, provider: RecipientProvider, at: string): void {
  const m = pool.mailboxes.find((x) => x.id === mailboxId);
  if (!m) return;
  m.sentToday++;
  m.sentLastHour++;
  if (!m.lastSentAt || Date.parse(at) > Date.parse(m.lastSentAt)) m.lastSentAt = at;
  m.sentByProvider = { ...m.sentByProvider, [provider]: (m.sentByProvider?.[provider] ?? 0) + 1 };
  const d = pool.domains.find((x) => x.id === m.domainId);
  if (d) d.sentToday++;
}

/**
 * The gap cold_send_claim checks. With no send seen from this mailbox it is
 * the policy's minimum instead of 0, so a send another process made after the
 * pool was read (an overlapping tick, plan-tick) is refused by the claim. When
 * the pool saw no send, cold_send_claim's window (since the mailbox's day
 * start or an hour ago, inside the pool's 26 hours) has none either, unless
 * someone else sent since: then and only then the floor refuses.
 */
export function claimGap(m: ColdMailbox | undefined, now: Date, policy: ColdDeliverability): number {
  return (m ? mailboxGapSeconds(m, now, policy) : 0) || policy.gapMinSeconds;
}

/**
 * Takes a due row for this run before its send is claimed. The update only
 * matches the row as this run read it (active, same step, same next_send_at)
 * and moves next_send_at to `until`, so of two runs that read the same row
 * exactly one gets it back; the other sends nothing.
 */
export async function claimEnrollment(admin: Any, row: Any, until: string): Promise<boolean> {
  const { data, error } = await admin.from('cold_enrollments').update({ next_send_at: until })
    .eq('id', row.id).eq('status', 'active').eq('step_position', row.step_position).eq('next_send_at', row.next_send_at)
    .select('id');
  return !error && ((data ?? []) as Any[]).length > 0;
}

/**
 * The enrollment once its step has gone out: on to the next step, due now
 * (the planner applies the business-day delay from last_sent_at), or
 * finished. The one write after a send, and the repair below.
 */
export function advancePatch(
  row: Any, steps: readonly { position: number }[], stepPosition: number,
  sent: { at: string; mailboxId: number | null; rfc: string | null; threadId: string | null }, now: Date,
) {
  const next = steps.find((s) => s.position === stepPosition + 1);
  return {
    last_sent_at: sent.at,
    mailbox_id: row.mailbox_id ?? sent.mailboxId,
    thread_message_id: row.thread_message_id ?? sent.rfc,
    provider_thread_id: sent.threadId ?? row.provider_thread_id,
    step_position: next ? next.position : stepPosition,
    status: next ? 'active' : 'completed',
    stop_reason: next ? null : 'Sequence finished.',
    stopped_at: next ? null : now.toISOString(),
    next_send_at: now.toISOString(),
  };
}

/** A queued send younger than this may still be in flight in another run. */
export const IN_FLIGHT_MS = 10 * 60_000;

/**
 * The earlier send of this step when cold_send_claim refused because the
 * step already went out (migration 352, reason 'step_sent'): the write that
 * moves the enrollment on after a send did not land. The tick then moves it
 * on (advancePatch) instead of sending again. A queued row is the claim of a
 * run whose 'sent' write did not land, or whose send died with it; one past
 * IN_FLIGHT_MS (an edge run lives at most 400 s, and the row's own claim put
 * the enrollment 15 minutes out) is taken as sent, so the step is never sent
 * twice. Null for every other refusal and for a failed call.
 */
export function priorSend(claim: Any, now: Date): { at: string; rfc: string | null; mailboxId: number | null } | null {
  if (claim?.reason !== 'step_sent') return null;
  const at = String(claim.sent_at ?? '');
  if (claim.send_status === 'queued' && !(Date.parse(at) <= now.getTime() - IN_FLIGHT_MS)) return null;
  return { at, rfc: claim.rfc_message_id ?? null, mailboxId: claim.mailbox_id == null ? null : Number(claim.mailbox_id) };
}

export const HEALTH_EVERY_MS = 15 * 60_000;

/**
 * True for the one run that takes this workspace's 15-minute health pass
 * (cold_workspace_settings.health_checked_at, migration 334). An error,
 * such as the column not there yet, runs the pass, as every tick did before.
 */
export async function healthSlot(admin: Any, ws: number, now: Date): Promise<boolean> {
  const { data, error } = await admin.from('cold_workspace_settings').update({ health_checked_at: now.toISOString() })
    .eq('workspace_id', ws).lte('health_checked_at', new Date(now.getTime() - HEALTH_EVERY_MS).toISOString())
    .select('workspace_id');
  if (error) return true;
  return ((data ?? []) as Any[]).length > 0;
}

/**
 * Reopens the slot after a failed pass, so the next tick takes it and tries
 * again. A stamp newer than this run's (a later run that took the slot since)
 * is left alone.
 */
export async function releaseHealthSlot(admin: Any, ws: number, now: Date): Promise<void> {
  await admin.from('cold_workspace_settings').update({ health_checked_at: '-infinity' })
    .eq('workspace_id', ws).lte('health_checked_at', now.toISOString())
    .select('workspace_id');
}

/**
 * Runs the health pass and never throws. A failure (the aggregate, a warmup
 * placement call) is logged, gives back the 15-minute slot, and counts no
 * pauses, so sends go on as when the pass ran after them: cold_send_claim
 * still counts the caps, and each send re-reads its mailbox and domain pause.
 */
export async function healthPass(admin: Any, ws: number, now: Date, pass: () => Promise<number>): Promise<number> {
  try {
    return await pass();
  } catch (err) {
    console.error('cold health', ws, err instanceof Error ? err.message : err);
    await releaseHealthSlot(admin, ws, now);
    return 0;
  }
}

export type HealthCounts = {
  sent7d: number; bounced7d: number; hardInLast50: number; bulk30d: number; unsub30d: number; complaints7d: number; replied7d: number;
};
export type HealthBox = HealthCounts & { id: number; domainId: number | null; email: string | null; paused: boolean };
export type HealthDomain = HealthCounts & { id: number; paused: boolean };
/** What cold_pool_health (migration 333) returns. */
export type Health = { mailboxes: HealthBox[]; domains: HealthDomain[] };

function counts(rows: Any[], since7: string, unsub30d: number): HealthCounts {
  const week = rows.filter((r) => r.sent_at >= since7 && r.status !== 'failed');
  const last50 = [...rows].sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at))).slice(0, 50);
  return {
    sent7d: week.length,
    bounced7d: week.filter((r) => r.status === 'bounced' || r.bounced_at).length,
    hardInLast50: last50.filter((r) => r.status === 'bounced' || r.bounced_at).length,
    bulk30d: rows.filter((r) => r.status !== 'failed').length,
    unsub30d,
    complaints7d: week.filter((r) => r.complained_at).length,
    replied7d: week.filter((r) => r.status === 'replied' || r.replied_at).length,
  };
}

/**
 * The health counts from the raw rows, as pauseUnhealthy counted them before
 * migration 333: 30 days of the workspace's sends, its unsubscribe replies,
 * its mailboxes and its domains. The fallback while 333 is not applied, and
 * the reference the SQL was proved against.
 */
export function healthFromRows(sends: Any[], unsubs: Any[], boxes: Any[], domains: Any[], since7: string): Health {
  const unsubByBox = new Map<number, number>();
  for (const r of unsubs) unsubByBox.set(Number(r.mailbox_id), (unsubByBox.get(Number(r.mailbox_id)) ?? 0) + 1);
  const byBox = new Map<number, Any[]>();
  for (const s of sends) {
    const list = byBox.get(Number(s.mailbox_id)) ?? [];
    list.push(s);
    byBox.set(Number(s.mailbox_id), list);
  }
  return {
    mailboxes: boxes.map((b) => ({
      id: Number(b.id), domainId: b.domain_id == null ? null : Number(b.domain_id), email: b.email ?? null, paused: !!b.paused,
      ...counts(byBox.get(Number(b.id)) ?? [], since7, unsubByBox.get(Number(b.id)) ?? 0),
    })),
    domains: domains.map((d) => {
      const ids = new Set(boxes.filter((b) => Number(b.domain_id) === Number(d.id)).map((b) => Number(b.id)));
      const mine = sends.filter((s) => ids.has(Number(s.mailbox_id)));
      const unsub = [...ids].reduce((n, id) => n + (unsubByBox.get(id) ?? 0), 0);
      return { id: Number(d.id), paused: !!d.paused, ...counts(mine, since7, unsub) };
    }),
  };
}
