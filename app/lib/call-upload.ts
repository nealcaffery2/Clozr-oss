// "Submit a call for review": a call from outside CLOZR, as a transcript
// (.txt) or a recording (mp3, wav, m4a; 25 MB at most), graded the same way
// as a recorded call. Pure helpers shared by the Coaching screen (what may be
// uploaded) and the sales-manager function (Deepgram's answer into labelled
// lines, and which speaker is the rep).

import type { CallSegment } from './call-media.ts';

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const AUDIO_TYPES: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };
export const UPLOAD_ACCEPT = '.txt,.mp3,.wav,.m4a,text/plain,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a';

export type UploadCheck =
  | { ok: true; kind: 'text' | 'audio'; ext: string; contentType: string }
  | { ok: false; error: string };

/** What a picked file is, and the content type to store it under (the bucket allows audio/mpeg, audio/wav, audio/mp4). */
export function checkUpload(name: string, size: number): UploadCheck {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  if (size > UPLOAD_MAX_BYTES) return { ok: false, error: 'That file is over 25 MB.' };
  if (size <= 0) return { ok: false, error: 'That file is empty.' };
  if (ext === 'txt') return { ok: true, kind: 'text', ext, contentType: 'text/plain' };
  if (AUDIO_TYPES[ext]) return { ok: true, kind: 'audio', ext, contentType: AUDIO_TYPES[ext]! };
  return { ok: false, error: 'Upload a .txt transcript or an .mp3, .wav or .m4a recording.' };
}

/** The storage path for an uploaded recording: <workspace>/uploads/<user>-<stamp>.<ext> (migration 149's insert policy). */
export function uploadPath(workspaceId: number, userId: string, ext: string, now = Date.now()): string {
  return `${workspaceId}/uploads/${userId.replace(/[^a-z0-9-]/gi, '')}-${now}.${ext.replace(/[^a-z0-9]/gi, '')}`;
}

export type Utterance = { speaker: number; start: number; end: number; text: string };

/** Deepgram pre-recorded answer (utterances=true, diarize=true) into utterances. */
export function parseDeepgram(raw: unknown): { utterances: Utterance[]; durationS: number | null } {
  type U = { transcript?: unknown; start?: unknown; end?: unknown; speaker?: unknown };
  const r = (raw && typeof raw === 'object' ? raw : {}) as { results?: { utterances?: unknown }; metadata?: { duration?: unknown } };
  const list: U[] = Array.isArray(r.results?.utterances) ? (r.results.utterances as U[]) : [];
  const utterances: Utterance[] = [];
  for (const u of list) {
    const text = String(u?.transcript ?? '').replace(/\s+/g, ' ').trim();
    const start = Number(u?.start);
    if (!text || !Number.isFinite(start)) continue;
    const end = Number(u?.end);
    utterances.push({ speaker: Number.isFinite(Number(u?.speaker)) ? Number(u.speaker) : 0, start, end: Number.isFinite(end) ? end : start, text });
  }
  const d = Number(r.metadata?.duration);
  return { utterances, durationS: Number.isFinite(d) && d > 0 ? Math.round(d) : null };
}

const REP_CUES = [
  /\b(this is|my name is|i'?m)\s+\w+\s+(with|from)\b/i,
  /\bcalling (about|from|on)\b/i,
  /\bwe buy\b|\bour company\b|\bcash offer\b|\bas-is\b|\bclosing costs\b/i,
  /\bwhat (price|number)\b|\bhow much (are you|were you|do you)\b/i,
  /\bwhy (are you|do you|did you)\b.*\bsell/i,
  /\b(purchase )?agreement\b|\bi can (pay|do|offer)\b/i,
];

/**
 * Which speaker is the rep. Scored on what reps say (introductions with a
 * company, price and motivation questions, offer language), then on who asks
 * more questions. Ties go to the speaker who talks second, since a seller
 * usually picks up with "hello".
 */
export function guessRepSpeaker(utts: Utterance[]): number {
  const speakers = [...new Set(utts.map((u) => u.speaker))];
  if (speakers.length <= 1) return speakers[0] ?? 0;
  const score = new Map<number, number>(speakers.map((s) => [s, 0]));
  for (const u of utts) {
    let n = 0;
    for (const re of REP_CUES) if (re.test(u.text)) n += 3;
    n += (u.text.match(/\?/g) ?? []).length;
    score.set(u.speaker, (score.get(u.speaker) ?? 0) + n);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked[0]![1] > ranked[1]![1]) return ranked[0]![0];
  const second = utts.find((u) => u.speaker !== utts[0]!.speaker);
  return second ? second.speaker : ranked[0]![0];
}

/** Utterances as the player's segments, the rep's speaker as 'rep' and everyone else 'contact'. */
export function segmentsFromUtterances(utts: Utterance[], repSpeaker: number): CallSegment[] {
  return utts.map((u) => ({ start: u.start, end: u.end, speaker: u.speaker === repSpeaker ? 'rep' as const : 'contact' as const, text: u.text }));
}

/** "Rep: …\nSeller: …" from segments, the shape measureTalkSplit reads. */
export function labelledTranscript(segments: CallSegment[], names: { rep: string; prospect: string }): string {
  return segments.map((s) => `${s.speaker === 'rep' ? names.rep : names.prospect}: ${s.text}`).join('\n');
}

/** An uploaded .txt as a transcript: normalised line breaks, trimmed, capped. */
export function cleanUploadedText(text: string, cap = 60_000): string {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, cap);
}
