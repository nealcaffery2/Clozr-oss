'use client';

// The Marketing tab's building blocks, in the app's current look: white cards
// with a light border, small uppercase eyebrows, the mint primary, Talkr red
// for texting and calling, coloured status chips.
//
// Motion follows how often a thing is used. Buttons, chips and rows are
// pressed all day: a 160ms scale on press and colour on hover, nothing else.
// The confirm dialog and a disclosure's content are occasional: 200ms, strong
// ease-out, from scale(0.95) and opacity 0. Reduced motion keeps the fades and
// drops the movement.

import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Mark } from '@/components/ds/mark';

export const C = {
  ink: '#18181b', ink2: '#27272a', muted: '#52525b', muted2: '#71717a', subtle: '#a1a1aa',
  line: '#e4e4e7', line2: '#f0f0f1', surface2: '#f4f4f5',
  mint: 'var(--c-primary)', mint2: '#08694C', mintSoft: '#E7F8F1', mintLine: '#A8ECD2',
  talkr: 'var(--c-talkr)', talkrSoft: 'var(--c-talkr-soft)',
  amber: '#b45309', amberSoft: '#fef3c7', red: '#dc2626', redSoft: '#fee2e2', green: '#16a34a',
  contact: 'var(--c-contact)',
};

export const CSS = `
.mk { color: ${C.ink}; font-variant-numeric: tabular-nums; }
.mk button, .mk input, .mk select, .mk textarea { font-family: inherit; }
.mk :is(button, a, summary, [tabindex]):focus-visible { outline: 2px solid var(--c-primary); outline-offset: 2px; }
.mk :is(input[type=checkbox], input[type=radio]):focus-visible { outline: 2px solid var(--c-primary); outline-offset: 2px; }
.mk-card { background: #fff; border: 1px solid ${C.line}; border-radius: 12px; }
.mk-eyebrow { font-size: 11.5px; color: ${C.muted2}; font-weight: 500; }
.mk-num { font-variant-numeric: tabular-nums; }

.mk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--c-btn-line); background: var(--c-btn-bg); color: ${C.ink}; font-size: 12.5px; font-weight: 600; cursor: pointer;
  white-space: nowrap; text-decoration: none; transition: transform 160ms ease-out, background-color 120ms linear, border-color 120ms linear, color 120ms linear; }
.mk-btn--sm { height: 28px; padding: 0 10px; font-size: 12px; font-weight: 500; border-radius: 7px; }
.mk-btn--lg { height: 38px; padding: 0 16px; font-size: 13px; border-radius: 9px; }
.mk-btn--wrap { white-space: normal; height: auto; min-height: 38px; padding-top: 8px; padding-bottom: 8px; text-align: center; line-height: 1.3; }
.mk-btn--primary { background: var(--c-primary); border-color: var(--c-primary); color: #fff; }
.mk-btn--talkr { color: var(--c-talkr); border-color: #fecdd3; background: var(--c-btn-bg); }
.mk-btn--danger { color: ${C.red}; }
.mk-btn--quiet { border-color: transparent; background: none; color: ${C.mint2}; padding: 0 6px; }
.mk-btn:disabled, .mk-btn[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.mk-press:active:not(:disabled):not([aria-disabled="true"]) { transform: scale(0.97); }
@media (hover: hover) and (pointer: fine) {
  .mk-btn:not(:disabled):hover { background: var(--c-btn-hover); }
  .mk-btn--primary:not(:disabled):hover { background: var(--c-primary-hover); border-color: var(--c-primary-hover); }
  .mk-btn--talkr:not(:disabled):hover { background: var(--c-talkr-soft); border-color: var(--c-talkr); }
  .mk-btn--quiet:not(:disabled):hover { background: ${C.mintSoft}; }
  .mk-chip:not(:disabled):hover { border-color: var(--c-primary); color: var(--c-primary); }
  .mk-row:hover { background: #fafafa; }
  .mk-tab:not([aria-selected="true"]):hover { color: ${C.ink}; }
}

.mk-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 7px; border: 1px solid ${C.line};
  background: #fff; font-size: 12px; color: #52525b; cursor: pointer; white-space: nowrap;
  transition: transform 160ms ease-out, background-color 120ms linear, border-color 120ms linear, color 120ms linear; }
.mk-chip[aria-pressed="true"], .mk-chip[aria-checked="true"] { border-color: var(--c-primary); background: ${C.mintSoft}; color: var(--c-primary); font-weight: 600; }

.mk-field { max-width: 100%; height: 32px; border-radius: 8px; border: 1px solid ${C.line}; padding: 0 10px; font-size: 12.5px; background: #fff; color: ${C.ink}; min-width: 0; box-sizing: border-box; }
.mk-area { border-radius: 8px; border: 1px solid ${C.line}; padding: 8px 10px; font-size: 13px; line-height: 1.5; background: #fff; color: ${C.ink}; width: 100%; box-sizing: border-box; resize: vertical; }
.mk-field:focus, .mk-area:focus { border-color: var(--c-primary); box-shadow: 0 0 0 3px rgba(10,133,96,.1); outline: 0; }

.mk-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; white-space: nowrap; }

.mk-tab { height: 38px; padding: 0 2px; margin-right: 18px; border: 0; border-bottom: 2px solid transparent; background: none; cursor: pointer; font-size: 13px; font-weight: 500; color: ${C.muted2};
  display: inline-flex; align-items: center; gap: 8px; transition: color 120ms linear; }
.mk-tab[aria-selected="true"] { color: ${C.ink}; border-bottom-color: ${C.ink}; font-weight: 600; }
.mk-tab .mk-step { width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; font-size: 11px; font-weight: 700; border: 1px solid ${C.line}; color: ${C.muted2}; background: #fff; }
.mk-tab[aria-selected="true"] .mk-step { background: ${C.ink}; border-color: ${C.ink}; color: #fff; }
.mk-tab[data-done="true"] .mk-step { background: ${C.mintSoft}; border-color: ${C.mintLine}; color: var(--c-primary); }

.mk-disclosure > button[aria-expanded] svg { transition: transform 160ms ease-out; }
.mk-disclosure > button[aria-expanded="true"] svg { transform: rotate(90deg); }
.mk-reveal { opacity: 1; transform: none; transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1), transform 200ms cubic-bezier(0.23, 1, 0.32, 1); }
@starting-style { .mk-reveal { opacity: 0; transform: translateY(-4px); } }

.mk-scrim { position: fixed; inset: 0; background: rgba(12,13,16,.42); display: grid; place-items: center; padding: 16px; z-index: 60; opacity: 1; transition: opacity 200ms ease-out; }
@starting-style { .mk-scrim { opacity: 0; } }
.mk-dialog { background: #fff; border-radius: 14px; border: 1px solid ${C.line}; box-shadow: var(--shadow-lg); width: min(460px, 100%); max-height: calc(100dvh - 32px); overflow: auto;
  transform: none; opacity: 1; transform-origin: center; transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1), opacity 200ms cubic-bezier(0.23, 1, 0.32, 1); }
@starting-style { .mk-dialog { transform: scale(0.95); opacity: 0; } }

/* A bubble whose words were rewritten (a new tone) blurs across, rather than two texts overlapping. */
.mk-swap { opacity: 1; filter: blur(0); transition: opacity 180ms ease-out, filter 180ms ease-out; }
@starting-style { .mk-swap { opacity: 0; filter: blur(2px); } }

.mk-bubble { max-width: 86%; justify-self: end; background: ${C.talkrSoft}; border: 1px solid rgba(230,20,46,.18); color: ${C.ink}; border-radius: 18px 18px 6px 18px;
  padding: 9px 12px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.mk-list { max-height: 420px; overflow: auto; overscroll-behavior: contain; }
.mk-bar { height: 6px; border-radius: 3px; background: ${C.line2}; overflow: hidden; }
.mk-bar > span { display: block; height: 100%; background: var(--c-primary); border-radius: 3px; transform-origin: left; transition: transform 300ms cubic-bezier(0.23, 1, 0.32, 1); }

@media (prefers-reduced-motion: reduce) {
  .mk-press:active:not(:disabled) { transform: none; }
  .mk-disclosure > button[aria-expanded] svg, .mk-bar > span { transition: none; }
  .mk-reveal { transition: opacity 150ms linear; transform: none; }
  @starting-style { .mk-reveal { transform: none; } }
  .mk-dialog { transition: opacity 150ms linear; }
  @starting-style { .mk-dialog { transform: none; } }
  .mk-swap { transition: opacity 150ms linear; filter: none; }
  @starting-style { .mk-swap { filter: none; } }
}
`;

