'use client';

// The deal page's overview: the numbers in one strip across the top, and the
// house's details in one card. Everything a rep looks for on a deal used to
// sit in three columns of a narrow rail; these put it where the eye lands.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { InlineField } from '@/components/ds/InlineField';
import { parseMoney } from './record-logic';
import { label } from './ui';

const money = (n: number | null) => (n == null ? '—' : '$' + n.toLocaleString('en-US'));
/** $75K, $1.2M: the range has to fit one cell. */
const short = (n: number | null) => (n == null ? '—' : n >= 1_000_000 ? '$' + (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0) + 'M' : n >= 1000 ? '$' + Math.round(n / 1000) + 'K' : '$' + n);

/** Asking, ARV, rehab, MAO, the offer range and the gap to asking: what the deal is worth, at a glance. */
export function KeyNumbers({ V }: { V: ClozrView }) {
  const o = V.offerCard;
  const asking = parseMoney(V.P.asking || '');
  const gap = asking != null && o.mao != null ? asking - o.mao : null;
  const cells: { k: string; v: string; hint?: string; tone?: string }[] = [
    { k: 'Asking', v: asking != null ? money(asking) : '—' },
    { k: 'ARV', v: o.arvLabel },
    { k: 'Est. rehab', v: o.rehabLabel },
    { k: 'MAO', v: o.maoLabel },
    { k: 'Offer range', v: o.low != null || o.high != null ? `${short(o.low)} – ${short(o.high)}` : '—' },
    {
      k: 'Asking over MAO',
      v: gap == null ? '—' : gap <= 0 ? 'At or under' : money(gap),
      hint: gap == null ? 'Needs asking and MAO' : gap <= 0 ? 'Asking is at or under MAO' : 'How far asking is above MAO',
      tone: gap == null ? undefined : gap <= 0 ? '#0A8560' : '#b45309',
    },
  ];
  return (
    <section aria-label="Key numbers" className="rec2-card rec2-numbers" data-testid="key-numbers">
      {cells.map((c) => (
        <div key={c.k} className="rec2-number" title={c.hint ?? (c.k === 'Offer range' ? `${money(o.low)} – ${money(o.high)}` : undefined)}>
          <div style={label}>{c.k}</div>
          <div className="rec-money" style={{ fontSize: '19px', fontWeight: 700, letterSpacing: '-0.02em', marginTop: '4px', color: c.v === '—' ? '#71717a' : c.tone ?? '#18181b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c.v}
          </div>
        </div>
      ))}
    </section>
  );
}

/** Property facts editable on the card (lot has no column yet). */
const PROP_FIELDS: Record<string, string> = {
  Beds: 'property.beds',
  Baths: 'property.baths',
  Sqft: 'property.sqft',
  Year: 'property.year',
  Type: 'property.type',
};

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="rec2-row">
      <dt style={label}>{k}</dt>
      <dd style={{ margin: 0, minWidth: 0, fontSize: '13px', fontWeight: 500, color: '#18181b' }}>{children}</dd>
    </div>
  );
}

const plain = (v: string | null | undefined) => (v && v.trim() && v !== '—' ? v : '—');

/**
 * The house and the seller's situation, as a list: what the rep reads before
 * every call. `bare`: inside the record's Details tab, which is already the card.
 */
export function PropertyDetails({ V, bare }: { V: ClozrView; bare?: boolean }) {
  const canEdit = !!V.liveIds?.canWrite || !V.liveIds;
  const facts = V.propFacts || [];
  return (
    <section aria-labelledby="rec2-prop-title" className={bare ? 'rec2-sec' : 'rec2-card'} data-testid="property-details">
      <div className="rec2-card-head">
        <h2 id="rec2-prop-title" className="rec2-title">Property details</h2>
        {V.canEditAddress ? (
          <button type="button" data-testid="property-edit-address" className="rec2-link rec-press" onClick={V.editAddress}>{V.hasAddress ? 'Edit address' : 'Set address'}</button>
        ) : null}
      </div>
      <dl className="rec2-list">
        <Row k="Address">
          <span title={[V.P.addr, V.P.cityLine.replace(/^[\s,]+|[\s,]+$/g, '')].filter(Boolean).join(', ')} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {[V.P.addr, V.P.cityLine.replace(/^[\s,]+|[\s,]+$/g, '')].filter(Boolean).join(', ')}
          </span>
        </Row>
        {facts.map((f) => {
          const field = PROP_FIELDS[f.k];
          const value = f.v == null || f.v === '' || f.v === 0 || f.v === '0' || f.v === '—' ? '—' : String(f.v);
          return (
            <Row key={f.k} k={f.k === 'Sqft' ? 'Square feet' : f.k === 'Year' ? 'Year built' : f.k === 'Lot' ? 'Lot size' : f.k === 'Type' ? 'Property type' : f.k}>
              {field ? (
                <span className="rec-money" data-testid={`compr-${f.k.toLowerCase()}`}>
                  <InlineField recordId={V.P.id} field={'card:' + field} label={f.k} type={field === 'property.type' ? 'text' : 'number'}
                    value={value === '—' ? null : field === 'property.type' ? value : Number(value.replace(/,/g, '')) || null}
                    format={() => (value === '—' ? '' : value)} placeholder="Add"
                    readOnly={canEdit ? false : 'Read-only: you can’t edit this record'}
                    onSave={(v) => V.saveSellerField(field, v)} />
                </span>
              ) : <span className="rec-money">{value}</span>}
            </Row>
          );
        })}
        <Row k="APN"><span className="rec-money">{plain(V.P.apn)}</span></Row>
        <Row k="Occupancy">{plain(V.P.occupancy)}</Row>
        <Row k="Condition">{plain(V.P.condition)}</Row>
        <Row k="Motivation">{plain(V.P.motivation)}</Row>
        <Row k="Timeline">{plain(V.P.timeline)}</Row>
        <Row k="Source">{plain(V.P.source)}</Row>
      </dl>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '12px' }}>
        {V.P.lookups.map((l) => (
          <button key={l.label} type="button" className="rec2-chip rec-press" onClick={l.go} title={`Open ${l.label} in a popup`}>{l.label}</button>
        ))}
        <button type="button" className="rec2-chip rec-press" onClick={V.openPropertyData}>Property data</button>
        <button type="button" className="rec2-chip rec-press" onClick={V.openMap}>Map</button>
        <button type="button" className="rec2-chip rec-press" onClick={V.openPhotos}>Photos</button>
      </div>
    </section>
  );
}
