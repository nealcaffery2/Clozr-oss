// What the floor show remembers: which moments already played, who was
// zeroed after an import, the monthly wheel prize, and who already spun.

import { supabase } from './supabase';
import { loadSettings, saveSettings, type WorkspaceSettings } from './integrations';
import type { FloorBoard, FloorEvent, FloorSnap } from './floor-show';
import { EMPTY_SNAP } from './floor-show';

export type FloorBoardRead = FloorBoard & {
  /** The server's clock when it read, for the next read's `changed`. */
  at: string;
  /** Emails filed since `changed` that this person may read, for the signed-by-email popup. */
  mail: { id: number; subject: string; body: string; owner_id: string | null }[];
};

/**
 * The board's own read (migration 295): deals, offers and calls inside the
 * board's windows, contracts, and the sellers and mail changed since `changed`.
 * Null when it failed or this person is not in the workspace.
 */
export async function loadFloorBoard(workspaceId: number, since: string, changed: string): Promise<FloorBoardRead | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('floor_board' as never, { p_ws: workspaceId, p_since: since, p_changed: changed } as never);
  return error || !data ? null : (data as unknown as FloorBoardRead);
}

const SNAP_KEY = 'clozr.floor.snap.v1';
const SPIN_KEY = 'clozr.floor.spins.v1';
const RESET_KEY = 'clozr.floor.resets.v1';
const NUDGE_KEY = 'clozr.floor.prizeNudge';

export type FloorSettings = {
  monthlyPrize: string;
  monthlyDetail: string;
  updatedAt: string | null;
  resets: Record<string, string>;
};

const listeners = new Set<() => void>();
let resets: Record<string, string> = {};
let prize: { name: string; detail: string; set: boolean } | null = null;
let rev = 0;

function bump() {
  rev += 1;
  listeners.forEach((l) => l());
}

