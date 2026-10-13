// "From: (210) 555-0100 ▾" on every texting box. One choice for the whole CRM
// (lib/sms-from): change it here and the next text from any screen goes out on
// that line.
'use client';

import { lineText, useLineNames } from '@/lib/line-names';
import React from 'react';
import { formatPhone } from '@/lib/talkr';
import { useSmsFrom, useSmsLines } from '@/lib/sms-from';

export function SmsFromPicker({ compact, style }: { compact?: boolean; style?: React.CSSProperties }) {
  const [from, setFrom] = useSmsFrom();
  const lines = useSmsLines();
  useLineNames();
  if (!lines || lines.error || lines.lines.length === 0) return null;
  const def = lines.lines.find((n) => n.id === lines.defaultId);
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: compact ? '11px' : '12px', color: '#71717a', minWidth: 0, ...style }}>
      <span style={{ fontWeight: 600, fontSize: compact ? '10px' : '10.5px' }}>From</span>
      <select
        value={from ?? ''}
        onChange={(e) => setFrom(e.target.value || null)}
        aria-label="Send texts from"
        title="Which of your lines the text goes out from"
        style={{ height: compact ? '24px' : '28px', maxWidth: '100%', minWidth: 0, border: '1px solid #e4e4e7', borderRadius: '8px', padding: '0 6px', fontSize: compact ? '11.5px' : '12px', background: '#fff', color: '#18181b', fontFamily: 'inherit' }}
      >
        <option value="">{def ? `My default · ${formatPhone(def.phone_e164)}` : 'My default line'}</option>
        {lines.lines.map((n) => (
          <option key={n.id} value={n.id}>{lineText(n)}</option>
        ))}
      </select>
    </label>
  );
}
