// The contract request's reads and writes (the pure half is lib/contract-request.ts).
//
// Send to TC makes the draft the way New contract does (the `contracts`
// function, send: false, so nothing goes out for signature), then files the
// request with request_contract (migration 272), which notifies the TC.
'use client';

import { supabase } from './supabase';
import { type LibraryTemplate, createClozr, listDocTemplates } from './contracts';
import { createPdfClozr, isPdfTemplate } from './pdf-docs';
import { saveRecipientToCrm } from './contract-recipients';
import { loadDealForSeller } from './deal-sheet';
import { type RequestContext, type RequestForm, type RequestPayload, buildRequestPayload, requestTokens } from './contract-request';

type Res<T> = { ok: true; data: T } | { ok: false; message: string };

/** The template a request of this kind starts on: the workspace's own PDF of that kind, else any of that kind. */
export function defaultTemplate(list: readonly LibraryTemplate[], kind: string): LibraryTemplate | null {
  const ofKind = list.filter((t) => t.kind === kind);
  return ofKind.find((t) => isPdfTemplate(t) && t.workspace_id != null) ?? ofKind.find((t) => t.workspace_id != null) ?? ofKind[0] ?? null;
}

export const requestTemplates = (workspaceId: number) => listDocTemplates(workspaceId);

/** The role on a template that is the party on the line (`party` is seller, seller2, buyer or company). */
const roleFor = (t: LibraryTemplate, side: string) =>
  ((t.signers ?? []) as { role: string; party?: string | null }[]).find((r) => r.party === side)?.role ?? null;

export type DraftResult = { contractId: number | null; sellerId: number | null; buyerId: number | null; dealId: number | null; why: string | null };

/**
 * The draft contract for the request. A party with no record yet is saved to
 * People (with the property and a deal) or Buyers first, the way New contract
 * does for someone new. No template, or one that fails, still files the
 * request: `why` says why there is no draft, and the TC makes it.
 */
export async function makeRequestDraft(workspaceId: number, f: RequestForm, ctx: RequestContext, template: LibraryTemplate | null, userId: string | null): Promise<DraftResult> {
  const rec = ctx.record;
  let sellerId = rec?.sellerId ?? null;
  let buyerId = rec?.buyerId ?? null;
  let dealId = rec?.dealId ?? null;
  if (!sellerId && !buyerId && f.partyName.trim().length >= 2) {
    const kind = f.side === 'buyer' ? 'buyer' : 'seller';
    const saved = await saveRecipientToCrm(workspaceId, { name: f.partyName, email: f.partyEmail, phone: f.partyPhone, addr: f.address }, kind, userId);
    if (saved.ok) {
      if (kind === 'buyer') buyerId = Number(saved.link.buyer_id) || null;
      else {
        sellerId = Number(saved.link.seller_id) || null;
        if (sellerId) dealId = (await loadDealForSeller(workspaceId, sellerId, userId, true)).deal?.id ?? null;
      }
    }
  }
  const ids = { sellerId, buyerId, dealId };
  if (!template) return { contractId: null, ...ids, why: 'No template of that kind yet, so the TC starts the draft.' };
  if (!sellerId && !buyerId && !dealId) return { contractId: null, ...ids, why: 'No record to fill the contract from, so the TC starts the draft.' };
  const role = roleFor(template, f.side === 'buyer' ? 'buyer' : 'seller');
  const signers = role ? [{ role, name: f.partyName.trim() || null, email: f.partyEmail.trim() || null, phone: f.partyPhone.trim() || null }] : [];
  const tokens = requestTokens(f, rec?.address ?? '');
  const name = `${template.name}${f.address.trim() ? ` - ${f.address.split(',')[0].trim()}` : ''}`.slice(0, 200);
  const templateId = template.id;
  const r: { ok: true; id: number } | { ok: false; message: string } = await (isPdfTemplate(template)
    ? createPdfClozr(workspaceId, { templateId, kind: f.kind, name, sellerId, dealId, buyerId, signers, tokens, send: false })
      .then((x) => (x.ok ? { ok: true as const, id: x.data.contract.id } : x))
    : createClozr(workspaceId, { templateId, sellerId, dealId, buyerId, signers, tokens, name, send: false })
      .then((x) => (x.ok ? { ok: true as const, id: (x.data as { contract: { id: number } }).contract.id } : { ok: false as const, message: (x as { message: string }).message })));
  if (!r.ok) return { contractId: null, ...ids, why: `The draft did not save (${r.message}). The TC can start it from the request.` };
  return { contractId: r.id, ...ids, why: null };
}

