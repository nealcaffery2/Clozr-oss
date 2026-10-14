// The softphone: Talkr's media leg, owned by the browser tab.
//
// Two-step click-to-call, exactly as Talkr's own web app does it: the server
// creates the call (`POST /v1/calls` — suppression, quiet hours and caller-ID
// rules run there) and the browser then opens the media leg for the call id.
// Call *control* — hold, add a party, transfer — is a server operation on the
// call's conference room; this hook only asks and re-reads the roster.
//
// Which carrier SDK carries the audio is the Talkr server's decision
// (`/v1/voice/token` names it) and lives behind lib/softphone-engine.ts:
// Twilio's Voice SDK or Telnyx's WebRTC SDK, same events either way.
//
// Kept outside React state where it must be: the engine and the active call
// live in refs, because re-rendering must never recreate a WebRTC session.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isBrowserLegError, RELOAD_AND_TRY } from './browser-leg';
import { everyWhileVisible } from './visible-timer';
import { createEngine, engineKindOf, type EngineAudio, type EngineCall, type SoftphoneEngine } from './softphone-engine';
import {
  callWhileLockedElsewhere, createSoftphoneLock, mayAutoAcquirePhone, PHONE_OTHER_TAB, USE_PHONE_HERE, type SoftphoneLock,
} from './softphone-lock';
import { VM_DROPPED_EVENT } from './dial-engine';
import { playDropOnLeg, playUrlOnPeer } from './vm-playback';
import { busyAnswer } from './busy-answer';
import { readyDropUrl } from './busy-drop';
import { TalkrError, talkr, type CallDto, type ParticipantDto } from './talkr';
import { probeTracksToStop } from './mic-release';
import {
  getAudioPrefs, isBenignHangupError, isTouchPhone, micConstraints, playEvent, primeRemoteCallAudio,
  remoteHasLiveAudio, setCarrierHeard, startOutgoingRing, startRing, stopRing, subscribeAudioPrefs, yieldLocalRingToCarrier,
} from './phone-audio';
import { applyCallRoute, getCallRoute, releaseCallAudioSession, resetCallRoute } from './call-route';
import { NEVER_DIALED_AFTER_MS, RING_GUARD_POLL_MS, RING_GUARD_WINDOW_MS, ringVerdict, type RingVerdict, type RosterRow } from './ring-guard';

export type DeviceState = 'off' | 'connecting' | 'ready' | 'error';
export type CallPhase = 'idle' | 'connecting' | 'ringing' | 'in_call' | 'wrapup';

export type IncomingInfo = { from: string; talkrCallId: string | null };

export type Softphone = {
  deviceState: DeviceState;
  deviceError: string | null;
  /** Which carrier SDK is loaded, once connected. */
  carrier: 'twilio' | 'telnyx' | null;
  phase: CallPhase;
  /** The Talkr call record for the live (or just-ended) call. */
  call: CallDto | null;
  /** When the far end picked up; drives the clock. */
  startedAt: number | null;
  muted: boolean;
  onHold: boolean;
  participants: ParticipantDto[];
  incoming: IncomingInfo | null;
  /**
   * Someone called while this browser was already on a line. The browser
   * holds one call, so that ring was declined. Cleared once the rep is told.
   */
  calledBack: string | null;
  clearCalledBack: () => void;
  /** The last control that was refused, in the rep's words. */
  controlError: string | null;
  /**
   * The call was hung up for the rep because the seller's side was over (rang
   * out, busy, failed) or never started (lib/ring-guard.ts). Cleared on the next call.
   */
  ringOut: RingVerdict | null;
  /**
   * Register the softphone. `claim` is a press (Connect, Retry, Enable,
   * Use phone here): it takes the lock from another tab. The default backs
   * off, and a hidden tab does not even try — only automatic connects do that.
   */
  initDevice: (opts?: { claim?: boolean }) => Promise<boolean>;
  /** Another tab holds a fresh lock. Call uses this before it asks for the mic. */
  phoneInOtherTab: () => boolean;
  /**
   * Unregister and drop the engine, unless a call is up or being opened —
   * then it returns false and leaves it be. For when another surface (the
   * Talkr extension) takes the phone.
   */
  releaseDevice: () => boolean;
  placeCall: (input: { to_number?: string; contact_id?: string; lead_id?: string; from_phone_number_id?: string }) => Promise<CallDto>;
  /**
   * Open the leg for a call the server already created — a dial session's
   * `next` (docs/dialers.md §3). Same path as `placeCall` without the create.
   */
  connectToCall: (record: CallDto, gesture?: Promise<MediaStream | null>) => Promise<CallDto>;
  acceptIncoming: () => void;
  rejectIncoming: () => void;
  hangup: () => void;
  toggleMute: () => void;
  sendDigits: (digits: string) => void;
  toggleHold: () => Promise<void>;
  addParticipant: (input: { user_id?: string; to_number?: string }) => Promise<void>;
  transfer: (input: { mode: 'warm' | 'blind'; user_id?: string; to_number?: string }) => Promise<void>;
  completeTransfer: () => Promise<void>;
  /** Both legs' audio, for the live transcript. Null until the call is up. */
  getStreams: () => { local: MediaStream | null; remote: MediaStream | null };
  /** Leave wrap-up; the dialer goes back to idle. */
  finishWrapup: () => void;
  /** The engine's mic/speaker control (the Talkr dialer's Audio button). Null until connected. */
  getAudio: () => EngineAudio | null;
  /**
   * A one-click recovery when the browser leg never rang, or when another
   * tab already holds the phone. Null when there is nothing to press.
   */
  deviceAction: { label: string; run: () => void } | null;
  /**
   * Play a recording to the person on the line, then hang up. Resolves after
   * the file ends. The session hears `clozr-vm-dropped` and, in predictive
   * mode, dials the next number.
   */
  dropVoicemail: (url: string) => Promise<void>;
};

