// A finger-or-mouse signature pad. Exposes the drawing as a PNG data URL;
// empty means the signer chose to type instead.
'use client';

import React, { useEffect, useRef, useState } from 'react';

export function SignaturePad({ onChange, height = 150 }: { onChange: (png: string | null) => void; height?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  // Draw at device resolution so the stamped signature is crisp.
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    c.width = Math.round(w * ratio); c.height = Math.round(height * ratio);
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1d2a6b';
  }, [height]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => { e.preventDefault(); drawing.current = true; last.current = pos(e); e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const ctx = e.currentTarget.getContext('2d'); if (!ctx) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p;
    if (empty) setEmpty(false);
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false; last.current = null;
    // A tap with no stroke leaves the pad blank: report nothing, so the
    // "draw your signature" check can refuse an empty signature.
    onChange(empty ? null : e.currentTarget.toDataURL('image/png'));
  };
  const clear = () => {
    const c = ref.current; const ctx = c?.getContext('2d'); if (!c || !ctx) return;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.restore();
    setEmpty(true); onChange(null);
  };

  return (
    <div>
      <div style={{ position: 'relative', border: '1px dashed #c4c4c8', borderRadius: '10px', background: 'var(--surface, #fff)', overflow: 'hidden' }}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: `${height}px`, touchAction: 'none', cursor: 'crosshair' }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
        {empty ? <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', color: 'var(--subtle, #a1a1aa)', fontSize: '13px' }}>Draw your signature here</div> : null}
        <div style={{ position: 'absolute', left: '16px', right: '16px', bottom: '28px', borderTop: '1px solid var(--divider, #e4e4e7)', pointerEvents: 'none' }} />
      </div>
      <button type="button" onClick={clear} style={{ marginTop: '6px', fontSize: '12px', color: 'var(--muted, #52525b)', background: 'none', border: 0, cursor: 'pointer', padding: 0 }}>Clear</button>
    </div>
  );
}
