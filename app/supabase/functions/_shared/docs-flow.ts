/**
 * The people side of a sent contract (migration 114): approvals before it
 * goes out, handing a signature to someone else, adding or correcting a
 * recipient mid-flow, and signing links by text.
 *
 * Shared by the contracts (app), esign (public signing page) and docs-remind
 * (cron) functions. The rules themselves — who is up, who gets what — are
 * pure and live in signing-order.ts and docs-people.ts.
 *
 * Texts go through Talkr as a person: the contract's sender (or whoever is
 * acting in the app), with a five-minute token signed with
 * TALKR_PARTNER_JWT_SECRET, the same way dispo-campaign-tick sends. Without
 * that secret nothing is texted and the result says so; email still goes.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { type Any, type Company, applySent, emailSigners, ensureTcCc, logContractFeed, logEvent, signUrl, signingSender } from './docs.ts';
import { needsApproval, pendingApprovals, sendTo } from './signing-order.ts';
import { codeText, delegatedRole, insertAt, normalizeDelivery, phoneE164, signingText, wantsEmail, wantsSms } from './docs-people.ts';
import { sendResend, transactionalFrom } from './resend.ts';
import { signingResendEnv } from './workspace-email.ts';
import { onDelegated } from './delegate.ts';
import { type BlacklistDb, loadBlocked, textBlock } from '../../../lib/blacklist.ts';
import { carrierCheck, carrierReport } from '../../../lib/carrier-safe.ts';
import { gateTalkrWrite, readTalkrOrg, TALKR_NOT_CONNECTED } from './talkr-binding.ts';
import { textingBinding } from './talkr-connect.ts';

export const SIGNER_COLS = 'id, workspace_id, contract_id, role, label, name, email, phone, status, sort, recipient_type, token, delivery, seller_id, buyer_id, vendor_id, user_id, signed_at, viewed_at, view_seconds, reminder_count, last_reminded_at, approved_at, rejected_at, reject_reason, delegated_from, delegated_to, delegate_reason';

type Who = { actor_type?: 'user' | 'signer' | 'system'; actor_id?: string | null; signer_id?: number | null; ip?: string | null; user_agent?: string | null };
export type FlowCtx = { company: Company; origin: string; who: Who; senderId?: string | null };

const TALKR_DEFAULT_URL = 'https://talkr.example.com';
const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export async function loadRecipients(admin: SupabaseClient, contractId: number): Promise<Any[]> {
  const { data } = await admin.from('contract_signers').select(SIGNER_COLS).eq('contract_id', contractId).order('sort');
  return (data ?? []) as Any[];
}

/** A recipient as the app sees it: no token, a link instead. */
export const publicRecipient = (s: Any, origin: string) => {
  const { token, ...rest } = s;
  return { ...rest, url: token ? signUrl(origin, token) : null };
};

// ------------------------------------------------------------------- texts
async function partnerToken(user: { id: string; email: string | null }): Promise<string | null> {
  const secret = Deno.env.get('TALKR_PARTNER_JWT_SECRET');
  if (!secret || !user.email) return null;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({
    iss: `${Deno.env.get('SUPABASE_URL')}/auth/v1`, sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, iat: now, exp: now + 300,
  })));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** `carrier_fixed`: what the carrier check reworded before it went (lib/carrier-safe), for the sender's log. */
export type TextResult = { ok: true; communication_id?: number | null; carrier_fixed?: string } | { ok: false; reason: string };

/**
 * One text to one recipient, as the sender. Blacklisted records and numbers
 * Talkr has suppressed (they replied STOP) are never texted; quiet hours are
 * Talkr's to enforce and come back as a reason. A blacklist read that fails
 * comes back as BLACKLIST_UNREAD (lib/blacklist): nothing went out, and the
 * caller holds the text and tries again rather than counting it as a no.
 */
