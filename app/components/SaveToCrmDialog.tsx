// "Save as a new Person or Buyer?" — asked on send for recipients typed in by
// hand who are not in the CRM yet. People (sellers) is the default for the
// seller side, Buyers for the buyer side; each can be skipped.
'use client';

import React, { useState } from 'react';
import { CenteredDialog } from '@/components/ContractsHub';
import { defaultCrmKind } from '@/supabase/functions/_shared/docs-people';

export type Unsaved = { key: string; name: string; email?: string | null; phone?: string | null; role?: string | null; label?: string | null };
export type CrmChoice = 'seller' | 'buyer' | 'skip';

const opt = (on: boolean): React.CSSProperties => ({
  height: '30px', padding: '0 12px', borderRadius: '999px', fontSize: '12.5px', fontWeight: on ? 650 : 500, cursor: 'pointer',
  border: `1px solid ${on ? '#0A8560' : '#e4e4e7'}`, background: on ? '#E7F8F1' : '#fff', color: on ? '#0A8560' : '#27272a', fontFamily: 'inherit',
});

export function SaveToCrmDialog({ rows, busy, confirmLabel = 'Save and continue', onDone, onCancel }: {
  rows: Unsaved[]; busy?: boolean; confirmLabel?: string;
  onDone: (choices: Record<string, CrmChoice>) => void; onCancel: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, CrmChoice>>(() => Object.fromEntries(rows.map((r) => [r.key, defaultCrmKind(r.role)])));
  return (
    <CenteredDialog title="Save these recipients to the CRM?" onClose={onCancel} width={640} z={220}>
      <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#52525b', lineHeight: 1.5 }}>
        {rows.length === 1 ? 'This recipient is' : 'These recipients are'} not in CLOZR yet. Save them so the contract shows on their record. Someone already on file with the same email or phone is linked instead of added twice.
      </p>
      <div style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: '12px' }}>
        {rows.map((r, i) => (
          <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '12px 14px', borderTop: i ? '1px solid #f0f0f1' : 0 }}>
            <div style={{ flex: 1, minWidth: '180px' }}>
              <div style={{ fontSize: '13.5px', fontWeight: 650, color: '#18181b' }}>{r.name}{r.label ? <span style={{ fontWeight: 500, color: '#71717a' }}> · {r.label}</span> : null}</div>
              <div style={{ fontSize: '12px', color: '#71717a' }}>{[r.email, r.phone].filter(Boolean).join(' · ') || 'No email or phone'}</div>
            </div>
            <div role="radiogroup" aria-label={`Save ${r.name} as`} style={{ display: 'flex', gap: '6px' }}>
              {(['seller', 'buyer', 'skip'] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={choices[r.key] === k} onClick={() => setChoices((c) => ({ ...c, [r.key]: k }))} style={opt(choices[r.key] === k)}>
                  {k === 'seller' ? 'New Person' : k === 'buyer' ? 'New Buyer' : 'Don’t save'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
        <button type="button" onClick={onCancel} style={{ height: '34px', padding: '0 14px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Back</button>
        <button type="button" disabled={busy} onClick={() => onDone(choices)} style={{ height: '34px', padding: '0 14px', borderRadius: '8px', border: '1px solid #0A8560', background: busy ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}>{busy ? 'Saving…' : confirmLabel}</button>
      </div>
    </CenteredDialog>
  );
}
