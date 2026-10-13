'use client';

// One frame for every HTML email: the record's activity, the inbox thread,
// and the designed-template previews. Sandbox blocks scripts. allow-same-origin
// is only so this page can read the document height and so the app CSP's
// 'self' matches the frame; without allow-scripts the message cannot touch
// the parent. Popups are for "open this link", and they leave the sandbox.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { emailSrcDoc } from '@/lib/email-html';

const SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

export function EmailHtml({
  html, title = 'Email', clip = false, scrollHeight,
}: {
  html: string;
  title?: string;
  /** The first screenful, for a row that is not opened yet. */
  clip?: boolean;
  /** A fixed preview box. The message scrolls inside it. */
  scrollHeight?: number;
}) {
  const srcDoc = useMemo(() => emailSrcDoc(html), [html]);
  const [height, setHeight] = useState(clip ? 148 : scrollHeight ?? 180);
  const fixed = clip || scrollHeight != null;
  const frame = useRef<HTMLIFrameElement | null>(null);

  // The frame takes the message's whole height, so the page scrolls and the
  // frame never does. A 4,800px cap clipped every long reply chain into a
  // box with its own scrollbar (a 24 Hour Closing thread ran 22,000px); the
  // cap now only guards against a runaway document.
  const measure = (el: HTMLIFrameElement | null) => {
    if (fixed || !el) return;
    const doc = el.contentDocument;
    const h = Math.max(doc?.documentElement?.scrollHeight ?? 0, doc?.body?.scrollHeight ?? 0);
    if (h > 40) setHeight(Math.min(h + 8, 60000));
  };
  const observer = useRef<ResizeObserver | null>(null);
  // An image without dimensions, or the pane narrowing, changes the height
  // after load: measure again whenever the message's body resizes.
  const watch = (el: HTMLIFrameElement | null) => {
    observer.current?.disconnect();
    const body = el?.contentDocument?.body;
    if (fixed || !el || !body || typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(() => measure(el));
    observer.current.observe(body);
  };
  useEffect(() => () => observer.current?.disconnect(), []);
  const onLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => { measure(e.currentTarget); watch(e.currentTarget); };
  // Opened after it loaded clipped ("Show full email"): the frame does not
  // load again, so measure it now — otherwise it stays at the preview height.
  useEffect(() => {
    if (fixed) return;
    const el = frame.current;
    if (el?.contentDocument?.readyState === 'complete') { measure(el); watch(el); }
    // measure reads the frame, not React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixed, srcDoc]);

  return (
    <iframe
      ref={frame}
      title={title}
      sandbox={SANDBOX}
      srcDoc={srcDoc}
      scrolling={clip ? 'no' : 'auto'}
      onLoad={onLoad}
      style={{
        width: '100%',
        height: clip ? 148 : scrollHeight ?? height,
        border: '1px solid #e4e4e7',
        borderRadius: 10,
        background: '#fff',
        display: 'block',
      }}
    />
  );
}
