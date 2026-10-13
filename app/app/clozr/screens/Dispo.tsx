// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import { ContractsButton } from '@/components/ContractsHub';
import React from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { Empty, EmptyRow } from '@/components/ds/Empty';
import { GeniusPicker } from '@/components/AiButton';
import { Chevron, CZ } from '@/components/ds/chrome';
import type { ClozrView } from '@/app/clozr/view';
import { Mark } from '@/components/ds/mark';
import { OptionTimers } from '@/components/OptionTimers';

/** One label-over-value cell in the phone card's fact grid. */
function DispoFact({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <span style={{ minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: '#71717a' }}>
        {label}
      </span>
      <span style={{ display: 'block', fontSize: '12.5px', fontWeight: strong ? 600 : 500, color: '#27272a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value || '—'}
      </span>
    </span>
  );
}

function DomCell({ dom, mls }: { dom: number | null; mls: boolean }) {
  if (dom == null) return <span style={{ color: "#71717a" }}>Not yet</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontVariantNumeric: "tabular-nums" }}>
      {dom} day{dom === 1 ? "" : "s"}
      {mls ? <span title="Unsold after 6 days on market: list it on the MLS" style={{ fontSize: "11px", fontWeight: 600, color: "#b91c1c", background: "#fee2e2", borderRadius: "6px", padding: "1px 7px" }}>MLS now</span> : null}
    </span>
  );
}

