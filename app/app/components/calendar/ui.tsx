// Calendar chrome: Google Calendar layout vocabulary, Clozr mint accent,
// and the shared iPhone buttons / chips / fields from ds/chrome.
'use client';

import React from 'react';
import { CZ, darkBtn, field as chromeField, ghostBtn, primaryBtn } from '@/components/ds/chrome';

export const INK = CZ.ink;
export const MUTED = CZ.muted;
export const LINE = '#dadce0'; // Google Calendar hairline
export const SOFT = '#e8eaed';
export const MINT = CZ.mint;

export const ghost: React.CSSProperties = { ...ghostBtn };
export const primary: React.CSSProperties = { ...primaryBtn };
export const dark: React.CSSProperties = { ...darkBtn };
export const input: React.CSSProperties = { ...chromeField, width: '100%' };
export const label: React.CSSProperties = {
  display: 'block', fontSize: '11px', letterSpacing: '.02em', color: MUTED, fontWeight: 500, marginBottom: '4px',
};

export function Field({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ marginBottom: '10px', ...style }}>
      <span style={label}>{title}</span>
      {children}
    </div>
  );
}

/** Calendar type filter — soft tray chip, not a full pill. */
export function Chip({ on, color, label: text, onClick, count }: { on: boolean; color: string; label: string; onClick: () => void; count?: number }) {
  return (
    <button type="button" className={`cz-chip${on ? ' is-on' : ''}`} onClick={onClick} style={{
      height: '28px', padding: '0 10px', borderRadius: '14px', border: 0,
      background: on ? CZ.tray : 'transparent', color: on ? INK : CZ.faint,
      font: '500 12px/1 var(--font-sans)', cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap',
    }}>
      <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: on ? color : '#dadce0', flex: 'none' }} />
      {text}
      {count != null ? <span style={{ fontSize: '11px', color: CZ.faint }}>{count}</span> : null}
    </button>
  );
}

export function Avatar({ initials, color, size = 20 }: { initials: string; color: string; size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: color, color: '#fff', fontSize: size <= 20 ? '9px' : '11px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', letterSpacing: '.02em' }}>
      {initials}
    </span>
  );
}

export const ago = (iso: string | null | undefined) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
};

/** The dot beside an event: Google's answer, or ours while it is still on the way. */
export function SyncDot({ state }: { state: 'pending' | 'synced' | 'error' | null }) {
  if (!state) return null;
  const c = state === 'synced' ? '#16a34a' : state === 'error' ? '#b91c1c' : '#d97706';
  const t = state === 'synced' ? 'On Google Calendar' : state === 'error' ? 'Google sync failed' : 'Waiting to sync';
  return <span title={t} style={{ width: '6px', height: '6px', borderRadius: '50%', background: c, display: 'inline-block', flex: 'none' }} />;
}
