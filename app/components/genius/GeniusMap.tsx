// The Genius Mode map, with no map library.
//
// Raster tiles are plain <img> tags, which the CSP already allows (img-src
// https:), so there is no script to load and nothing new in the bundle. With
// NEXT_PUBLIC_MAPBOX_TOKEN set the tiles are Mapbox's light style; without it,
// OpenStreetMap's tiles pushed to a quiet grey canvas with a CSS filter, so the
// basemap recedes and the buyers are what you see (attribution shown; set the
// token before heavy use, per OSM's tile policy).
//
// What it does, and why each is the way it is:
//  - Pins are dots with a white ring and a soft layered shadow, coloured by
//    buyer type; SmartMatch buyers carry a gold ring. The buyer the list is
//    hovering lifts (transform only) and all of their purchases light up.
//  - Below zoom 16 nearby pins fold into a donut whose ring shows the mix of
//    flippers, landlords and builders inside it. Click to zoom into it.
//  - Zoom animates toward the cursor in 220ms with a strong ease-out, then the
//    sharp tiles replace the scaled ones. Reduced motion skips the animation.
//  - Ctrl/⌘ + scroll (and trackpad pinch) zooms; a plain scroll says so rather
//    than hijacking the page. Arrow keys pan, + and − zoom, Esc closes the card.
//  - With onLasso, a lasso tool draws a free shape and reports every pin inside
//    it, clustered or not; selected pins wear a purple ring. A pin with a
//    weight (a realtor market: 8,210 agents in Phoenix) is a bubble showing the
//    count, and clusters add weights rather than pins.
'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { insidePolygon } from '@/lib/geo-centroids';

/** One pin. `group` ties several pins to one buyer: hovering the buyer lights all of them, a click reports the group. */
export type MapPin = { id: string; group?: string; lat: number; lng: number; color: string; ring?: boolean; title?: string; weight?: number };

const MAPBOX = (process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '').trim();
const osmTile = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const tileUrl = (z: number, x: number, y: number) => MAPBOX
  ? `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/256/${z}/${x}/${y}?access_token=${encodeURIComponent(MAPBOX)}`
  : osmTile(z, x, y);
/**
 * A Mapbox tile that fails (a revoked or URL-restricted token answers 401/403)
 * is swapped for the OpenStreetMap tile, once, so a bad token greys the map
 * instead of blanking it. A failed OSM tile is left alone.
 */
const tileFallback = (z: number, x: number, y: number) => (e: React.SyntheticEvent<HTMLImageElement>) => {
  const img = e.currentTarget;
  if (!MAPBOX || img.dataset.fallback) return;
  img.dataset.fallback = '1';
  img.src = osmTile(z, x, y);
};

type Props = {
  center: { lat: number; lng: number };
  radiusMi?: number | null;
  pins: MapPin[];
  activeId?: string | null;
  height: number | string;
  onPin?: (id: string) => void;
  onHover?: (id: string | null) => void;
  popup?: (id: string) => React.ReactNode;
  popupId?: string | null;
  onClosePopup?: () => void;
  /** Draw the subject marker at the centre (default). Off for a plain area view before anything is searched. */
  subject?: boolean;
  /** The zoom to open at when there is no radius to fit. */
  zoom?: number;
  /** Rendered over the map's bottom-left corner (the legend). */
  children?: React.ReactNode;
  /** Fit these instead of a radius, when there is no subject to centre on. */
  bounds?: { n: number; s: number; e: number; w: number } | null;
  /** Groups to draw as selected. */
  selected?: ReadonlySet<string>;
  /** Turns on the lasso tool; called with every group inside the shape drawn. */
  onLasso?: (groups: string[]) => void;
  /** What a cluster holds, for its label: purchases by default. */
  noun?: string;
  /** Count a cluster's pins (a buyer's purchases) or its groups (buyers, one pin per market each). */
  countBy?: 'pin' | 'group';
  /** Rendered over the map's top-left corner (a selection bar). */
  topLeft?: React.ReactNode;
  label?: string;
};

const TILE = 256;
const MINZ = 3; const MAXZ = 18;
const ZOOM_MS = 220;
const PURPLE = '#0A8560';

