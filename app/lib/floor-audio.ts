// Floor-show sounds, synthesized so a badge does not depend on a file.
// Good badges get an airhorn. Shame badges get a sad slide. A signed
// contract gets a pulled bell. Passes get a short bright chime.

type Tone = { freq: number; at: number; dur: number; type?: OscillatorType; peak?: number; slide?: number };

let ctx: AudioContext | null = null;
let unlocked = false;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/** Call from a click so later celebrations are audible. */
export function unlockFloorAudio(): void {
  const c = audio();
  if (!c) return;
  if (c.state === 'suspended') void c.resume().catch(() => undefined);
  unlocked = true;
}

function schedule(c: AudioContext, gain: GainNode, notes: Tone[], t0: number) {
  for (const n of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = n.type ?? 'sine';
    o.frequency.setValueAtTime(n.freq, t0 + n.at);
    if (n.slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, n.slide), t0 + n.at + n.dur);
    const peak = n.peak ?? 0.2;
    g.gain.setValueAtTime(0.0001, t0 + n.at);
    g.gain.exponentialRampToValueAtTime(peak, t0 + n.at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    o.connect(g);
    g.connect(gain);
    o.start(t0 + n.at);
    o.stop(t0 + n.at + n.dur + 0.02);
  }
}

function noiseBurst(c: AudioContext, gain: GainNode, t0: number, dur: number, peak: number) {
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1800;
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(gain);
  src.start(t0);
  src.stop(t0 + dur);
}

export type FloorSound = 'airhorn' | 'shame' | 'bell' | 'chime';

const HORNS: Tone[] = [
  { freq: 520, at: 0, dur: 0.18, type: 'sawtooth', peak: 0.18 },
  { freq: 415, at: 0.16, dur: 0.22, type: 'sawtooth', peak: 0.2 },
  { freq: 520, at: 0.34, dur: 0.28, type: 'square', peak: 0.12 },
];

const SHAME: Tone[] = [
  { freq: 392, at: 0, dur: 0.28, type: 'sawtooth', peak: 0.12, slide: 220 },
  { freq: 247, at: 0.26, dur: 0.34, type: 'triangle', peak: 0.1, slide: 130 },
  { freq: 165, at: 0.55, dur: 0.4, type: 'sine', peak: 0.08, slide: 90 },
];

const BELL: Tone[] = [
  { freq: 880, at: 0, dur: 1.4, type: 'sine', peak: 0.2 },
  { freq: 1320, at: 0, dur: 1.1, type: 'sine', peak: 0.08 },
  { freq: 1760, at: 0.02, dur: 0.7, type: 'triangle', peak: 0.05 },
  { freq: 440, at: 0.05, dur: 1.2, type: 'sine', peak: 0.06 },
];

const CHIME: Tone[] = [
  { freq: 660, at: 0, dur: 0.12, type: 'sine', peak: 0.12 },
  { freq: 880, at: 0.1, dur: 0.16, type: 'sine', peak: 0.14 },
  { freq: 1320, at: 0.22, dur: 0.22, type: 'triangle', peak: 0.08 },
];

export function playFloorSound(kind: FloorSound): void {
  // A badge can land at page load, before any click. Building the context then
  // only makes the browser log "AudioContext was not allowed to start" and
  // the sound is dropped anyway, so wait for unlockFloorAudio() to have run.
  if (!unlocked && !ctx) return;
  const c = audio();
  if (!c) return;
  if (c.state === 'suspended') void c.resume().catch(() => undefined);
  if (!unlocked && c.state !== 'running') return;
  const gain = c.createGain();
  gain.gain.value = 0.9;
  gain.connect(c.destination);
  const t = c.currentTime + 0.02;
  if (kind === 'airhorn') {
    noiseBurst(c, gain, t, 0.45, 0.25);
    schedule(c, gain, HORNS, t);
  } else if (kind === 'shame') schedule(c, gain, SHAME, t);
  else if (kind === 'bell') {
    noiseBurst(c, gain, t, 0.08, 0.2);
    schedule(c, gain, BELL, t);
  } else schedule(c, gain, CHIME, t);
}

export function soundFor(kind: 'badge-good' | 'badge-shame' | 'contract' | 'pass'): FloorSound {
  if (kind === 'badge-shame') return 'shame';
  if (kind === 'contract') return 'bell';
  if (kind === 'pass') return 'chime';
  return 'airhorn';
}
