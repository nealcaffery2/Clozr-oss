// Search across every call transcript, call summary, text, email and voicemail
// in the workspace (migration 271, search_communications). The ⌘K bar lists
// what this finds under "In calls and messages"; Ask CLOZR has the same search
// as its search_conversations tool.
//
// The pure helpers (snippetParts, hitTitle, searchable) are tested in
// tools/comm-search.test.ts.

import { supabase } from './supabase';

export type CommHit = {
  id: number;
  channel: string;
  direction: string | null;
  occurredAt: string;
  durationS: number | null;
  sellerId: number | null;
  buyerId: number | null;
  dealId: number | null;
  /** The seller's or buyer's name; null when the message is on a deal alone. */
  recordName: string | null;
  /** The text around the match, matched words between \u0002 and \u0003. */
  snippet: string;
};

type Row = {
  id: number; channel: string; direction: string | null; occurred_at: string; duration_s: number | null;
  seller_id: number | null; buyer_id: number | null; deal_id: number | null; record_name: string | null; snippet: string | null;
};

/** Shorter than this, a query matches too much to be worth a round trip. */
export const MIN_QUERY = 3;

/** Worth searching: at least MIN_QUERY letters or digits, and not a phone number (the bar finds those by record). */
export function searchable(q: string): boolean {
  const t = q.trim();
  if (t.replace(/[^\p{L}\p{N}]/gu, '').length < MIN_QUERY) return false;
  return !/^[+()\d\s.-]+$/.test(t);
}

/** The snippet as runs of plain and matched text, for highlighting. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  for (const piece of snippet.replace(/\s+/g, ' ').trim().split('\u0002')) {
    const [hit, rest] = piece.includes('\u0003') ? piece.split('\u0003', 2) : [null, piece];
    if (hit) out.push({ text: hit, hit: true });
    if (rest) out.push({ text: rest, hit: false });
  }
  return out;
}

const CHANNEL: Record<string, string> = { call: 'Call', sms: 'Text', email: 'Email', voicemail: 'Voicemail', note: 'Note' };

/** "Call with Kara Mitchell", "Text from Kara Mitchell", "Email to …": the row's title. */
export function hitTitle(h: Pick<CommHit, 'channel' | 'direction' | 'recordName'>): string {
  const what = CHANNEL[h.channel] ?? 'Message';
  const who = h.recordName?.trim();
  if (!who) return what;
  if (h.channel === 'call' || h.channel === 'note') return `${what} with ${who}`;
  return `${what} ${h.direction === 'inbound' ? 'from' : 'to'} ${who}`;
}

/**
 * The best matches for `q` in the workspace, newest among equals. Null when
 * the read failed (the bar says so); [] when nothing matched.
 */
export async function searchConversations(
  workspaceId: number, q: string, opts: { channels?: string[]; max?: number } = {},
): Promise<CommHit[] | null> {
  if (!supabase || !searchable(q)) return [];
  const { data, error } = await supabase.rpc('search_communications' as never, {
    ws: workspaceId, q: q.trim(), channels: opts.channels?.length ? opts.channels : null, max: opts.max ?? 8,
  } as never);
  if (error) return null;
  return ((data ?? []) as Row[]).map((r) => ({
    id: Number(r.id), channel: r.channel, direction: r.direction, occurredAt: r.occurred_at, durationS: r.duration_s,
    sellerId: r.seller_id, buyerId: r.buyer_id, dealId: r.deal_id, recordName: r.record_name, snippet: r.snippet ?? '',
  }));
}
