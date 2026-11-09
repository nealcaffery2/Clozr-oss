'use client';

/**
 * GIFs for the SMS composer: a searchable GIPHY grid. The search runs in the
 * gif-search edge function so GIPHY_API_KEY stays server side; a picked GIF
 * goes on the text as an MMS attachment, so it sends (and shows in the
 * thread) through the same path as a photo.
 */

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { type Gif, cleanGif } from '@/supabase/functions/_shared/giphy';

async function searchGifs(q: string): Promise<Gif[]> {
  if (!supabase) throw new Error('GIFs are unavailable here.');
  const { data, error } = await supabase.functions.invoke('gif-search', { body: { q } });
  if (error) {
    let why = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) why = ((await ctx.json()) as { error?: string }).error ?? why;
    } catch { /* keep the transport message */ }
    throw new Error(/sign in/.test(why) ? 'GIFs are unavailable: sign in first.' : why);
  }
  // The function already cleans these; checked again because it is what we text out.
  return ((data as { gifs?: Gif[] } | null)?.gifs ?? []).flatMap((g) => {
    const url = cleanGif(g.url);
    const preview = cleanGif(g.preview);
    return url && preview ? [{ ...g, url, preview }] : [];
  });
}

export function GifButton({ onPick, disabled, className }: { onPick: (gif: Gif) => void; disabled?: boolean; /** The trigger's class; the tray chip by default. */ className?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [gifs, setGifs] = useState<Gif[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    const t = setTimeout(() => {
      searchGifs(q.trim())
        .then((g) => { if (live) setGifs(g); })
        .catch((e: Error) => { if (live) { setGifs([]); setError(e.message); } });
    }, q ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [open, q]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (host.current && e.target instanceof Node && host.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  return (
    // `contents` so the open grid can take its own full-width row in the
    // composer's wrapping tray; a floating popover got clipped by the thread pane.
    <span ref={host} style={{ display: 'contents' }}>
      <button
        type="button"
        className={className ?? 'tray-btn'}
        aria-label="GIF"
        aria-expanded={open}
        title="Send a GIF (MMS)"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden style={{ font: '700 9px/1 var(--sans)', letterSpacing: '.04em', border: '1.5px solid currentColor', borderRadius: 4, padding: '2px 3px' }}>GIF</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Pick a GIF"
          className="flex flex-col"
          style={{
            order: 99,
            flexBasis: '100%',
            height: 300,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-card)',
            overflow: 'hidden',
          }}
        >
          <label className="block px-2 pt-2">
            <span className="sr-only">Search GIFs</span>
            <input
              type="search"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search GIPHY…"
              autoComplete="off"
              spellCheck={false}
              className="w-full"
              style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', font: '400 13px/1.2 var(--sans)', background: 'var(--panel)', color: 'var(--text)' }}
            />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-live="polite">
            {error ? (
              <p style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted)' }}>{error}</p>
            ) : gifs === null ? (
              <p role="status" style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted-2)' }}>Loading GIFs…</p>
            ) : gifs.length === 0 ? (
              <p style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted-2)' }}>No GIFs for “{q}”.</p>
            ) : (
              <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}>
                {gifs.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    title={g.title}
                    aria-label={`Send GIF: ${g.title || 'untitled'}`}
                    onClick={() => { setOpen(false); onPick(g); }}
                    style={{ padding: 0, border: 0, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'var(--line)', aspectRatio: '1' }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- GIPHY CDN, animated */}
                    <img src={g.preview} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="px-3 py-1.5" style={{ borderTop: '1px solid var(--line)', font: '500 10px/1.3 var(--sans)', color: 'var(--muted-2)' }}>
            Powered by GIPHY
          </p>
        </div>
      )}
    </span>
  );
}
