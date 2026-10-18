/**
 * Contracts made from an uploaded PDF (PDF overlay mode): create one from a
 * PDF template or a one-off upload, keep its fields, take each recipient's
 * values, and flatten everything onto the original pages when it completes.
 *
 * The pure rules (types, coordinates, validation, the draw plan) are in
 * pdf-fields.ts. This module does the reading and writing: storage, the
 * contract_fields table, events. Used by the contracts and esign functions,
 * and by completeContract in docs.ts.
 */
import { prepareForFlatten } from './parity/flatten-prep.ts';
import { PDFDocument, PDFImage, StandardFonts, degrees, rgb } from 'npm:pdf-lib@1.17.1';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  type Any, type Company, type SignerRow, applySent, completeContract, emailSigners, ensureTcCc, loadParties, logEvent, queueNotary, workspaceTcCopies,
  sha256Hex, signUrl, storePdf, toPdf, varsFor,
} from './docs.ts';
import {
  type ContractField, type FieldDef, type PageBox, bindToSigners, effectiveReadOnly, missingRequired, normalizeField, planFlatten, signingDay, validateValue,
} from './pdf-fields.ts';
import { allSigned, appendTcCc, pending, sendTo, turn, type OrderMode, type ReminderPolicy } from './signing-order.ts';

/** Columns the signing page and the editor get for a field (never who filled it from where). */
const FIELD_COLS = 'id, signer_id, type, page, x, y, w, h, required, read_only, label, default_value, variable_key, options, validation, value, filled_at, sort, field_key, group_key, conditions, formula, placeholder, font_size, attachment_id';

async function download(admin: SupabaseClient, bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) throw new Error('Could not read the PDF from storage.');
  return new Uint8Array(await data.arrayBuffer());
}

/** Page count of an uploaded file, or a plain error when it is not a PDF we can read. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    throw new Error('That file is not a PDF we can read. Save it as a PDF again and upload that.');
  }
}

/** Fields placed on a template, in the shape the editor and bindToSigners use. */
export async function templateFields(client: SupabaseClient, templateId: number): Promise<FieldDef[]> {
  const { data } = await client.from('doc_template_fields').select('*').eq('template_id', templateId).order('page').order('sort');
  return (data ?? []) as FieldDef[];
}

export type PdfCreateInput = {
  ws: number; userId: string | null; origin: string;
  /** A PDF-mode doc_templates row, or null for a one-off upload. */
  template: Record<string, Any> | null;
  /** doc-sources path of the uploaded file (one-off), ignored when a template is given. */
  sourcePath?: string | null;
  kind: string; name?: string | null;
  ids: { sellerId?: number | null; dealId?: number | null; buyerId?: number | null; offerId?: number | null };
  signers: { role: string; label?: string; name?: string | null; email?: string | null; phone?: string | null; optional?: boolean; recipient_type?: string | null }[];
  /** Fields for a one-off upload placed before creating it (usually none: they are placed on the draft). */
  fields?: unknown[] | null;
  message?: string | null; expiresDays?: number | null; send?: boolean; email?: boolean;
  orderMode?: OrderMode | null; reminders?: ReminderPolicy | null;
  /** Values the sender typed on the form, by variable name; they win over the record's. */
  tokens?: { name: string; value: string }[] | null;
  notary?: { needs?: boolean; mode?: 'digital' | 'wet' | 'vendor' | null; vendor?: string | null } | null;
  parties: Awaited<ReturnType<typeof loadParties>>; company: Company;
};

const RECIPIENT_TYPES = ['signer', 'cc', 'viewer', 'filler', 'approver'];

/**
 * Copy the original into the contract's own folder (so a template edited or
 * deleted later never changes what was sent), create the contract and its
 * recipients, and bind the template's fields to them by role.
 */
