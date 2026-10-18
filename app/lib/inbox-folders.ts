// The Inbox's folders, labels and thread filter (screens/Inbox.tsx AllList),
// the way SmarterContact's messenger files threads: a rail of folders on the
// left (All, Unread, Missed calls, Unreplied, Awaiting reply, Opted out,
// Archived), label chips on each row, and one Filter dialog whose settings
// can be saved under a name and land in the rail.
//
// Pure, so the rules are testable without Talkr or the DOM
// (`npx tsx tools/inbox-folders.test.ts`).

export type Folder = 'all' | 'unread' | 'missed' | 'unreplied' | 'awaiting' | 'optout' | 'archived';

export const FOLDERS: { id: Folder; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'Every text, email and call on this inbox' },
  { id: 'unread', label: 'Unread', hint: 'Nothing opened since the last message' },
  { id: 'missed', label: 'Missed calls', hint: 'Calls that rang out, voicemail included' },
  { id: 'unreplied', label: 'Unreplied', hint: 'They wrote last' },
  { id: 'awaiting', label: 'Awaiting reply', hint: 'We wrote last' },
  { id: 'optout', label: 'Opted out', hint: 'Do not contact: texted STOP or marked DNC' },
  { id: 'archived', label: 'Archived', hint: 'Closed threads. A new message brings one back' },
];

/** What a folder needs to know about a thread. */
export type FolderItem = {
  kind: 'sms' | 'email' | 'call';
  unread: boolean;
  /** A call that rang out (voicemail counts). */
  missed: boolean;
  /** The last message or call came from them. */
  theyLast: boolean;
  optedOut: boolean;
  /** Cleared by the rep and nothing newer since. */
  archived: boolean;
};

export function inFolder(i: FolderItem, f: Folder): boolean {
  if (f === 'archived') return i.archived;
  if (i.archived) return false;
  switch (f) {
    case 'all': return true;
    case 'unread': return i.unread;
    case 'missed': return i.missed;
    case 'unreplied': return i.kind !== 'call' && i.theyLast;
    case 'awaiting': return i.kind !== 'call' && !i.theyLast;
    case 'optout': return i.optedOut;
  }
}

/** How many threads each folder holds. */
export function folderCounts(items: readonly FolderItem[]): Record<Folder, number> {
  const n = { all: 0, unread: 0, missed: 0, unreplied: 0, awaiting: 0, optout: 0, archived: 0 };
  for (const i of items) for (const f of FOLDERS) if (inFolder(i, f.id)) n[f.id]++;
  return n;
}

/** Whether a Talkr contact, by its status and tags, has asked not to be contacted. */
export function optedOutOf(status: string | null | undefined, tags: readonly string[] | null | undefined): boolean {
  if (status === 'dnc') return true;
  return (tags ?? []).some((t) => /\b(opt.?out|opted.?out|dnc|do.?not.?(contact|text|call)|stop)\b/i.test(t));
}

// ---- Labels ----------------------------------------------------------------

