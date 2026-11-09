// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import { ScreenHeader } from '@/components/ds/Screen';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { DealTeam } from '@/components/DealTeam';
import { BuyerDesk } from '@/app/components/buyer/BuyerDesk';
import { buyerStatusTone } from '@/lib/people-colors';
import { TypeChip } from '@/components/TypeChip';
import { buyersNavAction, isArchiveChord, isTypingTarget, recordNavBlocked } from '@/lib/people-keys';
import { Mark, TireChip } from '@/components/ds/mark';
import { useBuyerScores } from '@/app/clozr/useBuyerScores';
import { responseTone } from '@/lib/heat';
import { isTireKicker } from '@/lib/tire-kicker';
import { BlacklistButton } from '@/components/BlacklistButton';
import { openReach } from '@/app/components/record/reach';
import { CalendarIcon, openMeetingInvite } from '@/app/components/meeting/MeetingInvite';
import { Composer } from '@/app/components/record/Composer';
import { SmartSummary } from '@/app/components/record/SmartSummary';
import { ActivityChips } from '@/app/components/record/ActivityChips';
import { ActivityStream, feedToStream as toStream, readOrder, saveOrder, type StreamOrder } from '@/app/components/record/ActivityStream';
import { pinTimelineEntry, setBuyerStage } from '@/lib/crm-write';
import { BuyerHeadFields, BuyerProfileFields } from '@/app/components/buyer/BuyerProfileFields';
import { CompanyChart } from '@/app/components/buyer/CompanyChart';
import { buyerStagesFor, COMPR_STAGES } from '@/lib/stages';
import { BulkSkipTrace } from '@/components/BulkSkipTrace';
import { CenteredDialog, ContractPopup } from '@/components/ContractsHub';
import { AiAgentToggle } from '@/app/components/ai-agent/AiAgentToggle';
import { isProtectedBuyer } from '@/lib/ai-agent-client';
import { Button } from '@/components/ds/Button';
import { SectionLabel } from '@/components/ds/Text';
import { textTone } from '@/lib/text-tone';
import { MessageSquare, Phone } from 'lucide-react';
import { BuyerContact } from '@/app/components/buyer/BuyerContact';
import { useRailPrefs } from '@/app/components/record/useRailPrefs';
import { RailSplit } from '@/app/components/record/RailSplit';
import { MoreMenu } from '@/app/components/record/MoreMenu';
import { ContractTemplatePicker } from '@/components/ContractTemplatePicker';
import { ComprAccountCard } from '@/app/components/buyer/ComprStubs';
import { PaymentLinkDialog } from '@/app/components/buyer/ComprStubs';
import { TRIAL_DEFAULT_DAYS } from '@/lib/compr-payment-link';
import '@/app/components/record/record.css';

const FEED_CHIPS = [['All', 'All'], ['Calls', 'call'], ['Texts', 'sms'], ['Email', 'mail'], ['Notes', 'note']] as const;
const chanIs = (chan: string, key: string) => key === 'All' || chan.toLowerCase().includes(key) || (key === 'sms' && chan.toLowerCase().includes('text'));

