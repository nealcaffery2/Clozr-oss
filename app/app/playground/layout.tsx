// /playground holds experiments, not product screens. Production serves them
// only to a signed-in owner or admin; everyone else (signed out, any other
// role) gets a plain "not here" page. Local dev shows them to anyone.
'use client';

import React from 'react';
import { useSession } from '@/lib/session';
import { isAdmin, type Role } from '@/lib/team';

const DEV = process.env.NODE_ENV !== 'production';

export default function PlaygroundLayout({ children }: { children: React.ReactNode }) {
  const s = useSession();
  if (DEV) return <>{children}</>;
  if (!s.ready || (s.session && s.memberships === 'loading')) {
    return <main aria-busy="true" style={{ minHeight: '100dvh', background: '#fafafa' }} />;
  }
  if (!isAdmin((s.workspace?.role as Role | undefined) ?? null)) {
    return (
      <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#fafafa', padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: '360px', textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#18181b' }}>This page isn’t available</h1>
          <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#52525b', lineHeight: 1.5 }}>
            Playground pages are for workspace owners and admins. <a href="/app" style={{ color: '#0A8560' }}>Open CLOZR</a>
          </p>
        </div>
      </main>
    );
  }
  return <>{children}</>;
}
