// The ⌘K command bar's grammar: which verb the input starts with, what the
// rest of it names, how records rank against it, and the small parsers the
// rows lean on (a phone number, a due date typed after the name).
//
// Pure: no React, no state, no I/O. The rows themselves are built from these
// in app/app/clozr/command-rows.ts, and tools/command.test.ts runs both.

import { parseDue } from './crm-write';

export type VerbId =
  | 'call' | 'text' | 'email' | 'note' | 'task' | 'appointment'
  | 'newLead' | 'newBuyer' | 'newProperty' | 'newDeal' | 'newVendor'
  | 'assign' | 'underwrite' | 'offer' | 'stage' | 'go' | 'filter' | 'lane' | 'genius' | 'dealMachine' | 'buyr';

/**
 * Whose colour a row carries: the product that does the work (Talkr for a
 * call or a text, COMPR for an underwrite), else CLOZR's own.
 */
export type Mark = 'talkr' | 'compr' | 'lane' | 'genius' | 'dealMachine' | 'buyr' | 'clozr' | 'neutral';

/**
 * What the words after the verb name.
 *   person   a seller (the record in focus when nothing is typed)
 *   contact  a seller or a buyer
 *   name     the new record's name, address or number
 *   screen   a screen, or a record to open
 *   text     free text (the People filter)
 *   none     nothing
 */
export type TargetKind = 'person' | 'contact' | 'name' | 'screen' | 'text' | 'none';

export type Verb = {
  id: VerbId;
  /** How it is typed. The longest phrase that starts the input wins. */
  say: string[];
  /** The row's verb as the bar shows it: "Call", "New lead". */
  label: string;
  /** One line on what it does. */
  hint: string;
  target: TargetKind;
  /** A screen the role must be able to open for the verb to be offered (lib/team.ts). */
  needs: string | null;
  mark: Mark;
};

export const VERBS: Verb[] = [
  { id: 'call', say: ['call', 'dial', 'ring'], label: 'Call', hint: 'Ring them through Talkr', target: 'contact', needs: null, mark: 'talkr' },
  { id: 'text', say: ['text', 'sms'], label: 'Text', hint: 'The text composer on their record', target: 'contact', needs: null, mark: 'talkr' },
  { id: 'email', say: ['email', 'e-mail', 'mail'], label: 'Email', hint: 'The email composer on their record', target: 'person', needs: null, mark: 'clozr' },
  { id: 'note', say: ['note', 'add note'], label: 'Note', hint: 'A note on their record', target: 'person', needs: null, mark: 'neutral' },
  { id: 'task', say: ['task', 'new task', 'add task', 'todo', 'remind'], label: 'Task', hint: "Type a date after the name: 'tomorrow 10am'", target: 'person', needs: null, mark: 'clozr' },
  { id: 'appointment', say: ['appointment', 'new appointment', 'appt'], label: 'Appointment', hint: 'Put it on the calendar', target: 'person', needs: null, mark: 'clozr' },
  { id: 'newLead', say: ['new lead', 'new seller', 'add lead', 'add seller'], label: 'New lead', hint: 'A seller and their property', target: 'name', needs: 'people', mark: 'clozr' },
  { id: 'newBuyer', say: ['new buyer', 'add buyer'], label: 'New buyer', hint: 'Starts matching against dispo inventory', target: 'name', needs: 'buyers', mark: 'genius' },
  { id: 'newProperty', say: ['new property', 'add property'], label: 'New property', hint: 'The property, its seller and a deal', target: 'name', needs: 'people', mark: 'clozr' },
  { id: 'newDeal', say: ['new deal', 'add deal'], label: 'New deal', hint: 'Moves a seller into the pipeline', target: 'person', needs: null, mark: 'clozr' },
  { id: 'newVendor', say: ['new vendor', 'add vendor'], label: 'New vendor', hint: 'Title, contractors, lenders', target: 'name', needs: null, mark: 'neutral' },
  { id: 'assign', say: ['assign', 'reassign'], label: 'Assign', hint: 'Pick a rep next', target: 'person', needs: null, mark: 'neutral' },
  { id: 'underwrite', say: ['underwrite', 'compr', 'comps'], label: 'Underwrite', hint: 'COMPR on the property', target: 'person', needs: 'person', mark: 'compr' },
  { id: 'offer', say: ['send offer', 'make offer', 'offer'], label: 'Send offer', hint: 'The Make offer sheet on their record', target: 'person', needs: 'people', mark: 'clozr' },
  { id: 'stage', say: ['move', 'stage', 'set stage'], label: 'Move', hint: 'Pick a stage next', target: 'person', needs: null, mark: 'neutral' },
  { id: 'go', say: ['go to', 'go', 'open'], label: 'Go to', hint: 'A screen or a record', target: 'screen', needs: null, mark: 'neutral' },
  { id: 'filter', say: ['filter'], label: 'Filter', hint: 'The People list, by what you type', target: 'text', needs: 'people', mark: 'neutral' },
  { id: 'lane', say: ['lane', 'ask lane'], label: 'Lane', hint: 'The TC assistant, on the file · L', target: 'person', needs: null, mark: 'lane' },
  { id: 'genius', say: ['genius', 'genius mode', 'find buyers'], label: 'Genius', hint: 'Every investor buying around any address', target: 'none', needs: 'genius', mark: 'genius' },
  { id: 'dealMachine', say: ['deal machine'], label: 'Deal Machine', hint: 'The scraper: run, pause, its log and finds', target: 'none', needs: 'dealMachine', mark: 'dealMachine' },
  { id: 'buyr', say: ['buyr', 'sniping', 'wholesale sniping', 'homefull'], label: 'Buyr', hint: 'Wholesale sniping and Facebook buyer groups', target: 'none', needs: 'buyr', mark: 'buyr' },
];

