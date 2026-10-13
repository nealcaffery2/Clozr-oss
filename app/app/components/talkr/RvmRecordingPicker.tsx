'use client';

/**
 * Which recording a ringless voicemail plays: pick one from the workspace's
 * saved recordings (play it first), or record a new one with the mic, listen
 * back, name it and save it to the library. Used everywhere an RVM is sent:
 * the bulk composer (People, Dispo, Buyers), the dispo push and action plan
 * RVM steps. Styles fall back to plain colors so it also sits in screens
 * without the Talkr theme.
 */
import { useEffect, useRef, useState } from 'react';
import { MAX_RVM_SECONDS, clipClock, droppable } from '@/lib/rvm-pick';
import { useVmLibrary, type VmClip } from './useVmLibrary';

const LINE = 'var(--line, #e4e4e7)';
const MUTED = 'var(--muted, #71717a)';
const GREEN = '#0A8560';
const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 11px', borderRadius: 8, border: `1px solid ${LINE}`,
  background: '#fff', font: '600 12.5px/1 var(--sans, inherit)', color: 'inherit', cursor: 'pointer',
};
const primary: React.CSSProperties = { ...btn, background: GREEN, borderColor: GREEN, color: '#fff' };

const Mic = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
  </svg>
);

type Take = { blob: Blob; url: string; seconds: number };

export function RvmRecordingPicker({ workspaceId, value, onChange, disabled, label = 'Recording', defaultName = 'Voicemail', script = '' }: {
  workspaceId: number | null;
  /** The chosen vm_library id, or null. */
  value: number | null;
  onChange: (clip: VmClip | null) => void;
  disabled?: boolean;
  label?: string;
  /** Pre-filled name for a new recording. */
  defaultName?: string;
  /** Saved with a new recording as its written record. */
  script?: string;
}) {
  const lib = useVmLibrary(workspaceId);
  const clips = lib.clips.filter(droppable);
  const chosen = clips.find((c) => c.id === value) ?? null;
  const [phase, setPhase] = useState<'pick' | 'recording' | 'review' | 'saving'>('pick');
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [name, setName] = useState(defaultName);
  const [err, setErr] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const timer = useRef<number | null>(null);
  const signedIn = workspaceId != null;

  const stopTimer = () => { if (timer.current != null) { window.clearInterval(timer.current); timer.current = null; } };
  useEffect(() => () => { stopTimer(); if (rec.current?.state === 'recording') rec.current.stop(); }, []);
  useEffect(() => () => { if (take) URL.revokeObjectURL(take.url); }, [take]);

  const pick = (id: string) => {
    setPlayUrl(null);
    onChange(clips.find((c) => String(c.id) === id) ?? null);
  };
  const play = async () => {
    if (!chosen?.audio_path) return;
    setErr(null);
    try { setPlayUrl(await lib.signedUrl(chosen.audio_path)); } catch (e) { setErr((e as Error).message); }
  };

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
      if (s >= MAX_RVM_SECONDS && r.state === 'recording') r.stop();
    }, 250);
    r.start();
    rec.current = r;
    setTake(null);
    setPhase('recording');
  };
  const stop = () => { if (rec.current?.state === 'recording') rec.current.stop(); };
  const save = async () => {
    if (!take) return;
    setPhase('saving');
    setErr(null);
    try {
      const clip = await lib.saveClip(name, script, take.blob, take.seconds);
      setTake(null);
      setPhase('pick');
      setPlayUrl(null);
      onChange(clip);
    } catch (e) {
      setErr(`The recording was not saved: ${(e as Error).message}`);
      setPhase('review');
    }
  };
  const cancel = () => { setTake(null); setPhase('pick'); setErr(null); };

  return (
    <div data-testid="rvm-picker" style={{ display: 'grid', gap: 8, padding: '10px 12px', border: `1px solid ${LINE}`, borderRadius: 10, background: '#fff' }}>
      <span style={{ font: '600 12.5px/1.2 var(--sans, inherit)' }}>{label}</span>
      {!signedIn ? (
        <span style={{ font: '400 12px/1.4 var(--sans, inherit)', color: MUTED }}>Sign in to a workspace to pick or record a voicemail.</span>
      ) : phase === 'recording' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: '#dc2626' }} />
          <span role="timer" style={{ font: '600 13px/1 var(--sans, inherit)', fontVariantNumeric: 'tabular-nums' }}>{clipClock(elapsed)}</span>
          <span style={{ font: '400 11.5px/1 var(--sans, inherit)', color: MUTED }}>of {clipClock(MAX_RVM_SECONDS)}</span>
          <span style={{ flex: 1 }} />
          <button type="button" style={btn} onClick={stop} data-testid="rvm-pick-stop">Stop</button>
        </div>
      ) : phase === 'review' || phase === 'saving' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {take ? <audio controls src={take.url} style={{ width: '100%', height: 36 }} aria-label="Play back the new recording" /> : null}
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name the recording" placeholder="Name, e.g. Buyer deal alert"
            style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: '7px 10px', font: '500 13px/1 var(--sans, inherit)' }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ font: '400 11.5px/1 var(--sans, inherit)', color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{take ? clipClock(take.seconds) : ''}</span>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={cancel} disabled={phase === 'saving'}>Cancel</button>
            <button type="button" style={btn} onClick={() => void start()} disabled={phase === 'saving'}><Mic /> Record again</button>
            <button type="button" style={primary} onClick={() => void save()} disabled={phase === 'saving' || disabled} data-testid="rvm-pick-save">{phase === 'saving' ? 'Saving…' : 'Save and use'}</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={chosen ? String(chosen.id) : ''} onChange={(e) => pick(e.target.value)} disabled={disabled} aria-label="Saved recording" data-testid="rvm-pick-select"
              style={{ flex: '1 1 200px', minWidth: 0, height: 30, border: `1px solid ${LINE}`, borderRadius: 8, padding: '0 8px', font: '500 12.5px/1 var(--sans, inherit)', background: '#fff' }}>
              <option value="">{clips.length ? 'Choose a saved recording…' : 'No saved recordings yet'}</option>
              {clips.map((c) => <option key={c.id} value={String(c.id)}>{c.name}{c.seconds ? ` · ${clipClock(c.seconds)}` : ''}</option>)}
            </select>
            {chosen ? <button type="button" style={btn} onClick={() => void play()} aria-label={`Play ${chosen.name}`}>▶ Play</button> : null}
            <span style={{ font: '400 12px/1 var(--sans, inherit)', color: MUTED }}>or</span>
            <button type="button" style={btn} onClick={() => void start()} disabled={disabled} data-testid="rvm-pick-record" aria-label="Record a new voicemail with the microphone"><Mic /> Record new</button>
          </div>
          {playUrl ? <audio controls autoPlay src={playUrl} style={{ width: '100%', height: 36 }} aria-label="Play the saved recording" /> : null}
          {chosen ? <span style={{ font: '600 11.5px/1.3 var(--sans, inherit)', color: GREEN }}>Every drop plays “{chosen.name}”.</span> : null}
        </div>
      )}
      {err || lib.error ? <span role="alert" style={{ font: '500 12px/1.4 var(--sans, inherit)', color: '#b91c1c' }}>{err || lib.error}</span> : null}
    </div>
  );
}
