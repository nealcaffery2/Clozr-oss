// Contracts, in two engines.
//
// CLOZR's own is the default and the one Acme Homes runs on: the templates
// below the fold live in `doc_templates`, the `contracts` edge function fills
// one from the record and mints a signing link per signer, and `esign` takes
// the signature on /sign. Nothing leaves the project and no vendor key is
// needed.
//
// PandaDoc is opt-in. With a PANDADOC_API_KEY the `pandadoc` function drives
// it properly and `pandadoc-webhook` writes status, recipients and tokens
// back. Without a key all it can do is write a packet of fields for someone
// to paste by hand, which is kept only so that work is not lost.

import { VAR_HELP } from '../supabase/functions/_shared/doc-vars';
import type { Contract } from './database.types';
import { SUPABASE_URL, supabase } from './supabase';
import { mailSignerLinks } from './google';

export type ContractRow = Contract;
export type Recipient = { email: string; first_name?: string; last_name?: string; role?: string; shared_link?: string; has_completed?: boolean };
export type Template = { id: string; name: string; modified?: string };
export type ContractKind = 'psa' | 'assignment' | 'amendment' | 'termination' | 'option' | 'novation' | 'jv' | 'disclosure' | 'addendum' | 'offer' | 'other';

export const KIND_LABELS: Record<ContractKind, string> = {
  psa: 'Purchase agreement', assignment: 'Assignment', amendment: 'Amendment', termination: 'Termination', option: 'Option',
  novation: 'Novation', jv: 'Joint venture', disclosure: 'Disclosure', addendum: 'Addendum', offer: 'Cash offer / LOI', other: 'Other',
};

/** What a template most likely is, from its name — the person can still change it. */
export function guessKind(name: string): ContractKind {
  const n = name.toLowerCase();
  if (/terminat|cancel|release/.test(n)) return 'termination';
  if (/assign/.test(n)) return 'assignment';
  if (/amend/.test(n)) return 'amendment';
  if (/addend/.test(n)) return 'addendum';
  if (/option/.test(n)) return 'option';
  if (/novation/.test(n)) return 'novation';
  if (/joint|jv\b/.test(n)) return 'jv';
  if (/disclos|seller info|information (form|sheet)/.test(n)) return 'disclosure';
  if (/\btrec\b|one to four|residential contract/.test(n)) return 'psa';
  if (/purchase|psa|sale|contract|agreement/.test(n)) return 'psa';
  return 'other';
}

/** The PandaDoc status as a person reads it. */
export function statusLabel(s: string): { text: string; color: string; bg: string } {
  switch (s) {
    case 'completed': return { text: 'Signed', color: '#15803d', bg: '#dcfce7' };
    case 'sent': return { text: 'Sent', color: '#1d4ed8', bg: '#dbeafe' };
    case 'viewed': return { text: 'Viewed', color: '#b45309', bg: '#fef3c7' };
    case 'waiting_approval': case 'approved': return { text: 'In approval', color: '#6d28d9', bg: '#ede9fe' };
    case 'awaiting_approval': return { text: 'Awaiting approval', color: '#6d28d9', bg: '#ede9fe' };
    case 'waiting_pay': case 'paid': return { text: 'Payment', color: '#6d28d9', bg: '#ede9fe' };
    case 'declined': case 'rejected': return { text: 'Declined', color: '#b91c1c', bg: '#fee2e2' };
    case 'voided': return { text: 'Voided', color: '#71717a', bg: '#f4f4f5' };
    case 'expired': return { text: 'Expired', color: '#9a3412', bg: '#ffedd5' };
    case 'error': return { text: 'Error', color: '#b91c1c', bg: '#fee2e2' };
    case 'uploaded': return { text: 'Generating', color: '#71717a', bg: '#f4f4f5' };
    default: return { text: 'Draft', color: '#52525b', bg: '#f4f4f5' };
  }
}

