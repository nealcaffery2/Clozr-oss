/**
 * One Clozr tab registers the Telnyx softphone.
 *
 * A second tab under the same login is a second WebRTC registration. Telnyx
 * then forks the browser leg, and the tab that is not on the call answers
 * 486 or lets it die 487. The lock is a localStorage row plus a
 * BroadcastChannel so the other tab hears a takeover without waiting for the
 * row to go stale.
 *
 * When the browser has the Web Locks API, that is the real exclusion: it
 * drops the moment the tab crashes or navigates, which a heartbeat cannot.
 * The row and the channel stay, so a tab can see who holds the phone and
 * hear a takeover immediately. Without `navigator.locks`, the row is the
 * whole mechanism.
 *
 * The tab id lives in sessionStorage. A reload of this tab is the same id,
 * so it reclaims its own row instead of waiting out the stale window as if
 * it were someone else. A generation on the row keeps the dying page's
 * pagehide from erasing the row the reloaded page just wrote.
 */

export const SOFTPHONE_LOCK_KEY = 'clozr-softphone-owner';
export const SOFTPHONE_LOCK_CHANNEL = 'clozr-softphone';
export const SOFTPHONE_TAB_KEY = 'clozr-softphone-tab';
export const SOFTPHONE_SEQ_KEY = 'clozr-softphone-seq';
/** A tab that crashed stops heartbeating. After this, another tab may register. */
export const SOFTPHONE_LOCK_STALE_MS = 8_000;
export const SOFTPHONE_LOCK_HEARTBEAT_MS = 2_000;

export const PHONE_OTHER_TAB = 'Phone is open in another tab';
export const USE_PHONE_HERE = 'Use phone here';

export type SoftphoneLockRow = { tabId: string; at: number; seq?: number };

export type LockDecision = 'free' | 'mine' | 'other';

export function parseSoftphoneLock(raw: string | null | undefined): SoftphoneLockRow | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { tabId?: unknown; at?: unknown; seq?: unknown };
    if (typeof parsed.tabId !== 'string' || !parsed.tabId) return null;
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return null;
    const row: SoftphoneLockRow = { tabId: parsed.tabId, at: parsed.at };
    if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) row.seq = parsed.seq;
    return row;
  } catch {
    return null;
  }
}

/** Whether this tab may register. A fresh row owned by someone else blocks it. */
export function lockDecision(row: SoftphoneLockRow | null, selfId: string, now: number, staleMs = SOFTPHONE_LOCK_STALE_MS): LockDecision {
  if (!row) return 'free';
  if (now - row.at >= staleMs) return 'free';
  return row.tabId === selfId ? 'mine' : 'other';
}

/**
 * A hidden or background tab must not register the phone on its own. Only a
 * tab the rep is looking at may. A press still can: that is a choice, not a
 * race between restored tabs.
 */
export function mayAutoAcquirePhone(doc: { visibilityState?: string; hasFocus?: () => boolean } | null | undefined): boolean {
  if (!doc || doc.visibilityState !== 'visible') return false;
  if (typeof doc.hasFocus !== 'function') return true;
  try {
    return doc.hasFocus();
  } catch {
    return false;
  }
}

/**
 * Call while another tab holds the phone. The press does not steal: that
 * would register a second softphone under a call that is live over there.
 * It names the other tab and offers the button that does take the lock.
 * Null when this tab may dial.
 */
export function callWhileLockedElsewhere(decision: LockDecision): { message: typeof PHONE_OTHER_TAB; action: typeof USE_PHONE_HERE } | null {
  if (decision !== 'other') return null;
  return { message: PHONE_OTHER_TAB, action: USE_PHONE_HERE };
}

export type LockStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type LockChannel = {
  postMessage(data: unknown): void;
  close(): void;
  addEventListener?(type: 'message', fn: (event: { data?: unknown }) => void): void;
};

