// Stage history (migration 125): every stage a seller, a deal or a buyer has
// been in, when, and who moved it. The triggers write it; this reads it.
//
// Two reads. A record's own history, for its timeline. And "who has ever been
// at this stage", for the People and Buyers filters: answered by the database,
// because a buyer list is 139k rows and the history behind a partner contact
// is hundreds of submissions, none of which the app holds in memory.

import { supabase } from './supabase';
import type { TimelineEntry } from './clozr-types';

export type StageEvent = {
  id: number;
  entityType: 'seller' | 'deal' | 'buyer';
  entityId: number;
  /** lead_stage (seller, or a submission's acquisitions stage), stage (a deal's pipeline), status (a buyer). */
  field: string;
  from: string | null;
  to: string;
  at: string;
  /** The user who moved it; null when no one did (a trigger, a webhook, the cron). */
  by: string | null;
  /** Rebuilt from the record when stage history began: the date is the best one on file. */
  backfill: boolean;
  /** A deal's street, on a seller's history. */
  dealLabel: string | null;
};

type Row = {
  id: number; entity_type: StageEvent['entityType']; entity_id: number; field: string; from_stage: string | null; to_stage: string;
  changed_at: string; changed_by: string | null; source: string; deal_label: string | null;
};

/** A seller's history (its own moves and every one of its deals'), or a buyer's. Newest first. */
export async function loadStageHistory(workspaceId: number, entity: 'seller' | 'buyer', id: number): Promise<StageEvent[] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('record_stage_history', { p_workspace_id: workspaceId, p_entity: entity, p_id: id });
  if (error || !data) return null;
  return (data as Row[]).map((r) => ({
    id: Number(r.id), entityType: r.entity_type, entityId: Number(r.entity_id), field: r.field,
    from: r.from_stage, to: r.to_stage, at: r.changed_at, by: r.changed_by, backfill: r.source === 'backfill', dealLabel: r.deal_label,
  }));
}

export type HistoryMatch = { sellers: Set<number>; deals: Set<number>; buyers: Set<number> };

/**
 * Everyone who has ever been at `stage`, or who reached it inside [from, to).
 * People match on a seller's own moves and on any of their deals' (so a
 * partner is "ever Offer Made" when any submission was); deals come back too,
 * for the lists that show one row per submission.
 */
export async function stageHistoryIds(
  workspaceId: number, entity: 'seller' | 'buyer', stage: string, from: string | null = null, to: string | null = null,
): Promise<HistoryMatch | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('stage_history_ids', {
    p_workspace_id: workspaceId, p_entity: entity, p_stage: stage, p_from: from, p_to: to,
  });
  if (error || !data) return null;
  const out: HistoryMatch = { sellers: new Set(), deals: new Set(), buyers: new Set() };
  for (const r of data as { kind: string; id: number }[]) {
    const id = Number(r.id);
    if (r.kind === 'seller') out.sellers.add(id);
    else if (r.kind === 'deal') out.deals.add(id);
    else if (r.kind === 'buyer') out.buyers.add(id);
  }
  return out;
}

const stamp = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

/**
 * A stage move as a timeline row: a system entry that says what changed, from
 * what, when to the minute, and who did it. `relative` formats the row's time
 * the way every other timeline row is formatted.
 */
export function stageEventEntry(e: StageEvent, entity: string, repName: (id: string | null) => string, relative: (iso: string) => string): TimelineEntry {
  const who = e.by ? repName(e.by) : 'System';
  const move = e.from ? `${e.from} → ${e.to}` : `→ ${e.to}`;
  const what = e.entityType === 'deal'
    ? `${e.dealLabel || 'Deal'} · ${e.field === 'stage' ? 'Pipeline' : 'Stage'} ${move}`
    : `Stage ${move}`;
  const when = e.backfill
    ? `${stamp(e.at)} · rebuilt from the record when stage history began, so the date is the best one on file`
    : `${stamp(e.at)} · moved by ${who}`;
  return { id: 'se' + e.id, type: 'stage', user: e.by, who, time: relative(e.at), title: what, body: when, entity, at: e.at };
}

/** A filter window: 'Ever' is none; the rest end now. Custom uses the two dates (to is inclusive). */
export function historyWindow(when: string, from: string, to: string, now = new Date()): { from: string | null; to: string | null } {
  const day = 86_400_000;
  const back = (days: number) => ({ from: new Date(now.getTime() - days * day).toISOString(), to: null });
  switch (when) {
    case 'Last 7 days': return back(7);
    case 'Last 30 days': return back(30);
    case 'Last 90 days': return back(90);
    case 'This year': return { from: new Date(now.getFullYear(), 0, 1).toISOString(), to: null };
    case 'Custom': {
      const f = /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(from + 'T00:00:00').toISOString() : null;
      const t = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(new Date(to + 'T00:00:00').getTime() + day).toISOString() : null;
      return { from: f, to: t };
    }
    default: return { from: null, to: null };
  }
}
