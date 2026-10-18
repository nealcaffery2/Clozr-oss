// Asks Google for new mail when a mail view comes back into view: the tab
// regains focus or becomes visible, and once when the view mounts. Throttled
// to once a minute per workspace (lib/mail-focus.ts); the server reads new
// mail every minute regardless, so this only closes the gap to that tick.
// New rows reach the screen through the views' own realtime subscriptions.
'use client';

import { useEffect } from 'react';
import { pullNewMail } from '@/lib/google';

export function useMailOnFocus(workspaceId: number | null | undefined): void {
  useEffect(() => {
    if (workspaceId == null) return;
    const ask = () => { void pullNewMail(workspaceId)?.catch(() => null); };
    const onVisible = () => { if (document.visibilityState === 'visible') ask(); };
    ask();
    window.addEventListener('focus', ask);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', ask);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [workspaceId]);
}
