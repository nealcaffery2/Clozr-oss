// The strip an admin sees while previewing a teammate (lib/view-as.ts), and
// the button on the Team roster that starts it.
'use client';

import React from 'react';
import { ROLE_LABEL, type Role } from '@/lib/team';
import { startViewAs, stopViewAs, type ViewAs } from '@/lib/view-as';
import { useCanWrite } from '@/lib/read-only-context';

export function ViewAsBanner({ who, onExit }: { who: ViewAs; onExit?: () => void }) {
  return (
    // clozr-viewas: moved to the top while the full-screen phone is up (globals.css).
    <div role="status" className="clozr-viewas" style={{
      position: 'fixed', left: '50%', bottom: 'calc(18px + env(safe-area-inset-bottom, 0px) + var(--clozr-callbar, 0px))', transform: 'translateX(-50%)',
      zIndex: 70, display: 'flex', alignItems: 'center', gap: '10px', maxWidth: 'calc(100vw - 24px)',
      padding: '8px 8px 8px 14px', borderRadius: '999px', background: '#7c2d12', color: '#fff',
      boxShadow: '0 10px 30px -10px rgba(0,0,0,.45)', fontSize: '12.5px',
    }}>
      <span style={{ width: '8px', height: '8px', borderRadius: '999px', background: '#fb923c', flex: 'none' }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Viewing as <b>{who.name}</b> · {ROLE_LABEL[who.role] ?? who.role} · read-only
      </span>
      <button type="button" onClick={() => { stopViewAs(); onExit?.(); }}
        style={{ height: '28px', padding: '0 12px', borderRadius: '999px', border: 0, background: 'var(--surface, #fff)', color: '#7c2d12', fontSize: '12px', fontWeight: 700, cursor: 'pointer', flex: 'none' }}>
        Exit
      </button>
    </div>
  );
}

export function ViewAsButton({ userId, role, name, onStart }: { userId: string; role: Role; name: string; onStart?: () => void }) {
  return (
    <button type="button" className="dc2" title={`See CLOZR the way ${name} does — their screens and their lists, read-only`}
      onClick={() => { startViewAs({ userId, role, name }); onStart?.(); }}
      style={{ height: '30px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--tint-orange-3, #fed7aa)', background: 'var(--tint-orange, #fff7ed)', fontSize: '12px', fontWeight: 600, color: 'var(--tx-orange, #c2410c)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
      View as
    </button>
  );
}

/**
 * A line at the top of a screen that saves things, shown only during a View-as
 * preview, so the fields and buttons below read as a look rather than a form.
 * The fetch guard (lib/read-only.ts) refuses the saves either way.
 */
export function ReadOnlyNote({ style }: { style?: React.CSSProperties }) {
  if (useCanWrite()) return null;
  return (
    <div role="note" style={{
      display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 12px', padding: '8px 12px', borderRadius: '9px',
      border: '1px solid var(--tint-orange-3, #fed7aa)', background: 'var(--tint-orange, #fff7ed)', color: 'var(--tx-orange-deep, #9a3412)', fontSize: '12.5px', fontWeight: 500, ...style,
    }}>
      <span style={{ width: '7px', height: '7px', borderRadius: '999px', background: '#fb923c', flex: 'none' }} />
      Read-only preview · changes here are not saved.
    </div>
  );
}
