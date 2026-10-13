// Lane — the transaction-coordination agent.
//
// Two halves. The daily drive (`laneDrive`) is deterministic: it reads the
// file and the TC checklist and says where the deal stands today — the
// day marker, what is due, what has slipped, and which of the playbook's
// yellow/red triggers have fired. It runs on every render, costs nothing, and
// is what the TC screen shows before anyone asks a question.
//
// The conversation (`askLane`) goes to the `lane` edge function, which holds
// the example TC playbook and the contract-to-close checklists as its
// knowledge and answers in Lane's voice: specific, lender- and
// structure-aware, always with a pivot, always with a draft. Lane looks up the
// records itself (sellers, deals, TC files, buyers, vendors), and each
// conversation is a chat kept in lane_chats / lane_messages, filed under the
// property it is about. Without a signed-in workspace (the /demo sample) the
// answer comes from the canned stub at the bottom of this file so the surface
// still works.

import { D, type TcChecklist, type TcTask, type Transaction } from './clozr-types';
import { supabase } from './supabase';

// ─── Daily drive ─────────────────────────────────────────────────────────────

export type LaneTrigger = {
  level: 'yellow' | 'red';
  /** What fired, in the playbook's words. */
  signal: string;
  /** The same-day action the playbook prescribes. */
  action: string;
  /** Who it escalates to, when it does. */
  escalate: string | null;
  /** Where in the playbook this comes from. */
  ref: string;
};

export type LaneDrive = {
  /** D0 … D14, T-5 … T-1, CLOSE, +1 … — the cadence row the file sits on today. */
  dayMarker: string;
  /** Calendar days since D0, or null when the file has no contract date. */
  dayN: number | null;
  /** Calendar days until closing, or null when there is no close date. */
  daysToClose: number | null;
  status: 'green' | 'yellow' | 'red';
  triggers: LaneTrigger[];
  /** Checklist tasks the cadence says should be done by now and are not. */
  overdue: { id: string; task: string; day: string; owner: string; critical: boolean }[];
  /** Tasks due on today's marker. */
  dueToday: { id: string; task: string; day: string; owner: string; critical: boolean }[];
  /** The next milestone on the rail and how far off it is. */
  nextMilestone: { k: string; label: string; inDays: number } | null;
  /** Vendor clocks that are running (playbook §4), with what to do at each mark. */
  slas: { item: string; clock: string }[];
};

const DAY_MS = 86_400_000;

/** "Aug 27" / "2026-08-27" → a local Date at midnight, or null. */
export function parseDisplayDate(s: string | null | undefined, ref = new Date()): Date | null {
  if (!s || s === '—') return null;
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(s);
  if (iso) { const d = new Date(s.slice(0, 10) + 'T00:00:00'); return Number.isNaN(d.getTime()) ? null : d; }
  const d = new Date(`${s} ${ref.getFullYear()}`);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);

/** A task's day target as "days after D0" (D-marks) or "days before close" (T-marks). */
function taskDue(t: TcTask): { kind: 'd'; n: number } | { kind: 't'; n: number } | { kind: 'close' } | { kind: 'post'; n: number } | null {
  const day = t.day.trim();
  let m = /^D(\d+)/.exec(day);
  if (m) return { kind: 'd', n: Number(m[1]) };
  m = /^T-(\d+)/.exec(day);
  if (m) return { kind: 't', n: Number(m[1]) };
  if (/^CLOSE/i.test(day)) return { kind: 'close' };
  m = /^\+(\d+)/.exec(day);
  if (m) return { kind: 'post', n: Number(m[1]) };
  return null; // varies / as need / +1 of retail: no clock of their own
}

const find = (tasks: TcTask[], re: RegExp) => tasks.find((t) => re.test(t.t)) ?? null;

/**
 * Where the file stands today. Pure: the same file and the same day give the
 * same answer, so it is safe on every render and easy to test.
 */
