// Everyone on one contract, under its row on the Contracts card: who has
// signed, approved or handed it on; approve or reject when it is waiting on
// you; fix a typo'd email or phone and send the link again; add someone.
'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CenteredDialog } from '@/components/ContractsHub';
import { AddRecipientDialog } from '@/components/AddRecipientDialog';
import {
  type ContractRecipient, type ContractRow, answerApproval, deliveredText, listRecipients, updateContractRecipient,
} from '@/lib/contracts';
import { linkLabel, updateCrmContact } from '@/lib/contract-recipients';

const field: React.CSSProperties = { width: '100%', height: '32px', padding: '0 9px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '12.5px', outline: 0, background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)' };
const link: React.CSSProperties = { fontSize: '12px', color: 'var(--tx-mint, #0a8560)', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: 500 };
const btn = (primary = false, danger = false): React.CSSProperties => ({
  height: '32px', padding: '0 12px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${danger ? 'var(--tint-red-2, #fecaca)' : primary ? '#0A8560' : 'var(--divider, #e4e4e7)'}`, background: primary ? '#0A8560' : '#fff', color: danger ? '#b91c1c' : primary ? '#fff' : '#18181b',
});
const OPEN = ['draft', 'awaiting_approval', 'sent', 'viewed'];
const TYPE: Record<string, string> = { signer: 'Signer', approver: 'Approver', cc: 'CC', viewer: 'Viewer', filler: 'Filler' };
const DELIVERY: Record<string, string> = { email: 'Email', sms: 'Text', both: 'Email + text' };

function statusOf(r: ContractRecipient): { text: string; color: string } {
  switch (r.status) {
    case 'signed': return { text: 'Signed', color: 'var(--tx-green, #15803d)' };
    case 'approved': return { text: 'Approved', color: 'var(--tx-green, #15803d)' };
    case 'rejected': return { text: 'Rejected', color: 'var(--tx-red, #b91c1c)' };
    case 'declined': return { text: 'Declined', color: 'var(--tx-red, #b91c1c)' };
    case 'delegated': return { text: 'Handed off', color: 'var(--meta, #71717a)' };
    case 'viewed': return { text: 'Viewed', color: 'var(--tx-amber, #b45309)' };
    default: return { text: r.recipient_type === 'cc' ? 'Gets a copy' : 'Waiting', color: 'var(--meta, #71717a)' };
  }
}

type Edit = { id: number; name: string; email: string; phone: string; delivery: 'email' | 'sms' | 'both' };
type CrmOffer = { name: string; list: string; link: { seller_id: number | null; buyer_id: number | null; vendor_id: number | null }; email?: string | null; phone?: string | null };

export function RecipientsPanel({ workspaceId, contract, canWrite, onToast, onChanged }: {
  workspaceId: number; contract: ContractRow; canWrite: boolean; onToast: (m: string) => void; onChanged: () => void;
}) {
  const [loaded, setLoaded] = useState<{ id: number; tick: number; list: ContractRecipient[] } | null>(null);
  const [tick, setTick] = useState(0);
  const [me, setMe] = useState<{ id: string; email: string } | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [crmOffer, setCrmOffer] = useState<CrmOffer | null>(null);

  useEffect(() => {
    let live = true;
    void listRecipients(workspaceId, contract.id).then((r) => {
      if (!live) return;
      if (!r.ok) { onToast(r.message); return; }
      setLoaded({ id: contract.id, tick, list: r.data.recipients });
    });
    return () => { live = false; };
  }, [workspaceId, contract.id, contract.status, tick, onToast]);

  useEffect(() => {
    if (!supabase) return;
    let live = true;
    void supabase.auth.getUser().then(({ data }) => { if (live && data.user) setMe({ id: data.user.id, email: (data.user.email ?? '').toLowerCase() }); });
    return () => { live = false; };
  }, []);

  const list = loaded && loaded.id === contract.id ? loaded.list : null;
  const reload = () => { setTick((t) => t + 1); onChanged(); };
  const open = OPEN.includes(contract.status);
  const awaiting = contract.status === 'awaiting_approval';
  const waitingOn = (list ?? []).filter((r) => r.recipient_type === 'approver' && r.status !== 'approved' && r.status !== 'delegated');
  const mine = waitingOn.find((r) => !!me && (r.user_id === me.id || (!!r.email && r.email.toLowerCase() === me.email)));
  const rejectedWhy = (contract as ContractRow & { approval_rejected_reason?: string | null }).approval_rejected_reason;

  async function answer(decision: 'approve' | 'reject') {
    setBusy(decision);
    try {
      const r = await answerApproval(workspaceId, contract.id, decision, decision === 'reject' ? reason : null, mine?.id ?? null);
      if (!r.ok) return onToast(r.message);
      setRejecting(false); setReason('');
      onToast(decision === 'reject' ? 'Rejected · it is back to draft with your reason' : r.data.sent ? `Approved and sent${deliveredText(r.data) ? ` · ${deliveredText(r.data)}` : ''}` : 'Approved · waiting on the other approvers');
      reload();
    } finally { setBusy(null); }
  }

  async function saveEdit(resend: boolean) {
    if (!edit) return;
    const before = (list ?? []).find((r) => r.id === edit.id);
    setBusy(resend ? 'resend' : 'save');
    try {
      const r = await updateContractRecipient(workspaceId, contract.id, edit.id, { name: edit.name, email: edit.email, phone: edit.phone, delivery: edit.delivery, resend });
      if (!r.ok) return onToast(r.message);
      const sent = deliveredText(r.data);
      onToast(r.data.changed.length || resend ? `Saved${resend ? ` · ${sent || 'link sent'}` : ''}${r.data.changed.some((c) => c === 'email' || c === 'phone') ? ' · the old link no longer works' : ''}` : 'Nothing changed');
      setEdit(null);
      // The record in People or Buyers still has the old email or phone: offer to fix it there too.
      const crmList = linkLabel(r.data.crm);
      const touched = r.data.changed.filter((c) => c === 'email' || c === 'phone');
      if (crmList && crmList !== 'Team' && touched.length) {
        setCrmOffer({ name: before?.name || edit.name, list: crmList, link: r.data.crm, ...(touched.includes('email') ? { email: edit.email } : {}), ...(touched.includes('phone') ? { phone: edit.phone } : {}) });
      }
      reload();
    } finally { setBusy(null); }
  }

  async function resend(r: ContractRecipient) {
    setBusy(`resend:${r.id}`);
    try {
      const res = await updateContractRecipient(workspaceId, contract.id, r.id, { resend: true });
      if (!res.ok) return onToast(res.message);
      onToast(`Link sent to ${r.name || r.email || r.label}${deliveredText(res.data) ? ` · ${deliveredText(res.data)}` : ''}`);
      reload();
    } finally { setBusy(null); }
  }

  return (
    <div style={{ marginTop: '8px', padding: '10px 12px', background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px' }}>
      {contract.status === 'draft' && rejectedWhy ? (
        <div style={{ fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)', background: 'var(--tint-red, #fef2f2)', border: '1px solid var(--tint-red-2, #fecaca)', borderRadius: '8px', padding: '8px 10px', marginBottom: '8px' }}>
          <b>Approval rejected:</b> {rejectedWhy} Fix it and send again; the approvers are asked again.
        </div>
      ) : null}
      {awaiting ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12.5px', color: 'var(--tx-mint-deep, #08694c)', background: 'var(--c-genius-soft, #f0faf5)', border: '1px solid var(--c-action-line, #a7dcc5)', borderRadius: '8px', padding: '8px 10px', marginBottom: '8px' }}>
          <span style={{ flex: 1, minWidth: '200px' }}>
            Waiting on {waitingOn.map((r) => r.name || r.email || r.label).join(', ') || 'approval'} to approve before it goes out for signature.
          </span>
          {mine ? (
            <>
              <button type="button" disabled={!!busy} onClick={() => setRejecting(true)} style={btn(false, true)}>Reject</button>
              <button type="button" disabled={!!busy} onClick={() => void answer('approve')} style={btn(true)}>{busy === 'approve' ? 'Approving…' : 'Approve and send'}</button>
            </>
          ) : null}
        </div>
      ) : null}

      {list === null ? <div style={{ fontSize: '12px', color: 'var(--subtle, #a1a1aa)' }}>Loading recipients…</div> : list.map((r) => {
        const st = statusOf(r);
        const gone = r.status === 'delegated';
        const answered = ['signed', 'approved', 'delegated'].includes(r.status);
        const handedTo = gone && r.delegated_to ? list.find((x) => x.id === r.delegated_to) : null;
        const from = r.delegated_from ? list.find((x) => x.id === r.delegated_from) : null;
        if (edit?.id === r.id) {
          return (
            <div key={r.id} style={{ padding: '8px 0', borderTop: '1px solid var(--divider-2, #f0f0f1)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1.4fr) minmax(0, 1fr) 130px', gap: '8px' }}>
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Full name" style={field} aria-label="Name" />
                <input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} placeholder="email@example.com" type="email" style={field} aria-label="Email" />
                <input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} placeholder="Mobile" style={field} aria-label="Mobile" />
                <select value={edit.delivery} onChange={(e) => setEdit({ ...edit, delivery: e.target.value as Edit['delivery'] })} style={field} aria-label="Send the link by">
                  <option value="email">Email</option><option value="sms">Text</option><option value="both">Email + text</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', flex: 1, minWidth: '160px' }}>A new email or phone gets a fresh link; the old one stops working.</span>
                <button type="button" onClick={() => setEdit(null)} style={btn()}>Cancel</button>
                <button type="button" disabled={!!busy} onClick={() => void saveEdit(false)} style={btn()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
                {['sent', 'viewed', 'awaiting_approval'].includes(contract.status) ? <button type="button" disabled={!!busy} onClick={() => void saveEdit(true)} style={btn(true)}>{busy === 'resend' ? 'Sending…' : 'Save and resend link'}</button> : null}
              </div>
            </div>
          );
        }
        return (
          <div key={r.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--divider-2, #f0f0f1)', fontSize: '12.5px', opacity: gone ? 0.6 : 1 }}>
            <span style={{ fontWeight: 600, minWidth: '90px' }}>{r.label || r.role}<span style={{ display: 'block', fontSize: '10.5px', fontWeight: 500, color: 'var(--subtle, #a1a1aa)' }}>{TYPE[r.recipient_type ?? 'signer'] ?? 'Signer'} · {DELIVERY[r.delivery ?? 'email']}</span></span>
            <span style={{ color: 'var(--muted, #52525b)', flex: 1, minWidth: '160px' }}>
              {r.name || '—'}{r.email ? ` · ${r.email}` : ''}{r.phone ? ` · ${r.phone}` : ''}
              {linkLabel(r) ? <span style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 700, color: 'var(--tx-mint, #0a8560)', background: 'var(--mint-dim, #e7f8f1)', borderRadius: '999px', padding: '1px 6px' }}>{linkLabel(r)}</span> : null}
              {gone ? <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)' }}>Handed to {handedTo?.name || 'someone else'}{r.delegate_reason ? `: ${r.delegate_reason}` : ''}</span> : null}
              {from ? <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)' }}>For {from.name || from.label}{from.delegate_reason ? ` — ${from.delegate_reason}` : ''}</span> : null}
              {r.status === 'rejected' && r.reject_reason ? <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)' }}>{r.reject_reason}</span> : null}
            </span>
            <span style={{ fontSize: '11px', fontWeight: 700, color: st.color }}>{st.text}</span>
            {canWrite && open && !gone ? (
              <span style={{ display: 'flex', gap: '10px' }}>
                {!answered ? <button type="button" style={link} onClick={() => setEdit({ id: r.id, name: r.name ?? '', email: r.email ?? '', phone: r.phone ?? '', delivery: r.delivery ?? 'email' })}>Edit</button> : null}
                {!answered && r.recipient_type !== 'cc' && contract.status !== 'draft' ? <button type="button" style={{ ...link, color: 'var(--muted, #52525b)' }} disabled={!!busy} onClick={() => void resend(r)}>{busy === `resend:${r.id}` ? 'Sending…' : 'Resend link'}</button> : null}
              </span>
            ) : null}
          </div>
        );
      })}
      {canWrite && open && list ? (
        <button type="button" onClick={() => setAdding(true)} style={{ ...link, marginTop: '8px' }}>+ Add recipient</button>
      ) : null}

      {adding && list ? (
        <AddRecipientDialog workspaceId={workspaceId} contract={contract} recipients={list} userId={me?.id ?? null} onToast={onToast} onClose={() => setAdding(false)} onAdded={reload} />
      ) : null}
      {rejecting ? (
        <CenteredDialog title={`Reject ${contract.name}`} onClose={() => setRejecting(false)} width={560} z={220}>
          <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--muted, #52525b)' }}>It goes back to draft, and the sender sees your reason. Nothing goes to the signers.</p>
          <textarea value={reason} autoFocus onChange={(e) => setReason(e.target.value)} rows={4} placeholder="What needs to change? (the price, a name, the closing date…)" style={{ ...field, height: 'auto', padding: '9px 10px', resize: 'vertical' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
            <button type="button" onClick={() => setRejecting(false)} style={btn()}>Back</button>
            <button type="button" disabled={!reason.trim() || !!busy} onClick={() => void answer('reject')} style={btn(false, true)}>{busy === 'reject' ? 'Rejecting…' : 'Reject with this reason'}</button>
          </div>
        </CenteredDialog>
      ) : null}
      {crmOffer ? (
        <CenteredDialog title="Update the CRM too?" onClose={() => setCrmOffer(null)} width={520} z={220}>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--ink-3, #3f3f46)', lineHeight: 1.5 }}>
            {crmOffer.name} is in {crmOffer.list} with the old {crmOffer.email !== undefined && crmOffer.phone !== undefined ? 'email and phone' : crmOffer.email !== undefined ? 'email' : 'phone'}. Update the record to {[crmOffer.email, crmOffer.phone].filter((v) => v !== undefined).map((v) => v || '(blank)').join(' and ')}?
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <button type="button" onClick={() => setCrmOffer(null)} style={btn()}>Only this contract</button>
            <button type="button" onClick={() => {
              const o = crmOffer;
              setCrmOffer(null);
              void updateCrmContact(workspaceId, o.link, { ...(o.email !== undefined ? { email: o.email } : {}), ...(o.phone !== undefined ? { phone: o.phone } : {}) })
                .then((u) => onToast(u.ok ? `${o.name} updated in ${o.list}` : u.message ?? 'Could not update the record'));
            }} style={btn(true)}>Update {crmOffer.list}</button>
          </div>
        </CenteredDialog>
      ) : null}
    </div>
  );
}
