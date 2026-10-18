// cold-campaign-tick: the pool a tick reads once and counts its own sends
// into, the due-row claim between two overlapping runs, the claim's gap
// floor, a send whose enrollment write fails (migration 352), the 15-minute
// health slot, and the health counts' JS fallback.
// Run with:  npx tsx tools/cold-campaign-tick.test.ts
import assert from 'node:assert/strict';
import {
  DEFAULT_COLD_DELIVERABILITY, blockedSendingDomains, coldDailyAllowance, coldSendRoom, mailboxGapSeconds, mailboxSkip, planColdSend,
  type ColdDomain, type ColdMailbox, type ColdStep,
} from '../supabase/functions/_shared/cold-campaign';
import { localParts, type MailboxSettings } from '../supabase/functions/_shared/deliverability-rules';
import {
  HEALTH_EVERY_MS, IN_FLIGHT_MS, advancePatch, claimEnrollment, claimGap, countSend, healthFromRows, healthPass, healthSlot, memo, must, priorSend, type Pool,
} from '../supabase/functions/cold-campaign-tick/tick';

const NOW = new Date('2026-10-06T15:00:00.000Z'); // Tuesday 10:00 America/Chicago
const POLICY = { ...DEFAULT_COLD_DELIVERABILITY, physicalAddress: '100 Congress Ave, Austin, TX 78701', restDays: false };

function settings(over: Partial<MailboxSettings> = {}): MailboxSettings {
  return {
    daily_cap: 20, hourly_cap: 6, min_gap_seconds: 240,
    window_start: 0, window_end: 24, window_days: [0, 1, 2, 3, 4, 5, 6], timezone: 'America/Chicago',
    ramp_enabled: false, ramp_start: 5, ramp_increase_pct: 20, ramp_target: 20, ramp_started_on: '2026-09-01',
    paused: false, paused_reason: null,
    ...over,
  };
}
function box(id: number, over: Partial<ColdMailbox> = {}): ColdMailbox {
  return {
    id, domainId: 1, domain: 'outreach.example.com', email: `m${id}@outreach.example.com`,
    paused: false, status: 'active', settings: settings(), sentToday: 0, sentLastHour: 0, lastSentAt: null, sentByProvider: {},
    ...over,
  };
}
function domain(over: Partial<ColdDomain> = {}): ColdDomain {
  return { id: 1, domain: 'outreach.example.com', dailyCap: 500, sentToday: 0, paused: false, blocking: [], checkedAt: '2026-10-06T12:00:00.000Z', ...over };
}
function pool(mailboxes: ColdMailbox[], domains: ColdDomain[] = [domain()]): Pool {
  return { mailboxes, domains, raw: mailboxes.map((m) => ({ id: m.id })) };
}
/** Cold room for the day, as mailboxSkip and the claim compute it. */
function room(m: ColdMailbox): number {
  const ramp = coldDailyAllowance(m.settings, localParts(NOW, m.settings.timezone).date, {
    ceiling: POLICY.dailyCeiling, rampDays: POLICY.rampDays, jitterPct: POLICY.jitterPct, mailboxId: m.id,
  });
  return coldSendRoom(ramp, m.warmupDaily ?? POLICY.warmupDaily, POLICY.combinedDailyCeiling);
}

const step1: ColdStep = { position: 1, delayBusinessDays: 0, subject: 'Hello {{first_name}}', body: '{Hi|Hey} {{first_name}}', variants: [] };
function planFor(p: Pool, enrollmentId: number, email: string, cursor: number) {
  return planColdSend({
    now: NOW,
    enrollment: {
      id: enrollmentId, status: 'active', email, state: 'TX', stepPosition: 1, lastSentAt: null,
      enrolledAt: '2026-10-06T14:00:00.000Z', threadMessageId: null, suppressed: false, safety: 'safe',
    },
    steps: [step1],
    campaign: { status: 'active', window: { start: 9, end: 17, days: [1, 2, 3, 4, 5] }, fallbackTimezone: 'America/Chicago' },
    mailboxes: p.mailboxes, domains: p.domains, blockedDomains: blockedSendingDomains([]), requireVerified: false,
    cursor, fields: { first_name: 'Pat' }, policy: POLICY, recentBodies: [],
  });
}

