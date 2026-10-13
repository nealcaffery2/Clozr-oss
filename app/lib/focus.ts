// "Clozr for today": the three to six things a rep should do first, each one
// pointing at its record.
//
// Six sources, in the order the rules trust them:
//   overdue tasks → today's appointments → unassigned new leads → tasks due
//   today → closings within 7 days → leads going cold (no touch in 3+ days,
//   highest motivation first) → deals 14+ days under contract with no buyer.
//
// Pure and import-free, so the clozr-today and ask-clozr edge functions (Deno)
// and tools/focus.test.ts (tsx) share one copy. The functions read the rows
// (supabase/functions/_shared/focus.ts) and hand them in; the model, when
// there is one, only reorders these items and rewrites their one line, and
// checkFocusWhy() keeps any line whose numbers are not the item's own out.

export type FocusKind = 'overdue_task' | 'appointment' | 'new_lead' | 'due_task' | 'closing' | 'cold_lead' | 'stale_deal';
export type FocusRecord = { kind: 'seller' | 'deal'; id: number };

export type FocusItem = {
  /** Stable across loads: kind and row id, e.g. "task:812". What the model must hand back. */
  id: string;
  kind: FocusKind;
  /** The record the row opens. */
  record: FocusRecord;
  /** The person or the property, exactly as the database has it. */
  title: string;
  /** One line, facts only: what it is and why now. */
  detail: string;
  /** A short label for the right-hand side: "Overdue", "2:30 PM", "Closes Fri". */
  tag: string;
  tone: 'overdue' | 'due' | 'money' | 'muted';
};

export type FocusTaskRow = { id: number; title: string; task_type: string | null; due_at: string | null; seller_id: number | null; deal_id: number | null; seller_name: string | null };
export type FocusAppointmentRow = { id: number; title: string; starts_at: string; seller_id: number | null; seller_name: string | null; location: string | null };
export type FocusLeadRow = { id: number; name: string; lead_stage: string | null; motivation: string | null; property_address: string | null; last_touch_at: string | null; created_at: string | null; source?: string | null };
export type FocusDealRow = { id: number; stage: string; close_date: string | null; stage_entered_at: string | null; address: string | null; seller_id: number | null; seller_name: string | null; offer_amount: number | null };

export type FocusInput = {
  now: Date;
  /** IANA zone the rep works in, for "today" and clock times. */
  tz: string;
  tasks: FocusTaskRow[];
  appointments: FocusAppointmentRow[];
  newLeads: FocusLeadRow[];
  coldLeads: FocusLeadRow[];
  closings: FocusDealRow[];
  staleDeals: FocusDealRow[];
};

export const FOCUS_MIN = 3;
export const FOCUS_MAX = 6;
export const COLD_DAYS = 3;
export const STALE_DEAL_DAYS = 14;
export const CLOSING_DAYS = 7;
/** At most this many of one kind in the first pass, so one busy source does not crowd out the rest. */
const PER_KIND = 2;

const ORDER: FocusKind[] = ['overdue_task', 'appointment', 'new_lead', 'due_task', 'closing', 'cold_lead', 'stale_deal'];

const DAY = 86_400_000;
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

/** "2:30 PM" in the rep's zone. */
export function clockIn(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
}