/** The slice of the Web Locks API this file uses. Tests pass a fake. */
export type WebLockManager = {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean; steal?: boolean },
    callback: (lock: { name: string } | null) => Promise<unknown> | unknown,
  ): Promise<unknown>;
};

export type UnloadTarget = {
  addEventListener(type: 'pagehide' | 'beforeunload', fn: () => void): void;
  removeEventListener(type: 'pagehide' | 'beforeunload', fn: () => void): void;
};

type LockMessage = { type: 'hold' | 'release' | 'takeover'; tabId: string };

export type SoftphoneLock = {
  readonly tabId: string;
  tryHold(): 'ok' | 'other';
  takeover(): void;
  release(): void;
  holding(): boolean;
  /** Who the row says owns the phone right now. */
  status(): LockDecision;
  destroy(): void;
};

function browserLocks(): WebLockManager | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: WebLockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return null;
  return locks;
}

function browserSession(): LockStorage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function browserWindow(): UnloadTarget | null {
  if (typeof window === 'undefined') return null;
  return window;
}

/** Same id across a reload of this tab. A new tab gets a new one. */
export function persistTabId(session: LockStorage | null, explicit?: string): string {
  if (explicit) {
    try { session?.setItem(SOFTPHONE_TAB_KEY, explicit); } catch { /* private mode */ }
    return explicit;
  }
  try {
    const existing = session?.getItem(SOFTPHONE_TAB_KEY);
    if (existing) return existing;
  } catch { /* private mode */ }
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  try { session?.setItem(SOFTPHONE_TAB_KEY, id); } catch { /* private mode */ }
  return id;
}

function takeSeq(session: LockStorage | null): number {
  let cur = 0;
  try { cur = Number(session?.getItem(SOFTPHONE_SEQ_KEY) ?? 0); } catch { /* private mode */ }
  const next = Number.isFinite(cur) && cur > 0 ? cur + 1 : 1;
  try { session?.setItem(SOFTPHONE_SEQ_KEY, String(next)); } catch { /* private mode */ }
  return next;
}

