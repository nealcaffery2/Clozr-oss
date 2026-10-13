// Clozr AI's order for Today — the wire to the `clozr-today` edge function.
//
// Today renders the rules' list (lib/today.ts) straight away; this asks Claude
// to rank it and useClozr swaps the order in when it lands. Any failure (no
// API key, a rate limit, the network) resolves null and the rules' order
// stands. One answer per workspace, rep and day, kept for the browser session.

import { supabase } from './supabase';
import type { TodayAiRank, TodayCandidate } from './today';

const read = (key: string): TodayAiRank | null => {
  try {
    const v = sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as TodayAiRank) : null;
  } catch {
    return null;
  }
};
const write = (key: string, v: TodayAiRank) => {
  try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode: rank again next load */ }
};

export const todayAiKey = (workspaceId: number, me: string, day: Date) =>
  `clozr-today:${workspaceId}:${me}:${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;

export async function rankToday(cacheKey: string, workspaceId: number, name: string, items: TodayCandidate[]): Promise<TodayAiRank | null> {
  const cached = read(cacheKey);
  if (cached) return cached;
  if (!supabase || !items.length) return null;
  try {
    const { data, error } = await supabase.functions.invoke('clozr-today', {
      body: { workspace_id: workspaceId, name, items: items.slice(0, 60) },
    });
    const r = data as { ok?: boolean; greeting?: string; items?: { id: string; why: string }[] } | null;
    if (error || !r?.ok || !Array.isArray(r.items) || !r.items.length) return null;
    const out = { greeting: typeof r.greeting === 'string' ? r.greeting : '', items: r.items };
    write(cacheKey, out);
    return out;
  } catch {
    return null;
  }
}
