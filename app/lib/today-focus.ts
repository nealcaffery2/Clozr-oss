// "Clozr for today" — the wire to clozr-today's focus action.
//
// The function reads the rep's day as them (RLS), picks 3 to 6 things with
// the rules in lib/focus.ts and, when ANTHROPIC_API_KEY is set, has one model
// call order and rephrase them, checked against the rows. Kept for ten minutes
// per workspace, rep and day in the browser session, so moving between
// screens does not spend another model call; Refresh asks again.

import { supabase } from './supabase';
import type { FocusItem } from './focus';

export type TodayFocusItem = FocusItem & { why: string };
export type TodayFocus = { source: 'ai' | 'rules'; note?: string; greeting: string; items: TodayFocusItem[]; total: number; at: number };

const TTL_MS = 10 * 60_000;
const keyOf = (workspaceId: number, day: Date) => `clozr-focus:${workspaceId}:${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;

function read(key: string): TodayFocus | null {
  try {
    const v = sessionStorage.getItem(key);
    const f = v ? (JSON.parse(v) as TodayFocus) : null;
    return f && Date.now() - f.at < TTL_MS ? f : null;
  } catch {
    return null;
  }
}
function write(key: string, f: TodayFocus) {
  try { sessionStorage.setItem(key, JSON.stringify(f)); } catch { /* private mode: ask again next load */ }
}

export async function loadTodayFocus(workspaceId: number, name: string, opts: { fresh?: boolean } = {}): Promise<{ ok: true; focus: TodayFocus } | { ok: false; message: string }> {
  const key = keyOf(workspaceId, new Date());
  if (!opts.fresh) {
    const cached = read(key);
    if (cached) return { ok: true, focus: cached };
  }
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('clozr-today', { body: { workspace_id: workspaceId, action: 'focus', name } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as { ok?: boolean; source?: string; note?: string; greeting?: string; items?: TodayFocusItem[]; total?: number; error?: string } | null;
  if (!r?.ok || !Array.isArray(r.items)) return { ok: false, message: r?.error ?? 'Clozr returned nothing.' };
  const focus: TodayFocus = {
    source: r.source === 'ai' ? 'ai' : 'rules', ...(r.note ? { note: r.note } : {}),
    greeting: typeof r.greeting === 'string' ? r.greeting : '', items: r.items, total: Number(r.total) || r.items.length, at: Date.now(),
  };
  write(key, focus);
  return { ok: true, focus };
}

/** "Good morning" by the rep's own clock. */
export function partOfDay(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export const FOCUS_CHIPS = [
  'What should I focus on today?',
  'Tell me more about the first one',
  'Make a task for the second one',
  'List my action plans',
  'What is closing this week?',
  'Which of my leads are going cold?',
];