export function laneDrive(tx: Transaction, template: TcChecklist | null, today = new Date(), tcName = 'TC'): LaneDrive {
  const d0 = parseDisplayDate(tx.d0Iso ?? tx.d0, today);
  const close = parseDisplayDate(tx.closingIso ?? tx.closing, today);
  const dayN = d0 ? daysBetween(d0, today) : null;
  const daysToClose = close ? daysBetween(today, close) : null;
  const done = (id: string) => !!tx.done[id];
  const tasks = template ? template.phases.flatMap((p) => p.tasks) : [];

  // The marker: close week is counted from the close, everything before from D0.
  let dayMarker = '—';
  if (daysToClose !== null && daysToClose <= 0) dayMarker = daysToClose === 0 ? 'CLOSE' : `+${-daysToClose}`;
  else if (daysToClose !== null && daysToClose <= 5) dayMarker = `T-${daysToClose}`;
  else if (dayN !== null) dayMarker = `D${Math.max(0, dayN)}`;

  const isDue = (t: TcTask, when: 'overdue' | 'today'): boolean => {
    const due = taskDue(t);
    if (!due) return false;
    if (due.kind === 'd') { if (dayN === null) return false; return when === 'today' ? dayN === due.n : dayN > due.n; }
    if (due.kind === 't') { if (daysToClose === null) return false; return when === 'today' ? daysToClose === due.n : daysToClose < due.n; }
    if (due.kind === 'close') { if (daysToClose === null) return false; return when === 'today' ? daysToClose === 0 : daysToClose < 0; }
    if (daysToClose === null) return false;
    return when === 'today' ? -daysToClose === due.n : -daysToClose > due.n;
  };
  const row = (t: TcTask) => ({ id: t.id, task: t.t, day: t.day, owner: t.owner, critical: t.critical });
  const overdue = tasks.filter((t) => !done(t.id) && isDue(t, 'overdue')).map(row);
  const dueToday = tasks.filter((t) => !done(t.id) && isDue(t, 'today')).map(row);

  // The playbook's extension-prevention triggers (§5), read off the checklist.
  const triggers: LaneTrigger[] = [];
  const commit = find(tasks, /prelim title commitment/i);
  const emd = find(tasks, /EMD to title|earnest money posted/i);
  const ctc = find(tasks, /Clear to Close/i);
  const payoff = find(tasks, /seller payoff/i);
  const wire = find(tasks, /wire instructions by phone/i);
  const memo = find(tasks, /memo \+ novation docs|memorandum/i);
  const stop = find(tasks, /STOP if the property state restricts/i);
  const hudAll = template ? template.hud.every((h) => !!tx.hudDone[h.id]) : false;
  const novation = tx.dealType === 'novation';

  if (commit && !done(commit.id) && dayN !== null) {
    if (dayN >= 8) triggers.push({ level: 'red', signal: 'Title commitment not in hand by D8', action: 'Title manager call same day; consider a title company swap if this is a pattern.', escalate: 'Ops lead + ' + tcName, ref: 'Playbook §5 · red triggers' });
    else if (dayN >= 6) triggers.push({ level: 'yellow', signal: 'Title commitment not in hand by D6 EOD', action: 'Call title direct today and draft the escalation email to the title manager.', escalate: null, ref: 'Playbook §5 · yellow triggers' });
  }
  if (emd && !done(emd.id) && dayN !== null && dayN >= 3) {
    triggers.push({ level: 'yellow', signal: 'EMD not confirmed at title by D2', action: 'Title will not fully open the file without it — confirm the wire in writing today.', escalate: null, ref: 'Playbook §3 · order on D1' });
  }
  if (ctc && !done(ctc.id) && dayN !== null && dayN >= 10 && (daysToClose === null || daysToClose > 0)) {
    triggers.push({ level: 'red', signal: 'CTC target D10 missed', action: 'Escalate same day; daily title pressure from here.', escalate: 'Ops lead + ' + tcName, ref: 'Playbook §2 · D10' });
  }
  if (payoff && !done(payoff.id) && daysToClose !== null && daysToClose <= 5 && daysToClose >= 0) {
    triggers.push({ level: 'yellow', signal: 'Seller payoff not confirmed by T-5', action: "Call the lender's payoff department direct; draft the estimated-payoff CPL request to title.", escalate: null, ref: 'Playbook §5 · yellow triggers' });
  }
  if (daysToClose !== null && daysToClose <= 2 && daysToClose >= 0 && (!hudAll || !tx.signoff)) {
    triggers.push({ level: 'red', signal: !hudAll ? 'HUD/CD lines not all verified at T-2' : 'HUD/CD verified but no ops lead sign-off', action: 'No wires until every line is verified and the ops lead signs off. Walk the lines, email the CD + review to the ops lead, wait for the explicit reply.', escalate: tcName + ' + ops lead', ref: 'Playbook §6 · hard funding gate' });
  }
  if (wire && !done(wire.id) && daysToClose !== null && daysToClose <= 1 && daysToClose >= 0) {
    triggers.push({ level: 'red', signal: 'Wire instructions not verbally verified at T-1', action: 'Call title on a known number and read the instructions back. Anti-fraud check — not optional.', escalate: tcName + ' + ops lead', ref: 'Playbook §2 · T-1' });
  }
  if (novation && stop && !done(stop.id) && dayN !== null && dayN >= 1) {
    triggers.push({ level: 'red', signal: 'Novation Day-1 state check not done', action: 'Confirm the property state; if the state restricts novation, stop and escalate.', escalate: 'Attorney', ref: 'Playbook §7 · Day-1 stop rules' });
  }
  if (novation && memo && !done(memo.id) && dayN !== null && dayN >= 3) {
    triggers.push({ level: 'red', signal: 'Memorandum not confirmed recorded by D3', action: 'Walk into the county recorder personally, or e-record where supported.', escalate: 'Attorney, immediately', ref: 'Playbook §5 · memo not recorded' });
  }
  const overdueCritical = overdue.filter((t) => t.critical);
  if (overdueCritical.length && !triggers.length) {
    triggers.push({ level: 'yellow', signal: `${overdueCritical.length} critical-path item${overdueCritical.length === 1 ? '' : 's'} past its day`, action: 'Take the next action on each today; a pivot is drafted at 75% of the SLA, not after it expires.', escalate: null, ref: 'Playbook §2 · Rule 3' });
  }

  const status: LaneDrive['status'] = triggers.some((t) => t.level === 'red') ? 'red' : triggers.length || overdue.length ? 'yellow' : 'green';

  // Next milestone on the rail.
  let nextMilestone: LaneDrive['nextMilestone'] = null;
  if (template && dayN !== null) {
    for (const m of template.milestones) {
      const n = /^D(\d+)/.exec(m.k);
      if (!n) continue;
      const at = Number(n[1]);
      if (at > dayN) { nextMilestone = { k: m.k, label: m.t, inDays: at - dayN }; break; }
    }
    if (!nextMilestone && daysToClose !== null && daysToClose > 0) nextMilestone = { k: 'CLOSE', label: 'Funding day', inDays: daysToClose };
  }

  // Clocks that are running on someone else (§4).
  const slas: LaneDrive['slas'] = [];
  if (commit && !done(commit.id)) slas.push({ item: 'Title commitment', clock: '5 business days from open · D5 EOD call · D6 EOD escalate to title manager' });
  if (payoff && !done(payoff.id) && dayN !== null && dayN >= 1) slas.push({ item: 'Seller payoff demand', clock: '5–7 business days · day 3 status check · day 5 call payoff dept direct' });
  const buyerEmd = find(tasks, /buyer EMD/i);
  if (buyerEmd && !done(buyerEmd.id) && dayN !== null && dayN >= 4) slas.push({ item: 'End-buyer EMD wire', clock: '48 hours after assignment · hour 24 confirm · hour 48 risk-of-default escalation' });
  if (tx.commitment.exceptions.some((e) => e.severity !== 'cleared')) slas.push({ item: 'Schedule B-I curative', clock: 'daily check after order · pivot path drafted by 75% of SLA' });

  return { dayMarker, dayN, daysToClose, status, triggers, overdue, dueToday, nextMilestone, slas };
}

