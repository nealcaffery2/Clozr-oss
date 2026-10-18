// The contract request across the shell: the dialer's popup, and the TC's
// alert. A request lands as a notifications row (request_contract, migration
// 272); this listens for the INSERT addressed to the signed-in member and
// opens a big centred alert on whatever screen she is on, with its own sound
// (Settings, Talkr, Sounds: "Contract request"). Several queue, one at a
// time. Later leaves it unread in the bell.
'use client';

import React, { useEffect, useId, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { supabase } from '@/lib/supabase';
import { playEvent } from '@/lib/phone-audio';
import { markNotificationRead } from '@/lib/crm-write';
import { useSoftphone, useWantLiveCalls } from '@/app/components/talkr/softphoneAdapter';
import { KIND_LABELS, type ContractKind } from '@/lib/contracts';
import { type RequestPayload, callStillLive, longDate } from '@/lib/contract-request';
import { markRequestSeen, recentRequestNotifications } from '@/lib/contract-request-api';
import { type RequestAlert, closeRequestDialog, dropAlert, pushAlert, setPendingContract, useRequestStore } from '@/lib/contract-request-store';
import { ContractRequestDialog } from './ContractRequestDialog';
import { C, Dialog, Glyph, btn } from './parts';

const LATER_KEY = 'clozr:contract-request-later';
const readLater = (): Set<number> => {
  try { return new Set(JSON.parse(sessionStorage.getItem(LATER_KEY) || '[]') as number[]); } catch { return new Set(); }
};
const rememberLater = (id: number) => {
  try { sessionStorage.setItem(LATER_KEY, JSON.stringify([...readLater(), id].slice(-50))); } catch { /* private mode: it may show again on reload */ }
};

type NotifRow = { id: number; user_id?: string | null; category?: string; title: string; created_at: string; contract_id?: number | null; payload?: (RequestPayload & { request_id?: number }) | null };

function toAlert(n: NotifRow): RequestAlert | null {
  if (!n.payload) return null;
  return { key: `n${n.id}`, notificationId: n.id, payload: { ...n.payload, contract_id: n.payload.contract_id ?? n.contract_id ?? null, title: n.payload.title || n.title }, createdAt: Date.parse(n.created_at) || Date.now(), demoAs: null };
}

export function ContractRequestHost({ V }: { V: ClozrView }) {
  const st = useRequestStore();
  const ws = V.liveIds?.workspaceId ?? null;
  const me = V.liveIds?.userId ?? null;

  // A request addressed to me: the moment it is filed, and any from the last
  // half hour still unread when the app opens (unless I pressed Later).
  useEffect(() => {
    const db = supabase;
    if (!db || !ws || !me) return;
    let live = true;
    void recentRequestNotifications(ws, me).then((rows) => {
      if (!live) return;
      const later = readLater();
      for (const n of rows) { const a = later.has(n.id) ? null : toAlert(n); if (a) pushAlert(a); }
    });
    const ch = db
      .channel(`contract-requests:${ws}:${me}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `workspace_id=eq.${ws}` }, (m) => {
        const n = m.new as NotifRow;
        if (n.user_id !== me || n.category !== 'Contract request') return;
        const a = toAlert(n);
        if (a) pushAlert(a);
      })
      .subscribe();
    return () => { live = false; void db.removeChannel(ch); };
  }, [ws, me]);

  const head = st.alerts[0] ?? null;
  return (
    <>
      {st.dialog ? <ContractRequestDialog key={st.dialog.seq} V={V} phone={st.dialog.phone} /> : null}
      {head ? <AlertModal key={head.key} V={V} alert={head} total={st.alerts.length} /> : null}
    </>
  );
}

/** Keeps the live-calls list fresh while an alert about a call is up. */
function WantLive() {
  useWantLiveCalls();
  return null;
}

function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  return m < 1 ? 'Just now' : m === 1 ? '1 min ago' : m < 60 ? `${m} min ago` : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function AlertModal({ V, alert, total }: { V: ClozrView; alert: RequestAlert; total: number }) {
  const titleId = useId();
  const p = alert.payload;
  const sp = useSoftphone();
  const [now] = useState(() => Date.now());
  const asker = (p.requester_name || 'A teammate').split(/\s+/)[0];
  const party = (p.party?.name || 'them').split(/\s+/)[0];
  const demo = !!alert.demoAs;
  // The demo's call is the scripted one on this screen; a real one is on Talkr's live list.
  const call = demo ? (V.callState === 'live' ? 'live' : 'none') : callStillLive(p.call_id, sp.liveCalls);
  const liveCall = !demo && p.call_id ? sp.liveCalls?.find((c) => c.call_id === p.call_id) ?? null : null;
  const busyOnCall = !demo && V.callState !== 'idle';

  // Its own sound, as each alert reaches the front (respects Settings, Sounds).
  useEffect(() => { playEvent('contract', p.title); }, [p.title]);

  const finish = () => {
    if (alert.notificationId) void markNotificationRead(`n${alert.notificationId}`);
    const rid = (p as RequestPayload & { request_id?: number }).request_id;
    if (rid) void markRequestSeen(rid, V.liveIds?.userId ?? null);
    dropAlert(alert.key);
  };
  const openDraft = () => {
    setPendingContract(demo ? alert.key.replace(/^demo:/, '') : p.contract_id ?? null);
    // The sample data shows both sides on one screen: the rep's popup goes with it.
    if (demo) closeRequestDialog();
    finish();
    V.goContracts();
  };
  const later = () => {
    if (alert.notificationId) rememberLater(alert.notificationId);
    dropAlert(alert.key);
  };
  const join = (mode: 'listen' | 'barge') => {
    if (demo) {
      V.showToast(mode === 'listen' ? `Sample data: on a live call this lets ${alert.demoAs} hear ${asker} and ${party} without being heard.` : `Sample data: on a live call this puts ${alert.demoAs} on ${asker}'s call with ${party}.`);
      return;
    }
    if (!liveCall) return;
    void sp.startMonitor(liveCall, mode);
    finish();
    V.goDialer();
  };

  const kind = KIND_LABELS[p.kind as ContractKind] ?? 'Contract';
  const facts: [string, string][] = [
    [p.party?.side === 'buyer' ? 'Buyer' : 'Seller', [p.party?.name, p.party?.phone].filter(Boolean).join(' · ') || 'Not given'],
    ['Price', p.price != null ? `$${Math.round(p.price).toLocaleString('en-US')}` : 'Not given'],
    ['Closing', p.closing_date ? longDate(p.closing_date) : 'Not given'],
    ['Contract', `${p.template_name || kind} · ${p.contract_id || demo ? 'draft ready' : 'no draft yet'}`],
  ];

  return (
    <Dialog labelledBy={titleId} onClose={later} width={540} z={140} scrimClose={false}>
      {p.call_id && !demo ? <WantLive /> : null}
      <div role="alert" aria-live="assertive" style={{ padding: '18px 20px 6px', display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 9px', borderRadius: 6, background: C.tint, color: C.accentHover, fontSize: 11.5, fontWeight: 650 }}>
            <Glyph name="file-signature" size={13} />
            Contract request
          </span>
          <span style={{ fontSize: 11.5, color: C.muted }}>{ago(alert.createdAt, now)}</span>
          {total > 1 ? <span style={{ marginLeft: 'auto', fontSize: 11.5, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>1 of {total}</span> : null}
        </div>
        {demo ? <div style={{ fontSize: 11.5, color: C.amber, fontWeight: 500 }}>{alert.demoAs}’s view · sample data</div> : null}
        <h2 id={titleId} style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.2, textWrap: 'balance' }}>{p.title}</h2>
        {p.address ? <div style={{ fontSize: 12.5, color: C.ink2 }}>{p.address}</div> : null}
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(70px, auto) 1fr', border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden' }}>
          {facts.map(([k, v], i) => (
            <React.Fragment key={k}>
              <dt style={{ padding: '8px 12px', fontSize: 11.5, color: C.muted, borderTop: i ? `1px solid ${C.hair}` : 0, background: C.page }}>{k}</dt>
              <dd style={{ margin: 0, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, borderTop: i ? `1px solid ${C.hair}` : 0, fontVariantNumeric: 'tabular-nums', minWidth: 0, overflowWrap: 'anywhere' }}>{v}</dd>
            </React.Fragment>
          ))}
        </dl>
        {p.notes ? (
          <div>
            <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 3 }}>{asker}’s notes</div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: C.ink2, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={p.notes}>{p.notes}</p>
          </div>
        ) : null}
        {call === 'live' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 10, background: C.tintPale, border: `1px solid ${C.tintLine}` }}>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 99, background: C.accent, flex: 'none' }} />
            <span style={{ flex: '1 1 180px', fontSize: 12.5, color: C.ink2 }}>{asker} is still on the call with {party}.</span>
            <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button type="button" onClick={() => join('listen')} disabled={busyOnCall} title={busyOnCall ? 'Finish your own call first' : 'Hear both sides; nobody hears you'} style={{ ...btn('ghost'), opacity: busyOnCall ? 0.5 : 1 }}>
              <Glyph name="headphones" size={14} />
              Listen
            </button>
            <button type="button" onClick={() => join('barge')} disabled={busyOnCall} title={busyOnCall ? 'Finish your own call first' : 'Join the call; everyone hears you'} style={{ ...btn('ghost'), opacity: busyOnCall ? 0.5 : 1 }}>
              <Glyph name="mic" size={14} />
              Barge
            </button>
            </span>
          </div>
        ) : call === 'no-access' ? (
          <p style={{ margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.45 }}>
            {asker} may still be on the call. Listening in needs the calls.monitor permission in Talkr; an admin adds it to your Talkr role.
          </p>
        ) : call === 'ended' ? (
          <p style={{ margin: 0, fontSize: 12, color: C.muted }}>The call has ended. The summary is on the draft.</p>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px 18px' }}>
        <button type="button" onClick={later} style={btn('quiet', 40)}>
          <Glyph name="clock" size={15} />
          Later
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" data-autofocus onClick={openDraft} style={btn('primary', 40)}>
          <Glyph name="file" size={15} />
          {p.contract_id || demo ? 'Open draft' : 'Open Contracts'}
        </button>
      </div>
    </Dialog>
  );
}
