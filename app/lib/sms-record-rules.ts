// The rules behind lib/sms-record, with no client import so a test can run
// them anywhere: the row every sent text is written as, how its line
// resolves, and how a Talkr seat maps to a CLOZR user.

import { recordBody } from './mms';

/** What Talkr hands back for a sent message, as far as this module needs. */
export type SentMessage = { id: string; status?: string | null; created_by?: string | null; from_number?: string | null };

export type SentTextRow = {
  workspace_id: number;
  seller_id: number | null;
  buyer_id: number | null;
  vendor_id: number | null;
  deal_id: number | null;
  channel: 'sms';
  direction: 'outbound';
  occurred_at: string;
  rep_id: string | null;
  talkr_user_id: string | null;
  from_phone: string | null;
  to_phone: string;
  body: string;
  status: string;
  source: 'talkr';
  source_id: string;
};

export type SentTextInput = {
  workspaceId: number;
  sellerId?: number | null;
  buyerId?: number | null;
  vendorId?: number | null;
  dealId?: number | null;
  to: string;
  body: string;
  mediaUrls?: readonly string[];
  msg: SentMessage;
  /** The CLOZR user sending. Null only when nobody is signed in (a server send names its own). */
  repId: string | null;
  /** The line it went out on, E.164. fromLine() resolves it from the message or the picked line. */
  fromPhone: string | null;
  now?: string;
};

export function sentTextRow(i: SentTextInput): SentTextRow {
  return {
    workspace_id: i.workspaceId,
    seller_id: i.sellerId ?? null,
    buyer_id: i.buyerId ?? null,
    vendor_id: i.vendorId ?? null,
    deal_id: i.dealId ?? null,
    channel: 'sms',
    direction: 'outbound',
    occurred_at: i.now ?? new Date().toISOString(),
    rep_id: i.repId,
    talkr_user_id: i.msg.created_by ?? null,
    from_phone: i.fromPhone,
    to_phone: i.to,
    body: recordBody(i.body, i.mediaUrls ?? []),
    status: i.msg.status || 'queued',
    source: 'talkr',
    source_id: 'msg:' + i.msg.id,
  };
}

/**
 * The E.164 a text left from: what Talkr says on the message, else the line
 * the sender picked (by Talkr number id), else the thread's own number. Null
 * when none of those is known; the line-owner trigger then has nothing to go
 * on, and the row still carries rep_id.
 */
export function fromLine(
  msg: Pick<SentMessage, 'from_number'> | null | undefined, fromId: string | null | undefined,
  lines: readonly { id: string; phone_e164: string }[] | null | undefined, threadNumber?: string | null,
): string | null {
  if (msg?.from_number) return msg.from_number;
  if (fromId) {
    const line = (lines ?? []).find((l) => l.id === fromId);
    if (line) return line.phone_e164;
  }
  return threadNumber ?? null;
}

/**
 * Talkr user id → CLOZR user id, by sign-in address. A Talkr seat whose email
 * matches no teammate maps to nothing: the row keeps talkr_user_id and the
 * line-owner trigger may still name a rep.
 */
export function talkrUserMap(
  talkrTeam: readonly { id: string; email?: string | null }[] | null | undefined,
  teammates: readonly { user_id: string; email: string | null }[] | null | undefined,
): Map<string, string> {
  const byEmail = new Map<string, string>();
  for (const t of teammates ?? []) { const e = (t.email ?? '').trim().toLowerCase(); if (e) byEmail.set(e, t.user_id); }
  const out = new Map<string, string>();
  for (const m of talkrTeam ?? []) {
    const e = (m.email ?? '').trim().toLowerCase();
    const u = e ? byEmail.get(e) : undefined;
    if (u) out.set(m.id, u);
  }
  return out;
}