/** Where PandaDoc posts document events. Shown on Settings so the webhook can be created in PandaDoc. */
export const pandadocWebhookUrl = () => (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/pandadoc-webhook` : '');

type Res<T> = { ok: true; data: T } | { ok: false; message: string };

async function call<T>(body: Record<string, unknown>): Promise<Res<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('pandadoc', { body });
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

export const listTemplates = (workspaceId: number, q?: string) =>
  call<{ templates: Template[] }>({ workspace_id: workspaceId, action: 'templates', q });

/** A PandaDoc template's signer roles and merge tokens. */
export const templateDetails = (workspaceId: number, templateId: string) =>
  call<{ id: string; name: string; roles: string[]; tokens: string[] }>({ workspace_id: workspaceId, action: 'template', template_id: templateId });

/** Copy a PandaDoc template into CLOZR as a PDF template (owners and admins); PandaDoc is not used to send it. */
export const importPandaTemplate = (workspaceId: number, templateId: string) =>
  call<{ template: { id: number; name: string } }>({ workspace_id: workspaceId, action: 'import_template', template_id: templateId });

/** Pull documents created or updated in PandaDoc into this workspace. */
export const syncPandaDoc = (workspaceId: number) =>
  call<{ upserted: number }>({ workspace_id: workspaceId, action: 'sync' });

export type CreateInput = {
  template: Template; kind: ContractKind; sellerId?: number | null; dealId?: number | null; buyerId?: number | null;
  recipients: Recipient[]; tokens?: { name: string; value: string }[]; name?: string;
  send?: { subject?: string; message?: string } | null;
};

/** Create the document from a template (and send it in the same call when `send` is set). */
export const createContract = (workspaceId: number, i: CreateInput) =>
  call<{ contract: ContractRow }>({
    workspace_id: workspaceId, action: 'create', template_id: i.template.id, template_name: i.template.name, kind: i.kind,
    seller_id: i.sellerId ?? null, deal_id: i.dealId ?? null, buyer_id: i.buyerId ?? null,
    recipients: i.recipients, tokens: i.tokens ?? [], name: i.name, send: i.send ?? undefined,
  });

export const sendContract = (workspaceId: number, contractId: number, subject?: string, message?: string) =>
  call<{ contract: ContractRow }>({ workspace_id: workspaceId, action: 'send', contract_id: contractId, subject, message });
export const previewContract = (workspaceId: number, contractId: number, recipient?: string) =>
  call<{ url: string; expires_at: string }>({ workspace_id: workspaceId, action: 'preview', contract_id: contractId, recipient });
export const refreshContract = (workspaceId: number, contractId: number) =>
  call<{ contract: ContractRow }>({ workspace_id: workspaceId, action: 'refresh', contract_id: contractId });
export const voidContract = (workspaceId: number, contractId: number) =>
  call<{ contract: ContractRow }>({ workspace_id: workspaceId, action: 'void', contract_id: contractId });

/** The signed (or current) PDF, as a blob URL the browser can open. */
export async function contractPdf(workspaceId: number, contractId: number): Promise<Res<string>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { ok: false, message: 'Sign in first.' };
  const res = await fetch(`${SUPABASE_URL}/functions/v1/pandadoc`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId, action: 'pdf', contract_id: contractId }),
  });
  if (!res.ok) {
    let message = `Could not fetch the PDF (${res.status}).`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* not json */ }
    return { ok: false, message };
  }
  return { ok: true, data: URL.createObjectURL(await res.blob()) };
}

/**
 * Contracts on a seller, their deal, or a buyer, newest first — including
 * any where that person is a recipient (contract_signers.seller_id /
 * buyer_id, migration 114), not only the one the contract is about.
 */
export async function listContracts(workspaceId: number, ids: { sellerId?: number | null; dealId?: number | null; buyerId?: number | null }): Promise<ContractRow[]> {
  if (!supabase) return [];
  const ors = [
    ids.sellerId ? `seller_id.eq.${ids.sellerId}` : null,
    ids.dealId ? `deal_id.eq.${ids.dealId}` : null,
    ids.buyerId ? `buyer_id.eq.${ids.buyerId}` : null,
  ].filter((x): x is string => !!x);
  if (!ors.length) return [];
  const asRecipient = [ids.sellerId ? `seller_id.eq.${ids.sellerId}` : null, ids.buyerId ? `buyer_id.eq.${ids.buyerId}` : null].filter((x): x is string => !!x);
  if (asRecipient.length) {
    // The generated types predate migration 114's columns.
    const { data: linked } = await supabase.from('contract_signers').select('contract_id' as '*').eq('workspace_id', workspaceId).or(asRecipient.join(',')).limit(500);
    const cids = [...new Set(((linked ?? []) as unknown as { contract_id: number }[]).map((r) => r.contract_id))];
    if (cids.length) ors.push(`id.in.(${cids.join(',')})`);
  }
  const { data } = await supabase.from('contracts').select('*').eq('workspace_id', workspaceId).or(ors.join(',')).order('created_at', { ascending: false });
  return live((data ?? []) as ContractRow[]);
}

/** Deleted (docs-plus delete, migration 179) contracts stay for the audit trail but leave every list. */
const live = (rows: ContractRow[]) => rows.filter((c) => !(c as ContractRow & { deleted_at?: string | null }).deleted_at);

/** Every contract in the workspace, newest first, for the Contracts screen. RLS still scopes it by role. */
export async function listAllContracts(workspaceId: number, limit = 1000): Promise<ContractRow[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('contracts').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(limit);
  return live((data ?? []) as ContractRow[]);
}

export const splitName = (full: string | null | undefined): { first_name?: string; last_name?: string } => {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') || undefined };
};

// ------------------------------------------------------------------------
// CLOZR's own engine — templates in the database, signing links, PDFs in
// storage. Goes through the `contracts` edge function; no vendor key.

import type { DocTemplate } from './database.types';

export type { DocTemplate };
export type SignerLink = { id: number; role: string; label: string | null; name: string | null; email: string | null; phone: string | null; status: string; url: string; viewed_at?: string | null; signed_at?: string | null; view_seconds?: number | null;
  /** signer · filler · cc · viewer · approver. A cc or viewer is never asked to sign. */
  recipient_type?: string | null };
export type NotaryChoice = { needs: boolean; mode: 'digital' | 'wet' | 'vendor'; vendor?: string | null };
export type SignerInput = { role: string; label?: string; name?: string | null; email?: string | null; phone?: string | null; optional?: boolean;
  /** signer · cc (gets the signed copy) · viewer (read-only) · approver (signs off before it goes out). */
  recipient_type?: 'signer' | 'cc' | 'viewer' | 'approver';
  /** How the link goes out (migration 114): email, text, or both. */
  delivery?: 'email' | 'sms' | 'both';
  /** The CRM record this recipient is (People, Buyers, Vendors, the team). */
  seller_id?: number | null; buyer_id?: number | null; vendor_id?: number | null; user_id?: string | null;
  /** Which record the template fills this role from (seller, seller2, buyer, company); set by render. */
  party?: string | null;
  /** Added by the sender beyond the template's roles; always cc or viewer. */
  extra?: boolean };
export type RenderResult = { html: string; tokens: { name: string; value: string }[]; used: string[]; missing: string[]; signers: SignerInput[]; deal_id: number | null; seller_id: number | null; buyer_id: number | null;
  /** Reusable sections the template placed (migration 115), and any it points at that were deleted. */
  sections?: { id: number; name: string; locked: boolean }[]; missing_sections?: number[] };

const engine = <T,>(body: Record<string, unknown>) => invoke<T>('contracts', body);

/**
 * The PandaDoc-parity sender actions (docs-plus): void with notice, extend,
 * edit and resend, duplicate, delete, bulk send, timeline. Same session, same
 * workspace check as the contracts function.
 */
export const docsPlus = <T,>(workspaceId: number, action: string, body: Record<string, unknown> = {}) =>
  invoke<T>('docs-plus', { workspace_id: workspaceId, action, ...body });

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<Res<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { data, error } = await supabase.functions.invoke(fn, { body: { origin, ...body } });
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

/**
 * System templates plus this workspace's; a workspace row with the same key
 * replaces the system one. Current versions only (migration 115), and a
 * template this workspace archived is left out — including a built-in it hid.
 */
export async function listDocTemplates(workspaceId: number): Promise<LibraryTemplate[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('doc_templates').select('*').or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`).order('sort');
  const rows = ((data ?? []) as LibraryTemplate[]).filter((t) => t.active || t.archived_at);
  return latestByKey(rows, workspaceId).filter((t) => !t.archived_at);
}

