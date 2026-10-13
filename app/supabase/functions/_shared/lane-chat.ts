// Lane's chats, the pure half (the lane function runs it;
// tools/lane-chat.test.ts tests it): turning what someone typed into an
// address search, and deciding which chat an exchange is filed in once Lane
// knows which property it is about.

/** Street-type words people type one way and the records store another ("Street" vs "St"). */
const SUFFIX = new Set([
  'st', 'street', 'ave', 'av', 'avenue', 'dr', 'drive', 'rd', 'road', 'ln', 'lane', 'ct', 'court',
  'blvd', 'boulevard', 'cir', 'circle', 'way', 'pl', 'place', 'trl', 'trail', 'pkwy', 'parkway',
  'hwy', 'highway', 'ter', 'terrace', 'loop', 'cv', 'cove', 'pass', 'run', 'xing', 'crossing',
]);
const DIRECTION = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);

/** Characters that are syntax in a PostgREST or=(…) filter or an ilike pattern. */
export const ilikeSafe = (s: string) => s.replace(/[,()\\*%_:"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * The patterns to try for a typed property, best first. "123 main street,
 * san antonio tx" becomes "%123%main%street%" (as typed, before the comma),
 * then "%123%main%" (street type, direction and city dropped), so the record
 * stored as "123 Main St" is still found. A bare name gives one pattern.
 */
export function addressPatterns(typed: string): string[] {
  const head = ilikeSafe(String(typed ?? '').split(',')[0] ?? '');
  if (!head) return [];
  const words = head.toLowerCase().split(' ').filter(Boolean);
  const out = [`%${words.join('%')}%`];
  const core = words.filter((w, i) => !(i > 0 && (SUFFIX.has(w.replace(/\.$/, '')) || DIRECTION.has(w.replace(/\.$/, '')))));
  // A house number and one street word is enough to find it; past that the
  // extra words are what made the first pattern miss.
  const short = /^\d/.test(core[0] ?? '') ? core.slice(0, 2) : core;
  const p2 = `%${short.join('%')}%`;
  if (short.length && p2 !== out[0]) out.push(p2);
  return out;
}

/** The property a chat is filed under. */
export type ChatSubject = { seller_id: number | null; deal_id: number | null; address: string | null };

/** Same property: the same seller, or the same deal. */
export function sameSubject(a: ChatSubject | null, b: ChatSubject | null): boolean {
  if (!a || !b) return false;
  if (a.seller_id != null && b.seller_id != null) return a.seller_id === b.seller_id;
  if (a.deal_id != null && b.deal_id != null) return a.deal_id === b.deal_id;
  return false;
}

export const hasSubject = (s: ChatSubject | null | undefined): s is ChatSubject => !!s && (s.seller_id != null || s.deal_id != null);

/**
 * Where this exchange goes once Lane has said which property it is about.
 *   keep  — the chat is already about it (or Lane named nothing)
 *   pin   — the chat is about nothing yet, or has nothing in it yet: file it here
 *   move  — the chat is about another property and has history: this exchange
 *           belongs in that property's own chat (found or started by the caller)
 */
export function routeFor(chat: { subject: ChatSubject | null; messages: number }, said: ChatSubject | null): 'keep' | 'pin' | 'move' {
  if (!hasSubject(said)) return 'keep';
  if (sameSubject(chat.subject, said)) return 'keep';
  if (!hasSubject(chat.subject) || chat.messages === 0) return 'pin';
  return 'move';
}

/** A chat's title: the address once it has one, else the first question. */
export function chatTitle(subject: ChatSubject | null, firstQuestion: string): string {
  if (subject?.address) return subject.address.slice(0, 80);
  const q = String(firstQuestion ?? '').replace(/\s+/g, ' ').trim();
  return q ? (q.length > 60 ? q.slice(0, 59) + '…' : q) : 'New chat';
}
