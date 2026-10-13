'use client';

// Phosphor fill icons (MIT) for the marks that used to be 6px squares.
// The path data lives in lib/stage-mark.ts.

import { STAGE_GLYPHS, markGlyph } from '@/lib/stage-mark';

export function Mark({ label, size = 13 }: { label: string; size?: number }) {
  const name = markGlyph(label);
  const viewBox = name === 'tire' ? '0 0 24 24' : '0 0 256 256';
  return (
    <svg width={size} height={size} viewBox={viewBox} aria-hidden focusable="false" style={{ flex: 'none', display: 'block' }}>
      <path fill="currentColor" d={STAGE_GLYPHS[name]} />
    </svg>
  );
}

/** Buyers who reply rarely, or who offer and never close. */
export function TireChip() {
  return (
    <span title="Answers 25% or less of what the team sends, or makes offers and never closes" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 7px', borderRadius: 999, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', flex: 'none' }}>
      <Mark label="Tire kicker" size={13} />
      Tire kicker
    </span>
  );
}
