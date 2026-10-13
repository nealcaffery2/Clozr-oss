// Choosing the recording a ringless voicemail plays. Every place that sends an
// RVM (the bulk composer, a dispo push, an action plan step) picks one saved
// recording or records a new one; this is the shared, pure part of that.
//
// A drop names its recording with library_id and a variant_group. rvm-tick
// rotates among the active clips in the group, so a drop pinned to one clip
// gets a group no clip belongs to: the tick then has only the pinned clip to
// play, never another recording from the workspace library.

import { audioKind } from './rvm-carriers';

/** The variant group that pins a drop to exactly this recording. */
export const pinnedGroup = (libraryId: number) => `clip-${libraryId}`;

/** A clip a carrier can drop: an mp3, wav or m4a file. WebM and script-only clips cannot be. */
export const droppable = (clip: { audio_path: string | null }) => audioKind(clip.audio_path) !== null;

/** "0:32" */
export const clipClock = (s: number | null | undefined) => {
  const n = Math.max(0, Math.round(s ?? 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

/** Carriers cut a voicemail off around 90 seconds; a take stops there rather than send a clipped one. */
export const MAX_RVM_SECONDS = 90;
