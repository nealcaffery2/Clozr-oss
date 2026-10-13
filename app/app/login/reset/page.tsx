// Where a password-reset email lands. Recovery used to bounce through
// /auth/callback onto /app?account=1 — a query the shell never reads — so
// there was no page to type a new password.
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ClozrMark } from '@/components/ds/ClozrMark';
import { useSession } from '@/lib/session';
import '../../clozr/tokens.css';

const label: React.CSSProperties = {
  display: 'block',
  fontSize: '11.5px',
  color: '#71717a',
  fontWeight: 600,
  marginBottom: '6px',
};

const field: React.CSSProperties = {
  width: '100%',
  height: '38px',
  padding: '0 11px',
  border: '1px solid #e4e4e7',
  borderRadius: '9px',
  fontSize: '13.5px',
  outline: 0,
  background: '#fafafa',
  color: '#18181b',
};

export default function ResetPasswordPage() {
  const s = useSession();
  const router = useRouter();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!s.ready) return;
    if (s.session) return;
    const t = setTimeout(() => setExpired(true), 6000);
    return () => clearTimeout(t);
  }, [s.ready, s.session]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 8) {
      setNote({ ok: false, text: 'Use at least 8 characters.' });
      return;
    }
    if (pw !== pw2) {
      setNote({ ok: false, text: 'Those passwords do not match.' });
      return;
    }
    setBusy(true);
    setNote(null);
    const r = await s.changePassword(pw);
    setBusy(false);
    if (!r.ok) {
      setNote({ ok: false, text: r.message ?? 'Could not update the password.' });
      return;
    }
    try { sessionStorage.removeItem('clozr.recovery'); } catch { /* private mode */ }
    router.replace('/app');
  }

  const waiting = !s.ready || (!s.session && !expired);

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#fafafa', padding: '24px 16px' }}>
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <a href="/" style={{ display: 'inline-flex', marginBottom: '22px', textDecoration: 'none' }}>
          <ClozrMark size={22} />
        </a>
        <div style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: '14px', padding: '24px', boxShadow: '0 1px 2px rgba(18,20,28,.05), 0 10px 28px -10px rgba(18,22,40,.13)' }}>
          <h1 style={{ margin: 0, fontSize: '19px', fontWeight: 700, letterSpacing: '-0.02em' }}>
            {expired ? 'This link expired' : 'Choose a new password'}
          </h1>
          <p style={{ margin: '5px 0 20px', fontSize: '13px', color: '#71717a' }}>
            {waiting
              ? 'Opening your reset link…'
              : expired
                ? 'Request a new one from sign-in. Reset links work once, and only for a short time.'
                : `For ${s.user?.email ?? 'your account'}.`}
          </p>

          {waiting ? (
            <p style={{ margin: 0, fontSize: '13px', color: '#71717a' }}>Signing you in…</p>
          ) : expired ? (
            <a href="/login?reset=1" style={{ fontSize: '13.5px', fontWeight: 600, color: '#0A8560' }}>Send a new reset link</a>
          ) : (
            <form onSubmit={submit}>
              <div style={{ marginBottom: '13px' }}>
                <label htmlFor="pw" style={label}>New password</label>
                <input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" required minLength={8} autoFocus style={field} />
              </div>
              <div style={{ marginBottom: '13px' }}>
                <label htmlFor="pw2" style={label}>Confirm</label>
                <input id="pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Same password again" autoComplete="new-password" required minLength={8} style={field} />
              </div>
              {note ? (
                <div role="status" style={{ margin: '4px 0 13px', padding: '10px 11px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5, background: '#fee2e2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                  {note.text}
                </div>
              ) : null}
              <button type="submit" disabled={busy} className="dc3" style={{ width: '100%', height: '40px', borderRadius: '10px', border: '1px solid #0A8560', background: busy ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '13.5px', fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}>
                {busy ? 'Saving…' : 'Save password and continue'}
              </button>
            </form>
          )}
        </div>
        <p style={{ margin: '16px 2px 0', fontSize: '12px', color: '#a1a1aa' }}>
          <a href="/login" style={{ color: '#71717a' }}>← Back to sign in</a>
        </p>
      </div>
    </main>
  );
}
