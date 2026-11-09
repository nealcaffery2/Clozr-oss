// The Inbox's folders, labels and thread filter (screens/Inbox.tsx AllList),
// the way SmarterContact's messenger files threads: a rail of folders on the
// left (All, Unread, Missed calls, Unreplied, Awaiting reply, Opted out,
// Archived), label chips on each row, and one Filter dialog whose settings
// can be saved under a name and land in the rail.
//
// Pure, so the rules are testable without Talkr or the DOM
// (`npx tsx tools/inbox-folders.test.ts`).

export type Folder = 'all' | 'unread' | 'missed' | 'unreplied' | 'awaiting' | 'scheduled' | 'optout' | 'archived';

export const FOLDERS: { id: Folder; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'Every text, email and call on this inbox' },
  { id: 'unread', label: 'Unread', hint: 'Nothing opened since the last message' },
  { id: 'missed', label: 'Missed calls', hint: 'Calls that rang out, voicemail included' },
  { id: 'unreplied', label: 'Unreplied', hint: 'They wrote last' },
  { id: 'awaiting', label: 'Awaiting reply', hint: 'We wrote last in a conversation they have answered before' },
  { id: 'scheduled', label: 'Scheduled', hint: 'A text is written and waits for its send time' },
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
  /** Nothing to answer: labelled Not interested or Wrong number, or an automated sender (a bounce). */
  closed?: boolean;
  /** Cleared by the rep and nothing newer since. */
  archived: boolean;
  /** A text to this thread waits in scheduled_messages (migration 367). */
  scheduled?: boolean;
  /** Only we have written (a blast or cold text they never answered): not awaiting a reply. */
  cold?: boolean;
};

/** The channel tabs a folder means something on. Missed is calls; Unreplied, Awaiting, Scheduled and Opted out are conversations. */
export const FOLDER_KINDS: Record<Folder, readonly FolderItem['kind'][]> = {
  all: ['sms', 'email', 'call'], unread: ['sms', 'email'], missed: ['call'], unreplied: ['sms', 'email'], awaiting: ['sms', 'email'],
  scheduled: ['sms', 'email'], optout: ['sms'], archived: ['sms', 'email', 'call'],
};

/** The rail's folders on one channel tab (every folder on All). */
export function foldersFor(kind: FolderItem['kind'] | null): typeof FOLDERS {
  return kind ? FOLDERS.filter((f) => FOLDER_KINDS[f.id].includes(kind)) : FOLDERS;
}

export function inFolder(i: FolderItem, f: Folder): boolean {
  if (f === 'archived') return i.archived;
  if (i.archived) return false;
  switch (f) {
    case 'all': return true;
    // Opted out and closed threads ask nothing of the rep: they stay on All and Opted out, off the work folders.
    case 'unread': return i.unread && !i.optedOut;
    case 'missed': return i.missed;
    case 'unreplied': return i.kind !== 'call' && i.theyLast && !i.optedOut && !i.closed;
    // Outreach nobody answered is not a conversation waiting on them: after a 450-text blast it buried every real one.
    case 'awaiting': return i.kind !== 'call' && !i.theyLast && !i.optedOut && !i.closed && !i.cold;
    case 'scheduled': return !!i.scheduled;
    case 'optout': return i.optedOut;
  }
}

/** How many threads each folder holds; on a channel tab (`kind`), only that channel's threads and folders count. */
export function folderCounts(items: readonly FolderItem[], kind: FolderItem['kind'] | null = null): Record<Folder, number> {
  const n = { all: 0, unread: 0, missed: 0, unreplied: 0, awaiting: 0, scheduled: 0, optout: 0, archived: 0 };
  const folders = foldersFor(kind);
  for (const i of items) if (!kind || i.kind === kind) for (const f of folders) if (inFolder(i, f.id)) n[f.id]++;
  return n;
}

/** Whether a Talkr contact, by its status, tags or a bare STOP as their last text, has asked not to be contacted. */
export function optedOutOf(status: string | null | undefined, tags: readonly string[] | null | undefined, lastTheirs?: string | null): boolean {
  if (status === 'dnc' || status === 'opted_out' || status === 'unsubscribed') return true;
  if (lastTheirs && /^\W*(stop|stop all|unsubscribe|cancel|end|quit|remove me|opt.?out)\W*$/i.test(lastTheirs.trim())) return true;
  return (tags ?? []).some((t) => /\b(opt.?out|opted.?out|dnc|do.?not.?(contact|text|call)|stop)\b/i.test(t));
}

type QuietConv = { unread_count: number; contact_status?: string | null; tags?: string[] | null; last_message?: { direction: string; body: string | null } | null };

/**
 * A thread whose contact opted out (STOP as their last text, or DNC) asks
 * nothing of anyone: no unread dot, no count. Every Talkr thread list goes
 * through this (lib/talkr-web/api listConversations), so the All and SMS
 * tabs, the folder counts and the nav badge agree.
 */
