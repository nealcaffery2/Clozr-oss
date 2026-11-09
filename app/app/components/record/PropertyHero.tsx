'use client';

// The house at the top of the record, wide: the address and its facts once,
// in the header, with Edit address, COMPR and Make offer; the key numbers in
// one strip; then a small photo on the left (thumbnails under it, arrows and
// the arrow keys walk the set, Street View when the record has no photos)
// beside the deal facts (triage, who sent it in, market, APN, the lookups,
// the shares, the offers and counters); the underwriter's stage chips run
// the full width under both. The same data the left-column PropertyCard
// showed, laid flat so the centre column opens on the house.

import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ClozrView } from '@/app/clozr/view';
import { PropertyPhoto } from '@/components/PropertyPhoto';
import { ComprIcon } from '@/components/ds/ComprIcon';
import { InlineField } from '@/components/ds/InlineField';
import { OfferHistory, UnderwriterStages } from './OfferCard';
import { BandField, factValue } from './PropertyCard';
import { ghostBtn, label } from './ui';
import { Button } from '@/components/ds/Button';
import { textTone } from '@/lib/text-tone';

/** A Drive photo at the size it is shown; the 232px hero and 52px thumbs were pulling the 1600px original. */
const sized = (u: string, w: number) => u.replace(/^(https:\/\/lh3\.googleusercontent\.com\/.+)=w\d+$/, `$1=w${w}`);

const small: React.CSSProperties = { ...ghostBtn, height: '28px', fontSize: '12px', padding: '0 10px', whiteSpace: 'nowrap' };

