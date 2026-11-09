// The call player's waveform (components/record/CallRecording): one bar per
// slice of the call, coloured by who was talking and sized by how loud it
// was. Loudness comes from the recording itself when the browser can decode
// it (Web Audio, RMS per slice); when it cannot (a carrier URL without CORS,
// no audio at all), each slice is sized by how fast that speaker was talking
// in that line, with a small deterministic ripple so a flat line reads as a
// wave and not a bar. Pure, so `npx tsx tools/call-wave.test.ts` covers it.

import type { CallSegment } from './call-media';

export type WaveBar = { speaker: CallSegment['speaker'] | null; level: number };

/** The segment covering a moment, or null in silence. */
export function speakerAt(segments: readonly CallSegment[], t: number): CallSegment | null {
  return segments.find((s) => t >= s.start && t < Math.max(s.end, s.start + 0.5)) ?? null;
}

/** RMS of each of `n` equal slices of a mono sample buffer, scaled so the loudest slice is 1. */
export function levelsFromSamples(samples: ArrayLike<number>, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  if (!samples.length || n <= 0) return out;
  const per = samples.length / n;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * per), b = Math.max(a + 1, Math.floor((i + 1) * per));
    let sum = 0;
    for (let j = a; j < b; j++) sum += samples[j]! * samples[j]!;
    out[i] = Math.sqrt(sum / (b - a));
    if (out[i]! > max) max = out[i]!;
  }
  return max > 0 ? out.map((v) => v / max) : out;
}

/** Words per second of a line, the stand-in for loudness when the audio cannot be read. */
export function pace(s: CallSegment): number {
  const words = s.text.trim().split(/\s+/).filter(Boolean).length;
  return words / Math.max(0.5, s.end - s.start);
}

/** A ripple in 0.55 to 1 from the bar's index, the same every render. */
export function ripple(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return 0.55 + 0.45 * (x - Math.floor(x));
}

/**
 * The bars. `levels` is the decoded audio's RMS per bar when it is known;
 * otherwise a speaker's pace, scaled to the fastest line, carries the height.
 * Silence is a bar with no speaker and a floor level.
 */
export function waveBars(segments: readonly CallSegment[], durationS: number, n: number, levels: readonly number[] | null = null): WaveBar[] {
  const bars: WaveBar[] = [];
  if (durationS <= 0 || n <= 0) return bars;
  const fastest = Math.max(0.1, ...segments.map(pace));
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * durationS;
    const seg = speakerAt(segments, t);
    let level: number;
    if (levels) level = Math.max(seg ? 0.12 : 0.04, Math.min(1, levels[i] ?? 0));
    else level = seg ? Math.max(0.18, Math.min(1, (pace(seg) / fastest) * ripple(i))) : 0.05;
    bars.push({ speaker: seg?.speaker ?? null, level });
  }
  return bars;
}
