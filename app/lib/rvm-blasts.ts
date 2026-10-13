// Blast results for ringless voicemail: one row per bulk send (rvm_drops.blast_id,
// migration 135), with what was delivered, what failed, who called back, and
// the same per caller-ID line. Drops queued by an action plan are one group;
// drops from before blast_id existed group by sender and hour.

import { LOCAL_TIERS, type PoolTier } from './rvm-pool';

export type BlastDrop = {
  id: number;
  blast_id?: string | null;
  enrollment_id?: number | null;
  created_by: string | null;
  created_at: string;
  status: string;
  from_e164: string | null;
  callback_at?: string | null;
  /** Migration 198: how local the caller ID was (lib/rvm-pool.ts PoolTier). */
  pool_tier?: string | null;
};

export type LineTally = { line: string; sent: number; delivered: number; failed: number; callbacks: number };

export type BlastSummary = {
  key: string;
  kind: 'blast' | 'plan';
  created_by: string | null;
  started_at: string;
  total: number;
  delivered: number;
  failed: number;
  skipped: number;
  pending: number;
  callbacks: number;
  /** Drops sent from a pool line local to the recipient (their area code, the lead's state or their phone's), and those with any tier recorded. */
  local: number;
  tiered: number;
  /** Callbacks per delivered drop, 0..1. */
  callbackRate: number;
  /** delivered × cost per drop, when the cost is known. */
  cost: number | null;
  lines: LineTally[];
};

const PENDING = new Set(['queued', 'sending', 'dialing', 'ready']);

function keyOf(d: BlastDrop): { key: string; kind: 'blast' | 'plan' } {
  if (d.blast_id) return { key: `blast:${d.blast_id}`, kind: 'blast' };
  if (d.enrollment_id != null) return { key: 'plan', kind: 'plan' };
  return { key: `legacy:${d.created_by ?? 'nobody'}:${d.created_at.slice(0, 13)}`, kind: 'blast' };
}

export function blastSummaries(drops: readonly BlastDrop[], costPerDrop: number | null = null): BlastSummary[] {
  const groups = new Map<string, BlastSummary & { byLine: Map<string, LineTally> }>();
  for (const d of drops) {
    const { key, kind } = keyOf(d);
    let g = groups.get(key);
    if (!g) {
      g = { key, kind, created_by: d.created_by, started_at: d.created_at, total: 0, delivered: 0, failed: 0, skipped: 0, pending: 0, callbacks: 0, local: 0, tiered: 0, callbackRate: 0, cost: null, lines: [], byLine: new Map() };
      groups.set(key, g);
    }
    g.total++;
    if (d.created_at < g.started_at) g.started_at = d.created_at;
    const delivered = d.status === 'dropped';
    if (delivered) g.delivered++;
    else if (d.status === 'failed') g.failed++;
    else if (d.status === 'skipped') g.skipped++;
    else if (PENDING.has(d.status)) g.pending++;
    const called = !!d.callback_at;
    if (called) g.callbacks++;
    if (d.pool_tier) {
      g.tiered++;
      if (LOCAL_TIERS.has(d.pool_tier as PoolTier)) g.local++;
    }
    if (d.from_e164) {
      const t = g.byLine.get(d.from_e164) ?? { line: d.from_e164, sent: 0, delivered: 0, failed: 0, callbacks: 0 };
      t.sent++;
      if (delivered) t.delivered++;
      if (d.status === 'failed') t.failed++;
      if (called) t.callbacks++;
      g.byLine.set(d.from_e164, t);
    }
  }
  return [...groups.values()].map(({ byLine, ...g }) => ({
    ...g,
    callbackRate: g.delivered ? g.callbacks / g.delivered : 0,
    cost: costPerDrop != null && Number.isFinite(costPerDrop) ? Math.round(g.delivered * costPerDrop * 100) / 100 : null,
    lines: [...byLine.values()].sort((a, b) => b.sent - a.sent || a.line.localeCompare(b.line)),
  })).sort((a, b) => b.started_at.localeCompare(a.started_at));
}
