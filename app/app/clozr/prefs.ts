// Display preferences, per browser (Settings → General).
//
// Its own module so the shell can apply them on mount without importing the
// Settings screen, which loads on demand like every other screen.

const PREF_KEY = 'clozr.prefs.v1';

export type Prefs = {
  compactRows: boolean;
};

const DEFAULTS: Prefs = {
  compactRows: false,
};

// Preferences live in localStorage, which is an external store: reading it
// into state inside an effect would be a synchronous setState on mount, and a
// lazy initialiser would disagree with the prerendered HTML. useSyncExternalStore
// is the API for exactly this — it takes a server snapshot for the prerender
// and re-reads on the client without an effect.
//
// The snapshot is cached because the hook compares by identity: parsing fresh
// JSON on every call would return a new object each time and loop forever.
let snapshot: Prefs = DEFAULTS;
let snapshotRaw: string | null = null;
const listeners = new Set<() => void>();

export function readPrefs(): Prefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREF_KEY);
  } catch {
    return snapshot;
  }
  if (raw === snapshotRaw) return snapshot;
  snapshotRaw = raw;
  try {
    snapshot = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS;
  } catch {
    snapshot = DEFAULTS;
  }
  return snapshot;
}

/** Compact rows is a class on <body>; app/globals.css does the rest. */
function applyPrefs(p: Prefs) {
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('compact-rows', p.compactRows);
}

/** Called once when the shell mounts, so the preference holds on every screen, not only after Settings opens. */
export function applyStoredPrefs() {
  applyPrefs(readPrefs());
}

export function writePrefs(next: Prefs) {
  snapshot = next;
  try {
    snapshotRaw = JSON.stringify(next);
    localStorage.setItem(PREF_KEY, snapshotRaw);
  } catch {
    // Private mode: the change still applies for this session.
  }
  applyPrefs(next);
  listeners.forEach((l) => l());
}

export function subscribePrefs(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The prerender has no localStorage, so it renders the defaults. */
export function serverPrefs(): Prefs {
  return DEFAULTS;
}
