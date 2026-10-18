'use client';

// Shared look for Settings → Email deliverability: the same zinc cards,
// 12.5px type and green accent as the rest of Settings.
//
// In plain words: the building blocks every box on the page is made of.
// Section is one box with a title and a one-line "why this matters";
// HowItWorks hides the long technical explanation until someone asks for it;
// NotSetUp is the short box shown in place of a feature nobody has turned on.

import React, { useState } from 'react';
import { SHADOW, btn } from '@/components/genius/parts';

export const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px', minWidth: 0 };
const h2: React.CSSProperties = { margin: '0 0 4px', fontSize: '13.5px', fontWeight: 650, color: 'var(--ink, #18181b)' };
export const sub: React.CSSProperties = { margin: '0 0 12px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 };
// Buttons and inputs are the app's own (DESIGN.md §5 and §7): ring shadow, not a border.
export const ghost: React.CSSProperties = btn('ghost', true);
export const primary: React.CSSProperties = btn('purple', true);
export const danger: React.CSSProperties = { ...btn('ghost', true), color: 'var(--tx-red, #b91c1c)' };
export const input: React.CSSProperties = { height: '32px', padding: '0 10px', border: 0, boxShadow: SHADOW.ring, borderRadius: '8px', fontSize: '13px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' };
export const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px', wordBreak: 'break-all' };
export const row: React.CSSProperties = { padding: '10px 0', borderTop: '1px solid var(--divider-2, #f0f0f1)' };
/** Sentence-case label above an input (DESIGN.md §1: no tracked caps). */
export const fieldLabel: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 500, marginBottom: '4px' };

/**
 * Hover, press and focus for every control on the page. Inline styles cannot
 * express :focus-visible, so the page root carries data-dlv and this sheet.
 */
export const DLV_CSS = `
[data-dlv] button, [data-dlv] summary, [data-dlv] label.dlv-file { transition: filter .12s ease, transform .14s cubic-bezier(.23,1,.32,1); }
[data-dlv] button:focus-visible, [data-dlv] summary:focus-visible, [data-dlv] input:focus-visible, [data-dlv] select:focus-visible, [data-dlv] textarea:focus-visible, [data-dlv] label.dlv-file:focus-within { outline: 2px solid #0A8560; outline-offset: 2px; }
[data-dlv] button:disabled { opacity: .5; cursor: default; }
[data-dlv] button:not(:disabled):active { transform: scale(.97); }
@media (hover: hover) and (pointer: fine) { [data-dlv] button:not(:disabled):hover, [data-dlv] label.dlv-file:hover { filter: brightness(.96); } }
[data-dlv] summary { list-style: none; cursor: pointer; }
[data-dlv] summary::-webkit-details-marker { display: none; }
[data-dlv] details[open] > summary .dlv-chev { transform: rotate(90deg); }
[data-dlv] .dlv-chev { transition: transform .14s cubic-bezier(.23,1,.32,1); }
[data-dlv] ::placeholder { color: var(--meta, #71717a); }
@media (max-width: 640px) { [data-dlv] input, [data-dlv] select, [data-dlv] textarea { font-size: 16px; } }
@media (prefers-reduced-motion: reduce) { [data-dlv] * { transition: none !important; } }
`;

export type Tone = 'good' | 'warn' | 'bad' | 'muted';
const TONES: Record<Tone, [string, string, string]> = {
  good: ['var(--c-action-soft, #e7f5ef)', 'var(--c-action-line, #a7dcc5)', '#08694C'],
  warn: ['var(--caution-soft, #fef3c7)', 'var(--tint-amber-2, #fde68a)', '#92400e'],
  bad: ['var(--negative-soft, #fee2e2)', 'var(--tint-red-2, #fecaca)', '#b91c1c'],
  muted: ['var(--surface-2, #f4f4f5)', 'var(--divider, #e4e4e7)', 'var(--muted, #52525b)'],
};

export function Badge({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  const [bg, border, color] = TONES[tone];
  return <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', height: '20px', padding: '0 7px', borderRadius: '6px', background: bg, border: `1px solid ${border}`, color, fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>;
}

export const toneOf = (status: string): Tone => (status === 'pass' ? 'good' : status === 'fail' ? 'bad' : status === 'warn' ? 'warn' : 'muted');

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" style={{ ...ghost, height: '26px', fontSize: '11.5px' }} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }); }}>
      {done ? 'Copied' : label}
    </button>
  );
}

export function Note({ note }: { note: { ok: boolean; text: string } | null }) {
  if (!note) return null;
  return <p role={note.ok ? 'status' : 'alert'} style={{ margin: '8px 0 0', fontSize: '12px', color: note.ok ? 'var(--tx-mint-deep, #08694c)' : '#b91c1c' }}>{note.text}</p>;
}

export const pct = (n: number | null | undefined, digits = 1) => (n == null ? 'n/a' : `${(n * 100).toFixed(digits)}%`);

/** "just now", "3 h ago", "yesterday", "in 5 days". Pair it with fullDate in a title. */
export function relDays(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const days = Math.round((t - now) / 86_400_000);
  if (days === 0) {
    const hours = Math.round((now - t) / 3_600_000);
    return hours <= 0 ? 'just now' : hours < 24 ? `${hours} h ago` : 'today';
  }
  return new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(days, 'day');
}
export const fullDate = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '');

