// A person's face: their photo when they have one (uploaded, or their Google
// photo), otherwise their initials. Falls back to initials if the image fails.
'use client';

import React, { useState } from 'react';

export function initialsFrom(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function UserAvatar({ name, src, size = 30, radius = '50%', bg = '#E7F8F1', color = '#0A8560', border, title, style }: {
  name: string; src?: string | null; size?: number; radius?: string; bg?: string; color?: string; border?: string; title?: string; style?: React.CSSProperties;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const showImg = !!src && broken !== src;
  return (
    <span title={title ?? name} aria-label={name} role="img"
      style={{ width: size, height: size, borderRadius: radius, background: showImg ? '#e4e4e7' : bg, color, border, display: 'inline-grid', placeItems: 'center', flex: 'none', overflow: 'hidden', fontSize: Math.max(9, Math.round(size * 0.36)), fontWeight: 700, ...style }}>
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src!} alt="" referrerPolicy="no-referrer" onError={() => setBroken(src!)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : initialsFrom(name)}
    </span>
  );
}
