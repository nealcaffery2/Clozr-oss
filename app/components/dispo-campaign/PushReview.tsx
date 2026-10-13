'use client';

// The whole push on one card: every segment it reaches and every distinct
// message it sends, each filled in for one sample recipient, with a way back
// to where it is edited. The composer shows it at Review, before anything is
// sent; a launched campaign shows the same card from what was actually queued.

import React from 'react';
import { Btn, C, Icon, Svg } from './ui';
import { plural } from './logic';

export type ReviewSegment = { key: string; label: string; detail: string; count: number };
export type ReviewVariant = {
  key: string;
  channel: 'sms' | 'email' | 'rvm' | 'ai_call';
  title: string;
  /** Who gets it, as a count of recipients. */
  reach: number;
  note?: string;
  subject?: string | null;
  body: string;
  html?: string | null;
  audioUrl?: string | null;
  seconds?: number | null;
  /** Where it is edited, handed to the card's onEdit. */
  edit?: string;
};

const ICON = { sms: Icon.text, email: Icon.mail, rvm: Icon.voicemail, ai_call: Icon.phone } as const;
const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 177)}…` : flat;
};
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function PushReview({ title, sample, segments, variants, empty, onEdit, testId = 'push-review' }: {
  title: string;
  /** "Filled in for Marisol Vega", or why there is no sample. */
  sample: string | null;
  segments: ReviewSegment[];
  variants: ReviewVariant[];
  empty?: string;
  onEdit?: (edit: string) => void;
  testId?: string;
}) {
  const reach = segments.reduce((n, s) => n + s.count, 0);
  return (
    <section className="mk-card" aria-label={title} style={{ overflow: 'hidden' }} data-testid={testId}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.line2}`, display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '13.5px', fontWeight: 650 }}>{title}</h3>
        <span className="mk-num" style={{ fontSize: '11.5px', color: C.muted }}>{plural(segments.length, 'segment')} · {plural(variants.length, 'message')}{sample ? ` · ${sample}` : ''}</span>
      </div>

      <div style={{ padding: '10px 16px 12px', display: 'grid', gap: '6px' }}>
        <div style={{ fontSize: '11.5px', fontWeight: 500, color: C.muted }}>Segments</div>
        {segments.length ? (
          <div role="table" aria-label="Segments" style={{ display: 'grid' }} data-testid="review-segments">
            {segments.map((s) => (
              <div role="row" key={s.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '10px', alignItems: 'baseline', padding: '6px 0', borderTop: `1px solid ${C.line2}`, fontSize: '12.5px' }}>
                <span role="cell" style={{ minWidth: 0 }}>
                  <b style={{ fontWeight: 600 }}>{s.label}</b>
                  <span style={{ display: 'block', fontSize: '11.5px', color: C.muted, overflowWrap: 'anywhere' }}>{s.detail}</span>
                </span>
                <span role="cell" className="mk-num" style={{ fontWeight: 650 }}>{s.count.toLocaleString('en-US')}</span>
              </div>
            ))}
            {segments.length > 1 ? (
              <div role="row" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '10px', padding: '6px 0', borderTop: `1px solid ${C.line}`, fontSize: '12.5px' }}>
                <span role="cell" style={{ color: C.muted }}>Total</span>
                <span role="cell" className="mk-num" style={{ fontWeight: 700 }}>{reach.toLocaleString('en-US')}</span>
              </div>
            ) : null}
          </div>
        ) : <div style={{ fontSize: '12.5px', color: C.muted }}>{empty ?? 'Nobody is in this push yet.'}</div>}
      </div>

      <div style={{ padding: '0 16px 14px', display: 'grid', gap: '10px' }} data-testid="review-variants">
        <div style={{ fontSize: '11.5px', fontWeight: 500, color: C.muted }}>Messages</div>
        {variants.length ? null : <div style={{ fontSize: '12.5px', color: C.muted }}>Nothing is switched on to send.</div>}
        {variants.map((v) => (
          <article key={v.key} style={{ border: `1px solid ${C.line}`, borderRadius: '10px', overflow: 'hidden' }} data-testid={`review-${v.key}`}>
            <header style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', background: '#fafafa', borderBottom: `1px solid ${C.line2}`, flexWrap: 'wrap' }}>
              <Svg d={ICON[v.channel]} size={13} color={v.channel === 'sms' ? 'var(--c-talkr)' : C.muted} />
              <b style={{ fontSize: '12.5px', fontWeight: 600 }}>{v.title}</b>
              <span className="mk-num" style={{ fontSize: '11.5px', color: C.muted }}>to {v.reach.toLocaleString('en-US')}</span>
              <div style={{ flex: 1 }} />
              {v.edit && onEdit ? <Btn size="sm" kind="quiet" onClick={() => onEdit(v.edit!)} aria-label={`Edit ${v.title.toLowerCase()}`}>Edit</Btn> : null}
            </header>
            <div style={{ padding: '10px', display: 'grid', gap: '6px' }}>
              {v.note ? <span style={{ fontSize: '11.5px', color: C.muted }}>{v.note}</span> : null}
              {v.channel === 'sms' ? (
                <div style={{ fontSize: '12.5px', lineHeight: 1.5, color: C.ink2, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{excerpt(v.body) || <i style={{ color: C.muted }}>Empty</i>}</div>
              ) : v.channel === 'email' ? (
                <div style={{ display: 'grid', gap: '4px' }}>
                  <div style={{ fontSize: '12.5px' }}><span style={{ color: C.muted }}>Subject </span><b>{v.subject || '(no subject)'}</b></div>
                  <div style={{ fontSize: '12.5px', lineHeight: 1.5, color: C.muted, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{excerpt(v.body)}</div>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: '6px' }}>
                  {v.audioUrl ? <audio controls src={v.audioUrl} preload="none" style={{ width: '100%', height: '36px' }} aria-label="Play the voicemail" />
                    : <span style={{ fontSize: '11.5px', color: C.muted }}>{v.seconds ? `Recorded, ${clock(v.seconds)}.` : 'No recording: the carrier reads the script aloud.'}</span>}
                  <div style={{ fontSize: '12.5px', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{v.body}</div>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
