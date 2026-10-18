'use client';

// How to reach a buyer, edited where it sits, the way the seller record's
// "What we know" does it: the main phone and email edit in place, the other
// numbers (buyer_phones) and other addresses (buyer_emails, migration 162)
// list under them, each one calls, texts or emails like the main one, and
// anyone who can edit buyers adds one, removes one or makes it the main one.
// Plus who the buyer is assigned to.

import React, { useCallback, useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ContactField } from '@/components/ContactField';
import { openReach } from '@/app/components/record/reach';
import type { BuyerEmailRow, BuyerPhoneRow } from '@/lib/database.types';
import {
  addBuyerEmail, addBuyerPhone, loadBuyerEmails, loadBuyerPhoneRows, otherEmails, promoteBuyerEmail, promoteBuyerPhone,
  removeBuyerEmail, removeBuyerPhone,
} from '@/lib/buyer-contacts';
import { otherNumbers } from '@/lib/seller-phones';
import { formatPhone } from '@/lib/talkr';

const row = (mobile: boolean): React.CSSProperties => ({
  display: 'grid', gridTemplateColumns: mobile ? 'minmax(0,86px) minmax(0,1fr)' : '88px 1fr', gap: '10px',
  padding: '8px 0', borderBottom: '1px solid var(--divider-2, #f0f0f1)', fontSize: '12.5px', alignItems: 'baseline',
});
const badge = (color: string, bg: string): React.CSSProperties => ({ fontSize: '10px', fontWeight: 700, color, background: bg, borderRadius: '5px', padding: '1px 5px', letterSpacing: '0.02em' });
const quiet: React.CSSProperties = { border: 0, background: 'none', color: 'var(--subtle, #a1a1aa)', cursor: 'pointer', fontSize: '12px', padding: 0 };
const line: React.CSSProperties = { marginTop: '3px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 };

/** "+ Add …" that turns into a one-line input; Enter adds, Escape closes. */
function AddLine({ label, type, placeholder, onAdd }: { label: string; type: 'tel' | 'email'; placeholder: string; onAdd: (v: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (draft === null || !draft.trim()) return;
    setBusy(true);
    const done = await onAdd(draft.trim());
    setBusy(false);
    if (done) setDraft(null);
  };
  if (draft === null) return <button type="button" onClick={() => setDraft('')} style={{ ...quiet, display: 'block', marginTop: '4px' }}>+ {label}</button>;
  return (
    <span style={{ marginTop: '4px', display: 'flex', gap: '4px', alignItems: 'center', minWidth: 0 }}>
      <input autoFocus value={draft} disabled={busy} type={type} aria-label={label} placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void go(); if (e.key === 'Escape') setDraft(null); }}
        style={{ height: '26px', minWidth: 0, width: '100%', padding: '0 7px', border: '1px solid #0A8560', borderRadius: '7px', fontSize: '12.5px', outline: 0 }} />
      <button type="button" onClick={() => void go()} disabled={busy} style={{ height: '26px', padding: '0 8px', border: 0, borderRadius: '7px', background: '#0A8560', color: '#fff', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>Add</button>
    </span>
  );
}

export function BuyerContact({ V }: { V: ClozrView }) {
  const ws = V.liveIds?.workspaceId ?? null;
  const buyerId = V.B.dbId;
  const canWrite = !!V.liveIds?.canWrite;
  const live = ws != null && buyerId != null;
  const toast = V.showToast;
  const phone = V.B.phone === '—' ? '' : V.B.phone;
  const email = V.B.email === '—' || !V.B.email.includes('@') ? '' : V.B.email;
  const [phones, setPhones] = useState<BuyerPhoneRow[]>([]);
  const [emails, setEmails] = useState<BuyerEmailRow[]>([]);

  const reload = useCallback(async () => {
    if (ws == null || buyerId == null) return;
    const [p, e] = await Promise.all([loadBuyerPhoneRows(ws, buyerId), loadBuyerEmails(ws, buyerId)]);
    setPhones(p);
    setEmails(e);
  }, [ws, buyerId]);
  useEffect(() => {
    let alive = true;
    // Keyed by buyer in the parent, so a new buyer starts empty.
    if (ws == null || buyerId == null) return;
    void Promise.all([loadBuyerPhoneRows(ws, buyerId), loadBuyerEmails(ws, buyerId)]).then(([p, e]) => {
      if (!alive) return;
      setPhones(p);
      setEmails(e);
    });
    return () => { alive = false; };
  }, [ws, buyerId]);

  const after = (r: { ok: boolean; added?: boolean; message?: string }, ok: string) => {
    if (!r.ok) { toast(r.message || 'That did not save.'); return false; }
    toast(r.added === false ? (r.message || 'Already on file') : ok);
    void reload();
    return true;
  };
  // The main phone and email are the buyer's own row: that buyer re-reads, not the workspace.
  const savedRow = () => (buyerId != null ? V.refreshBuyerCrm(buyerId) : V.reloadCrm());
  const reachAt = (ch: 'text' | 'email', to: { phone?: string; email?: string }) => openReach(ch, {
    name: V.B.name, phone: to.phone ?? phone, email: to.email ?? email, buyerId: buyerId ?? undefined, audience: 'buyer',
  });
  const promote = async (kind: 'phone' | 'email', r: BuyerPhoneRow | BuyerEmailRow) => {
    if (ws == null || buyerId == null) return;
    const res = kind === 'phone'
      ? await promoteBuyerPhone(ws, buyerId, r as BuyerPhoneRow, phone)
      : await promoteBuyerEmail(ws, buyerId, r as BuyerEmailRow, email);
    if (!res.ok) return toast(res.message || 'That did not save.');
    toast(kind === 'phone' ? 'Main number changed' : 'Main email changed');
    savedRow();
    void reload();
  };

  const mobile = !!V.isMobile;
  const others = otherNumbers(phone, phones);
  const moreEmails = otherEmails(email, emails);
  return (
    <div data-testid="buyer-contact">
      <div style={row(mobile)}>
        <span style={{ color: 'var(--meta, #71717a)' }}>Phones</span>
        <div style={{ minWidth: 0 }}>
          <ContactField field="phone" sellerId={null} buyerId={buyerId} value={phone} canWrite={canWrite} onSaved={savedRow} onToast={toast}>
            {phone ? <a href="#" className="clozr-contact" onClick={(e) => { e.preventDefault(); V.callBuyer(); }} style={{ fontWeight: 500 }}>{phone}</a> : <span style={{ color: 'var(--subtle, #a1a1aa)' }}>—</span>}
          </ContactField>
          {others.map((r) => {
            const label = formatPhone(r.phone);
            const bad = !!r.is_dnc || (r.kind ?? '').toLowerCase() === 'wrong';
            return (
              <div key={r.id} style={line}>
                {bad ? (
                  <span className="clozr-contact" style={{ fontWeight: 500, color: 'var(--meta, #71717a)' }}>{label}</span>
                ) : (
                  <a href="#" className="clozr-contact" onClick={(e) => { e.preventDefault(); V.callBuyerAt(r.phone, r.id); }} style={{ fontWeight: 500 }}>{label}</a>
                )}
                {r.is_dnc ? <span style={badge('#b91c1c', 'var(--tint-red, #fef2f2)')}>DNC</span> : null}
                {(r.kind ?? '').toLowerCase() === 'wrong' ? <span style={badge('#b45309', 'var(--tint-amber, #fffbeb)')} title="Marked as a wrong number">Wrong</span> : null}
                {!bad ? <button type="button" onClick={() => reachAt('text', { phone: r.phone })} title={`Text ${label}`} style={{ ...quiet, color: 'var(--tx-mint, #0a8560)', fontSize: '11.5px' }}>Text</button> : null}
                {canWrite && live && !bad ? <button type="button" onClick={() => void promote('phone', r)} title="Make this their main number" style={{ ...quiet, fontSize: '11.5px' }}>Make main</button> : null}
                {canWrite && live ? (
                  <button type="button" title={`Remove ${label}`} aria-label={`Remove ${label}`} onClick={() => ws != null && void removeBuyerPhone(ws, r.id).then((x) => after(x, 'Number removed'))} style={quiet}>×</button>
                ) : null}
              </div>
            );
          })}
          {canWrite && live ? (
            <AddLine label="Add number" type="tel" placeholder="(210) 555-0100" onAdd={async (v) => after(await addBuyerPhone(ws!, buyerId!, phone, v), 'Number added')} />
          ) : null}
        </div>
      </div>
      <div style={row(mobile)}>
        <span style={{ color: 'var(--meta, #71717a)' }}>Emails</span>
        <div style={{ minWidth: 0, fontWeight: 500 }}>
          <ContactField field="email" sellerId={null} buyerId={buyerId} value={email} canWrite={canWrite} onSaved={savedRow} onToast={toast}>
            {email ? <a href="#" className="clozr-contact" onClick={(e) => { e.preventDefault(); reachAt('email', { email }); }}>{email}</a> : <span style={{ color: 'var(--subtle, #a1a1aa)' }}>—</span>}
          </ContactField>
          {moreEmails.map((r) => (
            <div key={r.id} style={{ ...line, fontWeight: 500 }}>
              <a href="#" className="clozr-contact" onClick={(e) => { e.preventDefault(); reachAt('email', { email: r.email }); }} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</a>
              {canWrite && live ? <button type="button" onClick={() => void promote('email', r)} title="Make this their main email" style={{ ...quiet, fontSize: '11.5px', fontWeight: 400 }}>Make main</button> : null}
              {canWrite && live ? (
                <button type="button" title={`Remove ${r.email}`} aria-label={`Remove ${r.email}`} onClick={() => ws != null && void removeBuyerEmail(ws, r.id).then((x) => after(x, 'Email removed'))} style={quiet}>×</button>
              ) : null}
            </div>
          ))}
          {canWrite && live ? (
            <AddLine label="Add email" type="email" placeholder="name@example.com" onAdd={async (v) => after(await addBuyerEmail(ws!, buyerId!, email, v), 'Email added')} />
          ) : null}
        </div>
      </div>
      <div style={row(mobile)}>
        <span style={{ color: 'var(--meta, #71717a)' }}>Assigned to</span>
        <select aria-label="Assigned to" value={V.B.assignedId} disabled={!canWrite && live} onChange={(e) => V.B.assignTo(e.target.value)}
          style={{ border: 0, background: 'transparent', font: 'inherit', fontWeight: 500, color: 'var(--ink, #18181b)', cursor: 'pointer', padding: 0, minWidth: 0 }}>
          <option value="">Unassigned</option>
          {V.B.assignOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
    </div>
  );
}