/**
 * Save an edit to a template. Goes through the contracts function so a
 * template contracts were made from gets a new version instead of changing
 * (see supabase/functions/_shared/doc-library.ts); a built-in becomes this
 * workspace's own copy.
 */
export async function saveDocTemplate(workspaceId: number, t: { key: string; name: string; kind: string; body_md: string; signers: DocTemplate['signers']; sort?: number }, _userId: string | null): Promise<Res<DocTemplate>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  void _userId; // the function stamps created_by from the session
  const cur = (await listDocTemplates(workspaceId)).find((x) => x.key === t.key);
  const r = await saveLibraryTemplate(workspaceId, { template_id: cur?.id ?? null, name: t.name, kind: t.kind, body_md: t.body_md, signers: t.signers });
  return r.ok ? { ok: true, data: r.data.template } : r;
}

/** Drop the workspace copy so the system template shows again. */
export async function resetDocTemplate(workspaceId: number, key: string): Promise<Res<null>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('doc_templates').delete().eq('workspace_id', workspaceId).eq('key', key);
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

export const renderClozr = (workspaceId: number, i: { templateId: number; sellerId?: number | null; dealId?: number | null; buyerId?: number | null; offerId?: number | null; tokens?: { name: string; value: string }[] }) =>
  engine<RenderResult>({ workspace_id: workspaceId, action: 'render', template_id: i.templateId, seller_id: i.sellerId ?? null, deal_id: i.dealId ?? null, buyer_id: i.buyerId ?? null, offer_id: i.offerId ?? null, tokens: i.tokens ?? [] });

