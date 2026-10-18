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
export type ResultsKind = PlanOutcome | 'replies';

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

export type ProgressStep = { id: number; channel: string };

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
  channel: string;
  outcome: PlanOutcome;
  reason: string | null;
  at: string | null;
  title: string;
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
  reached: boolean;
  attempts: PlanAttempt[];
  replies: PlanReply[];
};

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
      : drop.skipReason === 'plan_stopped' ? 'The plan was stopped before this went out'
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
}): PlanProgress[] {
  const steps = new Map(input.steps.map((s) => [s.id, s.channel]));
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
            key: `task:${task.id}`, enrollmentId: e.id, channel, title: task.title || 'Voicemail',
            outcome: task.done ? 'not_sent' : 'waiting',
            reason: task.done ? (tail(task.notes) || 'No voicemail on file') : null,
            at: task.completedAt,
          });
          continue;
        }
        if (channel === 'ai_agent') {
          const missed = (task.notes ?? '').match(/(?:AI agent not started|AI step not run):\s*(.*)/i);
          attempts.push({
            key: `task:${task.id}`, enrollmentId: e.id, channel, title: task.title || 'AI agent',
            outcome: !task.done ? 'waiting' : missed ? 'not_sent' : 'sent',
            reason: missed ? missed[1].trim().slice(0, 180) : null,
            at: task.completedAt,
          });
          continue;
        }
        if (channel === 'email') {
          const comm = planComm.get(`plan:${task.id}`);
          if (comm) {
            const bad = failedStatus(comm.status);
            attempts.push({
              key: `task:${task.id}`, enrollmentId: e.id, channel, title: task.title || 'Email',
              outcome: bad ? 'failed' : 'sent',
              reason: bad ? (comm.status || 'Failed') : null,
              at: comm.occurredAt,
            });
          } else {
            attempts.push({
              key: `task:${task.id}`, enrollmentId: e.id, channel, title: task.title || 'Email',
              outcome: task.done ? 'not_sent' : 'waiting',
              reason: task.done ? (tail(task.notes) || 'No email on file') : null,
              at: task.done ? task.completedAt : task.dueAt,
            });
          }
          continue;
        }
        const comm = key && task.done ? takeSms(key, task.completedAt) : null;
        if (comm) {
          const bad = failedStatus(comm.status);
          attempts.push({
            key: `task:${task.id}`, enrollmentId: e.id, channel: 'sms', title: task.title || 'Text',
            outcome: bad ? 'failed' : 'sent',
            reason: bad ? (comm.status || 'Failed') : null,
            at: comm.occurredAt,
          });
        } else {
          attempts.push({
            key: `task:${task.id}`, enrollmentId: e.id, channel: 'sms', title: task.title || 'Text',
            outcome: task.done ? 'not_sent' : 'waiting',
            reason: task.done ? (tail(task.notes) || 'No text on file') : null,
            at: task.done ? task.completedAt : task.dueAt,
          });
        }
      }

      for (const drop of dropsByEnrollment.get(e.id) ?? []) {
        const mark = drop.planStepId != null ? `${e.id}:${drop.planStepId}` : '';
        if (mark && covered.has(mark)) {
          const got = dropOutcome(drop);
          attempts.push({
            key: `drop:${drop.id}`, enrollmentId: e.id, channel: 'rvm', title: 'Voicemail',
            outcome: got.outcome, reason: got.reason, at: got.at,
          });
          continue;
        }
        if (mark && (tasksByEnrollment.get(e.id) ?? []).some((t) => t.planStepId === drop.planStepId)) continue;
        const got = dropOutcome(drop);
        attempts.push({
          key: `drop:${drop.id}`, enrollmentId: e.id, channel: 'rvm', title: 'Voicemail',
          outcome: got.outcome, reason: got.reason, at: got.at,
        });
      }

      const reached = attempts.some((a) => a.outcome === 'sent');
      return {
        enrollmentId: e.id, buyerId: e.buyerId, sellerId: e.sellerId, name: e.name, status: e.status,
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
    });
  }
  return plans;
}

