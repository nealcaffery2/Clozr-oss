'use client';

/** Property photo viewer. One whole photo at a time (never cropped), arrows,
 *  swipe and Left/Right step through, thumbnails jump. Photos, title, and
 *  index come only from V.photoShow.
 *  role="dialog" is what the people list checks so Left/Right stay here.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { isGalleryImage } from '@/lib/house-photos';

const EASE = 'cubic-bezier(.23, 1, .32, 1)';
/** Modals use the lg elevation from DESIGN.md. */
const MODAL_SHADOW = '0 2.8px 2.2px rgba(0,0,0,.034), 0 6.7px 5.3px rgba(0,0,0,.048), 0 12.5px 10px rgba(0,0,0,.06), 0 22.3px 17.9px rgba(0,0,0,.072), 0 41.8px 33.4px rgba(0,0,0,.086), 0 100px 80px rgba(0,0,0,.12)';

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A8560]';

export function PhotoShow({ V }: { V: ClozrView }) {
  const show = V.photoShow;
  const many = !!show && show.photos.length > 1;
  const dialogRef = useRef<HTMLDivElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const swipeX = useRef<number | null>(null);
  // Close on a click that started on the backdrop. A swipe that starts on the
  // photo and ends past the dialog's edge also clicks the backdrop.
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        V.closePhotoShow();
      } else if (many && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        V.stepPhotoShow(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, V, many]);

  const openId = show?.id;
  useEffect(() => {
    if (openId == null) return;
    dialogRef.current?.focus();
  }, [openId]);

  const index = show?.index ?? 0;
  useEffect(() => {
    const thumb = thumbsRef.current?.children[index] as HTMLElement | undefined;
    thumb?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [index, openId]);

  if (!show || !show.photos.length) return null;
  const url = show.photos[show.index];

  return (
    <div
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        const close = downOnBackdrop.current && e.target === e.currentTarget;
        downOnBackdrop.current = false;
        if (close) V.closePhotoShow();
      }}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(12,14,18,.78)', display: 'grid', placeItems: 'center', padding: V.isMobile ? '12px 8px' : '28px 20px' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={show.title + ' photos'}
        data-testid="photo-show"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={focusRing}
        style={{
          width: 'min(1100px, 96vw)',
          height: 'min(820px, 92vh)',
          background: '#0c0c0e',
          borderRadius: 16,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: MODAL_SHADOW,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', color: '#fff', flex: 'none' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div title={show.title} style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.015em', lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{show.title}</div>
            {many ? (
              <div role="status" style={{ fontSize: 11.5, fontWeight: 500, color: '#d4d4d8', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{show.index + 1} of {show.photos.length}</div>
            ) : null}
          </div>
          <IconButton label="Close photos" onClick={V.closePhotoShow}><IconX /></IconButton>
        </div>
        <div
          style={{ position: 'relative', flex: 1, minHeight: 0, background: '#000', touchAction: 'pan-y' }}
          onPointerDown={(e) => { swipeX.current = e.clientX; }}
          onPointerUp={(e) => {
            const start = swipeX.current;
            swipeX.current = null;
            if (!many || start == null) return;
            const dx = e.clientX - start;
            if (Math.abs(dx) > 40) V.stepPhotoShow(dx < 0 ? 1 : -1);
          }}
        >
          <FullPhoto key={url + show.index} src={url} alt={show.title + ', photo ' + (show.index + 1)} />
          {many ? (
            <>
              <IconButton label="Previous photo" onClick={() => V.stepPhotoShow(-1)} style={{ position: 'absolute', left: 12, top: '50%', marginTop: -20, width: 40, height: 40, borderRadius: 20, zIndex: 2 }}>
                <IconChevron dir="left" />
              </IconButton>
              <IconButton label="Next photo" onClick={() => V.stepPhotoShow(1)} style={{ position: 'absolute', right: 12, top: '50%', marginTop: -20, width: 40, height: 40, borderRadius: 20, zIndex: 2 }}>
                <IconChevron dir="right" />
              </IconButton>
            </>
          ) : null}
        </div>
        {many ? (
          <div ref={thumbsRef} style={{ flex: 'none', display: 'flex', gap: 6, padding: '10px 12px', overflowX: 'auto', background: '#0c0c0e' }}>
            {show.photos.map((u, i) => {
              const active = i === show.index;
              return (
                <button
                  key={u + i}
                  type="button"
                  aria-label={'Photo ' + (i + 1) + ' of ' + show.photos.length}
                  aria-pressed={active}
                  onClick={() => V.stepPhotoShow(i - show.index)}
                  className={focusRing}
                  style={{
                    flex: 'none', width: 72, height: 52, padding: 0, border: 0, borderRadius: 6, overflow: 'hidden', cursor: 'pointer', background: '#18181b',
                    opacity: active ? 1 : 0.55,
                    boxShadow: active ? 'inset 0 0 0 2px #fff' : 'none',
                    transition: 'opacity 160ms ease',
                  }}
                >
                  {isGalleryImage(u) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={u} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />
                  ) : <span style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', color: '#d4d4d8', fontSize: 10, fontWeight: 650 }}>Link</span>}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FullPhoto({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!isGalleryImage(src)) {
    let host = src;
    try { host = new URL(src).hostname.replace(/^www\./, ''); } catch { /* keep the raw link */ }
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 24 }}>
        <a href={src} target="_blank" rel="noopener noreferrer" style={{ display: 'grid', gap: 8, justifyItems: 'center', textDecoration: 'none', color: '#fff' }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Open photo link</span>
          <span style={{ fontSize: 12.5, color: '#d4d4d8' }}>{host}</span>
        </a>
      </div>
    );
  }
  if (failed) {
    return <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#d4d4d8', fontSize: 12.5, fontWeight: 500 }}>This photo didn’t load</div>;
  }
  return (
    // Property photos are arbitrary remote URLs, same as the rest of the record.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
    />
  );
}

function IconButton({ label, onClick, style, children }: {
  label: string;
  onClick: () => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      className={'grid place-items-center text-white active:scale-[.97] [@media(hover:hover)_and_(pointer:fine)]:hover:brightness-125 ' + focusRing}
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 32,
        height: 32,
        padding: 0,
        border: 0,
        borderRadius: 8,
        background: 'rgba(24,24,27,.88)',
        color: '#fff',
        boxShadow: '0 0 0 1px rgba(255,255,255,.22)',
        cursor: 'pointer',
        flex: 'none',
        transition: 'transform 140ms ' + EASE + ', filter 140ms ease',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function IconX() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

function IconChevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === 'left' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
    </svg>
  );
}
