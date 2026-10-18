'use client';

/**
 * CLOZR seam for Talkr's dialer components.
 *
 * Talkr's ActiveCall / DialerScreen / IncomingCall read `useSoftphone()` from
 * Talkr's own SoftphoneProvider (A:\talkr\apps\web\lib\softphone.tsx). CLOZR
 * already runs the phone in useTalkrPhone (lib/softphone.ts + the live
 * transcript), so this provider exposes the same shape backed by CLOZR's view
 * model instead of bringing a second engine:
 *
 *  - media (dial, answer, mute, DTMF, hang up) goes through `V`, so the call
 *    carries CLOZR's call target, transcript, intel and wrap-up;
 *  - conference control (hold, add, merge, drop, transfer) is Talkr's own:
 *    lib/talkr-web/api.ts against the call's room, exactly as Talkr's
 *    provider does it, with the roster re-read after every control;
 *  - the sample-data demo (no workspace) maps onto V's scripted call.
 */

import { eventFacts, useTalkrEvents } from '@/lib/talkr-events';
import { everyWhileVisible } from '@/lib/visible-timer';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import type { CallTarget } from '@/app/clozr/useClozr';
import {
  ApiError,
  api,
  type CallDto,
  type LiveCallDto,
  type MeDto,
  type MonitorMode,
  type ParticipantDto,
  type TeamMemberDto,
} from '@/lib/talkr-web/api';
import { toE164 } from '@/lib/talkr-web/time';
import type { ClozrRecord } from './CallContext';
import { useSession } from '@/lib/session';
import { setAudioPrefs, useAudioPrefs } from '@/lib/phone-audio';
import { applyCallRoute, getCallRoute, subscribeCallRoute, type CallRoute } from '@/lib/call-route';
import { requestSettingsTab, type TalkrSettingsTab } from '@/app/clozr/screens/settingsTab';
import { useCrmSounds } from './useCrmSounds';

/** How often teammates' live calls are read while the tab is visible. */
const LIVE_POLL_MS = 10_000;
/**
 * With no live-calls list on screen the poll only keeps the "may this rep
 * monitor?" answer fresh, so it asks rarely. It used to ask every 5 s on
 * every screen of every rep's tab, which is most of what loaded the server.
 */
const LIVE_POLL_IDLE_MS = 120_000;

/** How many live-calls lists are mounted. The poll runs at full speed only while one is. */
let liveWanted = 0;
const liveWantedListeners = new Set<() => void>();
const liveWantedStore = {
  subscribe: (fn: () => void) => { liveWantedListeners.add(fn); return () => { liveWantedListeners.delete(fn); }; },
  get: () => liveWanted > 0,
  getServer: () => false,
};
/** A live-calls list (the sales floor) calls this while mounted. */
export function useWantLiveCalls() {
  useEffect(() => {
    liveWanted += 1;
    liveWantedListeners.forEach((fn) => fn());
    return () => {
      liveWanted -= 1;
      liveWantedListeners.forEach((fn) => fn());
    };
  }, []);
}

const NO_TEAM: TeamMemberDto[] = [];

/** The longest a failing live-calls read waits before asking again. */
const LIVE_POLL_MAX_MS = 60_000;

export type DeviceState = 'uninitialized' | 'initializing' | 'ready' | 'offline' | 'error';
export type LocalCallState = 'idle' | 'connecting' | 'ringing' | 'in_call' | 'wrapup';

export interface ActiveCall {
  record: CallDto;
  startedAt: number | null;
  muted: boolean;
}

export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

export interface IncomingCallInfo {
  from: string;
  talkrCallId: string | null;
}

