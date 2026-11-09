// What an action plan actually did: who was reached, which sends failed or
// never went out, and the replies a person can open.
//
// Email sends are the communications filed as source_id `plan:{taskId}`.
// Texts are Talkr rows (`msg:…`) matched to the finished text task. Ringless
// drops carry their own status. A done send step with neither a message nor a
// drop is a no-send. An open send step is still waiting.
//
// A reply is an inbound text, email, or call after the person was enrolled.
// Bounces, unsubscribes, and out-of-office notes are not replies.

import { supabase } from './supabase';

export type PlanOutcome = 'sent' | 'failed' | 'not_sent' | 'waiting';
export type ResultsKind = PlanOutcome | 'replies' | 'report';

export type ProgressEnrollment = {
  id: number;
  planId: number;
  buyerId: number | null;
  sellerId: number | null;
  name: string;
  status: string;
  enrolledAt: string;
  stoppedReason: string | null;
};

export type ProgressStep = { id: number; channel: string; position?: number; title?: string | null };

export type ProgressTask = {
  id: number;
  enrollmentId: number;
  planStepId: number | null;
  done: boolean;
  taskType: string;
  completedAt: string | null;
  dueAt: string | null;
  title: string;
  notes: string | null;
};

export type ProgressComm = {
  id: number;
  buyerId: number | null;
  sellerId: number | null;
  direction: string | null;
  channel: string;
  status: string | null;
  sourceId: string;
  occurredAt: string;
  subject: string | null;
  body: string | null;
  fromEmail?: string | null;
};

export type ProgressDrop = {
  id: number;
  enrollmentId: number | null;
  planStepId: number | null;
  status: string;
  skipReason: string | null;
  lastError: string | null;
  sentAt: string | null;
  buyerId: number | null;
  sellerId: number | null;
};

export type ProgressColdReply = {
  buyerId: number | null;
  communicationId: number | null;
  classification: string;
  receivedAt: string;
  subject: string | null;
  snippet: string | null;
  fromEmail: string | null;
};

export type PlanAttempt = {
  key: string;
  enrollmentId: number;
  stepId: number | null;
  channel: string;
  outcome: PlanOutcome;
  reason: string | null;
  at: string | null;
  title: string;
  /** The carrier's or mail provider's word: delivered, sent, failed, bounced. */
  status: string | null;
  opened: boolean;
  bounced: boolean;
};

export type PlanReply = {
  key: string;
  enrollmentId: number;
  buyerId: number | null;
  sellerId: number | null;
  name: string;
  channel: string;
  at: string;
  snippet: string;
};

export type PersonProgress = {
  enrollmentId: number;
  buyerId: number | null;
  sellerId: number | null;
  name: string;
  status: string;
  stoppedReason: string | null;
  reached: boolean;
  attempts: PlanAttempt[];
  replies: PlanReply[];
};

/** One line of the report: a step, a week, or the whole plan. */
export type ReportRow = {
  key: string;
  label: string;
  channel: string | null;
  sent: number;
  delivered: number;
  failed: number;
  bounced: number;
  opened: number;
  replies: number;
  optOuts: number;
};

export type PlanReport = { total: ReportRow; steps: ReportRow[]; weeks: ReportRow[] };

export type PlanProgress = {
  planId: number;
  enrolled: number;
  reached: number;
  sent: number;
  failed: number;
  notSent: number;
  waiting: number;
  replies: number;
  people: PersonProgress[];
  report: PlanReport;
};

const SEND = new Set(['email', 'sms', 'rvm', 'ai_agent']);
const NOT_A_REPLY = new Set(['bounce', 'unsubscribe', 'out_of_office']);
const SMS_WINDOW_MS = 20 * 60_000;
const REPLY_SKEW_MS = 2 * 60_000;

export function channelWord(channel: string): string {
  if (channel === 'sms' || channel === 'text') return 'Text';
  if (channel === 'email') return 'Email';
  if (channel === 'rvm') return 'Voicemail';
  if (channel === 'ai_agent') return 'AI agent';
  if (channel === 'call') return 'Call';
  return 'Message';
}

