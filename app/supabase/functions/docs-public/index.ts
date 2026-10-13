/**
 * POST /docs-public  (verify_jwt OFF; every action checks its own credential)
 *
 * Public-facing PandaDoc features that sit next to the signing page:
 *
 * Forms (PandaDoc Forms / PowerForms): a public link that creates a fresh
 * document from a template for whoever opens it.
 *   form_view   { slug }                         → { form: { name, intro, template, fields_preview } }
 *   form_start  { slug, name, email, phone? }    → { token }  creates the contract (visitor signs first,
 *               fixed recipients after), access code REQUIRED, then the page moves to /sign/?t=token
 *               where the existing esign request_code / unlock flow verifies the email.
 *
 * Signer extras (credential: the 48-hex signing token + gate when the document requires a code):
 *   adopt              { token, gate?, signature_png?, typed_name?, font?, initials_png? }  adopt once,
 *                      fill every signature / initials box of mine in one go (PDF mode)
 *   attachment_upload  { token, gate?, field_id?, label?, filename, content_type, data_base64 }  ≤ 25MB
 *   attachments        { token, gate? }
 *   comment_add        { token, gate?, body, page?, anchor? }   visible to the sender's team
 *   comments           { token, gate? }                         this recipient's thread (non-internal only)
 *
 * Anyone:
 *   verify  { sha256 }  → chain + PDF integrity, signer names and dates, completed
 *           documents only. Only someone holding the executed file (or its hash) learns who signed it;
 *           the CLZ- reference is time-based and guessable, so it is not a lookup key here.
 *           The /verify page hashes the file in the browser and sends only the hash.
 *
 * Every action is rate limited per caller IP (public.rate_limit_hit), and per
 * signing link for the signer extras.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, clientIp, rateLimit } from '../_shared/security.ts';
import { type Any, createContract, loadCompany, loadParties, logEvent, partySigner } from '../_shared/docs.ts';
import { canSignNow, isDone, signs } from '../_shared/signing-order.ts';
import { createPdfContract } from '../_shared/pdf-contracts.ts';
import { makeGate, safeOrigin } from '../_shared/parity/security.ts';
import { verifyContract } from '../_shared/parity/certificate.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

const MAX_UPLOADS_PER_SIGNER = 20;
// Per caller IP: [limit, window seconds].
const IP_LIMITS: Record<string, [number, number]> = {
  form_view: [60, 60], form_start: [10, 3600], verify: [20, 60],
  adopt: [20, 60], attachment_upload: [20, 3600], attachments: [60, 60], comment_add: [20, 3600], comments: [60, 60],
};

/** The first bytes match the declared type (PDF, PNG, JPEG); other allowed types pass on the declared type. */
function bytesMatch(ct: string, b: Uint8Array): boolean {
  const head = (n: number) => Array.from(b.slice(0, n));
  if (ct === 'application/pdf') return String.fromCharCode(...head(5)) === '%PDF-';
  if (ct === 'image/png') return head(4).join() === [0x89, 0x50, 0x4e, 0x47].join();
  if (ct === 'image/jpeg') return head(3).join() === [0xff, 0xd8, 0xff].join();
  return true;
}

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/^data:[^,]+,/, '')), (c) => c.charCodeAt(0));
async function sha(bytes: Uint8Array) {
  const buf = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

async function signerByToken(admin: SupabaseClient, token: string) {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const { data: signer } = await admin.from('contract_signers').select('*').eq('token', token).maybeSingle();
  if (!signer || signer.status === 'delegated') return null;
  const { data: row } = await admin.from('contracts').select('*').eq('id', signer.contract_id).is('deleted_at', null).maybeSingle();
  if (!row) return null;
  return { signer, row };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const ip = clientIp(req);
  const ua = req.headers.get('user-agent')?.slice(0, 300) ?? null;
  const limit = IP_LIMITS[String(b.action)];
  if (!limit) return json({ error: 'unknown action' }, 400);
  const hit = await rateLimit(admin, `docs-public:${b.action}:${ip}`, limit[0], limit[1]);
  if (!hit.allowed) return json({ error: 'Too many requests. Try again shortly.' }, 429);

  try {
    // ------------------------------------------------------------ forms
    if (b.action === 'form_view' || b.action === 'form_start') {
      const { data: form } = await admin.from('doc_forms').select('*, template:doc_templates(id, name, kind, mode, signers, body_md, pdf_path, default_expiry_days, reminder_policy, default_signing_order, workspace_id, version)')
        .eq('slug', String(b.slug ?? '')).maybeSingle();
      const live = form && form.active && (!form.expires_at || new Date(form.expires_at).getTime() > Date.now()) && (form.max_uses == null || form.uses < form.max_uses);
      if (!live) return json({ error: 'This form is closed or the link is wrong.' }, 404);
      const { company } = await loadCompany(admin, form.workspace_id);
      if (b.action === 'form_view') {
        return json({ form: { name: form.name, intro: form.intro, template: { name: form.template.name, kind: form.template.kind }, company: { name: company.name, address: company.address, phone: company.phone } } });
      }
      const name = String(b.name ?? '').trim();
      const email = String(b.email ?? '').trim().toLowerCase();
      if (name.length < 2 || !EMAIL.test(email)) return json({ error: 'Your full name and a valid email, please.' }, 422);
      // Abuse brake on top of the per-IP limit: 5 starts per IP per hour per form,
      // and 200 a day per form whoever starts them.
      const perForm = await rateLimit(admin, `docs-public:form:${form.id}:${ip}`, 5, 3600);
      const perDay = await rateLimit(admin, `docs-public:form:${form.id}`, 200, 86400);
      if (!perForm.allowed || !perDay.allowed) return json({ error: 'Too many attempts. Try again in an hour.' }, 429);
      // Claim a use before creating anything; a lost race (same uses value) asks to retry.
      const { data: claimed } = await admin.from('doc_forms').update({ uses: form.uses + 1 }).eq('id', form.id).eq('uses', form.uses).select('id');
      if (!claimed?.length) return json({ error: 'Busy. Try again.' }, 409);

      const ids = { dealId: form.deal_id ?? null };
      const parties = await loadParties(admin, form.workspace_id, ids);
      const t = form.template;
      const tplSigners = (t.signers ?? []) as Any[];
      const fixed = (form.fixed_recipients ?? []) as Any[];
      const signers = tplSigners
        .filter((s) => s.role === form.public_role || fixed.some((f) => f.role === s.role))
        .map((s) => s.role === form.public_role
          ? { role: s.role, label: s.label, name, email, phone: b.phone ?? null, recipient_type: 'signer' }
          : { ...partySigner(s, { ...parties, company }), ...fixed.find((f) => f.role === s.role) });
      const origin = safeOrigin(b.origin, req.headers.get('origin'));
      const common = {
        ws: form.workspace_id, userId: form.created_by, origin, ids, signers,
        name: `${t.name} - ${name}`, message: null, expiresDays: t.default_expiry_days ?? 30,
        // Created and sent, but the visitor's own link is not emailed: they are on the page already.
        send: true, email: false, orderMode: 'sequential' as const, reminders: t.reminder_policy ?? null, parties, company,
      };
      const out: Any = t.mode === 'pdf'
        ? await createPdfContract(admin, { ...common, template: t, kind: t.kind })
        : await createContract(admin, { ...common, template: t, tokens: [] });
      const row = out.contract;
      await admin.from('contracts').update({ form_id: form.id, require_access_code: form.require_email_code, redirect_url: form.redirect_url ?? null }).eq('id', row.id);
      // Visitor first in the order so fixed countersigners get their link only after.
      const visitor = (out.signers as Any[]).find((s) => s.role === form.public_role);
      await admin.from('contract_signers').update({ sort: 0, auth_mode: form.require_email_code ? 'email_code' : 'link' }).eq('id', visitor.id);
      await logEvent(admin, row, 'form_started', { form_id: form.id, email }, { actor_type: 'signer', actor_id: email, signer_id: visitor.id, ip, user_agent: ua });
      const { data: tok } = await admin.from('contract_signers').select('token').eq('id', visitor.id).single();
      return json({ ok: true, token: tok?.token });
    }

    if (b.action === 'verify') {
      if (!/^[a-f0-9]{64}$/i.test(String(b.sha256 ?? ''))) return json({ error: 'Upload the signed PDF to check it.' }, 422);
      return json(await verifyContract(admin, { sha256: String(b.sha256).toLowerCase() }));
    }

    // ------------------------------------------------------ signer extras
    const found = await signerByToken(admin, String(b.token ?? ''));
    if (!found) return json({ error: 'This signing link is not valid.' }, 404);
    const perLink = await rateLimit(admin, `docs-public:link:${found.signer.id}`, 120, 3600);
    if (!perLink.allowed) return json({ error: 'Too many requests. Try again shortly.' }, 429);
    const { signer, row } = found;
    const gate = makeGate(row, signer, b.gate, json);
    const denied = gate();
    if (denied) return denied;
    const who = { actor_type: 'signer' as const, actor_id: signer.email ?? null, signer_id: signer.id, ip, user_agent: ua };
    const closed = ['voided', 'declined', 'completed', 'expired'].includes(row.status);

    switch (b.action) {
      case 'adopt': {
        if (closed) return json({ error: `This document is ${row.status}.` }, 409);
        // Same rules as esign sign: only someone who signs, before they are done, on their turn.
        const { data: all } = await admin.from('contract_signers').select('*').eq('contract_id', row.id);
        if (!signs(signer) || isDone(signer)) return json({ error: 'There is nothing left for you to sign here.' }, 409);
        if (!canSignNow((all ?? []) as Any[], row.signing_order_mode, signer.id)) return json({ error: 'It is not your turn to sign yet. You will get an email when it is.' }, 409);
        const sig = typeof b.signature_png === 'string' && b.signature_png.startsWith('data:image/png;base64,') && b.signature_png.length < 400_000 ? b.signature_png : null;
        const ini = typeof b.initials_png === 'string' && b.initials_png.startsWith('data:image/png;base64,') && b.initials_png.length < 200_000 ? b.initials_png : null;
        if (!sig) return json({ error: 'Draw, type or upload a signature first.' }, 422);
        const style = ['drawn', 'typed', 'uploaded'].includes(b.style) ? b.style : 'drawn';
        await admin.from('contract_signers').update({
          signature_png: sig, initials_png: ini, signature_style: style, signature_font: b.font ?? null,
          signature_name: String(b.typed_name ?? signer.signature_name ?? signer.name ?? '').slice(0, 120) || null, adopted_at: new Date().toISOString(),
        }).eq('id', signer.id);
        let filled = 0;
        if (row.mode === 'pdf' && b.apply !== false) {
          const now = new Date().toISOString();
          const { data: f1 } = await admin.from('contract_fields').update({ value: sig, filled_at: now, filled_ip: ip, filled_by: signer.id })
            .eq('contract_id', row.id).eq('signer_id', signer.id).eq('type', 'signature').is('value', null).select('id');
          filled += f1?.length ?? 0;
          if (ini) {
            const { data: f2 } = await admin.from('contract_fields').update({ value: ini, filled_at: now, filled_ip: ip, filled_by: signer.id })
              .eq('contract_id', row.id).eq('signer_id', signer.id).eq('type', 'initials').is('value', null).select('id');
            filled += f2?.length ?? 0;
          }
        }
        await logEvent(admin, row, 'signature_adopted', { style, initials: !!ini, applied: filled }, who);
        return json({ ok: true, applied: filled });
      }

      case 'attachment_upload': {
        if (closed) return json({ error: `This document is ${row.status}.` }, 409);
        const ct = String(b.content_type ?? '');
        if (!ALLOWED_TYPES.includes(ct)) return json({ error: 'PDF, image or Word files only.' }, 415);
        const bytes = b64(String(b.data_base64 ?? ''));
        if (!bytes.length || bytes.length > MAX_BYTES) return json({ error: 'Files up to 25 MB.' }, 413);
        if (!bytesMatch(ct, bytes)) return json({ error: 'That file is not the type it says it is.' }, 415);
        const { count: mine } = await admin.from('contract_attachments').select('id', { count: 'exact', head: true }).eq('contract_id', row.id).eq('signer_id', signer.id);
        if ((mine ?? 0) >= MAX_UPLOADS_PER_SIGNER) return json({ error: `Up to ${MAX_UPLOADS_PER_SIGNER} files per person.` }, 409);
        let fieldId: number | null = null;
        if (b.field_id) {
          const { data: f } = await admin.from('contract_fields').select('id, signer_id, type').eq('id', Number(b.field_id)).eq('contract_id', row.id).maybeSingle();
          if (!f || f.signer_id !== signer.id || f.type !== 'attachment') return json({ error: 'That upload box is not yours.' }, 403);
          fieldId = f.id;
        }
        const safeName = String(b.filename ?? 'file').replace(/[^\w.\- ]+/g, '_').slice(-120);
        const path = `ws/${row.workspace_id}/${row.id}/${crypto.randomUUID()}-${safeName}`;
        const { error: upErr } = await admin.storage.from('contract-attachments').upload(path, bytes, { contentType: ct, upsert: false });
        if (upErr) return json({ error: upErr.message }, 500);
        const { data: att } = await admin.from('contract_attachments').insert({
          workspace_id: row.workspace_id, contract_id: row.id, signer_id: signer.id, field_id: fieldId,
          label: b.label ?? safeName, storage_path: path, content_type: ct, byte_size: bytes.length, sha256: await sha(bytes), uploaded_ip: ip,
        }).select('id, label, content_type, byte_size, created_at').single();
        if (fieldId && att) await admin.from('contract_fields').update({ value: String(att.id), attachment_id: att.id, filled_at: new Date().toISOString(), filled_ip: ip, filled_by: signer.id }).eq('id', fieldId);
        await logEvent(admin, row, 'attachment_added', { label: att?.label, bytes: bytes.length, field_id: fieldId }, who);
        return json({ ok: true, attachment: att });
      }
      case 'attachments': {
        const { data } = await admin.from('contract_attachments').select('id, label, content_type, byte_size, created_at, field_id').eq('contract_id', row.id).eq('signer_id', signer.id).order('id');
        return json({ attachments: data ?? [] });
      }

      case 'comment_add': {
        if (closed) return json({ error: `This document is ${row.status}.` }, 409);
        const body = String(b.body ?? '').trim();
        if (!body || body.length > 4000) return json({ error: 'Write a comment (up to 4000 characters).' }, 422);
        const { data } = await admin.from('contract_comments').insert({
          workspace_id: row.workspace_id, contract_id: row.id, author_signer_id: signer.id, internal: false,
          page: b.page ? Number(b.page) : null, anchor: b.anchor ?? null, body,
        }).select('id, body, page, created_at').single();
        await logEvent(admin, row, 'comment', { page: b.page ?? null }, who);
        return json({ ok: true, comment: data });
      }
      case 'comments': {
        const { data } = await admin.from('contract_comments').select('id, body, page, anchor, created_at, author_signer_id, author_user_id, parent_id, resolved_at')
          .eq('contract_id', row.id).eq('internal', false).order('id');
        return json({ comments: (data ?? []).map((c) => ({ ...c, mine: c.author_signer_id === signer.id, from_sender: !!c.author_user_id })) });
      }
      default: return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    console.error('docs-public', b.action, (e as Error).message);
    return json({ error: 'Something went wrong. Try again.' }, 500);
  }
});
