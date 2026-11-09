// The Inbox's All tab: which reply box an open thread gets. A text thread gets
// the SMS tab's own thread and composer (MessagesScreen), an email thread the
// Email tab's own (GmailThread), so a reply from All goes out the same way it
// does from the channel's tab. A call or voicemail keeps the header's Text
// button, which opens the docked quick text.
// Pure, so `npx tsx tools/inbox-reply.test.ts` covers it without the DOM.

export type AllKind = 'sms' | 'email' | 'call';
/** The channel tab whose reply box the thread borrows; null when it has none. */
export type AllReply = 'sms' | 'email' | null;

export type AllReplyItem = {
  kind: AllKind;
  /** The Talkr conversation behind a text thread. */
  convId?: string | null;
  /** The email thread the list already loaded. */
  thread?: unknown;
  /** Who a text goes to. */
  phone: string | null;
};

export function allReplyFor(i: AllReplyItem): AllReply {
  if (i.kind === 'sms' && i.convId) return 'sms';
  if (i.kind === 'email' && i.thread) return 'email';
  return null;
}

/**
 * The header's text button. A thread with the SMS composer under it needs
 * none; an email or a call with a number offers Text (the docked quick text);
 * a text thread Talkr has not given an id offers Reply through that same box.
 */
export function headerTextLabel(i: AllReplyItem): 'Text' | 'Reply' | null {
  if (!i.phone) return null;
  const reply = allReplyFor(i);
  if (reply === 'sms') return null;
  return i.kind === 'sms' ? 'Reply' : 'Text';
}

const TAB: Record<AllKind, string> = { sms: 'SMS', email: 'Email', call: 'Calls' };

/** The More menu's way to the same thread on its own tab. */
export const openInLabel = (kind: AllKind): string => `Open in ${TAB[kind]}`;
