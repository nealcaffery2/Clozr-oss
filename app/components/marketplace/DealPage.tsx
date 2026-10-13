'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bath, BedDouble, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Eye, FileBarChart, FileText, Hammer,
  Heart, Home, Images, LandPlot, Lock, MapPin, MessageSquare, Ruler, Send, Share2, ShieldCheck, X,
} from 'lucide-react';
import { PropertyPhoto } from '@/components/PropertyPhoto';
import { daysSince, moneyLabel, type Listing } from '@/lib/marketplace-public';
import { DealMap } from './DealMap';
import { api, streetPhoto, type Access } from './store';

const DISCLOSURES: [string, string][] = [
  ['Verify everything yourself', 'Prices, ARV, repair estimates, comps, square footage and photos are estimates offered for your convenience. Verify every figure, the condition and the title before you buy. Acme Homes is not an appraiser or a licensed contractor.'],
  ['Showings by appointment only', 'Do not enter the property or contact anyone living there. Access is only by an appointment set with Acme Homes.'],
  ['Assignment of contract', 'Acme Homes may hold an equitable interest in this property under a purchase contract and may be marketing that contract for assignment. Acme Homes is not acting as your real estate agent.'],
  ['As-is sale', 'Properties sell as-is, where-is. Price, earnest money, closing costs and closing date are set in the purchase contract you sign.'],
  ['Risk of loss', 'Real estate investing carries risk, including loss of the money you put in. Talk to your own attorney, CPA or lender before you commit.'],
  ['For buyers-list members', 'Deal details are shared with members of the Acme Homes buyers list. Share the link with a partner rather than reposting the details.'],
];

