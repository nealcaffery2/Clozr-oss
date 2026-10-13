// The React side of the read-only preview (lib/read-only.ts).
//
// The fetch guard is what actually stops a write. This is what lets a screen
// say so up front: a save or send button reads useCanWrite() and turns itself
// off with a "Read-only preview" tooltip, instead of being clicked and refused.
'use client';

import { createContext, useContext, useLayoutEffect } from 'react';
import { setReadOnly } from './read-only';

export const ReadOnlyContext = createContext(false);

/** False while an admin previews a teammate; buttons that save or send read it. */
export const useCanWrite = () => !useContext(ReadOnlyContext);

/** The tooltip a disabled save or send button shows during a preview. */
export const READ_ONLY_TITLE = 'Read-only preview';

/**
 * Turn the fetch guard on for as long as `readOnly` holds, and off the moment
 * it stops or the page unmounts. A layout effect, so it is in place before any
 * child's ordinary effect can fire a save, and so a remounted page's cleanup
 * runs before the new mount turns it back on rather than after.
 */
export function useReadOnlyWrites(readOnly: boolean) {
  useLayoutEffect(() => {
    if (!readOnly) return;
    setReadOnly(true);
    return () => setReadOnly(false);
  }, [readOnly]);
}
