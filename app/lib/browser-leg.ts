/**
 * When the Telnyx browser leg never comes up.
 *
 * A duplicate or stale WebRTC registration answers the invite somewhere else:
 * SIP 486 (busy) in a few hundred milliseconds, or SIP 487 (no answer) once
 * the ring times out. Either way this tab should drop the stuck Talkr call,
 * register again, and ask the rep to try the call again themselves.
 */

import { ringOutReason } from './ring-guard';

export const RELOAD_AND_TRY = 'Reload and try again';
/** A 486 on the browser leg: the same phone login answered somewhere else. */
export const SIGNED_IN_ELSEWHERE = 'Your phone line is signed in somewhere else (another computer, browser or the Talkr extension). Sign out there, then Reconnect.';

export class BrowserLegError extends Error {
  readonly code = 'browser_leg' as const;
  readonly kind: 'timeout' | 'busy';
  constructor(kind: 'timeout' | 'busy') {
    super(kind === 'busy' ? SIGNED_IN_ELSEWHERE : RELOAD_AND_TRY);
    this.name = 'BrowserLegError';
    this.kind = kind;
  }
}

export function isBrowserLegError(err: unknown): err is BrowserLegError {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'browser_leg';
}

/**
 * SIP code on a browser-leg hangup that means this registration lost the
 * invite. 486 is another client rejecting as busy. 487 is no answer, which
 * is what a stale registration leaves behind when the ring times out.
 */
export function browserLegSipKind(sipCode: number | null | undefined): 'busy' | 'timeout' | null {
  if (sipCode === 486) return 'busy';
  if (sipCode === 487) return 'timeout';
  return null;
}

/**
 * How long a Telnyx socket may go without a message before it counts as
 * dead. The SDK pings when a 35 s window passes with nothing received, so a
 * healthy idle socket hears something at least every ~70 s. That timer is
 * frozen while the laptop sleeps, so after a wake the socket still reads
 * "connected" while Telnyx has dropped the registration; a call placed then
 * rings nobody (SIP 480) and the tab waits out the leg.
 */
export const SOCKET_QUIET_MS = 75_000;

/** True when the socket has heard from Telnyx recently enough to trust its registration. */
export function socketHeardRecently(lastHeardAt: number, now: number = Date.now()): boolean {
  return lastHeardAt > 0 && now - lastHeardAt < SOCKET_QUIET_MS;
}

/**
 * Talkr already ended the call while this tab waits for its leg: the carrier
 * could not reach this browser (SIP 480 when no registration is live) and the
 * invite never arrives, so only the server knows. Seen at 17:28 UTC on
 * 2026-10-19: Talkr closed the call in 1.3 s, the tab waited out 30 s.
 */
export function legEndedOnServer(status: string | null | undefined): boolean {
  return status === 'completed' || ringOutReason(status) !== null;
}
