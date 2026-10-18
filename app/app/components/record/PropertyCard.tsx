'use client';

// Who this is and what they own: the identity block, and the property card.
// The card is the house and the deal in one: photo, facts, the one Open in
// COMPR (Run COMPR when it never ran), COMPR's numbers and the low/high band, the underwriter's stage chips
// right under that band, then the offer against asking and Make offer.

import React, { useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { TypeChip } from '@/components/TypeChip';
import { DEAL_TYPES } from '@/lib/deal-types';
import { comprBtn, ghostBtn, hint, label, primaryBtn } from './ui';
import { OfferHistory, OfferVsAsking, UnderwriterStages } from './OfferCard';
import { PropertyPhoto } from '@/components/PropertyPhoto';
import { ComprIcon } from '@/components/ds/ComprIcon';
import { nextOfferBand } from './record-logic';
import { InlineField } from '@/components/ds/InlineField';
import { RepPicker } from '@/components/ds/RepPicker';
import { Mail, MapPin, Phone } from 'lucide-react';

export function Identity({ V, compact }: { V: ClozrView; compact?: boolean }) {
  return (
    <div>
      {compact ? null : <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <span aria-hidden style={{ width: '44px', height: '44px', borderRadius: '10px', background: '#dcfce7', color: '#15803d', display: 'grid', placeItems: 'center', fontSize: '15px', fontWeight: 700, flex: 'none' }}>
          {V.P.initials}
        </span>
        <div style={{ minWidth: 0 }}>
          <EditableName V={V} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px', fontSize: '12px', color: 'var(--muted, #52525b)' }}>
            <TypeChip kind="Seller" />
            {V.P.market}
          </div>
          <div style={{ marginTop: '3px', fontSize: '12px', color: 'var(--muted, #52525b)' }}>Last communication <span style={{ color: 'var(--ink-2, #27272a)' }}>{V.lastTouch}</span></div>
        </div>
      </div>}
      {compact ? null : (
        <div className="rec-contact" data-testid="record-contact-rows">
          <div className="rec-contact-row">
            <Phone size={13} aria-hidden />
            {V.P.phone && V.P.phone !== '—' ? (
              <>
                <button type="button" className="rec-contact-link" onClick={V.callPerson} title="Call (C)">{V.P.phone}</button>
                <button type="button" className="rec-contact-act" onClick={() => V.openQuickReach('text')} title="Text (T)">Send text</button>
              </>
            ) : <span className="rec-contact-none">No phone</span>}
          </div>
          <div className="rec-contact-row">
            <Mail size={13} aria-hidden />
            {V.P.email.includes('@') ? (
              <button type="button" className="rec-contact-link" onClick={() => V.openQuickReach('email')} title="Email (E)" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{V.P.email}</button>
            ) : <span className="rec-contact-none">No email</span>}
          </div>
          <div className="rec-contact-row" style={{ alignItems: 'flex-start' }}>
            <MapPin size={13} aria-hidden style={{ marginTop: '6px' }} />
            {V.P.addr && V.P.addr !== '—' ? (() => {
              const full = [V.P.addr, V.P.cityLine.replace(/^,\s*|\s+$/g, '').replace(/,\s*$/, '')].filter((x) => x && x.trim() && x.trim() !== ',').join(', ');
              return (
                <a className="rec-contact-link" href={'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(full)} target="_blank" rel="noopener noreferrer"
                  title="Open in Google Maps" style={{ minWidth: 0, lineHeight: 1.35, padding: '4px 0', color: 'var(--ink-2, #27272a)' }}>
                  {full}
                </a>
              );
            })() : V.canEditAddress ? <button type="button" className="rec-contact-act" onClick={V.editAddress}>Add address</button> : <span className="rec-contact-none">No address</span>}
          </div>
        </div>
      )}
      <div style={{ marginTop: compact ? 0 : '10px', display: 'grid', gap: '3px', fontSize: '12px', color: '#71717a' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '8px', margin: '2px 0 4px' }}>
          <RepPicker label="Assigned to" team={V.team} roles={['acq']} value={V.P.assignedId || null} noneLabel="Unassigned"
            onChange={(id) => V.P.assignTo(id ?? '')} readOnlyReason={V.recordReadOnly} />
          <RepPicker label="Underwriter" team={V.team} roles={['underwriter']} value={V.P.underwriterId || null} noneLabel="Nobody"
            onChange={(id) => V.P.underwriterTo(id ?? '')} readOnlyReason={V.recordReadOnly} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          Deal type
          {V.P.dealType ? (() => {
            const tone = DEAL_TYPES.find((t) => t.label === V.P.dealType);
            return <span style={{ padding: '1px 8px', borderRadius: '999px', background: tone?.bg ?? '#f4f4f5', color: tone?.fg ?? '#27272a', fontSize: '12px', fontWeight: 750 }}>{V.P.dealType}</span>;
          })() : <span style={{ color: '#a1a1aa', fontWeight: 650 }}>Not set</span>}
        </div>
      </div>
    </div>
  );
}

function BandField({ testId, title, amount, setByHand, onSave }: { testId: string; title: string; amount: number | null; setByHand?: boolean; onSave: (n: number | null) => boolean | Promise<boolean> }) {
  const shown = amount == null ? '' : amount.toLocaleString('en-US');
  const [text, setText] = useState(shown);
  const [shownSnap, setShownSnap] = useState(shown);
  if (shown !== shownSnap) {
    setShownSnap(shown);
    setText(shown);
  }
  const [focused, setFocused] = useState(false);
  const skip = useRef(false);
  return (
    <div data-testid={testId}>
      <div style={{ ...label, display: 'flex', alignItems: 'baseline', gap: '6px' }}>
        {title}
        {setByHand ? (
          <button type="button" data-testid={testId + '-by-hand'} onClick={() => void onSave(null)}
            title="Set by hand, so COMPR leaves it alone. Click to follow COMPR's offer again."
            style={{ border: 0, background: 'none', padding: 0, font: 'inherit', color: '#b45309', fontWeight: 600, cursor: 'pointer' }}>
            by hand, reset
          </button>
        ) : null}
      </div>
      <input
        aria-label={title}
        inputMode="decimal"
        value={text}
        placeholder="—"
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setFocused(false);
          if (skip.current) { skip.current = false; return; }
          const next = nextOfferBand(amount, text);
          if (next === 'keep') { setText(shown); return; }
          void Promise.resolve(onSave(next)).then((ok) => { if (!ok) setText(shown); });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') {
            e.preventDefault();
            skip.current = true;
            setText(shown);
            e.currentTarget.blur();
          }
        }}
        className="rec-money"
        style={{
          display: 'block', width: '100%', marginTop: '2px', padding: 0, border: 0, background: 'transparent',
          fontSize: '15px', fontWeight: 700, letterSpacing: '-0.02em', fontFamily: 'inherit',
          color: text.trim() ? '#18181b' : '#a1a1aa', outline: 'none',
          boxShadow: focused ? 'inset 0 -1px 0 #18181b' : 'none', borderRadius: 0,
        }}
      />
    </div>
  );
}

