// Small shared pieces for the AI Agent console, in the same inline-style
// vocabulary as the phone settings (app/components/phone/ui.tsx). Every field
// primitive takes an `id` (fieldId(path) from lib/voice-agent-console) so a
// warning or a server error can scroll to the field it is about.
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Copy, Lock, X } from 'lucide-react';
import { GREEN, INK, LINE, MUTED, card } from '@/app/components/phone/ui';
import { DAY_LABELS, DAY_NAMES, toggleDay, zoneLabel, zoneOptions } from '@/lib/voice-agent-console';
import { DAYS, type Hours } from '@/lib/voice-agent';

export { GREEN, INK, LINE, MUTED, card };
export const RED = '#b91c1c';
export const AMBER = '#92400e';

export const h2: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600, color: INK, letterSpacing: '-0.005em' };
export const sub: React.CSSProperties = { margin: '3px 0 0', fontSize: 12.5, color: MUTED, lineHeight: 1.5 };
export const eyebrow: React.CSSProperties = { display: 'block', fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 };
export const input: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 11px', border: `1px solid ${LINE}`, borderRadius: 9, fontSize: 13, outline: 0,
  background: '#fafafa', color: INK, fontFamily: 'inherit', boxSizing: 'border-box',
};
export const areaStyle: React.CSSProperties = { ...input, height: 'auto', padding: '9px 11px', lineHeight: 1.5, resize: 'vertical' };
export const ghost: React.CSSProperties = {
  height: 32, padding: '0 12px', borderRadius: 9, border: '1px solid var(--c-btn-line, #e4e4e7)', background: 'var(--c-btn-bg, #fff)', color: INK,
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap', flex: 'none', fontFamily: 'inherit',
};
export const primary = (off?: boolean): React.CSSProperties => ({
  ...ghost, border: `1px solid ${GREEN}`, background: off ? '#7fcbb2' : GREEN, color: '#fff', cursor: off ? 'not-allowed' : 'pointer',
});
export const danger = (off?: boolean): React.CSSProperties => ({
  ...ghost, border: '1px solid #dc2626', background: off ? '#f0a3a3' : '#dc2626', color: '#fff', cursor: off ? 'not-allowed' : 'pointer',
});
export const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: INK, wordBreak: 'break-all' };
export const linkBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 0, background: 'none', color: GREEN, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
export const invalid: React.CSSProperties = { border: '1px solid #f87171', background: '#fff' };

