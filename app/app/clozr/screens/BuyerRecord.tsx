// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import { SmsFromPicker } from '@/components/SmsFromPicker';
import { BackLink } from '@/components/ds/BackLink';
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
import { LeadMemoryCard } from '@/app/components/record/LeadMemoryCard';
import { demoLeadMemory } from '@/lib/lead-memory-client';
import { setBuyerStage } from '@/lib/crm-write';
import { BuyerHeadFields, BuyerProfileFields } from '@/app/components/buyer/BuyerProfileFields';
import { BUYER_STAGES } from '@/lib/stages';
import { BulkSkipTrace } from '@/components/BulkSkipTrace';
import { CenteredDialog, ContractPopup } from '@/components/ContractsHub';
import { AiAgentToggle } from '@/app/components/ai-agent/AiAgentToggle';
import { isProtectedBuyer } from '@/lib/ai-agent-client';
import { DEAL_SHEET_BTN } from '@/app/components/record/deal-sheet-style';
import { BuyerContact } from '@/app/components/buyer/BuyerContact';
import { useRailPrefs } from '@/app/components/record/useRailPrefs';
import { MoreMenu } from '@/app/components/record/MoreMenu';
import { ContractTemplatePicker } from '@/components/ContractTemplatePicker';
import '@/app/components/record/record.css';

