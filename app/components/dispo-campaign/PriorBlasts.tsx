'use client';

// The launch warning both builders show before sending: buyers a blast for
// this same property already reached (any rep's campaign) are left out unless
// the rep switches on "Send again". The tick enforces the same thing server-side
// (lib/blast-dupes.ts waveRepeats), unless the campaign was launched with
// it on (settings.sendRepeats).

import React, { useEffect, useState } from 'react';
import { loadPriorSends } from '@/lib/dispo-campaign';
import { type Dupes, type PriorSend, dupeWarning } from '@/lib/blast-dupes';
import { Note, Switch } from './ui';

/** Reads the deal's earlier sends each time the confirm opens. `prior` is null while it reads. */
export function usePriorBlasts(workspaceId: number, dealId: number, me: string | null, open: boolean, skip = false) {
  const [prior, setPrior] = useState<PriorSend[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resend, setResend] = useState(false);
  // Each opening starts blank (React's reset-on-prop-change pattern; the effect below only reads).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setPrior(null); setErr(null); setResend(false); }
  }
  useEffect(() => {
    if (!open || skip) return;
    let live = true;
    void loadPriorSends(workspaceId, dealId, me).then((r) => {
      if (!live) return;
      if (r.ok) setPrior(r.data); else { setErr(r.message); setPrior([]); }
    });
    return () => { live = false; };
  }, [open, skip, workspaceId, dealId, me]);
  return { prior: skip ? [] : prior, err, resend, setResend };
}

export function PriorBlastsNote({ dupes, address, err, resend, setResend, disabled }: {
  dupes: Dupes; address: string; err: string | null; resend: boolean; setResend: (v: boolean) => void; disabled?: boolean;
}) {
  if (err) return <Note level="info">Could not check who already got a blast for this property ({err}). The server still skips anyone it already reached.</Note>;
  const n = dupes.ids.size;
  if (!n) return null;
  return (
    <Note level="warn">
      <span style={{ display: 'grid', gap: '6px' }}>
        <span data-testid="prior-blasts">{dupeWarning(dupes, address)} {resend ? 'They get this one too.' : 'They are left out of this one.'}</span>
        <Switch on={resend} set={setResend} disabled={disabled}>Send again to {n === 1 ? 'this buyer' : `these ${n.toLocaleString('en-US')} buyers`}</Switch>
      </span>
    </Note>
  );
}
