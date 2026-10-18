/**
 * Gmail sync runs in two lanes so new mail never waits behind upkeep.
 *
 *   fast  every minute (pg_cron clozr-gmail-fast, migration 273) and when the
 *         app opens, regains focus or asks "Sync now". One profile call; when
 *         Gmail's historyId moved, one history.list from the stored
 *         gmail_history_id. Only when that shows a message added does it read
 *         the new-mail window, plus by id any mail moved into the inbox or
 *         out of spam or trash, and store what matches, rules only.
 *   slow  every five minutes (clozr-google-sync, migration 71): the relink
 *         pass with the AI fallback, backfill, attachments, HTML hydrate and
 *         bounce scan. It runs the fast pass first only when that lane has
 *         fallen behind, so a missed minute cron still gets mail in.
 *
 * Pure pieces here, so they are tested without Deno or Google.
 */

import { type Link, mergeLink, threadLink } from './gmail-match.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

/**
 * Each message's link with its thread-mates' lent to it. Run over the
 * window's batch and the moved mail together: a parent restored from spam
 * and its reply in the window are one thread, and either may be the only one
 * that names the person or the deal.
 */
export function lendThreads(items: { threadId: string; link: Link }[]): Link[] {
  const byThread = new Map<string, Link[]>();
  for (const x of items) byThread.set(x.threadId, [...(byThread.get(x.threadId) ?? []), x.link]);
  return items.map((x) => mergeLink(x.link, threadLink(byThread.get(x.threadId) ?? [])));
}

export type Lane = 'fast' | 'slow';
export const laneOf = (v: unknown): Lane => (v === 'fast' ? 'fast' : 'slow');

/**
 * Per-account locks (rate_limit_hit windows). The fast one is just under the
 * cron's minute so the next tick is never refused by its own predecessor;
 * the slow one is under the five-minute tick for the same reason.
 */
export const FAST_LOCK_S = 55;
export const SLOW_LOCK_S = 270;

/** The slow lane catches mail up itself when the fast lane has not read through this recently. */
export const FAST_BEHIND_MS = 3 * 60_000;

/** history.list pages read before giving up and reading the window instead. */
export const HISTORY_PAGES = 3;

/** What the new-mail listing never reads: it asks -in:chats -in:drafts, and messages.list leaves spam and trash out. */
const SKIP = new Set(['DRAFT', 'CHAT', 'SPAM', 'TRASH']);

/** The history types the fast lane asks for: arrivals, and label moves that bring old mail into view. */
export const HISTORY_TYPES = ['messageAdded', 'labelAdded', 'labelRemoved'];

/** Ids of messages a history.list response says arrived, minus drafts, chats, spam and trash. */
export function addedMail(pages: Any[]): string[] {
  const out = new Set<string>();
  for (const page of pages) {
    for (const h of (page?.history ?? []) as Any[]) {
      for (const a of (h?.messagesAdded ?? []) as Any[]) {
        const m = a?.message;
        if (!m?.id) continue;
        const labels = (m.labelIds ?? []) as string[];
        if (labels.some((l) => SKIP.has(l))) continue;
        out.add(String(m.id));
      }
    }
  }
  return Array.from(out);
}

/** Mail moved into view, with the history record it was first seen at. */
export type Moved = { id: string; at: string };

