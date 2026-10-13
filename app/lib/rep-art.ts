// The leaderboard's character art : each rep's cartoon, matched on first name. The board shows the
// character first, then the rep's profile photo, then initials.

// Add your own reps' art here, keyed by lowercase first name, e.g.
//   sam: '/art/sam.png',
const ART: Record<string, string> = {};

export function repArt(name: string | null | undefined): string | null {
  const first = String(name ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return ART[first] ?? null;
}

/** The face the leaderboard draws: character art, else profile photo, else '' (initials). */
export const boardFace = (name: string | null | undefined, photo: string | null | undefined) => repArt(name) || photo || '';
