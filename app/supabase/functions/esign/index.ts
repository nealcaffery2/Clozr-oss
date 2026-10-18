/**
 * POST /esign — the public signing door. No login: the one-time token in the
 * signing link is the credential, so this function runs with verify_jwt off
 * and does every check itself.
 *
 * Body: { action, token, ... }
 *   view     → { contract: { name, kind, status, html, expires_at }, signer, others, company }
 *   sign     { name, signature_png?, consent: true }   → { ok, completed, pdf_url? }
 *   decline  { reason? }
 *   pdf      → { url } (signed URL, 10 minutes)
 *   request_code / unlock  { channel: 'sms', phone }  the code by text, for a recipient whose delivery is sms or both
 *   approve  { note? } / reject { reason }  an approver's answer (migration 114)
 *   delegate { name, email, phone?, reason }  hand this signature to someone else → { ok, name }
 *
 * PDF overlay contracts (contract.mode === 'pdf', _shared/pdf-contracts.ts):
 *   fields       → { fields, source_url }  this recipient's fields, plus others' filled values read-only
 *   fields_save  { values: [{ id, value }] } → { ok, saved }  one field_filled event per batch
 *   fill_done    { consent: true }          → { ok, completed, pdf_url?, waiting_on }  a form filler is finished
 *   sign on a PDF contract also needs every required field filled, and stamps the date-signed boxes.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS } from '../_shared/security.ts';
import { type Any, completeContract, emailSigners, loadCompany, logContractFeed, logEvent, notifySigned, parse, signUrl, toHtml } from '../_shared/docs.ts';
import { allSigned, canSignNow, isDone, signs, turn } from '../_shared/signing-order.ts';
import { approvalDecision, maskPhone, normalizeDelivery, phoneGateOk, phoneKey, phonesMatch } from '../_shared/docs-people.ts';
import { delegateRecipient, deliverLinks, loadRecipients, recordApproval, textCode } from '../_shared/docs-flow.ts';
import { afterTurn, saveSignerValues, signerFields, stampDateSigned } from '../_shared/pdf-contracts.ts';
import { effectiveReadOnly } from '../_shared/pdf-fields.ts';
import { sendResend, transactionalFrom } from '../_shared/resend.ts';
import { publishContract } from '../_shared/contract-webhooks.ts';
// PandaDoc parity (docs-parity): origin allow-list, access codes enforced, decline notice, new field types.
import { authNeeded, makeGate, safeOrigin } from '../_shared/parity/security.ts';
import { notifyDeclined } from '../_shared/parity/notify.ts';
import { blockers, computeFormulas, type LogicField, radioSiblings, validateParity } from '../_shared/parity/field-logic.ts';
import {
  addViewSeconds, codeFresh, emailsMatch, firstViewNotice, gateOk, hashAccessCode, maskEmail, mintCode, mintGate,
  signedBody, signedTitle, viewedBody, viewedTitle,
} from '../_shared/esign-session.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

/**
 * The sender hears the first time a seller or buyer opens their link. A text
 * carrying the link has no read receipt; this open is the one CLOZR gets, and
 * the Inbox and the record show it as "Viewed" on that text too.
 */
async function notifyFirstView(admin: Any, row: Any, signer: Any, at: string): Promise<void> {
  const notice = firstViewNotice(row, signer, at);
  if (!notice) return;
  const { error } = await admin.from('notifications').insert({
    workspace_id: row.workspace_id, user_id: notice.user_id, category: 'Contracts', title: notice.title, body: notice.body,
    seller_id: row.seller_id ?? null, deal_id: row.deal_id ?? null,
  });
  if (error) console.error('first view notice', error.message);
}