export async function textRecipient(
  admin: SupabaseClient, row: Record<string, Any>, to: { phone?: string | null; seller_id?: number | null; buyer_id?: number | null; vendor_id?: number | null },
  body: string, senderId: string | null | undefined,
  /** Who else calls this: the AI agent sends from the sender's own default line (fromPhoneNumberId null, contractsLine false). */
  opts: { fromPhoneNumberId?: string | null; contractsLine?: boolean } = {},
): Promise<TextResult> {
  const phone = phoneE164(to.phone);
  if (!phone) return { ok: false, reason: 'no mobile number' };
  // Every server text is outreach or a template: carrier trigger wording is
  // swapped for safe wording, and a text a carrier would block is refused.
  const carrier = carrierCheck(body);
  if (carrier.blocked) return { ok: false, reason: `carrier would block it: ${carrierReport(carrier)}` };
  body = carrier.text;
  const carrierFixed = carrierReport(carrier, ['fix']);
  const listed = await loadBlocked(admin as unknown as BlacklistDb, { sellerIds: [to.seller_id], buyerIds: [to.buyer_id] });
  if (!listed.ok) console.error('textRecipient', listed.message);
  const block = textBlock(listed, to);
  if (block) return { ok: false, reason: block };
  const { data: ws } = await admin.from('workspaces').select('settings, owner_id').eq('id', row.workspace_id).maybeSingle();
  const settings = (ws?.settings ?? {}) as Record<string, Any>;
  const wsId = Number(row.workspace_id);
  const binding = await textingBinding(admin, { id: wsId, settings });
  if (!binding) return { ok: false, reason: TALKR_NOT_CONNECTED };
  let userId = senderId ?? row.created_by ?? null;
  userId = userId ?? ws?.owner_id ?? null;
  if (!userId) return { ok: false, reason: 'no sender to text as' };
  const { data: p } = await admin.from('profiles').select('email').eq('id', userId).maybeSingle();
  const token = await partnerToken({ id: userId, email: p?.email ?? null });
  if (!token) return { ok: false, reason: 'server texting is not configured (TALKR_PARTNER_JWT_SECRET)' };
  const base = String(settings.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
  const observed = await readTalkrOrg(async (path) => {
    try {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { ok: res.ok, body: await res.json().catch(() => ({})) };
    } catch {
      return { ok: false, body: {} };
    }
  });
  if (!gateTalkrWrite({ binding, observedOrgId: observed }).ok) return { ok: false, reason: TALKR_NOT_CONNECTED };
  // Optional: a line for contract texts (settings.contracts.from_phone_number_id); else the sender's default.
  const from = opts.fromPhoneNumberId ?? (opts.contractsLine === false ? null : settings.contracts?.from_phone_number_id ?? null);
  let res: { ok: boolean; status: number; body: Any };
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to_number: phone, body, ...(from ? { from_phone_number_id: from } : {}) }),
    });
    res = { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  } catch {
    res = { ok: false, status: 0, body: { error: 'unreachable' } };
  }
  if (!res.ok) {
    const code = String(res.body?.error ?? '');
    if (code === 'suppressed') return { ok: false, reason: 'number opted out of texts' };
    if (code === 'quiet_hours') return { ok: false, reason: 'quiet hours' };
    return { ok: false, reason: `Talkr refused: ${code || res.status}` };
  }
  const msg = res.body?.message ?? {};
  // Who sent it and from which line, so the record, the Inbox and the
  // leaderboard agree (lib/sms-record on the browser side writes the same).
  // Talkr names the line on the message (from_number); an older Talkr does
  // not, and the row then carries only the sender.
  const { data: comm } = await admin.from('communications').upsert({
    workspace_id: row.workspace_id, seller_id: to.seller_id ?? null, buyer_id: to.buyer_id ?? null, vendor_id: to.vendor_id ?? null, deal_id: row.deal_id ?? null,
    channel: 'sms', direction: 'outbound', occurred_at: new Date().toISOString(), to_phone: phone, body,
    rep_id: userId, talkr_user_id: msg.created_by ?? null, from_phone: msg.from_number ?? null,
    status: msg.status || 'queued', source: 'talkr', source_id: 'msg:' + (msg.id ?? crypto.randomUUID()),
  }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
  return { ok: true, communication_id: (comm as Any)?.id ?? null, ...(carrierFixed ? { carrier_fixed: carrierFixed } : {}) };
}

