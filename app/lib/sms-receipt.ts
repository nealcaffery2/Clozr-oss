// What a sent text's receipt line says, drawn the way iPhone Messages draws it:
// one small grey line under the last text you sent ("Delivered", "Read 2:14 PM"),
// "Not Delivered" in red when it failed.
//
// Talkr reports the carrier's status on each text. When the carrier's status
// callback never reaches Talkr, a text that went out stays "sending" there for
// good, and the thread said "Sending…" under it for hours. A text still queued
// or sending ten minutes after it was written has left our hands: it reads
// "Sent" and is drawn as sent, not faded. A real receipt (delivered, read, not
// delivered) still wins whenever it lands.
//
// Plain SMS never reports a read. "Read" shows only when the status itself is
// `read`, which iMessage and RCS can send; nothing here infers it.

/** How long a text may sit in queued or sending before it reads as sent. */
export const SENDING_STALE_MS = 10 * 60_000;

const RECEIPT: Record<string, string> = {
  queued: 'Sending…',
  sending: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  undelivered: 'Not Delivered',
  failed: 'Not Delivered',
};

const PENDING = new Set(['queued', 'sending']);
const FAILED = new Set(['failed', 'undelivered', 'rejected']);

/**
 * How far along a text is. Mirrors public.comm_status_rank (migration 398), so a
 * late or repeated event never moves a status back: read outranks everything,
 * a failure outranks a delivery receipt.
 */
export function smsStatusRank(status: string | null | undefined): number {
  switch ((status ?? '').toLowerCase()) {
    case 'queued': case 'sending': case 'accepted': return 1;
    case 'sent': return 2;
    case 'delivered': return 3;
    case 'failed': case 'undelivered': case 'rejected': return 4;
    case 'read': return 5;
    default: return 0;
  }
}

/** The status to keep when `next` arrives on a text that holds `current`: never a step back. */
export function smsLaterStatus(current: string | null | undefined, next: string | null | undefined): string | null {
  if (!next) return current ?? null;
  return smsStatusRank(next) >= smsStatusRank(current) ? next : current ?? null;
}

/** Whether a text is still on its way: queued or sending, and newer than ten minutes. */
export function smsPending(status: string | null | undefined, at: string | null | undefined, now = Date.now()): boolean {
  if (!status || !PENDING.has(status)) return false;
  const t = Date.parse(at ?? '');
  return !Number.isFinite(t) || now - t < SENDING_STALE_MS;
}

/** Whether nothing reached the handset. */
export function smsFailed(status: string | null | undefined): boolean {
  return !!status && FAILED.has(status);
}

/** The status a receipt shows: a stale queued or sending text reads as sent. */
export function smsShownStatus(status: string | null | undefined, at: string | null | undefined, now = Date.now()): string {
  const s = status ?? '';
  return PENDING.has(s) && !smsPending(s, at, now) ? 'sent' : s;
}

/**
 * When a text was read, as iPhone writes it after "Read": the time today,
 * "Yesterday", the weekday within the week, then the date.
 */
export function readStamp(iso: string | null | undefined, now = Date.now()): string | null {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return null;
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff <= 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}

export type SmsReceipt = {
  /** "Sending…", "Sent", "Delivered", "Read", "Not Delivered", or the raw status. */
  word: string;
  /** After "Read": when. Null for every other status, and for a read with no time. */
  time: string | null;
  failed: boolean;
};

/** The receipt line's parts, for a renderer that sets "Read" apart from its time. */
export function smsReceipt(
  status: string | null | undefined,
  at: string | null | undefined,
  readAt?: string | null,
  now = Date.now(),
): SmsReceipt {
  const s = smsShownStatus(status, at, now);
  return {
    word: RECEIPT[s] ?? s,
    time: s === 'read' ? readStamp(readAt, now) : null,
    failed: smsFailed(s),
  };
}

/** "Sending…", "Sent", "Delivered", "Read 2:14 PM", "Not Delivered", or the raw status when it is none of those. */
export function smsReceiptLabel(
  status: string | null | undefined,
  at: string | null | undefined,
  now = Date.now(),
  readAt?: string | null,
): string {
  const r = smsReceipt(status, at, readAt, now);
  return r.time ? `${r.word} ${r.time}` : r.word;
}