/** A notary link is a different token. Same rule: only the emailed address opens it, then they apply the seal on file. */
async function notaryDoor(admin: Any, b: Any, token: string): Promise<Response> {
  const { data: reqRow } = await admin.from('notary_requests').select('*').eq('token', token).maybeSingle();
  if (!reqRow) return json({ error: 'This signing link is not valid.' }, 404);
  const { data: contract } = reqRow.contract_id
    ? await admin.from('contracts').select('id, name, workspace_id, deal_id, seller_id, buyer_id').eq('id', reqRow.contract_id).maybeSingle()
    : { data: null };
  const { data: member } = reqRow.notary_user_id
    ? await admin.from('workspace_members').select('notary_stamp_svg, notary_state, role').eq('workspace_id', reqRow.workspace_id).eq('user_id', reqRow.notary_user_id).maybeSingle()
    : { data: null };
  const hint = reqRow.emailed_to ? maskEmail(String(reqRow.emailed_to)) : null;
  if (b.action === 'request_code' || b.action === 'notary_code') {
    if (!emailsMatch(reqRow.emailed_to, b.email)) return json({ error: 'That email is not authorized to notarize this document.' }, 403);
    const from = transactionalFrom();
    if (!from) return json({ error: 'We could not email an access code.' }, 503);
    const code = mintCode();
    await admin.from('notary_requests').update({
      access_code_hash: await hashAccessCode(reqRow.id, code),
      access_code_expires: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq('id', reqRow.id);
    const ok = await sendResend({
      to: String(reqRow.emailed_to), from: from.from, subject: `Code to stamp ${contract?.name ?? 'document'}`,
      text: `Your notary code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your code to apply your seal is</p><p style="font-size:28px;letter-spacing:4px;font-weight:700">${code}</p>`,
      tags: { kind: 'notary_code' },
    });
    if (!ok) return json({ error: 'We could not email the code to that address.' }, 502);
    return json({ ok: true, hint });
  }
  if (b.action === 'unlock' || b.action === 'notary_unlock') {
    if (!emailsMatch(reqRow.emailed_to, b.email)) return json({ error: 'That email is not authorized to notarize this document.' }, 403);
    if (!codeFresh(reqRow.access_code_expires)) return json({ error: 'That code has expired. Request a new one.' }, 403);
    if (await hashAccessCode(reqRow.id, String(b.code ?? '')) !== reqRow.access_code_hash) return json({ error: 'That code does not match.' }, 403);
    const gate = mintGate();
    await admin.from('notary_requests').update({ access_gate: gate, email_verified_at: new Date().toISOString(), access_code_hash: null }).eq('id', reqRow.id);
    return json({ locked: false, gate, contract: { name: contract?.name ?? 'Document' }, stamp: member?.notary_stamp_svg ?? null, status: reqRow.status, state: member?.notary_state ?? null });
  }
  if (b.action === 'view' || b.action === 'notary_view') {
    if (!gateOk({ email: reqRow.emailed_to, access_gate: reqRow.access_gate, email_verified_at: reqRow.email_verified_at }, b.gate)) {
      return json({ locked: true, hint, contract: { name: contract?.name ?? 'Document' }, notary: true });
    }
    return json({ locked: false, contract: { name: contract?.name ?? 'Document' }, stamp: member?.notary_stamp_svg ?? null, status: reqRow.status, state: member?.notary_state ?? null });
  }
  if (b.action === 'stamp' || b.action === 'notary_stamp') {
    if (!gateOk({ email: reqRow.emailed_to, access_gate: reqRow.access_gate, email_verified_at: reqRow.email_verified_at }, b.gate)) {
      return json({ error: 'Confirm your notary email before applying the seal.' }, 403);
    }
    if (reqRow.status === 'stamped') return json({ ok: true, already: true });
    if (!member?.notary_stamp_svg) return json({ error: 'This notary has no seal on file. Add the state and commission expiration in Settings.' }, 422);
    const now = new Date().toISOString();
    await admin.from('notary_requests').update({ status: 'stamped', stamped_at: now }).eq('id', reqRow.id);
    if (reqRow.contract_id) {
      await admin.from('contracts').update({ notary_status: 'stamped', notarized_at: now }).eq('id', reqRow.contract_id);
      await admin.from('deal_files').update({ notary_status: 'stamped', needs_notary: true, notary_mode: 'digital' }).eq('contract_id', reqRow.contract_id);
    }
    const feedRow = { workspace_id: reqRow.workspace_id, seller_id: contract?.seller_id ?? null, buyer_id: contract?.buyer_id ?? null, deal_id: contract?.deal_id ?? reqRow.deal_id };
    await logContractFeed(admin, feedRow, 'Notary stamped', `${contract?.name ?? 'Document'} · digital seal applied ${now}`);
    return json({ ok: true });
  }
  return json({ error: 'This signing link is not valid.' }, 404);
}

// ---------------------------------------------------------------- parity
const PARITY_TYPES = new Set(['radio', 'email', 'phone', 'attachment', 'stamp', 'formula']);
const FIELD_LOGIC_COLS = 'id, signer_id, type, required, read_only, variable_key, value, label, page, x, y, field_key, group_key, conditions, formula, validation, options';

/** Required-field check with conditions, radio groups and checkbox-group counts (replaces pdf-contracts unfinished). */
async function parityUnfinished(admin: Any, row: Any, signerId: number): Promise<string | null> {
  const { data } = await admin.from('contract_fields').select(FIELD_LOGIC_COLS).eq('contract_id', row.id);
  const left = blockers((data ?? []) as LogicField[], signerId);
  if (!left.length) return null;
  const pages = [...new Set(left.map((f) => f.page).filter(Boolean))].sort((a, z) => Number(a) - Number(z));
  return `${left.length} required item${left.length === 1 ? ' is' : 's are'} still open (page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}): ${left.slice(0, 3).map((l) => `${l.label} (${l.reason})`).join('; ')}${left.length > 3 ? '...' : ''}`;
}

/**
 * Base types go through pdf-contracts saveSignerValues unchanged. The new
 * types (radio, email, phone, attachment, stamp) are validated here, radio
 * siblings are cleared, and formulas are recomputed after every save.
 */
async function saveParityValues(admin: Any, row: Any, signer: Any, values: Array<{ id: unknown; value: unknown }>, who: { ip: string | null; user_agent: string | null }) {
  const { data: all } = await admin.from('contract_fields').select(FIELD_LOGIC_COLS).eq('contract_id', row.id);
  const fields = (all ?? []) as LogicField[];
  const byId = new Map(fields.map((f) => [Number(f.id), f]));
  const base: typeof values = [];
  const extra: Array<{ f: LogicField; value: string | null }> = [];
  for (const v of values) {
    const f = byId.get(Number(v.id));
    if (!f || !PARITY_TYPES.has(f.type)) { base.push(v); continue; }
    if (f.signer_id !== signer.id) return { ok: false as const, error: 'That field is not yours to fill.', field_id: Number(v.id) };
    if (effectiveReadOnly(f)) return { ok: false as const, error: `${f.label || 'That field'} is filled in for you.`, field_id: Number(f.id) };
    const r = validateParity(f, v.value);
    if (!r.ok) return { ok: false as const, error: r.error, field_id: Number(f.id) };
    extra.push({ f, value: r.value });
  }
  const out = base.length ? await saveSignerValues(admin, row, signer, base, who) : { ok: true as const, saved: [] as Array<{ id: number; value: string | null }> };
  if (!out.ok) return out;
  const now = new Date().toISOString();
  const saved = [...out.saved];
  for (const e of extra) {
    await admin.from('contract_fields').update({ value: e.value, filled_at: e.value == null ? null : now, filled_ip: e.value == null ? null : who.ip, filled_by: e.value == null ? null : signer.id }).eq('id', e.f.id).eq('signer_id', signer.id);
    saved.push({ id: Number(e.f.id), value: e.value });
    e.f.value = e.value;
    if (e.f.type === 'radio' && e.value === 'true') {
      for (const sib of radioSiblings(fields, e.f)) {
        if (!sib.value) continue;
        await admin.from('contract_fields').update({ value: null, filled_at: null, filled_ip: null, filled_by: null }).eq('id', sib.id);
        sib.value = null; saved.push({ id: Number(sib.id), value: null });
      }
    }
  }
  for (const s of out.saved) { const f = byId.get(s.id); if (f) f.value = s.value; }
  if (fields.some((f) => f.type === 'formula')) {
    for (const [id, value] of computeFormulas(fields)) {
      const f = byId.get(Number(id));
      if (f && (f.value ?? '') !== value) {
        await admin.from('contract_fields').update({ value: value || null, filled_at: value ? now : null }).eq('id', id);
        saved.push({ id: Number(id), value: value || null });
      }
    }
  }
  return { ok: true as const, saved };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const token = String(b.token ?? '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) return json({ error: 'This signing link is not valid.' }, 404);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
  const ua = req.headers.get('user-agent')?.slice(0, 300) ?? null;
  const { data: signer } = await admin.from('contract_signers').select('*').eq('token', token).maybeSingle();
  if (!signer) return notaryDoor(admin, b, token);
  // Handed to someone else: this link is dead; the person it went to has their own.
  if (signer.status === 'delegated') return json({ error: 'This document was handed to someone else to sign. Ask the sender if you still need it.' }, 410);
  const { data: row } = await admin.from('contracts').select('*').eq('id', signer.contract_id).maybeSingle();
  if (!row) return json({ error: 'This document no longer exists.' }, 404);
  const { data: all } = await admin.from('contract_signers').select('id, role, label, name, status, signed_at, signature_name, signature_png, consented_at, viewed_at, sort, recipient_type').eq('contract_id', row.id).order('sort');
  const who = { actor_type: 'signer' as const, actor_id: signer.email ?? null, signer_id: signer.id, ip, user_agent: ua };
  const mode = row.signing_order_mode ?? 'parallel';
  const rtype = String(signer.recipient_type ?? 'signer');
  // Sequential signing: someone earlier in the order still has to go first.
  const waitingOn = mode === 'sequential' && signs(signer) && !isDone(signer) && !canSignNow((all ?? []) as Any[], mode, signer.id)
    ? turn((all ?? []) as Any[], mode).map((s: Any) => s.label || s.role).join(', ')
    : null;
  const { company } = await loadCompany(admin, row.workspace_id);
  const expired = row.expires_at && new Date(row.expires_at).getTime() < Date.now() && row.status !== 'completed';
  const closed = ['voided', 'declined', 'completed', 'expired'].includes(row.status);

  const others = (all ?? []).filter((s) => s.id !== signer.id && s.status !== 'delegated').map((s) => ({
    role: s.role, label: s.label, name: s.name, status: s.status, recipient_type: String(s.recipient_type ?? 'signer'),
  }));
  const smsOk = normalizeDelivery(signer.delivery) !== 'email' && !!phoneKey(signer.phone);
  const view = () => json({
    locked: false,
    contract: { id: row.id, name: row.name, kind: row.kind, mode: row.mode ?? 'richtext', status: expired ? 'expired' : row.status, expires_at: row.expires_at, message: row.message, html: toHtml(parse(String(row.body_md ?? '')), (all ?? []) as Any[], { highlightRole: signer.role }) },
    signer: { id: signer.id, role: signer.role, label: signer.label, name: signer.name, email: signer.email, status: signer.status, signed_at: signer.signed_at, filled_at: signer.filled_at ?? null, recipient_type: rtype, waiting_on: waitingOn },
    order: mode,
    others, company: { name: company.name, legal: company.legal, address: company.address, email: company.email, phone: company.phone },
  });
  // The link alone opens the document unless the sender (or the template) asked
  // for an access code, per document or per recipient (PandaDoc recipient authentication).
  const requireGate = makeGate(row, signer, b.gate, json);
  const authMode = authNeeded(row, signer);
  const markOpened = async () => {
    const now = new Date().toISOString();
    const firstLook = !signer.viewed_at;
    if (!firstLook) {
      if (!signer.view_open_at) await admin.from('contract_signers').update({ view_open_at: now, ip, user_agent: ua }).eq('id', signer.id);
      return;
    }
    await admin.from('contract_signers').update({
      status: signer.status === 'pending' ? 'viewed' : signer.status,
      viewed_at: now, view_open_at: now, ip, user_agent: ua,
    }).eq('id', signer.id);
    signer.status = signer.status === 'pending' ? 'viewed' : signer.status;
    signer.viewed_at = now;
    if (closed || expired) return;
    if (row.status === 'sent') {
      row.status = 'viewed';
      await admin.from('contracts').update({ status: 'viewed', viewed_at: row.viewed_at ?? now, last_event: { status: 'viewed', source: 'esign', at: now } }).eq('id', row.id);
    }
    await logEvent(admin, row, 'viewed', { signer: signer.role, email: signer.email, ip }, who);
    publishContract(admin, row, 'contract.viewed', { signer });
    await logContractFeed(admin, row, viewedTitle(signer.role), viewedBody({ name: signer.name, email: signer.email, at: now }));
    await notifyFirstView(admin, row, signer, now);
  };

  switch (b.action) {
    case 'view': {
      if (requireGate()) {
        // Locked: say which code to ask for, never the content.
        return json({ locked: true, auth: authMode, contract: { name: row.name, status: row.status }, hint: signer.email ? maskEmail(String(signer.email)) : null, sms: smsOk, phone_hint: smsOk ? maskPhone(signer.phone) : null, company: { name: company.name } });
      }
      await markOpened();
      return view();
    }
    case 'request_code': {
      if (b.channel === 'sms') {
        if (!smsOk) return json({ error: 'This document was not sent to a phone. Use the email it was sent to.' }, 403);
        if (!phonesMatch(signer.phone, b.phone)) {
          await logEvent(admin, row, 'access_denied', { reason: 'phone mismatch' }, who);
          return json({ error: 'That number is not the one this document was sent to.' }, 403);
        }
        const code = mintCode();
        await admin.from('contract_signers').update({ access_code_hash: await hashAccessCode(signer.id, code), access_code_expires: new Date(Date.now() + 10 * 60 * 1000).toISOString() }).eq('id', signer.id);
        const sent = await textCode(admin, row, signer, company, code);
        if (!sent.ok) return json({ error: `We could not text the code (${sent.reason}).${signer.email ? ' Use your email instead.' : ''}` }, 502);
        await logEvent(admin, row, 'code_sent', { channel: 'sms' }, who);
        return json({ ok: true, sent: true, hint: maskPhone(signer.phone) });
      }
      if (!signer.email) return json({ error: 'This signer has no authorized email. Ask the sender to set one.' }, 403);
      if (!emailsMatch(signer.email, b.email)) {
        await logEvent(admin, row, 'access_denied', { reason: 'email mismatch' }, who);
        return json({ error: 'That email is not authorized to open this document.' }, 403);
      }
      const from = transactionalFrom();
      if (!from) return json({ error: 'We could not email an access code. Ask the sender to try again.' }, 503);
      const code = mintCode();
      const hash = await hashAccessCode(signer.id, code);
      const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await admin.from('contract_signers').update({ access_code_hash: hash, access_code_expires: exp }).eq('id', signer.id);
      const ok = await sendResend({
        to: String(signer.email), from: from.from,
        subject: `Code to open ${row.name}`,
        text: `Your code is ${code}. It expires in 10 minutes. Only ${signer.email} can open this document.`,
        html: `<p>Your code to open <strong>${row.name}</strong> is</p><p style="font-size:28px;letter-spacing:4px;font-weight:700">${code}</p><p>It expires in 10 minutes. This inbox is the only one that can open it.</p>`,
        replyTo: company.email || null, tags: { kind: 'signing_code' },
      });
      if (!ok) return json({ error: 'We could not email the code to that address.' }, 502);
      await logEvent(admin, row, 'code_sent', { channel: 'email' }, who);
      return json({ ok: true, sent: true, hint: maskEmail(String(signer.email)) });
    }
    case 'unlock': {
      const bySms = b.channel === 'sms';
      if (bySms ? !(smsOk && phonesMatch(signer.phone, b.phone)) : !emailsMatch(signer.email, b.email)) return json({ error: bySms ? 'That number is not the one this document was sent to.' : 'That email is not authorized to open this document.' }, 403);
      if (!codeFresh(signer.access_code_expires)) return json({ error: 'That code has expired. Request a new one.' }, 403);
      const hash = await hashAccessCode(signer.id, String(b.code ?? ''));
      if (hash !== signer.access_code_hash) {
        await logEvent(admin, row, 'code_failed', {}, who);
        return json({ error: 'That code does not match. Check the email and try again.' }, 403);
      }
      const now = new Date().toISOString();
      const gate = mintGate();
      const firstLook = !signer.viewed_at;
      await admin.from('contract_signers').update({
        ...(bySms ? { phone_verified_at: now } : { email_verified_at: signer.email_verified_at ?? now }),
        access_gate: gate, access_code_hash: null, access_code_expires: null,
        status: signer.status === 'pending' ? 'viewed' : signer.status,
        viewed_at: signer.viewed_at ?? now, view_open_at: now, ip, user_agent: ua,
      }).eq('id', signer.id);
      if (firstLook && !closed) {
        if (row.status === 'sent') await admin.from('contracts').update({ status: 'viewed', viewed_at: row.viewed_at ?? now, last_event: { status: 'viewed', source: 'esign', at: now } }).eq('id', row.id);
        await logEvent(admin, row, 'viewed', { signer: signer.role, email: signer.email, ip }, who);
        publishContract(admin, row, 'contract.viewed', { signer });
        await logContractFeed(admin, row, viewedTitle(signer.role), viewedBody({ name: signer.name, email: signer.email, at: now }));
        await notifyFirstView(admin, row, signer, now);
      }
      signer.status = signer.status === 'pending' ? 'viewed' : signer.status;
      if (bySms) signer.phone_verified_at = now;
      else signer.email_verified_at = signer.email_verified_at ?? now;
      signer.access_gate = gate;
      const body = await view().json();
      return json({ ...body, gate });
    }
    case 'heartbeat': {
      const denied = requireGate();
      if (denied) return denied;
      const next = addViewSeconds(signer.view_open_at, Number(signer.view_seconds ?? 0));
      await admin.from('contract_signers').update(next).eq('id', signer.id);
      return json({ ok: true, view_seconds: next.view_seconds });
    }
    case 'sign': {
      const denied = requireGate();
      if (denied) return denied;
      if (closed) return json({ error: `This document is ${row.status} and can no longer be signed.` }, 409);
      if (expired) return json({ error: 'This document has expired. Ask the sender for a new one.' }, 409);
      if (row.status === 'draft') return json({ error: 'This document has not been sent for signature yet.' }, 409);
      if (row.status === 'awaiting_approval') return json({ error: 'This document is waiting on an internal approval before anyone signs.' }, 409);
      if (rtype === 'approver') return json({ error: 'You approve this document rather than sign it. Use Approve or Reject.' }, 409);
      if (signer.status === 'signed') return json({ ok: true, completed: row.status === 'completed' });
      if (!signs(signer)) return json({ error: rtype === 'cc' ? 'You are copied on this document and will get the signed copy. There is nothing for you to sign.' : 'You can read this document, but it is not yours to sign.' }, 409);
      if (waitingOn) return json({ error: `This document is signed in order. It is waiting on ${waitingOn} first; you will get an email when it is your turn.` }, 409);
      if (rtype === 'filler') return json({ error: 'You fill in fields on this document rather than sign it. Press Done when you have finished.' }, 409);
      if (b.consent !== true) return json({ error: 'Please agree to sign electronically first.' }, 422);
      const name = String(b.name ?? '').trim();
      if (name.length < 2) return json({ error: 'Type your full legal name.' }, 422);
      if (row.mode === 'pdf') {
        const left = await parityUnfinished(admin, row, signer.id);
        if (left) return json({ error: left }, 422);
        await stampDateSigned(admin, row, signer, ip);
      }
      let png: string | null = typeof b.signature_png === 'string' && b.signature_png.startsWith('data:image/png;base64,') ? b.signature_png : null;
      // Adopted once on this document (docs-public adopt): reuse it.
      if (!png && typeof signer.signature_png === 'string' && signer.adopted_at) png = signer.signature_png;
      if (png && png.length > 400_000) png = null;
      const now = new Date().toISOString();
      const viewed = addViewSeconds(signer.view_open_at, Number(signer.view_seconds ?? 0));
      await admin.from('contract_signers').update({ status: 'signed', signed_at: now, consented_at: now, signature_name: name, signature_png: png, name: signer.name || name, ip, user_agent: ua, view_seconds: viewed.view_seconds, view_open_at: null }).eq('id', signer.id);
      await logEvent(admin, row, 'consented', { signer: signer.role, disclosure: 'esign-v1' }, who);
      await logEvent(admin, row, 'signed', { signer: signer.role, name, email: signer.email, ip, drawn: !!png, view_seconds: viewed.view_seconds }, who);
      publishContract(admin, row, 'contract.signed', { signer: { ...signer, name: signer.name || name } });
      await logContractFeed(admin, row, signedTitle(signer.role), signedBody({ name: signer.name || name, email: signer.email, viewSeconds: viewed.view_seconds, signedAt: now }));
      try { await notifySigned(admin, row, signer); } catch (e) { console.error('notify', (e as Error).message); }

      const { data: rest } = await admin.from('contract_signers').select('id, role, label, name, email, status, sort, recipient_type, token').eq('contract_id', row.id).order('sort');
      const pending = (rest ?? []).filter((s) => signs(s) && !isDone(s) && s.status !== 'delegated');
      if (allSigned((rest ?? []) as Any[])) {
        // The signing links in the completion mail have to point back at the
        // site the signer is standing on, which this request knows and the
        // contract row does not.
        const origin = safeOrigin(b.origin, req.headers.get('origin'));
        const done = await completeContract(admin, row, company, origin);
        const { data: u } = done.path ? await admin.storage.from('contracts').createSignedUrl(done.path, 600) : { data: null };
        return json({ ok: true, completed: true, pdf_url: u?.signedUrl ?? null, redirect_url: row.redirect_url ?? null });
      }
      // Sequential: whoever is up next gets their link now.
      if (mode === 'sequential') {
        const origin = safeOrigin(b.origin, req.headers.get('origin'));
        // Each by the channel they chose (docs-flow deliverLinks: email, text or both).
        const nextUp = turn(await loadRecipients(admin, row.id), mode).filter((s: Any) => s.email || s.phone);
        if (nextUp.length && origin) {
          try {
            await deliverLinks(admin, row, nextUp, { company, origin, who: {}, senderId: row.created_by ?? null });
            await admin.from('contract_signers').update({ last_reminded_at: null }).in('id', nextUp.map((s: Any) => s.id));
            await logEvent(admin, row, 'turn', { next: nextUp.map((s: Any) => s.label || s.role) });
          } catch (e) { console.error('next signer', (e as Error).message); }
        }
      }
      return json({ ok: true, completed: false, waiting_on: pending.length, redirect_url: row.redirect_url ?? null });
    }
    case 'decline': {
      const denied = requireGate();
      if (denied) return denied;
      if (!signs(signer)) return json({ error: 'Only a signer can decline this document.' }, 409);
      if (closed) return json({ error: `This document is already ${row.status}.` }, 409);
      const now = new Date().toISOString();
      await admin.from('contract_signers').update({ status: 'declined', declined_at: now, decline_reason: String(b.reason ?? '').slice(0, 500) || null, ip, user_agent: ua }).eq('id', signer.id);
      await admin.from('contracts').update({ status: 'declined', last_event: { status: 'declined', source: 'esign', at: now, signer: signer.role } }).eq('id', row.id);
      await logEvent(admin, row, 'declined', { signer: signer.role, reason: b.reason ?? null }, who);
      publishContract(admin, row, 'contract.declined', { signer, reason: b.reason ?? null });
      await logContractFeed(admin, row, `${signer.label || signer.role} declined`, String(b.reason ?? ''));
      try { await notifyDeclined(admin, row, company, signer, String(b.reason ?? '') || null, safeOrigin(b.origin, req.headers.get('origin'))); } catch (e) { console.error('decline notice', (e as Error).message); }
      return json({ ok: true });
    }
    case 'approve':
    case 'reject': {
      const denied = requireGate();
      if (denied) return denied;
      const d = approvalDecision(b.action, b.action === 'reject' ? b.reason : b.note);
      if (!d.ok) return json({ error: d.message }, 422);
      if (rtype !== 'approver') return json({ error: 'Only an approver can approve this document.' }, 403);
      if (expired) return json({ error: 'This document has expired.' }, 409);
      try {
        const origin = safeOrigin(b.origin, req.headers.get('origin'));
        const out = await recordApproval(admin, row, signer, d, { company, origin, who, senderId: row.created_by ?? null });
        return json({ ok: true, ...out, delivered: undefined });
      } catch (e) {
        return json({ error: (e as Error).message }, 409);
      }
    }
    case 'delegate': {
      const denied = requireGate();
      if (denied) return denied;
      if (closed || expired) return json({ error: `This document is ${expired ? 'expired' : row.status}.` }, 409);
      if (signer.status === 'signed' || signer.status === 'approved') return json({ error: 'You have already answered; there is nothing to hand over.' }, 409);
      if (!signs(signer) && rtype !== 'approver') return json({ error: 'Only a signer or approver can hand this to someone else.' }, 409);
      if (row.allow_reassign === false) return json({ error: 'The sender turned off reassigning for this document. Reply to the email to ask them.' }, 403);
      const name = String(b.name ?? '').trim();
      const email = String(b.email ?? '').trim().toLowerCase();
      if (name.length < 2) return json({ error: 'Their full name, please.' }, 422);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email for them, please.' }, 422);
      if (emailsMatch(signer.email, email)) return json({ error: 'That is your own email. Enter the person who should sign instead.' }, 422);
      const reason = String(b.reason ?? '').trim().slice(0, 500) || null;
      if (!reason) return json({ error: 'Say why, so the sender knows.' }, 422);
      try {
        const origin = safeOrigin(b.origin, req.headers.get('origin'));
        const out = await delegateRecipient(admin, row, signer, { name, email, phone: String(b.phone ?? '').trim() || null, reason }, { company, origin, who, senderId: row.created_by ?? null });
        return json({ ok: true, name: out.signer.name, emailed: out.delivered.emailed, texted: out.delivered.texted });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }
    case 'fields': {
      const denied = requireGate();
      if (denied) return denied;
      if (row.mode !== 'pdf') return json({ fields: [], source_url: null });
      return json(await signerFields(admin, row, signer));
    }
    case 'fields_save': {
      const denied = requireGate();
      if (denied) return denied;
      if (row.mode !== 'pdf') return json({ error: 'This document has no fields to fill.' }, 409);
      if (closed) return json({ error: `This document is ${row.status} and can no longer be changed.` }, 409);
      if (expired) return json({ error: 'This document has expired. Ask the sender for a new one.' }, 409);
      if (row.status === 'draft') return json({ error: 'This document has not been sent yet.' }, 409);
      if (!signs(signer) || isDone(signer)) return json({ error: 'There is nothing left for you to fill on this document.' }, 409);
      if (waitingOn) return json({ error: `This document is filled in order. It is waiting on ${waitingOn} first.` }, 409);
      const out = await saveParityValues(admin, row, signer, Array.isArray(b.values) ? b.values : [], { ip, user_agent: ua });
      return out.ok ? json(out) : json({ error: out.error, field_id: out.field_id ?? null }, 422);
    }
    case 'fill_done': {
      const denied = requireGate();
      if (denied) return denied;
      if (rtype !== 'filler') return json({ error: 'Only a form filler finishes with Done. Signers sign the document.' }, 409);
      if (closed) return json({ error: `This document is ${row.status} and can no longer be changed.` }, 409);
      if (expired) return json({ error: 'This document has expired. Ask the sender for a new one.' }, 409);
      if (row.status === 'draft') return json({ error: 'This document has not been sent yet.' }, 409);
      if (signer.status === 'filled') return json({ ok: true, completed: row.status === 'completed' });
      if (waitingOn) return json({ error: `This document is filled in order. It is waiting on ${waitingOn} first.` }, 409);
      if (b.consent !== true) return json({ error: 'Please agree to do this electronically first.' }, 422);
      const left = row.mode === 'pdf' ? await parityUnfinished(admin, row, signer.id) : null;
      if (left) return json({ error: left }, 422);
      const now = new Date().toISOString();
      const viewed = addViewSeconds(signer.view_open_at, Number(signer.view_seconds ?? 0));
      await admin.from('contract_signers').update({ status: 'filled', filled_at: now, consented_at: signer.consented_at ?? now, ip, user_agent: ua, view_seconds: viewed.view_seconds, view_open_at: null }).eq('id', signer.id);
      await logEvent(admin, row, 'consented', { signer: signer.role, disclosure: 'esign-v1', filler: true }, who);
      await logEvent(admin, row, 'filled', { signer: signer.role, name: signer.name, email: signer.email, ip, view_seconds: viewed.view_seconds }, who);
      await logContractFeed(admin, row, `${signer.label || signer.role} filled in their fields`, [signer.name, signer.email].filter(Boolean).join(' · ') || null);
      const origin = safeOrigin(b.origin, req.headers.get('origin'));
      return json({ ok: true, ...(await afterTurn(admin, row, company, origin)) });
    }
    case 'pdf': {
      const denied = requireGate();
      if (denied) return denied;
      if (!row.pdf_path) return json({ error: 'no PDF yet' }, 404);
      const { data, error } = await admin.storage.from('contracts').createSignedUrl(row.pdf_path, 600);
      if (error || !data) return json({ error: 'could not fetch the PDF' }, 500);
      await logEvent(admin, row, 'downloaded', { by: signer.role }, who);
      return json({ url: data.signedUrl });
    }
    default: return json({ error: 'unknown action' }, 400);
  }
});
