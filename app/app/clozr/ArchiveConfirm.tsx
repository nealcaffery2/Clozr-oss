// The one archive prompt: Shift+Delete on People and the seller record,
// Ctrl+A on Buyers (lib/people-keys), the bulk bar's Archive, and a deal or
// submission archived from anywhere. Keyboard first: No is picked when it
// opens, left/right (or Tab) move between No and Yes, Enter answers with the
// one picked, Y and N answer directly, Escape is No. A seller's open deals go
// with them unless the box is unticked; a deal offers its seller, unticked,
// when this was their last open deal.
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { confirmKey, type ConfirmChoice } from '@/lib/people-keys';
import type { ArchiveAsk } from './useClozr';

const btn: React.CSSProperties = {
  flex: 1, height: '38px', borderRadius: '10px', font: 'inherit', fontSize: '13.5px', fontWeight: 600, cursor: 'pointer',
};

export function ArchiveConfirm({ ask, onAnswer }: { ask: ArchiveAsk; onAnswer: (yes: boolean, alsoDeals: boolean) => void }) {
  const [pick, setPick] = useState<ConfirmChoice>('no');
  // The box: a seller's deals (on unless unticked), or a deal's seller (off unless ticked).
  const [alsoDeals, setAlsoDeals] = useState(ask.kind !== 'deal');
  const live = useRef({ pick, alsoDeals, onAnswer });
  useEffect(() => { live.current = { pick, alsoDeals, onAnswer }; });
  const noRef = useRef<HTMLButtonElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { (pick === 'yes' ? yesRef : noRef).current?.focus(); }, [pick]);

  useEffect(() => {
    // Capture, so the list's own arrows and Enter never see these keys.
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const r = confirmKey(e.key, live.current.pick);
      if (!r) return;
      e.preventDefault();
      e.stopPropagation();
      if ('pick' in r) setPick(r.pick);
      else live.current.onAnswer(r.answer === 'yes', live.current.alsoDeals);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const n = ask.ids.length;
  const noun = {
    seller: n === 1 ? 'person' : 'people', buyer: n === 1 ? 'buyer' : 'buyers',
    deal: n === 1 ? 'deal' : 'deals', vendor: n === 1 ? 'vendor' : 'vendors',
  }[ask.kind];
  const who = n === 1 ? ask.names[0] : `${n.toLocaleString('en-US')} ${noun}`;
  const shown = ask.names.slice(0, 4).join(', ') + (n > 4 ? ` and ${(n - 4).toLocaleString('en-US')} more` : '');
  const d = ask.deals.length;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="archive-ask-title" data-testid="archive-confirm"
      onClick={() => onAnswer(false, alsoDeals)}
      style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(24,24,27,.45)', display: 'grid', placeItems: 'center', padding: '16px' }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '400px', background: '#fff', borderRadius: '14px', padding: '18px', boxShadow: '0 28px 60px -24px rgba(18,22,45,.4)' }}>
        <div id="archive-ask-title" style={{ fontSize: '15px', fontWeight: 650, color: '#18181b' }}>Archive {who}?</div>
        <div style={{ fontSize: '12.5px', color: '#52525b', marginTop: '6px', lineHeight: 1.5 }}>
          {n > 1 ? <>{shown}. </> : null}
          {ask.kind === 'deal'
            ? 'It leaves the Deals board, the deal list and Dispo everywhere, including its dispo campaign lists. Nothing is deleted: Deals → Archived brings it back.'
            : 'They leave every list, but nothing is deleted.'}
        </div>
        {ask.kind === 'deal' && ask.seller ? (
          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginTop: '10px', fontSize: '12.5px', color: '#27272a', cursor: 'pointer' }}>
            <input type="checkbox" data-testid="archive-seller-too" checked={alsoDeals} onChange={(e) => setAlsoDeals(e.target.checked)} style={{ marginTop: '2px' }} />
            <span>Also archive the seller, {ask.seller.name}, in People. This was their last open deal.</span>
          </label>
        ) : null}
        {d > 0 ? (
          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginTop: '10px', fontSize: '12.5px', color: '#27272a', cursor: 'pointer' }}>
            <input type="checkbox" checked={alsoDeals} onChange={(e) => setAlsoDeals(e.target.checked)} style={{ marginTop: '2px' }} />
            <span>
              Also archive {d === 1 ? 'their open deal' : `their ${d} open deals`} ({ask.deals.slice(0, 3).map((x) => x.addr).join(', ')}{d > 3 ? '…' : ''}). Off the Deals board, the deal list and Dispo.
            </span>
          </label>
        ) : null}
        <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
          <button ref={noRef} type="button" data-testid="archive-no" onClick={() => onAnswer(false, alsoDeals)} onFocus={() => setPick('no')}
            style={{ ...btn, border: `2px solid ${pick === 'no' ? '#18181b' : '#e4e4e7'}`, background: '#fff', color: '#18181b' }}>
            No
          </button>
          <button ref={yesRef} type="button" data-testid="archive-yes" onClick={() => onAnswer(true, alsoDeals)} onFocus={() => setPick('yes')}
            style={{ ...btn, border: `2px solid ${pick === 'yes' ? '#991b1b' : '#fecaca'}`, background: pick === 'yes' ? '#dc2626' : '#fef2f2', color: pick === 'yes' ? '#fff' : '#b91c1c' }}>
            Yes, archive
          </button>
        </div>
        <div style={{ fontSize: '11.5px', color: '#71717a', marginTop: '10px', textAlign: 'center' }}>
          ← → to choose · Enter to answer · Y / N · Esc is No
        </div>
      </div>
    </div>
  );
}
