// The seller record's calendar: this seller's appointments, coming and gone,
// with the same panel as the Calendar screen and an "Add to calendar" that
// books one for them — invitation included, when they have an email.
//
// Drop-in: the integrator mounts it on SellerRecord with the live ids.
//   <RecordCalendar workspaceId={V.liveIds.workspaceId} sellerId={V.liveIds.sellerId} sellerName={V.P.name}
//                   sellerEmail={V.P.email} sellerPhone={V.P.phone} address={V.P.property.addr} me={userId} onToast={V.showToast} />
'use client';

import React, { useMemo, useState } from 'react';
import { type CalEvent, fmtDay, fmtSpan, typeColor, useCalendar, useTeam } from '@/lib/calendar';
import { EventPanel, type PanelDraft } from './EventPanel';
import { INK, LINE, MINT, MUTED, SOFT, SyncDot, dark, ghost } from './ui';
import { Mark } from '@/components/ds/mark';

export function RecordCalendar({ workspaceId, sellerId, sellerName, sellerEmail, sellerPhone, address, me, canWrite = true, onToast }: {
  workspaceId: number | null;
  sellerId: number | null;
  sellerName: string;
  sellerEmail?: string | null;
  sellerPhone?: string | null;
  address?: string | null;
  /** The signed-in user's id. */
  me: string | null;
  canWrite?: boolean;
  onToast?: (msg: string) => void;
}) {
  const now = useMemo(() => new Date(), []);
  const cal = useCalendar(workspaceId, now, now, { sellerId });
  const team = useTeam(workspaceId, me);
  const [open, setOpen] = useState<{ event: CalEvent | null; draft: PanelDraft | null; key: string } | null>(null);
  const [showPast, setShowPast] = useState(false);

  const upcoming = cal.events.filter((e) => e.end >= now).sort((a, b) => a.start.getTime() - b.start.getTime());
  const past = cal.events.filter((e) => e.end < now);
  const email = (sellerEmail ?? '').trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const add = () => {
    const st = new Date(); st.setDate(st.getDate() + 1); st.setHours(10, 0, 0, 0);
    setOpen({
      event: null, key: `new:${Date.now()}`,
      draft: {
        start: st, end: new Date(st.getTime() + 3_600_000), kind: 'Appointment', title: `Appointment · ${sellerName}`,
        location: address ?? '', seller_id: sellerId, sellerName,
        suggest: valid ? [{ email, name: sellerName, role: 'seller', status: 'needsAction' }] : [],
        attendees: valid ? [{ email, name: sellerName, role: 'seller', status: 'needsAction' }] : [],
      },
    });
  };

  const rep = (id: string | null) => team.find((t) => t.user_id === id);

  const row = (ev: CalEvent) => {
    const r = rep(ev.repId);
    const sel = open?.event?.id === ev.id;
    return (
      <button key={ev.id} type="button" className="dc19" onClick={() => setOpen({ event: ev, draft: null, key: ev.id })} style={{
        display: 'grid', gridTemplateColumns: '16px 1fr auto', gap: '8px', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: '6px',
        border: `1px solid ${sel ? INK : LINE}`, borderRadius: '8px', background: '#fff', cursor: 'pointer',
      }}>
        <span style={{ color: r?.color ?? typeColor(ev.type), display: 'inline-flex', marginTop: '5px' }}><Mark label={ev.kind} /></span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: '11px', color: MUTED }}>{fmtDay(ev.start)} · {fmtSpan(ev)} · {ev.kind}{r ? ` · ${r.user_id === me ? 'me' : r.full_name}` : ''}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 600, marginTop: '1px', lineHeight: 1.35, color: INK }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</span>
            <SyncDot state={ev.syncState} />
          </span>
          {ev.attendees.length ? (
            <span style={{ display: 'block', fontSize: '11px', color: MUTED, marginTop: '2px' }}>
              {ev.attendees.map((a) => `${a.name ?? a.email}${a.status === 'accepted' ? ' ✓' : a.status === 'declined' ? ' ✕' : a.status === 'tentative' ? ' ?' : ''}`).join(', ')}
            </span>
          ) : null}
        </span>
        <span style={{ fontSize: '11px', color: ev.end < now ? '#a1a1aa' : MINT, fontWeight: 600, whiteSpace: 'nowrap' }}>{ev.end < now ? 'Past' : relative(ev.start, now)}</span>
      </button>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontSize: '11.5px', color: MUTED, fontWeight: 600, flex: 1 }}>
          Appointments{cal.events.length ? ` · ${upcoming.length} upcoming` : ''}
        </span>
        {canWrite && workspaceId && sellerId ? (
          <button type="button" className="dc10" onClick={add} style={{ ...dark, height: '28px' }}>+ Add</button>
        ) : null}
      </div>

      {open ? (
        <div style={{ marginBottom: '10px' }}>
          <EventPanel key={open.key} inline workspaceId={workspaceId} userId={me} reps={team} canWrite={canWrite} event={open.event} draft={open.draft} onClose={() => setOpen(null)} onChanged={cal.reload} onToast={onToast} />
        </div>
      ) : null}

      {!workspaceId || !sellerId ? (
        <p style={{ margin: 0, fontSize: '12px', color: '#a1a1aa' }}>Sign in to see this seller&rsquo;s appointments.</p>
      ) : cal.loading ? (
        <p style={{ margin: 0, fontSize: '12px', color: MUTED }}>Loading…</p>
      ) : !cal.ok ? (
        <p style={{ margin: 0, fontSize: '12px', color: '#b91c1c' }}>Couldn&rsquo;t load appointments. <button type="button" onClick={cal.reload} style={{ ...ghost, height: '24px', marginLeft: '6px', fontSize: '11.5px' }}>Retry</button></p>
      ) : (
        <>
          {upcoming.length ? upcoming.map(row) : (
            <p style={{ margin: '0 0 6px', fontSize: '12px', color: '#a1a1aa', lineHeight: 1.5 }}>
              Nothing booked with {sellerName.split(' ')[0] || 'this seller'}.{valid ? ' Adding one emails them a calendar invitation.' : sellerPhone ? ' No email on file, so the invite would be by phone.' : ''}
            </p>
          )}
          {past.length ? (
            <div style={{ marginTop: '4px', paddingTop: '6px', borderTop: `1px solid ${SOFT}` }}>
              <button type="button" onClick={() => setShowPast((v) => !v)} style={{ background: 'none', border: 0, padding: 0, fontSize: '11.5px', color: MUTED, cursor: 'pointer', fontWeight: 600 }}>
                {showPast ? 'Hide' : 'Show'} {past.length} past
              </button>
              {showPast ? <div style={{ marginTop: '6px' }}>{past.map(row)}</div> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function relative(d: Date, now: Date): string {
  const days = Math.round((d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `In ${days} days`;
  return `In ${Math.round(days / 7)} wk`;
}