/** History ids are decimal strings that outgrow a double; compare them as numbers of any length. */
export function cmpHistory(a: string, b: string): number {
  const x = a.replace(/^0+/, '') || '0';
  const y = b.replace(/^0+/, '') || '0';
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/** The history id just before `id`: startHistoryId there lists `id` again. */
export function historyBefore(id: string): string {
  return (BigInt(id) - BigInt(1)).toString();
}

/**
 * Mail that came into view without arriving: moved to the inbox (labelAdded
 * INBOX) or out of spam or trash (labelRemoved SPAM / TRASH). Its
 * internalDate is when it first arrived, often before the new-mail window,
 * so the window read alone would never see it; the fast lane reads these by
 * id. A message that is still a draft, chat, spam or trash after the change
 * is left out, and so is one only read or starred. In history order, each
 * id once, at the first record that moved it.
 */
export function movedIntoView(pages: Any[]): Moved[] {
  const out = new Map<string, string>();
  for (const page of pages) {
    for (const h of (page?.history ?? []) as Any[]) {
      const at = h?.id != null ? String(h.id) : null;
      if (!at) continue;
      const moves = [
        ...((h?.labelsAdded ?? []) as Any[]).filter((x) => ((x?.labelIds ?? []) as string[]).includes('INBOX')),
        ...((h?.labelsRemoved ?? []) as Any[]).filter((x) => ((x?.labelIds ?? []) as string[]).some((l) => l === 'SPAM' || l === 'TRASH')),
      ];
      for (const x of moves) {
        const m = x?.message;
        if (!m?.id) continue;
        if (((m.labelIds ?? []) as string[]).some((l) => SKIP.has(l))) continue;
        if (!out.has(String(m.id))) out.set(String(m.id), at);
      }
    }
  }
  return Array.from(out, ([id, at]) => ({ id, at })).sort((a, b) => cmpHistory(a.at, b.at));
}

/**
 * Where history reading stopped when there were more pages than
 * HISTORY_PAGES: the last record read. Null when every page was read.
 * Nothing past it is known, so the cursor may not pass it.
 */
export function historyCut(pages: Any[], more: boolean, stored: string): string | null {
  if (!more) return null;
  let last = stored;
  for (const page of pages) for (const h of (page?.history ?? []) as Any[]) if (h?.id != null && cmpHistory(String(h.id), last) > 0) last = String(h.id);
  return last;
}

/** The history record of the first moved message not yet stored (or given up), in history order; null when all are. */
export function firstPending(moved: Moved[], settled: ReadonlySet<string>): string | null {
  for (const m of moved) if (!settled.has(m.id)) return m.at;
  return null;
}

/**
 * The gmail_history_id a run that read its whole window may keep: the
 * profile's id, but never past a moved message still to read (it is listed
 * again from just before it) or past the last history record read. So moved
 * mail cut by a per-run limit is read on a later run, never skipped.
 */
export function stampPoint(o: { profileId: string; pendingAt: string | null; truncatedAt: string | null }): string {
  let point = o.profileId;
  if (o.pendingAt) { const before = historyBefore(o.pendingAt); if (cmpHistory(before, point) < 0) point = before; }
  if (o.truncatedAt && cmpHistory(o.truncatedAt, point) < 0) point = o.truncatedAt;
  return point;
}

/** Moved messages read per run, by headers and in full. The rest stay pending for the next run. */
export const MOVED_PER_RUN = 20;
export const MOVED_FULL_PER_RUN = 8;
/** A moved message that cannot be read is tried this many times a day, then given up so the cursor moves on. */
export const MOVED_TRIES = 3;
/** A fast run that failed without moving any cursor holds the minute lane off this mailbox this long. */
export const STALL_S = 300;

/**
 * Whether one minute's check can stop without reading the window.
 *   quiet    nothing arrived: stamp the cursors and return
 *   history  historyId moved: ask history.list what moved
 *   read     no usable cursor (first run, a mailbox behind by an hour or
 *            more, a profile read that failed): read the window
 */
export function quickVerdict(o: { profileId: string | null; storedId: string | null; current: boolean }): 'quiet' | 'history' | 'read' {
  if (!o.profileId || !o.storedId || !o.current) return 'read';
  return o.profileId === o.storedId ? 'quiet' : 'history';
}

/**
 * The slow lane's upkeep is due when the fast lane has read further since
 * upkeep last ran, or hourly regardless. `readId` is gmail_history_id, the
 * point the fast lane has stored mail through, not the mailbox's live
 * historyId: mail that arrived but is not stored yet (the fast lane's lock
 * was busy, or its run was cut) must not count as upkept, or its files and
 * relink would wait for the hourly run. Upkeep stamps the same readId. A
 * fast run that stores mail without moving readId writes upkeepMark() as the
 * upkeepId, which never equals a historyId, so the next slow tick is due.
 */
export function upkeepDue(o: { readId: string | null; upkeepId: string | null; hourlyAllowed: boolean }): boolean {
  if (!o.readId || !o.upkeepId) return true;
  return o.readId !== o.upkeepId || o.hourlyAllowed;
}

/** A one-off upkeep cursor: due on the next slow tick, and unique so a slow run's compare-and-set never stamps over it. */
export const upkeepMark = (now = Date.now()): string => `due:${now}:${Math.random().toString(36).slice(2, 10)}`;
