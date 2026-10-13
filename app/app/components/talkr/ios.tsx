'use client';

import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * The iOS segmented control (the Phone app's Keypad / Recents switch): a grey
 * track with a white thumb. Same props as ui.tsx `Segmented`, so the dialer
 * swaps it in without touching the shared primitive the inbox uses.
 */
export function IosSegmented<T extends string>({
  value,
  options,
  onChange,
  full = false,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  /** Stretch to the container, segments equal width. */
  full?: boolean;
}) {
  return (
    <div
      role="tablist"
      // Marks it as a segmented control, so the phone's many-up grid reflow
      // (globals.css, max-width 820) leaves its one row of segments alone.
      data-seg=""
      className={full ? 'grid' : 'inline-grid'}
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
        gap: 2,
        padding: 2,
        borderRadius: 9,
        background: 'rgba(118,118,128,.12)',
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className="truncate"
          style={{
            padding: '6px 10px',
            borderRadius: 7,
            border: 'none',
            cursor: 'pointer',
            font: `${value === o.value ? 600 : 500} 12px/1.1 var(--sans)`,
            background: value === o.value ? '#fff' : 'transparent',
            color: 'var(--text)',
            boxShadow: value === o.value ? '0 3px 8px rgba(0,0,0,.12), 0 1px 1px rgba(0,0,0,.04)' : 'none',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The same grey pill as a dropdown, for a phone screen where five or six
 * segments would squeeze each other down to a letter each: the current choice
 * with a chevron, and the native <select> laid invisibly over it so a tap
 * opens iOS's own picker.
 */
export function IosSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <label
      className="relative inline-flex shrink-0 items-center gap-1.5"
      style={{
        padding: '7px 10px 7px 12px',
        borderRadius: 9,
        background: 'rgba(118,118,128,.12)',
        font: '600 12px/1.1 var(--sans)',
        color: 'var(--text)',
      }}
    >
      <span className="truncate">{current?.label}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m6 9 6 6 6-6" />
      </svg>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The full-screen phone's bottom sheet (PhoneScreen.tsx): slides up over the
 * phone and never past it, a backdrop that closes it, and its own scroller so
 * the phone behind it never moves. Flex, not grid, all the way down.
 */
export function PhoneSheet({
  open,
  onClose,
  title,
  children,
  height,
  tone = 'dark',
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** A fixed height (e.g. '88%'); otherwise it fits its content up to 88%. */
  height?: string;
  /** 'light' for the stock Talkr forms, which read on white. */
  tone?: 'dark' | 'light';
  testId?: string;
}) {
  if (!open) return null;
  return (
    <>
      <div className="phone-sheet-backdrop" data-testid="phone-sheet-backdrop" onClick={onClose} aria-hidden />
      <div role="dialog" aria-label={title} data-testid={testId} className={`phone-sheet phone-${tone}`} style={height ? { height } : undefined}>
        <div className="phone-sheet-grab" aria-hidden />
        <div className="phone-sheet-head">
          <span className="min-w-0 truncate">{title}</span>
          <button type="button" className="phone-textbtn" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="phone-sheet-body">{children}</div>
      </div>
    </>
  );
}

export interface PhoneTab<T extends string> {
  value: T;
  label: string;
  icon: IconName;
  badge?: number | null;
  testId: string;
}

/** The phone's own tab bar (Recents, Queue, Keypad, Voicemail, Live): a flex row, one line always. */
export function PhoneTabBar<T extends string>({
  tabs,
  active,
  onPick,
}: {
  tabs: Array<PhoneTab<T>>;
  active: T;
  onPick: (next: T) => void;
}) {
  return (
    <nav className="phone-tabbar" role="tablist" aria-label="Phone">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={active === t.value}
          data-testid={t.testId}
          className="phone-tab"
          onClick={() => onPick(t.value)}
        >
          <Icon name={t.icon} size={24} strokeWidth={active === t.value ? 2.2 : 1.9} />
          <span>{t.label}</span>
          {t.badge ? <span className="phone-badge">{t.badge > 99 ? '99+' : t.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}
