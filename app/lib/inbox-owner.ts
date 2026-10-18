// Whose inbox a text thread or a call belongs to.
//
// Talkr hands an owner or admin the whole office's threads and calls in one
// list, so the Inbox read as everyone's texts mixed together. The Inbox now
// opens on the signed-in rep's own conversations and can switch to one
// teammate at a time (never everyone at once). The record's Activity feed is
// where the office's messages with one contact sit together, every rep's.
//
// A thread is the rep's whose line carries it: the seller texted that number.
// A thread on a line nobody owns (a shared or main line) belongs to the rep
// it is assigned to, and with no assignee it sits under "Unassigned lines".
// A call is the rep's who handled it; one nobody picked up (a missed call, a
// voicemail) is the owner's of the line it rang.
//
// Pure, so the rules are testable without Talkr (`npx tsx tools/inbox-owner.test.ts`).

/** `me`, a teammate's Talkr user id, the shared lines nobody owns, or everyone's. */
export type InboxOwner = string;
export const UNASSIGNED = 'unassigned';
/** The whole office's threads and calls in one list, each message marked with who sent it. */
export const EVERYONE = 'all';

export type OrgLine = { id: string; phone_e164: string; assigned_user_id: string | null; label?: string | null };
export type OwnedThread = { our_number: string; assigned_user_id: string | null };
export type OwnedCall = {
  direction: 'inbound' | 'outbound'; user_id: string | null; from_number: string; to_number: string;
};

const ten = (p: string | null | undefined) => String(p ?? '').replace(/\D/g, '').slice(-10);

/** Every org line by its last ten digits: who owns it (null: a shared line). */
export function lineOwners(lines: readonly OrgLine[] | null | undefined): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const l of lines ?? []) { const k = ten(l.phone_e164); if (k) m.set(k, l.assigned_user_id ?? null); }
  return m;
}

/** The rep a thread belongs to, or null when it is on a shared line and assigned to nobody. */
export function threadOwner(c: OwnedThread, owners: Map<string, string | null>): string | null {
  const line = owners.get(ten(c.our_number));
  if (line) return line;
  return c.assigned_user_id ?? null;
}

/** The rep a call belongs to: who handled it, else the owner of the line on our side. */
export function callOwner(h: OwnedCall, owners: Map<string, string | null>): string | null {
  if (h.user_id) return h.user_id;
  const ours = h.direction === 'inbound' ? h.to_number : h.from_number;
  return owners.get(ten(ours)) ?? null;
}

/** `owner` resolved: `me` is the signed-in rep's Talkr id. */
export function resolveOwner(owner: InboxOwner, me: string | null): string | null {
  return owner === 'me' ? me : owner;
}

/** Whether a thread or call whose owner is `who` belongs in the inbox being viewed. */
export function inInbox(who: string | null, owner: InboxOwner, me: string | null): boolean {
  if (owner === EVERYONE) return true;
  if (owner === UNASSIGNED) return who === null;
  const id = resolveOwner(owner, me);
  return !!id && who === id;
}

/** The org lines an inbox reads by number: the owner's own, the shared ones, or every line. */
export function linesFor(owner: InboxOwner, me: string | null, lines: readonly OrgLine[] | null | undefined): OrgLine[] {
  if (owner === EVERYONE) return [...(lines ?? [])];
  const id = owner === UNASSIGNED ? null : resolveOwner(owner, me);
  if (owner !== UNASSIGNED && !id) return [];
  return (lines ?? []).filter((l) => (l.assigned_user_id ?? null) === id);
}

/** The text events that can start a thread: an inbound text, or a send that opened one. */
const NEW_THREAD_EVENTS = new Set(['message.received', 'conversation.updated']);

/**
 * Whether a Talkr stream event can change the inbox being viewed: it names the
 * owner, one of the owner's lines, or a thread already on screen. An event that
 * names none of these (a teammate's dial) is not a reason to re-read.
 *
 * Talkr's text events name only the thread and the message
 * (`{ conversationId, messageId }`): no rep, no number. When `type` says the
 * event can start a thread and the thread it names is not on screen, it may be
 * this inbox's newest one, so it re-reads; the read keeps only threads that are
 * the owner's.
 */
