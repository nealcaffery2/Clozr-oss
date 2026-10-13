// Live two-channel transcription of the softphone call.
//
// Talkr Coach did this from a Chrome extension listening to a smrtPhone tab.
// Here the call is ours: the carrier's browser SDK hands us both legs as
// MediaStreams, so the seller (remote) and the rep (local) are tapped through
// one AudioContext, downsampled to 16 kHz, interleaved as PCM16 stereo and
// streamed to Deepgram (nova-3, multichannel, interim results) over a
// short-lived credential: Talkr's (POST /v1/transcription/token) or, when
// Talkr has none, CLOZR's own deepgram-token edge function. The long-lived
// DEEPGRAM_API_KEY never reaches the browser. Deepgram's `speech_final` on
// the seller channel is the moment the dialer asks Talkr for seller
// intelligence.
//
// Deepgram bills every second streamed, per channel, so the socket does not
// open on answer. The tap starts on connect and buffers locally while a free
// in-browser voice detector watches both legs; the socket opens once the call
// is a conversation (seller, rep, seller again) or has run LIVE_GATE_SECONDS,
// and the buffer is flushed first so the transcript still starts at hello. A
// no-answer, a voicemail greeting or a quick hang-up never reaches Deepgram.
//
//   channel 0  seller  (remote stream)
//   channel 1  rep     (local stream)
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { talkr } from './talkr';
import { supabase } from './supabase';

const SAMPLE_RATE = 16_000;
const FRAME = 4096;
const MAX_LINES = 400;
/** How long `start` keeps asking the SDK for the call's streams before giving up. */
const STREAM_WAIT_MS = 6_000;
/** Open Deepgram this far into a connected call even without a detected back-and-forth. */
export const LIVE_GATE_SECONDS = 20;
/** Held audio past this is dropped from the front; the gate opens long before it matters. */
const MAX_BUFFER_BYTES = 90 * SAMPLE_RATE * 4;

/** `armed`: tapping and buffering locally, Deepgram not opened yet. */
export type TranscriptStatus = 'idle' | 'armed' | 'starting' | 'listening' | 'error';

export type TranscriptLine = {
  speaker: 'seller' | 'rep';
  text: string;
  /** Deepgram's end-of-utterance; the intel request fires on this for the seller. */
  speechFinal: boolean;
  at: number;
  /** Seconds from when the transcriber started listening, per Deepgram. */
  start: number;
  end: number;
};

type Streams = { remote: MediaStream | null; local: MediaStream | null };

/**
 * A free, local stand-in for "did a conversation happen": frame energy per
 * leg, a floor that follows the line noise, and a speaker turn once a leg
 * holds speech for SEGMENT_MS. A real call goes seller, rep, seller (hello,
 * hi is this Mark, yes). A voicemail is greeting then the rep's message and
 * never comes back to the seller, so it does not pass.
 */
export class ConversationGate {
  static readonly SEGMENT_MS = 300;
  static readonly GAP_MS = 600;
  static readonly MIN_LEVEL = 0.01;
  private floor: [number, number] = [0.01, 0.01];
  private run: [number, number] = [0, 0];
  private quiet: [number, number] = [0, 0];
  private inTurn: [boolean, boolean] = [false, false];
  private turns: Array<0 | 1> = [];
  private elapsed = 0;
  passed = false;
  constructor(private readonly seconds = LIVE_GATE_SECONDS) {}

  /** One frame of both legs: RMS levels and the frame length. True once the gate has opened. */
  frame(levels: [number, number], ms: number): boolean {
    if (this.passed) return true;
    this.elapsed += ms;
    for (const side of [0, 1] as const) {
      const rms = levels[side];
      const f = this.floor[side];
      this.floor[side] = rms < f ? Math.max(rms, 1e-4) : Math.min(f * 1.01, 0.05);
      const speech = rms > Math.max(ConversationGate.MIN_LEVEL, this.floor[side] * 3);
      if (speech) {
        this.run[side] += ms;
        this.quiet[side] = 0;
        if (!this.inTurn[side] && this.run[side] >= ConversationGate.SEGMENT_MS) {
          this.inTurn[side] = true;
          if (this.turns[this.turns.length - 1] !== side) this.turns.push(side);
        }
      } else {
        this.quiet[side] += ms;
        if (this.quiet[side] >= ConversationGate.GAP_MS) {
          this.run[side] = 0;
          this.inTurn[side] = false;
        }
      }
    }
    // Three alternating turns: A, B, A.
    if (this.turns.length >= 3 || this.elapsed >= this.seconds * 1000) this.passed = true;
    return this.passed;
  }
}

