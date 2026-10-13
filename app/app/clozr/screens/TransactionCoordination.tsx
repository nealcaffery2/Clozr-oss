// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React, { useEffect, useState } from 'react';
import { BackLink } from '@/components/ds/BackLink';
import type { ClozrView } from '@/app/clozr/view';
import { AiButton } from '@/components/AiButton';
import { DealTeam } from '@/components/DealTeam';
import { DealFiles } from '@/components/DealFiles';
import { LaneHeard } from '@/components/LaneHeard';
import { Mark } from '@/components/ds/mark';
import { ScheduleC } from '@/components/ScheduleC';
import { isTypingTarget } from '@/lib/people-keys';

const arrowBtn = (on: boolean): React.CSSProperties => ({
  width: '32px', height: '32px', borderRadius: '8px', border: '1px solid var(--c-btn-line)',
  background: on ? 'var(--c-btn-bg)' : '#fafafa', color: on ? '#18181b' : '#d4d4d8',
  cursor: on ? 'pointer' : 'default', display: 'grid', placeItems: 'center', padding: 0, flex: 'none',
});

export function TransactionCoordination({ V }: { V: ClozrView }) {
  const [orderReq, setOrderReq] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
      if (!horizontal && !vertical) return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (isTypingTarget(e.target as HTMLElement)) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"]')) return;
      e.preventDefault();
      if (horizontal) V.stepTc('deal', e.key === 'ArrowRight' ? 1 : -1);
      else V.stepTc('stage', e.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [V]);

  const nav = V.tcNav;
  const place = nav ? `${nav.index + 1} of ${nav.count} · ${nav.stage}` : V.TP.addr;
  return (
    <section data-screen-label="Transaction coordination" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
      <div style={{background: "#fff", borderBottom: "1px solid #e4e4e7", padding: "12px 20px 14px"}}>
        <div style={{display: "flex", alignItems: "center", gap: "8px", fontSize: "12.5px", color: "#71717a"}}>
          <span data-testid="tc-back"><BackLink to={V.tcBackLink} /></span>
          <span style={{color: "#d4d4d8"}}>
            /
          </span>
          <span>
            Transaction coordination
          </span>
          <span style={{color: "#d4d4d8"}}>
            /
          </span>
          <span style={{color: "#18181b", fontWeight: "600"}}>
            {V.TP.addr}
          </span>
          <div style={{flex: "1"}}></div>
          <div role="group" aria-label="Move between deals" style={{display: "inline-flex", alignItems: "center", gap: "4px"}}>
            <button type="button" data-testid="tc-prev-stage" aria-label="Previous stage" disabled={!nav?.canPrevStage} onClick={() => V.stepTc('stage', -1)} style={arrowBtn(!!nav?.canPrevStage)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
            </button>
            <button type="button" data-testid="tc-prev-deal" aria-label="Previous deal in this stage" disabled={!nav?.canPrevDeal} onClick={() => V.stepTc('deal', -1)} style={arrowBtn(!!nav?.canPrevDeal)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <span data-testid="tc-place" style={{fontSize: "12px", color: "#52525b", fontVariantNumeric: "tabular-nums", padding: "0 6px", whiteSpace: "nowrap"}}>{place}</span>
            <button type="button" data-testid="tc-next-deal" aria-label="Next deal in this stage" disabled={!nav?.canNextDeal} onClick={() => V.stepTc('deal', 1)} style={arrowBtn(!!nav?.canNextDeal)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
            </button>
            <button type="button" data-testid="tc-next-stage" aria-label="Next stage" disabled={!nav?.canNextStage} onClick={() => V.stepTc('stage', 1)} style={arrowBtn(!!nav?.canNextStage)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
          </div>
          {V.tcFile?.dealId && V.tcFile.canWrite ? (
          <button type="button" data-testid="header-order-photos" onClick={() => setOrderReq((n) => n + 1)}
            title="Order iVueit photos of this house. A local Vuer shoots it and the photos land under Files & photos."
            style={{ height: '28px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12px', fontWeight: 600, color: '#18181b', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Order photos
          </button>
        ) : null}
          <AiButton kind="lane" onClick={V.laneTc} />
        </div>
        <div style={{display: "flex", alignItems: "center", gap: "18px", marginTop: "8px", flexWrap: "wrap"}}>
          <div style={{position: "relative", width: "64px", height: "64px", borderRadius: "50%", background: V.tcRing, display: "grid", placeItems: "center", flex: "none"}}>
            <div style={{width: "52px", height: "52px", borderRadius: "50%", background: "#fff", display: "grid", placeItems: "center", fontSize: "13px", fontWeight: "700"}}>
              {V.tcPct}
            </div>
          </div>
          <div style={{minWidth: "0"}}>
            <h1 style={{margin: "0", fontSize: "22px", fontWeight: "700", letterSpacing: "-0.03em"}}>
              {V.TP.addr}
            </h1>
            <div style={{fontSize: "12.5px", color: "#71717a", marginTop: "2px"}}>
              {V.TP.cityLine} · seller 
              <button onClick={V.TP.open} style={{background: "none", border: "0", padding: "0", color: "#0A8560", cursor: "pointer", fontSize: "12.5px"}}>
                {V.TP.seller}
              </button>
               · buyer {V.TP.buyer} · title {V.TP.title}
            </div>
            <div style={{fontSize: "12.5px", color: "#52525b", marginTop: "4px"}}>
              {V.tcDoneCount} of {V.tcTotal} items complete
            </div>
          </div>
          <div style={{flex: "1"}}></div>
          <div style={{display: "flex", gap: V.isMobile ? "16px" : "24px", flexWrap: "wrap", minWidth: V.isMobile ? "100%" : "0"}}>
            <div>
              <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
                Closing
              </div>
              <div style={{fontSize: "18px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "3px"}}>
                {V.TP.close}
              </div>
            </div>
            <div>
              <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
                Countdown
              </div>
              <div style={{fontSize: "18px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "3px", color: "#d97706"}}>
                {V.TP.daysLeft}
              </div>
            </div>
            <div>
              <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
                A → B
              </div>
              <div style={{fontSize: "18px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "3px"}}>
                {V.TP.contract}
              </div>
            </div>
            <div>
              <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
                B → C
              </div>
              <div style={{fontSize: "18px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "3px"}}>
                {V.TP.buyerPrice}
              </div>
            </div>
            <div>
              <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
                Assignment fee
              </div>
              <div style={{fontSize: "18px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "3px", color: "#16a34a"}}>
                {V.TP.assignment}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div style={{flex: "1", minHeight: "0", overflow: "auto", padding: "16px 20px 40px"}}>
        {/* The file A to Z, the order a transaction runs in: what stands in the way,
            today's moves, the contract-to-close checklist, who is on it and what
            they owe, then the documents and everything said on the deal. */}
        <TcStep n={1} title="Where it stands" note="Anything blocking the close comes first.">
        <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "repeat(3,minmax(0,1fr))", gap: "10px"}}>
          {(V.tcBlockers || []).map((b, b__i) => (
            <React.Fragment key={b__i}>
            <div style={{display: "grid", gridTemplateColumns: "auto 1fr", gap: "12px", alignItems: "start", padding: "12px 14px", borderRadius: "10px", background: b.bg}}>
              <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "10.5px", fontWeight: "700", letterSpacing: ".1em", textTransform: "uppercase", color: b.color, marginTop: "2px"}}>
                <Mark label={b.level} />
                {b.level}
              </span>
              <span>
                <span style={{display: "block", fontWeight: "600", fontSize: "13px", color: "#18181b"}}>
                  {b.text}
                </span>
                <span style={{display: "block", fontSize: "11.5px", color: "#52525b", marginTop: "2px"}}>
                  {b.who}
                </span>
              </span>
            </div>
            </React.Fragment>
          ))}
        </div>
          {(V.tcBlockers || []).length ? null : <div style={{fontSize: "12.5px", color: "#71717a"}}>Nothing is blocking this file.</div>}
        </TcStep>
        {V.tcFile?.txId || V.tcDrive ? (
        <TcStep n={2} title="Today" note="What Lane heard and needs a yes on, what is due and what slipped.">
        {V.tcFile?.txId ? (
          <LaneHeard transactionId={V.tcFile.txId} workspaceId={V.tcFile.workspaceId} me={V.tcFile.me} canWrite={V.tcFile.canWrite}
            onChanged={V.reloadCrm} onToast={V.showToast} />
        ) : null}
        {(V.tcDrive) ? (
          <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", padding: "14px 16px", marginBottom: "14px"}}>
            <div style={{display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap"}}>
              <span style={{width: "7px", height: "7px", borderRadius: "999px", background: "var(--c-lane)", animation: "clozrPulseLane 2.4s infinite"}}></span>
              <span style={{fontWeight: "700", fontSize: "14px", color: "var(--c-lane)"}}>Lane · today</span>
              <span style={{fontSize: "11px", fontWeight: "700", letterSpacing: ".1em", textTransform: "uppercase", padding: "3px 8px", borderRadius: "6px", color: V.tcDrive.color, background: V.tcDrive.bg}}>
                {V.tcDrive.statusLabel}
              </span>
              <span style={{fontSize: "12.5px", color: "#52525b"}}>
                {V.tcDrive.track} · <b style={{color: "#18181b"}}>{V.tcDrive.dayMarker}</b>
                {V.tcDrive.daysToClose !== null ? ` · closes in ${V.tcDrive.daysToClose} day${V.tcDrive.daysToClose === 1 ? '' : 's'}` : ' · no close date on the file'}
                {' · next: '}{V.tcDrive.nextLabel}
              </span>
              <div style={{flex: "1"}}></div>
              <button className="dc2" onClick={V.tcDrive.askSweep} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", cursor: "pointer", color: "#18181b"}}>
                Morning sweep
              </button>
              <button className="dc2" onClick={V.tcDrive.askPost} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", cursor: "pointer", color: "#18181b"}}>
                Status post
              </button>
            </div>
            {(V.tcDrive.hasTriggers) ? (
              <div style={{display: "grid", gap: "6px", marginTop: "12px"}}>
                {(V.tcDrive.triggers || []).map((t, t__i) => (
                  <div key={t__i} style={{display: "grid", gridTemplateColumns: "auto 1fr", gap: "10px", alignItems: "start", padding: "9px 12px", borderRadius: "9px", background: t.bg}}>
                    <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "10.5px", fontWeight: "700", letterSpacing: ".1em", textTransform: "uppercase", color: t.color, marginTop: "2px"}}>
                      <Mark label={t.level} />
                      {t.level}
                    </span>
                    <span>
                      <span style={{display: "block", fontWeight: "600", fontSize: "13px", color: "#18181b"}}>{t.signal}</span>
                      <span style={{display: "block", fontSize: "12px", color: "#52525b", marginTop: "2px"}}>{t.action}{t.escalate ? ` Escalate: ${t.escalate}.` : ''}</span>
                      <span style={{display: "block", fontSize: "10.5px", color: "#a1a1aa", marginTop: "3px"}}>{t.ref}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "repeat(3, minmax(0,1fr))", gap: "14px", marginTop: "12px"}}>
              <div>
                <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>Past its day</div>
                {(V.tcDrive.hasOverdue) ? (V.tcDrive.overdue || []).map((t, t__i) => (
                  <div key={t__i} style={{fontSize: "12.5px", marginTop: "6px", display: "flex", gap: "8px"}}>
                    <span style={{color: t.critical ? "#ff7a45" : "#71717a", fontWeight: "600", flex: "none", width: "44px"}}>{t.day}</span>
                    <span style={{color: "#18181b"}}>{t.task} <span style={{color: "#a1a1aa"}}>· {t.owner}</span></span>
                  </div>
                )) : <div style={{fontSize: "12.5px", color: "#a1a1aa", marginTop: "6px"}}>Nothing slipped.</div>}
              </div>
              <div>
                <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>Due today</div>
                {(V.tcDrive.hasDueToday) ? (V.tcDrive.dueToday || []).map((t, t__i) => (
                  <div key={t__i} style={{fontSize: "12.5px", marginTop: "6px", display: "flex", gap: "8px"}}>
                    <span style={{color: t.critical ? "#ff7a45" : "#71717a", fontWeight: "600", flex: "none", width: "44px"}}>{t.day}</span>
                    <span style={{color: "#18181b"}}>{t.task} <span style={{color: "#a1a1aa"}}>· {t.owner}</span></span>
                  </div>
                )) : <div style={{fontSize: "12.5px", color: "#a1a1aa", marginTop: "6px"}}>Cadence only.</div>}
              </div>
              <div>
                <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>Clocks running</div>
                {(V.tcDrive.hasSlas) ? (V.tcDrive.slas || []).map((s, s__i) => (
                  <div key={s__i} style={{fontSize: "12.5px", marginTop: "6px"}}>
                    <span style={{fontWeight: "600", color: "#18181b"}}>{s.item}</span>
                    <span style={{display: "block", fontSize: "11.5px", color: "#71717a"}}>{s.clock}</span>
                  </div>
                )) : <div style={{fontSize: "12.5px", color: "#a1a1aa", marginTop: "6px"}}>No vendor clock open.</div>}
              </div>
            </div>
          </div>
        ) : null}
        </TcStep>
        ) : null}
        <TcStep n={3} title="Contract to close" note="The checklist, top to bottom. Click an item to tick it off.">
          <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #f0f0f1"}}>
              <span style={{fontWeight: "600", fontSize: "14px"}}>
                Closing checklist
              </span>
              <span style={{fontSize: "12px", color: "#71717a"}}>
                click to toggle · owner · due
              </span>
            </div>
            <div style={{display: "grid", gridTemplateColumns: "1fr"}}>
              {(V.tcItems || []).map((it, it__i) => (
                <React.Fragment key={it__i}>
                <button className="dc4" onClick={it.toggle} style={{display: "grid", gridTemplateColumns: "18px 1fr auto", gap: "10px", alignItems: "center", textAlign: "left", padding: "10px 16px", border: "0", borderBottom: "1px solid #f0f0f1", borderRight: "1px solid #f0f0f1", background: "none", cursor: "pointer"}}>
                  <span style={{width: "18px", height: "18px", borderRadius: "5px", display: "grid", placeItems: "center", background: it.bg, border: `1.5px solid ${it.border}`}}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span>
                    <span style={{display: "block", fontSize: "13px", fontWeight: "500", color: it.textColor, textDecoration: it.deco}}>
                      {it.k}
                    </span>
                    <span style={{display: "block", fontSize: "11px", color: "#a1a1aa"}}>
                      {it.owner}
                    </span>
                  </span>
                  <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11.5px", color: "#71717a", whiteSpace: "nowrap"}}>
                    <span style={{ color: it.blockerColor, display: 'inline-flex' }}><Mark label="due" /></span>
                    {it.date}
                  </span>
                </button>
                </React.Fragment>
              ))}
            </div>
            {V.tcItems.length ? null : (
              <div style={{padding: "18px 16px", fontSize: "12.5px", color: "#71717a"}}>
                No contract-to-close checklist on this file yet. Open the deal under contract and the checklist lands here.
              </div>
            )}
          </div>
        </TcStep>
        {V.tcFile?.txId ? (
          <TcStep n={4} title="Title commitment" note="Schedule C, item by item: green cleared, yellow working, red blocking.">
            <ScheduleC txId={V.tcFile.txId} canWrite={V.tcFile.canWrite} readOnlyReason="Read-only seat" />
          </TcStep>
        ) : null}
        <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "minmax(0,1fr) minmax(0,1fr)", gap: "14px", alignItems: "start"}}>
        <TcStep n={V.tcFile?.txId ? 5 : 4} title="People on the deal" note="Seller, buyer, title, agents and our team. Click a name to open their record.">
            <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", padding: "14px 16px"}}>
              {V.tcFile?.dealId ? (
                // Live: the deal team is the one list of who is on this deal, editable, with call / text / email.
                <DealTeam bare dealId={V.tcFile.dealId} onCall={V.callParty} onOpenSeller={(id) => V.openPerson('s' + id)} onOpenBuyer={(id) => V.openBuyerRecord('b' + id)} onOpenVendor={V.openVendorContact} onChanged={V.reloadCrm} />
              ) : (
                <>
                <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
                  Parties
                </div>
                {(V.tcParties || []).map((p, p__i) => (
                  <div key={p__i} style={{display: "grid", gridTemplateColumns: "90px 1fr", gap: "10px", padding: "7px 0", borderBottom: "1px solid #f0f0f1", fontSize: "12.5px"}}>
                    <span style={{color: "#71717a"}}>{p.k}</span>
                    <span style={{fontWeight: "500"}}>{p.v}</span>
                  </div>
                ))}
                </>
              )}
            </div>
        </TcStep>
        <TcStep n={V.tcFile?.txId ? 6 : 5} title="Tasks" note="What is still owed on this file.">
            <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", padding: "12px 16px"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
                <span style={{fontWeight: "600", fontSize: "14px"}}>Open tasks</span>
                <button onClick={V.addTcTask} style={{fontSize: "11.5px", color: "#0A8560", background: "none", border: "0", cursor: "pointer"}}>+ Add</button>
              </div>
              {(V.tcTasks || []).map((t) => (
                <label key={t.id} style={{display: "grid", gridTemplateColumns: "16px 1fr auto", gap: "8px", padding: "8px 0", borderBottom: "1px solid #f0f0f1", cursor: "pointer", alignItems: "start"}}>
                  <input type="checkbox" checked={!!t.done} onChange={t.toggle} style={{width: "14px", height: "14px", accentColor: "#0A8560", marginTop: "2px"}} />
                  <span style={{fontSize: "12.5px", fontWeight: "500", color: t.done ? "#a1a1aa" : "#18181b", textDecoration: t.done ? "line-through" : "none"}}>{t.title}</span>
                  <span style={{fontSize: "11.5px", color: "#71717a", whiteSpace: "nowrap"}}>{t.due}</span>
                </label>
              ))}
              {(V.tcTasks || []).length ? null : <div style={{fontSize: "12.5px", color: "#a1a1aa", padding: "8px 0"}}>No open tasks on this file.</div>}
            </div>
        </TcStep>
        </div>
        <TcStep n={V.tcFile?.txId ? 7 : 6} title="Documents" note="Contracts, addenda, title and closing papers.">
            {V.tcFile?.dealId ? (
              <div>
                <DealFiles
                  workspaceId={V.tcFile.workspaceId}
                  dealId={V.tcFile.dealId}
                  canWrite={V.tcFile.canWrite}
                  onToast={V.showToast}
                  onOpenPhotos={(title, urls, start) => V.openPhotoShow(title, urls, V.tcFile!.dealId, start)}
                  orderRequest={orderReq}
                />
              </div>
            ) : null}
        </TcStep>
        <TcStep n={V.tcFile?.txId ? 8 : 7} title="Transaction history" note="Calls, texts, email and notes on this deal, newest first.">
            <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
              <div style={{padding: "12px 16px", borderBottom: "1px solid #f0f0f1"}}>
                <div style={{fontWeight: "600", fontSize: "14px"}}>Transaction activity</div>
                {(V.tcFeedFilters || []).length ? (
                  <div style={{display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "8px"}}>
                    {V.tcFeedFilters.map((f) => (
                      <button key={f.label} onClick={f.go} style={{height: "24px", padding: "0 8px", borderRadius: "999px", border: `1px solid ${f.on ? "#0A8560" : "#e4e4e7"}`, background: f.on ? "#E7F8F1" : "#fff", color: f.on ? "#0A8560" : "#52525b", fontSize: "11.5px", fontWeight: f.on ? "600" : "500", cursor: "pointer"}}>
                        {f.label} <span style={{color: "#a1a1aa"}}>{f.count}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {(V.tcFeed || []).map((f, f__i) => (
                <React.Fragment key={f__i}>
                <div style={{display: "grid", gridTemplateColumns: "28px 1fr", gap: "10px", padding: "10px 16px", borderBottom: "1px solid #f0f0f1"}}>
                  <span style={{width: "28px", height: "28px", borderRadius: "7px", background: "#f4f4f5", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "700", color: "#52525b"}}>
                    {f.initials}
                  </span>
                  <span style={{minWidth: "0"}}>
                    <span style={{display: "flex", alignItems: "center", gap: "8px"}}>
                      <span style={{fontWeight: "600", fontSize: "12.5px"}}>
                        {f.who}
                      </span>
                      <span style={{fontSize: "10px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: f.roleColor}}>
                        {f.role}
                      </span>
                      <span style={{flex: "1"}}></span>
                      <span style={{fontSize: "11px", color: "#a1a1aa", whiteSpace: "nowrap"}}>
                        {f.time}
                      </span>
                    </span>
                    <span style={{display: "block", fontSize: "12.5px", color: "#27272a", marginTop: "2px", lineHeight: "1.45", whiteSpace: "pre-line", overflowWrap: "anywhere"}}>
                      {f.text}
                    </span>
                  </span>
                </div>
                </React.Fragment>
              ))}
              {V.tcFeed.length ? null : <div style={{padding: "14px 16px", fontSize: "12.5px", color: "#a1a1aa", borderBottom: "1px solid #f0f0f1"}}>No transaction activity yet.</div>}
              <div style={{padding: "10px 16px", display: "flex", gap: "6px", alignItems: "flex-end"}}>
                <label style={{flex: "1", display: "flex", flexDirection: "column", gap: "4px", minWidth: 0}}>
                  <span style={{fontSize: "11.5px", fontWeight: 500, color: "#71717a"}}>Note on this deal&rsquo;s file</span>
                  <input className="dc21" value={V.composerText} onChange={V.setBuyerMsg} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); V.sendTcMsg(); } }} style={{height: "32px", padding: "0 10px", border: "1px solid #e4e4e7", borderRadius: "8px", fontSize: "12.5px", outline: "0", background: "#fafafa"}} />
                </label>
                <button type="button" className="dc10" onClick={V.sendTcMsg} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12px", fontWeight: "600", cursor: "pointer"}}>
                  Save note
                </button>
              </div>
            </div>
        </TcStep>
      </div>
    </section>
  );
}

/** One numbered step of the closing file. */
function TcStep({ n, title, note, children }: { n: number; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} style={{ marginBottom: '18px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', margin: '0 0 8px 2px' }}>
        <span aria-hidden style={{ width: '22px', height: '22px', borderRadius: '999px', background: '#0A8560', color: '#fff', fontSize: '11.5px', fontWeight: 800, display: 'inline-grid', placeItems: 'center', flex: 'none', alignSelf: 'center' }}>{n}</span>
        <h2 style={{ margin: 0, fontSize: '14.5px', fontWeight: 700, letterSpacing: '-0.01em', color: '#18181b' }}>{title}</h2>
        {note ? <span style={{ fontSize: '12px', color: '#71717a' }}>{note}</span> : null}
      </div>
      {children}
    </section>
  );
}