// ─── Conversation ────────────────────────────────────────────────────────────

/** One transaction's state, flattened to what Lane needs to reason. */
export type LaneContext = {
  dealId: string;
  address: string;
  /** Two-letter state, when the address has one: title routes on it. */
  state: string | null;
  seller: string;
  buyer: string;
  buyerFinancing: string | null;
  lender: string | null;
  /** assignment | novation — which checklist track runs the file. */
  dealType: string;
  structure: string | null;
  d0: string;
  ctcTarget: string;
  closing: string;
  titleCo: string;
  titleContact: string;
  /** The workspace TC — never a hardcoded name. */
  tcName: string;
  commitmentStatus: string;
  /** Exceptions still needing a cure, most severe first. */
  openExceptions: { ref: string; kind: string; text: string; severity: string; due: string; owner: string }[];
  /** Earnest money rows that are not yet received. */
  outstandingEarnest: { party: string; amount: string; due: string; status: string }[];
  /** Deadlines not yet met. */
  liveDeadlines: { k: string; date: string; owner: string; status: string }[];
  outstandingDocs: { k: string; owner: string; due: string }[];
  checklist: { done: number; total: number; notDone: { id: string; task: string; day: string; owner: string; critical: boolean }[] };
  hud: { done: number; total: number; review: string | null; signoff: string | null };
  drive: LaneDrive;
};

export type LaneRequest = {
  /** The TC's question, verbatim. */
  question: string;
  /** The file on screen. The stub answers from it; signed in, Lane reads the records itself. */
  context: LaneContext | null;
  /** Prior turns, oldest first: the stub's thread, and the function's when chats are not stored. */
  history: LaneTurn[];
  /** The signed-in workspace; without it the stub answers. */
  workspaceId?: number | null;
  /** The chat this question belongs to; none starts a new one. */
  chatId?: number | null;
  /** The record Lane was opened from, so a new chat starts filed under it. */
  focus?: { sellerId?: number | null; dealId?: number | null } | null;
  /** The workspace TC, by name. */
  tcName?: string;
};