export function BuyerRecord({ V }: { V: ClozrView }) {
  const [dealMenu, setDealMenu] = useState(false);
  const [pickingContract, setPickingContract] = useState(false);
  // false: closed; null: open, nothing picked; a number: open on that template (-1 for "other").
  const [contractsPop, setContractsPop] = useState<number | null | false>(false);
  const buyerId = V.liveIds ? V.B.dbId ?? null : null;
  // This buyer's response rate from buyer-score, refreshed when it is a day old
  // (a cached answer unless they have new history).
  const scoreIds = useMemo(() => (buyerId != null ? [buyerId] : []), [buyerId]);
  const aiScores = useBuyerScores(V.liveIds?.workspaceId ?? null, scoreIds, V.showToast);
  const resp = (() => {
    const ai = buyerId != null ? aiScores.scores.get(buyerId) : undefined;
    const fresh = ai && ai.responseRate != null && ai.touches > 0;
    const pct = fresh ? ai!.responseRate! : V.B.responseKnown === false ? null : V.B.engagement;
    const tk = fresh ? isTireKicker({ sent: ai!.touches, responsePct: ai!.responseRate!, offers: ai!.offers, purchases: ai!.closed }) : !!V.B.tireKicker;
    const sent = fresh ? ai!.touches : V.B.sent ?? null;
    const answered = fresh ? ai!.answered : sent != null && pct != null ? Math.round((sent * pct) / 100) : null;
    return { pct, tk, tone: responseTone(pct, tk), sent, answered };
  })();
  const textRef = useRef<HTMLInputElement>(null);
  const live = useRef(V);
  const { prefs: rails, toggle: toggleRail, stretch } = useRailPrefs('clozr.buyer.rails');
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
  // The docked quick text / quick email every Text and Email button opens, filed on this buyer.
  const reachBuyer = (ch: 'text' | 'email') => openReach(ch, {
    name: V.B.name, phone: V.B.phone, email: V.B.email.includes('@') ? V.B.email : '',
    buyerId: V.B.dbId, audience: 'buyer',
  });
  return (
    <section data-screen-label="Buyer record" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
      <div style={{minHeight: "48px", flex: "none", display: "flex", alignItems: "center", flexWrap: V.isMobile ? "wrap" : "nowrap", rowGap: "8px", gap: "10px", padding: V.isMobile ? "8px 14px" : "0 16px", background: "#fff", borderBottom: "1px solid #e4e4e7", minWidth: "0"}}>
        {(() => {
          const back = V.backFor('buyers');
          return <BackLink to={back.to.screen === 'buyers' && V.buyerList !== 'buyers' ? { ...back, label: V.buyerListLabel } : back} />;
        })()}
        <span style={{color: "#d4d4d8"}}>
          /
        </span>
        <span style={{fontSize: "12.5px", fontWeight: "600", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
          {V.B.company}
        </span>
        <div style={{flex: "1"}}></div>
        {/* The AI agent switch (migration 123). VIPs and funds show it as off limits. */}
        <AiAgentToggle workspaceId={V.liveIds?.workspaceId} kind="buyer" recordId={V.liveIds ? V.B.dbId : null}
          recordName={V.B.name || V.B.company} canWrite={!!V.liveIds?.canWrite} mobile={V.isMobile}
          offLimits={isProtectedBuyer({ vip: V.B.status === 'VIP', type: V.B.type }) ? 'VIP buyers and funds stay with the team' : null} />
        {V.can.dealSheet ? (
          <button type="button" data-testid="buyer-deal-sheet" className="dc6" onClick={V.openBuyerDealSheet} title="Open the deal sheet" style={DEAL_SHEET_BTN}>
            Deal sheet
          </button>
        ) : null}
        {V.can.tc ? (
          <button type="button" data-testid="buyer-tc" className="dc2" onClick={V.openBuyerTc} title="Open transaction coordination" style={{height: "32px", padding: "0 11px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "700", color: "#1f7a4d", cursor: "pointer", flex: "none", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px"}}>
            <Mark label="TC" />
            TC
          </button>
        ) : null}
        <button className="clozr-talkr-ghost" onClick={V.callBuyer} style={{color: "var(--c-talkr)", height: "32px", padding: "0 11px", borderRadius: "8px", border: "1px solid #fecdd3", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", flex: "none", whiteSpace: "nowrap"}}>
          Call
        </button>
        <button className="clozr-talkr-ghost" onClick={() => reachBuyer('text')} style={{color: "var(--c-talkr)", height: "32px", padding: "0 11px", borderRadius: "8px", border: "1px solid #fecdd3", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", flex: "none", whiteSpace: "nowrap"}}>
          Text
        </button>
        <button onClick={() => reachBuyer('email')} className="dc6" style={{height: "32px", padding: "0 11px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", flex: "none", whiteSpace: "nowrap"}}>
          Email
        </button>
        {buyerId != null && V.liveIds?.workspaceId ? (
          <MoreMenu items={[
            ...(V.liveIds.canWrite ? [{ key: 'newContract', label: 'New contract', group: 'Contracts', note: 'pick a template', run: () => setPickingContract(true) }] : []),
            { key: 'contracts', label: 'Contracts', group: 'Contracts', note: 'sent and signed', run: () => setContractsPop(null) },
          ]} />
        ) : null}
        <div style={{position: "relative", flex: "none"}}>
          <button className="clozr-genius-btn" onClick={() => ((V.sendDealOptions || []).length ? setDealMenu(!dealMenu) : V.showToast('No active inventory to send. Put a deal under contract first.'))} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-genius)", background: "var(--c-genius)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", flex: "none", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center"}}>
            Send a deal
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{marginLeft: "4px"}}><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {dealMenu ? (
            <>
            <div onClick={() => setDealMenu(false)} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
            <div style={{position: "absolute", top: "38px", right: "0", minWidth: "260px", maxWidth: "min(360px, calc(100vw - 24px))", maxHeight: "min(340px, 46vh)", overflow: "auto", background: "var(--c-menu-bg)", border: "1px solid var(--c-menu-line)", borderRadius: "12px", boxShadow: "0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)", zIndex: "45", padding: "4px"}}>
              <div style={{padding: "7px 9px 4px", fontSize: "11.5px", fontWeight: "600", color: "#71717a"}}>Into the campaign for…</div>
              {(V.sendDealOptions || []).map((d) => (
                <button key={d.id} className="dc2" onClick={() => { setDealMenu(false); d.go(); }} style={{display: "block", width: "100%", textAlign: "left", padding: "8px 9px", border: "0", borderRadius: "7px", background: "none", cursor: "pointer", fontSize: "12.5px", color: "#27272a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>
                  {d.label}
                </button>
              ))}
            </div>
            </>
          ) : null}
        </div>
      </div>
      <div style={{flex: "1", minHeight: "0", display: V.isMobile ? "block" : "grid", overflow: V.isMobile ? "auto" : "visible", gridTemplateColumns: V.isMobile ? "1fr" : `${rails.left ? '300px' : '36px'} 6px minmax(0,1fr) 6px ${rails.right ? '296px' : '36px'}`, gridTemplateRows: "minmax(0,1fr)"}}>
        <aside className={rails.left || V.isMobile ? undefined : 'rec-rail-collapsed'} style={{borderRight: "1px solid #e4e4e7", background: "#fff", overflow: "auto", padding: rails.left || V.isMobile ? "16px" : "8px 4px", ...(V.isMobile ? {} : {gridColumn: "1", gridRow: "1"})}}>
          {rails.left || V.isMobile ? (
          <>
          <div style={{display: "flex", gap: "12px", alignItems: "center"}}>
            <span style={{width: "44px", height: "44px", borderRadius: "10px", background: "#fff1ea", color: "#ff7a45", display: "grid", placeItems: "center", fontSize: "14px", fontWeight: "700"}}>
              {V.B.initials}
            </span>
            <div>
              <BuyerHeadFields V={V} />
            </div>
          </div>
          <div style={{display: "flex", alignItems: "center", gap: "10px", marginTop: "12px", flexWrap: "wrap"}}>
            <TypeChip kind="Buyer" />
            <span style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "22px", padding: "0 9px", borderRadius: "999px", fontSize: "11px", fontWeight: "600", color: buyerStatusTone(V.B.status).fg, background: buyerStatusTone(V.B.status).bg, border: `1px solid ${buyerStatusTone(V.B.status).line}`}}>
              <Mark label={V.B.status} size={12} />
              {V.B.status}
            </span>
            {resp.tk ? <TireChip /> : null}
            <BuyerStage V={V} />
            <span style={{display: "inline-flex", gap: "2px"}}>
              {(V.stars || []).map((st, st__i) => (
                <React.Fragment key={st__i}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill={st.color} stroke={st.color} strokeWidth="1.5" strokeLinejoin="round">
                  <path d="m12 3 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 21l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8L12 3z" />
                </svg>
                </React.Fragment>
              ))}
            </span>
          </div>
          <div style={{marginTop: "14px", borderTop: "1px solid #f0f0f1"}}>
            <BuyerProfileFields V={V} />
            <BuyerContact key={V.B.dbId ?? V.B.name} V={V} />
            <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "minmax(0,86px) minmax(0,1fr)" : "88px 1fr", gap: "10px", padding: "8px 0", borderBottom: "1px solid #f0f0f1", fontSize: "12.5px"}}>
              <span style={{color: "#71717a"}}>
                Preferred
              </span>
              <span style={{fontWeight: "500"}}>
                {V.B.pref}
              </span>
            </div>
            <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "minmax(0,86px) minmax(0,1fr)" : "88px 1fr", gap: "10px", padding: "8px 0", borderBottom: "1px solid #f0f0f1", fontSize: "12.5px"}}>
              <span style={{color: "#71717a"}}>
                Do not
              </span>
              <span style={{fontWeight: "500", color: "#dc2626"}}>
                {V.B.doNot}
              </span>
            </div>
            {V.B.dbId ? <DealTeam bare buyerId={V.B.dbId} onCall={V.callParty} onOpenSeller={(id) => V.openPerson('s' + id)} onOpenDeal={(sid, did) => V.openPersonDeal('s' + sid, 'd' + did)} onOpenBareDeal={(did) => V.openLandedDeal(did, null)} onOpenBuyer={(id) => V.openBuyerRecord('b' + id)} onOpenVendor={V.openVendorContact} /> : null}
          </div>
          <div style={{ marginTop: '14px' }}>
            <LeadMemoryCard
              key={V.B.dbId ?? V.B.name}
              kind="buyer"
              title="What we know"
              workspaceId={V.liveIds?.workspaceId ?? null}
              recordId={V.B.dbId}
              demo={V.isLiveData ? null : demoLeadMemory('buyer', { id: V.B.name, name: V.B.name, company: V.B.company })}
            />
          </div>
          <div data-testid="buyer-action-plans" style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid #f0f0f1' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 600 }}>
                Action plans
              </span>
              <button type="button" className="dc12" onClick={V.goPlans} style={{ fontSize: '11px', color: '#0A8560', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                Builder
              </button>
            </div>
            {plan ? (
              <div style={{ marginTop: '8px', padding: '10px', border: '1px solid #e4e4e7', borderRadius: '9px', background: '#fafafa' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12.5px' }}>
                  <button type="button" className="dc12" onClick={plan.open} style={{ fontWeight: 600, background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', color: '#18181b', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {plan.name}
                  </button>
                  <span style={{ color: '#71717a', flex: 'none' }}>Step {plan.step} / {plan.total}</span>
                </div>
                <div style={{ height: '4px', background: '#e4e4e7', borderRadius: '2px', overflow: 'hidden', marginTop: '8px' }}>
                  <div style={{ width: plan.pct, height: '100%', background: '#0A8560' }} />
                </div>
                <div style={{ fontSize: '11.5px', color: '#52525b', marginTop: '6px' }}>{plan.nextLabel} · {plan.statusNote}</div>
                <div style={{ display: 'flex', gap: '5px', marginTop: '8px' }}>
                  <button type="button" className="dc2" onClick={plan.open} style={{ height: '24px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', cursor: 'pointer' }}>Open</button>
                  <button type="button" className="dc2" onClick={plan.stop} style={{ height: '24px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', cursor: 'pointer', color: '#52525b' }}>Remove</button>
                </div>
              </div>
            ) : (
              <select aria-label="Add to action plan" defaultValue="" onChange={V.startBuyerPlanFor} style={{ marginTop: '8px', width: '100%', height: '30px', borderRadius: '8px', border: '1px solid #e4e4e7', padding: '0 8px', fontSize: '12.5px', background: '#fff' }}>
                <option value="">Add to action plan…</option>
                {(V.buyerPlanPickerOptions || V.planPickerOptions || []).map((o) => (
                  <option key={o.v} value={o.v}>{o.label}</option>
                ))}
              </select>
            )}
          </div>
          <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "14px"}}>
            <span style={{fontSize: "11.5px", color: "#71717a", fontWeight: "600"}}>
              Buy box
            </span>
            <button type="button" onClick={V.editBuyerProfile} title="Strategy, property types, rehab, economics and how they want to hear from you" style={{fontSize: "11.5px", color: "#0A8560", background: "none", border: "0", cursor: "pointer", minHeight: "24px"}}>
              Edit buy box
            </button>
            <BuyerTrace V={V} />
          </div>
          {(V.buyBoxRows || []).map((r, r__i) => (
            <React.Fragment key={r__i}>
            <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "minmax(0,86px) minmax(0,1fr)" : "100px 1fr", gap: "10px", padding: "6px 0", borderBottom: "1px solid #f0f0f1", fontSize: "12.5px"}}>
              <span style={{color: "#71717a"}}>
                {r.k}
              </span>
              <span style={{fontWeight: "500", minWidth: "0", overflowWrap: "anywhere"}}>
                {r.v}
              </span>
            </div>
            </React.Fragment>
          ))}
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "minmax(0,86px) minmax(0,1fr)" : "100px 1fr", gap: "10px", padding: "8px 0", fontSize: "12.5px"}}>
            <span style={{color: "#71717a"}}>
              Avoid
            </span>
            <span style={{display: "flex", flexWrap: "wrap", gap: "4px"}}>
              {(V.buyerAvoid || []).map((a, a__i) => (
                <React.Fragment key={a__i}>
                <span style={{fontSize: "11px", padding: "2px 7px", borderRadius: "6px", background: "#fee2e2", color: "#991b1b"}}>
                  {a.a}
                </span>
                </React.Fragment>
              ))}
            </span>
          </div>
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="dc2" data-testid="record-archive" title="Archive this record (Ctrl+A). Asks first; nothing is deleted." onClick={() => V.archiveOpenRecord('buyer')}
              style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid #d4d4d8', background: '#fff', color: '#3f3f46', fontSize: 12.5, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Archive
            </button>
            <BlacklistButton count={1} names={[V.B.name]} onConfirm={V.blacklistBuyer} />
          </div>
          </>
          ) : null}
        </aside>
        {V.isMobile ? null : (
          <button type="button" className="rec-split" style={{gridColumn: "2"}} aria-label="Resize left column. Double-click to stretch." title="Double-click to stretch / expand"
            onDoubleClick={() => stretch('left')} />
        )}
        <div style={{display: "flex", flexDirection: "column", minWidth: "0", background: "#fafafa", overflow: "auto", padding: "16px 20px", ...(V.isMobile ? {} : {gridColumn: "3", gridRow: "1"})}}>
          <div style={{flex: "none", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
            {(V.buyerActivity || []).map((a, a__i) => (
              <React.Fragment key={a__i}>
              <div style={{padding: "10px 12px", boxShadow: "1px 1px 0 #f0f0f1"}}>
                <div style={{fontSize: "11px", color: "#71717a", fontWeight: "600", whiteSpace: "nowrap"}}>
                  {a.k}
                </div>
                <div style={{fontSize: "18px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "4px"}}>
                  {a.v}
                </div>
              </div>
              </React.Fragment>
            ))}
          </div>
          <div style={{flex: "none", marginTop: "14px", background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
            <div data-tabs style={{display: "flex", alignItems: "center", gap: "2px", padding: "0 16px", borderBottom: "1px solid #e4e4e7"}}>
              {(V.buyerTabs || []).map((t, t__i) => (
                <React.Fragment key={t__i}>
                <button onClick={t.go} style={{height: "40px", padding: "0 10px", border: "0", borderBottom: `2px solid ${t.border}`, background: "none", fontSize: "13px", fontWeight: "500", marginBottom: "-1px", cursor: "pointer", color: t.color}}>
                  {t.label}
                </button>
                </React.Fragment>
              ))}
            </div>
            <BuyerDesk V={V} />
          </div>
          <div style={{flex: "none", marginTop: "14px", background: "#fff", borderTop: "1px solid #e4e4e7", border: "1px solid #e4e4e7", borderRadius: "12px", padding: "12px 16px"}}>
            <div style={{display: "flex", gap: "8px"}}>
              <input ref={textRef} data-testid="buyer-text" className="dc21" value={V.composerText} onChange={V.setBuyerMsg} placeholder={`Text ${V.B.name} · preferred channel is ${V.B.pref}`} style={{flex: "1", height: "36px", padding: "0 12px", border: "1px solid #e4e4e7", borderRadius: "9px", fontSize: "13px", outline: "0", background: "#fafafa"}} />
              <button className="dc3" onClick={V.sendBuyerMsg} style={{height: "36px", padding: "0 14px", borderRadius: "9px", border: "1px solid #0A8560", background: "#0A8560", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer"}}>
                Send
              </button>
            </div>
            <div style={{display: "flex", justifyContent: "flex-end", marginTop: "6px"}}>
              <SmsFromPicker compact />
            </div>
          </div>
        </div>
        {V.isMobile ? null : (
          <button type="button" className="rec-split" style={{gridColumn: "4"}} aria-label="Resize right column. Double-click to stretch." title="Double-click to stretch / expand"
            onDoubleClick={() => stretch('right')} />
        )}
        <aside className={rails.right || V.isMobile ? undefined : 'rec-rail-collapsed'} style={{borderLeft: "1px solid #e4e4e7", background: "#fff", overflow: "auto", padding: rails.right || V.isMobile ? "14px 14px 96px" : "8px 4px", ...(V.isMobile ? {} : {gridColumn: "5", gridRow: "1"})}}>
          {rails.right || V.isMobile ? (
          <>
          <div style={{border: "1px solid #e4e4e7", borderRadius: "10px", padding: "12px"}}>
            <div style={{fontSize: "11.5px", color: "#71717a", fontWeight: "600"}}>
              Response
            </div>
            <div style={{display: "flex", alignItems: "baseline", gap: "6px", marginTop: "4px", flexWrap: "wrap"}}>
              <span style={{fontSize: "30px", fontWeight: "700", letterSpacing: "-0.04em", color: resp.pct == null ? "#71717a" : resp.tone.text, fontVariantNumeric: "tabular-nums"}}>
                {resp.pct == null ? '—' : `${resp.pct}%`}
              </span>
              <span style={{fontSize: "12px", fontWeight: 600, color: resp.tone.text, background: resp.tone.tint, borderRadius: "6px", padding: "1px 7px"}}>
                {resp.tone.label}
              </span>
            </div>
            <div style={{fontSize: "12px", color: "#71717a", marginTop: "2px", fontVariantNumeric: "tabular-nums"}}>
              {resp.sent ? `Answered ${resp.answered ?? 0} of ${resp.sent} texts, emails, calls and deal sends` : 'Nothing sent to this buyer yet'}
            </div>
            <div style={{height: "5px", background: "#f0f0f1", borderRadius: "3px", overflow: "hidden", marginTop: "8px"}}>
              <div style={{height: "100%", width: `${resp.pct ?? 0}%`, background: resp.tone.stroke}}></div>
            </div>
            <div style={{marginTop: "10px"}}>
              {(V.buyerSummary || []).map((s, s__i) => (
                <React.Fragment key={s__i}>
                <div style={{fontSize: "12.5px", color: "#27272a", display: "flex", gap: "7px", marginTop: "4px"}}>
                  <span style={{color: "#0A8560", display: "inline-flex"}}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flex: "none", marginTop: "3px"}}><path d="M20 6 9 17l-5-5" /></svg>
                  </span>
                  {s.t}
                </div>
                </React.Fragment>
              ))}
            </div>
          </div>
          <div style={{marginTop: "12px", border: "1px solid #e4e4e7", borderRadius: "10px", padding: "12px"}}>
            <div style={{fontSize: "11.5px", color: "#71717a", fontWeight: "600"}}>
              Open deals sent
            </div>
            {V.buyerDeals.map((d, d__i) => (
              <div key={d__i} style={{display: "flex", justifyContent: "space-between", gap: "8px", padding: "8px 0", borderBottom: "1px solid #f0f0f1", fontSize: "12.5px"}}>
                <span style={{fontWeight: "600"}}>{d.addr}</span>
                <span style={{color: d.color, fontWeight: "600"}}>{d.status}</span>
              </div>
            ))}
            {V.buyerDeals.length ? null : <div style={{padding: "8px 0", fontSize: "12.5px", color: "#71717a"}}>No deals sent to this buyer yet.</div>}
          </div>
          {/* The insight and the owner below are sample copy; a live buyer has neither yet. */}
          {(V.showAi && !V.isLiveData) ? (
            <>
            <div style={{marginTop: "12px", borderRadius: "10px", padding: "12px", background: "#141419", color: "#fff", position: "relative", overflow: "hidden"}}>
              <div style={{position: "absolute", inset: "0", pointerEvents: "none", background: "radial-gradient(120% 90% at 90% -10%, rgba(10, 133, 96,0.34), transparent 58%)"}}></div>
              <div style={{position: "relative"}}>
                <div style={{fontSize: "11.5px", color: "rgba(255,255,255,.6)", fontWeight: "600"}}>
                  CLOZR AI · buyer
                </div>
                <div style={{fontSize: "13px", lineHeight: "1.5", marginTop: "8px", color: "rgba(255,255,255,.92)"}}>
                  Responds fastest to SMS between 8–10 AM. Historically pays 2–3% over initial offer when a competing offer is disclosed.
                </div>
              </div>
            </div>
            </>
          ) : null}
          {V.isLiveData ? null : (
          <div style={{marginTop: "12px"}}>
            <div style={{fontSize: "11.5px", color: "#71717a", fontWeight: "600"}}>
              Relationship owner
            </div>
            <div style={{display: "flex", alignItems: "center", gap: "8px", marginTop: "8px"}}>
              <span style={{width: "26px", height: "26px", borderRadius: "7px", background: "#f4f4f5", color: "#52525b", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "700"}}>
                TM
              </span>
              <span style={{fontSize: "12.5px", fontWeight: "500"}}>
                Morgan Lane
              </span>
              <span style={{fontSize: "11px", color: "#71717a"}}>
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
  const stage = cur && cur.for === key ? cur.stage : V.B.stage || 'Active';
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
      style={{ height: '22px', borderRadius: '999px', border: '1px solid #e4e4e7', padding: '0 6px', fontSize: '11px', fontWeight: 600, background: '#fff', color: '#18181b', fontFamily: 'inherit' }}>
      {[...new Set([...BUYER_STAGES, stage])].map((st) => <option key={st} value={st}>{st}</option>)}
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
      <button onClick={() => setOpen(true)} title="Find phones and emails for this buyer" style={{fontSize: "11.5px", color: "#0A8560", background: "none", border: "0", cursor: "pointer"}}>
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
