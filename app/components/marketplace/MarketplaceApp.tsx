'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bath, BedDouble, ChevronDown, Heart, Home, List, LogOut, Map as MapIcon, Ruler, Search, SlidersHorizontal, X,
} from 'lucide-react';
import { PropertyPhoto } from '@/components/PropertyPhoto';
import { daysSince, fromFeed, lockCard, moneyLabel, type Listing } from '@/lib/marketplace-public';
import { BuyerGate, type GateMode } from './BuyerGate';
import { DealMap } from './DealMap';
import { DealPage } from './DealPage';
import { MARKET_CSS } from './styles';
import { api, dealLink, saveAccess, streetPhoto, toggleSaved, useAccess, useDealParam, useSaved } from './store';

type SortKey = 'latest' | 'price-asc' | 'price-desc' | 'margin';
type Filters = { min: string; max: string; types: string[]; beds: number; status: 'all' | 'Available' | 'Sale Pending'; savedOnly: boolean };
const NO_FILTERS: Filters = { min: '', max: '', types: [], beds: 0, status: 'all', savedOnly: false };

export function MarketplaceApp() {
  const access = useAccess();
  const saved = useSaved();
  const [dealId, openDeal] = useDealParam();
  const [feed, setFeed] = useState<{ key: string; rows: Listing[]; member: boolean } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [market, setMarket] = useState('');
  const [sort, setSort] = useState<SortKey>('latest');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [menu, setMenu] = useState<'price' | 'type' | 'beds' | 'status' | null>(null);
  const [mobileMap, setMobileMap] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const [gate, setGate] = useState<{ mode: GateMode; reason: string | null } | null>(null);
  const [toast, setToast] = useState('');
  const [geo, setGeo] = useState<Record<string, { lat: number; lng: number }>>({});
  const afterGate = useRef<(() => void) | null>(null);
  const placed = useRef(geo);
  useEffect(() => { placed.current = geo; }, [geo]);

  const feedKey = access?.token ?? '';
  useEffect(() => {
    let cancel = false;
    fetch(api.feed(feedKey || null))
      .then((r) => r.json() as Promise<{ deals?: Record<string, unknown>[]; member?: boolean }>)
      .then((body) => {
        if (cancel) return;
        const member = !!body.member;
        setFeed({ key: feedKey, rows: (body.deals ?? []).map((d) => fromFeed(member || d.locked ? d : lockCard(d))), member });
        setFailed(null);
      })
      .catch(() => { if (!cancel) setFailed(feedKey); });
    return () => { cancel = true; };
  }, [feedKey]);
  const rows = useMemo(() => feed?.rows ?? [], [feed]);
  const state: 'loading' | 'ready' | 'error' = failed === feedKey ? 'error' : feed ? 'ready' : 'loading';

  // A member's full card and a visitor's teaser, depending on what the feed sent.
  const member = !!access && !!feed?.member && feed.key === feedKey;

  useEffect(() => {
    const missing = rows.filter((d) => d.lat == null && !placed.current[d.id] && (d.city || d.address));
    if (!missing.length) return;
    let cancel = false;
    const locate = async (query: string) => {
      const k = 'hpgeo:' + query;
      const cached = sessionStorage.getItem(k);
      if (cached) return JSON.parse(cached) as { lat: number; lng: number };
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=' + encodeURIComponent(query));
      const j = await r.json() as { lat: string; lon: string }[];
      if (!j[0]) return null;
      const point = { lat: Number(j[0].lat), lng: Number(j[0].lon) };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
      sessionStorage.setItem(k, JSON.stringify(point));
      return point;
    };
    (async () => {
      for (const d of missing.slice(0, 12)) {
        if (cancel) return;
        const street = d.address && d.address !== 'Address on request' ? d.address : '';
        const full = [street, d.city, d.state, d.zip].filter(Boolean).join(', ');
        const city = [d.city, d.state].filter(Boolean).join(', ');
        try {
          const point = (street ? await locate(full) : null) || (city ? await locate(city) : null);
          if (point && !cancel) setGeo((prev) => ({ ...prev, [d.id]: point }));
        } catch { /* a card without a pin is still a listing */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    return () => { cancel = true; };
  }, [rows]);

  const listings = useMemo(() => rows.map((d) => {
    const g = geo[d.id];
    return g && d.lat == null ? { ...d, lat: g.lat, lng: g.lng } : d;
  }), [rows, geo]);

  const markets = useMemo(() => [...new Set(listings.map((d) => d.market).filter((m) => m && m !== 'Other'))].sort(), [listings]);
  const types = useMemo(() => [...new Set(listings.map((d) => d.propertyType).filter(Boolean) as string[])].sort(), [listings]);

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    const lo = Number(filters.min.replace(/[$,\s]/g, '')) || 0;
    const hi = Number(filters.max.replace(/[$,\s]/g, '')) || Infinity;
    const list = listings.filter((d) => {
      if (market && d.market !== market) return false;
      if (filters.savedOnly && !saved.includes(d.id)) return false;
      if (filters.status !== 'all' && d.status !== filters.status) return false;
      if (filters.types.length && !filters.types.includes(d.propertyType ?? '')) return false;
      if (filters.beds && (d.beds ?? 0) < filters.beds) return false;
      if ((lo || hi < Infinity) && (d.price == null || d.price < lo || d.price > hi)) return false;
      if (!query) return true;
      return [d.address, d.city, d.state, d.zip, d.county, d.market].join(' ').toLowerCase().includes(query);
    });
    const margin = (d: Listing) => (d.arv && d.price ? d.arv - d.price : -Infinity);
    const when = (d: Listing) => Date.parse(d.listedAt ?? d.updatedAt ?? '') || 0;
    return [...list].sort((a, b) =>
      sort === 'price-asc' ? (a.price ?? Infinity) - (b.price ?? Infinity)
        : sort === 'price-desc' ? (b.price ?? 0) - (a.price ?? 0)
          : sort === 'margin' ? margin(b) - margin(a)
            : when(b) - when(a));
  }, [listings, q, market, filters, sort, saved]);

  const active = dealId ? listings.find((d) => d.id === dealId) ?? null : null;
  const filterCount = (filters.min || filters.max ? 1 : 0) + (filters.types.length ? 1 : 0) + (filters.beds ? 1 : 0) + (filters.status !== 'all' ? 1 : 0);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? '' : t)), 4200);
  }, []);
  const openGate = useCallback((reason: string | null, then?: () => void, mode: GateMode = 'join') => {
    afterGate.current = then ?? null;
    setGate({ mode, reason });
  }, []);
  const unlocked = (name: string | null) => {
    setGate(null);
    say(name ? `You're in, ${name}. Full addresses, every photo, and the COMPR report are unlocked.` : 'You are in. Deals are unlocked.');
    const then = afterGate.current;
    afterGate.current = null;
    if (then) window.setTimeout(then, 600);
  };
  const save = (d: Listing) => {
    if (!access) return openGate('Join to save deals and get alerts when the price drops.');
    const on = toggleSaved(d.id);
    void api.post('inquiry', { access: access.token, deal_id: Number(d.id), kind: on ? 'save' : 'unsave' });
    say(on ? 'Saved. Find it under Saved in the header.' : 'Removed from saved.');
  };
  const share = async (d: Listing) => {
    const url = dealLink(d.id);
    const title = `${moneyLabel(d.price) ?? 'Deal'} · ${[d.city, d.state].filter(Boolean).join(', ')} · Acme Homes`;
    try {
      if (navigator.share) { await navigator.share({ title, url }); return; }
      await navigator.clipboard.writeText(url);
      say('Link copied.');
    } catch { /* closing the share sheet is not an error */ }
  };

  return (
    <div className={'hp' + (mobileMap ? ' mk-map-on' : '') + (active ? ' mk-on-deal' : '')}>
      <style>{MARKET_CSS}</style>
      <header className="mk-bar">
        <a className="mk-logo" href="https://yourcompany.com" aria-label="Acme Homes">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/company-logo-white.svg" alt="Acme Homes" width={132} height={32} />
        </a>
        <form className="mk-search" role="search" onSubmit={(e) => { e.preventDefault(); if (active) openDeal(null); }}>
          <Search size={16} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="City, county, or ZIP" aria-label="Search listings" />
        </form>
        <div className="mk-bar-end">
          {access ? (
            <>
              <button type="button" className={'mk-dark-btn' + (filters.savedOnly ? ' is-on' : '')} aria-pressed={filters.savedOnly} onClick={() => { setFilters((f) => ({ ...f, savedOnly: !f.savedOnly })); if (active) openDeal(null); }}>
                <Heart size={16} aria-hidden fill={filters.savedOnly ? 'currentColor' : 'none'} />Saved{saved.length ? <span className="mk-count">{saved.length}</span> : null}
              </button>
              <span className="mk-hello">Hi, {access.name || 'investor'}</span>
              <button type="button" className="mk-dark-btn mk-icon-only" onClick={() => { saveAccess(null); say('Logged out.'); }} aria-label="Log out" title="Log out"><LogOut size={16} aria-hidden /></button>
            </>
          ) : (
            <>
              <button type="button" className="mk-dark-btn" onClick={() => openGate(null, undefined, 'login')}>Log in</button>
              <button type="button" className="mk-primary" onClick={() => openGate(null)}>Join buyers list</button>
            </>
          )}
        </div>
      </header>

      {!access && !active ? (
        <div className="mk-banner" role="note">
          <span>Addresses, most photos, and COMPR reports are for buyers-list members.</span>
          <button type="button" className="mk-link" onClick={() => openGate(null)}>Join free to unlock</button>
        </div>
      ) : null}

      {active ? (
        <DealPage
          listing={active}
          nearby={listings}
          access={member ? access : null}
          saved={saved.includes(active.id)}
          onBack={() => openDeal(null)}
          onGate={(reason, then) => openGate(reason, then)}
          onSave={() => save(active)}
          onShare={() => void share(active)}
          onToast={say}
          onSelect={(id) => openDeal(id)}
        />
      ) : (
        <div className="mk-body">
          <section className="mk-map" aria-label="Map">
            <DealMap listings={shown} selected={null} satellite={satellite} onSelect={(id) => openDeal(id)} />
            <div className="mk-layers" role="tablist" aria-label="Map style">
              <button type="button" role="tab" aria-selected={!satellite} className={satellite ? '' : 'is-on'} onClick={() => setSatellite(false)}>Map</button>
              <button type="button" role="tab" aria-selected={satellite} className={satellite ? 'is-on' : ''} onClick={() => setSatellite(true)}>Satellite</button>
            </div>
          </section>
          <section className="mk-rail" aria-label="Listings">
            <div className="mk-rail-head">
              <h1>Find your next deal</h1>
              <div className="mk-filters">
                <select aria-label="Market" value={market} onChange={(e) => setMarket(e.target.value)} className="mk-select">
                  <option value="">All markets</option>
                  {markets.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <Drop label={filters.min || filters.max ? priceLabel(filters) : 'Price'} on={!!(filters.min || filters.max)} open={menu === 'price'} onOpen={() => setMenu(menu === 'price' ? null : 'price')} onClose={() => setMenu(null)}>
                  <div className="mk-two">
                    <label>Min<input inputMode="numeric" value={filters.min} onChange={(e) => setFilters({ ...filters, min: e.target.value })} placeholder="No min" /></label>
                    <label>Max<input inputMode="numeric" value={filters.max} onChange={(e) => setFilters({ ...filters, max: e.target.value })} placeholder="No max" /></label>
                  </div>
                </Drop>
                <Drop label={filters.types.length ? `${filters.types.length} type${filters.types.length > 1 ? 's' : ''}` : 'Home type'} on={!!filters.types.length} open={menu === 'type'} onOpen={() => setMenu(menu === 'type' ? null : 'type')} onClose={() => setMenu(null)}>
                  {(types.length ? types : ['Single Family']).map((t) => (
                    <label key={t} className="mk-check-row">
                      <input type="checkbox" checked={filters.types.includes(t)} onChange={() => setFilters({ ...filters, types: filters.types.includes(t) ? filters.types.filter((x) => x !== t) : [...filters.types, t] })} />{t}
                    </label>
                  ))}
                </Drop>
                <Drop label={filters.beds ? `${filters.beds}+ beds` : 'Beds'} on={!!filters.beds} open={menu === 'beds'} onOpen={() => setMenu(menu === 'beds' ? null : 'beds')} onClose={() => setMenu(null)}>
                  <div className="mk-chips">
                    {[0, 1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className="mk-chip" aria-pressed={filters.beds === n} onClick={() => { setFilters({ ...filters, beds: n }); setMenu(null); }}>{n ? `${n}+` : 'Any'}</button>)}
                  </div>
                </Drop>
                <Drop label={filters.status === 'all' ? 'Status' : filters.status === 'Sale Pending' ? 'Sale pending' : 'For sale'} on={filters.status !== 'all'} open={menu === 'status'} onOpen={() => setMenu(menu === 'status' ? null : 'status')} onClose={() => setMenu(null)}>
                  <div className="mk-chips">
                    {([['all', 'Any'], ['Available', 'For sale'], ['Sale Pending', 'Sale pending']] as const).map(([v, t]) => (
                      <button key={v} type="button" className="mk-chip" aria-pressed={filters.status === v} onClick={() => { setFilters({ ...filters, status: v }); setMenu(null); }}>{t}</button>
                    ))}
                  </div>
                </Drop>
                {filterCount || market || q ? (
                  <button type="button" className="mk-text-btn" onClick={() => { setFilters(NO_FILTERS); setMarket(''); setQ(''); }}><X size={14} aria-hidden />Reset</button>
                ) : <span className="mk-filter-hint"><SlidersHorizontal size={14} aria-hidden />Filters</span>}
              </div>
              <div className="mk-rail-sub">
                <span role="status">{state === 'loading' ? 'Loading deals…' : `${shown.length} ${shown.length === 1 ? 'deal' : 'deals'} found`}</span>
                <label className="mk-sort">Sort
                  <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                    <option value="latest">Latest</option>
                    <option value="price-asc">Price, low to high</option>
                    <option value="price-desc">Price, high to low</option>
                    <option value="margin">Biggest margin</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="mk-scroll">
              {state === 'error' ? <p className="mk-empty">The marketplace could not load. Check your connection and refresh.</p> : null}
              {state === 'ready' && shown.length === 0 ? (
                <div className="mk-empty">
                  <Home size={22} aria-hidden />
                  <p>{rows.length ? 'No deals match these filters.' : 'Nothing is on the market right now.'}</p>
                  {rows.length ? <button type="button" className="mk-ghost" onClick={() => { setFilters(NO_FILTERS); setMarket(''); setQ(''); }}>Clear filters</button>
                    : <button type="button" className="mk-primary" onClick={() => openGate('Join and the next deal comes to you first.')}>Get the next deal first</button>}
                </div>
              ) : null}
              <div className="mk-grid">
                {state === 'loading' ? [0, 1, 2, 3].map((i) => <div key={i} className="mk-card is-skeleton" aria-hidden />) : null}
                {shown.map((d) => (
                  <Card key={d.id} d={d} saved={saved.includes(d.id)} onOpen={() => openDeal(d.id)} onSave={() => save(d)} />
                ))}
              </div>
            </div>
          </section>
          <button type="button" className="mk-toggle" onClick={() => setMobileMap((v) => !v)}>
            {mobileMap ? <><List size={16} aria-hidden />List</> : <><MapIcon size={16} aria-hidden />Map</>}
          </button>
        </div>
      )}

      {gate ? <BuyerGate mode={gate.mode} reason={gate.reason} markets={markets} onClose={() => { setGate(null); afterGate.current = null; }} onUnlocked={unlocked} /> : null}
      {toast ? <div className="mk-toast" role="status">{toast}</div> : null}
    </div>
  );
}

