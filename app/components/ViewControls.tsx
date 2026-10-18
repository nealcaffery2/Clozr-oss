// The Views menu and the column picker the Deals, People and Buyers tables
// share — Podio-style saved looks. Triggers, menus and chevrons use the
// shared iPhone chrome (ds/chrome), matching Inbox dropdowns.
'use client';

import React, { useState } from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { Chevron, CZ, MenuCheck, menuInfo, menuPanel, primaryBtn, ghostBtn, SHADOW } from '@/components/ds/chrome';
import type { SavedViews } from '@/lib/saved-views';

const TRIGGER: React.CSSProperties = {
  height: '32px', padding: '0 10px', borderRadius: '10px', border: 0,
  background: 'var(--surface, #fff)', fontFamily: 'var(--font-sans)', fontSize: '12.5px', fontWeight: 500, lineHeight: 1, color: CZ.ink2,
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap',
  boxShadow: SHADOW.ring,
};
const SMALL: React.CSSProperties = {
  ...ghostBtn, height: '28px', padding: '0 10px', borderRadius: '8px', fontSize: '12px',
};

/**
 * Pick, save, update and delete saved views. `current` is the look on screen
 * right now; `dirty` says it differs from the open view, which is when
 * "Update" is offered.
 */
export function ViewMenu<C>({ sv, current, dirty, onApply, onToast, align = 'right', pill }: {
  sv: SavedViews<C>;
  current: C;
  dirty: boolean;
  /** Apply a view's config (null = the screen's default look). */
  onApply: (config: C | null) => void;
  onToast?: (msg: string) => void;
  align?: 'left' | 'right';
  /** Phone strip styling — soft tray chip instead of a hairline rectangle. */
  pill?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const a = sv.active;
  const close = () => { setOpen(false); setNaming(false); setName(''); setShare(false); };
  const pick = (id: string | null) => {
    sv.select(id);
    onApply(id ? sv.views.find((v) => v.id === id)?.config ?? null : null);
    close();
  };
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const made = await sv.create(name, current, share);
    setBusy(false);
    if (!made) return onToast?.('That view did not save.');
    onToast?.(`Saved view “${made.name}”`);
    close();
  };
  const overwrite = async () => {
    if (!a || busy) return;
    setBusy(true);
    const ok = await sv.update(a.id, current);
    setBusy(false);
    onToast?.(ok ? `Updated “${a.name}”` : 'That view did not update.');
    close();
  };
  const drop = async () => {
    if (!a || busy || !window.confirm(`Delete the view “${a.name}”?`)) return;
    setBusy(true);
    const ok = await sv.remove(a.id);
    setBusy(false);
    if (ok) onApply(null);
    onToast?.(ok ? `Deleted “${a.name}”` : 'That view did not delete.');
    close();
  };
  const label = a ? a.name : 'Default view';
  const tray = pill ? {
    height: '32px', borderRadius: '16px', padding: '0 12px', border: 0, boxShadow: 'none',
    background: a ? CZ.mintSoft : CZ.tray, color: a ? CZ.mint : CZ.ink, fontWeight: a ? 600 : 500,
  } : null;
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button type="button" className={`dc9 cz-menu-trigger${open || a ? ' is-on' : ''}`} onClick={() => (open ? close() : setOpen(true))} title="Saved views"
        aria-expanded={open} aria-haspopup="menu"
        style={{
          ...TRIGGER,
          ...tray,
          ...(a && !pill ? { background: CZ.mintSoft, color: CZ.mint, fontWeight: 600, boxShadow: '0 0 0 1px rgba(10,133,96,.28), 0 1px 2px -1px rgba(10,133,96,.12)' } : null),
        }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
        </svg>
        <span style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {dirty && a ? <span title="Changed since this view was saved" style={{ width: '6px', height: '6px', borderRadius: '999px', background: '#d97706' }} /> : null}
        <Chevron size={11} color={a ? CZ.mint : CZ.faint} dir={open ? 'up' : 'down'} />
      </button>
      {open ? (
        <>
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={keepInView} role="menu" aria-label="Saved views" className={`cz-menu cz-menu--${align}`} style={{ ...menuPanel, [align]: 0, width: '280px' }}>
            <div className="cz-menu-head">Views</div>
            <div style={{ maxHeight: 'min(300px, 44vh)', overflow: 'auto', padding: '0 0 2px' }}>
              {[{ id: null as string | null, name: 'Default view', shared: false, mine: true }, ...sv.views].map((v) => {
                const on = (a?.id ?? null) === v.id;
                return (
                  <button key={v.id ?? 'default'} type="button" role="menuitem" className={`dc2 cz-menu-item${on ? ' is-on' : ''}`} onClick={() => pick(v.id)}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                    {v.shared ? <span className="cz-menu-meta" style={{ fontSize: '11px', fontWeight: 700, color: v.mine ? '#2563eb' : '#7c3aed', background: v.mine ? '#eff6ff' : '#f5f3ff', borderRadius: '6px', padding: '2px 6px' }}>{v.mine ? 'Shared' : 'Team'}</span> : null}
                    <MenuCheck on={on} />
                  </button>
                );
              })}
            </div>
            <div className="cz-menu-sep" />
            <div style={{ padding: '4px 4px 2px', display: 'grid', gap: '8px' }}>
              {naming ? (
                <>
                  <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80}
                    onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setNaming(false); }}
                    placeholder="Name this view — e.g. Morgan's closings" className="dc17"
                    style={{ height: '32px', padding: '0 10px', border: 0, borderRadius: '10px', fontSize: '12.5px', outline: 0, background: 'var(--surface, #fff)', fontFamily: 'var(--font-sans)', boxShadow: SHADOW.ring }} />
                  {sv.store === 'workspace' ? (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: 'var(--muted, #52525b)', cursor: 'pointer', padding: '0 4px' }}>
                      <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} style={{ accentColor: 'var(--c-accent)' }} />
                      Share with the team
                    </label>
                  ) : null}
                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                    <button type="button" className="dc2 cz-btn" onClick={() => setNaming(false)} style={SMALL}>Cancel</button>
                    <button type="button" className="dc10" onClick={() => void save()} disabled={!name.trim() || busy}
                      style={{ ...SMALL, ...primaryBtn, height: '28px', opacity: name.trim() ? 1 : 0.5 }}>Save view</button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '0 2px' }}>
                  <button type="button" className="dc10" onClick={() => setNaming(true)} style={{ ...SMALL, ...primaryBtn, height: '28px' }}>+ Save as new view</button>
                  {a && a.mine && dirty ? <button type="button" className="dc2 cz-btn" onClick={() => void overwrite()} style={SMALL}>Update “{a.name.length > 14 ? a.name.slice(0, 13) + '…' : a.name}”</button> : null}
                  {a && a.mine ? <button type="button" className="dc2 cz-btn" onClick={() => void drop()} style={{ ...SMALL, color: 'var(--tx-hot, #dc2626)' }}>Delete</button> : null}
                </div>
              )}
              <div className="cz-menu-info" style={menuInfo}>
                {sv.store === 'workspace'
                  ? 'A view keeps the columns, their order and the filters. Shared views show in every teammate’s menu.'
                  : 'A view keeps the columns, their order and the filters — saved in this browser.'}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export type ColumnDef = { key: string; label: string; locked?: boolean };

