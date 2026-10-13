// Signed in, but there is no workspace to open. Either this account was never
// added to a team, it was removed from one, or the membership read failed.
// The first two need an owner; the last needs a retry. Both used to look like
// a loading skeleton that never finished.
'use client';

import React from 'react';
import { ClozrMark } from '@/components/ds/ClozrMark';
import { btn, INK, MUTED, SHADOW } from '@/components/genius/parts';

export function NoWorkspace({ failed, email, onRetry, onSignOut }: {
  failed: boolean;
  email: string | null;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return (
    <main data-gx style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: 'var(--page, #f2f4f8)', padding: '16px' }}>
      <div role={failed ? 'alert' : 'status'} style={{ width: '100%', maxWidth: '420px', background: '#fff', borderRadius: '14px', padding: '20px', boxShadow: SHADOW.md }}>
        <ClozrMark size={18} />
        <h1 style={{ margin: '16px 0 0', fontSize: '15px', fontWeight: 700, letterSpacing: '-0.015em', color: INK }}>
          {failed ? 'Couldn’t load your workspace' : 'You’re not on a workspace yet'}
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: '13px', lineHeight: 1.55, color: '#52525b' }}>
          {failed
            ? 'The list of teams you belong to didn’t come back. This is a connection problem, not your data: try again in a moment.'
            : <>{email ? <><span style={{ color: INK, fontWeight: 600 }}>{email}</span> isn’t </> : 'This account isn’t '}a member of any CLOZR workspace. If you were removed, or haven’t been invited, ask your workspace owner to add you from Settings, then retry.</>}
        </p>
        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
          <button type="button" onClick={onRetry} style={btn('purple')}>Retry</button>
          <button type="button" onClick={onSignOut} style={btn('ghost')}>Sign out</button>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: '11.5px', color: MUTED }}>
          <a href="/demo" style={{ color: MUTED }}>Browse the demo on sample data</a>
        </p>
      </div>
    </main>
  );
}