type BtnKind = 'default' | 'primary' | 'talkr' | 'danger' | 'quiet';
export function Btn({ kind = 'default', size, className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; size?: 'sm' | 'lg' }) {
  return <button type="button" {...p} className={`mk-btn mk-press${kind === 'default' ? '' : ` mk-btn--${kind}`}${size ? ` mk-btn--${size}` : ''} ${className}`} />;
}

export const Eyebrow = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => <div className="mk-eyebrow" style={style}>{children}</div>;

export type Tone = 'mint' | 'green' | 'amber' | 'red' | 'grey' | 'talkr' | 'genius';
const TONE: Record<Tone, string> = { mint: 'var(--c-primary)', green: C.green, amber: '#d97706', red: C.red, grey: C.muted2, talkr: 'var(--c-talkr)', genius: 'var(--c-genius)' };
export const Status = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => (
  <span className="mk-status" style={{ color: TONE[tone] }}>
    <Mark label={typeof children === 'string' ? children : tone} />
    {children}
  </span>
);

/** A row of pressable choices where exactly one is on (radio semantics). */
export function Choice<T extends string>({ value, options, onChange, labels, label }: { value: T; options: readonly T[]; onChange: (v: T) => void; labels?: Partial<Record<T, string>>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} className="mk-chip mk-press" onClick={() => onChange(o)}>
          {labels?.[o] ?? o[0].toUpperCase() + o.slice(1)}
        </button>
      ))}
    </div>
  );
}

