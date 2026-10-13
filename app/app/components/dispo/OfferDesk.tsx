// The Offer desk, run the way the dispo SOP says (steps 6 to 8):
//
//   - The deal carries an ask (marketed_price) and a buy-it-now (bin_price):
//     VIP buyers hear the BIN, the market hears both.
//   - Every offer is logged with proof of funds.
//   - An offer under the ask shows a warning and waits for an owner or admin
//     to Approve it; the approval is logged and the database refuses anyone
//     else (migration 235 `offers_approval_guard`).
//   - Accept runs the qualified-sale checklist; accepting one that fails it
//     needs a typed override reason, kept on the offer.
//   - Mark Sold records the price and the buyer, moves the deal to Buyer
//     Under Contract and tells acquisitions. Then Assign & open TC.
//
// It reads its own deal and offers (lib/dispo-sop), so it shows the columns
// the app's list query does not carry and stays right after each step.
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SearchSelect } from '@/components/SearchSelect';
import { useConfirm } from '@/components/ds/Confirm';
import { InlineField, type InlineValue } from '@/components/ds/InlineField';
import { Badge, btn, GREEN, HAIR, Icon, ICON, INK, INK_2, input, LINE, MUTED, RED } from '@/components/genius/parts';
import { createBuyerOffer, pofProblem } from '@/lib/buyer-desk';
import { patchRecord } from '@/lib/crm-write';
import {
  acceptQualified, approveBelowAsk, closeDateIn, soldWriteProblem, judgedAsk, needsApproval, loadDeskOffers, loadDispoDeal, markSold, pofLink, qualifiedSale,
  setOfferPof, uploadPof, type DeskOffer, type DispoDeal,
} from '@/lib/dispo-sop';
import { formatDollars, parseDollars } from '@/lib/money';
import { emptyPof, hasPof, PofField, type PofDraft } from './PofField';
import './dispo.css';

export type DeskBuyer = { name: string; company: string; verified: boolean; vip: boolean };