export function eventTouches(
  facts: { userIds: string[]; numbers: string[]; conversationId: string | null },
  owner: InboxOwner, me: string | null, ownedLines: readonly OrgLine[], onScreen: ReadonlySet<string>,
  type?: string,
): boolean {
  if (owner === EVERYONE) return true;
  const id = owner === UNASSIGNED ? null : resolveOwner(owner, me);
  if (id && facts.userIds.includes(id)) return true;
  if (facts.conversationId && onScreen.has(facts.conversationId)) return true;
  const mine = new Set(ownedLines.map((l) => ten(l.phone_e164)));
  if (facts.numbers.some((n) => mine.has(n))) return true;
  const placed = facts.userIds.length > 0 || facts.numbers.length > 0;
  return !!type && NEW_THREAD_EVENTS.has(type) && !!facts.conversationId && !placed;
}

export type OwnerChoice = { value: InboxOwner; label: string };

/**
 * The switcher's options: my inbox first, then each teammate by name, then the
 * shared lines when the org has any, then everyone's together. The mixed list
 * is readable now that every outbound bubble names its sender and line.
 */
export function ownerChoices(
  me: string | null, team: readonly { id: string; display_name: string; is_self?: boolean }[], lines: readonly OrgLine[] | null | undefined,
): OwnerChoice[] {
  const others = team
    .filter((m) => m.id !== me && !m.is_self)
    .map((m) => ({ value: m.id, label: m.display_name || 'Teammate' }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const shared = (lines ?? []).some((l) => !l.assigned_user_id);
  return [
    { value: 'me', label: 'My inbox' },
    ...others,
    ...(shared ? [{ value: UNASSIGNED, label: 'Unassigned lines' }] : []),
    ...(others.length || shared ? [{ value: EVERYONE, label: 'Everyone' }] : []),
  ];
}

/** "Diego Ortiz’s inbox", for headings and the reply note. */
export function ownerTitle(owner: InboxOwner, choices: readonly OwnerChoice[]): string {
  if (owner === 'me') return 'My inbox';
  if (owner === UNASSIGNED) return 'Unassigned lines';
  if (owner === EVERYONE) return 'Everyone';
  const c = choices.find((x) => x.value === owner);
  return c ? `${c.label}’s inbox` : 'A teammate’s inbox';
}

type Sortable = { id: string; last_message_at: string | null; unread_count: number; temperature_score?: number | null };

/**
 * Threads read through several queries (one per line, one by assignee), as
 * one list: each thread once, kept only when it is the owner's, in the order
 * the inbox asked for.
 */
export function mergeOwnerThreads<T extends Sortable & OwnedThread>(
  lists: readonly (readonly T[])[], owner: InboxOwner, me: string | null, owners: Map<string, string | null>,
  sort: 'recent' | 'oldest' | 'unread' | 'temperature' = 'recent',
): T[] {
  const by = new Map<string, T>();
  for (const list of lists) for (const c of list) if (!by.has(c.id)) by.set(c.id, c);
  const at = (c: T) => Date.parse(c.last_message_at ?? '') || 0;
  const out = [...by.values()].filter((c) => inInbox(threadOwner(c, owners), owner, me));
  return out.sort((a, b) => {
    if (sort === 'oldest') return at(a) - at(b);
    if (sort === 'unread') return (b.unread_count > 0 ? 1 : 0) - (a.unread_count > 0 ? 1 : 0) || at(b) - at(a);
    if (sort === 'temperature') return (b.temperature_score ?? -1) - (a.temperature_score ?? -1) || at(b) - at(a);
    return at(b) - at(a);
  });
}

/** Threads with something unread, counted only over the owner's own. */
export function unreadThreads(threads: readonly { unread_count: number }[]): number {
  return threads.filter((c) => c.unread_count > 0).length;
}
