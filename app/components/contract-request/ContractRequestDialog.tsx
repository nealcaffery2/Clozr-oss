// Request contract: the popup the dialer opens. It fills from the seller or
// buyer on the line (or the number loaded before a call): party, address,
// the price from the offer or MAO, the closing date the record states, and
// the call so far. Send to TC makes a DRAFT in Contracts (nothing goes out
// for signature) and alerts the TC. Once it is sent, it offers a warm
// transfer to the TC for the contract details; it never starts one itself.
'use client';

import React, { useEffect, useId, useMemo, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { AddInput } from '@/components/ds/AddInput';
import { useSoftphone } from '@/app/components/talkr/softphoneAdapter';
import { KIND_LABELS, type ContractKind, type LibraryTemplate, TOKEN_HELP, renderClozr } from '@/lib/contracts';
import {
  type RequestForm, type RequestSide, autofillRequest, buildRequestPayload, kindFor, longDate, priceSource, requestProblems, tcFirstNames, tcRecipients, withDeal,
} from '@/lib/contract-request';
import { defaultTemplate, requestTemplates, sendToTc } from '@/lib/contract-request-api';
import { addDemoRequest, closeRequestDialog, pushAlert, requestWarmTransfer, setPendingContract } from '@/lib/contract-request-store';
import { C, Dialog, DialogHead, Field, Glyph, btn, field } from './parts';

/** Kinds offered when there is no template to pick from (the sample data), or "the TC picks the template". */
const KINDS: ContractKind[] = ['psa', 'assignment', 'offer', 'option', 'amendment', 'addendum', 'termination', 'other'];
/** Fill-ins the form already asks for, so the template's list leaves them out. */
const COVERED = new Set(['Deal.PurchasePrice', 'Trec.SalesPrice', 'Offer.Amount', 'Option.Price', 'Deal.AssignmentPrice', 'Deal.BuyerEMD', 'Deal.EMD', 'Trec.EarnestMoney', 'Offer.EMD', 'Deal.ClosingDate', 'Trec.ClosingDate', 'Property.FullAddress', 'Property.Address', 'Seller.Name', 'Seller.Email', 'Seller.Phone', 'Buyer.Name', 'Buyer.Email', 'Buyer.Phone']);
const label = (name: string) => TOKEN_HELP.find(([n]) => n === name)?.[1]
  ?? name.replace(/^Fill\./, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace('.', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
const sameName = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
const first = (name: string) => name.trim().split(/\s+/)[0] || name;

type Sent = { contractId: number | null; demoId: string | null; why: string | null; notified: string[] };

export function ContractRequestDialog({ V, phone }: { V: ClozrView; phone: string | null }) {
  const titleId = useId();
  // Read once, when the popup opens: the call keeps going underneath.
  const [opened] = useState(() => V.contractRequestFor(phone));
  // A buyer with more than one live deal: the one picked below is the record the request reads.
  const [rec, setRec] = useState(opened.record);
  const [dealKey, setDealKey] = useState(opened.record?.deals?.[0]?.key ?? '');
  const ctx = useMemo(() => ({ ...opened, record: rec }), [opened, rec]);
  const [form, setForm] = useState<RequestForm>(() => autofillRequest(opened));
  const [tcPicks, setTcPicks] = useState(false);
  const ws = V.liveIds?.workspaceId ?? null;
  const [templates, setTemplates] = useState<LibraryTemplate[] | null>(ws ? null : []);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const loadingTemplates = templates === null;
  const [fillIns, setFillIns] = useState<{ id: number; names: string[] } | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [hideTip, setHideTip] = useState(false);
  const sp = useSoftphone();

  const tcs = useMemo(() => tcRecipients(V.requestTeam, V.requestMe), [V.requestTeam, V.requestMe]);
  const tcName = tcFirstNames(tcs);
  const tcFull = tcs[0]?.name ?? 'the TC';
  const partyFirst = first(form.partyName || rec?.name || 'them');
  const canSave = ctx.demo || !!V.liveIds?.canWrite;

  useEffect(() => {
    if (!ws) return;
    let live = true;
    // A failed load settles to no templates, so Send still files the request (the TC starts the draft).
    requestTemplates(ws).then(
      (list) => { if (live) setTemplates(list); },
      () => { if (live) { setTemplates([]); setTemplatesFailed(true); } },
    );
    return () => { live = false; };
  }, [ws]);

  const chosen = !templates?.length || tcPicks ? null
    : templates.find((t) => t.id === form.templateId) ?? defaultTemplate(templates, form.kind);
  const chosenId = chosen?.id ?? null;
  const sellerId = rec?.sellerId ?? null, buyerId = rec?.buyerId ?? null, dealId = rec?.dealId ?? null;
  // The template's own fill-ins the record cannot answer, so the TC gets them typed in.
  useEffect(() => {
    if (!ws || chosenId == null || (!sellerId && !buyerId && !dealId)) return;
    let live = true;
    void renderClozr(ws, { templateId: chosenId, sellerId, dealId, buyerId }).then((r) => {
      if (!live || !r.ok) return;
      setFillIns({ id: chosenId, names: r.data.missing.filter((n) => !n.startsWith('Company.') && !COVERED.has(n)).slice(0, 6) });
    });
    return () => { live = false; };
  }, [ws, chosenId, sellerId, buyerId, dealId]);
  const extra = fillIns && fillIns.id === chosenId ? fillIns.names : [];

  const set = (patch: Partial<RequestForm>) => setForm((f) => ({ ...f, ...patch }));
  const problems = requestProblems(form);
  const callLive = ctx.demo ? V.callState === 'live' : sp.callState === 'in_call' && !!sp.active;
  const tcOnTalkr = ctx.demo ? null : sp.team.find((m) => !m.is_self && tcs.some((t) => sameName(t.name, m.display_name))) ?? null;

  function warmTransfer() {
    if (ctx.demo) { V.showToast(`Sample data: on a live call this rings ${tcFull} while ${partyFirst} holds.`); return; }
    if (!tcOnTalkr) return;
    requestWarmTransfer(tcOnTalkr.id);
    V.showToast(`Ringing ${tcFull}. ${partyFirst} is on hold until you complete the transfer.`);
    closeRequestDialog();
  }

  async function submit() {
    setTried(true);
    if (problems.length || busy || !canSave || loadingTemplates) return;
    setBusy(true); setErr(null);
    const f = chosen ? { ...form, templateId: chosen.id, templateName: chosen.name, kind: (chosen.kind as ContractKind) } : form;
    if (ctx.demo || !ws) {
      // The sample data saves nothing: the request stays in this browser, and
      // the TC's alert shows here, labelled as her view.
      const payload = buildRequestPayload(f, ctx, { contractId: null, sellerId, buyerId, dealId });
      const r = addDemoRequest(payload, tcFull);
      setSent({ contractId: null, demoId: r.id, why: null, notified: tcs.map((t) => t.name) });
      setBusy(false);
      window.setTimeout(() => pushAlert({ key: `demo:${r.id}`, notificationId: null, payload: { ...payload, contract_id: null }, createdAt: Date.now(), demoAs: tcFull }), 1400);
      return;
    }
    const out = await sendToTc(ws, f, ctx, chosen, V.requestMe);
    setBusy(false);
    if (!out.filed.ok) {
      setErr(`${out.filed.message}${out.draft.contractId ? ' The draft is saved in Contracts.' : ''}`);
      return;
    }
    setSent({ contractId: out.draft.contractId, demoId: null, why: out.draft.why, notified: out.filed.data.notified.map((n) => n.name) });
  }

  function openDraft() {
    if (!sent) return;
    setPendingContract(sent.contractId ?? sent.demoId);
    closeRequestDialog();
    V.goContracts();
  }

  const tip = callLive && !hideTip ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 10, background: C.tintPale, border: `1px solid ${C.tintLine}` }}>
      <span style={{ color: C.accent, display: 'inline-flex' }}><Glyph name="transfer" size={16} /></span>
      <span style={{ flex: '1 1 220px', minWidth: 0, fontSize: 12.5, color: C.ink2, lineHeight: 1.4 }}>
        Want {tcName} on the line for the contract details? She can confirm the terms while {partyFirst} is still on.
        {!ctx.demo && !tcOnTalkr ? <span style={{ display: 'block', color: C.muted, fontSize: 11.5 }}>{tcFull} has no Talkr line yet, so a transfer cannot reach her.</span> : null}
      </span>
      <button type="button" onClick={warmTransfer} disabled={!ctx.demo && !tcOnTalkr} style={{ ...btn('secondary'), opacity: !ctx.demo && !tcOnTalkr ? 0.5 : 1 }}>
        Warm transfer
      </button>
      <button type="button" onClick={() => setHideTip(true)} aria-label="Hide the transfer suggestion" style={{ ...btn('quiet'), width: 32, padding: 0 }}>
        <Glyph name="x" size={14} />
      </button>
    </div>
  ) : null;

  if (sent) {
    const where = [KIND_LABELS[(chosen?.kind as ContractKind) ?? form.kind] ?? 'Contract', form.partyName, form.address.split(',')[0]].filter(Boolean).join(' · ');
    return (
      <Dialog labelledBy={titleId} onClose={closeRequestDialog} width={560}>
        <DialogHead id={titleId} onClose={closeRequestDialog}
          title={`Sent to ${sent.notified.length ? tcFirstNames(sent.notified.map((name) => ({ name }))) : tcName}`}
          sub={ctx.demo ? 'Sample data: nothing was saved. Her alert opens on this screen as her view.' : sent.contractId ? 'The draft is in Contracts. Nothing goes out for signature until she sends it.' : sent.why} />
        <div role="status" style={{ padding: '16px 18px', display: 'grid', gap: 14, overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 32, height: 32, borderRadius: 8, background: C.tint, color: C.accent, display: 'grid', placeItems: 'center', flex: 'none' }}><Glyph name="check" size={16} /></span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={where}>{where}</div>
              <div style={{ fontSize: 11.5, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
                {[form.price ? `$${form.price.replace(/^\$/, '')}` : '', form.closingDate ? `Close ${longDate(form.closingDate)}` : '', form.emd ? `EMD $${form.emd.replace(/^\$/, '')}` : ''].filter(Boolean).join(' · ') || 'Price and dates left for the TC'}
              </div>
            </div>
          </div>
          {tip}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', padding: '12px 18px', borderTop: `1px solid ${C.line}`, background: C.page }}>
          <button type="button" onClick={openDraft} style={btn('ghost', 36)}>
            <Glyph name="file" size={15} />
            {sent.contractId || sent.demoId ? 'Open draft' : 'Open Contracts'}
          </button>
          <button type="button" data-autofocus onClick={closeRequestDialog} style={btn('primary', 36)}>Done</button>
        </div>
      </Dialog>
    );
  }

  const kindValue = chosen ? `t:${chosen.id}` : `k:${form.kind}`;
  const pickContract = (v: string) => {
    if (v.startsWith('t:')) {
      const t = templates?.find((x) => x.id === Number(v.slice(2)));
      if (t) { setTcPicks(false); set({ templateId: t.id, templateName: t.name, kind: (t.kind as ContractKind) }); }
    } else { setTcPicks(true); set({ templateId: null, templateName: '', kind: v.slice(2) as ContractKind }); }
  };
  const pickSide = (side: RequestSide) => {
    // A contract the rep has not chosen follows who signs: seller → purchase agreement, buyer → assignment.
    set({ side, ...(form.templateId == null ? { kind: kindFor(side) } : {}) });
  };
  const pickDeal = (key: string) => {
    const deal = rec?.deals?.find((d) => d.key === key);
    if (!rec || !deal) return;
    const next = withDeal(rec, deal);
    setDealKey(key);
    setRec(next);
    const a = autofillRequest({ ...ctx, record: next });
    set({ address: a.address, price: a.price, closingDate: a.closingDate });
  };
  const from = rec ? `From ${rec.name}'s ${rec.side} record` : 'No record for this number: type it in';
  const callLine = ctx.summary ? 'Talkr’s summary of the call' : form.summary ? `The last ${Math.min(8, ctx.transcript.length)} lines of the transcript` : 'Nothing said yet';

  return (
    <Dialog labelledBy={titleId} onClose={closeRequestDialog} width={680} scrimClose={false}>
      <DialogHead id={titleId} onClose={closeRequestDialog} title="Request a contract"
        sub={<>{rec ? <><strong style={{ fontWeight: 600, color: C.ink2 }}>{rec.name}</strong>{rec.phone ? ` · ${rec.phone}` : ''}{callLive ? ' · on the call now' : ''}</> : `Unknown number${ctx.caller?.phone ? ` · ${ctx.caller.phone}` : ''}`}. {tcFull} gets a draft in Contracts and an alert.</>} />
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <div style={{ overflow: 'auto', padding: '14px 18px 18px', display: 'grid', gap: 16 }}>
          {tip}
          <section aria-label="Contract" style={grid}>
            <Field label="Contract" wide hint={chosen ? `Drafted on ${chosen.name}, filled from the record` : loadingTemplates ? 'Loading templates…' : templatesFailed ? `Templates did not load, so ${tcName} starts the draft` : ws ? `${tcName} picks the template` : 'Sample data has no templates; the TC picks one'}>
              <select data-autofocus value={kindValue} onChange={(e) => pickContract(e.target.value)} style={field}>
                {templates?.length ? (
                  <optgroup label="Templates">
                    {templates.map((t) => <option key={t.id} value={`t:${t.id}`}>{t.name} ({KIND_LABELS[t.kind as ContractKind] ?? t.kind})</option>)}
                  </optgroup>
                ) : null}
                <optgroup label={templates?.length ? 'Let the TC pick the template' : 'Contract type'}>
                  {KINDS.map((k) => <option key={k} value={`k:${k}`}>{KIND_LABELS[k]}{k === 'psa' ? ' (from the seller)' : k === 'assignment' ? ' (to the buyer)' : ''}</option>)}
                </optgroup>
              </select>
            </Field>
            <div role="radiogroup" aria-label="Who signs" style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, fontWeight: 500, color: C.muted, marginRight: 4 }}>Who signs</span>
              {(['seller', 'buyer'] as const).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={form.side === s} onClick={() => pickSide(s)}
                  style={{ height: 28, padding: '0 11px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    border: `1px solid ${form.side === s ? C.ink : C.line}`, background: form.side === s ? C.ink : 'var(--surface, #fff)', color: form.side === s ? 'var(--surface, #fff)' : C.ink2 }}>
                  {s === 'seller' ? 'Seller' : 'Buyer'}
                </button>
              ))}
              <span style={{ fontSize: 11.5, color: C.muted }}>{from}</span>
            </div>
          </section>

          <section aria-label="Party" style={grid}>
            <Field label={form.side === 'buyer' ? 'Buyer name' : 'Seller name'}>
              <input value={form.partyName} onChange={(e) => set({ partyName: e.target.value })} autoComplete="off" style={field} aria-invalid={tried && form.partyName.trim().length < 2} />
            </Field>
            <Field label="Phone">
              <input type="tel" value={form.partyPhone} onChange={(e) => set({ partyPhone: e.target.value })} autoComplete="off" style={{ ...field, fontVariantNumeric: 'tabular-nums' }} />
            </Field>
            <Field label="Email">
              <input type="email" value={form.partyEmail} onChange={(e) => set({ partyEmail: e.target.value })} autoComplete="off" spellCheck={false} style={field} />
            </Field>
          </section>

          <section aria-label="Property and terms" style={grid}>
            {rec?.deals && rec.deals.length > 1 ? (
              <Field label="Deal" wide hint={`${rec.name} is on ${rec.deals.length} live deals. Pick the one this contract is for.`}>
                <select value={dealKey} onChange={(e) => pickDeal(e.target.value)} style={field}>
                  {rec.deals.map((d) => <option key={d.key} value={d.key}>{d.address || 'No address yet'}</option>)}
                </select>
              </Field>
            ) : null}
            <Field label="Property address" wide hint={rec?.address && form.address === rec.address ? 'From the record. Type to change it; suggestions fill the street, city and ZIP.' : 'Suggestions fill the street, city and ZIP.'}>
              <AddInput placesKey={V.placesKey}
                f={{ key: 'cr-addr', value: form.address, ph: 'Street address', addr: true, set: (e) => set({ address: e.target.value }) }}
                onPlace={(p) => set({ address: [p.addr, p.city, [p.st, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') })}
                style={field} />
            </Field>
            <Field label={form.kind === 'assignment' ? 'Assignment price' : 'Purchase price'} hint={priceSource(rec) || 'In dollars, like 185,000 or 185k'}>
              <input inputMode="decimal" value={form.price} onChange={(e) => set({ price: e.target.value })} placeholder="185,000" style={{ ...field, fontVariantNumeric: 'tabular-nums' }} />
            </Field>
            <Field label="Closing date" hint={rec?.desiredClose && rec.desiredClose !== '—' ? `Record says ${rec.desiredClose}` : undefined}>
              <input type="date" value={form.closingDate} onChange={(e) => set({ closingDate: e.target.value })} style={{ ...field, fontVariantNumeric: 'tabular-nums' }} />
            </Field>
            <Field label="Earnest money">
              <input inputMode="decimal" value={form.emd} onChange={(e) => set({ emd: e.target.value })} placeholder="1,000" style={{ ...field, fontVariantNumeric: 'tabular-nums' }} />
            </Field>
            {extra.map((name) => (
              <Field key={name} label={label(name)}>
                <input value={form.terms[name] ?? ''} onChange={(e) => set({ terms: { ...form.terms, [name]: e.target.value } })} style={field} />
              </Field>
            ))}
          </section>

          <section aria-label={`For ${tcName}`} style={grid}>
            <Field label={`Notes for ${tcName}`} wide>
              <textarea value={form.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} placeholder="Repairs the seller is leaving, who else is on title, anything she should ask" style={{ ...field, height: 'auto', padding: '8px 10px', lineHeight: 1.45, resize: 'vertical' }} />
            </Field>
            <Field label="From the call" wide hint={`${callLine}. Saved on the draft for ${tcName}; edit anything that is wrong.`}>
              <textarea value={form.summary} onChange={(e) => set({ summary: e.target.value })} rows={5} style={{ ...field, height: 'auto', padding: '8px 10px', lineHeight: 1.45, resize: 'vertical', color: C.ink2 }} />
            </Field>
          </section>

          {tried && problems.length ? (
            <div role="alert" style={{ fontSize: 12.5, color: C.red, lineHeight: 1.5 }}>{problems.join(' ')}</div>
          ) : null}
          {err ? <div role="alert" style={{ fontSize: 12.5, color: C.red, lineHeight: 1.5 }}>{err}</div> : null}
          {!canSave ? <div role="status" style={{ fontSize: 12.5, color: C.amber }}>Viewing as a teammate saves nothing, so this cannot be sent.</div> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '12px 18px', borderTop: `1px solid ${C.line}`, background: C.page }}>
          <span style={{ flex: '1 1 260px', fontSize: 11.5, color: C.muted, lineHeight: 1.4 }}>
            Goes to {tcs.map((t) => t.name).join(', ') || 'the TC'} as a draft. Nothing is sent for signature.
          </span>
          <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button type="button" onClick={closeRequestDialog} style={btn('ghost', 36)}>Cancel</button>
            <button type="submit" disabled={busy || !canSave || loadingTemplates} style={{ ...btn('primary', 36), opacity: busy || !canSave || loadingTemplates ? 0.5 : 1, cursor: busy || !canSave || loadingTemplates ? 'not-allowed' : 'pointer' }}>
              {busy ? 'Sending to TC…' : loadingTemplates ? 'Loading templates…' : 'Send to TC'}
            </button>
          </span>
        </div>
      </form>
    </Dialog>
  );
}

const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(176px, 1fr))', gap: '12px 12px' };
