// Proof of funds on an offer: a link, or a file attached here, and a tick for
// "someone checked it". The SOP logs no offer without one (lib/buyer-desk
// `pofProblem`); the file uploads with the deal's files when the offer saves.
'use client';

import React, { useId, useRef } from 'react';
import { btn, INK, MUTED, RED } from '@/components/genius/parts';

export type PofDraft = { url: string; file: File | null; verified: boolean };
export const emptyPof = (): PofDraft => ({ url: '', file: null, verified: false });
export const hasPof = (p: PofDraft) => !!p.url.trim() || !!p.file;

export function PofField({ value, onChange, error, inputStyle }: {
  value: PofDraft; onChange: (p: PofDraft) => void; error?: string | null; inputStyle: React.CSSProperties;
}) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div role="group" aria-labelledby={`${id}-l`} style={{ minWidth: 0 }}>
      <label id={`${id}-l`} htmlFor={`${id}-u`} style={{ display: 'block', fontSize: '11.5px', fontWeight: 500, color: MUTED, marginBottom: '5px' }}>
        Proof of funds <span style={{ color: RED }} aria-hidden="true">*</span>
      </label>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        {value.file ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: INK, minWidth: 0, flex: 1 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value.file.name}>{value.file.name}</span>
            <button type="button" style={btn('ghost', true)} onClick={() => onChange({ ...value, file: null })}>Remove file</button>
          </span>
        ) : (
          <>
            <input id={`${id}-u`} value={value.url} onChange={(e) => onChange({ ...value, url: e.target.value })} placeholder="Link to the bank letter or statement"
              aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined}
              style={{ ...inputStyle, flex: 1, minWidth: '160px', ...(error ? { borderColor: RED } : {}) }} />
            <button type="button" style={btn('ghost', true)} onClick={() => fileRef.current?.click()}>Attach file</button>
            <input ref={fileRef} type="file" accept=".pdf,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onChange({ ...value, file: f, url: '' }); e.target.value = ''; }} />
          </>
        )}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: INK, cursor: 'pointer', minHeight: '28px' }}>
          <input type="checkbox" checked={value.verified} onChange={(e) => onChange({ ...value, verified: e.target.checked })} style={{ width: '15px', height: '15px', accentColor: 'var(--tx-mint, #0a8560)' }} />
          Verified
        </label>
      </div>
      {error ? <div id={`${id}-e`} role="alert" style={{ fontSize: '11.5px', color: RED, marginTop: '4px' }}>{error}</div> : null}
    </div>
  );
}
