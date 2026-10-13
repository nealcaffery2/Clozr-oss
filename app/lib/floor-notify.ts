// Which floor-show moments a person still wants announced.
//
// Leaderboard is a pass: someone moved ahead on today's calls, offers, or
// talk time. Badges are the popup, the toast, the sound, and the catch-up
// digest. Contract bells, the wheel, and the prize nudge are not either one.
// Both default on, which is how the floor has always behaved.

export type FloorNotifyPrefs = {
  leaderboard: boolean;
  badges: boolean;
};

export const DEFAULT_FLOOR_NOTIFY: FloorNotifyPrefs = {
  leaderboard: true,
  badges: true,
};

/** True when this floor event should not toast, take over the screen, or play a sound. */
export function floorEventSilenced(kind: string, prefs: FloorNotifyPrefs): boolean {
  if (kind === 'badge' || kind === 'digest') return prefs.badges === false;
  if (kind === 'pass') return prefs.leaderboard === false;
  return false;
}

/** Bell categories these switches own. Wheel and Contract stay visible. */
export function floorBellMutes(prefs: FloorNotifyPrefs): Record<string, boolean> {
  return {
    ...(prefs.leaderboard ? {} : { Leaderboard: true }),
    ...(prefs.badges ? {} : { Badge: true }),
  };
}

/** The one-hour mute, plus a lasting off switch for leaderboard and badge rows. */
export function withFloorBellMutes(
  muted: Record<string, boolean>,
  prefs: FloorNotifyPrefs,
): Record<string, boolean> {
  const extra = floorBellMutes(prefs);
  if (!Object.keys(extra).length) return muted;
  return { ...muted, ...extra };
}
