// What a call or a text thread says the record should now say.
//
// The `record-suggest` edge function reads the conversation and proposes
// updates; nothing lands until a person clicks Apply, and Apply routes to the
// writers the rest of CLOZR already uses (applyCallFacts, setStage, createTask,
// createCalendarEvent) so a suggestion applied is indistinguishable from the
// same change made by hand.

import { applyCallFacts, createTask, logActivity, setStage, type WriteResult } from './crm-write';
import { createCalendarEvent } from './calendar';
import { SELLER_STAGE_LABELS } from './stages';
import { supabase } from './supabase';
import type { CallAiNotes } from './database.types';
import type { CallScoreDto } from './talkr-web/api';
import { api as talkrWeb } from './talkr-web/api';
import { isCoachingReview, type CallCoachingReview } from './call-coaching';
import { parseSegments, segmentsFromText, type CallSection, type CallSegment, type StoredSections } from './call-media';

export type Suggestion = {
  kind: 'field' | 'stage' | 'task' | 'appointment' | 'note';
  field?: 'motivation' | 'asking_price';
  value?: string;
  stage?: string;
  title?: string;
  due_at?: string;
  starts_at?: string;
  ends_at?: string;
  reason: string;
  quote: string;
};

export type SmsLine = { direction: 'inbound' | 'outbound'; body: string; at: string };

async function suggest(body: Record<string, unknown>): Promise<{ ok: true; suggestions: Suggestion[] } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('record-suggest', { body: { ...body, stages: SELLER_STAGE_LABELS } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as { ok?: boolean; suggestions?: Suggestion[]; error?: string };
  return r?.ok ? { ok: true, suggestions: r.suggestions ?? [] } : { ok: false, message: r?.error ?? 'No suggestions came back.' };
}

export const suggestForCall = (workspaceId: number, sellerId: number, transcript: string, communicationId?: number) =>
  suggest({ workspace_id: workspaceId, seller_id: sellerId, source: 'call', communication_id: communicationId, transcript });

export const suggestForSms = (workspaceId: number, sellerId: number, messages: SmsLine[]) =>
  suggest({ workspace_id: workspaceId, seller_id: sellerId, source: 'sms', messages: messages.slice(-40) });

/** One line for the list and the activity feed. */
export function describeSuggestion(s: Suggestion): string {
  const when = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso))
    ? new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  switch (s.kind) {
    case 'field': return (s.field === 'asking_price' ? 'Asking price' : 'Motivation') + ' → ' + (s.value ?? '');
    case 'stage': return 'Stage → ' + (s.stage ?? '');
    case 'task': return 'Task: ' + (s.title ?? '') + (s.due_at ? ' · ' + when(s.due_at) : '');
    case 'appointment': return 'Appointment: ' + (s.title ?? 'Appointment') + ' · ' + when(s.starts_at);
    default: return 'Note: ' + (s.value ?? '');
  }
}

