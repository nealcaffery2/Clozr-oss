// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ReportBlocks } from '@/app/components/reporting/ReportBlocks';
import { BankPanel } from '@/app/components/reporting/BankPanel';
import { CustomReports } from '@/app/components/reporting/custom/CustomReports';
import { SkeletonRows } from '@/components/ds/Skeleton';
import { AI_AGENTS_TAB, AI_SALES_TAB, CUSTOM_TAB, TEAM_STOPLIGHT_TAB } from '@/lib/reporting';
import { SalesManager } from '@/app/components/coaching/SalesManager';
import { AiAgentsReport } from '@/app/components/reporting/AiAgentsReport';
import { TeamStoplight } from '@/app/components/reporting/TeamStoplight';
import { holdReporting } from '@/lib/use-crm';

export function Reporting({ V }: { V: ClozrView }) {
  React.useEffect(() => holdReporting(), []);
  // Both draw themselves with their own ranges, so the shared range buttons and Export are not theirs.
  const ai = V.reportTab === AI_AGENTS_TAB;
  const sales = V.reportTab === AI_SALES_TAB;
  const stoplight = V.reportTab === TEAM_STOPLIGHT_TAB;
  const custom = V.reportTab === CUSTOM_TAB || ai || sales || stoplight;
  return (
    <section data-screen-label="Reporting" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
      <div style={{background: "#fff", borderBottom: "1px solid #e4e4e7", padding: "12px 20px 0"}}>
        <div data-head style={{display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", rowGap: "8px"}}>
          <h1 style={{margin: "0", fontSize: "16px", fontWeight: "700", letterSpacing: "-0.02em"}}>
            Reporting
          </h1>
          <span style={{fontSize: "12px", color: "#71717a"}}>
            {V.workspaceName} · {V.reportTab}{custom ? '' : ' · ' + V.reportRange}
          </span>
          <div style={{flex: "1"}}></div>
          {custom ? null : <div style={{display: "flex", gap: "4px", overflowX: "auto", maxWidth: "100%"}}>
            {(V.reportRanges || []).map((r, r__i) => (
              <React.Fragment key={r__i}>
              <button onClick={r.go} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid #e4e4e7", fontSize: "12px", fontWeight: "500", cursor: "pointer", background: r.bg, color: r.color}}>
                {r.label}
              </button>
              </React.Fragment>
            ))}
          </div>}
          {custom ? null : <button className="dc2" onClick={V.exportReport} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", cursor: "pointer", marginLeft: "6px"}}>
          Export
          </button>}
          {V.canSeeLeaderboard ? <button className="dc10" onClick={V.goLeaderboard} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12px", fontWeight: "600", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px"}}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            TV leaderboard
          </button> : null}
        </div>
        <div data-tabs style={{display: "flex", gap: "2px", marginTop: "10px", overflow: "auto"}}>
          {(V.reportTabs || []).map((t, t__i) => (
            <React.Fragment key={t__i}>
            <button className="dc12" onClick={t.go} style={{height: "36px", padding: "0 11px", border: "0", borderBottom: `2px solid ${t.border}`, background: "none", cursor: "pointer", fontSize: "13px", fontWeight: "500", color: t.color, whiteSpace: "nowrap"}}>
              {t.label}
            </button>
            </React.Fragment>
          ))}
        </div>
      </div>
      {sales ? (
        <div style={{flex: "1", minHeight: "0", overflow: "auto", padding: V.isMobile ? "12px 12px 40px" : "16px 20px 40px"}}>
          <SalesManager workspaceId={V.liveIds?.workspaceId ?? null} me={V.liveIds?.userId ?? null} admin={!!V.reportAdmin} isMobile={V.isMobile} toast={V.showToast} />
        </div>
      ) : stoplight ? (
        <div style={{flex: "1", minHeight: "0", overflow: "auto", padding: V.isMobile ? "12px 12px 40px" : "16px 20px 40px"}}>
          <TeamStoplight workspaceId={V.liveIds?.workspaceId ?? null} isMobile={V.isMobile} />
        </div>
      ) : ai ? (
        <div style={{flex: "1", minHeight: "0", overflow: "auto", padding: V.isMobile ? "12px 12px 40px" : "16px 20px 40px"}}>
          <AiAgentsReport workspaceId={V.liveIds?.workspaceId ?? null} isMobile={V.isMobile} />
        </div>
      ) : custom ? (
        <div style={{flex: "1", minHeight: "0", display: "flex", flexDirection: "column"}}>
          <CustomReports raw={V.reportRaw} workspaceId={V.liveIds?.workspaceId ?? null} workspaceName={V.workspaceName} admin={V.reportAdmin} isMobile={V.isMobile} toast={V.showToast} />
        </div>
      ) : (
      <div style={{flex: "1", minHeight: "0", overflow: "auto", padding: V.isMobile ? "12px 12px 40px" : "16px 20px 40px"}}>
        {V.reportHasData ? (
          <ReportBlocks
            key={V.reportTab}
            blocks={V.reportBlocks}
            isMobile={V.isMobile}
            bank={V.reportAdmin && V.reportRaw ? <BankPanel workspaceId={V.liveIds?.workspaceId ?? null} range={V.reportRangeBounds} raw={V.reportRaw} /> : null}
          />
        ) : (
          <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", padding: "8px 8px", fontSize: "12.5px", color: "#71717a"}}>
            {V.crmOk ? <SkeletonRows count={5} label="Loading the report" /> : "Could not read the workspace, so there is nothing to report on. Reload to try again."}
          </div>
        )}
      </div>
      )}
    </section>
  );
}