/**
 * Signing links go out from the sender's own Gmail when they have connected
 * Google, which is the difference between a contract landing in the inbox and
 * landing in promotions. The contract function mints the links and falls back
 * to the transactional sender; this adds whatever Gmail managed on top. A
 * workspace with neither still gets the links to copy, which is why nothing
 * here treats zero as a failure.
 */
export async function alsoByGmail(workspaceId: number, contractId: number, message: string | null, already: number): Promise<number> {
  if (already > 0) return already;
  // Signed in order: the Gmail path would mail every signer at once, so the
  // engine's own turn-by-turn mail is the only one that goes.
  if (supabase) {
    const { data } = await supabase.from('contracts').select('signing_order_mode, status').eq('id', contractId).maybeSingle();
    if ((data as { signing_order_mode?: string } | null)?.signing_order_mode === 'sequential') return already;
    // Waiting on an approver (migration 114): nothing goes to signers yet.
    if ((data as { status?: string } | null)?.status === 'awaiting_approval') return already;
  }
  const r = await mailSignerLinks(workspaceId, contractId, message);
  return r.ok ? r.data.emailed : 0;
}

export async function createClozr(workspaceId: number, i: { templateId: number; sellerId?: number | null; dealId?: number | null; buyerId?: number | null; offerId?: number | null; signers: SignerInput[]; tokens?: { name: string; value: string }[]; name?: string | null; message?: string | null; expiresDays?: number; send: boolean; notary?: NotaryChoice | null;
  /** Parallel (everyone at once) or sequential (in the order listed). */
  orderMode?: 'parallel' | 'sequential';
  /** Automatic reminders; zeros turn them off. */
  reminders?: { first_after_days: number; repeat_every_days: number } | null }) {
  const r = await engine<{ contract: ContractRow; signers: SignerLink[]; missing: string[]; emailed: number; texted?: number; awaiting_approval?: boolean; failed?: Delivered['failed'] }>({
    workspace_id: workspaceId, action: 'create', template_id: i.templateId, seller_id: i.sellerId ?? null, deal_id: i.dealId ?? null, buyer_id: i.buyerId ?? null, offer_id: i.offerId ?? null,
    signers: i.signers, tokens: i.tokens ?? [], name: i.name ?? null, message: i.message ?? null, expires_days: i.expiresDays ?? 14, send: i.send,
    notary: i.notary ?? null, order_mode: i.orderMode ?? 'parallel', reminders: i.reminders ?? null,
  });
  if (!r.ok || !i.send) return r;
  return { ok: true as const, data: { ...r.data, emailed: await alsoByGmail(workspaceId, r.data.contract.id, i.message ?? null, r.data.emailed) } };
}

export async function sendClozr(workspaceId: number, contractId: number, message?: string) {
  const r = await engine<{ contract: ContractRow; signers: SignerLink[]; emailed: number; texted?: number; awaiting_approval?: boolean; failed?: Delivered['failed'] }>({ workspace_id: workspaceId, action: 'send', contract_id: contractId, message });
  if (!r.ok) return r;
  return { ok: true as const, data: { ...r.data, emailed: await alsoByGmail(workspaceId, contractId, message ?? null, r.data.emailed) } };
}
export const signerLinks = (workspaceId: number, contractId: number) =>
  engine<{ signers: SignerLink[] }>({ workspace_id: workspaceId, action: 'links', contract_id: contractId });
export async function remindClozr(workspaceId: number, contractId: number) {
  const r = await engine<{ emailed: number; pending: number; texted?: number; failed?: Delivered['failed'] }>({ workspace_id: workspaceId, action: 'remind', contract_id: contractId });
  if (!r.ok) return r;
  return { ok: true as const, data: { ...r.data, emailed: await alsoByGmail(workspaceId, contractId, null, r.data.emailed) } };
}
export const clozrPdfUrl = (workspaceId: number, contractId: number) =>
  engine<{ url: string }>({ workspace_id: workspaceId, action: 'pdf', contract_id: contractId });

/** Mark a contract for an in-house digital seal, a wet stamp, or a vendor. Digital emails the notary. */
export const setContractNotary = (workspaceId: number, contractId: number, mode: 'digital' | 'wet' | 'vendor', vendor?: string | null) =>
  engine<{ contract: ContractRow; emailed: number; note: string | null }>({ workspace_id: workspaceId, action: 'notary', contract_id: contractId, mode, vendor: vendor ?? null, needs: true });