export function replySnippet(subject: string | null, body: string | null): string {
  const sub = (subject ?? '').replace(/\s+/g, ' ').trim();
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  const line = sub && text ? `${sub}. ${text}` : sub || text;
  return (line || 'No message text').slice(0, 180);
}

function personKey(buyerId: number | null, sellerId: number | null): string | null {
  if (buyerId != null) return `b:${buyerId}`;
  if (sellerId != null) return `s:${sellerId}`;
  return null;
}

function channelOf(task: ProgressTask, steps: Map<number, string>): string | null {
  const fromStep = task.planStepId != null ? steps.get(task.planStepId) : null;
  const raw = fromStep || (task.taskType === 'text' ? 'sms' : task.taskType);
  return SEND.has(raw) ? raw : null;
}

/** The tick's "Waiting: …" line on an open step, or null when it is only not due yet. */
function waitingOf(notes: string | null): string | null {
  const m = /(?:^|\n)Waiting:\s*([^\n]+)\s*$/.exec(notes ?? '');
  return m ? m[1].trim().slice(0, 180) : null;
}

function tail(notes: string | null): string | null {
  const line = (notes ?? '').split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  return line ? line.slice(0, 180) : null;
}

function failedStatus(status: string | null): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'failed' || s === 'bounced' || s === 'undelivered';
}

function machineMail(from: string | null | undefined): boolean {
  const f = (from ?? '').trim().toLowerCase();
  return f.startsWith('mailer-daemon@') || f.startsWith('postmaster@');
}

function dropOutcome(drop: ProgressDrop): { outcome: PlanOutcome; reason: string | null; at: string | null } {
  if (drop.status === 'dropped' || drop.status === 'answered') return { outcome: 'sent', reason: null, at: drop.sentAt };
  if (drop.status === 'failed') return { outcome: 'failed', reason: drop.lastError?.trim().slice(0, 180) || 'The drop failed', at: drop.sentAt };
  if (drop.status === 'skipped') {
    const why = drop.skipReason === 'no_phone' ? 'No phone number'
      : drop.skipReason ? drop.skipReason.replace(/_/g, ' ')
      : 'Did not send';
    return { outcome: 'not_sent', reason: why, at: null };
  }
  return { outcome: 'waiting', reason: null, at: null };
}

function count(people: PersonProgress[], outcome: PlanOutcome): number {
  return people.reduce((n, p) => n + p.attempts.filter((a) => a.outcome === outcome).length, 0);
}

