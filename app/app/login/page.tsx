// Sign in / create account.
//
// Three ways in, because acquisitions teams are not all at desks: password,
// magic link, and a reset. All of it runs in the browser against Supabase —
// the app is a static export, so there is no server to post to.
//
// Two extra gates, both optional per project: hCaptcha on every form when a
// site key is configured, and a TOTP step-up after sign-in when the account
// has an authenticator enrolled (Supabase aal1 → aal2).
'use client';

import { useRouter } from 'next/navigation';
import { safeNext } from '@/lib/nav-hash';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ClozrMark } from '@/components/ds/ClozrMark';
import { HCAPTCHA_SITE_KEY, captchaEnabled, loadHcaptcha } from '@/lib/captcha';
import { useSession } from '@/lib/session';

type Mode = 'signin' | 'signup' | 'magic' | 'reset' | 'mfa';

const COPY: Record<Mode, { title: string; sub: string; submit: string }> = {
  signin: { title: 'Sign in', sub: 'Pick up where your pipeline left off.', submit: 'Sign in' },
  signup: { title: 'Create your account', sub: 'Your workspace is set up on first sign-in.', submit: 'Create account' },
  magic: { title: 'Email me a link', sub: 'No password — we send a one-time link.', submit: 'Send magic link' },
  reset: { title: 'Reset your password', sub: 'We email you a link to set a new one.', submit: 'Send reset link' },
  mfa: { title: 'Two-factor code', sub: 'Enter the 6-digit code from your authenticator app.', submit: 'Verify and continue' },
};

const label: React.CSSProperties = {
  display: 'block',
  fontSize: '11.5px',
  color: 'var(--meta, #71717a)',
  fontWeight: 500,
  marginBottom: '6px',
};

const field: React.CSSProperties = {
  width: '100%',
  height: '38px',
  padding: '0 11px',
  border: '1px solid var(--divider, #e4e4e7)',
  borderRadius: '9px',
  fontSize: '13.5px',
  outline: 0,
  background: 'var(--canvas, #fafafa)',
  color: 'var(--ink, #18181b)',
};

/**
 * Launched from the Home Screen. An installed web app keeps its own cookies
 * and storage, apart from Safari's, and a link tapped in Mail opens in Safari —
 * so an emailed sign-in link can never sign this app in. Read once; it does
 * not change while the page is open.
 */
const noSubscribe = () => () => {};
function isInstalledApp(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen)').matches === true
  );
}

