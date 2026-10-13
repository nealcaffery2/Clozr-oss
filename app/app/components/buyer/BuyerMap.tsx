'use client';

// Buyers › Map. The same rows the list shows, filters and search applied,
// placed by market (lib/geo-centroids): a buyer who works three cities is a
// pin in each. The lasso selects them into the list's selection, so the bulk
// bar's Send marketing, Build campaign and the rest act on what was drawn.
//
// Realtors are a 127k corpus the app never holds, so they are one bubble per
// market with the agent count. A lasso round bubbles fetches every agent in
// those markets (migration 126, at most 5,000) and hands them to the bulk bar.

import React, { useMemo, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import type { MapPin } from '@/components/genius/GeniusMap';
import { ListMap, MapStatus, PopupButton, useCentroids, type LegendItem } from '@/components/ListMap';
import { Ring, tier } from '@/components/genius/parts';
import { responseTone } from '@/lib/heat';
import { fanOut, locate } from '@/lib/geo-centroids';
import { STATE_NAMES } from '@/lib/market-geo';
import { KIND_COLOR } from '@/lib/genius';
import { loadRealtorsInMarkets, type RealtorPick } from '@/lib/crm';
import type { BuyerAiScore } from '@/lib/buyer-ai-score';
import { picksOf } from '@/lib/multi-filter';

type BuyerRow = ClozrView['buyerRows'][number];

const OTHER = '#71717a';
const REALTOR = '#0d9488';

/** Colour by what they buy, as Genius does: flippers orange, landlords blue, builders teal. */
function kindOf(b: BuyerRow): { color: string; label: string } {
  const t = `${b.type} ${b.strategy ?? ''} ${b.exit ?? ''}`.toLowerCase();
  if (/flip|fix/.test(t)) return { color: KIND_COLOR.flipper, label: 'Flippers' };
  if (/landlord|rental|brrrr|hold|sfr/.test(t)) return { color: KIND_COLOR.landlord, label: 'Landlords' };
  if (/build|develop|new construction/.test(t)) return { color: KIND_COLOR.builder, label: 'Builders' };
  return { color: OTHER, label: 'Other' };
}

const isVip = (b: BuyerRow) => /vip/i.test(b.status) || b.genius;

type Props = {
  V: ClozrView;
  list: string;
  rows: BuyerRow[];
  height: number | string;
  sel: Record<string, boolean>;
  setSel: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  /** Realtors picked on the map, by the market that brought them in. */
  picks: Record<string, RealtorPick[]>;
  setPicks: React.Dispatch<React.SetStateAction<Record<string, RealtorPick[]>>>;
  aiOf: (b: BuyerRow) => BuyerAiScore | undefined;
  onList: () => void;
};

export function BuyerMap(p: Props) {
  return p.list === 'realtors' ? <RealtorMap {...p} /> : <BuyersOnMap {...p} />;
}

function BuyersOnMap({ rows, height, sel, setSel, aiOf }: Props) {
  const zipLike = useMemo(() => rows.some((b) => b.places.some((pl) => pl.kind === 'zip' || /^\d{5}$/.test(pl.city ?? ''))), [rows]);
  const { idx, failed } = useCentroids(true, zipLike);
  const [pop, setPop] = useState<string | null>(null);

  const { pins, unplaced, onMap, legend } = useMemo(() => {
    const out: MapPin[] = [];
    let unplaced = 0; let onMap = 0;
    const kinds = new Map<string, string>();
    if (!idx) return { pins: out, unplaced, onMap, legend: [] as LegendItem[] };
    for (const b of rows) {
      const seen = new Set<string>();
      const k = kindOf(b);
      for (const pl of b.places) {
        const hit = locate(pl, idx);
        if (!hit) continue;
        const at = `${hit.lat},${hit.lng}`;
        if (seen.has(at)) continue;
        seen.add(at);
        out.push({ id: `${b.id}@${at}`, group: b.id, lat: hit.lat, lng: hit.lng, color: k.color, ring: isVip(b),
          title: `${b.company || b.name} · ${hit.label}${hit.precision === 'state' ? ' (statewide)' : ''}` });
      }
      if (seen.size) { onMap += 1; kinds.set(k.label, k.color); } else unplaced += 1;
    }
    const order = ['Flippers', 'Landlords', 'Builders', 'Other'];
    const legend: LegendItem[] = [...kinds.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([label, color]) => ({ label, color }));
    if (rows.some(isVip)) legend.push({ label: 'VIP or Genius', color: '#a1a1aa', ring: true });
    return { pins: fanOut(out), unplaced, onMap, legend };
  }, [rows, idx]);

  const selected = useMemo(() => new Set(Object.keys(sel).filter((k) => sel[k])), [sel]);
  const count = rows.filter((b) => sel[b.id]).length;
  const byId = useMemo(() => new Map(rows.map((b) => [b.id, b])), [rows]);

  const popup = (id: string) => {
    const b = byId.get(id);
    if (!b) return null;
    const ai = aiOf(b);
    const n = ai ? ai.score : b.engagement;
    const t = ai ? tier(n) : (() => { const r = responseTone(b.responseKnown === false ? null : n, !!b.tireKicker); return { label: 'Replies', color: r.stroke, text: r.text }; })();
    const on = !!sel[b.id];
    return (
      <div style={{ display: 'grid', gap: '8px', paddingRight: '18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <Ring value={n} color={t.color} size={40} label={t.label} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 650, fontSize: '13px', color: '#18181b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.company || b.name}</span>
            <span style={{ display: 'block', fontSize: '11.5px', color: '#71717a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name} · {b.status}</span>
          </span>
        </div>
        <div style={{ fontSize: '11.5px', color: '#3f3f46', lineHeight: 1.45 }}>
          {b.markets || 'No market'}{b.price ? ` · ${b.price}` : ''}{b.exit ? ` · ${b.exit}` : ''}
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <PopupButton primary={!on} onClick={() => setSel((x) => ({ ...x, [b.id]: !on }))}>{on ? 'Unselect' : 'Select'}</PopupButton>
          <PopupButton onClick={b.open}>Open</PopupButton>
        </div>
      </div>
    );
  };

  const note = failed ? 'The map data did not load. Check the connection and switch back to Map.'
    : !idx ? 'Placing buyers…'
    : !pins.length ? (rows.length ? 'None of these buyers has a market we can place. Add a city, county, ZIP or state to their markets.' : 'No buyers match these filters.')
    : null;
  return (
    <ListMap pins={pins} height={height} selected={selected} noun="buyers" label="Map of buyers by market"
      onLasso={(ids) => { setSel((x) => ({ ...x, ...Object.fromEntries(ids.map((id) => [id, true])) })); setPop(null); }}
      onPin={setPop} popup={popup} popupId={pop} onClosePopup={() => setPop(null)} legend={legend} note={note}
      status={<MapStatus text={`${onMap.toLocaleString('en-US')} on the map${unplaced ? ` · ${unplaced.toLocaleString('en-US')} without a market` : ''}`} selected={count} onClear={() => setSel({})} />} />
  );
}

function RealtorMap({ V, height, picks, setPicks, onList }: Props) {
  const { idx, failed } = useCentroids(true, false);
  const [pop, setPop] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The list's State and City filters narrow the bubbles too (realtors take one of each: the first pick).
  const stateName = picksOf(V.gf.buyerState)[0];
  const cityName = picksOf(V.gf.buyerCity)[0];
  const pickedState = stateName ? Object.keys(STATE_NAMES).find((c) => STATE_NAMES[c] === stateName) ?? null : null;
  const pickedCity = cityName ? cityName.split(',')[0].trim().toLowerCase() : null;
  const markets = useMemo(() => (V.realtorMarkets || []).filter((m) => (!pickedState || m.state === pickedState) && (!pickedCity || m.city.toLowerCase() === pickedCity)),
    [V.realtorMarkets, pickedState, pickedCity]);

  const { pins, unplaced } = useMemo(() => {
    const out: MapPin[] = [];
    let unplaced = 0;
    if (!idx) return { pins: out, unplaced };
    for (const m of markets) {
      const key = `${m.city}, ${m.state}`;
      const hit = locate({ token: key, kind: 'city', state: m.state, city: m.city, label: key }, idx);
      if (!hit) { unplaced += m.count; continue; }
      out.push({ id: key, group: key, lat: hit.lat, lng: hit.lng, color: REALTOR, weight: m.count, title: `${key} · ${m.count.toLocaleString('en-US')} realtors` });
    }
    return { pins: out, unplaced };
  }, [markets, idx]);

  const picked = useMemo(() => new Set(Object.keys(picks)), [picks]);
  const agents = useMemo(() => new Set(Object.values(picks).flat().map((r) => r.dbId)).size, [picks]);
  const total = markets.reduce((t, m) => t + m.count, 0);

  /** Every agent in these markets, one request per market so a market can be let go again. */
  const take = async (keys: string[]) => {
    const wanted = keys.filter((k) => !picks[k]);
    if (!wanted.length) return;
    const ws = V.liveIds?.workspaceId;
    if (ws == null) return V.showToast('Sign in to select realtors.');
    setBusy(`Loading ${wanted.length === 1 ? wanted[0] : `${wanted.length} markets`}…`);
    const got = await Promise.all(wanted.map((k) => loadRealtorsInMarkets(ws, [k]).then((r) => [k, r] as const)));
    setBusy(null);
    const ok = got.filter(([, r]) => r.ok);
    if (!ok.length) return V.showToast('Could not load those realtors. Try again.');
    setPicks((cur) => ({ ...cur, ...Object.fromEntries(ok.map(([k, r]) => [k, r.rows])) }));
    const capped = ok.filter(([, r]) => r.total > r.rows.length).map(([k]) => k);
    const n = ok.reduce((t, [, r]) => t + r.rows.length, 0);
    V.showToast(capped.length
      ? `${n.toLocaleString('en-US')} realtors selected. ${capped.join(', ')} ${capped.length === 1 ? 'has' : 'have'} more than 5,000; the first 5,000 by name were taken.`
      : `${n.toLocaleString('en-US')} realtors selected`);
  };
  const drop = (key: string) => setPicks((cur) => { const next = { ...cur }; delete next[key]; return next; });

  const popup = (key: string) => {
    const m = markets.find((x) => `${x.city}, ${x.state}` === key);
    if (!m) return null;
    const on = !!picks[key];
    return (
      <div style={{ display: 'grid', gap: '8px', paddingRight: '18px' }}>
        <div>
          <div style={{ fontWeight: 650, fontSize: '13px', color: '#18181b' }}>{key}</div>
          <div style={{ fontSize: '11.5px', color: '#71717a' }}>{m.count.toLocaleString('en-US')} realtors in this market{on ? ' · selected' : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {on
            ? <PopupButton onClick={() => { setPop(null); drop(key); }}>Unselect</PopupButton>
            : <PopupButton primary onClick={() => { setPop(null); void take([key]); }}>Select all</PopupButton>}
          <PopupButton onClick={() => { V.setGf({ buyerState: STATE_NAMES[m.state] ?? m.state, buyerCity: m.city }); setPop(null); onList(); }}>Show in list</PopupButton>
        </div>
      </div>
    );
  };

  const note = failed ? 'The map data did not load. Check the connection and switch back to Map.'
    : !V.liveIds ? 'Realtors come from the live agent corpus. Sign in to a workspace to map them.'
    : !V.realtorMarkets?.length ? 'Loading realtor markets…'
    : !idx ? 'Placing markets…'
    : !pins.length ? 'No realtor markets match these filters.'
    : null;
  return (
    <ListMap pins={pins} height={height} selected={picked} noun="realtors" label="Map of realtors by market"
      onLasso={(keys) => { setPop(null); void take(keys); }}
      onPin={setPop} popup={popup} popupId={pop} onClosePopup={() => setPop(null)} note={note}
      legend={[{ color: REALTOR, label: 'Realtors per market' }]}
      status={<MapStatus busy={busy} text={`${total.toLocaleString('en-US')} realtors in ${pins.length.toLocaleString('en-US')} markets${unplaced ? ` · ${unplaced.toLocaleString('en-US')} not placed` : ''}`} selected={agents} onClear={() => setPicks({})} />} />
  );
}