export function quietOptOuts<C extends QuietConv, L extends { conversations: C[]; counts?: { unread: number } }>(list: L): L {
  let quieted = 0;
  const conversations = list.conversations.map((c) => {
    if (!c.unread_count) return c;
    const theirs = c.last_message?.direction === 'inbound' ? c.last_message.body : null;
    // A STOP Talkr already answered ("You have been unsubscribed") asks nothing either.
    const ours = c.last_message?.direction === 'outbound' ? c.last_message.body : null;
    if (!optedOutOf(c.contact_status, c.tags, theirs) && !leftCampaign(ours)) return c;
    quieted++;
    return { ...c, unread_count: 0 };
  });
  if (!quieted) return list;
  return { ...list, conversations, ...(list.counts ? { counts: { ...list.counts, unread: Math.max(0, list.counts.unread - quieted) } } : {}) };
}

/**
 * Talkr's "You have been unsubscribed" as our last text: they left that one
 * campaign. Not an opt-out from us (Sam, 2026-10-23), but nothing to
 * answer either, so the thread is closed: off Unreplied and Awaiting reply.
 */
export const leftCampaign = (lastOurs: string | null | undefined) => !!lastOurs && /^\W*you (have been|are now|are) unsubscribed\b/i.test(lastOurs.trim());

// ---- Labels ----------------------------------------------------------------

/** The fixed set a rep can put on a thread, in the order the menu lists them. */
export const DISPOSITIONS = ['Lead', 'Follow up', 'Offer made', 'High price', 'Not interested', 'Wrong number', 'Push to record'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** A tinted fill and the dark text that reads on it. Every chip also carries its word. */
export const DISPOSITION_TONE: Record<Disposition, { bg: string; fg: string }> = {
  'Lead': { bg: 'var(--c-action-soft, #e7f5ef)', fg: 'var(--tx-mint, #0a8560)' },
  'Follow up': { bg: 'var(--caution-soft, #fef3c7)', fg: 'var(--tx-amber, #b45309)' },
  'Offer made': { bg: 'var(--tint-sky, #e0f2fe)', fg: 'var(--tx-sky, #0369a1)' },
  'High price': { bg: 'var(--tint-orange-2, #ffedd5)', fg: 'var(--tx-orange, #c2410c)' },
  'Not interested': { bg: 'var(--surface-2, #f4f4f5)', fg: 'var(--muted, #52525b)' },
  'Wrong number': { bg: 'var(--negative-soft, #fee2e2)', fg: 'var(--tx-red, #b91c1c)' },
  'Push to record': { bg: 'var(--tint-violet, #ede9fe)', fg: 'var(--tx-violet, #6d28d9)' },
};

/** Labels that close a thread: no reply is owed. */
export const CLOSING_LABELS: readonly Disposition[] = ['Not interested', 'Wrong number'];
export const closedBy = (labels: readonly string[] | null | undefined) => (labels ?? []).some((l) => (CLOSING_LABELS as readonly string[]).includes(l));
/** Mail no person sent: bounces, no-reply and notification senders, and e-sign envelopes (dse_na4@docusign.net sat on Unreplied, 2026-10-23). */
export const automatedSender = (address: string | null | undefined) => {
  const a = String(address ?? '').trim();
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?|bounces?)[@+.]/i.test(a)
    || /@([\w-]+\.)*(docusign\.net|pandadoc\.net|hellosign\.com|echosign\.com|dotloop\.com)$/i.test(a);
};

/** A last text that only acknowledges ("No problem", "ok", "thanks"): nothing owed back, so off Unreplied. */
export const ackOnly = (text: string | null | undefined) =>
  /^\W*(no problem|no prob|np|ok(ay)?|k+|thanks?( you)?|thx|ty|sounds good|will do|got it|cool|perfect|great|you too|👍)[\s!.\p{Extended_Pictographic}]*$/iu.test(String(text ?? '').trim());

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
  /** A deal id (as text, '' for any): only people a blast about that deal reached (lib/inbox-blast-tags). */
  deal: string;
};

export const EMPTY_FILTER: InboxFilter = { include: [], includeMode: 'any', exclude: [], from: '', to: '', areaCode: '', tag: '', owner: '', channel: '', deal: '' };

/** A saved filter from before a part existed (deal, 2026-10-30) reads as that part unset. */
export const withDefaults = (f: Partial<InboxFilter> | null | undefined): InboxFilter => ({ ...EMPTY_FILTER, ...(f ?? {}) });

/** How many of the filter's parts are set, for the button's count. */
export function filterCount(f: InboxFilter): number {
  return (f.include.length ? 1 : 0) + (f.exclude.length ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.areaCode ? 1 : 0) + (f.tag ? 1 : 0) + (f.owner ? 1 : 0) + (f.channel ? 1 : 0) + (f.deal ? 1 : 0);
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
  /** The deals a blast about which reached them, by id. */
  deals?: readonly number[];
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
  if (f.deal && !(i.deals ?? []).includes(Number(f.deal))) return false;
  return true;
}

/** A saved filter: the dialog's settings under a name, in the rail. */
export type SavedFilter = { id: string; name: string; filter: InboxFilter };
