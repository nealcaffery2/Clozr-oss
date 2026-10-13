'use client';

// Actions ▾ on the People and Buyers bulk bars: everything a selection can do
// that is not one of the few buttons kept on the bar. Grouped (Reach out,
// Organize, Data, then the destructive ones last). Typing filters, Up/Down
// move, Enter runs, Escape closes and hands focus back to the button. While
// it is open the list's own keys stand down (role="menu", lib/people-keys).

import React, { useEffect, useMemo, useRef, useState } from 'react';

export type BulkAction = {
  key: string;
  label: string;
  group: string;
  run: () => void;
  note?: string;
  danger?: boolean;
  disabled?: boolean;
};

export function ActionsMenu({ actions, accent = '#0A8560', label = 'Actions' }: { actions: BulkAction[]; accent?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? actions.filter((a) => a.label.toLowerCase().includes(t) || a.group.toLowerCase().includes(t)) : actions;
  }, [actions, q]);
  const enabled = shown.filter((a) => !a.disabled);

  const close = (refocus = true) => { setOpen(false); setQ(''); setAt(0); if (refocus) btn.current?.focus(); };
  const run = (a: BulkAction | undefined) => { if (!a || a.disabled) return; close(); a.run(); };

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!enabled.length) return;
      setAt((i) => (i + (e.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length);
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); run(enabled[at]); }
  };

  const current = enabled[at]?.key;
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button ref={btn} type="button" className="dc11" aria-haspopup="menu" aria-expanded={open} data-testid="bulk-actions"
        onClick={() => (open ? close() : setOpen(true))}
        style={{ height: '28px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${accent}55`, background: '#fff', fontSize: '12px', color: '#18181b', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
        {label} <span aria-hidden style={{ fontSize: '9px', color: '#71717a' }}>▾</span>
      </button>
      {open ? (
        <>
          <div onClick={() => close(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div role="menu" aria-label="Bulk actions" onKeyDown={onKey}
            style={{ position: 'absolute', top: '32px', left: 0, zIndex: 45, width: '260px', maxHeight: 'min(440px, 60vh)', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #e4e4e7', borderRadius: '10px', boxShadow: '0 2px 6px rgba(18,20,28,.06), 0 18px 40px -16px rgba(18,22,45,.28)' }}>
            <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setAt(0); }} placeholder="Search actions…" aria-label="Search actions"
              style={{ margin: '8px', height: '30px', padding: '0 9px', border: '1px solid #e4e4e7', borderRadius: '7px', fontSize: '12.5px', outline: 'none' }} />
            <div style={{ overflow: 'auto', padding: '0 4px 6px' }}>
              {shown.map((a, i) => {
                const head = a.group !== shown[i - 1]?.group;
                const on = a.key === current;
                return (
                  <div key={a.key}>
                    {head ? <div style={{ padding: '8px 8px 3px', fontSize: '11px', color: '#71717a', fontWeight: 600 }}>{a.group}</div> : null}
                    <button type="button" role="menuitem" data-action={a.key} disabled={a.disabled} tabIndex={-1}
                      onMouseEnter={() => { const k = enabled.findIndex((x) => x.key === a.key); if (k >= 0) setAt(k); }}
                      onClick={() => run(a)}
                      style={{ display: 'flex', width: '100%', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', textAlign: 'left', padding: '7px 8px', border: 0, borderRadius: '6px', background: on ? '#f4f4f5' : 'transparent', cursor: a.disabled ? 'not-allowed' : 'pointer', opacity: a.disabled ? 0.45 : 1, fontSize: '12.5px', color: a.danger ? '#dc2626' : '#18181b', font: 'inherit' }}>
                      <span>{a.label}</span>
                      {a.note ? <span style={{ fontSize: '11px', color: '#a1a1aa' }}>{a.note}</span> : null}
                    </button>
                  </div>
                );
              })}
              {!shown.length ? <div style={{ padding: '10px 8px', fontSize: '12px', color: '#a1a1aa' }}>No action matches “{q}”</div> : null}
            </div>
            <div style={{ borderTop: '1px solid #f4f4f5', padding: '6px 10px', fontSize: '11px', color: '#a1a1aa' }}>↑ ↓ to move · Enter to run · Esc to close</div>
          </div>
        </>
      ) : null}
    </div>
  );
}
