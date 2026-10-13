// "Open in Inbox" from an email on a record: which thread the Inbox should
// open. A hand-off like settingsTab.ts — read once when the Inbox mounts,
// pushed to it when it is already open.
'use client';

import { emailThreadKey } from '@/lib/email-thread';

let pending: string | null = null;
const listeners = new Set<(key: string) => void>();
// The same for a text thread, keyed by the other side's E.164 number: a bell
// row for a text from a number that is not a contact yet opens it here.
let pendingSms: string | null = null;
const smsListeners = new Set<(e164: string) => void>();

/** The Inbox's thread key for a message (data.ts groupThreads: counterpart | base subject). */
export function threadKeyFor(e: { inbound: boolean; from: string; to: string[]; subject: string }): string {
  return emailThreadKey(e);
}

export function requestInboxThread(key: string): void {
  if (listeners.size) listeners.forEach((l) => l(key));
  else pending = key;
}

export function takeInboxThread(): string | null {
  const k = pending;
  pending = null;
  return k;
}

export function onInboxThread(fn: (key: string) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function requestInboxSms(e164: string): void {
  if (smsListeners.size) smsListeners.forEach((l) => l(e164));
  else pendingSms = e164;
}

export function takeInboxSms(): string | null {
  const k = pendingSms;
  pendingSms = null;
  return k;
}

export function onInboxSms(fn: (e164: string) => void): () => void {
  smsListeners.add(fn);
  return () => void smsListeners.delete(fn);
}