const worldPx = (lat: number, lng: number, z: number) => {
  const s = TILE * 2 ** z;
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return { x: ((lng + 180) / 360) * s, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s };
};
const toLatLng = (x: number, y: number, z: number) => {
  const s = TILE * 2 ** z;
  const lng = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng };
};
const metersPerPx = (lat: number, z: number) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/**
 * The view after zooming by dz (rounded to a whole level), keeping the world
 * point under (fx, fy) in the box where it is. Null when already at the limit.
 */
function zoomed(base: { lat: number; lng: number; z: number }, dz: number, fx: number, fy: number, size: { w: number; h: number }) {
  const z = Math.max(MINZ, Math.min(MAXZ, base.z + Math.round(dz)));
  if (z === base.z) return null;
  const k = 2 ** (z - base.z);
  const cw = worldPx(base.lat, base.lng, base.z);
  const wx = cw.x - size.w / 2 + fx; const wy = cw.y - size.h / 2 + fy;
  return { ...toLatLng(wx * k - fx + size.w / 2, wy * k - fy + size.h / 2, z), z };
}

/** The zoom that fits a box of points, at most street level so one pin is not a rooftop. */
function fitBoundsView(b: { n: number; s: number; e: number; w: number }, w: number, h: number, cap: number) {
  let z = MINZ;
  for (let k = Math.min(cap, MAXZ); k >= MINZ; k--) {
    const a = worldPx(b.n, b.w, k); const c = worldPx(b.s, b.e, k);
    if (Math.abs(c.x - a.x) <= w - 72 && Math.abs(c.y - a.y) <= h - 72) { z = k; break; }
  }
  const a = worldPx(b.n, b.w, z); const c = worldPx(b.s, b.e, z);
  return { ...toLatLng((a.x + c.x) / 2, (a.y + c.y) / 2, z), z };
}

/** 8210 → "8.2k"; 31000 → "31k". A bubble has room for four characters. */
const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
const bubble = (n: number) => (n >= 1000 ? 46 : n >= 100 ? 42 : n >= 25 ? 38 : n >= 8 ? 34 : 29);