/** A suggested follow-up the UI renders as a chip. */
export type LaneSuggestion = { label: string; question: string };

/**
 * The part of the file a ref points at. These are the sections the TC tab
 * actually renders, so every target except 'none' is somewhere the panel can
 * send you; 'none' is a playbook citation, which has no screen of its own.
 */
export type LaneRefTarget = 'commitment' | 'earnest' | 'deadlines' | 'documents' | 'checklist' | 'hud' | 'none';

/** A citation: what it is, and where on the file to find it. */
export type LaneRef = { label: string; target: LaneRefTarget };

const TARGETS: LaneRefTarget[] = ['commitment', 'earnest', 'deadlines', 'documents', 'checklist', 'hud', 'none'];

/**
 * Refs used to be bare strings, and the sample stub still writes them that
 * way. Both shapes normalise to a LaneRef so the panel has one thing to
 * render, and an unrecognised target degrades to a plain chip rather than a
 * button that goes nowhere.
 */
export function toLaneRef(r: unknown): LaneRef | null {
  if (typeof r === 'string') return r.trim() ? { label: r.trim(), target: 'none' } : null;
  if (!r || typeof r !== 'object') return null;
  const { label, target } = r as { label?: unknown; target?: unknown };
  if (typeof label !== 'string' || !label.trim()) return null;
  return { label: label.trim(), target: TARGETS.includes(target as LaneRefTarget) ? (target as LaneRefTarget) : 'none' };
}

export const toLaneRefs = (v: unknown): LaneRef[] =>
  (Array.isArray(v) ? v : []).map(toLaneRef).filter((r): r is LaneRef => r !== null).slice(0, 6);

/** A message Lane wrote for the TC to send, ready to copy. */
export type LaneDraft = { to: string; channel: 'email' | 'sms' | 'post'; subject: string | null; body: string };
/** A task or calendar item Lane suggests; the TC sets it with one tap. due: YYYY-MM-DD or YYYY-MM-DDTHH:MM (Central). */
export type LaneAction = { kind: 'task' | 'calendar'; title: string; due: string; notes: string | null };

export type LaneResponse = {
  /** Assistant prose. Rendered with `white-space: pre-line`. */
  answer: string;
  /** Short cited references, each with the part of the file it points at. */
  refs: LaneRef[];
  suggestions: LaneSuggestion[];
  drafts: LaneDraft[];
  actions?: LaneAction[];
  /** Records Lane opened to answer, for the panel to link. */
  cards?: LaneCard[];
  /** The chat this exchange was filed in (null: chats are not stored, or the stub). */
  chat?: LaneChat | null;
  /** Set when the question was about another property: the chat it was asked in. */
  movedFrom?: number | null;
  /** True when the answer came from the stub, so the UI can say so. */
  stubbed: boolean;
};

/** A record Lane opened: a seller (the property) or a buyer. */
export type LaneCard = { kind: 'seller' | 'deal' | 'buyer' | 'vendor'; id: number; title: string; subtitle: string };

export type LaneTurn = { role: 'tc' | 'lane'; text: string; refs?: LaneRef[]; drafts?: LaneDraft[]; actions?: LaneAction[]; cards?: LaneCard[] };

/** One conversation with Lane, filed under the property it is about once Lane knows. */
export type LaneChat = {
  id: number; title: string; sellerId: number | null; dealId: number | null; address: string | null; updatedAt: string;
  /** The sample workspace has no seller ids: the record a chat was asked on. */
  personId?: string | null;
};

type ChatRowDb = { id: number; title: string; seller_id: number | null; deal_id: number | null; address: string | null; updated_at?: string };
const toChat = (r: ChatRowDb): LaneChat => ({
  id: r.id, title: r.title || r.address || 'New chat', sellerId: r.seller_id ?? null, dealId: r.deal_id ?? null,
  address: r.address ?? null, updatedAt: r.updated_at ?? new Date().toISOString(),
});

/** My chats, newest first. Empty when the store has no chats yet (or none are mine). */
export async function listLaneChats(workspaceId: number): Promise<LaneChat[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('lane_chats' as never)
    .select('id, title, seller_id, deal_id, address, updated_at')
    .eq('workspace_id' as never, workspaceId as never).is('archived_at' as never, null)
    .order('updated_at' as never, { ascending: false }).limit(100);
  if (error || !data) return [];
  return (data as unknown as ChatRowDb[]).map(toChat);
}

