'use client';

/**
 * The carrier SDK behind the softphone, behind one small interface.
 *
 * The server chooses the carrier (`VOICE_PROVIDER`), and `/v1/voice/token`
 * says which one it chose. The browser must then load *that* SDK: Twilio's
 * Voice SDK for a Twilio deployment, Telnyx's WebRTC SDK for Telnyx. Nothing
 * above this file knows which one is in play — it sees an engine that
 * registers, reports incoming calls, opens the media leg for a Talkr call and
 * hands back a call with the same handful of events either way.
 *
 * The one structural difference between the carriers is who opens the rep's
 * leg on an outbound call (`browser_leg` on the token response):
 *
 *  - Twilio (`client`): the browser dials the TwiML app with the call id as a
 *    connect parameter. `connect()` is `Device.connect`.
 *  - Telnyx (`server`): a WebRTC endpoint dials numbers, not our TeXML app, so
 *    `connect()` asks the server to ring this browser (`POST
 *    /v1/calls/:id/browser-leg`) and answers the resulting invite. Until that
 *    invite arrives the call is "pending"; an invite that arrives while one is
 *    pending, from our own caller ID, is the server leg and is answered
 *    silently. Any other invite is a real inbound call.
 */

import type { Call as TwilioCall, Device as TwilioDevice } from '@twilio/voice-sdk';
import type { TelnyxRTC } from '@telnyx/webrtc';
import { BrowserLegError, browserLegSipKind } from './browser-leg';
import { adoptRemoteCallElement, isTouchPhone, remoteCallElement } from './phone-audio';
import { applyCallRoute, getCallRoute } from './call-route';
import { peerFromCall } from './vm-playback';
import { replaceAudioInputTrack } from './telnyx-media';

export type EngineKind = 'twilio' | 'telnyx';
export type BrowserLegMode = 'client' | 'server';

export interface VoiceTokenDto {
  token: string;
  identity: string;
  ttl_seconds: number;
  /** Which carrier minted it; absent on servers older than the Telnyx swap (Twilio). */
  provider?: string;
  browser_leg?: BrowserLegMode;
}

export type EngineCallEvent = 'accept' | 'ringing' | 'disconnect' | 'cancel' | 'reject' | 'error' | 'mute';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EngineCallListener = (arg?: any) => void;

/** One media leg, whichever SDK carries it. */
export interface EngineCall {
  /** Caller number as the carrier reported it (inbound legs). */
  readonly from: string | null;
  /** The Talkr call id when the leg carries one (Twilio custom parameter, or the leg we asked for). */
  readonly talkrCallId: string | null;
  /** 'mute' carries the new muted flag, 'error' the SDK's error; the rest carry nothing. */
  on(event: EngineCallEvent, fn: EngineCallListener): void;
  accept(): void;
  reject(): void;
  disconnect(): void;
  mute(on: boolean): void;
  isMuted(): boolean;
  sendDigits(digits: string): void;
  localStream(): MediaStream | null;
  remoteStream(): MediaStream | null;
  /** The peer carrying the mic, so a voicemail drop can play into it. */
  peerConnection(): RTCPeerConnection | null;
}

/**
 * Audio-device control in the shape of Twilio's AudioHelper, which the
 * softphone already speaks. Twilio hands over the real helper; the Telnyx
 * engine implements the same surface over `enumerateDevices` and the SDK's
 * per-call device setters. Ringtone routing is Twilio-only; the Telnyx
 * collection accepts the choice and applies nothing.
 */
export interface EngineOutputCollection {
  get(): Set<{ deviceId: string }>;
  set(deviceId: string): Promise<void>;
  test(): Promise<void>;
}
export interface EngineAudio {
  readonly isOutputSelectionSupported: boolean;
  readonly availableInputDevices: Map<string, MediaDeviceInfo>;
  readonly availableOutputDevices: Map<string, MediaDeviceInfo>;
  readonly speakerDevices: EngineOutputCollection;
  readonly ringtoneDevices: EngineOutputCollection;
  setInputDevice(deviceId: string): Promise<void>;
  unsetInputDevice(): Promise<void>;
  on(event: 'deviceChange' | 'inputVolume', fn: (arg: never) => void): void;
  off(event: 'deviceChange' | 'inputVolume', fn: (arg: never) => void): void;
}

