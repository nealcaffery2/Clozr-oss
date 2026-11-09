// The two AI entry points that live on screen headers: Lane (the TC assistant)
// and Genius Mode (nearby cash buyers). One look everywhere so they read as
// the same kind of thing.
'use client';

import React from 'react';
import { Button } from '@/components/ds/Button';
import { Mark } from '@/components/ds/mark';

/** The product's mark, in its own colour; the button itself is the house ghost (DESIGN.md §2). */
const ICON = {
  lane: <span style={{ display: 'inline-flex', color: 'var(--c-lane, #db2777)' }}><Mark label="Lane" size={14} /></span>,
} as const;

export function AiButton({ kind, onClick, children }: { kind: keyof typeof ICON; onClick: () => void; children?: React.ReactNode }) {
  return (
    <Button onClick={onClick} icon={ICON[kind]}>
      {children ?? 'Lane'}
    </Button>
  );
}