export function createSoftphoneLock(opts: {
  tabId?: string;
  now?: () => number;
  storage?: LockStorage | null;
  /** sessionStorage. Defaults to the page's. Pass null in tests that set tabId. */
  session?: LockStorage | null;
  channel?: LockChannel | null;
  /** Web Locks. Defaults to navigator.locks. Pass null to force the storage fallback. */
  locks?: WebLockManager | null;
  /** pagehide / beforeunload target. Defaults to window. Pass null in tests. */
  unload?: UnloadTarget | null;
  onLost?: () => void;
  staleMs?: number;
  /** Tests pass null to skip the heartbeat timer. */
  heartbeatMs?: number | null;
} = {}): SoftphoneLock {
  const session = opts.session === undefined ? browserSession() : opts.session;
  const tabId = persistTabId(session, opts.tabId);
  const now = opts.now ?? (() => Date.now());
  const staleMs = opts.staleMs ?? SOFTPHONE_LOCK_STALE_MS;
  const storage = opts.storage === undefined && typeof localStorage !== 'undefined' ? localStorage : opts.storage ?? null;
  const channel = opts.channel === undefined && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(SOFTPHONE_LOCK_CHANNEL)
    : opts.channel ?? null;
  const locks = opts.locks === undefined ? browserLocks() : opts.locks;
  const unload = opts.unload === undefined ? browserWindow() : opts.unload;
  let held = false;
  let closed = false;
  let mySeq = 0;
  let webRelease: (() => void) | null = null;

  const read = () => parseSoftphoneLock(storage?.getItem(SOFTPHONE_LOCK_KEY) ?? null);
  const write = () => {
    storage?.setItem(SOFTPHONE_LOCK_KEY, JSON.stringify({ tabId, at: now(), seq: mySeq } satisfies SoftphoneLockRow));
  };
  const releaseRow = () => {
    const row = read();
    // A reload already wrote a newer generation under this same tab id.
    // Clearing it here is how a dying page locks the new one out.
    if (row?.tabId === tabId && (row.seq == null || row.seq === mySeq)) storage?.removeItem(SOFTPHONE_LOCK_KEY);
  };
  const publish = (type: LockMessage['type']) => {
    try { channel?.postMessage({ type, tabId } satisfies LockMessage); } catch { /* channel already closed */ }
  };

  const lose = () => {
    if (!held) return;
    held = false;
    const end = webRelease;
    webRelease = null;
    end?.();
    opts.onLost?.();
  };

  /**
   * Ask the Web Lock manager. true = we hold it, false = someone else does,
   * null = the grant is still pending (real browsers invoke the callback
   * later) or the API threw, and the storage row stands until it answers.
   * A pending denial calls onLost.
   */
  const settleWeb = (steal: boolean): boolean | null => {
    if (!locks) return null;
    if (webRelease) return true;
    let saw = false;
    let granted = false;
    try {
      void locks.request(
        SOFTPHONE_LOCK_KEY,
        steal ? { mode: 'exclusive', steal: true } : { mode: 'exclusive', ifAvailable: true },
        (lock) => {
          saw = true;
          if (!lock) {
            granted = false;
            if (held) {
              held = false;
              releaseRow();
              opts.onLost?.();
            }
            return undefined;
          }
          granted = true;
          return new Promise<void>((resolve) => {
            webRelease = () => {
              if (webRelease) webRelease = null;
              resolve();
            };
          });
        },
      ).catch(() => {
        if (held) lose();
      });
    } catch {
      return null;
    }
    return saw ? granted : null;
  };

  channel?.addEventListener?.('message', (event) => {
    const msg = event.data as LockMessage | undefined;
    if (!msg || msg.tabId === tabId) return;
    if (msg.type === 'takeover' || msg.type === 'hold') lose();
  });

  const beat = () => {
    if (closed || !held) return;
    const decision = lockDecision(read(), tabId, now(), staleMs);
    if (decision === 'other') {
      lose();
      return;
    }
    write();
  };
  const heartbeatMs = opts.heartbeatMs === undefined ? SOFTPHONE_LOCK_HEARTBEAT_MS : opts.heartbeatMs;
  const timer = heartbeatMs && typeof setInterval !== 'undefined' ? setInterval(beat, heartbeatMs) : null;

  const onGone = () => {
    if (closed) return;
    release();
  };
  unload?.addEventListener('pagehide', onGone);
  unload?.addEventListener('beforeunload', onGone);

  const release = () => {
    if (!held && !webRelease) return;
    held = false;
    releaseRow();
    publish('release');
    const end = webRelease;
    webRelease = null;
    end?.();
  };

  return {
    tabId,
    holding: () => held,
    status: () => lockDecision(read(), tabId, now(), staleMs),
    tryHold() {
      if (closed) return 'other';
      const decision = lockDecision(read(), tabId, now(), staleMs);
      if (decision === 'other') return 'other';
      // Our own row (a reload) may steal the Web Lock the dying document
      // still holds. A free row must not: ifAvailable backs off when another
      // tab holds the Web Lock without a fresh row.
      const web = settleWeb(decision === 'mine');
      if (web === false) return 'other';
      held = true;
      mySeq = takeSeq(session);
      write();
      publish('hold');
      return 'ok';
    },
    takeover() {
      if (closed) return;
      const web = settleWeb(true);
      if (web === false) return;
      held = true;
      mySeq = takeSeq(session);
      write();
      publish('takeover');
    },
    release,
    destroy() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      unload?.removeEventListener('pagehide', onGone);
      unload?.removeEventListener('beforeunload', onGone);
      if (held || webRelease) {
        held = false;
        releaseRow();
        publish('release');
        const end = webRelease;
        webRelease = null;
        end?.();
      }
      try { channel?.close(); } catch { /* already closed */ }
    },
  };
}
