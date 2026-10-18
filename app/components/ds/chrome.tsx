// Shared CLOZR chrome — the Inbox / iPhone look for buttons, segments,
// dropdowns, fields and chevrons. Screens import these instead of inventing
// another pill, another ▾, or another 8px-vs-999px radius.
// Elevation recipes match DESIGN.md §5 (ring / md / lg).
'use client';

import React from 'react';

/** Inter first (via --font-inter), the system sans as the fallback. */
export const SANS = "var(--font-sans)";

export const CZ = {
  ink: 'var(--ink, #18181b)',
  ink2: 'var(--ink-2, #27272a)',
  muted: 'var(--meta, #71717a)',
  faint: 'var(--subtle, #a1a1aa)',
  line: 'var(--divider, #e4e4e7)',
  soft: 'var(--divider-2, #f0f0f1)',
  panel: 'var(--surface, #ffffff)',
  panel2: 'var(--surface-2, #f4f4f5)',
  bg: 'var(--canvas, #fafafa)',
  mint: '#0A8560',
  mintSoft: 'var(--mint-dim, #e7f8f1)',
  tray: 'rgba(118, 118, 128, 0.12)',
  hairline: 'rgba(60, 60, 67, 0.18)',
} as const;

/** Elevation — one recipe per surface (beautiful-shadows). */
export const SHADOW = {
  ring: 'var(--shadow-ring)',
  md: 'var(--shadow-md)',
  lg: 'var(--shadow-lg)',
} as const;

/** iOS segmented control track (All · SMS · Email, Month · Week · Day). */
export const segWrap: React.CSSProperties = {
  display: 'inline-flex',
  gap: 2,
  padding: 3,
  background: CZ.panel2,
  borderRadius: 8,
  maxWidth: '100%',
  overflowX: 'auto',
  scrollbarWidth: 'none',
  flex: 'none',
  boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.04)',
};

/** One segment inside `segWrap`. Active = white raised chip. */
export const seg = (on: boolean, size: 'sm' | 'md' = 'md'): React.CSSProperties => ({
  height: size === 'sm' ? 24 : 26,
  padding: size === 'sm' ? '0 9px' : '0 11px',
  borderRadius: 6,
  border: 0,
  cursor: 'pointer',
  font: `600 ${size === 'sm' ? 11.5 : 12.5}px/1 ${SANS}`,
  background: on ? 'var(--surface, #fff)' : 'transparent',
  color: on ? CZ.ink : CZ.muted,
  boxShadow: on ? '0 1px 2px rgba(0,0,0,.06), 0 0 0 1px rgba(0,0,0,.04)' : 'none',
  flex: 'none',
  whiteSpace: 'nowrap',
});

/**
 * Soft gray tray chip — Inbox Templates / composer tray buttons.
 * Prefer this over full `999px` pills for filters and secondary actions.
 */
export const trayBtn = (on = false): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 32,
  padding: '0 12px',
  borderRadius: 16,
  border: 0,
  background: on ? CZ.mintSoft : CZ.tray,
  color: on ? CZ.mint : CZ.ink,
  font: `600 12.5px/1 ${SANS}`,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flex: 'none',
});

/** Hairline rectangle button — secondary chrome (ghost), ring elevation. */
export const ghostBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  height: 32,
  padding: '0 12px',
  borderRadius: 10,
  border: 0,
  background: 'var(--surface, #fff)',
  font: `600 12.5px/1 ${SANS}`,
  color: CZ.ink,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flex: 'none',
  boxShadow: SHADOW.ring,
};

/** Primary mint fill. */
export const primaryBtn: React.CSSProperties = {
  ...ghostBtn,
  background: CZ.mint,
  color: 'var(--on-dark, #fff)',
  boxShadow: '0 0 0 1px rgba(10,133,96,.35), 0 1px 2px -1px rgba(10,133,96,.35), 0 2px 4px 0 rgba(10,133,96,.12)',
};

/** Near-black fill (Create / appointment). */
export const darkBtn: React.CSSProperties = {
  ...ghostBtn,
  background: CZ.ink,
  color: 'var(--surface, #fff)',
  boxShadow: '0 0 0 1px rgba(0,0,0,.2), 0 1px 2px -1px rgba(0,0,0,.2), 0 2px 4px 0 rgba(0,0,0,.08)',
};

/** Single-line text field / native select shell. */
export const field: React.CSSProperties = {
  height: 32,
  padding: '0 11px',
  borderRadius: 10,
  border: 0,
  background: 'var(--surface, #fff)',
  font: `500 12.5px/1 ${SANS}`,
  color: CZ.ink,
  outline: 'none',
  boxSizing: 'border-box',
  boxShadow: SHADOW.ring,
};

/** Dropdown panel shared by Views, Columns, filter menus. Prefer class `cz-menu`. */
export const menuPanel: React.CSSProperties = {
  position: 'absolute',
  top: 38,
  zIndex: 45,
  background: 'var(--c-menu-bg, #fff)',
  borderRadius: 12,
  padding: 6,
  boxShadow: SHADOW.md,
  animation: 'clozrPop .16s cubic-bezier(.23,1,.32,1)',
  overflow: 'hidden',
};

/** Sentence-case menu section label (DESIGN.md — no tracked caps). */
export const menuHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '8px 10px 6px',
  font: `500 11.5px/1.2 ${SANS}`,
  color: CZ.muted,
};

export const menuItem = (on: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  width: '100%',
  minHeight: 34,
  textAlign: 'left',
  padding: '7px 10px',
  border: 0,
  borderRadius: 8,
  background: on ? CZ.mintSoft : 'transparent',
  cursor: 'pointer',
  font: `${on ? 600 : 400} 12.5px/1.25 ${SANS}`,
  color: on ? CZ.mint : CZ.ink2,
  whiteSpace: 'nowrap',
});

/** Soft info foot inside a dropdown — use class `cz-menu-info` when possible. */
export const menuInfo: React.CSSProperties = {
  margin: '6px 2px 2px',
  padding: '10px 12px',
  borderRadius: 10,
  background: CZ.panel2,
  border: `1px solid ${CZ.line}`,
  borderLeft: `3px solid ${CZ.mint}`,
  font: `500 11.5px/1.5 ${SANS}`,
  color: '#52525b',
};

/** SF-style chevron — replaces the ▾ glyphs scattered through toolbars. */
export function Chevron({
  dir = 'down',
  size = 12,
  color = CZ.faint,
  style,
}: {
  dir?: 'down' | 'up' | 'left' | 'right';
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}) {
  const rot = { down: 0, up: 180, left: 90, right: -90 }[dir];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ transform: `rotate(${rot}deg)`, flex: 'none', display: 'block', ...style }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Round icon button for calendar prev/next (Google Calendar chrome). */
export const iconBtn: React.CSSProperties = {
  width: 36,
  height: 36,
  padding: 0,
  border: 0,
  borderRadius: '50%',
  background: 'transparent',
  color: CZ.ink2,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
};

/** Check mark for selected menu rows. */
export function MenuCheck({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: 'none' }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