export interface EngineHandlers {
  onRegistered(): void;
  /** Lost the carrier (network, sleep, token). The softphone re-registers with backoff. */
  onUnregistered(): void;
  /** `fatal` = a fresh token will not help (bad credentials, account suspended). */
  onError(err: { message: string; fatal: boolean }): void;
  onIncoming(call: EngineCall): void;
}

export interface ConnectOptions {
  /** Server-leg carriers: ask the server to ring this browser for the call. */
  ringServer: () => Promise<unknown>;
  /** Our caller ID on the call; the server leg arrives *from* it. */
  expectFrom?: string | null;
  timeoutMs?: number;
}

/** The mic the next call opens, and its processing (from lib/phone-audio.ts). */
export type MicSettings = MediaTrackConstraints;

export interface SoftphoneEngine {
  readonly kind: EngineKind;
  readonly browserLeg: BrowserLegMode;
  readonly audio: EngineAudio;
  register(): Promise<void>;
  updateToken(token: string): void;
  isRegistered(): boolean;
  /** Open the media leg for a Talkr call the server already created. */
  connect(callId: string, opts: ConnectOptions): Promise<EngineCall>;
  /** The org's own numbers: a server leg can present any of them, a customer never does. */
  setOwnNumbers?(numbers: string[]): void;
  /** getUserMedia constraints for calls from here on (device, echo cancellation, noise suppression, auto gain). */
  applyMic(settings: MicSettings): void;
  /** Play the far-end element. A dial tap calls this so a phone will output wait music. */
  primePlayback?(): void;
  destroy(): void;
}

/** Which engine a token response calls for. Older servers say nothing and mean Twilio. */
export function engineKindOf(token: Pick<VoiceTokenDto, 'provider'>): EngineKind {
  return token.provider === 'telnyx' ? 'telnyx' : 'twilio';
}

export async function createEngine(token: VoiceTokenDto, handlers: EngineHandlers): Promise<SoftphoneEngine> {
  const kind = engineKindOf(token);
  if (kind === 'telnyx') return TelnyxEngine.create(token, handlers);
  return TwilioEngine.create(token, handlers);
}

// ── Twilio ───────────────────────────────────────────────────────────────────

/** Twilio codes that mean "no amount of retrying helps": token/auth problems. */
const TWILIO_FATAL_CODES = new Set([20101, 20103, 20104, 31201, 31208]);

function describeTwilioError(err: { message?: string; code?: number } | undefined): string {
  const code = err?.code;
  if (code !== undefined && TWILIO_FATAL_CODES.has(code)) {
    return 'Twilio rejected the voice token (account not active or wrong API key). Calls are unavailable until the Twilio account is active.';
  }
  if (code === 31204 || code === 31205) return 'Voice token expired or invalid; reconnecting.';
  return err?.message ?? 'device error';
}

class TwilioEngineCall implements EngineCall {
  readonly from: string | null;
  readonly talkrCallId: string | null;
  constructor(
    private readonly call: TwilioCall,
    private readonly mic: () => MicSettings | null = () => null,
  ) {
    this.from = call.parameters?.From ?? null;
    this.talkrCallId = call.customParameters?.get('talkr_call_id') ?? null;
  }
  on(event: EngineCallEvent, fn: EngineCallListener): void {
    // Twilio's Call emits exactly these names; 'error' carries the SDK error.
    this.call.on(event, fn);
  }
  accept() {
    const audio = this.mic();
    this.call.accept(audio ? { rtcConstraints: { audio } } : undefined);
  }
  reject() {
    this.call.reject();
  }
  disconnect() {
    // The SDK stops its own capture in peer close. Stopping the tracks first
    // fires devicechange while that stream is still the default device, and
    // Twilio then opens a new one it keeps after the call.
    this.call.disconnect();
  }
  mute(on: boolean) {
    this.call.mute(on);
  }
  isMuted() {
    return this.call.isMuted();
  }
  sendDigits(digits: string) {
    this.call.sendDigits(digits);
  }
  localStream() {
    return (this.call.getLocalStream?.() as MediaStream | undefined) ?? null;
  }
  remoteStream() {
    return (this.call.getRemoteStream?.() as MediaStream | undefined) ?? null;
  }
  peerConnection() {
    return peerFromCall(this.call);
  }
}

