// Texting a seller from a CLOZR record.
//
// The wire is lib/talkr.ts: the browser calls Talkr's own API as the signed-in
// rep, because Talkr trusts this project's tokens. So there is no second
// credential, no machine account, and the send is attributed to the person who
// pressed the button. Talkr owns the numbers, the carrier (Telnyx), the
// suppression list and quiet hours, and it refuses what it should refuse.
//
// What this adds on top is the CRM half, which Talkr has no reason to know
// about: merge fields filled from the CLOZR row, and the sent message written
// onto the record so it shows on the timeline. The row is keyed by Talkr's
// message id, so a later delivery receipt for the same message updates it
// rather than adding a second copy of the text (migration 29).

import { TalkrError, talkr, toE164 } from './talkr';
import { getSmsFrom, loadSmsLines } from './sms-from';
import { sendsAsSelf } from './thread-line';
import { supabase } from './supabase';
import { BLACKLIST_MESSAGE, loadBlocked, type BlacklistDb, type BlockedSet } from './blacklist';

/** Who a text is going to, and the values its merge fields can use. */
export type Recipient = {
  sellerId: number | null;
  /** A buyer blast's recipient: the text is logged on the buyer, the way a seller's is on the seller. */
  buyerId?: number | null;
  /** A vendor list's recipient (Wholesalers, Lenders, …): logged on the vendor. */
  vendorId?: number | null;
  name: string;
  phone: string | null;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  email?: string;
  askingPrice?: string;
  offer?: string;
  closeDate?: string;
  titleCompany?: string;
  beds?: string;
  baths?: string;
  photoUrl?: string;
  /** Anything else a caller fills in: a dispo campaign's deal and last-purchase fields (lib/dispo-campaign.ts). */
  extra?: Record<string, string>;
};

/** The sender's side of the merge fields, the same for every recipient. */
export type SendContext = {
  repName?: string; repPhone?: string; repEmail?: string; company?: string;
  /** The Talkr line to send from. Unset uses the CRM-wide pick (lib/sms-from); null there is the rep's default. */
  fromPhoneNumberId?: string | null;
};

export type SendOutcome = {
  sellerId: number | null;
  name: string;
  to: string;
  /** queued | sending | sent | delivered | skipped | failed */
  status: string;
  messageId?: string;
  error?: string;
};

/** Talkr caps a message body at 1600 characters. */
export const MAX_BODY = 1600;
/** One press of Send should not be able to start a campaign. */
export const MAX_RECIPIENTS = 200;

/**
 * Fill in merge fields.
 *
 * Both brace styles are accepted: the plan builder writes {{first_name}} and
 * Talkr's own templates write {first_name}. A field nobody knows is left
 * exactly as typed rather than blanked, so a stray brace in a sentence
 * survives and a typo is visible instead of silently eating the word.
 */