/** Tokens filled from the record, as a copy-paste block for the PandaDoc template. */
export const contractFields = (workspaceId: number, ids: { sellerId?: number | null; dealId?: number | null; buyerId?: number | null; offerId?: number | null }) =>
  engine<{ tokens: { name: string; value: string }[]; packet: string }>({
    workspace_id: workspaceId, action: 'fields', seller_id: ids.sellerId ?? null, deal_id: ids.dealId ?? null, buyer_id: ids.buyerId ?? null, offer_id: ids.offerId ?? null,
  });

/** Save a PandaDoc packet (no API). The webhook attaches the document Casey sends. */
export const savePandaPacket = (workspaceId: number, i: { kind: ContractKind; sellerId?: number | null; dealId?: number | null; buyerId?: number | null; recipients: Recipient[]; name?: string | null; message?: string | null; templateName?: string | null }) =>
  engine<{ contract: ContractRow; tokens: { name: string; value: string }[]; packet: string }>({
    workspace_id: workspaceId, action: 'packet', kind: i.kind, seller_id: i.sellerId ?? null, deal_id: i.dealId ?? null, buyer_id: i.buyerId ?? null,
    recipients: i.recipients, name: i.name ?? null, message: i.message ?? null, template_name: i.templateName ?? null,
  });

/** Signers on a CLOZR contract, for the status line on the card (no tokens). */
export async function listSigners(workspaceId: number, contractIds: number[]) {
  type SignerSummary = { contract_id: number; role: string; label: string | null; name: string | null; email: string | null; status: string; signed_at: string | null; viewed_at: string | null; view_seconds: number | null; recipient_type?: string | null;
    /** Their last email: sent, delivered, opened, bounced, failed, complained (migration 179, Resend webhook). */
    last_delivery_status?: string | null };
  if (!supabase || !contractIds.length) return [] as SignerSummary[];
  // recipient_type is migration 112, last_delivery_status 179; the generated types predate them.
  const { data } = await supabase.from('contract_signers').select('contract_id, role, label, name, email, status, signed_at, viewed_at, view_seconds, recipient_type, last_delivery_status' as '*').eq('workspace_id', workspaceId).in('contract_id', contractIds).order('sort');
  return (data ?? []) as unknown as SignerSummary[];
}

/** Contracts waiting on the signed-in person, matched by the email on the signer row. */
export type MineToSign = { signerId: number; contractId: number; name: string; label: string; url: string };

export async function myContractsToSign(workspaceId: number, email: string): Promise<MineToSign[]> {
  if (!supabase || !email.includes('@')) return [];
  const { data: rows } = await supabase.from('contract_signers')
    .select('id, contract_id, role, label, status, email, token, recipient_type' as '*')
    .eq('workspace_id', workspaceId)
    .ilike('email', email.trim())
    .in('status', ['pending', 'viewed']);
  const mine = ((rows ?? []) as unknown as { id: number; contract_id: number; role: string; label: string | null; status: string; token: string; recipient_type?: string | null }[])
    .filter((r) => r.token && (!r.recipient_type || r.recipient_type === 'signer'));
  if (!mine.length) return [];
  const { data: contracts } = await supabase.from('contracts').select('id, name, status').in('id', mine.map((r) => r.contract_id)).in('status', ['sent', 'viewed']);
  const open = new Map((contracts ?? []).map((c) => [c.id, c.name]));
  return mine.flatMap((r) => {
    const name = open.get(r.contract_id);
    if (!name) return [];
    return [{ signerId: r.id, contractId: r.contract_id, name, label: r.label || r.role, url: `/sign/?t=${r.token}` }];
  });
}

