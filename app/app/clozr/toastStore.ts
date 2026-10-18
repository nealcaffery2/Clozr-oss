'use client';

// The toast, outside the workspace state.
//
// It used to be four fields on ClozrState, so every toast (a send's "Sending…"
// then its "Text sent", a save's "Saved") rebuilt the whole view model: the
// 13,000-person graph is memoised apart, but V itself is a useMemo over all of
// `s`, and a toast is written on nearly every action. A module store read with
// useSyncExternalStore means only the shell's toast element re-renders, and the
// dismissal timer lives here rather than in an effect that re-armed on each
// view rebuild.

import { useSyncExternalStore } from 'react';

/**
 * What a toast is saying: a write that landed, one that did not, or anything
 * else. Every toast used to wear the same green square, so "Could not save"
 * looked exactly like "Saved".
 */
export type ToastTone = 'success' | 'error' | 'info';

export type ToastAction = { label: string; run: () => void };

export type ToastState = {
  msg: string | null;
  /** Bumped on every toast so a repeat of the same message still reads as new. */
  seq: number;
  tone: ToastTone;
  /** A button on the toast (Undo on a ticked task or a mute). */
  action: ToastAction | null;
};

const EMPTY: ToastState = { msg: null, seq: 0, tone: 'info', action: null };
let snapshot: ToastState = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit() { for (const l of listeners) l(); }

// An error stays longer: it is the one message that asks the reader to do
// something, and 2.6 seconds is not enough to read "Could not save…" and what
// follows it. One with a button (Undo) stays long enough to reach for it.
function arm() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(dismissToast, snapshot.tone === 'error' ? 6000 : snapshot.action ? 5000 : 2600);
}

export function raiseToast(msg: string, tone: ToastTone = 'info', action?: ToastAction | null) {
  snapshot = { msg, seq: snapshot.seq + 1, tone, action: action ?? null };
  arm();
  emit();
}

/** Put a button on the toast that is up now (toastUndo); nothing when none is. */
export function setToastAction(action: ToastAction | null) {
  if (!snapshot.msg) return;
  snapshot = { ...snapshot, action };
  arm();
  emit();
}

export function dismissToast() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!snapshot.msg) return;
  snapshot = { ...snapshot, msg: null, action: null };
  emit();
}

export function readToast(): ToastState { return snapshot; }

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
function getServer(): ToastState { return EMPTY; }

/** The toast on screen now. Only the element that draws it should call this. */
export function useToast(): ToastState {
  return useSyncExternalStore(subscribe, readToast, getServer);
}
