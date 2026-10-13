'use client';

// Make an offer: a centred sheet with the amount prefilled (the workspace's
// pricing rule when it answers, else the MAO) and ⌘⏎ to log it. Logging puts
// the price on the deal and the line on the timeline at once; nothing is sent
// and no letter is drafted. Same path from the offer card, the O key and the
// command bar's "send offer" (V.openOfferSheet).

import React, { useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { priceOffer } from '@/lib/offers';
import { offerCopy, parseMoney } from './record-logic';
import { parseDollars } from '@/lib/money';
import { eyebrow, ghostBtn, primaryBtn } from './ui';
import { useExit, useFocusTrap } from './useModal';

export function OfferSheet({ V }: { V: ClozrView }) {
  const copy = offerCopy({ live: V.isLiveData });
  const [amount, setAmount] = useState(V.offerCard.mao != null ? V.offerCard.mao.toLocaleString('en-US') : '');
  const [basis, setBasis] = useState(V.offerCard.mao != null ? V.offerCard.basis.replace('Max offer (MAO), ', 'MAO, ') : '');
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const { closing, close } = useExit(V.closeOfferSheet, 150);
  useFocusTrap(panel, close, 'input[name=amount]');

  // Live: what the workspace rule would offer now (Settings › Offers), when it has an answer.
  const ws = V.liveIds?.workspaceId ?? null;
  const sid = V.liveIds?.sellerId ?? null;
  useEffect(() => {
    if (ws == null || sid == null) return;
    let gone = false;
    void priceOffer(ws, sid).then((r) => {
      if (gone || !r.ok || r.data.amount == null) return;
      setAmount((cur) => (cur && parseMoney(cur) !== V.offerCard.mao ? cur : Math.round(r.data.amount!).toLocaleString('en-US')));
      setBasis('Workspace rule · ' + r.data.basis);
    });
    return () => { gone = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, sid]);

  const n = parseMoney(amount);
  const why = !n ? (amount.trim() && parseDollars(amount).error) || 'Enter an amount to log the offer.' : '';
  const submit = async () => {
    if (!n || busy) return;
    setBusy(true);
    const ok = await V.sendOfferFromSheet(n);
    setBusy(false);
    if (ok) close();
  };

  return (
    <div className="rec-backdrop" data-closing={closing || undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(12,13,16,.32)', display: 'grid', placeItems: 'center', padding: '16px' }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="rec-offer-title" className="rec-modal" data-closing={closing || undefined}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void submit(); } }}
        style={{ width: 'min(440px, 100%)', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto', background: '#fff', borderRadius: '14px', border: '1px solid #e4e4e7', boxShadow: '0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)', padding: '18px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
          <div>
            <div style={eyebrow}>Offer</div>
            <h2 id="rec-offer-title" style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Make an offer</h2>
            <div style={{ fontSize: '12px', color: '#71717a', marginTop: '2px' }}>To {V.P.name} · {V.P.addr}</div>
          </div>
          <button type="button" aria-label="Close" className="dc2 rec-press" onClick={close} style={{ ...ghostBtn, width: '30px', padding: 0, flex: 'none' }}>×</button>
        </div>

        <label style={{ display: 'block', marginTop: '14px' }}>
          <span style={{ ...eyebrow, fontSize: '10px' }}>Amount</span>
          <span style={{ display: 'flex', alignItems: 'center', marginTop: '5px', border: '1px solid #e4e4e7', borderRadius: '10px', padding: '0 12px', background: '#fafafa' }} className="dc21">
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#71717a' }}>$</span>
            <input name="amount" inputMode="numeric" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Offer amount"
              className="rec-money" style={{ flex: 1, minWidth: 0, height: '46px', border: 0, background: 'transparent', outline: 0, fontSize: '24px', fontWeight: 700, letterSpacing: '-0.02em', color: '#18181b', paddingLeft: '4px' }} />
          </span>
        </label>
        <div style={{ fontSize: '11.5px', color: '#71717a', marginTop: '5px' }}>
          {basis ? 'Prefilled from the ' + basis + '. ' : 'No MAO on this record yet. '}Change it if you need to.
        </div>

        <div style={{ marginTop: '12px' }}>
          <div style={{ ...eyebrow, fontSize: '10px' }}>When you log it</div>
          <ul style={{ margin: '6px 0 0', padding: '0 0 0 18px', listStyle: 'disc', fontSize: '12.5px', color: '#27272a', lineHeight: 1.55 }}>
            {copy.when.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px' }}>
          <span style={{ flex: 1, fontSize: '11.5px', color: why ? '#b45309' : '#a1a1aa' }}>{why || (V.isMobile ? '' : '⌘↵ to log')}</span>
          <button type="button" className="dc2 rec-press" onClick={close} style={ghostBtn}>Cancel</button>
          <button type="button" className="dc3 rec-press" disabled={!n || busy} title={why || undefined} onClick={() => void submit()}
            style={{ ...primaryBtn, opacity: !n || busy ? 0.5 : 1 }}>
            {busy ? 'Working…' : copy.action}
          </button>
        </div>
      </div>
    </div>
  );
}
