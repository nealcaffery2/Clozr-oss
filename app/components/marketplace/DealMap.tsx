'use client';

import 'leaflet/dist/leaflet.css';
import React, { useEffect, useRef, useState } from 'react';
import { compactMoney, type Listing } from '@/lib/marketplace-public';

type Pin = Listing & { lat: number; lng: number };
type LeafletNS = typeof import('leaflet');

const STREETS = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
/** Pins closer than this on screen merge into a numbered cluster. */
const MERGE_PX = 52;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The marketplace map: price tags for single deals, orange count bubbles
 * where deals would overlap. The open deal is never folded into a cluster.
 */
export function DealMap({ listings, selected, onSelect, satellite = false, compact = false, zoom = 11 }: {
  listings: Listing[];
  selected: string | null;
  onSelect: (id: string) => void;
  satellite?: boolean;
  compact?: boolean;
  /** Zoom on the open deal when compact. */
  zoom?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<LeafletNS | null>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const layers = useRef<{ streets: import('leaflet').TileLayer; sat: import('leaflet').TileLayer; pins: import('leaflet').LayerGroup } | null>(null);
  const fitted = useRef('');
  const [ready, setReady] = useState(false);
  const [zoomTick, setZoomTick] = useState(0);
  // Callers pass an inline arrow, so a dependency on it would clear and redraw
  // every pin on each keystroke in the search box. The ref keeps the latest.
  const selectRef = useRef(onSelect);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let cancel = false;
    let resize = 0;
    let observer: ResizeObserver | null = null;
    (async () => {
      const lib = await import('leaflet');
      if (cancel || mapRef.current) return;
      L.current = lib;
      const map = lib.map(node, { zoomControl: false, scrollWheelZoom: !compact, attributionControl: true });
      lib.control.zoom({ position: 'topright' }).addTo(map);
      const streets = lib.tileLayer(STREETS, { attribution: 'Tiles &copy; Esri', maxZoom: 19 });
      const sat = lib.tileLayer(IMAGERY, { attribution: 'Tiles &copy; Esri', maxZoom: 19 });
      streets.addTo(map);
      map.setView([34, -92], 4);
      const pins = lib.layerGroup().addTo(map);
      map.on('zoomend', () => setZoomTick((n) => n + 1));
      mapRef.current = map;
      layers.current = { streets, sat, pins };
      setReady(true);
      resize = window.setTimeout(() => { if (mapRef.current === map) map.invalidateSize(); }, 60);
      // On a phone the map starts inside a display:none pane (the list shows
      // first), so Leaflet measured 0x0: no tiles were requested and the fit
      // put every pin on one point. Re-measure whenever the box changes size,
      // and refit the first time it has a real one.
      if (typeof ResizeObserver !== 'undefined') {
        let wasEmpty = node.clientWidth === 0 || node.clientHeight === 0;
        observer = new ResizeObserver(() => {
          if (mapRef.current !== map) return;
          const empty = node.clientWidth === 0 || node.clientHeight === 0;
          if (empty) { wasEmpty = true; return; }
          map.invalidateSize();
          if (wasEmpty) { wasEmpty = false; fitted.current = ''; }
          setZoomTick((n) => n + 1);
        });
        observer.observe(node);
      }
    })();
    return () => {
      cancel = true;
      observer?.disconnect();
      window.clearTimeout(resize);
      mapRef.current?.remove();
      mapRef.current = null;
      layers.current = null;
      fitted.current = '';
      setReady(false);
    };
  }, [compact]);

  useEffect(() => {
    const map = mapRef.current;
    const ls = layers.current;
    if (!ready || !map || !ls) return;
    const [on, off] = satellite ? [ls.sat, ls.streets] : [ls.streets, ls.sat];
    if (map.hasLayer(off)) map.removeLayer(off);
    if (!map.hasLayer(on)) on.addTo(map);
  }, [satellite, ready]);

  useEffect(() => {
    const map = mapRef.current;
    const lib = L.current;
    const ls = layers.current;
    if (!ready || !map || !lib || !ls) return;
    ls.pins.clearLayers();
    const pins = listings.filter((d) => d.lat != null && d.lng != null) as Pin[];

    const key = pins.map((p) => `${p.id}:${p.lat},${p.lng}`).join('|');
    const box = map.getSize();
    if (key !== fitted.current && pins.length && box.x > 0 && box.y > 0) {
      fitted.current = key;
      const chosen = pins.find((p) => p.id === selected);
      if (compact && chosen) map.setView([chosen.lat, chosen.lng], zoom);
      else if (chosen) map.setView([chosen.lat, chosen.lng], 13);
      else if (pins.length === 1) map.setView([pins[0].lat, pins[0].lng], 12);
      else map.fitBounds(pins.map((p) => [p.lat, p.lng] as [number, number]), { padding: [56, 56], maxZoom: 12 });
    }

    const groups: { x: number; y: number; items: Pin[] }[] = [];
    for (const p of pins) {
      if (p.id === selected) { groups.push({ x: NaN, y: NaN, items: [p] }); continue; }
      const pt = map.latLngToContainerPoint([p.lat, p.lng]);
      const near = groups.find((g) => Number.isFinite(g.x) && Math.hypot(g.x - pt.x, g.y - pt.y) < MERGE_PX);
      if (near) {
        near.items.push(p);
        near.x += (pt.x - near.x) / near.items.length;
        near.y += (pt.y - near.y) / near.items.length;
      } else groups.push({ x: pt.x, y: pt.y, items: [p] });
    }

    for (const g of groups) {
      if (g.items.length === 1) {
        const d = g.items[0];
        const on = d.id === selected;
        const label = compactMoney(d.price) ?? 'Ask';
        const icon = lib.divIcon({
          className: 'mk-pin-wrap',
          html: `<span class="mk-pin${on ? ' is-on' : ''}${d.status === 'Sale Pending' ? ' is-pending' : ''}"><span>${esc(label)}</span></span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        });
        const m = lib.marker([d.lat, d.lng], { icon, zIndexOffset: on ? 1000 : 0, keyboard: true, title: d.locked ? `${d.city}, ${d.state}` : d.address });
        m.on('click', () => selectRef.current(d.id));
        m.addTo(ls.pins);
      } else {
        const center = map.containerPointToLatLng([g.x, g.y]);
        const n = g.items.length;
        const size = n >= 100 ? 44 : n >= 10 ? 38 : 34;
        const icon = lib.divIcon({
          className: 'mk-pin-wrap',
          html: `<span class="mk-cluster" style="width:${size}px;height:${size}px"><span>${n}</span></span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        });
        const m = lib.marker(center, { icon, keyboard: true, title: `${n} deals` });
        m.on('click', () => map.fitBounds(g.items.map((p) => [p.lat, p.lng] as [number, number]), { padding: [72, 72], maxZoom: Math.min(16, map.getZoom() + 3) }));
        m.addTo(ls.pins);
      }
    }
  }, [listings, selected, ready, zoomTick, compact, zoom]);

  const focus = listings.find((d) => d.id === selected);
  const focusKey = focus && focus.lat != null && focus.lng != null ? `${focus.lat},${focus.lng}` : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focusKey || compact) return;
    const [lat, lng] = focusKey.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) map.flyTo([lat, lng], Math.min(14, Math.max(map.getZoom(), 12)), { duration: 0.5 });
  }, [focusKey, ready, compact]);

  return <div ref={el} className="mk-map-canvas" />;
}
