'use client';

// Today: a short read of the workspace cold-email pool. Hidden when the
// workspace has no pool mailboxes, and when the function is not deployed yet.

import React, { useState } from 'react';
import { type ColdOverview, coldPool } from '@/lib/cold-pool';
import { pct } from './ui';

export function ColdHealthCard({ workspaceId, demo }: { workspaceId: number | null; demo: boolean }) {
  const [health, setHealth] = useState<ColdOverview['health'] | null>(null);
  const [forId, setForId] = useState<number | null>(null);
  const want = !demo && workspaceId ? workspaceId : null;
  if (forId !== want) {
    setForId(want);
    setHealth(null);
    if (want) {
      void coldPool<ColdOverview['health']>(want, 'health').then((r) => {
        if (r.ok) setHealth(r.data);
      });
    }
  }
  const boxes = health?.mailboxes ?? [];
  if (!boxes.length) return null;
  const sent = boxes.reduce((n, r) => n + Number(r.sent_7d ?? 0), 0);
  const bounced = boxes.reduce((n, r) => n + Number(r.bounced_7d ?? 0), 0);
  const replied = boxes.reduce((n, r) => n + Number(r.replied_7d ?? 0), 0);
  return (
    <div data-testid="cold-health" style={{ margin: '0 16px 12px', background: 'var(--surface, #ffffff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--meta, #71717a)', marginBottom: 4 }}>Cold email, last 7 days</div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink, #18181b)' }}>
        {boxes.length} {boxes.length === 1 ? 'mailbox' : 'mailboxes'} · {sent} sent · bounce {pct(sent ? bounced / sent : 0)} · reply {pct(sent ? replied / sent : 0)}
      </div>
    </div>
  );
}
