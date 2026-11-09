'use client';

// Coaching: the AI Sales Manager screen (call reviews, flagged calls, rep
// scorecards, roleplay). Owners and admins see the team; reps see their own.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { SalesManager, salesManagerBlurb } from '@/app/components/coaching/SalesManager';
import { ScreenFrame, ScreenHeader } from '@/components/ds/Screen';

export function Coaching({ V }: { V: ClozrView }) {
  const admin = !!V.reportAdmin;
  return (
    <ScreenFrame data-screen-label="Coaching" header={
      <ScreenHeader title="AI Sales Manager">
        <p className="ds-prose" style={{ margin: 0, fontSize: '12.5px', color: 'var(--muted, #52525b)' }}>{salesManagerBlurb(admin)}</p>
      </ScreenHeader>
    }>
      <SalesManager
        titled={false}
        workspaceId={V.liveIds?.workspaceId ?? null}
        me={V.liveIds?.userId ?? null}
        admin={admin}
        isMobile={V.isMobile}
        toast={V.showToast}
      />
    </ScreenFrame>
  );
}
