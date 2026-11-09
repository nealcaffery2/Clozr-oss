// Which face the Dialer screen shows: the phone, or the power dialer.
//
// One store outside React so a list started from anywhere (People, Today,
// the queue) can put the power dialer on screen before the first ring. The
// choice is remembered per browser; a rep who dials lists all day lands on
// the power dialer tomorrow too.

import { useSyncExternalStore } from 'react';

/** The phone (one call at a time), the power dialer (you press Next) or the predictive dialer (it dials on by itself). */
export type DialerView = 'phone' | 'power' | 'predictive';

const KEY = 'clozr.dialerView';
const listeners = new Set<() => void>();
let view: DialerView | null = null;

const isView = (v: unknown): v is DialerView => v === 'phone' || v === 'power' || v === 'predictive';

function read(): DialerView {
  if (view) return view;
  try {
    const saved = localStorage.getItem(KEY);
    view = isView(saved) ? saved : 'phone';
  } catch {
    view = 'phone';
  }
  return view;
}

export function getDialerView(): DialerView {
  return read();
}

export function setDialerView(next: DialerView): void {
  if (read() === next) return;
  view = next;
  try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
  listeners.forEach((l) => l());
}

export function useDialerView(): DialerView {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    read,
    () => 'phone',
  );
}
