// What the rep typed and has not sent yet, kept per conversation for the
// session. One box per person: a text thread in the Inbox, the record
// composer, the docked quick text or email. Switching to someone else shows
// that person's own draft (empty when there is none), so a message written to
// one seller can never go out to the next one opened. Coming back, or leaving
// the screen and returning, finds it where it was.
//
// Keys say whose box it is:
//   sms:<conversation id>      an Inbox text thread ('sms:new' for New text)
//   record:<person id>         the seller record's composer
//   quick:<channel>:<person>   the docked quick text or email
//
// Kept in memory for the tab, not in storage: a draft is a minute's work, and
// a stale one surfacing tomorrow on someone's thread is worse than losing it.

export type Draft = { text: string; subject: string };

const EMPTY: Draft = { text: '', subject: '' };
const store = new Map<string, Draft>();

export function draftFor(key: string): Draft {
  return store.get(key) ?? EMPTY;
}

/** Save what is in the box now. An empty box forgets the key. */
export function keepDraft(key: string, patch: Partial<Draft>): void {
  const next = { ...draftFor(key), ...patch };
  if (!next.text && !next.subject) store.delete(key);
  else store.set(key, next);
}

export function clearDraft(key: string): void {
  store.delete(key);
}

/**
 * A send that failed hands its text back. An empty box takes it as it was; a
 * box the rep has started typing in again keeps that too, under the text that
 * did not go, so neither is lost. Already there (put back twice): unchanged.
 */
export function withRestored(current: string, failed: string): string {
  const cur = current.trim();
  const back = failed.trim();
  if (!back || cur.includes(back)) return current;
  if (!cur) return failed;
  return `${failed}\n\n${current}`;
}

/** Put a failed send back into the draft for `key`; returns the box's new text. */
export function restoreDraft(key: string, failed: string, subject?: string): string {
  const d = draftFor(key);
  const text = withRestored(d.text, failed);
  keepDraft(key, { text, ...(subject && !d.subject ? { subject } : {}) });
  return text;
}