/** An on/off switch with its words beside it. */
export function Switch({ on, set, children, disabled, hint }: { on: boolean; set: (v: boolean) => void; children: React.ReactNode; disabled?: boolean; hint?: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '12.5px', cursor: disabled ? 'not-allowed' : 'pointer', lineHeight: 1.45 }} title={hint}>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} style={{ accentColor: 'var(--c-primary)', width: '15px', height: '15px', margin: '1px 0 0', flex: 'none' }} />
      <span style={{ minWidth: 0 }}>{children}</span>
    </label>
  );
}

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 3.5 10.5 8 6 12.5" /></svg>
);

/** Options that most campaigns never touch: shut by default, one press away. */
export function Disclosure({ title, summary, open, onToggle, children, testId }: { title: string; summary?: string; open: boolean; onToggle: () => void; children: React.ReactNode; testId?: string }) {
  const id = useId();
  return (
    <div className="mk-disclosure" data-testid={testId}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className="mk-press"
        style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minHeight: '36px', padding: '0', border: 0, background: 'none', cursor: 'pointer', textAlign: 'left', color: C.ink, transition: 'transform 160ms ease-out' }}>
        <Chevron />
        <span style={{ fontSize: '13px', fontWeight: 600 }}>{title}</span>
        {summary ? <span style={{ fontSize: '12px', color: C.muted2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span> : null}
      </button>
      {open ? <div id={id} className="mk-reveal" style={{ paddingTop: '10px' }}>{children}</div> : null}
    </div>
  );
}

