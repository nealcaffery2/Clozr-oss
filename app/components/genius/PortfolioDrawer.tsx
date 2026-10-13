// "View all": everything an owner holds, from RealEstateAPI's linked
// properties on one of their current buys — a list and a mini map, the total
// count and value, the last purchase. Cached per property, so the second look
// is free. A flipper who has sold everything nearby has no current buy to ask
// about, so the drawer shows the purchases this run found instead.
'use client';

import React, { useEffect, useState } from 'react';
import { type Candidate, KIND_COLOR, portfolio } from '@/lib/genius';
import { GeniusMap } from './GeniusMap';
import { FAINT, GREEN, HAIR, INK, MUTED, Modal, RED, btn, money, when } from './parts';

type Props = { workspaceId: number; c: Candidate; isMobile: boolean; onClose: () => void; onOpenBuyer?: (id: number) => void };
type Loaded = Awaited<ReturnType<typeof portfolio>>;

export function PortfolioDrawer({ workspaceId, c, isMobile, onClose, onOpenBuyer }: Props) {
  const held = c.purchases.find((p) => !p.resale_date && p.reapi_id);
  const [res, setRes] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!held) return;
    let live = true;
    void portfolio(workspaceId, held.reapi_id).then((r) => { if (live) setRes(r); });
    return () => { live = false; };
  }, [workspaceId, held]);

  const loading = !!held && !res;
  const list = res?.ok && res.data.properties.length ? res.data.properties : c.purchases.map((p) => ({
    reapi_id: p.reapi_id, address: p.address, city: p.city, state: p.state, zip: p.zip, lat: p.lat, lng: p.lng, property_type: p.property_type,
    beds: p.beds, baths: p.baths, sqft: p.sqft, est_value: p.est_value, last_sale_date: p.date, last_sale_amount: p.price,
  }));
  const total = (res?.ok ? res.data.total : null) ?? c.portfolio_count ?? list.length;
  const value = (res?.ok ? res.data.value : null) ?? c.portfolio_value ?? null;
  const pins = list.filter((p) => p.lat && p.lng).map((p) => ({ id: p.reapi_id || p.address, lat: p.lat!, lng: p.lng!, color: KIND_COLOR[c.kind], title: p.address }));
  const centre = pins[0] ? { lat: pins.reduce((a, p) => a + p.lat, 0) / pins.length, lng: pins.reduce((a, p) => a + p.lng, 0) / pins.length } : null;
  const spread = centre ? Math.max(1, ...pins.map((p) => Math.hypot(p.lat - centre.lat, (p.lng - centre.lng) * 0.8) * 69)) : 1;

  return (
    <Modal isMobile={isMobile} onClose={onClose} width={820} title={<span>{c.owner_name}<span style={{ color: FAINT, fontWeight: 500 }}> · portfolio</span></span>}>
      <div style={{ display: 'flex', gap: '22px', flexWrap: 'wrap', padding: '12px 16px', borderBottom: `1px solid ${HAIR}` }}>
        {[['Owned', total ? total.toLocaleString('en-US') : '—'], ['Total value', money(value)], ['Last purchase', when(list.map((p) => p.last_sale_date).filter(Boolean).sort().pop() ?? c.last_purchase)]].map(([k, v]) => (
          <div key={k}><div style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }}>{k}</div><div style={{ fontSize: '16px', fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>
        ))}
        {c.matched_buyer_id && onOpenBuyer ? <button type="button" onClick={() => onOpenBuyer(c.matched_buyer_id!)} style={{ ...btn('ghost'), marginLeft: 'auto', alignSelf: 'center', color: GREEN }}>Open their buyer record</button> : null}
      </div>
      {!held ? <div style={{ padding: '10px 16px 0', fontSize: '11.5px', color: MUTED }}>They have sold what they bought here, so there is no current property to pull their portfolio from. These are the purchases this search found.</div> : null}
      {res && !res.ok ? <div style={{ padding: '10px 16px 0', fontSize: '12px', color: RED }}>{res.message}</div> : null}
      {centre ? <div style={{ margin: '12px 16px 0', borderRadius: '10px', overflow: 'hidden', border: `1px solid ${HAIR}` }}><GeniusMap center={centre} radiusMi={Math.min(40, spread)} pins={pins} height={220} /></div> : null}
      <div style={{ padding: '6px 16px 14px' }}>
        {loading ? <div style={{ padding: '18px 0', fontSize: '12.5px', color: FAINT }}>Loading their properties…</div> : list.map((p, i) => (
          <div key={(p.reapi_id || p.address) + i} style={{ display: 'flex', gap: '10px', alignItems: 'baseline', padding: '8px 0', borderTop: `1px solid ${HAIR}`, fontSize: '12px' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.address}, {p.city} {p.state} {p.zip}</span>
              <span style={{ color: MUTED }}>{p.property_type ?? ''} · {p.beds ?? '?'}/{p.baths ?? '?'} · {p.sqft ? `${p.sqft.toLocaleString('en-US')} sf` : '—'}{p.est_value ? ` · worth ~${money(p.est_value)}` : ''}</span>
            </span>
            <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <span style={{ display: 'block', fontWeight: 650, color: INK }}>{p.last_sale_amount ? money(p.last_sale_amount) : 'Not disclosed'}</span>
              <span style={{ color: FAINT }}>{when(p.last_sale_date)}</span>
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
