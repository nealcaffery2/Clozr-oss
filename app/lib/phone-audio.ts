// Phone audio: the ringtone (built-in or custom MP3/URL), notification sounds,
// and which mic and speaker the softphone uses — one per-user preference blob
// and the Web Audio / HTMLAudio that plays it.
//
// Talkr keeps these per browser (its lib/sounds.ts and the audio-device keys
// in lib/softphone.tsx). CLOZR keys the blob by the signed-in user so two reps
// sharing a machine keep their own choices, and mirrors it to
// profiles.phone_audio (migration 391) so the choices and the uploaded files
// follow the rep to the next browser. Which mic, speaker and ring device stay
// per browser: "which headset" is a fact about the desk, not the account.
//
// Built-in tones are synthesized — oscillator sequences, no audio files, nothing
// copyrighted, nothing to 404 mid-call. A custom HTTPS or uploaded data URL
// loops via HTMLAudioElement for both incoming ring and outbound ringback.
// The AudioContext is created on the first user gesture (installAudioUnlock)
// or first play, never at import, so SSR and the browser's autoplay rule are
// both respected. Nothing here throws: a browser that refuses audio stays
// silent and the call carries on.
'use client';

import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import type { Json } from './database.types';

// ── Catalogue ────────────────────────────────────────────────────────────────

type Note = { freq: number; at: number; dur: number; peak: number; type?: OscillatorType };

import { notificationPermission, requestNotificationPermission, showDesktopNotification } from './desktop-notify';

export const RINGTONES = {
  classic: { label: 'Classic', period: 5, notes: [
    { freq: 440, at: 0, dur: 1.8, peak: 0.07 }, { freq: 480, at: 0, dur: 1.8, peak: 0.07 },
  ] },
  trill: { label: 'Double trill', period: 3, notes: [
    { freq: 400, at: 0, dur: 0.4, peak: 0.07 }, { freq: 450, at: 0, dur: 0.4, peak: 0.07 },
    { freq: 400, at: 0.6, dur: 0.4, peak: 0.07 }, { freq: 450, at: 0.6, dur: 0.4, peak: 0.07 },
  ] },
  marimba: { label: 'Marimba', period: 2.4, notes: [
    { freq: 523.25, at: 0, dur: 0.22, peak: 0.12, type: 'triangle' }, { freq: 659.25, at: 0.18, dur: 0.22, peak: 0.12, type: 'triangle' },
    { freq: 783.99, at: 0.36, dur: 0.22, peak: 0.12, type: 'triangle' }, { freq: 659.25, at: 0.54, dur: 0.3, peak: 0.12, type: 'triangle' },
  ] },
  pulse: { label: 'Pulse', period: 2, notes: [0, 0.16, 0.32, 0.48].map((at) => ({ freq: 880, at, dur: 0.1, peak: 0.09 })) },
  digital: { label: 'Digital', period: 2.5, notes: Array.from({ length: 8 }, (_, i) => ({ freq: i % 2 ? 1000 : 1200, at: i * 0.07, dur: 0.06, peak: 0.035, type: 'square' as const })) },
  soft: { label: 'Soft bell', period: 3, notes: [
    { freq: 523.25, at: 0, dur: 0.9, peak: 0.09 }, { freq: 659.25, at: 0.45, dur: 1.1, peak: 0.09 },
  ] },
} satisfies Record<string, { label: string; period: number; notes: Note[] }>;
export type RingtoneId = keyof typeof RINGTONES;

export const TONES = {
  blip: { label: 'Blip', notes: [{ freq: 987.77, at: 0, dur: 0.11, peak: 0.06 }] },
  chime: { label: 'Chime', notes: [{ freq: 587.33, at: 0, dur: 0.1, peak: 0.07 }, { freq: 880, at: 0.09, dur: 0.13, peak: 0.08 }] },
  fall: { label: 'Fall', notes: [{ freq: 440, at: 0, dur: 0.1, peak: 0.05 }, { freq: 293.66, at: 0.09, dur: 0.16, peak: 0.06 }] },
  ding: { label: 'Ding', notes: [{ freq: 1318.5, at: 0, dur: 0.4, peak: 0.07, type: 'triangle' }] },
  triad: { label: 'Triad', notes: [523.25, 659.25, 783.99, 1046.5].map((freq, i) => ({ freq, at: i * 0.075, dur: i === 3 ? 0.16 : 0.09, peak: 0.07, type: 'triangle' as const })) },
  pop: { label: 'Pop', notes: [{ freq: 660, at: 0, dur: 0.05, peak: 0.08 }, { freq: 990, at: 0.05, dur: 0.07, peak: 0.07 }] },
  knock: { label: 'Knock', notes: [{ freq: 220, at: 0, dur: 0.09, peak: 0.12, type: 'triangle' }, { freq: 220, at: 0.16, dur: 0.09, peak: 0.12, type: 'triangle' }] },
  // Two rising triads a beat apart: long enough to hear across the room, unlike any other alert.
  request: { label: 'Request', notes: [0, 0.62].flatMap((t) => [659.25, 880, 1174.66].map((freq, i) => ({ freq, at: t + i * 0.11, dur: i === 2 ? 0.34 : 0.12, peak: 0.08, type: 'triangle' as const }))) },
} satisfies Record<string, { label: string; notes: Note[] }>;
export type ToneId = keyof typeof TONES;