type Row = Record<string, unknown>;
const time = (v: unknown) => (v === '-infinity' ? -Infinity : Date.parse(String(v)));
/**
 * Just enough supabase-js for a conditional update: from().update().eq() /
 * .lte().select(). One select() call filters and writes with no await in
 * between, so it is atomic the way one UPDATE under its row lock is.
 */
function fakeDb(tables: Record<string, Row[]>, error: { message: string } | null = null) {
  return {
    from(table: string) {
      let patch: Row = {};
      const where: ((r: Row) => boolean)[] = [];
      const q = {
        update(p: Row) { patch = p; return q; },
        eq(col: string, v: unknown) { where.push((r) => r[col] === v); return q; },
        lte(col: string, v: unknown) { where.push((r) => time(r[col]) <= time(v)); return q; },
        async select() {
          if (error) return { data: null, error };
          const hit = (tables[table] ?? []).filter((r) => where.every((w) => w(r)));
          for (const r of hit) Object.assign(r, patch);
          return { data: hit.map((r) => ({ ...r })), error: null };
        },
      };
      return q;
    },
  };
}

const RETRY = '2026-10-06T15:15:00.000000+00:00';
const yieldTurn = () => new Promise<void>((done) => setTimeout(done, 0));

/**
 * One run over its snapshot of due rows, in sendOne's order: claim the row,
 * send (the slow part), then move it to the next step, due now.
 */
async function run(db: ReturnType<typeof fakeDb>, snapshot: Row[], name: string, sent: string[]): Promise<void> {
  for (const row of snapshot) {
    if (!(await claimEnrollment(db, row, RETRY))) continue;
    await yieldTurn();
    sent.push(`${row.id}:${row.step_position}:${name}`);
    await db.from('cold_enrollments').update({ step_position: Number(row.step_position) + 1, next_send_at: '2026-10-06T15:00:00.000000+00:00' })
      .eq('id', row.id).select();
  }
}

function dueRows(): Row[] {
  return [1, 2, 3].map((id) => ({ id, status: 'active', step_position: 1, next_send_at: `2026-10-06T14:5${id}:00.123456+00:00` }));
}