/** Shared keyframes and focus rings, scoped by the va- prefix. Rendered once by the screen root. */
export function VaStyles() {
  return (
    <style>{`
      @keyframes va-spin { to { transform: rotate(360deg); } }
      @keyframes va-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
      @keyframes va-rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      @keyframes va-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes va-slide { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
      @keyframes va-sheet { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
      .va-spin { animation: va-spin .8s linear infinite; }
      .va-skel { background: linear-gradient(90deg, #f4f4f5, #ececee, #f4f4f5); background-size: 200% 100%; animation: va-pulse 1.4s ease-in-out infinite; border-radius: 8px; }
      .va-in { animation: va-rise .18s ease-out; }
      .va-field:focus { border-color: ${GREEN} !important; background: #fff !important; box-shadow: 0 0 0 3px rgba(10,133,96,.12); }
      .va-btn:focus-visible, .va-row:focus-visible, .va-chip:focus-visible, .va-tab:focus-visible, .va-card:focus-visible { outline: 2px solid ${GREEN}; outline-offset: 2px; }
      .va-row:hover { background: var(--band); }
      .va-ghost:hover:not(:disabled) { background: var(--c-btn-hover, #f4f4f5) !important; }
      .va-prim:hover:not(:disabled) { background: #08694C !important; }
      .va-nav:hover:not([aria-selected="true"]) { background: rgba(255,255,255,.7); }
      .va-agent { transition: box-shadow .16s ease, transform .16s ease, border-color .16s ease; }
      .va-agent:not([data-on]):hover { border-color: var(--edge-hover) !important; box-shadow: var(--elev-2) !important; }
      .va-agent:active { box-shadow: var(--elev-press) !important; }
      @media (prefers-reduced-motion: no-preference) { .va-agent:not([data-on]):hover { transform: translateY(-1px); } .va-agent:active { transform: none; } }
      .va-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
      .va-noscroll { scrollbar-width: none; }
      .va-noscroll::-webkit-scrollbar { display: none; }
      .va-modal-back { animation: va-fade .14s ease-out; }
      .va-modal { animation: va-rise .18s ease-out; }
      .va-drawer { animation: va-slide .2s ease-out; }
      @media (max-width: 640px) { .va-modal, .va-drawer { animation: va-sheet .2s ease-out; } }
      @media (max-width: 640px) {
        .va-bar { padding: 8px 10px !important; gap: 8px !important; }
        .va-bar-status { flex: 1 1 100% !important; }
        .va-bar-btn { flex: 1 1 0 !important; min-width: 0 !important; padding: 0 6px !important; }
        .va-long { display: none; }
      }
      input[type="range"]:focus-visible { outline: 2px solid ${GREEN}; outline-offset: 3px; border-radius: 4px; }
      @media (prefers-reduced-motion: reduce) { .va-spin, .va-skel, .va-in, .va-modal, .va-drawer, .va-modal-back { animation: none !important; } }
    `}</style>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="va-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ h = 14, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="va-skel" aria-hidden="true" style={{ height: h, width: w, ...style }} />;
}

/** iOS-style switch. `label` names it for assistive tech. */
export function Switch({ on, onChange, disabled, label, busy, id }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; busy?: boolean; id?: string }) {
  return (
    <button
      type="button" role="switch" id={id} aria-checked={on} aria-label={label} disabled={disabled || busy} onClick={() => onChange(!on)} className="va-btn"
      style={{
        width: 42, height: 24, borderRadius: 999, border: 0, padding: 2, flex: 'none', position: 'relative',
        background: on ? GREEN : '#d4d4d8', cursor: disabled || busy ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, transition: 'background .15s',
      }}
    >
      <span style={{ display: 'grid', placeItems: 'center', width: 20, height: 20, borderRadius: 999, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transform: `translateX(${on ? 18 : 0}px)`, transition: 'transform .15s', color: GREEN }}>
        {busy ? <Spinner size={11} /> : null}
      </span>
    </button>
  );
}
export { Switch as Toggle };

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button" className="va-btn va-ghost" style={{ ...ghost, height: 30, padding: '0 10px' }} aria-label={`${label} to clipboard`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => undefined);
      }}
    >
      {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {done ? 'Copied' : label}
    </button>
  );
}

export function Banner({ tone, children, action }: { tone: 'error' | 'warn' | 'info' | 'ok'; children: React.ReactNode; action?: React.ReactNode }) {
  const c = tone === 'error' ? { bg: 'var(--danger-bg)', bd: 'var(--danger-line)', fg: 'var(--danger-ink)' }
    : tone === 'warn' ? { bg: 'var(--warn-bg)', bd: 'var(--warn-line)', fg: 'var(--warn-ink)' }
      : tone === 'ok' ? { bg: 'var(--ok-bg)', bd: 'var(--ok-line)', fg: 'var(--ok-ink)' }
        : { bg: 'var(--info-bg)', bd: 'var(--info-line)', fg: 'var(--info-ink)' };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 10, background: c.bg, border: `1px solid ${c.bd}`, color: c.fg, fontSize: 12.5, lineHeight: 1.5 }}>
      <span style={{ flex: '1 1 220px', minWidth: 0 }}>{children}</span>
      {action}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{ padding: '28px 12px', textAlign: 'center' }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>{title}</div>
      {children ? <div style={{ margin: '4px auto 0', maxWidth: 380, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>{children}</div> : null}
    </div>
  );
}

