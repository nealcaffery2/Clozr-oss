'use client';

/**
 * Incoming-call panel: who's calling, which property, their local time, and
 * accept/decline. Declining lets the server-side routing chain proceed to the
 * next rep or to voicemail (docs/inbound-routing.md).
 *
 * The caller's local time is shown before pickup on purpose — it is context
 * the rep uses in the first sentence.
 *
 * CLOZR seam (copied from Talkr apps/web/components/IncomingCall.tsx): the
 * CLOZR record behind the number fills in the name, address and stage when
 * Talkr has no contact for it, and the card carries `.talkr-dialer` tokens.
 */

import { useEffect, useState } from 'react';
import { api, type CallContextDto } from '@/lib/talkr-web/api';
import { fetchCallContext } from '@/lib/talkr-web/callContext';
import { useSoftphone } from './softphoneAdapter';
import { Icon, HangupIcon } from './Icon';
import { Avatar, Button } from './ui';
import { BAND_COLOR, BAND_LABEL, TempDot, degrees, oneLineAddress, tempBand } from './contacts';
import { ProspectTime } from './ProspectTime';
import { formatPhone } from '@/lib/talkr-web/time';
import type { ClozrRecord } from './CallContext';
import { loadCallbackTouch, talkrRoutingTouch, type CallbackTouch } from '@/lib/callback-touch';
import { callbackLine, type Touch } from '@/lib/rvm-pool';

/** Who to open when the number is not on a record's own phone but a drop went to it. */
export type CallbackLookup = {
  workspaceId: number | null;
  userId: string | null;
  /** This rep's Talkr user id: Talkr's routing note names the rep by it. */
  talkrUserId?: string | null;
  openSeller?: (id: number) => void;
  openBuyer?: (id: number) => void;
};

export function IncomingCall({ record = null, callback = null }: { record?: ClozrRecord | null; callback?: CallbackLookup | null }) {
  const { incoming, acceptIncoming, rejectIncoming } = useSoftphone();
  const [now, setNow] = useState<number | null>(null);
  // The full party — name, address, temperature — fetched the moment the
  // phone rings, so the first sentence can use it. The dialer's panel asks
  // for the same number and shares this fetch through the cache.
  const [ctx, setCtx] = useState<CallContextDto | null>(null);
  const from = incoming?.from ?? null;
  // The outreach this call answers: Talkr's routing note when it sends one,
  // else the latest ringless drop to this number in the last week.
  const [touch, setTouch] = useState<CallbackTouch | null>(null);
  const [routing, setRouting] = useState<ReturnType<typeof talkrRoutingTouch>>(null);
  const wsId = callback?.workspaceId ?? null;
  const talkrCallId = incoming?.talkrCallId ?? null;

  useEffect(() => {
    if (!incoming) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [incoming]);

  useEffect(() => {
    setCtx(null);
    if (!from || !/^\+\d{7,}$/.test(from)) return;
    let alive = true;
    fetchCallContext({ phone: from })
      .then((c) => alive && setCtx(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [from]);

  useEffect(() => {
    setTouch(null);
    if (!from || wsId == null) return;
    let alive = true;
    loadCallbackTouch(wsId, from).then((t) => alive && setTouch(t)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [from, wsId]);

  // Talkr says why this call rang here: reason 'last_contact' carries the touch.
  useEffect(() => {
    setRouting(null);
    if (!talkrCallId) return;
    let alive = true;
    api.getCall(talkrCallId).then((r) => alive && setRouting(talkrRoutingTouch(r.call))).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [talkrCallId]);

  if (!incoming) return null;

  const contact = ctx?.contact ?? null;
  const name = contact?.display_name ?? record?.name;
  const address = ctx?.property
    ? oneLineAddress(ctx.property)
    : contact?.address
      ? oneLineAddress(contact.address)
      : record?.address
        || null;
  const leadStatus = ctx?.lead?.status ?? record?.stage ?? null;
  const routed: Touch | null = routing ?? touch;
  const mine = !!routed?.rep_id && (routed.rep_id === callback?.userId || routed.rep_id === callback?.talkrUserId);
  const callbackText = routed ? callbackLine(routed, mine) : null;
  const openAttributed = !record && touch
    ? touch.seller_id != null && callback?.openSeller ? () => callback.openSeller!(touch.seller_id!)
      : touch.buyer_id != null && callback?.openBuyer ? () => callback.openBuyer!(touch.buyer_id!) : null
    : null;

  return (
    <div className="talkr-dialer fixed inset-x-0 top-6 z-50 mx-auto w-full max-w-md px-4">
      <div
        className="p-5"
        style={{
          borderRadius: 'var(--r-lg)',
          background: 'var(--ink)',
          border: '1px solid var(--dark-2)',
          boxShadow: '0 24px 60px rgba(0,0,0,.45)',
        }}
      >
        <div className="flex items-center gap-3.5">
          <span className="relative inline-flex h-14 w-14 items-center justify-center">
            <span
              className="absolute inset-0 rounded-full"
              style={{ background: 'var(--accent)', animation: 'ringpulse 1.6s ease-out infinite' }}
              aria-hidden
            />
            <Avatar name={name ?? formatPhone(incoming.from)} size={48} dark />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate" style={{ font: '600 17px/1.2 var(--sans)', color: '#fff' }}>
                {name ?? formatPhone(incoming.from)}
              </span>
              {contact && (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5"
                  title={`${degrees(contact.temperature_score)} engagement score`}
                  style={{ font: '700 10.5px/1 var(--sans)', color: BAND_COLOR[tempBand(contact.temperature, contact.temperature_score)] }}
                >
                  <TempDot temperature={contact.temperature} score={contact.temperature_score} />
                  {BAND_LABEL[tempBand(contact.temperature, contact.temperature_score)]}
                  <span style={{ color: 'var(--muted-2)', fontWeight: 500 }}>
                    {degrees(contact.temperature_score)}
                  </span>
                </span>
              )}
            </div>
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
              style={{ font: '500 12px/1.5 var(--sans)', color: 'var(--muted-2)' }}
            >
              <span className="truncate">
                {name ? formatPhone(incoming.from) : 'Incoming call'}
                {contact?.company ? ` · ${contact.company}` : ''}
              </span>
              <ProspectTime e164={incoming.from} tone="dark" now={now} size={11.5} />
            </div>
            {(address || leadStatus) && (
              <div className="truncate" style={{ font: '500 11px/1.5 var(--sans)', color: 'var(--muted)' }}>
                {address ?? ''}
                {leadStatus ? `${address ? ' · ' : ''}lead: ${leadStatus.replace(/_/g, ' ')}` : ''}
              </div>
            )}
            {callbackText && (
              <div className="truncate" data-testid="callback-attribution" style={{ font: '600 11px/1.5 var(--sans)', color: 'var(--accent)' }}>
                {callbackText}
                {openAttributed ? (
                  <button type="button" onClick={openAttributed} style={{ marginLeft: 6, padding: 0, border: 0, background: 'none', color: '#fff', textDecoration: 'underline', font: 'inherit', cursor: 'pointer' }}>
                    Open record
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex gap-3">
          <Button tone="green" className="flex-1" style={{ padding: '12px 0' }} onClick={acceptIncoming}>
            <Icon name="phone" size={16} />
            Accept
          </Button>
          <Button tone="red" className="flex-1" style={{ padding: '12px 0' }} onClick={rejectIncoming}>
            <HangupIcon size={16} />
            Decline
          </Button>
        </div>
      </div>
    </div>
  );
}
