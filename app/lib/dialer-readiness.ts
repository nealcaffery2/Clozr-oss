import { PHONE_OTHER_TAB, USE_PHONE_HERE } from './softphone-lock';

// What a rep needs before a power or predictive session: a phone this browser
// can call from, a microphone, a caller-ID line, and a voicemail of their own
// to drop when a machine answers. Checked when a session starts; anything
// missing is put in front of the rep there, and stays flagged on the dialer
// until it is fixed.
//
// The checks are pure (tools/dialer-readiness.test.ts). The facts come from
// the screen (app/components/talkr/DialerReadiness.tsx), which publishes them
// here so a session start anywhere can ask without holding any of it.

export type DialMode = 'power' | 'predictive';

export type ReadinessFacts = {
  /** Talkr, as the CRM sees it (useTalkrPhone's status). */
  phone: 'off' | 'loading' | 'ok' | 'unlinked' | 'unreachable' | 'error';
  /** The softphone in this browser. */
  softphone: 'off' | 'connecting' | 'ready' | 'error';
  /**
   * Why the softphone is not ready, in its own words (another tab, a failed
   * login). Empty when it has not said. The checklist shows this instead of
   * a generic "not connected".
   */
  softphoneReason?: string | null;
  /** The browser's microphone permission; unknown where the browser will not say. */
  mic: 'granted' | 'prompt' | 'denied' | 'unknown';
  /** The line calls go out on, or null when the rep has none. */
  callerId: string | null;
  /** Voicemail recordings this rep made. */
  ownVoicemails: number;
  /** Voicemail recordings in the workspace, theirs included. */
  teamVoicemails: number;
};

export type ReadinessKey = 'phone' | 'mic' | 'caller_id' | 'voicemail';
export type ReadinessFix = 'connect_phone' | 'use_phone_here' | 'allow_mic' | 'open_numbers' | 'open_account' | 'record_voicemail';
export type ReadinessItem = {
  key: ReadinessKey;
  /** missing: dialing will not work properly without it. warn: it will, but worse. */
  state: 'ok' | 'warn' | 'missing';
  title: string;
  detail: string;
  fix?: { label: string; action: ReadinessFix };
};

export function dialerReadiness(f: ReadinessFacts, mode: DialMode | null = null): ReadinessItem[] {
  return [phoneItem(f), micItem(f), callerIdItem(f), voicemailItem(f, mode)];
}

function phoneItem(f: ReadinessFacts): ReadinessItem {
  const key = 'phone';
  if (f.phone === 'unlinked') {
    return { key, state: 'missing', title: 'Talkr does not know this sign-in', detail: 'Calls fall back to your own phone and nothing is recorded or logged. An admin adds you in Talkr with this email.', fix: { label: 'Open Talkr account', action: 'open_account' } };
  }
  if (f.phone === 'unreachable' || f.phone === 'error') {
    return { key, state: 'missing', title: 'Talkr cannot be reached', detail: 'No call can be placed until it answers again.', fix: { label: 'Retry', action: 'connect_phone' } };
  }
  if (f.phone === 'off' || f.phone === 'loading' || f.softphone === 'connecting') {
    return { key, state: 'warn', title: 'The phone is still connecting', detail: 'Give it a few seconds. The first call waits for it.' };
  }
  if (f.softphone !== 'ready') {
    const reason = f.softphoneReason?.trim() || '';
    if (reason === PHONE_OTHER_TAB) {
      return { key, state: 'missing', title: PHONE_OTHER_TAB, detail: 'Take it in this tab. The other tab disconnects, and calls ring here.', fix: { label: USE_PHONE_HERE, action: 'use_phone_here' } };
    }
    if (reason) {
      return { key, state: 'missing', title: reason, detail: 'The phone in this browser is not connected.', fix: { label: 'Connect phone', action: 'connect_phone' } };
    }
    return { key, state: 'missing', title: 'The phone in this browser is not connected', detail: 'Connect it so calls ring from here.', fix: { label: 'Connect phone', action: 'connect_phone' } };
  }
  return { key, state: 'ok', title: 'Phone connected', detail: 'Calls ring from this browser.' };
}

function micItem(f: ReadinessFacts): ReadinessItem {
  const key = 'mic';
  if (f.mic === 'denied') {
    return { key, state: 'missing', title: 'The microphone is blocked', detail: 'Nobody will hear you. Allow the microphone for this site from the lock icon in the address bar, then come back.' };
  }
  if (f.mic === 'prompt') {
    return { key, state: 'warn', title: 'The microphone is not allowed yet', detail: 'Allow it now so the first call does not stop to ask.', fix: { label: 'Allow microphone', action: 'allow_mic' } };
  }
  return { key, state: 'ok', title: 'Microphone allowed', detail: 'The seller will hear you.' };
}

