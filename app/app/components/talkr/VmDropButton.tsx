'use client';

/**
 * One tap on a live call: play a saved recording, hang up, and let predictive
 * dial the next. The recording picked in the session setup sheet
 * (DialSessionSetup.tsx, remembered per rep in lib/dial-session.ts) plays on
 * the first tap; "Other" opens the rest of the library.
 */
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import { DIAL_PREFS_CHANGED, readPrefs } from '@/lib/dial-session';
import { useSoftphone } from './softphoneAdapter';
import { useVmLibrary } from './useVmLibrary';

export function VmDropButton({ variant = 'card' }: { variant?: 'card' | 'phone' }) {
  const sp = useSoftphone();
  const session = useSession();
  const ws = session.workspace?.id ?? null;
  const uid = session.user?.id ?? null;
  const { clips, signedUrl } = useVmLibrary(ws);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickId, setPickId] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setPickId(readPrefs(ws, uid).vmClipId);
    const t = window.setTimeout(read, 0);
    window.addEventListener(DIAL_PREFS_CHANGED, read);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener(DIAL_PREFS_CHANGED, read);
    };
  }, [ws, uid]);
  const live = sp.callState === 'in_call';
  const withAudio = clips.filter((c) => c.audio_path);
  const picked = withAudio.find((c) => c.id === pickId && !/\.webm$/i.test(c.audio_path!)) ?? null;

  const drop = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const url = await signedUrl(path);
      await sp.dropVoicemail(url);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The recording did not play.');
    } finally {
      setBusy(false);
    }
  };

  const base: React.CSSProperties = variant === 'phone'
    ? { height: 44, borderRadius: 12, border: 0, background: 'rgba(255,255,255,.14)', color: '#fff', font: '600 15px/1 var(--sans)', padding: '0 14px' }
    : { marginTop: 12, height: 36, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--panel)', font: '600 13px/1 var(--sans)', padding: '0 12px', cursor: 'pointer' };

  const button = picked ? (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        data-testid="vm-drop"
        disabled={!live || busy}
        title={`Plays “${picked.name}” and hangs up`}
        onClick={() => void drop(picked.audio_path!)}
        style={base}
      >
        {busy ? 'Playing…' : `Drop VM · ${picked.name}`}
      </button>
      <button type="button" data-testid="vm-drop-other" disabled={!live || busy} onClick={() => setOpen((v) => !v)} style={{ ...base, padding: '0 10px' }} aria-expanded={open}>
        Other
      </button>
    </span>
  ) : (
    <button
      type="button"
      data-testid="vm-drop"
      disabled={!live || busy}
      onClick={() => setOpen((v) => !v)}
      style={base}
    >
      {busy ? 'Playing…' : 'Drop VM'}
    </button>
  );

  return (
    <div className={variant === 'card' ? 'flex flex-col items-center' : undefined}>
      {button}
      {open && (
        <div className="mt-2 flex w-full flex-col gap-1" style={{ maxWidth: 280 }}>
          {withAudio.length === 0 && (
            <span style={{ font: '400 12px/1.35 var(--sans)', color: variant === 'phone' ? 'rgba(255,255,255,.7)' : 'var(--muted)' }}>
              Record a voicemail on the dialer’s RVM tab first.
            </span>
          )}
          {withAudio.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busy}
              onClick={() => void drop(c.audio_path!)}
              style={{
                textAlign: 'left', borderRadius: 8, border: '1px solid var(--line)', padding: '8px 10px',
                background: variant === 'phone' ? 'rgba(255,255,255,.1)' : 'var(--panel)',
                color: variant === 'phone' ? '#fff' : 'var(--text)', font: '500 13px/1.2 var(--sans)', cursor: 'pointer',
              }}
            >
              {c.name}{c.seconds ? ` · ${c.seconds}s` : ''}
            </button>
          ))}
        </div>
      )}
      {error && <span role="alert" style={{ font: '500 12px/1.3 var(--sans)', color: '#FF6961' }}>{error}</span>}
    </div>
  );
}