async function readAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let from = 0; from < 5000; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) return { rows, error: error.message };
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return { rows, error: null };
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function joinPages<T>(pages: { rows: T[]; error: string | null }[]): { rows: T[]; error: string | null } {
  const rows: T[] = [];
  for (const page of pages) {
    if (page.error) return { rows, error: page.error };
    rows.push(...page.rows);
  }
  return { rows, error: null };
}

const COMM_COLS = 'id,buyer_id,seller_id,direction,channel,status,source_id,occurred_at,subject,body,from_email';

export async function fetchPlanProgress(workspaceId: number): Promise<{ ok: true; plans: PlanProgress[] } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sb = supabase;
  const enrolled = await readAll((a, b) => sb.from('enrollments')
    .select('id,plan_id,buyer_id,seller_id,status,enrolled_at,stopped_reason')
    .eq('workspace_id', workspaceId).order('id').range(a, b));
  if (enrolled.error) return { ok: false, message: enrolled.error };

  const buyerIds = [...new Set(enrolled.rows.map((e) => e.buyer_id).filter((id): id is number => id != null))];
  const sellerIds = [...new Set(enrolled.rows.map((e) => e.seller_id).filter((id): id is number => id != null))];
  const buyerName = new Map<number, string>();
  const sellerName = new Map<number, string>();
  for (const part of chunks(buyerIds, 80)) {
    const { data, error } = await sb.from('buyers').select('id,name,email').in('id', part);
    if (error) return { ok: false, message: error.message };
    for (const b of data ?? []) buyerName.set(b.id, b.name?.trim() || b.email || 'Buyer');
  }
  for (const part of chunks(sellerIds, 80)) {
    const { data, error } = await sb.from('sellers').select('id,name').in('id', part);
    if (error) return { ok: false, message: error.message };
    for (const s of data ?? []) sellerName.set(s.id, s.name || 'Seller');
  }

  const enrollments: ProgressEnrollment[] = enrolled.rows.filter((e) => e.seller_id != null || e.buyer_id != null).map((e) => ({
    id: e.id,
    planId: e.plan_id,
    buyerId: e.buyer_id ?? null,
    sellerId: e.seller_id,
    name: e.seller_id != null ? (sellerName.get(e.seller_id) || 'Seller') : (e.buyer_id != null ? (buyerName.get(e.buyer_id) || 'Buyer') : 'Buyer'),
    status: e.status,
    enrolledAt: e.enrolled_at,
    stoppedReason: e.stopped_reason,
  }));
  if (!enrollments.length) return { ok: true, plans: [] };

  const ids = enrollments.map((e) => e.id);
  const since = enrollments.reduce((min, e) => (e.enrolledAt < min ? e.enrolledAt : min), enrollments[0].enrolledAt);
  const inboundSince = new Date(new Date(since).getTime() - 2 * 60_000).toISOString();
  const commsFor = (part: number[], who: 'buyer_id' | 'seller_id') =>
    readAll((a, b) => sb.from('communications').select(COMM_COLS)
      .eq('workspace_id', workspaceId).eq('direction', 'inbound').in(who, part).gte('occurred_at', inboundSince).order('id').range(a, b));

  const [stepRes, taskRes, mailRes, dropRes, coldRes, buyerIn, sellerIn] = await Promise.all([
    readAll((a, b) => sb.from('action_plan_steps').select('id,channel').eq('workspace_id', workspaceId).order('id').range(a, b)),
    Promise.all(chunks(ids, 80).map((part) => readAll((a, b) => sb.from('tasks')
      .select('id,enrollment_id,plan_step_id,done,task_type,completed_at,due_at,title,notes')
      .in('enrollment_id', part).order('id').range(a, b)))).then(joinPages),
    readAll((a, b) => sb.from('communications').select(COMM_COLS).eq('workspace_id', workspaceId).like('source_id', 'plan:%').order('id').range(a, b)),
    readAll((a, b) => sb.from('rvm_drops')
      .select('id,enrollment_id,plan_step_id,status,skip_reason,last_error,sent_at,buyer_id,seller_id')
      .eq('workspace_id', workspaceId).not('enrollment_id', 'is', null).order('id').range(a, b)),
    buyerIds.length
      ? readAll((a, b) => sb.from('cold_replies')
        .select('buyer_id,communication_id,classification,received_at,subject,snippet,from_email')
        .eq('workspace_id', workspaceId).order('id').range(a, b))
      : Promise.resolve({ rows: [], error: null as string | null }),
    buyerIds.length ? Promise.all(chunks(buyerIds, 80).map((part) => commsFor(part, 'buyer_id'))).then(joinPages) : Promise.resolve({ rows: [], error: null as string | null }),
    sellerIds.length ? Promise.all(chunks(sellerIds, 80).map((part) => commsFor(part, 'seller_id'))).then(joinPages) : Promise.resolve({ rows: [], error: null as string | null }),
  ]);

  const failed = [stepRes.error, taskRes.error, mailRes.error, dropRes.error, coldRes.error, buyerIn.error, sellerIn.error].find((e): e is string => !!e);
  if (failed) return { ok: false, message: failed };

  const smsSince = new Date(new Date(since).getTime() - 30 * 60_000).toISOString();
  const smsRows: ProgressComm[] = [];
  const pullSms = async (part: number[], who: 'buyer_id' | 'seller_id') => {
    const page = await readAll((a, b) => sb.from('communications').select(COMM_COLS)
      .eq('workspace_id', workspaceId).eq('direction', 'outbound').in('channel', ['sms', 'text']).in(who, part).gte('occurred_at', smsSince).order('id').range(a, b));
    if (page.error) return page.error;
    smsRows.push(...page.rows.map(mapComm));
    return null;
  };
  for (const part of chunks(buyerIds, 80)) {
    const err = await pullSms(part, 'buyer_id');
    if (err) return { ok: false, message: err };
  }
  for (const part of chunks(sellerIds, 80)) {
    const err = await pullSms(part, 'seller_id');
    if (err) return { ok: false, message: err };
  }

  return {
    ok: true,
    plans: buildPlanProgress({
      enrollments,
      steps: stepRes.rows.map((s) => ({ id: s.id, channel: s.channel })),
      tasks: taskRes.rows.flatMap((r) => (r.enrollment_id == null ? [] : [{
        id: r.id, enrollmentId: r.enrollment_id, planStepId: r.plan_step_id, done: r.done, taskType: r.task_type,
        completedAt: r.completed_at, dueAt: r.due_at, title: r.title, notes: r.notes,
      }])),
      comms: dedupeComms([...mailRes.rows, ...buyerIn.rows, ...sellerIn.rows].map(mapComm).concat(smsRows)),
      drops: dropRes.rows.map((r) => ({
        id: r.id, enrollmentId: r.enrollment_id, planStepId: r.plan_step_id, status: r.status,
        skipReason: r.skip_reason, lastError: r.last_error, sentAt: r.sent_at, buyerId: r.buyer_id, sellerId: r.seller_id,
      })),
      coldReplies: coldRes.rows.map((r) => ({
        buyerId: r.buyer_id, communicationId: r.communication_id, classification: r.classification,
        receivedAt: r.received_at, subject: r.subject, snippet: r.snippet, fromEmail: r.from_email,
      })),
    }),
  };
}

function dedupeComms(rows: ProgressComm[]): ProgressComm[] {
  const seen = new Set<number>();
  return rows.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

function mapComm(row: { id: number; buyer_id: number | null; seller_id: number | null; direction: string | null; channel: string; status: string | null; source_id: string; occurred_at: string; subject: string | null; body: string | null; from_email: string | null }): ProgressComm {
  return {
    id: row.id, buyerId: row.buyer_id, sellerId: row.seller_id, direction: row.direction, channel: row.channel,
    status: row.status, sourceId: row.source_id, occurredAt: row.occurred_at, subject: row.subject, body: row.body, fromEmail: row.from_email,
  };
}
