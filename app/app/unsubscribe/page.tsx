// The unsubscribe page. A bulk email's "Unsubscribe" line lands here:
// /unsubscribe/?t=<token>. It asks before acting, because mail scanners open
// links on their own and should not unsubscribe anyone. Gmail's own
// unsubscribe button skips this page: it POSTs straight to the function
// (RFC 8058 one-click).
'use client';

import React, { useState, useSyncExternalStore } from 'react';
import { supabase } from '@/lib/supabase';

export default function Unsubscribe() {
  const token = useSyncExternalStore(() => () => {}, () => new URLSearchParams(window.location.search).get('t') ?? '', () => null);
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; text?: string }>({ kind: 'idle' });

  const go = async () => {
    if (!supabase || !token) return setState({ kind: 'error', text: 'This unsubscribe link is incomplete.' });
    setState({ kind: 'busy' });
    const { data, error } = await supabase.functions.invoke('deliverability', { body: { action: 'unsubscribe', t: token } });
    if (error || !data?.ok) return setState({ kind: 'error', text: 'That unsubscribe link is not valid. Reply to the email with "unsubscribe" and you will be removed.' });
    setState({ kind: 'done', text: `${data.email} will not get more of these emails from ${data.company}.` });
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--canvas, #fafafa)', fontFamily: 'var(--font-inter), Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: '24px' }}>
      <div style={{ maxWidth: '420px', width: '100%', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '14px', padding: '28px', textAlign: 'center' }}>
        <h1 style={{ margin: '0 0 8px', fontSize: '19px' }}>{state.kind === 'done' ? 'You are unsubscribed' : 'Unsubscribe'}</h1>
        <p style={{ margin: '0 0 18px', fontSize: '14px', color: 'var(--muted, #52525b)', lineHeight: 1.5 }}>
          {state.text ?? 'Stop receiving these emails? Replies to a conversation you started are not affected.'}
        </p>
        {(state.kind === 'idle' || state.kind === 'busy') && (
          <button type="button" disabled={state.kind === 'busy' || token === null} onClick={() => void go()} style={{ height: '40px', padding: '0 20px', borderRadius: '10px', border: 0, background: 'var(--ink, #18181b)', color: 'var(--surface, #fff)', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
            {state.kind === 'busy' ? 'Unsubscribing…' : 'Unsubscribe'}
          </button>
        )}
      </div>
    </main>
  );
}