/** The access code by text, for a recipient whose delivery is sms or both. */
export async function textCode(admin: SupabaseClient, row: Record<string, Any>, signer: Any, company: Company, code: string): Promise<TextResult> {
  return textRecipient(admin, row, signer, codeText(company.name, String(row.name ?? ''), code), row.created_by ?? null);
}

// -------------------------------------------------------------- deliveries
export type Delivered = { emailed: number; texted: number; failed: { id: number; reason: string }[] };

async function emailApprovers(admin: SupabaseClient, company: Company, row: Record<string, Any>, list: (Any & { url: string })[]): Promise<number> {
  const env = await signingResendEnv(admin, row.workspace_id as number);
  const from = transactionalFrom(env);
  if (!from) return 0;
  let sent = 0;
  for (const s of list) {
    if (!s.email) continue;
    const who = String(s.name ?? '').split(/\s+/)[0];
    const ok = await sendResend({
      to: s.email, from: from.from, subject: `Approval needed: ${row.name}`,
      text: `${who ? `${who}, ` : ''}${row.name} needs your approval before it goes out for signature.\n\nReview it: ${s.url}\n\nApprove or reject it from that page (or from the Contracts screen in CLOZR).`,
      html: `<p>${who ? `${esc(who)}, ` : ''}<strong>${esc(String(row.name))}</strong> needs your approval before it goes out for signature.</p><p><a href="${esc(s.url)}" style="display:inline-block;background:#0A8560;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Review and approve</a></p><p style="color:#71717a;font-size:13px">You can approve or reject it from that page, or from the Contracts screen in CLOZR.</p>`,
      replyTo: company.email || null, tags: { kind: 'signing_approval' },
    }, env);
    if (ok) sent++;
  }
  return sent;
}

/**
 * Send each recipient their link by the channel they chose: email, text, or
 * both. `approve` words it as an approval request.
 */
export async function deliverLinks(
  admin: SupabaseClient, row: Record<string, Any>, list: Any[], ctx: FlowCtx,
  opts: { reminder?: boolean; approve?: boolean; message?: string | null } = {},
): Promise<Delivered> {
  const out: Delivered = { emailed: 0, texted: 0, failed: [] };
  const withUrl = list.filter((s) => s.token).map((s) => ({ ...s, url: signUrl(ctx.origin, s.token) }));
  const mail = withUrl.filter((s) => wantsEmail(s));
  const cc = opts.approve ? [] : await ensureTcCc(admin, row);
  const mailEnv = await signingResendEnv(admin, row.workspace_id as number);
  const sender = await signingSender(admin, ctx.senderId ?? row.created_by ?? null);
  if (mail.length) {
    out.emailed = opts.approve
      ? await emailApprovers(admin, ctx.company, row, mail)
      : await emailSigners(ctx.company, String(row.name), opts.message ?? row.message ?? null, mail, { reminder: opts.reminder, expiresAt: row.expires_at, cc, contractId: row.id, env: mailEnv, sender });
  }
  for (const s of withUrl.filter((x) => wantsSms(x))) {
    const r = await textRecipient(admin, row, s, signingText({ company: ctx.company.name, name: s.name, doc: String(row.name ?? ''), url: s.url, reminder: opts.reminder, approve: opts.approve }), ctx.senderId ?? null);
    if (r.ok) out.texted++;
    else out.failed.push({ id: s.id, reason: r.reason });
  }
  return out;
}

