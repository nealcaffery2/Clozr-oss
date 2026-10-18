// Calls and texts that belong to another workspace on the same Talkr org.
//
// Two workspaces can share one Talkr org, so Talkr hands each of them every
// thread and call in it, the other workspace's work included. The rules are in
// supabase/functions/_shared/talkr-elsewhere.ts; this is the browser half:
// it asks public.talkr_elsewhere (migration 275) about the numbers on screen,
// remembers the answer for a few minutes, and filters the lists the Inbox,
// the dialer and the record mirror read. A workspace with nothing in
// settings.talkr.elsewhere never asks.

import { supabase } from './supabase';
import { loadSettings } from './integrations';
import { notedWorkspaceId } from './active-workspace';
import {
  type Elsewhere, type ElsewhereRow, NOWHERE_ELSE, elsewhereFromRows, elsewhereIds, historySourceId, keepConversations, keepHistory, phoneKey, theirNumber,
} from '../supabase/functions/_shared/talkr-elsewhere';

export { elsewhereIds, type Elsewhere } from '../supabase/functions/_shared/talkr-elsewhere';

const TTL_MS = 5 * 60_000;
/** The RPC reads at most this many numbers and ids per call. */
const BATCH = 400;

const configured = new Map<number, { at: number; ids: Promise<number[]> }>();
/** Per workspace: number → the workspace it belongs to (null: this one), and when that was read. */
const numberCache = new Map<number, Map<string, { at: number; ws: number | null }>>();

/** The workspaces this one leaves out, read from settings at most every five minutes. */
function elsewhereFor(workspaceId: number): Promise<number[]> {
  const hit = configured.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  const ids = loadSettings(workspaceId).then((s) => elsewhereIds(s, workspaceId)).catch(() => []);
  configured.set(workspaceId, { at: Date.now(), ids });
  return ids;
}

/** Settings → Talkr changed the list: read it, and every number, again. */
export function forgetElsewhere(workspaceId: number): void {
  configured.delete(workspaceId);
  numberCache.delete(workspaceId);
}

/**
 * What belongs elsewhere among these numbers and Talkr ids (`call:…`,
 * `msg:…`). Null when the lookup failed, so a writer can wait for the next
 * pass instead of filing a row in the wrong workspace.
 */
export async function awayFor(workspaceId: number, numbers: readonly (string | null | undefined)[], sourceIds: readonly string[] = []): Promise<Elsewhere | null> {
  if (!supabase) return NOWHERE_ELSE;
  if (!(await elsewhereFor(workspaceId)).length) return NOWHERE_ELSE;
  const cache = numberCache.get(workspaceId) ?? new Map<string, { at: number; ws: number | null }>();
  numberCache.set(workspaceId, cache);
  const now = Date.now();
  const keys = [...new Set(numbers.map((n) => phoneKey(n)).filter((k): k is string => !!k))];
  const ask = keys.filter((k) => { const c = cache.get(k); return !c || now - c.at >= TTL_MS; });
  const ids = [...new Set(sourceIds)];
  const rows: ElsewhereRow[] = [];
  for (let i = 0; i < Math.max(ask.length, ids.length); i += BATCH) {
    const { data, error } = await supabase.rpc('talkr_elsewhere' as never, {
      p_workspace: workspaceId, p_numbers: ask.slice(i, i + BATCH), p_source_ids: ids.slice(i, i + BATCH),
    } as never);
    if (error) return null;
    rows.push(...((data ?? []) as ElsewhereRow[]));
  }
  const found = elsewhereFromRows(rows);
  for (const k of ask) cache.set(k, { at: now, ws: found.numbers.get(k) ?? null });
  const numbersAway = new Map<string, number>();
  for (const k of keys) { const ws = cache.get(k)?.ws; if (ws != null) numbersAway.set(k, ws); }
  return { numbers: numbersAway, sources: found.sources };
}

type ConversationList<T> = { conversations: T[]; total: number; counts?: { unread: number } };

/**
 * A conversation list without the threads that belong to another workspace,
 * for the workspace on screen. A failed lookup shows the list as Talkr sent it.
 */
export async function withoutElsewhereConversations<T extends { their_number: string; unread_count?: number }, L extends ConversationList<T>>(list: L): Promise<L> {
  const ws = notedWorkspaceId();
  if (ws == null || !list.conversations.length) return list;
  const away = await awayFor(ws, list.conversations.map((c) => c.their_number)).catch(() => null);
  if (!away || !away.numbers.size) return list;
  const kept = keepConversations(list.conversations, away);
  const gone = list.conversations.length - kept.length;
  if (!gone) return list;
  const unreadGone = list.conversations.filter((c) => !kept.includes(c) && (c.unread_count ?? 0) > 0).length;
  return {
    ...list,
    conversations: kept,
    total: Math.max(kept.length, list.total - gone),
    ...(list.counts ? { counts: { ...list.counts, unread: Math.max(0, list.counts.unread - unreadGone) } } : {}),
  };
}

/** Call and text history without what belongs to another workspace, for the workspace on screen. */
export async function withoutElsewhereHistory<T extends { id: string; kind?: string; direction: string; from_number?: string | null; to_number?: string | null }>(items: T[]): Promise<T[]> {
  const ws = notedWorkspaceId();
  if (ws == null || !items.length) return items;
  const away = await awayFor(ws, items.map((h) => theirNumber(h)), items.map(historySourceId)).catch(() => null);
  return away ? keepHistory(items, away) : items;
}
