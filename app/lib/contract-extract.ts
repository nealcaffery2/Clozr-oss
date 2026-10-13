// AI-read contract terms: what docs-extract pulled off a PDF, the difference
// from the deal sheet, and Apply / Dismiss. Every write goes through the
// function, which checks the workspace and role and leaves an audit event;
// the app only reads contract_extractions directly (RLS: members).

import type { ContractExtractionRow } from './database.types';
import type { DiffRow } from '../supabase/functions/_shared/extract-diff';
import { supabase } from './supabase';

export type { ContractExtractionRow, DiffRow };
export { EXTRACT_FIELDS, fieldKind, fieldLabel, normDate, normMoney } from '../supabase/functions/_shared/extract-diff';

type Res<T> = { ok: true; data: T } | { ok: false; message: string };

async function call<T>(body: Record<string, unknown>): Promise<Res<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('docs-extract', { body });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  return { ok: true, data: data as T };
}

export type Review = {
  extractions: ContractExtractionRow[]; diff: DiffRow[]; deal_id: number | null; has_pdf: boolean;
  status: 'running' | 'done' | 'failed' | null; extracted_at: string | null; error: string | null;
};

export const reviewTerms = (contractId: number) => call<Review>({ action: 'review', contract_id: contractId });
/** Read (or re-read) the PDF. Takes as long as Claude takes, usually under a minute. */
export const extractTerms = (contractId: number) => call<{ ok: true; fields: ContractExtractionRow[]; diff: DiffRow[] }>({ action: 'extract', contract_id: contractId });
export const applyTerms = (ids: number[]) => call<{ applied: number[]; patch: Record<string, string | number> }>({ action: 'apply', extraction_ids: ids });
export const dismissTerms = (ids: number[]) => call<{ dismissed: number[] }>({ action: 'dismiss', extraction_ids: ids });

/** Every term read in the workspace, newest first, optionally one kind of term. */
export async function listExtractions(workspaceId: number, fieldKey?: string | null, limit = 2000): Promise<ContractExtractionRow[]> {
  if (!supabase) return [];
  let q = supabase.from('contract_extractions').select('*').eq('workspace_id', workspaceId).is('dismissed_at', null);
  if (fieldKey) q = q.eq('field_key', fieldKey);
  const { data } = await q.order('created_at', { ascending: false }).limit(limit);
  return (data ?? []) as ContractExtractionRow[];
}