/** In-app heads-up for approvers who are teammates (by user id, or by their email on the team). */
async function notifyTeamApprovers(admin: SupabaseClient, row: Record<string, Any>, approvers: Any[]) {
  const ids = new Set<string>(approvers.map((a) => a.user_id).filter(Boolean));
  const emails = approvers.filter((a) => !a.user_id && a.email).map((a) => String(a.email).toLowerCase());
  if (emails.length) {
    const { data: members } = await admin.from('workspace_members').select('user_id').eq('workspace_id', row.workspace_id);
    const memberIds = (members ?? []).map((m) => m.user_id as string);
    if (memberIds.length) {
      const { data: profiles } = await admin.from('profiles').select('id, email').in('id', memberIds);
      for (const p of profiles ?? []) if (p.email && emails.includes(String(p.email).toLowerCase())) ids.add(p.id);
    }
  }
  if (!ids.size) return;
  await admin.from('notifications').insert([...ids].map((user_id) => ({
    workspace_id: row.workspace_id, user_id, category: 'Contracts', title: `Approve ${row.name}`.slice(0, 120),
    body: 'It goes out for signature when you approve. Open Contracts → Awaiting approval.', seller_id: row.seller_id ?? null, deal_id: row.deal_id ?? null,
  })));
}

async function notifySender(admin: SupabaseClient, row: Record<string, Any>, title: string, body: string | null) {
  if (!row.created_by) return;
  await admin.from('notifications').insert({
    workspace_id: row.workspace_id, user_id: row.created_by, category: 'Contracts', title: title.slice(0, 120), body,
    seller_id: row.seller_id ?? null, deal_id: row.deal_id ?? null,
  });
}

// --------------------------------------------------------------------- send
export type Dispatch = { status: 'sent' | 'awaiting_approval'; emailed: number; texted: number; failed: { id: number; reason: string }[] };

/**
 * Send a contract. With an approver who has not approved, it goes to them
 * alone and waits in `awaiting_approval`; otherwise to whoever is up now
 * (signing-order sendTo), each by email, text or both.
 */
export async function dispatchSend(admin: SupabaseClient, row: Record<string, Any>, ctx: FlowCtx, message?: string | null): Promise<Dispatch> {
  const now = new Date().toISOString();
  let all = await loadRecipients(admin, row.id);
  const msg = message ?? row.message ?? null;
  if (needsApproval(all)) {
    // A second round after a rejection asks everyone who had not approved again.
    await admin.from('contract_signers').update({ status: 'pending', rejected_at: null, reject_reason: null }).eq('contract_id', row.id).eq('recipient_type', 'approver').eq('status', 'rejected');
    all = await loadRecipients(admin, row.id);
    await admin.from('contracts').update({
      status: 'awaiting_approval', approval_requested_at: now, approval_rejected_at: null, approval_rejected_reason: null, message: msg,
      last_event: { status: 'awaiting_approval', source: 'send', at: now },
    }).eq('id', row.id);
    const approvers = pendingApprovals(all);
    await logEvent(admin, row, 'approval_requested', { approvers: approvers.map((a) => a.name || a.email || a.label || a.role) }, ctx.who);
    const d = await deliverLinks(admin, row, approvers, ctx, { approve: true });
    try { await notifyTeamApprovers(admin, row, approvers); } catch (e) { console.error('approver notify', (e as Error).message); }
    return { status: 'awaiting_approval', ...d };
  }
  const hadApprovers = all.some((s) => s.recipient_type === 'approver');
  await admin.from('contracts').update({
    status: 'sent', sent_at: row.sent_at ?? now, message: msg, ...(hadApprovers ? { approved_at: now } : {}),
    last_event: { status: 'sent', source: 'send', at: now },
  }).eq('id', row.id);
  await logEvent(admin, row, 'sent', { source: hadApprovers ? 'approved' : 'send' }, ctx.who);
  await applySent(admin, row);
  const d = await deliverLinks(admin, { ...row, message: msg }, sendTo(all, row.signing_order_mode), ctx, { message: msg });
  if (d.failed.length) await logEvent(admin, row, 'delivery_failed', { failed: d.failed });
  return { status: 'sent', ...d };
}

