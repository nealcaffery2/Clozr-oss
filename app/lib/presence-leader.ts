/**
 * One tab per browser sends the Talkr presence heartbeat.
 *
 * Every open CLOZR tab used to beat on its own, so a rep with five tabs sent
 * five heartbeats a minute that all said the same thing. Now one tab leads:
 * a localStorage row names it and runs out on its own, so a closed or crashed
 * leader is replaced without anyone cleaning up after it.
 *
 * The tab that holds the softphone wins over one that does not, because only
 * it can say "available" truthfully (heartbeatStatus). A hidden leader steps
 * down so a tab the rep is looking at takes over, which hears the release
 * through the storage event and beats straight away.
 *
 * When storage is blocked or throws, every tab beats, as before.
 */

export const PRESENCE_LEADER_KEY = 'clozr-presence-leader:';
/** How often the leading tab beats. */
export const PRESENCE_BEAT_MS = 60_000;
/** A leader that stops renewing is replaced after this. Longer than a beat, so a slow timer does not hand over. */
export const PRESENCE_LEADER_TTL_MS = 90_000;

export type LeaderRow = { tabId: string; until: number; phone: boolean };

export type LeaderStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Where storage events come from. Tests pass a fake. */
export type StorageEvents = {
  addEventListener(type: 'storage', fn: (e: { key: string | null; newValue: string | null }) => void): void;
  removeEventListener(type: 'storage', fn: (e: { key: string | null; newValue: string | null }) => void): void;
};

export function parseLeaderRow(raw: string | null | undefined): LeaderRow | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { tabId?: unknown; until?: unknown; phone?: unknown };
    if (typeof p.tabId !== 'string' || !p.tabId) return null;
    if (typeof p.until !== 'number' || !Number.isFinite(p.until)) return null;
    return { tabId: p.tabId, until: p.until, phone: p.phone === true };
  } catch {
    return null;
  }
}

/**
 * Whether this tab should send the beat: nobody leads, the row has run out,
 * the row is this tab's, or this tab holds the phone and the leader does not.
 */
export function leadsBeat(row: LeaderRow | null, selfId: string, now: number, hasPhone: boolean): boolean {
  if (!row || row.until <= now) return true;
  if (row.tabId === selfId) return true;
  return hasPhone && !row.phone;
}

export type PresenceLeader = {
  readonly tabId: string;
  /** Claims or renews the beat. True when this tab should send it. */
  claim(hasPhone: boolean): boolean;
  /** Lets go of the beat if this tab holds it, so another tab takes over now. */
  release(): void;
  /** Another tab let go of the beat. Returns the unsubscribe. */
  onFreed(fn: () => void): () => void;
};

function newTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function browserStorage(): LeaderStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** `scope` keeps two Talkr users in one browser from sharing a leader (the Talkr user id). */
export function createPresenceLeader(
  scope: string,
  opts: { storage?: LeaderStorage | null; events?: StorageEvents | null; now?: () => number; tabId?: string; ttlMs?: number } = {},
): PresenceLeader {
  const key = PRESENCE_LEADER_KEY + scope;
  const storage = opts.storage !== undefined ? opts.storage : browserStorage();
  const events = opts.events !== undefined ? opts.events : typeof window === 'undefined' ? null : (window as unknown as StorageEvents);
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? PRESENCE_LEADER_TTL_MS;
  const tabId = opts.tabId ?? newTabId();
  return {
    tabId,
    claim(hasPhone) {
      if (!storage) return true;
      try {
        const t = now();
        if (!leadsBeat(parseLeaderRow(storage.getItem(key)), tabId, t, hasPhone)) return false;
        const row: LeaderRow = { tabId, until: t + ttl, phone: hasPhone };
        storage.setItem(key, JSON.stringify(row));
        return true;
      } catch {
        return true;
      }
    },
    release() {
      if (!storage) return;
      try {
        if (parseLeaderRow(storage.getItem(key))?.tabId === tabId) storage.removeItem(key);
      } catch {
        /* nothing to hand over */
      }
    },
    onFreed(fn) {
      if (!events) return () => undefined;
      const on = (e: { key: string | null; newValue: string | null }) => {
        // A cleared storage (key null) frees it too.
        if (e.key === null || (e.key === key && e.newValue === null)) fn();
      };
      events.addEventListener('storage', on);
      return () => events.removeEventListener('storage', on);
    },
  };
}