export const NOTIFY_EVENTS = {
  sms: { label: 'New text message', hint: 'An inbound text lands in Talkr', tone: 'blip' },
  missed: { label: 'Missed call', hint: 'A call rang this browser and was not answered', tone: 'knock' },
  voicemail: { label: 'Voicemail', hint: 'Someone left you a voicemail', tone: 'ding' },
  task: { label: 'Task due', hint: 'A task assigned to you comes due', tone: 'chime' },
  mention: { label: '@mention', hint: 'A teammate mentions you in a note', tone: 'pop' },
  connected: { label: 'Call connected', hint: 'The other side picks up', tone: 'chime' },
  ended: { label: 'Call ended', hint: 'The call hangs up', tone: 'fall' },
  appointment: { label: 'Appointment set', hint: 'A wrap-up books an appointment', tone: 'triad' },
  lead: { label: 'New lead', hint: 'A new seller lands in CLOZR (call within 60 seconds)', tone: 'triad' },
  contract: { label: 'Contract request', hint: 'Acquisitions asks the TC for a contract from a call', tone: 'request' },
} satisfies Record<string, { label: string; hint: string; tone: ToneId }>;
export type NotifyEvent = keyof typeof NOTIFY_EVENTS;

// ── Preferences ──────────────────────────────────────────────────────────────

export type PhoneAudioPrefs = {
  ringtone: RingtoneId;
  /**
   * True once the rep picks an incoming tone. Absent on older blobs, whose
   * stored "classic" was the ringback tone and should not ring for a call
   * coming in.
   */
  incomingRingChosen?: boolean;
  /**
   * Optional custom MP3/audio (HTTPS URL or data:audio…). When set, incoming
   * and outgoing ring use this instead of the built-in synthesizer tone.
   */
  customRingtoneUrl: string | null;
  /** 0–1 */
  ringVolume: number;
  /** Off: incoming calls show the card but make no sound here. */
  ringOnDevice: boolean;
  /** Outbound dialing/ringing plays ringback in this browser. */
  outgoingRingback: boolean;
  /**
 * Outbound ringback's own built-in tone. Null plays ringback (classic),
 * never the incoming ringtone.
   */
  outgoingRingtone: RingtoneId | null;
  /** Outbound ringback's own audio: the hold/wait music. Beats outgoingRingtone. */
  outgoingCustomRingtoneUrl: string | null;
  /** Where the ringtone plays (null = system default). */
  ringDeviceId: string | null;
  notifyVolume: number;
  /** Set once the connected/ended chimes were switched off for everyone (they leaked into calls). */
  callTonesOff?: boolean;
  /**
   * Also raise a desktop notification for each enabled event (lib/desktop-notify.ts).
   * Off until a rep turns it on in Settings: the browser's permission prompt has
   * to come from a gesture, and a denial cannot be asked again.
   */
  desktopNotifications: boolean;
  /** `customUrl`: an uploaded MP3 (data URL) or HTTPS link that plays instead of the built-in tone. */
  events: Record<NotifyEvent, { on: boolean; tone: ToneId; customUrl?: string | null }>;
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

export const DEFAULT_AUDIO_PREFS: PhoneAudioPrefs = {
  ringtone: 'marimba',
  customRingtoneUrl: null,
  ringVolume: 0.8,
  ringOnDevice: true,
  outgoingRingback: true,
  outgoingRingtone: null,
  outgoingCustomRingtoneUrl: null,
  ringDeviceId: null,
  notifyVolume: 0.8,
  desktopNotifications: false,
  events: Object.fromEntries(Object.entries(NOTIFY_EVENTS).map(([k, v]) => [k, { on: k !== 'connected' && k !== 'ended', tone: v.tone }])) as PhoneAudioPrefs['events'],
  callTonesOff: true,
  inputDeviceId: null,
  outputDeviceId: null,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Max size for an uploaded sound: ringtone, wait music or an alert. Uploads
 * live in the phone-audio bucket (and a copy in IndexedDB), with only an
 * `sb:` or `idb:` reference in the prefs: 10 MB is ~13.7 MB as a data URL,
 * well past localStorage's ~5 MB per site. The bucket's file_size_limit is
 * the same number.
 */
export const MAX_CUSTOM_AUDIO_BYTES = 10 * 1024 * 1024;
/** What still fits as a data URL in localStorage, for a browser with no IndexedDB. */
const MAX_DATA_URL_AUDIO_BYTES = 2 * 1024 * 1024;

const KEY = 'clozr.phoneAudio.v1';
/** Fired when a ring falls back to the built-in tone because the chosen file would not play. `detail` says why. */
export const RING_FALLBACK_EVENT = 'clozr-ring-fallback';
function ringFellBack(why: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(RING_FALLBACK_EVENT, { detail: why }));
}
let user = 'anon';
let snapshot = DEFAULT_AUDIO_PREFS;
let snapshotRaw: string | null | undefined;
const listeners = new Set<() => void>();

/** Which user's blob to read; the shell sets it from the session. */
export function setAudioUser(id: string | null): void {
  const next = id || 'anon';
  if (next === user) return;
  user = next;
  snapshotRaw = undefined;
  listeners.forEach((l) => l());
  void loadUploadedSounds();
  void pullCloudPrefs(next);
}

// ── The account's copy (profiles.phone_audio) ────────────────────────────────

/** profiles.phone_audio: a PhoneAudioPrefs with anything missing. */
export type CloudAudioPrefs = Partial<Omit<PhoneAudioPrefs, 'events'>> & { events?: Partial<PhoneAudioPrefs['events']> };

/** Mic, speaker and ring device: facts about the desk, never in the row. */
const DESK_KEYS = new Set<string>(['inputDeviceId', 'outputDeviceId', 'ringDeviceId']);

/** What the row holds: everything but the desk's devices. A data: URL (a file this browser could keep nowhere else) stays out too. */
export function cloudAudioPrefs(p: PhoneAudioPrefs): CloudAudioPrefs {
  const noData = (v: unknown) => !(typeof v === 'string' && v.startsWith('data:'));
  const out = Object.fromEntries(Object.entries(p).filter(([k, v]) => !DESK_KEYS.has(k) && noData(v))) as CloudAudioPrefs;
  out.events = Object.fromEntries(Object.entries(p.events).map(([k, e]) => [k, noData(e.customUrl) ? e : { on: e.on, tone: e.tone }]));
  return out;
}

/** Sign-in: the account's choices win, except which mic, speaker and ring device, which stay this browser's. */
export function mergeAudioPrefs(local: PhoneAudioPrefs, cloud: CloudAudioPrefs | null | undefined): PhoneAudioPrefs {
  if (!cloud) return local;
  const events = { ...local.events };
  for (const [k, e] of Object.entries(cloud.events ?? {})) events[k as NotifyEvent] = { ...local.events[k as NotifyEvent], ...e };
  return {
    ...local, ...cloud, events,
    inputDeviceId: local.inputDeviceId, outputDeviceId: local.outputDeviceId, ringDeviceId: local.ringDeviceId,
  };
}

async function pullCloudPrefs(id: string): Promise<void> {
  const db = supabase;
  if (!db || id === 'anon') return;
  const { data } = await db.from('profiles').select('phone_audio').eq('id', id).maybeSingle();
  if (user !== id) return;
  const cloud = data?.phone_audio as CloudAudioPrefs | null | undefined;
  if (!cloud) {
    // Nothing in the row yet: what this browser has chosen becomes the account's.
    pushCloudPrefs(getAudioPrefs());
    return;
  }
  const merged = mergeAudioPrefs(getAudioPrefs(), cloud);
  try {
    localStorage.setItem(`${KEY}:${user}`, JSON.stringify(merged));
    snapshotRaw = undefined;
  } catch {
    snapshot = merged;
  }
  listeners.forEach((l) => l());
  void loadUploadedSounds();
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced: a volume slider writes many times a second. */
function pushCloudPrefs(p: PhoneAudioPrefs): void {
  const db = supabase;
  if (!db || user === 'anon') return;
  const id = user;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void db.from('profiles').update({ phone_audio: cloudAudioPrefs(p) as unknown as Json }).eq('id', id)
      .then(({ error }) => { if (error) console.warn('phone audio prefs', error.message); });
  }, 1000);
}

