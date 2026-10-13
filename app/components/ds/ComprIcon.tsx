// The COMPR app icon: a heavy C, open to the right with flat-cut ends, and
// the royal-blue dot at its centre. Traced from COMPR's own icon source
// (comp-engine public/icon-source.png, 1024px) into a 24px box, so the nav
// shows the product's mark rather than a generic sparkle.
//
// The C takes currentColor, so it follows the nav item's ink and hover state
// like the text beside it; the dot stays COMPR blue, the part that identifies it.

import React from 'react';
import { COMPR } from '@/app/clozr/brand';

/** Outer ring r=7.03, inner r=4.34, cut by a 4.12-high slot on the right. */
const C_PATH = 'M18.72 9.94A7.03 7.03 0 1 0 18.72 14.06L15.82 14.06A4.34 4.34 0 1 1 15.82 9.94Z';

export function ComprIcon({ size = 14, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="4 4 16 16" style={{ display: 'block', flex: 'none' }}
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <path d={C_PATH} fill="currentColor" />
      <circle cx="12" cy="12" r="1.35" fill={COMPR} />
    </svg>
  );
}
