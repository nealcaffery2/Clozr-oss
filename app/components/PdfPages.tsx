// Uploaded PDFs on screen: open one from a signed URL, know each page's size,
// and paint a page onto a canvas at whatever width it is shown. Used by the
// field editor and the signing page; pdf.js itself loads lazily (lib/pdfjs).
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { type PdfDoc, openPdf } from '@/lib/pdfjs';

/** A page as displayed (its rotation applied), in PDF points. */
export type PageSize = { width: number; height: number };

/** Open `url` and read every page's size. Nothing loads until there is a URL. */
export function usePdf(url: string | null): { doc: PdfDoc | null; sizes: PageSize[]; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ url: string; doc: PdfDoc | null; sizes: PageSize[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    let opened: PdfDoc | null = null;
    (async () => {
      try {
        const doc = await openPdf(url);
        opened = doc;
        const sizes: PageSize[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const p = await doc.getPage(n);
          const v = p.getViewport({ scale: 1 });
          sizes.push({ width: v.width, height: v.height });
        }
        if (live) setState({ url, doc, sizes, error: null });
      } catch (e) {
        if (live) setState({ url, doc: null, sizes: [], error: (e as Error).message || 'Could not open the PDF.' });
      }
    })();
    return () => { live = false; void opened?.destroy(); };
  }, [url]);
  const cur = state && state.url === url ? state : null;
  return { doc: cur?.doc ?? null, sizes: cur?.sizes ?? [], error: cur?.error ?? null, loading: !!url && !cur };
}

/** One page painted at `width` CSS pixels (sharp on high-density screens). */
export function PdfPageCanvas({ doc, page, width, height }: { doc: PdfDoc; page: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let live = true;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const p = await doc.getPage(page);
      const c = ref.current;
      if (!live || !c || width <= 0) return;
      const base = p.getViewport({ scale: 1 });
      const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
      const vp = p.getViewport({ scale: (width / base.width) * dpr });
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      task = p.render({ canvasContext: ctx, viewport: vp });
      try { await task.promise; } catch { /* cancelled by a newer render */ }
    })();
    return () => { live = false; task?.cancel(); };
  }, [doc, page, width]);
  return <canvas ref={ref} aria-label={`Page ${page}`} style={{ display: 'block', width: `${width}px`, height: `${height}px`, background: 'var(--surface, #fff)' }} />;
}

/** The width of an element, kept current as it resizes. */
export function useWidth<T extends HTMLElement>(): [React.RefCallback<T>, number] {
  const [width, setWidth] = useState(0);
  const obs = useRef<ResizeObserver | null>(null);
  const attach = React.useCallback((el: T | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => { for (const e of entries) setWidth(Math.round(e.contentRect.width)); });
    ro.observe(el);
    obs.current = ro;
  }, []);
  return [attach, width];
}
