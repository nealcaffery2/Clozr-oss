/**
 * Folding a re-read of Talkr's moving lists (threads, recent calls, call
 * history) into the phone's state without a new object when nothing moved.
 *
 * useTalkrPhone re-reads these on every Talkr event about the rep and once a
 * minute for the rest of the org. Most of those reads come back the same, and
 * a new `data` object each time rebuilt the whole view model behind it. Rows
 * are compared whole (they are small JSON from one server, so the key order
 * is stable), which never misses a field that changed.
 */
import type { CallDto, ConversationDto, HistoryItemDto } from './talkr';

export type PhoneLists = {
  convs: ConversationDto[];
  unread: number;
  recent: CallDto[];
  history: HistoryItemDto[];
};

/** Same rows in the same order. */
export function sameRows<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

/**
 * `d` with whatever came back folded in. A list that failed to read is left
 * out of `fresh` and stays as it was. Returns `d` itself when nothing changed,
 * and a list that did not change keeps its identity either way.
 */
export function foldLists<T extends PhoneLists>(d: T, fresh: Partial<PhoneLists>): T {
  const convs = fresh.convs && !sameRows(d.convs, fresh.convs) ? fresh.convs : d.convs;
  const unread = fresh.unread ?? d.unread;
  const recent = fresh.recent && !sameRows(d.recent, fresh.recent) ? fresh.recent : d.recent;
  const history = fresh.history && !sameRows(d.history, fresh.history) ? fresh.history : d.history;
  if (convs === d.convs && unread === d.unread && recent === d.recent && history === d.history) return d;
  return { ...d, convs, unread, recent, history };
}
