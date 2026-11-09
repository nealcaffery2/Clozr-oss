'use client';

// The deal blast label on a thread (lib/inbox-blast-tags): the street of the
// newest deal blast that reached them, solid CLOZR green so a buyer's reply
// to a blast is the first thing the eye lands on, "+1" when more than one
// deal reached them (every street and send date in the title). Beside it,
// "Buyer prospect" when the buyer is still a prospect.

import React from 'react';
import { House } from 'lucide-react';
import type { BlastTag } from '@/lib/inbox-blast-tags';

const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');

export function BlastChip({ tag }: { tag: BlastTag | null | undefined }) {
  const first = tag?.deals[0];
  if (!tag || !first) return null;
  const more = tag.deals.length - 1;
  const title = tag.deals.map((d) => `${d.line1}, blast sent ${day(d.lastSentAt)}`).join('\n');
  return (
    <span className="ax-blast" title={title} data-testid="inbox-blast-chip">
      <House size={11} strokeWidth={2.5} aria-hidden />
      <span className="sr-only">Deal blast: </span>
      <span className="ax-blast-addr">{first.line1}</span>
      {more > 0 ? <span className="ax-blast-more" aria-label={`and ${more} more`}>+{more}</span> : null}
    </span>
  );
}

export function ProspectChip({ tag }: { tag: BlastTag | null | undefined }) {
  return tag?.prospect ? <span className="ax-prospect" title="Still a prospect: not a confirmed buyer yet">Buyer prospect</span> : null;
}
