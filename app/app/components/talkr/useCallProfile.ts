'use client';

/**
 * "From this call": asks the `call-profile` edge function who the caller is
 * as the live transcript grows, and keeps the merged answer for the call.
 *
 * Load stays low on purpose: an ask goes out only while the call is live with
 * AI transcription on, only after ASK_EVERY_LINES new finished lines and
 * ASK_EVERY_MS since the last ask, never while one is still out, and once
 * more at wrap-up when something was said since. An error pauses the asks
 * until the rep presses Try again, so a missing key is not retried all call.
 *
 * The answers live in module memory per call (V.callProfile.key), so leaving
 * the Dialer and coming back mid-call, or the card moving from the live
 * column to the wrap-up, keeps what was found. The sample-data demo asks
 * nothing: V.callProfile.demo is its scripted answer.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { askCallProfile, emptyProfile, filledFields, mergeProfiles, type CallProfile, type ProfileKind } from '@/lib/call-profile';

export const ASK_EVERY_LINES = 4;
export const ASK_EVERY_MS = 20_000;
const KEEP_CALLS = 6;

type Entry = {
  profile: CallProfile;
  /** Lines the last ask covered. */
  asked: number;
  askedAt: number;
  busy: boolean;
  error: string | null;
  /** Stops auto asks after an error, until Try again. */
  paused: boolean;
  /** The wrap-up ask went out (or there was nothing new for it). */
  final: boolean;
  /** The kind the rep picked over the suggestion. */
  picked: Exclude<ProfileKind, 'unknown'> | null;
};

const memory = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function entryFor(key: string): Entry {
  let e = memory.get(key);
  if (!e) {
    e = { profile: emptyProfile(), asked: 0, askedAt: Date.now(), busy: false, error: null, paused: false, final: false, picked: null };
    memory.set(key, e);
    while (memory.size > KEEP_CALLS) memory.delete(memory.keys().next().value as string);
  }
  return e;
}

export type CallProfileState = {
  /** `off`: AI transcription is off. `waiting`: listening, nothing found yet. */
  status: 'off' | 'waiting' | 'asking' | 'ready' | 'error';
  profile: CallProfile;
  /** An ask is out. */
  busy: boolean;
  error: string | null;
  /** The kind the card shows: the rep's pick, else the call's suggestion, else the record's. */
  kind: ProfileKind;
  pickKind: (k: Exclude<ProfileKind, 'unknown'>) => void;
  retry: () => void;
};

export function useCallProfile(V: ClozrView): CallProfileState {
  const c = V.callProfile;
  const key = c.key;
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);

  const live = c.demo == null;
  // Only while the card shows (CallProfileCard): no record yet, or a buyer
  // with buy-box gaps. A seller or a complete buyer costs no asks.
  const wanted = c.recordKind == null || (c.recordKind === 'buyer' && c.buyerGaps.length > 0);
  const on = live && V.ai && wanted && c.workspaceId != null && key != null && V.callState !== 'idle';
  const linesRef = useRef(c.lines);
  const ctxRef = useRef(c);
  // Before the ask effect below, so an ask sends this render's lines.
  useEffect(() => {
    linesRef.current = c.lines;
    ctxRef.current = c;
  });

  const ask = useCallback((k: string, final: boolean) => {
    const e = entryFor(k);
    const cx = ctxRef.current;
    if (e.busy || cx.workspaceId == null) return;
    const lines = linesRef.current;
    e.busy = true; e.asked = lines.length; e.askedAt = Date.now(); e.error = null;
    if (final) e.final = true;
    notify();
    void askCallProfile({ workspaceId: cx.workspaceId, lines, repLabel: cx.repLabel, phone: cx.phone, knownKind: cx.recordKind })
      .then((r) => {
        if (r.ok) { e.profile = mergeProfiles(e.profile, r.profile); e.paused = false; } else { e.error = r.message; e.paused = true; }
      }, (err: unknown) => { e.error = err instanceof Error ? err.message : 'The request failed.'; e.paused = true; })
      .finally(() => { e.busy = false; notify(); });
  }, []);

  const n = c.lines.length;
  const phase = V.callState;
  const e = key ? entryFor(key) : null;
  const busy = e?.busy ?? false;
  const paused = e?.paused ?? false;
  useEffect(() => {
    if (!on || !key) return;
    const en = entryFor(key);
    if (en.busy || en.paused) return;
    if (phase === 'wrap') {
      if (en.final) return;
      if (n > en.asked) ask(key, true);
      else { en.final = true; }
      return;
    }
    if (n - en.asked < ASK_EVERY_LINES) return;
    const t = setTimeout(() => ask(key, false), Math.max(0, en.askedAt + ASK_EVERY_MS - Date.now()));
    return () => clearTimeout(t);
  }, [on, key, n, phase, busy, paused, ask]);

  const profile = live ? (e?.profile ?? emptyProfile()) : (c.demo ?? emptyProfile());
  const found = filledFields(profile).length > 0;
  const suggested: ProfileKind = profile.kind !== 'unknown' ? profile.kind : c.recordKind ?? 'unknown';
  return {
    status: live && !V.ai ? 'off'
      : busy && !found ? 'asking'
        : e?.error && live ? 'error'
          : found ? 'ready' : 'waiting',
    profile,
    busy: live && busy,
    error: live ? e?.error ?? null : null,
    kind: e?.picked ?? suggested,
    pickKind: (k) => { if (!key) return; entryFor(key).picked = k; notify(); },
    retry: () => { if (!key) return; const en = entryFor(key); en.paused = false; ask(key, V.callState === 'wrap'); },
  };
}