// ── Uploaded sounds (phone-audio bucket, IndexedDB copy) ─────────────────────

const IDB_PREFIX = 'idb:';
/** `sb:<user id>/<slot>#<saved at>`: a file in the private phone-audio bucket, which follows the rep across browsers. */
const SB_PREFIX = 'sb:';
const SB_BUCKET = 'phone-audio';
const SIGNED_URL_SECONDS = 3600;
/** idb:/sb: reference → object URL (or, until the file is down, a signed URL), so a ring can start synchronously. */
const blobUrls = new Map<string, string>();

/** An uploaded file rather than a link the rep pasted. */
export const isUploadedSound = (url: string | null | undefined): boolean =>
  !!url && (url.startsWith(IDB_PREFIX) || url.startsWith(SB_PREFIX) || url.startsWith('data:'));
/** A reference that has to be loaded before <audio> can take it. */
const isStoredRef = (url: string): boolean => url.startsWith(IDB_PREFIX) || url.startsWith(SB_PREFIX);

function soundStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('clozr.phoneAudio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result.transaction('files', mode).objectStore('files'));
    req.onerror = () => reject(req.error);
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * The key inside the store: `idb:<user>:<slot>#<saved at>` → `<user>:<slot>`.
 * An sb: reference is its own key, so a file re-uploaded on another browser
 * (a new `#<saved at>`) never plays this browser's stale copy.
 */
const idbKey = (ref: string) => (ref.startsWith(SB_PREFIX) ? ref : ref.slice(IDB_PREFIX.length).split('#')[0]);
const sbPath = (ref: string) => ref.slice(SB_PREFIX.length).split('#')[0];

/** Read every uploaded sound in the prefs into memory. Called on sign-in, and lazily on a miss. */
export async function loadUploadedSounds(p: PhoneAudioPrefs = getAudioPrefs()): Promise<void> {
  const refs = [p.customRingtoneUrl, p.outgoingCustomRingtoneUrl, ...Object.values(p.events).map((e) => e.customUrl)]
    .filter((u): u is string => !!u && isStoredRef(u) && !blobUrls.has(u));
  if (!refs.length) return;
  await Promise.all(refs.map(async (ref) => {
    try {
      if (typeof indexedDB !== 'undefined') {
        const blob = await done((await soundStore('readonly')).get(idbKey(ref)) as IDBRequest<Blob | undefined>);
        if (blob) {
          blobUrls.set(ref, URL.createObjectURL(blob));
          return;
        }
      }
    } catch {
      /* gone or blocked: the bucket copy below, or the built-in tone */
    }
    if (ref.startsWith(SB_PREFIX)) await fetchStoredSound(ref);
  }));
}

/**
 * The bucket copy of an sb: reference. A signed URL plays it right away; the
 * file itself is then pulled down and kept in IndexedDB, so the next ring is
 * an object URL and a desk that goes offline still has its music.
 */
async function fetchStoredSound(ref: string): Promise<void> {
  if (!supabase) return;
  const { data } = await supabase.storage.from(SB_BUCKET).createSignedUrl(sbPath(ref), SIGNED_URL_SECONDS);
  const signed = data?.signedUrl;
  if (!signed) return;
  blobUrls.set(ref, signed);
  setTimeout(() => { if (blobUrls.get(ref) === signed) blobUrls.delete(ref); }, (SIGNED_URL_SECONDS - 300) * 1000);
  try {
    const blob = await (await fetch(signed)).blob();
    blobUrls.set(ref, URL.createObjectURL(blob));
    await done((await soundStore('readwrite')).put(blob, idbKey(ref)));
  } catch {
    /* no IndexedDB, or the download failed: the signed URL plays for the hour */
  }
}

/** What to hand an <audio> element: an uploaded file's object URL, or the link itself. Null while not loaded yet. */
function playable(url: string): string | null {
  if (!isStoredRef(url)) return url;
  const hit = blobUrls.get(url);
  if (!hit) void loadUploadedSounds();
  return hit ?? null;
}

/** Keep an uploaded file and return the reference the prefs store for it. */
async function storeAudioFile(file: File, slot: string): Promise<string> {
  if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|wav|ogg|aac)$/i.test(file.name)) throw new Error('File must be an audio file (MP3, WAV, OGG, …).');
  if (file.size > MAX_CUSTOM_AUDIO_BYTES) throw new Error('File too large (max 10 MB). Host it and paste an HTTPS link instead.');
  // The bucket first, so the file follows the rep; this browser keeps a copy too.
  if (supabase && user !== 'anon') {
    const path = `${user}/${slot.replace(':', '-')}`;
    const up = await supabase.storage.from(SB_BUCKET).upload(path, file, { upsert: true, contentType: file.type || 'audio/mpeg' });
    if (!up.error) {
      const ref = `${SB_PREFIX}${path}#${Date.now()}`;
      blobUrls.set(ref, URL.createObjectURL(file));
      try {
        await done((await soundStore('readwrite')).put(file, idbKey(ref)));
      } catch {
        /* the bucket has it */
      }
      return ref;
    }
    console.warn('phone audio upload', up.error.message);
  }
  const key = `${user}:${slot}`;
  try {
    await done((await soundStore('readwrite')).put(file, key));
  } catch {
    if (file.size > MAX_DATA_URL_AUDIO_BYTES) throw new Error('This browser cannot keep a file over 2 MB. Host it and paste an HTTPS link instead.');
    return readAudioFile(file);
  }
  const ref = `${IDB_PREFIX}${key}#${Date.now()}`;
  blobUrls.set(ref, URL.createObjectURL(file));
  return ref;
}

