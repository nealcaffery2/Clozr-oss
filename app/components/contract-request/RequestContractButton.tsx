// The dialer's Request contract button. It sits with the call's party, in
// the context card's actions beside Text and Open record: during a call, its
// wrap-up, and once a number with a record is loaded. Green on white (the
// secondary style), so the call's own controls stay the loudest thing on the
// screen. The phone has it in the call's More sheet (ActiveCall).
'use client';

import React from 'react';
import { openRequestDialog } from '@/lib/contract-request-store';
import { tcFirstNames, tcRecipients } from '@/lib/contract-request';
import type { ClozrView } from '@/app/clozr/view';
import { CR_CSS, Glyph, btn } from './parts';

export function RequestContractButton({ V, phone = null }: { V: ClozrView; phone?: string | null }) {
  const tc = tcFirstNames(tcRecipients(V.requestTeam, V.requestMe));
  return (
    <span data-cr="" style={{ display: 'inline-flex' }}>
      <style>{CR_CSS}</style>
      <button type="button" onClick={() => openRequestDialog(phone)} aria-haspopup="dialog" title={`Drafts the contract in Contracts and alerts ${tc}`}
        style={{ ...btn('secondary'), height: 30, padding: '0 10px', fontSize: 11.5 }}>
        <Glyph name="file-signature" size={14} />
        Request contract
      </button>
    </span>
  );
}