export function buildPlanProgress(input: {
  enrollments: ProgressEnrollment[];
  steps: ProgressStep[];
  tasks: ProgressTask[];
  comms: ProgressComm[];
  drops: ProgressDrop[];
  coldReplies: ProgressColdReply[];
  /** communications ids of plan mail that was opened (email_tracking). */
  opens?: number[];
  /** Cold plan emails that bounced after the send, by buyer and time (cold_sends). */
  coldBounces?: { buyerId: number | null; at: string }[];
}): PlanProgress[] {
  const steps = new Map(input.steps.map((s) => [s.id, s.channel]));
  const opened = new Set(input.opens ?? []);
  const coldBounce = new Map<number, number[]>();
  for (const b of input.coldBounces ?? []) {
    if (b.buyerId == null) continue;
    const list = coldBounce.get(b.buyerId) ?? [];
    list.push(new Date(b.at).getTime());
    coldBounce.set(b.buyerId, list);
  }
  // A cold bounce lands within a day of the send; the communications row still says sent.
  const bouncedCold = (buyerId: number | null, at: string) => {
    if (buyerId == null) return false;
    const t = new Date(at).getTime();
    return (coldBounce.get(buyerId) ?? []).some((b) => Math.abs(b - t) < 36 * 3600_000);
  };
  const byPlan = new Map<number, ProgressEnrollment[]>();
  for (const e of input.enrollments) {
    const list = byPlan.get(e.planId) ?? [];
    list.push(e);
    byPlan.set(e.planId, list);
  }

  const skipComm = new Set<number>();
  const coldByBuyer = new Map<number, ProgressColdReply[]>();
  for (const r of input.coldReplies) {
    if (NOT_A_REPLY.has(r.classification)) {
      if (r.communicationId != null) skipComm.add(r.communicationId);
      continue;
    }
    if (r.buyerId == null) continue;
    const list = coldByBuyer.get(r.buyerId) ?? [];
    list.push(r);
    coldByBuyer.set(r.buyerId, list);
  }

  const planComm = new Map<string, ProgressComm>();
  const smsPool = new Map<string, ProgressComm[]>();
  const inbound = new Map<string, ProgressComm[]>();
  for (const c of input.comms) {
    if (c.sourceId.startsWith('plan:')) planComm.set(c.sourceId, c);
    const key = personKey(c.buyerId, c.sellerId);
    if (!key) continue;
    if (c.direction === 'outbound' && (c.channel === 'sms' || c.channel === 'text')) {
      const list = smsPool.get(key) ?? [];
      list.push(c);
      smsPool.set(key, list);
    }
    if (c.direction === 'inbound' && (c.channel === 'sms' || c.channel === 'text' || c.channel === 'email' || c.channel === 'call')) {
      if (skipComm.has(c.id) || machineMail(c.fromEmail)) continue;
      const list = inbound.get(key) ?? [];
      list.push(c);
      inbound.set(key, list);
    }
  }
  for (const list of smsPool.values()) list.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const dropByStep = new Map<string, ProgressDrop>();
  const dropsByEnrollment = new Map<number, ProgressDrop[]>();
  for (const d of input.drops) {
    if (d.enrollmentId == null) continue;
    if (d.planStepId != null) dropByStep.set(`${d.enrollmentId}:${d.planStepId}`, d);
    const list = dropsByEnrollment.get(d.enrollmentId) ?? [];
    list.push(d);
    dropsByEnrollment.set(d.enrollmentId, list);
  }

  const tasksByEnrollment = new Map<number, ProgressTask[]>();
  for (const t of input.tasks) {
    const list = tasksByEnrollment.get(t.enrollmentId) ?? [];
    list.push(t);
    tasksByEnrollment.set(t.enrollmentId, list);
  }

  const takeSms = (key: string, at: string | null): ProgressComm | null => {
    const list = smsPool.get(key);
    if (!list?.length) return null;
    if (!at) return list.shift() ?? null;
    const t = new Date(at).getTime();
    let best = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < list.length; i++) {
      const d = Math.abs(new Date(list[i].occurredAt).getTime() - t);
      if (d < bestDelta) { bestDelta = d; best = i; }
    }
    if (best < 0 || bestDelta > SMS_WINDOW_MS) return null;
    return list.splice(best, 1)[0];
  };

  const plans: PlanProgress[] = [];
  for (const [planId, enrolled] of byPlan) {
    const people: PersonProgress[] = enrolled.map((e) => {
      const key = personKey(e.buyerId, e.sellerId);
      const attempts: PlanAttempt[] = [];
      const covered = new Set<string>();

      for (const task of tasksByEnrollment.get(e.id) ?? []) {
        const channel = channelOf(task, steps);
        if (!channel) continue;
        if (channel === 'rvm' && task.planStepId != null && dropByStep.has(`${e.id}:${task.planStepId}`)) {
          covered.add(`${e.id}:${task.planStepId}`);
          continue;
        }
        if (channel === 'rvm') {
          attempts.push({
            key: `task:${task.id}`, enrollmentId: e.id, stepId: task.planStepId, channel, title: task.title || 'Voicemail',
            outcome: task.done ? 'not_sent' : 'waiting',
            reason: task.done ? (tail(task.notes) || 'No voicemail on file') : waitingOf(task.notes),
            at: task.completedAt, status: null, opened: false, bounced: false,
          });
          continue;
        }
        if (channel === 'ai_agent') {
          const missed = (task.notes ?? '').match(/(?:AI agent not started|AI step not run):\s*(.*)/i);
          attempts.push({
            key: `task:${task.id}`, enrollmentId: e.id, stepId: task.planStepId, channel, title: task.title || 'AI agent',
            outcome: !task.done ? 'waiting' : missed ? 'not_sent' : 'sent',
            reason: missed ? missed[1].trim().slice(0, 180) : null,
            at: task.completedAt, status: null, opened: false, bounced: false,
          });
          continue;
        }
        if (channel === 'email') {
          const comm = planComm.get(`plan:${task.id}`);
          if (comm) {
            const bounced = (comm.status ?? '').toLowerCase() === 'bounced' || bouncedCold(e.buyerId, comm.occurredAt);
            const bad = bounced || failedStatus(comm.status);
            attempts.push({
              key: `task:${task.id}`, enrollmentId: e.id, stepId: task.planStepId, channel, title: task.title || 'Email',
              outcome: bad ? 'failed' : 'sent',
              reason: bad ? (bounced ? 'Bounced' : comm.status || 'Failed') : null,
              at: comm.occurredAt, status: bounced ? 'bounced' : comm.status, opened: opened.has(comm.id), bounced,
            });
          } else {
            attempts.push({
              key: `task:${task.id}`, enrollmentId: e.id, stepId: task.planStepId, channel, title: task.title || 'Email',
              outcome: task.done ? 'not_sent' : 'waiting',
              reason: task.done ? (tail(task.notes) || 'No email on file') : waitingOf(task.notes),
              at: task.done ? task.completedAt : task.dueAt, status: null, opened: false, bounced: false,
            });
          }
          continue;
        }
        const comm = key && task.done ? takeSms(key, task.completedAt) : null;
        if (comm) {
          const bad = failedStatus(comm.status);
          attempts.push({
            key: `task:${task.id}`, enrollmentId: e.id, stepId: task.planStepId, channel: 'sms', title: task.title || 'Text',
            outcome: bad ? 'failed' : 'sent',
            reason: bad ? (comm.status || 'Failed') : null,
            at: comm.occurredAt, status: comm.status, opened: false, bounced: false,
          });
        } else {
          attempts.push({
            key: `task:${task.id}`, enrollmentId: e.id, stepId: task.planStepId, channel: 'sms', title: task.title || 'Text',
            outcome: task.done ? 'not_sent' : 'waiting',
            reason: task.done ? (tail(task.notes) || 'No text on file') : waitingOf(task.notes),
            at: task.done ? task.completedAt : task.dueAt, status: null, opened: false, bounced: false,
          });
        }
      }

      for (const drop of dropsByEnrollment.get(e.id) ?? []) {
        const mark = drop.planStepId != null ? `${e.id}:${drop.planStepId}` : '';
        // The plan stopped (a reply, a call, a stage change) before the drop's turn: not a send that failed to go out.
        if (drop.status === 'skipped' && drop.skipReason === 'plan_stopped') continue;
        if (mark && covered.has(mark)) {
          const got = dropOutcome(drop);
          attempts.push({
            key: `drop:${drop.id}`, enrollmentId: e.id, stepId: drop.planStepId, channel: 'rvm', title: 'Voicemail',
            outcome: got.outcome, reason: got.reason, at: got.at, status: drop.status, opened: false, bounced: false,
          });
          continue;
        }
        if (mark && (tasksByEnrollment.get(e.id) ?? []).some((t) => t.planStepId === drop.planStepId)) continue;
        const got = dropOutcome(drop);
        attempts.push({
          key: `drop:${drop.id}`, enrollmentId: e.id, stepId: drop.planStepId, channel: 'rvm', title: 'Voicemail',
          outcome: got.outcome, reason: got.reason, at: got.at, status: drop.status, opened: false, bounced: false,
        });
      }

      const reached = attempts.some((a) => a.outcome === 'sent');
      return {
        enrollmentId: e.id, buyerId: e.buyerId, sellerId: e.sellerId, name: e.name, status: e.status, stoppedReason: e.stoppedReason,
        reached, attempts, replies: [] as PlanReply[],
      };
    });

    const latest = (key: string, at: number): PersonProgress | null => {
      let best: PersonProgress | null = null;
      let bestStart = -Infinity;
      for (let i = 0; i < enrolled.length; i++) {
        const e = enrolled[i];
        if (personKey(e.buyerId, e.sellerId) !== key) continue;
        const start = new Date(e.enrolledAt).getTime();
        if (at + REPLY_SKEW_MS < start || start < bestStart) continue;
        bestStart = start;
        best = people[i];
      }
      return best;
    };
    const seenComm = new Set<number>();
    for (const [key, comms] of inbound) {
      for (const c of comms) {
        const at = new Date(c.occurredAt).getTime();
        const who = Number.isFinite(at) ? latest(key, at) : null;
        if (!who) continue;
        seenComm.add(c.id);
        who.replies.push({
          key: `comm:${c.id}:${who.enrollmentId}`, enrollmentId: who.enrollmentId, buyerId: who.buyerId, sellerId: who.sellerId, name: who.name,
          channel: c.channel, at: c.occurredAt, snippet: replySnippet(c.subject, c.body),
        });
      }
    }
    for (const [buyerId, rows] of coldByBuyer) {
      for (const r of rows) {
        if (r.communicationId != null && seenComm.has(r.communicationId)) continue;
        if (machineMail(r.fromEmail)) continue;
        const at = new Date(r.receivedAt).getTime();
        const who = Number.isFinite(at) ? latest(`b:${buyerId}`, at) : null;
        if (!who) continue;
        who.replies.push({
          key: `cold:${r.receivedAt}:${who.enrollmentId}:${r.subject ?? ''}`, enrollmentId: who.enrollmentId,
          buyerId: who.buyerId, sellerId: who.sellerId, name: who.name,
          channel: 'email', at: r.receivedAt, snippet: replySnippet(r.subject, r.snippet),
        });
      }
    }
    for (let i = 0; i < enrolled.length; i++) {
      const e = enrolled[i];
      const who = people[i];
      if (e.stoppedReason === 'reply' && who.replies.length === 0) {
        who.replies.push({
          key: `stop:${e.id}`, enrollmentId: e.id, buyerId: e.buyerId, sellerId: e.sellerId, name: e.name,
          channel: 'email', at: e.enrolledAt, snippet: 'They replied, and the plan stopped.',
        });
      }
      who.replies.sort((a, b) => b.at.localeCompare(a.at));
    }

    plans.push({
      planId,
      enrolled: people.length,
      reached: people.filter((p) => p.reached).length,
      sent: count(people, 'sent'),
      failed: count(people, 'failed'),
      notSent: count(people, 'not_sent'),
      waiting: count(people, 'waiting'),
      replies: people.reduce((n, p) => n + p.replies.length, 0),
      people,
      report: buildPlanReport(people, input.steps),
    });
  }
  return plans;
}

