// The rep's own presence: Available, Do not disturb or Away.
//
// Talkr's floor and transfer lists read presence from the heartbeat
// (POST /v1/presence: available, away or offline). The heartbeat in
// useTalkrPhone sends what is picked here, so a rep who sets Away stays Away
// instead of being flipped back to Available thirty seconds later. Do not
// disturb is Away to Talkr, and this tab declines a call that rings while it
// is on (useTalkrPhone), so the caller goes to voicemail.
//
// Kept per browser: it is how this rep is working today, on this machine.

'use client';

import { useSyncExternalStore } from 'react';

export type Presence = 'available' | 'dnd' | 'away';

export const PRESENCE_OPTIONS: { value: Presence; label: string; hint: string; color: string }[] = [
  { value: 'available', label: 'Available', hint: 'Calls ring here and teammates can transfer to you', color: 'var(--green)' },
  { value: 'dnd', label: 'Do not disturb', hint: 'Calls go to voicemail; you can still dial out', color: 'var(--red)' },
  { value: 'away', label: 'Away', hint: 'Teammates see you as away; calls still ring', color: 'var(--amber)' },
];

const KEY = 'clozr.presence';
const listeners = new Set<() => void>();
let current: Presence | null = null;

function read(): Presence {
  if (current) return current;
  let saved: string | null = null;
  try { saved = typeof window === 'undefined' ? null : window.localStorage.getItem(KEY); } catch { /* storage blocked */ }
  current = saved === 'dnd' || saved === 'away' ? saved : 'available';
  return current;
}

export function getPresence(): Presence {
  return read();
}

export function setPresence(next: Presence): void {
  current = next;
  try { window.localStorage.setItem(KEY, next); } catch { /* storage blocked: kept for this tab */ }
  for (const fn of [...listeners]) fn();
}

// Another tab picking a presence changes this one too: its heartbeat and its
// Do not disturb follow, rather than telling Talkr the old answer every 30 s.
function fromOtherTab(e: StorageEvent) {
  if (e.key !== KEY) return;
  current = e.newValue === 'dnd' || e.newValue === 'away' ? e.newValue : 'available';
  for (const fn of [...listeners]) fn();
}

export function onPresence(fn: () => void): () => void {
  if (!listeners.size && typeof window !== 'undefined') window.addEventListener('storage', fromOtherTab);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', fromOtherTab);
  };
}

export function usePresence(): Presence {
  return useSyncExternalStore(onPresence, read, () => 'available');
}

/** What the heartbeat tells Talkr: available only when picked and the phone can actually ring here. */
export function heartbeatStatus(p: Presence, phoneReady: boolean): 'available' | 'away' {
  return p === 'available' && phoneReady ? 'available' : 'away';
}