export default function LoginPage() {
  const installed = useSyncExternalStore(noSubscribe, isInstalledApp, () => false);
  const s = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(() => {
    if (typeof window === 'undefined') return 'signin';
    const q = new URLSearchParams(window.location.search);
    return q.has('reset') || q.get('mode') === 'reset' ? 'reset' : 'signin';
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // Where the app sent you from (`?next=`), checked: CLOZR app addresses only.
  const [next] = useState(() => (typeof window === 'undefined' ? '/app' : safeNext(new URLSearchParams(window.location.search).get('next'))));

  // A session exists (fresh sign-in, or arriving back from a magic link).
  // Before going to the app, ask whether this account owes a second factor.
  const sessionId = s.session?.access_token ?? null;
  useEffect(() => {
    if (!sessionId) return;
    try {
      if (sessionStorage.getItem('clozr.recovery') === '1') {
        router.replace('/login/reset');
        return;
      }
    } catch { /* private mode */ }
    let live = true;
    void s.mfa.level().then((lvl) => {
      if (!live) return;
      if (lvl.stepUp && lvl.factorId) {
        setFactorId(lvl.factorId);
        setMode('mfa');
        setNote(null);
      } else {
        router.replace(next);
      }
    });
    return () => {
      live = false;
    };
  }, [sessionId, s.mfa, router, next]);

  // hCaptcha, only when a site key is configured for this build.
  const captchaBox = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const showCaptcha = captchaEnabled() && mode !== 'mfa' && !s.demo;
  useEffect(() => {
    if (!showCaptcha || !captchaBox.current) return;
    const box = captchaBox.current;
    let live = true;
    void loadHcaptcha()
      .then((h) => {
        if (!live || widgetId.current) return;
        widgetId.current = h.render(box, { sitekey: HCAPTCHA_SITE_KEY });
      })
      .catch(() => {
        if (live) setNote({ ok: false, text: 'The captcha could not load. Check your connection and try again.' });
      });
    return () => {
      live = false;
    };
  }, [showCaptcha]);

  const c = COPY[mode];
  const needsPassword = mode === 'signin' || mode === 'signup';

  function captchaToken(): string | undefined {
    if (!showCaptcha) return undefined;
    const t = window.hcaptcha?.getResponse(widgetId.current ?? undefined) ?? '';
    return t || undefined;
  }
  function resetCaptcha() {
    if (showCaptcha && widgetId.current) window.hcaptcha?.reset(widgetId.current);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);

    if (mode === 'mfa') {
      if (!factorId) {
        setBusy(false);
        return;
      }
      const r = await s.mfa.verify(factorId, code);
      setBusy(false);
      if (r.ok) router.replace(next);
      else {
        setCode('');
        setNote({ ok: false, text: r.message ?? 'That code did not verify. Try the next one.' });
      }
      return;
    }

    const token = captchaToken();
    if (showCaptcha && !token) {
      setBusy(false);
      setNote({ ok: false, text: 'Please complete the captcha first.' });
      return;
    }
    const opts = token ? { captchaToken: token } : undefined;
    const r =
      mode === 'signin' ? await s.signIn(email, password, opts)
      : mode === 'signup' ? await s.signUp(email, password, name, opts)
      : mode === 'magic' ? await s.sendMagicLink(email, opts)
      : await s.sendReset(email, opts);
    setBusy(false);
    resetCaptcha();
    if (r.message) setNote({ ok: r.ok, text: r.message });
    else if (!r.ok) setNote({ ok: false, text: 'Something went wrong.' });
  }

  function go(next: Mode) {
    setMode(next);
    setNote(null);
  }

  async function cancelMfa() {
    await s.signOut();
    setCode('');
    setFactorId(null);
    go('signin');
  }

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: 'var(--canvas, #fafafa)', padding: '24px 16px' }}>
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <a href="/" style={{ display: 'inline-flex', marginBottom: '22px', textDecoration: 'none' }}>
          <ClozrMark size={22} />
        </a>

        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '14px', padding: '24px', boxShadow: '0 1px 2px rgba(18,20,28,.05), 0 10px 28px -10px rgba(18,22,40,.13)' }}>
          <h1 style={{ margin: 0, fontSize: '19px', fontWeight: 700, letterSpacing: '-0.02em' }}>{c.title}</h1>
          <p style={{ margin: '5px 0 20px', fontSize: '13px', color: 'var(--meta, #71717a)' }}>{c.sub}</p>

          {s.demo ? (
            <div style={{ marginBottom: '16px', padding: '11px 12px', borderRadius: '10px', background: 'var(--caution-soft, #fef3c7)', border: '1px solid var(--tint-amber-2, #fde68a)', fontSize: '12.5px', color: 'var(--tx-amber-deep, #92400e)', lineHeight: 1.5 }}>
              Supabase isn&rsquo;t configured for this deployment, so sign-in is inactive.{' '}
              <a href="/demo" style={{ color: 'var(--tx-amber-deep, #92400e)', fontWeight: 600 }}>Open the demo</a> to browse CLOZR on sample data.
            </div>
          ) : null}

          <form onSubmit={submit}>
            {mode === 'mfa' ? (
              <div style={{ marginBottom: '13px' }}>
                <label htmlFor="code" style={label}>Authenticator code</label>
                <input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  placeholder="123 456"
                  required
                  autoFocus
                  style={{ ...field, letterSpacing: '.2em', fontSize: '16px' }}
                />
              </div>
            ) : null}

            {mode === 'signup' ? (
              <div style={{ marginBottom: '13px' }}>
                <label htmlFor="name" style={label}>Your name</label>
                <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Smith" autoComplete="name" required style={field} />
              </div>
            ) : null}

            {mode !== 'mfa' ? (
              <div style={{ marginBottom: '13px' }}>
                <label htmlFor="email" style={label}>Work email</label>
                <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@acmehomes.com" autoComplete="email" required style={field} />
              </div>
            ) : null}

            {needsPassword ? (
              <div style={{ marginBottom: '13px' }}>
                <label htmlFor="password" style={label}>Password</label>
                <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={8} style={field} />
              </div>
            ) : null}

            {showCaptcha ? <div ref={captchaBox} style={{ marginBottom: '13px', minHeight: '78px' }} /> : null}

            {note ? (
              <div role="status" style={{ margin: '4px 0 13px', padding: '10px 11px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5, background: note.ok ? 'var(--positive-soft, #dcfce7)' : 'var(--negative-soft, #fee2e2)', border: `1px solid ${note.ok ? 'var(--tint-green-3, #bbf7d0)' : 'var(--tint-red-2, #fecaca)'}`, color: note.ok ? 'var(--tx-green, #15803d)' : '#b91c1c' }}>
                {note.text}
              </div>
            ) : null}

            <button type="submit" disabled={busy || s.demo || (mode === 'mfa' && code.length < 6)} className="dc3" style={{ width: '100%', height: '40px', borderRadius: '10px', border: '1px solid #0A8560', background: busy || s.demo ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '13.5px', fontWeight: 600, cursor: busy || s.demo ? 'not-allowed' : 'pointer' }}>
              {busy ? 'Working…' : c.submit}
            </button>
          </form>

          {installed && mode !== 'mfa' ? (
            <p role="note" style={{ margin: '14px 0 0', padding: '10px 11px', borderRadius: '9px', background: 'var(--surface-2, #f4f4f5)', fontSize: '12.5px', lineHeight: 1.5, color: 'var(--muted, #52525b)' }}>
              In the installed app, sign in with your password. Email links open in Safari, not here
              {mode === 'reset' ? ' — reset your password in Safari, then sign in here with the new one.' : '.'}
            </p>
          ) : null}

          <div style={{ marginTop: '16px', paddingTop: '15px', borderTop: '1px solid var(--divider-2, #f0f0f1)', display: 'flex', flexWrap: 'wrap', gap: '10px 16px', fontSize: '12.5px' }}>
            {mode === 'mfa' ? (
              <Alt onClick={() => void cancelMfa()}>Use a different account</Alt>
            ) : (
              <>
                {mode !== 'signin' ? <Alt onClick={() => go('signin')}>Sign in with a password</Alt> : null}
                {mode !== 'magic' ? <Alt onClick={() => go('magic')}>Email me a link</Alt> : null}
                {mode !== 'signup' ? <Alt onClick={() => go('signup')}>Create an account</Alt> : null}
                {mode !== 'reset' ? <Alt onClick={() => go('reset')}>Forgot password</Alt> : null}
              </>
            )}
          </div>
        </div>

        <p style={{ margin: '16px 2px 0', fontSize: '12px', color: 'var(--subtle, #a1a1aa)', display: 'flex', gap: '14px' }}>
          <a href="/" style={{ color: 'var(--meta, #71717a)' }}>Back to clozr.com</a>
          {/* Still reachable once sign-in works, for anyone who landed here
              wanting a look rather than an account. */}
          <a href="/demo" style={{ color: 'var(--meta, #71717a)' }}>Browse the demo</a>
        </p>
      </div>
    </main>
  );
}

function Alt({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--tx-mint, #0a8560)', fontWeight: 500, fontSize: '12.5px' }}>
      {children}
    </button>
  );
}