export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

export type LiveTranscript = {
  status: TranscriptStatus;
  error: string | null;
  /** The latest partial per side, for the "hearing…" line. */
  partial: { seller: string; rep: string };
  /** Everything final, both sides, oldest first (capped). */
  lines: TranscriptLine[];
  /** Bumped on every seller speech_final — the trigger for intelligence. */
  sellerTurns: number;
  /** Wall-clock ms when audio started flowing to Deepgram; line.start is relative to it. */
  startedAt: number | null;
  /** A getter is polled until the SDK has attached the streams. */
  start: (streams: Streams | (() => Streams)) => Promise<void>;
  stop: () => void;
  reset: () => void;
};

/**
 * Both legs through ONE AudioContext at the device's own rate, merged into a
 * stereo pair and downsampled here to 16 kHz.
 *
 * The old tap opened one 16 kHz context per leg. Firefox refuses to connect a
 * MediaStream into a context whose rate differs from the stream's
 * ("Connecting AudioNodes from AudioContexts with different sample-rate"),
 * and two contexts drift apart, so the two channels were never the same
 * instant. One context, one processor: channel 0 and 1 are sample-aligned.
 */
class StereoTap {
  private ctx: AudioContext;
  private nodes: AudioNode[] = [];
  private processor: ScriptProcessorNode;
  /** Chrome feeds a remote WebRTC track into Web Audio only while a media element is also playing it. */
  private keepAlive: HTMLAudioElement | null = null;
  private down: [Downsampler, Downsampler];
  constructor(streams: Streams, onPcm: (buf: ArrayBuffer, levels: [number, number], ms: number) => void) {
    this.ctx = new AudioContext();
    const merger = this.ctx.createChannelMerger(2);
    const feed = (stream: MediaStream | null, input: 0 | 1) => {
      if (!stream || !stream.getAudioTracks().length) return;
      const src = this.ctx.createMediaStreamSource(stream);
      const mono = this.ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      src.connect(mono);
      mono.connect(merger, 0, input);
      this.nodes.push(src, mono);
    };
    feed(streams.remote, 0);
    feed(streams.local, 1);
    if (streams.remote && typeof Audio !== 'undefined') {
      const el = new Audio();
      el.muted = true;
      el.srcObject = streams.remote;
      void el.play().catch(() => undefined);
      this.keepAlive = el;
    }
    this.down = [new Downsampler(this.ctx.sampleRate, SAMPLE_RATE), new Downsampler(this.ctx.sampleRate, SAMPLE_RATE)];
    // ScriptProcessor is deprecated but universally available; an AudioWorklet
    // needs a separately served module.
    this.processor = this.ctx.createScriptProcessor(FRAME, 2, 2);
    this.processor.onaudioprocess = (e) => {
      const ra = e.inputBuffer.getChannelData(0);
      const rb = e.inputBuffer.getChannelData(1);
      const a = this.down[0].push(ra);
      const b = this.down[1].push(rb);
      const n = Math.min(a.length, b.length);
      if (!n) return;
      onPcm(interleave16(a, b, n), [rms(ra), rms(rb)], (ra.length / this.ctx.sampleRate) * 1000);
    };
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    merger.connect(this.processor);
    this.processor.connect(sink);
    sink.connect(this.ctx.destination);
    this.nodes.push(merger, sink);
    void this.ctx.resume();
  }
  async stop() {
    try {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      for (const n of this.nodes) n.disconnect();
    } catch {
      /* torn down */
    }
    if (this.keepAlive) {
      this.keepAlive.pause();
      this.keepAlive.srcObject = null;
    }
    await this.ctx.close().catch(() => undefined);
  }
}

/** Box-filter decimation with a fractional carry, so 44.1 kHz lands on 16 kHz without drift. */
export class Downsampler {
  private pos = 0;
  private acc = 0;
  private count = 0;
  private readonly step: number;
  constructor(from: number, to: number) {
    this.step = from / to;
  }
  push(input: Float32Array): Float32Array {
    if (this.step === 1) return input.slice();
    const out = new Float32Array(Math.ceil(input.length / this.step) + 1);
    let o = 0;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i]!;
      this.count++;
      this.pos += 1;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        out[o++] = this.acc / this.count;
        this.acc = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, o);
  }
}