export function getAudioPrefs(): PhoneAudioPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(`${KEY}:${user}`);
  } catch {
    return snapshot;
  }
  if (raw === snapshotRaw) return snapshot;
  snapshotRaw = raw;
  try {
    const saved = raw ? (JSON.parse(raw) as Partial<PhoneAudioPrefs>) : {};
    const ringtone = saved.ringtone && saved.ringtone in RINGTONES ? saved.ringtone : DEFAULT_AUDIO_PREFS.ringtone;
    snapshot = {
      ...DEFAULT_AUDIO_PREFS,
      ...saved,
      ringtone,
      customRingtoneUrl: saved.customRingtoneUrl?.trim() || null,
      events: { ...DEFAULT_AUDIO_PREFS.events, ...saved.events },
    };
    // The connected and ended chimes played on the speaker with the mic open,
    // and the other side heard a beep. Off once for everyone; a rep can turn
    // them back on in Settings.
    if (!saved.callTonesOff) {
      snapshot = {
        ...snapshot, callTonesOff: true,
        events: { ...snapshot.events, connected: { ...snapshot.events.connected, on: false }, ended: { ...snapshot.events.ended, on: false } },
      };
    }
  } catch {
    snapshot = DEFAULT_AUDIO_PREFS;
  }
  return snapshot;
}

export function setAudioPrefs(patch: Partial<PhoneAudioPrefs>): void {
  const chose = patch.ringtone !== undefined || patch.customRingtoneUrl !== undefined;
  const next = { ...getAudioPrefs(), ...patch, ...(chose ? { incomingRingChosen: true } : {}) };
  snapshot = next;
  try {
    snapshotRaw = JSON.stringify(next);
    localStorage.setItem(`${KEY}:${user}`, snapshotRaw);
  } catch {
    /* private mode: applies for this page only */
  }
  pushCloudPrefs(next);
  listeners.forEach((l) => l());
}

export function subscribeAudioPrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export function useAudioPrefs(): PhoneAudioPrefs {
  return useSyncExternalStore(subscribeAudioPrefs, getAudioPrefs, () => DEFAULT_AUDIO_PREFS);
}

/** getUserMedia audio constraints for the chosen mic. `ideal`, so an unplugged headset falls back instead of failing the call. */
export function micConstraints(p: PhoneAudioPrefs = getAudioPrefs()): MediaTrackConstraints {
  return {
    ...(p.inputDeviceId && p.inputDeviceId !== 'default' ? { deviceId: { ideal: p.inputDeviceId } } : {}),
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
  };
}

/** Why the last openMic failed, so the toast can say how to fix it instead of "blocked or unavailable". */
let lastMicError: { name: string; message: string } | null = null;

/**
 * getUserMedia that resolves null on failure and remembers why. Call it
 * inside the tap: that is what makes the browser show its Allow prompt.
 * A site the rep already blocked never prompts again (no API can re-ask),
 * so micFailureText says where to flip it back.
 */
export function openMic(audio: MediaTrackConstraints | boolean = micConstraints()): Promise<MediaStream | null> {
  lastMicError = null;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    lastMicError = { name: 'Unsupported', message: '' };
    return Promise.resolve(null);
  }
  return navigator.mediaDevices.getUserMedia({ audio }).catch((err: unknown) => {
    lastMicError = { name: (err as Error)?.name ?? 'Error', message: (err as Error)?.message ?? '' };
    return null;
  });
}

