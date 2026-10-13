// Uploaded PDFs as templates and contracts (PDF overlay mode).
//
// The file goes straight from the browser into the private `doc-sources`
// bucket under this workspace's folder (migration 113). A PDF template is a
// doc_templates row with mode 'pdf' plus its placed fields in
// doc_template_fields, both written as the signed-in admin under RLS. A
// contract from one goes through the `contracts` function (create_pdf), which
// copies the file, binds the fields to the actual people and fills the
// variable-bound ones from the record.

import type { FieldDef } from '../supabase/functions/_shared/pdf-fields';
import type { ContractRow, DocTemplate, SignerInput, SignerLink } from './contracts';
import { supabase } from './supabase';

type Res<T> = { ok: true; data: T } | { ok: false; message: string };

/** A template role; `recipient_type: 'filler'` makes that role a form filler by default. */
export type PdfRole = { role: string; label: string; party?: string; optional?: boolean; recipient_type?: 'signer' | 'filler' | null };
export type PdfTemplate = DocTemplate & { mode?: string | null; pdf_path?: string | null };

export const isPdfTemplate = (t: DocTemplate | null | undefined): t is PdfTemplate => (t as PdfTemplate | null | undefined)?.mode === 'pdf';
export const isPdfContract = (c: ContractRow | null | undefined) => (c as { mode?: string } | null | undefined)?.mode === 'pdf';

const MAX_BYTES = 25 * 1024 * 1024;

/** Put a PDF in doc-sources/ws/<ws>/<folder>/…; returns its storage path. */
export async function uploadDocSource(workspaceId: number, file: File, folder: 'templates' | 'uploads'): Promise<Res<string>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (file.type && file.type !== 'application/pdf') return { ok: false, message: 'That file is not a PDF.' };
  if (file.size > MAX_BYTES) return { ok: false, message: 'That PDF is over 25 MB.' };
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) !== '%PDF-') return { ok: false, message: 'That file is not a PDF.' };
  const safe = file.name.replace(/\.pdf$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';
  const path = `ws/${workspaceId}/${folder}/${crypto.randomUUID()}-${safe}.pdf`;
  const { error } = await supabase.storage.from('doc-sources').upload(path, file, { contentType: 'application/pdf', upsert: false });
  return error ? { ok: false, message: error.message } : { ok: true, data: path };
}

/** A 10-minute link to a file in doc-sources, for rendering. */
export async function docSourceUrl(path: string): Promise<Res<string>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.storage.from('doc-sources').createSignedUrl(path, 600);
  return error || !data ? { ok: false, message: error?.message ?? 'Could not open the PDF.' } : { ok: true, data: data.signedUrl };
}