class TwilioEngine implements SoftphoneEngine {
  readonly kind = 'twilio' as const;
  readonly browserLeg = 'client' as const;
  private mic: MicSettings | null = null;
  private constructor(
    private readonly device: TwilioDevice,
    private readonly handlers: EngineHandlers,
  ) {}

  static async create(token: VoiceTokenDto, handlers: EngineHandlers): Promise<TwilioEngine> {
    // Dynamic import: the SDK touches browser APIs and must never run on the server.
    const { Device } = await import('@twilio/voice-sdk');
    const device = new Device(token.token, {
      codecPreferences: ['opus', 'pcmu'] as TwilioCall.Codec[],
      logLevel: 'error',
    });
    const engine = new TwilioEngine(device, handlers);
    device.on('registered', () => handlers.onRegistered());
    device.on('unregistered', () => handlers.onUnregistered());
    device.on('error', (err: { message?: string; code?: number } | undefined) => {
      handlers.onError({
        message: describeTwilioError(err),
        fatal: err?.code !== undefined && TWILIO_FATAL_CODES.has(err.code),
      });
    });
    device.on('incoming', (call: TwilioCall) => handlers.onIncoming(new TwilioEngineCall(call, () => engine.mic)));
    // CLOZR plays the rep's own ringtone (lib/phone-audio.ts); the SDK's built-in one would ring over it.
    try {
      device.audio?.incoming(false);
    } catch {
      /* older SDK without toggleable sounds */
    }
    return engine;
  }

  get audio(): EngineAudio {
    // AudioHelper satisfies EngineAudio structurally; the cast only narrows the
    // event names to the two the softphone listens for.
    return this.device.audio as unknown as EngineAudio;
  }
  async register() {
    await this.device.register();
  }
  updateToken(token: string) {
    this.device.updateToken(token);
  }
  isRegistered() {
    return String(this.device.state) === 'registered';
  }
  async connect(callId: string): Promise<EngineCall> {
    // The server's TwiML decides the dial; the browser only carries media.
    const call = await this.device.connect({ params: { talkr_call_id: callId }, ...(this.mic ? { rtcConstraints: { audio: this.mic } } : {}) });
    return new TwilioEngineCall(call, () => this.mic);
  }
  applyMic(settings: MicSettings) {
    this.mic = settings;
  }
  destroy() {
    try {
      this.device.destroy();
    } catch {
      /* already torn down */
    }
  }
  /** Twilio's own helper, for the tokenWillExpire hook the softphone registers. */
  onTokenWillExpire(fn: () => void) {
    this.device.on('tokenWillExpire', fn);
  }
}

// ── Telnyx ───────────────────────────────────────────────────────────────────

type TelnyxCall = ReturnType<TelnyxRTC['newCall']>;

/** Digits only, so "+1 (210) 555-0101" and "12105550101" compare equal. */
function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

class Emitter {
  private readonly fns = new Map<string, Array<(arg?: unknown) => void>>();
  on(event: string, fn: (arg?: unknown) => void) {
    const list = this.fns.get(event) ?? [];
    list.push(fn);
    this.fns.set(event, list);
  }
  emit(event: string, arg?: unknown) {
    for (const fn of this.fns.get(event) ?? []) {
      try {
        fn(arg);
      } catch {
        /* a listener must not break the others */
      }
    }
  }
}

