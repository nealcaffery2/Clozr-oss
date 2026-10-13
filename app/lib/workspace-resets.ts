// What a workspace switch throws away.
//
// Screens that read `useSession().workspace` re-render onto the new id, and
// `useCrm` already treats a different id as not loaded. These are the copies
// that live outside that render: module caches, the "view as" preview, and
// every realtime channel, which would otherwise keep delivering the previous
// workspace until its effect cleaned up.

import { clearEmailHtmlCache } from './email-document-cache';
import { forgetLineNames } from './line-names';
import { forgetLinePools } from './line-pools';
import { forgetTeamPhotos } from './avatar';
import { clearReadiness } from './dialer-readiness';
import { publishResets } from './floor-store';
import { onWorkspaceReset } from './active-workspace';
import { supabase } from './supabase';
import { invalidateCallContext } from './talkr-web/callContext';
import { stopViewAs } from './view-as';

const CAMPAIGN_PREFIX = 'clozr:campaign:';

function clearCampaignHandoff(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(CAMPAIGN_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch { /* private mode */ }
}

let installed = false;

/** Idempotent. Session installs this once, before any switch can fire. */
export function installWorkspaceResets(): void {
  if (installed) return;
  installed = true;
  onWorkspaceReset(() => {
    forgetLinePools();
    forgetLineNames();
    forgetTeamPhotos();
    invalidateCallContext();
    clearEmailHtmlCache();
    clearReadiness();
    publishResets({});
    stopViewAs();
    clearCampaignHandoff();
    if (supabase) void supabase.removeAllChannels();
  });
}
