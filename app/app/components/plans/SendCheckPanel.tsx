// Under a text or email step: green when it will go out clean, otherwise what
// a carrier or the writing guard will catch and what to change, with a
// one-click Fix it for everything that has a mechanical fix.
'use client';

import React, { useMemo } from 'react';
import { checkMessage } from '@/lib/send-check';
import { Btn, MINT, MINT_BG } from './ui';

export function SendCheckPanel({ body, channel, onFix }: { body: string; channel: 'sms' | 'email'; onFix: (next: string) => void }) {
  const c = useMemo(() => checkMessage(body, channel), [body, channel]);
  if (!body.trim()) return null;
  if (!c.issues.length) {
    return (
      <div role="status" style={{ marginTop: '6px', padding: '6px 10px', borderRadius: '8px', background: MINT_BG, color: MINT, fontSize: '12px', fontWeight: 600 }}>
        Ready to send{channel === 'sms' ? ` · ${c.segments} text${c.segments === 1 ? '' : 's'}` : ''}
      </div>
    );
  }
  const red = c.issues.some((i) => i.level === 'red');
  const canFix = c.fixed !== body;
  return (
    <div role="alert" style={{
      marginTop: '6px', padding: '8px 10px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.45,
      border: `1px solid ${red ? 'var(--tx-red, #b91c1c)' : 'var(--amber, #b45309)'}`,
      background: red ? 'var(--tint-red, #fef2f2)' : 'var(--tint-amber, #fffbeb)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <b style={{ color: red ? 'var(--tx-red, #b91c1c)' : 'var(--amber, #b45309)' }}>
          {red ? 'Will get flagged' : 'May get flagged'}{channel === 'sms' ? ` · ${c.segments} texts long` : ''}
        </b>
        {canFix && <Btn small kind="primary" style={{ marginLeft: 'auto' }} onClick={() => onFix(c.fixed)}>Fix it</Btn>}
      </div>
      <ul style={{ margin: 0, paddingLeft: '16px' }}>
        {c.issues.map((i, n) => (
          <li key={n}><span style={{ fontWeight: 600 }}>{i.what}.</span> {i.fix}.</li>
        ))}
      </ul>
    </div>
  );
}
