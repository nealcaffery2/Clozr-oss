'use client';

// What one buyer will actually get: the texts as a thread of bubbles and the
// email as it renders, each with its send time. The frame has a fixed height
// and scrolls inside, so typing in the composer never moves the page.

import React, { useLayoutEffect, useRef, useState } from 'react';
import type { PlannedMessage } from '@/lib/dispo-campaign';
import { emailSrcDoc } from '@/lib/email-html';
import { C, Svg, Icon } from './ui';
import { smsSegments, whenLabel, tzLabel } from './logic';

const KIND = { intro: 'Intro', brief: 'Deal brief', followup: 'Follow-up if no reply' } as const;

export function SmsThread({ messages, tz, now, from, swapKey }: { messages: PlannedMessage[]; tz: string; now: Date; from: string; swapKey?: string }) {
  if (!messages.length) return <Empty>No texts for this buyer. They have no textable number, prefer email, or text is off.</Empty>;
  return (
    <div style={{ display: 'grid', gap: '6px' }} data-testid="preview-sms">
      <div style={{ textAlign: 'center', fontSize: '11px', color: C.muted2, paddingBottom: '4px' }}>From {from}</div>
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const gap = !prev || Date.parse(m.send_at) - Date.parse(prev.send_at) > 10 * 60_000 || prev.kind !== m.kind;
        const segs = smsSegments(m.body);
        return (
          <React.Fragment key={`${m.kind}:${m.seq}`}>
            {gap ? (
              <div style={{ textAlign: 'center', fontSize: '11px', color: C.muted2, margin: i ? '10px 0 2px' : '0 0 2px' }}>
                <span style={{ fontWeight: 600, color: m.kind === 'followup' ? '#92400e' : C.muted }}>{KIND[m.kind]}</span> · {at(m.send_at, tz, now)}
              </div>
            ) : null}
            <div style={{ display: 'grid' }}>
              <div className={m.kind === 'intro' && swapKey ? 'mk-bubble mk-swap' : 'mk-bubble'} key={m.kind === 'intro' ? swapKey : undefined} data-testid={`bubble-${m.kind}`}>
                {m.body}
                {m.media_urls.length ? <span style={{ display: 'block', marginTop: '6px', fontSize: '11px', fontWeight: 600 }}>+ photo</span> : null}
              </div>
              <span className="mk-num" style={{ justifySelf: 'end', fontSize: '11px', color: segs > 2 ? 'var(--tx-amber-deep, #92400e)' : C.subtle, marginTop: '2px' }}>
                {m.body.length} chars · {segs} segment{segs === 1 ? '' : 's'}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
/** "Now", or "Tomorrow 9:00 AM Central". */
const at = (iso: string, tz: string, now: Date) => { const w = whenLabel(Date.parse(iso), tz, now); return w === 'now' ? 'Now' : `${cap(w)} ${tzLabel(tz)}`; };

/** The email at the column's width. Height follows the document so nothing is clipped or scaled down. */
export function Scaled({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(420);
  const measure = () => {
    const body = frame.current?.contentDocument?.body;
    if (!body) return;
    setH(Math.max(180, Math.min(body.scrollHeight + 8, 2400)));
  };
  useLayoutEffect(() => { measure(); }, [html]);
  // A frame first drawn hidden (the editor's preview on a phone) measures again once it has a width.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; measure(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <iframe ref={frame} title="Email preview" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={emailSrcDoc(html)}
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument;
        if (doc?.head && !doc.getElementById('mk-fit')) {
          const style = doc.createElement('style');
          style.id = 'mk-fit';
          style.textContent = 'html,body{margin:0;background:var(--surface, #fff)} table{width:100%!important;max-width:100%!important} img{max-width:100%!important;height:auto!important}';
          doc.head.appendChild(style);
        }
        measure();
      }}
      style={{ width: '100%', height: `${h}px`, border: `1px solid ${C.line}`, borderRadius: '8px', display: 'block', background: 'var(--surface, #fff)' }} />
  );
}

export function EmailView({ messages, tz, now, from }: { messages: PlannedMessage[]; tz: string; now: Date; from: string }) {
  if (!messages.length) return <Empty>No emails for this buyer. They have no email on file, prefer texts, or email is off.</Empty>;
  return (
    <div style={{ display: 'grid', gap: '14px' }} data-testid="preview-email">
      {messages.map((m) => (
        <div key={`${m.kind}:${m.seq}`} style={{ display: 'grid', gap: '6px' }}>
          <div style={{ fontSize: '11px', color: C.muted2 }}>
            <span style={{ fontWeight: 600, color: m.kind === 'followup' ? '#92400e' : C.muted }}>{KIND[m.kind]}</span> · {at(m.send_at, tz, now)}
          </div>
          <div style={{ border: `1px solid ${C.line}`, borderRadius: '10px', overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.line2}`, fontSize: '12px', display: 'grid', gap: '2px', background: 'var(--canvas, #fafafa)' }}>
              <span style={{ color: C.muted2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>From {from}</span>
              <b style={{ fontSize: '13px' }} data-testid="preview-subject">{m.subject || '(no subject)'}</b>
            </div>
            <div style={{ padding: m.body_html ? '8px' : '10px 12px' }}>
              {m.body_html ? <Scaled html={m.body_html} /> : <div style={{ fontSize: '13px', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'grid', placeItems: 'center', textAlign: 'center', gap: '8px', padding: '40px 16px', color: C.muted2, fontSize: '12.5px', lineHeight: 1.5 }}>
    <Svg d={Icon.text} size={18} color={C.subtle} />
    {children}
  </div>
);
