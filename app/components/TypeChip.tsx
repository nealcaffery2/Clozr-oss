// Who a contact is — Seller, Buyer, Lender, Title … — as a small colour-coded
// label (lib/people-colors). Soft rounded tag (iOS), not a full pill.
'use client';

import React from 'react';
import { typeTone } from '@/lib/people-colors';
import { Mark } from '@/components/ds/mark';

export function TypeChip({ kind, label }: { kind: string; label?: string }) {
  const t = typeTone(kind);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 7px', borderRadius: 6,
      font: '700 11px/1 var(--font-sans)', whiteSpace: 'nowrap',
      color: t.fg, background: t.bg, border: `1px solid ${t.line}`, flex: 'none',
    }}>
      <Mark label={label ?? kind} size={12} />
      {label ?? kind}
    </span>
  );
}
