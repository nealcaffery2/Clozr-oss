'use client';

import { useEffect } from 'react';

/** The slice of the Screen Wake Lock API this uses; older DOM typings lack it. */
type Sentinel = { release: () => Promise<void> };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<Sentinel> } };

/**
 * Keep the screen awake while `active`.
 *
 * A phone that auto-locks mid-call drops the call: iOS suspends a page's
 * WebRTC the moment it leaves the foreground, and there is no CallKit for the
 * web. Feature-detected (Safari 16.4+, Home Screen apps from iOS 18.4), and
 * every failure is ignored — a refused lock only means the phone may dim, as
 * it did before. The browser drops the lock whenever the page is hidden, so
 * it is asked for again each time the page comes back.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined') return;
    const nav = navigator as WakeLockNavigator;
    if (!nav.wakeLock) return;
    let sentinel: Sentinel | null = null;
    let stopped = false;

    const acquire = async () => {
      if (stopped || document.visibilityState !== 'visible' || sentinel) return;
      try {
        const lock = await nav.wakeLock!.request('screen');
        if (stopped) {
          void lock.release().catch(() => undefined);
          return;
        }
        sentinel = lock;
      } catch {
        // NotAllowedError (low battery, a policy, no user activation yet): carry on without it.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        // The old sentinel was released when the page was hidden.
        sentinel = null;
        void acquire();
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      const s = sentinel;
      sentinel = null;
      if (s) void s.release().catch(() => undefined);
    };
  }, [active]);
}