export async function createPdfContract(admin: SupabaseClient, i: PdfCreateInput) {
  const srcPath = i.template ? String(i.template.pdf_path ?? '') : String(i.sourcePath ?? '');
  if (!srcPath) throw new Error(i.template ? 'This PDF template has no file yet.' : 'Upload the PDF first.');
  if (!srcPath.startsWith(`ws/${i.ws}/`)) throw new Error('That file belongs to another workspace.');
  const bytes = await download(admin, 'doc-sources', srcPath);
  const pages = await pdfPageCount(bytes);

  const ref = `CLZ-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const address = String(i.parties.prop?.line1 || i.parties.seller?.property_address || '').trim();
  const base = i.template ? String(i.template.name) : 'Uploaded PDF';
  const name = String(i.name || `${base} - ${address || i.parties.buyer?.name || 'contract'}`).slice(0, 200);
  const signers = i.signers.filter((s) => s.role).map((s, idx) => ({ ...s, sort: idx + 1 }));
  const tcs = await workspaceTcCopies(admin, i.ws);
  const active = appendTcCc(signers.filter((s) => !s.optional || s.name || s.email), tcs)
    .map((s, idx) => ({ ...s, sort: idx + 1 }));
  const now = new Date();
  const expires = i.expiresDays ? new Date(now.getTime() + i.expiresDays * 864e5).toISOString() : null;
  const notaryMode = i.notary?.needs ? (i.notary.mode ?? 'digital') : null;
  const notaryStatus = !i.notary?.needs ? 'none' : notaryMode === 'wet' ? 'wet' : notaryMode === 'vendor' ? 'vendor' : 'needed';

  const { data: row, error } = await admin.from('contracts').insert({
    workspace_id: i.ws, deal_id: i.parties.deal?.id ?? null, seller_id: i.parties.seller?.id ?? null, buyer_id: i.parties.buyer?.id ?? null, offer_id: i.ids.offerId ?? null,
    kind: i.kind, provider: 'clozr', mode: 'pdf',
    template_id: i.template?.id ? String(i.template.id) : null, template_key: i.template?.key ?? null, template_name: i.template?.name ?? 'Uploaded PDF',
    ref_number: ref, signing_order_mode: i.orderMode === 'sequential' ? 'sequential' : 'parallel',
    ...(i.reminders ? { reminder_policy: i.reminders } : {}),
    name, status: i.send ? 'sent' : 'draft', body_md: null, tokens: [],
    recipients: active.map((s) => ({ email: s.email ?? null, name: s.name ?? null, role: s.role })),
    message: i.message ?? null, expires_at: expires, sent_at: i.send ? now.toISOString() : null, created_by: i.userId,
    needs_notary: !!i.notary?.needs, notary_mode: notaryMode, notary_status: notaryStatus, notary_vendor: i.notary?.vendor ?? null,
  }).select('*').single();
  if (error || !row) throw new Error(error?.message ?? 'could not save the contract');

  const { data: signerRows, error: sErr } = await admin.from('contract_signers').insert(active.map((s) => ({
    workspace_id: i.ws, contract_id: row.id, role: s.role, label: s.label ?? s.role, name: s.name ?? null,
    email: s.email?.trim().toLowerCase() || null, phone: s.phone ?? null, sort: s.sort,
    recipient_type: s.recipient_type && RECIPIENT_TYPES.includes(s.recipient_type) ? s.recipient_type : 'signer',
  }))).select('*');
  if (sErr) throw new Error(sErr.message);

  const path = await storePdf(admin, i.ws, row.id, 'source.pdf', bytes);
  if (!path) throw new Error('Could not store the PDF.');
  const hash = await sha256Hex(bytes);
  await admin.from('contracts').update({ source_pdf_path: path, pdf_path: path, sha256: hash }).eq('id', row.id);

  // Template fields, or fields the sender placed before creating it.
  const defs: FieldDef[] = i.template
    ? await templateFields(admin, Number(i.template.id))
    : (i.fields ?? []).flatMap((f) => { const n = normalizeField(f, pages); return n.ok ? [n.field] : []; });
  // What the sender typed wins over the record (as on text templates), under the
  // name the form showed and its lowercase spelling.
  const vars = { ...varsFor(i.parties, i.company, ref) };
  for (const t of i.tokens ?? []) {
    const name = String(t?.name ?? '').trim();
    const value = String(t?.value ?? '').trim();
    if (!name || !value) continue;
    for (const k of new Set([name, name.toLowerCase()])) {
      // Printed exactly as typed: "$500" or "Sept 20" is not reformatted.
      vars[k] = { value, type: 'text' };
    }
  }
  const bound = bindToSigners(defs, (signerRows ?? []) as Any[], vars, { fromTemplate: !!i.template });
  if (bound.rows.length) {
    const { error: fErr } = await admin.from('contract_fields').insert(bound.rows.map((r) => ({ ...r, workspace_id: i.ws, contract_id: row.id })));
    if (fErr) throw new Error(fErr.message);
  }

  await logEvent(admin, row, i.send ? 'sent' : 'created', {
    provider: 'clozr', mode: 'pdf', pages, fields: bound.rows.length, skipped: bound.skipped.length, missing: bound.unresolved,
    signers: active.length, ref, order: row.signing_order_mode, sha256: hash,
  }, { actor_type: 'user', actor_id: i.userId });
  if (i.send) await applySent(admin, row);

  const links = (signerRows ?? []).map((s) => ({ id: s.id, role: s.role, label: s.label, name: s.name, email: s.email, phone: s.phone, status: s.status, recipient_type: s.recipient_type, sort: s.sort, url: signUrl(i.origin, s.token) }));
  let emailed = 0;
  if (i.send && i.email !== false) emailed = await emailSigners(i.company, name, i.message ?? null, sendTo(links, row.signing_order_mode), { expiresAt: expires, cc: tcs.map((t) => t.email), contractId: row.id });
  if (i.notary?.needs && (notaryMode === 'wet' || notaryMode === 'vendor' || i.send)) {
    try { await queueNotary(admin, { ...row, notary_mode: notaryMode, notary_vendor: i.notary.vendor ?? null }, i.origin); } catch (e) { console.error('notary', (e as Error).message); }
  }
  return {
    contract: { ...row, source_pdf_path: path, pdf_path: path, sha256: hash },
    signers: links, emailed, pages, fields: bound.rows.length, skipped: bound.skipped, missing: bound.unresolved,
  };
}

/** A draft's fields for the editor, by signer role, with a 10-minute link to the original. */
export async function draftFields(admin: SupabaseClient, row: Record<string, Any>) {
  const [{ data: fields }, { data: signers }] = await Promise.all([
    admin.from('contract_fields').select(FIELD_COLS).eq('contract_id', row.id).order('page').order('sort'),
    admin.from('contract_signers').select('id, role, label, name, email, recipient_type, sort').eq('contract_id', row.id).order('sort'),
  ]);
  const roleOf = new Map((signers ?? []).map((s) => [s.id, s.role]));
  const { data: link } = row.source_pdf_path ? await admin.storage.from('contracts').createSignedUrl(row.source_pdf_path, 600) : { data: null };
  return {
    fields: (fields ?? []).map((f) => ({ ...f, role: roleOf.get(f.signer_id) ?? '' })),
    signers: signers ?? [], source_url: link?.signedUrl ?? null,
  };
}

const CLEARED = ' cleared';
/**
 * What the sender typed on the page while preparing the document (the PandaDoc
 * "prefill" step). A typed value wins over the record. Emptied: a field bound
 * to the record falls back to it; any other field is cleared. Signatures,
 * initials, stamps and formulas are never typed by the sender. Undefined when
 * the editor did not send a value (it was only moved), so the rules below apply.
 */
function typedValue(raw: unknown, r: { type: FieldDef['type']; options?: string[] | null; validation?: FieldDef['validation']; label?: string | null; variable_key?: string | null }): string | undefined {
  const given = raw as Record<string, unknown> | null;
  if (!given || typeof given !== 'object' || !('value' in given)) return undefined;
  if (['signature', 'initials', 'stamp', 'formula', 'date_signed'].includes(r.type)) return undefined;
  const v = validateValue(r, given.value);
  if (!v.ok) throw new Error(v.error);
  if (v.value == null) return r.variable_key ? undefined : CLEARED;
  return v.value;
}

/**
 * Replace a draft's fields with the editor's. Only a draft: once it is out,
 * moving a box under someone who already filled it would change what they
 * agreed to.
 */
export async function saveDraftFields(admin: SupabaseClient, row: Record<string, Any>, raw: unknown[], company: Company, who: { actor_id: string }) {
  if (row.mode !== 'pdf') throw new Error('This contract is not a PDF.');
  if (row.status !== 'draft') throw new Error('Fields can only be moved while the contract is a draft.');
  const defs: FieldDef[] = [];
  for (const f of raw) {
    const n = normalizeField(f);
    if (!n.ok) throw new Error(n.error);
    defs.push(n.field);
  }
  const { data: signers } = await admin.from('contract_signers').select('id, role, recipient_type').eq('contract_id', row.id);
  // Bound fields resolve now, from the records as they stand.
  const parties = await loadParties(admin, row.workspace_id, { sellerId: row.seller_id, dealId: row.deal_id, buyerId: row.buyer_id, offerId: row.offer_id });
  const bound = bindToSigners(defs, (signers ?? []) as Any[], varsFor(parties, company, row.ref_number));
  if (bound.skipped.length) throw new Error(`Some fields have nobody to fill them: ${bound.skipped.map((s) => `${s.type} for ${s.role} (${s.reason})`).join('; ')}`);
  // Keep what the sender already typed into a field that did not move roles.
  const { data: before } = await admin.from('contract_fields').select('id, signer_id, value, template_field_id').eq('contract_id', row.id);
  const keep = new Map((before ?? []).map((f) => [String(f.id), f]));
  const rows = bound.rows.map((r, idx) => {
    const prior = defs[idx].id != null ? keep.get(String(defs[idx].id)) : undefined;
    return {
      ...r, template_field_id: prior?.template_field_id ?? null,
      value: typedValue(raw[idx], r) ?? r.value ?? (prior && prior.signer_id === r.signer_id && !r.read_only ? prior.value : null),
      workspace_id: row.workspace_id, contract_id: row.id,
    };
  }).map((r) => (r.value === CLEARED ? { ...r, value: null } : r));
  const { error: dErr } = await admin.from('contract_fields').delete().eq('contract_id', row.id);
  if (dErr) throw new Error(dErr.message);
  if (rows.length) {
    const { error } = await admin.from('contract_fields').insert(rows);
    if (error) throw new Error(error.message);
  }
  await logEvent(admin, row, 'fields_edited', { fields: rows.length, missing: bound.unresolved }, { actor_type: 'user', actor_id: who.actor_id });
  return { fields: rows.length, missing: bound.unresolved };
}

/**
 * What one recipient sees: their own fields (editable unless read-only), and
 * everyone else's only once it has a value, read-only. Plus a 10-minute link
 * to the original to render.
 */
export async function signerFields(admin: SupabaseClient, row: Record<string, Any>, signer: Record<string, Any>) {
  const { data: fields } = await admin.from('contract_fields').select(FIELD_COLS).eq('contract_id', row.id).order('page').order('sort');
  const { data: signers } = await admin.from('contract_signers').select('id, role, label, sort').eq('contract_id', row.id).order('sort');
  const order = (signers ?? []).map((s) => s.id);
  const who = new Map((signers ?? []).map((s) => [s.id, s.label || s.role]));
  const out = (fields ?? []).flatMap((f) => {
    const mine = f.signer_id === signer.id;
    if (!mine && !(f.value ?? '').trim()) return [];
    return [{
      id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
      required: mine ? f.required : false, read_only: mine ? effectiveReadOnly(f as ContractField) : true,
      label: f.label, options: mine ? f.options : null, validation: mine ? f.validation : null,
      value: f.value, filled_at: f.filled_at, mine,
      // PandaDoc parity: the signing page evaluates groups, conditions and formulas with these.
      field_key: f.field_key ?? null, group_key: f.group_key ?? null, conditions: f.conditions ?? null, formula: f.formula ?? null, placeholder: f.placeholder ?? null,
      color: Math.max(0, order.indexOf(f.signer_id)), who: who.get(f.signer_id) ?? null,
    }];
  });
  const { data: link } = row.source_pdf_path ? await admin.storage.from('contracts').createSignedUrl(row.source_pdf_path, 600) : { data: null };
  return { fields: out, source_url: link?.signedUrl ?? null };
}

/**
 * Save a batch of this recipient's values. Each must be one of their own,
 * editable fields and valid for its type. One field_filled event per batch
 * (the page sends a batch when the signer leaves a field or moves on), and
 * only for values that changed.
 */
export async function saveSignerValues(
  admin: SupabaseClient, row: Record<string, Any>, signer: Record<string, Any>,
  values: Array<{ id: unknown; value: unknown }>, who: { ip: string | null; user_agent: string | null },
): Promise<{ ok: true; saved: Array<{ id: number; value: string | null }> } | { ok: false; error: string; field_id?: number }> {
  if (!Array.isArray(values) || !values.length) return { ok: true, saved: [] };
  if (values.length > 200) return { ok: false, error: 'Too many fields in one save.' };
  const ids = values.map((v) => Number(v.id)).filter(Number.isFinite);
  const { data: fields } = await admin.from('contract_fields').select(FIELD_COLS).eq('contract_id', row.id).in('id', ids);
  const byId = new Map((fields ?? []).map((f) => [f.id, f as unknown as ContractField]));
  const changes: Array<{ f: ContractField; value: string | null }> = [];
  for (const v of values) {
    const f = byId.get(Number(v.id));
    if (!f || f.signer_id !== signer.id) return { ok: false, error: 'That field is not yours to fill.', field_id: Number(v.id) };
    if (effectiveReadOnly(f) || f.type === 'date_signed') return { ok: false, error: `${f.label || 'That field'} is filled in for you.`, field_id: f.id };
    const r = validateValue(f, v.value);
    if (!r.ok) return { ok: false, error: r.error, field_id: f.id };
    if ((f.value ?? null) !== r.value) changes.push({ f, value: r.value });
  }
  const now = new Date().toISOString();
  for (const c of changes) {
    const { error } = await admin.from('contract_fields').update({
      value: c.value, filled_at: c.value == null ? null : now, filled_ip: c.value == null ? null : who.ip, filled_by: c.value == null ? null : signer.id,
    }).eq('id', c.f.id).eq('signer_id', signer.id);
    if (error) return { ok: false, error: error.message, field_id: c.f.id };
  }
  if (changes.length) {
    await logEvent(admin, row, 'field_filled', {
      signer: signer.role, count: changes.length,
      fields: changes.map((c) => ({ id: c.f.id, type: c.f.type, label: c.f.label ?? null, cleared: c.value == null })),
    }, { actor_type: 'signer', actor_id: signer.email ?? null, signer_id: signer.id, ip: who.ip, user_agent: who.user_agent });
  }
  return { ok: true, saved: changes.map((c) => ({ id: c.f.id, value: c.value })) };
}

/** Required fields this recipient has not filled, as a sentence; null when they are ready to finish. */
export async function unfinished(admin: SupabaseClient, row: Record<string, Any>, signerId: number): Promise<string | null> {
  const { data } = await admin.from('contract_fields').select('id, signer_id, type, required, read_only, value, label, page').eq('contract_id', row.id).eq('signer_id', signerId);
  const left = missingRequired((data ?? []) as Any[], signerId);
  if (!left.length) return null;
  const pages = [...new Set(left.map((f: Any) => f.page))].sort((a, b) => a - b);
  return `${left.length} required field${left.length === 1 ? ' is' : 's are'} still empty (page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}).`;
}

/** The date-signed boxes of this signer get today's date the moment they sign. */
export async function stampDateSigned(admin: SupabaseClient, row: Record<string, Any>, signer: Record<string, Any>, ip: string | null) {
  await admin.from('contract_fields').update({ value: signingDay(), filled_at: new Date().toISOString(), filled_ip: ip, filled_by: signer.id })
    .eq('contract_id', row.id).eq('signer_id', signer.id).eq('type', 'date_signed');
}

/**
 * Someone finished their turn (a form filler pressed Done). Complete the
 * contract when nobody is left, otherwise hand the next turn its link.
 */
export async function afterTurn(admin: SupabaseClient, row: Record<string, Any>, company: Company, origin: string) {
  const { data: rest } = await admin.from('contract_signers').select('id, role, label, name, email, status, sort, recipient_type, token').eq('contract_id', row.id).order('sort');
  const all = (rest ?? []) as Any[];
  if (allSigned(all)) {
    const done = await completeContract(admin, row, company, origin);
    const { data: u } = done.path ? await admin.storage.from('contracts').createSignedUrl(done.path, 600) : { data: null };
    return { completed: true, pdf_url: u?.signedUrl ?? null, waiting_on: 0 };
  }
  if (row.signing_order_mode === 'sequential' && origin) {
    const nextUp = turn(all, 'sequential').filter((s: Any) => s.email);
    if (nextUp.length) {
      try {
        const cc = await ensureTcCc(admin, row);
        await emailSigners(company, row.name, row.message ?? null, nextUp.map((s: Any) => ({ ...s, url: signUrl(origin, s.token) })), { expiresAt: row.expires_at, cc, contractId: row.id });
        await admin.from('contract_signers').update({ last_reminded_at: null }).in('id', nextUp.map((s: Any) => s.id));
        await logEvent(admin, row, 'turn', { next: nextUp.map((s: Any) => s.label || s.role) });
      } catch (e) { console.error('next signer', (e as Error).message); }
    }
  }
  return { completed: false, pdf_url: null, waiting_on: pending(all).length };
}

// ------------------------------------------------------------------ flatten
const WIN = /[^\t\n\x20-\x7E\xA0-\xFF–—‘’“”•…]/g;
const clean = (s: string) => s.replace(/ /g, ' ').replace(WIN, '?');
const pngBytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.split(',')[1] ?? ''), (c) => c.charCodeAt(0));

/**
 * The executed PDF: the original pages with every value drawn where its box
 * was (text, checks, signature and initials images, dates signed), then the
 * signature certificate. What the signers saw is what gets printed.
 */
export async function flattenPdfContract(admin: SupabaseClient, row: Record<string, Any>, company: Company, signers: SignerRow[]): Promise<Uint8Array> {
  const src = String(row.source_pdf_path || row.pdf_path || '');
  if (!src) throw new Error('This PDF contract has no source file.');
  const doc = await PDFDocument.load(await download(admin, 'contracts', src), { ignoreEncryption: true, updateMetadata: false });
  doc.setProducer('CLOZR'); doc.setCreator('CLOZR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const boxes: PageBox[] = pages.map((p) => { const c = p.getCropBox(); return { x0: c.x, y0: c.y, width: c.width, height: c.height, rotation: p.getRotation().angle }; });

  const { data } = await admin.from('contract_fields').select('id, type, page, x, y, w, h, value, label, field_key, group_key, conditions, formula, signer_id').eq('contract_id', row.id).order('page').order('sort');
  // PandaDoc parity: new types mapped to drawable ones, hidden conditional fields blanked, formulas current.
  const { data: atts } = await admin.from('contract_attachments').select('id, label').eq('contract_id', row.id);
  const fields = prepareForFlatten((data ?? []) as Any[], new Map((atts ?? []).map((a) => [a.id, a.label ?? 'file']))) as Array<Pick<ContractField, 'type' | 'page' | 'x' | 'y' | 'w' | 'h' | 'value'>>;
  const images = new Map<string, PDFImage>();
  for (const f of fields) {
    const v = (f.value ?? '').trim();
    if ((f.type === 'signature' || f.type === 'initials') && v.startsWith('data:image/png;base64,') && !images.has(v)) {
      try { images.set(v, await doc.embedPng(pngBytes(v))); } catch { /* an unreadable image is left blank rather than failing the whole document */ }
    }
  }
  const ops = planFlatten(
    fields.map((f) => { const img = images.get((f.value ?? '').trim()); return { ...f, value: f.type === 'signature' || f.type === 'initials' ? (img ? f.value : null) : clean(f.value ?? ''), imageSize: img ? { width: img.width, height: img.height } : null }; }),
    boxes,
    (t, size) => font.widthOfTextAtSize(clean(t), size),
  );
  const ink = rgb(0.06, 0.09, 0.3);
  for (const o of ops) {
    const page = pages[o.page - 1];
    if (!page) continue;
    if (o.op === 'text') page.drawText(clean(o.text), { x: o.x, y: o.y, size: o.size, font, color: ink, rotate: degrees(o.rotate) });
    else if (o.op === 'image') { const img = images.get(o.png); if (img) page.drawImage(img, { x: o.x, y: o.y, width: o.width, height: o.height, rotate: degrees(o.rotate) }); }
    else page.drawLine({ start: o.start, end: o.end, thickness: o.thickness, color: ink });
  }

  // The certificate is the same page the rich-text contracts get.
  const cert = await PDFDocument.load(await toPdf([], {
    title: String(row.name ?? 'Contract'), company, contractId: row.id, signers, certificate: true, certificateOnly: true, hashOf: row.sha256 ?? undefined,
  }));
  const copied = await doc.copyPages(cert, cert.getPageIndices());
  for (const p of copied) doc.addPage(p);
  return doc.save();
}
