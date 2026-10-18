// The builder's small vocabulary of controls, in CLOZR's inline-style idiom:
// #18181b ink, #71717a muted, #e4e4e7 lines, 8–12px radii, 12–13px text.
'use client';

import React from 'react';
import { Mark } from '@/components/ds/mark';

export const INK = 'var(--ink, #18181b)';
export const MUTED = 'var(--meta, #71717a)';
export const FAINT = 'var(--subtle, #a1a1aa)';
export const LINE = 'var(--divider, #e4e4e7)';
export const MINT = '#0A8560';
export const MINT_BG = 'var(--mint-dim, #e7f8f1)';

export const label: React.CSSProperties = {
  display: 'block', fontSize: '11.5px', color: MUTED, fontWeight: 600, marginBottom: '5px',
};
export const input: React.CSSProperties = {
  width: '100%', height: '34px', padding: '0 10px', border: `1px solid ${LINE}`, borderRadius: '8px', fontSize: '13px', outline: 0,
  background: 'var(--canvas, #fafafa)', color: INK, fontFamily: 'inherit', boxSizing: 'border-box',
};
export const smallInput: React.CSSProperties = { ...input, height: '28px', fontSize: '12.5px', padding: '0 8px', borderRadius: '7px' };
export const select: React.CSSProperties = { ...input, cursor: 'pointer' };
export const smallSelect: React.CSSProperties = { ...smallInput, cursor: 'pointer' };
export const textarea: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: `1px solid ${LINE}`, borderRadius: '8px', resize: 'vertical', fontSize: '12.5px', outline: 0,
  background: 'var(--canvas, #fafafa)', color: 'var(--ink-2, #27272a)', lineHeight: 1.5, fontFamily: 'inherit', boxSizing: 'border-box',
};
export const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '12px', padding: '14px 16px' };

function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
      <path d="M3.2 1.8v8.4L10.2 6 3.2 1.8z" fill="currentColor" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
      <path d="M2.4 1.6h2.4v8.8H2.4V1.6zm4.8 0h2.4v8.8H7.2V1.6z" fill="currentColor" />
    </svg>
  );
}

/** Play starts the plan. Pause holds it, including the people already on it. */
export function PlayPause({ playing, onClick, disabled, label }: { playing: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
  const text = label ?? (playing ? 'Pause' : 'Play');
  return (
    <button
      type="button"
      data-testid="plan-play-pause"
      aria-pressed={playing}
      aria-label={playing ? 'Pause action plan' : 'Play action plan'}
      title={playing ? 'Pause this plan' : 'Play this plan'}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="dc2"
      style={{
        height: '28px', padding: '0 10px', borderRadius: '8px',
        border: `1px solid ${playing ? MINT : LINE}`,
        background: playing ? MINT_BG : 'var(--surface, #fff)', color: playing ? MINT : INK,
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        cursor: disabled ? 'default' : 'pointer', fontSize: '12px', fontWeight: 650,
        fontFamily: 'inherit', opacity: disabled ? 0.5 : 1,
      }}
    >
      {playing ? <PauseIcon /> : <PlayIcon />}
      {text}
    </button>
  );
}

export function Btn({ kind = 'plain', small = false, style, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'plain' | 'primary' | 'dark' | 'danger' | 'ghost'; small?: boolean }) {
  const base: React.CSSProperties = {
    height: small ? '26px' : '32px', padding: small ? '0 9px' : '0 12px', borderRadius: small ? '7px' : '8px', fontSize: small ? '11.5px' : '12.5px',
    cursor: rest.disabled ? 'default' : 'pointer', fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: rest.disabled ? 0.5 : 1,
    display: 'inline-flex', alignItems: 'center', gap: '6px',
  };
  const look: Record<string, React.CSSProperties> = {
    plain: { border: `1px solid ${LINE}`, background: 'var(--surface, #fff)', color: INK, fontWeight: 500 },
    primary: { border: `1px solid ${MINT}`, background: MINT, color: 'var(--on-dark, #fff)' },
    dark: { border: `1px solid ${INK}`, background: INK, color: 'var(--on-dark, #fff)' },
    danger: { border: `1px solid ${LINE}`, background: 'var(--surface, #fff)', color: 'var(--tx-red, #b91c1c)', fontWeight: 500 },
    ghost: { border: `1px dashed var(--line, #d4d4d8)`, background: 'var(--surface, #fff)', color: INK, fontWeight: 500 },
  };
  const cls = kind === 'primary' ? 'dc3' : kind === 'dark' ? 'dc10' : 'dc2';
  return <button type="button" className={cls} style={{ ...base, ...look[kind], ...style }} {...rest} />;
}

export function Toggle({ on, onChange, label: text, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', padding: '6px 0' }}>
      <span
        role="switch" aria-checked={on}
        onClick={(e) => { e.preventDefault(); onChange(!on); }}
        style={{ flex: 'none', marginTop: '1px', width: '30px', height: '18px', borderRadius: '999px', background: on ? MINT : 'var(--line, #d4d4d8)', position: 'relative', transition: 'background .15s' }}
      >
        <span style={{ position: 'absolute', top: '2px', left: on ? '14px' : '2px', width: '14px', height: '14px', borderRadius: '999px', background: 'var(--surface, #fff)', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 500, color: INK }}>{text}</span>
        {hint ? <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '1px' }}>{hint}</span> : null}
      </span>
    </label>
  );
}

export function Pill({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', height: '22px', padding: '0 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, color, background: bg, whiteSpace: 'nowrap' }}>
      <Mark label={typeof children === 'string' ? children : 'status'} />
      {children}
    </span>
  );
}

export function Section({ title, aside, children, style }: { title: string; aside?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ ...card, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <span style={{ ...label, marginBottom: 0 }}>{title}</span>
        <span style={{ flex: 1 }} />
        {aside}
      </div>
      {children}
    </div>
  );
}

export function Toast({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div style={{ position: 'fixed', left: '50%', bottom: 'calc(24px + var(--clozr-callbar, 0px))', transform: 'translateX(-50%)', background: INK, color: 'var(--on-dark, #fff)', fontSize: '12.5px', fontWeight: 500, padding: '9px 14px', borderRadius: '9px', boxShadow: '0 8px 24px rgba(0,0,0,.18)', zIndex: 60, maxWidth: 'min(92vw, 520px)' }}>
      {msg}
    </div>
  );
}

/** "3 min ago" / "yesterday" / "Sep 2". */
export function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  const m = Math.round(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