class TelnyxEngineCall implements EngineCall {
  readonly from: string | null;
  readonly talkrCallId: string | null;
  private readonly emitter = new Emitter();
  private accepted = false;
  private ended = false;
  private muted = false;

  constructor(
    readonly call: TelnyxCall,
    talkrCallId: string | null,
  ) {
    this.from = call.options.remoteCallerNumber ?? call.options.callerNumber ?? null;
    this.talkrCallId = talkrCallId;
  }

  on(event: EngineCallEvent, fn: EngineCallListener): void {
    this.emitter.on(event, fn);
  }

  /** Fed by the client's callUpdate notifications; states are the SDK's lowercase names. */
  update(state: string): void {
    switch (state) {
      case 'ringing':
      case 'early':
        if (!this.accepted) this.emitter.emit('ringing');
        break;
      case 'active':
        if (!this.accepted) {
          this.accepted = true;
          this.emitter.emit('accept');
        }
        break;
      case 'hangup':
      case 'destroy':
      case 'purge':
        this.end(this.accepted ? 'disconnect' : 'cancel');
        break;
      default:
        break;
    }
  }

  private end(event: 'disconnect' | 'cancel' | 'reject'): void {
    if (this.ended) return;
    this.ended = true;
    // Telnyx dispatches the hangup state before it sends BYE. Stopping the
    // mic in that same turn closes the peer while the call is still early,
    // and the SDK reports "Failed to hang up cleanly". Release on the next
    // turn, after that BYE has been handed to the socket.
    setTimeout(() => {
      this.releaseCapture();
      this.emitter.emit(event);
    }, 0);
  }

  releaseCapture(): void {
    this.localStream()?.getTracks().forEach((t) => t.stop());
    const peer = (this.call as { peer?: { instance?: RTCPeerConnection | null } }).peer;
    peer?.instance?.getSenders().forEach((s) => {
      if (s.track && s.track.readyState === 'live') s.track.stop();
    });
  }

  accept() {
    void this.call.answer().catch((err: unknown) => {
      this.emitter.emit('error', { message: err instanceof Error ? err.message : 'could not answer' });
      this.end('cancel');
    });
  }
  reject() {
    void this.call.hangup().catch(() => this.end('reject'));
  }
  disconnect() {
    void this.call.hangup().catch(() => this.end(this.accepted ? 'disconnect' : 'cancel'));
  }
  mute(on: boolean) {
    if (on) this.call.muteAudio();
    else this.call.unmuteAudio();
    this.muted = on;
    this.emitter.emit('mute', on);
  }
  isMuted() {
    return this.muted;
  }
  sendDigits(digitsToSend: string) {
    this.call.dtmf(digitsToSend);
  }
  localStream() {
    return this.call.localStream ?? null;
  }
  remoteStream() {
    return this.call.remoteStream ?? null;
  }
  peerConnection() {
    return peerFromCall(this.call);
  }
}

/** Speaker/ringtone collections over `setSinkId`; ringtone is accepted and unused. */
class TelnyxOutputs implements EngineOutputCollection {
  private current: string | null = null;
  constructor(
    private readonly apply: (deviceId: string) => Promise<void>,
    private readonly supported: boolean,
  ) {}
  get(): Set<{ deviceId: string }> {
    return new Set(this.current ? [{ deviceId: this.current }] : []);
  }
  async set(deviceId: string) {
    this.current = deviceId;
    if (this.supported) await this.apply(deviceId);
  }
  async test() {
    if (typeof window === 'undefined') return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    osc.frequency.value = 660;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    const el = new Audio();
    el.srcObject = dest.stream;
    const sink = (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (sink && this.current && this.current !== 'default') await sink.call(el, this.current).catch(() => undefined);
    osc.start();
    await el.play().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 600));
    osc.stop();
    el.pause();
    await ctx.close().catch(() => undefined);
  }
}

