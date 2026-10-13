// Talkr's threads and call log, mirrored onto the CLOZR records they belong to.
//
// Calls and texts happen in Talkr. The CRM record is where someone looks to
// decide what to do next, and it can only be right if what happened is on it.
// Talkr emits no message or call webhook CLOZR can subscribe to — its outbound
// fan-out carries call.completed and dispositions, not the thread — but the
// browser is already on Talkr's event stream and holds its recent history for
// the dialer. So the record catches up from what is already in hand.
//
// Everything written here is keyed by Talkr's own id (`msg:…`, `call:…`), so a
// row already recorded is skipped, not rewritten (migration 29). It used to
// be rewritten: every SMS, wrap-up and event-stream nudge, in every tab,
// re-read 60 threads and upserted every message in them (ON CONFLICT DO
// UPDATE, firing the communications BEFORE INSERT triggers), then reloaded
// the whole workspace. Now a cursor (per workspace, shared by this browser's
// tabs) says which threads moved since the last pass and which calls and
// messages are new or changed. Only those are read and written: a row never
// seen is inserted if absent (an existing row is left alone), and a row whose
// status moved since the last pass is updated, so a text going from sent to
// delivered, or a call's final status and talk time, still lands.
//
// A number with no CLOZR record behind it is skipped. A call from a stranger
// is not a lead, and inventing one from a wrong number is how a CRM fills up
// with ghosts.

import { type ConversationDto, type HistoryItemDto, talkr, toE164 } from './talkr';
import { supabase } from './supabase';
import { talkrMirrorAllowed } from './talkr-mirror';

/** Exactly the columns this module writes. */
type Row = {
  workspace_id: number;
  seller_id: number;
  channel: string;
  direction: string;
  occurred_at: string;
  from_phone: string;
  to_phone: string;
  body: string | null;
  summary: string | null;
  duration_s: number | null;
  status: string;
  source: string;
  source_id: string;
};

/** The seller behind a number, or nothing. */
export type SellerIndex = Map<string, number>;

/** Build the number → seller index the sync matches on. */
export function indexByPhone(people: { id: string; phone: string }[], dbId: (id: string) => number): SellerIndex {
  const m: SellerIndex = new Map();
  for (const p of people) {
    const e = toE164(p.phone);
    if (e) m.set(e, dbId(p.id));
  }
  return m;
}

function messageRows(conv: ConversationDto, sellerId: number, workspaceId: number, messages: {
  id: string; direction: 'outbound' | 'inbound'; status: string; body: string;
  created_at: string; sent_at: string | null;
}[]): Row[] {
  return messages.map((m) => {
    const inbound = m.direction === 'inbound';
    return {
      workspace_id: workspaceId,
      seller_id: sellerId,
      channel: 'sms',
      direction: m.direction,
      occurred_at: m.sent_at ?? m.created_at,
      from_phone: inbound ? conv.their_number : conv.our_number,
      to_phone: inbound ? conv.our_number : conv.their_number,
      body: m.body,
      summary: null,
      duration_s: null,
      status: m.status || (inbound ? 'received' : 'sent'),
      source: 'talkr',
      source_id: 'msg:' + m.id,
    };
  });
}

/**
 * A call, as the record shows it.
 *
 * The disposition is the summary, because that is the sentence a rep actually
 * wrote about the call; the note follows it when there is one. Talk time is
 * the number the AI plan builder reads, so it is carried even for a call that
 * went nowhere — a string of eight-second calls is itself the history.
 */
function callRow(item: HistoryItemDto, sellerId: number, workspaceId: number): Row {
  const summary = [item.disposition_label, item.note].filter(Boolean).join(' — ') || null;
  return {
    workspace_id: workspaceId,
    seller_id: sellerId,
    channel: item.status === 'voicemail' ? 'voicemail' : 'call',
    direction: item.direction,
    occurred_at: item.at,
    from_phone: item.from_number,
    to_phone: item.to_number,
    body: item.body,
    summary,
    duration_s: item.duration_seconds,
    status: item.status,
    source: 'talkr',
    source_id: 'call:' + item.id,
  };
}

/**
 * The sellers whose rows were written. `fresh` rows (never seen by the
 * cursor) are inserted only where absent; `moved` rows (seen, status changed)
 * are updated in place. An error writes nothing and returns null.
 */
async function write(fresh: Row[], moved: Row[]): Promise<number[] | null> {
  if (!supabase) return [];
  const sellers = new Set<number>();
  for (const [rows, ignoreDuplicates] of [[fresh, true], [moved, false]] as const) {
    if (!rows.length) continue;
    const { data, error } = await supabase
      .from('communications')
      .upsert(rows, { onConflict: 'workspace_id,source,source_id', ignoreDuplicates })
      .select('seller_id');
    if (error) {
      console.error('could not mirror Talkr onto the records', error.message);
      return null;
    }
    for (const r of (data ?? []) as { seller_id: number | null }[]) if (r.seller_id != null) sellers.add(r.seller_id);
  }
  return [...sellers];
}

/**
 * What the last pass already mirrored: each thread's last message time and
 * each call's status. Kept in localStorage so a second tab, or a reload, does
 * not read every thread again; a browser without storage keeps it in memory.
 */
