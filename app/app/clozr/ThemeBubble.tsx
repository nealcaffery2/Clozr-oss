'use client';

// The light/dark switch: a row in the account menu (ThemeMenuItem). Light is the default; Settings → Theme
// still offers System.

import { useSyncExternalStore } from 'react';
import { isDark, subscribeTheme, toggleTheme } from '@/lib/theme';

/** The switch as a row in the account menu. It used to float over the screens. */
export function ThemeMenuItem({ onDone }: { onDone?: () => void }) {
  const dark = useSyncExternalStore(subscribeTheme, isDark, () => false);
  return (
    <button
      type="button"
      role="menuitem"
      className="dc2"
      data-theme-bubble
      onClick={() => { toggleTheme(); onDone?.(); }}
      style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left', height: '34px', padding: '0 10px', border: 0, borderRadius: '8px', background: 'none', cursor: 'pointer', fontSize: '13px', color: 'var(--ink, #18181b)' }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--meta, #71717a)' }}>
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </>
        ) : (
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        )}
      </svg>
      {dark ? 'Light mode' : 'Dark mode'}
    </button>
  );
}