export interface SoftphoneValue {
  deviceState: DeviceState;
  deviceError: string | null;
  /** Reconnect, or take the phone from another tab. Null when there is nothing to press. */
  deviceAction: { label: string; run: () => void } | null;
  callState: LocalCallState;
  active: ActiveCall | null;
  incoming: IncomingCallInfo | null;
  serverStatus: string | null;
  authed: boolean;
  /** Enable / Retry claim the lock. Pass `{ claim: false }` to back off when another tab holds it. */
  initDevice: (opts?: { claim?: boolean }) => Promise<void>;
  /** Another tab holds the phone. Call checks this before it asks for the mic. */
  phoneInOtherTab: () => boolean;
  placeCall: (input: { to_number?: string; lead_id?: string; contact_id?: string }) => Promise<void>;
  acceptIncoming: () => void;
  rejectIncoming: () => void;
  hangup: () => void;
  toggleMute: () => void;
  sendDigit: (digit: string) => void;
  participants: ParticipantDto[];
  onHold: boolean;
  merged: boolean;
  controlError: string | null;
  controlErrorCode: string | null;
  toggleHold: () => Promise<void>;
  addParticipant: (input: { user_id?: string; to_number?: string; consult?: boolean }) => Promise<void>;
  merge: () => Promise<void>;
  dropParticipant: (providerParticipantId: string) => Promise<void>;
  transfer: (input: { mode: 'warm' | 'blind'; user_id?: string; to_number?: string }) => Promise<void>;
  completeTransfer: () => Promise<void>;
  inputDevices: AudioDevice[];
  outputDevices: AudioDevice[];
  audioDevices: AudioDevice[];
  activeInputDeviceId: string | null;
  activeOutputDeviceId: string | null;
  activeAudioDeviceId: string | null;
  selectAudioDevice: (deviceId: string) => Promise<void>;
  /** The mic, which nothing could change from a call until now. */
  selectInputDevice: (deviceId: string) => Promise<void>;
  /** True while this call is on the loudspeaker. A phone starts with this off (earpiece). */
  speakerOn: boolean;
  /** Earpiece ↔ loudspeaker for the call that is up. The next call starts in the earpiece. */
  toggleSpeaker: () => void;
  /** Play a saved recording to the person on the line, then hang up. */
  dropVoicemail: (url: string) => Promise<void>;

  // ── CLOZR additions: shared by the Dialer screen and the slide-out ────────
  /** The CLOZR record on the line (seller or buyer), when there is one. */
  record: ClozrRecord | null;
  team: TeamMemberDto[];
  me: MeDto | null;
  setMe: (me: MeDto) => void;
  recent: CallDto[];
  /** Call notes, one draft across both surfaces; saved with the wrap-up. */
  notes: string;
  setNotes: (next: string | ((cur: string) => string)) => void;

  // ── Supervision (listen / whisper / barge) ──────────────────────────────
  /** Teammates' live calls; null when this user may not monitor (403) or is not signed in. */
  liveCalls: LiveCallDto[] | null;
  /** The call this user is monitoring, and how. Its leg rings this browser and is answered automatically. */
  monitor: { call: LiveCallDto; mode: MonitorMode } | null;
  startMonitor: (call: LiveCallDto, mode: MonitorMode) => Promise<void>;
  switchMonitor: (mode: MonitorMode) => Promise<void>;
  leaveMonitor: () => Promise<void>;
  /** Open Settings → Talkr on a tab (scripts from a call, audio from the headset line). */
  openTalkrSettings: (tab: TalkrSettingsTab) => void;
}

/** "Default - Headset (1234:abcd)" → "Headset". Verbatim from Talkr's lib/softphone.tsx. */
export function shortDeviceLabel(label: string): string {
  return label
    .replace(/^(Default|Communications)\s+-\s+/i, '')
    .replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .trim();
}

const SoftphoneContext = createContext<SoftphoneValue | null>(null);

export function useSoftphone(): SoftphoneValue {
  const ctx = useContext(SoftphoneContext);
  if (!ctx) throw new Error('useSoftphone must be used inside <TalkrSoftphoneProvider>');
  return ctx;
}

function callRecord(partial: Partial<CallDto> & Pick<CallDto, 'id' | 'direction' | 'from_number' | 'to_number'>): CallDto {
  return {
    correlation_id: '', status: 'in_progress', user_id: null, lead_id: null, contact_id: null, answered_at: null, ended_at: null,
    duration_seconds: null, failure_class: '', disposition_id: null, crm_sync_status: '', contact_name: null,
    created_at: new Date(0).toISOString(),
    ...partial,
  };
}

