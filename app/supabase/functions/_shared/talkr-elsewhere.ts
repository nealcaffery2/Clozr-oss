/**
 * Which workspace a Talkr call or text belongs to, when one Talkr org carries
 * two businesses.
 *
 * Two workspaces can share a Talkr org, its lines and its people: a rep works
 * the second workspace's leads from the same dialer, on the same rotating
 * caller IDs, as the first workspace's calls. The line says nothing about the
 * business. The person on the other end does: a contact in the second
 * workspace is not one in the first. So a workspace names, in settings.talkr.elsewhere, the other
 * workspaces (same owner) whose contacts it leaves alone, and
 * public.talkr_elsewhere (migration 275) answers, for a batch of numbers and
 * Talkr ids:
 *   - number → workspace: a seller or buyer there, and no seller or buyer here;
 *   - source id → workspace: that call or text is already filed there.
 *
 * Pure: no Postgres, no fetch. call-sync (Deno) and the browser
 * (lib/talkr-elsewhere.ts) both decide with it.
 */

/** settings.talkr.elsewhere, as workspace ids. Anything else is ignored; never the workspace itself. */
export function elsewhereIds(settings: unknown, selfId?: number | null): number[] {
  const talkr = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).talkr : null;
  const raw = talkr && typeof talkr === 'object' ? (talkr as Record<string, unknown>).elsewhere : null;
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (Number.isInteger(n) && n > 0 && n !== selfId && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The key sellers.phone_key and buyers.phone_key hold: public.normalize_phone (E.164, +1 for a bare US number). */
export function phoneKey(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d.length >= 8 && d.length <= 15 ? '+' + d : null;
}

/** The other party on a call or history row: who was dialled, or who rang in. */
export function theirNumber(item: { direction: string; from_number?: string | null; to_number?: string | null }): string | null {
  return phoneKey(item.direction === 'outbound' ? item.to_number : item.from_number);
}

export type ElsewhereRow = { kind: string; key: string; workspace_id: number | null };

/** What talkr_elsewhere answered, as two lookups. */
export type Elsewhere = { numbers: Map<string, number>; sources: Map<string, number> };

export const NOWHERE_ELSE: Elsewhere = { numbers: new Map(), sources: new Map() };

export function elsewhereFromRows(rows: readonly ElsewhereRow[] | null | undefined): Elsewhere {
  const out: Elsewhere = { numbers: new Map(), sources: new Map() };
  for (const r of rows ?? []) {
    const ws = Number(r.workspace_id);
    if (!r.key || !Number.isInteger(ws)) continue;
    if (r.kind === 'number') out.numbers.set(r.key, ws);
    else if (r.kind === 'source') out.sources.set(r.key, ws);
  }
  return out;
}

/**
 * Where one mirrored call or text goes: 'here', or the id of the workspace
 * it belongs to.
 *
 *   1. Filed on a record in another workspace under the same Talkr id: there.
 *      That workspace has no mirror of this org, so its copy came from its
 *      own dialer or composer: the rep placed it from there.
 *   2. Filed on a record here: here.
 *   3. The other party is a contact there and not here: there.
 *   4. Otherwise: here.
 */
export function homeFor(input: { sourceId: string; their: string | null; filedHere?: boolean; away: Elsewhere }): number | 'here' {
  const bySource = input.away.sources.get(input.sourceId);
  if (bySource !== undefined) return bySource;
  if (input.filedHere) return 'here';
  const byNumber = input.their ? input.away.numbers.get(input.their) : undefined;
  return byNumber ?? 'here';
}

/** A Talkr thread with someone who is another workspace's contact, and not this one's. */
export function conversationElsewhere(conv: { their_number: string }, away: Elsewhere): boolean {
  const k = phoneKey(conv.their_number);
  return !!k && away.numbers.has(k);
}

/** The threads this workspace lists. */
export function keepConversations<T extends { their_number: string }>(convs: readonly T[], away: Elsewhere): T[] {
  if (!away.numbers.size) return [...convs];
  return convs.filter((c) => !conversationElsewhere(c, away));
}

/** The communications.source_id a Talkr history row is filed under. */
export function historySourceId(item: { kind?: string; id: string }): string {
  return (item.kind === 'sms' ? 'msg:' : 'call:') + item.id;
}

type HistoryLike = { id: string; kind?: string; direction: string; from_number?: string | null; to_number?: string | null };

/** The calls and texts this workspace lists: not another workspace's contact, not filed there. */
export function keepHistory<T extends HistoryLike>(items: readonly T[], away: Elsewhere): T[] {
  if (!away.numbers.size && !away.sources.size) return [...items];
  return items.filter((h) => {
    if (away.sources.has(historySourceId(h))) return false;
    const k = theirNumber(h);
    return !k || !away.numbers.has(k);
  });
}
