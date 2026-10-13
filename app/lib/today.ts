// Today: the one ordered list an acquisitions rep works, and the list the
// call session dials.
//
// Three groups, each seller once, in the first group that takes them:
//   Call now   — new leads nobody has called: mine, plus the unassigned pool
//                from the last 72 hours (the first rep to dial claims one).
//   Due today  — my overdue and today tasks.
//   Offers out — my offers with no next step scheduled.
//
// Pure, so it can be tested against the demo graph (tools/today.test.ts). The
// view-model hands in the merged people and tasks (session edits applied),
// `me`, `now`, the stage vocabulary and the session's done ledger.
//
// Only the rep's own work: sellers assigned to them and tasks assigned to them
// (an unassigned task counts on their own seller). The unassigned new-lead
// pool is acquisitions' (`workPool`); a dispo rep or TC never sees it. Task
// types that belong to another seat (`notMine`) are left out unless they are
// that seat's: a dispo rep's dispo tasks are theirs, a TC's checklist is theirs.

import { isDoNotEngage } from './blacklist';
import { isNewStage, stageGroup, type Vocab } from './call-outcomes';
import { notMine, workPool } from './seat';

export type TodayGroup = 'now' | 'due' | 'offers';
export const TODAY_GROUPS: { id: TodayGroup; label: string }[] = [
  { id: 'now', label: 'Call now' },
  { id: 'due', label: 'Due today' },
  { id: 'offers', label: 'Offers out' },
];

/** The fields Today reads off a seller (lib/clozr-types Person). */
export type TodayPerson = {
  id: string; name: string; stage: string; assigned: string | null; source: string;
  phone: string; lastComm: string; lastCommTs: number | null; created: string;
  /** Live rows: when the seller was created, ISO. The demo has only its `created` label. */
  createdAt?: string | null;
  tags: string[]; asking: string; offer: string | null;
  property: { addr: string; city: string; st: string; zip: string };
};
/** The fields Today reads off a task (lib/clozr-types Task), with `done` already merged. */
export type TodayTask = {
  id: string; title: string; personId: string; type: string; due: string;
  /** Live rows: the due time, ISO. The demo has only its `due` label. */
  dueAt?: string | null;
  assigned: string | null; done: boolean; bucket: string;
};
export type TodayDeal = { contract: number | null; mao?: number | null };

export type TodayRow = {
  pid: string;
  group: TodayGroup;
  name: string;
  stage: string;
  /** The right-hand tag: a time, "Overdue", or the offer. */
  tag: string;
  tagTone: 'muted' | 'due' | 'overdue' | 'money';
  /** One line under the name. */
  reason: string;
  /** The "Why now" sentence: only facts CLOZR has. */
  why: string;
  /** The open task that put them here (mine or unassigned), earliest first: the outcome completes or moves it. */
  task: { id: string; title: string; type: string } | null;
  /** Unassigned: calling claims the lead. */
  claim: boolean;
  target: { name: string; phone: string; personId: string };
  /** "4410 Bluebonnet Trail, Fort Worth" */
  address: string;
  /** Set once the rep has logged an outcome this session. */
  done?: { label: string; failed?: string[] };
  /** Clozr AI's one line on why this row sits where it does (lib/today-ai.ts). */
  aiWhy?: string;
};

/**
 * What the session ledger keeps about a saved row, so it stays where it was
 * once its data has moved on: `at` is its place in its group when it was saved.
 */
export type TodayDone = { seq: number; label: string; row: TodayRow; at?: number; failed?: string[] };

export const CALL_NOW_CAP = 25;
export const OFFERS_CAP = 15;
const POOL_HOURS = 72;
const OFFER_LIVE = ['Offer Made', 'Pending Response', 'Offer Made - Follow Up', 'Offer Made - Retail'];
const OFFER_DEMO = ['Offer Sent', 'Negotiation'];

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const parseMoney = (s: string | null | undefined): number | null => {
  const n = Number(String(s ?? '').replace(/[^0-9.]/g, ''));
  return s && /\d/.test(s) && Number.isFinite(n) && n > 0 ? n : null;
};
const clock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const known = (v: string | null | undefined) => !!v && v !== '—' && !/^(unknown|no contact yet)$/i.test(v.trim());

