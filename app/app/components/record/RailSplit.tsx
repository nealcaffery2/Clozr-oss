'use client';

// The thin bar between a rail and the centre column: grab and drag to set
// that rail's width; left and right arrows move it 16px for the keyboard.
// The width goes to useRailPrefs (saved on release, not on every move).

import React, { useRef } from 'react';
import { RAIL_MAX, RAIL_MIN, type Side } from './useRailPrefs';

const STEP = 16;
const clamp = (n: number) => Math.min(RAIL_MAX, Math.max(RAIL_MIN, n));

export function RailSplit({ side, open, rail, onWidth, style }: {
  side: Side;
  open: boolean;
  /** The rail this bar resizes; its current width is read from the DOM when a drag starts. */
  rail: React.RefObject<HTMLElement | null>;
  onWidth: (px: number, persist: boolean) => void;
  style?: React.CSSProperties;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const width = () => rail.current?.getBoundingClientRect().width ?? 264;
  const label = `Resize ${side} column`;
  return (
    <button
      type="button"
      className={`rec-split rec-split-${side}`}
      aria-label={label}
      title={open ? 'Drag to resize' : undefined}
      disabled={!open}
      style={style}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, w: width() };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        e.currentTarget.dataset.dragging = '';
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = (e.clientX - d.x) * (side === 'left' ? 1 : -1);
        onWidth(clamp(d.w + dx), false);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
        const dx = (e.clientX - d.x) * (side === 'left' ? 1 : -1);
        onWidth(clamp(d.w + dx), true);
      }}
      onPointerCancel={(e) => { drag.current = null; delete e.currentTarget.dataset.dragging; }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const grow = (e.key === 'ArrowRight') === (side === 'left');
        onWidth(clamp(width() + (grow ? STEP : -STEP)), true);
      }}
    />
  );
}