/** The fixed set a rep can put on a thread, in the order the menu lists them. */
export const DISPOSITIONS = ['Lead', 'Follow up', 'Offer made', 'High price', 'Not interested', 'Wrong number', 'Push to record'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** A tinted fill and the dark text that reads on it. Every chip also carries its word. */
export const DISPOSITION_TONE: Record<Disposition, { bg: string; fg: string }> = {
  'Lead': { bg: '#E7F5EF', fg: '#0A8560' },
  'Follow up': { bg: '#fef3c7', fg: '#b45309' },
  'Offer made': { bg: '#e0f2fe', fg: '#0369a1' },
  'High price': { bg: '#ffedd5', fg: '#c2410c' },
  'Not interested': { bg: '#f4f4f5', fg: '#52525b' },
  'Wrong number': { bg: '#fee2e2', fg: '#b91c1c' },
  'Push to record': { bg: '#ede9fe', fg: '#6d28d9' },
};

export const isDisposition = (s: string): s is Disposition => (DISPOSITIONS as readonly string[]).includes(s);

/**
 * The label the last text from them suggests, from plain keywords. Shown as a
 * ghost chip the rep accepts with one click; never written on its own.
 * Checked in order: an opt-out or a wrong number beats a price question.
 */
export function suggestLabel(text: string | null | undefined): Disposition | null {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (/\b(wrong (number|person|#)|who is this|who'?s this|don'?t know (you|who)|never (contacted|heard))\b/.test(t)) return 'Wrong number';
  if (/\b(stop|unsubscribe|remove me|take me off|don'?t (text|contact|message|call) me|quit texting|leave me alone|not interested|no thanks|not selling|not for sale|no longer (own|have))\b/.test(t)) return 'Not interested';
  if (/\b(too low|low.?ball|at least|no less than|more than that|not enough|insult|worth (way )?more|wouldn'?t take less|want(ing)? \$?\d)/.test(t)) return 'High price';
  if (/\b(how much|what('?s| is| would be) (your|the) offer|cash offer|what (would|can|do) you (pay|offer|give)|make (me )?an offer|send (me )?(the |an )?offer|what are you offering|ballpark)\b/.test(t)) return 'Lead';
  if (/\b(call me|text me|tomorrow|next (week|month|year)|later|busy|not (right )?now|in a (few|couple)|after the|when (can|could|would|do)|give me (a|some) time|let me think|thinking (it|about))\b/.test(t)) return 'Follow up';
  return null;
}

// ---- Filter ----------------------------------------------------------------

export type Channel = 'sms' | 'email' | 'call';

export type InboxFilter = {
  /** Labels a thread must carry (any of them, or all of them). */
  include: string[];
  includeMode: 'any' | 'all';
  /** Labels a thread must not carry. */
  exclude: string[];
  /** Last response (their last message) on or after / before these days, YYYY-MM-DD. */
  from: string;
  to: string;
  /** Three digits of their number. */
  areaCode: string;
  /** A Talkr tag (campaigns tag the contacts they reach). */
  tag: string;
  /** The rep a Talkr thread or call is assigned to, by name. */
  owner: string;
  channel: '' | Channel;
};

export const EMPTY_FILTER: InboxFilter = { include: [], includeMode: 'any', exclude: [], from: '', to: '', areaCode: '', tag: '', owner: '', channel: '' };

/** How many of the filter's parts are set, for the button's count. */
export function filterCount(f: InboxFilter): number {
  return (f.include.length ? 1 : 0) + (f.exclude.length ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.areaCode ? 1 : 0) + (f.tag ? 1 : 0) + (f.owner ? 1 : 0) + (f.channel ? 1 : 0);
}

/** What the filter reads off a thread. */
export type FilterItem = {
  kind: Channel;
  /** Every label on the row: dispositions, the stage, the heat word. */
  labels: readonly string[];
  /** When they last wrote or called, ISO; empty when they never did. */
  lastTheirsAt: string;
  phone: string | null;
  tags: readonly string[];
  owner: string | null;
};

const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());
export const areaCodeOf = (phone: string | null | undefined): string => {
  const d = String(phone ?? '').replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? ten.slice(0, 3) : '';
};

export function matchesFilter(i: FilterItem, f: InboxFilter): boolean {
  const have = lower(i.labels);
  if (f.include.length) {
    const want = lower(f.include);
    const ok = f.includeMode === 'all' ? want.every((w) => have.includes(w)) : want.some((w) => have.includes(w));
    if (!ok) return false;
  }
  if (f.exclude.length && lower(f.exclude).some((w) => have.includes(w))) return false;
  if (f.from || f.to) {
    const day = i.lastTheirsAt ? i.lastTheirsAt.slice(0, 10) : '';
    if (!day) return false;
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
  }
  if (f.areaCode && areaCodeOf(i.phone) !== f.areaCode.replace(/\D/g, '').slice(0, 3)) return false;
  if (f.tag && !lower(i.tags).includes(f.tag.toLowerCase())) return false;
  if (f.owner && (i.owner ?? '').toLowerCase() !== f.owner.toLowerCase()) return false;
  if (f.channel && i.kind !== f.channel) return false;
  return true;
}

/** A saved filter: the dialog's settings under a name, in the rail. */
export type SavedFilter = { id: string; name: string; filter: InboxFilter };
