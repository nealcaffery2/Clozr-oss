'use client';

// Record the push's ringless voicemail in place: the mic, a running timer,
// play it back, re-record, then "Use this recording" hands the take to the
// composer, which uploads it and ties it to this push. A take that is not
// used is never uploaded.

import React, { useEffect, useRef, useState } from 'react';
import { Btn, C, Icon, Note, Svg } from './ui';

/** Carriers cut a voicemail off around 90 seconds; stop there rather than send a clipped one. */
const MAX_SECONDS = 90;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export type AttachedRecording = { seconds: number; url: string | null };

export function RvmRecorder({ attached, onUse, onRemove, disabled }: {
  attached: AttachedRecording | null;
  /** Save the take for this push. Resolves to an error sentence, or null when it is attached. */
  onUse: (blob: Blob, seconds: number) => Promise<string | null>;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'review' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<{ blob: Blob; url: string; seconds: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const timer = useRef<number | null>(null);

  const stopTimer = () => { if (timer.current != null) { window.clearInterval(timer.current); timer.current = null; } };
  useEffect(() => () => {
    stopTimer();
    if (rec.current?.state === 'recording') rec.current.stop();
  }, []);
  useEffect(() => () => { if (take) URL.revokeObjectURL(take.url); }, [take]);

  const start = async () => {
    setErr(null);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) { setErr('This browser cannot record audio. Use Chrome, Edge or Safari.'); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    if (!stream) { setErr('The microphone is blocked. Allow it for this site in the browser, then record again.'); return; }
    const r = new MediaRecorder(stream);
    chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      stopTimer();
      const seconds = Math.max(1, Math.round((Date.now() - started.current) / 1000));
      const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
      setTake({ blob, url: URL.createObjectURL(blob), seconds });
      setPhase('review');
    };
    started.current = Date.now();
    setElapsed(0);
    timer.current = window.setInterval(() => {
      const s = (Date.now() - started.current) / 1000;
      setElapsed(s);
      if (s >= MAX_SECONDS && r.state === 'recording') r.stop();
    }, 250);
    r.start();
    rec.current = r;
    setTake(null);
    setPhase('recording');
  };
  const stop = () => { if (rec.current?.state === 'recording') rec.current.stop(); };
  const use = async () => {
    if (!take) return;
    setPhase('saving');
    const e = await onUse(take.blob, take.seconds);
    if (e) { setErr(e); setPhase('review'); return; }
    setTake(null);
    setPhase('idle');
  };

  return (
    <div style={{ display: 'grid', gap: '8px', padding: '10px 12px', border: `1px solid ${C.line}`, borderRadius: '10px' }} data-testid="rvm-recorder">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12.5px', fontWeight: 600 }}>Recording</span>
        <span style={{ fontSize: '11.5px', color: C.muted }}>
          {phase === 'recording' ? 'Recording now. Stop when you are done.'
            : phase === 'review' || phase === 'saving' ? 'Listen back, then use it or record again.'
              : attached ? 'This push drops this recording. The script below is its written record.'
                : 'Optional. Without one, the carrier reads the script aloud.'}
        </span>
      </div>

      {phase === 'recording' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: C.red }} />
          <span className="mk-num" role="timer" aria-live="off" style={{ fontSize: '13px', fontWeight: 600 }} data-testid="rvm-timer">{clock(elapsed)}</span>
          <span className="mk-num" style={{ fontSize: '11.5px', color: C.muted }}>of {clock(MAX_SECONDS)}</span>
          <div style={{ flex: 1 }} />
          <Btn size="sm" onClick={stop} data-testid="rvm-stop"><Svg d={Icon.stop} size={12} /> Stop</Btn>
        </div>
      ) : phase === 'review' || phase === 'saving' ? (
        <div style={{ display: 'grid', gap: '8px' }}>
          {take ? <audio controls src={take.url} style={{ width: '100%', height: '36px' }} aria-label="Play back the recording" data-testid="rvm-playback" /> : null}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mk-num" style={{ fontSize: '11.5px', color: C.muted }}>{take ? clock(take.seconds) : ''}</span>
            <div style={{ flex: 1 }} />
            <Btn size="sm" onClick={() => void start()} disabled={phase === 'saving'} data-testid="rvm-rerecord"><Svg d={Icon.mic} size={12} /> Record again</Btn>
            <Btn size="sm" kind="primary" onClick={() => void use()} disabled={phase === 'saving' || disabled} data-testid="rvm-use">{phase === 'saving' ? 'Saving the recording…' : 'Use this recording'}</Btn>
          </div>
        </div>
      ) : attached ? (
        <div style={{ display: 'grid', gap: '8px' }}>
          {attached.url ? <audio controls src={attached.url} style={{ width: '100%', height: '36px' }} aria-label="Play the attached recording" data-testid="rvm-attached" /> : null}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mk-num" style={{ fontSize: '11.5px', color: '#0A8560', fontWeight: 600 }}>Attached · {clock(attached.seconds)}</span>
            <div style={{ flex: 1 }} />
            <Btn size="sm" kind="quiet" onClick={onRemove} disabled={disabled}>Remove</Btn>
            <Btn size="sm" onClick={() => void start()} disabled={disabled} data-testid="rvm-rerecord"><Svg d={Icon.mic} size={12} /> Record again</Btn>
          </div>
        </div>
      ) : (
        <div>
          <Btn onClick={() => void start()} disabled={disabled} aria-label="Record the ringless voicemail" data-testid="rvm-record"><Svg d={Icon.mic} size={13} /> Record voicemail</Btn>
        </div>
      )}
      {err ? <Note level="block">{err}</Note> : null}
    </div>
  );
}
