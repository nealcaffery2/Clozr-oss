// The close date on a Deals card, as a full-width bar under the photo: the one
// date every rep needs at a glance. Words and colour both carry the state
// (lib/close-date.ts): ink for an upcoming close, amber within three days,
// solid amber today, solid red once the date has passed, green once closed,
// and a dashed amber bar when a contract-stage deal has no date.
'use client';

import React from 'react';
import type { CloseBadge, CloseTone } from '@/lib/close-date';

// Text on each fill is at least 4.5:1: white on #18181b 17:1, on #b45309 5:1,
// on #b91c1c 6.5:1; #8a3f0a on #fff6df 7:1; #0b6045 on #eaf8f1 6.9:1.
const TONE: Record<CloseTone, { bg: string; fg: string; border?: string }> = {
  upcoming: { bg: '#18181b', fg: '#ffffff' },
  soon: { bg: '#fff6df', fg: '#8a3f0a', border: '#f1d58a' },
  today: { bg: '#b45309', fg: '#ffffff' },
  late: { bg: '#b91c1c', fg: '#ffffff' },
  closed: { bg: '#eaf8f1', fg: '#0b6045', border: '#b4e3cd' },
  missing: { bg: '#fffbeb', fg: '#8a3f0a', border: '#f1d58a' },
};

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: 'none' }}>
      <rect x="3" y="4.5" width="18" height="16.5" rx="2.5" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </svg>
  );
}

/** `edge` = sits flush under a photo (square corners); otherwise a rounded pill-bar. */
export function CloseBar({ badge, edge = false }: { badge: CloseBadge | null; edge?: boolean }) {
  if (!badge) return null;
  const t = TONE[badge.tone];
  return (
    <div
      data-testid="deal-close"
      data-tone={badge.tone}
      title={badge.title}
      role="note"
      aria-label={[badge.label, badge.detail].filter(Boolean).join(', ')}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, minHeight: 34, padding: edge ? '7px 12px 7px 14px' : '7px 10px',
        background: t.bg, color: t.fg,
        borderBottom: edge ? `1px solid ${t.border ?? t.bg}` : undefined,
        border: edge ? undefined : `1px ${badge.tone === 'missing' ? 'dashed' : 'solid'} ${t.border ?? t.bg}`,
        borderRadius: edge ? 0 : 9,
        ...(edge && badge.tone === 'missing' ? { borderBottom: `1px dashed ${t.border}` } : {}),
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <CalendarIcon />
      <span style={{ font: '700 13px/1.2 var(--sans, system-ui)', letterSpacing: '-0.005em', minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{badge.label}</span>
      {badge.detail ? <span style={{ font: '700 12px/1 var(--sans, system-ui)', whiteSpace: 'nowrap', flex: 'none', opacity: badge.tone === 'upcoming' ? 0.85 : 1 }}>{badge.detail}</span> : null}
    </div>
  );
}