/** The verbs a role may use: a verb that leads to a screen the role cannot open is never offered. */
export const allowedVerbs = (can: (screen: string) => boolean, verbs: Verb[] = VERBS): Verb[] =>
  verbs.filter((v) => !v.needs || can(v.needs));

/** Lower case, single spaces, trimmed. */
export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const digitsOf = (s: string) => s.replace(/\D/g, '');

export type Parsed = {
  /** The whole input, normalised. */
  q: string;
  verb: Verb | null;
  /** The verb phrase that matched ("go to"). */
  said: string;
  /** Everything after the verb, as typed (case kept): the target. The whole input when there is no verb. */
  rest: string;
};

/**
 * Split the input into a verb and its target. The verb has to be whole words
 * at the start ("calendar" is not "call"), and the longest phrase wins, so
 * "go to reports" is Go to + "reports", not Go + "to reports".
 */
export function parseCommand(raw: string, verbs: Verb[] = VERBS): Parsed {
  const q = norm(raw);
  let best: { verb: Verb; phrase: string } | null = null;
  for (const verb of verbs) {
    for (const phrase of verb.say) {
      if ((q === phrase || q.startsWith(phrase + ' ')) && (!best || phrase.length > best.phrase.length)) best = { verb, phrase };
    }
  }
  if (!best) return { q, verb: null, said: '', rest: raw.trim() };
  const n = best.phrase.split(' ').length;
  return { q, verb: best.verb, said: best.phrase, rest: raw.trim().split(/\s+/).slice(n).join(' ') };
}

/**
 * Verbs the input is the start of ("ta" → Task, "new" → every New …), for
 * completing a half-typed verb. Two letters at least, and never the verb
 * already typed in full.
 */
export function verbCompletions(raw: string, verbs: Verb[] = VERBS): { verb: Verb; phrase: string }[] {
  const q = norm(raw);
  if (q.length < 2) return [];
  const out: { verb: Verb; phrase: string }[] = [];
  for (const verb of verbs) {
    const phrase = verb.say.find((p) => p.startsWith(q) && p !== q);
    if (phrase && !verb.say.includes(q)) out.push({ verb, phrase });
  }
  return out;
}