function priceLabel(f: Filters) {
  const n = (s: string) => {
    const v = Number(s.replace(/[$,\s]/g, ''));
    return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`;
  };
  if (f.min && f.max) return `${n(f.min)} – ${n(f.max)}`;
  return f.min ? `${n(f.min)}+` : `Up to ${n(f.max)}`;
}

function Drop({ label, on, open, onOpen, onClose, children }: { label: string; on: boolean; open: boolean; onOpen: () => void; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <div className="mk-drop">
      <button type="button" className={'mk-select' + (on ? ' is-on' : '')} aria-expanded={open} onClick={onOpen}>{label}<ChevronDown size={14} aria-hidden /></button>
      {open ? (
        <>
          <button type="button" className="mk-drop-back" onClick={onClose} aria-label="Close filter" tabIndex={-1} />
          <div className="mk-drop-panel">{children}</div>
        </>
      ) : null}
    </div>
  );
}

function Card({ d, saved, onOpen, onSave }: { d: Listing; saved: boolean; onOpen: () => void; onSave: () => void }) {
  const age = daysSince(d.listedAt);
  const street = streetPhoto(d);
  const where = d.locked
    ? [d.county ? `${d.county} County` : null, d.city, [d.state, d.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : [d.address, d.city, [d.state, d.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return (
    <article className="mk-card">
      <button type="button" className="mk-card-hit" onClick={onOpen} aria-label={`${moneyLabel(d.price) ?? 'Deal'}, ${where}`} />
      <div className="mk-photo">
        {d.photos[0] || street ? <PropertyPhoto photo={d.photos[0]} street={street} alt="" empty="Photo coming soon" /> : <span className="mk-nophoto"><Home size={22} aria-hidden />Photo coming soon</span>}
        <span className={'mk-flag' + (d.status === 'Sale Pending' ? ' is-pending' : '')}>{d.status === 'Sale Pending' ? 'Sale pending' : 'For sale'}</span>
        {age != null && age <= 7 ? <span className="mk-new">Just listed</span> : null}
        <button type="button" className="mk-heart" aria-pressed={saved} aria-label={saved ? 'Remove from saved' : 'Save deal'} onClick={onSave}>
          <Heart size={16} aria-hidden fill={saved ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="mk-card-copy">
        <div className="mk-price-line">
          <span className="mk-price">{moneyLabel(d.price) ?? 'Make an offer'}</span>
          {d.arv ? <span className="mk-arv">ARV {moneyLabel(d.arv)}</span> : null}
        </div>
        <div className="mk-where" title={where}>{where}</div>
        <div className="mk-icons">
          <span><BedDouble size={14} aria-hidden />{d.beds ?? '—'} bd</span>
          <span><Bath size={14} aria-hidden />{d.baths ?? '—'} ba</span>
          <span><Ruler size={14} aria-hidden />{d.sqft ? d.sqft.toLocaleString('en-US') : '—'} sq ft</span>
        </div>
      </div>
    </article>
  );
}
