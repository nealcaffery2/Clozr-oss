// The Buyers list's response rate and buyer score, from the buyer-score edge
// function's cache (migration 106). Reads fail open: no table, no function or
// demo mode all fall back to the reply ratio the list already computes.

import { supabase } from './supabase';
import { heatText } from './heat';

export type BuyerAiScore = {
  responseRate: number | null;
  /** The counts behind the rate: touches the team sent, answered, offers, closed deals. */
  touches: number; answered: number; offers: number; closed: number;
  score: number;
  reason: string;
  source: 'ai' | 'rule';
  computedAt: string;
};

/**
 * A score older than this is re-asked for the next time the row is on screen.
 * The function answers from its cache unless the buyer has new history, so a
 * short window costs a read, not a model call, and catches imported messages.
 */
export const SCORE_TTL_MS = 864e5;

export const isStale = (s: BuyerAiScore | undefined, now = Date.now()) =>
  !s || s.source !== 'ai' || now - Date.parse(s.computedAt) > SCORE_TTL_MS;

type Raw = { response_rate: number | null; score: number | null; reason: string | null; source: 'ai' | 'rule'; computed_at: string; stats?: unknown };

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const fromRaw = (r: Raw): BuyerAiScore => fromStats(r, (r.stats && typeof r.stats === 'object' ? r.stats : {}) as Record<string, unknown>);
const fromStats = (r: Raw, st: Record<string, unknown>): BuyerAiScore => ({
  responseRate: r.response_rate, score: r.score ?? 0, reason: r.reason ?? '', source: r.source, computedAt: r.computed_at,
  touches: n(st.touches), answered: n(st.answered), offers: n(st.offers), closed: n(st.closed),
});

/** Every cached score in the workspace, by buyer database id. */
export async function loadBuyerScores(workspaceId: number | null): Promise<Map<number, BuyerAiScore>> {
  const out = new Map<number, BuyerAiScore>();
  if (!supabase || workspaceId == null) return out;
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase.from('buyer_scores')
      .select('buyer_id, response_rate, score, reason, source, computed_at, stats')
      .eq('workspace_id', workspaceId).order('buyer_id').range(from, from + 999);
    if (error || !data) break;
    for (const r of data) out.set(r.buyer_id, fromRaw(r));
    if (data.length < 1000) break;
  }
  return out;
}

/**
 * Score these buyers (20 per call). The function reuses a fresh cached score
 * unless `force`. `message` carries why a score is reply-based, e.g. the
 * missing ANTHROPIC_API_KEY secret.
 */
export async function refreshBuyerScores(
  workspaceId: number, buyerIds: number[], force = false,
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: boolean; scores: Map<number, BuyerAiScore>; message?: string }> {
  const scores = new Map<number, BuyerAiScore>();
  if (!supabase) return { ok: false, scores, message: 'Supabase is not configured.' };
  let message: string | undefined;
  const ids = [...new Set(buyerIds)];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const { data, error } = await supabase.functions.invoke('buyer-score', { body: { workspace_id: workspaceId, buyer_ids: chunk, force } });
    if (error) {
      let msg = error.message;
      try {
        const ctx = (error as { context?: Response }).context;
        if (ctx) msg = ((await ctx.json()) as { error?: string }).error ?? msg;
      } catch { /* keep the transport message */ }
      if (/failed to send|not found|404/i.test(msg)) msg = 'The buyer-score function is not deployed on the Supabase project.';
      return { ok: false, scores, message: msg };
    }
    const res = data as { scores?: Record<string, Raw>; message?: string };
    for (const [id, r] of Object.entries(res.scores ?? {})) scores.set(Number(id), fromRaw(r));
    message = res.message ?? message;
    onProgress?.(Math.min(i + chunk.length, ids.length), ids.length);
  }
  return { ok: true, scores, message };
}

/** Colour for a 0-100 figure on the temperature scale (lib/heat.ts). */
export const scoreTone = (n: number) => heatText(n);
