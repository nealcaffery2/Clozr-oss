'use client';

// How the offer went: the acquisitions SOP's last step, on the record.
//
// Offer accepted opens the deal and its sheet for the contract; Declined asks
// why, when to follow up and which drip to start; No offer asks why, then Not
// Qualified or a follow-up. It is Today's outcome picker (components/talkr/
// OutcomePicker) showing only those three, so the plan it previews is the one
// it saves, through the same saveOutcome.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { OutcomePicker } from '@/app/components/talkr/OutcomePicker';
import { card } from './ui';

export function OutcomeBar({ V }: { V: ClozrView }) {
  const target = V.recordOutcome;
  if (!target) return null;
  if (V.recordReadOnly) {
    return (
      <section aria-label="How the offer went" data-testid="record-outcome" style={{ ...card, padding: '10px 12px' }}>
        <h2 style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>How the offer went</h2>
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#71717a' }}>Read-only: you can’t log an outcome on this record.</p>
      </section>
    );
  }
  return (
    <section aria-label="How the offer went" data-testid="record-outcome" style={{ ...card, padding: '12px' }}>
      <OutcomePicker
        key={target.key}
        V={V}
        target={target}
        variant="card"
        armed={V.recordOutcomeArmed}
        canPick
        offer="only"
        keysInside
        plans={V.outcomeDrips}
        heading="How the offer went"
        saveLabel={target.mode === 'call' ? 'Save the call' : 'Save outcome'}
      />
    </section>
  );
}
