// Who is on a running action plan or cold campaign right now, by buyer id:
// the names, for the Compr contacts list's "Action plan" column and filter.
'use client';

import { useEffect, useState } from 'react';
import { supabase } from './supabase';

const EMPTY = new Map<number, string[]>();

/** Reads every page of a query (1,000 rows a page). */
async function all<T>(page: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from);
    if (error) { console.warn('running plans', error.message); break; }
    out.push(...((data ?? []) as T[]));
    if (((data ?? []) as T[]).length < 1000) break;
  }
  return out;
}

export function useRunningPlans(workspaceId: number | null, on: boolean): Map<number, string[]> {
  const [state, setState] = useState<{ ws: number | null; map: Map<number, string[]> }>({ ws: null, map: EMPTY });
  useEffect(() => {
    if (!on || workspaceId == null || !supabase) return;
    const sb = supabase;
    let alive = true;
    void (async () => {
      const [plans, cold] = await Promise.all([
        all<{ buyer_id: number; action_plans: { name: string } | null }>((from) => sb.from('enrollments').select('buyer_id, action_plans(name)')
          .eq('workspace_id', workspaceId).eq('status', 'active').not('buyer_id', 'is', null).order('id').range(from, from + 999)),
        all<{ buyer_id: number; cold_campaigns: { name: string; status: string } | null }>((from) => sb.from('cold_enrollments').select('buyer_id, cold_campaigns(name, status)')
          .eq('workspace_id', workspaceId).eq('status', 'active').not('buyer_id', 'is', null).order('id').range(from, from + 999)),
      ]);
      const map = new Map<number, string[]>();
      const add = (id: number, name: string | undefined) => {
        if (!name) return;
        const list = map.get(id) ?? [];
        if (!list.includes(name)) map.set(id, [...list, name]);
      };
      for (const r of plans) add(r.buyer_id, r.action_plans?.name);
      for (const r of cold) if (r.cold_campaigns?.status === 'active') add(r.buyer_id, r.cold_campaigns.name);
      if (alive) setState({ ws: workspaceId, map });
    })();
    return () => { alive = false; };
  }, [workspaceId, on]);
  return on && state.ws === workspaceId ? state.map : EMPTY;
}

export const ON_A_PLAN = 'On a running plan';
export const NOT_ON_A_PLAN = 'Not on a plan';

/** Whether a contact passes the Action plan filter's picks (any pick matches). */
export function runningMatch(picks: readonly string[], names: readonly string[] | undefined): boolean {
  if (!picks.length) return true;
  const n = names ?? [];
  return picks.some((p) => (p === ON_A_PLAN ? n.length > 0 : p === NOT_ON_A_PLAN ? n.length === 0 : n.includes(p)));
}