/** The zoom that fits the search radius in the box. */
function fitZoom(lat: number, radiusMi: number, w: number, h: number) {
  const r = radiusMi * 1609.34;
  for (let z = MAXZ; z >= MINZ; z--) if (r / metersPerPx(lat, z) <= Math.min(w, h) / 2 - 24) return z;
  return MINZ;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A cluster's ring: one arc per buyer type, in proportion. */
function donut(pins: MapPin[]): string {
  const counts = new Map<string, number>();
  let total = 0;
  for (const p of pins) { const w = p.weight ?? 1; counts.set(p.color, (counts.get(p.color) ?? 0) + w); total += w; }
  let at = 0;
  const stops = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([color, n]) => {
    const from = at; at += (n / total) * 360;
    return `${color} ${from}deg ${at}deg`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

// Hover, press, focus and entrance can't be inline styles, so the map carries
// its own small sheet, scoped by the gm- prefix.
const CSS = `
.gm-root{position:relative;overflow:hidden;background:#f1f1f3;touch-action:none;user-select:none;outline:none;isolation:isolate}
.gm-root:focus-visible{box-shadow:inset 0 0 0 2px ${PURPLE}}
.gm-root.gm-full{position:fixed!important;inset:0;z-index:80;height:auto!important}
.gm-tiles{position:absolute;inset:0;${MAPBOX ? '' : 'filter:grayscale(1) contrast(.86) brightness(1.07);'}}
.gm-tile{position:absolute;width:256px;height:256px;pointer-events:none;animation:gm-fade 180ms ease-out both}
@keyframes gm-fade{from{opacity:0}to{opacity:1}}
.gm-pin{position:absolute;padding:0;border-radius:50%;cursor:pointer;border:2px solid var(--surface, #fff);min-height:0;min-width:0;
  box-shadow:0 0 0 1px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.10);
  transition:transform 150ms cubic-bezier(.23,1,.32,1),box-shadow 150ms ease}
.gm-pin.gm-on{transform:scale(1.45);box-shadow:0 0 0 1px rgba(0,0,0,.08),0 2px 4px rgba(0,0,0,.2),0 6px 16px rgba(0,0,0,.18)}
.gm-pin.gm-smart{box-shadow:0 0 0 1.5px #f59e0b,0 1px 2px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.10)}
.gm-pin.gm-smart.gm-on{box-shadow:0 0 0 1.5px #f59e0b,0 2px 4px rgba(0,0,0,.2),0 6px 16px rgba(0,0,0,.18)}
.gm-pin.gm-sel,.gm-pin.gm-sel.gm-smart{box-shadow:0 0 0 2.5px ${PURPLE},0 1px 2px rgba(0,0,0,.18),0 2px 8px rgba(10,133,96,.35)}
.gm-cluster.gm-sel{box-shadow:0 0 0 2.5px ${PURPLE},0 1px 2px rgba(0,0,0,.14),0 4px 12px rgba(10,133,96,.28)}
.gm-lasso .gm-pin,.gm-lasso .gm-cluster{pointer-events:none}
.gm-btn.gm-btn-on{background:${PURPLE};color:var(--on-dark, #fff)}
.gm-cluster{position:absolute;display:grid;place-items:center;border-radius:50%;padding:0;border:0;cursor:pointer;min-height:0;min-width:0;
  box-shadow:0 1px 2px rgba(0,0,0,.14),0 4px 12px rgba(0,0,0,.10);transition:transform 150ms cubic-bezier(.23,1,.32,1)}
.gm-cluster>span{display:grid;place-items:center;border-radius:50%;background:var(--surface, #fff);color:var(--ink, #18181b);font:700 11.5px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums}
.gm-btn{display:grid;place-items:center;width:32px;height:32px;border:0;background:var(--surface, #fff);color:var(--ink-2, #27272a);cursor:pointer;transition:background 120ms ease,transform 120ms cubic-bezier(.23,1,.32,1)}
.gm-btn:active{transform:scale(.94)}
.gm-group{display:flex;flex-direction:column;background:var(--surface, #fff);border-radius:10px;overflow:hidden;
  box-shadow:0 0 0 1px rgba(0,0,0,.07),0 1px 2px rgba(0,0,0,.06),0 4px 12px rgba(0,0,0,.07)}
.gm-group>.gm-btn+.gm-btn{border-top:1px solid var(--divider-2, #f0f0f1)}
.gm-pin:focus-visible,.gm-cluster:focus-visible,.gm-btn:focus-visible{outline:2px solid ${PURPLE};outline-offset:2px}
/* A 12px dot is too small for a finger: the tap target reaches 10px past it. */
@media (pointer:coarse){.gm-pin::before{content:'';position:absolute;inset:-10px;border-radius:50%}.gm-btn{width:40px;height:40px}}
@media (hover:hover) and (pointer:fine){
  .gm-pin:hover{transform:scale(1.3)}
  .gm-pin.gm-on:hover{transform:scale(1.45)}
  .gm-cluster:hover{transform:scale(1.07)}
  .gm-btn:not(.gm-btn-on):hover{background:var(--surface-2, #f4f4f5)}
}
.gm-card{position:absolute;width:264px;z-index:9;background:var(--surface, #fff);border-radius:12px;padding:12px 13px;cursor:default;transform:var(--gm-from);
  box-shadow:0 0 0 1px rgba(0,0,0,.06),0 2px 4px rgba(0,0,0,.05),0 12px 32px rgba(0,0,0,.14);
  animation:gm-pop 160ms cubic-bezier(.23,1,.32,1) both}
@keyframes gm-pop{from{opacity:0;transform:var(--gm-from) scale(.96)}to{opacity:1;transform:var(--gm-from) scale(1)}}
.gm-tip{position:absolute;z-index:7;pointer-events:none;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;
  background:var(--ink, #18181b);color:var(--surface, #fff);font:500 11.5px/1.35 system-ui,sans-serif;padding:5px 8px;border-radius:7px;box-shadow:0 4px 12px rgba(0,0,0,.18);transform:translate(-50%,calc(-100% - 10px))}
.gm-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:8;pointer-events:none;background:rgba(24,24,27,.86);color:#fff;
  font:500 12.5px/1 system-ui,sans-serif;padding:10px 14px;border-radius:10px;animation:gm-fade 120ms ease-out both}
@media (prefers-reduced-motion:reduce){.gm-tile,.gm-card,.gm-hint{animation:none}.gm-pin,.gm-cluster,.gm-btn{transition:none}}
`;

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  target: 'M12 2v3M12 19v3M2 12h3M19 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  shrink: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
};

export function GeniusMap({ center, radiusMi, pins, activeId, height, onPin, onHover, popup, popupId, onClosePopup, subject = true, zoom: startZoom, children, bounds, selected, onLasso, noun = 'purchases', countBy = 'pin', topLeft, label }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400, measured: false });
  const [view, setView] = useState<{ lat: number; lng: number; z: number } | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [anim, setAnim] = useState<{ scale: number; ox: number; oy: number } | null>(null);
  // Two fingers down: the layer scales live, and lifting them settles on the nearest zoom level.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const [pinch, setPinch] = useState<{ d0: number; ox: number; oy: number; k: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [hint, setHint] = useState(false);
  const [full, setFull] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The lasso: on while the tool is picked; the shape is screen pixels while a finger or the mouse is down.
  const [lassoOn, setLassoOn] = useState(false);
  const [shape, setShape] = useState<{ x: number; y: number }[] | null>(null);
  const shapeRef = useRef<{ x: number; y: number }[] | null>(null);

  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const read = () => setSize({ w: el.clientWidth || 600, h: el.clientHeight || 400, measured: el.clientWidth > 0 && el.clientHeight > 0 });
    read();
    const ro = new ResizeObserver(read); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitTo = useCallback(() => (!radiusMi && bounds ? fitBoundsView(bounds, size.w, size.h, startZoom ?? 12) : {
    lat: center.lat, lng: center.lng,
    z: !radiusMi && startZoom ? startZoom : fitZoom(center.lat, radiusMi || 2, size.w, size.h),
  }), [center.lat, center.lng, radiusMi, startZoom, size.w, size.h, bounds]);

  // A new subject or radius re-centres; panning around the same one does not.
  const fitKey = `${center.lat.toFixed(5)},${center.lng.toFixed(5)},${radiusMi ?? ''}${bounds ? `,${bounds.n.toFixed(3)},${bounds.s.toFixed(3)},${bounds.e.toFixed(3)},${bounds.w.toFixed(3)}` : ''}`;
  const fitted = useRef('');
  useEffect(() => {
    if (fitted.current === fitKey || !size.measured) return;
    fitted.current = fitKey;
    setView(fitTo());
  }, [fitKey, size.measured, fitTo]);

  const v = view ?? { lat: center.lat, lng: center.lng, z: 13 };
  const c = worldPx(v.lat, v.lng, v.z);
  const ox = c.x - size.w / 2; const oy = c.y - size.h / 2;
  const at = (lat: number, lng: number) => { const p = worldPx(lat, lng, v.z); return { x: p.x - ox, y: p.y - oy }; };

  const tiles = useMemo(() => {
    const out: { key: string; x: number; y: number; src: string; onError: (e: React.SyntheticEvent<HTMLImageElement>) => void }[] = [];
    const n = 2 ** v.z;
    const x0 = Math.floor(ox / TILE); const x1 = Math.floor((ox + size.w) / TILE);
    const y0 = Math.max(0, Math.floor(oy / TILE)); const y1 = Math.min(n - 1, Math.floor((oy + size.h) / TILE));
    for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
      const wx = ((tx % n) + n) % n;
      out.push({ key: `${v.z}/${tx}/${ty}`, x: tx * TILE - ox, y: ty * TILE - oy, src: tileUrl(v.z, wx, ty), onError: tileFallback(v.z, wx, ty) });
    }
    return out;
  }, [v.z, ox, oy, size.w, size.h]);

  // Clusters: only pins that would actually collide (within 22px of a
  // cluster's centre) fold together, and only below zoom 16. A grid would put a
  // bubble on every block; this keeps singles as dots and merges real piles.
  const groups = useMemo(() => {
    const R = 22;
    const solo: MapPin[] = [];
    const piles: { x: number; y: number; pins: MapPin[] }[] = [];
    for (const p of pins) {
      if ((p.group ?? p.id) === activeId || v.z >= 16) { solo.push(p); continue; }
      const q = worldPx(p.lat, p.lng, v.z);
      const hit = piles.find((c) => Math.abs(c.x - q.x) < R && Math.abs(c.y - q.y) < R);
      if (hit) {
        hit.pins.push(p);
        hit.x += (q.x - hit.x) / hit.pins.length; hit.y += (q.y - hit.y) / hit.pins.length;
      } else piles.push({ x: q.x, y: q.y, pins: [p] });
    }
    const clusters: { key: string; lat: number; lng: number; pins: MapPin[]; n: number }[] = [];
    for (const c of piles) {
      // Two weighted bubbles that touch fold too: they would overlap otherwise.
      if (c.pins.length < 3 && !(c.pins.length === 2 && c.pins.some((p) => (p.weight ?? 1) > 1))) { solo.push(...c.pins); continue; }
      const ll = toLatLng(c.x, c.y, v.z);
      const n = c.pins.some((p) => p.weight != null) ? c.pins.reduce((t, p) => t + (p.weight ?? 1), 0)
        : countBy === 'group' ? new Set(c.pins.map((p) => p.group ?? p.id)).size : c.pins.length;
      clusters.push({ key: c.pins[0].id, lat: ll.lat, lng: ll.lng, pins: c.pins, n });
    }
    return { solo, clusters };
  }, [pins, activeId, v.z, countBy]);

  /**
   * Zoom by dz, keeping the point under `focus` (px within the box) where it is.
   * The current layer scales toward the new zoom first, then the sharp tiles
   * for the new zoom take its place.
   */
  const zoomBy = useCallback((dz: number, focus?: { x: number; y: number }) => {
    if (anim) return;
    const base = view ?? { lat: center.lat, lng: center.lng, z: 13 };
    const next = zoomed(base, dz, focus?.x ?? size.w / 2, focus?.y ?? size.h / 2, size);
    if (!next) return;
    const k = 2 ** (next.z - base.z);
    const fx = focus?.x ?? size.w / 2; const fy = focus?.y ?? size.h / 2;
    if (reducedMotion()) { setView(next); return; }
    setAnim({ scale: k, ox: fx, oy: fy });
    setTimeout(() => { setView(next); setAnim(null); }, ZOOM_MS);
  }, [anim, view, center.lat, center.lng, size]);

  // Ctrl/⌘ + wheel and trackpad pinch (which arrives as ctrl + wheel) zoom at
  // the cursor. A plain wheel is the page's, and a hint says how to zoom.
  // React's onWheel is passive, so this is a native listener.
  useEffect(() => {
    const el = box.current; if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) {
        if (hintTimer.current) clearTimeout(hintTimer.current);
        setHint(true);
        hintTimer.current = setTimeout(() => setHint(false), 1100);
        return;
      }
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < 60) return;
      const r = el.getBoundingClientRect();
      zoomBy(acc < 0 ? 1 : -1, { x: e.clientX - r.left, y: e.clientY - r.top });
      acc = 0;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const pan = (dx: number, dy: number) => { const ll = toLatLng(c.x + dx, c.y + dy, v.z); setView({ ...ll, z: v.z }); };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement) !== box.current) return;
    const step = 80;
    if (e.key === 'ArrowLeft') pan(-step, 0);
    else if (e.key === 'ArrowRight') pan(step, 0);
    else if (e.key === 'ArrowUp') pan(0, -step);
    else if (e.key === 'ArrowDown') pan(0, step);
    else if (e.key === '+' || e.key === '=') zoomBy(1);
    else if (e.key === '-' || e.key === '_') zoomBy(-1);
    else if (e.key === 'Escape') { if (popupId) onClosePopup?.(); else if (lassoOn) setLassoOn(false); else if (full) setFull(false); }
    else return;
    e.preventDefault();
  };

  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [full]);

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(lassoOn ? '[data-ui]' : '[data-pin],[data-ui]')) return;
    const r = box.current!.getBoundingClientRect();
    touches.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    if (lassoOn && touches.current.size === 1) {
      shapeRef.current = [{ x: e.clientX - r.left, y: e.clientY - r.top }];
      setShape(shapeRef.current); setTip(null);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      // A second finger means pinch, not a lasso.
      shapeRef.current = null; setShape(null);
      drag.current = null; setTip(null);
      setPinch({ d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), ox: (a.x + b.x) / 2, oy: (a.y + b.y) / 2, k: 1 });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y, moved: false };
    setGrabbing(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (touches.current.has(e.pointerId)) {
      const r = box.current!.getBoundingClientRect();
      touches.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    }
    if (pinch && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()];
      const k = Math.max(0.25, Math.min(8, Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
      setPinch({ ...pinch, k });
      return;
    }
    const sh = shapeRef.current;
    if (sh) {
      const r = box.current!.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      const last = sh[sh.length - 1];
      if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 4) { shapeRef.current = [...sh, p]; setShape(shapeRef.current); }
      return;
    }
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.x; const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { d.moved = true; setTip(null); }
    const ll = toLatLng(d.cx - dx, d.cy - dy, v.z);
    setView({ ...ll, z: v.z });
  };
  const onUp = (e: React.PointerEvent) => {
    touches.current.delete(e.pointerId);
    const sh = shapeRef.current;
    if (sh) {
      shapeRef.current = null; setShape(null);
      if (sh.length < 3 || !onLasso) return;
      // Every pin, clustered or not, so a lasso round a "42" bubble takes all 42.
      const hit = new Set<string>();
      for (const p of pins) {
        const q = at(p.lat, p.lng);
        if (insidePolygon(q.x, q.y, sh)) hit.add(p.group ?? p.id);
      }
      onLasso([...hit]);
      return;
    }
    if (pinch) {
      if (touches.current.size) return; // wait for the second finger
      const next = zoomed(v, Math.round(Math.log2(pinch.k)), pinch.ox, pinch.oy, size);
      if (next) setView(next);
      setPinch(null); drag.current = null; setGrabbing(false);
      return;
    }
    if (drag.current && !drag.current.moved) onClosePopup?.();
    drag.current = null; setGrabbing(false);
  };

  const subj = at(center.lat, center.lng);
  const rpx = radiusMi ? (radiusMi * 1609.34) / metersPerPx(center.lat, v.z) : 0;
  const pop = popupId ? pins.find((p) => (p.group ?? p.id) === popupId) : null;
  const popAt = pop ? at(pop.lat, pop.lng) : null;
  const above = popAt ? popAt.y > 210 : true;

  const layerStyle: React.CSSProperties = pinch
    ? { position: 'absolute', inset: 0, transformOrigin: `${pinch.ox}px ${pinch.oy}px`, transform: `scale(${pinch.k})` }
    : anim
    ? { position: 'absolute', inset: 0, transformOrigin: `${anim.ox}px ${anim.oy}px`, transform: `scale(${anim.scale})`, transition: `transform ${ZOOM_MS}ms cubic-bezier(0.23, 1, 0.32, 1)` }
    : { position: 'absolute', inset: 0 };

  return (
    <div ref={box} className={`gm-root${full ? ' gm-full' : ''}${lassoOn ? ' gm-lasso' : ''}`} tabIndex={0}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}
      onDoubleClick={(e) => { if (!lassoOn && !(e.target as HTMLElement).closest('[data-pin],[data-ui]')) { const r = box.current!.getBoundingClientRect(); zoomBy(1, { x: e.clientX - r.left, y: e.clientY - r.top }); } }}
      style={{ height, cursor: lassoOn ? 'crosshair' : grabbing ? 'grabbing' : 'grab' }}
      role="application" aria-label={`${label ?? 'Map of investor purchases'}. Arrow keys pan, plus and minus zoom.`}>
      <style>{CSS}</style>

      <div style={layerStyle}>
        <div className="gm-tiles">
          {tiles.map((t) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={t.key} className="gm-tile" src={t.src} onError={t.onError} alt="" draggable={false} width={TILE} height={TILE} style={{ left: t.x, top: t.y }} />
          ))}
        </div>

        {rpx > 0 ? (
          <>
            <div style={{ position: 'absolute', left: subj.x - rpx, top: subj.y - rpx, width: rpx * 2, height: rpx * 2, borderRadius: '50%', pointerEvents: 'none',
              border: `1.5px solid ${PURPLE}66`, background: `radial-gradient(circle, ${PURPLE}00 55%, ${PURPLE}12 100%)` }} />
            {rpx > 40 && subject ? (
              <div style={{ position: 'absolute', left: subj.x, top: subj.y - rpx, transform: 'translate(-50%, -50%)', pointerEvents: 'none', background: 'var(--surface, #fff)', color: PURPLE,
                font: '700 11px/1 system-ui, sans-serif', padding: '4px 7px', borderRadius: '999px', boxShadow: `0 0 0 1px ${PURPLE}33, 0 1px 3px rgba(0,0,0,.1)` }}>{radiusMi} mi</div>
            ) : null}
          </>
        ) : null}

        {groups.clusters.map((g) => {
          const p = at(g.lat, g.lng); const n = g.n;
          const d = bubble(n);
          const picked = selected ? new Set(g.pins.filter((x) => selected.has(x.group ?? x.id)).map((x) => x.group ?? x.id)).size : 0;
          return (
            <button key={g.key} type="button" data-pin className={`gm-cluster${picked ? ' gm-sel' : ''}`} onClick={() => zoomBy(2, p)} aria-label={`${n.toLocaleString('en-US')} ${noun} here, zoom in`}
              onMouseEnter={() => setTip({ x: p.x, y: p.y - d / 2 + 4, text: `${n.toLocaleString('en-US')} ${noun}${picked ? ` · ${picked} selected` : ''} · click to zoom in` })} onMouseLeave={() => setTip(null)}
              style={{ left: p.x - d / 2, top: p.y - d / 2, width: d, height: d, background: donut(g.pins), zIndex: 2 }}>
              <span style={{ width: d - 8, height: d - 8 }}>{compact(n)}</span>
            </button>
          );
        })}

        {groups.solo.map((pin) => {
          const g = pin.group ?? pin.id;
          const p = at(pin.lat, pin.lng); const on = g === activeId; const d = 12;
          if (p.x < -20 || p.y < -20 || p.x > size.w + 20 || p.y > size.h + 20) return null;
          const sel = !!selected?.has(g);
          if ((pin.weight ?? 1) > 1) {
            const n = pin.weight ?? 1; const b = bubble(n);
            return (
              <button key={pin.id} type="button" data-pin className={`gm-cluster${sel ? ' gm-sel' : ''}`} aria-label={pin.title} onClick={() => onPin?.(g)}
                onMouseEnter={() => { onHover?.(g); if (pin.title) setTip({ x: p.x, y: p.y - b / 2 + 4, text: pin.title }); }}
                onMouseLeave={() => { onHover?.(null); setTip(null); }}
                style={{ left: p.x - b / 2, top: p.y - b / 2, width: b, height: b, background: pin.color, zIndex: on ? 4 : 3 }}>
                <span style={{ width: b - 8, height: b - 8 }}>{compact(n)}</span>
              </button>
            );
          }
          return (
            <button key={pin.id} type="button" data-pin className={`gm-pin${on ? ' gm-on' : ''}${pin.ring ? ' gm-smart' : ''}${sel ? ' gm-sel' : ''}`} aria-label={pin.title}
              onClick={() => onPin?.(g)}
              onMouseEnter={() => { onHover?.(g); if (pin.title) setTip({ x: p.x, y: p.y - 4, text: pin.title }); }}
              onMouseLeave={() => { onHover?.(null); setTip(null); }}
              onFocus={() => onHover?.(g)} onBlur={() => onHover?.(null)}
              style={{ left: p.x - d / 2, top: p.y - d / 2, width: d, height: d, background: pin.color, zIndex: on ? 4 : 3 }} />
          );
        })}

        {subject ? (
          <div aria-hidden="true" style={{ position: 'absolute', left: subj.x, top: subj.y, zIndex: 5, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', left: -22, top: -22, width: 44, height: 44, borderRadius: '50%', background: `${PURPLE}1f`, boxShadow: `0 0 0 1px ${PURPLE}26` }} />
            <div style={{ position: 'absolute', left: -15, top: -15, width: 30, height: 30, borderRadius: '10px', background: PURPLE, display: 'grid', placeItems: 'center',
              boxShadow: '0 0 0 2.5px var(--surface, #fff), 0 2px 4px rgba(0,0,0,.18), 0 8px 18px rgba(8,105,76,.35)' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9v11h14V9" /><path d="M10 20v-6h4v6" /></svg>
            </div>
          </div>
        ) : null}
      </div>

      {shape && shape.length > 1 ? (
        <svg aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 8, pointerEvents: 'none' }}>
          <polygon points={shape.map((q) => `${q.x},${q.y}`).join(' ')} fill={`${PURPLE}1a`} stroke={PURPLE} strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" />
        </svg>
      ) : null}

      {tip && !anim && !pinch && !grabbing && !popupId && !lassoOn ? <div className="gm-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div> : null}

      {pop && popAt && popup && !anim && !pinch ? (
        <div data-ui className="gm-card" onPointerDown={(e) => e.stopPropagation()}
          style={{
            left: Math.min(Math.max(8, popAt.x - 132), size.w - 272), top: above ? popAt.y - 16 : popAt.y + 16,
            ['--gm-from' as string]: above ? 'translateY(-100%)' : 'translateY(0)',
            transformOrigin: `${Math.min(Math.max(12, popAt.x - Math.min(Math.max(8, popAt.x - 132), size.w - 272)), 252)}px ${above ? '100%' : '0'}`,
          } as React.CSSProperties}>
          <span aria-hidden="true" style={{ position: 'absolute', left: Math.min(Math.max(12, popAt.x - Math.min(Math.max(8, popAt.x - 132), size.w - 272)), 252) - 6, [above ? 'bottom' : 'top']: -6,
            width: 12, height: 12, background: 'var(--surface, #fff)', transform: 'rotate(45deg)', boxShadow: above ? '2px 2px 0 0 rgba(0,0,0,.04)' : '-1px -1px 0 0 rgba(0,0,0,.06)' }} />
          <button type="button" className="gm-btn" onClick={onClosePopup} aria-label="Close" style={{ position: 'absolute', right: 4, top: 4, width: 24, height: 24, borderRadius: 6, color: 'var(--subtle, #a1a1aa)' }}>
            <Icon d="M6 6l12 12M18 6 6 18" size={13} />
          </button>
          <div style={{ position: 'relative' }}>{popup(pop.group ?? pop.id)}</div>
        </div>
      ) : null}

      {hint ? <div className="gm-hint">Hold {typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'} and scroll to zoom</div> : null}

      <div data-ui style={{ position: 'absolute', right: 12, top: 12, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 6 }}>
        <div className="gm-group">
          <button type="button" className="gm-btn" onClick={() => zoomBy(1)} aria-label="Zoom in" title="Zoom in"><Icon d={I.plus} /></button>
          <button type="button" className="gm-btn" onClick={() => zoomBy(-1)} aria-label="Zoom out" title="Zoom out"><Icon d={I.minus} /></button>
        </div>
        <div className="gm-group">
          <button type="button" className="gm-btn" onClick={() => { setView(fitTo()); }} aria-label="Re-centre on the search" title="Re-centre"><Icon d={I.target} /></button>
          <button type="button" className="gm-btn" onClick={() => setFull((f) => !f)} aria-label={full ? 'Exit full screen' : 'Full screen map'} title={full ? 'Exit full screen (Esc)' : 'Full screen'}>
            <Icon d={full ? I.shrink : I.expand} />
          </button>
        </div>
        {onLasso ? (
          <div className="gm-group">
            <button type="button" className={`gm-btn${lassoOn ? ' gm-btn-on' : ''}`} onClick={() => { setLassoOn((x) => !x); onClosePopup?.(); }} aria-pressed={lassoOn}
              aria-label={lassoOn ? 'Stop drawing (Esc)' : 'Lasso: draw round the pins to select them'} title={lassoOn ? 'Stop drawing (Esc)' : 'Lasso: draw round pins to select them'}>
              {/* A dashed loop with a cursor: draw a shape to select. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4.5 14.5C3.6 13.4 3 12.2 3 11c0-3.9 4-7 9-7s9 3.1 9 7c0 1-.3 2-.8 2.9" strokeDasharray="2.6 3" />
                <path d="M13 13l7.5 3-3.2 1.3L16 20.5z" fill="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>

      {children ? <div data-ui style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 6 }}>{children}</div> : null}
      {topLeft ? <div data-ui style={{ position: 'absolute', left: 12, top: 12, right: 64, zIndex: 6, pointerEvents: 'none' }}><div style={{ pointerEvents: 'auto', display: 'inline-flex', maxWidth: '100%' }}>{topLeft}</div></div> : null}
      {lassoOn && !shape ? <div className="gm-hint" style={{ top: 58, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>Draw round the pins to select them</div> : null}

      <div style={{ position: 'absolute', right: 0, bottom: 0, fontSize: '10.5px', color: '#52525b', background: 'rgba(255,255,255,.75)', padding: '2px 6px', borderTopLeftRadius: 6, zIndex: 6 }}>
        {MAPBOX ? <>© <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>Mapbox</a> · </> : null}© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>OpenStreetMap</a>
      </div>
    </div>
  );
}