/**
 * The demo's time labels ("Today 8:51 AM", "Now", "Overdue · 2h",
 * "Tomorrow 10:00 AM") as a local time, relative to `now`. Anything else is
 * null: a label is not evidence of a time.
 */
export function parseDemoWhen(label: string | null | undefined, now: Date): Date | null {
  const t = (label ?? '').trim();
  if (/^now$/i.test(t)) return new Date(now);
  const late = /^overdue\s*·\s*(\d+)\s*(h|m|d)/i.exec(t);
  if (late) {
    const n = Number(late[1]);
    const ms = late[2]!.toLowerCase() === 'h' ? 3_600_000 : late[2]!.toLowerCase() === 'm' ? 60_000 : 86_400_000;
    return new Date(now.getTime() - n * ms);
  }
  const m = /^(today|tomorrow)\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(t);
  if (!m) return null;
  let h = Number(m[2]) % 12;
  if (/pm/i.test(m[4]!)) h += 12;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (/tomorrow/i.test(m[1]!) ? 1 : 0), h, Number(m[3]));
  return d;
}

const createdOf = (p: TodayPerson, now: Date): Date | null => {
  if (p.createdAt) {
    const t = Date.parse(p.createdAt);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return parseDemoWhen(p.created, now);
};
const dueOf = (t: TodayTask, now: Date): Date | null => {
  if (t.dueAt) {
    const x = Date.parse(t.dueAt);
    return Number.isNaN(x) ? null : new Date(x);
  }
  return parseDemoWhen(t.due, now);
};

/** In the running at all: a lead, being worked, or an offer out; not do-not-call; not already saved this session. */
export function inTodayUniverse(p: TodayPerson, vocab: Vocab, done: Record<string, unknown> = {}): boolean {
  const g = stageGroup(p.stage, vocab);
  return (g === 'lead' || g === 'working' || g === 'offer')
    && !isDoNotEngage(p)
    && !done[p.id];
}

/**
 * A new lead for Call now: a brand-new stage, never contacted, and mine or
 * unassigned and under 72 hours old. Partner submissions (New Submission)
 * and leads already tried (Lead - No Contact) are not new.
 */
export function isNewLead(p: TodayPerson, me: string, now: Date, vocab: Vocab, pool = true): boolean {
  if (!isNewStage(p.stage, vocab) || p.lastCommTs !== null) return false;
  if (p.assigned === me) return true;
  if (p.assigned !== null || !pool) return false;
  const c = createdOf(p, now);
  return !!c && now.getTime() - c.getTime() <= POOL_HOURS * 3_600_000;
}

/** Open tasks by seller, built once per list. */
export function tasksByPerson(tasks: TodayTask[]): Map<string, TodayTask[]> {
  const m = new Map<string, TodayTask[]>();
  for (const t of tasks) {
    if (t.done || !t.personId) continue;
    const list = m.get(t.personId);
    if (list) list.push(t);
    else m.set(t.personId, [t]);
  }
  return m;
}

const dueNowish = (t: TodayTask, role?: string | null) => (t.bucket === 'overdue' || t.bucket === 'today') && !notMine(role).test(t.type);
const byDue = (now: Date) => (a: TodayTask, b: TodayTask) => {
  if (a.bucket !== b.bucket) return a.bucket === 'overdue' ? -1 : 1;
  const x = dueOf(a, now)?.getTime() ?? Infinity;
  const y = dueOf(b, now)?.getTime() ?? Infinity;
  return x - y;
};

/** The open overdue or today task that puts a seller on Today, assigned to me or to nobody; the earliest. */
export function dueTaskFor(open: TodayTask[] | undefined, me: string, now: Date, role?: string | null): TodayTask | null {
  const mine = (open ?? []).filter((t) => dueNowish(t, role) && (t.assigned === me || t.assigned === null));
  return mine.sort(byDue(now))[0] ?? null;
}

export type TodayInput = {
  people: TodayPerson[];
  tasks: TodayTask[];
  dealOf: (pid: string) => TodayDeal | undefined;
  me: string;
  now: Date;
  vocab: Vocab;
  /** The session ledger: sellers saved this session, by id. */
  done?: Record<string, TodayDone>;
  /** The rep's workspace role (lib/team Role): which seat's work is theirs. */
  role?: string | null;
};

export function buildToday(input: TodayInput): { rows: TodayRow[]; more: number } {
  const { people, dealOf, me, now, vocab, role } = input;
  const done = input.done ?? {};
  const open = tasksByPerson(input.tasks);
  const taken = new Set<string>();
  const universe = people.filter((p) => inTodayUniverse(p, vocab, done));
  const target = (p: TodayPerson) => ({ name: p.name, phone: p.phone, personId: p.id });
  const address = (p: TodayPerson) => [p.property.addr, p.property.city].filter((x) => known(x)).join(', ');
  const taskOf = (t: TodayTask | null) => (t ? { id: t.id, title: t.title, type: t.type } : null);
  const lastTouch = (p: TodayPerson) => (known(p.lastComm) ? p.lastComm : 'none yet');

  // ---- Call now
  const fresh = universe
    .filter((p) => isNewLead(p, me, now, vocab, workPool(role)))
    .map((p) => ({ p, c: createdOf(p, now) }))
    .sort((a, b) => (a.c?.getTime() ?? Infinity) - (b.c?.getTime() ?? Infinity) || a.p.name.localeCompare(b.p.name));
  const callNow: TodayRow[] = fresh.slice(0, CALL_NOW_CAP).map(({ p, c }) => {
    taken.add(p.id);
    const claim = p.assigned === null;
    const at = c ? (sameDay(c, now) ? clock(c) : c.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : '';
    const source = known(p.source) ? p.source : 'an unknown source';
    return {
      pid: p.id, group: 'now', name: p.name, stage: p.stage,
      tag: at || 'New', tagTone: 'muted',
      reason: `New lead, ${known(p.source) ? p.source : 'no source'}${claim ? ', unassigned' : ''}`,
      why: `New lead from ${source}${at ? (c && sameDay(c, now) ? ` at ${at}` : ` on ${at}`) : ''}. Nobody has called yet.${claim ? ' Calling claims it for you.' : ''}`,
      task: taskOf(dueTaskFor(open.get(p.id), me, now, role)),
      claim, target: target(p), address: address(p),
    };
  });
  for (const { p } of fresh.slice(CALL_NOW_CAP)) taken.add(p.id);
  const more = Math.max(0, fresh.length - CALL_NOW_CAP);

  // ---- Due today
  // A task assigned to me is my work whatever stage its seller is in (a dispo
  // rep's buyer follow-up sits on a seller under contract); an unassigned one
  // only on my own seller still being worked.
  const byId = new Map(universe.map((p) => [p.id, p]));
  const anyById = new Map(people.filter((p) => !isDoNotEngage(p) && !done[p.id]).map((p) => [p.id, p]));
  const dueTasks = input.tasks
    .filter((t) => !t.done && dueNowish(t, role) && !taken.has(t.personId))
    .filter((t) => (t.assigned === me && anyById.has(t.personId)) || (t.assigned === null && byId.get(t.personId)?.assigned === me))
    .sort(byDue(now));
  const due: TodayRow[] = [];
  for (const t of dueTasks) {
    if (taken.has(t.personId)) continue;
    const p = anyById.get(t.personId)!;
    taken.add(p.id);
    const d = dueOf(t, now);
    const overdue = t.bucket === 'overdue';
    const at = d ? clock(d) : '';
    due.push({
      pid: p.id, group: 'due', name: p.name, stage: p.stage,
      tag: overdue ? 'Overdue' : at || 'Today', tagTone: overdue ? 'overdue' : 'due',
      reason: t.title,
      why: `${t.title}, ${overdue ? 'overdue' : at ? `due ${at}` : 'due today'}.${known(p.lastComm) ? ` Last touch: ${p.lastComm}.` : ''}`,
      task: taskOf(t), claim: false, target: target(p), address: address(p),
    });
  }

  // ---- Offers out
  const offerStages = vocab === 'demo' ? OFFER_DEMO : OFFER_LIVE;
  const offers: TodayRow[] = universe
    .filter((p) => !taken.has(p.id) && p.assigned === me && offerStages.includes(p.stage))
    // A next step on the calendar means the seller is not today's work.
    .filter((p) => !(open.get(p.id) ?? []).some((t) => t.bucket === 'upcoming'))
    .sort((a, b) => (a.lastCommTs === null ? -1 : b.lastCommTs === null ? 1 : b.lastCommTs - a.lastCommTs))
    .slice(0, OFFERS_CAP)
    .map((p) => {
      taken.add(p.id);
      const d = dealOf(p.id);
      const amount = d?.contract != null ? d.contract : parseMoney(p.offer);
      const offerText = amount != null ? money(amount) : 'Offer';
      const asking = parseMoney(p.asking);
      const gap = asking != null && amount != null && asking > amount ? asking - amount : null;
      return {
        pid: p.id, group: 'offers', name: p.name, stage: p.stage,
        tag: offerText, tagTone: 'money',
        reason: `Offer out, last touch ${lastTouch(p)}`,
        why: `Offer ${amount != null ? money(amount) + ' ' : ''}out, last touch ${lastTouch(p)}.${asking != null ? ` Asking ${money(asking)}${gap ? `, a ${money(gap)} gap` : ''}.` : ''}`,
        task: taskOf(dueTaskFor(open.get(p.id), me, now, role)),
        claim: false, target: target(p), address: address(p),
      };
    });

  // Saved rows stay where they were in their group, so the list does not
  // reshuffle under the rep as they work down it.
  const withDone = (g: TodayGroup, rows: TodayRow[]) => {
    const out = [...rows];
    Object.values(done).filter((e) => e.row.group === g)
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.seq - b.seq)
      .forEach((e) => out.splice(Math.min(e.at ?? 0, out.length), 0, { ...e.row, done: { label: e.label, ...(e.failed?.length ? { failed: e.failed } : {}) } }));
    return out;
  };
  return { rows: [...withDone('now', callNow), ...withDone('due', due), ...withDone('offers', offers)], more };
}

// ---- Clozr AI ranking (supabase/functions/clozr-today) -----------------------

/** What the model is shown for each row. */
export type TodayCandidate = { id: string; kind: TodayGroup; label: string; due: string; stage: string; value: string | null; detail: string };
export type TodayAiRank = { greeting: string; items: { id: string; why: string }[] };

/** The open rows, as candidates for the model. Saved rows are not today's work any more. */
export function todayCandidates(rows: TodayRow[]): TodayCandidate[] {
  return rows.filter((r) => !r.done).map((r) => ({
    id: r.pid, kind: r.group, label: r.name, due: r.tag, stage: r.stage,
    value: r.tagTone === 'money' ? r.tag : null, detail: `${r.reason}. ${r.why}`,
  }));
}

/**
 * The model's order applied inside each group, so the groups (and new leads
 * first) stand. Ranked rows lead their group in the model's order; rows it
 * left out or that arrived since keep the rules' order after them. Ids the
 * model made up are ignored.
 */
export function mergeTodayAi(rows: TodayRow[], ai: TodayAiRank | null): TodayRow[] {
  if (!ai) return rows;
  const rank = new Map<string, { at: number; why: string }>();
  ai.items.forEach((it, at) => { if (!rank.has(it.id)) rank.set(it.id, { at, why: it.why }); });
  const out: TodayRow[] = [];
  for (const g of TODAY_GROUPS) {
    const inGroup = rows.filter((r) => r.group === g.id).map((r, i) => ({ r, i, k: rank.get(r.pid) }));
    inGroup.sort((a, b) => (a.k?.at ?? Infinity) - (b.k?.at ?? Infinity) || a.i - b.i);
    for (const { r, k } of inGroup) out.push(k?.why ? { ...r, aiWhy: k.why } : r);
  }
  return out;
}
