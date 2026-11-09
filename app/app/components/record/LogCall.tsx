'use client';

/**
 * Log call, the composer's fourth tab on both records: the outcome picker
 * (No answer, Left voicemail, Wrong number and the rest, plus the offer
 * outcomes once a seller has an offer out) through the same saveOutcome
 * Today uses, with their numbers to pick from when they have more than one.
 * Call rings the picked number through the floating dialer.
 *
 * The seller's target plans stage, task and drip; the buyer's (useClozr
 * buyerLogTarget) is the outcome and the note on the buyer. Same chips,
 * same keys, same card.
 */

import React, { useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import type { ClozrView } from '@/app/clozr/view';
import { OutcomePicker } from '@/app/components/talkr/OutcomePicker';
import { loadBuyerPhoneRows } from '@/lib/buyer-contacts';
import { loadSellerPhones, otherNumbers } from '@/lib/seller-phones';
import { formatPhone } from '@/lib/talkr';
import { ghostBtn } from './ui';

type Num = { id: number; phone: string; kind: string | null };

export function LogCall({ V, kind = 'seller' }: { V: ClozrView; kind?: 'seller' | 'buyer' }) {
  const buyer = kind === 'buyer';
  const target = V.recordLogCall;
  const ws = V.liveIds?.workspaceId ?? null;
  const recordId = buyer ? V.B.dbId ?? null : V.liveIds?.sellerId ?? null;
  const name = buyer ? V.B.name || V.B.company : V.P.name;
  const rawPhone = buyer ? V.B.phone : V.P.phone;
  const primary = rawPhone && rawPhone !== '—' ? rawPhone : '';
  const [others, setOthers] = useState<Num[]>([]);
  const [picked, setPicked] = useState<string>('');
  useEffect(() => {
    if (ws == null || recordId == null) return;
    let alive = true;
    const load = buyer
      ? loadBuyerPhoneRows(ws, recordId).then((rows) => rows.filter((r) => r.phone !== primary && !r.is_dnc).map((r) => ({ id: r.id, phone: r.phone, kind: r.kind ?? null })))
      : loadSellerPhones(ws, [recordId]).then((m) => otherNumbers(primary, m.get(recordId) ?? []).filter((r) => !r.is_wrong && !r.is_dnc).map((r) => ({ id: r.id, phone: r.phone, kind: r.kind ?? null })));
    void load.then((list) => { if (alive) setOthers(list); });
    return () => { alive = false; };
  }, [ws, recordId, primary, buyer]);
  const numbers: Num[] = [...(primary ? [{ id: 0, phone: primary, kind: 'main' }] : []), ...others];
  const sel = numbers.find((n) => String(n.id) === picked) ?? numbers[0];
  const call = () => {
    if (!sel) return;
    if (buyer) { if (sel.id) V.callBuyerAt(sel.phone, sel.id); else V.callBuyer(); return; }
    if (sel.id) V.callPersonAt(sel.phone, sel.id); else V.callPerson();
  };
  if (!target) {
    return <p className="rec-smart-hint" style={{ padding: '12px 16px' }}>Open a {buyer ? 'buyer' : 'seller'} record to log a call.</p>;
  }
  if (V.recordReadOnly) {
    return <p className="rec-smart-hint" style={{ padding: '12px 16px' }}>Read-only: you can’t log a call on this record.</p>;
  }
  return (
    <div className="rec-compose-form" data-testid="record-log-call">
      <OutcomePicker
        key={target.key}
        V={V}
        target={target}
        variant="card"
        armed
        canPick
        offer={!buyer && V.recordOutcome ? 'also' : undefined}
        keysInside
        plans={buyer ? [] : V.outcomeDrips}
        heading="How did the call go?"
        saveLabel="Log call"
      />
      {numbers.length ? (
        <div className="rec-compose-foot" style={{ marginTop: '8px' }}>
          {numbers.length > 1 ? (
            <>
              <label htmlFor="rec-log-number" style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', flex: 'none' }}>Number</label>
              <select id="rec-log-number" value={String(sel?.id ?? '')} onChange={(e) => setPicked(e.target.value)} className="dc17"
                style={{ height: '28px', maxWidth: '100%', minWidth: 0, borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', padding: '0 8px', fontSize: '12.5px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)' }}>
                {numbers.map((n) => (
                  <option key={n.id} value={String(n.id)}>{name} ({formatPhone(n.phone)}){n.kind ? ` (${n.kind})` : ''}</option>
                ))}
              </select>
            </>
          ) : (
            <span style={{ fontSize: '12px', color: 'var(--meta, #71717a)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <strong style={{ color: 'var(--ink, #18181b)', fontWeight: 600 }}>{name}</strong> ({formatPhone(numbers[0].phone)})
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="dc2 rec-press" onClick={call} style={{ ...ghostBtn, height: '28px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <Phone size={13} aria-hidden />Call
          </button>
        </div>
      ) : null}
    </div>
  );
}
