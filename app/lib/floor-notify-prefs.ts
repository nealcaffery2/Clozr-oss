// The signed-in user's floor-show notification switches.
//
// The browser copy is what the floor reads on the next event, so a toggle
// takes effect before the profile write returns. The profile columns
// (migration 173) are what the next browser and the next machine read.
// Missing columns, a signed-out demo, or a view-as preview keep the browser copy.
'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { isReadOnly } from './read-only';
import { useSession } from './session';
import { supabase } from './supabase';
import { DEFAULT_FLOOR_NOTIFY, type FloorNotifyPrefs } from './floor-notify';

const KEY = 'clozr.floorNotify.v1';

let user = 'anon';
let snapshot: FloorNotifyPrefs = DEFAULT_FLOOR_NOTIFY;
let snapshotRaw: string | null | undefined;
const listeners = new Set<() => void>();
/** Bumps on a toggle so a profile read already in flight cannot put the old value back. */
let writeSeq = 0;

function storageKey(): string {
  return `${KEY}:${user}`;
}

function coerce(raw: Partial<FloorNotifyPrefs> | null | undefined): FloorNotifyPrefs {
  return {
    leaderboard: raw?.leaderboard !== false,
    badges: raw?.badges !== false,
  };
}

export function getFloorNotifyPrefs(): FloorNotifyPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey());
  } catch {
    return snapshot;
  }
  if (raw === snapshotRaw) return snapshot;
  snapshotRaw = raw;
  try {
    snapshot = raw ? coerce(JSON.parse(raw) as Partial<FloorNotifyPrefs>) : DEFAULT_FLOOR_NOTIFY;
  } catch {
    snapshot = DEFAULT_FLOOR_NOTIFY;
  }
  return snapshot;
}

function publish(next: FloorNotifyPrefs): void {
  snapshot = next;
  try {
    snapshotRaw = JSON.stringify(next);
    localStorage.setItem(storageKey(), snapshotRaw);
  } catch {
    snapshotRaw = JSON.stringify(next);
  }
  listeners.forEach((l) => l());
}

export function subscribeFloorNotify(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** Point the store at this account and, when signed in, take the profile's values. */
export function setFloorNotifyUser(id: string | null): void {
  const next = id || 'anon';
  if (next === user) return;
  user = next;
  snapshotRaw = undefined;
  writeSeq = 0;
  getFloorNotifyPrefs();
  listeners.forEach((l) => l());
  void pull(next);
}

async function pull(id: string): Promise<void> {
  if (!supabase || id === 'anon') return;
  const seq = writeSeq;
  const { data, error } = await supabase
    .from('profiles')
    .select('notify_leaderboard, notify_badges')
    .eq('id', id)
    .maybeSingle();
  if (error || !data || user !== id || writeSeq !== seq) return;
  publish(coerce({
    leaderboard: data.notify_leaderboard,
    badges: data.notify_badges,
  }));
}

export async function setFloorNotify(patch: Partial<FloorNotifyPrefs>): Promise<{ ok: boolean; message?: string }> {
  const next = { ...getFloorNotifyPrefs(), ...patch };
  writeSeq += 1;
  publish(next);
  if (!supabase || user === 'anon' || isReadOnly()) return { ok: true };
  const { error } = await supabase
    .from('profiles')
    .update({ notify_leaderboard: next.leaderboard, notify_badges: next.badges })
    .eq('id', user);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export function useFloorNotifyPrefs(): FloorNotifyPrefs {
  const s = useSession();
  const id = s.user?.id ?? null;
  useEffect(() => { setFloorNotifyUser(id); }, [id]);
  return useSyncExternalStore(subscribeFloorNotify, getFloorNotifyPrefs, () => DEFAULT_FLOOR_NOTIFY);
}
