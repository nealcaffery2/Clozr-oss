// A ringless voicemail recorded for one dispo marketing push.
//
// The carriers (Drop Cowboy, Slybroadcast) take mp3, wav or m4a only
// (lib/rvm-carriers.ts audioKind), and MediaRecorder hands back webm/opus on
// Chrome and Firefox. A webm clip would reach rvm-tick with no playable URL
// and the carrier would read the script aloud instead, so the take is
// re-encoded here as 16 kHz mono WAV: a minute is about 1.9 MB, well under the
// vm-library bucket's 8 MB cap.
//
// The clip gets a variant_group of its own. rvm-tick picks among the active
// clips in a drop's variant_group, so a drop queued with this group can only
// ever play this recording, never another clip from the workspace library.

import { supabase } from './supabase';

export type PushRecording = {
  /** vm_library.id, or -1 on /demo where nothing is uploaded. */
  libraryId: number;
  /** Object path in the vm-library bucket. Empty on /demo. */
  path: string;
  variantGroup: string;
  seconds: number;
};

const RATE = 16_000;

/** Decode whatever the browser recorded and write it out as 16-bit PCM mono WAV. */
export async function toWav(blob: Blob): Promise<Blob> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx || typeof OfflineAudioContext === 'undefined') throw new Error('This browser cannot convert the recording to WAV. Record it in Chrome, Edge or Safari.');
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void ctx.close().catch(() => {});
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  const off = new OfflineAudioContext(1, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + mono.length * 2));
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); out.setUint32(4, 36 + mono.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  ascii(36, 'data'); out.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

/** Upload the take and register it as this push's only clip. */
export async function savePushRecording(
  workspaceId: number, dealId: number, blob: Blob, seconds: number, script: string, name: string, userId: string | null,
): Promise<{ ok: true; data: PushRecording } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Sign in to save a recording.' };
  let wav: Blob;
  try { wav = await toWav(blob); } catch (e) { return { ok: false, message: `Could not convert the recording: ${(e as Error).message}` }; }
  const id = crypto.randomUUID();
  const path = `${workspaceId}/dispo-push/${dealId}/${id}.wav`;
  const variantGroup = `dispo-push-${id}`;
  const up = await supabase.storage.from('vm-library').upload(path, wav, { contentType: 'audio/wav' });
  if (up.error) return { ok: false, message: `The recording did not upload: ${up.error.message}` };
  const ins = await supabase.from('vm_library').insert({
    workspace_id: workspaceId, name: name.slice(0, 120) || 'Dispo push voicemail', script, audio_path: path, seconds,
    variant_group: variantGroup, audience: 'buyer', created_by: userId,
  }).select('id').single();
  if (ins.error) {
    void supabase.storage.from('vm-library').remove([path]);
    return { ok: false, message: `The recording uploaded but was not saved: ${ins.error.message}` };
  }
  return { ok: true, data: { libraryId: Number((ins.data as { id: number }).id), path, variantGroup, seconds } };
}

/** A short-lived link to play a saved push recording back. */
export async function pushRecordingUrl(path: string): Promise<string | null> {
  if (!supabase || !path) return null;
  const { data } = await supabase.storage.from('vm-library').createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

/** A take the rep removed or replaced: out of the library, so nothing else picks it up. */
export async function retirePushRecording(libraryId: number): Promise<void> {
  if (!supabase || libraryId <= 0) return;
  await supabase.from('vm_library').update({ active: false }).eq('id', libraryId);
}