function factValue(facts: { k: string; v: string | number }[] | undefined, key: string): string {
  const hit = (facts || []).find((f) => f.k === key);
  const v = hit?.v;
  if (v == null || v === '' || v === 0 || v === '0' || v === '—') return '—';
  return String(v);
}

/** Property facts editable on the card (lot has no column yet). */
const PROP_FIELDS: Record<string, string> = {
  Beds: 'property.beds',
  Baths: 'property.baths',
  Sqft: 'property.sqft',
  Year: 'property.year',
  Type: 'property.type',
};

/**
 * `side`: the deal page's right column, where Property details already shows
 * the facts, the lookups and the APN, so the card is the photo, COMPR, the
 * underwriting and the offer.
 */
export function PropertyCard({ V, side = false }: { V: ClozrView; side?: boolean }) {
  const o = V.offerCard;
  const canEdit = !!V.liveIds?.canWrite || !V.liveIds;
  const triage = V.propertyUwTriage;
  const triageBorder = triage?.bucket === 'green' ? '2px solid #16a34a'
    : triage?.bucket === 'decline' ? '2px solid #dc2626'
      : triage?.bucket === 'review' ? '2px solid #ca8a04'
        : '1px solid #e4e4e7';
  const rule: React.CSSProperties = { borderTop: '1px solid #f0f0f1' };
  return (
    <div data-testid="record-property" style={{ border: triageBorder, borderRadius: '12px', overflow: 'hidden', background: '#fff' }}>
      <button type="button" data-testid="subject-photo" onClick={() => (V.P.photos.length ? V.openPhotoShow(V.P.addr, V.P.photos, V.P.dealDbId) : V.P.lookups[0].go())}
        aria-label={V.P.photos.length ? `View photos of ${V.P.addr}` : `Open Street View of ${V.P.addr}`}
        style={{ position: 'relative', display: 'block', width: '100%', height: '130px', padding: 0, border: 0, background: '#e4e4e7', cursor: 'pointer', textAlign: 'left' }}>
        {V.ready ? <PropertyPhoto photo={V.P.photos?.[0] || ''} street={V.P.streetSafe || V.P.imgSafe} alt={'Photo of ' + V.P.addr} eager /> : null}
        {V.P.photos.length > 1 ? <span style={{ position: 'absolute', right: '10px', top: '10px', background: 'rgba(12,14,18,.72)', color: '#fff', fontSize: '11px', fontWeight: 600, borderRadius: '6px', padding: '2px 7px', zIndex: 1 }}>{V.P.photos.length} photos</span> : null}
        <span aria-hidden style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg,transparent 40%,rgba(0,0,0,.55))' }} />
        <span style={{ position: 'absolute', left: '12px', right: '12px', bottom: '10px', color: '#fff' }}>
          <span style={{ display: 'block', fontWeight: 650, fontSize: '13.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{V.P.addr}</span>
          <span style={{ display: 'block', fontSize: '11.5px', opacity: 0.9 }}>{V.P.cityLine}</span>
        </span>
      </button>

      <div style={{ padding: '10px 12px 12px' }}>
        {triage ? (
          <div data-testid="uw-triage-badge" style={{ ...hint, marginBottom: '10px', padding: '6px 8px', borderRadius: '8px', background: triage.bucket === 'green' ? '#f0fdf4' : triage.bucket === 'decline' ? '#fef2f2' : '#fefce8', color: triage.bucket === 'green' ? '#15803d' : triage.bucket === 'decline' ? '#b91c1c' : '#a16207', fontWeight: 600 }}>
            {triage.label} — {triage.hint}
          </div>
        ) : null}
        {side ? null : <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '6px' }}>
          {V.P.lookups.map((l) => (
            <button key={l.label} type="button" className="dc2 rec-press rec-ghost" onClick={l.go} title={`Open ${l.label} in a popup`}
              style={{ ...ghostBtn, height: '28px', padding: '0 6px', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {l.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '10px 8px', marginTop: '12px' }}>
          {(V.propFacts || []).map((f) => {
            const field = PROP_FIELDS[f.k];
            const value = factValue(V.propFacts, f.k);
            return (
              <div key={f.k} data-testid={field ? `compr-${f.k.toLowerCase()}` : undefined} style={{ minWidth: 0 }}>
                <div style={label}>{f.k}</div>
                {field ? (
                  <div className="rec-money" style={{ fontSize: '13.5px', fontWeight: 600, marginTop: '2px', maxWidth: '100%' }}>
                    <InlineField recordId={V.P.id} field={'card:' + field} label={f.k} type={field === 'property.type' ? 'text' : 'number'}
                      value={value === '—' ? null : field === 'property.type' ? value : Number(value.replace(/,/g, '')) || null}
                      format={() => (value === '—' ? '' : value)} placeholder="Add"
                      readOnly={canEdit ? false : 'Read-only: you can’t edit this record'}
                      onSave={(v) => V.saveSellerField(field, v)} />
                  </div>
                ) : (
                  <div className="rec-money" style={{ fontSize: '13.5px', fontWeight: 600, marginTop: '2px' }}>{value}</div>
                )}
              </div>
            );
          })}
        </div>
        </>}
        {V.comprLinked ? (
          <button type="button" data-testid="open-in-compr" className="clozr-compr-btn rec-press rec-compr" onClick={V.openCompr}
            title="The COMPR report in its own window. Put it on your second screen once; every next house opens there."
            style={{ ...comprBtn, width: '100%', height: '32px', marginTop: side ? 0 : '14px' }}>
            <span style={{ color: '#7fcbb2', display: 'inline-flex' }}><ComprIcon size={14} /></span>
            Open in COMPR
          </button>
        ) : (
          <button type="button" data-testid="run-compr" className="clozr-compr-btn rec-press rec-compr" onClick={V.runCompr}
            disabled={V.comprRunning} aria-busy={V.comprRunning || undefined}
            title="Underwrites this house in COMPR with every photo on the record. ARV, rehab and MAO fill in below."
            style={{ ...comprBtn, width: '100%', height: '32px', marginTop: side ? 0 : '14px', ...(V.comprRunning ? { opacity: 0.7, cursor: 'progress' } : null) }}>
            <span style={{ color: '#7fcbb2', display: 'inline-flex' }}><ComprIcon size={14} /></span>
            {V.comprRunning ? 'Running COMPR…' : 'Run COMPR'}
          </button>
        )}
        {V.comprPhotoGap ? (
          <div data-testid="compr-photo-gap" style={{ ...hint, marginTop: '6px' }}>
            COMPR graded {V.comprPhotoGap.graded} of the {V.comprPhotoGap.own} photos on this record.{' '}
            <button type="button" data-testid="compr-rerun-photos" className="rec-press" onClick={V.rerunComprPhotos}
              title="Re-runs this COMPR report in place (same link) with every photo on the record. One COMPR run."
              style={{ border: 0, background: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: '#0A8560', cursor: 'pointer', textDecoration: 'underline' }}>
              Re-run with them
            </button>
          </div>
        ) : (
          <div data-testid={V.comprLinked ? undefined : 'compr-not-run'} style={{ ...hint, marginTop: '6px' }}>
            {V.comprLinked ? 'ARV, rehab and MAO you move in COMPR save here.'
              : V.comprRunning ? 'COMPR is underwriting this house. About a minute.'
                : 'COMPR has not run this house yet. One run fills ARV, rehab and MAO.'}
          </div>
        )}
      </div>

      <section data-testid="record-underwrite" aria-label="Underwriting" style={{ ...rule, padding: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
          <span style={label}>{o.basis}</span>
          <span style={{ ...label, whiteSpace: 'nowrap' }}>{o.status}</span>
        </div>
        <div className="rec-money" style={{ fontSize: '24px', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.2, marginTop: '2px', color: o.mao === null ? '#71717a' : '#18181b' }}>{o.maoLabel}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '8px', marginTop: '10px' }}>
          {([['ARV', o.arvLabel], ['Rehab', o.rehabLabel], ['Contract', o.contract]] as const).map(([k, v]) => (
            <div key={k} style={{ minWidth: 0 }}>
              <div style={label}>{k}</div>
              <div className="rec-money" style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(v)}>{v}</div>
            </div>
          ))}
        </div>
        <div data-testid="compr-offer-band" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #f0f0f1' }}>
          <BandField testId="offer-low" title="Low offer" amount={o.low} setByHand={o.lowSet} onSave={(n) => V.saveOfferBand('low', n)} />
          <div style={{ paddingLeft: '12px', borderLeft: '1px solid #f0f0f1' }}>
            <BandField testId="offer-high" title="High offer" amount={o.high} setByHand={o.highSet} onSave={(n) => V.saveOfferBand('high', n)} />
          </div>
        </div>
        {V.showUnderwriterChips ? <UnderwriterStages V={V} /> : null}
      </section>

      <section data-testid="record-offer" aria-label="Offer" style={{ ...rule, padding: '12px' }}>
        <OfferVsAsking V={V} />
        <button type="button" className="dc3 rec-press rec-primary" onClick={() => V.openOfferSheet(V.P.id)} title="Make offer (O)" style={{ ...primaryBtn, width: '100%', height: '32px', marginTop: '10px' }}>
          Make offer
        </button>
        <div style={{ ...hint, marginTop: '6px' }}>
          {o.mao === null ? (V.comprLinked ? 'No MAO yet: open it in COMPR first, or type an amount in the sheet.' : 'No MAO yet: run COMPR above, or type an amount in the sheet.') : 'Prefilled from the MAO. Logs it on the deal; nothing is sent.'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '10px' }}>
          <button type="button" className="dc2 rec-press rec-ghost" onClick={() => V.sendComprReport('seller')} title="Text the COMPR seller report"
            style={{ ...ghostBtn, height: '28px', fontSize: '12px', padding: '0 8px' }}>Seller share</button>
          <button type="button" className="dc2 rec-press rec-ghost" onClick={() => V.sendComprReport('buyer')} title="Text the COMPR buyer report"
            style={{ ...ghostBtn, height: '28px', fontSize: '12px', padding: '0 8px' }}>Buyer share</button>
        </div>
        {o.history ? <OfferHistory h={o.history} refreshKey={String(o.sent ?? '')} /> : null}
      </section>

      {side ? null : <div style={{ ...rule, padding: '10px 12px 12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', gap: '6px' }}>
          <button type="button" className="dc2 rec-press rec-ghost" onClick={V.openPropertyData} style={{ ...ghostBtn, height: '28px', fontSize: '12px', padding: 0, whiteSpace: 'nowrap' }}>Property data</button>
          <button type="button" className="dc2 rec-press rec-ghost" onClick={V.openMap} style={{ ...ghostBtn, height: '28px', fontSize: '12px', padding: 0, whiteSpace: 'nowrap' }}>Map</button>
          <button type="button" className="dc2 rec-press rec-ghost" onClick={V.openPhotos} style={{ ...ghostBtn, height: '28px', fontSize: '12px', padding: 0, whiteSpace: 'nowrap' }}>Photos</button>
        </div>
        <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11.5px', color: '#71717a' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`APN ${V.P.apn}`}>APN {V.P.apn}</span>
          {V.canEditAddress ? (
            <button type="button" data-testid="property-edit-address" className="rec-press" onClick={V.editAddress}
              style={{ border: 0, background: 'none', padding: '4px 0', color: '#0A8560', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {V.hasAddress ? 'Edit address' : 'Set address'}
            </button>
          ) : null}
        </div>
      </div>}
    </div>
  );
}

/**
 * The seller's name, click to edit (components/ds/InlineField): Enter or
 * leaving the box saves, Esc cancels and never saves, a refused name stays in
 * the box with the reason under it.
 */
export function EditableName({ V, as: Tag = 'h1', style }: { V: ClozrView; as?: 'h1' | 'span'; style?: React.CSSProperties }) {
  const h1: React.CSSProperties = style ?? { margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' };
  return (
    <Tag style={{ ...h1, minWidth: 0 }}>
      <InlineField recordId={V.P.id} field="name" label="Seller name" type="text" value={V.P.name}
        readOnly={V.recordReadOnly || false} onSave={(v) => V.P.rename(v == null ? '' : String(v))} />
    </Tag>
  );
}
