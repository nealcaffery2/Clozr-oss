// Reads what the bulk RVM pre-send check needs (rvm_send_preview, migration
// 194). The rules themselves are lib/rvm-send.ts.

import { supabase } from './supabase';
import type { PreviewLine, PreviewPerson } from './rvm-send';
import type { RvmPoolSettings } from './rvm-pool';

export type SendPreviewData = { people: PreviewPerson[]; pool: PreviewLine[]; settings: RvmPoolSettings | null };

export async function loadSendPreview(
  workspaceId: number, sellerIds: number[], buyerIds: number[],
): Promise<{ ok: true; data: SendPreviewData } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Sign in to check the send.' };
  const { data, error } = await supabase.rpc('rvm_send_preview', { p_ws: workspaceId, p_seller_ids: sellerIds, p_buyer_ids: buyerIds });
  // Before migration 194 there is no check to run; the tick still applies every rule.
  if (error) return { ok: false, message: /rvm_send_preview/.test(error.message) ? 'The pre-send check is not set up yet (migration 194).' : error.message };
  const d = (data ?? {}) as { people?: PreviewPerson[]; pool?: PreviewLine[]; settings?: RvmPoolSettings | null };
  return { ok: true, data: { people: d.people ?? [], pool: d.pool ?? [], settings: d.settings ?? null } };
}
