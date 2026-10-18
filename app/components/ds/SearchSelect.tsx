// A filter menu with a type-to-filter box, for menus too long to scan (the
// People Submitter filter lists every wholesaler who ever sent a deal).
// Same look as the plain `cz-menu` dropdowns; the caller keeps its trigger
// and its open state, this is the panel that opens under it.
'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { normSearch } from '@/lib/list-search';
import { PickLabel } from '@/components/ds/PickBox';

export type SearchSelectOption = {
  label: string;
  /** The current pick: checked, and where the highlight starts. */
  on?: boolean;
  /** A muted note on the right, e.g. a count. */
  meta?: string;
  /** Last activity, ms since epoch. Powers the Recent sort. */
  at?: number;
  go: () => void;
};

/**
 * The open panel. Typing filters by every word; arrows move, Enter picks,
 * Escape or a click outside closes. The first `pinned` options (the "Any"
 * that clears the filter) stay listed whatever is typed.
 */
export function SearchSelectMenu({
  options, onClose, placeholder = 'Search…', pinned = 1, style, multi,
}: {
  options: SearchSelectOption[];
  onClose: () => void;
  placeholder?: string;
  pinned?: number;
  style?: React.CSSProperties;
  /** Several picks (lib/multi-filter): rows get a checkbox and picking keeps the menu open. */
  multi?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [dir, setDir] = useState<'list' | 'az' | 'za' | 'recent'>('list');
  const dated = options.some((o) => o.at != null);
  const keyed = useMemo(() => options.map((o, i) => ({ o, i, k: ' ' + normSearch(o.label) })), [options]);
  const terms = normSearch(text).split(' ').filter(Boolean);
  const shown = terms.length
    ? keyed.filter((x) => x.i < pinned || terms.every((t) => x.k.includes(t)))
    : [...keyed];
  // Word-start matches ("dal" → "Dallas Homes") above ones mid-word.
  if (terms.length) {
    const starts = (x: { k: string }) => (x.k.includes(' ' + terms[0]) ? 0 : 1);
    shown.sort((a, b) => (a.i < pinned ? -1 : b.i < pinned ? 1 : starts(a) - starts(b) || a.i - b.i));
  } else if (dir !== 'list') {
    const pin = shown.filter((x) => x.i < pinned);
    const rest = shown.filter((x) => x.i >= pinned);
    if (dir === 'recent') rest.sort((a, b) => (b.o.at ?? 0) - (a.o.at ?? 0) || a.o.label.localeCompare(b.o.label));
    else rest.sort((a, b) => a.o.label.localeCompare(b.o.label, 'en', { sensitivity: 'base' }) * (dir === 'az' ? 1 : -1));
    shown.splice(0, shown.length, ...pin, ...rest);
  }
  const firstHit = terms.length ? Math.min(pinned, shown.length - 1) : Math.max(0, shown.findIndex((x) => x.o.on));
  const [active, setActive] = useState<number | null>(null);
  const at = Math.min(active ?? firstHit, shown.length - 1);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-ss-idx="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((at + step + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      shown[at]?.o.go();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Close this menu only, not the screen or record behind it.
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
      <div ref={keepInView} className="cz-menu cz-menu--left" onKeyDown={onKey}
        style={{ top: '38px', left: 0, width: '260px', display: 'flex', flexDirection: 'column', maxHeight: 'min(400px, 52vh)', ...style }}>
        <input
          autoFocus
          value={text}
          onChange={(e) => { setText(e.target.value); setActive(null); }}
          placeholder={placeholder}
          role="combobox"
          aria-expanded="true"
          aria-controls={id}
          aria-activedescendant={shown[at] ? `${id}-${at}` : undefined}
          aria-autocomplete="list"
          style={{ flex: 'none', height: '32px', margin: '0 0 6px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--canvas, #fafafa)', fontSize: '12.5px', color: 'var(--ink, #18181b)', outline: 'none', fontFamily: 'var(--font-sans)' }}
        />
        <div style={{ display: 'flex', gap: 4, margin: '0 0 6px' }}>
          {(dated ? ['az', 'za', 'recent'] as const : ['az', 'za'] as const).map((d) => (
            <button key={d} type="button" aria-pressed={dir === d} onClick={() => setDir((cur) => (cur === d ? 'list' : d))}
              style={{ height: 24, padding: '0 8px', borderRadius: 7, border: '1px solid var(--divider, #e4e4e7)', background: dir === d ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', color: dir === d ? '#0A8560' : 'var(--muted, #52525b)', fontSize: 11, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit' }}>
              {d === 'az' ? 'A to Z' : d === 'za' ? 'Z to A' : 'Recent'}
            </button>
          ))}
        </div>
        <div ref={listRef} id={id} role="listbox" style={{ overflow: 'auto', minHeight: 0 }}>
          {shown.map((x, n) => (
            <button key={x.i} id={`${id}-${n}`} data-ss-idx={n} type="button" role="option" aria-selected={!!x.o.on}
              className={'dc2 cz-menu-item' + (x.o.on ? ' is-on' : '')}
              onMouseMove={() => { if (n !== at) setActive(n); }}
              onClick={x.o.go}
              style={n === at ? { background: x.o.on ? '#d8f3e8' : '#f4f4f5' } : undefined}>
              {multi ? <PickLabel multi on={!!x.o.on} label={x.o.label} /> : <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.o.label}</span>}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flex: 'none' }}>
                {x.o.meta ? <span className="cz-menu-meta">{x.o.meta}</span> : null}
                {x.o.on && (!multi || x.o.label === 'Any') ? <span style={{ fontSize: '11px' }}>✓</span> : null}
              </span>
            </button>
          ))}
          {shown.length <= pinned && terms.length ? (
            <div style={{ padding: '8px 10px', fontSize: '12px', color: 'var(--subtle, #a1a1aa)' }}>No match for “{text.trim()}”</div>
          ) : null}
        </div>
      </div>
    </>
  );
}
