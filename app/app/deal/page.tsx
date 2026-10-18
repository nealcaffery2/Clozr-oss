// A deal's buyer page, on the app's own domain: /deal?s=<slug>&t=<token>.
//
// This is the link a dispo text or email carries (lib/dispo listingUrl). The
// page itself is still rendered by the `listing` edge function, which records
// the view against the buyer's token; this route fetches that HTML from the
// buyer's own browser and writes it into this document, so the buyer stays on
// our domain and the function still sees the buyer's IP for its rate limit.
// The app is a static export, so there is no server here to proxy through.
//
// If the fetch fails (the function has not been redeployed with CORS on the
// page yet, or the network drops), the buyer is sent to the function URL
// instead, so the link never dead-ends.
//
// Whatever is written runs on the app's origin, so it is parsed and cleaned
// first (lib/listing-html.ts): only http(s), mailto: and tel: links, no inline
// handlers, frames or <base>.
'use client';

import React, { useEffect, useSyncExternalStore } from 'react';
import { listingSourceUrl } from '@/lib/dispo';
import { sanitizeListing } from '@/lib/listing-html';

const noop = () => () => {};
const readQuery = () => window.location.search;

export default function DealPage() {
  const search = useSyncExternalStore(noop, readQuery, () => null);
  const q = new URLSearchParams(search ?? '');
  const slug = (q.get('s') ?? '').trim();
  const token = q.get('t');
  const valid = /^[a-z0-9_-]{1,64}$/i.test(slug);

  useEffect(() => {
    if (!valid) return;
    const src = listingSourceUrl(slug, token);
    let gone = false;
    void (async () => {
      try {
        const r = await fetch(src, { headers: { accept: 'text/html' } });
        const html = await r.text();
        if (gone) return;
        if (!/<html|<!doctype/i.test(html)) throw new Error('not a page');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        sanitizeListing(doc, src);
        document.open();
        document.write(`<!doctype html>\n${doc.documentElement.outerHTML}`);
        document.close();
      } catch {
        if (!gone) window.location.replace(src);
      }
    })();
    return () => { gone = true; };
  }, [valid, slug, token]);

  const missing = search !== null && !valid;
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--canvas, #fafafa)', fontFamily: 'var(--font-inter), Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: '24px', color: 'var(--ink, #18181b)' }}>
      <p role="status" style={{ margin: 0, fontSize: '14px', color: 'var(--meta, #71717a)' }}>
        {missing ? 'This deal link is incomplete. Ask whoever sent it for a fresh one.' : 'Loading the deal…'}
      </p>
    </main>
  );
}
