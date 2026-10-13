// The small pieces every Genius Mode panel shares: the palette, the money and
// date formatters, the score and %-of-ARV rings, pills, badges, buttons, icons
// and the modal. The rules they follow are written down in app/DESIGN.md:
// sentence-case labels (no tracked-out capitals), one purple primary per view,
// neutral buttons drawn with a shadow ring rather than a border, real SVG
// icons, and press / hover / focus states on everything that clicks.
'use client';

import React from 'react';
import { heat } from '@/lib/heat';

export const INK = '#18181b';
export const MUTED = '#71717a';
export const FAINT = '#a1a1aa';
export const LINE = '#e4e4e7';
export const HAIR = '#f0f0f1';
export const GREEN = '#0A8560';
export const PURPLE = '#0A8560';
export const PURPLE_TINT = '#E7F5EF';
export const RED = '#b91c1c';
export const INK_2 = '#3f3f46';

/** Elevation, from beautiful-shadows: one recipe per surface, never mixed. */
export const SHADOW = {
  ring: '0 0 0 1px rgba(0,0,0,.08), 0 1px 2px -1px rgba(0,0,0,.08), 0 2px 4px 0 rgba(0,0,0,.04)',
  md: '0 0 0 1px rgba(0,0,0,.06), 0 1px 1px -.5px rgba(0,0,0,.06), 0 3px 3px -1.5px rgba(0,0,0,.06), 0 6px 6px -3px rgba(0,0,0,.06), 0 12px 12px -6px rgba(0,0,0,.06)',
  lg: '0 2.8px 2.2px rgba(0,0,0,.034), 0 6.7px 5.3px rgba(0,0,0,.048), 0 12.5px 10px rgba(0,0,0,.06), 0 22.3px 17.9px rgba(0,0,0,.072), 0 41.8px 33.4px rgba(0,0,0,.086), 0 100px 80px rgba(0,0,0,.12)',
};

/**
 * Press, hover and focus for everything inside Genius Mode. Inline styles
 * can't express :active / :hover / :focus-visible, so the root renders this
 * once and every button under [data-gx] picks it up. Hover is a brightness
 * shift so it works on any inline background; press is a 0.97 scale; only
 * transform, filter and box-shadow transition, and never on reduced motion.
 */
export const GX_CSS = `
[data-gx] button{transition:transform 140ms cubic-bezier(.23,1,.32,1),filter 140ms ease,box-shadow 140ms ease;-webkit-tap-highlight-color:transparent}
[data-gx] button:not(:disabled):active{transform:scale(.97)}
[data-gx] button:disabled{cursor:default!important;opacity:.5}
[data-gx] :is(button,a,input,select,[role=button],[tabindex]):focus-visible{outline:2px solid ${'#0A8560'};outline-offset:2px}
[data-gx] label:has(>input[type=checkbox]:focus-visible)>span[aria-hidden]{outline:2px solid ${'#0A8560'};outline-offset:2px}
[data-gx] input::placeholder{color:${'#a1a1aa'}}
[data-gx] input:focus-visible,[data-gx] select:focus-visible{outline-offset:0;box-shadow:0 0 0 3px ${'#0A8560'}26}
@media (hover:hover) and (pointer:fine){
  [data-gx] button:not(:disabled):hover{filter:brightness(.96)}
  [data-gx] [data-gx-row]:hover{background:#fafafa}
  [data-gx] [data-alt]>div:not([data-active]):hover{background:#F0FAF5!important}
}
[data-gx] [data-alt]>div:not([data-active]){background:var(--band)!important}
[data-gx] .gx-scroll{scrollbar-width:none;-webkit-overflow-scrolling:touch}
[data-gx] .gx-scroll::-webkit-scrollbar{display:none}
[data-gx] .gx-scroll>*{flex:none}
@media (prefers-reduced-motion:reduce){[data-gx] button,[data-gx] label>span[aria-hidden],[data-gx] label>span[aria-hidden]>span{transition:none}[data-gx] button:not(:disabled):active{transform:none}}
`;

