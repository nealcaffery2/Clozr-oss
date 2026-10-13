'use client';

// A list as a map: the Genius map (components/genius/GeniusMap) with the
// lasso on, fitted to whatever the list's filters left, and a bar that says
// what is selected. Buyers and People both use it; each decides where its rows
// sit and what a selection does.

import React, { useEffect, useMemo, useState } from 'react';
import { GeniusMap, type MapPin } from '@/components/genius/GeniusMap';
import { boundsOf, loadCentroids, type CentroidIndex } from '@/lib/geo-centroids';

const PURPLE = '#0A8560';
const US = { lat: 39.5, lng: -98.35 };

/** The centroid files, fetched once a map opens. `zips` adds the ZIP file. */
export function useCentroids(on: boolean, zips: boolean): { idx: CentroidIndex | null; failed: boolean } {
  const [idx, setIdx] = useState<CentroidIndex | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!on) return;
    let cancel = false;
    loadCentroids(zips).then((i) => { if (!cancel) { setIdx(i); setFailed(false); } }).catch(() => { if (!cancel) setFailed(true); });
    return () => { cancel = true; };
  }, [on, zips]);
  return { idx, failed };
}

export type LegendItem = { color: string; label: string; ring?: boolean };

export function MapLegend({ items }: { items: LegendItem[] }) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 12px', maxWidth: 'min(560px, calc(100vw - 120px))', background: 'rgba(255,255,255,.94)', backdropFilter: 'blur(8px)', borderRadius: '10px', padding: '7px 11px',
      boxShadow: '0 0 0 1px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.07)', fontSize: '11.5px', fontWeight: 550, color: '#3f3f46' }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
          <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: it.color, boxShadow: it.ring ? '0 0 0 1.5px #fff, 0 0 0 3px #f59e0b' : '0 0 0 1.5px #fff, 0 0 0 2.5px rgba(0,0,0,.08)' }} />{it.label}
        </span>
      ))}
    </div>
  );
}

/** The bar over the map's top-left: how many are on it, how many picked, and a way to clear them. */
export function MapStatus({ text, selected, onClear, busy }: { text: string; selected: number; onClear: () => void; busy?: string | null }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', background: 'rgba(255,255,255,.95)', backdropFilter: 'blur(8px)', borderRadius: '10px', padding: '6px 10px',
      boxShadow: '0 0 0 1px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.07)', fontSize: '12px', color: '#3f3f46', maxWidth: '100%' }}>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</span>
      {busy ? <span style={{ color: PURPLE, fontWeight: 600 }}>{busy}</span> : null}
      {selected ? (
        <>
          <span style={{ color: PURPLE, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{selected.toLocaleString('en-US')} selected</span>
          <button type="button" onClick={onClear} style={{ border: 0, background: 'none', padding: 0, color: PURPLE, fontSize: '12px', cursor: 'pointer', textDecoration: 'underline' }}>Clear</button>
        </>
      ) : <span style={{ color: '#71717a' }}>Lasso (right) to select</span>}
    </div>
  );
}

type Props = {
  pins: MapPin[];
  height: number | string;
  selected: ReadonlySet<string>;
  onLasso: (groups: string[]) => void;
  onPin: (group: string) => void;
  popup?: (group: string) => React.ReactNode;
  popupId?: string | null;
  onClosePopup?: () => void;
  noun: string;
  label: string;
  legend?: LegendItem[];
  status: React.ReactNode;
  /** Shown over the middle while there is nothing to draw yet. */
  note?: string | null;
};

export function ListMap({ pins, height, selected, onLasso, onPin, popup, popupId, onClosePopup, noun, label, legend, status, note }: Props) {
  // Fit what the filters left; the key rounds, so a new array of the same pins does not re-fit.
  const bounds = useMemo(() => boundsOf(pins), [pins]);
  return (
    <div style={{ position: 'relative', height, minHeight: 0 }}>
      <GeniusMap center={bounds ? { lat: (bounds.n + bounds.s) / 2, lng: (bounds.e + bounds.w) / 2 } : US} bounds={bounds} zoom={bounds ? 12 : 4} subject={false}
        pins={pins} height={height} selected={selected} onLasso={onLasso} onPin={onPin} popup={popup} popupId={popupId} onClosePopup={onClosePopup}
        noun={noun} countBy="group" label={label} topLeft={status}>
        {legend?.length ? <MapLegend items={legend} /> : null}
      </GeniusMap>
      {note ? (
        <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', zIndex: 7, pointerEvents: 'none', background: 'rgba(24,24,27,.86)', color: '#fff', fontSize: '12.5px', padding: '10px 14px', borderRadius: '10px', maxWidth: '80%', textAlign: 'center', lineHeight: 1.45 }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

/** A popup's buttons, the same weight as the Genius card's. */
export function PopupButton({ onClick, children, primary }: { onClick: () => void; children: React.ReactNode; primary?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      style={{ height: '28px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${primary ? PURPLE : '#e4e4e7'}`, background: primary ? PURPLE : '#fff', color: primary ? '#fff' : '#18181b', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
      {children}
    </button>
  );
}

export type ListOrMap = 'list' | 'map';

/** The view a screen was last left in, per browser: a convenience, so a blocked storage just means List. */
export function useListOrMap(key: string): [ListOrMap, (v: ListOrMap) => void] {
  const [v, setV] = useState<ListOrMap>(() => {
    try { return typeof window !== 'undefined' && window.localStorage.getItem(key) === 'map' ? 'map' : 'list'; } catch { return 'list'; }
  });
  const set = (next: ListOrMap) => {
    setV(next);
    try { window.localStorage.setItem(key, next); } catch { /* storage blocked: the choice lasts this visit */ }
  };
  return [v, set];
}

/** List | Map, the segmented switch. */
export function ListMapSwitch({ value, onChange, pill }: { value: ListOrMap; onChange: (v: ListOrMap) => void; pill?: boolean }) {
  const h = pill ? 34 : 32;
  return (
    <div role="tablist" aria-label="View as" style={{ flex: 'none', display: 'inline-flex', height: h, padding: 2, borderRadius: pill ? 999 : 10, background: '#f4f4f5', boxShadow: 'inset 0 0 0 1px #e4e4e7', boxSizing: 'border-box' }}>
      {(['list', 'map'] as const).map((k) => {
        const on = value === k;
        return (
          <button key={k} type="button" role="tab" aria-selected={on} onClick={() => onChange(k)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: h - 4, padding: '0 11px', border: 0, borderRadius: pill ? 999 : 8, cursor: 'pointer', fontSize: 12.5, fontWeight: on ? 650 : 500,
              background: on ? '#fff' : 'transparent', color: on ? '#18181b' : '#52525b', boxShadow: on ? '0 1px 2px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.04)' : 'none', fontFamily: 'inherit' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={k === 'list' ? 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' : 'M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3zM9 3v15M15 6v15'} />
            </svg>
            {k === 'list' ? 'List' : 'Map'}
          </button>
        );
      })}
    </div>
  );
}