export function interleave16(a: Float32Array, b: Float32Array, n: number): ArrayBuffer {
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const sa = Math.max(-1, Math.min(1, a[i]!));
    const sb = Math.max(-1, Math.min(1, b[i]!));
    out[2 * i] = sa < 0 ? sa * 0x8000 : sa * 0x7fff;
    out[2 * i + 1] = sb < 0 ? sb * 0x8000 : sb * 0x7fff;
  }
  return out.buffer;
}

function deepgramUrl(): string {
  const u = new URL('wss://api.deepgram.com/v1/listen');
  u.searchParams.set('model', 'nova-3');
  u.searchParams.set('encoding', 'linear16');
  u.searchParams.set('sample_rate', String(SAMPLE_RATE));
  u.searchParams.set('channels', '2');
  u.searchParams.set('multichannel', 'true');
  u.searchParams.set('interim_results', 'true');
  u.searchParams.set('endpointing', '200');
  u.searchParams.set('utterance_end_ms', '1000');
  u.searchParams.set('vad_events', 'true');
  u.searchParams.set('punctuate', 'true');
  u.searchParams.set('smart_format', 'true');
  return u.toString();
}

/**
 * The WebSocket subprotocol a Deepgram credential needs. A temporary API key
 * (POST /v1/projects/:id/keys) authenticates as `token`; a short-lived access
 * token from POST /v1/auth/grant is a JWT and is refused unless it is sent as
 * `bearer`. Sending a grant as `token` closes the socket on open with no
 * message, which is exactly "Transcription connection failed" and nothing else.
 */
export function deepgramScheme(key: string): 'bearer' | 'token' {
  return /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(key.trim()) ? 'bearer' : 'token';
}

/** A short-lived Deepgram credential: Talkr's first, then CLOZR's own deepgram-token function. */
async function mintCredential(): Promise<{ key: string; scheme: 'bearer' | 'token' }> {
  let talkrWhy = '';
  try {
    const r = await talkr.transcriptionToken();
    if (r?.key) return { key: r.key, scheme: deepgramScheme(r.key) };
    talkrWhy = 'Talkr returned no key';
  } catch (err) {
    talkrWhy = err instanceof Error ? err.message : String(err);
  }
  let ownWhy = 'Supabase is not configured';
  if (supabase) {
    const { data, error } = await supabase.functions.invoke('deepgram-token', { body: {} });
    const body = data as { key?: string; scheme?: 'bearer' | 'token'; error?: string } | null;
    if (!error && body?.key) return { key: body.key, scheme: body.scheme ?? deepgramScheme(body.key) };
    ownWhy = body?.error ?? error?.message ?? 'no key';
    try {
      const ctx = (error as { context?: Response } | null)?.context;
      if (ctx) ownWhy = ((await ctx.json()) as { error?: string }).error ?? ownWhy;
    } catch {
      /* keep the transport message */
    }
  }
  throw new Error(`Live transcription could not get a Deepgram key. Talkr: ${talkrWhy}. CLOZR: ${ownWhy}.`);
}

/** Deepgram's close codes, in words the rep can act on. */
export function closeReason(code: number, reason: string): string {
  if (code === 1008 || /auth|unauthor|credential|token/i.test(reason)) return 'Deepgram refused the transcription key. Check DEEPGRAM_API_KEY on Talkr or the Supabase project.';
  if (code === 1011 && /timeout|NET-0001/i.test(reason)) return 'Deepgram closed the stream: no audio reached it from the call.';
  if (reason) return `Deepgram closed the stream: ${reason}`;
  return 'Transcription connection failed. Deepgram closed the stream without a reason.';
}

