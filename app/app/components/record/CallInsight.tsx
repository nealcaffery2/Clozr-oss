// One call on a record: its recording, its transcript, the AI notes, the
// coaching score, and — on a seller — what the transcript says the record
// should now say, each suggestion one click to apply or dismiss.
//
// Drop-in, keyed by the communications row id; it fetches the rest itself
// (lib/record-suggest.ts loadCallMedia). call-sync stores transcript, notes,
// score and a copy of the recording on the row a couple of minutes after the
// call, so this normally reads from the database; a call the sync has not
// finished falls back to Talkr live.
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { type Suggestion, applySuggestion, describeSuggestion, loadCallMedia, type CallMedia, suggestForCall } from '@/lib/record-suggest';
import type { CallScoreDto } from '@/lib/talkr-web/api';
import { requestCallCoaching } from '@/lib/call-coach';
import { firstName, type CallCoachingReview } from '@/lib/call-coaching';
import { CoachingReviewView } from '@/app/components/talkr/CoachingReviewCard';
import { CallRecording } from './CallRecording';

const INK = '#18181b';
const MUTED = '#71717a';
const LINE = '#e4e4e7';
const btn: React.CSSProperties = { height: '26px', padding: '0 10px', borderRadius: '7px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' };
const eyebrow: React.CSSProperties = { fontSize: '11.5px', color: MUTED, fontWeight: 600, marginBottom: '6px' };