export type BadgeTone = 'green' | 'amber' | 'grey' | 'red' | 'indigo';
const BADGE: Record<BadgeTone, { bg: string; fg: string; ring: string }> = {
  green: { bg: 'var(--ok-bg)', fg: 'var(--ok-ink)', ring: 'var(--ok-line)' }, amber: { bg: 'var(--warn-bg)', fg: 'var(--warn-ink)', ring: 'var(--warn-line)' },
  grey: { bg: '#eef1f6', fg: '#4b4b55', ring: '#d9dfe8' }, red: { bg: 'var(--danger-bg)', fg: 'var(--danger-ink)', ring: 'var(--danger-line)' }, indigo: { bg: 'var(--info-bg)', fg: 'var(--info-ink)', ring: 'var(--info-line)' },
};

export function Badge({ tone = 'grey', children }: { tone?: BadgeTone; children: React.ReactNode }) {
  const c = BADGE[tone];
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: c.bg, color: c.fg, boxShadow: `inset 0 0 0 1px ${c.ring}`, whiteSpace: 'nowrap' }}>{children}</span>;
}

// ---- Layout ---------------------------------------------------------------------------------------

/** A titled card with its description and optional help line, the unit every settings section is built from. */
export function Section({ id, title, description, help, aside, children }: {
  id: string; title: string; description?: string; help?: string; aside?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section style={card} aria-labelledby={id}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '-16px -18px 14px', padding: '12px 18px 11px', flexWrap: 'wrap', background: 'var(--band)', borderBottom: '1px solid var(--band-line)', borderRadius: '11px 11px 0 0' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <h2 id={id} className="cz-title" style={h2}>{title}</h2>
          {description ? <p style={sub}>{description}</p> : null}
          {help ? <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted-2)', lineHeight: 1.45 }}>{help}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export const grid = (min = 240): React.CSSProperties => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))`, gap: 14 });

/** Label, control, then the field's error (or its hint). The error carries the id `${htmlFor}-err` for aria-describedby. */
export function Field({ label, htmlFor, error, hint, aside, children }: { label: string; htmlFor: string; error?: string; hint?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <label htmlFor={htmlFor} style={{ ...eyebrow, flex: 1 }}>{label}</label>
        {aside}
      </div>
      {children}
      {error
        ? <p id={`${htmlFor}-err`} role="alert" style={{ margin: '5px 0 0', fontSize: 12, color: RED, lineHeight: 1.45 }}>{error}</p>
        : hint ? <p style={{ margin: '5px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.45 }}>{hint}</p> : null}
    </div>
  );
}

/** A one-line text field wired to its Field's error and helper text. */
export function TextField({ id, value, onChange, disabled, error, placeholder, maxLength, type = 'text', inputMode, autoComplete }: {
  id: string; value: string; onChange: (v: string) => void; disabled?: boolean; error?: string; placeholder?: string; maxLength?: number; type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']; autoComplete?: string;
}) {
  return (
    <input id={id} className="va-field" type={type} inputMode={inputMode} autoComplete={autoComplete ?? 'off'} style={{ ...input, ...(error ? invalid : null) }} value={value} disabled={disabled} maxLength={maxLength}
      placeholder={placeholder} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} onChange={(e) => onChange(e.target.value)} />
  );
}

/** A textarea with a live character count against `max`; the count turns red past it. */
export const AreaField = React.forwardRef<HTMLTextAreaElement, {
  id: string; value: string; onChange: (v: string) => void; disabled?: boolean; error?: string; placeholder?: string; rows?: number; max?: number; mono?: boolean;
  onFocus?: React.FocusEventHandler<HTMLTextAreaElement>; onSelect?: React.ReactEventHandler<HTMLTextAreaElement>;
}>(function AreaField({ id, value, onChange, disabled, error, placeholder, rows = 4, max, mono, onFocus, onSelect }, ref) {
  const over = max != null && value.length > max;
  return (
    <>
      <textarea id={id} ref={ref} className="va-field" rows={rows} style={{ ...areaStyle, ...(mono ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 } : null), ...(error || over ? invalid : null) }}
        value={value} disabled={disabled} placeholder={placeholder} aria-invalid={!!error || over} aria-describedby={error ? `${id}-err` : max != null ? `${id}-count` : undefined} onChange={(e) => onChange(e.target.value)} onFocus={onFocus} onSelect={onSelect} />
      {max != null ? (
        <div id={`${id}-count`} aria-live="polite" style={{ marginTop: 3, textAlign: 'right', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', color: over ? RED : MUTED }}>
          {value.length.toLocaleString('en-US')} / {max.toLocaleString('en-US')}
        </div>
      ) : null}
    </>
  );
});

/** A setting with its plain-language explanation on the left and its control on the right. */
export function SettingRow({ title, help, children, first, id, error }: { title: string; help?: React.ReactNode; children: React.ReactNode; first?: boolean; id?: string; error?: string }) {
  return (
    <div id={id} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 0', borderTop: first ? 'none' : '1px solid #f0f0f1', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{title}</div>
        {help ? <p style={{ margin: '2px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{help}</p> : null}
        {error ? <p role="alert" style={{ margin: '4px 0 0', fontSize: 12, color: RED }}>{error}</p> : null}
      </div>
      <div style={{ flex: 'none', maxWidth: '100%' }}>{children}</div>
    </div>
  );
}

/** A switch the person may never turn off: shown on, dimmed, with a lock and the reason. */
export function LockedRow({ title, help, why, first }: { title: string; help: string; why: string; first?: boolean }) {
  return (
    <SettingRow title={title} first={first} help={<>{help} <span style={{ color: INK }}>{why}</span></>}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} title="Locked on: this protects callers and cannot be changed">
        <Badge tone="grey"><Lock size={11} aria-hidden="true" /> Always on</Badge>
        <Switch on disabled label={`${title} (locked on)`} onChange={() => undefined} />
      </span>
    </SettingRow>
  );
}

// ---- Choices -------------------------------------------------------------------------------------------

/** A short row of mutually exclusive options. It is a radio group, not a tab list. */
export function Segmented<T extends string>({ value, options, onChange, label, disabled, id }: {
  value: T; options: { id: T; label: string; hint?: string }[]; onChange: (id: T) => void; label: string; disabled?: boolean; id?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} id={id} style={{ display: 'flex', gap: 2, padding: 3, background: '#f4f4f5', borderRadius: 8, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.04)', maxWidth: '100%' }}>
      {options.map((o, i) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" role="radio" aria-checked={on} disabled={disabled} className="va-tab" title={o.hint} tabIndex={on || (!value && i === 0) ? 0 : -1} onClick={() => onChange(o.id)}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = options[(i + step + options.length) % options.length]!;
              onChange(next.id);
              (e.currentTarget.parentElement?.querySelectorAll('button')[options.indexOf(next)] as HTMLElement | undefined)?.focus();
            }}
            style={{ flex: 1, minHeight: 30, padding: '0 11px', border: 0, borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', font: '600 12.5px/1 var(--font-sans)',
              background: on ? '#fff' : 'transparent', color: on ? INK : MUTED, boxShadow: on ? '0 1px 2px rgba(0,0,0,.06), 0 0 0 1px rgba(0,0,0,.04)' : 'none', opacity: disabled && !on ? 0.6 : 1 }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Large radio cards, each with a title and a line of explanation. */
export function ChoiceCards<T extends string>({ value, options, onChange, label, disabled, min = 170 }: {
  value: T; options: { id: T; label: string; hint: string }[]; onChange: (id: T) => void; label: string; disabled?: boolean; min?: number;
}) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))`, gap: 8 }}>
      {options.map((t) => {
        const on = value === t.id;
        return (
          <button key={t.id} type="button" role="radio" aria-checked={on} disabled={disabled} className="va-btn" onClick={() => onChange(t.id)}
            style={{
              textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              border: `1px solid ${on ? GREEN : LINE}`, background: on ? '#E7F8F1' : '#fff', boxShadow: on ? `0 0 0 1px ${GREEN}` : 'none', opacity: disabled && !on ? 0.6 : 1,
            }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: on ? GREEN : INK }}>{t.label}</span>
            <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: MUTED, lineHeight: 1.4 }}>{t.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A range with its two ends named, the current value read out, and a way back to the default (which clears the value). */
export function Slider({ id, label, value, min, max, step, defaultValue, ends, format, onChange, disabled, hint }: {
  id: string; label: string; value: number | null; min: number; max: number; step: number; defaultValue: number; ends: [string, string];
  format?: (n: number) => string; onChange: (v: number | null) => void; disabled?: boolean; hint?: string;
}) {
  const shown = value ?? defaultValue;
  const fmt = format ?? ((n: number) => String(n));
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <label htmlFor={id} style={{ ...eyebrow, marginBottom: 0, flex: 1 }}>{label}</label>
        <output htmlFor={id} style={{ fontSize: 12.5, fontWeight: 600, color: value == null ? MUTED : INK, fontVariantNumeric: 'tabular-nums' }}>{value == null ? `Default (${fmt(defaultValue)})` : fmt(value)}</output>
        <button type="button" className="va-btn" disabled={disabled || value == null} onClick={() => onChange(null)} aria-label={`Reset ${label} to default`}
          style={{ padding: 0, border: 0, background: 'none', fontSize: 12, fontWeight: 600, color: value == null || disabled ? '#d4d4d8' : GREEN, cursor: value == null || disabled ? 'default' : 'pointer', fontFamily: 'inherit' }}>Reset</button>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={shown} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: GREEN, cursor: disabled ? 'not-allowed' : 'pointer', opacity: value == null ? 0.55 : 1 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, color: MUTED }}><span>{ends[0]}</span><span style={{ textAlign: 'right' }}>{ends[1]}</span></div>
      {hint ? <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.45 }}>{hint}</p> : null}
    </div>
  );
}

/** A whole-number scale (1 to 5, 0 to 3) with plain-language ends and a word for where it sits now. */
export function Scale({ id, label, value, min, max, ends, words, onChange, disabled, hint, format }: {
  id: string; label: string; value: number; min: number; max: number; ends: [string, string]; words?: string[]; onChange: (v: number) => void; disabled?: boolean; hint?: string;
  format?: (n: number) => string;
}) {
  const word = words?.[value - min] ?? (format ? format(value) : String(value));
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <label htmlFor={id} style={{ ...eyebrow, marginBottom: 0, flex: 1 }}>{label}</label>
        <output htmlFor={id} style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>{word}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={1} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={word} style={{ width: '100%', accentColor: GREEN, cursor: disabled ? 'not-allowed' : 'pointer' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, color: MUTED }}><span>{ends[0]}</span><span style={{ textAlign: 'right' }}>{ends[1]}</span></div>
      {hint ? <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.45 }}>{hint}</p> : null}
    </div>
  );
}

/** A number in a fixed range with its unit, edited by slider; the value reads out beside the label. */
export function RangeField({ id, label, value, min, max, step, unit, onChange, disabled, hint, error, format }: {
  id: string; label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void; disabled?: boolean; hint?: string; error?: string;
  format?: (n: number) => string;
}) {
  const shown = format ? format(value) : `${value}${unit ?? ''}`;
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint} aside={<output htmlFor={id} style={{ fontSize: 12.5, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>{shown}</output>}>
      <input id={id} type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={shown} style={{ width: '100%', accentColor: GREEN, cursor: disabled ? 'not-allowed' : 'pointer', display: 'block', height: 24 }} />
    </Field>
  );
}

/** Removable chips with an inline adder. `add` returns the next list, so the caller's dedupe and caps stay in one place. */
export function ChipList({ id, items, onChange, add, placeholder, disabled, max, label }: {
  id: string; items: string[]; onChange: (next: string[]) => void; add: (list: string[], text: string) => string[]; placeholder: string; disabled?: boolean; max: number; label?: string;
}) {
  const [text, setText] = useState('');
  const commit = () => {
    const next = add(items, text);
    if (next !== items) onChange(next);
    setText('');
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 6, border: `1px solid ${LINE}`, borderRadius: 9, background: '#fafafa', minHeight: 40, alignItems: 'center' }}
      onClick={() => document.getElementById(id)?.focus()}>
      {items.map((c) => (
        <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 26, padding: '0 4px 0 10px', borderRadius: 999, background: '#fff', border: `1px solid ${LINE}`, fontSize: 12.5, fontWeight: 500, color: INK, maxWidth: '100%' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c}</span>
          {!disabled ? (
            <button type="button" className="va-chip" aria-label={`Remove ${c}`} onClick={(e) => { e.stopPropagation(); onChange(items.filter((x) => x !== c)); }}
              style={{ display: 'grid', placeItems: 'center', width: 20, height: 20, borderRadius: 999, border: 0, background: 'transparent', color: MUTED, cursor: 'pointer', padding: 0 }}>
              <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>&times;</span>
            </button>
          ) : <span style={{ width: 6 }} />}
        </span>
      ))}
      {!disabled && items.length < max ? (
        <input id={id} aria-label={label} value={text} maxLength={120} placeholder={items.length ? 'Add another' : placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
            else if (e.key === 'Backspace' && !text && items.length) onChange(items.slice(0, -1));
          }}
          style={{ flex: '1 1 130px', minWidth: 110, height: 26, border: 0, outline: 0, background: 'transparent', fontSize: 13, color: INK, fontFamily: 'inherit' }} />
      ) : null}
      {disabled && !items.length ? <span style={{ fontSize: 12.5, color: MUTED, padding: '0 6px' }}>None</span> : null}
    </div>
  );
}

/** Up and down buttons for a list item (drag-free reorder), and a remove button. */
export function ItemControls({ i, count, onMove, onRemove, what }: { i: number; count: number; onMove: (dir: -1 | 1) => void; onRemove?: () => void; what: string }) {
  const b: React.CSSProperties = { display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 7, border: 0, background: 'transparent', color: MUTED, cursor: 'pointer', padding: 0, flex: 'none' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0, flex: 'none' }}>
      <button type="button" className="va-btn va-ghost" aria-label={`Move ${what} up`} disabled={i === 0} onClick={() => onMove(-1)} style={{ ...b, opacity: i === 0 ? 0.3 : 1, cursor: i === 0 ? 'default' : 'pointer' }}><ArrowUp size={15} aria-hidden="true" /></button>
      <button type="button" className="va-btn va-ghost" aria-label={`Move ${what} down`} disabled={i === count - 1} onClick={() => onMove(1)} style={{ ...b, opacity: i === count - 1 ? 0.3 : 1, cursor: i === count - 1 ? 'default' : 'pointer' }}><ArrowDown size={15} aria-hidden="true" /></button>
      {onRemove ? <button type="button" className="va-btn va-ghost" aria-label={`Remove ${what}`} onClick={onRemove} style={{ ...b, color: RED }}><X size={15} aria-hidden="true" /></button> : null}
    </span>
  );
}

/**
 * One rule the agent follows. Hard rules are never broken; soft ones are
 * preferences it may bend. Read-only when there is no `onText`.
 */
export function RuleCard({ id, kind, severity, text, error, i, count, onText, onSeverity, onMove, onRemove }: {
  id: string; kind: 'always' | 'never'; severity: 'hard' | 'soft'; text: string; error?: string; i: number; count: number;
  onText?: (t: string) => void; onSeverity?: (s: 'hard' | 'soft') => void; onMove?: (dir: -1 | 1) => void; onRemove?: () => void;
}) {
  const hard = severity === 'hard';
  const edit = !!onText;
  return (
    <div id={id} style={{ padding: '9px 10px 9px 12px', borderRadius: 10, border: `1px solid ${error ? '#f87171' : hard ? 'var(--danger-line)' : 'var(--inset-line)'}`, background: hard ? 'var(--danger-bg)' : 'var(--inset)', boxShadow: 'var(--elev-inset)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ flex: 'none', fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
          background: kind === 'never' ? (hard ? '#fee2e2' : '#f4f4f5') : '#E7F8F1', color: kind === 'never' ? (hard ? RED : '#52525b') : GREEN }}>{kind === 'never' ? 'Never' : 'Always'}</span>
        <span style={{ flex: 1 }} />
        {edit && onMove ? <ItemControls i={i} count={count} onMove={onMove} onRemove={onRemove} what={`rule ${i + 1}`} /> : null}
      </div>
      {edit ? (
        <textarea aria-label={`${kind === 'never' ? 'Never' : 'Always'} rule ${i + 1}`} className="va-field" rows={2} value={text} onChange={(e) => onText(e.target.value)} placeholder={kind === 'never' ? 'Never quote a price outside the range.' : 'Ask one question at a time.'}
          aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined}
          style={{ ...areaStyle, width: '100%', minHeight: 40, resize: 'vertical', background: '#fff', fontSize: 13 }} />
      ) : <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: INK, overflowWrap: 'anywhere' }}>{text}</p>}
      {edit && onSeverity ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <Segmented<'hard' | 'soft'> label={`Strictness of rule ${i + 1}`} value={severity} onChange={onSeverity} options={[{ id: 'hard', label: 'Hard rule', hint: 'The agent never breaks it.' }, { id: 'soft', label: 'Soft rule', hint: 'A preference it may bend when the call calls for it.' }]} />
          <span style={{ fontSize: 12, color: MUTED }}>{hard ? 'Never broken.' : 'A preference; it may bend.'}</span>
        </div>
      ) : null}
      {error ? <p id={`${id}-err`} role="alert" style={{ margin: '6px 0 0', fontSize: 12, color: RED }}>{error}</p> : null}
    </div>
  );
}

// ---- Hours -------------------------------------------------------------------------------------------------

/** Day chips, a start and end time, and a zone: one window when the agent (or a destination) is available. */
export function HoursEditor({ id, value, onChange, disabled, error, local, noDays }: { id: string; value: Hours; onChange: (h: Hours) => void; disabled?: boolean; error?: string; local?: string; noDays?: boolean }) {
  const zones = zoneOptions(value.tz, local);
  const bad = error ? invalid : null;
  return (
    <div id={id} style={{ display: 'grid', gap: 12 }}>
      {noDays ? null : <div>
        <span style={eyebrow} id={`${id}-days-l`}>Days</span>
        <div role="group" aria-labelledby={`${id}-days-l`} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {DAYS.map((d) => {
            const on = value.days.includes(d);
            return (
              <button key={d} type="button" aria-pressed={on} aria-label={DAY_NAMES[d]} disabled={disabled} className="va-btn" onClick={() => onChange({ ...value, days: toggleDay(value.days, d) })}
                style={{ minWidth: 46, height: 34, padding: '0 8px', borderRadius: 9, border: `1px solid ${on ? GREEN : LINE}`, background: on ? '#E7F8F1' : '#fff', color: on ? GREEN : MUTED,
                  fontSize: 12.5, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: disabled && !on ? 0.6 : 1 }}>
                {DAY_LABELS[d]}
              </button>
            );
          })}
        </div>
      </div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 120px), 1fr))', gap: 12 }}>
        <Field label="From" htmlFor={`${id}-from`}>
          <input id={`${id}-from`} className="va-field" type="time" style={{ ...input, ...bad }} value={value.start} disabled={disabled} onChange={(e) => onChange({ ...value, start: e.target.value })} />
        </Field>
        <Field label="To" htmlFor={`${id}-to`}>
          <input id={`${id}-to`} className="va-field" type="time" style={{ ...input, ...bad }} value={value.end} disabled={disabled} onChange={(e) => onChange({ ...value, end: e.target.value })} />
        </Field>
        <Field label="Time zone" htmlFor={`${id}-tz`}>
          <select id={`${id}-tz`} className="va-field" style={{ ...input, ...bad }} value={value.tz} disabled={disabled} onChange={(e) => onChange({ ...value, tz: e.target.value })}>
            {zones.map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
          </select>
        </Field>
      </div>
      {error ? <p role="alert" style={{ margin: 0, fontSize: 12, color: RED }}>{error}</p> : null}
    </div>
  );
}

// ---- Dialogs -------------------------------------------------------------------------------------------------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog (centered) or drawer (right, a bottom sheet on a phone). It
 * holds focus while open, closes on Escape and on the backdrop unless `busy`,
 * locks page scroll, and hands focus back to whatever opened it.
 */
export function Dialog({ title, titleId, onClose, children, footer, busy, placement = 'center', width = 560 }: {
  title: string; titleId: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; busy?: boolean; placement?: 'center' | 'right'; width?: number;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? box.current;
    first?.focus();
    return () => { document.body.style.overflow = prev; opener?.focus?.(); };
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab' || !box.current) return;
    const nodes = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!nodes.length) { e.preventDefault(); return; }
    const a = nodes[0]!; const z = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  };
  const right = placement === 'right';
  return (
    <div className="va-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} onKeyDown={onKey}
      style={{ position: 'fixed', inset: 0, zIndex: 98, background: 'rgba(24,24,27,.42)', display: 'flex', alignItems: right ? 'stretch' : 'center', justifyContent: right ? 'flex-end' : 'center', padding: right ? 0 : 16 }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={right ? 'va-drawer' : 'va-modal'}
        style={{
          background: '#fff', display: 'flex', flexDirection: 'column', width: `min(100%, ${width}px)`, maxHeight: right ? '100%' : 'min(100%, 760px)', height: right ? '100%' : undefined,
          borderRadius: right ? '14px 0 0 14px' : 14, boxShadow: 'var(--elev-3)', outline: 0, minWidth: 0, boxSizing: 'border-box',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 12px 18px', borderBottom: '1px solid var(--band-line)', background: 'var(--band)', borderRadius: right ? '14px 0 0 0' : '14px 14px 0 0' }}>
          <h2 id={titleId} style={{ ...h2, flex: 1, fontSize: 15 }}>{title}</h2>
          <button type="button" className="va-btn va-ghost" aria-label="Close" disabled={busy} onClick={close} style={{ ...ghost, width: 30, height: 30, padding: 0 }}><X size={16} aria-hidden="true" /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 18px' }}>{children}</div>
        {footer ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', padding: '12px 18px', borderTop: '1px solid var(--band-line)', background: 'var(--page)', borderRadius: right ? 0 : '0 0 14px 14px' }}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, titleId, children, confirmLabel, busy, error, onConfirm, onClose, tone = 'danger' }: {
  title: string; titleId: string; children: React.ReactNode; confirmLabel: string; busy?: boolean; error?: string | null; onConfirm: () => void; onClose: () => void; tone?: 'danger' | 'primary';
}) {
  return (
    <Dialog title={title} titleId={titleId} onClose={onClose} busy={busy} width={440}
      footer={(
        <>
          <button type="button" className="va-btn va-ghost" style={ghost} disabled={busy} onClick={onClose} data-autofocus>Cancel</button>
          <button type="button" className={`va-btn ${tone === 'danger' ? '' : 'va-prim'}`} disabled={busy} onClick={onConfirm} style={{ ...(tone === 'danger' ? danger(busy) : primary(busy)), minWidth: 110 }}>
            {busy ? <Spinner size={14} /> : null}{confirmLabel}
          </button>
        </>
      )}>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: INK }}>{children}</div>
      {error ? <div style={{ marginTop: 12 }}><Banner tone="error">{error}</Banner></div> : null}
    </Dialog>
  );
}

/** A number with a label, for the stats cards. */
export function Stat({ label, value, hint, wide }: { label: string; value: string; hint?: string; wide?: boolean }) {
  return (
    <div title={hint} style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--edge)', background: '#fff', boxShadow: 'var(--elev-1)', minWidth: 0, gridColumn: wide ? 'span 2' : undefined }}>
      <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 20, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>{value}</div>
    </div>
  );
}
