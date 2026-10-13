// Where a phone call plays.
//
// A web call attached to an <audio> element starts on the loudspeaker, which
// is the media output. A handset call should start in the receiver. Chrome
// names that output "communications"; a labeled earpiece or receiver wins
// when the browser lists one. Speaker is the loudspeaker device, or the
// default media output when the browser does not name one.
//
// iOS keeps the voice session on play-and-record either way so the mic stays
// up. The sink is what moves the call between the receiver and the speaker.

export type CallRoute = 'earpiece' | 'speaker';

export type SinkDevice = { deviceId: string; label: string };

/** Chromium's default communications device. On a phone that is the earpiece. */
export const COMMUNICATIONS_SINK = 'communications';

const EARPIECE_LABEL = /earpiece|receiver|handset/i;
const SPEAKER_LABEL = /speakerphone|loudspeaker|\bspeaker\b/i;

/** The sink id to hand to setSinkId for this route. */
export function pickOutputSink(devices: SinkDevice[], route: CallRoute): string {
  if (route === 'earpiece') {
    const named = devices.find((d) => EARPIECE_LABEL.test(d.label) && !/speakerphone/i.test(d.label));
    if (named?.deviceId) return named.deviceId;
    const comms = devices.find((d) => d.deviceId === COMMUNICATIONS_SINK);
    if (comms) return comms.deviceId;
    return COMMUNICATIONS_SINK;
  }
  const named = devices.find((d) => SPEAKER_LABEL.test(d.label) && !EARPIECE_LABEL.test(d.label));
  if (named?.deviceId) return named.deviceId;
  return '';
}

type AudioSession = { type: string };

function audioSession(): AudioSession | null {
  if (typeof navigator === 'undefined') return null;
  const n = navigator as Navigator & { audioSession?: AudioSession };
  return n.audioSession ?? null;
}

let route: CallRoute = 'earpiece';
const listeners = new Set<() => void>();

export function getCallRoute(): CallRoute {
  return route;
}

export function subscribeCallRoute(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** Next call starts in the earpiece again. */
export function resetCallRoute(): void {
  if (route === 'earpiece') return;
  route = 'earpiece';
  emit();
}

/** Ringtone and notification sounds are not a call. Put the session back. */
export function releaseCallAudioSession(): void {
  const session = audioSession();
  if (session && session.type !== 'auto') session.type = 'auto';
}

async function pointElement(el: HTMLAudioElement, sink: string): Promise<void> {
  const setSink = (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
  if (!setSink) return;
  try {
    await setSink.call(el, sink);
  } catch {
    if (sink) await setSink.call(el, '').catch(() => undefined);
  }
}

// Writes run one after another. A tap on Speaker during the call-start
// write has to be the one that finishes, or the call stays on the receiver.
let tail: Promise<void> = Promise.resolve();

/**
 * Point the live call at the receiver or the loudspeaker.
 * Returns the sink id that was requested.
 */
export function applyCallRoute(next: CallRoute, devices: SinkDevice[]): Promise<string> {
  const changed = route !== next;
  route = next;
  if (changed) emit();
  const sink = pickOutputSink(devices, next);
  const job = tail.then(async () => {
    if (route !== next) return;
    const session = audioSession();
    if (session) session.type = 'play-and-record';
    if (typeof document === 'undefined') return;
    const els = document.querySelectorAll<HTMLAudioElement>('audio[data-talkr-softphone]');
    await Promise.all([...els].map((el) => pointElement(el, sink)));
  });
  tail = job.then(() => undefined, () => undefined);
  return job.then(() => sink);
}
