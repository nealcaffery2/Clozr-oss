// A browser recording (MediaRecorder hands back WebM/Opus in Chrome, MP4 in
// Safari) as a 16 kHz mono PCM WAV, the one format every ringless network
// and Telnyx playback accepts. A WebM voicemail could not be dropped at all:
// Drop Cowboy and Slybroadcast take mp3/wav/m4a, Telnyx plays mp3/wav.

const RATE = 16_000;

/** PCM16 mono WAV bytes from float samples. */
export function encodeWav(samples: Float32Array, sampleRate = RATE): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Any recording the browser can decode, as a WAV blob. Throws with a readable reason when it cannot. */
export async function toWav(blob: Blob): Promise<Blob> {
  if (/wav/i.test(blob.type)) return blob;
  const Ctx = typeof window !== 'undefined' ? window.OfflineAudioContext : undefined;
  if (!Ctx) throw new Error('This browser cannot convert the recording to WAV.');
  const bytes = await blob.arrayBuffer();
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error('The recording could not be decoded. Try recording it again.');
  } finally {
    void probe.close().catch(() => undefined);
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  const off = new Ctx(1, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return new Blob([encodeWav(rendered.getChannelData(0), RATE)], { type: 'audio/wav' });
}