/** One chat's turns, oldest first. */
export async function loadLaneMessages(chatId: number): Promise<LaneTurn[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('lane_messages' as never)
    .select('role, body, refs, drafts, actions, cards')
    .eq('chat_id' as never, chatId as never).order('id' as never, { ascending: true }).limit(400);
  if (error || !data) return [];
  return (data as unknown as { role: string; body: string; refs: unknown; drafts: unknown; actions: unknown; cards: unknown }[]).map((m) => ({
    role: m.role === 'tc' ? 'tc' : 'lane',
    text: m.body,
    refs: toLaneRefs(m.refs),
    drafts: Array.isArray(m.drafts) ? (m.drafts as LaneDraft[]) : [],
    actions: Array.isArray(m.actions) ? (m.actions as LaneAction[]) : [],
    cards: Array.isArray(m.cards) ? (m.cards as LaneCard[]) : [],
  }));
}

/** Delete a chat and its messages. */
export async function deleteLaneChat(chatId: number): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from('lane_chats' as never).delete().eq('id' as never, chatId as never);
  return !error;
}

/** Packs a transaction into a LaneContext. Pure — safe to call on every render. */
export function laneContext(
  tx: Transaction,
  meta: { address: string; seller: string; buyer: string; state?: string | null; tcName?: string },
  today = new Date(),
): LaneContext {
  const rank: Record<string, number> = { critical: 0, warning: 1, cleared: 2 };
  const template = (D.tcChecklists as Record<string, TcChecklist>)[tx.dealType] ?? null;
  const tasks = template ? template.phases.flatMap((p) => p.tasks) : [];
  const hudTotal = template ? template.hud.length : 0;
  const tcName = meta.tcName || 'TC';
  return {
    dealId: tx.dealId,
    address: meta.address,
    state: meta.state ?? tx.state ?? null,
    seller: meta.seller,
    buyer: meta.buyer,
    buyerFinancing: tx.buyerFinancing ?? null,
    lender: tx.lender ?? null,
    dealType: tx.dealType,
    structure: tx.structure ?? null,
    d0: tx.d0,
    ctcTarget: tx.ctcTarget,
    closing: tx.closing,
    titleCo: tx.titleCo,
    titleContact: tx.titleContact,
    tcName,
    commitmentStatus: tx.commitment.status,
    openExceptions: tx.commitment.exceptions
      .filter((e) => e.severity !== 'cleared')
      .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
      .map((e) => ({ ref: e.ref, kind: e.kind, text: e.text, severity: e.severity, due: e.due, owner: e.owner })),
    outstandingEarnest: tx.earnest
      .filter((e) => e.status !== 'Received')
      .map((e) => ({ party: e.party, amount: e.amount, due: e.due, status: e.status })),
    liveDeadlines: tx.deadlines
      .filter((d) => d.status !== 'met')
      .map((d) => ({ k: d.k, date: d.date, owner: d.owner, status: d.status })),
    outstandingDocs: tx.documents
      .filter((d) => d.status !== 'Received')
      .map((d) => ({ k: d.k, owner: d.owner, due: d.due })),
    checklist: {
      done: tasks.filter((t) => !!tx.done[t.id]).length,
      total: tasks.length,
      notDone: tasks.filter((t) => !tx.done[t.id]).map((t) => ({ id: t.id, task: t.t, day: t.day, owner: t.owner, critical: t.critical })),
    },
    hud: {
      done: template ? template.hud.filter((h) => !!tx.hudDone[h.id]).length : 0,
      total: hudTotal,
      review: tx.tcReview,
      signoff: tx.signoff,
    },
    drive: laneDrive(tx, template, today, tcName),
  };
}

/** Openers shown before the TC has asked anything. */
export const LANE_PROMPTS: LaneSuggestion[] = [
  { label: 'Morning sweep', question: 'Run the morning sweep on this file: day marker, next milestone, oldest open item, SLA clocks, and what I do today.' },
  { label: "What's blocking close?", question: "What's blocking this closing right now, and what's the pivot?" },
  { label: 'Review the commitment', question: 'Review the title commitment and tell me what needs curing, with a pivot for each item.' },
  { label: 'Status post', question: 'Write the team status post for this file in the day-marker format.' },
  { label: 'Chase the EMD', question: 'The buyer EMD is late. Draft what I send.' },
  { label: 'T-2 HUD/CD', question: 'Walk me through the T-2 HUD/CD review for this file.' },
];

