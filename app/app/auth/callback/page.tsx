// Where magic links, email confirmations and password resets land.
//
// supabase-js reads the token out of the URL itself (detectSessionInUrl is on
// by default), so this page's only job is to wait for that to settle and then
// send the visitor on. A recovery link is the exception: it signs you in, but
// the point of it is to set a new password, so it routes to /login/reset
// instead of the pipeline.
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ClozrMark } from '@/components/ds/ClozrMark';
import { useSession } from '@/lib/session';

export default function AuthCallbackPage() {
  const s = useSession();
  const router = useRouter();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    // Recovery used to live in the hash (`type=recovery`). PKCE puts a `code`
    // on the query instead; we still honour the hash so older emails work.
    const hash = typeof window === 'undefined' ? '' : window.location.hash;
    const query = typeof window === 'undefined' ? '' : window.location.search;
    const recovery = hash.includes('type=recovery') || /(?:^|[?&])type=recovery(?:&|$)/.test(query);
    if (recovery) {
      try { sessionStorage.setItem('clozr.recovery', '1'); } catch { /* private mode */ }
    }
    if (!s.ready) return;
    const flagged = recovery || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('clozr.recovery') === '1');
    if (s.session) router.replace(flagged ? '/login/reset' : '/app');
    else router.replace('/login');
  }, [s.ready, s.session, router]);

  // If neither branch fires the link was already used or has expired; say so
  // rather than spinning forever.
  useEffect(() => {
    const t = setTimeout(() => setStuck(true), 6000);
    return () => clearTimeout(t);
  }, []);

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: 'var(--canvas, #fafafa)', padding: '24px' }}>
      <div style={{ textAlign: 'center' }}>
        <ClozrMark size={22} />
        <p style={{ marginTop: '16px', fontSize: '13px', color: 'var(--meta, #71717a)' }}>
          {stuck ? 'That link has expired or was already used.' : 'Signing you in…'}
        </p>
        {stuck ? (
          <a href="/login" style={{ display: 'inline-block', marginTop: '10px', fontSize: '13px', color: 'var(--tx-mint, #0a8560)', fontWeight: 600 }}>
            Back to sign in
          </a>
        ) : null}
      </div>
    </main>
  );
}