export function subscribeLeaderboardResets(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export function getLeaderboardResets(): Record<string, string> {
  return resets;
}

/** The monthly wheel prize as Settings last saved or loaded it; null until one load. */
export function getMonthlyPrize(): { name: string; detail: string; set: boolean } | null {
  return prize;
}

/**
 * `set` is false when no admin ever saved a prize: the wheel still falls back
 * to AirPods, but Reporting says none is set rather than show a made-up one.
 */
function publishPrize(f: Pick<FloorSettings, 'monthlyPrize' | 'monthlyDetail' | 'updatedAt'>) {
  const set = !!f.updatedAt;
  if (prize && prize.name === f.monthlyPrize && prize.detail === f.monthlyDetail && prize.set === set) return;
  prize = { name: f.monthlyPrize, detail: f.monthlyDetail, set };
  bump();
}

export function getLeaderboardResetRev(): number {
  return rev;
}

export function publishResets(next: Record<string, string>) {
  resets = next;
  try { localStorage.setItem(RESET_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  bump();
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

export function loadSnap(workspaceId: number | null): FloorSnap {
  const all = readJson<Record<string, FloorSnap>>(SNAP_KEY, {});
  return all[String(workspaceId ?? 'demo')] ?? EMPTY_SNAP;
}

export function saveSnap(workspaceId: number | null, snap: FloorSnap) {
  let all: Record<string, FloorSnap> = {};
  try {
    all = JSON.parse(localStorage.getItem(SNAP_KEY) || '{}') as Record<string, FloorSnap>;
  } catch { /* start fresh */ }
  all[String(workspaceId ?? 'demo')] = snap;
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(all)); } catch { /* private mode */ }
}

export function loadSpins(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SPIN_KEY) || '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberSpin(contractId: string) {
  const next = [...new Set([...loadSpins(), contractId])];
  try { localStorage.setItem(SPIN_KEY, JSON.stringify(next)); } catch { /* private mode */ }
}

export function hasSpun(contractId: string): boolean {
  return loadSpins().includes(contractId);
}

export function nudgeShownToday(): boolean {
  try { return localStorage.getItem(NUDGE_KEY) === new Date().toISOString().slice(0, 10); } catch { return false; }
}

export function markNudgeShown() {
  try { localStorage.setItem(NUDGE_KEY, new Date().toISOString().slice(0, 10)); } catch { /* private mode */ }
}

function fromWorkspace(s: WorkspaceSettings): FloorSettings {
  const floor = s.floor_show;
  return {
    monthlyPrize: floor?.monthlyPrize?.trim() || 'AirPods',
    monthlyDetail: floor?.monthlyDetail ?? '',
    updatedAt: floor?.updatedAt ?? null,
    resets: s.leaderboard_resets ?? {},
  };
}

export async function loadFloorSettings(workspaceId: number | null): Promise<FloorSettings> {
  if (!workspaceId) {
    const local = readJson<FloorSettings>(RESET_KEY + '.settings', {
      monthlyPrize: 'AirPods', monthlyDetail: '', updatedAt: null, resets: {},
    });
    publishResets(local.resets ?? {});
    publishPrize(local);
    return local;
  }
  const s = await loadSettings(workspaceId);
  const floor = fromWorkspace(s);
  publishResets(floor.resets);
  publishPrize(floor);
  return floor;
}

export async function saveFloorSettings(workspaceId: number | null, patch: Partial<FloorSettings>): Promise<{ ok: boolean; message?: string }> {
  const current = await loadFloorSettings(workspaceId);
  const next: FloorSettings = {
    monthlyPrize: patch.monthlyPrize ?? current.monthlyPrize,
    monthlyDetail: patch.monthlyDetail ?? current.monthlyDetail,
    updatedAt: patch.updatedAt === undefined ? current.updatedAt : patch.updatedAt,
    resets: patch.resets ?? current.resets,
  };
  publishResets(next.resets);
  publishPrize(next);
  if (!workspaceId) {
    try { localStorage.setItem(RESET_KEY + '.settings', JSON.stringify(next)); } catch { /* private mode */ }
    return { ok: true };
  }
  return saveSettings(workspaceId, {
    floor_show: { monthlyPrize: next.monthlyPrize, monthlyDetail: next.monthlyDetail, updatedAt: next.updatedAt },
    leaderboard_resets: next.resets,
  });
}

export async function resetLeaderboardReps(workspaceId: number | null, ids: string[], at = new Date().toISOString()): Promise<{ ok: boolean; message?: string }> {
  const current = await loadFloorSettings(workspaceId);
  const resets = { ...current.resets };
  for (const id of ids) if (id) resets[id] = at;
  return saveFloorSettings(workspaceId, { resets });
}

export async function clearLeaderboardReset(workspaceId: number | null, id: string): Promise<{ ok: boolean; message?: string }> {
  const current = await loadFloorSettings(workspaceId);
  const resets = { ...current.resets };
  delete resets[id];
  return saveFloorSettings(workspaceId, { resets });
}

/** Tells every admin what the wheel landed on. The bell opens the leaderboard. */
export async function notifyWheelResult(workspaceId: number | null, adminIds: string[], title: string, body: string): Promise<{ ok: boolean; message?: string }> {
  if (!supabase || workspaceId == null || !adminIds.length) return { ok: false, message: 'Saved on this screen. Admins see it in the bell once the workspace is signed in.' };
  const { error } = await supabase.from('notifications').insert(adminIds.map((user_id) => ({
    workspace_id: workspaceId,
    user_id,
    category: 'Wheel',
    title,
    body,
  })));
  return error ? { ok: false, message: error.message } : { ok: true };
}

type PreviewListener = (event: FloorEvent) => void;
const previewListeners = new Set<PreviewListener>();

export function previewFloor(event: FloorEvent) {
  previewListeners.forEach((l) => l(event));
}

export function onFloorPreview(cb: PreviewListener): () => void {
  previewListeners.add(cb);
  return () => void previewListeners.delete(cb);
}
