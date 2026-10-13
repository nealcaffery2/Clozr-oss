/**
 * When the Telnyx browser leg never comes up.
 *
 * A duplicate or stale WebRTC registration answers the invite somewhere else:
 * SIP 486 (busy) in a few hundred milliseconds, or SIP 487 (no answer) once
 * the ring times out. Either way this tab should drop the stuck Talkr call,
 * register again, and ask the rep to try the call again themselves.
 */

export const RELOAD_AND_TRY = 'Reload and try again';

export class BrowserLegError extends Error {
  readonly code = 'browser_leg' as const;
  readonly kind: 'timeout' | 'busy';
  constructor(kind: 'timeout' | 'busy') {
    super(RELOAD_AND_TRY);
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
