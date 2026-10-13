'use client';

// The record's closing file: the deal's TC checklist, commitment, earnest
// money, deadlines and the HUD review — the old TC tab, now reached from
// More › Closing file. A role that cannot open the TC screen sees it here
// read-only: nothing to tick, mark or sign.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { LaneHeard } from '@/components/LaneHeard';
import { Mark } from '@/components/ds/mark';

export function TcFile({ V, readOnly }: { V: ClozrView; readOnly: boolean }) {
  return (
    <div data-testid="record-tc-file" data-readonly={readOnly || undefined}>
      {readOnly ? (
        <div style={{ marginBottom: '10px', padding: '8px 12px', borderRadius: '8px', background: '#fafafa', border: '1px solid #e4e4e7', fontSize: '12px', color: '#52525b' }}>
          Read-only. The TC works this file; ask them to change anything here.
        </div>
      ) : null}
    <div data-head style={{display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px"}}>
      <span style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
        Transaction coordination
      </span>
      <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>
        escrow {V.txCommitment.escrow} · {V.txCommitment.titleCo}
      </span>
      <div style={{flex: "1"}}></div>
      <button className="clozr-lane-btn" onClick={() => V.openLane(V.dealSheetFor.personId)} style={{height: "30px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-lane)", background: "var(--c-lane)", color: "#fff", fontSize: "12px", fontWeight: "600", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px"}}>
        <span aria-hidden style={{fontSize: "12px", lineHeight: "1"}}>✦</span>
        Ask Lane
      </button>
    </div>
    {V.personTcFile ? (
      <LaneHeard transactionId={V.personTcFile.txId} workspaceId={V.personTcFile.workspaceId} me={V.personTcFile.me} canWrite={!readOnly && V.personTcFile.canWrite}
        onChanged={V.reloadCrm} onToast={V.showToast} />
    ) : null}
    <div style={{display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "10px"}}>
      <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "10px", padding: "11px 13px"}}>
        <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
          Commitment
        </div>
        <div style={{display: "inline-flex", alignItems: "center", gap: "6px", marginTop: "6px", fontSize: "12px", fontWeight: "700", letterSpacing: ".04em", textTransform: "uppercase", color: V.txCommitment.color}}>
          <Mark label={V.txCommitment.status} />
          {V.txCommitment.status}
        </div>
        <div style={{fontSize: "11px", color: "#a1a1aa", marginTop: "3px"}}>
          received {V.txCommitment.received}
        </div>
      </div>
      <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "10px", padding: "11px 13px"}}>
        <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
          Cure items
        </div>
        <div style={{fontSize: "20px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "3px", color: V.txOpenExceptions ? "#d97706" : "#16a34a"}}>
          {V.txOpenExceptions}
        </div>
        <div style={{fontSize: "11px", color: "#a1a1aa"}}>
          open on the commitment
        </div>
      </div>
      <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "10px", padding: "11px 13px"}}>
        <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
          Docs out
        </div>
        <div style={{fontSize: "20px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "3px", color: V.txDocsOutstanding ? "#d97706" : "#16a34a"}}>
          {V.txDocsOutstanding}
        </div>
        <div style={{fontSize: "11px", color: "#a1a1aa"}}>
          awaiting signature or receipt
        </div>
      </div>
      <div style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "10px", padding: "11px 13px"}}>
        <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
          Closing
        </div>
        <div style={{fontSize: "20px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "3px"}}>
          {V.txCommitment.closing}
        </div>
        <div style={{fontSize: "11px", color: "#a1a1aa"}}>
          opened {V.txCommitment.opened}
        </div>
      </div>
    </div>
    <div id="tc-next" style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", scrollMarginTop: "14px", overflow: "hidden", marginTop: "12px"}}>
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderBottom: "1px solid #f0f0f1"}}>
        <span style={{fontWeight: "600", fontSize: "14px"}}>
          Who owes what next
        </span>
        <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>
          {V.txCritical} critical
        </span>
      </div>
      {(V.txNextActions || []).map((n, n__i) => (
        <React.Fragment key={n__i}>
        <div style={{display: "grid", gridTemplateColumns: "28px minmax(0,1fr) auto", gap: "10px", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #f0f0f1"}}>
          <span style={{width: "28px", height: "28px", borderRadius: "7px", background: "#f4f4f5", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "700", color: "#52525b"}}>
            {n.initials}
          </span>
          <span style={{minWidth: "0"}}>
            <span style={{display: "flex", alignItems: "center", gap: "8px"}}>
              <span style={{fontWeight: "600", fontSize: "12.5px"}}>
                {n.who}
              </span>
              <span style={{fontSize: "10px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: n.color}}>
                {n.role}
              </span>
            </span>
            <span style={{display: "block", fontSize: "12.5px", color: "#27272a", marginTop: "1px", lineHeight: "1.45"}}>
              {n.what}
            </span>
          </span>
          <span style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "22px", padding: "0 8px", borderRadius: "6px", background: n.bg, color: n.color, fontSize: "11px", fontWeight: "700", whiteSpace: "nowrap"}}>
            {n.due}
          </span>
        </div>
        </React.Fragment>
      ))}
      {V.txNextActions.length ? null : <div style={{padding: "14px 16px", fontSize: "12.5px", color: "#a1a1aa"}}>Nothing outstanding on the drive.</div>}
    </div>
    <div id="tc-documents" style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", scrollMarginTop: "14px", overflow: "hidden", marginTop: "12px"}}>
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderBottom: "1px solid #f0f0f1"}}>
        <span style={{fontWeight: "600", fontSize: "14px"}}>Documents</span>
        <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>{V.txDocsOutstanding} outstanding</span>
      </div>
      {(V.txDocuments || []).map((d, d__i) => (
        <React.Fragment key={d__i}>
        <div style={{display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: "10px", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #f0f0f1"}}>
          <span style={{fontSize: "12.5px", fontWeight: "500", color: "#18181b"}}>{d.k}</span>
          <span style={{fontSize: "11px", color: "#a1a1aa"}}>{d.owner} · {d.due}</span>
          <span style={{display: "inline-flex", alignItems: "center", height: "22px", padding: "0 8px", borderRadius: "6px", background: d.bg, color: d.color, fontSize: "10.5px", fontWeight: "700", letterSpacing: ".06em", textTransform: "uppercase"}}>{d.status}</span>
        </div>
        </React.Fragment>
      ))}
      {V.txDocuments.length ? null : <div style={{padding: "14px 16px", fontSize: "12.5px", color: "#a1a1aa"}}>No contracts on this deal yet.</div>}
    </div>
    <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "minmax(0,1fr) minmax(0,1fr)", gap: "12px", marginTop: "12px", alignItems: "start"}}>
      <div id="tc-commitment" style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", scrollMarginTop: "14px", overflow: "hidden"}}>
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderBottom: "1px solid #f0f0f1"}}>
          <span style={{fontWeight: "600", fontSize: "14px"}}>
            Title commitment
          </span>
          <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>
            effective {V.txCommitment.effective}
          </span>
        </div>
        {(V.txExceptions || []).map((e, e__i) => (
          <React.Fragment key={e__i}>
          <div style={{padding: "11px 16px", borderBottom: "1px solid #f0f0f1"}}>
            <div style={{display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap"}}>
              <span style={{fontSize: "12px", fontWeight: "700", color: "#18181b"}}>
                {e.ref}
              </span>
              <span style={{fontSize: "11px", color: "#71717a"}}>
                {e.kind}
              </span>
              <span style={{flex: "1"}}></span>
              <span style={{display: "inline-flex", alignItems: "center", gap: "5px", height: "20px", padding: "0 7px", borderRadius: "6px", background: e.bg, color: e.color, fontSize: "10px", fontWeight: "700", letterSpacing: ".06em", textTransform: "uppercase"}}>
                {e.label}
              </span>
            </div>
            <div style={{fontSize: "12.5px", color: "#27272a", marginTop: "4px", lineHeight: "1.5"}}>
              {e.text}
            </div>
            <div style={{fontSize: "11px", color: "#a1a1aa", marginTop: "4px"}}>
              {e.owner} · {e.status} · due {e.due}
            </div>
          </div>
          </React.Fragment>
        ))}
        {V.txExceptions.length ? null : <div style={{padding: "14px 16px", fontSize: "12.5px", color: "#a1a1aa"}}>No exceptions on the commitment yet. Tick prelim commitment on the checklist when title sends it.</div>}
      </div>
      <div style={{display: "flex", flexDirection: "column", gap: "12px"}}>
        <div id="tc-earnest" style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", scrollMarginTop: "14px", overflow: "hidden"}}>
          <div style={{padding: "11px 16px", borderBottom: "1px solid #f0f0f1", fontWeight: "600", fontSize: "14px"}}>
            Earnest money
          </div>
          {(V.txEarnest || []).map((e, e__i) => (
            <React.Fragment key={e__i}>
            <div style={{display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "10px", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #f0f0f1"}}>
              <span style={{minWidth: "0"}}>
                <span style={{display: "flex", alignItems: "baseline", gap: "8px"}}>
                  <span style={{fontSize: "16px", fontWeight: "700", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums"}}>
                    {e.amount}
                  </span>
                  <span style={{fontSize: "12px", color: "#52525b"}}>
                    {e.party}
                  </span>
                </span>
                <span style={{display: "block", fontSize: "11px", color: "#a1a1aa", marginTop: "1px"}}>
                  {e.holder} · due {e.due} · received {e.received}
                </span>
              </span>
              <span style={{display: "flex", alignItems: "center", gap: "8px"}}>
                <span style={{display: "inline-flex", alignItems: "center", height: "22px", padding: "0 8px", borderRadius: "6px", background: e.bg, color: e.color, fontSize: "10.5px", fontWeight: "700", letterSpacing: ".06em", textTransform: "uppercase", whiteSpace: "nowrap"}}>
                  {e.status}
                </span>
                {e.canMark && !readOnly ? (
                  <button className="dc2" onClick={e.mark} style={{height: "22px", padding: "0 8px", borderRadius: "6px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11px", fontWeight: "600", cursor: "pointer", color: "#18181b"}}>
                    Mark received
                  </button>
                ) : null}
              </span>
            </div>
            </React.Fragment>
          ))}
          {V.txEarnest.length ? null : (
            <div style={{padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px"}}>
              <span style={{fontSize: "12.5px", color: "#a1a1aa"}}>No EMD on the file yet.</span>
              {V.emdCanMark && !readOnly ? (
                <button className="dc2" onClick={V.markEmdReceived} style={{height: "26px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "600", cursor: "pointer", color: "#18181b"}}>
                  Mark received
                </button>
              ) : null}
            </div>
          )}
        </div>
        <div id="tc-deadlines" style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", scrollMarginTop: "14px", overflow: "hidden"}}>
          <div style={{padding: "11px 16px", borderBottom: "1px solid #f0f0f1", fontWeight: "600", fontSize: "14px"}}>
            Deadlines
          </div>
          {(V.txDeadlines || []).map((d, d__i) => (
            <React.Fragment key={d__i}>
            <div style={{display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: "10px", alignItems: "center", padding: "9px 16px", borderBottom: "1px solid #f0f0f1"}}>
              <span style={{minWidth: "0"}}>
                <span style={{display: "block", fontSize: "12.5px", fontWeight: "500", color: d.met ? "#a1a1aa" : "#18181b", textDecoration: d.met ? "line-through" : "none"}}>
                  {d.k}
                </span>
                {(d.hasNote) ? (
                  <>
                  <span style={{display: "block", fontSize: "11px", color: "#a1a1aa"}}>
                    {d.note}
                  </span>
                  </>
                ) : null}
              </span>
              <span style={{fontSize: "11.5px", color: "#71717a", whiteSpace: "nowrap"}}>
                {d.owner}
              </span>
              <span style={{display: "inline-flex", alignItems: "center", gap: "5px", height: "20px", padding: "0 7px", borderRadius: "6px", background: d.bg, color: d.color, fontSize: "10.5px", fontWeight: "700", whiteSpace: "nowrap"}}>
                {d.date}
              </span>
            </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
    <div id="tc-checklist" style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", scrollMarginTop: "14px", overflow: "hidden", marginTop: "12px"}}>
      <div style={{display: "flex", alignItems: "center", gap: "10px", padding: "11px 16px", borderBottom: "1px solid #f0f0f1", flexWrap: "wrap"}}>
        <span style={{fontWeight: "600", fontSize: "14px"}}>
          Contract-to-close checklist
        </span>
        <span style={{fontSize: "10px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "#0A8560"}}>
          {V.tcClLabel}
        </span>
        <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>
          {V.tcClFlow} · {V.tcClTarget}
        </span>
        <div style={{flex: "1"}}></div>
        <span style={{fontSize: "12px", color: "#52525b", fontVariantNumeric: "tabular-nums"}}>
          {V.tcClDoneCount} / {V.tcClTotal}
        </span>
        <span style={{width: "84px", height: "6px", borderRadius: "99px", background: "#f0f0f1", overflow: "hidden"}}>
          <span style={{display: "block", height: "100%", width: V.tcClPctS, borderRadius: "99px", background: "#16a34a"}}></span>
        </span>
      </div>
      <div style={{display: "flex", alignItems: "stretch", padding: "12px 16px", borderBottom: "1px solid #f0f0f1", background: "#fafafa"}}>
        {(V.tcMilestones || []).map((m, m__i) => (
          <React.Fragment key={m__i}>
          <div style={{flex: "1", display: "flex", flexDirection: "column", gap: "6px", minWidth: "0"}}>
            <div style={{display: "flex", alignItems: "center", gap: "0"}}>
              {(!m.first) ? (
                <>
                <span style={{flex: "1", height: "2px", background: m.bg}}></span>
                </>
              ) : null}
              <span style={{width: "9px", height: "9px", borderRadius: "999px", background: m.bg, flex: "none"}}></span>
              <span style={{flex: "1", height: "2px", background: "transparent"}}></span>
            </div>
            <div style={{minWidth: "0"}}>
              <div style={{fontSize: "10.5px", fontWeight: "700", letterSpacing: ".08em", color: m.color}}>
                {m.k}
              </div>
              <div style={{fontSize: "12px", fontWeight: "600", color: m.labelColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                {m.t}
              </div>
              <div style={{fontSize: "10.5px", color: "#a1a1aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                {m.sub}
              </div>
            </div>
          </div>
          </React.Fragment>
        ))}
      </div>
      {(V.tcChecklistPhases || []).map((ph, ph__i) => (
        <React.Fragment key={ph__i}>
        <div style={{display: "flex", alignItems: "center", gap: "8px", padding: "9px 16px", background: "#fafafa", borderBottom: "1px solid #f0f0f1", borderTop: ph__i ? "1px solid #f0f0f1" : "0"}}>
          <span style={{fontSize: "10.5px", fontWeight: "700", letterSpacing: ".1em", textTransform: "uppercase", color: "#52525b"}}>
            {ph.k}
          </span>
          {(ph.hasSub) ? (
            <>
            <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>
              {ph.sub}
            </span>
            </>
          ) : null}
          <div style={{flex: "1"}}></div>
          <span style={{fontSize: "11px", color: ph.complete ? "#16a34a" : "#a1a1aa", fontWeight: ph.complete ? "700" : "400", fontVariantNumeric: "tabular-nums"}}>
            {ph.done} / {ph.total}
          </span>
        </div>
        {(ph.tasks || []).map((t, t__i) => (
          <React.Fragment key={t__i}>
          <button className={readOnly ? undefined : "dc4"} onClick={readOnly ? undefined : t.toggle} disabled={readOnly} style={{display: "grid", gridTemplateColumns: "18px minmax(0,1fr) auto auto", gap: "10px", alignItems: "start", width: "100%", textAlign: "left", padding: "9px 16px", border: "0", borderBottom: "1px solid #f0f0f1", background: "none", cursor: readOnly ? "default" : "pointer", color: "inherit"}}>
            <span style={{width: "18px", height: "18px", borderRadius: "5px", display: "grid", placeItems: "center", background: t.box, border: `1.5px solid ${t.boxBorder}`, marginTop: "1px"}}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span style={{minWidth: "0"}}>
              <span style={{display: "block", fontSize: "12.5px", fontWeight: "500", color: t.textColor, textDecoration: t.deco, lineHeight: "1.45"}}>
                {t.t}
              </span>
              {(t.hasNote) ? (
                <span style={{display: "block", fontSize: "11px", color: "#a1a1aa", marginTop: "1px", lineHeight: "1.4"}}>
                  {t.note}
                </span>
              ) : null}
            </span>
            <span style={{fontSize: "11px", color: "#a1a1aa", whiteSpace: "nowrap", marginTop: "1px"}}>
              {t.owner}
            </span>
            <span style={{fontSize: "11px", fontWeight: "700", color: t.dayColor, whiteSpace: "nowrap", marginTop: "1px", minWidth: "52px", textAlign: "right"}}>
              {t.day}
            </span>
          </button>
          </React.Fragment>
        ))}
        </React.Fragment>
      ))}
    </div>
    <div id="tc-hud" style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", scrollMarginTop: "14px", overflow: "hidden", marginTop: "12px", marginBottom: "8px"}}>
      <div style={{display: "flex", alignItems: "center", gap: "10px", padding: "11px 16px", borderBottom: "1px solid #f0f0f1"}}>
        <span style={{fontWeight: "600", fontSize: "14px"}}>
          HUD / CD review
        </span>
        <span style={{fontSize: "10px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "#ff7a45"}}>
          T-2 before close
        </span>
        <div style={{flex: "1"}}></div>
        <span style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "22px", padding: "0 8px", borderRadius: "6px", background: V.tcHudClear ? "#f0fdf4" : "#fef2f2", color: V.tcHudClear ? "#16a34a" : "#dc2626", fontSize: "10.5px", fontWeight: "700", letterSpacing: ".06em", textTransform: "uppercase"}}>
          {V.tcHudDone} / {V.tcHudTotal} verified
        </span>
      </div>
      <div style={{padding: "9px 16px", borderBottom: "1px solid #f0f0f1", background: "#fffbeb", fontSize: "11.5px", color: "#92400e", lineHeight: "1.45"}}>
        No funding until every line is checked and an owner signs off. Catch surprise fees, missing reimbursements and wrong TC fee amounts here, not at the wire.
      </div>
      {(V.tcHudLines || []).map((h, h__i) => (
        <React.Fragment key={h__i}>
        <button className={readOnly ? undefined : "dc4"} onClick={readOnly ? undefined : h.toggle} disabled={readOnly} style={{display: "grid", gridTemplateColumns: "18px minmax(0,1fr) auto", gap: "10px", alignItems: "center", width: "100%", textAlign: "left", padding: "8px 16px", border: "0", borderBottom: "1px solid #f0f0f1", background: "none", cursor: "pointer"}}>
          <span style={{width: "18px", height: "18px", borderRadius: "5px", display: "grid", placeItems: "center", background: h.box, border: `1.5px solid ${h.boxBorder}`}}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
          <span style={{fontSize: "12.5px", fontWeight: "500", color: h.textColor, lineHeight: "1.45"}}>
            {h.k}
          </span>
          <span style={{fontSize: "12px", color: "#d4d4d8"}}>
            $
          </span>
        </button>
        </React.Fragment>
      ))}
      <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "1fr 1fr", gap: "10px", padding: "12px 16px"}}>
        <div>
          <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
            TC review
          </div>
          <div style={{fontSize: "12.5px", fontWeight: "600", marginTop: "3px", color: V.tcReview === 'Not reviewed' ? "#a1a1aa" : "#18181b"}}>
            {V.tcReview}
          </div>
          {V.hasTx && !readOnly ? (
            <button className="dc2" onClick={V.markTcReview} style={{height: "26px", marginTop: "8px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "600", cursor: "pointer", color: "#18181b"}}>
              {V.tcReview === 'Not reviewed' ? 'Mark reviewed' : 'Update review'}
            </button>
          ) : null}
        </div>
        <div>
          <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
            Owner sign-off
          </div>
          <div style={{fontSize: "12.5px", fontWeight: "600", marginTop: "3px", color: V.tcSignoffClear ? "#16a34a" : "#dc2626"}}>
            {V.tcSignoff}
          </div>
          {V.hasTx && !readOnly ? (
            <button className={V.canSignoff ? "dc2" : undefined} onClick={V.markTcSignoff} disabled={!V.canSignoff} style={{height: "26px", marginTop: "8px", padding: "0 10px", borderRadius: "7px", border: "1px solid #e4e4e7", background: !V.canSignoff ? "#fafafa" : V.tcSignoffClear ? "#fff" : "#18181b", fontSize: "12px", fontWeight: "600", cursor: V.canSignoff ? "pointer" : "not-allowed", color: !V.canSignoff ? "#52525b" : V.tcSignoffClear ? "#18181b" : "#fff"}}>
              {!V.canSignoff ? 'Only an owner or admin can sign off' : V.tcSignoffClear ? 'Update sign-off' : 'Record sign-off'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
    </div>
  );
}
