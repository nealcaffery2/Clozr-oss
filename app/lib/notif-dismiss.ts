// Which notifications the bell still shows, and which database rows a
// "mark read" click is allowed to update.
//
// Missed calls and texts are synthesized from communications (bell-call-*,
// bell-sms-*). They have no notifications row, so dismissing them is local.
// A real note is `n` plus the numeric id.

const NOTIF_KEY = 'clozr.notifDismissed';

export function notificationDbIds(ids: string[]): number[] {
  const out: number[] = [];
  for (const id of ids) {
    if (!/^n\d+$/.test(id)) continue;
    const n = Number(id.slice(1));
    if (Number.isInteger(n)) out.push(n);
  }
  return out;
}

export function mergeDismissed(prev: Record<string, boolean>, ids: string[]): Record<string, boolean> {
  if (!ids.length) return prev;
  const next = { ...prev };
  for (const id of ids) next[id] = true;
  return next;
}

/** How long the nth row waits before it starts leaving, so a pile cascades. */
export function dismissDelay(index: number): number {
  return Math.min(Math.max(index, 0), 14) * 46;
}

export function visibleNotifs<T extends { id: string; cat: string; unread: boolean }>(
  items: T[],
  read: Record<string, boolean>,
  cat: string,
  muted: Record<string, boolean>,
): T[] {
  return items.filter((n) => n.unread && !read[n.id] && !muted[n.cat] && (cat === 'All' || n.cat === cat));
}

export function loadDismissedNotifs(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(NOTIF_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(-400) : [];
  } catch {
    return [];
  }
}

export function saveDismissedNotifs(ids: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(NOTIF_KEY, JSON.stringify([...new Set(ids)].slice(-400)));
  } catch { /* private mode */ }
}

/**
 * Everyone's bell, owners and admins included: only what is theirs.
 * - A notification addressed to them (direct).
 * - A missed call, voicemail or text in their conversation: the rep on it, or
 *   the owner of the line it came in on (owner).
 * - One with no known rep: the rep the record is assigned to; with nobody
 *   assigned either, the workspace owner (isOwner).
 * Someone else's conversation, record or team-wide item is not in it.
 */
export function forRep<T extends { direct?: boolean; owner?: string | null; link: { screen: string; id: string } }>(
  items: T[], me: string, sellerRep: Map<string, string | null>, buyerRep: Map<string, string | null>, isOwner = false,
): T[] {
  return items.filter((n) => {
    if (n.direct) return true;
    if (n.owner) return n.owner === me;
    const { screen, id } = n.link;
    const assigned = screen === 'person' || screen === 'tc' ? sellerRep.get(id) : screen === 'buyer' ? buyerRep.get(id) : undefined;
    if (assigned) return assigned === me;
    return n.owner === null && isOwner;
  });
}
