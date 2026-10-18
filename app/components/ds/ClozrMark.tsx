// CLOZR logo — the linked loops ("CO", one stroke) and the Clozr wordmark,
// from the brand kit v1.0, in CLOZR mint where the kit uses its red accent.
//
// Drawn as inline SVG rather than an image file so it stays crisp at any size
// and carries no background of its own. The wordmark is text in the app's own
// font stack (Inter in the kit), so the logo matches the UI type rather than
// shipping a second typeface. public/favicon.svg and the app icons are the
// same mark on a mint tile.
'use client';

import React from 'react';

/** The mint used for the mark. */
export const CLOZR_MINT = '#12D69A';
/** A deeper mint for the mark on white and the app-icon tile, where the bright one under-reads. */
export const CLOZR_MINT_INK = '#0BA97A';

/**
 * The loops: a C open to the right, one diagonal, an O open at the bottom
 * left. One stroke, round ends. Width is 2× the height.
 */
const LOOPS = 'M44.7 19.3A18 18 0 1 0 44.7 44.7L75.3 19.3A18 18 0 1 1 75.3 44.7';

/** The mark on its own. `size` is its height in px. */
export function ClozrIcon({ size = 16, color = CLOZR_MINT_INK, title }: { size?: number; color?: string; title?: string }) {
  return (
    <svg width={size * 2} height={size} viewBox="4 4 112 56" fill="none" style={{ display: 'block', flex: 'none' }}
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d={LOOPS} stroke={color} strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The app-icon tile: the white mark on mint, as on the home screen and in the favicon. */
export function ClozrAppIcon({ size = 30, radius }: { size?: number; radius?: number }) {
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: radius ?? size * 0.24, background: CLOZR_MINT_INK, display: 'grid', placeItems: 'center', flex: 'none' }}>
      <ClozrIcon size={size * 0.36} color="var(--on-dark, #fff)" />
    </span>
  );
}

/** The horizontal lockup: mark and wordmark, with the tagline beneath when asked. */
export function ClozrMark({
  size = 18,
  tone = 'ink',
  tagline = false,
  ...rest
}: {
  /** Cap height of the wordmark in px. */
  size?: number;
  /** 'ink' for light backgrounds, 'light' for dark ones. */
  tone?: 'ink' | 'light';
  /** Show THE CRM THAT CLOSES beneath. */
  tagline?: boolean;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const letter = tone === 'light' ? 'var(--surface, #ffffff)' : 'var(--ink, #18181b)';
  return (
    <span
      role="img"
      aria-label="Clozr"
      {...rest}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: tagline ? size * 0.34 : 0,
        lineHeight: 1,
        ...(rest.style || {}),
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.38 }}>
        <ClozrIcon size={size * 0.98} color={tone === 'light' ? CLOZR_MINT : CLOZR_MINT_INK} />
        <span style={{ fontWeight: 800, fontSize: size * 1.36, letterSpacing: '-0.035em', color: letter, lineHeight: 1 }}>Clozr</span>
      </span>
      {tagline ? (
        <span
          style={{
            alignSelf: 'flex-end',
            fontSize: size * 0.34,
            color: tone === 'light' ? 'rgba(255,255,255,.72)' : 'var(--meta, #71717a)',
            fontWeight: 500,
            marginRight: '-0.34em',
          }}
        >
          The CRM that closes
        </span>
      ) : null}
    </span>
  );
}
