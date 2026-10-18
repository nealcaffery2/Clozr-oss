'use client';

/** One-hour bell mutes, persisted per user in this browser (like phone-audio prefs). */

const KEY = 'clozr.bellMute.v1';
let user = 'anon';

export type BellMuteState = {
  mutedCats: Record<string, boolean>;
  mutedUntil: Record<string, number>;
};

export function setBellMuteUser(id: string | null): BellMuteState {
  user = id || 'anon';
  return loadBellMutes();
}

function prune(raw: BellMuteState): BellMuteState {
  const now = Date.now();
  const mutedCats: Record<string, boolean> = {};
  const mutedUntil: Record<string, number> = {};
  for (const [cat, until] of Object.entries(raw.mutedUntil)) {
    if (raw.mutedCats[cat] && until > now) {
      mutedCats[cat] = true;
      mutedUntil[cat] = until;
    }
  }
  return { mutedCats, mutedUntil };
}

export function loadBellMutes(): BellMuteState {
  try {
    const raw = localStorage.getItem(`${KEY}:${user}`);
    if (!raw) return { mutedCats: {}, mutedUntil: {} };
    return prune(JSON.parse(raw) as BellMuteState);
  } catch {
    return { mutedCats: {}, mutedUntil: {} };
  }
}

export function saveBellMutes(state: BellMuteState): void {
  try {
    localStorage.setItem(`${KEY}:${user}`, JSON.stringify(prune(state)));
  } catch {
    /* private mode */
  }
}

export function isBellCatMuted(cat: string, state: BellMuteState, now = Date.now()): boolean {
  return !!state.mutedCats[cat] && (state.mutedUntil[cat] ?? 0) > now;
}