/** The Apply / Dismiss list, shared with SmsSuggestions. */
export function SuggestionList({ workspaceId, sellerId, me, canWrite = true, state, onToast, onChanged, onSettled }: {
  workspaceId: number;
  sellerId: number;
  me: string | null;
  canWrite?: boolean;
  state: { loading: boolean; error: string | null; items: Suggestion[] | null };
  onToast?: (msg: string) => void;
  onChanged?: () => void;
  /** A suggestion applied or dismissed, so a cached list can drop it. */
  onSettled?: (s: Suggestion) => void;
}) {
  const [gone, setGone] = useState<Record<number, 'applied' | 'dismissed' | 'busy'>>({});
  if (state.loading) return <div style={{ fontSize: '12px', color: MUTED }}>Reading for updates…</div>;
  if (state.error) return <div style={{ fontSize: '12px', color: '#b91c1c' }}>{state.error}</div>;
  const items = (state.items ?? []).map((s, i) => ({ s, i })).filter(({ i }) => gone[i] !== 'applied' && gone[i] !== 'dismissed');
  if (!state.items) return null;
  if (!items.length) return <div style={{ fontSize: '12px', color: MUTED }}>No updates to suggest.</div>;

  const apply = async (s: Suggestion, i: number) => {
    setGone((g) => ({ ...g, [i]: 'busy' }));
    const r = await applySuggestion(workspaceId, sellerId, me, s);
    setGone((g) => { const n = { ...g }; if (r.ok) n[i] = 'applied'; else delete n[i]; return n; });
    onToast?.(r.ok ? 'Applied · ' + describeSuggestion(s) : r.message ?? 'Could not apply.');
    if (r.ok) { onSettled?.(s); onChanged?.(); }
  };

  return (
    <div style={{ display: 'grid', gap: '6px' }}>
      {items.map(({ s, i }) => (
        <div key={i} style={{ border: `1px solid ${LINE}`, borderRadius: '8px', padding: '8px 10px', background: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 600, color: INK }}>{describeSuggestion(s)}</span>
            {canWrite ? (
              <button type="button" className="dc3" disabled={gone[i] === 'busy'} onClick={() => apply(s, i)}
                style={{ ...btn, border: 0, background: '#0A8560', color: '#fff' }}>{gone[i] === 'busy' ? 'Applying…' : 'Apply'}</button>
            ) : null}
            <button type="button" className="dc2" onClick={() => { setGone((g) => ({ ...g, [i]: 'dismissed' })); onSettled?.(s); }}
              style={{ ...btn, border: `1px solid ${LINE}`, background: '#fff', color: INK }}>Dismiss</button>
          </div>
          <div style={{ fontSize: '12px', color: MUTED, marginTop: '4px', lineHeight: 1.45 }}>
            {s.reason}{s.quote ? <> · <i>“{s.quote}”</i></> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

const scoreColor = (n: number) => (n >= 80 ? '#0A8560' : n >= 60 ? '#b45309' : '#b91c1c');

/** The coaching read-out for one call, from the stored score. Compact by design: the dialer's wrap-up has the long form. */
function Coaching({ score }: { score: CallScoreDto }) {
  const [open, setOpen] = useState(false);
  const overall = typeof score.overall === 'number' ? Math.round(score.overall) : null;
  const cats = Object.entries(score.categories ?? {})
    .map(([k, v]) => ({ k, label: (v as { label?: string }).label ?? k.replace(/_/g, ' '), s: (v as { score?: number | null }).score ?? null, why: (v as { reason?: string | null }).reason ?? null }))
    .filter((c) => c.s !== null);
  const ratio = typeof score.rep_talk_ratio === 'number' ? Math.round(score.rep_talk_ratio * 100) : null;
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '8px', background: '#fff', padding: '8px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {overall !== null ? (
          <span style={{ fontSize: '20px', fontWeight: 700, color: scoreColor(overall), lineHeight: 1 }}>{overall}<span style={{ fontSize: '11px', color: MUTED, fontWeight: 500 }}>/100</span></span>
        ) : null}
        <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', color: '#27272a', lineHeight: 1.45 }}>
          <b style={{ color: INK }}>Coaching</b>
          {ratio !== null ? <> · rep talked {ratio}%</> : null}
          {score.next_action ? <> · next: {score.next_action}</> : null}
        </span>
        <button type="button" className="dc2" onClick={() => setOpen((o) => !o)} style={{ ...btn, border: `1px solid ${LINE}`, background: '#fff', color: INK }}>{open ? 'Less' : 'Details'}</button>
      </div>
      {open ? (
        <div style={{ marginTop: '8px', display: 'grid', gap: '8px', fontSize: '12.5px', lineHeight: 1.5, color: '#27272a' }}>
          {cats.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '4px 12px' }}>
              {cats.map((c) => (
                <div key={c.k} title={c.why ?? undefined} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                  <span style={{ color: MUTED, textTransform: 'capitalize' }}>{c.label}</span><b>{c.s}/10</b>
                </div>
              ))}
            </div>
          ) : null}
          {score.strengths?.length ? <div><div style={eyebrow}>Strengths</div><ul style={{ margin: 0, paddingLeft: '18px' }}>{score.strengths.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
          {score.gaps?.length ? <div><div style={eyebrow}>Gaps</div><ul style={{ margin: 0, paddingLeft: '18px' }}>{score.gaps.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
          {score.missed_opportunities?.length ? (
            <div><div style={eyebrow}>Missed</div><ul style={{ margin: 0, paddingLeft: '18px' }}>{score.missed_opportunities.map((m, i) => <li key={i}>{typeof m === 'string' ? m : (m as { moment?: string; play?: string }).moment ?? (m as { play?: string }).play ?? JSON.stringify(m)}</li>)}</ul></div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What one call's insight has read already, for the session: a record's feed
 * draws a CallInsight per call, and each used to read the whole row ('*', the
 * transcript and its segments), sign the recording and ask the record-suggest
 * model again every time the record opened or the feed redrew. A copy that is
 * still settling (no transcript yet, or audio held as a blob URL the card
 * revokes) is not kept, and nothing is kept past CACHE_MS.
 */
const CACHE_MS = 10 * 60_000;
type SugResult = Awaited<ReturnType<typeof suggestForCall>>;
const mediaCache = new Map<number, { at: number; media: CallMedia }>();
const sugCache = new Map<string, { at: number; result: SugResult & { ok: true } }>();
const unexpired = <T extends { at: number }>(e: T | undefined): T | undefined => (e && Date.now() - e.at < CACHE_MS ? e : undefined);
function loadCallMediaCached(id: number): Promise<CallMedia> {
  const hit = unexpired(mediaCache.get(id));
  if (hit) return Promise.resolve(hit.media);
  return loadCallMedia(id).then((m) => {
    if (m.transcript && !m.audioUrl?.startsWith('blob:')) mediaCache.set(id, { at: Date.now(), media: m });
    return m;
  });
}
function suggestForCallCached(workspaceId: number, sellerId: number, transcript: string, id: number): Promise<SugResult> {
  const key = `${workspaceId}:${sellerId}:${id}`;
  const hit = unexpired(sugCache.get(key));
  if (hit) return Promise.resolve(hit.result);
  return suggestForCall(workspaceId, sellerId, transcript, id).then((r) => {
    if (r.ok) sugCache.set(key, { at: Date.now(), result: r });
    return r;
  });
}
/** A suggestion acted on leaves the cached list, so the card does not offer it again on the next open. */
function settleCached(workspaceId: number, sellerId: number, id: number, s: Suggestion) {
  const key = `${workspaceId}:${sellerId}:${id}`;
  const hit = sugCache.get(key);
  if (hit) sugCache.set(key, { ...hit, result: { ...hit.result, suggestions: hit.result.suggestions.filter((x) => x !== s) } });
}

/**
 * True once the element is within a screen or so of the viewport. The feed
 * draws thirty entries at a time; a call further down waits until the rep
 * scrolls toward it before it reads its recording or asks for suggestions.
 */
function useNearView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near]);
  return near;
}

export function CallInsight({ communicationId, workspaceId, sellerId, me, canWrite = true, prospectName, repName, onToast, onChanged }: {
  communicationId: number;
  workspaceId: number;
  /** The seller the call is filed on; null on a buyer, where there are no record suggestions. */
  sellerId: number | null;
  me: string | null;
  canWrite?: boolean;
  /** First names for the card, when the stored review does not already have them. */
  prospectName?: string | null;
  repName?: string | null;
  onToast?: (msg: string) => void;
  onChanged?: () => void;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const near = useNearView(holder);
  const [media, setMedia] = useState<CallMedia | null>(() => unexpired(mediaCache.get(communicationId))?.media ?? null);
  const [sug, setSug] = useState<{ loading: boolean; error: string | null; items: Suggestion[] | null }>({ loading: false, error: null, items: null });
  const [fresh, setFresh] = useState<CallCoachingReview | null>(null);
  const [coaching, setCoaching] = useState<'idle' | 'working' | 'error'>('idle');
  const [coachErr, setCoachErr] = useState<string | null>(null);

  // Load once per call, when it nears the screen; suggestions are asked for
  // once, when a transcript exists. Both are kept for the session (above).
  useEffect(() => {
    if (!near) return;
    let alive = true;
    let url: string | null = null;
    loadCallMediaCached(communicationId).then(async (m) => {
      if (m.audioUrl?.startsWith('blob:')) url = m.audioUrl;
      if (!alive) { if (url) URL.revokeObjectURL(url); return; }
      setMedia(m);
      if (!m.transcript || sellerId === null) return;
      setSug({ loading: true, error: null, items: null });
      const r = await suggestForCallCached(workspaceId, sellerId, m.transcript, communicationId);
      if (alive) setSug(r.ok ? { loading: false, error: null, items: r.suggestions } : { loading: false, error: r.message, items: null });
    });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [near, communicationId, workspaceId, sellerId]);

  const review = fresh ?? media?.review ?? null;
  const coach = async () => {
    if (!media?.transcript || coaching === 'working') return;
    setCoaching('working');
    setCoachErr(null);
    const r = await requestCallCoaching({
      transcript: media.transcript,
      communicationId,
      workspaceId,
      prospectName: firstName(prospectName, ''),
      repName: firstName(repName, ''),
      source: 'ondemand',
      force: true,
    });
    if (r.ok) {
      setFresh(r.review);
      // The kept copy carries the new review, so the next open shows it.
      const kept = mediaCache.get(communicationId);
      if (kept) mediaCache.set(communicationId, { ...kept, media: { ...kept.media, review: r.review } });
      setCoaching('idle');
      onToast?.('Coaching saved on this call.');
      onChanged?.();
    } else {
      setCoaching('error');
      setCoachErr(r.message);
    }
  };

  if (!media) return <div ref={holder} style={{ marginTop: '10px', fontSize: '12px', color: MUTED }}>Loading call…</div>;
  // A call nobody picked up has nothing to play or read; the timeline row already says so.
  if (!media.audioUrl && !media.transcript && !media.transcriptNote) return null;
  const n = media.notes;
  const facts = n ? [
    n.seller_motivation ? ['Motivation', n.seller_motivation] : null,
    n.timeline ? ['Timeline', n.timeline] : null,
    n.asking_price ? ['Asking', n.asking_price] : null,
    n.property_condition ? ['Condition', n.property_condition] : null,
    n.sentiment ? ['Sentiment', n.sentiment] : null,
  ].filter((x): x is [string, string] => !!x) : [];

  return (
    <div ref={holder} style={{ marginTop: '10px', padding: '10px', border: `1px solid ${LINE}`, borderRadius: '10px', background: '#fafafa', display: 'grid', gap: '8px' }}>
      {media.audioUrl || media.segments.length ? (
        <CallRecording
          audioUrl={media.audioUrl} segments={media.segments} estimated={media.estimated} durationS={media.durationS}
          communicationId={communicationId} sections={media.sections} sectionsSource={media.sectionsSource}
          contactName={prospectName} repName={repName} note={media.transcriptNote}
        />
      ) : (
        <span style={{ fontSize: '12px', color: MUTED }}>{media.transcriptNote ?? 'No recording.'}</span>
      )}
      {media.audioUrl && !media.segments.length && media.transcriptNote ? <div style={{ fontSize: '12px', color: MUTED }}>{media.transcriptNote}</div> : null}
      {media.summary ? <div style={{ fontSize: '13px', color: '#27272a', lineHeight: 1.5 }}>{media.summary}</div> : null}
      {n?.key_points?.length ? (
        <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12.5px', color: '#27272a', lineHeight: 1.5 }}>
          {n.key_points.map((k, i) => <li key={i}>{k}</li>)}
        </ul>
      ) : null}
      {facts.length || n?.next_step || n?.objections?.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: '12px', color: '#27272a' }}>
          {facts.map(([k, v]) => <span key={k}><span style={{ color: MUTED }}>{k}: </span>{v}</span>)}
          {n?.objections?.length ? <span><span style={{ color: MUTED }}>Objections: </span>{n.objections.join('; ')}</span> : null}
          {n?.next_step ? <span><span style={{ color: MUTED }}>Next step: </span><b>{n.next_step}</b></span> : null}
        </div>
      ) : null}
      {review ? <CoachingReviewView review={review} /> : media.score ? <Coaching score={media.score} /> : null}
      {media.transcript && canWrite ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button type="button" className="dc2" disabled={coaching === 'working'} onClick={() => void coach()}
            style={{ ...btn, border: `1px solid ${LINE}`, background: '#fff', color: INK }}>{coaching === 'working' ? 'Coaching...' : review ? 'Coach again' : 'Coach this call'}</button>
          {coaching === 'error' && coachErr ? <span style={{ fontSize: '12px', color: '#b91c1c' }}>{coachErr}</span> : null}
        </div>
      ) : null}
      {media.transcript && sellerId !== null ? (
        <div>
          <div style={eyebrow}>Suggestions</div>
          <SuggestionList workspaceId={workspaceId} sellerId={sellerId} me={me} canWrite={canWrite} state={sug} onToast={onToast} onChanged={onChanged}
            onSettled={(x) => settleCached(workspaceId, sellerId, communicationId, x)} />
        </div>
      ) : null}
    </div>
  );
}
