// One contact field on a record, editable in place: the value (a link that
// calls or emails, passed as children) and a named Edit button beside it.
// Editing works like components/ds/InlineField: Enter or leaving the box
// saves, Esc cancels, a value the save refuses stays in the box with the
// reason under it, and nothing on screen changes until the save lands.
//
// A seller's phone and email go through crm-write `saveSellerContact`: the
// phone is stored E.164 and the number it replaces stays on file as one of
// their other numbers. A buyer's (buyerId) still writes the buyer row.
'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { readInline } from '@/components/ds/InlineField';
import { saveSellerContact } from '@/lib/crm-write';

const LABEL = { phone: 'phone', email: 'email', name: 'name' } as const;

export function ContactField({ sellerId, buyerId, workspaceId, field, value, canWrite, onSaved, onToast, children }: {
  sellerId: number | null; buyerId?: number | null;
  /** Needed for a seller: the save is scoped to the workspace. */
  workspaceId?: number | null;
  field: 'phone' | 'email' | 'name'; value: string; canWrite: boolean;
  /** After a save lands: the caller refreshes its copy of the record. */
  onSaved?: (stored: string | null) => void; onToast?: (m: string) => void; children?: React.ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const shown = value && value !== '—' ? value : '';
  const id0 = buyerId ?? sellerId;

  useEffect(() => { if (draft !== null) input.current?.focus(); }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => { cancelled.current = true; setDraft(null); setError(null); };
  const save = async () => {
    if (cancelled.current) { cancelled.current = false; return; }
    if (draft === null || !id0 || busy) return;
    const next = draft.trim();
    if (next === shown) { setDraft(null); setError(null); return; }
    const read = field === 'name' ? { value: next || null, error: next ? undefined : 'A name can’t be blank' } : readInline(field, next, { allowBlank: field === 'email' });
    if (read.error) { setError(read.error); return; }
    setBusy(true);
    let r: { ok: boolean; message?: string; stored?: string | null };
    if (!buyerId && field !== 'name') {
      r = workspaceId != null ? await saveSellerContact(workspaceId, id0, field, read.value) : { ok: false, message: 'Sign in to save changes.' };
    } else if (!supabase) {
      r = { ok: false, message: 'Sign in to save changes.' };
    } else {
      const v = read.value == null ? null : String(read.value);
      const patch = field === 'name' ? { name: v ?? '' } : field === 'phone' ? { phone: v } : { email: v };
      const { error: err } = buyerId
        ? await supabase.from('buyers').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', buyerId)
        : await supabase.from('sellers').update(patch).eq('id', id0);
      r = err ? { ok: false, message: /phone_uniq|duplicate/i.test(err.message) ? 'Another contact already has that phone number.' : err.message } : { ok: true, stored: v };
    }
    setBusy(false);
    if (!r.ok) { setError(r.message || 'That didn’t save. Try again'); return; }
    setDraft(null);
    setError(null);
    if (r.message) onToast?.(r.message);
    onSaved?.(r.stored ?? null);
  };

  const errId = `${id}-err`;
  if (draft !== null) {
    return (
      <span className="ds-inline" data-editing="" style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0, width: '100%' }}>
        <input ref={input} className="ds-inline-input" value={draft} disabled={busy} aria-label={`${field === 'phone' ? 'Phone' : field === 'email' ? 'Email' : 'Name'}`}
          aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined}
          type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'} inputMode={field === 'phone' ? 'tel' : undefined}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void save(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
          }}
          style={{ width: '100%', minWidth: 0 }} />
        {error ? <span id={errId} role="alert" className="ds-inline-error">{error}</span> : null}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', minWidth: 0 }}>
      <span className={field !== 'name' && shown ? 'clozr-contact' : undefined} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children ?? (shown || '—')}</span>
      {canWrite && id0 ? (
        <button type="button" aria-label={`Edit ${LABEL[field]}`} title={`Edit ${LABEL[field]}`}
          onClick={() => { cancelled.current = false; setError(null); setDraft(shown); }}
          style={{ width: '24px', height: '24px', display: 'inline-grid', placeItems: 'center', border: 0, borderRadius: '6px', background: 'none', color: 'var(--meta, #71717a)', cursor: 'pointer', padding: 0, flex: 'none' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}
