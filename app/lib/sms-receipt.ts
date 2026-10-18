// What a sent text's receipt line says.
//
// Talkr reports the carrier's status on each text. When the carrier's status
// callback never reaches Talkr, a text that went out stays "sending" there for
// good, and the thread said "Sending…" under it for hours. A text still queued
// or sending ten minutes after it was written has left our hands: it reads
// "Sent" and is drawn as sent, not faded. A real receipt (delivered, not
// delivered) still wins whenever it lands.

/** How long a text may sit in queued or sending before it reads as sent. */
export const SENDING_STALE_MS = 10 * 60_000;

const RECEIPT: Record<string, string> = {
  queued: 'Sending…',
  sending: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  undelivered: 'Not delivered',
  failed: 'Not delivered',
};

const PENDING = new Set(['queued', 'sending']);

/** Whether a text is still on its way: queued or sending, and newer than ten minutes. */
export function smsPending(status: string | null | undefined, at: string | null | undefined, now = Date.now()): boolean {
  if (!status || !PENDING.has(status)) return false;
  const t = Date.parse(at ?? '');
  return !Number.isFinite(t) || now - t < SENDING_STALE_MS;
}

/** The status a receipt shows: a stale queued or sending text reads as sent. */
export function smsShownStatus(status: string | null | undefined, at: string | null | undefined, now = Date.now()): string {
  const s = status ?? '';
  return PENDING.has(s) && !smsPending(s, at, now) ? 'sent' : s;
}

/** "Sending…", "Sent", "Delivered", "Not delivered", or the raw status when it is none of those. */
export function smsReceiptLabel(status: string | null | undefined, at: string | null | undefined, now = Date.now()): string {
  const s = smsShownStatus(status, at, now);
  return RECEIPT[s] ?? s;
}