// ---------------------------------------------------------------- approvals
export type ApprovalOut = { approved: boolean; sent: boolean; status: string; delivered?: Dispatch };

/** An approver answers. The last approval sends the document; a rejection puts it back to draft. */
export async function recordApproval(
  admin: SupabaseClient, row: Record<string, Any>, approver: Any, d: { approve: boolean; reason: string | null }, ctx: FlowCtx,
): Promise<ApprovalOut> {
  if (row.status !== 'awaiting_approval') throw new Error(`This document is ${row.status}; there is nothing to approve.`);
  if (approver.recipient_type !== 'approver') throw new Error('Only an approver can approve this document.');
  const now = new Date().toISOString();
  const who = approver.name || approver.email || approver.label || 'Approver';
  if (!d.approve) {
    await admin.from('contract_signers').update({ status: 'rejected', rejected_at: now, reject_reason: d.reason }).eq('id', approver.id);
    await admin.from('contracts').update({
      status: 'draft', approval_rejected_at: now, approval_rejected_reason: d.reason,
      last_event: { status: 'approval_rejected', source: 'approval', at: now, by: who, reason: d.reason },
    }).eq('id', row.id);
    await logEvent(admin, row, 'approval_rejected', { approver: who, reason: d.reason }, ctx.who);
    await logContractFeed(admin, row, `${who} rejected ${row.name}`, d.reason);
    await notifySender(admin, row, `${who} rejected ${row.name}`, `${d.reason ?? ''}\nIt is back to draft. Fix it and send again.`.trim());
    return { approved: false, sent: false, status: 'draft' };
  }
  await admin.from('contract_signers').update({ status: 'approved', approved_at: now, rejected_at: null, reject_reason: null }).eq('id', approver.id);
  await logEvent(admin, row, 'approved', { approver: who, note: d.reason }, ctx.who);
  const all = await loadRecipients(admin, row.id);
  if (needsApproval(all)) return { approved: true, sent: false, status: 'awaiting_approval' };
  await logContractFeed(admin, row, `${row.name} approved`, `${who} signed off; it went out for signature.`);
  const delivered = await dispatchSend(admin, row, { ...ctx, senderId: ctx.senderId ?? row.created_by ?? null });
  await notifySender(admin, row, `${row.name} approved and sent`, `${who} approved it. ${delivered.emailed + delivered.texted} link${delivered.emailed + delivered.texted === 1 ? '' : 's'} went out.`);
  return { approved: true, sent: true, status: delivered.status, delivered };
}

// --------------------------------------------------------------- delegation
export type DelegateInput = { name: string; email: string; phone?: string | null; reason: string | null; delivery?: string | null };

/**
 * Hand a signature to someone else. The new recipient takes the old one's
 * role, place in the order and type; the old row is closed as `delegated`
 * (its role renamed so the new person owns the signature line) and its link
 * stops working.
 */
