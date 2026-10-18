'use client';

// Coaching: the AI Sales Manager screen (call reviews, flagged calls, rep
// scorecards, roleplay). Owners and admins see the team; reps see their own.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { SalesManager } from '@/app/components/coaching/SalesManager';

export function Coaching({ V }: { V: ClozrView }) {
  return (
    <section data-screen-label="Coaching" style={{ flex: '1', minWidth: '0', overflow: 'auto', padding: V.isMobile ? '12px 12px 40px' : '16px 20px 40px', background: 'var(--canvas, #fafafa)' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <SalesManager
          workspaceId={V.liveIds?.workspaceId ?? null}
          me={V.liveIds?.userId ?? null}
          admin={!!V.reportAdmin}
          isMobile={V.isMobile}
          toast={V.showToast}
        />
      </div>
    </section>
  );
}