/** Icons: one stroke family (Lucide geometry), currentColor, 2px next to semibold text. */
export const ICON = {
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  chevronDown: 'm6 9 6 6 6-6',
  chevronUp: 'm18 15-6-6-6 6',
  chevronRight: 'm9 18 6-6-6-6',
  chevronLeft: 'm15 18-6-6 6-6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  plus: 'M12 5v14M5 12h14',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  layers: 'm12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  chart: 'M3 3v18h18M8 17v-6M13 17V7M18 17v-4',
  map: 'm9 4-6 2v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
};

export function Icon({ d, size = 14, stroke = 2, style }: { d: string; size?: number; stroke?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none', ...style }}>
      <path d={d} />
    </svg>
  );
}

export const money = (n: number | null | undefined) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
export const shortMoney = (n: number | null | undefined) => (n == null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}K` : '$' + Math.round(n));
export const when = (s: string | null | undefined) => (s ? new Date(s + (s.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—');
export const ago = (s: string | null | undefined) => {
  if (!s) return '';
  const d = (Date.now() - new Date(s).getTime()) / 864e5;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.round(d)}d ago` : d < 365 ? `${Math.round(d / 30.4)}mo ago` : `${(d / 365).toFixed(1)}y ago`;
};

/** Likelihood read as a temperature word, because 68% and 71% are the same decision (lib/heat.ts). */
export function tier(lk: number): { label: string; color: string; text: string; tint: string } {
  const h = heat(lk);
  return { label: h.label, color: h.stroke, text: h.text, tint: h.tint };
}

