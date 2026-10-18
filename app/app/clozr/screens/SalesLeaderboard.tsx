// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React from 'react';
import { BackLink } from '@/components/ds/BackLink';
import { keepInView } from '@/components/ds/keepInView';
import { UserAvatar } from '@/components/UserAvatar';
import type { ClozrView } from '@/app/clozr/view';
import { holdReporting } from '@/lib/use-crm';

// A rep's face on the board: photo (Google photos need no-referrer, which a CSS
// background can't send), else initials on the board's dark disc.
function Face({ name, src, size, style }: { name: string; src?: string | null; size: string | number; style?: React.CSSProperties }) {
  return <UserAvatar name={name} src={src || null} size={parseInt(String(size), 10) || 32} bg="var(--ink-deep, #1c1d1f)" color="#fdfcfa" style={style} />;
}

export function SalesLeaderboard({ V }: { V: ClozrView }) {
  React.useEffect(() => holdReporting(), []);
  return (
    <section data-screen-label="Sales leaderboard" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column", background: "#f4f2ec", color: "#1c1d1f", overflow: "hidden", position: "relative"}}>
      <header style={{display: "flex", alignItems: "center", flexWrap: V.isMobile ? "wrap" : "nowrap", rowGap: "8px", gap: V.isMobile ? "10px" : "16px", padding: V.isMobile ? "10px 14px" : "10px 22px", background: "#f4f2ec", borderBottom: "1px solid #e2dfd5", flex: "none"}}>
        <BackLink to={V.backFor('reporting')} style={{ color: '#6f7377' }} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/company-logo.svg" alt="Acme Homes" style={{height: "32px", objectFit: "contain"}} />
        <span style={{width: "1px", height: "22px", background: "#ddd9ce"}}></span>
        <span style={{fontSize: "18px", fontWeight: "800", letterSpacing: "-0.02em"}}>
          Leaderboard
        </span>
        <span style={{flex: "1", minWidth: "0"}}></span>
        <label style={{display: "inline-flex", alignItems: "center", gap: "8px", padding: "8px 14px", borderRadius: "10px", border: "1px solid #ddd9ce", background: "#fdfcfa", color: "#9b9e96", minWidth: V.isMobile ? "0" : "200px", flex: V.isMobile ? "1 1 100%" : "none", cursor: "text"}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input value={V.lbQ} onChange={V.setLbQ} placeholder="Search reps" style={{border: "0", outline: "0", background: "transparent", fontSize: "13px", fontWeight: "500", color: "var(--ink-deep, #1c1d1f)", width: "100%"}} />
        </label>
        <button className="dc28" onClick={V.togglePoints} style={{display: "inline-flex", alignItems: "center", gap: "7px", padding: "8px 15px", borderRadius: "10px", border: "1px solid #ddd9ce", background: "#fdfcfa", color: "#1c1d1f", fontWeight: "600", fontSize: "13px", lineHeight: "1", cursor: "pointer", whiteSpace: "nowrap"}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Points
        </button>
        <button className="dc28" onClick={V.toggleBadges} title="Every badge and who holds it" style={{display: "inline-flex", alignItems: "center", gap: "7px", padding: "8px 15px", borderRadius: "10px", border: `1px solid ${V.lbBadgesOpen ? '#12946a' : '#ddd9ce'}`, background: V.lbBadgesOpen ? '#e3f0e9' : '#fdfcfa', color: "#1c1d1f", fontWeight: "600", fontSize: "13px", lineHeight: "1", cursor: "pointer", whiteSpace: "nowrap"}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
            <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
            <path d="M4 22h16" />
            <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
            <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
            <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
          </svg>
          Badges
        </button>
        <button className="dc28" onClick={V.toggleTv} title={V.tvLabel} style={{width: "36px", height: "36px", borderRadius: "10px", border: `1px solid ${V.tvBorder}`, background: V.tvBg, color: V.tvColor, cursor: "pointer", display: "grid", placeItems: "center"}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </button>
        <span style={{display: "inline-flex", alignItems: "center", gap: "6px", color: "#9b9e96", fontSize: "11px", fontWeight: "600", whiteSpace: "nowrap"}}>
          {V.lbClock}
          <span style={{width: "6px", height: "6px", borderRadius: "50%", background: "#12946a", display: "inline-block"}}></span>
        </span>
      </header>
      <div style={{flex: "1", display: "flex", flexDirection: V.isMobile ? "column" : "row", gap: V.isMobile ? "14px" : "22px", padding: V.isMobile ? "12px 14px 24px" : "18px 22px", minHeight: "0", overflowY: V.isMobile ? "auto" : "visible"}}>
        <main style={{flex: V.isMobile ? "none" : "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "14px", minHeight: "0"}}>
          <div style={{display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: "8px", gap: "8px", flexShrink: "0"}}>
            <div style={{position: "relative"}}>
              <button onClick={V.lbToggle.period} style={{display: "inline-flex", alignItems: "center", gap: "7px", padding: "8px 15px", borderRadius: "10px", border: "1px solid var(--ink-deep, #1c1d1f)", background: "var(--ink-deep, #1c1d1f)", color: "var(--surface, #fff)", fontWeight: "600", fontSize: "13px", lineHeight: "1", cursor: "pointer", whiteSpace: "nowrap"}}>
                {V.lbPeriodLabel}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {(V.lbMenu.period) ? (
                <>
                <div ref={keepInView} style={{position: "absolute", top: "calc(100% + 6px)", left: "0", zIndex: "20", minWidth: "220px", maxHeight: "46vh", overflowY: "auto", padding: "6px", borderRadius: "10px", border: "1px solid #ddd9ce", background: "#fdfcfa", boxShadow: "0 12px 30px rgba(28,29,31,.14)"}}>
                  {(V.lbPeriods || []).map((o, o__i) => (
                    <React.Fragment key={o__i}>
                    <button className="dc29" onClick={o.go} style={{display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "0", borderRadius: "8px", fontSize: "13px", fontWeight: "600", cursor: "pointer", background: o.bg, color: o.color}}>
                      {o.label}
                    </button>
                    </React.Fragment>
                  ))}
                </div>
                </>
              ) : null}
            </div>
            <div style={{position: "relative"}}>
              <button className="dc28" onClick={V.lbToggle.sort} style={{display: "inline-flex", alignItems: "center", gap: "7px", padding: "8px 15px", borderRadius: "10px", border: "1px solid #ddd9ce", background: "#fdfcfa", color: "#1c1d1f", fontWeight: "600", fontSize: "13px", lineHeight: "1", cursor: "pointer", whiteSpace: "nowrap"}}>
                {V.lbSortLabel}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {(V.lbMenu.sort) ? (
                <>
                <div ref={keepInView} style={{position: "absolute", top: "calc(100% + 6px)", left: "0", zIndex: "20", minWidth: "200px", padding: "6px", borderRadius: "10px", border: "1px solid #ddd9ce", background: "#fdfcfa", boxShadow: "0 12px 30px rgba(28,29,31,.14)"}}>
                  {(V.lbSorts || []).map((o, o__i) => (
                    <React.Fragment key={o__i}>
                    <button className="dc29" onClick={o.go} style={{display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "0", borderRadius: "8px", fontSize: "13px", fontWeight: "600", cursor: "pointer", background: o.bg, color: o.color}}>
                      {o.label}
                    </button>
                    </React.Fragment>
                  ))}
                </div>
                </>
              ) : null}
            </div>
            <div style={{position: "relative"}}>
              <button className="dc28" onClick={V.lbToggle.scope} style={{display: "inline-flex", alignItems: "center", gap: "7px", padding: "8px 15px", borderRadius: "10px", border: "1px solid #ddd9ce", background: "#fdfcfa", color: "#1c1d1f", fontWeight: "600", fontSize: "13px", lineHeight: "1", cursor: "pointer", whiteSpace: "nowrap"}}>
                {V.lbScopeLabel}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {(V.lbMenu.scope) ? (
                <>
                <div ref={keepInView} style={{position: "absolute", top: "calc(100% + 6px)", left: "0", zIndex: "20", minWidth: "200px", padding: "6px", borderRadius: "10px", border: "1px solid #ddd9ce", background: "#fdfcfa", boxShadow: "0 12px 30px rgba(28,29,31,.14)"}}>
                  {(V.lbScopes || []).map((o, o__i) => (
                    <React.Fragment key={o__i}>
                    <button className="dc29" onClick={o.go} style={{display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "0", borderRadius: "8px", fontSize: "13px", fontWeight: "600", cursor: "pointer", background: o.bg, color: o.color}}>
                      {o.label}
                    </button>
                    </React.Fragment>
                  ))}
                </div>
                </>
              ) : null}
            </div>
            <span style={{flex: "1"}}></span>
            <span style={{fontSize: "11px", fontWeight: "600", color: "#9b9e96", display: V.isMobile ? "none" : "inline-flex", alignItems: "center", gap: "6px"}}>
              <span style={{width: "6px", height: "6px", borderRadius: "50%", background: "#12946a"}}></span>
              {V.lbSyncLabel}
            </span>
          </div>
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "repeat(4, 1fr)" : "repeat(8, 1fr)", gap: "6px", flexShrink: "0"}}>
            {(V.lbKpis || []).map((k, k__i) => (
              <div key={k__i} style={{padding: "8px 10px", borderRadius: "10px", background: "#fdfcfa", border: "1px solid #e6e3da"}}>
                <div style={{fontSize: "9px", letterSpacing: ".12em", textTransform: "uppercase", color: "#9b9e96", fontWeight: "700"}}>{k.k}</div>
                <div style={{fontSize: V.isMobile ? "14px" : "17px", fontWeight: "800", letterSpacing: "-0.02em", marginTop: "2px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{k.v}</div>
              </div>
            ))}
          </div>
          {V.lbReadFailed ? (
            <div role="status" style={{margin: "0 0 10px", padding: "8px 12px", borderRadius: "10px", background: "var(--tint-red, #fef2f2)", color: "var(--tx-red, #b91c1c)", fontSize: "12.5px", fontWeight: 600}}>
              Part of the workspace did not load, so these numbers may read low. Reload to try again.
            </div>
          ) : null}
          {(V.lbNotes || []).length ? (
            <div style={{fontSize: "11px", color: "#6f7377", background: "#f7f5ee", border: "1px solid #e6e3da", borderRadius: "8px", padding: "6px 10px"}}>
              {(V.lbNotes || []).join(' ')}
            </div>
          ) : null}
          {V.lbEmpty ? (
            <div style={{padding: "28px", textAlign: "center", color: "#9b9e96", fontSize: "14px", fontWeight: "600", background: "#fdfcfa", border: "1px dashed #ddd9ce", borderRadius: "16px"}}>
              No teammates on the board yet. Invite the team under Settings; every call, text, offer, contract and closing they log in CLOZR lands here.
            </div>
          ) : null}
          <div style={{display: "flex", alignItems: "flex-end", justifyContent: "center", gap: V.isMobile ? "10px" : "56px", padding: "6px 0 12px", flexShrink: "0"}}>
            {(V.lbPodium || []).map((p, p__i) => (
              <React.Fragment key={p__i}>
              <button className="dc30" onClick={p.open} style={{display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", minWidth: "0", border: "0", background: "none", padding: "0", cursor: "pointer", borderRadius: "12px", color: "var(--ink-deep, #1c1d1f)", width: p.slotW, transition: "transform .15s ease"}}>
                <span style={{position: "relative", display: "inline-block"}}>
                  <Face name={p.name} src={p.avatar} size={p.size} style={{display: "grid", boxShadow: p.shadow}} />
                  <span style={{position: "absolute", top: "-4px", left: "-4px", width: p.pip, height: p.pip, borderRadius: "50%", background: "var(--ink-deep, #1c1d1f)", border: "2px solid #f4f2ec", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "800", fontSize: p.pipFs, color: "var(--surface, #fff)"}}>
                    {p.rank}
                  </span>
                </span>
                <span style={{fontSize: p.nameFs, fontWeight: p.nameW, marginTop: "4px", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                  {p.name}
                </span>
                <span style={{fontSize: p.scoreFs, fontWeight: "800", lineHeight: "1", letterSpacing: "-0.03em"}}>
                  {p.score}
                </span>
                <span style={{fontSize: "10px", color: "#9b9e96", fontWeight: "600", whiteSpace: "nowrap", display: V.isMobile ? "none" : "block"}}>
                  {p.sub}
                </span>
                {(p.isFirst) ? (
                  <>
                  <span style={{display: "inline-flex", alignItems: "center", gap: "6px", marginTop: "2px", padding: "4px 10px", borderRadius: "6px", background: "var(--ink-deep, #1c1d1f)", fontSize: "10px", fontWeight: "700", letterSpacing: "0.1em", color: "var(--surface, #fff)"}}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14" />
                    </svg>
                    THE CROWN
                  </span>
                  </>
                ) : null}
                {(p.notFirst) ? (
                  <>
                  <span style={{display: "flex", gap: "5px", marginTop: "2px", minHeight: "26px"}}>
                    {(p.badges || []).map((b, b__i) => (
                      <React.Fragment key={b__i}>
                      <span title={b.title} style={{display: "inline-block", width: "26px", height: "26px", borderRadius: "50%", border: "1px solid #ddd9ce", boxShadow: "inset 0 1px 0 #fff,0 1px 3px rgba(28,29,31,.1)", background: `#eceae3 url(${b.img}) center/cover no-repeat`}}></span>
                      </React.Fragment>
                    ))}
                  </span>
                  </>
                ) : null}
              </button>
              </React.Fragment>
            ))}
          </div>
          <div style={{flex: V.isMobile ? "none" : "1", display: "flex", flexDirection: "column", overflowY: V.isMobile ? "visible" : "auto", minHeight: "0", background: "#fdfcfa", border: "1px solid #e6e3da", borderRadius: "16px", boxShadow: "0 1px 3px rgba(28,29,31,.06)"}}>
            {(V.lbRest || []).map((r, r__i) => (
              <React.Fragment key={r__i}>
              <button className="dc31" onClick={r.open} style={{flex: "1", display: "flex", alignItems: "center", gap: V.isMobile ? "10px" : "14px", padding: V.isMobile ? "10px 12px" : "10px 18px", border: "0", borderBottom: "1px solid #efece4", minHeight: "56px", width: "100%", background: "none", color: "var(--ink-deep, #1c1d1f)", textAlign: "left", cursor: "pointer", transition: "background .15s"}}>
                <span style={{width: "22px", textAlign: "center", fontWeight: "700", fontSize: "14px", color: "#9b9e96", flexShrink: "0"}}>
                  {r.rank}
                </span>
                <Face name={r.name} src={r.avatar} size={42} />
                <span style={{display: "flex", flexDirection: "column", gap: "2px", minWidth: "0"}}>
                  <span style={{fontWeight: "700", fontSize: "15px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>
                    {r.name}
                  </span>
                  <span style={{display: "flex", gap: "5px", alignItems: "center"}}>
                    {(r.badges || []).length === 0 ? <span style={{fontSize: "10px", color: "#9b9e96", fontWeight: "600"}}>{r.sub}</span> : null}
                    {(r.badges || []).map((b, b__i) => (
                      <React.Fragment key={b__i}>
                      <span title={b.title} style={{display: "inline-block", width: "22px", height: "22px", borderRadius: "50%", border: "1px solid #ddd9ce", boxShadow: "inset 0 1px 0 #fff,0 1px 3px rgba(28,29,31,.1)", background: `#eceae3 url(${b.img}) center/cover no-repeat`}}></span>
                      </React.Fragment>
                    ))}
                  </span>
                </span>
                <span style={{flex: "1", minWidth: "0"}}></span>
                <span style={{width: "140px", height: "4px", borderRadius: "999px", background: "#efece4", overflow: "hidden", display: V.isMobile ? "none" : "block", flexShrink: "0"}}>
                  <span style={{display: "block", height: "100%", borderRadius: "999px", background: "#12946a", width: r.pct, transition: "width .4s cubic-bezier(0.4,0,0.2,1)"}}></span>
                </span>
                <span style={{width: "76px", textAlign: "right", fontWeight: "800", fontSize: "17px", flexShrink: "0"}}>
                  {r.score}
                </span>
              </button>
              </React.Fragment>
            ))}
            {(V.lbRestEmpty) ? (
              <>
              <div style={{display: "flex", alignItems: "center", justifyContent: "center", flex: "1", color: "#9b9e96", fontSize: "14px", fontWeight: "600", padding: "24px"}}>
                Everyone in view is on the podium.
              </div>
              </>
            ) : null}
          </div>
        </main>
        <aside style={{flex: V.isMobile ? "none" : "0 0 320px", display: "flex", flexDirection: "column", gap: "14px", minHeight: "0"}}>
          <section style={{padding: "16px", display: "flex", flexDirection: "column", background: "#fdfcfa", border: "1px solid #e6e3da", borderRadius: "16px", boxShadow: "0 1px 3px rgba(28,29,31,.06)"}}>
            <div style={{display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px"}}>
              <span style={{fontWeight: "800", fontSize: "15px", letterSpacing: "-0.01em"}}>
                Monthly prize
              </span>
              <span style={{fontSize: "11.5px", color: "#6f7377", fontWeight: "600"}}>
                {V.lbPrize?.month}
              </span>
            </div>
            {V.lbPrize ? (
              <div data-testid="lb-monthly-prize" style={{marginTop: "10px"}}>
                <div style={{fontSize: "20px", fontWeight: "800", letterSpacing: "-0.02em", lineHeight: 1.2, overflowWrap: "anywhere", color: V.lbPrize.set ? "var(--ink-deep, #1c1d1f)" : "#6f7377"}}>
                  {V.lbPrize.name}
                </div>
                {V.lbPrize.detail ? (
                  <div style={{fontSize: "12.5px", color: "#6f7377", marginTop: "4px", lineHeight: 1.4}}>{V.lbPrize.detail}</div>
                ) : null}
                <div style={{display: "flex", alignItems: "baseline", gap: "6px", marginTop: "12px"}}>
                  <span style={{fontWeight: "800", fontSize: "17px", fontVariantNumeric: "tabular-nums"}}>{V.lbPrize.spins}</span>
                  <span style={{fontSize: "12.5px", color: "#6f7377"}}>
                    {V.lbPrize.spins === 1 ? 'contract this month, one spin' : 'contracts this month, one spin each'}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{marginTop: "10px", height: "64px", borderRadius: "10px", background: "#efece4"}} aria-label="Loading the monthly prize" />
            )}
            <div style={{marginTop: "12px", paddingTop: "10px", borderTop: "1px solid #efece4", fontSize: "11.5px", color: "#6f7377"}}>
              Set in Settings, Floor show. Each signed contract spins the wheel; the gold slice is this prize.
            </div>
            <div style={{marginTop: "6px", fontSize: "11.5px", color: "#6f7377", fontVariantNumeric: "tabular-nums"}}>
              {V.lbYearContracts} team contracts this year · {V.lbTeamContracts} in the selected period
            </div>
          </section>
          <section data-testid="lb-h2h" style={{padding: "16px", display: "flex", flexDirection: "column", background: "#fdfcfa", border: "1px solid #e6e3da", borderRadius: "16px", boxShadow: "0 1px 3px rgba(28,29,31,.06)"}}>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "12px"}}>
              <span style={{fontWeight: "800", fontSize: "15px", letterSpacing: "-0.01em"}}>
                Head-to-head
              </span>
              <span style={{fontSize: "11px", fontWeight: "600", color: "#4b4e52", background: "#efece4", padding: "3px 8px", borderRadius: "6px", whiteSpace: "nowrap"}}>
                {V.lbH2hDaysLeft}
              </span>
            </div>
            {(V.lbH2h || []).length ? (
              <button type="button" className="dc2" onClick={V.toggleH2h} aria-expanded={V.lbH2hOpen}
                title={V.lbH2hOpen ? 'Hide the week side by side' : 'See the week side by side'}
                style={{display: "flex", flexDirection: "column", gap: "12px", width: "100%", padding: "4px", margin: "-4px", border: 0, borderRadius: "10px", background: "transparent", cursor: "pointer", textAlign: "left", font: "inherit", color: "inherit"}}>
                {(V.lbH2h || []).map((h, h__i) => (
                  <span key={h__i} style={{display: "flex", alignItems: "center", gap: "10px", width: "100%"}}>
                    <Face name={h.first} src={h.avatar} size={32} />
                    <span style={{fontWeight: "700", fontSize: "13px", width: "58px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {h.first}
                    </span>
                    <span style={{flex: "1", height: "5px", borderRadius: "999px", background: "#efece4", overflow: "hidden", display: "block"}}>
                      <span style={{display: "block", height: "100%", borderRadius: "999px", width: h.pct, background: h.fill}}></span>
                    </span>
                    <span style={{fontWeight: "800", fontSize: "14px", fontVariantNumeric: "tabular-nums"}}>
                      {h.score}
                    </span>
                  </span>
                ))}
              </button>
            ) : (
              <div style={{fontSize: "12.5px", color: "#6f7377"}}>Two reps on the board start a matchup.</div>
            )}
            {V.lbH2hOpen && (V.lbH2hRows || []).length ? (
              <table data-testid="lb-h2h-week" style={{width: "100%", marginTop: "12px", borderCollapse: "collapse", fontSize: "12.5px", fontVariantNumeric: "tabular-nums"}}>
                <thead>
                  <tr style={{color: "#6f7377", fontSize: "11.5px"}}>
                    <th style={{textAlign: "left", fontWeight: 500, padding: "4px 0"}}>This week</th>
                    {(V.lbH2h || []).map((h, i) => <th key={i} style={{textAlign: "right", fontWeight: 600, padding: "4px 0"}}>{h.first}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(V.lbH2hRows || []).map((r) => (
                    <tr key={r.k} style={{borderTop: "1px solid #efece4"}}>
                      <td style={{padding: "6px 0", color: "var(--ink-3, #3f3f46)"}}>{r.k}</td>
                      <td style={{padding: "6px 0", textAlign: "right", fontWeight: r.aLead ? 800 : 500, color: r.aLead ? "var(--tx-green-2, #0e7a57)" : "var(--ink-deep, #1c1d1f)"}}>{r.a}</td>
                      <td style={{padding: "6px 0", textAlign: "right", fontWeight: r.bLead ? 800 : 500, color: r.bLead ? "var(--tx-green-2, #0e7a57)" : "var(--ink-deep, #1c1d1f)"}}>{r.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <div style={{marginTop: "12px", paddingTop: "10px", borderTop: "1px solid #efece4", fontSize: "11.5px", color: "#6f7377"}}>
              {V.lbH2hNote}
            </div>
          </section>
          <section style={{padding: "16px", display: "flex", flexDirection: "column", flex: "1", minHeight: "0", overflow: "hidden", background: "#fdfcfa", border: "1px solid #e6e3da", borderRadius: "16px", boxShadow: "0 1px 3px rgba(28,29,31,.06)"}}>
            <div style={{fontWeight: "800", fontSize: "15px", letterSpacing: "-0.01em"}}>
              Title Holders
            </div>
            <div style={{fontSize: "10px", color: "#9b9e96", fontWeight: "600", margin: "2px 0 12px"}}>
              Stealable · one holder at a time
            </div>
            <div style={{display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto", minHeight: "0"}}>
              {(V.lbTitles || []).map((t, t__i) => (
                <React.Fragment key={t__i}>
                <div style={{display: "flex", alignItems: "center", gap: "10px"}}>
                  <span role="img" title={t.name} style={{width: "32px", height: "32px", borderRadius: "50%", flexShrink: "0", background: `var(--ink-deep, #1c1d1f) url(${t.img}) center/cover no-repeat`, boxShadow: "0 2px 6px rgba(28,29,31,.2)"}}></span>
                  <span style={{display: "flex", flexDirection: "column", minWidth: "0", flex: "1"}}>
                    <span style={{fontWeight: "700", fontSize: "13px"}}>
                      {t.name}
                    </span>
                    <span style={{fontSize: "10px", color: "#9b9e96", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {t.desc}
                    </span>
                  </span>
                  {t.avatar || t.holder !== 'Vacant' ? <Face name={t.holder} src={t.avatar} size={26} /> : <span style={{width: "26px", height: "26px", borderRadius: "50%", background: "#efece4", flexShrink: "0"}}></span>}
                  <span title={t.valueLabel} style={{fontSize: "12px", fontWeight: "700", color: "#6f7377", whiteSpace: "nowrap"}}>
                    {t.holder}
                  </span>
                </div>
                </React.Fragment>
              ))}
            </div>
          </section>
        </aside>
      </div>
      {(V.lbBadgesOpen) ? (
        <>
        <div onClick={V.toggleBadges} style={{position: "absolute", inset: "0", zIndex: "40", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", background: "rgba(28,29,31,.45)"}}>
          <div onClick={V.stop} style={{width: "min(760px,100%)", maxHeight: "86vh", display: "flex", flexDirection: "column", padding: "20px", background: "#fdfcfa", border: "1px solid #e6e3da", borderRadius: "16px", boxShadow: "0 12px 30px rgba(28,29,31,.14)"}}>
            <div style={{display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "14px"}}>
              <div>
                <div style={{fontWeight: "800", fontSize: "15px"}}>
                  Badges
                </div>
                <div style={{marginTop: "4px", fontSize: "12px", fontWeight: "500", color: "#9b9e96", lineHeight: "1.4"}}>
                  Prestige and earned badges are computed from the selected period. Hall-of-shame badges show only here, never on the board.
                </div>
              </div>
              <button onClick={V.toggleBadges} style={{width: "36px", height: "36px", borderRadius: "10px", border: "1px solid #ddd9ce", background: "#fdfcfa", color: "#6f7377", cursor: "pointer", fontSize: "18px", lineHeight: "1"}}>
                ×
              </button>
            </div>
            <div style={{overflowY: "auto", display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "1fr 1fr", gap: "10px"}}>
              {(V.lbBadgeGallery || []).map((b, b__i) => (
                <React.Fragment key={b__i}>
                <div title={b.approximation} style={{display: "flex", alignItems: "center", gap: "12px", padding: "10px", borderRadius: "12px", border: "1px solid #e6e3da", background: b.held ? "#fff" : "#f7f5ee", opacity: b.held ? 1 : 0.7}}>
                  <span role="img" title={b.name} style={{width: "44px", height: "44px", borderRadius: "50%", flexShrink: "0", border: "1px solid #ddd9ce", boxShadow: "inset 0 1px 0 #fff,0 1px 3px rgba(28,29,31,.1)", background: `#eceae3 url(${b.img}) center/cover no-repeat`, filter: b.held ? "none" : "grayscale(1)"}}></span>
                  <span style={{display: "flex", flexDirection: "column", minWidth: "0", flex: "1"}}>
                    <span style={{fontWeight: "700", fontSize: "13px", display: "flex", alignItems: "center", gap: "6px"}}>
                      {b.name}
                      <span style={{fontSize: "9px", letterSpacing: ".1em", textTransform: "uppercase", color: b.tier === 'prestige' ? '#b45309' : b.tier === 'shame' ? '#b91c1c' : '#0e7a57', fontWeight: "800"}}>{b.tier}</span>
                    </span>
                    <span style={{fontSize: "11px", color: "#9b9e96"}}>{b.hint}</span>
                  </span>
                  <span style={{display: "flex", gap: "4px", flexShrink: "0"}}>
                    {b.holders.length === 0 ? <span style={{fontSize: "11px", color: "#9b9e96", fontWeight: "600"}}>Unclaimed</span> : b.holders.slice(0, 4).map((h, h__i) => (
                      <Face key={h__i} name={h.name} src={h.avatar} size={26} style={{border: "2px solid #fdfcfa", boxShadow: "0 1px 3px rgba(28,29,31,.2)"}} />
                    ))}
                  </span>
                </div>
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
        </>
      ) : null}
      {(V.lbPointsOpen) ? (
        <>
        <div onClick={V.togglePoints} style={{position: "absolute", inset: "0", zIndex: "40", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", background: "rgba(28,29,31,.45)"}}>
          <div onClick={V.stop} style={{width: "min(440px,100%)", display: "flex", flexDirection: "column", padding: "20px", background: "#fdfcfa", border: "1px solid #e6e3da", borderRadius: "16px", boxShadow: "0 12px 30px rgba(28,29,31,.14)"}}>
            <div style={{display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "14px"}}>
              <div>
                <div style={{fontWeight: "800", fontSize: "15px"}}>
                  How Points Work
                </div>
                <div style={{marginTop: "4px", fontSize: "12px", fontWeight: "500", color: "#9b9e96", lineHeight: "1.4"}}>
                  Every activity earns points. The Points sort ranks reps by their total for the selected period.
                </div>
              </div>
              <button onClick={V.togglePoints} style={{width: "36px", height: "36px", borderRadius: "10px", border: "1px solid #ddd9ce", background: "#fdfcfa", color: "#6f7377", cursor: "pointer", fontSize: "18px", lineHeight: "1"}}>
                ×
              </button>
            </div>
            {(V.lbPointsRows || []).map((r, r__i) => (
              <React.Fragment key={r__i}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "9px 0", borderBottom: "1px solid #efece4"}}>
                <span style={{display: "flex", flexDirection: "column", gap: "1px"}}>
                  <span style={{fontWeight: "700", fontSize: "14px"}}>
                    {r.label}
                  </span>
                  <span style={{fontSize: "11px", color: "#9b9e96", fontWeight: "500"}}>
                    {r.detail}
                  </span>
                </span>
                <span style={{fontWeight: "800", fontSize: "16px", whiteSpace: "nowrap"}}>
                  {r.value}
                  <span style={{fontSize: "9px", fontWeight: "700", letterSpacing: ".1em", color: "#9b9e96"}}>
                    PTS
                  </span>
                </span>
              </div>
              </React.Fragment>
            ))}
          </div>
        </div>
        </>
      ) : null}
    </section>
  );
}
