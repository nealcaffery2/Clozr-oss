// Add someone to a contract that is already out (or still a draft): a signer,
// a CC, a viewer, or before it goes out, an approver. Existing signatures stay
// as they are; a new signer gets their link when it is their turn.
'use client';

import React, { useState } from 'react';
import { CenteredDialog } from '@/components/ContractsHub';
import { RecipientPicker } from '@/components/RecipientPicker';
import { type ContractRecipient, type ContractRow, addContractRecipient, deliveredText } from '@/lib/contracts';
import { type Contact, type ContactLink, isLinked, linkOf } from '@/lib/contact-search';
import { linkLabel, saveRecipientToCrm } from '@/lib/contract-recipients';

const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 600, marginBottom: '5px' };
const field: React.CSSProperties = { width: '100%', height: '34px', padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', fontSize: '13px', outline: 0, background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)' };
const chip = (on: boolean): React.CSSProperties => ({
  height: '30px', padding: '0 12px', borderRadius: '999px', fontSize: '12.5px', fontWeight: on ? 650 : 500, cursor: 'pointer',
  border: `1px solid ${on ? '#0A8560' : 'var(--divider, #e4e4e7)'}`, background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', color: on ? 'var(--tx-mint, #0a8560)' : 'var(--ink-2, #27272a)', fontFamily: 'inherit',
});

type Kind = 'signer' | 'cc' | 'viewer' | 'approver';
const KIND_HELP: Record<Kind, string> = {
  signer: 'Signs the document. Their signature goes on the signature certificate.',
  cc: 'Gets the signed copy when everyone has signed.',
  viewer: 'Can open and read it while it is out. Never signs.',
  approver: 'Signs off inside the company before it goes out.',
};

export function AddRecipientDialog({ workspaceId, contract, recipients, userId, onToast, onClose, onAdded }: {
  workspaceId: number; contract: ContractRow; recipients: ContractRecipient[]; userId: string | null;
  onToast: (m: string) => void; onClose: () => void; onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [link, setLink] = useState<ContactLink | null>(null);
  const [kind, setKind] = useState<Kind>('signer');
  const [delivery, setDelivery] = useState<'email' | 'sms' | 'both'>('email');
  const [position, setPosition] = useState<number>(0);
  const [save, setSave] = useState<'seller' | 'buyer' | 'skip'>('seller');
  const [busy, setBusy] = useState(false);
  const live = recipients.filter((r) => r.status !== 'delegated');
  const out = ['sent', 'viewed'].includes(contract.status);
  const kinds: Kind[] = out ? ['signer', 'cc', 'viewer'] : ['signer', 'cc', 'viewer', 'approver'];
  const digits = phone.replace(/\D/g, '');
  const canText = digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
  const valid = name.trim().length > 1 && (delivery === 'sms' ? canText : email.includes('@') && (delivery === 'email' || canText));

  const pick = (c: Contact) => { setName(c.name); setEmail(c.email ?? ''); setPhone(c.phone ?? ''); setLink(linkOf(c)); };

  async function submit() {
    setBusy(true);
    try {
      let l = link;
      if (!isLinked(l) && save !== 'skip' && kind !== 'approver') {
        const s = await saveRecipientToCrm(workspaceId, { name, email, phone }, save, userId);
        if (!s.ok) { onToast(s.message); return; }
        l = s.link;
        onToast(s.existing ? `Linked to ${name} already in ${save === 'seller' ? 'People' : 'Buyers'}` : `${name} saved to ${save === 'seller' ? 'People' : 'Buyers'}`);
      }
      const r = await addContractRecipient(workspaceId, contract.id, {
        name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, recipient_type: kind, delivery,
        position: position || null, ...(l ?? {}),
      });
      if (!r.ok) { onToast(r.message); return; }
      const sent = deliveredText(r.data);
      onToast(`${name.trim()} added${sent ? ` · ${sent}` : out && kind !== 'cc' ? ' · they get a link when it is their turn' : ''}`);
      onAdded();
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <CenteredDialog title={`Add a recipient · ${contract.name}`} onClose={onClose} width={680} z={210}>
      <div style={{ display: 'grid', gap: '14px' }}>
        <div>
          <span style={label}>Who</span>
          <RecipientPicker workspaceId={workspaceId} value={name} autoFocus onChange={(v) => setName(v)} onPick={pick} linked={linkLabel(link)} onUnlink={() => setLink(null)} kinds={kind === 'approver' ? ['team'] : undefined} placeholder={kind === 'approver' ? 'Search your team' : 'Name — or search People, Buyers, vendors, team'} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: '10px' }}>
          <div><span style={label}>Email</span><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="email@example.com" style={field} /></div>
          <div><span style={label}>Mobile</span><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(210) 555-0100" style={field} /></div>
        </div>
        <div>
          <span style={label}>Role</span>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {kinds.map((k) => <button key={k} type="button" onClick={() => setKind(k)} style={chip(kind === k)}>{k === 'cc' ? 'CC' : k[0].toUpperCase() + k.slice(1)}</button>)}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--meta, #71717a)', marginTop: '5px' }}>{KIND_HELP[kind]}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' }}>
          <div>
            <span style={label}>Send the link by</span>
            <select value={delivery} onChange={(e) => setDelivery(e.target.value as 'email' | 'sms' | 'both')} style={field}>
              <option value="email">Email</option>
              <option value="sms">Text</option>
              <option value="both">Email and text</option>
            </select>
          </div>
          <div>
            <span style={label}>Place in the order</span>
            <select value={position} onChange={(e) => setPosition(Number(e.target.value))} style={field} title={(contract as ContractRow & { signing_order_mode?: string }).signing_order_mode === 'sequential' ? 'Signed in order: they sign when everyone above them has' : 'Everyone signs at once, so the order is only how the list reads'}>
              <option value={0}>At the end</option>
              {live.map((r, i) => <option key={r.id} value={i + 1}>Before {r.name || r.label || r.role}</option>)}
            </select>
          </div>
        </div>
        {!isLinked(link) && kind !== 'approver' && name.trim() ? (
          <div>
            <span style={label}>Not in the CRM yet — save as</span>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(['seller', 'buyer', 'skip'] as const).map((k) => <button key={k} type="button" onClick={() => setSave(k)} style={chip(save === k)}>{k === 'seller' ? 'New Person' : k === 'buyer' ? 'New Buyer' : 'Don’t save'}</button>)}
            </div>
          </div>
        ) : null}
        {out && kind === 'signer' ? <div style={{ fontSize: '12px', color: 'var(--muted, #52525b)', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', padding: '9px 11px' }}>Signatures already on the document stay valid. The new signer signs on the signature certificate.</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button type="button" onClick={onClose} style={{ height: '34px', padding: '0 14px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button type="button" disabled={!valid || busy} onClick={() => void submit()} style={{ height: '34px', padding: '0 14px', borderRadius: '8px', border: '1px solid #0A8560', background: !valid || busy ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: !valid || busy ? 'not-allowed' : 'pointer' }}>{busy ? 'Adding…' : out ? 'Add and send' : 'Add recipient'}</button>
        </div>
      </div>
    </CenteredDialog>
  );
}