/** Lucide-geometry icons, 2px stroke, currentColor. Decorative, so hidden from screen readers. */
export function Icon({ name, size = 14 }: { name: 'chevron' | 'check' | 'x' | 'alert' | 'clock' | 'minus'; size?: number }) {
  const paths: Record<typeof name, React.ReactNode> = {
    chevron: <path d="m9 18 6-6-6-6" />,
    check: <path d="M20 6 9 17l-5-5" />,
    x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
    alert: <><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></>,
    clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
    minus: <path d="M5 12h14" />,
  };
  return (
    <svg className={name === 'chevron' ? 'dlv-chev' : undefined} aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      {paths[name]}
    </svg>
  );
}

const MARK: Record<Tone, ['check' | 'x' | 'alert' | 'minus', string]> = { good: ['check', '#0A8560'], bad: ['x', '#b91c1c'], warn: ['alert', '#b45309'], muted: ['minus', 'var(--meta, #71717a)'] };

/** A status mark that never relies on colour alone: each tone has its own shape. */
export function Mark({ tone, size = 14 }: { tone: Tone; size?: number }) {
  const [name, color] = MARK[tone];
  return <span style={{ color, display: 'inline-flex' }}><Icon name={name} size={size} /></span>;
}

/**
 * A row that opens to show more, using the browser's own details element.
 * Problems pass `open` so they start expanded; healthy rows stay closed.
 */
export function Fold({ id, summary, open, children, style }: { id?: string; summary: React.ReactNode; open?: boolean; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <details id={id} open={open} style={{ scrollMarginTop: '72px', ...style }}>
      <summary style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '32px', flexWrap: 'wrap', borderRadius: '6px' }}>
        <span style={{ display: 'inline-flex', color: 'var(--meta, #71717a)' }}><Icon name="chevron" /></span>
        {summary}
      </summary>
      <div style={{ padding: '4px 0 6px 22px', minWidth: 0 }}>{children}</div>
    </details>
  );
}

/**
 * The long technical explanation, folded away. Nothing was deleted from the
 * old page: every paragraph that used to sit on top now lives in one of these.
 */
function HowItWorks({ children, label = 'How this works' }: { children: React.ReactNode; label?: string }) {
  return (
    <details style={{ margin: '0 0 12px' }}>
      <summary style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', fontSize: '12px', fontWeight: 600, color: 'var(--tx-mint, #0a8560)', borderRadius: '6px' }}>
        <Icon name="chevron" size={13} />{label}
      </summary>
      <div style={{ marginTop: '6px', padding: '10px 12px', background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider-2, #f0f0f1)', borderRadius: '8px', fontSize: '12px', color: 'var(--ink-3, #3f3f46)', lineHeight: 1.55, maxWidth: '64ch' }}>
        {children}
      </div>
    </details>
  );
}

/**
 * One box on the page: title, a single plain sentence on what it is and why
 * the owner should care, optional buttons on the right, then its content.
 */
export function Section({ id, title, why, actions, how, children }: { id?: string; title: React.ReactNode; why: React.ReactNode; actions?: React.ReactNode; how?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section id={id} style={{ ...card, scrollMarginTop: '72px' }} aria-label={typeof title === 'string' ? title : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <h3 style={{ ...h2, marginRight: 'auto' }}>{title}</h3>
        {actions}
      </div>
      <p style={{ ...sub, margin: how ? '0 0 6px' : sub.margin, maxWidth: '64ch' }}>{why}</p>
      {how ? <HowItWorks>{how}</HowItWorks> : null}
      {children}
    </section>
  );
}

/** A feature nobody has switched on: one line on what it gives, one button. */
export function NotSetUp({ id, title, why, action, how }: { id?: string; title: string; why: React.ReactNode; action?: React.ReactNode; how?: React.ReactNode }) {
  return (
    <section id={id} style={{ ...card, scrollMarginTop: '72px' }} aria-label={title}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <h3 style={{ ...h2, margin: 0 }}>{title}</h3>
        <Badge tone="muted">Not set up</Badge>
      </div>
      <p style={{ ...sub, margin: '4px 0 10px', maxWidth: '64ch' }}>{why}</p>
      {how ? <HowItWorks>{how}</HowItWorks> : null}
      {action}
    </section>
  );
}

/** The heading over a group of boxes ("Cold email", "Warm email"). */
export function GroupHeading({ id, title, why }: { id: string; title: string; why: string }) {
  return (
    <div style={{ margin: '20px 0 10px', paddingTop: '14px', borderTop: '1px solid var(--divider, #e4e4e7)' }}>
      <h2 id={id} style={{ margin: 0, fontSize: '15px', fontWeight: 700, letterSpacing: '-0.015em', color: 'var(--ink, #18181b)' }}>{title}</h2>
      <p style={{ margin: '3px 0 0', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5, maxWidth: '64ch' }}>{why}</p>
    </div>
  );
}

/**
 * Scroll the page to a section and focus its first control, for the "do this
 * next" button and the links in the status box. A folded row opens first.
 */
export function goTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  const focusable = el.querySelector<HTMLElement>('button, summary, input');
  focusable?.focus({ preventScroll: true });
}