class TelnyxAudio implements EngineAudio {
  readonly isOutputSelectionSupported =
    typeof window !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  readonly availableInputDevices = new Map<string, MediaDeviceInfo>();
  readonly availableOutputDevices = new Map<string, MediaDeviceInfo>();
  readonly speakerDevices: TelnyxOutputs;
  readonly ringtoneDevices: TelnyxOutputs;
  /** The mic the next call opens on. */
  inputDeviceId: string | null = null;
  private readonly listeners = new Map<string, Set<(arg: never) => void>>();
  private readonly onChange = () => void this.refresh().then(() => this.emit('deviceChange'));

  constructor(private readonly engine: TelnyxEngine) {
    this.speakerDevices = new TelnyxOutputs((id) => engine.applyOutput(id), this.isOutputSelectionSupported);
    this.ringtoneDevices = new TelnyxOutputs(async () => undefined, false);
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this.onChange);
      void this.refresh();
    }
  }

  async refresh(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.availableInputDevices.clear();
      this.availableOutputDevices.clear();
      for (const d of all) {
        if (d.kind === 'audioinput') this.availableInputDevices.set(d.deviceId, d);
        else if (d.kind === 'audiooutput') this.availableOutputDevices.set(d.deviceId, d);
      }
    } catch {
      /* enumeration refused; keep the last list */
    }
  }

  async setInputDevice(deviceId: string) {
    this.inputDeviceId = deviceId;
    await this.engine.applyInput(deviceId);
  }
  async unsetInputDevice() {
    // Preference for the next call stays. This only drops a capture that
    // outlived the hangup (a sender track the SDK did not stop).
    this.engine.releaseCaptures();
  }
  on(event: 'deviceChange' | 'inputVolume', fn: (arg: never) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
  }
  off(event: 'deviceChange' | 'inputVolume', fn: (arg: never) => void) {
    this.listeners.get(event)?.delete(fn);
  }
  private emit(event: 'deviceChange') {
    for (const fn of this.listeners.get(event) ?? []) fn(undefined as never);
  }
  dispose() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.onChange);
    }
  }
}