/** Openers for a new chat, before it is about a property: Lane finds the records. */
export const LANE_START: LaneSuggestion[] = [
  { label: 'Morning sweep', question: 'Run the morning sweep across my open TC files: what is behind, what is due today, and what I do first.' },
  { label: 'Closing this week', question: 'Which files close in the next 7 days, and what is still open on each?' },
  { label: 'What is behind?', question: 'Which files have a critical checklist line past its day? Lead with the worst one.' },
];

/**
 * Ask Lane a question about a transaction.
 *
 * A signed-in workspace goes to the `lane` edge function (Anthropic, with the
 * playbook as its knowledge). The sample workspace has no server behind it
 * and answers from the stub below.
 */
export async function askLane(req: LaneRequest): Promise<LaneResponse> {
  if (supabase && req.workspaceId != null) {
    const { data, error } = await supabase.functions.invoke('lane', {
      body: {
        workspace_id: req.workspaceId, question: req.question, chat_id: req.chatId ?? null,
        focus: req.focus ? { seller_id: req.focus.sellerId ?? null, deal_id: req.focus.dealId ?? null } : null,
        tc_name: req.tcName, history: req.history.slice(-12).map((t) => ({ role: t.role, text: t.text })),
      },
    });
    if (error) {
      let message = error.message;
      try {
        const ctx = (error as { context?: Response }).context;
        if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
      } catch { /* keep the transport message */ }
      throw new Error(message);
    }
    const r = data as { ok?: boolean; answer?: string; refs?: unknown; refs_v2?: unknown; suggestions?: LaneSuggestion[]; drafts?: LaneDraft[]; actions?: LaneAction[]; cards?: LaneCard[]; chat?: ChatRowDb | null; moved_from?: number | null; error?: string };
    if (!r?.ok || typeof r.answer !== 'string') throw new Error(r?.error ?? 'Lane returned nothing.');
    // refs_v2 is the targeted shape; refs is the label-only one every older
    // function returns. Preferring v2 and falling back keeps this client
    // working against a function deployed either side of the change.
    return {
      answer: r.answer, refs: toLaneRefs(r.refs_v2 ?? r.refs), suggestions: r.suggestions ?? [], drafts: r.drafts ?? [],
      actions: Array.isArray(r.actions) ? r.actions : [], cards: Array.isArray(r.cards) ? r.cards : [],
      chat: r.chat && typeof r.chat.id === 'number' ? toChat(r.chat) : null, movedFrom: r.moved_from ?? null, stubbed: false,
    };
  }
  await new Promise((r) => setTimeout(r, 420));
  if (!req.context) {
    return stub({
      answer: 'Sample workspace: name a property with a transaction file (open one from the TC screen) and I\'ll work it. Signed in, I find any property, buyer or vendor in the CRM on my own.',
      refs: [], suggestions: [],
    });
  }
  return stubAnswer({ ...req, context: req.context });
}

// ─── STUB (sample workspace only) ────────────────────────────────────────────
// Canned prose so /demo exercises the surface. Never used when signed in.

const sev = (s: string) => (s === 'critical' ? 'must be cured' : 'should be resolved');
/** A stub citation, with the section of the file it points at. */
const ref = (label: string, target: LaneRefTarget = 'none'): LaneRef => ({ label, target });
const stub = (r: Omit<LaneResponse, 'stubbed' | 'refs' | 'drafts'> & { refs: unknown[]; drafts?: LaneDraft[] }): LaneResponse =>
  ({ ...r, refs: toLaneRefs(r.refs), drafts: r.drafts ?? [], stubbed: true });

