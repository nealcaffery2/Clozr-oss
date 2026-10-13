'use client';

// People › Map: the list's rows where their houses are, coloured by stage.
// A geocoded property is pinned at its own point; one that is not yet is
// placed at its town or ZIP and says so. The lasso selects into the list's
// selection, so the bulk bar (text, email, tag, call queue, plans) acts on
// what was drawn.

import React, { useMemo, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import type { MapPin } from '@/components/genius/GeniusMap';
import { ListMap, MapStatus, PopupButton, useCentroids, type LegendItem } from '@/components/ListMap';
import { fanOut, locate } from '@/lib/geo-centroids';
import { resolveMarket } from '@/lib/market-geo';

const GROUP_LABEL: Record<string, string> = {
  lead: 'Lead', working: 'Working', offer: 'Offer', contract: 'Under contract', closed: 'Closed',
  dead: 'Dead', refund: 'Refund', referral: 'Referral',
};
const NO_GAZ = { city: new Map<string, string>() };

export function PeopleMap({ V, height }: { V: ClozrView; height: number | string }) {
  const m = V.peopleMap;
  // Rebuilt when the filtered list is, not on every render (the getter maps every row).
  const rows = useMemo(() => m.rows, [V.peopleRows]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only rows without a point need the centroid files.
  const needPlaces = useMemo(() => rows.some((r) => r.lat == null), [rows]);
  const needZips = useMemo(() => rows.some((r) => r.lat == null && !r.city && /^\d{5}/.test(r.zip)), [rows]);
  const { idx, failed } = useCentroids(needPlaces, needZips);
  const [pop, setPop] = useState<string | null>(null);

  const { pins, approx, unplaced, legend } = useMemo(() => {
    const out: MapPin[] = [];
    let approx = 0; let unplaced = 0;
    const seen = new Map<string, string>();
    for (const r of rows) {
      let at: { lat: number; lng: number } | null = r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null;
      let where = '';
      if (!at && idx) {
        const token = r.city && r.st ? `${r.city}, ${r.st}` : r.zip;
        const hit = token ? locate(resolveMarket(token, NO_GAZ), idx) : null;
        if (hit) { at = hit; where = ` · placed at ${hit.precision === 'zip' ? 'its ZIP' : 'its town'}`; approx += 1; }
      }
      if (!at) { unplaced += 1; continue; }
      const label = GROUP_LABEL[r.group] ?? r.stage;
      if (!seen.has(r.color)) seen.set(r.color, label);
      out.push({ id: r.id, group: r.id, lat: at.lat, lng: at.lng, color: r.color, title: `${r.name} · ${r.addr || 'No address'} · ${r.stage}${where}` });
    }
    const legend: LegendItem[] = [...seen.entries()].slice(0, 8).map(([color, label]) => ({ color, label }));
    return { pins: fanOut(out), approx, unplaced, legend };
  }, [rows, idx]);

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const selected = useMemo(() => new Set(Object.keys(m.selected).filter((k) => m.selected[k] && byId.has(k))), [m.selected, byId]);

  const popup = (id: string) => {
    const r = byId.get(id);
    if (!r) return null;
    const on = !!m.selected[id];
    return (
      <div style={{ display: 'grid', gap: '8px', paddingRight: '18px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: '13px', color: '#18181b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
          <div style={{ fontSize: '11.5px', color: '#71717a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[r.addr, r.city, r.st].filter(Boolean).join(', ') || 'No address'}</div>
        </div>
        <div style={{ fontSize: '11.5px', color: '#3f3f46', lineHeight: 1.45 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: r.color, marginRight: 6 }} />{r.stage}
          {r.offer ? <span style={{ color: '#71717a' }}> · offer {r.offer}</span> : null}
          {r.lat == null ? <span style={{ color: '#b45309' }}> · pinned at its town, not the house</span> : null}
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <PopupButton primary={!on} onClick={() => m.toggle(id)}>{on ? 'Unselect' : 'Select'}</PopupButton>
          <PopupButton onClick={r.open}>Open</PopupButton>
        </div>
      </div>
    );
  };

  const note = failed ? 'The map data did not load. Check the connection and switch back to Map.'
    : needPlaces && !idx && !pins.length ? 'Placing people…'
    : !pins.length ? (rows.length ? 'None of these has an address we can place yet.' : 'Nobody matches these filters.')
    : null;
  const text = `${(pins.length).toLocaleString('en-US')} on the map${approx ? ` · ${approx.toLocaleString('en-US')} by town` : ''}${unplaced ? ` · ${unplaced.toLocaleString('en-US')} without an address` : ''}`;
  return (
    <ListMap pins={pins} height={height} selected={selected} noun="people" label="Map of people by property"
      onLasso={(ids) => { m.select(ids); setPop(null); }}
      onPin={setPop} popup={popup} popupId={pop} onClosePopup={() => setPop(null)} legend={legend} note={note}
      status={<MapStatus text={text} selected={selected.size} onClear={m.clear} />} />
  );
}