export type Filed = { id: number; contractId: number | null; notified: { user_id: string; name: string }[] };

/** File the request and notify the TC (request_contract, migration 272). */
export async function fileContractRequest(workspaceId: number, payload: RequestPayload): Promise<Res<Filed>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.rpc('request_contract' as never, { p_workspace_id: workspaceId, p_request: payload } as never);
  if (error) {
    const missing = /request_contract|PGRST202|function .* does not exist/i.test(`${error.code} ${error.message}`);
    return { ok: false, message: missing ? 'Contract requests need database migration 272. It applies when this change merges.' : error.message };
  }
  const d = data as unknown as { id: number; contract_id: number | null; notified: { user_id: string; name: string }[] } | null;
  return d ? { ok: true, data: { id: d.id, contractId: d.contract_id, notified: d.notified ?? [] } } : { ok: false, message: 'The request did not save.' };
}

/** Draft, then request. */
export async function sendToTc(workspaceId: number, f: RequestForm, ctx: RequestContext, template: LibraryTemplate | null, userId: string | null) {
  const draft = await makeRequestDraft(workspaceId, f, ctx, template, userId);
  const payload = buildRequestPayload(f, ctx, { contractId: draft.contractId, sellerId: draft.sellerId, buyerId: draft.buyerId, dealId: draft.dealId });
  const filed = await fileContractRequest(workspaceId, payload);
  return { draft, payload, filed };
}

/** A contract_requests row as the Contracts screen shows it. */
export type RequestRow = {
  id: number; contract_id: number | null; requested_by: string | null; kind: string; template_name: string | null;
  party: { side?: string; name?: string; phone?: string; email?: string } | null; address: string | null;
  price: number | null; closing_date: string | null; emd: number | null; terms: Record<string, string> | null;
  notes: string | null; summary: string | null; call_id: string | null; status: string; created_at: string;
};

/** The request behind a contract, if it came from the dialer. Null before migration 272 too. */
export async function requestForContract(workspaceId: number, contractId: number): Promise<RequestRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('contract_requests' as never).select('*').eq('workspace_id', workspaceId).eq('contract_id', contractId).order('created_at', { ascending: false }).limit(1);
  if (error) return null;
  return ((data ?? []) as unknown as RequestRow[])[0] ?? null;
}

/** Which contracts came from a request, and who asked, for the Contracts list. Empty before migration 272. */
export async function requestedContracts(workspaceId: number): Promise<Map<number, { requestedBy: string | null; status: string }>> {
  const out = new Map<number, { requestedBy: string | null; status: string }>();
  if (!supabase) return out;
  const { data, error } = await supabase.from('contract_requests' as never).select('contract_id, requested_by, status').eq('workspace_id', workspaceId).not('contract_id', 'is', null).order('created_at', { ascending: false }).limit(500);
  if (error) return out;
  for (const r of (data ?? []) as unknown as { contract_id: number; requested_by: string | null; status: string }[]) if (!out.has(r.contract_id)) out.set(r.contract_id, { requestedBy: r.requested_by, status: r.status });
  return out;
}

/** The TC opened it: the request reads as seen. */
export async function markRequestSeen(requestId: number, userId: string | null): Promise<void> {
  if (!supabase) return;
  await supabase.from('contract_requests' as never).update({ status: 'seen', seen_by: userId, seen_at: new Date().toISOString() } as never).eq('id', requestId).eq('status', 'open');
}

/** Contract requests addressed to me in the last `minutes`, unread: what the alert shows on arrival. */
export async function recentRequestNotifications(workspaceId: number, userId: string, minutes = 30) {
  if (!supabase) return [];
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { data, error } = await supabase.from('notifications').select('*').eq('workspace_id', workspaceId).eq('user_id', userId)
    .eq('category', 'Contract request').is('read_at', null).gte('created_at', since).order('created_at', { ascending: true }).limit(10);
  if (error) return [];
  return (data ?? []) as unknown as { id: number; created_at: string; title: string; contract_id?: number | null; payload?: RequestPayload & { request_id?: number } | null }[];
}
