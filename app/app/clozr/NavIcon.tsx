// A place's icon (lib/nav-icons.ts): the side nav, the phone tabs and the
// More sheet all draw it here, so a place looks the same wherever it is listed.
'use client';

import React from 'react';
import { NAV_ICONS, type IconPart, type NavIconDef } from '@/lib/nav-icons';
import { ComprIcon } from '@/components/ds/ComprIcon';
import { Mark } from '@/components/ds/mark';

function part(p: IconPart, i: number) {
  switch (p[0]) {
    case 'path': return <path key={i} d={p[1]} />;
    case 'circle': return <circle key={i} cx={p[1]} cy={p[2]} r={p[3]} />;
    case 'rect': return <rect key={i} x={p[1]} y={p[2]} width={p[3]} height={p[4]} rx={p[5]} />;
    case 'ellipse': return <ellipse key={i} cx={p[1]} cy={p[2]} rx={p[3]} ry={p[4]} />;
  }
}

/** `name` is a place's icon key; an unknown one draws Today's, as the menus always have. */
export function NavIcon({ name, size = 16, stroke = 2 }: { name: string; size?: number; stroke?: number }) {
  const def: NavIconDef = (NAV_ICONS as Record<string, NavIconDef>)[name] ?? NAV_ICONS.today;
  if ('brand' in def) return def.brand === 'compr' ? <ComprIcon size={size} /> : null;
  if ('mark' in def) return <Mark label={def.mark} size={size} />;
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      {def.parts.map(part)}
    </svg>
  );
}