export function TalkrSoftphoneProvider({ V, children }: { V: ClozrView; children: ReactNode }) {
  const phone = V.talkrPhone;
  const sp = phone.sp;
  const live = V.phoneEnabled;
  const authed = V.talkrAuthed;
  const session = useSession();
  useCrmSounds(session.workspace?.id ?? null, session.user?.id ?? null);
  const audioPrefs = useAudioPrefs();

  // ── call state: V reconciles the softphone with the scripted demo call ──
  const callState: LocalCallState =
    V.callState === 'wrap' ? 'wrapup'
      : V.callState === 'idle' ? 'idle'
        : live && (sp.phase === 'connecting' || sp.phase === 'ringing') ? sp.phase
          : 'in_call';
  const inCall = callState === 'in_call';

  const target = V.callTarget;
  const named = target.name && target.name !== target.phone && target.name !== '—' ? target.name : null;
  const active: ActiveCall | null =
    callState === 'idle' || callState === 'wrapup'
      ? null
      : {
          record: live && sp.call
            ? callRecord({ ...sp.call, contact_name: sp.call.contact_name ?? named })
            : callRecord({
                id: 'demo', direction: 'outbound', to_number: toE164(target.phone) || target.phone,
                from_number: '+12105550100', contact_name: named,
              }),
          // The softphone's answer time, or the demo's scripted start.
          startedAt: V.callTimer.startedAt,
          muted: V.muted,
        };

  // ── the conference room, Talkr's way ───────────────────────────────────
  const callId = live && inCall && sp.call && sp.call.id !== 'unknown' ? sp.call.id : null;
  const [participants, setParticipants] = useState<ParticipantDto[]>([]);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlErrorCode, setControlErrorCode] = useState<string | null>(null);

  // One read at a time per call: a control's re-read, an event and the poll
  // landing together share it rather than each asking Talkr.
  // A control's re-read (`fresh`) waits for one in flight and then asks
  // again, since that read may have started before the hold or the add.
  const rosterRead = useRef<{ id: string; p: Promise<void> } | null>(null);
  const refreshParticipants = useCallback((id: string, fresh = false): Promise<void> => {
    const read = (): Promise<void> => {
      const again = rosterRead.current?.id === id ? rosterRead.current.p : null;
      if (again) return again;
      const p = api.listParticipants(id)
        .then(({ participants: rows }) => setParticipants(rows))
        .catch(() => { /* a transient read failure leaves the last known roster in place */ })
        .finally(() => { if (rosterRead.current?.p === p) rosterRead.current = null; });
      rosterRead.current = { id, p };
      return p;
    };
    const inFlight = rosterRead.current?.id === id ? rosterRead.current.p : null;
    if (inFlight && fresh) return inFlight.then(read);
    return read();
  }, []);

  // The room re-reads when Talkr says this call changed (the shared stream,
  // lib/talkr-events), and every 30 s while the tab is in view in case an
  // event is missed. Not while hidden: nobody is looking at the roster.
  useTalkrEvents(!!callId, ['call.updated'], (events) => {
    if (callId && events.some((e) => { const id = eventFacts(e).callId; return !id || id === callId; })) void refreshParticipants(callId);
  }, 250);
  useEffect(() => {
    if (!callId) {
      setParticipants([]);
      return;
    }
    void refreshParticipants(callId);
    return everyWhileVisible(() => { void refreshParticipants(callId); }, 30_000);
  }, [callId, refreshParticipants]);

  const control = useCallback(
    async (fn: (id: string) => Promise<unknown>) => {
      if (!callId) return;
      setControlError(null);
      setControlErrorCode(null);
      try {
        await fn(callId);
      } catch (err) {
        setControlError(err instanceof Error ? err.message : 'control failed');
        setControlErrorCode(err instanceof ApiError ? err.code : null);
      }
      await refreshParticipants(callId, true);
    },
    [callId, refreshParticipants],
  );

  const onHold = live
    ? participants.some((p) => p.role === 'customer' && p.state === 'on_hold')
    : V.hold;
  const merged =
    participants.filter((p) => p.state === 'joined' && p.role !== 'supervisor').length >= 3 &&
    participants.some((p) => p.role === 'customer' && p.state === 'joined');

  // ── audio devices, from the carrier engine ─────────────────────────────
  const audio = live && sp.deviceState === 'ready' ? sp.getAudio() : null;
  const [, setDeviceTick] = useState(0);
  useEffect(() => {
    if (!audio) return;
    const bump = () => setDeviceTick((n) => n + 1);
    audio.on('deviceChange', bump);
    return () => audio.off('deviceChange', bump);
  }, [audio]);
  // Until the browser has been allowed the mic once it withholds every label,
  // so a picker of four blanks is what you get: number them instead.
  const list = (m: Map<string, MediaDeviceInfo> | undefined, kind: AudioDevice['kind']): AudioDevice[] =>
    [...(m?.values() ?? [])].map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || (d.deviceId === 'default' ? 'System default' : `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${i + 1}`),
      kind,
    }));
  const outputDevices = list(audio?.availableOutputDevices, 'audiooutput');
  const inputDevices = list(audio?.availableInputDevices, 'audioinput');
  const activeOutputDeviceId = audio ? ([...audio.speakerDevices.get()][0]?.deviceId ?? null) : null;
  const [speakerOn, setSpeakerOn] = useState(() => getCallRoute() === 'speaker');
  useEffect(() => subscribeCallRoute(() => setSpeakerOn(getCallRoute() === 'speaker')), []);
  const toggleSpeaker = useCallback(() => {
    const next: CallRoute = getCallRoute() === 'speaker' ? 'earpiece' : 'speaker';
    // Raw labels only. The picker falls back to "Speaker 1" when the browser
    // has not named a device, and that word would be mistaken for the loudspeaker.
    const devices = [...(audio?.availableOutputDevices.values() ?? [])].map((d) => ({ deviceId: d.deviceId, label: d.label }));
    void applyCallRoute(next, devices).then((sink) => audio?.speakerDevices.set(sink).catch(() => undefined));
  }, [audio]);

  // ── the lists the dialer reads ─────────────────────────────────────────
  // useTalkrPhone already reads the rep, their numbers (with each line's
  // carrier), the team and recent calls, and re-reads Recent when a call
  // ends. This used to ask Talkr for all of it a second time. Both clients
  // call the same endpoints, so the rows are the same JSON under two names.
  const phoneData = phone.data;
  const recent = useMemo(() => (authed ? (phoneData.recent.slice(0, 8) as unknown as CallDto[]) : []), [authed, phoneData.recent]);
  const team = authed ? (phoneData.team as unknown as TeamMemberDto[]) : NO_TEAM;
  const me = authed ? (phoneData.me as unknown as MeDto | null) : null;
  const setPhoneMe = phone.setMe;
  const [notes, setNotes] = useState('');
  // A call's notes go onto its record once the call is over, then the draft
  // clears for the next one. The target is kept from while the call was up;
  // by idle the view may already have let go of it.
  const lastTarget = useRef<CallTarget | null>(null);
  /** The Talkr call the notes were typed on, so they land on that call's row. */
  const lastCallId = useRef<string | null>(null);
  const liveCallId = V.talkrPhone.sp.call?.id ?? null;
  const saveCallNote = V.saveCallNote;
  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);
  const prevCallState = useRef<LocalCallState>(callState);
  useEffect(() => {
    const was = prevCallState.current;
    prevCallState.current = callState;
    if (callState !== 'idle') {
      // A call answered straight out of wrap-up never passes through idle, so
      // the last call's notes are filed here — on its own record — before the
      // new caller becomes the target, instead of being saved against them.
      const prev = lastTarget.current;
      if (was === 'wrapup' && callState !== 'wrapup' && prev && V.callTarget && prev.phone !== V.callTarget.phone) {
        if (notesRef.current.trim()) saveCallNote(notesRef.current, prev, { callId: lastCallId.current });
        setNotes('');
      }
      lastTarget.current = V.callTarget;
      // Not during wrap-up: the next call can arrive before this one's notes are filed.
      if (callState !== 'wrapup' && liveCallId && liveCallId !== 'unknown') lastCallId.current = liveCallId;
      return;
    }
    // Only the moment a call ends: notes typed before dialing stay put.
    if (!lastTarget.current) return;
    if (notesRef.current.trim()) saveCallNote(notesRef.current, lastTarget.current, { callId: lastCallId.current });
    lastTarget.current = null;
    lastCallId.current = null;
    setNotes('');
  }, [callState, V.callTarget, saveCallNote, liveCallId]);

  // ── supervision: teammates' live calls, and the one being monitored ────
  const [liveCalls, setLiveCalls] = useState<LiveCallDto[] | null>(null);
  const [monitor, setMonitor] = useState<SoftphoneValue['monitor']>(null);
  /** When the server was asked to ring this browser for a monitor leg; that ring is answered without a click. */
  const monitorRingAt = useRef(0);
  /** The call being joined. Only a ring carrying its id is the monitor leg. */
  const monitorCallId = useRef<string | null>(null);
  const canPollLive = authed && (callState === 'idle' || monitor !== null);
  const liveOnScreen = useSyncExternalStore(liveWantedStore.subscribe, liveWantedStore.get, liveWantedStore.getServer);
  const livePollMs = liveOnScreen || monitor !== null ? LIVE_POLL_MS : LIVE_POLL_IDLE_MS;
  // Every 5 s while the tab is visible; a hidden tab does not ask at all
  // (every screen in every tab used to, 12 requests a minute each) and asks
  // once as soon as it is shown again. A failure retries after 10 s, then
  // twice as long each time up to a minute; a success goes back to the cadence.
  useEffect(() => {
    if (!canPollLive) return;
    let stop = false;
    let wait = livePollMs;
    let fails = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const schedule = () => {
      if (t) clearTimeout(t);
      t = stop || !visible() ? null : setTimeout(tick, wait);
    };
    function tick() {
      t = null;
      if (stop || !visible()) return;
      void api.listLiveCalls().then(
        (r) => { if (stop) return; fails = 0; wait = livePollMs; setLiveCalls(r.calls); schedule(); },
        (err) => {
          // No calls.monitor: the Live section stays hidden for good.
          // Anything else is a blip: the last list stays, and the next try comes soon.
          if (err instanceof ApiError && err.status === 403) { stop = true; setLiveCalls(null); }
          fails += 1;
          wait = Math.min(LIVE_POLL_MAX_MS, LIVE_POLL_MS * 2 ** (fails - 1));
          schedule();
        },
      );
    }
    const onVisibility = () => { if (visible()) { wait = livePollMs; tick(); } else if (t) { clearTimeout(t); t = null; } };
    document.addEventListener('visibilitychange', onVisibility);
    tick();
    return () => {
      stop = true;
      if (t) clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [canPollLive, livePollMs]);
  const acceptRing = V.incoming?.accept;
  useEffect(() => {
    if (!sp.incoming || !acceptRing || Date.now() - monitorRingAt.current > 45_000) return;
    // Any other call ringing in that window is a real caller, and answering
    // it silently would put a supervisor on the line with a customer. A ring
    // that cannot be told apart (no call id) is left for a click.
    if (!monitorCallId.current || sp.incoming.talkrCallId !== monitorCallId.current) return;
    monitorRingAt.current = 0;
    monitorCallId.current = null;
    acceptRing();
  }, [sp.incoming, acceptRing]);
  // The monitored call ended (or the leg dropped): no wrap-up for a call that was never ours.
  const dismissWrap = V.dismissWrap;
  useEffect(() => {
    if (monitor && callState === 'wrapup') {
      setMonitor(null);
      dismissWrap();
    }
  }, [monitor, callState, dismissWrap]);
  const monitorControl = async (fn: () => Promise<unknown>) => {
    setControlError(null);
    setControlErrorCode(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setControlError(err instanceof Error ? err.message : 'monitor failed');
      setControlErrorCode(err instanceof ApiError ? err.code : null);
      return false;
    }
  };

  const deviceState: DeviceState = !live
    ? 'ready'
    : sp.deviceState === 'ready' ? 'ready'
      : sp.deviceState === 'connecting' ? 'initializing'
        : sp.deviceState === 'error' ? 'error'
          : 'uninitialized';

  const value: SoftphoneValue = {
    deviceState,
    deviceError: live ? sp.deviceError : null,
    deviceAction: live ? sp.deviceAction : null,
    callState,
    active,
    // The demo's staged ring (/demo?ring=1) has no carrier leg behind it.
    incoming: !V.incoming
      ? null
      : sp.incoming
        ? { from: sp.incoming.from, talkrCallId: sp.incoming.talkrCallId }
        : !live
          ? { from: V.incoming.e164, talkrCallId: null }
          : null,
    serverStatus: null,
    authed,
    initDevice: async (opts) => {
      // The dialer's Enable / Retry / Call buttons are presses. The default
      // takes the lock. Call passes claim: false when another tab already
      // holds it, so the row can offer Use phone here instead of stealing
      // under a live call.
      await sp.initDevice({ claim: opts?.claim ?? true });
    },
    phoneInOtherTab: () => live && sp.phoneInOtherTab(),
    placeCall: async (input) => {
      if (input.to_number) V.dialE164(input.to_number);
    },
    acceptIncoming: () => V.incoming?.accept(),
    rejectIncoming: () => V.incoming?.decline(),
    hangup: V.endCall,
    toggleMute: V.toggleMute,
    sendDigit: (d) => V.dtmf.find((k) => k.k === d)?.go(),
    participants,
    onHold,
    merged,
    controlError,
    controlErrorCode,
    toggleHold: async () => (live ? control((id) => api.setHold(id, !onHold)) : V.toggleHold()),
    addParticipant: (input) => control((id) => api.addParticipant(id, input)),
    merge: () => control((id) => api.mergeCall(id)),
    dropParticipant: (pid) => control((id) => api.removeParticipant(id, pid)),
    transfer: (input) => control((id) => api.transferCall(id, input)),
    completeTransfer: () => control((id) => api.completeTransfer(id)),
    inputDevices,
    outputDevices,
    audioDevices: outputDevices,
    activeInputDeviceId: audioPrefs.inputDeviceId,
    activeOutputDeviceId,
    activeAudioDeviceId: activeOutputDeviceId,
    selectAudioDevice: async (deviceId) => {
      // Saved, so the next call and Settings → Talkr → Audio agree; lib/softphone.ts applies it.
      setAudioPrefs({ outputDeviceId: deviceId });
      await audio?.speakerDevices.set(deviceId).catch(() => undefined);
      setDeviceTick((n) => n + 1);
    },
    selectInputDevice: async (deviceId) => {
      // Saved for the next call. Opening the device while idle is what leaves
      // the mic light on after Always-allow, so only a live call takes it.
      setAudioPrefs({ inputDeviceId: deviceId });
      if (V.callState === 'idle') await audio?.unsetInputDevice().catch(() => undefined);
      else await audio?.setInputDevice(deviceId).catch(() => undefined);
      setDeviceTick((n) => n + 1);
    },
    speakerOn,
    toggleSpeaker,
    dropVoicemail: (url) => sp.dropVoicemail(url),
    record: V.callState === 'idle' ? null : V.callRecord,
    team,
    me,
    // The caller ID picker saved the rep's profile itself; the phone takes it
    // as is instead of reading who they are again (seven requests).
    setMe: (next) => setPhoneMe(next as unknown as Parameters<typeof setPhoneMe>[0]),
    recent,
    notes,
    setNotes,
    liveCalls,
    monitor,
    startMonitor: async (call, mode) => {
      if (!authed || V.callState !== 'idle') return;
      // The monitor leg rings this browser, so the softphone has to be up.
      V.enableSoftphone();
      monitorRingAt.current = Date.now();
      monitorCallId.current = call.call_id;
      if (await monitorControl(() => api.startMonitor(call.call_id, mode))) setMonitor({ call, mode });
      else {
        monitorRingAt.current = 0;
        monitorCallId.current = null;
      }
    },
    switchMonitor: async (mode) => {
      if (!monitor) return;
      if (await monitorControl(() => api.setMonitorMode(monitor.call.call_id, mode))) setMonitor({ ...monitor, mode });
    },
    openTalkrSettings: (tab) => {
      // On a phone the full-screen phone would cover Settings: tuck it away
      // first (a call carries on behind its pill).
      if (V.isMobile) V.minimisePhone();
      requestSettingsTab({ main: 'talkr', tab });
      V.goSettings();
    },
    leaveMonitor: async () => {
      if (!monitor) return;
      monitorRingAt.current = 0;
      monitorCallId.current = null;
      await monitorControl(() => api.stopMonitor(monitor.call.call_id));
      if (callState === 'idle') setMonitor(null);
      else V.endCall();
    },
  };

  return <SoftphoneContext.Provider value={value}>{children}</SoftphoneContext.Provider>;
}