async function main() {
  // ---- memo: one load per key for the tick; a failed load is not kept.
  const cache = new Map<string, Promise<number>>();
  let loads = 0;
  assert.equal(await memo(cache, 'ws13', async () => ++loads), 1);
  assert.equal(await memo(cache, 'ws13', async () => ++loads), 1);
  assert.equal(loads, 1);
  await assert.rejects(memo(cache, 'ws14', async () => { throw new Error('read failed'); }));
  await yieldTurn();
  assert.equal(await memo(cache, 'ws14', async () => 7), 7, 'a failed load is read again by the next row');

  // ---- must: a failed read throws; it never reads as "nothing there".
  assert.deepEqual(must({ data: [1], error: null }, 'x'), [1]);
  assert.equal(must({ data: null, error: null }, 'x'), null);
  assert.throws(() => must({ data: null, error: { message: 'timeout' } }, 'cold suppression'), /cold suppression: timeout/);

  // ---- local accounting: the second plan in a tick sees the first send.
  {
    const p = pool([box(1), box(2)]);
    const first = planFor(p, 11, 'pat@buyer-one.test', 0);
    assert.equal(first.action, 'send');
    if (first.action !== 'send') return;
    countSend(p, first.mailboxId, first.recipientProvider, NOW.toISOString());
    const second = planFor(p, 12, 'sam@buyer-two.test', 1);
    assert.equal(second.action, 'send');
    if (second.action !== 'send') return;
    assert.notEqual(second.mailboxId, first.mailboxId, 'the mailbox that just sent is in its gap; rotation moves on');
    countSend(p, second.mailboxId, second.recipientProvider, NOW.toISOString());
    assert.equal(planFor(p, 13, 'lee@buyer-three.test', 2).action, 'wait', 'both mailboxes sent this tick: nothing left');
    assert.equal(p.domains[0].sentToday, 2);
  }
  {
    // Daily cap: one under the room, then one send counted, then refused (sent long enough ago that the gap is clear).
    const m = box(1);
    m.sentToday = room(m) - 1;
    const p = pool([m]);
    assert.equal(mailboxSkip(m, p.domains[0], [], NOW, POLICY), null);
    countSend(p, 1, 'other', new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    assert.equal(mailboxSkip(m, p.domains[0], [], NOW, POLICY), 'daily_cap');
  }
  {
    // Hourly cap.
    const m = box(1, { sentLastHour: 5 });
    const p = pool([m]);
    assert.equal(mailboxSkip(m, p.domains[0], [], NOW, POLICY), null);
    countSend(p, 1, 'other', new Date(NOW.getTime() - 20 * 60_000).toISOString());
    assert.equal(mailboxSkip(m, p.domains[0], [], NOW, POLICY), 'hourly_cap');
  }
  {
    // Domain cap: a send from one mailbox fills the domain for its sibling.
    const p = pool([box(1), box(2)], [domain({ dailyCap: 1 })]);
    countSend(p, 1, 'other', new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    assert.equal(mailboxSkip(p.mailboxes[1], p.domains[0], [], NOW, POLICY), 'domain_cap');
  }
  {
    // Provider spread: the provider count moves with the send.
    const m = box(1);
    const limit = Math.ceil(room(m) * POLICY.providerShare);
    m.sentByProvider = { gmail: limit - 1 };
    m.sentToday = limit - 1;
    const p = pool([m]);
    assert.equal(mailboxSkip(m, p.domains[0], [], NOW, POLICY, 'gmail'), null);
    countSend(p, 1, 'gmail', new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    assert.equal(mailboxSkip(m, p.domains[0], [], NOW, POLICY, 'gmail'), 'provider_spread');
    assert.equal(mailboxSkip(m, p.domains[0], [], NOW, POLICY, 'outlook'), null);
  }
  {
    // The newest send wins lastSentAt; an older one does not move it back.
    const m = box(1, { lastSentAt: '2026-10-06T14:58:00.000+00:00' });
    countSend(pool([m]), 1, 'other', '2026-10-06T14:00:00.000Z');
    assert.equal(m.lastSentAt, '2026-10-06T14:58:00.000+00:00');
  }

  // ---- claimGap: never 0, so cold_send_claim always checks the gap against the database.
  assert.equal(claimGap(box(1), NOW, POLICY), POLICY.gapMinSeconds);
  assert.equal(claimGap(undefined, NOW, POLICY), POLICY.gapMinSeconds);
  const seen = box(1, { lastSentAt: '2026-10-06T14:50:00.000+00:00' });
  assert.equal(claimGap(seen, NOW, POLICY), mailboxGapSeconds(seen, NOW, POLICY));
  assert.ok(claimGap(seen, NOW, POLICY) >= POLICY.gapMinSeconds && claimGap(seen, NOW, POLICY) <= POLICY.gapMaxSeconds);

  // ---- two overlapping runs: each row is sent once.
  {
    // B read the rows before A ran; A finishes first. B sends nothing.
    const db = fakeDb({ cold_enrollments: dueRows() });
    const snapA = dueRows();
    const snapB = dueRows();
    const sent: string[] = [];
    await run(db, snapA, 'A', sent);
    await run(db, snapB, 'B', sent);
    assert.deepEqual(sent, ['1:1:A', '2:1:A', '3:1:A']);
  }
  {
    // Both runs at once on the same snapshot, interleaving between claim and send.
    const db = fakeDb({ cold_enrollments: dueRows() });
    const sent: string[] = [];
    await Promise.all([run(db, dueRows(), 'A', sent), run(db, dueRows(), 'B', sent)]);
    const ids = sent.map((s) => s.split(':').slice(0, 2).join(':')).sort();
    assert.deepEqual(ids, ['1:1', '2:1', '3:1'], `each row once, got ${sent.join(', ')}`);
  }
  {
    // A claimed and is still sending when B claims: B loses, even with the row not yet moved on.
    const rows = dueRows();
    const db = fakeDb({ cold_enrollments: rows });
    const snap = dueRows()[0];
    assert.equal(await claimEnrollment(db, snap, RETRY), true);
    assert.equal(await claimEnrollment(db, snap, RETRY), false);
    assert.equal(rows[0].next_send_at, RETRY, 'the winner left the row waiting until retryAt');
  }
  {
    // A person stopped the row after it was read: no run sends it.
    const rows = dueRows();
    rows[1].status = 'stopped';
    const db = fakeDb({ cold_enrollments: rows });
    const sent: string[] = [];
    await run(db, dueRows(), 'A', sent);
    assert.deepEqual(sent, ['1:1:A', '3:1:A']);
  }
  {
    // A failed update is a lost claim, never a send.
    const db = fakeDb({ cold_enrollments: dueRows() }, { message: 'connection reset' });
    assert.equal(await claimEnrollment(db, dueRows()[0], RETRY), false);
  }

  // ---- advancePatch: the write after a send, as it was written inline before.
  {
    const steps = [{ position: 1 }, { position: 2 }];
    const row = { mailbox_id: null, thread_message_id: null, provider_thread_id: 'old-thread' };
    const sent = { at: NOW.toISOString(), mailboxId: 7, rfc: '<a@m7>', threadId: null };
    assert.deepEqual(advancePatch(row, steps, 1, sent, NOW), {
      last_sent_at: NOW.toISOString(), mailbox_id: 7, thread_message_id: '<a@m7>', provider_thread_id: 'old-thread',
      step_position: 2, status: 'active', stop_reason: null, stopped_at: null, next_send_at: NOW.toISOString(),
    });
    const pinned = { mailbox_id: 3, thread_message_id: '<first@m3>', provider_thread_id: null };
    assert.deepEqual(advancePatch(pinned, steps, 2, { ...sent, threadId: 'g-thread' }, NOW), {
      last_sent_at: NOW.toISOString(), mailbox_id: 3, thread_message_id: '<first@m3>', provider_thread_id: 'g-thread',
      step_position: 2, status: 'completed', stop_reason: 'Sequence finished.', stopped_at: NOW.toISOString(), next_send_at: NOW.toISOString(),
    });
  }

  // ---- priorSend: only a 'step_sent' refusal moves the row on, and never over a send still in flight.
  {
    const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
    const refusal = (status: string, sentAt: string) => ({ ok: false, reason: 'step_sent', send_id: 9, send_status: status, sent_at: sentAt, rfc_message_id: status === 'queued' ? null : '<s@m7>', mailbox_id: 7 });
    assert.equal(priorSend(null, NOW), null, 'a failed call');
    assert.equal(priorSend({ ok: false, reason: 'pinned_sender' }, NOW), null);
    assert.equal(priorSend({ ok: false, today: 20, last_hour: 1 }, NOW), null, 'a cap refusal');
    for (const status of ['sent', 'bounced', 'replied']) {
      assert.deepEqual(priorSend(refusal(status, at(60_000)), NOW), { at: at(60_000), rfc: '<s@m7>', mailboxId: 7 }, status);
    }
    assert.equal(priorSend(refusal('queued', at(2 * 60_000)), NOW), null, 'queued two minutes ago: may still be sending');
    assert.equal(priorSend(refusal('queued', at(IN_FLIGHT_MS - 1)), NOW), null);
    assert.deepEqual(priorSend(refusal('queued', at(IN_FLIGHT_MS)), NOW), { at: at(IN_FLIGHT_MS), rfc: null, mailboxId: 7 }, 'a run that is gone: taken as sent');
    assert.equal(priorSend(refusal('queued', 'not a time'), NOW), null);
  }

  // ---- a send whose enrollment write fails: the next run must not send that step again (352).
  {
    type Send = { id: number; enrollment_id: number; step_position: number; status: string; variant_key: string; sent_at: string; rfc_message_id: string | null; mailbox_id: number };
    const steps = [{ position: 1 }, { position: 2 }];
    /**
     * Runs of sendOne from the row claim on, against a fake cold_send_claim
     * (the 352 step check as SQL has it, then the insert and the pin) and a
     * send that always works. `lose` says which writes after the send do not
     * land: 'advance' (the enrollment), 'both' (also cold_sends 'sent').
     */
    const world = (stepCheck: boolean, lose: 'advance' | 'both') => {
      const rows: Row[] = [{ id: 1, status: 'active', step_position: 1, next_send_at: '2026-10-06T14:51:00.000Z', mailbox_id: null, thread_message_id: null, provider_thread_id: null }];
      const db = fakeDb({ cold_enrollments: rows });
      const sends: Send[] = [];
      const delivered: string[] = [];
      let losses = 1;
      const sendClaim = (row: Row, step: number, variant: string, now: Date) => {
        const prior = stepCheck && variant !== 'plan'
          ? sends.filter((s) => s.enrollment_id === row.id && s.step_position === step && s.status !== 'failed' && s.variant_key !== 'plan')
            .sort((a, b) => b.sent_at.localeCompare(a.sent_at))[0]
          : undefined;
        if (prior) return { ok: false, reason: 'step_sent', send_id: prior.id, send_status: prior.status, sent_at: prior.sent_at, rfc_message_id: prior.rfc_message_id, mailbox_id: prior.mailbox_id };
        const s: Send = { id: sends.length + 1, enrollment_id: Number(row.id), step_position: step, status: 'queued', variant_key: variant, sent_at: now.toISOString(), rfc_message_id: null, mailbox_id: 7 };
        sends.push(s);
        if (rows[0].mailbox_id == null) rows[0].mailbox_id = 7;
        return { ok: true, id: s.id };
      };
      const tickAt = async (now: Date) => {
        const due = rows.filter((r) => r.status === 'active' && Date.parse(String(r.next_send_at)) <= now.getTime()).map((r) => ({ ...r }));
        for (const row of due) {
          if (!(await claimEnrollment(db, row, new Date(now.getTime() + 15 * 60_000).toISOString()))) continue;
          const step = Number(row.step_position);
          const claim = sendClaim(row, step, 'a', now);
          if (!claim.ok) {
            const prior = priorSend(claim, now);
            if (prior) await db.from('cold_enrollments').update(advancePatch(row, steps, step, { ...prior, threadId: null }, now)).eq('id', row.id).select();
            continue;
          }
          delivered.push(`${row.id}:${step}`);
          const lost = losses-- > 0;
          const s = sends.find((x) => x.id === claim.id)!;
          if (!(lost && lose === 'both')) Object.assign(s, { status: 'sent', rfc_message_id: `<${s.id}@m7>` });
          if (lost) continue;
          await db.from('cold_enrollments').update(advancePatch(row, steps, step, { at: now.toISOString(), mailboxId: 7, rfc: s.rfc_message_id, threadId: 'g1' }, now)).eq('id', row.id).select();
        }
      };
      return { rows, sends, delivered, tickAt };
    };
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    for (const lose of ['advance', 'both'] as const) {
      const w = world(true, lose);
      await w.tickAt(at(0)); // step 1 goes out; the write after it is lost
      await w.tickAt(at(15)); // due again on step 1: refused, moved on, nothing sent
      assert.deepEqual(w.delivered, ['1:1'], `${lose}: step 1 once`);
      assert.equal(w.rows[0].step_position, 2);
      assert.equal(w.rows[0].last_sent_at, at(0).toISOString(), 'the delay to step 2 counts from the real send');
      assert.equal(w.rows[0].thread_message_id, lose === 'both' ? null : '<1@m7>');
      assert.equal(w.rows[0].mailbox_id, 7, 'still pinned to the inbox that sent step 1');
      await w.tickAt(at(16)); // step 2, then the sequence is finished
      await w.tickAt(at(40));
      assert.deepEqual(w.delivered, ['1:1', '1:2'], `${lose}: every step once`);
      assert.equal(w.rows[0].status, 'completed');
    }
    const before = world(false, 'advance');
    await before.tickAt(at(0));
    await before.tickAt(at(15));
    assert.deepEqual(before.delivered, ['1:1', '1:1'], 'without 352 the step went out again 15 minutes later');
  }

  // ---- the 15-minute health slot.
  {
    const rows: Row[] = [{ workspace_id: 13, health_checked_at: '-infinity' }];
    const db = fakeDb({ cold_workspace_settings: rows });
    assert.equal(await healthSlot(db, 13, NOW), true, 'never run: runs');
    assert.equal(await healthSlot(db, 13, NOW), false, 'an overlapping run in the same minute does not run it again');
    assert.equal(await healthSlot(db, 13, new Date(NOW.getTime() + 14 * 60_000)), false);
    assert.equal(await healthSlot(db, 13, new Date(NOW.getTime() + HEALTH_EVERY_MS)), true, 'fifteen minutes later it runs');
    assert.equal(rows[0].health_checked_at, new Date(NOW.getTime() + HEALTH_EVERY_MS).toISOString());
    const [a, b] = await Promise.all([healthSlot(db, 13, new Date(NOW.getTime() + 2 * HEALTH_EVERY_MS)), healthSlot(db, 13, new Date(NOW.getTime() + 2 * HEALTH_EVERY_MS))]);
    assert.equal(Number(a) + Number(b), 1, 'two runs at once: exactly one takes the slot');
    // Migration 334 not applied yet (or any error): the pass runs, as it did every tick before.
    assert.equal(await healthSlot(fakeDb({}, { message: 'column cold_workspace_settings.health_checked_at does not exist' }), 13, NOW), true);
  }

  // ---- a health pass that fails gives the slot back for the next tick and never stops the sends.
  {
    const quiet = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const rows: Row[] = [{ workspace_id: 13, health_checked_at: '-infinity' }];
      const db = fakeDb({ cold_workspace_settings: rows });
      const outage = async (): Promise<number> => { throw new Error('cold health: Instantly placement timed out'); };
      assert.equal(await healthSlot(db, 13, NOW), true);
      assert.equal(await healthPass(db, 13, NOW, outage), 0, 'a failed pass counts no pauses and does not throw');
      assert.equal(rows[0].health_checked_at, '-infinity', 'the slot is given back');
      assert.equal(logged.length, 1, 'the failure is logged');
      const nextTick = new Date(NOW.getTime() + 60_000);
      assert.equal(await healthSlot(db, 13, nextTick), true, 'the very next tick takes the slot and tries again');
      assert.equal(await healthPass(db, 13, nextTick, async () => 2), 2);
      assert.equal(rows[0].health_checked_at, nextTick.toISOString(), 'a pass that works keeps the slot');
      assert.equal(await healthSlot(db, 13, new Date(nextTick.getTime() + 60_000)), false);

      // A run that started earlier and fails late does not give back a slot a later run has taken since.
      const later = new Date(NOW.getTime() + 20 * 60_000);
      assert.equal(await healthSlot(db, 13, later), true);
      await healthPass(db, 13, NOW, outage);
      assert.equal(rows[0].health_checked_at, later.toISOString());

      // The pass before a workspace's first send, as sendOne's pool load runs it: a failure still yields the pool,
      // and the row is planned and sent.
      const pools = new Map<string, Promise<Pool>>();
      let paused = 0;
      const p = await memo(pools, '13', async () => {
        paused += await healthPass(db, 13, NOW, outage);
        return pool([box(1), box(2)]);
      });
      assert.equal(paused, 0);
      assert.equal(planFor(p, 21, 'pat@buyer-one.test', 0).action, 'send', 'sends go on while the health pass is down');
      assert.equal(await memo(pools, '13', async () => pool([])), p, 'the pool stays cached for the rest of the tick');
    } finally {
      console.error = quiet;
    }
  }

  // ---- healthFromRows: the counts the pass reads while 333 is missing (and what 333 was proved against).
  {
    const since7 = '2026-10-10T20:00:00.000Z';
    const sends = [
      { mailbox_id: 1, status: 'sent', sent_at: '2026-10-16T10:00:00+00:00', bounced_at: null, replied_at: null, complained_at: '2026-10-16T12:00:00+00:00' },
      { mailbox_id: 1, status: 'failed', sent_at: '2026-10-16T11:00:00+00:00', bounced_at: null, replied_at: null, complained_at: '2026-10-16T13:00:00+00:00' },
      { mailbox_id: 1, status: null, sent_at: '2026-10-15T10:00:00+00:00', bounced_at: null, replied_at: null, complained_at: '2026-10-15T12:00:00+00:00' },
      { mailbox_id: 1, status: 'sent', sent_at: '2026-10-09T10:00:00+00:00', bounced_at: null, replied_at: null, complained_at: '2026-10-09T12:00:00+00:00' },
      { mailbox_id: 1, status: 'replied', sent_at: '2026-10-14T10:00:00+00:00', bounced_at: null, replied_at: '2026-10-14T11:00:00+00:00', complained_at: '2026-10-14T12:00:00+00:00' },
      { mailbox_id: 2, status: 'sent', sent_at: '2026-10-14T09:00:00+00:00', bounced_at: '2026-10-14T09:05:00+00:00', replied_at: null, complained_at: null },
      { mailbox_id: 9, status: 'bounced', sent_at: '2026-10-14T09:00:00+00:00', bounced_at: null, replied_at: null, complained_at: null },
    ];
    const h = healthFromRows(sends, [{ mailbox_id: 1 }, { mailbox_id: 2 }, { mailbox_id: 9 }],
      [{ id: 1, domain_id: 10, email: 'a@x.test', paused: false }, { id: 2, domain_id: 10, email: 'b@x.test', paused: true }],
      [{ id: 10, paused: false }, { id: 11, paused: true }], since7);
    assert.deepEqual(h.mailboxes[0], { id: 1, domainId: 10, email: 'a@x.test', paused: false, sent7d: 3, bounced7d: 0, hardInLast50: 0, bulk30d: 4, unsub30d: 1, complaints7d: 3, replied7d: 1 });
    assert.deepEqual(h.mailboxes[1], { id: 2, domainId: 10, email: 'b@x.test', paused: true, sent7d: 1, bounced7d: 1, hardInLast50: 1, bulk30d: 1, unsub30d: 1, complaints7d: 0, replied7d: 0 });
    assert.deepEqual(h.domains[0], { id: 10, paused: false, sent7d: 4, bounced7d: 1, hardInLast50: 1, bulk30d: 5, unsub30d: 2, complaints7d: 3, replied7d: 1 }, 'a send on no workspace mailbox counts nowhere');
    assert.deepEqual(h.domains[1], { id: 11, paused: true, sent7d: 0, bounced7d: 0, hardInLast50: 0, bulk30d: 0, unsub30d: 0, complaints7d: 0, replied7d: 0 });

    // Last 50 by time, failed sends included: three old bounces fall out once 50 newer sends exist.
    const many = [
      ...[1, 2, 3].map((d) => ({ mailbox_id: 1, status: 'bounced', sent_at: `2026-09-2${d}T10:00:00+00:00`, bounced_at: null, replied_at: null, complained_at: null })),
      ...Array.from({ length: 50 }, (_, i) => ({ mailbox_id: 1, status: i % 2 ? 'failed' : 'sent', sent_at: `2026-10-0${1 + (i % 9)}T${String(10 + Math.floor(i / 9)).padStart(2, '0')}:00:00+00:00`, bounced_at: null, replied_at: null, complained_at: null })),
    ];
    const cut = healthFromRows(many, [], [{ id: 1, domain_id: 10, email: 'a@x.test', paused: false }], [{ id: 10, paused: false }], since7);
    assert.equal(cut.mailboxes[0].hardInLast50, 0);
    assert.equal(cut.mailboxes[0].bulk30d, 28, 'failed sends are not bulk sends');
    const kept = healthFromRows(many.slice(0, 50), [], [{ id: 1, domain_id: 10, email: 'a@x.test', paused: false }], [{ id: 10, paused: false }], since7);
    assert.equal(kept.mailboxes[0].hardInLast50, 3);
  }

  console.log('cold-campaign-tick tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