function stubAnswer(req: LaneRequest & { context: LaneContext }): LaneResponse {
  const q = req.question.toLowerCase();
  const c = req.context;
  const exc = c.openExceptions;
  const emd = c.outstandingEarnest;
  const docs = c.outstandingDocs;
  const dr = c.drive;

  if (q.includes('sweep') || q.includes('today')) {
    const lines = [
      `${c.address} · ${c.dealType === 'novation' ? 'Novation' : 'Assignment'} · ${dr.dayMarker} · ${dr.status.toUpperCase()}`,
      dr.nextMilestone ? `Next milestone: ${dr.nextMilestone.k} ${dr.nextMilestone.label} in ${dr.nextMilestone.inDays} day${dr.nextMilestone.inDays === 1 ? '' : 's'}.` : null,
      dr.overdue.length ? `Past its day: ${dr.overdue.map((t) => `${t.task} (${t.day}, ${t.owner})`).join('; ')}.` : 'Nothing past its day.',
      dr.dueToday.length ? `Due today: ${dr.dueToday.map((t) => t.task).join('; ')}.` : null,
      ...dr.triggers.map((t) => `${t.level.toUpperCase()}: ${t.signal} → ${t.action}${t.escalate ? ` Escalate: ${t.escalate}.` : ''}`),
      dr.slas.length ? `Clocks running: ${dr.slas.map((s) => `${s.item} (${s.clock})`).join('; ')}.` : null,
      '',
      'Want me to draft that?',
    ].filter((l): l is string => l !== null);
    return stub({ answer: lines.join('\n'), refs: [ref('Playbook §2 · daily drive'), ...dr.triggers.map((t) => ref(t.ref))], suggestions: LANE_PROMPTS.slice(1, 4) });
  }

  if (q.includes('commitment') || q.includes('cure') || q.includes('title') || q.includes('exception')) {
    if (!exc.length) {
      return stub({
        answer:
          `The commitment on ${c.address} is ${c.commitmentStatus.toLowerCase()} and I don't see an open exception.\n\n`
          + `Nothing to cure on my read. Keep an eye on the settlement statement — that's the usual late item.\n\nWant me to draft that?`,
        refs: [ref('Commitment: ' + c.commitmentStatus, 'commitment')],
        suggestions: [
          { label: "What's blocking close?", question: "What's blocking this closing right now, and what's the pivot?" },
          { label: 'Deadline check', question: 'Which deadlines are at risk this week?' },
        ],
      });
    }
    const lines = exc.map(
      (e) => `• ${e.ref} — ${e.kind}. ${e.text}\n  ${sev(e.severity).replace(/^./, (m) => m.toUpperCase())} by ${e.due}. Owner: ${e.owner}.`,
    );
    return stub({
      answer:
        `${c.titleCo} has the commitment at "${c.commitmentStatus}". ${exc.length} exception${exc.length > 1 ? 's' : ''} still open on ${c.address}:\n\n`
        + lines.join('\n\n')
        + `\n\nOrder I'd work them: anything marked critical first — those stop the file, not just slow it. `
        + `Send the objection letter before your objection deadline even if a cure is promised; a promise isn't a cure.\n\nWant me to draft that?`,
      refs: exc.map((e) => ref(e.ref, 'commitment')),
      suggestions: [
        { label: 'Draft the objection letter', question: 'Draft a title objection letter for the open exceptions.' },
        { label: 'Who do I chase?', question: 'Who owes what next on this file?' },
      ],
    });
  }

  if (q.includes('emd') || q.includes('earnest') || q.includes('wire') || q.includes('deposit')) {
    if (!emd.length) {
      return stub({
        answer: `All earnest money on ${c.address} is in and receipted. Nothing outstanding.`,
        refs: [ref('Earnest money', 'earnest')],
        suggestions: [{ label: "What's blocking close?", question: "What's blocking this closing right now, and what's the pivot?" }],
      });
    }
    const e = emd[0];
    const emdBody = `Hi — following up on the ${e.amount} ${e.party.toLowerCase()} for ${c.address}. It was due ${e.due} and ${c.titleCo} hasn't receipted it. Closing is ${c.closing}. Can you send the wire confirmation number today? If it's already out, the confirmation is enough and I'll chase it from this end.`;
    return stub({
      answer:
        `${e.party} — ${e.amount} — is ${e.status.toLowerCase()} (was due ${e.due}) with ${c.titleCo}.\n\n`
        + `Message I'd send:\n\n`
        + `"${emdBody}"\n\n`
        + `Copy the title contact so the receipt lands in front of everyone at once. At 48 hours this is a risk-of-default note to the dispo lead.`,
      refs: emd.map((x) => ref(x.party, 'earnest')),
      drafts: [
        { to: c.buyer, channel: 'sms', subject: null, body: emdBody },
        { to: c.titleContact || c.titleCo, channel: 'email', subject: `EMD receipt — ${c.address}`, body: emdBody },
      ],
      suggestions: [
        { label: "What's blocking close?", question: "What's blocking this closing right now, and what's the pivot?" },
        { label: 'Deadline check', question: 'Which deadlines are at risk this week?' },
      ],
    });
  }

  if (q.includes('objection') || q.includes('draft') || q.includes('letter')) {
    const body = exc.length
      ? exc.map((e) => `  ${e.ref} (${e.kind}) — ${e.text}`).join('\n')
      : '  [no open exceptions on this commitment]';
    const letter = `To: ${c.titleCo}\nRe: Escrow — ${c.address}. Closing ${c.closing}.\n\nBuyer objects to the following items on the commitment and requests cure prior to closing:\n\n${body}\n\nPlease confirm in writing which items ${c.titleCo} will cure and by what date. Items not cured by the closing date will be addressed under the contract's title provisions.`;
    return stub({
      answer:
        `Draft — title objection letter, ${c.address}:\n\n`
        + letter
        + `\n\nSend it inside your objection window — sending late is the same as waiving.`,
      refs: exc.map((e) => ref(e.ref, 'commitment')),
      drafts: [{ to: c.titleContact || c.titleCo, channel: 'email', subject: `Title objection — ${c.address}`, body: letter }],
      suggestions: [{ label: 'Who do I chase?', question: 'Who owes what next on this file?' }],
    });
  }

  if (q.includes('deadline') || q.includes('date') || q.includes('risk') || q.includes('week') || q.includes('option')) {
    const dl = c.liveDeadlines;
    if (!dl.length) return stub({ answer: `Every dated item on ${c.address} is met. Closing ${c.closing}.`, refs: [], suggestions: [] });
    return stub({
      answer:
        `Live dates on ${c.address}, closing ${c.closing}:\n\n`
        + dl.map((d) => `• ${d.k} — ${d.date} (${d.owner})${d.status === 'due' ? '  ← near' : ''}`).join('\n')
        + `\n\nThe ones I'd watch are whatever sits in front of the option period and the title objection date — `
        + `those are the two that quietly expire and can't be recovered.`,
      refs: dl.map((d) => ref(d.k, 'deadlines')),
      suggestions: [
        { label: 'Review the commitment', question: 'Review the title commitment and tell me what needs curing, with a pivot for each item.' },
        { label: 'Who do I chase?', question: 'Who owes what next on this file?' },
      ],
    });
  }

  if (q.includes('doc') || q.includes('outstanding') || q.includes('who') || q.includes('chase') || q.includes('owe')) {
    return stub({
      answer:
        docs.length
          ? `Outstanding on ${c.address}:\n\n`
            + docs.map((d) => `• ${d.k} — ${d.owner}, due ${d.due}`).join('\n')
            + `\n\nSeller-owned items are the ones that slip; they don't do this for a living. `
            + `Send them one message with one ask, not a list.`
          : `Nothing outstanding on ${c.address}. Every document is receipted.`,
      refs: docs.map((d) => ref(d.k, 'documents')),
      suggestions: [{ label: 'Chase the EMD', question: 'The buyer EMD is late. Draft what I send.' }],
    });
  }

  if (q.includes('block') || q.includes('status') || q.includes('close') || q.includes('summary') || q.includes('post')) {
    const bits: string[] = [];
    if (emd.length) bits.push(`${emd[0].party} ${emd[0].amount} is ${emd[0].status.toLowerCase()}`);
    const crit = exc.filter((e) => e.severity === 'critical');
    if (crit.length) bits.push(`${crit[0].ref} (${crit[0].kind}) needs a cure by ${crit[0].due}`);
    if (docs.length) bits.push(`${docs.length} document${docs.length > 1 ? 's' : ''} outstanding`);
    for (const t of dr.triggers) bits.push(`${t.signal} — ${t.action}`);
    const post = bits.length
      ? `${c.address} · ${dr.dayMarker} · ${dr.status.toUpperCase()} · closes ${c.closing}\n${bits.map((b, i) => `${i + 1}. ${b}`).join('\n')}`
      : `${c.address} · ${dr.dayMarker} · GREEN · closes ${c.closing} · nothing outstanding`;
    return stub({
      answer:
        bits.length
          ? `${c.address} closes ${c.closing}. ${dr.dayMarker} · ${dr.status.toUpperCase()}. What's actually in the way:\n\n`
            + bits.map((b, i) => `${i + 1}. ${b}`).join('\n')
            + `\n\nThe earnest money and any critical exception are the only two that can move the closing date. `
            + `Everything else runs in parallel.`
          : `${c.address} is clean. ${dr.dayMarker} · GREEN. Closing ${c.closing} with nothing outstanding on my read.`,
      refs: [ref(c.commitmentStatus, 'commitment'), ...emd.map((e) => ref(e.party, 'earnest')), ...dr.triggers.map((t) => ref(t.ref))],
      drafts: [{ to: 'team', channel: 'post', subject: null, body: post }],
      suggestions: [
        { label: 'Review the commitment', question: 'Review the title commitment and tell me what needs curing, with a pivot for each item.' },
        { label: 'Chase the EMD', question: 'The buyer EMD is late. Draft what I send.' },
      ],
    });
  }

  return stub({
    answer:
      `I can work the commitment and its cure items, earnest money, the dated deadlines, the checklist, and what's outstanding `
      + `on ${c.address}.\n\nAsk me about any of those and I'll pull from this file — ${dr.dayMarker}, commitment `
      + `"${c.commitmentStatus}", closing ${c.closing}.`,
    refs: [],
    suggestions: LANE_PROMPTS.slice(0, 3),
  });
}