export async function delegateRecipient(admin: SupabaseClient, row: Record<string, Any>, old: Any, input: DelegateInput, ctx: FlowCtx) {
  const now = new Date().toISOString();
  const phone = (input.phone ?? '').trim() || null;
  const delivery = normalizeDelivery(input.delivery ?? (phone && normalizeDelivery(old.delivery) !== 'email' ? old.delivery : 'email'));
  // Free the role first so the new row is the only live one holding it.
  await admin.from('contract_signers').update({
    role: delegatedRole(String(old.role), old.id), status: 'delegated', delegated_at: now, delegate_reason: input.reason,
    access_gate: null, access_code_hash: null, access_code_expires: null,
  }).eq('id', old.id);
  const { data: fresh, error } = await admin.from('contract_signers').insert({
    workspace_id: old.workspace_id, contract_id: old.contract_id, role: old.role, label: old.label, sort: old.sort,
    recipient_type: old.recipient_type ?? 'signer', name: input.name, email: input.email.trim().toLowerCase(), phone, delivery,
    delegated_from: old.id,
  }).select(SIGNER_COLS).single();
  if (error || !fresh) {
    // Put the old recipient back rather than leave the document with nobody in that seat.
    await admin.from('contract_signers').update({ role: old.role, status: old.status, delegated_at: null, delegate_reason: null }).eq('id', old.id);
    throw new Error(error?.message ?? 'could not add the new signer');
  }
  await admin.from('contract_signers').update({ delegated_to: fresh.id }).eq('id', old.id);
  await onDelegated(admin, old.id, fresh.id);
  const from = old.name || old.email || old.label || old.role;
  await logEvent(admin, row, 'delegated', {
    role: old.role, from: { id: old.id, name: old.name, email: old.email }, to: { id: fresh.id, name: fresh.name, email: fresh.email }, reason: input.reason,
  }, ctx.who);
  await logContractFeed(admin, row, `${from} handed ${row.name} to ${fresh.name}`, input.reason);
  await notifySender(admin, row, `${from} handed ${row.name} to ${fresh.name}`, [fresh.email, input.reason ? `Reason: ${input.reason}` : null].filter(Boolean).join(' · ') || null);
  let delivered: Delivered = { emailed: 0, texted: 0, failed: [] };
  if (['sent', 'viewed'].includes(row.status)) {
    const all = await loadRecipients(admin, row.id);
    if (sendTo(all, row.signing_order_mode).some((s) => s.id === fresh.id)) delivered = await deliverLinks(admin, row, [fresh], ctx);
  } else if (row.status === 'awaiting_approval' && fresh.recipient_type === 'approver') {
    delivered = await deliverLinks(admin, row, [fresh], ctx, { approve: true });
  }
  return { signer: fresh, delivered };
}

// ------------------------------------------------------- recipients mid-flow
export type NewRecipient = {
  name?: string | null; email?: string | null; phone?: string | null; label?: string | null;
  recipient_type?: string | null; delivery?: string | null; position?: number | null;
  seller_id?: number | null; buyer_id?: number | null; vendor_id?: number | null; user_id?: string | null;
};

const OPEN = ['draft', 'awaiting_approval', 'sent', 'viewed'];

/**
 * Add a recipient to a contract, before or after it goes out. Existing
 * signatures stay as they are; a signer added after sending signs on the
 * signature certificate (there is no signature line for them in the body)
 * and gets a link when it is their turn.
 */
export async function addRecipient(admin: SupabaseClient, row: Record<string, Any>, r: NewRecipient, ctx: FlowCtx) {
  if (!OPEN.includes(row.status)) throw new Error(`This document is ${row.status}; recipients can no longer change.`);
  const type = ['signer', 'cc', 'viewer', 'approver'].includes(String(r.recipient_type)) ? String(r.recipient_type) : 'signer';
  const email = (r.email ?? '').trim().toLowerCase() || null;
  const phone = (r.phone ?? '').trim() || null;
  const delivery = normalizeDelivery(r.delivery);
  if (!email && !(delivery !== 'email' && phoneE164(phone))) throw new Error('Add an email, or a mobile number to text the link to.');
  if (type === 'approver' && ['sent', 'viewed'].includes(row.status)) throw new Error('This document is already out for signature; an approver comes before sending.');
  const all = await loadRecipients(admin, row.id);
  const place = insertAt(all.filter((s) => s.status !== 'delegated'), r.position);
  for (const s of place.shift) await admin.from('contract_signers').update({ sort: s.sort }).eq('id', s.id);
  const n = all.filter((s) => String(s.role).startsWith('added')).length + 1;
  const label = (r.label ?? '').trim() || (type === 'cc' ? 'CC' : type === 'viewer' ? 'Viewer' : type === 'approver' ? 'Approver' : 'Signer');
  const { data: fresh, error } = await admin.from('contract_signers').insert({
    workspace_id: row.workspace_id, contract_id: row.id, role: `added${n}`, label, sort: place.sort,
    recipient_type: type, name: (r.name ?? '').trim() || null, email, phone, delivery,
    seller_id: r.seller_id ?? null, buyer_id: r.buyer_id ?? null, vendor_id: r.vendor_id ?? null, user_id: r.user_id ?? null,
  }).select(SIGNER_COLS).single();
  if (error || !fresh) throw new Error(error?.message ?? 'could not add the recipient');
  await logEvent(admin, row, 'recipient_added', { id: fresh.id, type, label, name: fresh.name, email: fresh.email, sort: place.sort, after_send: !!row.sent_at }, ctx.who);
  let delivered: Delivered = { emailed: 0, texted: 0, failed: [] };
  if (['sent', 'viewed'].includes(row.status)) {
    const now = await loadRecipients(admin, row.id);
    if (sendTo(now, row.signing_order_mode).some((s) => s.id === fresh.id)) delivered = await deliverLinks(admin, row, [fresh], ctx);
  } else if (row.status === 'awaiting_approval' && type === 'approver') {
    delivered = await deliverLinks(admin, row, [fresh], ctx, { approve: true });
  }
  return { signer: fresh, delivered };
}

const mintToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Fix a recipient's name, email, phone or delivery (the typo'd address), and
 * optionally send them their link again. A new email or phone gets a fresh
 * link: whatever went to the wrong address stops working.
 */
export async function updateRecipient(
  admin: SupabaseClient, row: Record<string, Any>, s: Any,
  patch: { name?: string | null; email?: string | null; phone?: string | null; delivery?: string | null; resend?: boolean },
  changed: string[], ctx: FlowCtx,
) {
  if (!OPEN.includes(row.status)) throw new Error(`This document is ${row.status}; recipients can no longer change.`);
  if (['signed', 'approved', 'delegated'].includes(String(s.status)) && changed.some((c) => c !== 'name')) throw new Error('They have already answered; their email and phone stay as signed.');
  const up: Record<string, unknown> = {};
  if (changed.includes('name')) up.name = (patch.name ?? '').trim() || null;
  if (changed.includes('email')) up.email = (patch.email ?? '').trim().toLowerCase() || null;
  if (changed.includes('phone')) up.phone = (patch.phone ?? '').trim() || null;
  if (patch.delivery !== undefined && normalizeDelivery(patch.delivery) !== normalizeDelivery(s.delivery)) { up.delivery = normalizeDelivery(patch.delivery); changed = [...changed, 'delivery']; }
  if (changed.includes('email') || changed.includes('phone')) {
    Object.assign(up, { token: mintToken(), access_gate: null, access_code_hash: null, access_code_expires: null, email_verified_at: null, phone_verified_at: null });
  }
  let cur = s;
  if (Object.keys(up).length) {
    const { data, error } = await admin.from('contract_signers').update(up).eq('id', s.id).select(SIGNER_COLS).single();
    if (error || !data) throw new Error(error?.message ?? 'could not update the recipient');
    cur = data;
    await logEvent(admin, row, 'recipient_updated', {
      id: s.id, changed, before: { name: s.name, email: s.email, phone: s.phone, delivery: s.delivery }, after: { name: cur.name, email: cur.email, phone: cur.phone, delivery: cur.delivery },
    }, ctx.who);
  }
  let delivered: Delivered = { emailed: 0, texted: 0, failed: [] };
  if (patch.resend) {
    const all = await loadRecipients(admin, row.id);
    const upNow = row.status === 'awaiting_approval' ? pendingApprovals(all) : ['sent', 'viewed'].includes(row.status) ? sendTo(all, row.signing_order_mode) : [];
    if (!upNow.some((x) => x.id === cur.id)) throw new Error(row.status === 'draft' ? 'Send the document first.' : 'It is not their turn yet; they get the link when it is.');
    delivered = await deliverLinks(admin, row, [cur], ctx, { approve: cur.recipient_type === 'approver' });
    await logEvent(admin, row, 'link_resent', { id: cur.id, emailed: delivered.emailed, texted: delivered.texted }, ctx.who);
  }
  return { signer: cur, delivered };
}
