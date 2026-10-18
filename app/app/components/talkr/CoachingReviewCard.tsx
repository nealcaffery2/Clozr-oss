'use client';

// The post-call scorecard: overall, talk split, ten scores, keep, three fixes,
// one better line. Hang-up asks for it off the live transcript. The record
// reads the stored card and can ask again.

import React, { useEffect, useState } from 'react';
import { requestCallCoaching } from '@/lib/call-coach';
import {
  COACHING_CATEGORIES, demoCoachingReview, isCoachingReview, isConversation, type CallCoachingReview, type CoachingSource,
} from '@/lib/call-coaching';
import { FrameworkSummary, ReviewSectionsView } from '@/app/components/coaching/parts';

const INK = 'var(--ink, #18181b)';
const MUTED = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';

function gradeColor(n: number): string {
  if (n >= 70) return '#0A8560';
  if (n >= 50) return '#b45309';
  return '#b91c1c';
}

export function CoachingReviewView({ review }: { review: CallCoachingReview }) {
  return (
    <div style={{ display: 'grid', gap: '10px', fontSize: '13px', lineHeight: 1.5, color: 'var(--ink-2, #27272a)' }}>
      <div>
        <div style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em', color: INK }}>
          <span style={{ color: gradeColor(review.overall) }}>{review.overall}/100</span>
          <span style={{ fontWeight: 600 }}>{` · ${review.rep_name} ↔ ${review.prospect_name}`}</span>
        </div>
        <div style={{ marginTop: '2px', fontSize: '12.5px', color: MUTED }}>
          {`Talk: ${review.prospect_name} ${review.prospect_talk} / ${review.rep_name} ${review.rep_talk}`}
        </div>
      </div>
      <p style={{ margin: 0 }}>{review.verdict}</p>
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: MUTED, marginBottom: '4px' }}>Scores</div>
        <div style={{ fontSize: '12.5px', color: INK }}>
          {COACHING_CATEGORIES.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? ' · ' : ''}
              {c.short} {review.scores[c.id]}
            </span>
          ))}
        </div>
      </div>
      <Lines label="Keep" items={review.keep} />
      <Lines label="Fix next time" items={review.fix} />
      <div>
        <div style={{ fontSize: '12.5px', color: MUTED, marginBottom: '4px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700 }}>Better line than</span>
          {` "${review.worst_line}"`}
        </div>
        <div style={{ fontWeight: 600, color: INK }}>{review.better_line}</div>
      </div>
      {review.sections ? <ReviewSectionsView s={review.sections} /> : null}
      {review.framework ? <FrameworkSummary fw={review.framework} /> : null}
    </div>
  );
}

function Lines({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: MUTED, marginBottom: '4px' }}>{label}</div>
      <ul style={{ margin: 0, paddingLeft: '18px' }}>
        {items.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '10px', padding: '14px 16px' }}>
      {children}
    </div>
  );
}

/**
 * Hang-up card. `auto` asks once the transcript shows a real two-sided
 * conversation; a voicemail or a quick hang-up gets no card and no model call. With no live
 * call, the scripted Taylor / Kara card stands in so the demo wrap-up
 * shows the same shape.
 */
export function CoachingReviewCard({
  transcript,
  repName,
  prospectName,
  workspaceId,
  talkrCallId,
  communicationId,
  source = 'live',
  auto = false,
  demo = false,
}: {
  transcript: string;
  repName: string;
  prospectName: string;
  workspaceId?: number | null;
  talkrCallId?: string | null;
  communicationId?: number | null;
  source?: CoachingSource;
  auto?: boolean;
  demo?: boolean;
}) {
  const [review, setReview] = useState<CallCoachingReview | null>(demo ? demoCoachingReview() : null);
  const [status, setStatus] = useState<'idle' | 'working' | 'ready' | 'error'>(demo ? 'ready' : 'idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (demo || !auto) return;
    const text = transcript.trim();
    if (!isConversation(text, { repName, prospectName })) {
      setStatus('idle');
      return;
    }
    let live = true;
    setStatus('working');
    setError(null);
    void requestCallCoaching({
      transcript: text,
      repName,
      prospectName,
      workspaceId,
      talkrCallId,
      communicationId,
      source,
    }).then((r) => {
      if (!live) return;
      if (r.ok && isCoachingReview(r.review)) {
        setReview(r.review);
        setStatus('ready');
      } else {
        setStatus('error');
        setError(r.ok ? 'No coaching came back.' : r.message);
      }
    });
    return () => { live = false; };
  }, [auto, demo, transcript, repName, prospectName, workspaceId, talkrCallId, communicationId, source]);

  if (demo && review) {
    return <Frame><CoachingReviewView review={review} /></Frame>;
  }
  if (status === 'working' || (auto && status === 'idle' && isConversation(transcript, { repName, prospectName }))) {
    return <Frame><p style={{ margin: 0, fontSize: '13px', color: MUTED }}>Coaching this call...</p></Frame>;
  }
  if (status === 'error') {
    return <Frame><p style={{ margin: 0, fontSize: '13px', color: 'var(--tx-red, #b91c1c)' }}>{error || 'Coaching failed.'}</p></Frame>;
  }
  if (review) return <Frame><CoachingReviewView review={review} /></Frame>;
  if (transcript.trim().length > 0 && transcript.trim().length < 40) {
    return <Frame><p style={{ margin: 0, fontSize: '13px', color: MUTED }}>Not enough of a conversation to coach.</p></Frame>;
  }
  return null;
}
