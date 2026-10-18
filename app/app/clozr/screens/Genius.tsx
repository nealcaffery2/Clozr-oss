// The Genius page: find every cash buyer around any address, not only around a
// deal already in Dispo. The nav item used to highlight and leave you where you
// were; this is where it goes now. Past searches sit in the rail and reopen
// without spending a credit.
'use client';

import React, { useSyncExternalStore } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { GeniusMode } from '@/components/GeniusMode';
import { useSession } from '@/lib/session';
import { DEMO_GENIUS_PAST, DEMO_GENIUS_RUN } from '@/lib/genius-demo';

// The sample-data page has no workspace to search with, so /demo alone shows a
// finished search from memory. Read after hydration: the prerender has no path.
const onDemoRoute = () => typeof window !== 'undefined' && window.location.pathname.startsWith('/demo');
const useDemoRoute = () => useSyncExternalStore(() => () => {}, onDemoRoute, () => false);

export function Genius({ V }: { V: ClozrView }) {
  const session = useSession();
  const demo = useDemoRoute();
  return (
    <section data-screen-label="Genius Mode" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: V.isMobile ? '12px 12px 40px' : '16px 20px 40px', background: 'var(--canvas, #fafafa)' }}>
        {V.liveIds ? (
          <GeniusMode standalone workspaceId={V.liveIds.workspaceId} userId={session.user?.id ?? null}
            canWrite={!!V.liveIds.canWrite} isMobile={V.isMobile} onToast={V.showToast} onAdded={V.reloadCrm}
            onCall={V.genius.call} onQueue={V.genius.queue} onOpenBuyer={V.genius.openBuyer} onCampaign={V.genius.campaign} onAddToMarketing={V.genius.addToMarketing} onShowProspects={V.goBuyerProspects} />
        ) : demo ? (
          <GeniusMode standalone workspaceId={null} userId={null} canWrite={false} isMobile={V.isMobile} onToast={V.showToast} seed={{ run: DEMO_GENIUS_RUN, past: DEMO_GENIUS_PAST }} />
        ) : (
          <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '14px', padding: '22px', fontSize: '13px', color: 'var(--meta, #71717a)', lineHeight: 1.55 }}>
            Genius Mode finds the flippers, landlords and builders buying around any address from public records. Sign in to a workspace to run it.
          </div>
        )}
      </div>
    </section>
  );
}
