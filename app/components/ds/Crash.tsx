// What a screen shows when its code threw.
//
// The framework's own fallback says "This page couldn't load" and nothing
// else, which leaves the person looking at it with no way to tell whether the
// server is down, their data is bad, or one line of ours is wrong — and leaves
// whoever has to fix it with nothing to go on. This one names the error, keeps
// the rest of the app standing where it can, and offers the ways out in order
// of how much they cost: try the screen again, go back to Home, reload.

'use client';

import React, { useEffect } from 'react';
import { isChunkLoadError, reloadForNewDeploy } from '@/lib/chunk-reload';

export function Crash({
  error, where, onRetry, onHome, full = false,
}: {
  error: unknown;
  /** What was being drawn when it failed — a screen name, or nothing for the whole app. */
  where?: string | null;
  onRetry?: () => void;
  onHome?: () => void;
  /** Fill the viewport (the whole app is gone) rather than the screen area. */
  full?: boolean;
}) {
  const err = error instanceof Error ? error : null;
  // A screen whose code chunk was deleted by a newer deploy is fixed by a
  // reload, so do it rather than ask; the guard shows this card if it recurs.
  const stale = isChunkLoadError(error);
  useEffect(() => { if (stale) reloadForNewDeploy(); }, [stale]);
  const message = stale
    ? 'CLOZR was updated while this tab was open. Reload to load the new version.'
    : err?.message || (typeof error === 'string' ? error : 'Something in this screen threw an error.');
  const stack = err?.stack && err.stack !== err.message ? err.stack.split('\n').slice(0, 8).join('\n') : null;
  const reload = () => { if (typeof window !== 'undefined') window.location.reload(); };
  const btn = (primary: boolean): React.CSSProperties => ({
    height: '34px', padding: '0 14px', borderRadius: '9px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
    border: primary ? '1px solid var(--ink, #18181b)' : '1px solid var(--divider, #e4e4e7)',
    background: primary ? 'var(--ink, #18181b)' : 'var(--surface, #fff)', color: primary ? 'var(--surface, #fff)' : 'var(--ink, #18181b)',
  });
  return (
    <div role="alert" style={{
      flex: 1, minWidth: 0, minHeight: full ? '100dvh' : 0, display: 'grid', placeItems: 'center',
      background: 'var(--canvas, #fafafa)', padding: '24px 16px', fontFamily: 'inherit',
    }}>
      <div style={{ width: '100%', maxWidth: '440px', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '14px', padding: '22px 20px' }}>
        <div style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--tx-red, #b91c1c)' }}>
          {where ? `${where} could not be drawn` : 'CLOZR hit an error'}
        </div>
        <div style={{ marginTop: '8px', fontSize: '15px', fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ink, #18181b)', lineHeight: 1.4, overflowWrap: 'anywhere' }}>
          {message}
        </div>
        <div style={{ marginTop: '6px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.55 }}>
          Your records are not affected — this is a fault in the app, not in your data.
          {' '}A screenshot of this card is enough to get it fixed.
        </div>
        {stack ? (
          <details style={{ marginTop: '10px' }}>
            <summary style={{ fontSize: '12px', color: 'var(--meta, #71717a)', cursor: 'pointer' }}>Details</summary>
            <pre style={{ margin: '8px 0 0', padding: '10px', background: 'var(--surface-2, #f4f4f5)', borderRadius: '8px', fontSize: '11px', lineHeight: 1.45, color: 'var(--ink-3, #3f3f46)', overflow: 'auto', maxHeight: '180px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {stack}
            </pre>
          </details>
        ) : null}
        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
          {onRetry ? <button type="button" onClick={onRetry} style={btn(true)}>Try again</button> : null}
          {onHome ? <button type="button" onClick={onHome} style={btn(false)}>Go to Home</button> : null}
          <button type="button" onClick={reload} style={btn(false)}>Reload CLOZR</button>
        </div>
      </div>
    </div>
  );
}
