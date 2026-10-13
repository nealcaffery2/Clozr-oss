// caller_lines' pool and market state (migration 135), read once every few
// minutes for the live-call spin. Before the migration the columns are missing
// and this returns an empty map, so dialing works exactly as it did.

import { supabase } from './supabase';
import type { LinePools } from './caller-spin';

const TTL_MS = 5 * 60_000;
let cache: { ws: number; at: number; data: LinePools } | null = null;

export async function loadLinePools(workspaceId: number | null | undefined): Promise<LinePools> {
  if (!supabase || workspaceId == null) return {};
  if (cache && cache.ws === workspaceId && Date.now() - cache.at < TTL_MS) return cache.data;
  const { data, error } = await supabase.from('caller_lines')
    .select('phone_e164, pool, market_state').eq('workspace_id', workspaceId);
  const out: Record<string, { pool: string | null; state: string | null }> = {};
  if (!error) {
    for (const r of (data ?? []) as unknown as { phone_e164: string; pool: string | null; market_state: string | null }[]) {
      out[r.phone_e164] = { pool: r.pool ?? null, state: r.market_state ?? null };
    }
  }
  cache = { ws: workspaceId, at: Date.now(), data: out };
  return out;
}

/** After the settings card saves, so the next call sees the change. */
export function forgetLinePools(): void {
  cache = null;
}