/** Human labels for the tokens a template can use, for the editor's reference list. */
export const TOKEN_HELP: [string, string][] = [
  ['Property.FullAddress', 'Street, city, state ZIP'], ['Property.Address', 'Street'], ['Property.City', 'City'], ['Property.State', 'State'], ['Property.Zip', 'ZIP'], ['Property.County', 'County'],
  ['Property.LegalDescription', 'Legal description (fill in)'], ['Property.APN', 'Parcel number'], ['Property.Beds', 'Beds'], ['Property.Baths', 'Baths'], ['Property.Sqft', 'Sqft'], ['Property.YearBuilt', 'Year built'],
  ['Seller.Name', 'Seller full name'], ['Seller.FirstName', 'Seller first name'], ['Seller.Email', 'Seller email'], ['Seller.Phone', 'Seller phone'],
  ['Buyer.Company', 'Buyer company (or name)'], ['Buyer.Name', 'Buyer contact name'], ['Buyer.Email', 'Buyer email'], ['Buyer.Phone', 'Buyer phone'],
  ['Deal.PurchasePrice', 'Under-contract price'], ['Deal.EMD', 'Earnest money'], ['Deal.EMDDays', 'Days to deposit EMD (fill in)'], ['Deal.AcceptanceDeadline', 'Acceptance deadline (fill in)'], ['Deal.ClosingDate', 'Close date'],
  ['Deal.TitleCompany', 'Title company'], ['Deal.ContractDate', 'Contract date'], ['Deal.AssignmentPrice', 'Price + assignment fee'], ['Deal.AssignmentFee', 'Assignment fee'], ['Deal.BuyerEMD', 'Buyer EMD (fill in)'], ['Deal.TCFee', 'TC fee (fill in)'],
  ['Deal.ARV', 'ARV'], ['Deal.Repairs', 'Rehab'], ['Deal.MAO', 'MAO'], ['Deal.OtherAgreements', 'Other agreements (fill in)'], ['Deal.SpecialAgreements', 'Special agreements (fill in)'],
  ['Offer.Amount', 'Offer amount'], ['Offer.Expires', 'Offer expiration'], ['Offer.EMD', 'Offer EMD'], ['Offer.CloseDays', 'Days to close'],
  ['Company.Name', 'Trade name'], ['Company.Legal', 'Legal entity'], ['Company.Address', 'Company address'], ['Company.Signer', 'Who signs for the company'], ['Company.Title', 'Signer title'], ['Company.Email', 'Company email'], ['Company.Phone', 'Company phone'],
  ['Date.Today', "Today's date"],
  ['Company.Escrow', 'Escrow holder on the purchase agreement'],
  // Migration 75: the rest of the Acme Homes stack. Anything the record cannot
  // answer shows up as a fill-in on the New contract form, so these labels are
  // what the person filling it reads.
  ['Seller2.Name', 'Second seller full name'], ['Seller2.Email', 'Second seller email'], ['Seller2.Phone', 'Second seller phone'],
  ['Amend.CashPortion', 'Amended cash at closing'], ['Amend.Financing', 'Amended financing'], ['Amend.SalesPrice', 'Amended sales price'],
  ['Amend.Repairs', 'Repairs and treatments Seller completes'], ['Amend.ClosingDate', 'New closing date'], ['Amend.OptionWaiver', 'Buyer waives the option (yes / no)'], ['Amend.Other', 'Other modifications'],
  ['Option.Start', 'Option starts'], ['Option.End', 'Option ends'], ['Option.Price', 'Option purchase price'], ['Option.ClosingCostsBy', 'Who pays closing costs'], ['Option.LicenseeStatus', 'Buyer is / is not a licensee'],
  ['Lease.MoveOut', 'Seller move-out date'], ['Lease.Days', 'Days to vacate after closing'], ['Lease.DailyRent', 'Daily rent'], ['Lease.TotalRent', 'Total rent due at closing'], ['Lease.Deposit', 'Security deposit'], ['Lease.Holdover', 'Holdover rent per day'],
  ['Holdback.Purpose', 'What the holdback is for'], ['Holdback.Amount', 'Holdback amount'], ['Holdback.Escrow', 'Title company or attorney holding it'], ['Holdback.Address', 'Their address'],
  ['Holdback.Conditions', 'Conditions for release'], ['Holdback.VerifiedBy', 'Verified by Buyer or Escrow Officer'], ['Holdback.Deadline', 'Deadline for completion'],
  ['Title.File', 'Title file number'], ['Seller.Marital', 'Seller marital status'], ['Seller.Forwarding', 'Seller forwarding address'], ['Seller.HasSurvey', 'Existing survey (yes / no)'], ['Seller.Citizens', 'All sellers are US citizens (yes / no)'],
  ['HOA.Exists', 'Property has an HOA (yes / no)'], ['HOA.Name', 'HOA name'], ['HOA.Manager', 'HOA management company'], ['HOA.Contact', 'HOA contact'], ['HOA.More', 'More than one HOA (yes / no)'],
  ['Legal.Lot', 'Lot'], ['Legal.Block', 'Block'], ['Legal.Addition', 'Addition'],
  ['Trec.CashPortion', 'Cash at closing'], ['Trec.Financing', 'Sum of financing'], ['Trec.SalesPrice', 'Sales price'], ['Trec.Exclusions', 'Items Seller keeps'],
  ['Trec.EscrowAgent', 'Escrow agent'], ['Trec.EscrowAddress', "Escrow agent's address"], ['Trec.EarnestMoney', 'Earnest money'], ['Trec.OptionFee', 'Option fee'], ['Trec.OptionDays', 'Option period (days)'],
  ['Trec.TitleCompany', 'Title company'], ['Trec.TitlePolicyExpense', "Title policy at Seller's or Buyer's expense"], ['Trec.ClosingDate', 'Closing date'],
  ['Trec.Survey', 'Survey: 6C(1), (2) or (3)'], ['Trec.SurveyDays', 'Days for the survey'], ['Trec.SellerDisclosure', "Seller's Disclosure: 7B(1), (2) or (3)"],
  ['Trec.AsIs', 'As Is: 7D(1) or (2)'], ['Trec.Repairs', 'Specific repairs Seller completes'], ['Trec.Possession', 'Possession: upon closing and funding, or under a lease'],
  ['Trec.SpecialProvisions', 'Special provisions'], ['Trec.Addenda', 'Addenda attached'],
  // Clozr Docs variables (supabase/functions/_shared/doc-vars.ts): {{deal.purchase_price|currency}},
  // |words, |date:long, |upper, |default:"N/A", and {{#if property.state == "TX"}}…{{/if}} riders.
  ...VAR_HELP.map(([k, v]) => [k, v] as [string, string]),
];

