// Buyer record desk: the tabs that used to be empty, plus the composer that
// actually writes. Offers and purchases are the same rows dispo reads.
'use client';

import React, { useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ContractsCard } from '@/components/ContractsCard';
import { MentionText } from '@/app/components/record/MentionField';
import { EmailThread } from '@/app/components/record/EmailThread';
import { AgentBadge } from '@/app/components/record/ActivityStream';
import { attachBuyerToDeal, createBuyerNote, createBuyerOffer, listBuyerCampaigns, type BuyerCampaignRow } from '@/lib/buyer-desk';
import { parseDollars } from '@/lib/money';
import { uploadPof } from '@/lib/dispo-sop';
import { emptyPof, hasPof, PofField, type PofDraft } from '@/app/components/dispo/PofField';
import { CallInsight } from '@/app/components/record/CallInsight';
import { Mark } from '@/components/ds/mark';
import { UserAvatar } from '@/components/UserAvatar';
import { SearchSelect } from '@/components/SearchSelect';

const field: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 10px', border: '1px solid #e4e4e7',
  borderRadius: 9, fontSize: 13, outline: 0, background: '#fafafa', color: '#18181b',
};
const btn = (primary = false): React.CSSProperties => ({
  height: 32, padding: '0 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${primary ? '#0A8560' : '#e4e4e7'}`, background: primary ? '#0A8560' : '#fff', color: primary ? '#fff' : '#18181b',
});
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

export function BuyerDesk({ V }: { V: ClozrView }) {
  const tab = V.buyerTab;
  const live = V.liveIds;
  const buyerId = V.B.dbId;
  const [adding, setAdding] = useState<'note' | 'offer' | 'purchase' | 'campaign' | null>(null);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 16px 0' }}>
        {tab === 'Notes' ? <button type="button" style={btn(true)} onClick={() => setAdding('note')}>Add note</button> : null}
        {tab === 'Offers' ? <button type="button" style={btn(true)} onClick={() => setAdding('offer')}>Add offer</button> : null}
        {tab === 'Purchases' ? <button type="button" style={btn(true)} onClick={() => setAdding('purchase')}>Attach purchase</button> : null}
        {tab === 'Campaigns' ? <button type="button" style={btn(true)} onClick={() => setAdding('campaign')}>Add to campaign</button> : null}
      </div>

      {adding && live && buyerId ? (
        <AddForm
          kind={adding} V={V} workspaceId={live.workspaceId} buyerId={buyerId}
          onClose={() => setAdding(null)}
        />
      ) : adding && !live ? (
        <p style={{ padding: '12px 16px', fontSize: 12.5, color: '#71717a' }}>Adding runs on a signed-in workspace.</p>
      ) : null}

      {tab === 'Activity' ? <Activity V={V} /> : null}
      {tab === 'Offers' ? <Offers V={V} /> : null}
      {tab === 'Purchases' ? <Purchases V={V} /> : null}
      {tab === 'Campaigns' ? <Campaigns V={V} buyerId={buyerId} workspaceId={live?.workspaceId ?? null} /> : null}
      {tab === 'Notes' ? <Notes V={V} /> : null}
      {tab === 'Contracts' ? (
        live && buyerId ? (
          <div style={{ margin: '14px 0 0', padding: '0 16px 16px' }}>
            <ContractsCard
              compact
              workspaceId={live.workspaceId}
              buyerId={buyerId}
              dealId={V.buyerContractDealId}
              sellerId={V.buyerContractSellerId}
              seller={V.buyerContractSeller}
              buyer={{ name: V.B.name, email: V.B.email === '—' ? null : V.B.email, phone: V.B.phone === '—' ? null : V.B.phone }}
              canWrite={live.canWrite}
              onToast={V.showToast}
              onChanged={V.reloadCrm}
            />
          </div>
        ) : <p style={{ padding: '16px', fontSize: 12.5, color: '#71717a' }}>Contracts are filled from this buyer on a signed-in workspace.</p>
      ) : null}
    </>
  );
}

const FEED_CHIPS = ['All', 'Calls', 'Texts', 'Email', 'Notes'] as const;

function feedMatch(chan: string, chip: (typeof FEED_CHIPS)[number]): boolean {
  if (chip === 'All') return true;
  const c = chan.toLowerCase();
  if (chip === 'Calls') return c.includes('call');
  if (chip === 'Texts') return c.includes('sms') || c.includes('text');
  if (chip === 'Email') return c.includes('mail') || c.includes('email');
  return c.includes('note');
}