const OPT_OUT = /^\s*(stop|unsubscribe|remove me|opt out|quit|cancel|end)\b/i;

/** The Monday (UTC) of the week an ISO time falls in, as YYYY-MM-DD. */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

const emptyRow = (key: string, label: string, channel: string | null): ReportRow => ({ key, label, channel, sent: 0, delivered: 0, failed: 0, bounced: 0, opened: 0, replies: 0, optOuts: 0 });

function addAttempt(row: ReportRow, a: PlanAttempt): void {
  if (a.outcome === 'sent' || a.outcome === 'failed') row.sent++;
  if (a.outcome === 'failed') row.failed++;
  if (a.bounced) row.bounced++;
  if (a.opened) row.opened++;
  // A text is delivered when the carrier said so; an email counts as delivered when it did not bounce or fail.
  if (a.outcome === 'sent' && (a.channel !== 'sms' || (a.status ?? '').toLowerCase() === 'delivered')) row.delivered++;
}

/**
 * The plan's numbers by step and by week (Monday, UTC): sends, delivered,
 * failed, bounced, opened, replies, opt-outs. A reply or an opt-out is
 * counted in the week it arrived and in the plan total, not against a step
 * (a reply answers the plan, not one step). An opt-out is a STOP-style first
 * word in a reply, or the plan stopped as not interested.
 */
