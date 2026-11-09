'use client';

// The classic record's chip row over the activity stream (All, Calls, Texts,
// Email, Notes), with the timeline's User filter on the right. The chips are
// the view's `personTab`, so they switch instantly and a hand-off that names
// a tab still lands. The deal page (Settings › Try new design) draws the
// record's tab row instead (RecordTabs in ActivityStream.tsx).

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { keepInView } from '@/components/ds/keepInView';
import { Chevron, CZ, MenuCheck } from '@/components/ds/chrome';
import { ArrowDownUp, List, Mail, MessageSquare, Phone, StickyNote } from 'lucide-react';
import type { StreamOrder } from './ActivityStream';

const CHIP_ICON: Record<string, React.ReactNode> = {
  All: <List size={13} aria-hidden />, Calls: <Phone size={13} aria-hidden />, Texts: <MessageSquare size={13} aria-hidden />,
  Email: <Mail size={13} aria-hidden />, Notes: <StickyNote size={13} aria-hidden />,
};

type Chip = { label: string; pressed: boolean; count: number | null; go: () => void };
type UserMenu = ClozrView['timelineUserMenu'];

/**
 * `chips` and `userMenu` default to the seller record's; the buyer record
 * hands in its own. `order` + `onOrder`: the clock toggle beside User,
 * newest at the bottom (asc) or at the top.
 */
export function ActivityChips({ V, chips, userMenu, order, onOrder }: {
  V: ClozrView; chips?: Chip[]; userMenu?: UserMenu | null; order?: StreamOrder; onOrder?: (o: StreamOrder) => void;
}) {
  // null: no User filter (the vendor record).
  const f = userMenu === null ? null : userMenu ?? V.timelineUserMenu;
  const list: Chip[] = chips ?? V.recordChips;
  const orderLabel = order === 'asc' ? 'Newest at bottom' : 'Newest at top';
  return (
    <div data-tabs style={{ display: 'flex', alignItems: 'center', gap: '2px', padding: V.isMobile ? '0 12px' : '0 16px', borderBottom: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', flex: 'none', minWidth: 0 }}>
      <div role="group" aria-label="Filter activity" style={{ display: 'flex', gap: '2px', minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
        {list.map((c) => (
          <button key={c.label} type="button" className="rec-chip" aria-pressed={c.pressed} onClick={c.go}
            style={{ height: '40px', padding: V.isMobile ? '0 8px' : '0 10px', border: 0, borderBottom: `2px solid ${c.pressed ? 'var(--ink, #18181b)' : 'transparent'}`, background: 'none', cursor: 'pointer', fontSize: '12.5px', fontWeight: 500, color: c.pressed ? 'var(--ink, #18181b)' : 'var(--muted, #52525b)', marginBottom: '-1px', whiteSpace: 'nowrap', fontFamily: 'var(--font-sans)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            {CHIP_ICON[c.label] ?? null}{c.label}{c.count != null ? <span className="rec-chip-n">{c.count}</span> : null}
          </button>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      {onOrder ? (
        <button type="button" className="dc2 rec-press rec-order" onClick={() => onOrder(order === 'asc' ? 'desc' : 'asc')} aria-label={orderLabel} title={orderLabel} aria-pressed={order === 'desc'}>
          <ArrowDownUp size={14} aria-hidden />
        </button>
      ) : null}
      {f ? <div style={{ position: 'relative', marginRight: V.isMobile ? 0 : '10px', flex: 'none' }}>
        <button type="button" className="dc2 cz-menu-trigger" onClick={f.toggle} aria-expanded={f.open} aria-haspopup="true"
          aria-label={f.on ? `Activity by ${f.value}. Change who` : 'Filter activity by who did it'}
          style={{ height: '28px', padding: '0 10px', borderRadius: '8px', border: `1px solid ${f.border}`, background: f.bg, fontSize: '12px', cursor: 'pointer', color: f.color, fontWeight: f.on ? 600 : 500, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-sans)' }}>
          {f.on ? f.value : f.label}
          <Chevron size={11} color={f.on ? CZ.mint : CZ.faint} />
        </button>
        {f.open ? (
          <>
            <div onClick={V.closeFilterMenus} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
            <div ref={keepInView} style={{ position: 'absolute', top: '34px', right: 0, minWidth: '190px', background: 'var(--c-menu-bg)', border: '1px solid var(--c-menu-line)', borderRadius: '12px', boxShadow: 'var(--shadow-md)', zIndex: 45, padding: '4px' }}>
              {f.options.map((o) => (
                <button key={o.label} type="button" className="dc2" onClick={o.go} aria-pressed={o.on} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', width: '100%', minHeight: '30px', textAlign: 'left', padding: '6px 9px', border: 0, borderRadius: '7px', background: o.on ? 'var(--c-action-soft, #e7f5ef)' : 'none', cursor: 'pointer', fontSize: '12.5px', color: o.on ? 'var(--tx-mint-deep, #08694c)' : 'var(--ink-2, #27272a)', fontWeight: o.on ? 600 : 400, whiteSpace: 'nowrap' }}>
                  {o.label}
                  <MenuCheck on={o.on} />
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div> : null}
    </div>
  );
}
