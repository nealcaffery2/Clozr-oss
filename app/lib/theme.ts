// Theme (Settings → Account → Theme, and ⌘K "Toggle dark mode").
//
// The choice is `<html data-theme="light" | "dark" | "system">`; tokens.css
// carries the dark values under `:root[data-theme="dark"]`, and the
// `prefers-color-scheme` block (guarded by `:root[data-theme="system"]`)
// follows the OS live without a listener. Nothing stored = light, the default.
// Per browser, in localStorage, like prefs.ts.

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'clozr-theme';

/** Inline in <head>, before any paint, so a dark tab never flashes white. */
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='dark'||t==='system')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

const listeners = new Set<() => void>();

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'dark' || t === 'system' ? t : 'light';
  } catch {
    return 'light';
  }
}

function apply(t: Theme) {
  const el = document.documentElement;
  if (t === 'light') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
}

export function setTheme(t: Theme) {
  try {
    if (t === 'light') localStorage.removeItem(THEME_KEY);
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

/** ⌘K "Toggle dark mode" and the shell's theme bubble: flips what is on screen and pins it. */
export function toggleTheme() {
  setTheme(isDark() ? 'light' : 'dark');
}

/** The prerender has no localStorage. */
export const serverTheme = (): Theme => 'light';