type DeepgramResults = {
  type?: string;
  channel_index?: number[];
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string }> };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useLiveTranscript(): LiveTranscript {
  const [status, setStatus] = useState<TranscriptStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState({ seller: '', rep: '' });
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [sellerTurns, setSellerTurns] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const tapRef = useRef<StereoTap | null>(null);
  const activeRef = useRef(false);
  /** Survives a mid-call reconnect, so a retry opens at once; cleared by reset. */
  const gatePassedRef = useRef(false);

  const teardown = useCallback(() => {
    activeRef.current = false;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
        ws.close();
      } catch {
        /* closing anyway */
      }
    }
    const tap = tapRef.current;
    tapRef.current = null;
    if (tap) void tap.stop();
  }, []);

  const stop = useCallback(() => {
    teardown();
    setStatus('idle');
    setPartial({ seller: '', rep: '' });
  }, [teardown]);

  const reset = useCallback(() => {
    stop();
    setLines([]);
    setSellerTurns(0);
    setError(null);
    setStartedAt(null);
    gatePassedRef.current = false;
  }, [stop]);

  const fail = useCallback((message: string) => {
    teardown();
    setError(message);
    setStatus('error');
  }, [teardown]);

  const start = useCallback<LiveTranscript['start']>(async (input) => {
    if (activeRef.current) return;
    activeRef.current = true;
    setError(null);
    setStatus('starting');
    // The SDK attaches the legs a beat after accept; poll rather than failing
    // the whole call's transcript on the first empty read.
    const read = () => (typeof input === 'function' ? input() : input);
    let streams = read();
    for (let waited = 0; !streams.remote && waited < STREAM_WAIT_MS && activeRef.current; waited += 300) {
      await sleep(300);
      streams = read();
    }
    if (!activeRef.current) return;
    if (!streams.remote && !streams.local) {
      fail('No call audio reached the browser, so there is nothing to transcribe.');
      return;
    }
    // Tap now and hold the audio; Deepgram is opened only once the gate does.
    const held: ArrayBuffer[] = [];
    let heldBytes = 0;
    let ws: WebSocket | null = null;
    const gate = new ConversationGate();
    if (gatePassedRef.current) gate.passed = true;
    let opening = false;
    const open = () => {
      if (opening) return;
      opening = true;
      gatePassedRef.current = true;
      setStatus('starting');
      void connect();
    };
    try {
      tapRef.current = new StereoTap(streams, (buf, levels, ms) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(buf);
          return;
        }
        held.push(buf);
        heldBytes += buf.byteLength;
        while (heldBytes > MAX_BUFFER_BYTES && held.length > 1) heldBytes -= held.shift()!.byteLength;
        if (gate.frame(levels, ms)) open();
      });
    } catch (err) {
      fail(`The browser could not tap the call audio: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Deepgram's timestamps count from the first byte, which is the tap's start.
    setStartedAt(Date.now());
    if (gate.passed) open();
    else setStatus('armed');

    async function connect() {
      let cred: { key: string; scheme: 'bearer' | 'token' };
      try {
        cred = await mintCredential();
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      if (!activeRef.current) return;
      let sock: WebSocket;
      try {
        sock = new WebSocket(deepgramUrl(), [cred.scheme, cred.key]);
      } catch (err) {
        fail(`Could not open the transcription socket: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      sock.binaryType = 'arraybuffer';
      wsRef.current = sock;
      let opened = false;
      sock.addEventListener('open', () => {
        if (!activeRef.current || wsRef.current !== sock) return;
        opened = true;
        // Everything said before the gate opened goes first, in order.
        for (const buf of held.splice(0)) sock.send(buf);
        heldBytes = 0;
        ws = sock;
        setStatus('listening');
      });
      sock.addEventListener('message', (e) => {
        let msg: DeepgramResults;
        try {
          msg = JSON.parse(String(e.data)) as DeepgramResults;
        } catch {
          return;
        }
        if (msg.type !== 'Results') return;
        const speaker: 'seller' | 'rep' = (msg.channel_index?.[0] ?? 0) === 0 ? 'seller' : 'rep';
        const text = (msg.channel?.alternatives?.[0]?.transcript ?? '').trim();
        if (!text) return;
        setPartial((p) => ({ ...p, [speaker]: text }));
        if (!msg.is_final) return;
        const begin = Number(msg.start ?? 0);
        const line: TranscriptLine = {
          speaker, text, speechFinal: Boolean(msg.speech_final), at: Date.now(),
          start: begin, end: begin + Number(msg.duration ?? 0),
        };
        setLines((prev) => [...prev, line].slice(-MAX_LINES));
        setPartial((p) => ({ ...p, [speaker]: '' }));
        if (speaker === 'seller' && msg.speech_final) setSellerTurns((n) => n + 1);
      });
      // `error` carries no detail in browsers; the close that follows has the code.
      sock.addEventListener('close', (e) => {
        if (wsRef.current !== sock) return;
        if (!activeRef.current) return;
        if (!opened || e.code !== 1000) fail(closeReason(e.code, e.reason));
        else {
          teardown();
          setStatus('idle');
        }
      });
    }
  }, [teardown, fail]);

  useEffect(() => () => teardown(), [teardown]);

  // Stable identity between state changes: the phone hook keys its start
  // effect on this object, and a fresh literal every render re-ran that effect
  // (and cleared its start timer) on every render of the dialer.
  return useMemo(
    () => ({ status, error, partial, lines, sellerTurns, startedAt, start, stop, reset }),
    [status, error, partial, lines, sellerTurns, startedAt, start, stop, reset],
  );
}