/** What to tell the rep after openMic resolved null. */
export async function micFailureText(): Promise<string> {
  const e = lastMicError;
  const ios = isIOSDevice();
  const siteFix = ios
    ? 'On iPhone: tap aA in the address bar > Website Settings > Microphone > Allow (or Settings > Safari > Microphone), then call again.'
    : 'Click the icon at the left of the address bar, set Microphone to Allow, reload, then call again.';
  if (!e) return 'The microphone did not start. Call again.';
  if (e.name === 'Unsupported') return 'This browser cannot use a microphone here. Open Clozr in Chrome or Safari over https.';
  if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
    return 'No microphone found. Plug one in (or pick another under phone audio settings) and call again.';
  }
  if (e.name === 'NotReadableError' || e.name === 'AbortError') {
    return ios
      ? 'The microphone is busy. End any other call or recording app and call again.'
      : 'The microphone is busy or your computer is blocking it. Close other apps using it (Zoom, Teams), and check Windows Settings > Privacy & security > Microphone is on for your browser.';
  }
  // NotAllowedError: blocked by the OS, blocked for this site, or the prompt was dismissed.
  if (/system/i.test(e.message)) {
    return 'Your computer is blocking the browser from the microphone. Windows: Settings > Privacy & security > Microphone, turn on for your browser. Mac: System Settings > Privacy & Security > Microphone.';
  }
  let state: string | null = null;
  try {
    state = (await navigator.permissions?.query({ name: 'microphone' as PermissionName }))?.state ?? null;
  } catch { /* Safari/Firefox may not support the query */ }
  if (state === 'prompt') {
    return 'Microphone not allowed. Call again and choose Allow. No prompt showing? ' + siteFix;
  }
  return 'Microphone is blocked for this site, so the browser will not ask again. ' + siteFix;
}

// ── Web Audio ────────────────────────────────────────────────────────────────

let ctx: AudioContext | null = null;

/** True once the user has clicked or typed on this page (always true where the API is missing). */
const userHasActed = (): boolean => (typeof navigator !== 'undefined' && navigator.userActivation ? navigator.userActivation.hasBeenActive : true);

/**
 * `fromGesture` is the unlock handler itself, which runs inside the gesture.
 * Every other caller (a notification tone at page load, say) must not build a
 * context before the user has acted: Chrome logs "AudioContext was not allowed
 * to start" and the tone is silent anyway.
 */
function audioContext(fromGesture = false): AudioContext | null {
  if (ctx) return ctx.state === 'closed' ? null : ctx;
  if (typeof window === 'undefined') return null;
  if (!fromGesture && !userHasActed()) return null;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    ctx = Ctor ? new Ctor() : null;
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Browsers start audio suspended until a gesture; resume it on the first one so a ring that arrives later is heard. */
export function installAudioUnlock(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const unlock = () => {
    const c = audioContext(true);
    if (c?.state === 'suspended') void c.resume().catch(() => undefined);
    if (c?.state === 'running') remove();
  };
  const remove = () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  return remove;
}

export const outputSelectionSupported = (): boolean =>
  typeof window !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/**
 * iPhone or iPad, whatever the browser (they are all WebKit there). A phone
 * call starts in the earpiece (lib/call-route.ts); Speaker on the call screen
 * moves it to the loudspeaker. Headphones and Bluetooth still take over when
 * they are connected.
 */
export const isIOSDevice = (): boolean =>
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1));

/** A phone-sized touch screen. iOS, and Android at a phone width. */
export function isTouchPhone(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (isIOSDevice()) return true;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches && window.matchMedia('(max-width: 900px)').matches;
}

/**
 * Local ringback stacked on the carrier's early media is the skipping noise
 * on a phone. The carrier track is the same wait music the desk already
 * plays. A rep who picked their own MP3 keeps that instead.
 */
export function yieldLocalRingToCarrier(opts: { touch: boolean; remoteAudio: boolean; customWaitMusic: boolean }): boolean {
  return opts.touch && opts.remoteAudio && !opts.customWaitMusic;
}

/**
 * Hangup while the call is still ringing. Telnyx reports these as failures
 * ("Failed to hang up cleanly", "Call was closed during setup") even though
 * the rep just ended the call. They are not a device error.
 */
export function isBenignHangupError(message: string): boolean {
  return /failed to hang up|hang up cleanly|closed during setup|hang ?up early/i.test(message);
}

/** Short silent WAV so a tap can unlock an <audio> element before media arrives. */
export const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

let remoteCallEl: HTMLAudioElement | null = null;

/** The element the carrier attaches early media (wait music) and the far end to. */
export function remoteCallElement(): HTMLAudioElement | null {
  return remoteCallEl;
}

export function adoptRemoteCallElement(el: HTMLAudioElement): HTMLAudioElement {
  if (!remoteCallEl) remoteCallEl = el;
  return remoteCallEl;
}

/**
 * Call from the dial or answer tap. iOS will not play carrier wait music on
 * an element that has never played inside a gesture, and `display:none`
 * makes that audio skip. One element, unlocked here, is reused for the call.
 */
export function primeRemoteCallAudio(): void {
  if (typeof document === 'undefined') return;
  const c = audioContext();
  if (c?.state === 'suspended') void c.resume().catch(() => undefined);
  if (!remoteCallEl) {
    const el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', 'true');
    el.setAttribute('webkit-playsinline', 'true');
    el.setAttribute('data-talkr-softphone', 'telnyx');
    el.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;bottom:0';
    document.body.appendChild(el);
    remoteCallEl = el;
  }
  const el = remoteCallEl;
  // The one element outlives the engines that play on it; put it back if something took it out of the page.
  if (!el.isConnected) document.body.appendChild(el);
  el.muted = false;
  if (!el.srcObject && !el.getAttribute('src')) el.src = SILENT_WAV;
  void el.play().catch(() => undefined);
}

