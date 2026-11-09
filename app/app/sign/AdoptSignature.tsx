// Adopting a signature, the way a signer expects it: type your name and pick a
// hand, or draw one.
//
// Both paths end in a PNG. A typed signature is rendered to a canvas in the
// chosen face rather than sent as plain text, because the PDF is stamped with
// Helvetica — a typed name sent as text would come back on the signed document
// in a typeface the signer never saw. Drawing it to an image means what they
// adopt here is exactly what appears on the paper.
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { SignaturePad } from '@/components/SignaturePad';

/** The hands on offer. `css` is the family as the loaded webfont names it. */
export const HANDS = [
  { id: 'dancing', label: 'Dancing Script', css: "'Dancing Script'", weight: 600, scale: 1 },
  { id: 'vibes', label: 'Great Vibes', css: "'Great Vibes'", weight: 400, scale: 1.05 },
  { id: 'caveat', label: 'Caveat', css: "'Caveat'", weight: 600, scale: 1.05 },
  { id: 'apple', label: 'Homemade Apple', css: "'Homemade Apple'", weight: 400, scale: 0.78 },
] as const;
export type HandId = (typeof HANDS)[number]['id'];

/**
 * Draw `name` in `hand` onto a transparent PNG at print resolution.
 *
 * Waits on the face first: a canvas asked for a font the browser has not
 * finished fetching silently falls back to the default sans, which is exactly
 * the substitution this whole approach exists to avoid.
 */
export async function handToPng(name: string, hand: HandId): Promise<string | null> {
  const h = HANDS.find((x) => x.id === hand) ?? HANDS[0];
  const text = name.trim();
  if (!text) return null;
  const size = 96 * h.scale;
  const font = `${h.weight} ${size}px ${h.css}`;
  try { await document.fonts.load(font, text); await document.fonts.ready; } catch { /* draw with what we have */ }

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + 48;
  const height = Math.ceil(size * 1.9);

  const c = document.createElement('canvas');
  const ratio = 2;
  c.width = w * ratio; c.height = height * ratio;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.scale(ratio, ratio);
  ctx.font = font;
  ctx.fillStyle = '#1d2a6b';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 24, height / 2);
  return trimPng(c.toDataURL('image/png'));
}

/**
 * Crop a signature PNG to its ink, a few pixels of margin kept. The canvas a
 * signature is typed or drawn on is mostly empty, and a box scales the whole
 * image, so untrimmed ink came out a fraction of the box's height.
 */
export async function trimPng(src: string | null): Promise<string | null> {
  if (!src) return src;
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx || !c.width || !c.height) return src;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return src;
    const pad = 4;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d')?.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  } catch { return src; }
}

type Props = {
  /** Prefilled from the record; the signer can correct it. */
  initialName: string;
  role: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onAdopt: (v: { name: string; png: string | null }) => void;
};

// `flex-end` puts the sheet on the bottom edge of a phone; the stylesheet's
// desktop query re-centres it with `margin: auto 0`.
const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(16,16,20,.55)',
  display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 0,
  backdropFilter: 'blur(2px)',
};

export function AdoptSignature({ initialName, role, busy, error, onClose, onAdopt }: Props) {
  const [name, setName] = useState(initialName);
  const [mode, setMode] = useState<'type' | 'draw'>('type');
  const [hand, setHand] = useState<HandId>('dancing');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const firstField = useRef<HTMLInputElement | null>(null);

  useEffect(() => { firstField.current?.focus(); }, []);
  // Escape closes, and the page behind must not scroll under the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const clean = name.trim();
  const ready = clean.length >= 2 && (mode === 'type' || !!drawn);

  async function adopt() {
    setLocal(null);
    if (clean.length < 2) return setLocal('Type your full legal name.');
    if (mode === 'draw' && !drawn) return setLocal('Draw your signature, or switch to typing it.');
    setWorking(true);
    const png = mode === 'draw' ? await trimPng(drawn) : await handToPng(clean, hand);
    setWorking(false);
    onAdopt({ name: clean, png });
  }

  return (
    <div style={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Adopt your signature" className="cz-sheet">
        <div className="cz-sheet-grab" />
        <header style={{ padding: '4px 22px 0' }}>
          <h2 style={{ margin: 0, fontSize: '18px', letterSpacing: '-0.015em' }}>Adopt your signature</h2>
          <p style={{ margin: '4px 0 0', fontSize: '13.5px', color: '#6b6b74' }}>
            Confirm your name and choose how it should look. This is what goes on the {role.toLowerCase()} line.
          </p>
        </header>

        <div style={{ padding: '16px 22px 0' }}>
          <label className="cz-label" htmlFor="cz-legal-name">Full legal name</label>
          <input
            id="cz-legal-name" ref={firstField} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="First Last" autoComplete="name" className="cz-input"
          />

          <div className="cz-seg" role="tablist" aria-label="Signature style">
            {(['type', 'draw'] as const).map((m) => (
              <button
                key={m} type="button" role="tab" aria-selected={mode === m}
                onClick={() => { if (m !== mode) { setMode(m); setDrawn(null); } }} className={`cz-seg-btn${mode === m ? ' is-on' : ''}`}
              >{m === 'type' ? 'Choose a style' : 'Draw it'}</button>
            ))}
          </div>

          {mode === 'type' ? (
            <div className="cz-hands">
              {HANDS.map((h) => (
                <button
                  key={h.id} type="button" onClick={() => setHand(h.id)}
                  aria-pressed={hand === h.id}
                  className={`cz-hand${hand === h.id ? ' is-on' : ''}`}
                >
                  <span
                    className="cz-hand-ink"
                    style={{ fontFamily: `${h.css}, cursive`, fontWeight: h.weight, fontSize: `${28 * h.scale}px` }}
                  >{clean || 'Your name'}</span>
                  {hand === h.id ? <span className="cz-hand-tick" aria-hidden>✓</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ marginTop: '12px' }}>
              <SignaturePad onChange={setDrawn} height={170} />
            </div>
          )}

          <p style={{ margin: '14px 0 0', fontSize: '12.5px', lineHeight: 1.55, color: '#6b6b74' }}>
            By selecting <strong style={{ color: '#26262c' }}>Adopt and sign</strong> you agree that this signature and
            initials will be the electronic representation of your signature for all purposes when you use them on
            documents, including legally binding contracts — just the same as a pen-and-paper signature.
          </p>

          {(local || error) ? <div className="cz-err" role="alert">{local || error}</div> : null}
        </div>

        <div className="cz-sheet-foot">
          <button type="button" onClick={onClose} className="cz-btn cz-btn-ghost">Cancel</button>
          <button
            type="button" onClick={adopt} disabled={!ready || busy || working}
            className="cz-btn cz-btn-primary" style={{ flex: 1 }}
          >{busy || working ? 'Signing…' : 'Adopt and sign'}</button>
        </div>
      </div>
    </div>
  );
}