// ------------------------------------------------------------------------
// Template library (migration 115): versions, folders, reusable sections.
// Reads and writes go through the `contracts` function, which owns the
// versioning rules (supabase/functions/_shared/doc-library.ts).

import { latestByKey } from '../supabase/functions/_shared/doc-library';

export type ReminderPolicy = { first_after_days: number; repeat_every_days: number };
/** A doc_templates row with the library columns from migration 115. */
export type LibraryTemplate = DocTemplate & {
  version?: number | null; parent_id?: number | null; superseded_at?: string | null; archived_at?: string | null; folder_id?: number | null;
  default_expiry_days?: number | null; reminder_policy?: ReminderPolicy | null; default_signing_order?: 'parallel' | 'sequential' | null;
};
/** As the library lists it: with this workspace's usage for the whole family and for this version. */
export type ListedTemplate = LibraryTemplate & { family_id: number; used: number; used_this: number; built_in: boolean };
export type TemplateVersion = LibraryTemplate & { used: number; built_in: boolean; current: boolean };
export type DocFolder = { id: number; scope: 'templates' | 'contracts'; name: string; parent_id: number | null; sort: number };
export type DocBlock = { id: number; name: string; body: string; tags: string[]; locked: boolean; updated_at?: string };
export type Library = { templates: ListedTemplate[]; folders: DocFolder[]; contract_folders: DocFolder[]; blocks: DocBlock[]; can_edit: boolean };
export type TemplateFields = {
  template_id?: number | null; name?: string; kind?: string; body_md?: string; signers?: DocTemplate['signers']; folder_id?: number | null;
  default_expiry_days?: number | null; reminder_policy?: ReminderPolicy | null; default_signing_order?: 'parallel' | 'sequential' | null;
};

export const loadLibrary = (workspaceId: number) => engine<Library>({ workspace_id: workspaceId, action: 'library' });
export const templateVersions = (workspaceId: number, templateId: number) =>
  engine<{ versions: TemplateVersion[] }>({ workspace_id: workspaceId, action: 'template_versions', template_id: templateId });
/** Save (or create, without template_id). `versioned` says a new version was made because the old one had been used. */
export const saveLibraryTemplate = (workspaceId: number, f: TemplateFields) =>
  engine<{ template: LibraryTemplate; versioned: boolean }>({ workspace_id: workspaceId, action: 'template_save', ...f });
export const restoreTemplateVersion = (workspaceId: number, templateId: number) =>
  engine<{ template: LibraryTemplate; restored_from: number }>({ workspace_id: workspaceId, action: 'restore_version', template_id: templateId });
export const duplicateTemplate = (workspaceId: number, templateId: number) =>
  engine<{ template: LibraryTemplate }>({ workspace_id: workspaceId, action: 'template_duplicate', template_id: templateId });
export const archiveTemplate = (workspaceId: number, templateId: number, archived: boolean) =>
  engine<{ template: LibraryTemplate }>({ workspace_id: workspaceId, action: 'template_archive', template_id: templateId, archived });
export const moveTemplate = (workspaceId: number, templateId: number, folderId: number | null) =>
  engine<{ template: LibraryTemplate }>({ workspace_id: workspaceId, action: 'template_move', template_id: templateId, folder_id: folderId });
export const folderOp = (workspaceId: number, scope: 'templates' | 'contracts', op: 'create' | 'rename' | 'move' | 'delete', f: { id?: number; name?: string; parent_id?: number | null }) =>
  engine<{ folders: DocFolder[] }>({ workspace_id: workspaceId, action: 'folders', scope, op, ...f });