export function BuyerRecord({ V }: { V: ClozrView }) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [dealMenu, setDealMenu] = useState(false);
  const [pickingContract, setPickingContract] = useState(false);
  // false: closed; null: open, nothing picked; a number: open on that template (-1 for "other").
  const [contractsPop, setContractsPop] = useState<number | null | false>(false);
  const buyerId = V.liveIds ? V.B.dbId ?? null : null;
  // This buyer's response rate from buyer-score, refreshed when it is a day old
  // (a cached answer unless they have new history).
  const scoreIds = useMemo(() => (buyerId != null ? [buyerId] : []), [buyerId]);
  const aiScores = useBuyerScores(V.liveIds?.workspaceId ?? null, scoreIds, V.showToast);
  const comprProfile = V.buyerListProfile === 'compr';
  const resp = (() => {
    const ai = buyerId != null ? aiScores.scores.get(buyerId) : undefined;
    const fresh = ai && ai.responseRate != null && ai.touches > 0;
    const pct = fresh ? ai!.responseRate! : V.B.responseKnown === false ? null : V.B.engagement;
    const tk = comprProfile ? false : fresh ? isTireKicker({ sent: ai!.touches, responsePct: ai!.responseRate!, offers: ai!.offers, purchases: ai!.closed }) : !!V.B.tireKicker;
    const sent = fresh ? ai!.touches : V.B.sent ?? null;
    const answered = fresh ? ai!.answered : sent != null && pct != null ? Math.round((sent * pct) / 100) : null;
    return { pct, tk, tone: responseTone(pct, tk), sent, answered };
  })();
  const live = useRef(V);
  // Newest at the bottom like a chat, unless this user flipped it (shared key with the seller record).
  const [order, setOrderState] = useState<StreamOrder>('asc');
  useEffect(() => { const t = setTimeout(() => setOrderState(readOrder()), 0); return () => clearTimeout(t); }, []);
  const setOrder = (o: StreamOrder) => { setOrderState(o); saveOrder(o); };
  const [chip, setChip] = useState<string>('All');
  const feed = V.buyerTimeline;
  const chips = FEED_CHIPS.map(([label, key]) => ({ label, pressed: chip === label, count: key === 'All' ? null : feed.filter((t) => chanIs(t.chan, key)).length, go: () => setChip(label) }));
  // Pin to top on a buyer row: communications.pinned_at through the seller's writer (crm-write pinTimelineEntry), shown at once.
  const [pins, setPins] = useState<Record<string, boolean>>({});
  const pin = useMemo(() => ({
    is: (id: string, fallback: boolean) => (id in pins ? pins[id] : fallback),
    toggle: (id: string, now: boolean) => {
      setPins((p) => ({ ...p, [id]: !now }));
      if (V.liveIds?.canWrite) void pinTimelineEntry(id.replace(/:b$/, ''), !now, V.liveIds.userId).then((r) => { if (!r.ok) { setPins((p) => ({ ...p, [id]: now })); V.showToast(r.message || 'Could not pin that.', 'error'); } });
    },
  }), [pins, V]);
  const streamItems = useMemo(() => feed.filter((t) => chanIs(t.chan, FEED_CHIPS.find(([l]) => l === chip)?.[1] ?? 'All')).map((t) => toStream(t, pin)), [feed, chip, pin]);
  const { prefs: rails, toggle: toggleRail, setWidth } = useRailPrefs('clozr.buyer.rails');
  const leftRail = useRef<HTMLElement | null>(null);
  const rightRail = useRef<HTMLElement | null>(null);
  const colW = (open: boolean, w: number | undefined) => (!open ? '36px' : w ? `${w}px` : 'var(--rec-side)');
  useEffect(() => { live.current = V; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const v = live.current;
      const blocked = recordNavBlocked({
        onRecord: true,
        typing: isTypingTarget(t),
        dialogOrMenu: !!document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"]'),
        addOpen: !!v.addOpen,
        searchOpen: v.searchOpen,
        phoneUp: v.phoneUp,
        inDialer: !!t?.closest?.('[data-screen-label="Talkr dialer"], [data-testid="phone-root"]'),
      });
      if (isArchiveChord(e, blocked)) { e.preventDefault(); v.archiveOpenRecord('buyer'); return; }
      const nav = buyersNavAction(e, blocked);
      if (!nav) return;
      e.preventDefault();
      if (nav.type === 'list') v.moveBuyerList(nav.dir);
      else v.moveOpenBuyer(nav.dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const plan = V.buyerPlan;
  // The Compr workspace sells Compr: no deal sheet, TC, deal sends, buy box or
  // proof of funds. It gets a free trial link and an invoice (a Stripe
  // checkout link through compr-payment-link) beside Text and Email instead.
  const compr = V.buyerListProfile === 'compr';
  const [paying, setPaying] = useState<'invoice' | 'trial' | null>(null);
  // The docked quick text / quick email every Text and Email button opens, filed on this buyer.
  const reachBuyer = (ch: 'text' | 'email') => openReach(ch, {
    name: V.B.name, phone: V.B.phone, email: V.B.email.includes('@') ? V.B.email : '',
    buyerId: V.B.dbId, audience: 'buyer',
  });
  return (
    <section data-screen-label="Buyer record" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
      {(() => {
        const back = V.backFor('buyers');
        const to = back.to.screen === 'buyers' && V.buyerList !== 'buyers' ? { ...back, label: V.buyerListLabel } : back;
        return (
      V.isMobile ? (() => {
        // The seller record's phone header (RecordHeader): Call on the title
        // row, then Text and More. Everything else moves into More instead
        // of wrapping into three rows of buttons.
        const meet = () => openMeetingInvite({
          name: V.B.name || V.B.company, email: V.B.email.includes('@') ? V.B.email : '', phone: V.B.phone && V.B.phone !== '—' ? V.B.phone : '',
          buyerId: V.B.dbId ?? null, typeKey: V.buyerListProfile === 'compr' ? 'demo' : 'check_in',
        });
        const sends = V.sendDealOptions || [];
        const items = [
          { key: 'email', label: 'Email', group: 'Reach', run: () => reachBuyer('email') },
          { key: 'meet', label: 'Send a meeting invite', group: 'Reach', run: meet },
          ...(V.can.dealSheet && !compr ? [{ key: 'dealSheet', label: 'Deal sheet', group: 'Deal', run: V.openBuyerDealSheet }] : []),
          ...(V.can.tc && !compr ? [{ key: 'tc', label: 'Transaction coordination', group: 'Deal', run: V.openBuyerTc }] : []),
          ...(compr ? [
            { key: 'trial', label: 'Free trial', group: 'Compr', run: () => setPaying('trial') },
            { key: 'invoice', label: 'Invoice', group: 'Compr', run: () => setPaying('invoice') },
          ] : sends.length ? sends.map((d) => ({ key: 'send-' + d.id, label: d.label, group: 'Send a deal', run: d.go }))
            : [{ key: 'send', label: 'Send a deal', group: 'Send a deal', note: 'No active inventory', run: () => V.showToast('No active inventory to send. Put a deal under contract first.') }]),
          ...(buyerId != null && V.liveIds?.workspaceId && !compr ? [
            ...(V.liveIds.canWrite ? [{ key: 'newContract', label: 'New contract', group: 'Contracts', note: 'pick a template', run: () => setPickingContract(true) }] : []),
            { key: 'contracts', label: 'Contracts', group: 'Contracts', note: 'sent and signed', run: () => setContractsPop(null) },
          ] : []),
        ];
        return (
          <ScreenHeader back={to} title={V.B.company || V.B.name} actions={
            <Button kind="solid" onClick={V.callBuyer} aria-label={'Call ' + (V.B.name || V.B.company)} title="Call" icon={<Phone size={16} aria-hidden />} style={{ height: '44px', padding: '0 14px' }}>Call</Button>
          }>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <AiAgentToggle workspaceId={V.liveIds?.workspaceId} kind="buyer" recordId={V.liveIds ? V.B.dbId : null}
                recordName={V.B.name || V.B.company} canWrite={!!V.liveIds?.canWrite} mobile
                offLimits={isProtectedBuyer({ vip: V.B.status === 'VIP', type: V.B.type }) ? 'VIP buyers and funds stay with the team' : null} />
              <Button onClick={() => reachBuyer('text')} icon={<MessageSquare size={15} aria-hidden />} style={{ flex: 1, height: '44px' }}>Text</Button>
              <MoreMenu items={items} mobile />
            </div>
          </ScreenHeader>
        );
      })() : (
      <ScreenHeader back={to} title={V.B.company || V.B.name} actions={<>
        {/* The AI agent switch (migration 123). VIPs and funds show it as off limits. */}
        <AiAgentToggle workspaceId={V.liveIds?.workspaceId} kind="buyer" recordId={V.liveIds ? V.B.dbId : null}
          recordName={V.B.name || V.B.company} canWrite={!!V.liveIds?.canWrite} mobile={V.isMobile}
          offLimits={isProtectedBuyer({ vip: V.B.status === 'VIP', type: V.B.type }) ? 'VIP buyers and funds stay with the team' : null} />
        {V.can.dealSheet && !compr ? (
          <Button data-testid="buyer-deal-sheet" onClick={V.openBuyerDealSheet} title="Open the deal sheet">
            Deal sheet
          </Button>
        ) : null}
        {V.can.tc && !compr ? (
          <Button data-testid="buyer-tc" onClick={V.openBuyerTc} title="Open transaction coordination" icon={<span style={{display: "inline-flex", color: "var(--tx-green-deep, #1f7a4d)"}}><Mark label="TC" /></span>}>
            TC
          </Button>
        ) : null}
        <Button onClick={V.callBuyer}>Call</Button>
        <Button onClick={() => reachBuyer('text')}>Text</Button>
        <Button onClick={() => reachBuyer('email')}>Email</Button>
        {compr ? (
          <>
            <Button data-testid="buyer-trial-link" onClick={() => setPaying('trial')} title="Email or text a Compr link with a free trial">
              Free trial
            </Button>
            <Button data-testid="buyer-invoice" onClick={() => setPaying('invoice')} title="Email or text a Compr invoice: a checkout link for the plan you pick">
              Invoice
            </Button>
          </>
        ) : null}
        <Button data-testid="buyer-meet" title="Send a meeting invite with a Google Meet link" icon={<CalendarIcon size={13} />}
          onClick={() => openMeetingInvite({
            name: V.B.name || V.B.company, email: V.B.email.includes('@') ? V.B.email : '', phone: V.B.phone && V.B.phone !== '—' ? V.B.phone : '',
            buyerId: V.B.dbId ?? null, typeKey: V.buyerListProfile === 'compr' ? 'demo' : 'check_in',
          })}>
          Meeting
        </Button>
        {buyerId != null && V.liveIds?.workspaceId && !compr ? (
          <MoreMenu items={[
            ...(V.liveIds.canWrite ? [{ key: 'newContract', label: 'New contract', group: 'Contracts', note: 'pick a template', run: () => setPickingContract(true) }] : []),
            { key: 'contracts', label: 'Contracts', group: 'Contracts', note: 'sent and signed', run: () => setContractsPop(null) },
          ]} />
        ) : null}
        {compr ? null : <div style={{position: "relative", flex: "none"}}>
          <Button kind="primary" aria-haspopup="menu" aria-expanded={dealMenu} onClick={() => ((V.sendDealOptions || []).length ? setDealMenu(!dealMenu) : V.showToast('No active inventory to send. Put a deal under contract first.'))}
            iconRight={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>}>
            Send a deal
          </Button>
          {dealMenu ? (
            <>
            <div onClick={() => setDealMenu(false)} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
            <div style={{position: "absolute", top: "38px", right: "0", minWidth: "260px", maxWidth: "min(360px, calc(100vw - 24px))", maxHeight: "min(340px, 46vh)", overflow: "auto", background: "var(--c-menu-bg)", border: "1px solid var(--c-menu-line)", borderRadius: "12px", boxShadow: "var(--shadow-md)", zIndex: "45", padding: "4px"}}>
              <div style={{padding: "7px 9px 4px", fontSize: "11.5px", fontWeight: "600", color: "var(--meta, #71717a)"}}>Into the campaign for…</div>
              {(V.sendDealOptions || []).map((d) => (
                <button key={d.id} className="dc2" onClick={() => { setDealMenu(false); d.go(); }} style={{display: "block", width: "100%", textAlign: "left", padding: "8px 9px", border: "0", borderRadius: "7px", background: "none", cursor: "pointer", fontSize: "12.5px", color: "var(--ink-2, #27272a)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>
                  {d.label}
                </button>
              ))}
            </div>
            </>
          ) : null}
        </div>}
      </>} />
      )
        );
      })()}
      <div className="rec-frame-buyer" style={{flex: "1", minHeight: "0", display: V.isMobile ? "block" : "grid", overflow: V.isMobile ? "auto" : "visible", gridTemplateColumns: V.isMobile ? "1fr" : `${colW(rails.left, rails.leftW)} 6px minmax(0,1fr) 6px ${colW(rails.right, rails.rightW)}`, gridTemplateRows: "minmax(0,1fr)", background: "var(--page)"}}>
        <aside ref={leftRail} className={rails.left || V.isMobile ? undefined : 'rec-rail-collapsed'} style={{borderRight: "1px solid var(--divider, #e4e4e7)", background: "var(--page)", overflow: "auto", padding: rails.left || V.isMobile ? "12px" : "8px 4px", ...(V.isMobile ? {} : {gridColumn: "1", gridRow: "1"})}}>
          {rails.left || V.isMobile ? (
          <div className="rec-card">
          <div style={{display: "flex", gap: "12px", alignItems: "center"}}>
            <span style={{width: "44px", height: "44px", borderRadius: "10px", background: "var(--orange-soft, #fff1ea)", color: "var(--tx-orange, #c2410c)", display: "grid", placeItems: "center", fontSize: "14px", fontWeight: "700"}}>
              {V.B.initials}
            </span>
            <div>
              <BuyerHeadFields V={V} />
            </div>
          </div>
          <div style={{display: "flex", alignItems: "center", gap: "10px", marginTop: "12px", flexWrap: "wrap"}}>
            {compr ? null : <TypeChip kind="Buyer" />}
            {compr ? null : <span style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "22px", padding: "0 9px", borderRadius: "999px", fontSize: "11px", fontWeight: "600", color: buyerStatusTone(V.B.status).fg, background: buyerStatusTone(V.B.status).bg, border: `1px solid ${buyerStatusTone(V.B.status).line}`}}>
              <Mark label={V.B.status} size={12} />
              {V.B.status}
            </span>}
            {resp.tk && !compr ? <TireChip /> : null}
            <BuyerStage V={V} />
            {compr ? null : <span style={{display: "inline-flex", gap: "2px"}}>
              {(V.stars || []).map((st, st__i) => (
                <React.Fragment key={st__i}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill={st.color} stroke={st.color} strokeWidth="1.5" strokeLinejoin="round">
                  <path d="m12 3 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 21l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8L12 3z" />
                </svg>
                </React.Fragment>
              ))}
            </span>}
          </div>
          <div style={{marginTop: "14px", borderTop: "1px solid var(--divider-2, #f0f0f1)"}}>
            <BuyerProfileFields V={V} />
            <BuyerContact key={V.B.dbId ?? V.B.name} V={V} />
            <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "minmax(0,86px) minmax(0,1fr)" : "88px 1fr", gap: "10px", padding: "8px 0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontSize: "12.5px"}}>
              <span style={{color: "var(--meta, #71717a)"}}>
                Preferred
              </span>
              <span style={{fontWeight: "500"}}>
                {V.B.pref}
              </span>
            </div>
            <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "minmax(0,86px) minmax(0,1fr)" : "88px 1fr", gap: "10px", padding: "8px 0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontSize: "12.5px"}}>
              <span style={{color: "var(--meta, #71717a)"}}>
                Do not
              </span>
              <span style={{fontWeight: "500", color: "var(--tx-hot, #dc2626)"}}>
                {V.B.doNot}
              </span>
            </div>
            {V.B.dbId && !compr ? <DealTeam bare buyerId={V.B.dbId} onCall={V.callParty} onOpenSeller={(id) => V.openPerson('s' + id)} onOpenDeal={(sid, did) => V.openPersonDeal('s' + sid, 'd' + did)} onOpenBareDeal={(did) => V.openLandedDeal(did, null)} onOpenBuyer={(id) => V.openBuyerRecord('b' + id)} onOpenVendor={V.openVendorContact} /> : null}
          </div>
          {V.buyerListProfile === 'compr' ? (
            <ComprAccountCard buyerId={V.B.dbId ?? null} contact={V.isLiveData && V.liveIds?.canWrite ? {
              workspaceId: V.liveIds?.workspaceId ?? null, name: V.B.name, isMobile: !!V.isMobile, onSent: V.reloadCrm,
              email: V.B.email.includes('@') ? V.B.email : null, phone: V.B.phone && V.B.phone !== '—' ? V.B.phone : null,
            } : undefined} />
          ) : null}
          <div data-testid="buyer-action-plans" style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--divider-2, #f0f0f1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 600 }}>
                Action plans
              </span>
              <button type="button" className="dc12" onClick={V.goPlans} style={{ fontSize: '11px', color: 'var(--tx-mint, #0a8560)', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                Builder
              </button>
            </div>
            {plan ? (
              <div style={{ marginTop: '8px', padding: '10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', background: 'var(--canvas, #fafafa)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12.5px' }}>
                  <button type="button" className="dc12" onClick={plan.open} style={{ fontWeight: 600, background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', color: 'var(--ink, #18181b)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {plan.name}
                  </button>
                  <span style={{ color: 'var(--meta, #71717a)', flex: 'none' }}>Step {plan.step} / {plan.total}</span>
                </div>
                <div style={{ height: '4px', background: 'var(--divider, #e4e4e7)', borderRadius: '2px', overflow: 'hidden', marginTop: '8px' }}>
                  <div style={{ width: plan.pct, height: '100%', background: '#0A8560' }} />
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--muted, #52525b)', marginTop: '6px' }}>{plan.nextLabel} · {plan.statusNote}</div>
                <div style={{ display: 'flex', gap: '5px', marginTop: '8px' }}>
                  <button type="button" className="dc2" onClick={plan.open} style={{ height: '28px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', cursor: 'pointer' }}>Open plan</button>
                  <button type="button" className="dc2" onClick={plan.stop} style={{ height: '24px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', cursor: 'pointer', color: 'var(--muted, #52525b)' }}>Remove</button>
                </div>
              </div>
            ) : (
              <select aria-label="Add to action plan" defaultValue="" onChange={V.startBuyerPlanFor} style={{ marginTop: '8px', width: '100%', height: '30px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', padding: '0 8px', fontSize: '12.5px', background: 'var(--surface, #fff)' }}>
                <option value="">Add to action plan…</option>
                {(V.buyerPlanPickerOptions || V.planPickerOptions || []).map((o) => (
                  <option key={o.v} value={o.v}>{o.label}</option>
                ))}
              </select>
            )}
          </div>
          {compr ? null : <>
          <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "14px"}}>
            <span style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
              Buy box
            </span>
            <button type="button" onClick={V.editBuyerProfile} title="Strategy, property types, rehab, economics and how they want to hear from you" style={{fontSize: "11.5px", color: "var(--tx-mint, #0a8560)", background: "none", border: "0", cursor: "pointer", minHeight: "24px"}}>
              Edit buy box
            </button>
            <BuyerTrace V={V} />
          </div>
          {(V.buyBoxRows || []).map((r, r__i) => (
            <React.Fragment key={r__i}>
            <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "minmax(0,86px) minmax(0,1fr)" : "100px 1fr", gap: "10px", padding: "6px 0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontSize: "12.5px"}}>
              <span style={{color: "var(--meta, #71717a)"}}>
                {r.k}
              </span>
              <span style={{fontWeight: "500", minWidth: "0", overflowWrap: "anywhere"}}>
                {r.v}
              </span>
            </div>
            </React.Fragment>
          ))}
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "minmax(0,86px) minmax(0,1fr)" : "100px 1fr", gap: "10px", padding: "8px 0", fontSize: "12.5px"}}>
            <span style={{color: "var(--meta, #71717a)"}}>
              Avoid
            </span>
            <span style={{display: "flex", flexWrap: "wrap", gap: "4px"}}>
              {(V.buyerAvoid || []).map((a, a__i) => (
                <React.Fragment key={a__i}>
                <span style={{fontSize: "11px", padding: "2px 7px", borderRadius: "6px", background: "var(--negative-soft, #fee2e2)", color: "var(--tx-red-deep, #991b1b)"}}>
                  {a.a}
                </span>
                </React.Fragment>
              ))}
            </span>
          </div>
          </>}
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="dc2" data-testid="record-archive" title="Archive this record (Ctrl+A). Asks first; nothing is deleted." onClick={() => V.archiveOpenRecord('buyer')}
              style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--line, #d4d4d8)', background: 'var(--surface, #fff)', color: 'var(--ink-3, #3f3f46)', fontSize: 12.5, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Archive
            </button>
            <BlacklistButton count={1} names={[V.B.name]} onConfirm={V.blacklistBuyer} />
          </div>
          </div>
          ) : null}
        </aside>
        {V.isMobile ? null : (
          <RailSplit side="left" open={rails.left} rail={leftRail} onWidth={(px, keep) => setWidth('left', px, keep)} style={{ gridColumn: '2' }} />
        )}
        <div style={{display: "flex", flexDirection: "column", minWidth: "0", background: "var(--page)", overflow: "auto", padding: "12px 16px 16px", gap: "10px", ...(V.isMobile ? {} : {gridColumn: "3", gridRow: "1"})}}>
          <Composer V={V} inputRef={composerRef} kind="buyer" />
          <SmartSummary key={V.B.dbId ?? V.B.name} V={V} kind="buyer" />
          <div style={{flex: "none", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
            {(V.buyerActivity || []).map((a, a__i) => (
              <React.Fragment key={a__i}>
              <div style={{padding: "10px 12px", boxShadow: "1px 1px 0 var(--divider-2, #f0f0f1)"}}>
                <div style={{fontSize: "11px", color: "var(--meta, #71717a)", fontWeight: "600", whiteSpace: "nowrap"}}>
                  {a.k}
                </div>
                <div style={{fontSize: "18px", fontWeight: "650", letterSpacing: "-0.02em", marginTop: "4px", fontVariantNumeric: "tabular-nums"}}>
                  {a.v}
                </div>
              </div>
              </React.Fragment>
            ))}
          </div>
          <div className="rec-stream" style={{flex: "none", overflow: "hidden"}}>
            <div data-tabs style={{display: "flex", alignItems: "center", gap: "2px", padding: "0 8px", borderBottom: "1px solid var(--divider, #e4e4e7)", overflowX: "auto", scrollbarWidth: "none"}}>
              {(V.buyerTabs || []).map((t, t__i) => (
                <React.Fragment key={t__i}>
                <button type="button" onClick={t.go} aria-pressed={t.active} className="rec-chip" style={{height: "40px", padding: "0 10px", border: "0", borderBottom: `2px solid ${t.border}`, background: "none", fontSize: "12.5px", fontWeight: "600", marginBottom: "-1px", cursor: "pointer", color: t.color, whiteSpace: "nowrap", fontFamily: "var(--font-sans)"}}>
                  {t.label}
                </button>
                </React.Fragment>
              ))}
            </div>
            {V.buyerTab === 'Activity' ? (
              <>
                <ActivityChips V={V} chips={chips} userMenu={V.buyerTimelineUserMenu} order={order} onOrder={setOrder} />
                <div style={{ padding: '16px 16px 8px' }}>
                  <ActivityStream V={V} me={V.liveIds?.userId ?? null} items={streamItems} kind="buyer" order={order}
                    empty={chip === 'All' ? 'Nothing here yet. Calls, texts, emails and notes on this buyer show up as they happen.' : `No ${chip.toLowerCase()} on this buyer yet.`} />
                </div>
              </>
            ) : <BuyerDesk V={V} />}
          </div>
        </div>
        {V.isMobile ? null : (
          <RailSplit side="right" open={rails.right} rail={rightRail} onWidth={(px, keep) => setWidth('right', px, keep)} style={{ gridColumn: '4' }} />
        )}
        <aside ref={rightRail} className={rails.right || V.isMobile ? undefined : 'rec-rail-collapsed'} style={{borderLeft: "1px solid var(--divider, #e4e4e7)", background: "var(--page)", overflow: "auto", padding: rails.right || V.isMobile ? "12px 12px 96px" : "8px 4px", ...(V.isMobile ? {} : {gridColumn: "5", gridRow: "1"})}}>
          {rails.right || V.isMobile ? (
          <>
          <div className="rec-card">
            <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
              Response
            </div>
            <div style={{display: "flex", alignItems: "baseline", gap: "6px", marginTop: "4px", flexWrap: "wrap"}}>
              <span style={{fontSize: "var(--fs-figure)", fontWeight: "650", letterSpacing: "-0.02em", color: resp.pct == null ? "var(--meta, #71717a)" : resp.tone.text, fontVariantNumeric: "tabular-nums"}}>
                {resp.pct == null ? '—' : `${resp.pct}%`}
              </span>
              <span style={{fontSize: "12px", fontWeight: 600, color: resp.tone.text, background: resp.tone.tint, borderRadius: "6px", padding: "1px 7px"}}>
                {resp.tone.label}
              </span>
            </div>
            <div style={{fontSize: "12px", color: "var(--meta, #71717a)", marginTop: "2px", fontVariantNumeric: "tabular-nums"}}>
              {resp.sent ? `Answered ${resp.answered ?? 0} of ${resp.sent} texts, emails${compr ? ' and calls' : ', calls and deal sends'}` : compr ? 'Nothing sent to this contact yet' : 'Nothing sent to this buyer yet'}
            </div>
            <div style={{height: "5px", background: "var(--divider-2, #f0f0f1)", borderRadius: "3px", overflow: "hidden", marginTop: "8px"}}>
              <div style={{height: "100%", width: `${resp.pct ?? 0}%`, background: resp.tone.stroke}}></div>
            </div>
            <div style={{marginTop: "10px"}}>
              {(V.buyerSummary || []).map((s, s__i) => (
                <React.Fragment key={s__i}>
                <div style={{fontSize: "12.5px", color: "var(--ink-2, #27272a)", display: "flex", gap: "7px", marginTop: "4px"}}>
                  <span style={{color: "var(--tx-mint, #0a8560)", display: "inline-flex"}}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flex: "none", marginTop: "3px"}}><path d="M20 6 9 17l-5-5" /></svg>
                  </span>
                  {s.t}
                </div>
                </React.Fragment>
              ))}
            </div>
          </div>
          <CompanyChart V={V} buyerId={V.B.dbId ?? null} company={V.B.company && V.B.company !== '—' ? V.B.company : null} email={V.B.email && V.B.email !== '—' ? V.B.email : null} title={null} />
          {compr ? null : <div className="rec-card" style={{marginTop: "10px"}}>
            <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
              Open deals sent
            </div>
            {V.buyerDeals.map((d, d__i) => (
              <div key={d__i} style={{display: "flex", justifyContent: "space-between", gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontSize: "12.5px"}}>
                <span style={{fontWeight: "600"}}>{d.addr}</span>
                <span style={{color: textTone(d.color), fontWeight: "600"}}>{d.status}</span>
              </div>
            ))}
            {V.buyerDeals.length ? null : <div style={{padding: "8px 0", fontSize: "12.5px", color: "var(--meta, #71717a)"}}>No deals sent to this buyer yet.</div>}
          </div>}
          {/* The insight and the owner below are sample copy; a live buyer has neither yet. */}
          {(V.showAi && !V.isLiveData && !compr) ? (
            <>
            <div className="rec-card" style={{marginTop: "10px"}}>
              <SectionLabel>What CLOZR AI sees</SectionLabel>
              <div style={{fontSize: "13px", lineHeight: "1.5", marginTop: "6px", color: "var(--ink-2, #27272a)"}}>
                Responds fastest to SMS between 8–10 AM. Historically pays 2–3% over initial offer when a competing offer is disclosed.
              </div>
            </div>
            </>
          ) : null}
          {V.isLiveData ? null : (
          <div className="rec-card" style={{marginTop: "10px"}}>
            <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
              Relationship owner
            </div>
            <div style={{display: "flex", alignItems: "center", gap: "8px", marginTop: "8px"}}>
              <span style={{width: "26px", height: "26px", borderRadius: "7px", background: "var(--surface-2, #f4f4f5)", color: "var(--muted, #52525b)", display: "grid", placeItems: "center", fontSize: "10.5px", fontWeight: "700"}}>
                TM
              </span>
              <span style={{fontSize: "12.5px", fontWeight: "500"}}>
                Morgan Lane
              </span>
              <span style={{fontSize: "11px", color: "var(--meta, #71717a)"}}>
                dispo
              </span>
            </div>
          </div>
          )}
          </>
          ) : null}
        </aside>
        {V.isMobile ? null : (
          <>
            <RailToggle side="left" open={rails.left} onToggle={() => toggleRail('left')} />
            <RailToggle side="right" open={rails.right} onToggle={() => toggleRail('right')} />
          </>
        )}
      </div>
      {pickingContract && V.liveIds?.workspaceId ? (
        <ContractTemplatePicker
          workspaceId={V.liveIds.workspaceId}
          who={V.B.name || V.B.company}
          onPick={(id) => { setPickingContract(false); setContractsPop(id); }}
          onOther={() => { setPickingContract(false); setContractsPop(-1); }}
          onClose={() => setPickingContract(false)}
        />
      ) : null}
      {paying && compr ? (
        <PaymentLinkDialog workspaceId={V.liveIds?.workspaceId ?? null} isMobile={!!V.isMobile} onClose={() => setPaying(null)} onSent={V.reloadCrm}
          initialTrial={paying === 'trial' ? TRIAL_DEFAULT_DAYS : null}
          people={[{ id: V.B.dbId ?? 0, name: V.B.name, email: V.B.email.includes('@') ? V.B.email : null, phone: V.B.phone && V.B.phone !== '—' ? V.B.phone : null, tier: null }]} />
      ) : null}
      {contractsPop !== false && buyerId != null ? (
        <ContractPopup
          key={contractsPop ?? 'all'}
          V={V}
          target={{ sellerId: null, dealId: null, buyerId, title: `Contracts · ${V.B.name || V.B.company}`, buyer: { id: buyerId, name: V.B.name, company: V.B.company, email: V.B.email.includes('@') ? V.B.email : '', phone: V.B.phone && V.B.phone !== '—' ? V.B.phone : '' } }}
          startTemplateId={contractsPop}
          onClose={() => setContractsPop(false)}
        />
      ) : null}
    </section>
  );
}

function RailToggle({ side, open, onToggle }: { side: 'left' | 'right'; open: boolean; onToggle: () => void }) {
  const label = side === 'left' ? (open ? 'Collapse left column' : 'Expand left column') : (open ? 'Collapse right column' : 'Expand right column');
  return (
    <button type="button" className={`rec-rail-toggle rec-rail-toggle-${side} rec-press`} data-testid={`buyer-rail-toggle-${side}`} aria-label={label} title={label} onClick={onToggle}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        {side === 'left'
          ? (open ? <path d="M15 18 9 12l6-6" /> : <path d="m9 18 6-6-6-6" />)
          : (open ? <path d="m9 18 6-6-6-6" /> : <path d="M15 18 9 12l6-6" />)}
      </svg>
    </button>
  );
}

/** Where the buyer is with us: change it right here. */
function BuyerStage({ V }: { V: ClozrView }) {
  const bulk = V.buyerBulk;
  const [cur, setCur] = useState<{ for: string; stage: string } | null>(null);
  const key = String(V.B.dbId ?? V.B.name);
  const stages = buyerStagesFor(V.buyerListProfile);
  // A Compr contact on an old buyer stage (or none) reads as a new lead.
  const saved = V.buyerListProfile === 'compr' && !(COMPR_STAGES as readonly string[]).includes(V.B.stage) ? 'Not contacted' : V.B.stage || 'Active';
  const stage = cur && cur.for === key ? cur.stage : saved;
  const change = async (to: string) => {
    if (!to || to === stage) return;
    setCur({ for: key, stage: to });
    if (!bulk.canWrite || V.B.dbId == null) { bulk.toast(`Moved to ${to} (demo)`); return; }
    const r = await setBuyerStage([String(V.B.dbId)], to);
    if (!r.ok) { setCur(null); bulk.toast(r.message || 'Could not change the stage.'); return; }
    bulk.toast(`Moved to ${to}`);
    bulk.reload?.();
  };
  return (
    <select value={stage} disabled={!bulk.canWrite && !!bulk.workspaceId} onChange={(e) => void change(e.target.value)} aria-label="Buyer stage" title="Stage"
      style={{ height: '22px', borderRadius: '999px', border: '1px solid var(--divider, #e4e4e7)', padding: '0 6px', fontSize: '11px', fontWeight: 600, background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', fontFamily: 'inherit' }}>
      {[...new Set([...stages, stage])].map((st) => <option key={st} value={st}>{st}</option>)}
    </select>
  );
}

/** Skip trace this one buyer: at their mailing address or a property they bought from you. */
function BuyerTrace({ V }: { V: ClozrView }) {
  const [open, setOpen] = useState(false);
  const bulk = V.buyerBulk;
  if (V.B.dbId == null && bulk.workspaceId) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} title="Find phones and emails for this buyer" style={{fontSize: "11.5px", color: "var(--tx-mint, #0a8560)", background: "none", border: "0", cursor: "pointer"}}>
        Skip trace
      </button>
      {open ? (
        <CenteredDialog title={`Skip trace · ${V.B.name}`} onClose={() => setOpen(false)} width={620} z={90}>
          <BulkSkipTrace kind="buyer" records={[{ kind: 'buyer', dbId: V.B.dbId ?? 0, name: V.B.name, company: V.B.company }]}
            workspaceId={bulk.workspaceId} canWrite={bulk.canWrite} userId={V.liveIds?.userId ?? null}
            toast={bulk.toast} onDone={() => bulk.reload?.()} onClose={() => setOpen(false)} />
        </CenteredDialog>
      ) : null}
    </>
  );
}
