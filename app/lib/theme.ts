// Theme (Settings → Account → Theme, and ⌘K "Toggle dark mode").
//
// The choice is `<html data-theme="light" | "dark">`; tokens.css carries the
// dark values under `:root[data-theme="dark"]`. "System" is no attribute at
// all: the `prefers-color-scheme` block in tokens.css (guarded by
// `:root:not([data-theme="light"])`) follows the OS, so it tracks live OS
// changes without a listener. Per browser, in localStorage, like prefs.ts.

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'clozr-theme';

/** Inline in <head>, before any paint, so a dark tab never flashes white. */
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

const listeners = new Set<() => void>();

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'dark' || t === 'light' ? t : 'system';
  } catch {
    return 'system';
  }
}

function apply(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
}

export function setTheme(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    // Private mode: the change still applies for this tab.
  }
  apply(t);
  listeners.forEach((l) => l());
}

/** Also follows another tab changing it (the storage event). */
export function subscribeTheme(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === THEME_KEY) {
      apply(getTheme());
      cb();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

/** What is on screen now: the choice, or the OS when it is "system". */
export function isDark(): boolean {
  const t = getTheme();
  if (t !== 'system') return t === 'dark';
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** ⌘K "Toggle dark mode": flips what is on screen and pins it. */
export function toggleTheme() {
  setTheme(isDark() ? 'light' : 'dark');
}

/** The prerender has no localStorage. */
export const serverTheme = (): Theme => 'system';
