// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { Empty } from '@/components/ds/Empty';
import { Chevron, CZ } from '@/components/ds/chrome';
import type { ClozrView } from '@/app/clozr/view';
import { Mark } from '@/components/ds/mark';
import { ScreenHeader } from '@/components/ds/Screen';
import { Button, IconButton } from '@/components/ds/Button';
import { Badge } from '@/components/ds/Text';
import { textTone } from '@/lib/text-tone';
import { Check, Clock, Phone, Users } from 'lucide-react';

const none = (text: string) => (
  <div style={{padding: "18px 16px", fontSize: "12.5px", color: "var(--meta, #71717a)"}}>{text}</div>
);

export function Home({ V }: { V: ClozrView }) {
  return (
    <section data-screen-label="Home" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
      <ScreenHeader title={<>{V.greeting}{V.meName ? ', ' + V.meName : ''}</>} titleTitle={`${V.greeting}${V.meName ? ', ' + V.meName : ''}`} meta={V.todayLabel} actions={<>
          {/* Owners and admins only: it scopes the tiles and the queue below. */}
          {V.canScopeHome ? (
          <div style={{position: "relative"}}>
            <Button className="cz-menu-trigger" onClick={V.toggleTeamMenu} aria-expanded={!!V.teamMenuOpen} icon={<Users size={14} aria-hidden />} iconRight={<Chevron size={12} color={CZ.muted} />}>
              {V.teamView}
            </Button>
            {(V.teamMenuOpen) ? (
              <>
              <div ref={keepInView} style={{position: "absolute", top: "38px", right: "0", width: "200px", background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "10px", boxShadow: "var(--shadow-md)", padding: "5px", zIndex: "30"}}>
                {(V.teamOptions || []).map((o, o__i) => (
                  <React.Fragment key={o__i}>
                  <button className="dc2" onClick={o.go} style={{display: "block", width: "100%", textAlign: "left", height: "32px", padding: "0 10px", border: "0", borderRadius: "7px", background: "none", cursor: "pointer", fontSize: "13px", color: "var(--ink, #18181b)"}}>
                    {o.label}
                  </button>
                  </React.Fragment>
                ))}
              </div>
              </>
            ) : null}
          </div>
          ) : null}
          <Button kind="primary" onClick={V.openCallQueue} icon={<Phone size={14} aria-hidden />} style={{flex: V.isMobile ? "1" : "none"}}>
            Start call queue
            <span style={{fontSize: "11.5px", fontWeight: 500, opacity: ".85", fontVariantNumeric: "tabular-nums"}}>
              {V.callQueueCount}
            </span>
          </Button>
      </>}>
        {V.todayAiGreeting ? <p className="ds-prose" style={{margin: 0, fontSize: "13px", color: "var(--muted, #52525b)"}}>{V.todayAiGreeting}</p> : null}
      </ScreenHeader>
      <div style={{flex: "1", minHeight: "0", overflow: "auto", padding: "var(--gutter) var(--gutter) 40px"}}>
      {(V.workspaceEmpty || !V.crmOk) ? (
        <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", boxShadow: "0 1px 2px rgba(0,0,0,.03)"}}>
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
      <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr 1fr" : "repeat(8,minmax(0,1fr))", background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,.03)"}}>
        {(V.homeStats || []).map((s, s__i) => (
          <React.Fragment key={s__i}>
          <div style={{padding: V.isMobile ? "12px 13px" : "14px 16px", borderRight: "1px solid var(--divider-2, #f0f0f1)", borderBottom: V.isMobile ? "1px solid var(--divider-2, #f0f0f1)" : "0"}}>
            {/* Labels name their period ("… this month"), so they may wrap rather than run into the next tile. */}
            <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "500", whiteSpace: "normal"}}>
              {s.k}
            </div>
            <div style={{fontSize: "var(--fs-figure)", fontWeight: "650", letterSpacing: "-0.02em", marginTop: "6px", color: "var(--ink, #18181b)", fontVariantNumeric: "tabular-nums"}}>
              {s.v}
            </div>
            <div style={{fontSize: "11.5px", marginTop: "2px", color: textTone(s.dColor)}}>
              {s.d}
            </div>
          </div>
          </React.Fragment>
        ))}
      </div>
      <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "minmax(0,1.7fr) minmax(300px,0.9fr)", gap: "16px", marginTop: "16px", alignItems: "start"}}>
        <div style={{display: "flex", flexDirection: "column", gap: "16px", minWidth: "0"}}>
          <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: V.isMobile ? "wrap" : "nowrap", padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
              <div style={{display: "flex", alignItems: "baseline", gap: "10px", minWidth: "0", flex: "1 1 auto"}}>
                <span className="t-title" style={{flex: "none"}}>
                  {V.homeQueueTitle}
                </span>
                <span style={{fontSize: "12px", color: "var(--meta, #71717a)", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                  {V.queueCount} items · ordered by urgency
                </span>
              </div>
              <div style={{display: "flex", gap: "6px", flex: "none"}}>
                <Button size={28} onClick={V.goTasks}>All tasks</Button>
                <Button size={28} onClick={V.can.today ? V.goToday : V.openCallQueue} iconRight={<Chevron dir="right" size={12} color="currentColor" />}>
                  Work queue
                </Button>
              </div>
            </div>
            {(V.queue || []).map((q) => (
              <React.Fragment key={q.id}>
              {/* Three columns at 92px + text + five buttons needs ~560px. On a
                  phone that left the middle column about 90px wide, so the
                  title broke one word per line and the last buttons were
                  clipped off the card. The phone stacks it instead. */}
              <div className="dc4" style={V.isMobile
                ? {display: "flex", flexDirection: "column", gap: "9px", alignItems: "stretch", padding: "12px 14px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", minWidth: "0"}
                : {display: "grid", gridTemplateColumns: "92px minmax(0,1fr) auto", gap: "14px", alignItems: "center", padding: "11px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", transition: "background .12s"}}>
                <span style={{display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "11.5px", fontWeight: "650", color: textTone(q.color), whiteSpace: "nowrap"}}>
                  <Mark label={q.tag} />
                  {q.tag}
                </span>
                <div style={{minWidth: "0"}}>
                  <div style={{display: "flex", alignItems: "baseline", gap: "8px", flexWrap: V.isMobile ? "wrap" : "nowrap", minWidth: "0"}}>
                    <button className="dc5 t-name" onClick={q.open} style={{ background: "none", border: "0", padding: "0", cursor: "pointer", textAlign: "left", minWidth: "0", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {q.title}
                    </button>
                    <span style={{fontSize: "12px", color: "var(--meta, #71717a)", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {q.sub}
                    </span>
                  </div>
                  <div style={{fontSize: "12px", color: "var(--meta, #71717a)", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: V.isMobile ? "normal" : "nowrap"}}>
                    {q.meta}
                  </div>
                </div>
                <div style={{display: "flex", gap: "6px", minWidth: "0"}}>
                  {/* Call and Text are ordinary actions: ghost, not Talkr red (red means destructive). */}
                  <Button size={28} onClick={q.call} style={V.isMobile ? {flex: "1", minWidth: "0"} : undefined}>Call</Button>
                  <Button size={28} onClick={q.text} style={V.isMobile ? {flex: "1", minWidth: "0"} : undefined}>Text</Button>
                  <Button size={28} onClick={q.open} style={V.isMobile ? {flex: "1", minWidth: "0"} : undefined}>Open</Button>
                  <IconButton kind="ghost" size={28} label="Complete" onClick={q.complete} icon={<Check size={14} strokeWidth={2.4} aria-hidden />} style={{color: "var(--tx-green-deep, #1f7a4d)"}} />
                  <IconButton kind="ghost" size={28} label={q.snoozeLabel || 'Snooze'} onClick={q.snooze} icon={<Clock size={14} aria-hidden />} />
                </div>
              </div>
              </React.Fragment>
            ))}
            {V.queueCount === 0 ? (
              <div style={{padding: "28px 16px", textAlign: "center", fontSize: "13px", color: "var(--meta, #71717a)"}}>
                Queue clear — nothing waiting on you right now.
              </div>
            ) : null}
          </div>
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "1fr 1fr", gap: V.isMobile ? "12px" : "16px", minWidth: "0"}}>
            <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
                <span className="t-title">
                  Recent inbound
                </span>
                {V.can.inbox ? (
                <button onClick={V.goInbox} style={{display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "var(--tx-mint, #0a8560)", background: "none", border: "0", cursor: "pointer", fontWeight: "500"}}>
                  Open inbox <Chevron dir="right" size={12} color="currentColor" />
                </button>
                ) : null}
              </div>
              {(V.homeInbound || []).map((m, m__i) => (
                <React.Fragment key={m__i}>
                <button className="dc4" onClick={m.open} style={{display: "grid", gridTemplateColumns: "30px minmax(0,1fr) auto", gap: "10px", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 16px", border: "0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", background: "none", cursor: "pointer"}}>
                  <span style={{width: "30px", height: "30px", borderRadius: "8px", background: "var(--surface-2, #f4f4f5)", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: "700", color: "var(--muted, #52525b)"}}>
                    {m.initials}
                  </span>
                  <span style={{minWidth: "0"}}>
                    <span style={{display: "flex", gap: "6px", alignItems: "baseline"}}>
                      <span className="t-name">
                        {m.name}
                      </span>
                      <span style={{fontSize: "11.5px", color: "var(--meta, #71717a)"}}>
                        {/sms/i.test(m.channel) ? 'SMS' : m.channel.charAt(0).toUpperCase() + m.channel.slice(1).toLowerCase()}
                      </span>
                    </span>
                    <span style={{display: "block", fontSize: "12px", color: "var(--meta, #71717a)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>
                      {m.preview}
                    </span>
                  </span>
                  <span style={{fontSize: "11.5px", color: "var(--meta, #71717a)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums"}}>
                    {m.time}
                  </span>
                </button>
                </React.Fragment>
              ))}
              {V.homeInbound.length ? null : none("Nothing inbound yet.")}
            </div>
            <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
                <span className="t-title">
                  Upcoming closings
                </span>
                <span style={{fontSize: "12px", color: "var(--meta, #71717a)"}}>
                  {V.closingsTotal} with a close date
                </span>
              </div>
              {(V.homeClosings || []).map((c, c__i) => (
                <React.Fragment key={c__i}>
                <button className="dc4" onClick={c.open} style={{display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: "12px", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 16px", border: "0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", background: "none", cursor: "pointer"}}>
                  <span style={{minWidth: "0"}}>
                    <span className="t-name" style={{display: "block"}}>
                      {c.addr}
                    </span>
                    <span style={{display: "block", fontSize: "12px", color: "var(--meta, #71717a)"}}>
                      {c.sub}
                    </span>
                  </span>
                  <span style={{fontSize: "13px", fontWeight: "600", color: "var(--ink, #18181b)"}}>
                    {c.fee}
                  </span>
                  <span style={{fontSize: "12px", color: textTone(c.color), fontWeight: "600", whiteSpace: "nowrap"}}>
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
            <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
                <span className="t-title">
                  CLOZR AI alerts
                </span>
                <span style={{fontSize: "12px", color: "var(--meta, #71717a)", fontVariantNumeric: "tabular-nums"}}>
                  {V.aiAlerts.length} new
                </span>
              </div>
              {(V.aiAlerts || []).map((a, a__i) => (
                <React.Fragment key={a__i}>
                <div style={{padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
                  <div style={{fontSize: "13px", lineHeight: "1.45", color: "var(--ink-2, #27272a)"}}>
                    {a.text}
                  </div>
                  <div style={{display: "flex", gap: "6px", marginTop: "8px"}}>
                    <Button kind="solid" size={28} onClick={a.go}>{a.cta}</Button>
                    <Button size={28} onClick={a.dismiss}>Dismiss</Button>
                  </div>
                </div>
                </React.Fragment>
              ))}
            </div>
            </>
          ) : null}
          <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
              <span className="t-title">
                At-risk deals
              </span>
              <button onClick={V.goDeals} style={{display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "var(--tx-mint, #0a8560)", background: "none", border: "0", cursor: "pointer", fontWeight: "500"}}>
                Pipeline <Chevron dir="right" size={12} color="currentColor" />
              </button>
            </div>
            {(V.atRisk || []).map((r, r__i) => (
              <React.Fragment key={r__i}>
              <button className="dc4" onClick={r.open} style={{display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "10px", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 16px", border: "0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", background: "none", cursor: "pointer"}}>
                <span style={{minWidth: "0"}}>
                  <span style={{display: "block", fontWeight: "600", fontSize: "13px", color: "var(--ink, #18181b)"}}>
                    {r.addr}
                  </span>
                  <span style={{display: "block", fontSize: "12px", color: "var(--meta, #71717a)"}}>
                    {r.reason}
                  </span>
                </span>
                <Badge style={{flex: "none"}}>
                  <span style={{display: "inline-flex", color: r.color}}><Mark label={r.stage} size={12} /></span>
                  {r.stage}
                </Badge>
              </button>
              </React.Fragment>
            ))}
            {V.atRisk.length ? null : none("No deals at risk.")}
          </div>
          <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
              <span className="t-title">
                Recent contracts
              </span>
              <span style={{fontSize: "12px", color: "var(--meta, #71717a)"}}>
                latest
              </span>
            </div>
            {(V.recentContracts || []).map((r, r__i) => (
              <React.Fragment key={r__i}>
              <button className="dc4" onClick={r.open} style={{display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "10px", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 16px", border: "0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", background: "none", cursor: "pointer"}}>
                <span style={{minWidth: "0"}}>
                  <span style={{display: "block", fontWeight: "600", fontSize: "13px", color: "var(--ink, #18181b)"}}>
                    {r.addr}
                  </span>
                  <span style={{display: "block", fontSize: "12px", color: "var(--meta, #71717a)"}}>
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
          <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
            <div className="t-title" style={{padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
              Team activity
            </div>
            {(V.teamFeed || []).map((f, f__i) => (
              <React.Fragment key={f__i}>
              <div style={{display: "grid", gridTemplateColumns: "26px minmax(0,1fr) auto", gap: "10px", alignItems: "start", padding: "9px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
                <span style={{width: "26px", height: "26px", borderRadius: "7px", background: "var(--mint-dim, #e7f8f1)", color: "var(--tx-mint, #0a8560)", display: "grid", placeItems: "center", fontSize: "10.5px", fontWeight: "700"}}>
                  {f.initials}
                </span>
                <span style={{fontSize: "12.5px", color: "var(--ink-2, #27272a)", lineHeight: "1.4"}}>
                  <b style={{fontWeight: "600"}}>
                    {f.who}
                  </b>
                  {f.text}
                </span>
                <span style={{fontSize: "11.5px", color: "var(--meta, #71717a)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums"}}>
                  {f.time}
                </span>
              </div>
              </React.Fragment>
            ))}
          </div>
          ) : null}
        </div>
      </div>
      </div>
    </section>
  );
}
