'use client';

// The offer half of the property card (PropertyCard): offer made against
// asking, the underwriter's stage chips, and the offers-and-counters log.

import React, { useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { type OfferLine, listRecordOffers, logCounter, offerMoney } from '@/lib/offers';
import { PODIO_SUBMISSION_STAGES } from '@/lib/stages';
import { parseDollars } from '@/lib/money';
import { ghostBtn, label } from './ui';
import { InlineField } from '@/components/ds/InlineField';

type HistoryKey = { workspaceId: number; sellerId: number; dealId: number | null; canWrite: boolean };

/**
 * Every offer we made and every counter they came back with, newest first,
 * and a field to log their counter (migration 145 puts it on the timeline).
 */
export function OfferHistory({ h, refreshKey }: { h: HistoryKey; refreshKey: string }) {
  const [rows, setRows] = useState<OfferLine[] | null>(null);
  const [counter, setCounter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void listRecordOffers(h.workspaceId, h.sellerId, h.dealId).then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, [h.workspaceId, h.sellerId, h.dealId, refreshKey, tick]);
  async function save() {
    const typed = parseDollars(counter);
    if (typed.error) { setErr(typed.error); return; }
    const n = typed.value;
    if (!n) { setErr('Type their number.'); return; }
    setBusy(true); setErr(null);
    const r = await logCounter(h.workspaceId, { sellerId: h.sellerId, dealId: h.dealId, amount: n });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setCounter(''); setTick((t) => t + 1);
  }
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div data-testid="offer-history" style={{ marginTop: '12px' }}>
      <div style={label}>Offers and counters</div>
      {rows === null ? <div style={{ fontSize: '12px', color: '#71717a', marginTop: '4px' }}>Loading…</div>
        : !rows.length ? <div style={{ fontSize: '12px', color: '#71717a', marginTop: '4px' }}>None yet.</div>
          : rows.map((o) => (
            <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', padding: '3px 0' }}>
              <span style={{ color: o.direction === 'inbound' ? '#b45309' : '#18181b', fontWeight: 600 }}>
                {o.direction === 'inbound' ? 'Counter' : 'Offer'} <span className="rec-money">{offerMoney(o.amount)}</span>
              </span>
              <span style={{ color: '#71717a', whiteSpace: 'nowrap' }}>{o.direction === 'outbound' && o.status ? o.status + ' · ' : ''}{day(o.created_at)}</span>
            </div>
          ))}
      {h.canWrite ? (
        <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
          <input aria-label="Their counter" inputMode="decimal" placeholder="Their counter $" value={counter} onChange={(e) => setCounter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }}
            style={{ flex: 1, minWidth: 0, height: '28px', padding: '0 8px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12px' }} />
          <button type="button" className="dc2 rec-press" disabled={busy} onClick={() => void save()} style={{ ...ghostBtn, fontSize: '12px', padding: '0 10px', height: '28px' }}>{busy ? 'Saving…' : 'Log counter'}</button>
        </div>
      ) : null}
      {err ? <div style={{ fontSize: '11px', color: '#b91c1c', marginTop: '4px' }}>{err}</div> : null}
    </div>
  );
}

/**
 * The underwriter's fast path: the Podio submission stages as one-press
 * chips, right under the low/high band they set, so pricing a house and
 * moving it on happen in one place.
 */
export function UnderwriterStages({ V }: { V: ClozrView }) {
  const current = V.P.stage;
  const move = (stage: string) => {
    if (stage === current) return;
    V.stageOptions.find((o) => o.label === stage)?.go();
  };
  return (
    <div data-testid="offer-stage-chips" role="group" aria-label="Underwriting stage" style={{ marginTop: '12px' }}>
      <div style={label}>Underwriting stage</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
        {PODIO_SUBMISSION_STAGES.map((stage) => {
          const on = stage === current;
          return (
            <button
              key={stage}
              type="button"
              className="dc13 rec-press rec-chip"
              aria-pressed={on}
              title={on ? `${stage} (current)` : `Move to ${stage}`}
              onClick={() => move(stage)}
              style={{
                height: '28px', padding: '0 10px', borderRadius: '8px', border: 0,
                background: on ? '#18181b' : '#fff',
                boxShadow: on ? 'none' : 'var(--shadow-ring)',
                fontSize: '12px', cursor: 'pointer',
                color: on ? '#fff' : '#3f3f46', fontWeight: on ? 600 : 500,
                maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {stage}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const dollars = (v: string | null | undefined) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return v && /\d/.test(v) && Number.isFinite(n) && n > 0 ? n : null;
};
const short = (n: number) => (n >= 1000 ? '$' + Math.round(n / 1000).toLocaleString('en-US') + 'k' : '$' + n.toLocaleString('en-US'));

/**
 * What we offered next to what they asked for (the submission's asking
 * price), side by side, with the gap between them. Asking is editable here.
 */
export function OfferVsAsking({ V }: { V: ClozrView }) {
  const offer = V.offerCard.sent;
  const asking = V.P.asking && V.P.asking !== '—' ? V.P.asking : '—';
  const canEdit = !!V.liveIds?.canWrite || !V.liveIds;
  const o = dollars(offer);
  const a = dollars(asking);
  const gap = o != null && a != null ? o - a : null;
  const big: React.CSSProperties = { fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.2, marginTop: '2px', whiteSpace: 'nowrap' };
  return (
    <div data-testid="offer-vs-asking">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        <div data-testid="offer-made">
          <div style={label}>Offer made</div>
          <div className="rec-money" style={{ ...big, color: offer ? '#18181b' : '#71717a' }}>{offer || 'None yet'}</div>
        </div>
        <div data-testid="offer-asking" style={{ paddingLeft: '12px', borderLeft: '1px solid #f0f0f1' }}>
          <div style={label}>Asking</div>
          <div className="rec-money" style={{ ...big, color: a == null ? '#71717a' : '#18181b' }}>
            <InlineField recordId={V.P.id} field="offer-card:asking_price" label="Asking price" type="money" value={a}
              readOnly={canEdit ? false : 'Read-only: you can’t edit this record'} placeholder="Add asking"
              onSave={(v) => V.saveSellerField('asking_price', v)} />
          </div>
        </div>
      </div>
      {gap != null ? (
        <div data-testid="offer-gap" className="rec-money" style={{ marginTop: '6px', color: gap < 0 ? '#b45309' : '#0A8560', fontSize: '12px', fontWeight: 600 }}>
          {gap === 0 ? 'Offer matches asking' : `${short(Math.abs(gap))} ${gap < 0 ? 'under' : 'over'} asking · ${Math.round((o! / a!) * 100)}% of ask`}
        </div>
      ) : null}
    </div>
  );
}
