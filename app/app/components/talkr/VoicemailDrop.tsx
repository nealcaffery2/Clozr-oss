'use client';

/**
 * The voicemail a rep drops: record it, hear it back, save it, and pick which
 * one Drop VM plays. Settings → Audio & sounds owns the card. The dialer's
 * Fix / Record voicemail button opens the same recorder in a dialog, because
 * jumping to the RVM tab closed the checklist and often landed on a screen
 * that does not show the recorder at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { armDrop } from '@/lib/busy-drop';
import { readPrefs, savePrefs, DIAL_PREFS_CHANGED } from '@/lib/dial-session';
import { onPhoneBusy, phoneBusy } from '@/lib/phone-busy';
import { clipClock, MAX_RVM_SECONDS } from '@/lib/rvm-pick';
import { useVmLibrary, VM_LIBRARY_CHANGED, type VmClip } from './useVmLibrary';
import { Button } from './ui';

const HELP = { font: '400 11.5px/1.45 var(--sans)', color: 'var(--muted)' } as const;
const WEBM = /\.webm$/i;

type Phase = 'idle' | 'recording' | 'review' | 'saving';
type Take = { blob: Blob; url: string; seconds: number };

function playable(c: VmClip): boolean {
  return !!c.audio_path && !WEBM.test(c.audio_path);
}

/** Remember this clip as the one Drop VM and a busy second answer play. */
async function rememberDrop(
  workspaceId: number | null,
  userId: string | null,
  clip: VmClip,
  signedUrl: (path: string) => Promise<string>,
) {
  const prefs = readPrefs(workspaceId, userId);
  savePrefs(workspaceId, userId, { ...prefs, vmClipId: clip.id });
  if (!clip.audio_path || WEBM.test(clip.audio_path)) return;
  const url = await signedUrl(clip.audio_path);
  armDrop({ clipId: clip.id, name: clip.name, script: clip.script ?? '', url, urlUntil: Date.now() + 120_000 });
}

/**
 * Keep a fresh signed URL for the clip the rep picked, so a second answer
 * during a call can play it without waiting on a fetch that would miss the ring.
 */
export function useArmBusyDrop(workspaceId: number | null, userId: string | null) {
  const lib = useVmLibrary(workspaceId);
  const [prefsRev, setPrefsRev] = useState(0);
  useEffect(() => {
    const on = () => setPrefsRev((n) => n + 1);
    window.addEventListener(DIAL_PREFS_CHANGED, on);
    window.addEventListener(VM_LIBRARY_CHANGED, on);
    return () => {
      window.removeEventListener(DIAL_PREFS_CHANGED, on);
      window.removeEventListener(VM_LIBRARY_CHANGED, on);
    };
  }, []);

  const signedUrl = lib.signedUrl;
  const clips = lib.clips;
  useEffect(() => {
    const prefs = readPrefs(workspaceId, userId);
    const rows = clips.filter(playable);
    const mine = rows.filter((c) => !!userId && c.created_by === userId);
    const pick = rows.find((c) => c.id === prefs.vmClipId) ?? mine[mine.length - 1] ?? rows[0] ?? null;
    if (!pick?.audio_path) {
      armDrop(null);
      return;
    }
    let live = true;
    let timer = 0;
    /** A refresh came due while nobody could need the URL, so it may have expired. */
    let stale = false;
    // Fresh while the rep can see the tab, and in a hidden tab while a call or
    // dial session is up there (lib/phone-busy): a second answer only reaches a
    // tab on a call. The URL lasts 120 seconds; a refresh every 90 keeps it live.
    const due = () => !document.hidden || phoneBusy();
    const sign = () => {
      stale = false;
      void signedUrl(pick.audio_path!).then((url) => {
        if (!live) return;
        armDrop({ clipId: pick.id, name: pick.name, script: pick.script ?? '', url, urlUntil: Date.now() + 120_000 });
      }).catch(() => { if (live) armDrop(null); });
      timer = window.setTimeout(refresh, 90_000);
    };
    const refresh = () => {
      if (due()) sign();
      else stale = true;
    };
    // Shown again, or a call starting in a hidden tab, after a skipped refresh: sign at once.
    const wake = () => { if (stale && due()) sign(); };
    refresh();
    document.addEventListener('visibilitychange', wake);
    const offBusy = onPhoneBusy(wake);
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      offBusy();
    };
  }, [clips, signedUrl, workspaceId, userId, prefsRev]);
}

