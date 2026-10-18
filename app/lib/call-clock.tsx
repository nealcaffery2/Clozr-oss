// The live call's clock.
//
// The view model holds when the call connected and when it ended, which change
// twice a call. The m:ss that ticks every second is read here, by the
// components that show it, so a live call re-renders a clock and not the whole
// app shell once a second.
'use client';

import { useSyncExternalStore } from 'react';
import { everyWhileVisible } from './visible-timer';

/** A call's start and end, in epoch ms. No start: not connected yet (ringing, or never answered). */
export type CallTimer = { startedAt: number | null; endedAt: number | null };

/** Whole seconds from `startedAt` to `until`; 0 before the call connects. */
export function callSeconds(startedAt: number | null, until: number): number {
  return startedAt == null ? 0 : Math.max(0, Math.floor((until - startedAt) / 1000));
}

/** m:ss, the way every call clock in the app reads. */
export function formatCallClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/** The length of a call that has ended, m:ss. A call still running reads 0:00 here; show it with useCallClock. */
export function endedCallClock({ startedAt, endedAt }: CallTimer): string {
  return formatCallClock(endedAt == null ? 0 : callSeconds(startedAt, endedAt));
}

// One shared one-second clock for every running call clock on the page, so
// they tick together and stop when none is showing. A hidden tab pauses it and
// catches up from the real time when shown (everyWhileVisible).
let now = 0;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();
const tick = () => {
  now = Date.now();
  listeners.forEach((l) => l());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!stop) {
    now = Date.now();
    stop = everyWhileVisible(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && stop) {
      stop();
      stop = null;
    }
  };
};
const idle = () => () => undefined;
// Cached between ticks, because React compares two reads. With nothing
// subscribed it refreshes once a stale second has passed, so a clock that
// mounts mid-call shows the running time at once rather than 0:00.
const getSnapshot = () => {
  if (!stop && Date.now() - now >= 1000) now = Date.now();
  return now;
};
const getServerSnapshot = () => 0;

/** The call's clock as m:ss: ticking once a second while it runs, fixed once it ends. */
export function useCallClock({ startedAt, endedAt }: CallTimer): string {
  const running = startedAt != null && endedAt == null;
  const at = useSyncExternalStore(running ? subscribe : idle, getSnapshot, getServerSnapshot);
  return formatCallClock(callSeconds(startedAt, endedAt ?? at));
}

/** The clock as text, for a spot inside a larger component: only this re-renders each second. */
export function CallClock({ timer }: { timer: CallTimer }) {
  return <>{useCallClock(timer)}</>;
}