/** YYYY-MM-DD of an instant in the rep's zone. */
export function dayIn(d: Date, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Whole days between two calendar dates (YYYY-MM-DD), b − a. */
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

/**
 * How motivated a seller sounds, for ordering cold leads: a number when the
 * field holds one (a 1–10 score), else hot/high/urgent 8, warm/medium 5,
 * low/cold 2, anything else 0. Only ever compared, never shown.
 */
export function motivationScore(m: string | null | undefined): number {
  const s = (m ?? '').trim().toLowerCase();
  if (!s) return 0;
  const n = /(\d+(?:\.\d+)?)/.exec(s);
  if (n) return Math.min(10, Number(n[1]));
  if (/\b(hot|high|very|urgent|must|asap|desperate)\b/.test(s)) return 8;
  if (/\b(warm|medium|moderate|some)\b/.test(s)) return 5;
  if (/\b(low|cold|none|not)\b/.test(s)) return 2;
  return 1;
}

const daysAgo = (iso: string | null, now: Date) => (iso ? Math.floor((now.getTime() - Date.parse(iso)) / DAY) : null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Every candidate, in the rules' order. Each record appears once, in its first source. */
export function focusCandidates(input: FocusInput): FocusItem[] {
  const { now, tz } = input;
  const today = dayIn(now, tz);
  const out: FocusItem[] = [];
  const seen = new Set<string>();
  const push = (it: FocusItem) => {
    const k = `${it.record.kind}:${it.record.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(it);
  };

  const tasks = input.tasks.filter((t) => t.due_at && (t.seller_id || t.deal_id))
    .sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!));
  const overdue = tasks.filter((t) => Date.parse(t.due_at!) < now.getTime() && dayIn(new Date(t.due_at!), tz) <= today);
  const dueToday = tasks.filter((t) => Date.parse(t.due_at!) >= now.getTime() && dayIn(new Date(t.due_at!), tz) === today);
  const taskItem = (t: FocusTaskRow, late: boolean): FocusItem => {
    const behind = late ? dayDiff(dayIn(new Date(t.due_at!), tz), today) : 0;
    const when = late ? (behind > 0 ? `${plural(behind, 'day')} overdue` : `overdue since ${clockIn(t.due_at!, tz)}`) : `due ${clockIn(t.due_at!, tz)}`;
    return {
      id: `task:${t.id}`, kind: late ? 'overdue_task' : 'due_task',
      record: t.seller_id ? { kind: 'seller', id: t.seller_id } : { kind: 'deal', id: t.deal_id! },
      title: t.seller_name || t.title,
      detail: `${t.title}, ${when}.`,
      tag: late ? 'Overdue' : clockIn(t.due_at!, tz), tone: late ? 'overdue' : 'due',
    };
  };

  const byKind: Record<FocusKind, FocusItem[]> = { overdue_task: [], appointment: [], new_lead: [], due_task: [], closing: [], cold_lead: [], stale_deal: [] };
  byKind.overdue_task = overdue.map((t) => taskItem(t, true));
  byKind.due_task = dueToday.map((t) => taskItem(t, false));

  byKind.appointment = input.appointments
    .filter((a) => a.seller_id && dayIn(new Date(a.starts_at), tz) === today && Date.parse(a.starts_at) >= now.getTime() - 60 * 60_000)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
    .map((a) => ({
      id: `appointment:${a.id}`, kind: 'appointment' as const, record: { kind: 'seller' as const, id: a.seller_id! },
      title: a.seller_name || a.title,
      detail: `${a.title} at ${clockIn(a.starts_at, tz)}${a.location ? `, ${a.location}` : ''}.`,
      tag: clockIn(a.starts_at, tz), tone: 'due' as const,
    }));

  byKind.new_lead = input.newLeads
    .slice().sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''))
    .map((p) => {
      const h = p.created_at ? Math.max(0, Math.floor((now.getTime() - Date.parse(p.created_at)) / 3_600_000)) : null;
      return {
        id: `new_lead:${p.id}`, kind: 'new_lead' as const, record: { kind: 'seller' as const, id: p.id },
        title: p.name,
        detail: `New lead${p.source ? ` from ${p.source}` : ''}, unassigned${h !== null ? `, in ${h < 1 ? 'the last hour' : plural(h, 'hour') + ' ago'}` : ''}. Nobody has called.${p.property_address ? ` ${p.property_address}.` : ''}`,
        tag: 'New', tone: 'muted' as const,
      };
    });

  byKind.closing = input.closings
    .filter((d) => d.close_date && dayDiff(today, d.close_date.slice(0, 10)) <= CLOSING_DAYS)
    .sort((a, b) => a.close_date!.localeCompare(b.close_date!))
    .map((d) => {
      const n = dayDiff(today, d.close_date!.slice(0, 10));
      const when = n < 0 ? `was due to close ${plural(-n, 'day')} ago` : n === 0 ? 'closes today' : n === 1 ? 'closes tomorrow' : `closes in ${plural(n, 'day')}`;
      return {
        id: `closing:${d.id}`, kind: 'closing' as const, record: { kind: 'deal' as const, id: d.id },
        title: d.address || d.seller_name || `Deal ${d.id}`,
        detail: `${d.stage}, ${when} (${d.close_date!.slice(0, 10)})${d.offer_amount ? `, under contract at ${money(d.offer_amount)}` : ''}.`,
        tag: n < 0 ? 'Past due' : n === 0 ? 'Today' : `${plural(n, 'day')}`, tone: n <= 1 ? 'overdue' : 'money',
      };
    });

  byKind.cold_lead = input.coldLeads
    .filter((p) => {
      const ago = daysAgo(p.last_touch_at ?? p.created_at, now);
      return ago !== null && ago >= COLD_DAYS;
    })
    .sort((a, b) => motivationScore(b.motivation) - motivationScore(a.motivation)
      || Date.parse(a.last_touch_at ?? a.created_at ?? '') - Date.parse(b.last_touch_at ?? b.created_at ?? ''))
    .map((p) => {
      const ago = daysAgo(p.last_touch_at ?? p.created_at, now)!;
      return {
        id: `cold_lead:${p.id}`, kind: 'cold_lead' as const, record: { kind: 'seller' as const, id: p.id },
        title: p.name,
        detail: `${p.lead_stage ?? 'Lead'}, ${p.last_touch_at ? `no touch in ${plural(ago, 'day')}` : `never touched, added ${plural(ago, 'day')} ago`}${p.motivation ? `. Motivation: ${p.motivation.trim().slice(0, 60)}` : ''}.`,
        tag: `${ago}d quiet`, tone: 'muted' as const,
      };
    });

  byKind.stale_deal = input.staleDeals
    .filter((d) => {
      const ago = daysAgo(d.stage_entered_at, now);
      return ago !== null && ago >= STALE_DEAL_DAYS;
    })
    .sort((a, b) => Date.parse(a.stage_entered_at ?? '') - Date.parse(b.stage_entered_at ?? ''))
    .map((d) => {
      const ago = daysAgo(d.stage_entered_at, now)!;
      return {
        id: `stale_deal:${d.id}`, kind: 'stale_deal' as const, record: { kind: 'deal' as const, id: d.id },
        title: d.address || d.seller_name || `Deal ${d.id}`,
        detail: `${d.stage} for ${plural(ago, 'day')} with no buyer${d.offer_amount ? `, under contract at ${money(d.offer_amount)}` : ''}.`,
        tag: `${ago}d, no buyer`, tone: 'money' as const,
      };
    });

  for (const k of ORDER) for (const it of byKind[k]) push(it);
  return out;
}

/**
 * The list Today shows when no model ranks it: the rules' order, at most two
 * of a kind on the first pass so the six are not all one source, topped up
 * from what is left. Between FOCUS_MIN and FOCUS_MAX when there is that much.
 */
export function focusTop(candidates: FocusItem[], max = FOCUS_MAX): FocusItem[] {
  const picked: FocusItem[] = [];
  const count = new Map<FocusKind, number>();
  for (const it of candidates) {
    if (picked.length >= max) break;
    if ((count.get(it.kind) ?? 0) >= PER_KIND) continue;
    picked.push(it);
    count.set(it.kind, (count.get(it.kind) ?? 0) + 1);
  }
  for (const it of candidates) {
    if (picked.length >= max) break;
    if (!picked.includes(it)) picked.push(it);
  }
  // Back in the rules' order, so overdue still reads first.
  return picked.sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
}

/** The numbers in a string, as written ("$185,000" → "185000", "2:30" → "2", "30"). */
const numbersIn = (s: string): string[] => (s.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []);

/**
 * The model's line for an item, or null when it cannot be trusted: empty, too
 * long, or carrying a number the item's own title and detail do not.
 */
export function checkFocusWhy(item: FocusItem, why: unknown): string | null {
  if (typeof why !== 'string') return null;
  const line = why.replace(/\s+/g, ' ').trim();
  if (!line || line.length > 160) return null;
  const own = new Set(numbersIn(`${item.title} ${item.detail} ${item.tag}`));
  return numbersIn(line).every((n) => own.has(n)) ? line : null;
}

export type FocusRank = { greeting?: unknown; items?: unknown };
export type FocusResult = { source: 'ai' | 'rules'; greeting: string; items: (FocusItem & { why: string })[]; total: number };

/** "4 things need you first." — the rules' greeting, facts only. */
export function rulesGreeting(items: FocusItem[], total: number): string {
  if (!items.length) return 'Nothing is pressing. A good day to work the cold list.';
  const overdue = items.filter((i) => i.kind === 'overdue_task').length;
  return `${plural(items.length, 'thing')} to do first${total > items.length ? ` out of ${total}` : ''}${overdue ? `, ${overdue} of them overdue` : ''}.`;
}

/**
 * Apply the model's answer: its order and its lines, for ids it was given,
 * each once; at least FOCUS_MIN and at most FOCUS_MAX, topped up from the
 * rules when it returned fewer. Null when the answer is unusable, so the
 * caller falls back to the rules and says so.
 */
export function applyFocusRank(candidates: FocusItem[], rank: FocusRank): FocusResult | null {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const items: (FocusItem & { why: string })[] = [];
  for (const raw of Array.isArray(rank.items) ? rank.items : []) {
    const r = raw as { id?: unknown; why?: unknown };
    const id = typeof r?.id === 'string' ? r.id : '';
    const it = byId.get(id);
    if (!it || seen.has(id)) continue;
    seen.add(id);
    items.push({ ...it, why: checkFocusWhy(it, r.why) ?? it.detail });
    if (items.length >= FOCUS_MAX) break;
  }
  if (!items.length) return null;
  const floor = Math.min(FOCUS_MIN, candidates.length);
  for (const it of focusTop(candidates)) {
    if (items.length >= floor) break;
    if (!seen.has(it.id)) { seen.add(it.id); items.push({ ...it, why: it.detail }); }
  }
  const g = typeof rank.greeting === 'string' ? rank.greeting.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  // A greeting is held to the same rule: no number the list does not carry.
  const listNumbers = new Set(numbersIn(candidates.map((c) => `${c.title} ${c.detail} ${c.tag}`).join(' ')).concat(String(items.length), String(candidates.length)));
  const greeting = g && numbersIn(g).every((n) => listNumbers.has(n)) ? g : rulesGreeting(items, candidates.length);
  return { source: 'ai', greeting, items, total: candidates.length };
}

export function rulesFocus(candidates: FocusItem[]): FocusResult {
  const items = focusTop(candidates).map((it) => ({ ...it, why: it.detail }));
  return { source: 'rules', greeting: rulesGreeting(items, candidates.length), items, total: candidates.length };
}