const fmt = (n: number | null | undefined) => (n == null ? '—' : formatDollars(n));
const dateLabel = (d: string | null) => (d ? new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', fontWeight: 500, color: MUTED, marginBottom: '5px' };
const field: React.CSSProperties = { ...input, width: '100%', boxSizing: 'border-box' };

/** The buyer's closing date: the one they gave, else the days they gave counted from the offer. */
const buyerClose = (o: DeskOffer) => o.terms?.close_on || closeDateIn(o.terms?.close_days ?? null, new Date(o.sent_at || Date.now()));
const isAccepted = (o: DeskOffer) => /accept/i.test(o.status);

const DEMO_DEAL: DispoDeal = { id: 0, workspace_id: 0, seller_id: null, stage: 'Ready To Market', marketed_price: 240000, bin_price: 232500, offer_amount: 214000, close_date: '2026-10-24', sold_at: null };
const DEMO_OFFERS: DeskOffer[] = [
  { id: 1, buyer_id: -1, amount: 241000, status: 'Submitted', sent_at: '2026-10-08T15:40:00Z', notes: null, terms: { emd: 5000, close_days: 14, option_days: 0 }, pof_url: 'https://example.com/pof.pdf', pof_path: null, pof_verified: true, approved_by: null, approved_at: null, qualified: null, override_reason: null, ask_at_offer: 240000 },
  { id: 2, buyer_id: -2, amount: 238500, status: 'Submitted', sent_at: '2026-10-08T15:02:00Z', notes: null, terms: { emd: 10000, close_days: 10, option_days: 0 }, pof_url: 'https://example.com/pof2.pdf', pof_path: null, pof_verified: true, approved_by: null, approved_at: null, qualified: null, override_reason: null, ask_at_offer: 240000 },
  { id: 3, buyer_id: -3, amount: 226000, status: 'Submitted', sent_at: '2026-10-09T13:15:00Z', notes: null, terms: { emd: 3000, close_days: 21, option_days: 7 }, pof_url: null, pof_path: 'demo', pof_verified: false, approved_by: null, approved_at: null, qualified: null, override_reason: null, ask_at_offer: 240000 },
];
const DEMO_BUYERS: Record<number, DeskBuyer> = {
  [-1]: { name: 'Dana Ruiz', company: 'Northline Homes', verified: true, vip: true },
  [-2]: { name: 'Sam Patel', company: 'Harbor Capital', verified: true, vip: false },
  [-3]: { name: 'Lee Owens', company: 'Blue Mesa Investments', verified: false, vip: false },
};

export function OfferDesk({
  workspaceId, dealId, userId, canWrite, canApprove, isMobile, address, buyerChoices, buyerOf, onToast, onChanged, onOpenBuyer, onAssign, assignLabel, demo,
}: {
  workspaceId: number | null;
  dealId: number | null;
  userId: string | null;
  canWrite: boolean;
  /** Owner or admin: may approve an offer under the ask. */
  canApprove: boolean;
  isMobile: boolean;
  address: string;
  /** Who can offer: id is the buyer's database id as a string. */
  buyerChoices: { id: string; label: string }[];
  buyerOf: (dbId: number) => DeskBuyer | null;
  onToast: (m: string, tone?: 'success' | 'error') => void;
  /** After a write the lists elsewhere (Overview, the buyer record) should see. */
  onChanged: () => void;
  onOpenBuyer: (dbId: number) => void;
  /** Assign & open TC, for a deal already marked sold. */
  onAssign: () => void;
  assignLabel: string;
  demo?: boolean;
}) {
  const [deal, setDeal] = useState<DispoDeal | null>(demo ? DEMO_DEAL : null);
  const [offers, setOffers] = useState<DeskOffer[]>(demo ? DEMO_OFFERS : []);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(demo ? 'ready' : 'loading');
  const [picked, setPicked] = useState<number | null>(null);
  const [logging, setLogging] = useState(false);
  const who = useCallback((id: number) => (demo ? DEMO_BUYERS[id] ?? null : buyerOf(id)), [demo, buyerOf]);

  // Bumped to read the deal and its offers again (after an offer is logged).
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce((n) => n + 1);
  useEffect(() => {
    if (demo || !dealId) return;
    let live = true;
    void Promise.all([loadDispoDeal(dealId), loadDeskOffers(dealId)]).then(([d, o]) => {
      if (!live) return;
      if (!d) { setState('error'); return; }
      setDeal(d); setOffers(o); setState('ready');
    });
    return () => { live = false; };
  }, [dealId, demo, nonce]);

  const ask = deal?.marketed_price == null ? null : Number(deal.marketed_price);
  const bin = deal?.bin_price == null ? null : Number(deal.bin_price);
  const contract = deal?.offer_amount == null ? null : Number(deal.offer_amount);
  const accepted = offers.find(isAccepted) ?? null;
  const current = offers.find((o) => o.id === (picked ?? accepted?.id ?? null)) ?? null;
  const readOnly = canWrite ? null : 'You can view offers but not change them';

  const saveDealCol = (col: 'marketed_price' | 'bin_price') => async (v: InlineValue) => {
    if (demo || !dealId) { setDeal((d) => (d ? { ...d, [col]: v } : d)); return { ok: true }; }
    const r = await patchRecord<DispoDeal>('deals', dealId, { [col]: v });
    if (r.ok) setDeal((d) => (d ? { ...d, ...r.row } : r.row));
    return r;
  };

  if (!demo && !dealId) {
    return <div style={{ padding: '14px 16px', fontSize: '12.5px', color: MUTED, background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px' }}>This property has no deal yet, so there is nothing to take offers on.</div>;
  }

  return (
    <div data-gx data-testid="offer-desk" style={{ display: 'grid', gap: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, letterSpacing: '-0.015em', color: INK }}>Offer desk</h2>
          <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
            {offers.length} offer{offers.length === 1 ? '' : 's'} · contract {fmt(contract)}
          </div>
        </div>
        <InlineField recordId={`deal${dealId ?? 'demo'}`} field="marketed_price" label="Ask" showLabel type="money" value={ask} readOnly={readOnly} onSave={saveDealCol('marketed_price')} width={120} />
        <span title="Buy it now: the price VIP buyers get first">
          <InlineField recordId={`deal${dealId ?? 'demo'}`} field="bin_price" label="VIP buy-it-now" showLabel type="money" value={bin} readOnly={readOnly} onSave={saveDealCol('bin_price')} width={130} />
        </span>
        <span style={{ flex: 1 }} />
        {canWrite && !logging ? <button type="button" style={btn('purple')} onClick={() => setLogging(true)}><Icon d={ICON.plus} />Log offer</button> : null}
      </div>

      {logging ? (
        <LogOffer workspaceId={workspaceId} dealId={dealId} userId={userId} ask={ask} isMobile={isMobile} demo={demo}
          buyerChoices={demo ? Object.entries(DEMO_BUYERS).map(([id, b]) => ({ id, label: `${b.company} · ${b.name}` })) : buyerChoices}
          onToast={onToast} onClose={() => setLogging(false)}
          onSaved={(o) => { setLogging(false); if (o) setOffers((x) => [o, ...x]); else refresh(); onChanged(); }} />
      ) : null}

      {state === 'loading' ? <div role="status" style={{ fontSize: '12.5px', color: MUTED }}>Loading offers…</div> : null}
      {state === 'error' ? <div role="alert" style={{ fontSize: '12.5px', color: RED }}>Could not read this deal&apos;s offers. Reload to try again.</div> : null}

      {state === 'ready' ? (
        <div style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'hidden' }}>
          {offers.length === 0 ? (
            <div style={{ padding: '14px 16px', fontSize: '12.5px', color: MUTED }}>No buyer offers yet. Log each one here with its proof of funds as it comes in.</div>
          ) : (
            <div role="radiogroup" aria-label="Offers" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px', minWidth: isMobile ? '640px' : 0 }}>
                <thead>
                  <tr>
                    {['', 'Buyer', 'Offer', 'Vs ask', 'Assignment', 'EMD', 'Closes', 'Option', 'Proof of funds', 'Status'].map((c) => (
                      <th key={c} scope="col" style={{ padding: '0 10px', height: '34px', textAlign: 'left', fontSize: '11.5px', fontWeight: 500, color: MUTED, borderBottom: `1px solid ${LINE}`, background: '#fafafa', whiteSpace: 'nowrap' }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {offers.map((o) => {
                    const b = who(o.buyer_id);
                    const rowAsk = judgedAsk(ask, o.ask_at_offer);
                    const under = needsApproval(o.amount, ask, o.ask_at_offer);
                    const on = current?.id === o.id;
                    return (
                      <tr key={o.id} onClick={() => setPicked(o.id)} style={{ cursor: 'pointer', background: on ? '#f4fbf8' : '#fff' }}>
                        <td style={{ padding: '0 10px', height: '48px', borderBottom: `1px solid ${HAIR}` }}>
                          <input type="radio" name="desk-offer" checked={on} onChange={() => setPicked(o.id)} aria-label={`Select ${b?.company || b?.name || 'buyer'}'s offer of ${fmt(o.amount)}`} style={{ width: '16px', height: '16px', accentColor: GREEN }} />
                        </td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap' }}>
                          <button type="button" onClick={(e) => { e.stopPropagation(); if (!demo) onOpenBuyer(o.buyer_id); }} style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', font: 'inherit', color: INK }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>{b?.company || b?.name || 'Buyer'}{b?.vip ? <Badge color="#08694C" tint="#E7F5EF">VIP</Badge> : null}</span>
                            <span style={{ display: 'block', fontSize: '11.5px', color: MUTED }}>{b?.name ?? ''}</span>
                          </button>
                        </td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${HAIR}`, fontWeight: 650, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmt(o.amount)}</td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: rowAsk == null ? MUTED : under ? RED : GREEN }}>
                          {rowAsk == null ? (ask != null && ask > 0 ? 'Logged with no ask' : 'No ask set') : under ? `${fmt(rowAsk - o.amount)} under` : o.amount === rowAsk ? 'At ask' : `${fmt(o.amount - rowAsk)} over`}
                        </td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${HAIR}`, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{contract == null ? '—' : fmt(o.amount - contract)}</td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${HAIR}`, fontVariantNumeric: 'tabular-nums' }}>{o.terms?.emd ? fmt(o.terms.emd) : '—'}</td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap' }}>{dateLabel(buyerClose(o))}</td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap', color: o.terms?.option_days ? '#b45309' : INK_2 }}>{o.terms?.option_days ? `${o.terms.option_days} days` : 'None'}</td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap' }}><PofCell o={o} demo={demo} canWrite={canWrite} onToast={onToast} onChange={(p) => setOffers((x) => x.map((y) => (y.id === o.id ? { ...y, ...p } : y)))} /></td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap' }}>
                          {isAccepted(o) ? <Badge color={GREEN} tint="#e7f6f0">Accepted</Badge>
                            : under && !o.approved_at ? <Badge color="#b45309" tint="#fef3c7">Needs approval</Badge>
                              : under ? <Badge color={INK_2}>Approved</Badge>
                                : <span style={{ color: INK_2 }}>{o.status || 'Submitted'}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {state === 'ready' && current ? (
        <Steps key={current.id} o={current} deal={deal} ask={ask} buyer={who(current.buyer_id)} workspaceId={workspaceId} userId={userId} address={address}
          canWrite={canWrite} canApprove={canApprove} demo={demo} isMobile={isMobile} onToast={onToast}
          onAssign={onAssign} assignLabel={assignLabel}
          onDone={(patch) => {
            if (patch.offer) setOffers((x) => x.map((y) => (y.id === current.id ? { ...y, ...patch.offer } : patch.offer?.status === 'Accepted' && isAccepted(y) ? { ...y, status: 'Submitted' } : y)));
            if (patch.deal) setDeal((d) => (d ? { ...d, ...patch.deal } : d));
            if (!demo) onChanged();
          }} />
      ) : null}
      {state === 'ready' && offers.length > 0 && !current ? (
        <div style={{ fontSize: '12.5px', color: MUTED }}>Select an offer to approve, accept or mark it sold.</div>
      ) : null}
    </div>
  );
}

/** The proof of funds on one row: open it, and tick it verified. */
function PofCell({ o, demo, canWrite, onToast, onChange }: { o: DeskOffer; demo?: boolean; canWrite: boolean; onToast: (m: string) => void; onChange: (p: Partial<DeskOffer>) => void }) {
  const [busy, setBusy] = useState(false);
  if (!o.pof_url && !o.pof_path) return <span style={{ color: RED, fontWeight: 600 }}>Missing</span>;
  const open = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (demo) return onToast('Opens the proof of funds (demo)');
    const url = await pofLink(o);
    if (url) window.open(url, '_blank', 'noopener'); else onToast('Could not open the proof of funds.');
  };
  const verify = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (demo) { onChange({ pof_verified: true }); return; }
    setBusy(true);
    const r = await setOfferPof(o.id, { pof_verified: true });
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    onChange({ pof_verified: true });
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <button type="button" onClick={(e) => void open(e)} style={{ ...btn('ghost', true), height: '26px' }}>Open</button>
      {o.pof_verified ? <Badge color={GREEN} tint="#e7f6f0">Verified</Badge>
        : canWrite ? <button type="button" disabled={busy} onClick={(e) => void verify(e)} style={{ ...btn('ghost', true), height: '26px' }}>{busy ? 'Saving…' : 'Mark verified'}</button>
          : <Badge color="#b45309" tint="#fef3c7">Not verified</Badge>}
    </span>
  );
}

function LogOffer({ workspaceId, dealId, userId, ask, isMobile, demo, buyerChoices, onToast, onClose, onSaved }: {
  workspaceId: number | null; dealId: number | null; userId: string | null; ask: number | null; isMobile: boolean; demo?: boolean;
  buyerChoices: { id: string; label: string }[];
  onToast: (m: string, tone?: 'success' | 'error') => void; onClose: () => void; onSaved: (o: DeskOffer | null) => void;
}) {
  const [f, setF] = useState({ buyerId: '', amount: '', emd: '', closeDays: '', optionDays: '', contingency: '', notes: '' });
  const [pof, setPof] = useState<PofDraft>(emptyPof());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const on = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const price = parseDollars(f.amount);
  const under = price.value != null && needsApproval(price.value, ask);
  const options = useMemo(() => buyerChoices.map((b) => ({ v: b.id, label: b.label })), [buyerChoices]);

  const save = async () => {
    const emd = parseDollars(f.emd);
    const e: Record<string, string> = {};
    if (!f.buyerId) e.buyer = 'Pick the buyer';
    if (price.error) e.amount = price.error; else if (price.value == null || price.value <= 0) e.amount = 'Enter the offer price';
    if (emd.error) e.emd = emd.error;
    const days = f.closeDays.trim() ? Number(f.closeDays.replace(/[^\d]/g, '')) : null;
    const opt = f.optionDays.trim() ? Number(f.optionDays.replace(/[^\d]/g, '')) : 0;
    if (!hasPof(pof)) e.pof = pofProblem(null) ?? '';
    setErrors(e);
    if (Object.keys(e).length) return;
    const terms = { emd: emd.value, close_days: days && days > 0 ? days : null, option_days: opt || 0, contingency: f.contingency.trim() || null };
    if (demo || !workspaceId || !dealId) {
      onToast('Offer logged (demo)');
      onSaved({ id: Date.now(), buyer_id: Number(f.buyerId), amount: price.value as number, status: 'Submitted', sent_at: new Date().toISOString(), notes: f.notes || null, terms, pof_url: pof.url || null, pof_path: pof.file ? 'demo' : null, pof_verified: pof.verified, approved_by: null, approved_at: null, qualified: null, override_reason: null, ask_at_offer: ask });
      return;
    }
    setBusy(true);
    try {
      let path: string | null = null;
      if (pof.file) {
        const up = await uploadPof(workspaceId, dealId, pof.file);
        if (!up.ok) { setErrors({ pof: up.message }); return; }
        path = up.path;
      }
      const r = await createBuyerOffer(workspaceId, {
        buyerId: Number(f.buyerId), dealId, amount: price.value as number, notes: f.notes || null, userId, terms,
        pof: { url: pof.url || null, path, verified: pof.verified },
      });
      if (!r.ok) { onToast(r.message || 'Could not save the offer.', 'error'); return; }
      onToast(under ? (ask == null ? 'Offer saved. The deal has no ask, so an owner or admin has to approve it' : 'Offer saved. It is under the ask, so an owner or admin has to approve it') : 'Offer saved', 'success');
      onSaved(null);
    } finally { setBusy(false); }
  };

  const err = (k: string) => (errors[k] ? <div role="alert" style={{ fontSize: '11.5px', color: RED, marginTop: '4px' }}>{errors[k]}</div> : null);
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="Log an offer" style={{ padding: '14px', border: `1px solid ${LINE}`, borderRadius: '12px', background: '#fff', display: 'grid', gap: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,2fr) repeat(4,minmax(0,1fr))', gap: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <span style={label}>Buyer</span>
          <SearchSelect value={f.buyerId} ariaLabel="Buyer" placeholder={buyerChoices.length ? `Search ${buyerChoices.length.toLocaleString('en-US')} buyers` : 'No buyers on this workspace'}
            options={options} onChange={(v) => setF({ ...f, buyerId: v })} />
          {err('buyer')}
        </div>
        <div><label style={label} htmlFor="lo-amount">Price</label><input id="lo-amount" value={f.amount} onChange={on('amount')} inputMode="decimal" placeholder="$238,500" style={{ ...field, ...(errors.amount ? { borderColor: RED } : {}) }} />{err('amount')}</div>
        <div><label style={label} htmlFor="lo-emd">EMD</label><input id="lo-emd" value={f.emd} onChange={on('emd')} inputMode="decimal" placeholder="$5,000" style={field} />{err('emd')}</div>
        <div><label style={label} htmlFor="lo-close">Close in (days)</label><input id="lo-close" value={f.closeDays} onChange={on('closeDays')} inputMode="numeric" placeholder="14" style={field} /></div>
        <div><label style={label} htmlFor="lo-opt">Option period (days)</label><input id="lo-opt" value={f.optionDays} onChange={on('optionDays')} inputMode="numeric" placeholder="0" style={field} /></div>
      </div>
      {under && price.value != null ? (
        <div role="status" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '8px 10px', borderRadius: '8px', background: '#fef3c7', color: '#92400e', fontSize: '12.5px' }}>
          <strong style={{ fontWeight: 600 }}>{ask == null ? 'This deal has no ask set.' : `${fmt(ask - price.value)} under the ${fmt(ask)} ask.`}</strong>
          <span>It logs now; an owner or admin has to approve it before it can be accepted.</span>
        </div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1.4fr) minmax(0,1fr)', gap: '10px' }}>
        <PofField value={pof} onChange={setPof} error={errors.pof} inputStyle={field} />
        <div><label style={label} htmlFor="lo-cont">Contingency</label><input id="lo-cont" value={f.contingency} onChange={on('contingency')} placeholder="None, inspection, financing" style={field} /></div>
      </div>
      <div><label style={label} htmlFor="lo-notes">Other terms</label><textarea id="lo-notes" value={f.notes} onChange={on('notes')} rows={2} style={{ ...field, height: 'auto', padding: '8px 10px', resize: 'vertical' }} /></div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button type="button" style={btn('ghost')} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" style={btn('solid')} disabled={busy}>{busy ? 'Saving…' : 'Save offer'}</button>
      </div>
    </form>
  );
}

type StepPatch = { offer?: Partial<DeskOffer>; deal?: Partial<DispoDeal> };

/** What happens to the selected offer: approve, accept, mark sold, assign. */
function Steps({ o, deal, ask, buyer, workspaceId, userId, address, canWrite, canApprove, demo, isMobile, onToast, onAssign, assignLabel, onDone }: {
  o: DeskOffer; deal: DispoDeal | null; ask: number | null; buyer: DeskBuyer | null; workspaceId: number | null; userId: string | null; address: string;
  canWrite: boolean; canApprove: boolean; demo?: boolean; isMobile: boolean;
  onToast: (m: string, tone?: 'success' | 'error') => void; onAssign: () => void; assignLabel: string; onDone: (p: StepPatch) => void;
}) {
  const { confirm, confirmReason } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [executed, setExecuted] = useState(!!o.qualified?.executed_contract);
  const [soldPrice, setSoldPrice] = useState(String(o.amount));
  const [soldErr, setSoldErr] = useState<string | null>(null);
  const offerAsk = judgedAsk(ask, o.ask_at_offer);
  const under = needsApproval(o.amount, ask, o.ask_at_offer);
  const waiting = under && !o.approved_at;
  const accepted = isAccepted(o);
  const sold = !!deal?.sold_at;
  const q = qualifiedSale({
    buyerVerified: !!buyer?.verified, pof: o.pof_verified, executedContract: executed, emd: o.terms?.emd ?? null,
    optionDays: o.terms?.option_days ?? null, buyerClose: buyerClose(o), abClose: deal?.close_date ? String(deal.close_date).slice(0, 10) : null,
  });
  const name = buyer?.company || buyer?.name || 'this buyer';
  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); try { await fn(); } finally { setBusy(null); } };

  const approve = () => run('approve', async () => {
    const note = await confirmReason({
      title: offerAsk == null ? `Approve ${fmt(o.amount)} with no ask to judge it by?` : `Approve ${fmt(o.amount)} under the ask?`,
      body: offerAsk == null
        ? `${name} offered ${fmt(o.amount)}. ${ask != null && ask > 0 ? 'It was logged before the deal had an ask' : 'The deal has no ask'}, so the price needs your approval. It is logged on the deal.`
        : `${name} offered ${fmt(offerAsk - o.amount)} under the ${fmt(offerAsk)} ask. Your approval is logged on the deal.`,
      reasonLabel: 'Why take it', placeholder: 'Six days on market, best of four offers, closes in 10 days', confirmLabel: 'Approve offer',
    });
    if (note === null) return;
    if (demo || !workspaceId || !deal) { onDone({ offer: { approved_at: new Date().toISOString(), approved_by: userId } }); onToast('Approved (demo)'); return; }
    const r = await approveBelowAsk(workspaceId, { offerId: o.id, dealId: deal.id, buyerId: o.buyer_id, amount: o.amount, ask: offerAsk, note }, userId);
    if (!r.ok) return onToast(r.message, 'error');
    onDone({ offer: { approved_at: new Date().toISOString(), approved_by: userId } });
    onToast('Approved. It can be accepted now', 'success');
  });

  const accept = () => run('accept', async () => {
    let reason: string | null = null;
    if (!q.qualified) {
      const missing = q.items.filter((i) => !i.ok).map((i) => i.label.toLowerCase()).join(', ');
      reason = await confirmReason({
        title: 'Accept without a qualified sale?',
        body: `Missing: ${missing}. The SOP sells only to a qualified buyer, so say why this one goes ahead.`,
        reasonLabel: 'Override reason', confirmLabel: 'Accept anyway', tone: 'danger',
      });
      if (reason === null) return;
    } else if (!(await confirm({ title: `Accept ${name}'s ${fmt(o.amount)}?`, body: 'Any other accepted offer on this deal goes back to Submitted.', confirmLabel: 'Accept offer' }))) return;
    const patch = { status: 'Accepted', qualified: q.flags, override_reason: reason };
    if (demo || !workspaceId || !deal) { onDone({ offer: patch }); onToast('Accepted (demo)'); return; }
    const r = await acceptQualified(workspaceId, { offerId: o.id, dealId: deal.id, buyerId: o.buyer_id, amount: o.amount, qualified: q.flags, overrideReason: reason }, userId);
    if (!r.ok) return onToast(r.message, 'error');
    onDone({ offer: patch });
    onToast('Offer accepted. Mark it sold once the buyer contract is executed', 'success');
  });

  const markItSold = () => run('sold', async () => {
    const p = parseDollars(soldPrice);
    if (p.error || !p.value) { setSoldErr(p.error || 'Enter the sold price'); return; }
    // The same rule the database applies (migration 236): the buyer and price of this accepted offer.
    const problem = soldWriteProblem(
      { sold_at: null, sold_price: null, buyer_id: null },
      { sold_at: 'now', sold_price: p.value, buyer_id: o.buyer_id },
      [{ buyer_id: o.buyer_id, amount: o.amount }], canApprove,
    );
    if (problem) { setSoldErr(problem); return; }
    setSoldErr(null);
    if (!(await confirm({ title: `Mark ${address} sold?`, body: `${name} for ${fmt(p.value)}. The deal moves to Buyer Under Contract and acquisitions is told.`, confirmLabel: 'Mark sold' }))) return;
    if (demo || !workspaceId || !deal) { onDone({ deal: { sold_at: new Date().toISOString(), sold_price: p.value, stage: 'Buyer Under Contract' } }); onToast('Marked sold (demo)'); return; }
    const r = await markSold(workspaceId, { dealId: deal.id, buyerId: o.buyer_id, buyerName: name, price: p.value, address }, userId);
    if (!r.ok) return onToast(r.message, 'error');
    onDone({ deal: { sold_at: new Date().toISOString(), sold_price: p.value, buyer_id: o.buyer_id, stage: 'Buyer Under Contract' } });
    onToast(r.notified ? 'Sold. Acquisitions has been notified' : 'Sold. No acquisitions rep is on this deal, so nobody was notified', 'success');
  });

  const step = (n: number, title: string, done: boolean, body: React.ReactNode) => (
    <li style={{ display: 'grid', gridTemplateColumns: '24px minmax(0,1fr)', gap: '10px', padding: '12px 16px', borderTop: n > 1 ? `1px solid ${HAIR}` : 0 }}>
      <span aria-hidden="true" style={{ width: '22px', height: '22px', borderRadius: '999px', display: 'grid', placeItems: 'center', fontSize: '11px', fontWeight: 600, background: done ? GREEN : '#f4f4f5', color: done ? '#fff' : INK_2 }}>
        {done ? <Icon d={ICON.check} size={12} /> : n}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>{title}{done ? <span className="dispo-sr"> (done)</span> : null}</div>
        <div style={{ marginTop: '6px' }}>{body}</div>
      </div>
    </li>
  );

  return (
    <section aria-label={`${name}'s offer`} style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'hidden' }}>
      <header style={{ padding: '12px 16px', borderBottom: `1px solid ${HAIR}`, display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 650 }}>{name}</span>
        <span style={{ fontSize: '13.5px', fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{fmt(o.amount)}</span>
        {o.override_reason ? <span style={{ fontSize: '11.5px', color: MUTED }}>Accepted on override: {o.override_reason}</span> : null}
      </header>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {under ? step(1, 'Below-ask approval', !waiting, waiting ? (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12.5px', color: '#92400e' }}>{offerAsk == null ? (ask != null && ask > 0 ? 'Logged before the deal had an ask.' : 'The deal has no ask set.') : `${fmt(offerAsk - o.amount)} under the ask.`} Only an owner or admin can approve it.</span>
            {canApprove && canWrite ? <button type="button" style={btn('solid', true)} disabled={!!busy} onClick={() => void approve()}>{busy === 'approve' ? 'Approving…' : 'Approve'}</button> : null}
          </div>
        ) : <span style={{ fontSize: '12.5px', color: INK_2 }}>Approved {o.approved_at ? dateLabel(o.approved_at) : ''}. Logged on the deal.</span>) : null}
        {step(under ? 2 : 1, 'Qualified sale', accepted, (
          <div style={{ display: 'grid', gap: '10px' }}>
            <ul aria-label="Qualified-sale checklist" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2,minmax(0,1fr))', gap: '6px 16px' }}>
              {q.items.map((i) => (
                <li key={i.key} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', fontSize: '12.5px', color: INK }}>
                  <span style={{ color: i.ok ? GREEN : RED, marginTop: '1px' }}><Icon d={i.ok ? ICON.check : ICON.x} size={13} /></span>
                  <span>
                    {i.key === 'executed_contract' && !accepted && canWrite ? (
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                        <input type="checkbox" checked={executed} onChange={(e) => setExecuted(e.target.checked)} style={{ width: '15px', height: '15px', accentColor: GREEN }} />
                        {i.label}
                      </label>
                    ) : i.label}
                    <span className="dispo-sr">{i.ok ? ': yes' : ': no'}</span>
                    {i.detail ? <span style={{ display: 'block', fontSize: '11.5px', color: MUTED }}>{i.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            {!accepted && canWrite ? (
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" style={btn('solid', true)} disabled={!!busy || waiting} onClick={() => void accept()}>{busy === 'accept' ? 'Accepting…' : 'Accept offer'}</button>
                {waiting ? <span style={{ fontSize: '11.5px', color: MUTED }}>Waiting on the below-ask approval.</span>
                  : !q.qualified ? <span style={{ fontSize: '11.5px', color: MUTED }}>Not qualified yet. Accepting asks for an override reason.</span> : null}
              </div>
            ) : null}
          </div>
        ))}
        {step(under ? 3 : 2, 'Mark sold and tell acquisitions', sold, sold ? (
          <span style={{ fontSize: '12.5px', color: INK_2 }}>Sold for {fmt(deal?.sold_price == null ? null : Number(deal.sold_price))}. Acquisitions has the notification.</span>
        ) : !accepted ? <span style={{ fontSize: '12.5px', color: MUTED }}>Accept the offer first.</span> : canWrite ? (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <label htmlFor={`sold-${o.id}`} style={label}>Sold price</label>
              <input id={`sold-${o.id}`} value={soldPrice} onChange={(e) => setSoldPrice(e.target.value)} inputMode="decimal" style={{ ...field, width: '150px', ...(soldErr ? { borderColor: RED } : {}) }} />
              {soldErr ? <div role="alert" style={{ fontSize: '11.5px', color: RED, marginTop: '4px' }}>{soldErr}</div> : null}
            </div>
            <button type="button" style={{ ...btn('solid', true), marginTop: '21px' }} disabled={!!busy} onClick={() => void markItSold()}>{busy === 'sold' ? 'Saving…' : 'Mark sold'}</button>
          </div>
        ) : null)}
        {step(under ? 4 : 3, 'Hand to TC', false, !sold ? <span style={{ fontSize: '12.5px', color: MUTED }}>Mark it sold first.</span> : (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12.5px', color: INK_2 }}>The deal is at Buyer Under Contract. TC generates the assignment and closes in 14 to 21 days.</span>
            <button type="button" style={btn('ghost', true)} onClick={onAssign}>{assignLabel}</button>
          </div>
        ))}
      </ol>
    </section>
  );
}
