'use client';

/**
 * The Talkr Chrome extension, seen from this page.
 *
 * The extension is the same phone as the dialer in the corner, in a window
 * that outlives the tab — a rep can close CLOZR mid-call and keep talking. Two
 * front ends over one Talkr account need two things from each other, and this
 * module is both of them.
 *
 * **One sign-in.** CLOZR already signs its Talkr requests with the rep's own
 * Supabase access token, which Talkr verifies as a partner identity and links
 * by email. The extension needs exactly that token and nothing else, so this
 * page hands it over and the rep never types a second password. The token
 * leaves here only after the extension has announced itself, only over
 * `postMessage` to our own origin, and only to a listener the extension
 * installed — a content script in the isolated world, not page script. Talkr
 * still verifies it against `/v1/me` before trusting a word of it.
 *
 * Renewal stays here on purpose. A Supabase refresh token is single-use: if
 * the extension redeemed ours, this tab would be signed out of the CRM the rep
 * is working in. So the extension asks and this page answers with whatever
 * `supabase.auth.getSession()` has, which is always current because the client
 * renews it.
 *
 * **One softphone.** Two WebRTC registrations under one identity is how an
 * inbound call rings in a window nobody is looking at. When the extension says
 * it is holding the softphone this page stands its own down; the dialer says
 * so, and comes back the moment the extension goes away.
 *
 * Nothing here is required for CLOZR to work. With no extension installed the
 * marker is ignored, no message ever arrives, and the phone runs in the tab
 * exactly as it did before.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { talkrUrl } from './talkr';

/** The extension looks for this on <html> before it says anything at all. */
const MARKER_ATTR = 'data-talkr-bridge';
const FROM_EXTENSION = 'talkr-extension';
const FROM_CLOZR = 'clozr';

/** A call the extension is running, mirrored here as it happens. */
export interface ExtensionCall {
  phase: 'ringing' | 'connected' | 'ended';
  direction: 'inbound' | 'outbound' | null;
  e164: string | null;
  callId: string | null;
}

export interface ExtensionState {
  /** The extension has introduced itself in this tab. */
  present: boolean;
  /** Its softphone is registered, so this page must not register a second one. */
  holdingSoftphone: boolean;
  /** The last call it reported, or null. */
  call: ExtensionCall | null;
}

const initial: ExtensionState = { present: false, holdingSoftphone: false, call: null };

let state: ExtensionState = initial;
const listeners = new Set<(s: ExtensionState) => void>();
/** Called when the extension reports a call, for the write-back the CRM owes. */
const callListeners = new Set<(call: ExtensionCall) => void>();
/**
 * The extension's "Open in CLOZR". A listener returns false while it cannot
 * answer yet (the workspace is still loading, which is exactly when a tab the
 * extension just opened asks), and the request is kept and replayed to the
 * next listener that subscribes, for a little while.
 */
const openListeners = new Set<(e164: string) => boolean>();
const OPEN_KEEP_MS = 30_000;
let pendingOpen: { e164: string; at: number } | null = null;

function tryOpen(): void {
  if (!pendingOpen || Date.now() - pendingOpen.at > OPEN_KEEP_MS) {
    pendingOpen = null;
    return;
  }
  for (const fn of openListeners) {
    if (fn(pendingOpen.e164)) {
      pendingOpen = null;
      return;
    }
  }
}

/**
 * Nothing tells this page when the extension goes away — disabled, reloaded,
 * crashed — so without these `holdingSoftphone` stays true forever: every dial
 * is handed to a phone that is not there and inbound rings nowhere. Two
 * checks, because an older extension answers neither pings nor anything else:
 *
 *  - a dial handed over must be reported back (`talkr.call`) within
 *    DIAL_ACK_MS, or the extension is taken to be gone and the dial comes
 *    back to this tab;
 *  - while it holds the phone it is pinged, and one that has ever answered a
 *    ping (`talkr.pong`) and then stops is taken to be gone.
 */
const DIAL_ACK_MS = 12_000;
const PING_EVERY_MS = 20_000;
const PING_GRACE_MS = 8_000;
let answersPings = false;
let lastPong = 0;
let pendingDial: { timer: ReturnType<typeof setTimeout>; onNoAnswer?: () => void } | null = null;

/** The extension stopped answering: this tab takes the phone back. */
function extensionGone(): void {
  set({ holdingSoftphone: false, call: null });
}

function set(next: Partial<ExtensionState>): void {
  const merged = { ...state, ...next };
  if (
    merged.present === state.present &&
    merged.holdingSoftphone === state.holdingSoftphone &&
    merged.call === state.call
  ) {
    return;
  }
  state = merged;
  for (const fn of listeners) fn(state);
}

export function getExtensionState(): ExtensionState {
  return state;
}