export function Dispo({ V }: { V: ClozrView }) {
  return (
    <section data-screen-label="Dispo" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: V.isMobile ? "column" : "row", overflow: V.isMobile ? "hidden" : "visible"}}>
      <aside style={V.isMobile
        ? {display: "flex", alignItems: "center", gap: "6px", flex: "none", background: "#fff", borderBottom: "1px solid #e4e4e7", padding: "9px 12px", overflowX: "auto", overflowY: "hidden"}
        : {width: "210px", flex: "none", background: "#fff", borderRight: "1px solid #e4e4e7", padding: "14px 10px", overflow: "auto"}}>
        <div style={{display: V.isMobile ? "none" : "block", fontSize: "11.5px", fontWeight: "600", color: "#71717a", padding: "0 8px 8px"}}>
          Disposition
        </div>
        {(V.dispoFilters || []).map((f, f__i) => (
          <React.Fragment key={f__i}>
          <button className="dc2" onClick={f.go} style={{display: "flex", alignItems: "center", gap: V.isMobile ? "6px" : "0", justifyContent: V.isMobile ? "flex-start" : "space-between", width: V.isMobile ? "auto" : "100%", flex: "none", whiteSpace: "nowrap", height: "30px", padding: V.isMobile ? "0 11px" : "0 8px", border: V.isMobile ? "1px solid #e4e4e7" : "0", borderRadius: V.isMobile ? "999px" : "7px", cursor: "pointer", fontSize: "13px", textAlign: "left", background: f.bg, color: f.color, fontWeight: "500"}}>
            <span>
              {f.label}
            </span>
            <span style={{fontSize: "11.5px", color: "#71717a"}}>
              {f.count}
            </span>
          </button>
          </React.Fragment>
        ))}
        <div style={{display: V.isMobile ? "none" : "block", margin: "14px 8px 0", padding: "10px", border: "1px solid #e4e4e7", borderRadius: "9px"}}>
          <div style={{fontSize: "11.5px", color: "#71717a", fontWeight: "600"}}>
            This month
          </div>
          <div style={{fontSize: "20px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "4px"}}>
            {V.dispoMonthFees}
          </div>
          <div style={{fontSize: "11.5px", color: "#71717a"}}>
            assignment fees · {V.dispoMonthCount} deals
          </div>
        </div>
      </aside>
      <div style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
        <div data-head style={{display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px", background: "#fff", borderBottom: "1px solid #e4e4e7"}}>
          <h1 style={{margin: "0", fontSize: "16px", fontWeight: "700", letterSpacing: "-0.02em"}}>
            {V.dispoFilter}
          </h1>
          <span style={{fontSize: "12px", color: "#71717a"}}>
            {V.dispoSubtitle}
          </span>
          <div style={{flex: "1"}}></div>
          <ContractsButton V={V} />
          <GeniusPicker items={V.inventory || []} label="Genius Mode" />
                    {(V.dispoMenus || []).map((f, f__i) => (
            <React.Fragment key={f__i}>
            <div style={{position: "relative"}}>
              <button className="dc2 cz-menu-trigger" onClick={f.toggle} style={{height: "32px", padding: "0 10px", borderRadius: "10px", border: `1px solid ${f.border}`, background: f.bg, fontSize: "12.5px", cursor: "pointer", color: f.color, fontWeight: f.on ? "600" : "500", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px", fontFamily: "var(--font-sans)"}}>
                {f.on ? f.value : f.label}
                <Chevron size={11} color={f.on ? CZ.mint : CZ.faint} />
              </button>
              {(f.open) ? (
                <>
                <div onClick={V.closeFilterMenus} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
                <div ref={keepInView} className="cz-menu cz-menu--left" style={{top: "38px", left: "0", minWidth: "208px", maxHeight: "min(340px, 46vh)", overflow: "auto"}}>
                  {(f.options || []).map((o, o__i) => (
                    <React.Fragment key={o__i}>
                    <button type="button" className={"dc2 cz-menu-item" + (o.on ? " is-on" : "")} onClick={o.go}>
                      {o.label}
                      {(o.on) ? (
                        <>
                        <span style={{display: "inline-flex"}}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flex: "none", marginTop: "0"}}><path d="M20 6 9 17l-5-5" /></svg>
                        </span>
                        </>
                      ) : null}
                    </button>
                    </React.Fragment>
                  ))}
                </div>
                </>
              ) : null}
            </div>
            </React.Fragment>
          ))}
        </div>
        {(V.isMobile) ? (
          <>
          {/* Twelve columns at 1100px: on a phone everything from SPREAD
              rightwards was off the screen and the money cells wrapped to
              three lines. The card carries the same figures stacked. */}
          <div style={{flex: "1", overflow: "auto", background: "#fafafa", padding: "10px 12px calc(96px + env(safe-area-inset-bottom, 0px))", display: "flex", flexDirection: "column", gap: "8px"}}>
            {(V.inventory || []).map((i, i__i) => (
              <React.Fragment key={i__i}>
              <div onClick={i.open} style={{background: "#fff", border: "1px solid #e4e4e7", borderRadius: "12px", padding: "11px 12px", display: "flex", flexDirection: "column", gap: "9px", cursor: "pointer", minWidth: "0"}}>
                <div style={{display: "flex", alignItems: "flex-start", gap: "10px", minWidth: "0"}}>
                  <div style={{flex: "1", minWidth: "0"}}>
                    <div style={{fontWeight: "600", fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {i.addr}
                    </div>
                    <div style={{fontSize: "12px", color: "#71717a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {i.market && i.market.includes(',') ? i.market : (i.market && i.market !== i.city ? `${i.city} · ${i.market}` : i.city)}
                    </div>
                  </div>
                  <span style={{flex: "none", display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: "600", color: i.statusColor, whiteSpace: "nowrap", marginTop: "2px"}}>
                    <Mark label={i.status} />
                    {i.status}
                  </span>
                </div>
                <div style={{display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap", minWidth: "0", padding: "8px 10px", borderRadius: "9px", background: "#fafafa"}}>
                  <span style={{fontSize: "16px", fontWeight: "700", color: "#0A8560", whiteSpace: "nowrap"}}>
                    {i.spread}
                  </span>
                  <span style={{fontSize: "12px", color: "#71717a", whiteSpace: "nowrap"}}>
                    {i.spreadPct} spread
                  </span>
                  <span style={{flex: "1"}}></span>
                  <span style={{fontSize: "12px", color: "#52525b", whiteSpace: "nowrap"}}>
                    {i.contract} · ARV {i.arv}
                  </span>
                </div>
                <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: "7px 10px", minWidth: "0"}}>
                  <DispoFact label="On market" value={<DomCell dom={i.dom} mls={i.mlsDue} />} />
                  <DispoFact label="Buyer matches" value={i.matches} />
                  <DispoFact label="Offers" value={i.offers} />
                  <DispoFact label="Best offer" value={i.best} strong />
                  <DispoFact label="Option" value={<OptionTimers seller={i.optionSeller} buyer={i.optionBuyer} />} />
                  <DispoFact label="Campaign" value={i.campaign} />
                  <DispoFact label="Rep" value={i.rep} />
                </div>
              </div>
              </React.Fragment>
            ))}
            {(V.inventory || []).length === 0 ? (
              <Empty
                title={V.crmOk ? 'No inventory' : ''}
                hint={'Properties arrive here once a deal reaches Under Contract.'}
                failed={!V.crmOk}
                onRetry={V.reloadCrm}
              />
            ) : null}
          </div>
          </>
        ) : (
        <div style={{flex: "1", overflow: "auto", background: "#fff"}}>
          <table style={{width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px", minWidth: "1100px"}}>
            <thead>
              <tr>
                {(V.inventoryCols || []).map((c, c__i) => (
                  <React.Fragment key={c__i}>
                  <th style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", padding: "0 12px", height: "36px", textAlign: "left", fontSize: "11.5px", fontWeight: "600", color: "#71717a", whiteSpace: "nowrap"}}>
                    {c}
                  </th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {(V.inventory || []).map((i, i__i) => (
                <React.Fragment key={i__i}>
                <tr className="dc2" onClick={i.open} style={{cursor: "pointer"}}>
                  <td style={{padding: "0 12px", height: "46px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                    <div style={{fontWeight: "600"}}>
                      {i.addr}
                    </div>
                    <div style={{fontSize: "11px", color: "#71717a"}}>
                      {i.city}
                    </div>
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#52525b"}}>
                    {i.market}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", fontWeight: "500"}}>
                    {i.contract}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                    {i.arv}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", fontWeight: "600", color: "#0A8560"}}>
                    {i.spread}
                    <span style={{fontWeight: "400", color: "#71717a", marginLeft: "6px"}}>
                      {i.spreadPct}
                    </span>
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                    <DomCell dom={i.dom} mls={i.mlsDue} />
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                    {i.matches}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#52525b"}}>
                    {i.campaign}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                    {i.offers}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", fontWeight: "600"}}>
                    {i.best}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", maxWidth: "220px"}}>
                    <OptionTimers seller={i.optionSeller} buyer={i.optionBuyer} />
                    {i.optionSeller || i.optionBuyer ? null : i.daysLeft}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#52525b"}}>
                    {i.rep}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                    <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11.5px", fontWeight: "600", color: i.statusColor}}>
                      <Mark label={i.status} />
                      {i.status}
                    </span>
                  </td>
                </tr>
                </React.Fragment>
              ))}
              {(V.inventory || []).length === 0 ? (
                <EmptyRow
                  colSpan={(V.inventoryCols || []).length || 1}
                  title={V.crmOk ? 'No inventory' : ''}
                  hint={'Properties arrive here once a deal reaches Under Contract.'}
                  failed={!V.crmOk}
                  onRetry={V.reloadCrm}
                />
              ) : null}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </section>
  );
}
