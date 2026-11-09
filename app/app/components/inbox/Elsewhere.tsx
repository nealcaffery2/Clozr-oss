'use client';

// "Not in CLOZR" for a number the open workspace has no record for, unless
// another of this person's workspaces has one: then who they are and where,
// and a way there (lib/elsewhere.ts).

import React from 'react';
import { useSession } from '@/lib/session';
import { type Elsewhere, useElsewhere } from '@/lib/elsewhere';
import { openRecordInWorkspace } from '@/lib/talkr-extension';
import { formatPhone, toE164 } from '@/lib/talkr-web/time';

export function useElsewhereHere(phone: string | null | undefined): { hit: Elsewhere | null; open: (() => void) | null } {
  const s = useSession();
  const e164 = phone ? toE164(phone) || null : null;
  const hit = useElsewhere(e164, s.workspace?.id, s.workspaces);
  // Ask first, then switch: the open waits until that workspace's contacts are loaded.
  const open = hit && e164 ? () => { openRecordInWorkspace(e164, hit.workspaceId); s.switchWorkspace(hit.workspaceId); } : null;
  return { hit, open };
}

export const elsewhereText = (h: Elsewhere) => `${h.kind === 'seller' ? 'Seller' : 'Buyer'} · ${h.name} · in ${h.workspaceName}`;

/** A thread's title: its own name, else the other workspace's record, else the number. Label only. */
export function ThreadName({ phone, name }: { phone: string | null | undefined; name: string | null | undefined }) {
  const { hit } = useElsewhereHere(name ? null : phone);
  return <>{name || hit?.name || formatPhone(phone ?? '')}</>;
}

/** Text only, for inside a row that is itself a button. */
export function NotHere({ phone, fallback = 'Not in CLOZR' }: { phone: string | null | undefined; fallback?: string }) {
  const { hit } = useElsewhereHere(phone);
  return <>{hit ? elsewhereText(hit) : fallback}</>;
}

/** The same, as a link that switches workspace and opens the record. */
export function NotHereLink({ phone, fallback = 'Not in CLOZR', className, style }: { phone: string | null | undefined; fallback?: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  const { hit, open } = useElsewhereHere(phone);
  if (!hit || !open) return <>{fallback}</>;
  return (
    <button type="button" onClick={open} className={className} title={`Switch to ${hit.workspaceName} and open ${hit.name}`}
      style={{ font: 'inherit', color: 'var(--accent)', background: 'none', border: 0, padding: 0, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2, ...style }}>
      {elsewhereText(hit)}
    </button>
  );
}
