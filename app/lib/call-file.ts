// A call, filed on the record it belongs to the moment it ends.
//
// call-sync mirrors Talkr's history every two minutes and files each call by
// matching the number, which is right for most calls and wrong for some: a
// buyer who shares a number with a seller lands on the seller, and a call
// about a deal never reaches the deal. The dialer knows exactly who it dialled
// (and which deal), so at hang-up it writes the row itself, keyed like the
// mirror (`talkr` / `call:<id>`), with what it heard: the live transcript,
// its timed segments and the AI summary. call-sync then leaves that filing
// alone and fills in the recording, the recording transcript and the scores.
//
// The recording transcript wins: once call-sync marks the transcript
// completed, the live text is never written over it.

import { supabase } from './supabase';
import { TALKR_NOT_CONNECTED, talkrMirrorAllowed } from './talkr-mirror';
import type { CallAiNotes } from './database.types';
import type { SummaryIntelDto } from './talkr';

export type LiveLine = { speaker: 'rep' | 'seller'; text: string; start: number; end: number };

export type FileCallInput = {
  workspaceId: number;
  talkrCallId: string;
  sellerId: number | null;
  buyerId: number | null;
  /** Known from the screen; otherwise the seller's latest deal. */
  dealId?: number | null;
  direction: 'inbound' | 'outbound';
  fromPhone?: string | null;
  toPhone?: string | null;
  occurredAt: string;
  durationS?: number | null;
  status?: string | null;
  lines?: LiveLine[];
  /** Seconds between the call connecting and the transcriber starting, so segment times line up with the recording. */
  offsetS?: number;
  summary?: SummaryIntelDto | null;
  origin?: 'ai_agent' | null;
  /** Talkr org the dialer is signed into. Omitted, the binding alone is enough. */
  talkrOrgId?: string | null;
};

export function liveTranscriptText(lines: LiveLine[], repName = 'Rep', contactName = 'Contact'): string {
  return lines.map((l) => `${l.speaker === 'rep' ? repName : contactName}: ${l.text}`).join('\n');
}

export function liveSegments(lines: LiveLine[], offsetS = 0) {
  return lines.map((l) => ({
    start: Math.max(0, Math.round((l.start + offsetS) * 10) / 10),
    end: Math.max(0, Math.round((l.end + offsetS) * 10) / 10),
    speaker: l.speaker === 'rep' ? 'rep' : 'contact',
    text: l.text,
  }));
}

export function notesFromSummary(s: SummaryIntelDto): CallAiNotes & { source: 'live' } {
  return {
    summary: s.summary || null,
    seller_motivation: s.motivation,
    timeline: s.timeline,
    asking_price: s.price_expectation,
    property_condition: s.condition,
    objections: s.objection ? [s.objection] : [],
    next_step: s.follow_up ?? s.suggested_task,
    sentiment: s.sentiment,
    rep_talk_ratio: s.talk_ratio ? s.talk_ratio.rep / 100 : null,
    source: 'live',
  };
}

/** The seller's most recent deal, the one a seller call is about when the screen did not say. */
async function latestDeal(workspaceId: number, sellerId: number): Promise<number | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('deals').select('id').eq('workspace_id', workspaceId).eq('seller_id', sellerId)
    .order('id', { ascending: false }).limit(1);
  return (data?.[0] as { id?: number } | undefined)?.id ?? null;
}

export async function fileCallOnRecord(input: FileCallInput): Promise<{ ok: true; id: number } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (!(await talkrMirrorAllowed(input.workspaceId, input.talkrOrgId))) return { ok: false, message: TALKR_NOT_CONNECTED };
  if (!input.talkrCallId) return { ok: false, message: 'No Talkr call id to file.' };
  if (input.sellerId === null && input.buyerId === null) return { ok: false, message: 'No record to file the call on.' };
  const sourceId = 'call:' + input.talkrCallId;
  const dealId = input.dealId ?? (input.sellerId !== null ? await latestDeal(input.workspaceId, input.sellerId) : null);

  const base = {
    workspace_id: input.workspaceId,
    source: 'talkr',
    source_id: sourceId,
    channel: 'call',
    direction: input.direction,
    // Exactly one of the two, so a call never sits on a seller and a buyer at once.
    seller_id: input.sellerId,
    buyer_id: input.sellerId !== null ? null : input.buyerId,
    ...(dealId !== null ? { deal_id: dealId } : {}),
    ...(input.fromPhone ? { from_phone: input.fromPhone } : {}),
    ...(input.toPhone ? { to_phone: input.toPhone } : {}),
    ...(input.durationS != null ? { duration_s: input.durationS } : {}),
    ...(input.status ? { status: input.status } : {}),
  };

  // Updated in place when the mirror or a first filing got there first;
  // otherwise inserted as an upsert on the same key, so two filings racing
  // (hang-up, then the summary a moment later; or the two-minute mirror) land
  // on one row instead of one of them failing on the unique key and dropping
  // the transcript.
  type Filed = { id: number; transcript_status: string | null };
  const upd = await supabase.from('communications').update(base as never)
    .eq('workspace_id', input.workspaceId).eq('source', 'talkr').eq('source_id', sourceId)
    .select('id, transcript_status').maybeSingle();
  if (upd.error) return { ok: false, message: upd.error.message };
  let existing = upd.data as Filed | null;
  if (!existing) {
    const ins = await supabase.from('communications')
      .upsert({ ...base, occurred_at: input.occurredAt } as never, { onConflict: 'workspace_id,source,source_id' })
      .select('id, transcript_status').single();
    if (ins.error || !ins.data) return { ok: false, message: ins.error?.message ?? 'The call was not saved.' };
    existing = ins.data as Filed;
  }
  const id = existing.id;

  // What the dialer heard, until the recording transcript lands.
  const recordingDone = existing?.transcript_status === 'completed';
  const lines = input.lines ?? [];
  if (!recordingDone && (lines.length || input.summary)) {
    const patch: Record<string, unknown> = {};
    if (lines.length) patch.transcript = liveTranscriptText(lines);
    if (input.summary) patch.ai_notes = notesFromSummary(input.summary);
    const { error } = await supabase.from('communications').update(patch as never).eq('id', id);
    // The call itself is filed; a refused transcript patch is not a refused filing.
    if (error) console.error('could not store the live transcript on the call', error.message);
  }
  // Migration 106 columns, on their own so a project without them still files the call.
  const extra: Record<string, unknown> = {};
  if (!recordingDone && lines.length) extra.transcript_segments = liveSegments(lines, input.offsetS ?? 0);
  if (input.origin) extra.call_origin = input.origin;
  if (Object.keys(extra).length) await supabase.from('communications').update(extra as never).eq('id', id);
  return { ok: true, id };
}