/**
 * Show, hide and reorder a table's fields. `value` is the ordered list of
 * visible keys; locked fields are always on and stay where they are.
 */
export function ColumnPicker({ all, value, onChange, defaults, title = 'Fields in this table', label = 'Columns', align = 'right', note, reorder = true }: {
  all: ColumnDef[];
  value: string[];
  onChange: (keys: string[]) => void;
  defaults: string[];
  title?: string;
  label?: string;
  align?: 'left' | 'right';
  note?: string;
  /** False for a list whose order is fixed (the board's stages). */
  reorder?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shown = value.filter((k) => all.some((c) => c.key === k));
  const hidden = all.filter((c) => !shown.includes(c.key));
  const byKey = (k: string) => all.find((c) => c.key === k)!;
  const move = (k: string, dir: -1 | 1) => {
    const i = shown.indexOf(k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= shown.length || byKey(shown[j]).locked) return;
    const next = [...shown];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const row = (c: ColumnDef, on: boolean, i: number) => (
    <div key={c.key} className="dc2" style={{ display: 'grid', gridTemplateColumns: '18px 1fr auto', gap: '9px', alignItems: 'center', padding: '6px 8px', borderRadius: '8px' }}>
      <button type="button" aria-label={(on ? 'Hide ' : 'Show ') + c.label} disabled={c.locked}
        onClick={() => onChange(on ? shown.filter((k) => k !== c.key) : reorder ? [...shown, c.key] : all.map((x) => x.key).filter((k) => k === c.key || shown.includes(k)))}
        style={{ width: '18px', height: '18px', padding: 0, borderRadius: '5px', display: 'grid', placeItems: 'center', background: on ? (c.locked ? 'var(--subtle, #a1a1aa)' : CZ.mint) : 'var(--surface, #fff)', border: 0, boxShadow: on ? 'none' : SHADOW.ring, cursor: c.locked ? 'default' : 'pointer' }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--surface, #fff)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      </button>
      <span style={{ fontSize: '12.5px', color: c.locked ? CZ.faint : on ? CZ.ink : CZ.muted, fontWeight: on ? 500 : 400 }}>{c.label}</span>
      {reorder && on && !c.locked ? (
        <span style={{ display: 'inline-flex', gap: '2px' }}>
          <button type="button" aria-label={'Move ' + c.label + ' up'} onClick={() => move(c.key, -1)} disabled={i === 0 || byKey(shown[i - 1])?.locked} style={ARROW}>↑</button>
          <button type="button" aria-label={'Move ' + c.label + ' down'} onClick={() => move(c.key, 1)} disabled={i === shown.length - 1} style={ARROW}>↓</button>
        </span>
      ) : <span />}
    </div>
  );
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button type="button" className={`dc9 cz-menu-trigger${open ? ' is-on' : ''}`} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)} style={TRIGGER}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" />
        </svg>
        {label}
        <span style={{ fontSize: '11px', color: CZ.faint, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{shown.length}/{all.length}</span>
        <Chevron size={11} dir={open ? 'up' : 'down'} />
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={keepInView} role="menu" aria-label={title} className={`cz-menu cz-menu--${align}`} style={{ ...menuPanel, [align]: 0, width: '276px', overflow: 'hidden' }}>
            <div className="cz-menu-head" style={{ paddingBottom: 8, borderBottom: `1px solid ${CZ.soft}`, marginBottom: 4 }}>
              <span><strong style={{ color: CZ.ink2 }}>{title}</strong></span>
              <span style={{ display: 'inline-flex', gap: '10px' }}>
                <button type="button" className="dc12" onClick={() => onChange(all.map((c) => c.key))} style={LINK}>All</button>
                <button type="button" className="dc12" onClick={() => onChange([...defaults])} style={LINK}>Reset</button>
              </span>
            </div>
            <div style={{ maxHeight: 'min(440px, 56vh)', overflow: 'auto', padding: '2px 0' }}>
              {shown.map((k, i) => row(byKey(k), true, i))}
              {hidden.length ? <div className="cz-menu-head" style={{ paddingTop: 10 }}>Hidden</div> : null}
              {hidden.map((c) => row(c, false, -1))}
            </div>
            {note ? <div className="cz-menu-info" style={menuInfo}>{note}</div> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Sort a list, and put it back. `value` is one of `options[].id`. When it is
 * not `resetId`, the trigger highlights and Reset is offered.
 */
export function SortMenu({ options, value, resetId, onChange, pill }: {
  options: { id: string; label: string }[];
  value: string;
  resetId: string;
  onChange: (id: string) => void;
  pill?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const dirty = value !== resetId;
  const label = options.find((o) => o.id === value)?.label ?? 'Sort';
  const tray = pill ? {
    height: '32px', borderRadius: '16px', padding: '0 12px', border: 0, boxShadow: 'none',
    background: dirty ? CZ.mintSoft : CZ.tray, color: dirty ? CZ.mint : CZ.ink, fontWeight: dirty ? 600 : 500,
  } : null;
  const close = () => setOpen(false);
  const pick = (id: string) => { onChange(id); close(); };
  return (
    <div style={{ position: 'relative', flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <button type="button" className={`dc9 cz-menu-trigger${open || dirty ? ' is-on' : ''}`} onClick={() => setOpen(!open)}
        aria-expanded={open} aria-haspopup="menu" title="Sort this list"
        style={{
          ...TRIGGER,
          ...tray,
          ...(dirty && !pill ? { background: CZ.mintSoft, color: CZ.mint, fontWeight: 600, boxShadow: '0 0 0 1px rgba(10,133,96,.28), 0 1px 2px -1px rgba(10,133,96,.12)' } : null),
        }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h18" /><path d="M6 12h12" /><path d="M10 18h4" />
        </svg>
        <span style={{ maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dirty ? label : 'Sort'}</span>
        <Chevron size={11} color={dirty ? CZ.mint : CZ.faint} dir={open ? 'up' : 'down'} />
      </button>
      {dirty ? (
        <button type="button" className="dc12" onClick={() => onChange(resetId)} style={{ height: '32px', padding: '0 8px', background: 'none', border: 0, fontSize: '12px', color: 'var(--tx-mint, #0a8560)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          Reset
        </button>
      ) : null}
      {open ? (
        <>
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={keepInView} role="menu" aria-label="Sort" className="cz-menu cz-menu--left" style={{ ...menuPanel, left: 0, width: '240px' }}>
            <div className="cz-menu-head">Sort</div>
            {options.map((o) => {
              const on = o.id === value;
              return (
                <button key={o.id} type="button" role="menuitem" className={`dc2 cz-menu-item${on ? ' is-on' : ''}`} onClick={() => pick(o.id)}>
                  <span style={{ flex: 1 }}>{o.label}</span>
                  <MenuCheck on={on} />
                </button>
              );
            })}
            {dirty ? (
              <>
                <div className="cz-menu-sep" />
                <button type="button" role="menuitem" className="dc2 cz-menu-item" onClick={() => pick(resetId)}>Reset</button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

const ARROW: React.CSSProperties = { width: '22px', height: '22px', padding: 0, border: 0, borderRadius: '6px', background: 'var(--surface, #fff)', fontSize: '11px', color: 'var(--muted, #52525b)', cursor: 'pointer', lineHeight: 1, boxShadow: SHADOW.ring };
const LINK: React.CSSProperties = { background: 'none', border: 0, padding: 0, fontSize: '11.5px', color: 'var(--c-accent)', cursor: 'pointer', fontWeight: 600 };

/** Same members, same order. */
export const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