export function buildPlanReport(people: PersonProgress[], steps: ProgressStep[]): PlanReport {
  const total = emptyRow('total', 'Whole plan', null);
  const byStep = new Map<string, ReportRow>();
  const byWeek = new Map<string, ReportRow>();
  const meta = new Map(steps.map((s) => [s.id, s]));
  const stepRow = (a: PlanAttempt): ReportRow => {
    const key = a.stepId != null ? `step:${a.stepId}` : `channel:${a.channel}`;
    let row = byStep.get(key);
    if (!row) {
      const s = a.stepId != null ? meta.get(a.stepId) : undefined;
      const word = channelWord(a.channel);
      const title = (s?.title ?? '').trim();
      const label = s?.position != null ? `${s.position + 1}. ${title && title !== word ? title : word}` : word;
      row = emptyRow(key, label, a.channel);
      byStep.set(key, row);
    }
    return row;
  };
  const weekRow = (iso: string): ReportRow => {
    const wk = weekOf(iso);
    let row = byWeek.get(wk);
    if (!row) { row = emptyRow(`week:${wk}`, wk, null); byWeek.set(wk, row); }
    return row;
  };
  for (const p of people) {
    let lastAt: string | null = null;
    for (const a of p.attempts) {
      if (a.outcome !== 'sent' && a.outcome !== 'failed') continue;
      addAttempt(total, a);
      addAttempt(stepRow(a), a);
      if (a.at) { addAttempt(weekRow(a.at), a); if (!lastAt || a.at > lastAt) lastAt = a.at; }
    }
    let optedOut = false;
    for (const r of p.replies) {
      total.replies++;
      weekRow(r.at).replies++;
      if (!optedOut && OPT_OUT.test(r.snippet)) { optedOut = true; total.optOuts++; weekRow(r.at).optOuts++; }
    }
    if (!optedOut && p.stoppedReason === 'not_interested') {
      total.optOuts++;
      if (lastAt) weekRow(lastAt).optOuts++;
    }
  }
  const order = [...steps].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((s) => `step:${s.id}`);
  const stepsOut = [...byStep.values()].sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.label.localeCompare(b.label);
  });
  const weeks = [...byWeek.values()].sort((a, b) => b.label.localeCompare(a.label));
  return { total, steps: stepsOut, weeks };
}

