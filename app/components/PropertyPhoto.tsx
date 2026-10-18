'use client';

import React, { useEffect, useRef, useState } from 'react';

/**
 * A property photo that never shows the browser's broken-image icon.
 * A dead COMPR link falls through to Street View. A Street View tile Google
 * answers 403/404 for (no imagery, or the key cannot call that API) falls
 * through to the grey "No photo yet" placeholder.
 */
export function PropertyPhoto({ photo, street, alt, empty = 'No photo yet', fit = 'cover', eager = false }: {
  photo?: string | null;
  street?: string | null;
  alt: string;
  empty?: string;
  fit?: 'cover' | 'contain';
  /** The one photo above the fold (a deal page's hero): fetch now, at high priority. */
  eager?: boolean;
}) {
  return <PropertyPhotoFrame key={`${photo ?? ''}\0${street ?? ''}`} photo={photo} street={street} alt={alt} empty={empty} fit={fit} eager={eager} />;
}

function PropertyPhotoFrame({ photo, street, alt, empty, fit, eager }: {
  photo?: string | null;
  street?: string | null;
  alt: string;
  empty: string;
  fit: 'cover' | 'contain';
  eager: boolean;
}) {
  const urls = [photo, street]
    .map((u) => (u ?? '').trim())
    .filter((u, i, all) => !!u && u !== '—' && all.indexOf(u) === i);
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const handled = useRef<string | null>(null);
  const src = urls[step];
  const show = () => {
    if (!src || handled.current === src) return;
    handled.current = src;
    setReady(true);
  };
  const fail = () => {
    if (!src || handled.current === src) return;
    handled.current = src;
    setReady(false);
    setStep((n) => n + 1);
  };
  // A photo can finish (or fail) before hydration attaches onLoad/onError.
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete) return;
    if (img.naturalWidth > 0) show();
    // Some engines report a lazy image that has not started as complete with
    // no pixels; that is "not yet", not "broken", and onError still fires.
    else if (eager) fail();
  }, [src]);
  const box = (label: string) => (
    <span style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', fontSize: '12px', color: 'var(--meta, #71717a)', textAlign: 'center', padding: '0 8px', background: 'var(--divider, #e4e4e7)' }}>
      {label}
    </span>
  );
  if (!src) return box(empty);
  // The image stays in layout (hidden by opacity, not display:none) because a
  // lazy image that is display:none never intersects the viewport and so is
  // never fetched. Lazy is what keeps a marketplace grid from pulling every
  // full-size photo, through COMPR's proxy, before the first card paints.
  return (
    <span style={{ display: 'block', width: '100%', height: '100%', position: 'relative' }}>
      {ready ? null : <span aria-hidden style={{ position: 'absolute', inset: 0 }}>{box('')}</span>}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={eager ? 'high' : 'auto'}
        decoding="async"
        onLoad={show}
        onError={fail}
        style={{ position: 'relative', display: 'block', width: '100%', height: '100%', objectFit: fit, opacity: ready ? 1 : 0 }}
      />
    </span>
  );
}
