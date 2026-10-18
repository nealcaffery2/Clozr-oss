// A select you can type into: for long lists (every seller) where a plain
// <select> is a wall of names. Type to filter, arrow keys and Enter to pick,
// and sort the list A to Z or Z to A, or newest first when the options carry
// a date (`at`, ms since epoch).
'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

export type SearchOption = { v: string; label: string; at?: number };

const SORT_ICON = {
  // Lucide arrow-down-a-z, arrow-up-z-a and clock.
  asc: 'm3 16 4 4 4-4M7 20V4M20 8h-5M15 10V6.5a2.5 2.5 0 0 1 5 0V10M15 14h5l-5 6h5',
  desc: 'm3 8 4-4 4 4M7 4v16M15 4h5l-5 6h5M15 20v-3.5a2.5 2.5 0 0 1 5 0V20M20 18h-5',
  new: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
} as const;

export function SearchSelect({ value, options, placeholder, onChange, ariaLabel, fieldStyle }: {
  value: string; options: SearchOption[]; placeholder: string; onChange: (v: string) => void; ariaLabel?: string;
  /** Overrides for the input and the sort button, so the control matches the fields beside it. */
  fieldStyle?: React.CSSProperties;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<'asc' | 'desc' | 'new'>('asc');
  const dated = useMemo(() => options.some((o) => o.at), [options]);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const picked = options.find((o) => o.v === value) ?? null;
  const shown = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = options.filter((o) => terms.every((t) => o.label.toLowerCase().includes(t)));
    if (dir === 'new') hit.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.label.localeCompare(b.label));
    else hit.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) * (dir === 'asc' ? 1 : -1));
    return hit.slice(0, 200);
  }, [options, q, dir]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const choose = (o: SearchOption) => { onChange(o.v); setQ(''); setOpen(false); };
  const field: React.CSSProperties = { width: '100%', height: '34px', padding: '0 8px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '13px', outline: 0, background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)', fontFamily: 'inherit', boxSizing: 'border-box', ...fieldStyle };
  const sortName = dir === 'asc' ? 'Sorted A to Z' : dir === 'desc' ? 'Sorted Z to A' : 'Sorted by recent activity';
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: '6px' }}>
        <input value={open ? q : picked?.label ?? ''} placeholder={picked ? picked.label : placeholder} aria-label={ariaLabel ?? placeholder}
          role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
          onFocus={() => { setOpen(true); setQ(''); setHi(0); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, shown.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter' && open && shown[hi]) { e.preventDefault(); choose(shown[hi]); }
            else if (e.key === 'Escape') { setOpen(false); }
          }}
          style={field} />
        <button type="button" onClick={() => setDir((d) => (d === 'asc' ? 'desc' : d === 'desc' && dated ? 'new' : 'asc'))}
          aria-label={`${sortName}. Change sort`}
          title={dir === 'asc' ? 'Sorted A to Z: click for Z to A' : dir === 'desc' ? (dated ? 'Sorted Z to A: click for recent activity' : 'Sorted Z to A: click for A to Z') : 'Recent activity: click for A to Z'}
          style={{ ...field, width: field.height, padding: 0, cursor: 'pointer', display: 'inline-grid', placeItems: 'center', color: 'var(--muted, #52525b)', flex: 'none' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={SORT_ICON[dir]} /></svg>
        </button>
      </div>
      {open ? (
        <div role="listbox" id={listId} style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, top: '38px', maxHeight: '260px', overflow: 'auto', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', boxShadow: '0 10px 30px rgba(0,0,0,.12)' }}>
          {shown.map((o, i) => (
            <div key={o.v} role="option" aria-selected={o.v === value} onMouseDown={(e) => { e.preventDefault(); choose(o); }} onMouseEnter={() => setHi(i)}
              style={{ padding: '7px 10px', fontSize: '13px', cursor: 'pointer', background: i === hi ? '#F0FBF6' : o.v === value ? '#fafafa' : '#fff', fontWeight: o.v === value ? 650 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {o.label}
            </div>
          ))}
          {!shown.length ? <div style={{ padding: '10px', fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>No match for “{q}”.</div> : null}
          {options.length > shown.length && shown.length === 200 ? <div style={{ padding: '6px 10px', fontSize: '11.5px', color: 'var(--subtle, #a1a1aa)' }}>Showing 200 of {options.length}; type to narrow.</div> : null}
        </div>
      ) : null}
    </div>
  );
}