const REFUSALS: Record<string, string> = {
  call_not_active: 'The call is not active any more.',
  no_customer: 'Nobody is on the line to hold.',
  nothing_to_merge: 'There is no second party to merge.',
  already_held: 'The seller is already on hold.',
  not_held: 'The seller is not on hold.',
  invalid_target: 'That is not a valid number or teammate.',
  suppressed: 'This number is on the Do-Not-Call list.',
  quiet_hours: "Outside this number's calling window.",
  invalid_caller_id: 'That caller ID is not one of your lines.',
  no_carrier: 'Talkr has no carrier connected.',
  unlinked: 'Talkr does not recognise this sign-in yet.',
  already_bound: 'This call is already ringing your browser.',
  browser_leg_is_client: 'The carrier expects the browser to dial; reload and try again.',
};

export function refusalText(err: unknown): string {
  if (err instanceof TalkrError) return REFUSALS[err.code] ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Last ten digits only, so "+1 (346) 555-0164" and "13465550164" compare equal. */
function last10(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '').slice(-10);
}

/**
 * An invite from one of our org numbers. On Telnyx that is either our outbound
 * server leg ringing back, or another softphone's (the Chrome extension) —
 * never a customer. Used to avoid SipHangupCause=486 on those legs.
 */
function isOwnNumberInvite(from: string | null | undefined, own: Set<string>): boolean {
  const key = last10(from);
  return key.length === 10 && own.has(key);
}

/** Push the saved audio preferences onto a carrier engine. */
function applyAudio(engine: SoftphoneEngine): void {
  const p = getAudioPrefs();
  engine.applyMic(micConstraints(p));
  // A phone call starts in the earpiece (lib/call-route.ts). The desk speaker
  // saved in Settings would put that call on the loudspeaker.
  if (isTouchPhone()) return;
  if (p.outputDeviceId && engine.audio.isOutputSelectionSupported) {
    void engine.audio.speakerDevices.set(p.outputDeviceId).catch(() => undefined);
  }
}

