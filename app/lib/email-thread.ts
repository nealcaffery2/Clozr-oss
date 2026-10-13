// Email threads as a reader sees them: the same person and the same subject,
// Re:/Fwd: aside. Gmail's own thread ids differ per mailbox, so the Inbox
// (components/inbox/data.ts) and a record's Activity feed both group this way,
// and "Open in Inbox" from a record lands on the thread it came from.
//
// Pure: no React, no Supabase. Run its test with npx tsx tools/email-thread.test.ts.

/** The subject with any run of Re:/Fwd:/AW: prefixes removed. */
export const baseSubject = (s: string | null | undefined) => (s ?? '').replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '').trim();

export type ThreadEmail = { inbound: boolean; from: string; to: string[]; subject: string };

/** Who the conversation is with: the sender of a received email, the first recipient of a sent one. */
export const counterpartOf = (e: ThreadEmail) => (e.inbound ? e.from : e.to[0] ?? '').trim().toLowerCase();

/** The thread an email belongs to: counterpart | base subject. */
export function emailThreadKey(e: ThreadEmail): string {
  return `${counterpartOf(e)}|${baseSubject(e.subject).toLowerCase()}`;
}

/** "Re: <subject>" for a reply, never "Re: Re: …". */
export const replySubject = (subject: string) => 'Re: ' + (baseSubject(subject) || subject || '(no subject)');

/** A feed item that may be an email. */
type Item<E> = { email?: E | null; pinned?: boolean };

/**
 * Fold a newest-first feed's emails into threads. The newest message of a
 * thread keeps its place in the feed and carries `earlier`: the rest of the
 * thread, oldest first. Everything else (calls, texts, notes) passes through
 * untouched, in order.
 *
 * A pinned message stays on its own, so pinning never makes it disappear
 * into a thread further down the feed.
 */
export function foldEmailThreads<E extends ThreadEmail, T extends Item<E>>(feed: T[]): (T & { earlier: T[] })[] {
  const heads = new Map<string, T & { earlier: T[] }>();
  const out: (T & { earlier: T[] })[] = [];
  for (const item of feed) {
    const e = item.email;
    if (!e || item.pinned) {
      out.push({ ...item, earlier: [] });
      continue;
    }
    const key = emailThreadKey(e);
    const head = heads.get(key);
    if (head) {
      head.earlier.unshift(item);
      continue;
    }
    const next = { ...item, earlier: [] as T[] };
    heads.set(key, next);
    out.push(next);
  }
  return out;
}