function callerIdItem(f: ReadinessFacts): ReadinessItem {
  const key = 'caller_id';
  if (!f.callerId) {
    return { key, state: 'missing', title: 'No number to call from', detail: 'You have no caller-ID line. An admin assigns one in Settings → Numbers.', fix: { label: 'Open Numbers', action: 'open_numbers' } };
  }
  return { key, state: 'ok', title: 'Caller ID set', detail: 'Calls go out on your line.' };
}

function voicemailItem(f: ReadinessFacts, mode: DialMode | null): ReadinessItem {
  const key = 'voicemail';
  const fix = { label: 'Record voicemail', action: 'record_voicemail' as const };
  const after = mode === 'predictive' ? ' Predictive dials the next number as soon as it plays.' : '';
  if (f.ownVoicemails > 0) {
    return { key, state: 'ok', title: 'Voicemail recorded', detail: `When a machine answers, Drop VM plays it and hangs up.${after}` };
  }
  if (f.teamVoicemails > 0) {
    return { key, state: 'warn', title: 'Record your own voicemail', detail: `Drop VM would play a teammate’s recording in their voice.${after}`, fix };
  }
  return { key, state: 'missing', title: 'No voicemail to drop', detail: `Record one, so a machine answer is a one-tap drop instead of leaving the message by hand every time.${after}`, fix };
}

export const needsAttention = (items: ReadinessItem[]) => items.filter((i) => i.state !== 'ok');

/**
 * Whether starting a session should stop and show the checklist. Anything
 * missing always does. Warnings alone ask once a day, so a rep who chose to
 * dial with a teammate's voicemail is not asked again on every start.
 */
export function shouldPrompt(items: ReadinessItem[], warnedToday: string | null, today: string): boolean {
  const open = needsAttention(items);
  if (!open.length) return false;
  if (open.some((i) => i.state === 'missing')) return true;
  return warnedToday !== warnKey(items, today);
}

export function warnKey(items: ReadinessItem[], today: string): string {
  return `${today}:${needsAttention(items).map((i) => i.key).sort().join(',')}`;
}

// ---- the hand-off between a session start and the checklist on screen ------------

type Prompt = { mode: DialMode | null; resolve: (go: boolean) => void };
let facts: ReadinessFacts | null = null;
let rev = 0;
const subs = new Set<() => void>();
let host: ((p: Prompt) => void) | null = null;

const WARNED_KEY = 'clozr.dialerReady.warned';
const today = () => new Date().toISOString().slice(0, 10);

/** The checklist was describing another workspace. The next publish fills it in. */
export function clearReadiness(): void {
  if (!facts && rev === 0) return;
  facts = null;
  rev += 1;
  subs.forEach((s) => s());
}

export function publishReadiness(next: ReadinessFacts): void {
  if (facts && JSON.stringify(facts) === JSON.stringify(next)) return;
  facts = next;
  rev += 1;
  subs.forEach((s) => s());
}

export function readinessFacts(): ReadinessFacts | null {
  return facts;
}

export function readinessRev(): number {
  return rev;
}

export function subscribeReadiness(cb: () => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}

/** The checklist on screen takes prompts. One host at a time. */
export function hostReadinessPrompt(fn: (p: Prompt) => void): () => void {
  host = fn;
  return () => { if (host === fn) host = null; };
}

/** Open the checklist to look at, not to start anything. */
export function reviewDialerReadiness(): void {
  host?.({ mode: null, resolve: () => undefined });
}

/**
 * Ask before a session starts. `true` straight away (still inside the click,
 * so the first call keeps its gesture) when there is nothing to show or
 * nothing on screen to show it; otherwise the rep's answer: start anyway, or not.
 */
export function confirmDialerReady(mode: DialMode): true | Promise<boolean> {
  if (!host || !facts) return true;
  const items = dialerReadiness(facts, mode);
  let warned: string | null = null;
  try { warned = localStorage.getItem(WARNED_KEY); } catch { /* private mode */ }
  if (!shouldPrompt(items, warned, today())) return true;
  try { localStorage.setItem(WARNED_KEY, warnKey(items, today())); } catch { /* private mode */ }
  const show = host;
  return new Promise<boolean>((resolve) => show({ mode, resolve }));
}