/** Apply one suggestion through the writer the same change would use by hand. */
export async function applySuggestion(workspaceId: number, sellerId: number, me: string | null, s: Suggestion): Promise<WriteResult> {
  let res: WriteResult;
  switch (s.kind) {
    case 'field': {
      if (s.field === 'asking_price') {
        const n = Number(String(s.value ?? '').replace(/[^0-9.]/g, ''));
        if (!n) return { ok: false, message: 'No price to apply.' };
        res = await applyCallFacts(sellerId, { asking_price: n });
      } else if (s.field === 'motivation' && s.value) {
        res = await applyCallFacts(sellerId, { motivation: s.value });
      } else return { ok: false, message: 'Nothing to apply.' };
      break;
    }
    case 'note':
      if (!s.value) return { ok: false, message: 'Nothing to apply.' };
      res = await applyCallFacts(sellerId, { note: s.value });
      break;
    // setStage logs its own activity.
    case 'stage':
      if (!s.stage || !SELLER_STAGE_LABELS.includes(s.stage)) return { ok: false, message: 'Unknown stage.' };
      return setStage(workspaceId, String(sellerId), s.stage, me);
    case 'task': {
      // createTask reads what a person would type ("Sep 15, 3:00 PM").
      const due = s.due_at && !Number.isNaN(Date.parse(s.due_at))
        ? new Date(s.due_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      res = await createTask(workspaceId, { personId: String(sellerId), title: s.title || 'Follow up', due, type: 'Call' }, me);
      break;
    }
    case 'appointment': {
      const start = Date.parse(s.starts_at ?? '');
      if (Number.isNaN(start)) return { ok: false, message: 'No time to book.' };
      const end = Date.parse(s.ends_at ?? '');
      const cal = await createCalendarEvent(workspaceId, {
        title: s.title || 'Appointment', kind: 'Appointment',
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(Number.isNaN(end) || end <= start ? start + 3_600_000 : end).toISOString(),
        seller_id: sellerId, notes: s.quote ? `“${s.quote}”` : null,
      }, me);
      res = cal.ok ? { ok: true, id: cal.id } : { ok: false, message: cal.message };
      break;
    }
    default:
      return { ok: false, message: 'Unknown suggestion.' };
  }
  if (res.ok) await logActivity(workspaceId, 'seller', sellerId, 'ai_suggestion', 'Applied: ' + describeSuggestion(s), s.quote || undefined, me);
  return res;
}

// ---- the call itself --------------------------------------------------------

export type CallMedia = {
  /** An <audio> src: a signed URL for a copied recording, a blob: URL for a Talkr recording, or the stored recording_url. */
  audioUrl: string | null;
  transcript: string | null;
  summary: string | null;
  /** Talkr's structured notes (call-sync, migration 67), when stored. */
  notes: CallAiNotes | null;
  /** Talkr's coaching score (call-sync), when the native card is not stored. */
  score: CallScoreDto | null;
  /** Native scorecard (migration 89), when stored. */
  review: CallCoachingReview | null;
  /** Why there is no transcript, when there is none. */
  transcriptNote: string | null;
  /** The timed transcript for the player; `estimated` when the times were spread over flat text. */
  segments: CallSegment[];
  estimated: boolean;
  durationS: number | null;
  /** Chapters stored by call-sections (migration 106), when computed. */
  sections: CallSection[] | null;
  sectionsSource: 'ai' | 'keywords' | null;
  communicationId: number | null;
};

/**
 * Everything the record can show about one call.
 *
 * call-sync (supabase/functions/call-sync) stores the transcript, the AI notes,
 * the coaching score and a copy of the recording on the communications row a
 * couple of minutes after the call, so the record reads those first. A call
 * the sync has not finished yet falls back to Talkr live (GET
 * /v1/calls/:id/transcript, GET /v1/recordings/:id/audio), as before.
 */
export async function loadCallMedia(communicationId: number): Promise<CallMedia> {
  const out: CallMedia = {
    audioUrl: null, transcript: null, summary: null, notes: null, score: null, review: null, transcriptNote: null,
    segments: [], estimated: false, durationS: null, sections: null, sectionsSource: null, communicationId,
  };
  if (!supabase) return out;
  // '*' so the migration-106 columns come back when they exist and nothing breaks when they do not.
  const { data: row } = await supabase.from('communications').select('*').eq('id', communicationId).maybeSingle();
  if (!row) return out;
  out.durationS = row.duration_s ?? null;
  const stored = parseSegments(row.transcript_segments);
  if (stored) out.segments = stored;
  const sec = row.call_sections as StoredSections | null | undefined;
  if (sec && Array.isArray(sec.sections) && sec.sections.length) { out.sections = sec.sections; out.sectionsSource = sec.source ?? 'ai'; }
  const finish = () => {
    if (!out.segments.length && out.transcript) {
      out.segments = segmentsFromText(out.transcript, out.durationS);
      out.estimated = out.segments.length > 0;
    }
    return out;
  };
  out.summary = row.summary;
  out.notes = row.ai_notes ?? null;
  if (out.notes?.summary) out.summary = out.notes.summary;
  out.transcript = row.transcript ?? null;
  const storedScore = row.call_score as CallScoreDto | null;
  out.score = storedScore && storedScore.status === 'completed' ? storedScore : null;
  out.review = isCoachingReview(row.coaching_review) ? row.coaching_review : null;

  // A copied recording lives in our private bucket; sign a URL for the <audio> tag.
  if (row.recording_url?.startsWith('storage:')) {
    const [bucket, ...rest] = row.recording_url.slice('storage:'.length).split('/');
    const { data } = await supabase.storage.from(bucket).createSignedUrl(rest.join('/'), 3600);
    out.audioUrl = data?.signedUrl ?? null;
  } else {
    out.audioUrl = row.recording_url;
  }

  const talkrCall = row.source === 'talkr' && !!row.source_id?.startsWith('call:');
  if (!talkrCall) {
    // A webhook call stores the transcript text in body (talkr-webhook).
    out.transcript = out.transcript || row.body;
    if (!out.transcript) out.transcriptNote = 'No transcript stored for this call.';
    return finish();
  }
  if (out.transcript && out.audioUrl && (out.score || row.transcript_status === 'completed')) return finish();
  if (row.transcript_status === 'no_recording') { out.transcriptNote = 'This call was not recorded.'; return finish(); }
  // No transcript coming, but the call was still recorded: play it from Talkr
  // rather than saying "No recording" over audio that exists.
  const talkrAudio = async () => {
    if (out.audioUrl || !row.recording_id) return;
    try { out.audioUrl = URL.createObjectURL(await talkrWeb.getRecordingAudio(row.recording_id)); } catch { /* the note says why */ }
  };
  if (row.transcript_status === 'not_configured') { out.transcriptNote = 'Talkr has no transcription key (DEEPGRAM_API_KEY) set.'; await talkrAudio(); return finish(); }
  if (row.transcript_status === 'failed') { out.transcriptNote = 'Transcription failed on Talkr' + (out.notes?.error ? ': ' + out.notes.error : '.'); out.notes = null; await talkrAudio(); return finish(); }

  // Not stored yet: read Talkr live for whatever is ready.
  try {
    const t = await talkrWeb.getCallTranscript(row.source_id.slice(5));
    out.transcript = out.transcript || t.transcript?.full_text
      || (t.transcript?.segments ?? []).map((g) => (g.speaker === 'rep' ? 'Rep: ' : g.speaker === 'contact' ? 'Seller: ' : '') + g.text).join('\n')
      || null;
    out.summary = t.transcript?.summary || out.summary;
    // The recording's own segments beat the live ones the dialer stored at hang-up.
    const recSegs = t.transcript?.status === 'completed' ? parseSegments(t.transcript.segments) : null;
    if (recSegs && (!stored || row.transcript_status !== 'completed')) out.segments = recSegs;
    out.durationS = out.durationS ?? t.recording?.duration_seconds ?? null;
    if (!out.notes && t.transcript?.ai && t.transcript.status === 'completed') out.notes = { summary: t.transcript.summary, ...t.transcript.ai };
    if (!out.transcript) {
      out.transcriptNote = !t.recording ? 'This call was not recorded.'
        : !t.configured ? 'Talkr has no transcription key (DEEPGRAM_API_KEY) set.'
          : t.transcript?.status === 'failed' ? 'Transcription failed.' : 'Transcript is still processing — it lands here automatically.';
    }
    if (t.recording?.status === 'completed' && !out.audioUrl) {
      out.audioUrl = URL.createObjectURL(await talkrWeb.getRecordingAudio(t.recording.id));
    }
    if (!out.score && out.transcript) {
      const sc = await talkrWeb.getCallScore(row.source_id.slice(5)).catch(() => null);
      if (sc?.score?.status === 'completed') out.score = sc.score;
    }
  } catch (e) {
    if (!out.transcript) out.transcriptNote = e instanceof Error ? e.message : 'Could not reach Talkr.';
  }
  return finish();
}

/**
 * One Talkr call by its Talkr id (the inbox and dialer lists), for the player.
 * The mirrored communications row is used when there is one, so the stored
 * copy of the recording, the timed transcript and the chapters are shared;
 * otherwise Talkr is read live.
 */
export async function loadTalkrCallMedia(talkrCallId: string): Promise<CallMedia> {
  if (supabase) {
    const { data } = await supabase.from('communications').select('id')
      .eq('source', 'talkr').eq('source_id', 'call:' + talkrCallId).limit(1);
    const id = (data?.[0] as { id?: number } | undefined)?.id;
    if (id) return loadCallMedia(id);
  }
  const out: CallMedia = {
    audioUrl: null, transcript: null, summary: null, notes: null, score: null, review: null, transcriptNote: null,
    segments: [], estimated: false, durationS: null, sections: null, sectionsSource: null, communicationId: null,
  };
  try {
    const [call, t] = await Promise.all([
      talkrWeb.getCall(talkrCallId),
      talkrWeb.getCallTranscript(talkrCallId).catch(() => null),
    ]);
    out.durationS = call.call.duration_seconds ?? null;
    const rec = call.recordings.find((r) => r.status === 'completed') ?? null;
    if (rec) out.audioUrl = URL.createObjectURL(await talkrWeb.getRecordingAudio(rec.id));
    else out.transcriptNote = call.recordings.length ? 'The recording is still processing.' : 'This call was not recorded.';
    if (t?.transcript) {
      out.segments = parseSegments(t.transcript.segments) ?? [];
      out.transcript = t.transcript.full_text || null;
      out.summary = t.transcript.summary || null;
    }
    if (!out.transcript && !out.segments.length && rec) {
      out.transcriptNote = t && !t.configured ? 'Talkr has no transcription key (DEEPGRAM_API_KEY) set.'
        : t?.transcript?.status === 'failed' ? 'Transcription failed.' : 'No transcript for this call yet.';
    }
  } catch (e) {
    out.transcriptNote = e instanceof Error ? e.message : 'Could not load the recording.';
  }
  if (!out.segments.length && out.transcript) {
    out.segments = segmentsFromText(out.transcript, out.durationS);
    out.estimated = out.segments.length > 0;
  }
  return out;
}