/** A 0-100 ring. `color` draws the arc; `text` colours the number (defaults to `color`, so pass a darker shade when the arc colour is too light for text). */
export function Ring({ value, color, text, size = 46, label, suffix = '' }: { value: number | null; color: string; text?: string; size?: number; label?: string; suffix?: string }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '2px', flex: 'none' }} title={label}>
      <span style={{ position: 'relative', width: size, height: size, display: 'grid', placeItems: 'center' }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={HAIR} strokeWidth="4" />
          {value != null ? <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(c * pct) / 100} ${c}`} /> : null}
        </svg>
        <span style={{ position: 'relative', fontSize: size >= 44 ? '12.5px' : '11px', fontWeight: 700, color: value == null ? FAINT : text ?? color, fontVariantNumeric: 'tabular-nums' }}>{value == null ? '—' : `${value}${suffix}`}</span>
      </span>
      {label ? <span style={{ fontSize: '11px', fontWeight: 500, color: MUTED, whiteSpace: 'nowrap' }}>{label}</span> : null}
    </span>
  );
}

/** A toggle chip. Selected is a solid ink fill; unselected is a white chip drawn with a shadow ring. */
export function Pill({ on, onClick, children, disabled, title }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} disabled={disabled} title={title} style={{
      height: '28px', padding: '0 11px', borderRadius: '8px', fontSize: '12px', fontWeight: on ? 600 : 500, cursor: 'pointer',
      whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '6px', border: 0,
      background: on ? INK : '#fff', color: on ? '#fff' : INK_2,
      boxShadow: on ? '0 1px 2px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.08)' : SHADOW.ring,
    }}>{children}</button>
  );
}

/** A labelled group of controls. Sentence-case label, not a tracked-out capital eyebrow. */
export function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
      <span style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }}>{label}</span>
      <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

/** One input with its label above it. The label is visible text, never the placeholder. */
export function Field({ label, children, span, hint }: { label: string; children: React.ReactNode; span?: string; hint?: string }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0, gridColumn: span }}>
      <span style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }} title={hint}>{label}</span>
      {children}
    </label>
  );
}

/** A labelled on/off switch for run options (skip trace, compare). Native checkbox underneath, so it keeps keyboard and form behaviour. */
export function Toggle({ on, onChange, disabled, children, title }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: React.ReactNode; title?: string }) {
  return (
    <label title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', minHeight: '32px', fontSize: '12.5px', fontWeight: 500, color: INK, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap' }}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ position: 'absolute', opacity: 0, width: 1, height: 1, margin: 0 }} />
      <span aria-hidden="true" style={{ position: 'relative', width: '28px', height: '16px', borderRadius: '99px', background: on ? PURPLE : '#d4d4d8', flex: 'none', transition: 'background-color 140ms ease' }}>
        <span style={{ position: 'absolute', top: '2px', left: '2px', width: '12px', height: '12px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.2)', transform: on ? 'translateX(12px)' : 'none', transition: 'transform 140ms cubic-bezier(.23,1,.32,1)' }} />
      </span>
      {children}
    </label>
  );
}

/** A status chip: sentence case, 11px semibold, a small radius so it never reads as a button. */
export function Badge({ children, color = INK_2, tint = '#f4f4f5', title }: { children: React.ReactNode; color?: string; tint?: string; title?: string }) {
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 600, lineHeight: '16px', color, background: tint, padding: '1px 7px', borderRadius: '6px', whiteSpace: 'nowrap' }}>{children}</span>
  );
}

export function Stat({ label, value, strong, hint }: { label: string; value: React.ReactNode; strong?: boolean; hint?: string }) {
  return (
    <span style={{ minWidth: 0 }} title={hint}>
      <span style={{ display: 'block', fontSize: '11px', fontWeight: 500, color: MUTED }}>{label}</span>
      <span style={{ display: 'block', fontSize: '13px', fontWeight: strong ? 650 : 500, color: INK, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </span>
  );
}

/**
 * Buttons. `purple` is the one primary action a view has (Find buyers,
 * Investor comps). `solid` is a confirming row action (Add to buyers): ink,
 * so the purple stays singular and green stays a status colour. `ghost` is
 * everything else: white, drawn with a shadow ring instead of a border.
 */
export const btn = (kind: 'ghost' | 'solid' | 'purple' = 'ghost', small = false): React.CSSProperties => ({
  height: small ? '28px' : '32px', padding: small ? '0 10px' : '0 13px', borderRadius: '8px', fontSize: small ? '12px' : '12.5px', fontWeight: kind === 'ghost' ? 500 : 600,
  cursor: 'pointer', whiteSpace: 'nowrap', border: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  background: kind === 'solid' ? INK : kind === 'purple' ? PURPLE : '#fff',
  color: kind === 'ghost' ? INK : '#fff',
  boxShadow: kind === 'ghost' ? SHADOW.ring
    : kind === 'purple' ? '0 0 0 1px #08694C, 0 1px 2px rgba(8,105,76,.3), inset 0 1px 0 rgba(255,255,255,.16)'
      : '0 0 0 1px #000, 0 1px 2px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.1)',
});

export const input: React.CSSProperties = {
  height: '32px', padding: '0 10px', borderRadius: '8px', border: 0, boxShadow: SHADOW.ring, fontSize: '13px', color: INK, background: '#fff', minWidth: 0, outline: 'none',
};

export const sectionLabel: React.CSSProperties = { fontSize: '12px', color: INK, fontWeight: 600, marginBottom: '8px' };

export function Modal({ title, onClose, children, width = 760, isMobile }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; width?: number; isMobile: boolean }) {
  return (
    <div role="dialog" aria-modal="true" data-gx onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(24,24,27,.38)', display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : '24px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', width: isMobile ? '100%' : `min(${width}px, 100%)`, maxHeight: isMobile ? '92vh' : '88vh', borderRadius: isMobile ? '16px 16px 0 0' : '14px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: SHADOW.lg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '13px 16px', borderBottom: `1px solid ${HAIR}` }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: '14.5px', fontWeight: 700, color: INK }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ ...btn('ghost', true), width: '28px', padding: 0, boxShadow: 'none', color: MUTED }}><Icon d={ICON.x} size={15} /></button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}