/** The query's words. Punctuation that is not part of a number or an address goes. */
export const wordsOf = (q: string) => norm(q).split(' ').map((w) => w.replace(/^[,.;:!?'"]+|[,.;:!?'"]+$/g, '')).filter(Boolean);

/**
 * Every word must match somewhere in `find`. A word with digits in it also
 * matches as bare digits, so "210-555" finds (210) 555-0136 when the find
 * string carries the digits-only phone.
 */
export function matches(q: string, find: string): boolean {
  const f = find.toLowerCase();
  const ws = wordsOf(q);
  if (!ws.length) return false;
  return ws.every((w) => f.includes(w) || (/\d/.test(w) && digitsOf(w).length >= 3 && f.includes(digitsOf(w))));
}

/**
 * How well a record matches, for ranking: 4 its name exactly, 3 its name
 * starts with the query, 2 every word starts a word somewhere, 1 every word
 * is somewhere inside, 0 no match.
 */
export function matchTier(q: string, name: string, find: string): number {
  const nq = norm(q);
  if (!nq || !matches(q, name + ' ' + find)) return 0;
  const nn = norm(name);
  if (nn === nq) return 4;
  if (nn.startsWith(nq)) return 3;
  const starts = (norm(name + ' ' + find).match(/[a-z0-9]+/g) ?? []);
  if (wordsOf(q).every((w) => starts.some((s) => s.startsWith(w.replace(/[^a-z0-9]/g, '')) && w.replace(/[^a-z0-9]/g, '') !== ''))) return 2;
  return 1;
}

/**
 * The records that match, best first: exact name, then starts-with, then a
 * word start, then anywhere. Ties go to the more recently opened record, then
 * to the list's own order.
 */
export function rankRecords<T>(items: T[], q: string, key: (t: T) => { name: string; find: string; recent?: number }): T[] {
  return items
    .map((item, i) => {
      const k = key(item);
      return { item, i, tier: matchTier(q, k.name, k.find), recent: k.recent ?? Infinity };
    })
    .filter((x) => x.tier > 0)
    .sort((a, b) => b.tier - a.tier || a.recent - b.recent || a.i - b.i)
    .map((x) => x.item);
}

/** "person:p1" → { kind: 'person', id: 'p1' }. */
export function parseRecent(key: string): { kind: 'person' | 'buyer'; id: string } | null {
  const m = /^(person|buyer):(.+)$/.exec(key);
  return m ? { kind: m[1] as 'person' | 'buyer', id: m[2]! } : null;
}

/**
 * A US phone number typed on its own: ten digits, or eleven with the leading
 * 1, in any of the usual punctuations. Null for anything else, including a
 * number with a name in front of it.
 */
export function phoneQuery(raw: string): { digits: string; display: string } | null {
  const t = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(t)) return null;
  let d = digitsOf(t);
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return null;
  return { digits: d, display: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` };
}

// ---- a due date after the name ------------------------------------------------

const MONTH = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)$/;
const WEEKDAY = /^(sun(day)?|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?)$/;
/** Words that name a moment by themselves. */
const ANCHOR = (w: string) => /^(today|tomorrow|now|asap)$/.test(w) || WEEKDAY.test(w)
  || /^\d{1,2}(:\d{2})?(am|pm)$/.test(w) || /^\d{1,2}:\d{2}$/.test(w)
  || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(w) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(w);
/** Words that belong to a date but say nothing alone. */
const FILLER = (w: string) => MONTH.test(w) || /^\d{1,4}$/.test(w) || /^(am|pm|at|@|on|by|due|in|days?|weeks?|hours?)$/.test(w);
const CONNECTOR = /^(at|@|on|by|due)$/;

/**
 * Take a due date off the end of what was typed after a verb:
 * "kara tomorrow 10am" → target "kara", due tomorrow at 10:00. The date is
 * the longest run of date words at the end that `parseDue` (the Quick Add
 * form's own parser) reads; a run that is only a number or a month is not a
 * date, so "44 benton court" keeps its 44.
 */
export function splitDue(rest: string, now: Date): { target: string; due: string | null; dueText: string } {
  const raw = rest.trim().split(/\s+/).filter(Boolean);
  const low = raw.map((w) => w.toLowerCase().replace(/,$/, ''));
  let start = low.length;
  while (start > 0 && (ANCHOR(low[start - 1]!) || FILLER(low[start - 1]!))) start--;
  for (let i = start; i < low.length; i++) {
    const run = low.slice(i);
    const anchored = run.some(ANCHOR)
      || (run.some((w) => MONTH.test(w)) && run.some((w) => /^\d{1,2}$/.test(w)))
      || /\bin \d+ (day|week|hour)s?\b/.test(run.join(' '));
    if (!anchored) break;
    const text = run.filter((w) => !CONNECTOR.test(w)).join(' ');
    const due = parseDue(text, now);
    if (due) return { target: raw.slice(0, i).join(' '), due, dueText: raw.slice(i).join(' ') };
  }
  return { target: rest.trim(), due: null, dueText: '' };
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Whole days from `now`'s date to `d`'s date. */
export const daysFrom = (d: Date, now: Date) => Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000);
const timeLabel = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dateLabel = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** "Thu, Sep 24, 10:00 AM" — what the row says a due date is. */
export const dueLabel = (iso: string) => {
  const d = new Date(iso);
  return dateLabel(d) + ', ' + timeLabel(d);
};

/**
 * The due date as the task dialog's Due field takes it: "Today 3:00 PM" for
 * today (so the demo files it under today), else "Thu, Sep 24, 10:00 AM".
 * Either reads back through `parseDue` to the same moment.
 */
export const dueField = (iso: string, now: Date) => {
  const d = new Date(iso);
  return daysFrom(d, now) === 0 ? 'Today ' + timeLabel(d) : dueLabel(iso);
};

/**
 * The appointment dialog's Day and Time: its day picker lists the next
 * fortnight as "Today", "Tomorrow", then "Fri, Sep 25", so a later date
 * leaves the day for the rep to pick.
 */
export function apptFields(iso: string, now: Date): { day?: string; time: string } {
  const d = new Date(iso);
  const n = daysFrom(d, now);
  const day = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 && n < 14 ? dateLabel(d) : undefined;
  return { ...(day ? { day } : {}), time: timeLabel(d) };
}

// ---- screens ----------------------------------------------------------------------

export type ScreenDef = { key: string; label: string; say: string[]; hint: string; mark: Mark };

/** Where "go …" can take you. Only the ones the role can open are offered. */
export const SCREENS: ScreenDef[] = [
  { key: 'today', label: 'Today', say: ['today', 'call list', 'queue'], hint: 'Your list to call', mark: 'neutral' },
  { key: 'home', label: 'Home', say: ['home', 'dashboard'], hint: 'Priority queue, inbound, closings', mark: 'neutral' },
  { key: 'people', label: 'People', say: ['people', 'sellers', 'leads', 'contacts'], hint: 'Smart lists and the record table', mark: 'neutral' },
  { key: 'inbox', label: 'Inbox', say: ['inbox', 'messages', 'threads'], hint: 'Texts and email, one place', mark: 'neutral' },
  { key: 'dialer', label: 'Dialer', say: ['dialer', 'phone', 'talkr', 'calls'], hint: 'Talkr: queue, recents, voicemail', mark: 'talkr' },
  { key: 'tasks', label: 'Tasks', say: ['tasks', 'todos', 'to do'], hint: 'Today, upcoming, overdue', mark: 'neutral' },
  { key: 'calendar', label: 'Calendar', say: ['calendar', 'appointments', 'schedule'], hint: 'The week', mark: 'neutral' },
  { key: 'deals', label: 'Deals', say: ['deals', 'pipeline'], hint: 'The pipeline', mark: 'neutral' },
  { key: 'contracts', label: 'Contracts', say: ['contracts', 'contract', 'psa', 'agreements', 'documents'], hint: 'Purchase and assignment agreements', mark: 'neutral' },
  { key: 'tc', label: 'Transaction coordination', say: ['tc', 'transaction', 'closing file', 'title file'], hint: 'The closing files, furthest along first', mark: 'neutral' },
  { key: 'dispo', label: 'Dispo', say: ['dispo', 'dispositions', 'inventory'], hint: 'Inventory to market', mark: 'neutral' },
  { key: 'buyers', label: 'Buyers', say: ['buyers', 'cash buyers'], hint: 'The buyer database', mark: 'genius' },
  { key: 'reporting', label: 'Reporting', say: ['reporting', 'reports', 'report', 'kpis', 'stats'], hint: 'Executive overview', mark: 'neutral' },
  { key: 'coaching', label: 'Coaching', say: ['coaching', 'coach', 'scorecard', 'roleplay', 'graded calls'], hint: 'Graded calls, scorecard and roleplay', mark: 'neutral' },
  { key: 'leaderboard', label: 'Sales leaderboard', say: ['leaderboard', 'tv', 'scoreboard'], hint: 'The office TV board', mark: 'neutral' },
  { key: 'automations', label: 'Automations', say: ['automations', 'sequences', 'triggers'], hint: 'Sequences and triggers', mark: 'neutral' },
  { key: 'plans', label: 'Action plans', say: ['action plans', 'plans', 'drips'], hint: 'Follow-up plans', mark: 'neutral' },
  { key: 'import', label: 'Import', say: ['import', 'upload', 'csv'], hint: 'Sellers, buyers or vendors from a file', mark: 'neutral' },
  { key: 'liveLists', label: 'Live database', say: ['live database', 'database', 'vendors', 'lists'], hint: 'Buyers, vendors and sellers', mark: 'neutral' },
  { key: 'genius', label: 'Genius', say: ['genius', 'genius mode'], hint: 'Every investor buying around any address', mark: 'genius' },
  { key: 'dealMachine', label: 'Deal Machine', say: ['deal machine', 'scraper'], hint: 'The scraper: run, pause, its log and finds', mark: 'dealMachine' },
  { key: 'buyr', label: 'Buyr', say: ['buyr', 'sniping', 'wholesale sniping', 'homefull'], hint: 'Wholesale sniping and Facebook buyer groups', mark: 'buyr' },
  { key: 'settings', label: 'Settings', say: ['settings', 'preferences'], hint: 'Workspace and your own', mark: 'neutral' },
  { key: 'account', label: 'Account', say: ['account', 'profile'], hint: 'You', mark: 'neutral' },
];

/** The screens a role can open that match what was typed, best first. Everything the role can open when nothing is typed. */
export function matchScreens(q: string, can: (screen: string) => boolean): ScreenDef[] {
  const open = SCREENS.filter((s) => can(s.key));
  if (!norm(q)) return open;
  return rankRecords(open, q, (s) => ({ name: s.label, find: s.say.join(' ') }));
}
