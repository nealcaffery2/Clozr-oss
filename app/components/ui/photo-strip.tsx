// A record's photos as a plain thumbnail grid with a count (DESIGN.md §1: no
// decorative illustration). It replaced the manila-folder gallery on the
// seller record and the deal files card. Up to `max` tiles show; the last one
// carries "+N" when there are more, and every tile opens the photo viewer.
'use client';

import React from 'react';

export type StripPhoto = { id: string | number; image: string; label?: string };

export function PhotoStrip({ photos, max = 6, onOpen, label = 'Photos' }: {
  photos: StripPhoto[];
  max?: number;
  onOpen: (index: number) => void;
  label?: string;
}) {
  if (!photos.length) return null;
  const shown = photos.slice(0, max);
  const more = photos.length - shown.length;
  return (
    <div role="list" aria-label={`${label}: ${photos.length}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px' }}>
      {shown.map((p, i) => {
        const last = i === shown.length - 1 && more > 0;
        return (
          <button key={p.id} type="button" role="listitem" onClick={() => onOpen(i)}
            aria-label={last ? `Open photo ${i + 1}, ${more} more` : `Open photo ${i + 1}${p.label ? `, ${p.label}` : ''}`}
            style={{ position: 'relative', aspectRatio: '4 / 3', padding: 0, border: 0, borderRadius: 'var(--r-control, 8px)', overflow: 'hidden', background: 'var(--photo-bg, #e9ebf0)', cursor: 'pointer', boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / .06)' }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- remote listing photos, sized by the grid */}
            <img src={p.image} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            {last ? (
              <span aria-hidden style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgb(12 14 18 / .55)', color: '#fff', fontSize: '13px', fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>+{more}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