export function DealPage({ listing, nearby, access, saved, onBack, onGate, onSave, onShare, onToast, onSelect }: {
  listing: Listing;
  nearby: Listing[];
  access: Access | null;
  saved: boolean;
  onBack: () => void;
  onGate: (reason: string, then?: () => void) => void;
  onSave: () => void;
  onShare: () => void;
  onToast: (msg: string) => void;
  onSelect: (id: string) => void;
}) {
  const [sheet, setSheet] = useState<'offer' | 'inquiry' | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const locked = listing.locked || !access;
  const photos = listing.photos;
  const margin = listing.arv != null && listing.price != null ? listing.arv - listing.price : null;
  const net = margin != null && listing.repairs != null ? margin - listing.repairs : null;
  const listed = daysSince(listing.listedAt);
  const area = [listing.county ? `${listing.county} County` : null, listing.city, [listing.state, listing.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const viewed = useRef('');
  // A stable array, so the aerial map is not torn down and redrawn on every render.
  const only = useMemo(() => [listing], [listing]);
  const street = locked ? null : streetPhoto(listing);

  useEffect(() => {
    if (!access || listing.locked || viewed.current === listing.id) return;
    viewed.current = listing.id;
    const session = sessionStorage.getItem('hp.session') || Math.random().toString(36).slice(2);
    sessionStorage.setItem('hp.session', session);
    void api.post('inquiry', { access: access.token, deal_id: Number(listing.id), kind: 'view', session });
  }, [access, listing.id, listing.locked]);

  const need = (reason: string, then: () => void) => (locked ? onGate(reason, then) : then());
  const description = listing.description || summary(listing);
  const details = ([
    [<Home key="t" size={16} aria-hidden />, 'Type', listing.propertyType],
    [<CalendarDays key="b" size={16} aria-hidden />, 'Built in', listing.yearBuilt],
    [<LandPlot key="l" size={16} aria-hidden />, 'Lot size', listing.lotSqft ? `${listing.lotSqft.toLocaleString('en-US')} sq ft` : null],
    [<ShieldCheck key="o" size={16} aria-hidden />, 'Occupancy', listing.occupancy],
    [<Hammer key="c" size={16} aria-hidden />, 'Condition', listing.condition],
    [<Hammer key="r" size={16} aria-hidden />, 'Repair estimate', moneyLabel(listing.repairs)],
  ] as [React.ReactNode, string, React.ReactNode][]).filter(([, , v]) => v != null && v !== '');

  return (
    <div className="mk-page">
      <div className="mk-page-inner">
        <button type="button" className="mk-back" onClick={onBack}><ChevronLeft size={16} aria-hidden />Back to properties</button>

        <div className={'mk-gallery' + (listing.photoCount > 1 ? '' : ' is-single')}>
          <button type="button" className="mk-gallery-main" onClick={() => (photos.length ? need('Join to see every photo.', () => setViewer(0)) : undefined)} aria-label="Open photos">
            {photos.length || street ? <PropertyPhoto photo={photos[0]} street={street} alt={listing.locked ? 'Property photo' : listing.address} empty="Photo coming soon" eager /> : <span className="mk-nophoto"><Home size={28} aria-hidden />Photos coming soon</span>}
            <span className={'mk-flag' + (listing.status === 'Sale Pending' ? ' is-pending' : '')}>{listing.status === 'Sale Pending' ? 'Sale pending' : 'For sale'}</span>
          </button>
          {listing.photoCount <= 1 ? (
            <div className="mk-gallery-aerial">
              <DealMap listings={only} selected={listing.id} onSelect={() => undefined} satellite compact zoom={locked ? 13 : 18} />
              <span className="mk-aerial-tag">{locked ? 'Approximate area' : 'Aerial view'}</span>
            </div>
          ) : null}
          {(listing.photoCount > 1 ? [1, 2, 3, 4] : []).map((i) => {
            const url = photos[i];
            const last = i === 4;
            const hidden = locked && listing.photoCount > 1;
            return (
              <button key={i} type="button" className={'mk-gallery-tile' + (hidden ? ' is-locked' : '')}
                onClick={() => need(`Join to unlock all ${Math.max(listing.photoCount, 1)} photos.`, () => setViewer(Math.min(i, Math.max(photos.length - 1, 0))))}
                aria-label={hidden ? 'Locked photo' : `Photo ${i + 1}`}>
                {url && !hidden ? <PropertyPhoto photo={url} alt="" empty="" /> : hidden && photos[0] ? <span className="mk-blur" style={{ backgroundImage: `url("${photos[0]}")` }} /> : <span className="mk-tile-empty"><Images size={18} aria-hidden /></span>}
                {hidden ? <span className="mk-tile-lock"><Lock size={14} aria-hidden /></span> : null}
                {last && hidden ? (
                  <span className="mk-tile-cta"><strong>Join to unlock all {listing.photoCount} photos</strong><span className="mk-ghost mk-ghost-sm">Join free</span></span>
                ) : last && photos.length > 5 ? <span className="mk-tile-cta"><span className="mk-ghost mk-ghost-sm"><Images size={14} aria-hidden />All {photos.length} photos</span></span> : null}
              </button>
            );
          })}
        </div>

        <div className="mk-where-row">
          <h1 className="mk-where-title">
            <MapPin size={18} aria-hidden />
            <span>{locked ? area || 'Location on request' : [listing.address, area].filter(Boolean).join(', ')}</span>
          </h1>
          {locked ? <button type="button" className="mk-ghost" onClick={() => onGate('Join to see the full address.')}><Lock size={14} aria-hidden />View full address</button> : null}
          <span className="mk-where-meta">
            {listed != null ? <span><CalendarDays size={14} aria-hidden />{listed === 0 ? 'Listed today' : `Listed ${listed} day${listed === 1 ? '' : 's'} ago`}</span> : null}
            {listing.views ? <span><Eye size={14} aria-hidden />{listing.views.toLocaleString('en-US')} views</span> : null}
          </span>
        </div>

        <div className="mk-layout">
          <div className="mk-main">
            <section className="mk-box mk-specs">
              <Spec icon={<BedDouble size={20} aria-hidden />} label="Beds" value={listing.beds} />
              <Spec icon={<Bath size={20} aria-hidden />} label="Baths" value={listing.baths} />
              <Spec icon={<Ruler size={20} aria-hidden />} label="Sq ft" value={listing.sqft?.toLocaleString('en-US') ?? null} />
              {listing.yearBuilt ? <Spec icon={<CalendarDays size={20} aria-hidden />} label="Built" value={listing.yearBuilt} /> : null}
              {listing.lotSqft ? <Spec icon={<LandPlot size={20} aria-hidden />} label="Lot" value={`${listing.lotSqft.toLocaleString('en-US')} sq ft`} /> : null}
              <Spec icon={<Hammer size={20} aria-hidden />} label="Repairs" value={listing.repairs ? moneyLabel(listing.repairs) : null} />
            </section>

            <section className="mk-box">
              <h2>Overview</h2>
              <p className={'mk-desc' + (more ? ' is-open' : '')}>{description}</p>
              {description.length > 280 ? <button type="button" className="mk-link" onClick={() => setMore((v) => !v)}>{more ? 'Show less' : 'Read more'}</button> : null}
            </section>

            {details.length ? (
              <section className="mk-box">
                <h2>Details</h2>
                <dl className="mk-grid-dl">
                  {details.map(([icon, k, v]) => <Fact key={k} icon={icon} k={k} v={v} />)}
                </dl>
              </section>
            ) : null}

            <section className="mk-box">
              <h2>Documents</h2>
              <p className="mk-muted">The COMPR package: the buyer report with photos and sold comps, and the comps PDF.</p>
              <div className="mk-docs">
                <Doc icon={<FileBarChart size={18} aria-hidden />} title="COMPR report and comps" sub="Photos, ARV and sold comps" href={listing.buyerReportUrl} available={listing.hasReport} locked={locked} onGate={() => onGate('Join to open the COMPR report.')} />
                <Doc icon={<FileText size={18} aria-hidden />} title="Comps PDF" sub="Comparable market analysis" href={listing.compsUrl} available={listing.hasComps} locked={locked} onGate={() => onGate('Join to open the comps PDF.')} />
              </div>
            </section>

            <section className="mk-box mk-box-map">
              <h2>Location</h2>
              <p className="mk-muted">{locked ? 'The pin is approximate until you join.' : 'Nearby Acme Homes deals on the map.'}</p>
              <div className="mk-mini-map"><DealMap listings={nearby} selected={listing.id} onSelect={onSelect} compact /></div>
            </section>

            <section className="mk-box">
              <h2>Notices and disclosures</h2>
              <div className="mk-accordion">
                {DISCLOSURES.map(([t, body]) => (
                  <details key={t}>
                    <summary><span>{t}</span><ChevronDown size={16} aria-hidden /></summary>
                    <p>{body}</p>
                  </details>
                ))}
              </div>
            </section>
          </div>

          <aside className="mk-side">
            <section className="mk-box mk-price-box">
              <div className="mk-price-row"><span>Price</span><strong>{moneyLabel(listing.price) ?? 'Make an offer'}</strong></div>
              {listing.arv ? <div className="mk-price-row"><span>ARV</span><strong>{moneyLabel(listing.arv)}</strong></div> : null}
              {listing.repairs ? <div className="mk-price-row"><span>Est. repairs</span><strong>{moneyLabel(listing.repairs)}</strong></div> : null}
              {margin != null && margin > 0 ? <div className="mk-price-row is-sub"><span>Gross margin</span><strong>{moneyLabel(margin)}</strong></div> : null}
              {net != null && net > 0 ? <div className="mk-price-row is-sub"><span>After repairs</span><strong>{moneyLabel(net)}</strong></div> : null}
              <button type="button" className="mk-primary mk-wide" disabled={!listing.allowOffers || listing.status === 'Sale Pending'} onClick={() => need('Join to make an offer on this house.', () => setSheet('offer'))}>
                {listing.status === 'Sale Pending' ? 'Sale pending' : 'Make offer'}
              </button>
              <button type="button" className="mk-ghost mk-wide" onClick={() => need('Join to message dispositions about this house.', () => setSheet('inquiry'))}><MessageSquare size={16} aria-hidden />Send inquiry</button>
              <div className="mk-side-row">
                <button type="button" className="mk-text-btn" aria-pressed={saved} onClick={onSave}><Heart size={16} aria-hidden fill={saved ? 'currentColor' : 'none'} />{saved ? 'Saved' : 'Save'}</button>
                <button type="button" className="mk-text-btn" onClick={onShare}><Share2 size={16} aria-hidden />Share</button>
              </div>
            </section>
            <section className="mk-box mk-agent">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/company-mark.svg" alt="" width={52} height={52} />
              <div>
                <strong>Acme Homes Dispositions</strong>
                <span>Off-market homes, sold as-is</span>
              </div>
              <button type="button" className="mk-ghost mk-wide" onClick={() => need('Join to message dispositions.', () => setSheet('inquiry'))}><Send size={15} aria-hidden />Message us</button>
            </section>
          </aside>
        </div>
      </div>

      {sheet === 'offer' && access ? <OfferSheet listing={listing} access={access} onClose={() => setSheet(null)} onToast={onToast} /> : null}
      {sheet === 'inquiry' && access ? <InquirySheet listing={listing} access={access} onClose={() => setSheet(null)} onToast={onToast} /> : null}
      {viewer != null && !locked && photos.length ? <Viewer photos={photos} start={viewer} alt={listing.address} onClose={() => setViewer(null)} /> : null}
    </div>
  );
}

function summary(l: Listing): string {
  const bits = [
    l.propertyType ? l.propertyType.toLowerCase() : 'home',
    l.beds && l.baths ? `${l.beds} bed, ${l.baths} bath` : null,
    l.sqft ? `${l.sqft.toLocaleString('en-US')} sq ft` : null,
    l.yearBuilt ? `built in ${l.yearBuilt}` : null,
  ].filter(Boolean);
  const where = [l.city, l.state].filter(Boolean).join(', ');
  const money = [l.price ? `offered at ${moneyLabel(l.price)}` : null, l.arv ? `with an ARV of ${moneyLabel(l.arv)}` : null].filter(Boolean).join(' ');
  return `Off-market ${bits.join(', ')}${where ? ` in ${where}` : ''}${money ? `, ${money}` : ''}. Sold as-is. Open the COMPR report for the photos, the sold comps and the numbers behind the ARV.`;
}

function Spec({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="mk-spec">
      <span className="mk-spec-icon">{icon}</span>
      <span><span className="mk-spec-k">{label}</span><strong>{value ?? '—'}</strong></span>
    </div>
  );
}

function Fact({ icon, k, v }: { icon: React.ReactNode; k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt>{icon}{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function Doc({ icon, title, sub, href, available, locked, onGate }: { icon: React.ReactNode; title: string; sub: string; href: string | null; available: boolean; locked: boolean; onGate: () => void }) {
  const body = (
    <>
      <span className="mk-doc-icon">{icon}</span>
      <span className="mk-doc-copy"><strong>{title}</strong><span>{available ? sub : 'Coming soon'}</span></span>
      {locked && available ? <Lock size={15} aria-hidden /> : null}
    </>
  );
  if (!available) return <div className="mk-doc is-off">{body}</div>;
  if (locked || !href) return <button type="button" className="mk-doc" onClick={onGate}>{body}</button>;
  return <a className="mk-doc" href={href} target="_blank" rel="noreferrer">{body}</a>;
}

function Sheet({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="mk-modal" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="mk-modal-back" onClick={onClose} aria-label="Close" />
      <div className="mk-gate">
        <div className="mk-gate-head">
          <span className="mk-gate-kicker">{title}</span>
          <button type="button" className="mk-icon-btn" onClick={onClose} aria-label="Close"><X size={18} aria-hidden /></button>
        </div>
        <div className="mk-gate-body">
          {sub ? <p className="mk-gate-sub">{sub}</p> : null}
          {children}
        </div>
      </div>
    </div>
  );
}

function OfferSheet({ listing, access, onClose, onToast }: { listing: Listing; access: Access; onClose: () => void; onToast: (m: string) => void }) {
  const [amount, setAmount] = useState(listing.price ? String(listing.price) : '');
  const [financing, setFinancing] = useState('Cash');
  const [days, setDays] = useState('14');
  const [emd, setEmd] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(amount.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return setErr('Enter your offer amount.');
    setBusy(true); setErr('');
    const r = await api.post('offer', { access: access.token, deal_id: Number(listing.id), amount: n, financing, close_days: days, emd, notes });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error || 'That did not go through. Try again.');
    onToast(`Offer of ${moneyLabel(n)} sent. Dispositions will reach out.`);
    onClose();
  }
  return (
    <Sheet title="Make an offer" sub={`${listing.address}${listing.city ? `, ${listing.city}` : ''}. Asking ${moneyLabel(listing.price) ?? 'open to offers'}.`} onClose={onClose}>
      <form className="mk-form" onSubmit={submit}>
        <label>Your offer<input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></label>
        <div className="mk-two">
          <label>Funding
            <select value={financing} onChange={(e) => setFinancing(e.target.value)}>
              {['Cash', 'Hard money', 'Private money', 'Conventional'].map((f) => <option key={f}>{f}</option>)}
            </select>
          </label>
          <label>Close in
            <select value={days} onChange={(e) => setDays(e.target.value)}>
              {['7', '10', '14', '21', '30'].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
        </div>
        <label><span>Earnest money <span className="mk-opt">optional</span></span><input inputMode="numeric" value={emd} onChange={(e) => setEmd(e.target.value)} placeholder="$5,000" /></label>
        <label><span>Notes <span className="mk-opt">optional</span></span><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Walkthrough needed, proof of funds attached by email…" /></label>
        <button type="submit" className="mk-primary mk-wide" disabled={busy}>{busy ? 'Sending…' : 'Send offer'}</button>
        {err ? <p className="mk-err" role="alert">{err}</p> : null}
      </form>
    </Sheet>
  );
}

function InquirySheet({ listing, access, onClose, onToast }: { listing: Listing; access: Access; onClose: () => void; onToast: (m: string) => void }) {
  const [msg, setMsg] = useState(`Hi, I'm interested in ${listing.address}${listing.city ? `, ${listing.city}` : ''}. Is it still available, and when can I walk it?`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!msg.trim()) return setErr('Write a short message.');
    setBusy(true); setErr('');
    const r = await api.post('inquiry', { access: access.token, deal_id: Number(listing.id), kind: 'inquiry', message: msg.trim() });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error || 'That did not go through. Try again.');
    onToast('Message sent. Dispositions will reach out.');
    onClose();
  }
  return (
    <Sheet title="Send inquiry" sub="Dispositions gets this on the deal and calls or texts you back." onClose={onClose}>
      <form className="mk-form" onSubmit={submit}>
        <label>Message<textarea rows={5} value={msg} onChange={(e) => setMsg(e.target.value)} autoFocus /></label>
        <button type="submit" className="mk-primary mk-wide" disabled={busy}><Send size={15} aria-hidden />{busy ? 'Sending…' : 'Send'}</button>
        {err ? <p className="mk-err" role="alert">{err}</p> : null}
      </form>
    </Sheet>
  );
}

function Viewer({ photos, start, alt, onClose }: { photos: string[]; start: number; alt: string; onClose: () => void }) {
  const [i, setI] = useState(start);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((n) => (n + 1) % photos.length);
      if (e.key === 'ArrowLeft') setI((n) => (n - 1 + photos.length) % photos.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photos.length, onClose]);
  return (
    <div className="mk-viewer" role="dialog" aria-modal="true" aria-label="Photos">
      <button type="button" className="mk-viewer-close mk-icon-btn" onClick={onClose} aria-label="Close photos"><X size={20} aria-hidden /></button>
      {photos.length > 1 ? <button type="button" className="mk-viewer-nav is-prev" onClick={() => setI((n) => (n - 1 + photos.length) % photos.length)} aria-label="Previous photo"><ChevronLeft size={22} aria-hidden /></button> : null}
      <div className="mk-viewer-img"><PropertyPhoto photo={photos[i]} alt={`${alt}, photo ${i + 1}`} fit="contain" empty="Photo unavailable" eager /></div>
      {photos.length > 1 ? <button type="button" className="mk-viewer-nav is-next" onClick={() => setI((n) => (n + 1) % photos.length)} aria-label="Next photo"><ChevronRight size={22} aria-hidden /></button> : null}
      <span className="mk-viewer-count" role="status">{i + 1} of {photos.length}</span>
    </div>
  );
}