export function renderMerge(body: string, fields: Record<string, string>): string {
  let blanked = false;
  // A blank field leaves a marker rather than nothing, so the clean-up below
  // can tell a line that held only blank fields from a line someone left empty.
  const out = body.replace(/\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}/g, (whole, name: string) => {
    const v = fields[String(name).toLowerCase()];
    if (v === undefined) return whole;
    if (v === '') { blanked = true; return BLANK; }
    return v;
  });
  if (!blanked) return out;
  // A field we know but do not have leaves a hole: "selling {address}?" with no
  // address on the record became "selling ?". Close the gap the substitution
  // made, and only then — text nobody substituted into is left exactly as
  // whoever wrote it typed it. A line that held nothing but blank fields (a
  // "{{purchase_note}}" line for a buyer with no purchase on file) goes away
  // with its line break, so the text above and below simply meet.
  return out
    .replace(/^[ \t]*\u0000(?:[ \t]*\u0000)*[ \t]*\n/gm, '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}
const BLANK = '\u0000';

export function fieldsFor(r: Recipient, ctx: SendContext, to: string): Record<string, string> {
  const rep = (ctx.repName ?? '').trim();
  return {
    first_name: r.name.trim().split(/\s+/)[0] ?? '',
    name: r.name,
    contact_name: r.name,
    address: r.address ?? '',
    city: r.city ?? '',
    state: r.state ?? '',
    zip: r.zip ?? '',
    postal_code: r.zip ?? '',
    phone: to,
    email: r.email ?? '',
    asking_price: r.askingPrice ?? '',
    offer: r.offer ?? '',
    close_date: r.closeDate ?? '',
    title_company: r.titleCompany ?? '',
    beds: r.beds ?? '',
    baths: r.baths ?? '',
    photo_url: r.photoUrl ?? '',
    rep_name: rep,
    rep_first_name: rep.split(/\s+/)[0] ?? '',
    rep_phone: ctx.repPhone ?? '',
    rep_email: ctx.repEmail ?? '',
    company: ctx.company ?? '',
    org_name: ctx.company ?? '',
    ...r.extra,
  };
}

/**
 * Talkr's refusals, in words the person who pressed Send can act on. Its
 * error codes are stable; its prose is not, so the sentence is written here.
 */
function refusal(err: unknown, to: string): string {
  if (!(err instanceof TalkrError)) return (err as Error)?.message ?? 'Could not send.';
  switch (err.code) {
    case 'suppressed': return `${to} has opted out of texts. Talkr is blocking this one.`;
    case 'quiet_hours': return 'Outside Talkr’s sending window for this team, so nothing was queued.';
    case 'no_from_number': return 'Talkr has no active number to send from. Buy or assign one in Talkr first.';
    case 'invalid_number': return `${to} is not a number Talkr can text.`;
    case 'invalid_body': return 'The message was empty.';
    case 'invalid_caller_id': return 'Talkr refused the sending number.';
    case 'forbidden': return 'This account cannot send texts in Talkr.';
    case 'unlinked': return err.message;
    default: return err.message || 'Could not send.';
  }
}

/**
 * Record the sent text on the CLOZR record.
 *
 * Failing to write the row must not read as a failed send — the text is gone
 * either way — so this reports nothing and the outcome stays "sent".
 */
async function record(
  workspaceId: number, r: Recipient, to: string, body: string,
  msg: { id: string; status?: string },
): Promise<void> {
  if (!supabase) return;
  const repId = (await supabase.auth.getSession()).data.session?.user.id ?? null;
  const { error } = await supabase.from('communications').insert({
    workspace_id: workspaceId,
    seller_id: r.sellerId,
    buyer_id: r.buyerId ?? null,
    vendor_id: r.vendorId ?? null,
    channel: 'sms',
    direction: 'outbound',
    occurred_at: new Date().toISOString(),
    // The rep who sent it, for the leaderboard (migration 85).
    ...(repId ? { rep_id: repId } : {}),
    to_phone: to,
    body,
    status: msg.status ?? 'queued',
    source: 'talkr',
    source_id: 'msg:' + msg.id,
  });
  if (error) console.error('text sent but not recorded on the record', error.message);
}

/**
 * Texts go browser to Talkr with no CLOZR server in between (send-sms is
 * retired), so this is the one chokepoint every send passes, and it reads the
 * blacklist from the database rather than trusting the row the screen holds.
 * Talkr's own suppression list only knows opt-outs. Demo builds (no client)
 * have nothing to read and nothing to send.
 */
export async function blockedTexts(
  recipients: Recipient[], db: BlacklistDb | null = supabase as unknown as BlacklistDb | null,
): Promise<{ ok: true; blocked: BlockedSet } | { ok: false; message: string }> {
  if (!db) return { ok: true, blocked: { sellers: new Set(), buyers: new Set() } };
  return loadBlocked(db, { sellerIds: recipients.map((r) => r.sellerId), buyerIds: recipients.map((r) => r.buyerId) });
}

const isBlockedRecipient = (r: Recipient, b: BlockedSet) =>
  (r.sellerId != null && b.sellers.has(r.sellerId)) || (r.buyerId != null && b.buyers.has(r.buyerId));

/** One text. `gate` is the blacklist read textMany already did for the whole batch. */
export async function textOne(
  workspaceId: number, r: Recipient, body: string, ctx: SendContext = {},
  gate?: { ok: true; blocked: BlockedSet } | { ok: false; message: string },
): Promise<SendOutcome> {
  const to = toE164(r.phone);
  if (!to) return { sellerId: r.sellerId, name: r.name, to: r.phone ?? '—', status: 'skipped', error: `${r.name} has no mobile number.` };
  const check = gate ?? await blockedTexts([r]);
  if (!check.ok) return { sellerId: r.sellerId, name: r.name, to, status: 'blocked', error: check.message };
  if (isBlockedRecipient(r, check.blocked)) return { sellerId: r.sellerId, name: r.name, to, status: 'blocked', error: BLACKLIST_MESSAGE };
  const text = renderMerge(body, fieldsFor(r, ctx, to));
  try {
    let from = ctx.fromPhoneNumberId !== undefined ? ctx.fromPhoneNumberId : getSmsFrom();
    // The TC names her own line: left to Talkr, a number with an open thread
    // went out on whichever rep's line was carrying it (lib/thread-line).
    if (from == null && ctx.fromPhoneNumberId === undefined && sendsAsSelf()) from = (await loadSmsLines()).defaultId;
    const sent = await talkr.sendMessage({ to_number: to, body: text, ...(from ? { from_phone_number_id: from } : {}) });
    await record(workspaceId, r, to, text, sent.message);
    return { sellerId: r.sellerId, name: r.name, to, status: sent.message.status || 'queued', messageId: sent.message.id };
  } catch (err) {
    return { sellerId: r.sellerId, name: r.name, to, status: 'failed', error: refusal(err, to) };
  }
}

/**
 * Several texts, a few at a time.
 *
 * One at a time makes a list of two hundred crawl; all at once hands Talkr a
 * thundering herd. Order is preserved so results line up with the selection.
 */
export async function textMany(
  workspaceId: number, recipients: Recipient[], body: string, ctx: SendContext = {},
): Promise<SendOutcome[]> {
  const out: SendOutcome[] = new Array(recipients.length);
  // One read for the whole batch; each textOne then only looks its own row up.
  const gate = await blockedTexts(recipients);
  const BATCH = 6;
  for (let i = 0; i < recipients.length; i += BATCH) {
    await Promise.all(recipients.slice(i, i + BATCH).map(async (r, j) => {
      out[i + j] = await textOne(workspaceId, r, body, ctx, gate);
    }));
  }
  return out;
}

/** One line for the toast: what went out, and what did not. */
export function sendSummary(results: SendOutcome[]): string {
  const sent = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  if (!sent.length) return failed[0]?.error ?? 'Nothing was sent.';
  const who = sent.length === 1 ? '1 text sent' : sent.length + ' texts sent';
  if (!failed.length) return who + '.';
  // One failure names itself; several are counted, because a toast listing
  // twelve reasons is a toast nobody reads.
  return failed.length === 1
    ? who + ' · ' + failed[0].error
    : who + ' · ' + failed.length + ' not sent (' + failed[0].error + ')';
}