let carrierHeardFlag = true;

/**
 * Mute the carrier (its early media is a second ringback) while this browser
 * plays its own ringback, until the other side answers. The engine's playback
 * watchdog reads carrierHeard() so it does not unmute what this muted.
 */
export function setCarrierHeard(heard: boolean): void {
  carrierHeardFlag = heard;
  if (remoteCallEl) remoteCallEl.muted = !heard;
}

export const carrierHeard = (): boolean => carrierHeardFlag;

export function remoteHasLiveAudio(stream: { getAudioTracks(): { readyState: string }[] } | null | undefined): boolean {
  if (!stream) return false;
  return stream.getAudioTracks().some((t) => t.readyState === 'live');
}

/** The element is kept with its node: an unreferenced <audio> can be collected mid-ring, and the tone goes quiet or to the default speaker. */
const sinks = new Map<string, { dest: AudioNode; el: HTMLAudioElement }>();

/** The node to connect to for a device: the context itself, or a sink-routed media element (Chrome/Edge; Safari has no setSinkId). */
function outputFor(c: AudioContext, deviceId: string | null): AudioNode {
  if (!deviceId || deviceId === 'default' || !outputSelectionSupported()) return c.destination;
  const hit = sinks.get(deviceId);
  if (hit) {
    if (hit.el.paused) void hit.el.play().catch(() => undefined);
    return hit.dest;
  }
  const dest = c.createMediaStreamDestination();
  const el = new Audio();
  el.srcObject = dest.stream;
  void (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId).catch(() => undefined);
  void el.play().catch(() => undefined);
  sinks.set(deviceId, { dest, el });
  return dest;
}

function schedule(c: AudioContext, into: AudioNode, notes: Note[], start: number): void {
  for (const n of notes) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const t = start + n.at;
    osc.type = n.type ?? 'sine';
    osc.frequency.setValueAtTime(n.freq, t);
    // A hard edge on a sine is a click: short attack, exponential tail.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(n.peak, t + Math.min(0.012, n.dur / 3));
    if (n.dur > 0.5) gain.gain.setValueAtTime(n.peak, t + n.dur - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(gain).connect(into);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }
}

/** One volume-scaled bus into a device; `peak` values are tuned for volume 1 ≈ gain 2.5. */
function bus(c: AudioContext, volume: number, deviceId: string | null): GainNode {
  const g = c.createGain();
  g.gain.value = Math.max(0, Math.min(1, volume)) * 2.5;
  g.connect(outputFor(c, deviceId));
  return g;
}

function play(notes: Note[], volume: number, deviceId: string | null): void {
  try {
    const c = audioContext();
    if (!c) return;
    if (c.state === 'suspended') void c.resume().catch(() => undefined);
    const g = bus(c, volume, deviceId);
    schedule(c, g, notes, c.currentTime + 0.02);
    setTimeout(() => g.disconnect(), (Math.max(...notes.map((n) => n.at + n.dur)) + 0.5) * 1000);
  } catch {
    /* silent */
  }
}

/** Preview a tone at the chosen notification volume. */
export function previewTone(tone: ToneId, volume = getAudioPrefs().notifyVolume, deviceId: string | null = null): void {
  play(TONES[tone].notes, volume, deviceId);
}

let previewCustom: HTMLAudioElement | null = null;

function stopCustomPreview(): void {
  if (!previewCustom) return;
  previewCustom.pause();
  previewCustom = null;
}

/** Play a custom URL once (or briefly loop) for the preview button. */
function previewCustomUrl(url: string, volume: number, deviceId: string | null): void {
  stopCustomPreview();
  const src = playable(url);
  if (!src) return;
  try {
    const el = new Audio(src);
    el.volume = Math.max(0, Math.min(1, volume));
    if (deviceId && deviceId !== 'default' && outputSelectionSupported()) {
      void (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId).catch(() => undefined);
    }
    previewCustom = el;
    void el.play().catch(() => undefined);
    window.setTimeout(() => {
      if (previewCustom === el) stopCustomPreview();
    }, 4000);
  } catch {
    /* silent */
  }
}

/** Streaming-site pages: a link to one is a web page, never an audio file. */
const PAGE_LINK = /^https?:\/\/([^/]+\.)?(youtube\.com|youtu\.be|spotify\.com|soundcloud\.com|music\.apple\.com|tiktok\.com)(\/|$)/i;
const PAGE_LINK_PROBLEM = 'That is a web page, not an audio file. Download the MP3 and use Upload MP3 instead.';

/**
 * Why a pasted link will not ring, or null when it plays. Loads it the way a
 * ring would, so a host the CSP blocks, a 404, or a page fails here, in
 * Settings, instead of as a silent call.
 */
export function audioLinkProblem(url: string, timeoutMs = 8000): Promise<string | null> {
  if (PAGE_LINK.test(url)) return Promise.resolve(PAGE_LINK_PROBLEM);
  if (typeof Audio === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const el = new Audio();
    el.preload = 'metadata';
    const finish = (problem: string | null) => {
      clearTimeout(timer);
      el.oncanplay = el.onloadedmetadata = el.onerror = null;
      el.removeAttribute('src');
      el.load();
      resolve(problem);
    };
    const timer = setTimeout(() => finish('That link took too long to load. Upload the MP3 instead.'), timeoutMs);
    el.oncanplay = el.onloadedmetadata = () => finish(null);
    el.onerror = () => finish('That link will not play here (not an audio file, or its host is blocked). Upload the MP3 instead.');
    el.src = url;
  });
}