/** What plan_progress_inputs (migration 428, 459) returns. Enrollments and tasks are positional arrays. */
export type ProgressInputs = {
  enrollments: [number, number, number | null, number | null, string, string, string, string | null][];
  steps: ProgressStep[];
  tasks: [number, number, number | null, boolean, string, string | null, string | null, string, string | null][];
  mail: ProgressComm[];
  inbound: ProgressComm[];
  sms: ProgressComm[];
  drops: ProgressDrop[];
  coldReplies: ProgressColdReply[];
  opens?: number[];
  coldBounces?: { buyerId: number | null; at: string }[];
};

/** The RPC's rows as buildPlanProgress takes them. Same order and the same de-duplication as the old per-table reads. */
export function progressFromInputs(raw: ProgressInputs): Parameters<typeof buildPlanProgress>[0] {
  const enrollments: ProgressEnrollment[] = raw.enrollments.map(([id, planId, buyerId, sellerId, name, status, enrolledAt, stoppedReason]) => ({
    id, planId, buyerId, sellerId, name, status, enrolledAt, stoppedReason,
  }));
  const tasks: ProgressTask[] = raw.tasks.map(([id, enrollmentId, planStepId, done, taskType, completedAt, dueAt, title, notes]) => ({
    id, enrollmentId, planStepId, done, taskType, completedAt, dueAt, title, notes,
  }));
  const seen = new Set<number>();
  const comms = [...raw.mail, ...raw.inbound].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).concat(raw.sms);
  return { enrollments, steps: raw.steps, tasks, comms, drops: raw.drops, coldReplies: raw.coldReplies, opens: raw.opens ?? [], coldBounces: raw.coldBounces ?? [] };
}

/**
 * Every plan's results in one call (plan_progress_inputs, migration 428). It
 * replaced reading enrollments, people, tasks and messages in chunks of 80
 * ids, which was about 200 requests and every task's full notes on Compr.
 */
export async function fetchPlanProgress(workspaceId: number): Promise<{ ok: true; plans: PlanProgress[] } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.rpc('plan_progress_inputs' as never, { p_workspace_id: workspaceId } as never);
  if (error) return { ok: false, message: error.message };
  const input = progressFromInputs(data as ProgressInputs);
  return { ok: true, plans: input.enrollments.length ? buildPlanProgress(input) : [] };
}