export function PropertyHero({ V }: { V: ClozrView }) {
  const o = V.offerCard;
  const canEdit = !!V.liveIds?.canWrite || !V.liveIds;
  const photos = V.P.photos || [];
  const [i, setI] = useState(0);
  const [pid, setPid] = useState(V.P.id);
  if (pid !== V.P.id) { setPid(V.P.id); setI(0); }
  const n = photos.length;
  const at = n ? Math.min(i, n - 1) : 0;
  const step = (d: number) => { if (n > 1) setI((x) => (x + d + n) % n); };
  const strip = useRef<HTMLDivElement | null>(null);
  // Only after a step: on mount it forced a layout of the whole page before the first paint.
  const stepped = useRef(false);
  useEffect(() => {
    if (!stepped.current) { stepped.current = true; return; }
    strip.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [at]);
  const triage = V.propertyUwTriage;
  const triageColor = triage?.bucket === 'green' ? '#16a34a' : triage?.bucket === 'decline' ? '#dc2626' : triage?.bucket === 'review' ? '#ca8a04' : null;

  const facts = V.propFacts || [];
  const fact = (k: string) => factValue(facts, k);
  const subline = [
    V.P.cityLine.replace(/^,\s*/, ''),
    [fact('Beds') !== '—' ? `${fact('Beds')} bed` : null, fact('Baths') !== '—' ? `${fact('Baths')} bath` : null].filter(Boolean).join(' '),
    fact('Sqft') !== '—' ? `${fact('Sqft')} sqft` : null,
    fact('Year') !== '—' ? `Built ${fact('Year')}` : null,
    fact('Lot') !== '—' ? `${fact('Lot')} lot` : null,
    fact('Type') !== '—' ? fact('Type') : null,
  ].filter((x) => x && x.trim()).join(' · ');
  const sub = V.recordSubmission;
  const asking = V.P.asking && V.P.asking !== '—' ? V.P.asking : '—';
  const money = (v: string | number | null | undefined) => (v == null || v === '' || v === '—' ? '—' : String(v));
  return (
    <section data-testid="record-property" aria-label="Property" className="rec-hero">
      <header className="rec-hero-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="rec-hero-h1">{V.P.addr}</h2>
          <div className="rec-hero-sub">{subline}{V.P.source && V.P.source !== '—' ? <span className="rec-hero-src">Source: {V.P.source}</span> : null}</div>
        </div>
        <div className="rec-hero-head-acts">
          {V.canEditAddress ? <button type="button" data-testid="property-edit-address" className="rec-link" onClick={V.editAddress}>{V.hasAddress ? 'Edit address' : 'Set address'}</button> : null}
          {V.comprLinked ? (
            <Button data-testid="open-in-compr" onClick={V.openCompr} title="The COMPR report in its own window" icon={<ComprIcon size={14} />}>
              Open in COMPR
            </Button>
          ) : (
            <Button data-testid="run-compr" onClick={V.runCompr} disabled={V.comprRunning} busy={V.comprRunning} icon={<ComprIcon size={14} />}
              title="Underwrites this house in COMPR with every photo on the record. ARV, rehab and MAO fill in here.">
              {V.comprRunning ? 'Running COMPR…' : 'Run COMPR'}
            </Button>
          )}
          <Button kind="primary" onClick={() => V.openOfferSheet(V.P.id)} title={o.mao === null ? 'Make offer (O). No MAO yet: type the amount in the sheet.' : 'Make offer (O). Prefilled from the MAO; nothing is sent.'}>
            Make offer
          </Button>
        </div>
      </header>
      <div className="rec-hero-nums" data-testid="record-underwrite" aria-label="Key numbers">
          <div className="rec-hero-nums-title">Key numbers<span style={{ ...label, marginLeft: '8px' }}>{o.basis} · {o.status}</span></div>
          <div data-testid="offer-asking" style={{ minWidth: 0 }}>
            <div style={label}>Asking</div>
            <div className="rec-money rec-hero-n" style={{ color: asking === '—' ? 'var(--meta, #71717a)' : undefined }}>
              <InlineField recordId={V.P.id} field="offer-card:asking_price" label="Asking price" type="money" value={asking === '—' ? null : Number(asking.replace(/[^0-9.]/g, '')) || null}
                readOnly={canEdit ? false : 'Read-only: you can’t edit this record'} placeholder="Add" onSave={(v) => V.saveSellerField('asking_price', v)} />
            </div>
          </div>
          <div style={{ minWidth: 0 }}><div style={label}>ARV</div><div className="rec-money rec-hero-n" title={String(o.arvLabel)}>{money(o.arvLabel)}</div></div>
          <div style={{ minWidth: 0 }}><div style={label}>Est. rehab</div><div className="rec-money rec-hero-n" title={String(o.rehabLabel)}>{money(o.rehabLabel)}</div></div>
          <div className="rec-hero-mao" style={{ minWidth: 0 }}><div style={label}>Max offer</div><div className="rec-money rec-hero-n" style={{ color: o.mao === null ? 'var(--meta, #71717a)' : 'var(--tx-mint, #0a8560)' }}>{o.maoLabel}</div></div>
          <div data-testid="compr-offer-band" style={{ display: 'contents' }}>
            <BandField testId="offer-low" title="Low offer" amount={o.low} setByHand={o.lowSet} onSave={(x) => V.saveOfferBand('low', x)} />
            <BandField testId="offer-high" title="High offer" amount={o.high} setByHand={o.highSet} onSave={(x) => V.saveOfferBand('high', x)} />
          </div>
          <div data-testid="offer-made" style={{ minWidth: 0 }}><div style={label}>Offer made</div><div className="rec-money rec-hero-n" style={{ color: o.sent ? undefined : 'var(--meta, #71717a)' }}>{o.sent || 'None yet'}</div></div>
          <div style={{ minWidth: 0 }}><div style={label}>Contract</div><div className="rec-money rec-hero-n" title={String(o.contract)}>{money(o.contract)}</div></div>
      </div>
      <div className="rec-hero-photos" tabIndex={0} aria-label={n ? `Photos of ${V.P.addr}, ${at + 1} of ${n}. Arrow keys change the photo.` : `Street View of ${V.P.addr}`} aria-roledescription="carousel"
        onKeyDown={(e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); } }}>
        <div className="rec-hero-frame">
        <button type="button" data-testid="subject-photo" className="rec-hero-main" aria-label={n ? `Open photo ${at + 1} of ${n} full size` : `Open Street View of ${V.P.addr}`}
          onClick={() => (n ? V.openPhotoShow(V.P.addr, photos, V.P.dealDbId, at) : V.P.lookups[0].go())}>
          {V.ready ? <PropertyPhoto photo={sized(photos[at] || '', 640)} street={V.P.streetSafe || V.P.imgSafe} alt={n ? `Photo ${at + 1} of ${V.P.addr}` : 'Street View of ' + V.P.addr} eager /> : null}
          {n ? <span className="rec-hero-count" aria-hidden>{at + 1} / {n}</span> : <span className="rec-hero-count" aria-hidden>Street View</span>}
        </button>
        {n > 1 ? (
          <>
            <button type="button" className="rec-hero-arrow rec-hero-prev rec-press" aria-label="Previous photo" onClick={() => step(-1)}><ChevronLeft size={16} aria-hidden /></button>
            <button type="button" className="rec-hero-arrow rec-hero-next rec-press" aria-label="Next photo" onClick={() => step(1)}><ChevronRight size={16} aria-hidden /></button>
          </>
        ) : null}
        </div>
        {n > 1 ? (
          <>
            <div ref={strip} className="rec-hero-strip" role="list">
              {photos.map((p, k) => (
                <button key={p + k} type="button" role="listitem" className="rec-hero-thumb" aria-label={`Photo ${k + 1}`} aria-current={k === at ? 'true' : undefined} onClick={() => setI(k)}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- static export, thumbnails of stored photos */}
                  <img src={sized(p, 160)} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="rec-hero-body">
        {triage ? <div data-testid="uw-triage-badge" className="rec-hero-triage" style={{ color: textTone(triageColor) }}>{triage.label} · {triage.hint}</div> : null}
        <div className="rec-hero-meta">
          {sub ? <><span style={label}>{sub.fromPartner ? 'Submitted by' : 'Sent in by'}</span><span title={sub.from}>{sub.from}{sub.submitted && sub.submitted !== '—' ? <span style={{ color: 'var(--meta, #71717a)' }}> · {sub.submitted}</span> : null}</span></>
            : V.P.source && V.P.source !== '—' ? <><span style={label}>Source</span><span>{V.P.source}</span></> : null}
          {V.P.market && V.P.market !== '—' ? <><span style={label}>Market</span><span>{V.P.market}</span></> : null}
          <span style={label}>APN</span><span className="rec-hero-apn" title={`APN ${V.P.apn}`}>{V.P.apn}</span>
        </div>
        <div className="rec-hero-links">
          {V.P.lookups.map((l) => <button key={l.label} type="button" className="rec-link" onClick={l.go} title={`Open ${l.label} in a popup`}>{l.label}</button>)}
          <button type="button" className="rec-link" onClick={V.openPropertyData}>Property data</button>
          <button type="button" className="rec-link" onClick={V.openMap}>Map</button>
          <button type="button" className="rec-link" onClick={V.openPhotos}>Photos</button>
        </div>
        <div className="rec-hero-actions">
          <button type="button" className="dc2 rec-press rec-ghost" onClick={() => V.sendComprReport('seller')} title="Text the COMPR seller report" style={small}>Seller share</button>
          <button type="button" className="dc2 rec-press rec-ghost" onClick={() => V.sendComprReport('buyer')} title="Text the COMPR buyer report" style={small}>Buyer share</button>
          {V.comprPhotoGap ? (
            <button type="button" data-testid="compr-rerun-photos" className="rec-link" onClick={V.rerunComprPhotos} title={`COMPR graded ${V.comprPhotoGap.graded} of the ${V.comprPhotoGap.own} photos on this record. Re-run with all of them.`}>
              Re-run COMPR with all {V.comprPhotoGap.own} photos
            </button>
          ) : null}
        </div>
        {o.history ? <div className="rec-hero-history"><OfferHistory h={o.history} refreshKey={String(o.sent ?? '')} /></div> : null}
      </div>
      {V.showUnderwriterChips ? <div className="rec-hero-foot"><UnderwriterStages V={V} /></div> : null}
    </section>
  );
}
