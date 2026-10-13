// A call's outcome and note, written once, on the call.
//
// The wrap-up card, the outcome picker and the record's outcome bar all end
// here. Each used to write its own copies: a "Call note" communication, an
// activity row ("Call summary", "Call outcome: …") and the summary appended to
// sellers.notes, so one call put three to five items on the timeline. Now the
// outcome and the note are the summary of the call's own row (`talkr` /
// `call:<id>`), in the form the Talkr mirror writes ("Interested — wants 240
// by spring", call-sync and talkr-sync), so the mirror catching up later
// agrees with it instead of adding to it.
//
// A call with no Talkr id (the demo dialer, an outcome logged by hand) has no
// row to write on, so its outcome and note are one note on the record.

import { supabase } from './supabase';
import { createCommunication, type WriteResult } from './crm-write';

export type CallOutcomeInput = {
  workspaceId: number;
  /** Talkr's call id; null when there was no Talkr call. */
  talkrCallId: string | null;
  sellerId: number | null;
  buyerId?: number | null;
  dealId?: number | null;
  /** The outcome as the rep picked it ("Appointment set"); null keeps the one already on the call. */
  outcome: string | null;
  /** What the rep typed; null keeps the one already on the call. */
  note: string | null;
  /** Enough to create the call's row when the hang-up filing and the mirror have not yet. */
  call?: { direction: 'inbound' | 'outbound'; fromPhone?: string | null; toPhone?: string | null; occurredAt: string } | null;
};

const SEP = ' — ';
/** The label a note gets before any outcome is picked, so the note is never mistaken for one. */
export const NOTE_LABEL = 'Call note';

/**
 * The call's summary line with this outcome and note in it. `prev` is what
 * the row says now: its label stays when no outcome is given, its note when
 * no note is. A note with no outcome yet is filed under "Call note", which
 * an outcome picked later replaces. Null when there is nothing to say.
 */
export function outcomeSummary(outcome: string | null, note: string | null, prev: string | null = null): string | null {
  const before = (prev ?? '').trim();
  const at = before.indexOf(SEP);
  const prevLabel = (at >= 0 ? before.slice(0, at) : before).trim() || null;
  const prevNote = (at >= 0 ? before.slice(at + SEP.length) : '').trim() || null;
  const label = outcome?.trim() || prevLabel;
  const text = note?.trim() || prevNote;
  if (text) return (label || NOTE_LABEL) + SEP + text;
  return label || null;
}

export async function writeCallOutcome(input: CallOutcomeInput): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sb = supabase;
  if (input.sellerId === null && (input.buyerId ?? null) === null) return { ok: false, message: 'No record to log the call on.' };

  if (!input.talkrCallId) {
    // A note already titled "Call note": the body is the outcome and the words.
    const body = [input.outcome?.trim(), input.note?.trim()].filter(Boolean).join(SEP);
    if (!body) return { ok: true };
    return createCommunication(input.workspaceId, {
      sellerId: input.sellerId, buyerId: input.sellerId !== null ? null : input.buyerId ?? null, dealId: input.dealId ?? null,
      channel: 'note', direction: 'outbound', body, subject: 'Call note',
    });
  }

  const sourceId = 'call:' + input.talkrCallId;
  const { data: row, error: readErr } = await sb.from('communications')
    .select('id, summary, seller_id, buyer_id')
    .eq('workspace_id', input.workspaceId).eq('source', 'talkr').eq('source_id', sourceId).maybeSingle();
  if (readErr) return { ok: false, message: readErr.message };
  const summary = outcomeSummary(input.outcome, input.note, (row as { summary?: string | null } | null)?.summary ?? null);
  if (!summary) return { ok: true, id: (row as { id?: number } | null)?.id };

  if (row) {
    const r = row as { id: number; seller_id: number | null; buyer_id: number | null };
    // A call the mirror filed on nobody (a number on no record) goes on this one.
    const unfiled = r.seller_id === null && r.buyer_id === null;
    const patch = {
      summary,
      ...(unfiled ? { seller_id: input.sellerId, buyer_id: input.sellerId !== null ? null : input.buyerId ?? null } : {}),
      ...(unfiled && input.dealId != null ? { deal_id: input.dealId } : {}),
    };
    const { error } = await sb.from('communications').update(patch as never).eq('id', r.id);
    return error ? { ok: false, message: error.message } : { ok: true, id: r.id };
  }

  if (!input.call) {
    // No row yet and nothing to make one from: keep the words as a note rather than lose them.
    return writeCallOutcome({ ...input, talkrCallId: null });
  }
  // Same key as the hang-up filing and the mirror, so whichever lands second updates this one.
  const { data, error } = await sb.from('communications').upsert({
    workspace_id: input.workspaceId, source: 'talkr', source_id: sourceId, channel: 'call',
    direction: input.call.direction, occurred_at: input.call.occurredAt,
    seller_id: input.sellerId, buyer_id: input.sellerId !== null ? null : input.buyerId ?? null,
    ...(input.dealId != null ? { deal_id: input.dealId } : {}),
    ...(input.call.fromPhone ? { from_phone: input.call.fromPhone } : {}),
    ...(input.call.toPhone ? { to_phone: input.call.toPhone } : {}),
    summary,
  } as never, { onConflict: 'workspace_id,source,source_id' }).select('id').single();
  return error || !data ? { ok: false, message: error?.message ?? 'The call outcome was not saved.' } : { ok: true, id: (data as { id: number }).id };
}