function Activity({ V }: { V: ClozrView }) {
  const [chip, setChip] = useState<(typeof FEED_CHIPS)[number]>('All');
  const rows = V.buyerTimeline.filter((t) => feedMatch(t.chan, chip));
  return (
    <>
      <div role="group" aria-label="Filter activity" style={{ display: 'flex', gap: 2, padding: '8px 16px 0', flexWrap: 'wrap' }}>
        {FEED_CHIPS.map((c) => (
          <button key={c} type="button" aria-pressed={chip === c} onClick={() => setChip(c)}
            style={{ height: 32, padding: '0 10px', border: 0, borderBottom: `2px solid ${chip === c ? '#18181b' : 'transparent'}`, background: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: chip === c ? '#18181b' : '#71717a' }}>
            {c}
          </button>
        ))}
      </div>
      {!V.buyerTimeline.length ? <Empty label="activity" /> : !rows.length ? <Empty label={chip.toLowerCase()} /> : rows.map((t) => (
        <div key={t.id} className="clozr-tl" style={{ display: 'grid', gridTemplateColumns: '30px minmax(0,1fr)', gap: 12, padding: '14px 16px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
            {/* A teammate's row shows their face, as the seller feed does; the buyer's own and system rows keep the channel mark. */}
            {t.rep ? (
              <UserAvatar name={t.rep.name} src={t.rep.avatar} size={30} radius="8px" border="1px solid #e4e4e7" />
            ) : (
              <span title={t.who} style={{ width: 30, height: 30, borderRadius: 8, background: '#fff', border: '1px solid #e4e4e7', display: 'grid', placeItems: 'center', color: t.color }}>
                <Mark label={t.chan} size={15} />
              </span>
            )}
            {t.rep ? (
              <span title={t.rep.name} style={{ maxWidth: 52, marginTop: 3, fontSize: 9.5, lineHeight: 1.2, color: '#71717a', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.rep.name.split(' ')[0]}
              </span>
            ) : null}
            <span style={{ flex: 1, width: 1, background: '#e4e4e7', marginTop: 6 }} />
          </div>
          <div style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: 10, padding: '12px 14px', minWidth: 0, marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: t.color }}>
                <Mark label={t.chan} />
                {t.chan}
              </span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{t.title}</span>
              {t.email ? null : <span style={{ fontSize: 12, color: '#71717a' }}>· {t.who}</span>}
              {t.agentTag ? <AgentBadge /> : null}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: '#a1a1aa', whiteSpace: 'nowrap' }}>{t.time}</span>
            </div>
            {t.email ? (
              <EmailThread
                latest={{ id: t.id, email: t.email, commId: t.commId, time: t.time }}
                earlier={t.earlier.flatMap((m) => (m.email ? [{ id: m.id, email: m.email, commId: m.commId, time: m.time }] : []))}
                workspaceId={V.liveIds?.workspaceId}
                onOpenInbox={V.liveIds ? () => V.openEmailInInbox(t.email!) : undefined}
                reply={!V.liveIds ? { name: V.B.name } : V.liveIds.canWrite && V.liveIds.buyerId ? { name: V.B.name, buyerId: V.liveIds.buyerId, onSent: V.reloadCrm } : null}
              />
            ) : t.body ? (
              <div style={{ fontSize: 13, color: '#27272a', marginTop: 8, lineHeight: 1.5 }}>
                <MentionText text={t.body} />
              </div>
            ) : null}
            {t.isCall && t.commId && V.liveIds ? (
              <CallInsight communicationId={t.commId} workspaceId={V.liveIds.workspaceId} sellerId={null} me={V.liveIds.userId} canWrite={V.liveIds.canWrite} prospectName={V.B.name} onToast={V.showToast} onChanged={V.reloadCrm} />
            ) : null}
            {t.isCall && t.ai && V.showAi ? (
              <div style={{ marginTop: 10, padding: 12, borderRadius: 8, background: 'rgba(10, 133, 96,.05)', border: '1px solid rgba(10, 133, 96,.18)' }}>
                <div style={{ fontSize: 11.5, color: '#0A8560', fontWeight: 600 }}>AI summary</div>
                <div style={{ fontSize: 13, color: '#27272a', marginTop: 6, lineHeight: 1.5 }}>{t.ai.summary}</div>
                <div style={{ display: 'grid', gridTemplateColumns: V.isMobile ? '1fr' : '1fr 1fr', gap: 12, marginTop: 10 }}>
                  <div>
                    <div style={{ fontSize: 11.5, color: '#71717a', fontWeight: 600 }}>Objections</div>
                    {t.ai.objections.map((o) => (
                      <div key={o} style={{ fontSize: 12.5, color: '#27272a', marginTop: 4 }}>• {o}</div>
                    ))}
                  </div>
                  <div>
                    <div style={{ fontSize: 11.5, color: '#71717a', fontWeight: 600 }}>Next best action</div>
                    <div style={{ fontSize: 12.5, color: '#18181b', fontWeight: 600, marginTop: 4 }}>{t.ai.next}</div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}

function Offers({ V }: { V: ClozrView }) {
  if (!V.buyerOfferRows.length) return <Empty label="offers" />;
  return (
    <>
      {V.buyerOfferRows.map((o) => (
        <button key={o.id} type="button" onClick={o.open ?? undefined} style={{ display: 'flex', width: '100%', textAlign: 'left', gap: 12, padding: '12px 16px', border: 0, borderBottom: '1px solid #f0f0f1', background: '#fff', cursor: o.open ? 'pointer' : 'default' }}>
          <span style={{ fontWeight: 700, minWidth: 88 }}>{o.amount}</span>
          <span style={{ flex: 1, minWidth: 0, color: '#27272a' }}>{o.addr}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: o.color }}>{o.status}</span>
          <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>{o.when}</span>
        </button>
      ))}
    </>
  );
}

function Purchases({ V }: { V: ClozrView }) {
  if (!V.buyerPurchaseRows.length) return <Empty label="purchases" hint="Closed deals this buyer is on, plus any you attach." />;
  return (
    <>
      {V.buyerPurchaseRows.map((p) => (
        <button key={p.id} type="button" onClick={p.open} style={{ display: 'flex', width: '100%', textAlign: 'left', gap: 12, padding: '12px 16px', border: 0, borderBottom: '1px solid #f0f0f1', background: '#fff', cursor: 'pointer' }}>
          <span style={{ fontWeight: 700, flex: 1, minWidth: 0 }}>{p.addr}</span>
          <span style={{ color: '#27272a' }}>{p.price}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: p.color }}>{p.stage}</span>
          <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>{p.when}</span>
        </button>
      ))}
    </>
  );
}

function Notes({ V }: { V: ClozrView }) {
  if (!V.buyerNoteRows.length) return <Empty label="notes" />;
  return (
    <>
      {V.buyerNoteRows.map((n) => (
        <div key={n.id} style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f1' }}>
          <div style={{ fontSize: 12.5, color: '#27272a', whiteSpace: 'pre-wrap' }}>{n.text}</div>
          <div style={{ fontSize: 11.5, color: '#a1a1aa', marginTop: 4 }}>{n.when}</div>
        </div>
      ))}
    </>
  );
}

function Campaigns({ V, buyerId, workspaceId }: { V: ClozrView; buyerId: number | null; workspaceId: number | null }) {
  const [rows, setRows] = useState<BuyerCampaignRow[] | null>(null);
  useEffect(() => {
    if (!workspaceId || !buyerId) return;
    let on = true;
    void listBuyerCampaigns(workspaceId, buyerId).then((r) => { if (on) setRows(r); });
    return () => { on = false; };
  }, [workspaceId, buyerId, V.B.dbId]);
  if (!workspaceId || !buyerId) return <Empty label="campaigns" hint="Add this buyer to a deal's dispo blast from here or from Matches." />;
  if (rows === null) return <p style={{ padding: 16, fontSize: 12.5, color: '#a1a1aa' }}>Loading campaigns…</p>;
  if (!rows.length) return <Empty label="campaigns" hint="Add this buyer to a deal's dispo blast from here or from Matches." />;
  return (
    <>
      {rows.map((c) => (
        <button key={c.id} type="button" onClick={() => V.openBuyerCampaign(c.deal_id)} style={{ display: 'flex', width: '100%', textAlign: 'left', gap: 12, padding: '12px 16px', border: 0, borderBottom: '1px solid #f0f0f1', background: '#fff', cursor: 'pointer' }}>
          <span style={{ fontWeight: 700, flex: 1 }}>{c.name}</span>
          <span style={{ fontSize: 12, color: '#52525b' }}>{c.status}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#0A8560' }}>{c.recipient_status}</span>
        </button>
      ))}
    </>
  );
}

function Empty({ label, hint }: { label: string; hint?: string }) {
  return (
    <div style={{ padding: '26px 16px', textAlign: 'center', fontSize: 12.5, color: '#a1a1aa' }}>
      No {label} recorded for this buyer yet.
      {hint ? <div style={{ marginTop: 6 }}>{hint}</div> : null}
    </div>
  );
}

function AddForm({ kind, V, workspaceId, buyerId, onClose }: {
  kind: 'note' | 'offer' | 'purchase' | 'campaign'; V: ClozrView; workspaceId: number; buyerId: number; onClose: () => void;
}) {
  const [dealId, setDealId] = useState('');
  const [amount, setAmount] = useState('');
  const [body, setBody] = useState('');
  const [pof, setPof] = useState<PofDraft>(emptyPof());
  const [pofError, setPofError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const userId = V.liveIds?.userId ?? null;
    try {
      if (kind === 'note') {
        const r = await createBuyerNote(workspaceId, buyerId, body, userId);
        if (!r.ok) return V.showToast(r.message || 'Could not save the note.');
        V.showToast('Note added');
      } else if (kind === 'offer') {
        const n = parseDollars(amount);
        if (n.error) return V.showToast(n.error);
        if (!dealId || n.value == null) return V.showToast('Pick a deal and an amount.');
        if (!hasPof(pof)) { setPofError('Proof of funds is required. Paste a link or attach the file'); return; }
        setPofError(null);
        let path: string | null = null;
        if (pof.file) {
          const up = await uploadPof(workspaceId, Number(dealId), pof.file);
          if (!up.ok) { setPofError(up.message); return; }
          path = up.path;
        }
        const r = await createBuyerOffer(workspaceId, { buyerId, dealId: Number(dealId), amount: n.value, notes: body || null, userId, pof: { url: pof.url || null, path, verified: pof.verified } });
        if (!r.ok) return V.showToast(r.message || 'Could not save the offer.');
        V.showToast('Offer saved · it shows on this buyer and on dispo');
      } else if (kind === 'purchase' || kind === 'campaign') {
        if (!dealId) return V.showToast('Pick a deal.');
        if (kind === 'purchase') {
          const r = await attachBuyerToDeal(workspaceId, buyerId, Number(dealId), userId);
          if (!r.ok) return V.showToast(r.message || 'Could not attach that deal.');
          V.showToast('Deal attached · purchases and dispo stay in sync');
        } else {
          V.addBuyerToCampaign(Number(dealId), buyerId);
        }
      }
      V.reloadCrm();
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <div style={{ margin: '10px 16px 0', padding: 12, border: '1px solid #e4e4e7', borderRadius: 10, background: '#fafafa' }}>
      {kind === 'note' ? (
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder={`Note about ${V.B.name}…`} style={{ ...field, height: 'auto', padding: '8px 10px', resize: 'vertical' }} />
      ) : (
        <>
          <label style={{ display: 'block', fontSize: 11.5, color: '#71717a', fontWeight: 600, marginBottom: 5 }}>Deal</label>
          {V.buyerDealChoices.length ? (
            <SearchSelect value={dealId} ariaLabel="Deal" placeholder={`Search ${V.buyerDealChoices.length} pipeline deals: address, seller, stage`}
              options={V.buyerDealChoices.map((d) => ({ v: d.id, label: d.label, at: d.at }))} onChange={setDealId} />
          ) : <div style={{ fontSize: 12.5, color: '#71717a' }}>No deal has been in the pipeline on this workspace yet.</div>}
          {kind === 'offer' ? (
            <div style={{ marginTop: 8 }}>
              <label style={{ display: 'block', fontSize: 11.5, color: '#71717a', fontWeight: 600, marginBottom: 5 }}>Amount</label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$238,500" inputMode="decimal" aria-label="Offer amount" style={field} />
              <div style={{ marginTop: 8 }}><PofField value={pof} onChange={(p) => { setPof(p); setPofError(null); }} error={pofError} inputStyle={field} /></div>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Terms, EMD, close date…" style={{ ...field, height: 'auto', padding: '8px 10px', resize: 'vertical', marginTop: 8 }} />
            </div>
          ) : null}
        </>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" style={btn()} onClick={onClose}>Cancel</button>
        <button type="button" style={btn(true)} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : kind === 'campaign' ? 'Add to campaign' : 'Save'}</button>
      </div>
    </div>
  );
}

void money;
