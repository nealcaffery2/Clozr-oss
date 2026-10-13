'use client';

// "File under deal": a searchable, sortable list of the deals in the pipeline
// (under contract through closed). Leads' Prospect deal sheets are not places
// to file mail by hand; the sync files those itself when an email names them.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DealRef } from '../data';

export const PIPELINE_ORDER = ['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow', 'Closed'];
const STAGE_SHORT: Record<string, string> = {
  'Under Contract Seller': 'Under contract', 'Ready To Market': 'Marketing', 'Buyer Under Contract': 'Buyer UC', 'In Escrow': 'In escrow', Closed: 'Closed',
};
type Sort = 'stage' | 'address' | 'seller';

const stageIdx = (s: string | null | undefined) => PIPELINE_ORDER.indexOf(s ?? '');

/** The deals mail can be filed under by hand: the pipeline, one per street and seller. */
export function pipelineDeals(deals: DealRef[]): DealRef[] {
  const seen = new Set<string>();
  return deals.filter((d) => d.id != null && stageIdx(d.stage) >= 0).filter((d) => {
    const k = `${d.label.toLowerCase()}|${(d.who ?? '').toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function DealPicker({ deals, current, onPick, onClose }: {
  deals: DealRef[];
  current: number | null;
  onPick: (dealId: number | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('stage');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: MouseEvent) => { const t = e.target as HTMLElement; if (box.current && !box.current.contains(t) && !t.closest?.('[data-deal-picker-toggle]')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [onClose]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (d: DealRef) => !needle || `${d.label} ${d.who ?? ''} ${d.stage ?? ''} ${STAGE_SHORT[d.stage ?? ''] ?? ''}`.toLowerCase().includes(needle);
    const by = (a: DealRef, b: DealRef) =>
      sort === 'address' ? a.label.localeCompare(b.label, undefined, { numeric: true })
        : sort === 'seller' ? (a.who ?? '~').localeCompare(b.who ?? '~') || a.label.localeCompare(b.label)
          : stageIdx(a.stage) - stageIdx(b.stage) || a.label.localeCompare(b.label, undefined, { numeric: true });
    return pipelineDeals(deals).filter(hit).sort(by);
  }, [deals, q, sort]);

  const pick = (id: number | null) => { onPick(id); onClose(); };

  return (
    <div ref={box} role="dialog" aria-label="File under deal"
      style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40, width: 'min(420px, calc(100vw - 32px))', background: 'var(--surface, #fff)', border: '1px solid var(--line, #e4e4e7)', borderRadius: '12px', boxShadow: '0 12px 32px rgba(0,0,0,.14)', padding: '10px', display: 'grid', gap: '8px' }}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search address, seller or stage" aria-label="Search deals"
        onKeyDown={(e) => { if (e.key === 'Enter' && list[0]?.id != null) pick(list[0].id); }}
        style={{ height: '36px', padding: '0 12px', border: '1px solid var(--line, #e4e4e7)', borderRadius: '9px', fontSize: '13px', width: '100%', background: 'var(--bg, #fff)', color: 'inherit' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--muted, #71717a)' }}>
        <span>Sort</span>
        {(['stage', 'address', 'seller'] as Sort[]).map((s) => (
          <button key={s} type="button" onClick={() => setSort(s)} aria-pressed={sort === s}
            style={{ border: '1px solid var(--line, #e4e4e7)', borderRadius: '999px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', background: sort === s ? 'var(--accent-soft, #e7f5ef)' : 'transparent', color: sort === s ? 'var(--accent, #0A8560)' : 'inherit', fontWeight: sort === s ? 650 : 500 }}>
            {s === 'stage' ? 'Stage' : s === 'address' ? 'Address' : 'Seller'}
          </button>
        ))}
        <span style={{ marginLeft: 'auto' }}>{list.length} deal{list.length === 1 ? '' : 's'}</span>
      </div>
      <div style={{ maxHeight: '320px', overflowY: 'auto', display: 'grid', gap: '2px' }}>
        {current != null ? (
          <button type="button" onClick={() => pick(null)}
            style={{ textAlign: 'left', padding: '8px 10px', border: 0, borderRadius: '8px', background: 'transparent', cursor: 'pointer', color: 'var(--muted, #71717a)', fontSize: '13px' }}>
            Take it off this deal
          </button>
        ) : null}
        {list.map((d) => (
          <button key={d.id} type="button" onClick={() => pick(d.id!)} aria-current={d.id === current ? 'true' : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'left', padding: '8px 10px', border: 0, borderRadius: '8px', cursor: 'pointer', background: d.id === current ? 'var(--accent-soft, #e7f5ef)' : 'transparent', color: 'inherit' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
              {d.who && d.who !== d.label ? <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--muted, #71717a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.who}</span> : null}
            </span>
            <span style={{ flex: 'none', fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '999px', background: 'var(--chip, #f4f4f5)', color: 'var(--muted, #52525b)' }}>{STAGE_SHORT[d.stage ?? ''] ?? d.stage}</span>
          </button>
        ))}
        {!list.length ? <div style={{ padding: '10px', fontSize: '12.5px', color: 'var(--muted, #71717a)' }}>{q ? 'No pipeline deal matches that.' : 'No deals in the pipeline.'}</div> : null}
      </div>
    </div>
  );
}