export function subscribeExtension(fn: (s: ExtensionState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every extension call, for whoever wants to write it onto a record. */
export function onExtensionCall(fn: (call: ExtensionCall) => void): () => void {
  callListeners.add(fn);
  return () => callListeners.delete(fn);
}

/** The extension's "Open in CLOZR": show the record for this number. */
export function onExtensionOpenRecord(fn: (e164: string) => boolean): () => void {
  openListeners.add(fn);
  tryOpen();
  return () => openListeners.delete(fn);
}

function post(message: Record<string, unknown>): void {
  window.postMessage({ source: FROM_CLOZR, ...message }, window.location.origin);
}

/** Unix seconds from a JWT's `exp`, so the extension knows when to come back. */
function jwtExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Answer with the session this tab holds. `getSession` renews a token that is
 * about to expire, which is the whole reason the extension asks us rather than
 * keeping its own refresh token.
 */
async function sendSession(): Promise<void> {
  if (!supabase) {
    post({ type: 'clozr.session', token: null, email: null, expiresAt: null, apiUrl: talkrUrl() });
    return;
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? null;
  post({
    type: 'clozr.session',
    token,
    email: data.session?.user?.email ?? null,
    expiresAt: token ? (data.session?.expires_at ?? jwtExpiry(token)) : null,
    // The workspace may point Talkr somewhere other than production; the
    // extension has no way to know that except from here.
    apiUrl: talkrUrl(),
  });
}

function onMessage(event: MessageEvent): void {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { source?: string; type?: string; holding?: boolean } | null;
  if (data?.source !== FROM_EXTENSION) return;

  switch (data.type) {
    case 'talkr.hello':
      set({ present: true });
      void sendSession();
      return;
    case 'talkr.token-request':
      void sendSession();
      return;
    case 'talkr.softphone':
      set({ present: true, holdingSoftphone: Boolean(data.holding) });
      return;
    case 'talkr.pong':
      answersPings = true;
      lastPong = Date.now();
      return;
    case 'talkr.call': {
      if (pendingDial) {
        clearTimeout(pendingDial.timer);
        pendingDial = null;
      }
      const call = data as unknown as ExtensionCall;
      set({ present: true, call });
      for (const fn of callListeners) fn(call);
      return;
    }
    case 'talkr.open-record': {
      const e164 = (data as { e164?: unknown }).e164;
      if (typeof e164 === 'string') {
        pendingOpen = { e164, at: Date.now() };
        tryOpen();
      }
      return;
    }
    default:
      return;
  }
}

let installed = false;

/**
 * Advertise this page to the extension and keep answering it. Safe to call
 * more than once; the second call is a no-op.
 */
export function installTalkrExtensionBridge(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (installed) return () => undefined;
  installed = true;
  window.addEventListener('message', onMessage);
  // Last, so a content script that is already listening sees the marker appear
  // and introduces itself rather than racing us.
  document.documentElement.setAttribute(MARKER_ATTR, 'clozr');

  // A fresh sign-in or a token renewal is worth pushing, not just answering:
  // the extension may be sitting on a token that is about to lapse.
  const auth = supabase?.auth.onAuthStateChange((event) => {
    if (!state.present) return;
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT') {
      void sendSession();
    }
  });

  const ping = setInterval(() => {
    if (!state.holdingSoftphone) return;
    const sent = Date.now();
    post({ type: 'clozr.ping' });
    setTimeout(() => {
      if (answersPings && state.holdingSoftphone && lastPong < sent) extensionGone();
    }, PING_GRACE_MS);
  }, PING_EVERY_MS);

  return () => {
    installed = false;
    clearInterval(ping);
    if (pendingDial) clearTimeout(pendingDial.timer);
    pendingDial = null;
    window.removeEventListener('message', onMessage);
    document.documentElement.removeAttribute(MARKER_ATTR);
    auth?.data.subscription.unsubscribe();
    set(initial);
  };
}

/**
 * Ask the extension to place a call, for a CLOZR button that prefers it.
 * `onNoAnswer` runs if the extension never reports the call — it is gone, and
 * by then `holdingSoftphone` is false so the caller can dial here instead.
 */
export function dialWithExtension(e164: string, onNoAnswer?: () => void): boolean {
  if (!state.present) return false;
  if (pendingDial) clearTimeout(pendingDial.timer);
  post({ type: 'clozr.dial', e164 });
  const timer = setTimeout(() => {
    pendingDial = null;
    extensionGone();
    onNoAnswer?.();
  }, DIAL_ACK_MS);
  pendingDial = { timer, onNoAnswer };
  return true;
}

// ── React ──────────────────────────────────────────────────────────────────

/**
 * The extension's state, for components that have to change what they show
 * when it is here. Installs the bridge on first use so nothing else has to
 * remember to.
 */
export function useTalkrExtension(): ExtensionState {
  useEffect(() => installTalkrExtensionBridge(), []);
  return useSyncExternalStore(subscribeExtension, getExtensionState, () => initial);
}
