// The smart call recording: one player for every place a call is played
// (seller and buyer records, the inbox's calls, the dialer's lists).
//
//   - play, skip 15s either way, speed 1x to 2x, a seekable bar with the
//     chapters marked on it and a talk map (who spoke when) above it;
//   - the transcript, following playback: the current line is highlighted
//     and kept in view, and a click on any line plays from there;
//   - chapters (intro, motivation, price, objections, next steps…) computed
//     once by the call-sections function and stored with the call, or from
//     keywords when that is unavailable, each one a jump;
//   - "ask the call": an AI search over the transcript ("where did they
//     mention the roof?") that lists the moments and jumps to them, falling
//     back to plain text search.
//
// Styling follows DESIGN.md: ink primary control, ring-shadow ghosts, 12px
// card, tabular figures, sentence-case labels, no motion beyond press.
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Pause, Play, RotateCcw, RotateCw, Search } from 'lucide-react';
import { SECTION_LABEL, activeIndex, fmtClock, type CallSection, type CallSegment } from '@/lib/call-media';
import { loadSections, searchCall, type SearchHit } from '@/lib/call-sections';
import { loadTalkrCallMedia, type CallMedia } from '@/lib/record-suggest';
import { DEMO_CALL_SECONDS, DEMO_SECTIONS, DEMO_SEGMENTS, demoCallAudio } from '@/lib/call-demo';

const INK = '#18181b';
const INK2 = '#3f3f46';
const MUTED = '#71717a';
const LINE = '#e4e4e7';
const HAIR = '#f0f0f1';
const ACCENT = '#0A8560';
const RED = '#b91c1c';
const RING = '0 0 0 1px rgba(0,0,0,.08), 0 1px 2px -1px rgba(0,0,0,.08), 0 2px 4px 0 rgba(0,0,0,.04)';
const SPEEDS = [1, 1.25, 1.5, 2] as const;
const SKIP = 15;

const CSS = `
[data-cr] button{font:inherit;cursor:pointer;transition:transform 140ms cubic-bezier(.23,1,.32,1),filter 120ms ease}
[data-cr] button:active:not(:disabled){transform:scale(.97)}
[data-cr] button:disabled{opacity:.5;cursor:default}
[data-cr] button:focus-visible,[data-cr] input:focus-visible,[data-cr] [role=slider]:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}
@media (hover:hover) and (pointer:fine){[data-cr] button:hover:not(:disabled){filter:brightness(.96)}}
@media (prefers-reduced-motion:reduce){[data-cr] button{transition:none}}
[data-cr] .cr-line{display:grid;grid-template-columns:44px 64px 1fr;gap:8px;width:100%;text-align:left;border:0;background:transparent;padding:5px 8px;border-radius:6px;color:${INK};font-size:12.5px;line-height:1.5}
[data-cr] .cr-line[aria-current=true]{background:#f4f4f5;box-shadow:inset 2px 0 0 ${INK}}
@media (max-width:520px){[data-cr] .cr-line{grid-template-columns:40px 1fr}[data-cr] .cr-who{display:none}[data-cr] .cr-q{font-size:16px!important}}
`;

const iconBtn: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 8, border: 0, background: '#fff', color: INK, boxShadow: RING,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
};
const chip = (on: boolean): React.CSSProperties => ({
  height: 28, padding: '0 9px', borderRadius: 8, border: 0, fontSize: 12, fontWeight: 600,
  background: on ? INK : '#fff', color: on ? '#fff' : INK2, boxShadow: on ? 'none' : RING,
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
});
const label: React.CSSProperties = { fontSize: 11.5, fontWeight: 500, color: MUTED };

export type CallRecordingProps = {
  audioUrl: string | null;
  segments: CallSegment[];
  /** Times spread over flat text rather than measured. */
  estimated?: boolean;
  durationS?: number | null;
  /** The communications row, for stored chapters and AI search. Null reads keywords and text search only. */
  communicationId: number | null;
  sections?: CallSection[] | null;
  sectionsSource?: 'ai' | 'keywords' | null;
  contactName?: string | null;
  repName?: string | null;
  /** Shown in place of the player when there is no audio. */
  note?: string | null;
  autoPlay?: boolean;
  /** Transcript, sections and search expanded on first render. A record's timeline keeps them folded, so a page of calls does not ask for a page of sections. */
  defaultOpen?: boolean;
};

