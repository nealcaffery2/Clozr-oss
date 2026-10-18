/**
 * POST /docs-plus  (JWT required; roles owner/admin/acquisitions/dispositions/tc,
 * template writes owner/admin)
 *
 * The PandaDoc features the `contracts` function does not have: void with
 * notice, extend, correct and resend, duplicate, bulk send, the tracker
 * timeline. Shares _shared/ with esign and contracts.
 *
 * Body: { action, workspace_id, origin?, ... }
 *
 *   void              { contract_id, reason }                    void AND email every recipient (contracts.void emails nobody)
 *   extend_expiry     { contract_id, days?: 1..365 | expires_at } also revives an expired document
 *   correct           { contract_id, note?, body_md? }           snapshot, back to draft, signatures cleared, old links dead
 *   correct_send      { contract_id, note? }                     send the corrected version (invites go out in signing order, the note as the message)
 *   duplicate         { contract_id, name? }                     new draft, same recipients and fields, no values
 *   delete            { contract_id }                            soft delete (draft, voided, declined, expired only)
 *   archive           { contract_id, archived: boolean }
 *   tags              { contract_id, tags: string[] }
 *   reassign          { contract_id, signer_id, name, email, phone?, reason }  sender-side reassign (moves unfilled fields)
 *   settings          { contract_id, require_access_code?, allow_forwarding?, allow_reassign?, redirect_url?, signer_auth?: [{signer_id, auth_mode}] }
 *   template_settings { template_id, mode?, pdf_path?, require_access_code?, default_cc?, default_message?, default_subject?, name_pattern?, tags?, description?, default_expiry_days?, reminder_policy?, default_signing_order? }
 *   template_fields   { template_id }                            → { fields }
 *   template_fields_save { template_id, fields: FieldDef[] }     replaces all fields (with the new types, groups, conditions, formulas)
 *   anchor_place      { template_id, dry_run? }                  place fields that have anchor_text onto the PDF
 *   bulk_create       { template_id, name, rows: BulkRow[], options }  → { bulk_send_id, total }
 *   bulk_tick         { bulk_send_id? }                          process up to 20 queued rows (also called by cron)
 *   verify            { contract_id }                            hash chain + stored PDF check
 *   timeline          { contract_id }                            events + deliveries + comments merged, for the tracker
 *   pandadoc_backfill { page?: number }                          owner/admin: page through ALL PandaDoc documents (contracts.sync stops at 100)
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, isServiceCaller } from '../_shared/security.ts';
import { type Any, createContract, loadCompany, loadParties, logContractFeed, logEvent, partySigner } from '../_shared/docs.ts';
import { createPdfContract } from '../_shared/pdf-contracts.ts';
import { delegateRecipient, dispatchSend, loadRecipients } from '../_shared/docs-flow.ts';
import { publishContract } from '../_shared/contract-webhooks.ts';
import { clampRect } from '../_shared/pdf-fields.ts';
import { pd } from '../_shared/pandadoc.ts';
import { safeOrigin } from '../_shared/parity/security.ts';
import { notifyVoided } from '../_shared/parity/notify.ts';
import { verifyContract } from '../_shared/parity/certificate.ts';
import { PARITY_FIELD_META, type ParityFieldType } from '../_shared/parity/field-logic.ts';
import { claimBulkItem } from './bulk.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const WRITERS = ['owner', 'admin', 'acquisitions', 'dispositions', 'tc'];
const ADMINS = ['owner', 'admin'];
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

export type BulkRow = {
  recipient: { name: string; email?: string | null; phone?: string | null; role?: string | null };
  deal_id?: number | null; seller_id?: number | null; buyer_id?: number | null;
  tokens?: Array<{ name: string; value: string }>;
  name?: string | null;
};

async function roleOk(user: SupabaseClient, ws: number, roles: string[]) {
  const { data, error } = await user.rpc('has_role', { ws, roles });
  return !error && data === true;
}

async function loadContract(admin: SupabaseClient, ws: number, id: unknown) {
  const { data } = await admin.from('contracts').select('*').eq('id', Number(id)).eq('workspace_id', ws).is('deleted_at', null).maybeSingle();
  return data as Record<string, Any> | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const authz = req.headers.get('authorization') ?? '';
  const bearer = authz.replace(/^Bearer\s+/i, '').trim();
  const isService = await isServiceCaller(admin, bearer);

  // Cron: bulk_tick without a user.
  if (isService && b.action === 'bulk_tick') return json(await bulkTick(admin, b.bulk_send_id ? Number(b.bulk_send_id) : null, safeOrigin()));

  const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authz } }, auth: { persistSession: false } });
  const { data: auth } = await user.auth.getUser();
  if (!auth?.user) return json({ error: 'Sign in first.' }, 401);
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 400);
  const templateAction = ['template_settings', 'template_fields_save', 'anchor_place', 'pandadoc_backfill'].includes(b.action);
  if (!(await roleOk(user, ws, templateAction ? ADMINS : WRITERS))) return json({ error: 'You do not have access to documents in this workspace.' }, 403);

  const origin = safeOrigin(b.origin, req.headers.get('origin'));
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
  const who = { actor_type: 'user' as const, actor_id: auth.user.email ?? auth.user.id, ip, user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null };
  const { company } = await loadCompany(admin, ws);

  try {
    switch (b.action) {
      // ------------------------------------------------------------ void
      case 'void': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        if (row.status === 'completed') return json({ error: 'A completed document cannot be voided. Send a termination instead.' }, 409);
        if (row.status === 'voided') return json({ ok: true, already: true });
        const reason = String(b.reason ?? '').trim().slice(0, 500) || null;
        const now = new Date().toISOString();
        await admin.from('contracts').update({ status: 'voided', voided_at: now, void_reason: reason, last_event: { status: 'voided', source: 'docs-plus', at: now } }).eq('id', row.id);
        await admin.from('contract_signers').update({ access_gate: null, access_code_hash: null }).eq('contract_id', row.id);
        await logEvent(admin, row, 'voided', { reason }, who);
        publishContract(admin, row, 'contract.voided', { reason });
        await logContractFeed(admin, row, `Voided ${row.name}`, reason);
        const emailed = ['draft'].includes(row.status) ? 0 : await notifyVoided(admin, { ...row, status: 'voided' }, company, reason);
        return json({ ok: true, emailed });
      }

      // --------------------------------------------------- extend expiry
      case 'extend_expiry': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        if (['completed', 'voided', 'declined'].includes(row.status)) return json({ error: `A ${row.status} document cannot be extended.` }, 409);
        let at: Date;
        if (b.expires_at) at = new Date(String(b.expires_at));
        else {
          const days = Math.max(1, Math.min(365, Number(b.days ?? 14)));
          const base = row.expires_at && new Date(row.expires_at).getTime() > Date.now() ? new Date(row.expires_at) : new Date();
          at = new Date(base.getTime() + days * 86400_000);
        }
        if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() + 3600_000) return json({ error: 'Pick a date at least an hour from now.' }, 422);
        const revived = row.status === 'expired';
        const status = revived ? (row.viewed_at ? 'viewed' : 'sent') : row.status;
        const lastEvent = { ...(row.last_event ?? {}), warned_expiry: false, status, source: 'docs-plus', at: new Date().toISOString() };
        await admin.from('contracts').update({ expires_at: at.toISOString(), expired_at: null, status, last_event: lastEvent, expiry_extended_count: Number(row.expiry_extended_count ?? 0) + 1 }).eq('id', row.id);
        await logEvent(admin, row, 'expiry_extended', { from: row.expires_at, to: at.toISOString(), revived }, who);
        return json({ ok: true, expires_at: at.toISOString(), status });
      }

      // ------------------------------------------- correct and resend
      case 'correct': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        if (['completed', 'voided'].includes(row.status)) return json({ error: `A ${row.status} document cannot be edited. Duplicate it instead.` }, 409);
        const [{ data: fields }, signers] = await Promise.all([
          admin.from('contract_fields').select('*').eq('contract_id', row.id),
          loadRecipients(admin, row.id),
        ]);
        const rev = Number(row.revision ?? 1);
        await admin.from('contract_revisions').insert({
          workspace_id: ws, contract_id: row.id, revision: rev, reason: String(b.note ?? '') || null,
          body_md: row.body_md, pdf_path: row.pdf_path, source_pdf_path: row.source_pdf_path, sha256: row.sha256,
          fields: fields ?? [], signers: signers.map((s: Any) => ({ id: s.id, role: s.role, name: s.name, email: s.email, status: s.status, signed_at: s.signed_at })),
          created_by: auth.user.id,
        });
        // PandaDoc behavior: editing a sent document clears every signature already given.
        await admin.from('contract_fields').update({ value: null, filled_at: null, filled_ip: null, filled_by: null })
          .eq('contract_id', row.id).in('type', ['signature', 'initials', 'date_signed', 'stamp']);
        for (const s of signers) {
          if (s.status === 'delegated') continue;
          await admin.from('contract_signers').update({
            token: newToken(), status: 'pending', signed_at: null, filled_at: null, signature_png: null, signature_name: null,
            approved_at: null, rejected_at: null, access_gate: null, access_code_hash: null, last_reminded_at: null, reminder_count: 0,
          }).eq('id', s.id);
        }
        const patch: Record<string, Any> = { status: 'draft', revision: rev + 1, corrected_at: new Date().toISOString() };
        if (typeof b.body_md === 'string' && row.mode !== 'pdf') patch.body_md = b.body_md;
        await admin.from('contracts').update(patch).eq('id', row.id);
        await logEvent(admin, row, 'corrected', { revision: rev + 1, note: b.note ?? null, signatures_cleared: signers.filter((s: Any) => s.status === 'signed').length }, who);
        return json({ ok: true, revision: rev + 1, status: 'draft', note: 'Edit fields or text, then call correct_send.' });
      }
      case 'correct_send': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        if (row.status !== 'draft') return json({ error: 'Call correct first.' }, 409);
        // One send path: dispatchSend invites whoever's turn it is (approvers first, then
        // signing order), with the correction note as the message. No second "Updated" mail.
        const note = String(b.note ?? '').trim();
        const message = note ? `Updated: ${note}${row.message ? `

${row.message}` : ''}` : (row.message ?? null);
        const out = await dispatchSend(admin, row, { company, origin, who, senderId: auth.user.id }, message);
        return json({ ok: true, status: out.status });
      }

      // ------------------------------------------------------- duplicate
      case 'duplicate': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        const { id: _id, created_at: _c, updated_at: _u, sent_at: _s, viewed_at: _v, completed_at: _cp, voided_at: _vd, expired_at: _e,
          pandadoc_id: _p, final_sha256: _f, last_event: _l, ref_number: _r, extract_status: _x, extracted_at: _xa, extract_error: _xe, ...rest } = row;
        const { data: copy, error } = await admin.from('contracts').insert({
          ...rest, name: String(b.name ?? `${row.name} (copy)`), status: 'draft', provider: 'clozr', parent_contract_id: row.id,
          created_by: auth.user.id, revision: 1, corrected_at: null, void_reason: null, expires_at: null, approved_at: null,
          approval_requested_at: null, approval_rejected_at: null, approval_rejected_reason: null, notary_status: row.needs_notary ? 'needed' : 'none', notarized_at: null,
          pdf_path: row.mode === 'pdf' ? row.source_pdf_path : row.pdf_path,
        }).select('*').single();
        if (error || !copy) return json({ error: error?.message ?? 'could not copy' }, 500);
        const signers = await loadRecipients(admin, row.id);
        const map = new Map<number, number>();
        for (const s of signers.filter((x: Any) => x.status !== 'delegated')) {
          const { data: ns } = await admin.from('contract_signers').insert({
            workspace_id: ws, contract_id: copy.id, role: s.role, label: s.label, name: s.name, email: s.email, phone: s.phone, sort: s.sort,
            recipient_type: s.recipient_type, delivery: s.delivery, seller_id: s.seller_id, buyer_id: s.buyer_id, vendor_id: s.vendor_id, user_id: s.user_id,
          }).select('id').single();
          if (ns) map.set(s.id, ns.id);
        }
        const { data: fields } = await admin.from('contract_fields').select('*').eq('contract_id', row.id);
        const rows = (fields ?? []).filter((f: Any) => map.has(f.signer_id)).map((f: Any) => {
          const { id: _fid, created_at: _fc, updated_at: _fu, value, filled_at: _ff, filled_ip: _fi, filled_by: _fb, attachment_id: _a, ...fr } = f;
          return { ...fr, contract_id: copy.id, signer_id: map.get(f.signer_id), value: f.variable_key || f.read_only ? value : (f.default_value ?? null) };
        });
        if (rows.length) await admin.from('contract_fields').insert(rows);
        await logEvent(admin, copy, 'created', { duplicated_from: row.id }, who);
        return json({ ok: true, contract: copy });
      }

      case 'delete': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        if (!['draft', 'voided', 'declined', 'expired'].includes(row.status)) return json({ error: 'Void it first. Sent and completed documents are kept for the audit trail.' }, 409);
        await admin.from('contracts').update({ deleted_at: new Date().toISOString() }).eq('id', row.id);
        await logEvent(admin, row, 'deleted', {}, who);
        return json({ ok: true });
      }
      case 'archive': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        await admin.from('contracts').update({ archived_at: b.archived === false ? null : new Date().toISOString() }).eq('id', row.id);
        return json({ ok: true });
      }
      case 'tags': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        const tags = (Array.isArray(b.tags) ? b.tags : []).map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
        await admin.from('contracts').update({ tags }).eq('id', row.id);
        return json({ ok: true, tags });
      }

      // ----------------------------------------------------- reassign
      case 'reassign': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        if (['completed', 'voided', 'declined', 'expired'].includes(row.status)) return json({ error: `This document is ${row.status}.` }, 409);
        const { data: old } = await admin.from('contract_signers').select('*').eq('id', Number(b.signer_id)).eq('contract_id', row.id).maybeSingle();
        if (!old) return json({ error: 'recipient not found' }, 404);
        if (['signed', 'filled', 'approved', 'delegated'].includes(old.status)) return json({ error: 'That recipient already finished.' }, 409);
        const email = String(b.email ?? '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email, please.' }, 422);
        const out = await delegateRecipient(admin, row, old, { name: String(b.name ?? '').trim(), email, phone: b.phone ?? null, reason: String(b.reason ?? 'Reassigned by sender') }, { company, origin, who, senderId: auth.user.id });
        return json({ ok: true, signer_id: out.signer.id, emailed: out.delivered.emailed, texted: out.delivered.texted });
      }

      case 'settings': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        const patch: Record<string, Any> = {};
        for (const k of ['require_access_code', 'allow_forwarding', 'allow_reassign']) if (typeof b[k] === 'boolean') patch[k] = b[k];
        if (b.redirect_url !== undefined) patch.redirect_url = /^https:\/\//.test(String(b.redirect_url ?? '')) ? String(b.redirect_url) : null;
        if (Object.keys(patch).length) await admin.from('contracts').update(patch).eq('id', row.id);
        for (const a of Array.isArray(b.signer_auth) ? b.signer_auth : []) {
          if (!['link', 'email_code', 'sms_code'].includes(a.auth_mode)) continue;
          await admin.from('contract_signers').update({ auth_mode: a.auth_mode }).eq('id', Number(a.signer_id)).eq('contract_id', row.id);
        }
        return json({ ok: true });
      }

      // ----------------------------------------------------- templates
      case 'template_settings': {
        const { data: t } = await admin.from('doc_templates').select('id, workspace_id').eq('id', Number(b.template_id)).maybeSingle();
        if (!t || t.workspace_id !== ws) return json({ error: 'Template not found (built-in templates must be duplicated first).' }, 404);
        const patch: Record<string, Any> = {};
        if (b.mode === 'pdf' || b.mode === 'richtext') patch.mode = b.mode;
        if (typeof b.pdf_path === 'string' && b.pdf_path.startsWith(`ws/${ws}/`)) patch.pdf_path = b.pdf_path;
        for (const k of ['require_access_code']) if (typeof b[k] === 'boolean') patch[k] = b[k];
        for (const k of ['default_message', 'default_subject', 'name_pattern', 'description']) if (b[k] !== undefined) patch[k] = b[k] == null ? null : String(b[k]).slice(0, 2000);
        if (Array.isArray(b.default_cc)) patch.default_cc = b.default_cc.filter((c: Any) => /@/.test(String(c?.email ?? ''))).slice(0, 10);
        if (Array.isArray(b.tags)) patch.tags = b.tags.map(String).slice(0, 20);
        if (b.default_expiry_days != null) patch.default_expiry_days = Math.max(1, Math.min(365, Number(b.default_expiry_days)));
        if (b.reminder_policy) patch.reminder_policy = { first_after_days: Number(b.reminder_policy.first_after_days ?? 1), repeat_every_days: Number(b.reminder_policy.repeat_every_days ?? 2), max: Number(b.reminder_policy.max ?? 10) };
        if (['parallel', 'sequential'].includes(b.default_signing_order)) patch.default_signing_order = b.default_signing_order;
        await admin.from('doc_templates').update(patch).eq('id', t.id);
        return json({ ok: true });
      }
      case 'template_fields': {
        const { data } = await admin.from('doc_template_fields').select('*').eq('template_id', Number(b.template_id)).eq('workspace_id', ws).order('page').order('sort');
        return json({ fields: data ?? [] });
      }
      case 'template_fields_save': {
        const { data: t } = await admin.from('doc_templates').select('id, workspace_id, signers').eq('id', Number(b.template_id)).maybeSingle();
        if (!t || t.workspace_id !== ws) return json({ error: 'Template not found.' }, 404);
        const { count } = await admin.from('contracts').select('id', { count: 'exact', head: true }).eq('template_id', String(t.id));
        if ((count ?? 0) > 0 && b.force !== true) {
          return json({ error: 'Documents were already sent from this version. Save as a new version (contracts.template_save) or pass force: true to edit in place.', in_use: count }, 409);
        }
        const roles = new Set(((t.signers ?? []) as Any[]).map((s) => String(s.role)));
        const raw = Array.isArray(b.fields) ? b.fields : [];
        if (raw.length > 1500) return json({ error: 'Too many fields.' }, 422);
        const rows: Any[] = [];
        for (const [i, f] of raw.entries()) {
          const type = String(f.type) as ParityFieldType;
          if (!PARITY_FIELD_META[type]) return json({ error: `Field ${i + 1}: unknown type ${f.type}` }, 422);
          if (!roles.has(String(f.role))) return json({ error: `Field ${i + 1}: role ${f.role} is not on this template.` }, 422);
          const r = f.anchor_text ? { x: Number(f.x ?? 0), y: Number(f.y ?? 0), w: Number(f.w ?? 0.2), h: Number(f.h ?? 0.03) } : clampRect({ x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h) });
          rows.push({
            workspace_id: ws, template_id: t.id, role: String(f.role), type, page: Math.max(1, Number(f.page ?? 1)),
            x: r.x, y: r.y, w: r.w, h: r.h,
            required: !!f.required, read_only: !!f.read_only || type === 'formula',
            label: f.label ?? null, default_value: f.default_value ?? null, variable_key: f.variable_key ?? null,
            anchor_text: f.anchor_text ?? null, anchor_offset: f.anchor_offset ?? null,
            options: Array.isArray(f.options) ? f.options.map(String).slice(0, 100) : null,
            validation: f.validation ?? null, sort: i,
            field_key: f.field_key ? String(f.field_key).replace(/[^a-z0-9_.]/gi, '_').slice(0, 60) : null,
            group_key: f.group_key ? String(f.group_key).slice(0, 60) : null,
            conditions: f.conditions ?? null, formula: f.formula ? String(f.formula).slice(0, 500) : null,
            placeholder: f.placeholder ?? null, font_size: f.font_size ?? null,
          });
        }
        const { error: delErr } = await admin.from('doc_template_fields').delete().eq('template_id', t.id);
        if (delErr) return json({ error: delErr.message }, 500);
        if (rows.length) {
          const { error } = await admin.from('doc_template_fields').insert(rows);
          if (error) return json({ error: error.message }, 422);
        }
        await admin.from('doc_templates').update({ mode: 'pdf', updated_at: new Date().toISOString() }).eq('id', t.id);
        return json({ ok: true, saved: rows.length });
      }
      case 'anchor_place': {
        const { data: t } = await admin.from('doc_templates').select('id, workspace_id, pdf_path').eq('id', Number(b.template_id)).maybeSingle();
        if (!t || t.workspace_id !== ws || !t.pdf_path) return json({ error: 'PDF template not found.' }, 404);
        const { data: fields } = await admin.from('doc_template_fields').select('*').eq('template_id', t.id).not('anchor_text', 'is', null);
        if (!fields?.length) return json({ ok: true, placed: 0 });
        const { data: blob } = await admin.storage.from('doc-sources').download(t.pdf_path);
        if (!blob) return json({ error: 'Could not read the template PDF.' }, 500);
        // Loaded here so a pdfjs problem only breaks anchor placement, not every docs-plus action.
        const { findAnchors } = await import('../_shared/parity/anchors.ts');
        const hits = await findAnchors(new Uint8Array(await blob.arrayBuffer()), [...new Set(fields.map((f: Any) => String(f.anchor_text)))]);
        const placed: Any[] = [];
        const extra: Any[] = [];
        for (const f of fields) {
          const list = hits.get(String(f.anchor_text)) ?? [];
          const off = (f.anchor_offset ?? {}) as { dx?: number; dy?: number; occurrence?: string | number };
          const which = off.occurrence === 'all' ? list : list.slice(typeof off.occurrence === 'number' ? off.occurrence : 0, (typeof off.occurrence === 'number' ? off.occurrence : 0) + 1);
          which.forEach((h, idx) => {
            const box = clampRect({ x: h.x + h.w + Number(off.dx ?? 0.005), y: h.y + Number(off.dy ?? 0) - (Number(f.h) - h.h) / 2, w: Number(f.w), h: Number(f.h) });
            if (idx === 0) placed.push({ id: f.id, page: h.page, ...box });
            else extra.push({ ...f, id: undefined, page: h.page, ...box, anchor_text: null, sort: Number(f.sort) + idx / 100 });
          });
        }
        if (b.dry_run) return json({ ok: true, placed, extra: extra.length });
        for (const p of placed) await admin.from('doc_template_fields').update({ page: p.page, x: p.x, y: p.y, w: p.w, h: p.h }).eq('id', p.id);
        if (extra.length) await admin.from('doc_template_fields').insert(extra.map(({ id: _i, created_at: _c, updated_at: _u, ...r }) => r));
        return json({ ok: true, placed: placed.length, extra: extra.length, missing: fields.filter((f: Any) => !(hits.get(String(f.anchor_text)) ?? []).length).map((f: Any) => f.anchor_text) });
      }

      // ---------------------------------------------------- bulk send
      case 'bulk_create': {
        const rowsIn = (Array.isArray(b.rows) ? b.rows : []) as BulkRow[];
        if (!rowsIn.length || rowsIn.length > 500) return json({ error: 'Between 1 and 500 rows.' }, 422);
        // This workspace's templates or the built-in ones, never another workspace's.
        const { data: t } = await admin.from('doc_templates').select('id, name, workspace_id').eq('id', Number(b.template_id)).maybeSingle();
        if (!t || (t.workspace_id != null && Number(t.workspace_id) !== ws)) return json({ error: 'Template not found.' }, 404);
        const { data: bs, error } = await admin.from('bulk_sends').insert({
          workspace_id: ws, template_id: t.id, name: String(b.name ?? t.name), message: b.message ?? null, total: rowsIn.length,
          options: { ...(b.options ?? {}), origin }, created_by: auth.user.id,
        }).select('id').single();
        if (error || !bs) return json({ error: error?.message ?? 'could not queue' }, 500);
        await admin.from('bulk_send_items').insert(rowsIn.map((r, i) => ({ bulk_send_id: bs.id, workspace_id: ws, row_index: i, input: r })));
        const first = await bulkTick(admin, bs.id, origin);
        return json({ ok: true, bulk_send_id: bs.id, total: rowsIn.length, ...first });
      }
      case 'bulk_tick':
        return json(await bulkTick(admin, b.bulk_send_id ? Number(b.bulk_send_id) : null, origin, ws));

      case 'verify': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        return json(await verifyContract(admin, { id: row.id }));
      }
      case 'timeline': {
        const row = await loadContract(admin, ws, b.contract_id);
        if (!row) return json({ error: 'not found' }, 404);
        const [ev, dl, cm, rv, at] = await Promise.all([
          admin.from('contract_events').select('id, event, created_at, actor_type, actor_id, signer_id, ip, user_agent, payload').eq('contract_id', row.id).order('id'),
          admin.from('contract_deliveries').select('id, signer_id, channel, kind, status, to_address, created_at, updated_at, events, error').eq('contract_id', row.id).order('id'),
          admin.from('contract_comments').select('*').eq('contract_id', row.id).order('id'),
          admin.from('contract_revisions').select('id, revision, reason, created_at, created_by').eq('contract_id', row.id).order('revision'),
          admin.from('contract_attachments').select('id, signer_id, field_id, label, content_type, byte_size, created_at').eq('contract_id', row.id).order('id'),
        ]);
        return json({ events: ev.data ?? [], deliveries: dl.data ?? [], comments: cm.data ?? [], revisions: rv.data ?? [], attachments: at.data ?? [], recipients: await loadRecipients(admin, row.id) });
      }

      // ------------------------------------------ PandaDoc full backfill
      case 'pandadoc_backfill': {
        const page = Math.max(1, Number(b.page ?? 1));
        const list = await pd<{ results: Any[] }>('GET', `/documents?count=100&page=${page}&order_by=date_created`);
        let upserted = 0;
        for (const d of list.results ?? []) {
          const { data: existing } = await admin.from('contracts').select('id').eq('workspace_id', ws).eq('pandadoc_id', d.id).maybeSingle();
          const patch = {
            workspace_id: ws, provider: 'pandadoc', pandadoc_id: d.id, name: d.name, status: String(d.status ?? '').replace(/^document\./, '') || 'draft',
            sent_at: d.date_sent ?? null, completed_at: d.date_completed ?? null, expires_at: d.expiration_date ?? null,
          };
          if (existing) await admin.from('contracts').update(patch).eq('id', existing.id);
          else await admin.from('contracts').insert({ ...patch, kind: guessKind(String(d.name)) });
          upserted++;
        }
        return json({ ok: true, page, upserted, next_page: (list.results?.length ?? 0) === 100 ? page + 1 : null });
      }

      default: return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    console.error('docs-plus', b.action, (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

function guessKind(name: string): string {
  const n = name.toLowerCase();
  if (/assign/.test(n)) return 'assignment';
  if (/amend/.test(n)) return 'amendment';
  if (/terminat|cancel/.test(n)) return 'termination';
  if (/option/.test(n)) return 'option';
  if (/novation/.test(n)) return 'novation';
  if (/jv|joint venture|profit share/.test(n)) return 'jv';
  if (/disclos|seller info/.test(n)) return 'disclosure';
  if (/addend|leaseback|hold ?back/.test(n)) return 'addendum';
  if (/\bpcs\b|commission/.test(n)) return 'commission';
  if (/earnest money receipt|receipt/.test(n)) return 'receipt';
  if (/\bica\b|contractor agreement/.test(n)) return 'ica';
  if (/nda|non-disclosure/.test(n)) return 'nda';
  if (/referral/.test(n)) return 'referral';
  if (/participation/.test(n)) return 'participation';
  if (/psa|purchase|trec|contract|one to four/.test(n)) return 'psa';
  return 'other';
}

/** Up to 20 queued rows per call: each is claimed, then becomes its own contract, created and sent. */
async function bulkTick(admin: SupabaseClient, bulkId: number | null, origin: string, ws?: number) {
  let q = admin.from('bulk_send_items').select('id, bulk_send_id, workspace_id, row_index, input').eq('status', 'queued').order('id').limit(20);
  if (bulkId) q = q.eq('bulk_send_id', bulkId);
  if (ws) q = q.eq('workspace_id', ws);
  const { data: items } = await q;
  let sent = 0, failed = 0;
  const cache = new Map<number, Any>();
  for (const it of items ?? []) {
    let bs = cache.get(it.bulk_send_id);
    if (!bs) {
      const { data, error } = await admin.from('bulk_sends').select('*, template:doc_templates(*)').eq('id', it.bulk_send_id).maybeSingle();
      // A failed read is not "gone": the row stays queued for the next tick.
      if (error) continue;
      bs = data; cache.set(it.bulk_send_id, bs);
      if (bs?.status === 'queued') await admin.from('bulk_sends').update({ status: 'running' }).eq('id', bs.id);
    }
    // Claimed before anything is created or sent (bulk.ts): a run that loses the claim sends nothing.
    if (!(await claimBulkItem(admin, it.id))) continue;
    try {
      if (!bs || bs.status === 'cancelled') { await admin.from('bulk_send_items').update({ status: 'skipped', error: null }).eq('id', it.id); continue; }
      const r = it.input as BulkRow;
      const t = bs.template;
      const opts = bs.options ?? {};
      const { company } = await loadCompany(admin, bs.workspace_id);
      const ids = { dealId: r.deal_id ?? null, sellerId: r.seller_id ?? null, buyerId: r.buyer_id ?? null };
      const parties = await loadParties(admin, bs.workspace_id, ids);
      const tplSigners = (t.signers ?? []) as Any[];
      const publicRole = String(r.recipient.role ?? opts.recipient_role ?? tplSigners.find((s) => s.party !== 'company')?.role ?? tplSigners[0]?.role);
      const fixed = (opts.fixed_recipients ?? []) as Any[];
      // The row's person in the public role; every other role filled the way a normal send fills it
      // (seller, buyer, the company signer from the record), then any fixed recipient the batch names.
      const signers = tplSigners
        .filter((s) => s.role === publicRole || fixed.some((f) => f.role === s.role) || !s.optional)
        .map((s) => s.role === publicRole
          ? { role: s.role, label: s.label, name: r.recipient.name, email: r.recipient.email ?? null, phone: r.recipient.phone ?? null, recipient_type: s.recipient_type ?? 'signer' }
          : { ...partySigner(s, { ...parties, company }), ...(fixed.find((f) => f.role === s.role) ?? {}), recipient_type: (fixed.find((f) => f.role === s.role)?.recipient_type) ?? s.recipient_type ?? 'signer' });
      const common = {
        ws: bs.workspace_id, userId: bs.created_by, origin: opts.origin || origin, ids, signers,
        name: r.name ?? `${t.name} - ${r.recipient.name}`, message: bs.message ?? null,
        expiresDays: opts.expires_days ?? t.default_expiry_days ?? 60, send: true,
        orderMode: opts.order_mode ?? t.default_signing_order ?? 'parallel', reminders: opts.reminders ?? t.reminder_policy ?? null,
        parties, company,
      };
      const out = t.mode === 'pdf'
        ? await createPdfContract(admin, { ...common, template: t, kind: t.kind })
        : await createContract(admin, { ...common, template: t, tokens: r.tokens ?? [] });
      const contractId = (out as Any).contract?.id;
      if (contractId) await admin.from('contracts').update({ bulk_send_id: bs.id }).eq('id', contractId);
      await admin.from('bulk_send_items').update({ status: 'sent', contract_id: contractId ?? null, error: null }).eq('id', it.id);
      sent++;
    } catch (e) {
      failed++;
      await admin.from('bulk_send_items').update({ status: 'failed', error: (e as Error).message.slice(0, 500) }).eq('id', it.id);
    }
  }
  for (const id of new Set((items ?? []).map((i) => i.bulk_send_id))) {
    const { data: counts, error } = await admin.from('bulk_send_items').select('status').eq('bulk_send_id', id);
    if (error) continue; // no counts is not zero counts: leave the batch as it stands
    const c = (s: string) => (counts ?? []).filter((x) => x.status === s).length;
    await admin.from('bulk_sends').update({
      sent: c('sent'), failed: c('failed'),
      ...(c('queued') === 0 ? { status: c('failed') && !c('sent') ? 'failed' : 'done', finished_at: new Date().toISOString() } : {}),
    }).eq('id', id);
  }
  return { processed: (items ?? []).length, sent, failed };
}
