// The panels' side of deal memory (migration 399): read the stored rows, ask
// the deal-memory function to rewrite one, learn the newest input on each deal
// for the "New info" mark, and open a source. Reads fail open: no table yet
// reads as "no summary", never as an error.

import { supabase } from './supabase';
import { rowToDealMemory, type DealMemory, type SourceEntry } from './deal-memory';
import { clozrPdfUrl, contractPdf } from './contracts';

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST202' || /does not exist|schema cache/i.test(e.message ?? ''));

export async function loadDealMemories(workspaceId: number, dealIds: number[]): Promise<{ memories: Map<number, DealMemory>; error?: string }> {
  const memories = new Map<number, DealMemory>();
  if (!supabase || !dealIds.length) return { memories };
  const { data, error } = await supabase.from('deal_memory').select('*').eq('workspace_id', workspaceId).in('deal_id', dealIds);
  if (error) return missing(error) ? { memories } : { memories, error: `Could not read the summary: ${error.message}` };
  for (const r of data ?? []) {
    const m = rowToDealMemory(r);
    if (m) memories.set(m.deal_id, m);
  }
  return { memories };
}

/** The newest message, note, file, contract or deal edit on each deal: the panel's staleness check. */
export async function loadNewestInputs(dealIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!supabase || !dealIds.length) return out;
  const { data, error } = await supabase.rpc('deal_memory_newest', { p_deal_ids: dealIds });
  if (error) return out;
  for (const r of (data ?? []) as { deal_id: number; newest_at: string | null }[]) if (r.newest_at) out.set(Number(r.deal_id), r.newest_at);
  return out;
}

export async function refreshDealMemoryNow(workspaceId: number, dealId: number, force = false): Promise<{ memory: DealMemory | null; message?: string; error?: string }> {
  if (!supabase) return { memory: null, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('deal-memory', { body: { action: 'refresh', workspace_id: workspaceId, deal_id: dealId, force } });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) msg = ((await ctx.json()) as { error?: string }).error ?? msg;
    } catch { /* keep the transport message */ }
    if (/failed to send|not found|404/i.test(msg) && !/deal not found/i.test(msg)) msg = 'The deal-memory function is not deployed on the Supabase project.';
    return { memory: null, error: msg };
  }
  const res = data as { memory?: unknown; message?: string };
  return { memory: rowToDealMemory(res.memory), message: res.message };
}

/** A message a source points at, whole: who, when, subject, body. */
export type SourceMessage = { subject: string | null; from: string | null; to: string | null; at: string | null; body: string };

export async function loadSourceMessage(communicationId: number): Promise<SourceMessage | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('communications')
    .select('subject, body, summary, transcript, from_email, to_email, from_phone, to_phone, occurred_at')
    .eq('id', communicationId).maybeSingle();
  if (!data) return null;
  const d = data as Record<string, string | null>;
  return {
    subject: d.subject, at: d.occurred_at, from: d.from_email || d.from_phone, to: d.to_email || d.to_phone,
    body: String(d.body || d.transcript || d.summary || '').trim(),
  };
}

/** A viewable address for a document or contract source; null with a reason when it cannot open. */
export async function sourceDocUrl(workspaceId: number, e: SourceEntry): Promise<{ url: string | null; error?: string }> {
  if (!supabase) return { url: null, error: 'Supabase is not configured.' };
  if (e.deal_file_id) {
    const { data } = await supabase.from('deal_files').select('url, storage_path').eq('id', e.deal_file_id).maybeSingle();
    const f = data as { url: string | null; storage_path: string | null } | null;
    if (f?.url) return { url: f.url };
    if (f?.storage_path) {
      const { data: s } = await supabase.storage.from('deal-files').createSignedUrl(f.storage_path, 3600);
      if (s?.signedUrl) return { url: s.signedUrl };
    }
    return { url: null, error: 'That file is no longer on the deal.' };
  }
  if (e.contract_id) {
    const r = e.provider === 'pandadoc' ? await contractPdf(workspaceId, e.contract_id) : await clozrPdfUrl(workspaceId, e.contract_id).then((x) => (x.ok ? { ok: true as const, data: x.data.url } : x));
    return r.ok ? { url: r.data } : { url: null, error: r.message };
  }
  return { url: null, error: 'This source has no file to open.' };
}