export function CallRecording({
  audioUrl, segments, estimated = false, durationS, communicationId, sections: storedSections, sectionsSource,
  contactName, repName, note, autoPlay = false, defaultOpen = false,
}: CallRecordingProps) {
  const [open, setOpen] = useState(defaultOpen);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastUserScroll = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState<number>(() => Number(durationS) || segments[segments.length - 1]?.end || 0);
  const [speed, setSpeed] = useState<number>(1);
  const [audioErr, setAudioErr] = useState<string | null>(null);
  const [secState, setSecState] = useState<{ list: CallSection[]; source: 'ai' | 'keywords'; note: string | null; loading: boolean }>(() => ({
    list: storedSections ?? [], source: sectionsSource ?? 'ai', note: null, loading: !storedSections?.length && segments.length >= 2,
  }));
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ list: SearchHit[]; source: 'ai' | 'text'; note: string | null; busy: boolean; asked: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const who = useCallback((s: CallSegment['speaker']) => (
    s === 'rep' ? (repName?.split(' ')[0] || 'Rep') : s === 'contact' ? (contactName?.split(' ')[0] || 'Contact') : 'Speaker'
  ), [repName, contactName]);

  // Chapters: the stored copy, else ask once, when the rep opens the call.
  useEffect(() => {
    if (!open || storedSections?.length || segments.length < 2) return;
    let alive = true;
    void loadSections(communicationId, segments).then((r) => {
      if (alive) setSecState({ list: r.sections, source: r.source, note: r.note, loading: false });
    });
    return () => { alive = false; };
  }, [open, communicationId, segments, storedSections]);

  useEffect(() => {
    const a = audioRef.current;
    if (a) a.playbackRate = speed;
  }, [speed]);

  const seek = useCallback((to: number, play = true) => {
    const a = audioRef.current;
    const clamped = Math.max(0, dur ? Math.min(to, dur - 0.05) : to);
    setT(clamped);
    lastUserScroll.current = 0;
    if (!a) return;
    a.currentTime = clamped;
    if (play && a.paused) void a.play().catch((e: Error) => setAudioErr(e.message));
  }, [dur]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch((e: Error) => setAudioErr(e.message || 'The recording would not play.'));
    else a.pause();
  };

  const current = activeIndex(segments, t);
  const curSection = useMemo(() => {
    let k = -1;
    secState.list.forEach((s, i) => { if (s.start <= t + 0.05) k = i; });
    return k;
  }, [secState.list, t]);

  // Keep the current line in view inside the panel, not by scrolling the page,
  // and not while the rep is reading elsewhere in it.
  useEffect(() => {
    const box = listRef.current;
    if (!box || current < 0 || Date.now() - lastUserScroll.current < 4000) return;
    const el = box.querySelector<HTMLElement>(`[data-i="${current}"]`);
    if (!el) return;
    const top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + el.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 3);
    }
  }, [current, open]);

  const ask = async () => {
    const query = q.trim();
    if (!query) return;
    setHits({ list: [], source: 'ai', note: null, busy: true, asked: query });
    const r = await searchCall(communicationId, segments, query);
    setHits({ list: r.hits, source: r.source, note: r.note, busy: false, asked: query });
    if (r.hits[0]) seek(segments[r.hits[0].index]!.start, false);
  };

  const pct = (x: number) => (dur > 0 ? `${Math.min(100, Math.max(0, (x / dur) * 100))}%` : '0%');
  const onBar = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * dur, false);
  };
  const onBarKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 15 : 5;
    if (e.key === 'ArrowRight') { e.preventDefault(); seek(t + step, false); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(t - step, false); }
    else if (e.key === 'Home') { e.preventDefault(); seek(0, false); }
    else if (e.key === 'End') { e.preventDefault(); seek(dur, false); }
    else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
  };

  const shown = showAll || segments.length <= 60 ? segments : segments.slice(0, 60);
  const hasAudio = !!audioUrl && !audioErr;

  return (
    <div data-cr data-testid="call-recording" style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', padding: 12, display: 'grid', gap: 10, minWidth: 0 }}>
      <style>{CSS}</style>
      {audioUrl ? (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          autoPlay={autoPlay}
          onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d); e.currentTarget.playbackRate = speed; }}
          onDurationChange={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d); }}
          onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => setAudioErr('The recording could not be loaded. It may have expired; reopen the call to get a fresh link.')}
          style={{ display: 'none' }}
        />
      ) : null}

      {/* Transport */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={toggle} disabled={!hasAudio} aria-label={playing ? 'Pause' : 'Play'}
          style={{ ...iconBtn, background: INK, color: '#fff', boxShadow: 'none' }}>
          {playing ? <Pause size={16} strokeWidth={2} aria-hidden fill="currentColor" /> : <Play size={16} strokeWidth={2} aria-hidden fill="currentColor" />}
        </button>
        <button type="button" onClick={() => seek(t - SKIP, playing)} disabled={!hasAudio} aria-label={`Back ${SKIP} seconds`} title={`Back ${SKIP}s`} style={iconBtn}>
          <RotateCcw size={15} strokeWidth={2} aria-hidden />
        </button>
        <button type="button" onClick={() => seek(t + SKIP, playing)} disabled={!hasAudio} aria-label={`Forward ${SKIP} seconds`} title={`Forward ${SKIP}s`} style={iconBtn}>
          <RotateCw size={15} strokeWidth={2} aria-hidden />
        </button>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: INK2, fontVariantNumeric: 'tabular-nums', minWidth: 84 }}>
          {fmtClock(t)} / {dur ? fmtClock(dur) : '–:––'}
        </span>
        <span role="group" aria-label="Playback speed" style={{ display: 'inline-flex', gap: 4, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {SPEEDS.map((s) => (
            <button key={s} type="button" onClick={() => setSpeed(s)} aria-pressed={speed === s} disabled={!hasAudio} style={chip(speed === s)}>{s}x</button>
          ))}
        </span>
      </div>
      {!audioUrl ? <div style={{ fontSize: 12, color: MUTED }}>{note || 'No recording for this call.'}</div> : null}
      {audioErr ? <div role="alert" style={{ fontSize: 12, color: RED }}>{audioErr}</div> : null}

      {/* Talk map + progress with chapter markers */}
      {dur > 0 ? (
        <div style={{ display: 'grid', gap: 3 }}>
          {segments.length ? (
            <div aria-hidden style={{ position: 'relative', height: 6, borderRadius: 3, background: HAIR, overflow: 'hidden' }}>
              {segments.map((s, i) => (
                <span key={i} style={{ position: 'absolute', top: s.speaker === 'rep' ? 3 : 0, height: 3, left: pct(s.start), width: `max(1px, calc(${pct(Math.max(s.end, s.start + 0.5))} - ${pct(s.start)}))`, background: s.speaker === 'rep' ? MUTED : INK }} />
              ))}
            </div>
          ) : null}
          <div
            role="slider" tabIndex={hasAudio ? 0 : -1} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(t)}
            aria-valuetext={`${fmtClock(t)} of ${fmtClock(dur)}`}
            onClick={hasAudio ? onBar : undefined} onKeyDown={hasAudio ? onBarKey : undefined}
            style={{ position: 'relative', height: 18, cursor: hasAudio ? 'pointer' : 'default', borderRadius: 4 }}
          >
            <span style={{ position: 'absolute', left: 0, right: 0, top: 7, height: 4, borderRadius: 2, background: LINE }} />
            <span style={{ position: 'absolute', left: 0, top: 7, height: 4, borderRadius: 2, background: INK, width: pct(t) }} />
            {secState.list.map((s, i) => i === 0 ? null : (
              <span key={i} title={`${s.title} · ${fmtClock(s.start)}`} style={{ position: 'absolute', top: 3, height: 12, width: 2, borderRadius: 1, background: ACCENT, left: pct(s.start) }} />
            ))}
            <span style={{ position: 'absolute', top: 3, width: 12, height: 12, borderRadius: 6, background: '#fff', boxShadow: RING, left: `calc(${pct(t)} - 6px)` }} />
          </div>
          {segments.length ? (
            <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: MUTED }}>
              <span><span aria-hidden style={{ display: 'inline-block', width: 8, height: 3, background: INK, verticalAlign: 'middle', marginRight: 4 }} />{who('contact')}</span>
              <span><span aria-hidden style={{ display: 'inline-block', width: 8, height: 3, background: MUTED, verticalAlign: 'middle', marginRight: 4 }} />{who('rep')}</span>
              {estimated ? <span style={{ marginLeft: 'auto' }}>Times are estimated from the transcript</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {segments.length ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ ...chip(false), justifySelf: 'start' }}>
          {open ? 'Hide transcript' : `Transcript, sections and search · ${segments.length} lines`}
        </button>
      ) : null}

      {/* Chapters */}
      {open && segments.length >= 2 ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={label}>{secState.loading ? 'Finding sections…' : secState.source === 'ai' ? 'Sections' : 'Sections from keywords'}</span>
          {secState.list.length ? (
            <div role="group" aria-label="Call sections" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {secState.list.map((s, i) => (
                <button key={i} type="button" onClick={() => seek(s.start)} aria-current={curSection === i ? 'true' : undefined}
                  title={s.summary ?? `${SECTION_LABEL[s.kind]} at ${fmtClock(s.start)}`} style={chip(curSection === i)}>
                  {s.title} <span style={{ fontWeight: 500, opacity: .75 }}>{fmtClock(s.start)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {secState.note && secState.source === 'keywords' ? <span style={{ fontSize: 11.5, color: MUTED }}>AI sections unavailable: {secState.note}</span> : null}
        </div>
      ) : null}

      {/* Ask the call */}
      {open && segments.length >= 2 ? (
        <form onSubmit={(e) => { e.preventDefault(); void ask(); }} style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <label style={{ position: 'relative', flex: 1, minWidth: 0 }}>
              <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Search this call</span>
              <Search size={14} aria-hidden style={{ position: 'absolute', left: 9, top: 9, color: MUTED }} />
              <input className="cr-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask the call: where did they mention the roof?"
                style={{ width: '100%', height: 32, borderRadius: 8, border: 0, boxShadow: RING, padding: '0 10px 0 28px', fontSize: 13, color: INK, background: '#fff' }} />
            </label>
            <button type="submit" disabled={!q.trim() || hits?.busy} style={{ ...chip(false), height: 32 }}>{hits?.busy ? 'Searching…' : 'Search'}</button>
          </div>
          {hits && !hits.busy ? (
            <div role="status" style={{ display: 'grid', gap: 2 }}>
              <span style={label}>
                {hits.list.length ? `${hits.list.length} ${hits.list.length === 1 ? 'moment' : 'moments'} for “${hits.asked}”${hits.source === 'text' ? ', by text match' : ''}` : `Nothing in this call matches “${hits.asked}”.`}
              </span>
              {hits.note ? <span style={{ fontSize: 11.5, color: MUTED }}>AI search unavailable: {hits.note}</span> : null}
              {hits.list.map((h) => {
                const s = segments[h.index]!;
                return (
                  <button key={h.index} type="button" className="cr-line" onClick={() => seek(s.start)} style={{ gridTemplateColumns: '44px 1fr' }}>
                    <span style={{ color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{fmtClock(s.start)}</span>
                    <span><b style={{ fontWeight: 600 }}>{who(s.speaker)}:</b> {s.text}{h.why ? <span style={{ color: MUTED }}> · {h.why}</span> : null}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </form>
      ) : null}

      {/* Transcript, synced */}
      {open && segments.length ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={label}>Transcript</span>
          <div ref={listRef} onScroll={() => { lastUserScroll.current = Date.now(); }}
            style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${LINE}`, borderRadius: 8, padding: 4, position: 'relative' }}>
            {shown.map((s, i) => (
              <button key={i} type="button" data-i={i} className="cr-line" aria-current={i === current ? 'true' : undefined}
                onClick={() => seek(s.start)} title={hasAudio ? `Play from ${fmtClock(s.start)}` : undefined}>
                <span style={{ color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{fmtClock(s.start)}</span>
                <span className="cr-who" style={{ fontWeight: 600, color: s.speaker === 'rep' ? MUTED : INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={who(s.speaker)}>{who(s.speaker)}</span>
                <span>{s.text}</span>
              </button>
            ))}
            {shown.length < segments.length ? (
              <button type="button" onClick={() => setShowAll(true)} style={{ ...chip(false), margin: 6 }}>Show all {segments.length} lines</button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The player for a call known by its Talkr id (inbox, dialer lists): loads, then plays. */
export function TalkrCallRecording({ talkrCallId, contactName, autoPlay = false }: { talkrCallId: string; contactName?: string | null; autoPlay?: boolean }) {
  // Keyed by the id it was loaded for, so a new call shows "Loading" without resetting state in the effect.
  const [loaded, setLoaded] = useState<{ id: string; media: CallMedia } | null>(null);
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    void loadTalkrCallMedia(talkrCallId).then((m) => {
      if (m.audioUrl?.startsWith('blob:')) url = m.audioUrl;
      if (!alive) { if (url) URL.revokeObjectURL(url); return; }
      setLoaded({ id: talkrCallId, media: m });
    });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [talkrCallId]);
  const media = loaded?.id === talkrCallId ? loaded.media : null;
  if (!media) return <div role="status" style={{ fontSize: 12, color: MUTED, padding: '6px 0' }}>Loading the recording…</div>;
  if (!media.audioUrl && !media.segments.length) return <div style={{ fontSize: 12, color: MUTED, padding: '6px 0' }}>{media.transcriptNote ?? 'No recording on this call.'}</div>;
  return (
    <CallRecording
      audioUrl={media.audioUrl} segments={media.segments} estimated={media.estimated} durationS={media.durationS}
      communicationId={media.communicationId} sections={media.sections} sectionsSource={media.sectionsSource}
      contactName={contactName} note={media.transcriptNote} autoPlay={autoPlay} defaultOpen
    />
  );
}

const noSubscribe = () => () => undefined;

/** The /demo record's sample call: silent audio the call's length, a real transcript and stored chapters. */
export function DemoCallRecording({ contactName }: { contactName?: string | null }) {
  // Null on the server, the blob URL in the browser, without a hydration mismatch.
  const audio = useSyncExternalStore(noSubscribe, demoCallAudio, () => null);
  return (
    <CallRecording
      audioUrl={audio} segments={DEMO_SEGMENTS} durationS={DEMO_CALL_SECONDS} communicationId={null}
      sections={DEMO_SECTIONS} sectionsSource="ai" contactName={contactName} repName="Taylor"
    />
  );
}
