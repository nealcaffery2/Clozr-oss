'use client';

// The People list's half of the bulk composer: the selection and the signed-in
// rep's own signature fields handed to BulkCompose. Nothing renders until
// somebody presses Text or Email on more than one person.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { useSession } from '@/lib/session';
import { BulkCompose } from './BulkCompose';

export function PeopleBulkCompose({ bulk }: { bulk: ClozrView['peopleBulk'] }) {
  const session = useSession();
  if (!bulk.channel) return null;
  return (
    <BulkCompose
      kind={bulk.kind}
      channel={bulk.channel}
      people={bulk.people}
      workspaceId={bulk.workspaceId}
      canWrite={bulk.canWrite}
      userId={session.user?.id ?? null}
      rep={{ ...bulk.textCtx, repPhone: session.profile?.phone ?? '', repEmail: session.user?.email ?? '' }}
      testTo={session.user?.email ?? null}
      toast={bulk.toast}
      onSent={() => bulk.reload?.()}
      onClose={bulk.close}
    />
  );
}