/** Save a new PDF template (owners and admins). */
export async function createPdfTemplate(workspaceId: number, t: { name: string; kind: string; pdfPath: string; roles: PdfRole[]; folderId?: number | null }, userId: string | null): Promise<Res<PdfTemplate>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const key = `pdf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const row = { workspace_id: workspaceId, key, name: t.name, kind: t.kind, body_md: '', signers: t.roles, sort: 150, active: true, mode: 'pdf', pdf_path: t.pdfPath, folder_id: t.folderId ?? null, created_by: userId };
  // mode and pdf_path are migration 113; the generated types predate it.
  const { data, error } = await supabase.from('doc_templates').insert(row as never).select('*').single();
  return error ? { ok: false, message: error.message } : { ok: true, data: data as PdfTemplate };
}

/** Rename a PDF template or change its roles. */
export async function updatePdfTemplate(id: number, patch: { name?: string; kind?: string; roles?: PdfRole[] }): Promise<Res<null>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('doc_templates').update({ ...(patch.name ? { name: patch.name } : {}), ...(patch.kind ? { kind: patch.kind } : {}), ...(patch.roles ? { signers: patch.roles } : {}) } as never).eq('id', id);
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

export async function templateFields(templateId: number): Promise<FieldDef[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('doc_template_fields' as never).select('*').eq('template_id', templateId).order('page').order('sort');
  return (data ?? []) as unknown as FieldDef[];
}

/** Replace a template's fields with the editor's (they are only read when a contract is created). */
export async function saveTemplateFields(workspaceId: number, templateId: number, fields: FieldDef[]): Promise<Res<number>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error: dErr } = await supabase.from('doc_template_fields' as never).delete().eq('template_id', templateId);
  if (dErr) return { ok: false, message: dErr.message };
  if (!fields.length) return { ok: true, data: 0 };
  const rows = fields.map((f, i) => ({
    workspace_id: workspaceId, template_id: templateId, role: f.role, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
    required: !!f.required, read_only: !!f.read_only, label: f.label ?? null, default_value: f.default_value ?? null,
    variable_key: f.variable_key ?? null, options: f.options ?? null, validation: f.validation ?? null, sort: i,
    field_key: f.field_key ?? null, group_key: f.group_key ?? null, conditions: f.conditions ?? null, formula: f.formula ?? null, placeholder: f.placeholder ?? null,
  }));
  const { error } = await supabase.from('doc_template_fields' as never).insert(rows as never);
  return error ? { ok: false, message: error.message } : { ok: true, data: rows.length };
}

async function engine<T>(body: Record<string, unknown>): Promise<Res<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { data, error } = await supabase.functions.invoke('contracts', { body: { origin, ...body } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) return { ok: false, message: String((data as { error: string }).error) };
  return { ok: true, data: data as T };
}

export type PdfCreateResult = { contract: ContractRow; signers: SignerLink[]; emailed: number; texted?: number; failed?: { id: number; reason: string }[]; awaiting_approval?: boolean; pages: number; fields: number; skipped: { role: string; type: string; reason: string }[]; missing: string[] };

/** A contract from a PDF template, or from a one-off upload (sourcePath). */
export const createPdfClozr = (workspaceId: number, i: {
  templateId?: number | null; sourcePath?: string | null; kind?: string; name?: string | null;
  sellerId?: number | null; dealId?: number | null; buyerId?: number | null; offerId?: number | null;
  signers: (Omit<SignerInput, 'recipient_type'> & { recipient_type?: 'signer' | 'cc' | 'viewer' | 'filler' | 'approver' })[]; message?: string | null; expiresDays?: number; send: boolean;
  orderMode?: 'parallel' | 'sequential'; reminders?: { first_after_days: number; repeat_every_days: number } | null;
  notary?: { needs: boolean; mode: 'digital' | 'wet' | 'vendor'; vendor?: string | null } | null;
  /** Values typed on the form ([Group.Name] or {{var}} names); they win over the record's. */
  tokens?: { name: string; value: string }[];
}) => engine<PdfCreateResult>({
  workspace_id: workspaceId, action: 'create_pdf', template_id: i.templateId ?? null, source_path: i.sourcePath ?? null, kind: i.kind ?? 'other', name: i.name ?? null,
  seller_id: i.sellerId ?? null, deal_id: i.dealId ?? null, buyer_id: i.buyerId ?? null, offer_id: i.offerId ?? null,
  signers: i.signers, message: i.message ?? null, expires_days: i.expiresDays ?? 14, send: i.send,
  order_mode: i.orderMode ?? 'parallel', reminders: i.reminders ?? null, notary: i.notary ?? null, tokens: i.tokens ?? [],
});

export type DraftFields = { fields: (FieldDef & { id: number; signer_id: number })[]; signers: { id: number; role: string; label: string | null; name: string | null; email: string | null; recipient_type: string | null; sort: number }[]; source_url: string | null };

export const contractPdfFields = (workspaceId: number, contractId: number) =>
  engine<DraftFields>({ workspace_id: workspaceId, action: 'pdf_fields', contract_id: contractId });
export const saveContractPdfFields = (workspaceId: number, contractId: number, fields: FieldDef[]) =>
  engine<{ fields: number; missing: string[] }>({ workspace_id: workspaceId, action: 'pdf_fields_save', contract_id: contractId, fields });