function outputSinks(engine: SoftphoneEngine | null): { deviceId: string; label: string }[] {
  return [...(engine?.audio.availableOutputDevices.values() ?? [])].map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

export function useSoftphone({ enabled }: { enabled: boolean }): Softphone {
  const [deviceState, setDeviceState] = useState<DeviceState>('off');
  const [deviceError, setDeviceErrorState] = useState<string | null>(null);
  const deviceErrorRef = useRef<string | null>(null);
  const setErr = useCallback((message: string | null) => {
    deviceErrorRef.current = message;
    setDeviceErrorState(message);
  }, []);
  const [deviceAction, setDeviceAction] = useState<Softphone['deviceAction']>(null);
  const [carrier, setCarrier] = useState<'twilio' | 'telnyx' | null>(null);
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [call, setCall] = useState<CallDto | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [participants, setParticipants] = useState<ParticipantDto[]>([]);
  const [incoming, setIncoming] = useState<IncomingInfo | null>(null);
  const [calledBack, setCalledBack] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [ringOut, setRingOut] = useState<RingVerdict | null>(null);

  const engineRef = useRef<SoftphoneEngine | null>(null);
  const callRef = useRef<EngineCall | null>(null);
  const incomingRef = useRef<EngineCall | null>(null);
  const callIdRef = useRef<string | null>(null);
  /** End pressed before the leg attached (see placeCall). */
  const cancelledRef = useRef(false);
  /**
   * A leg is being opened: from the tap until it attaches or fails. `phase`
   * is still idle while the mic and the carrier login are coming up (Telnyx
   * registration alone can take seconds), so this is what lets End and a
   * second dial see that something is already on its way.
   */
  const openingRef = useRef(false);
  /** Mic opened inside the tap. Stopped when the call ends, not when it connects. */
  const gestureRef = useRef<Promise<MediaStream | null> | null>(null);
  const initPromise = useRef<Promise<boolean> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last ten digits of every org number — server legs and other softphones present these. */
  const ownNumbersRef = useRef<Set<string>>(new Set());
  /** A voicemail drop is hanging up: skip wrap-up and tell the session. */
  const vmDropGo = useRef(false);
  const lockRef = useRef<SoftphoneLock | null>(null);
  const releaseRef = useRef<() => boolean>(() => false);
  const takeoverRef = useRef<() => void>(() => undefined);
  const reconnectRef = useRef<() => void>(() => undefined);

  const onHold = participants.some((p) => p.role !== 'agent' && p.state !== 'left' && p.hold);

  const refreshParticipants = useCallback(async () => {
    const id = callIdRef.current;
    if (!id) return;
    try {
      const r = await talkr.participants(id);
      setParticipants(r.participants);
    } catch {
      /* the roster is advisory */
    }
  }, []);

  /** Wire a media leg's lifecycle into state. Shared by outbound and accepted inbound. */
  const attach = useCallback((leg: EngineCall, record: CallDto) => {
    callRef.current = leg;
    callIdRef.current = record.id;
    setCall(record);
    setMuted(false);
    setParticipants([]);
    setControlError(null);
    setRingOut(null);
    leg.on('ringing', () => {
      setPhase((p) => (p === 'connecting' ? 'ringing' : p));
      engineRef.current?.primePlayback?.();
      const hearCarrier = () => {
        const prefs = getAudioPrefs();
        // The carrier's early media is the piano hold music. While this
        // browser is playing its own ringback (a built-in tone or an MP3),
        // that piano stays muted. It comes back the moment they answer.
        if (prefs.outgoingRingback) {
          setCarrierHeard(false);
          return;
        }
        setCarrierHeard(true);
        if (yieldLocalRingToCarrier({
          touch: isTouchPhone(),
          remoteAudio: remoteHasLiveAudio(leg.remoteStream()),
          customWaitMusic: !!prefs.outgoingCustomRingtoneUrl,
        })) stopRing();
      };
      hearCarrier();
      window.setTimeout(hearCarrier, 400);
    });
    leg.on('accept', () => {
      setCarrierHeard(true);
      stopRing();
      setStartedAt(Date.now());
      setPhase('in_call');
      engineRef.current?.primePlayback?.();
      playEvent('connected');
      void refreshParticipants();
    });
    leg.on('mute', (m: boolean) => setMuted(m));
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      setCarrierHeard(true);
      stopRing();
      // The carrier keeps its own capture after the signaling ends. Stopping
      // the gesture probe and the leg, then dropping any input the audio
      // helper re-opened on devicechange, is what turns the mic light off.
      const gesture = gestureRef.current;
      gestureRef.current = null;
      void gesture?.then((s) => s && probeTracksToStop(s, null, false).forEach((t) => t.stop()));
      leg.localStream()?.getTracks().forEach((t) => t.stop());
      const release = () => engineRef.current?.audio.unsetInputDevice().catch(() => undefined);
      void release();
      // Twilio schedules a fresh getUserMedia on setTimeout(0) when the
      // default track ends. A second release runs after that reopen.
      setTimeout(() => void release(), 0);
      setTimeout(() => void release(), 300);
      callRef.current = null;
      playEvent('ended');
      if (vmDropGo.current) {
        vmDropGo.current = false;
        setPhase('idle');
        window.dispatchEvent(new CustomEvent(VM_DROPPED_EVENT));
      } else {
        setPhase('wrapup');
      }
    };
    leg.on('disconnect', onEnd);
    leg.on('cancel', onEnd);
    leg.on('error', (err: { message?: string }) => {
      setControlError(err?.message ?? 'The call dropped.');
      onEnd();
    });
  }, [refreshParticipants]);

  /** Keep the credential fresh for as long as the softphone is up. */
  const scheduleRefresh = useCallback((engine: SoftphoneEngine, ttlSeconds: number) => {
    const arm = (seconds: number) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(async () => {
        refreshTimer.current = null;
        if (engineRef.current !== engine) return;
        try {
          const t = await talkr.voiceToken();
          engine.updateToken(t.token);
          arm(t.ttl_seconds);
        } catch {
          /* the next call attempt surfaces the problem */
        }
      }, Math.max(30, seconds - 60) * 1000);
    };
    arm(ttlSeconds);
  }, []);

  const showOtherTab = useCallback(() => {
    setDeviceState('error');
    setErr(PHONE_OTHER_TAB);
    setDeviceAction({ label: USE_PHONE_HERE, run: () => takeoverRef.current() });
  }, [setErr]);

  const phoneInOtherTab = useCallback(() => lockRef.current?.status() === 'other', []);

  const initDevice = useCallback(async (opts?: { claim?: boolean }): Promise<boolean> => {
    if (!enabled) return false;
    // A drop mid-call ('off') must not rebuild the engine under the live leg:
    // destroying it ends the call, and on Telnyx may never say so, leaving the
    // phase stuck in_call. The media often outlives the signalling socket, so
    // the call is left to finish and the reconnect waits for it.
    if (callRef.current && engineRef.current) return false;
    // Never skip a token fetch when "ready": a carrier cutover (Twilio → Telnyx)
    // leaves a registered engine that can no longer place calls. Always ask
    // /v1/voice/token and rebuild when provider changes.
    if (initPromise.current) {
      const ok = await initPromise.current;
      if (ok || !opts?.claim) return ok;
      if (callRef.current && engineRef.current) return false;
    }
    // A press takes the phone from whichever tab holds it. Automatic
    // registration backs off, and a tab the rep is not looking at does not
    // even ask — restored background tabs were registering over the live one.
    if (opts?.claim && lockRef.current) {
      lockRef.current.takeover();
      if (!lockRef.current.holding()) {
        showOtherTab();
        return false;
      }
    }
    const run = (async () => {
      if (!opts?.claim) {
        if (!mayAutoAcquirePhone(typeof document === 'undefined' ? null : document)) return false;
        const gate = lockRef.current?.tryHold() ?? 'ok';
        if (gate === 'other') {
          showOtherTab();
          return false;
        }
      }
      setDeviceState('connecting');
      setErr(null);
      setDeviceAction(null);
      try {
        const token = await talkr.voiceToken();
        const existing = engineRef.current;
        if (existing && existing.kind === engineKindOf(token) && existing.isRegistered() && deviceState === 'ready') {
          existing.updateToken(token.token);
          await existing.register();
          scheduleRefresh(existing, token.ttl_seconds);
          setDeviceState('ready');
          setCarrier(existing.kind);
          return true;
        }
        if (existing) {
          engineRef.current = null;
          existing.destroy();
        }
        let engine: SoftphoneEngine | null = null;
        engine = await createEngine(token, {
          onRegistered: () => {
            if (engineRef.current === engine) setDeviceState('ready');
          },
          onUnregistered: () => {
            if (engineRef.current === engine) setDeviceState((s) => (s === 'error' ? s : 'off'));
          },
          onError: (err) => {
            // Ending a call that is still ringing is a hangup, not a broken phone.
            if (isBenignHangupError(err.message)) {
              if (deviceErrorRef.current && isBenignHangupError(deviceErrorRef.current)) setErr(null);
              return;
            }
            setErr(err.message);
            if (err.fatal && engineRef.current === engine) setDeviceState('error');
          },
          onIncoming: (leg) => {
            // On Telnyx every outbound call rings this browser back from our
            // own caller ID. If the engine fails to claim that invite as its
            // pending leg (ANI mismatch, dual registration), it lands here
            // while `openingRef` is still true. Rejecting it sends
            // SipHangupCause=486 and the outbound call dies in ~1s before the
            // seller is ever dialed — which is exactly the "signs in, call
            // hangs up, never rings" failure. Ignore while connecting; the
            // connect() timeout still covers a miss.
            if (openingRef.current) return;
            // Truly on another call: only busy-reject a customer inbound.
            // An invite from one of our numbers is another softphone's
            // outbound ring-back (or our own late leg) — hanging it up also
            // produces 486 and can cancel the fork the answering client holds.
            if (callRef.current) {
              const own = isOwnNumberInvite(leg.from, ownNumbersRef.current);
              const dropUrl = readyDropUrl();
              const action = busyAnswer({ ownNumber: own, hasDrop: !!dropUrl });
              // Our own caller-ID ringing back is the outbound leg, not a second person.
              if (action === 'ignore') return;
              // Someone answered (or called) while this browser is already talking.
              // Play the saved drop on THAT leg and hang it up. Rejecting here is
              // the click the person hears. The call already on screen is a
              // different peer and is not hung up. A line Talkr never offers
              // here is still abandoned on the Talkr server.
              if (action === 'drop' && dropUrl) {
                void playDropOnLeg(leg, dropUrl).catch(() => {
                  setCalledBack(leg.from ?? 'Unknown');
                  playEvent('missed');
                  try { leg.disconnect(); } catch { leg.reject(); }
                });
                return;
              }
              setCalledBack(leg.from ?? 'Unknown');
              playEvent('missed');
              leg.reject();
              return;
            }
            if (isOwnNumberInvite(leg.from, ownNumbersRef.current)) return;
            incomingRef.current = leg;
            setIncoming({ from: leg.from ?? 'Unknown', talkrCallId: leg.talkrCallId });
            const clear = () => {
              if (incomingRef.current === leg) {
                incomingRef.current = null;
                setIncoming(null);
              }
            };
            // The caller hung up (or routing moved on) before anyone here answered.
            leg.on('cancel', () => {
              if (incomingRef.current === leg) playEvent('missed');
              clear();
            });
            leg.on('disconnect', clear);
            leg.on('reject', clear);
          },
        });
        engineRef.current = engine;
        applyAudio(engine);
        setCarrier(engine.kind);
        await engine.register();
        // Org numbers so the engine recognises a server leg that presents a
        // different ANI than the call's own caller ID.
        void talkr
          .me()
          .then((me) => {
            const numbers = (me.org_numbers ?? []).map((n) => n.phone_e164);
            ownNumbersRef.current = new Set(numbers.map(last10).filter((n) => n.length === 10));
            engine?.setOwnNumbers?.(numbers);
          })
          .catch(() => undefined);
        scheduleRefresh(engine, token.ttl_seconds);
        setDeviceState('ready');
        return true;
      } catch (err) {
        lockRef.current?.release();
        setDeviceState('error');
        setErr(refusalText(err));
        setDeviceAction(null);
        return false;
      } finally {
        initPromise.current = null;
      }
    })();
    initPromise.current = run;
    return run;
  }, [enabled, deviceState, scheduleRefresh, showOtherTab, setErr]);

  // The rep's mic, speaker and processing choices follow them onto the engine,
  // now and whenever Settings → Talkr → Audio changes them.
  useEffect(() => subscribeAudioPrefs(() => {
    if (engineRef.current) applyAudio(engineRef.current);
  }), []);

  // Ring while a call is offered to this browser; the card clearing (answer,
  // decline, caller hung up) stops it.
  useEffect(() => {
    if (!incoming) return;
    startRing();
    return stopRing;
  }, [incoming]);

  // Outbound ringback while connecting/ringing — same custom MP3 or built-in
  // tone as Settings → Talkr → Audio (inbox, dialer, and floating call share
  // this softphone hook).
  useEffect(() => {
    // An offered inbound call rings with startRing. Outbound ringback must
    // not start over it, or a call coming in sounds like one you placed.
    if (incoming) return;
    if (phase !== 'connecting' && phase !== 'ringing') return;
    startOutgoingRing();
    return stopRing;
  }, [phase, incoming]);

  // A phone call plays in the receiver until Speaker is tapped. The incoming
  // ringtone stays on the loudspeaker; the route applies once this browser is
  // actually on the call. The next call starts in the receiver again.
  useEffect(() => {
    if (!isTouchPhone()) return;
    const onCall = !incoming && (phase === 'connecting' || phase === 'ringing' || phase === 'in_call');
    if (!onCall) {
      releaseCallAudioSession();
      if (phase === 'idle' || phase === 'wrapup') resetCallRoute();
      return;
    }
    const wanted = getCallRoute();
    const engine = engineRef.current;
    void applyCallRoute(wanted, outputSinks(engine)).then((sink) => {
      if (getCallRoute() !== wanted) return;
      void engine?.audio.speakerDevices.set(sink).catch(() => undefined);
    });
  }, [phase, incoming]);

  // The ring guard (lib/ring-guard.ts). While an outbound call is young, re-read
  // it: once Talkr says the seller's side is over, or the rep has sat alone in
  // the room past Talkr's own retry, hang the rep's leg up instead of leaving
  // them on a dead line with the clock running.
  const watchCallId = phase === 'in_call' && call?.direction === 'outbound' ? call.id : null;
  useEffect(() => {
    if (!watchCallId) return;
    const since = Date.now();
    let stop = false;
    let sawSeller = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stop) return;
      const upForMs = Date.now() - since;
      if (upForMs > RING_GUARD_WINDOW_MS) return;
      try {
        // The roster is only needed to spot a seller who was never dialled.
        const wantRoster = !sawSeller && upForMs >= NEVER_DIALED_AFTER_MS;
        const [fresh, roster] = await Promise.all([
          talkr.call(watchCallId).then((r) => r.call),
          wantRoster ? talkr.participants(watchCallId).then((r) => r.participants as RosterRow[]).catch(() => null) : Promise.resolve(null),
        ]);
        if (stop || callIdRef.current !== watchCallId) return;
        if (roster?.some((p) => p.role !== 'agent')) sawSeller = true;
        const verdict = ringVerdict({ status: fresh.status, roster: sawSeller ? null : roster, upForMs: Date.now() - since });
        const leg = callRef.current;
        if (verdict && leg) {
          setCall(fresh);
          setRingOut(verdict);
          setControlError(verdict.message);
          leg.disconnect();
          return;
        }
      } catch {
        /* a missed read is retried on the next tick */
      }
      if (!stop) timer = setTimeout(() => void tick(), RING_GUARD_POLL_MS);
    };
    timer = setTimeout(() => void tick(), RING_GUARD_POLL_MS);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [watchCallId]);

  // Tear the engine down when the hook is disabled (sign-out) or unmounts.
  // The cleanup runs on both, so one effect covers both paths.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      engineRef.current?.destroy();
      engineRef.current = null;
      setDeviceState('off');
    };
  }, [enabled]);

  /**
   * Open this browser's leg for a call, creating it first or taking one the
   * server has already created.
   *
   * A dial session's `next` creates the call itself (docs/dialers.md §3) and
   * hands back the record, so the browser's job there is only the leg. Both
   * paths are otherwise identical — the mic gesture, the engine, the
   * cancelled-while-connecting guard — and keeping them one function is what
   * stops the power dialer drifting away from click-to-call.
   */
  const openLeg = useCallback(
    async (obtain: () => Promise<CallDto>, existing = false, gesture?: Promise<MediaStream | null>): Promise<CallDto> => {
      if (callRef.current || openingRef.current) throw new Error('A call is already active.');
      // Before the microphone, the ring, or any await. Another tab holding
      // the phone is not a mic problem and it is not "the softphone could
      // not connect". Name it and offer the button that takes the lock.
      // Stealing on the dial itself would register a second phone under a
      // call that is live over there. Connect, Retry, Enable and Use phone
      // here are the presses that take it; Call is the one that asks.
      const elsewhere = callWhileLockedElsewhere(lockRef.current?.status() ?? 'free');
      if (elsewhere) {
        showOtherTab();
        throw Object.assign(new Error(PHONE_OTHER_TAB), { code: 'other_tab' as const });
      }
      // Set before the first await: End pressed at any point from here on
      // must be seen by the checks below, not wiped by a reset after it.
      openingRef.current = true;
      cancelledRef.current = false;
      // Still inside the tap. A phone will not play wait music, or the far
      // end, on an element that has not played from this gesture.
      primeRemoteCallAudio();
      engineRef.current?.primePlayback?.();
      startOutgoingRing();
      // Ask for the mic now, while this still runs inside the rep's tap: iOS
      // Safari only prompts (and only lets the far end's audio autoplay) from
      // a gesture, and everything after the first await below is not one.
      // A dial session opens this inside its own tap and passes it in, because
      // the leg itself starts only after the server answers.
      const mic: Promise<MediaStream | null> = gesture ?? (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? navigator.mediaDevices.getUserMedia({ audio: micConstraints() }).catch(() => null)
        : Promise.resolve(null));
      // `code: 'device'`: this browser cannot carry the call at all (no WebRTC,
      // mic refused, carrier login failed), as opposed to Talkr refusing it.
      // Thrown before the call exists, so nothing was dialled.
      const deviceFailure = (message: string) => Object.assign(new Error(message), { code: 'device' as const });
      // End pressed before anything was dialled. Not a failure to show anyone.
      const cancelled = () => Object.assign(new Error('The call was cancelled.'), { code: 'cancelled' as const });
      try {
        if (!(await mic)) throw deviceFailure('Microphone is blocked or unavailable in this browser.');
        // The lock is free or already ours. Claim it so a press is not the
        // automatic path that backs off.
        const ok = await initDevice({ claim: true });
        const engine = engineRef.current;
        if (!ok || !engine) {
          const reason = deviceErrorRef.current ?? 'The softphone could not connect.';
          if (reason === PHONE_OTHER_TAB || lockRef.current?.status() === 'other') {
            showOtherTab();
            throw Object.assign(new Error(PHONE_OTHER_TAB), { code: 'other_tab' as const });
          }
          throw deviceFailure(reason);
        }
        // A call the server already created (dial session) still gets its
        // wrap-up, below; one not yet created is simply never created.
        if (cancelledRef.current && !existing) throw cancelled();
        setPhase('connecting');
        setStartedAt(null);
        let record: CallDto;
        try {
          record = await obtain();
        } catch (err) {
          setPhase('idle');
          throw new Error(refusalText(err));
        }
        setCall(record);
        callIdRef.current = record.id;
        // End pressed while the call was being created: it exists on the
        // server, so keep the record for wrap-up, but never open the leg — on
        // Telnyx opening it is what rings the seller.
        if (cancelledRef.current) {
          cancelledRef.current = false;
          callIdRef.current = null;
          setPhase('wrapup');
          return record;
        }
        let leg: EngineCall;
        try {
          // Twilio: the browser dials with the call id. Telnyx: the server rings
          // this browser for the call and the engine answers.
          leg = await engine.connect(record.id, {
            ringServer: () => talkr.ringBrowserLeg(record.id),
            expectFrom: record.from_number,
          });
        } catch (err) {
          callIdRef.current = null;
          setCall(null);
          setPhase('idle');
          if (isBrowserLegError(err)) {
            void talkr.hangupCall(record.id).catch(() => undefined);
            const stuck = engineRef.current;
            engineRef.current = null;
            try { stuck?.destroy(); } catch { /* already gone */ }
            // The client is gone. Holding the lock here is what leaves every
            // other tab unable to register while this one waits on the rep.
            lockRef.current?.release();
            setDeviceState('error');
            setErr(RELOAD_AND_TRY);
            setDeviceAction({ label: 'Reconnect', run: () => reconnectRef.current() });
          }
          throw new Error(refusalText(err));
        }
        // End was pressed while this leg was still connecting: drop it instead
        // of wiring it up, or the far end answering would revive a call the
        // rep already ended.
        if (cancelledRef.current) {
          cancelledRef.current = false;
          try { leg.disconnect(); } catch { /* already gone */ }
          callIdRef.current = null;
          setCall(null);
          return record;
        }
        attach(leg, record);
        return record;
      } finally {
        openingRef.current = false;
        if (!callRef.current) stopRing();
        void mic.then((s) => {
          if (!s) return;
          const leg = callRef.current;
          if (!leg) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          // Keep a track the carrier is still sending. Stopping it here is
          // what leaves the mic on after Always.
          gestureRef.current = Promise.resolve(s);
          probeTracksToStop(s, leg.localStream(), true).forEach((t) => t.stop());
        });
      }
    },
    [attach, initDevice, showOtherTab, setErr],
  );

  const releaseDevice = useCallback(() => {
    if (callRef.current || openingRef.current || incomingRef.current) return false;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
    const engine = engineRef.current;
    engineRef.current = null;
    engine?.destroy();
    lockRef.current?.release();
    setDeviceState('off');
    return true;
  }, []);

  const takeover = useCallback(() => {
    if (callRef.current || openingRef.current) return;
    const engine = engineRef.current;
    engineRef.current = null;
    try { engine?.destroy(); } catch { /* already gone */ }
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
    setDeviceAction(null);
    setErr(null);
    setDeviceState('off');
    // claim takes the lock from the other tab, then registers here.
    void initDevice({ claim: true });
  }, [initDevice, setErr]);

  const reconnect = useCallback(() => {
    if (callRef.current || openingRef.current) return;
    setDeviceAction(null);
    const engine = engineRef.current;
    engineRef.current = null;
    try { engine?.destroy(); } catch { /* already gone */ }
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
    setErr(null);
    setDeviceState('off');
    void initDevice({ claim: true });
  }, [initDevice, setErr]);

  useEffect(() => {
    releaseRef.current = releaseDevice;
    takeoverRef.current = takeover;
    reconnectRef.current = reconnect;
  }, [releaseDevice, takeover, reconnect]);

  useEffect(() => {
    const lock = createSoftphoneLock({
      onLost: () => {
        if (!releaseRef.current()) return;
        showOtherTab();
      },
    });
    lockRef.current = lock;
    return () => {
      lock.destroy();
      if (lockRef.current === lock) lockRef.current = null;
    };
  }, [showOtherTab]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const wake = () => {
      // Visible is not enough: a window behind another must not register.
      if (!mayAutoAcquirePhone(document)) return;
      const engine = engineRef.current;
      if (!engine || engine.isRegistered()) return;
      if (callRef.current || openingRef.current || incomingRef.current) return;
      if (lockRef.current?.tryHold() === 'other') {
        showOtherTab();
        return;
      }
      void initDevice();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [initDevice, showOtherTab]);

  useEffect(() => {
    if (deviceError !== PHONE_OTHER_TAB) return;
    // A background tab must not pick the phone up. Visible and focused tabs
    // retry every 30s; showing the tab tries immediately (the wake effect above).
    return everyWhileVisible(() => {
      if (!mayAutoAcquirePhone(document)) return;
      if (lockRef.current?.tryHold() !== 'ok') return;
      setErr(null);
      setDeviceAction(null);
      setDeviceState('off');
    }, 30_000);
  }, [deviceError, setErr]);

  const placeCall = useCallback<Softphone['placeCall']>(
    (input) => openLeg(async () => (await talkr.createCall(input)).call),
    [openLeg],
  );

  const connectToCall = useCallback<Softphone['connectToCall']>(
    (record, gesture) => openLeg(async () => record, true, gesture),
    [openLeg],
  );

  const acceptIncoming = useCallback(() => {
    const leg = incomingRef.current;
    const info = incoming;
    if (!leg || !info) return;
    if (callRef.current || openingRef.current) return;
    incomingRef.current = null;
    setIncoming(null);
    primeRemoteCallAudio();
    engineRef.current?.primePlayback?.();
    const placeholder: CallDto = {
      id: info.talkrCallId ?? 'unknown',
      direction: 'inbound',
      status: 'in_progress',
      user_id: null,
      lead_id: null,
      contact_id: null,
      from_number: info.from,
      to_number: '',
      answered_at: null,
      ended_at: null,
      duration_seconds: null,
      disposition_id: null,
      contact_name: null,
      created_at: new Date().toISOString(),
    };
    attach(leg, placeholder);
    setStartedAt(Date.now());
    setPhase('in_call');
    leg.accept();
    if (info.talkrCallId) {
      void talkr.call(info.talkrCallId).then((r) => setCall(r.call)).catch(() => undefined);
    }
  }, [attach, incoming]);

  const clearCalledBack = useCallback(() => setCalledBack(null), []);

  const rejectIncoming = useCallback(() => {
    incomingRef.current?.reject();
    incomingRef.current = null;
    setIncoming(null);
  }, []);

  const hangup = useCallback(() => {
    const c = callRef.current;
    if (c) c.disconnect();
    else if (phase === 'connecting' || phase === 'ringing') { cancelledRef.current = true; setPhase('wrapup'); }
    // Still bringing up the mic or the softphone: nothing is dialled yet, so
    // there is no wrap-up to show — openLeg stops at its next check.
    else if (openingRef.current) cancelledRef.current = true;
  }, [phase]);

  const toggleMute = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    c.mute(!c.isMuted());
  }, []);

  const sendDigits = useCallback((digits: string) => {
    callRef.current?.sendDigits(digits);
  }, []);

  const control = useCallback(
    async (fn: (id: string) => Promise<unknown>) => {
      const id = callIdRef.current;
      if (!id) return;
      setControlError(null);
      try {
        await fn(id);
      } catch (err) {
        setControlError(refusalText(err));
      } finally {
        void refreshParticipants();
      }
    },
    [refreshParticipants],
  );

  const toggleHold = useCallback(() => control((id) => talkr.hold(id, !onHold)), [control, onHold]);
  const addParticipant = useCallback<Softphone['addParticipant']>((input) => control((id) => talkr.addParticipant(id, input)), [control]);
  const transfer = useCallback<Softphone['transfer']>((input) => control((id) => talkr.transfer(id, input)), [control]);
  const completeTransfer = useCallback(() => control((id) => talkr.completeTransfer(id)), [control]);

  const getStreams = useCallback(() => {
    const c = callRef.current;
    if (!c) return { local: null, remote: null };
    return { local: c.localStream(), remote: c.remoteStream() };
  }, []);

  const finishWrapup = useCallback(() => {
    callIdRef.current = null;
    setRingOut(null);
    setCall(null);
    setStartedAt(null);
    setParticipants([]);
    setMuted(false);
    setPhase('idle');
  }, []);

  const getAudio = useCallback(() => engineRef.current?.audio ?? null, []);

  const dropVoicemail = useCallback(async (url: string) => {
    const peer = callRef.current?.peerConnection() ?? null;
    if (!peer) throw new Error('The call is not up yet, so there is nowhere to play the recording.');
    vmDropGo.current = true;
    try {
      await playUrlOnPeer(peer, url);
      callRef.current?.disconnect();
    } catch (err) {
      vmDropGo.current = false;
      throw err;
    }
  }, []);

  return useMemo<Softphone>(
    () => ({
      deviceState: enabled ? deviceState : 'off',
      deviceError,
      carrier,
      phase,
      call,
      startedAt,
      muted,
      onHold,
      participants,
      incoming,
      calledBack,
      clearCalledBack,
      controlError,
      ringOut,
      initDevice,
      phoneInOtherTab,
      releaseDevice,
      placeCall,
      connectToCall,
      acceptIncoming,
      rejectIncoming,
      hangup,
      toggleMute,
      sendDigits,
      toggleHold,
      addParticipant,
      transfer,
      completeTransfer,
      getStreams,
      finishWrapup,
      getAudio,
      deviceAction: enabled ? deviceAction : null,
      dropVoicemail,
    }),
    [
      enabled, deviceState, deviceError, deviceAction, carrier, phase, call, startedAt, muted, onHold, participants, incoming, calledBack, clearCalledBack, controlError, ringOut,
      initDevice, phoneInOtherTab, releaseDevice, placeCall, connectToCall, acceptIncoming, rejectIncoming, hangup, toggleMute, sendDigits, toggleHold, addParticipant,
      transfer, completeTransfer, getStreams, finishWrapup, getAudio, dropVoicemail,
    ],
  );
}