type Cursor = { convs: Record<string, string>; calls: Record<string, string>; msgs: Record<string, string> };
const CURSOR_KEEP = 500;
const memoryCursor = new Map<number, Cursor>();
const cursorKey = (workspaceId: number) => `clozr.talkrSync.${workspaceId}`;
function readCursor(workspaceId: number): Cursor {
  try {
    const raw = localStorage.getItem(cursorKey(workspaceId));
    if (raw) {
      const j = JSON.parse(raw) as Partial<Cursor>;
      return { convs: j.convs ?? {}, calls: j.calls ?? {}, msgs: j.msgs ?? {} };
    }
  } catch { /* no storage: the in-memory copy */ }
  return memoryCursor.get(workspaceId) ?? { convs: {}, calls: {}, msgs: {} };
}
/** Only the newest CURSOR_KEEP entries of each kind; the dialer holds far fewer. */
const trim = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).slice(-CURSOR_KEEP));
function saveCursor(workspaceId: number, c: Cursor): void {
  const next = { convs: trim(c.convs), calls: trim(c.calls), msgs: Object.fromEntries(Object.entries(c.msgs).slice(-CURSOR_KEEP * 4)) };
  memoryCursor.set(workspaceId, next);
  try { localStorage.setItem(cursorKey(workspaceId), JSON.stringify(next)); } catch { /* memory only */ }
}

/** A thread needs reading when it is new to the cursor or its last message moved. */
export function threadMoved(cursor: Record<string, string>, conv: { id: string; last_message_at?: string | null }): boolean {
  const at = conv.last_message_at ?? '';
  return !at || cursor[conv.id] !== at;
}

/**
 * Mirror what Talkr knows onto the records, and say which sellers got a new
 * row (so the caller re-reads those, not the workspace). Null when the write
 * failed.
 *
 * `history` is what the dialer already loaded, so calls cost no extra request.
 * Threads are fetched per conversation, only for conversations that belong to
 * somebody in the CRM, and only when their last message moved since the last
 * pass (the cursor above).
 */
export async function syncTalkrToRecords(
  workspaceId: number,
  convs: ConversationDto[],
  history: HistoryItemDto[],
  sellers: SellerIndex,
  observedOrgId?: string | null,
): Promise<number[] | null> {
  if (!supabase) return [];
  if (!(await talkrMirrorAllowed(workspaceId, observedOrgId))) return [];
  const cursor = readCursor(workspaceId);
  const seen: Cursor = { convs: { ...cursor.convs }, calls: { ...cursor.calls }, msgs: { ...cursor.msgs } };
  const rows: Row[] = [];
  /** Rows the cursor had seen with another status: these are updated, the rest only inserted. */
  const moved = new Set<string>();

  // Calls, from what is already in hand: only ones new to the cursor or whose status moved.
  for (const item of history) {
    if (item.kind !== 'call') continue;
    if (cursor.calls[item.id] === item.status) continue;
    const outbound = item.direction === 'outbound';
    const theirs = toE164(outbound ? item.to_number : item.from_number);
    const sellerId = theirs ? sellers.get(theirs) : undefined;
    if (sellerId === undefined) continue;
    rows.push(callRow(item, sellerId, workspaceId));
    if (cursor.calls[item.id] !== undefined) moved.add('call:' + item.id);
    seen.calls[item.id] = item.status;
  }

  // Threads, one request each, and only the ones we can place that moved.
  for (const conv of convs) {
    if (!threadMoved(cursor.convs, conv)) continue;
    const theirs = toE164(conv.their_number);
    const sellerId = theirs ? sellers.get(theirs) : undefined;
    if (sellerId === undefined) continue;
    try {
      const { messages } = await talkr.messages(conv.id);
      // Only messages new to the cursor or whose status moved.
      const changed = messages.filter((m) => cursor.msgs[m.id] !== (m.status || ''));
      rows.push(...messageRows(conv, sellerId, workspaceId, changed));
      for (const m of changed) {
        if (cursor.msgs[m.id] !== undefined) moved.add('msg:' + m.id);
        seen.msgs[m.id] = m.status || '';
      }
      if (conv.last_message_at) seen.convs[conv.id] = conv.last_message_at;
    } catch {
      // One unreadable thread must not stop the rest; it is read again next pass.
    }
  }
  if (!rows.length) { saveCursor(workspaceId, seen); return []; }

  // A call already filed on a record stays where it was filed: the dialer puts
  // it on the record the rep dialled, which a number match can get wrong (a
  // buyer who shares a seller's number). call-sync keeps its status current.
  const callIds = rows.filter((r) => r.source_id.startsWith('call:')).map((r) => r.source_id);
  if (callIds.length) {
    const { data: have } = await supabase.from('communications').select('source_id, seller_id, buyer_id')
      .eq('workspace_id', workspaceId).eq('source', 'talkr').in('source_id', callIds.slice(0, 200));
    const filed = new Set(((have ?? []) as { source_id: string; seller_id: number | null; buyer_id: number | null }[])
      .filter((r) => r.seller_id !== null || r.buyer_id !== null).map((r) => r.source_id));
    const keep = rows.filter((r) => !filed.has(r.source_id));
    const out = await write(keep.filter((r) => !moved.has(r.source_id)), keep.filter((r) => moved.has(r.source_id)));
    if (out) saveCursor(workspaceId, seen);
    return out;
  }
  const out = await write(rows.filter((r) => !moved.has(r.source_id)), rows.filter((r) => moved.has(r.source_id)));
  // A failed write keeps the old cursor, so the next pass tries these again.
  if (out) saveCursor(workspaceId, seen);
  return out;
}