export function VoicemailDropPanel({ workspaceId, userId }: { workspaceId: number | null; userId: string | null }) {
  const lib = useVmLibrary(workspaceId);
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [name, setName] = useState('My voicemail');
  const [script, setScript] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<number | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const timer = useRef<number | null>(null);

  const refreshArmed = useCallback(() => {
    const prefs = readPrefs(workspaceId, userId);
    setArmedId(prefs.vmClipId);
  }, [workspaceId, userId]);
  useEffect(() => {
    refreshArmed();
    const on = () => refreshArmed();
    window.addEventListener(DIAL_PREFS_CHANGED, on);
    return () => window.removeEventListener(DIAL_PREFS_CHANGED, on);
  }, [refreshArmed]);

  const stopTimer = () => {
    if (timer.current != null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => () => {
    stopTimer();
    const r = rec.current;
    const stream = streamRef.current;
    if (r && r.state === 'recording') {
      r.ondataavailable = null;
      r.onstop = () => stream?.getTracks().forEach((t) => t.stop());
      r.stop();
    } else stream?.getTracks().forEach((t) => t.stop());
    if (take) URL.revokeObjectURL(take.url);
  }, [take]);

  const rows = lib.clips.filter((c) => !!c.audio_path);
  const chosen = rows.find((c) => c.id === armedId && playable(c))
    ?? rows.filter((c) => playable(c) && !!userId && c.created_by === userId).at(-1)
    ?? null;

  const start = async () => {
    setErr(null);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setErr('This browser cannot record audio. Use Chrome, Edge or Safari.');
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    if (!stream) {
      setErr('The microphone is blocked. Allow it for this site, then record again.');
      return;
    }
    const r = new MediaRecorder(stream);
    chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      stopTimer();
      const seconds = Math.max(1, Math.round((Date.now() - started.current) / 1000));
      const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
      if (!blob.size) {
        setErr('That take was empty. Hold Record, say the message, then press Stop.');
        setPhase('idle');
        return;
      }
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
    streamRef.current = stream;
    try { r.start(200); } catch { r.start(); }
    rec.current = r;
    setPhase('recording');
  };

  const stop = () => {
    const r = rec.current;
    if (!r || r.state !== 'recording') return;
    // Flush the last slice before stop, so a short take is not an empty file.
    try { r.requestData(); } catch { /* stop still emits the final chunk */ }
    r.stop();
  };

  const discard = () => {
    if (take) URL.revokeObjectURL(take.url);
    setTake(null);
    setPhase('idle');
    setErr(null);
  };

  const save = async () => {
    if (!take) return;
    if (workspaceId == null) {
      setErr('Sign in to a workspace to save a voicemail.');
      return;
    }
    setPhase('saving');
    setErr(null);
    try {
      const clip = await lib.saveClip(name, script, take.blob, take.seconds);
      await rememberDrop(workspaceId, userId, clip, lib.signedUrl);
      if (take) URL.revokeObjectURL(take.url);
      setTake(null);
      setPhase('idle');
      setArmedId(clip.id);
    } catch (e) {
      setErr((e as Error).message || 'The recording was not saved.');
      setPhase('review');
    }
  };

  const selectClip = async (clip: VmClip) => {
    setErr(null);
    try {
      await rememberDrop(workspaceId, userId, clip, lib.signedUrl);
      setArmedId(clip.id);
    } catch (e) {
      setErr((e as Error).message || 'That recording could not be selected.');
    }
  };

  const play = async (clip: VmClip) => {
    if (!clip.audio_path) return;
    setErr(null);
    try { setPlayUrl(await lib.signedUrl(clip.audio_path)); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="vm-drop-panel">
      <ol className="flex flex-col gap-1.5" style={{ ...HELP, margin: 0, paddingLeft: 18 }}>
        <li><b style={{ color: 'var(--text)' }}>On a call you are on.</b> Drop VM plays this recording into the call and hangs up.</li>
        <li><b style={{ color: 'var(--text)' }}>A machine on a predictive campaign.</b> Talkr speaks the script below when it detects an answering machine.</li>
        <li><b style={{ color: 'var(--text)' }}>Someone else answers while you are already talking.</b> This browser plays the same recording on that line and hangs it up. The call you are on stays up.</li>
      </ol>
      <p style={HELP}>
        A line Talkr never offers to this browser is still hung up on the Talkr server. Clozr can only play audio on a call this browser is connected to. That server-side drop lives in Talkr.
      </p>

      {workspaceId == null ? (
        <p style={HELP}>Sign in to a workspace to record a voicemail.</p>
      ) : phase === 'recording' ? (
        <div className="flex items-center gap-2.5" data-testid="vm-drop-recording">
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: '#dc2626' }} />
          <span role="timer" style={{ font: '600 13px/1 var(--sans)', fontVariantNumeric: 'tabular-nums' }}>{clipClock(elapsed)}</span>
          <span style={HELP}>of {clipClock(MAX_RVM_SECONDS)}</span>
          <span className="flex-1" />
          <Button tone="ghost" onClick={stop}>Stop</Button>
        </div>
      ) : phase === 'review' || phase === 'saving' ? (
        <div className="flex flex-col gap-2" data-testid="vm-drop-review">
          {take ? <audio controls src={take.url} style={{ width: '100%', height: 36 }} aria-label="Play back the new voicemail" /> : null}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Voicemail name"
            placeholder="Name, e.g. My voicemail"
            style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', font: '500 13px/1 var(--sans)' }}
          />
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            aria-label="Voicemail script"
            rows={2}
            placeholder="What it says. Talkr reads this when it drops a voicemail on a machine by itself."
            style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', font: '400 13px/1.4 var(--sans)', resize: 'vertical' }}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span style={{ ...HELP, fontVariantNumeric: 'tabular-nums' }}>{take ? clipClock(take.seconds) : ''}</span>
            <span className="flex-1" />
            <Button tone="ghost" onClick={discard} disabled={phase === 'saving'}>Discard</Button>
            <Button tone="ghost" onClick={() => void start()} disabled={phase === 'saving'}>Record again</Button>
            <Button tone="green" onClick={() => void save()} disabled={phase === 'saving'}>{phase === 'saving' ? 'Saving…' : 'Save voicemail'}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button tone="green" onClick={() => void start()}>Record voicemail</Button>
          {chosen ? (
            <span style={{ font: '600 12px/1.3 var(--sans)', color: 'var(--green, #0a8560)' }}>
              Drop VM plays “{chosen.name}”{chosen.seconds ? ` · ${clipClock(chosen.seconds)}` : ''}
            </span>
          ) : (
            <span style={HELP}>No voicemail of yours yet.</span>
          )}
        </div>
      )}

      {rows.length > 0 && phase === 'idle' && (
        <ul className="flex flex-col gap-1" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {rows.map((c) => {
            const on = chosen?.id === c.id;
            const webm = !!c.audio_path && WEBM.test(c.audio_path);
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-1.5" style={{ font: '500 12.5px/1.3 var(--sans)' }}>
                <span className="mr-auto min-w-0 truncate">
                  {c.name}{c.seconds ? ` · ${clipClock(c.seconds)}` : ''}
                  {webm ? ' · record again, WebM will not play on a call' : ''}
                  {on ? ' · used for Drop VM' : ''}
                </span>
                {!webm && (
                  <>
                    <Button tone="quiet" onClick={() => void play(c)} style={{ padding: '6px 9px', font: '600 11px/1 var(--sans)' }}>Play</Button>
                    {!on && <Button tone="ghost" onClick={() => void selectClip(c)} style={{ padding: '6px 9px', font: '600 11px/1 var(--sans)' }}>Use this</Button>}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {playUrl && phase === 'idle' ? <audio controls autoPlay src={playUrl} style={{ width: '100%', height: 36 }} aria-label="Play the saved voicemail" /> : null}
      {(err || lib.error) && <span role="alert" style={{ ...HELP, color: 'var(--tx-red, #b91c1c)' }}>{err || lib.error}</span>}
    </div>
  );
}

type RecorderHost = (open: boolean) => void;
let host: RecorderHost | null = null;

export function hostVoicemailRecorder(fn: RecorderHost): () => void {
  host = fn;
  return () => { if (host === fn) host = null; };
}

/** Open the recorder. No-op until VoicemailRecorderHost is mounted. */
export function openVoicemailRecorder(): void {
  host?.(true);
}

export function VoicemailRecorderHost({ workspaceId, userId }: { workspaceId: number | null; userId: string | null }) {
  const [open, setOpen] = useState(false);
  useEffect(() => hostVoicemailRecorder(setOpen), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="vm-record-title"
      onClick={() => setOpen(false)}
      style={{ position: 'fixed', inset: 0, zIndex: 160, background: 'rgba(28,29,31,.5)', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="talkr-dialer flex flex-col gap-3"
        style={{ width: 'min(480px, 100%)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', background: '#fdfcfa', color: '#1c1d1f', borderRadius: 18, padding: '18px 16px 16px', boxShadow: '0 30px 80px rgba(28,29,31,.35)' }}
      >
        <div id="vm-record-title" style={{ font: '700 18px/1.2 var(--sans)' }}>Record a voicemail</div>
        <VoicemailDropPanel workspaceId={workspaceId} userId={userId} />
        <div className="flex justify-end">
          <Button tone="ghost" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </div>
    </div>
  );
}