export const saveBlock = (workspaceId: number, block: { id?: number | null; name: string; body: string; tags: string[]; locked: boolean }) =>
  engine<{ blocks: DocBlock[] }>({ workspace_id: workspaceId, action: 'blocks', op: 'save', block });
export const deleteBlock = (workspaceId: number, id: number) =>
  engine<{ blocks: DocBlock[] }>({ workspace_id: workspaceId, action: 'blocks', op: 'delete', id });
export const addStarterBlocks = (workspaceId: number) =>
  engine<{ blocks: DocBlock[]; added: number }>({ workspace_id: workspaceId, action: 'blocks', op: 'starter' });
/** Folders only (any member can read them): contract folders for the Contracts screen, template folders for the New contract picker. */
export const contractFolders = (workspaceId: number) =>
  engine<{ folders: DocFolder[] }>({ workspace_id: workspaceId, action: 'folders', scope: 'contracts', op: 'list' });
export const templateFolders = (workspaceId: number) =>
  engine<{ folders: DocFolder[] }>({ workspace_id: workspaceId, action: 'folders', scope: 'templates', op: 'list' });
export const fileContract = (workspaceId: number, contractId: number, folderId: number | null) =>
  engine<{ contract: ContractRow }>({ workspace_id: workspaceId, action: 'contract_folder', contract_id: contractId, folder_id: folderId });

// People flows (migration 114): approvers, recipients added or corrected
// after sending, delivery by text. Goes through the same `contracts` function.

export type ContractRecipient = {
  id: number; role: string; label: string | null; name: string | null; email: string | null; phone: string | null;
  status: string; sort: number; recipient_type: 'signer' | 'cc' | 'viewer' | 'approver' | 'filler' | null; delivery: 'email' | 'sms' | 'both' | null;
  seller_id: number | null; buyer_id: number | null; vendor_id: number | null; user_id: string | null;
  signed_at: string | null; viewed_at: string | null; approved_at: string | null; rejected_at: string | null; reject_reason: string | null;
  delegated_from: number | null; delegated_to: number | null; delegate_reason: string | null; url: string | null;
};
export type Delivered = { emailed: number; texted: number; failed: { id: number; reason: string }[] };
export type NewRecipientInput = {
  name?: string | null; email?: string | null; phone?: string | null; label?: string | null;
  recipient_type: 'signer' | 'cc' | 'viewer' | 'approver'; delivery?: 'email' | 'sms' | 'both';
  /** 1-based place in the order; empty appends. */
  position?: number | null;
  seller_id?: number | null; buyer_id?: number | null; vendor_id?: number | null; user_id?: string | null;
};

export const listRecipients = (workspaceId: number, contractId: number) =>
  engine<{ recipients: ContractRecipient[] }>({ workspace_id: workspaceId, action: 'recipients', contract_id: contractId });

/** An approver answers from the app. A rejection needs a reason; the last approval sends it. */
export const answerApproval = (workspaceId: number, contractId: number, decision: 'approve' | 'reject', reason?: string | null, signerId?: number | null) =>
  engine<{ approved: boolean; sent: boolean; status: string; emailed: number; texted: number }>({ workspace_id: workspaceId, action: 'approve', contract_id: contractId, decision, reason: reason ?? null, signer_id: signerId ?? null });

export const addContractRecipient = (workspaceId: number, contractId: number, recipient: NewRecipientInput) =>
  engine<{ recipient: ContractRecipient } & Delivered>({ workspace_id: workspaceId, action: 'add_recipient', contract_id: contractId, recipient });

/** Fix a typo'd email or phone (a fresh link replaces the old one) and optionally send the link again. */
export const updateContractRecipient = (workspaceId: number, contractId: number, signerId: number, patch: { name?: string | null; email?: string | null; phone?: string | null; delivery?: 'email' | 'sms' | 'both'; resend?: boolean }) =>
  engine<{ recipient: ContractRecipient; changed: string[]; crm: { seller_id: number | null; buyer_id: number | null; vendor_id: number | null } } & Delivered>({ workspace_id: workspaceId, action: 'update_recipient', contract_id: contractId, signer_id: signerId, ...patch });

/** "Emailed 2 · texted 1", or why a text did not go. */
export function deliveredText(d: Partial<Delivered> | null | undefined): string {
  const bits = [d?.emailed ? `emailed ${d.emailed}` : null, d?.texted ? `texted ${d.texted}` : null].filter(Boolean);
  const failed = d?.failed?.length ? `text not sent: ${d.failed.map((f) => f.reason).join('; ')}` : null;
  return [bits.join(' · '), failed].filter(Boolean).join(' · ');
}