/** A centred confirm, for what costs money or cannot be undone. Esc and the scrim cancel. */
export function Dialog({ title, children, onClose, actions, labelledBy }: { title: string; children: React.ReactNode; onClose: () => void; actions: React.ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('button');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && ref.current) {
        const f = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), a, input, select, textarea'));
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); prev?.focus?.(); };
  }, [onClose]);
  // Portalled to the body: the composer is a size container, which would otherwise pin a fixed scrim to itself.
  return createPortal(
    <div className="mk-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="mk-dialog mk" role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? id}>
        <div style={{ padding: '18px 20px 6px' }}>
          <h2 id={labelledBy ?? id} style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</h2>
        </div>
        <div style={{ padding: '6px 20px 16px' }}>{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 20px', borderTop: `1px solid ${C.line2}`, background: '#fafafa', borderRadius: '0 0 14px 14px', flexWrap: 'wrap' }}>{actions}</div>
      </div>
    </div>,
    document.body,
  );
}

export const initials = (n: string) => n.split(/\s+/).map((w) => w[0] ?? '').slice(0, 2).join('').toUpperCase();
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, borderRadius: '9px', background: C.surface2, display: 'grid', placeItems: 'center', fontSize: '11px', fontWeight: 700, color: '#52525b', flex: 'none' }}>{initials(name)}</span>;
}

/** A plain-words note: a problem that blocks launch (red), one worth a look (amber), or information. */
export function Note({ level, children, action }: { level: 'block' | 'warn' | 'info'; children: React.ReactNode; action?: React.ReactNode }) {
  const s = level === 'block' ? { bg: C.redSoft, fg: '#991b1b', dot: C.red } : level === 'warn' ? { bg: C.amberSoft, fg: '#92400e', dot: '#d97706' } : { bg: '#f4f4f5', fg: C.muted, dot: C.muted2 };
  return (
    <div role={level === 'block' ? 'alert' : undefined} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', background: s.bg, color: s.fg, borderRadius: '8px', padding: '8px 10px', fontSize: '12.5px', lineHeight: 1.45 }}>
      <span style={{ color: s.dot, display: 'inline-flex', marginTop: '6px' }}><Mark label={level === 'block' ? 'error' : level === 'warn' ? 'warning' : 'info'} /></span>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {action}
    </div>
  );
}

export const Icon = {
  text: 'M2.5 3.5h11v7.5h-6l-3 2.5V11h-2z',
  mail: 'M2.5 4h11v8h-11zM2.5 4.5 8 9l5.5-4.5',
  phone: 'M3.5 2.5h2.2l1.1 3-1.5 1a8 8 0 0 0 4.2 4.2l1-1.5 3 1.1v2.2a1.5 1.5 0 0 1-1.6 1.5A11.5 11.5 0 0 1 2 4.1a1.5 1.5 0 0 1 1.5-1.6z',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3',
  left: 'M10 3.5 5.5 8 10 12.5',
  right: 'M6 3.5 10.5 8 6 12.5',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1',
  plus: 'M8 3v10M3 8h10',
  mic: 'M8 1.8a2 2 0 0 1 2 2v4a2 2 0 0 1-4 0v-4a2 2 0 0 1 2-2zM4.2 7.5a3.8 3.8 0 0 0 7.6 0M8 11.3v2.9',
  stop: 'M4.5 4.5h7v7h-7z',
  play: 'M5 3.5v9l7-4.5z',
  users: 'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.8 13.5a4.2 4.2 0 0 1 8.4 0M10.5 2.7a2.5 2.5 0 0 1 0 4.6M12 9.6a4.2 4.2 0 0 1 2.2 3.9',
  voicemail: 'M4.5 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM11.5 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM4.5 10.5h7',
};
export const Svg = ({ d, size = 14, color = 'currentColor' }: { d: string; size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: 'none' }}><path d={d} /></svg>
);