interface PendingLeg {
  callId: string;
  expectFrom: string | null;
  resolve: (call: EngineCall) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class TelnyxEngine implements SoftphoneEngine {
  readonly kind = 'telnyx' as const;
  readonly browserLeg = 'server' as const;
  readonly audio: TelnyxAudio;
  private client: TelnyxRTC | null = null;
  private ready = false;
  private destroyed = false;
  private token: string;
  private readonly calls = new Map<string, TelnyxEngineCall>();
  private active: TelnyxEngineCall | null = null;
  private pending: PendingLeg | null = null;
  /** Last ten digits of every org number. */
  private ownNumbers = new Set<string>();
  private readonly remoteElement: HTMLAudioElement | null;
  private speakerId: string | null = null;
  private mic: MicSettings | null = null;

  private constructor(
    token: VoiceTokenDto,
    private readonly Ctor: typeof TelnyxRTC,
    private readonly handlers: EngineHandlers,
  ) {
    this.token = token.token;
    // The SDK attaches the far end — and the wait music before they answer —
    // to a media element it is told about. Reuse the element a dial tap
    // already unlocked. display:none makes that audio skip on a phone.
    const shared = remoteCallElement();
    if (shared) {
      this.remoteElement = shared;
    } else if (typeof document !== 'undefined') {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');
      el.setAttribute('data-talkr-softphone', 'telnyx');
      el.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;bottom:0';
      document.body.appendChild(el);
      this.remoteElement = adoptRemoteCallElement(el);
    } else {
      this.remoteElement = null;
    }
    this.audio = new TelnyxAudio(this);
  }

  static async create(token: VoiceTokenDto, handlers: EngineHandlers): Promise<TelnyxEngine> {
    const mod = await import('@telnyx/webrtc');
    return new TelnyxEngine(token, mod.TelnyxRTC, handlers);
  }

  private build(): TelnyxRTC {
    const client = new this.Ctor({ login_token: this.token });
    if (this.remoteElement) client.remoteElement = this.remoteElement;
    if (this.mic) void this.pushMic(client, this.mic);
    client.on('telnyx.ready', () => {
      this.ready = true;
      this.handlers.onRegistered();
    });
    client.on('telnyx.error', (event: { error?: Error; message?: string }) => {
      const message = event?.error?.message ?? event?.message ?? 'Telnyx error';
      this.handlers.onError({ message, fatal: /credential|unauthori|token|login|auth/i.test(message) && !this.ready });
    });
    client.on('telnyx.socket.close', () => {
      const wasReady = this.ready;
      this.ready = false;
      if (!this.destroyed && wasReady) this.handlers.onUnregistered();
    });
    client.on('telnyx.notification', (n: { type: string; call?: TelnyxCall }) => {
      if (n.type === 'callUpdate' && n.call) this.onCallUpdate(n.call);
    });
    return client;
  }

  private onCallUpdate(call: TelnyxCall): void {
    const state = String(call.state).toLowerCase();
    let wrapped = this.calls.get(call.id);
    if (!wrapped) {
      // First sight of this leg. Ours if we asked the server for one and the
      // invite comes from our own caller ID; otherwise a real inbound call.
      if (['hangup', 'destroy', 'purge'].includes(state)) {
        // A duplicate registration rejects this invite (486) or lets it die
        // (487) before we ever see ringing. Fail the connect that is waiting
        // so the tab can hang the Talkr call up and register again.
        const pending = this.pending;
        const kind = browserLegSipKind((call as { sipCode?: number }).sipCode);
        if (pending && kind) {
          clearTimeout(pending.timer);
          this.pending = null;
          pending.reject(new BrowserLegError(kind));
        }
        return;
      }
      const pending = this.pending;
      const from = call.options.remoteCallerNumber ?? call.options.callerNumber ?? null;
      // A server leg arrives from our caller ID, but the carrier may present
      // another of the org's numbers, or no number at all (a SIP user). A
      // customer never calls from one of ours, so any of those is the leg we
      // asked for. Treating it as inbound while openingRef is set used to
      // reject it with SipHangupCause=486 and kill the outbound call.
      const key = digits(from).slice(-10);
      const exact = (expectFrom: string | null) =>
        !expectFrom || key === digits(expectFrom).slice(-10);
      const isOurLeg =
        pending !== null &&
        (exact(pending.expectFrom) || key.length < 10 || this.ownNumbers.has(key));
      wrapped = new TelnyxEngineCall(call, isOurLeg ? pending!.callId : null);
      this.calls.set(call.id, wrapped);
      wrapped.on('accept', () => void this.onLegUp(wrapped!));
      const forget = () => {
        this.calls.delete(call.id);
        if (this.active === wrapped) this.active = null;
      };
      wrapped.on('disconnect', forget);
      wrapped.on('cancel', forget);
      wrapped.on('reject', forget);
      if (isOurLeg) {
        clearTimeout(pending!.timer);
        this.pending = null;
        this.active = wrapped;
        wrapped.accept();
        pending!.resolve(wrapped);
      } else {
        this.handlers.onIncoming(wrapped);
      }
    }
    wrapped.update(state);
    if (wrapped === this.active && (state === 'early' || state === 'ringing' || state === 'active')) {
      this.primePlayback();
    }
  }

  /** Start the far-end element. Early media on that element is the wait music. */
  primePlayback(): void {
    const el = this.remoteElement;
    if (!el) return;
    if (el.srcObject) el.removeAttribute('src');
    void el.play().catch(() => undefined);
  }

  /** Apply the chosen mic and speaker to a leg that just came up. */
  private async onLegUp(leg: TelnyxEngineCall): Promise<void> {
    this.active = leg;
    // replaceTrack / setSinkId only (applyInput / applyOutput): the SDK's
    // setAudio*Device mid-session has been hanging up the browser leg.
    if (this.audio.inputDeviceId) await this.applyInput(this.audio.inputDeviceId);
    // Phones start in the receiver. A desk uses the speaker chosen in Settings.
    if (isTouchPhone()) {
      const wanted = getCallRoute();
      const devices = [...this.audio.availableOutputDevices.values()].map((d) => ({ deviceId: d.deviceId, label: d.label }));
      const sink = await applyCallRoute(wanted, devices);
      if (getCallRoute() === wanted) await this.applyOutput(sink);
      return;
    }
    if (this.speakerId) await this.applyOutput(this.speakerId);
  }

  applyMic(settings: MicSettings): void {
    this.mic = settings;
    if (this.client) void this.pushMic(this.client, settings);
  }

  /** Stop any capture still live after hangup. The saved mic id is untouched. */
  releaseCaptures(): void {
    for (const call of this.calls.values()) call.releaseCapture();
  }

  /** The session's media constraints, which every call it answers opens the mic with. */
  private async pushMic(client: TelnyxRTC, settings: MicSettings): Promise<void> {
    const ideal = settings.deviceId && typeof settings.deviceId === 'object' && 'ideal' in settings.deviceId ? settings.deviceId.ideal : undefined;
    const { deviceId: _drop, ...rest } = settings;
    void _drop;
    await client.setAudioSettings({ ...rest, ...(typeof ideal === 'string' ? { micId: ideal } : {}) }).catch(() => undefined);
  }

  async applyInput(deviceId: string): Promise<void> {
    // Mid-call setAudioInDevice hangs up the Telnyx browser leg (SDK mediaError
    // → hangup) while the conference stays up for the customer. Never call it.
    if (!this.active) return;
    await replaceAudioInputTrack(peerFromCall(this.active.call), { deviceId, muted: this.active.isMuted(), local: this.active.localStream() }).catch(() => false);
  }

  async applyOutput(deviceId: string): Promise<void> {
    this.speakerId = deviceId;
    if (this.client) this.client.speaker = deviceId;
    const sink = (this.remoteElement as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null)?.setSinkId;
    if (sink && this.remoteElement) await sink.call(this.remoteElement, deviceId).catch(() => undefined);
    // setSinkId only — setAudioOutDevice is the same underneath and is unused.
  }

  async register(): Promise<void> {
    if (this.destroyed) throw new Error('softphone was shut down');
    if (this.ready && this.client?.connected) return;
    // A lost socket is re-logged in with whatever token we hold now; a stale
    // client is replaced rather than nursed, the SDK has no updateToken.
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        /* already closed */
      }
    }
    const client = this.build();
    this.client = client;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Telnyx did not answer the registration')), 15_000);
      client.on('telnyx.ready', () => {
        clearTimeout(timer);
        resolve();
      });
      client.on('telnyx.error', (event: { error?: Error; message?: string }) => {
        clearTimeout(timer);
        reject(new Error(event?.error?.message ?? event?.message ?? 'Telnyx refused the login'));
      });
      void client.connect().catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  updateToken(token: string) {
    this.token = token;
  }

  isRegistered() {
    return this.ready && Boolean(this.client?.connected);
  }

  setOwnNumbers(numbers: string[]) {
    this.ownNumbers = new Set(numbers.map((n) => digits(n).slice(-10)).filter((n) => n.length === 10));
  }

  async connect(callId: string, opts: ConnectOptions): Promise<EngineCall> {
    if (this.pending) throw new Error('a call is already being connected');
    let slot: PendingLeg | null = null;
    const leg = new Promise<EngineCall>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === slot) this.pending = null;
        reject(new BrowserLegError('timeout'));
      }, opts.timeoutMs ?? 30_000);
      slot = { callId, expectFrom: opts.expectFrom ?? null, resolve, reject, timer };
      this.pending = slot;
    });
    try {
      await opts.ringServer();
    } catch (err) {
      if (slot && this.pending === slot) {
        clearTimeout((slot as PendingLeg).timer);
        this.pending = null;
      }
      throw err;
    }
    return leg;
  }

  destroy() {
    this.destroyed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('softphone was shut down'));
      this.pending = null;
    }
    this.audio.dispose();
    void this.client?.disconnect().catch(() => undefined);
    this.client = null;
    this.remoteElement?.remove();
  }
}
