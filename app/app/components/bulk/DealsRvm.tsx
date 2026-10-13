'use client';

// Deals → RVM sellers: a ringless voicemail to the seller on every deal the
// list shows (its filters and search), each drop filed on its own deal. Every
// role that can open Deals can send it, the transaction coordinator included,
// who has no People list to send from.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { useSession } from '@/lib/session';
import { BulkCompose, type BulkPerson } from './BulkCompose';

export function DealsRvm({ bulk, people, onClose }: { bulk: ClozrView['dealsRvm']; people: BulkPerson[]; onClose: () => void }) {
  const session = useSession();
  return (
    <BulkCompose
      kind="seller"
      channel="rvm"
      people={people}
      workspaceId={bulk.workspaceId}
      canWrite={bulk.canWrite}
      userId={session.user?.id ?? null}
      rep={{ ...bulk.textCtx, repPhone: session.profile?.phone ?? '', repEmail: session.user?.email ?? '' }}
      testTo={session.user?.email ?? null}
      toast={bulk.toast}
      onSent={() => bulk.reload?.()}
      onClose={onClose}
    />
  );
}

/** One person per seller: two deals on one seller send one drop (the first deal the list shows). */
export function dealSellers(rows: readonly { rvmSeller?: BulkPerson | null }[]): BulkPerson[] {
  const seen = new Set<number>();
  const out: BulkPerson[] = [];
  for (const r of rows) {
    const p = r.rvmSeller;
    if (!p || seen.has(p.dbId)) continue;
    seen.add(p.dbId);
    out.push(p);
  }
  return out;
}
