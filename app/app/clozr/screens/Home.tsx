// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { Empty } from '@/components/ds/Empty';
import { Chevron, CZ } from '@/components/ds/chrome';
import type { ClozrView } from '@/app/clozr/view';
import { Mark } from '@/components/ds/mark';

const none = (text: string) => (
  <div style={{padding: "18px 16px", fontSize: "12.5px", color: "#a1a1aa"}}>{text}</div>
);

export function Home({ V }: { V: ClozrView }) {
  return (
    <section data-screen-label="Home" style={{flex: "1", minWidth: "0", overflow: "auto", padding: V.isMobile ? "14px 12px 28px" : "22px 28px 40px"}}>
      <div style={{display: "flex", flexDirection: V.isMobile ? "column" : "row", alignItems: V.isMobile ? "stretch" : "flex-end", justifyContent: "space-between", gap: V.isMobile ? "12px" : "16px", marginBottom: "18px"}}>
        <div>
          <div style={{fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
            {V.todayLabel}
          </div>
          <h1 style={{margin: "4px 0 0", fontSize: V.isMobile ? "21px" : "24px", fontWeight: "700", letterSpacing: "-0.03em"}}>
            {V.greeting}{V.meName ? ', ' + V.meName : ''}
          </h1>
          {V.todayAiGreeting && <p style={{margin: "4px 0 0", fontSize: "13px", color: "#52525b"}}>{V.todayAiGreeting}</p>}
        </div>
        <div style={{display: "flex", gap: "8px", alignItems: "center"}}>
          {/* Owners and admins only: it scopes the tiles and the queue below. */}
          {V.canScopeHome ? (
          <div style={{position: "relative"}}>
            <button className="dc1 cz-menu-trigger" onClick={V.toggleTeamMenu} style={{height: "34px", padding: "0 12px", borderRadius: "10px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "13px", fontWeight: "500", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "8px", color: "#18181b", fontFamily: "var(--font-sans)"}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="8" r="3.2" />
                <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
                <path d="M16 5.2a3.2 3.2 0 0 1 0 6.3" />
                <path d="M21.5 20a6.5 6.5 0 0 0-4.5-6.2" />
              </svg>
              {V.teamView}
              <Chevron size={12} color={CZ.faint} />
            </button>
            {(V.teamMenuOpen) ? (
              <>
              <div ref={keepInView} style={{position: "absolute", top: "38px", right: "0", width: "200px", background: "#fff", border: "1px solid #e4e4e7", borderRadius: "10px", boxShadow: "0 10px 28px -10px rgba(18,22,40,0.2)", padding: "5px", zIndex: "30"}}>
                {(V.teamOptions || []).map((o, o__i) => (
                  <React.Fragment key={o__i}>
                  <button className="dc2" onClick={o.go} style={{display: "block", width: "100%", textAlign: "left", height: "32px", padding: "0 10px", border: "0", borderRadius: "7px", background: "none", cursor: "pointer", fontSize: "13px", color: "#18181b"}}>
                    {o.label}
                  </button>
                  </React.Fragment>
                ))}
              </div>
              </>
            ) : null}
          </div>
          ) : null}
          <button className="clozr-talkr-btn" onClick={V.openCallQueue} style={{height: "34px", flex: V.isMobile ? "1" : "none", whiteSpace: "nowrap", padding: "0 12px", borderRadius: "9px", border: "1px solid var(--c-talkr)", background: "var(--c-talkr)", color: "#fff", fontWeight: "600", fontSize: "13px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "7px"}}>
            Start call queue
            <span style={{fontSize: "11px", opacity: ".7"}}>
              {V.callQueueCount}
            </span>
          </button>
        </div>
      </div>
      {(V.workspaceEmpty || !V.crmOk) ? (
        <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", boxShadow: "0 1px 2px rgba(0,0,0,.03)"}}>
          <Empty
            title="Your workspace is empty"
            hint="Records arrive three ways: the Deal Machine extension pushes scraped leads, Talkr posts calls and texts against them, and Quick Add (Q) creates anything by hand. Settings → Ingest keys has the endpoint and a key for each source."
            failed={!V.crmOk}
            onRetry={V.reloadCrm}
            action={V.goSettings}
            actionLabel="Open Settings"
          />
        </div>
      ) : null}
      <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr 1fr" : "repeat(8,minmax(0,1fr))", background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,.03)"}}>
        {(V.homeStats || []).map((s, s__i) => (
          <React.Fragment key={s__i}>
          <div style={{padding: V.isMobile ? "12px 13px" : "14px 16px", borderRight: "1px solid #f0f0f1", borderBottom: V.isMobile ? "1px solid #f0f0f1" : "0"}}>
            {/* Labels name their period ("… this month"), so they may wrap rather than run into the next tile. */}
            <div style={{fontSize: "10.5px", letterSpacing: "0.1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600", whiteSpace: "normal"}}>
              {s.k}
            </div>
            <div style={{fontSize: "22px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "6px", color: "#18181b"}}>
              {s.v}
            </div>
            <div style={{fontSize: "11.5px", marginTop: "2px", color: s.dColor}}>
              {s.d}
            </div>
          </div>
          </React.Fragment>
        ))}
      </div>
      <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "minmax(0,1.7fr) minmax(300px,0.9fr)", gap: "16px", marginTop: "16px", alignItems: "start"}}>
        <div style={{display: "flex", flexDirection: "column", gap: "16px", minWidth: "0"}}>
          <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: V.isMobile ? "wrap" : "nowrap", padding: "12px 16px", borderBottom: "1px solid #f0f0f1"}}>
              <div style={{display: "flex", alignItems: "baseline", gap: "10px", minWidth: "0", flex: "1 1 auto"}}>
                <span style={{fontWeight: "600", fontSize: "14px", flex: "none"}}>
                  {V.homeQueueTitle}
                </span>
                <span style={{fontSize: "12px", color: "#71717a", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                  {V.queueCount} items · ordered by urgency
                </span>
              </div>
              <div style={{display: "flex", gap: "6px", flex: "none"}}>
                <button className="dc2" onClick={V.goTasks} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", cursor: "pointer", color: "#52525b"}}>
            All tasks
          </button>
                <button className="clozr-talkr-ghost" onClick={V.can.today ? V.goToday : V.openCallQueue} style={{display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--c-talkr)", height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid #fecdd3", background: "var(--c-btn-bg)", fontSize: "12px", cursor: "pointer", fontWeight: "600"}}>
                  Work queue <Chevron dir="right" size={12} color="currentColor" />
                </button>
              </div>
            </div>
            {(V.queue || []).map((q) => (
              <React.Fragment key={q.id}>
              {/* Three columns at 92px + text + five buttons needs ~560px. On a
                  phone that left the middle column about 90px wide, so the
                  title broke one word per line and the last buttons were
                  clipped off the card. The phone stacks it instead. */}
              <div className="dc4" style={V.isMobile
                ? {display: "flex", flexDirection: "column", gap: "9px", alignItems: "stretch", padding: "12px 14px", borderBottom: "1px solid #f0f0f1", minWidth: "0"}
                : {display: "grid", gridTemplateColumns: "92px minmax(0,1fr) auto", gap: "14px", alignItems: "center", padding: "11px 16px", borderBottom: "1px solid #f0f0f1", transition: "background .12s"}}>
                <span style={{display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "10.5px", fontWeight: "700", letterSpacing: "0.1em", textTransform: "uppercase", color: q.color, whiteSpace: "nowrap"}}>
                  <Mark label={q.tag} />
                  {q.tag}
                </span>
                <div style={{minWidth: "0"}}>
                  <div style={{display: "flex", alignItems: "baseline", gap: "8px", flexWrap: V.isMobile ? "wrap" : "nowrap", minWidth: "0"}}>
                    <button className="dc5" onClick={q.open} style={{fontWeight: "600", fontSize: "13.5px", color: "#18181b", background: "none", border: "0", padding: "0", cursor: "pointer", textAlign: "left", minWidth: "0", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {q.title}
                    </button>
                    <span style={{fontSize: "12px", color: "#71717a", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {q.sub}
                    </span>
                  </div>
                  <div style={{fontSize: "12px", color: "#71717a", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: V.isMobile ? "normal" : "nowrap"}}>
                    {q.meta}
                  </div>
                </div>
                <div style={{display: "flex", gap: "6px", minWidth: "0"}}>
                  <button className="clozr-talkr-ghost" onClick={q.call} style={{color: "var(--c-talkr)", height: V.isMobile ? "36px" : "28px", flex: V.isMobile ? "1" : "none", minWidth: "0", padding: "0 10px", borderRadius: V.isMobile ? "9px" : "7px", border: "1px solid #fecdd3", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", }}>
                    Call
                  </button>
                  <button className="clozr-talkr-ghost" onClick={q.text} style={{color: "var(--c-talkr)", height: V.isMobile ? "36px" : "28px", flex: V.isMobile ? "1" : "none", minWidth: "0", padding: "0 10px", borderRadius: V.isMobile ? "9px" : "7px", border: "1px solid #fecdd3", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", }}>
                    Text
                  </button>
                  <button className="dc6" onClick={q.open} style={{height: V.isMobile ? "36px" : "28px", flex: V.isMobile ? "1" : "none", minWidth: "0", padding: "0 10px", borderRadius: V.isMobile ? "9px" : "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", color: "#18181b"}}>
                    Open
                  </button>
                  <button className="dc7" onClick={q.complete} title="Complete" style={{height: V.isMobile ? "36px" : "28px", width: V.isMobile ? "38px" : "30px", flex: "none", borderRadius: V.isMobile ? "9px" : "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", cursor: "pointer", color: "#1f7a4d", display: "grid", placeItems: "center"}}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </button>
                  <button className="dc2" onClick={q.snooze} title={q.snoozeLabel} style={{height: V.isMobile ? "36px" : "28px", width: V.isMobile ? "38px" : "30px", flex: "none", borderRadius: V.isMobile ? "9px" : "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", cursor: "pointer", color: "#71717a", display: "grid", placeItems: "center"}}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </button>
                </div>
              </div>
              </React.Fragment>
            ))}
            {V.queueCount === 0 ? (
              <div style={{padding: "28px 16px", textAlign: "center", fontSize: "13px", color: "#71717a"}}>
                Queue clear — nothing waiting on you right now.
              </div>
            ) : null}
          </div>
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "1fr 1fr", gap: V.isMobile ? "12px" : "16px", minWidth: "0"}}>
            <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #f0f0f1"}}>
                <span style={{fontWeight: "600", fontSize: "14px"}}>
                  Recent inbound
                </span>
                {V.can.inbox ? (
                <button onClick={V.goInbox} style={{display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#0A8560", background: "none", border: "0", cursor: "pointer", fontWeight: "500"}}>
                  Open inbox <Chevron dir="right" size={12} color="currentColor" />
                </button>
                ) : null}
              </div>
              {(V.homeInbound || []).map((m, m__i) => (
                <React.Fragment key={m__i}>
                <button className="dc4" onClick={m.open} style={{display: "grid", gridTemplateColumns: "30px minmax(0,1fr) auto", gap: "10px", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 16px", border: "0", borderBottom: "1px solid #f0f0f1", background: "none", cursor: "pointer"}}>
                  <span style={{width: "30px", height: "30px", borderRadius: "8px", background: "#f4f4f5", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: "700", color: "#52525b"}}>
                    {m.initials}
                  </span>
                  <span style={{minWidth: "0"}}>
                    <span style={{display: "flex", gap: "6px", alignItems: "baseline"}}>
                      <span style={{fontWeight: "600", fontSize: "13px", color: "#18181b"}}>
                        {m.name}
                      </span>
                      <span style={{fontSize: "11px", color: "#a1a1aa", textTransform: "uppercase", letterSpacing: ".06em"}}>
                        {m.channel}
                      </span>
                    </span>
                    <span style={{display: "block", fontSize: "12px", color: "#71717a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>
                      {m.preview}
                    </span>
                  </span>
                  <span style={{fontSize: "11px", color: "#a1a1aa", whiteSpace: "nowrap"}}>
                    {m.time}
                  </span>
                </button>
                </React.Fragment>
              ))}
              {V.homeInbound.length ? null : none("Nothing inbound yet.")}
            </div>
            <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #f0f0f1"}}>
                <span style={{fontWeight: "600", fontSize: "14px"}}>
                  Upcoming closings
                </span>
                <span style={{fontSize: "12px", color: "#71717a"}}>
                  {V.closingsTotal} with a close date
                </span>
              </div>
              {(V.homeClosings || []).map((c, c__i) => (
                <React.Fragment key={c__i}>
                <button className="dc4" onClick={c.open} style={{display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: "12px", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 16px", border: "0", borderBottom: "1px solid #f0f0f1", background: "none", cursor: "pointer"}}>
                  <span style={{minWidth: "0"}}>
                    <span style={{display: "block", fontWeight: "600", fontSize: "13px", color: "#18181b"}}>
                      {c.addr}
                    </span>
                    <span style={{display: "block", fontSize: "12px", color: "#71717a"}}>
                      {c.sub}
                    </span>
                  </span>
                  <span style={{fontSize: "13px", fontWeight: "600", color: "#18181b"}}>
                    {c.fee}
                  </span>
                  <span style={{fontSize: "12px", color: c.color, fontWeight: "600", whiteSpace: "nowrap"}}>
                    {c.when}
                  </span>
                </button>
                </React.Fragment>
              ))}
              {V.homeClosings.length ? null : none("No close dates set.")}
            </div>
          </div>
        </div>
        <div style={{display: "flex", flexDirection: "column", gap: "16px", minWidth: "0"}}>
          {(V.showAi && V.aiAlerts.length) ? (
            <>
            <div style={{background: "#141419", color: "#fff", borderRadius: "12px", padding: "16px", position: "relative", overflow: "hidden"}}>
              <div style={{position: "absolute", inset: "0", pointerEvents: "none", background: "radial-gradient(120% 90% at 90% -10%, rgba(10, 133, 96,0.34), transparent 58%)"}}></div>
              <div style={{position: "relative"}}>
                <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
                  <span style={{fontSize: "10.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,.6)", fontWeight: "600"}}>
                    CLOZR AI · alerts
                  </span>
                  <span style={{width: "7px", height: "7px", borderRadius: "999px", background: "#0A8560", animation: "clozrPulse 2.4s infinite"}}></span>
                </div>
                {(V.aiAlerts || []).map((a, a__i) => (
                  <React.Fragment key={a__i}>
                  <div style={{marginTop: "12px", paddingTop: "12px", borderTop: "1px solid rgba(255,255,255,.1)"}}>
                    <div style={{fontSize: "13px", lineHeight: "1.45", color: "rgba(255,255,255,.92)"}}>
                      {a.text}
                    </div>
                    <div style={{display: "flex", gap: "6px", marginTop: "8px"}}>
                      <button className="dc3" onClick={a.go} style={{height: "26px", padding: "0 10px", borderRadius: "7px", border: "0", background: "#0A8560", color: "#fff", fontSize: "12px", fontWeight: "600", cursor: "pointer"}}>
                        {a.cta}
                      </button>
                      <button className="dc8" onClick={a.dismiss} style={{height: "26px", padding: "0 10px", borderRadius: "7px", border: "1px solid rgba(255,255,255,.18)", background: "transparent", color: "rgba(255,255,255,.75)", fontSize: "12px", cursor: "pointer"}}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                  </React.Fragment>
                ))}
              </div>
            </div>
            </>
          ) : null}
          <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #f0f0f1"}}>
              <span style={{fontWeight: "600", fontSize: "14px"}}>
                At-risk deals
              </span>
              <button onClick={V.goDeals} style={{display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#0A8560", background: "none", border: "0", cursor: "pointer", fontWeight: "500"}}>
                Pipeline <Chevron dir="right" size={12} color="currentColor" />
              </button>
            </div>
            {(V.atRisk || []).map((r, r__i) => (
              <React.Fragment key={r__i}>
              <button className="dc4" onClick={r.open} style={{display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "10px", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 16px", border: "0", borderBottom: "1px solid #f0f0f1", background: "none", cursor: "pointer"}}>
                <span style={{minWidth: "0"}}>
                  <span style={{display: "block", fontWeight: "600", fontSize: "13px", color: "#18181b"}}>
                    {r.addr}
                  </span>
                  <span style={{display: "block", fontSize: "12px", color: "#71717a"}}>
                    {r.reason}
                  </span>
                </span>
                <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "10.5px", fontWeight: "700", letterSpacing: ".1em", textTransform: "uppercase", color: r.color}}>
                  <Mark label={r.stage} />
                  {r.stage}
                </span>
              </button>
              </React.Fragment>
            ))}
            {V.atRisk.length ? null : none("No deals at risk.")}
          </div>
          <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #f0f0f1"}}>
              <span style={{fontWeight: "600", fontSize: "14px"}}>
                Recent contracts
              </span>
              <span style={{fontSize: "12px", color: "#71717a"}}>
                latest
              </span>
            </div>
            {(V.recentContracts || []).map((r, r__i) => (
              <React.Fragment key={r__i}>
              <button className="dc4" onClick={r.open} style={{display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "10px", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 16px", border: "0", borderBottom: "1px solid #f0f0f1", background: "none", cursor: "pointer"}}>
                <span style={{minWidth: "0"}}>
                  <span style={{display: "block", fontWeight: "600", fontSize: "13px", color: "#18181b"}}>
                    {r.addr}
                  </span>
                  <span style={{display: "block", fontSize: "12px", color: "#71717a"}}>
                    {r.sub}
                  </span>
                </span>
                <span style={{fontSize: "13px", fontWeight: "600"}}>
                  {r.price}
                </span>
              </button>
              </React.Fragment>
            ))}
            {V.recentContracts.length ? null : none("No contracts dated yet.")}
          </div>
          {V.teamFeed.length ? (
          <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden"}}>
            <div style={{padding: "12px 16px", borderBottom: "1px solid #f0f0f1", fontWeight: "600", fontSize: "14px"}}>
              Team activity
            </div>
            {(V.teamFeed || []).map((f, f__i) => (
              <React.Fragment key={f__i}>
              <div style={{display: "grid", gridTemplateColumns: "26px minmax(0,1fr) auto", gap: "10px", alignItems: "start", padding: "9px 16px", borderBottom: "1px solid #f0f0f1"}}>
                <span style={{width: "26px", height: "26px", borderRadius: "7px", background: "#E7F8F1", color: "#0A8560", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "700"}}>
                  {f.initials}
                </span>
                <span style={{fontSize: "12.5px", color: "#27272a", lineHeight: "1.4"}}>
                  <b style={{fontWeight: "600"}}>
                    {f.who}
                  </b>
                  {f.text}
                </span>
                <span style={{fontSize: "11px", color: "#a1a1aa", whiteSpace: "nowrap"}}>
                  {f.time}
                </span>
              </div>
              </React.Fragment>
            ))}
          </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
