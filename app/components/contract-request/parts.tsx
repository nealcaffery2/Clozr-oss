// Shared pieces for the contract request: the house colours (app/DESIGN.md),
// buttons, labelled fields, icons and the centred dialog shell.
'use client';

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/app/components/record/useModal';

export const C = {
  ink: 'var(--ink, #18181b)', ink2: 'var(--ink-3, #3f3f46)', muted: 'var(--meta, #71717a)', faint: 'var(--subtle, #a1a1aa)', line: 'var(--divider, #e4e4e7)', hair: 'var(--divider-2, #f0f0f1)',
  accent: '#0A8560', accentHover: '#08694C', tint: 'var(--c-action-soft, #e7f5ef)', tintPale: 'var(--c-genius-soft, #f0faf5)', tintLine: 'var(--c-action-line, #a7dcc5)',
  amber: '#b45309', red: '#b91c1c', page: 'var(--canvas, #fafafa)',
};

export const SHADOW_RING = '0 0 0 1px rgba(0,0,0,.08), 0 1px 2px -1px rgba(0,0,0,.08), 0 2px 4px 0 rgba(0,0,0,.04)';
export const SHADOW_LG = '0 2.8px 2.2px rgba(0,0,0,.034), 0 6.7px 5.3px rgba(0,0,0,.048), 0 12.5px 10px rgba(0,0,0,.06), 0 22.3px 17.9px rgba(0,0,0,.072), 0 41.8px 33.4px rgba(0,0,0,.086), 0 100px 80px rgba(0,0,0,.12)';

/** Press, hover and focus for every control here; scoped so nothing else changes. */
export const CR_CSS = `
[data-cr] button { transition: transform 140ms cubic-bezier(.23,1,.32,1), filter 130ms ease, box-shadow 130ms ease; }
[data-cr] button:active:not(:disabled) { transform: scale(.97); }
@media (hover: hover) and (pointer: fine) { [data-cr] button:hover:not(:disabled) { filter: brightness(.96); } }
[data-cr] button:focus-visible, [data-cr] input:focus-visible, [data-cr] select:focus-visible, [data-cr] textarea:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
[data-cr] input, [data-cr] select, [data-cr] textarea { font-family: inherit; }
[data-cr] ::selection { background: ${C.tint}; color: ${C.ink}; }
[data-cr] input::placeholder, [data-cr] textarea::placeholder { color: ${C.faint}; }
[data-cr] .cr-pop { animation: crPop 220ms cubic-bezier(.23,1,.32,1); }
@keyframes crPop { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { [data-cr] .cr-pop { animation: none; } [data-cr] button { transition: none; } }
@media (max-width: 640px) { [data-cr] input, [data-cr] select, [data-cr] textarea { font-size: 16px !important; } }
`;

export type BtnKind = 'primary' | 'secondary' | 'ghost' | 'quiet';

/** DESIGN.md §7: primary = the one green action, secondary = green on white, ghost = white ring, quiet = text. */
export function btn(kind: BtnKind, h: 32 | 36 | 40 = 32): React.CSSProperties {
  const base: React.CSSProperties = {
    height: h, padding: `0 ${h >= 40 ? 16 : 12}px`, borderRadius: 8, fontSize: h >= 40 ? 13.5 : 12.5, fontWeight: 600, cursor: 'pointer',
    whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit', minWidth: 24,
  };
  if (kind === 'primary') return { ...base, background: C.accent, color: 'var(--on-dark, #fff)', border: `1px solid ${C.accent}` };
  if (kind === 'secondary') return { ...base, background: 'var(--surface, #fff)', color: C.accent, border: `1px solid ${C.tintLine}`, boxShadow: SHADOW_RING };
  if (kind === 'ghost') return { ...base, background: 'var(--surface, #fff)', color: C.ink, border: `1px solid ${C.line}`, boxShadow: SHADOW_RING };
  return { ...base, background: 'transparent', color: C.muted, border: '1px solid transparent' };
}

export const field: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 10px', border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 13, color: C.ink, background: 'var(--surface, #fff)', boxSizing: 'border-box',
};

/** Sentence-case label above its control, with an optional hint under it. */
export function Field({ label, hint, children, wide }: { label: string; hint?: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, gridColumn: wide ? '1 / -1' : undefined }}>
      <span style={{ fontSize: 11.5, fontWeight: 500, color: C.muted }}>{label}</span>
      {children}
      {hint ? <span style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.35 }}>{hint}</span> : null}
    </label>
  );
}

/** Lucide geometry, currentColor, 2px stroke. */
export function Glyph({ name, size = 16 }: { name: 'file-signature' | 'x' | 'headphones' | 'mic' | 'transfer' | 'check' | 'clock' | 'file'; size?: number }) {
  const p = {
    'file-signature': <><path d="M20 19.5v.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8.5L18 5.5" /><path d="M8 18h1" /><path d="M18.42 9.61a2.1 2.1 0 1 1 2.97 2.97L16.95 17 13 18l.99-3.95 4.43-4.44Z" /></>,
    x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
    headphones: <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />,
    mic: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></>,
    transfer: <><path d="m16 3 4 4-4 4" /><path d="M20 7H4" /><path d="m8 21-4-4 4-4" /><path d="M4 17h16" /></>,
    check: <path d="M20 6 9 17l-5-5" />,
    clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
    file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>,
  }[name];
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>{p}</svg>;
}

/**
 * A centred modal: portaled to the page, focus trapped, Escape and the scrim
 * close it. `labelledBy` names it from its own heading.
 */
export function Dialog({ labelledBy, onClose, children, width = 640, z = 120, scrimClose = true }: {
  labelledBy: string; onClose: () => void; children: React.ReactNode; width?: number; z?: number; scrimClose?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  // During render, not an effect (set-state-in-effect fails CI), as CenteredDialog does.
  if (host === null && typeof document !== 'undefined') setHost(document.body);
  return host ? createPortal(<Trap boxRef={ref} labelledBy={labelledBy} onClose={onClose} width={width} z={z} scrimClose={scrimClose}>{children}</Trap>, host) : null;
}

function Trap({ boxRef, labelledBy, onClose, children, width, z, scrimClose }: {
  boxRef: React.RefObject<HTMLDivElement | null>; labelledBy: string; onClose: () => void; children: React.ReactNode; width: number; z: number; scrimClose: boolean;
}) {
  useFocusTrap(boxRef, onClose, '[data-autofocus]');
  return (
    <div data-cr="" onClick={scrimClose ? onClose : undefined} style={{ position: 'fixed', inset: 0, zIndex: z, background: 'rgba(24,24,27,.5)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <style>{CR_CSS}</style>
      <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} className="cr-pop" onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: width, maxHeight: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column', background: 'var(--surface, #fff)', borderRadius: 16, boxShadow: SHADOW_LG, overflow: 'hidden', color: C.ink, fontSize: 13 }}>
        {children}
      </div>
    </div>
  );
}

/** The dialog's title row with a named close button. */
export function DialogHead({ id, title, sub, onClose }: { id: string; title: React.ReactNode; sub?: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px 12px 18px', borderBottom: `1px solid ${C.line}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 id={id} style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: '-0.015em', lineHeight: 1.25 }}>{title}</h2>
        {sub ? <div style={{ marginTop: 3, fontSize: 12, color: C.muted, lineHeight: 1.4 }}>{sub}</div> : null}
      </div>
      <button type="button" onClick={onClose} aria-label="Close" style={{ ...btn('ghost'), width: 32, padding: 0 }}>
        <Glyph name="x" size={15} />
      </button>
    </div>
  );
}
