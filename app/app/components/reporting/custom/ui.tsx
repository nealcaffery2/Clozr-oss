'use client';

// The small style vocabulary the report builder shares.

import React from 'react';

export const INK = '#18181b', MUTED = '#71717a', LINE = '#e4e4e7', SOFT = '#f0f0f1', ACCENT = '#0A8560';

export const field: React.CSSProperties = { width: '100%', height: '32px', padding: '0 11px', border: 0, borderRadius: '10px', fontSize: '12.5px', outline: 0, background: '#fff', color: INK, fontFamily: 'inherit', boxSizing: 'border-box', boxShadow: 'var(--shadow-ring)' };
export const eyebrow: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: MUTED, fontWeight: 500, marginBottom: '5px' };
export const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px' };
export const popover: React.CSSProperties = { position: 'absolute', top: 'calc(100% + 6px)', zIndex: 40, background: '#fff', borderRadius: '12px', boxShadow: 'var(--shadow-md)', padding: '12px', animation: 'clozrPop .16s cubic-bezier(.23,1,.32,1)' };

const base: React.CSSProperties = { height: '30px', padding: '0 11px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' };
export const btn = {
  primary: { ...base, border: `1px solid ${INK}`, background: INK, color: '#fff' } as React.CSSProperties,
  accent: { ...base, border: `1px solid ${ACCENT}`, background: ACCENT, color: '#fff' } as React.CSSProperties,
  ghost: { ...base, border: `1px solid ${LINE}`, background: '#fff', color: INK } as React.CSSProperties,
  plain: { ...base, border: 0, background: 'none', color: MUTED, fontWeight: 500 } as React.CSSProperties,
  danger: { ...base, border: `1px solid ${LINE}`, background: '#fff', color: '#b91c1c' } as React.CSSProperties,
  chip: (on: boolean): React.CSSProperties => ({ height: '28px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${on ? ACCENT : LINE}`, background: on ? '#E7F8F1' : '#fff', color: on ? ACCENT : '#27272a', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }),
  icon: { width: '30px', height: '30px', borderRadius: '8px', border: `1px solid ${LINE}`, background: '#fff', color: INK, cursor: 'pointer', display: 'inline-grid', placeItems: 'center', padding: 0 } as React.CSSProperties,
};

export function Modal({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(24,24,27,.45)', display: 'grid', placeItems: 'center', padding: '16px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: '100%', maxWidth: width, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px', borderBottom: `1px solid ${SOFT}` }}>
          <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, letterSpacing: '-0.01em', flex: 1 }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ ...btn.icon, border: 0, fontSize: '18px', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflow: 'auto', padding: '16px' }}>{children}</div>
      </div>
    </div>
  );
}

export function Toggle({ on, onChange, label, sub }: { on: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', padding: '6px 0' }}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: '2px', width: '15px', height: '15px', accentColor: ACCENT, flex: 'none', cursor: 'pointer' }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: INK }}>{label}</span>
        {sub ? <span style={{ display: 'block', fontSize: '12px', color: MUTED, marginTop: '1px', lineHeight: 1.45 }}>{sub}</span> : null}
      </span>
    </label>
  );
}
