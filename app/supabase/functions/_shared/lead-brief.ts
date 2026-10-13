// The lead memory (migration 110) for a drafting prompt: the brief plus what
// must never be said, so a text drafted here agrees with what the rep and the
// phone agent read. Missing table, missing row or any error reads as "".
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { briefForPrompt, rowToMemory, type RecordKind } from '../../../lib/lead-memory.ts';

export async function leadBriefs(db: SupabaseClient, ws: number, kind: RecordKind, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  try {
    const { data } = await db.from('lead_memory').select('record_id, record_kind, workspace_id, brief, facts, updated_at')
      .eq('workspace_id', ws).eq('record_kind', kind).in('record_id', ids);
    for (const r of data ?? []) {
      const text = briefForPrompt(rowToMemory(r));
      if (text) out.set(Number((r as { record_id: number }).record_id), text);
    }
  } catch (e) {
    console.error('lead brief read', String(e));
  }
  return out;
}
