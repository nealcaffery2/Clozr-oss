'use client';

// An AI agent's face: its generated picture, or its initials on a gradient
// until it has one. `live` adds the green pulse an agent at work wears.

import React from 'react';
import { avatarFallback } from '@/lib/ai-agent-client';

export function AgentAvatar({ name, src, size = 32, live, ring }: { name: string; src?: string | null; size?: number; live?: boolean; ring?: string }) {
  const fb = avatarFallback(name);
  const dot = Math.max(8, Math.round(size * 0.28));
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size, flex: 'none' }}>
      {src ? (
        // A data: SVG or a public bucket URL; an <img> never runs anything inside it.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`${name} avatar`} width={size} height={size}
          style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block', boxShadow: ring ? `0 0 0 2px ${ring}` : '0 1px 2px rgba(15,23,42,.18)', background: '#f4f4f5' }} />
      ) : (
        <span aria-label={`${name} avatar`} role="img"
          style={{
            width: size, height: size, borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 700, letterSpacing: '-0.02em',
            fontSize: Math.round(size * 0.38), background: `linear-gradient(135deg, ${fb.from}, ${fb.to})`, boxShadow: ring ? `0 0 0 2px ${ring}` : '0 1px 2px rgba(15,23,42,.18)',
          }}>
          {fb.initials}
        </span>
      )}
      {live ? (
        <span aria-hidden className="aia-live"
          style={{ position: 'absolute', right: -1, bottom: -1, width: dot, height: dot, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 0 2px #fff' }} />
      ) : null}
    </span>
  );
}
