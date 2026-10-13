'use client';

// The dropdown half of a filter menu, with a type-ahead box on top. Buyers
// and Realtors carry hundreds of cities; scrolling a plain menu for "Tulsa"
// was the slow part. Arrow keys move, Enter picks, Esc closes.

import React, { useId, useMemo, useState } from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { PickLabel } from '@/components/ds/PickBox';

type Option = { label: string; on: boolean; go: () => void };

const SHOW = 200;

export function ComboPopover({ label, options, onClose, style, className, touch, multi }: {
  label: string;
  /** Several picks (lib/multi-filter): rows get a checkbox and picking keeps the popover open. */
  multi?: boolean;
  /** Phones get a 16px input so iOS does not zoom. */
  touch?: boolean;
  options: Option[];
  onClose: () => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const id = useId();
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return options;
    // Prefix hits first ("Da" finds Dallas before Canada), then anywhere.
    const starts = options.filter((o) => o.label.toLowerCase().startsWith(t));
    const rest = options.filter((o) => !o.label.toLowerCase().startsWith(t) && o.label.toLowerCase().includes(t));
    return [...starts, ...rest];
  }, [q, options]);
  const shown = matches.slice(0, SHOW);
  const at = Math.min(cursor, Math.max(0, shown.length - 1));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(Math.min(at + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(Math.max(at - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); shown[at]?.go(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
      <div ref={keepInView} className={className} onKeyDown={onKey} style={{ zIndex: 45, display: 'flex', flexDirection: 'column', ...style, overflow: 'hidden' }}>
        <div style={{ padding: 4 }}>
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={id}
            aria-activedescendant={shown.length ? `${id}-${at}` : undefined}
            aria-label={`Search ${label.toLowerCase()}`}
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(0); }}
            placeholder={`Type a ${label.toLowerCase()}…`}
            style={{ width: '100%', height: 30, borderRadius: 8, border: '1px solid #e4e4e7', padding: '0 9px', fontSize: touch ? 16 : 13, background: '#fafafa', color: '#18181b', outlineOffset: 1 }}
          />
        </div>
        <div id={id} role="listbox" aria-label={label} style={{ overflow: 'auto', flex: 1, minHeight: 0, padding: '0 4px 4px' }}>
          {shown.map((o, i) => (
            <button
              key={o.label}
              id={`${id}-${i}`}
              type="button"
              role="option"
              aria-selected={o.on}
              tabIndex={-1}
              className={'dc2 cz-menu-item' + (o.on ? ' is-on' : '')}
              onMouseEnter={() => setCursor(i)}
              onClick={o.go}
              style={i === at ? { background: '#f4f4f5' } : undefined}
            >
              <PickLabel multi={multi} on={o.on} label={o.label} />
              {o.on && (!multi || o.label === 'Any') ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg> : null}
            </button>
          ))}
          {!shown.length ? <div role="status" style={{ padding: '8px 10px', fontSize: 12.5, color: '#71717a' }}>No {label.toLowerCase()} matches “{q.trim()}”</div> : null}
          {matches.length > SHOW ? <div style={{ padding: '6px 10px', fontSize: 11.5, color: '#71717a' }}>{(matches.length - SHOW).toLocaleString('en-US')} more. Keep typing to narrow.</div> : null}
        </div>
      </div>
    </>
  );
}
