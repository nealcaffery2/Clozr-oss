// A date box that fits a form line: typed the way people write dates
// (10/20/2026, Oct 20 2026), or picked from the calendar button. The native
// <input type="date"> was clipped to nothing in the small boxes contract forms
// have, so a typed date never saved. Values go out as YYYY-MM-DD.
'use client';

import React, { useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { parseDay } from '@/supabase/functions/_shared/pdf-fields';

const shown = (v: string) => { const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[2]}/${m[3]}/${m[1]}` : v; };

export function DayInput({ value, onSet, style, label, placeholder, onFocus, onPointerDown }: {
  value: string;
  /** Called with YYYY-MM-DD, or null when cleared. A date that cannot be read is passed through as typed, for the server to reject with a message. */
  onSet: (v: string | null) => void;
  style?: React.CSSProperties; label: string; placeholder?: string;
  onFocus?: () => void; onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const commit = () => {
    if (draft == null) return;
    const t = draft.trim();
    setDraft(null);
    onSet(t ? parseDay(t) ?? t : null);
  };
  return (
    <span style={{ display: 'flex', alignItems: 'center', width: '100%', height: '100%', minWidth: 0 }}>
      <input
        value={draft ?? shown(value)} aria-label={label} placeholder={placeholder ?? 'MM/DD/YYYY'} inputMode="numeric"
        onFocus={onFocus} onPointerDown={onPointerDown}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        style={{ ...style, flex: 1, minWidth: 0 }}
      />
      <button
        type="button" aria-label={`Pick ${label} from a calendar`} title="Pick a date" onPointerDown={onPointerDown}
        onClick={() => { const el = picker.current; if (!el) return; try { el.showPicker(); } catch { el.focus(); } }}
        style={{ flex: 'none', border: 0, background: 'transparent', padding: '0 2px', cursor: 'pointer', color: 'inherit', display: 'grid', placeItems: 'center', height: '100%' }}
      >
        <CalendarDays size={13} aria-hidden />
      </button>
      <input
        ref={picker} type="date" tabIndex={-1} aria-hidden value={/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''}
        onChange={(e) => { setDraft(null); onSet(e.target.value || null); }}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
      />
    </span>
  );
}