/** One ring cycle of a ringtone, for the preview button. */
export function previewRingtone(id: RingtoneId, p: PhoneAudioPrefs = getAudioPrefs()): void {
  play(RINGTONES[id]?.notes ?? RINGTONES.classic.notes, p.ringVolume, p.ringDeviceId);
}

/** Preview whatever will actually ring — for inbound, or for dial-out. */
export function previewActiveRingtone(p: PhoneAudioPrefs = getAudioPrefs(), outgoing = false): void {
  const src = ringSource(p, outgoing);
  if (src.url) previewCustomUrl(src.url, p.ringVolume, p.ringDeviceId);
  else play(RINGTONES[src.ringtone]?.notes ?? RINGTONES.classic.notes, p.ringVolume, p.ringDeviceId);
}

function readAudioFile(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

/** Give one notification (a new text, a missed call…) its own MP3, up to 10 MB. Follows the rep, like the ringtone. */
export async function setEventSoundFromFile(event: NotifyEvent, file: File): Promise<void> {
  const ref = await storeAudioFile(file, `event:${event}`);
  const p = getAudioPrefs();
  setAudioPrefs({ events: { ...p.events, [event]: { ...p.events[event], customUrl: ref } } });
}

/** Play what an event will play: its custom sound if it has one, otherwise its tone. */
export function previewEvent(event: NotifyEvent, p: PhoneAudioPrefs = getAudioPrefs()): void {
  const e = p.events[event];
  if (!e) return;
  if (e.customUrl) previewCustomUrl(e.customUrl, p.notifyVolume, p.outputDeviceId);
  else previewTone(e.tone, p.notifyVolume, p.outputDeviceId);
}

/** Use an uploaded audio file (up to 10 MB) as the ringtone or the dial-out wait music. */
export async function setCustomRingtoneFromFile(
  file: File,
  target: 'incoming' | 'outgoing' = 'incoming',
): Promise<void> {
  const ref = await storeAudioFile(file, target === 'outgoing' ? 'ringback' : 'ringtone');
  setAudioPrefs(target === 'outgoing' ? { outgoingCustomRingtoneUrl: ref } : { customRingtoneUrl: ref });
}

/** A 660 Hz test tone on a specific output, for the speaker test. */
export function testOutput(deviceId: string | null): void {
  play([{ freq: 660, at: 0, dur: 0.6, peak: 0.06 }], 1, deviceId);
}

/**
 * Ask the browser for notification permission from the next click, then send
 * them. One ask: a denial sticks, so this does not prompt again.
 */
export function armNotificationAsk(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (notificationPermission() === 'denied') return () => undefined;
  if (notificationPermission() === 'granted' && getAudioPrefs().desktopNotifications) return () => undefined;
  const ask = () => {
    window.removeEventListener('pointerdown', ask, true);
    void requestNotificationPermission().then((next) => {
      if (next === 'granted') setAudioPrefs({ desktopNotifications: true });
    });
  };
  window.addEventListener('pointerdown', ask, true);
  return () => window.removeEventListener('pointerdown', ask, true);
}

type BellMuteChecker = (cat: string) => boolean;
let bellMuteChecker: BellMuteChecker = () => false;
const recentSounds = new Map<string, number>();
const SOUND_DEDUPE_MS = 8_000;

/** Bell panel mutes (useClozr) — blocks sound for that category while active. */
export function setBellMuteChecker(fn: BellMuteChecker): void {
  bellMuteChecker = fn;
}

/** True when a bell category is temporarily muted from the panel. */
export function isBellCategoryMuted(cat: string): boolean {
  return bellMuteChecker(cat);
}

export function playEvent(event: NotifyEvent, detail?: string, dedupeKey?: string): void {
  const p = getAudioPrefs();
  const e = p.events[event];
  if (!e?.on) return;
  if (dedupeKey) {
    const now = Date.now();
    const last = recentSounds.get(dedupeKey);
    if (last != null && now - last < SOUND_DEDUPE_MS) return;
    recentSounds.set(dedupeKey, now);
  }
  if (e.customUrl) playAlertUrl(e.customUrl, p.notifyVolume, p.outputDeviceId, e.tone);
  else previewTone(e.tone, p.notifyVolume, p.outputDeviceId);
  if (p.desktopNotifications) {
    showDesktopNotification({ title: NOTIFY_EVENTS[event].label, body: detail, tag: `clozr:${event}` });
  }
}

/**
 * A custom alert plays once, capped at a few seconds so a long MP3 cannot
 * talk over a call. A file the browser will not play falls back to the tone.
 */
function playAlertUrl(url: string, volume: number, deviceId: string | null, fallback: ToneId): void {
  const src = playable(url);
  if (!src) {
    previewTone(fallback, volume, deviceId);
    return;
  }
  try {
    const el = new Audio(src);
    el.volume = Math.max(0, Math.min(1, volume));
    if (deviceId && deviceId !== 'default' && outputSelectionSupported()) {
      void (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId).catch(() => undefined);
    }
    void el.play().catch(() => previewTone(fallback, volume, deviceId));
    window.setTimeout(() => el.pause(), 6000);
  } catch {
    previewTone(fallback, volume, deviceId);
  }
}

type SynthRing = { kind: 'synth'; timer: ReturnType<typeof setInterval>; gain: GainNode };
type FileRing = { kind: 'file'; el: HTMLAudioElement };
let ring: SynthRing | FileRing | null = null;

/**
 * `onUnplayable` runs when the source itself will not load: a link that is a
 * web page (YouTube), a host the page's CSP blocks, a 404. Without it that
 * ring was silent. An autoplay refusal is not that, and keeps the file.
 */
function startCustomLoop(url: string, volume: number, deviceId: string | null, onUnplayable?: () => void): boolean {
  const src = playable(url);
  if (!src) return false;
  try {
    const el = new Audio(src);
    el.loop = true;
    el.volume = Math.max(0, Math.min(1, volume));
    if (deviceId && deviceId !== 'default' && outputSelectionSupported()) {
      void (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId).catch(() => undefined);
    }
    void el.play().catch((e: unknown) => {
      if ((e as { name?: string })?.name === 'NotAllowedError') return;
      if (ring?.kind !== 'file' || ring.el !== el) return;
      ring = null;
      ringFellBack('the file would not play (a bad link, or a host this page cannot load)');
      onUnplayable?.();
    });
    ring = { kind: 'file', el };
    return true;
  } catch {
    return false;
  }
}

function startSynthLoop(p: PhoneAudioPrefs): boolean {
  try {
    const c = audioContext();
    if (!c) return false;
    if (c.state === 'suspended') void c.resume().catch(() => undefined);
    const tone = RINGTONES[p.ringtone] ?? RINGTONES.classic;
    const gain = bus(c, p.ringVolume, p.ringDeviceId);
    const cycle = () => schedule(c, gain, tone.notes, c.currentTime + 0.02);
    cycle();
    ring = { kind: 'synth', timer: setInterval(cycle, tone.period * 1000), gain };
    return true;
  } catch {
    return false;
  }
}

/**
 * Which sound a ring uses. Outbound gets its own answer when the rep has set
 * one — wait music first, then its own tone — and otherwise falls all the way
 * back to the incoming choice, which is what this did before outbound could
 * differ.
 */
/** North American ringback: what you hear while the other phone is ringing. */
const RINGBACK: RingtoneId = 'classic';

export function ringSource(p: PhoneAudioPrefs, outgoing = false): { url: string | null; ringtone: RingtoneId } {
  // Dial-out is the standard ringback, always. A chosen tone or an uploaded
  // MP3 (older prefs still carry one) made dialing out sound like a call
  // coming in; the fields are kept in the blob and ignored.
  if (outgoing) return { url: null, ringtone: RINGBACK };
  if (!p.customRingtoneUrl && p.ringtone === RINGBACK && !p.incomingRingChosen) {
    return { url: null, ringtone: 'marimba' };
  }
  return { url: p.customRingtoneUrl, ringtone: p.ringtone };
}

/**
 * Where a ring plays. An incoming ring goes to the ringtone device (the desk
 * speaker, so it is heard without the headset on). Outbound ringback is part
 * of the call and plays where the call does: the headset. Splitting them was
 * one ring in the headset and the next on the laptop.
 */
export function ringDeviceFor(p: PhoneAudioPrefs, outgoing: boolean): string | null {
  return outgoing ? p.outputDeviceId : p.ringDeviceId;
}

function beginRing(outgoing = false): void {
  if (ring) return;
  stopCustomPreview();
  const p = getAudioPrefs();
  const src = ringSource(p, outgoing);
  const device = ringDeviceFor(p, outgoing);
  const fallBack = () => {
    if (!startSynthLoop({ ...p, ringtone: src.ringtone, ringDeviceId: device })) ring = null;
  };
  const playFile = (url: string) => startCustomLoop(url, p.ringVolume, device, fallBack);
  if (src.url) {
    if (playFile(src.url)) return;
    // An uploaded MP3 is an sb: or idb: reference. The file is not in memory
    // until the bucket or IndexedDB answers, and falling through to the piano
    // tone here is what made a custom file sound like it never took.
    if (isStoredRef(src.url)) {
      // Ring the built-in tone now, never silence, while the file loads (or
      // forever, on a browser the upload never reached). The file takes over
      // only if this same ring is still going: a load that lands after the
      // call connected or ended used to start a loop nothing stopped.
      const url = src.url;
      fallBack();
      const mine = ring;
      void loadUploadedSounds(p).then(() => {
        if (!mine || ring !== mine) return;
        stopRing();
        if (!playFile(url)) {
          ringFellBack('the uploaded file is not on this browser (uploads stay in the browser they were added in)');
          fallBack();
        }
      });
      return;
    }
  }
  if (!startSynthLoop({ ...p, ringtone: src.ringtone })) ring = null;
}

/** Loop the user's ringtone until stopRing(). No-op when "ring on this device" is off. */
export function startRing(): void {
  if (ring) return;
  const p = getAudioPrefs();
  if (!p.ringOnDevice) return;
  beginRing();
}

/**
 * Outbound ringback while connecting/ringing: the rep's own dial-out tone or
 * wait music, or the incoming ringtone when they have not chosen one.
 * Independent of ringOnDevice (desk can stay silent for inbound while still
 * hearing dial-out ringback).
 */
export function startOutgoingRing(): void {
  if (ring) return;
  const p = getAudioPrefs();
  if (!p.outgoingRingback) return;
  beginRing(true);
}

export function stopRing(): void {
  if (!ring) return;
  const current = ring;
  ring = null;
  if (current.kind === 'file') {
    try {
      current.el.pause();
      current.el.src = '';
    } catch {
      /* already gone */
    }
    return;
  }
  clearInterval(current.timer);
  try {
    const c = audioContext();
    if (c) current.gain.gain.setTargetAtTime(0, c.currentTime, 0.02);
    setTimeout(() => current.gain.disconnect(), 200);
  } catch {
    /* already gone */
  }
}
