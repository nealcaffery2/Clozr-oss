// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React from 'react';
import { BackLink } from '@/components/ds/BackLink';
import type { ClozrView } from '@/app/clozr/view';
import { GeniusMode, GeniusTopFive } from '@/components/GeniusMode';
import { DealFiles } from '@/components/DealFiles';
import { DispoCampaign } from '@/components/DispoCampaign';
import { BuyerPagePanel } from '@/components/BuyerPagePanel';
import { AiButton } from '@/components/AiButton';
import { useSession } from '@/lib/session';
import { BulkCompose } from '@/app/components/bulk/BulkCompose';
import { Mark } from '@/components/ds/mark';
import { PropertyPhoto } from '@/components/PropertyPhoto';
import { SearchSelect } from '@/components/SearchSelect';
import { HandoffCard } from '@/app/components/dispo/HandoffCard';
import { OfferDesk } from '@/app/components/dispo/OfferDesk';
import { MentionText } from '@/app/components/record/MentionField';
import { Walkthroughs } from '@/app/components/dispo/Walkthroughs';

const none = (text: string, pad = "14px 16px") => (
  <div style={{padding: pad, fontSize: "12.5px", color: "var(--meta, #71717a)"}}>{text}</div>
);

const field: React.CSSProperties = {
  width: "100%", height: "34px", padding: "0 10px", border: "1px solid var(--divider, #e4e4e7)",
  borderRadius: "9px", fontSize: "13px", outline: "0", background: "var(--canvas, #fafafa)", color: "var(--ink, #18181b)",
};
const label: React.CSSProperties = {
  display: "block", fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "500", marginBottom: "5px",
};
const btn = (primary = false): React.CSSProperties => ({
  height: "32px", padding: "0 12px", borderRadius: "8px", fontSize: "12.5px", fontWeight: "600", cursor: "pointer",
  border: primary ? "1px solid var(--c-primary)" : "1px solid var(--c-btn-line)", background: primary ? "var(--c-primary)" : "var(--c-btn-bg)", color: primary ? "#fff" : "#18181b",
});

/** Book a buyer's walkthrough of this property: an appointment the Walkthroughs tab and the calendar both read. */
function WalkthroughForm({ V, onBooked }: { V: ClozrView; onBooked: () => void }) {
  const [f, setF] = React.useState({ buyerId: "", day: "", time: "10:00" });
  const [busy, setBusy] = React.useState(false);
  const buyerId = f.buyerId;
  const on = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const options = React.useMemo(() => V.dispoBuyerChoices.map((b) => ({ v: b.id, label: b.label })), [V.dispoBuyerChoices]);
  const save = async () => {
    setBusy(true);
    try { if (await V.scheduleWalkthrough({ ...f, buyerId })) { setF({ ...f, day: "" }); onBooked(); } } finally { setBusy(false); }
  };
  return (
    <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", padding: "16px", marginBottom: "14px"}}>
      <div style={{fontWeight: "600", fontSize: "14px", marginBottom: "10px"}}>
        Schedule a walkthrough
      </div>
      <span style={label}>Buyer</span>
      <SearchSelect value={buyerId} ariaLabel="Buyer" placeholder={options.length ? `Search ${options.length.toLocaleString("en-US")} buyers` : "No buyers on this workspace"}
        options={options} onChange={(v) => setF({ ...f, buyerId: v })} />
      <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "8px"}}>
        <div>
          <label style={label} htmlFor="wt-day">Day</label>
          <input id="wt-day" type="date" value={f.day} onChange={on("day")} style={field} />
        </div>
        <div>
          <label style={label} htmlFor="wt-time">Time</label>
          <input id="wt-time" type="time" value={f.time} onChange={on("time")} style={field} />
        </div>
      </div>
      <button type="button" style={{...btn(true), width: "100%", marginTop: "10px"}} disabled={busy || !buyerId || !f.day} onClick={() => void save()}>
        {busy ? "Scheduling…" : "Schedule walkthrough"}
      </button>
    </div>
  );
}

export function DispoProperty({ V }: { V: ClozrView }) {
  const session = useSession();
  const [walkVersion, setWalkVersion] = React.useState(0);
  const dealId = V.liveIds?.dispoDealId ?? null;
  const demo = !V.isLiveData;
  const [rvmIds, setRvmIds] = React.useState<string[] | null>(null);
  return (
    <section data-screen-label="Dispo property" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
      <div style={{background: "var(--surface, #fff)", borderBottom: "1px solid var(--divider, #e4e4e7)", padding: "12px 20px 0"}}>
        <div style={{display: "flex", alignItems: "center", flexWrap: V.isMobile ? "wrap" : "nowrap", rowGap: "4px", gap: "8px", fontSize: "12.5px", color: "var(--meta, #71717a)", minWidth: "0"}}>
          <BackLink to={V.backFor('dispo')} />
          <span style={{color: "var(--line, #d4d4d8)", flex: "none"}}>
            /
          </span>
          <span style={{color: "var(--ink, #18181b)", fontWeight: "600", display: V.isMobile ? "none" : "inline", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
            {V.DP.addr}
          </span>
          <span style={{color: "var(--line, #d4d4d8)", display: V.isMobile ? "none" : "inline", flex: "none"}}>
            ·
          </span>
          <button onClick={V.DP.open} style={{background: "none", border: "0", padding: "0", cursor: "pointer", color: "var(--tx-mint, #0a8560)", fontSize: "12.5px", minWidth: "0", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left"}}>
            Seller: {V.DP.seller}
          </button>
          <div style={{flex: "1"}}></div>
          {V.DP.dealDbId ? (
            <button type="button" data-testid="dispo-archive" onClick={() => V.archiveDealDb(V.DP.dealDbId, !V.dealArchivedDb(V.DP.dealDbId))}
              title={V.dealArchivedDb(V.DP.dealDbId) ? 'Put this deal back on Dispo and the Deals board' : 'Archive this deal: it leaves Dispo, the Deals board and the deal list'}
              style={{height: "28px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--divider, #e4e4e7)", background: "var(--surface, #fff)", fontSize: "12px", fontWeight: 600, color: "var(--muted, #52525b)", cursor: "pointer", flex: "none"}}>
              {V.dealArchivedDb(V.DP.dealDbId) ? 'Restore' : 'Archive'}
            </button>
          ) : null}
          <AiButton kind="genius" onClick={V.geniusHere} />
        </div>
        <div style={{display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "16px", marginTop: "8px"}}>
          {(V.ready) ? (
            <>
            <button type="button" data-testid="dispo-photo" onClick={() => { if (V.DP.photos.length) V.openPhotoShow(V.DP.addr, V.DP.photos, V.DP.dealDbId); }} title={V.DP.photos.length ? 'View photos' : 'Property photo'} style={{width: "88px", height: "62px", borderRadius: "8px", flex: "none", padding: 0, border: 0, overflow: "hidden", background: "#e9ebf0", cursor: V.DP.photos.length ? "pointer" : "default"}}>
              <PropertyPhoto photo={V.DP.photos?.[0] || ''} street={V.DP.streetSafe || V.DP.imgSafe} alt={'Photo of ' + V.DP.addr} eager />
            </button>
            </>
          ) : null}
          <div style={{minWidth: "0"}}>
            <h1 style={{margin: "0", fontSize: "22px", fontWeight: "700", letterSpacing: "-0.03em"}}>
              {V.DP.addr}
            </h1>
            <div style={{fontSize: "12.5px", color: "var(--meta, #71717a)", marginTop: "2px"}}>
              {V.DP.cityLine} · {V.DP.facts} · dispo rep {V.DP.rep}
            </div>
            <div style={{display: "inline-flex", alignItems: "center", gap: "6px", marginTop: "6px", fontSize: "11.5px", fontWeight: "700", color: V.DP.statusColor}}>
              <Mark label={V.DP.status} />
              {V.DP.status}
            </div>
          </div>
          <div style={{flex: "1"}}></div>
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "repeat(2,minmax(0,1fr))" : "repeat(6,auto)", gap: V.isMobile ? "12px 16px" : "22px", width: V.isMobile ? "100%" : "auto", minWidth: "0"}}>
            {(V.dispoHead || []).map((h, h__i) => (
              <React.Fragment key={h__i}>
              <div style={{minWidth: "0"}}>
                <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600", whiteSpace: V.isMobile ? "normal" : "nowrap", minWidth: "0", overflowWrap: "anywhere"}}>
                  {h.k}
                </div>
                <div style={{fontSize: "18px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "3px", whiteSpace: "nowrap"}}>
                  {h.v}
                </div>
              </div>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div data-tabs style={{display: "flex", gap: "2px", marginTop: "10px"}}>
          {(V.dispoTabs || []).map((t, t__i) => (
            <React.Fragment key={t__i}>
            <button className="dc12" onClick={t.go} style={{height: "36px", padding: "0 11px", border: "0", borderBottom: `2px solid ${t.border}`, background: "none", cursor: "pointer", fontSize: "13px", fontWeight: "500", color: t.color}}>
              {t.label}
            </button>
            </React.Fragment>
          ))}
        </div>
      </div>
      <div style={{flex: "1", minHeight: "0", overflow: "auto", padding: "16px 20px 40px"}}>
        {(V.isDispoTab.Overview) ? (
          <>
          <div style={{marginBottom: "14px"}}>
            <HandoffCard key={dealId ?? "demo"} dealId={dealId} address={V.DP.addr} seller={V.DP.seller} canWrite={!!V.liveIds?.canWrite || demo} isMobile={V.isMobile}
              userId={session.user?.id ?? null} onToast={V.showToast} demo={demo} />
          </div>
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "repeat(2,minmax(0,1fr))" : "repeat(auto-fit,minmax(110px,1fr))", background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
            {(V.campaignMetrics || []).map((m, m__i) => (
              <React.Fragment key={m__i}>
              <div style={{padding: "12px 14px", borderRight: "1px solid var(--divider-2, #f0f0f1)"}}>
                <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
                  {m.k}
                </div>
                <div style={{fontSize: "20px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "4px"}}>
                  {m.v}
                </div>
                <div style={{fontSize: "11px", color: "var(--meta, #71717a)"}}>
                  {m.pct}
                </div>
              </div>
              </React.Fragment>
            ))}
          </div>
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "minmax(0,1.5fr) minmax(300px,1fr)", gap: "14px", marginTop: "14px", alignItems: "start"}}>
            <div style={{display: "flex", flexDirection: "column", gap: "14px"}}>
              <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
                <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
                  <span style={{fontWeight: "600", fontSize: "14px"}}>
                    Offers received · {V.offerRows.length}
                  </span>
                  <button onClick={V.goOffersTab} style={{fontSize: "12px", color: "var(--tx-mint, #0a8560)", background: "none", border: "0", cursor: "pointer", fontWeight: "500"}}>
                    Offer desk
                  </button>
                </div>
                {(V.offerRows || []).map((o, o__i) => (
                  <React.Fragment key={o__i}>
                  <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "30px minmax(0,1fr)" : "30px minmax(0,1fr) auto auto", gap: V.isMobile ? "4px 10px" : "12px", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
                    <span style={{width: "30px", height: "30px", borderRadius: "8px", background: "var(--surface-2, #f4f4f5)", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: "700", color: "var(--muted, #52525b)"}}>
                      {o.initials}
                    </span>
                    <span>
                      <span style={{display: "block", fontWeight: "600"}}>
                        {o.buyer}
                      </span>
                      <span style={{display: "block", fontSize: "11.5px", color: "var(--meta, #71717a)"}}>
                        {o.terms} · close {o.closing}
                      </span>
                    </span>
                    <span style={{fontWeight: "700", fontSize: "14px", gridColumn: V.isMobile ? "2" : "auto", whiteSpace: "nowrap"}}>
                      {o.offer}
                      {(V.isMobile && o.net !== '—') ? (
                        <span style={{fontSize: "11.5px", color: "var(--tx-mint, #0a8560)", fontWeight: "600", marginLeft: "8px"}}>
                          net {o.net}
                        </span>
                      ) : null}
                    </span>
                    <span style={{display: V.isMobile ? "none" : "block", fontSize: "11.5px", color: "var(--tx-mint, #0a8560)", fontWeight: "600", minWidth: "70px", textAlign: "right"}}>
                      net {o.net}
                    </span>
                  </div>
                  </React.Fragment>
                ))}
                {V.offerRows.length ? null : none("No offers on this deal yet.")}
              </div>
              <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden"}}>
                <div style={{padding: "12px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontWeight: "600", fontSize: "14px"}}>
                  Buyer engagement · live
                </div>
                {V.engagementFeed.length ? null : none("No buyer has been sent this deal yet.")}
                {(V.engagementFeed || []).map((e, e__i) => (
                  <React.Fragment key={e__i}>
                  <div style={{display: "grid", gridTemplateColumns: "70px 1fr", gap: "12px", padding: "8px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontSize: "12.5px"}}>
                    <span style={{color: "var(--meta, #71717a)"}}>
                      {e.t}
                    </span>
                    <span style={{color: "var(--ink-2, #27272a)"}}>
                      {e.text}
                    </span>
                  </div>
                  </React.Fragment>
                ))}
              </div>
            </div>
            <div style={{display: "flex", flexDirection: "column", gap: "14px"}}>
              <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", padding: "16px"}}>
                <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
                  Top matches
                </div>
                {(V.topMatches || []).map((m, m__i) => (
                  <React.Fragment key={m__i}>
                  <button onClick={m.open} style={{display: "grid", gridTemplateColumns: "1fr auto", gap: "8px", width: "100%", textAlign: "left", padding: "9px 0", border: "0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", background: "none", cursor: "pointer"}}>
                    <span>
                      <span style={{display: "block", fontWeight: "600", fontSize: "13px", color: "var(--ink, #18181b)"}}>
                        {m.company}
                      </span>
                      <span style={{display: "block", fontSize: "11.5px", color: "var(--meta, #71717a)"}}>
                        {m.strategy} · ceiling {m.ceiling} · {m.lastActivity}
                      </span>
                    </span>
                    <span style={{fontWeight: "700", color: m.matchColor}}>
                      {m.match}
                    </span>
                  </button>
                  </React.Fragment>
                ))}
                {V.topMatches.length ? null : none("No matches yet — run matching on the Matches tab.", "9px 0")}
                <button className="dc2" onClick={V.goMatchesTab} style={{marginTop: "10px", width: "100%", height: "30px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer"}}>
                  All {V.matchCount} matches
                </button>
              </div>
              <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", padding: "16px"}}>
                <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
                  Walkthroughs
                </div>
                {V.walkRowsHere.length ? null : none("No walkthroughs scheduled.", "8px 0")}
                {(V.walkRowsHere || []).map((w, w__i) => (
                  <React.Fragment key={w__i}>
                  <div style={{display: "grid", gridTemplateColumns: "1fr auto", gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontSize: "12.5px"}}>
                    <span>
                      <span style={{display: "block", fontWeight: "600"}}>
                        {w.buyer}
                      </span>
                      <span style={{display: "block", fontSize: "11.5px", color: "var(--meta, #71717a)"}}>
                        {w.date} · {w.time}
                      </span>
                    </span>
                    <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11.5px", fontWeight: "600", color: w.color}}>
                      <Mark label={w.status} />
                      {w.status}
                    </span>
                  </div>
                  </React.Fragment>
                ))}
              </div>
              {(V.showAi && !V.isLiveData) ? (
                <>
                <div style={{borderRadius: "12px", padding: "14px", background: "var(--ink-hero, #141419)", color: "var(--on-dark, #fff)", position: "relative", overflow: "hidden"}}>
                  <div style={{position: "absolute", inset: "0", pointerEvents: "none", background: "radial-gradient(120% 90% at 90% -10%, rgba(10, 133, 96,0.34), transparent 58%)"}}></div>
                  <div style={{position: "relative"}}>
                    <div style={{fontSize: "11.5px", color: "rgba(255,255,255,.6)", fontWeight: "600"}}>
                      CLOZR AI · dispo
                    </div>
                    <div style={{fontSize: "13px", lineHeight: "1.5", marginTop: "8px", color: "rgba(255,255,255,.92)"}}>
                      {"Harbor Capital's offer nets $2,500 less than Northline's but closes 7 days sooner with no contingencies. Given the Sept 22 close, accept Harbor."}
                    </div>
                    <button className="dc3" onClick={V.goOffersTab} style={{marginTop: "10px", height: "28px", padding: "0 12px", borderRadius: "7px", border: "0", background: "#0A8560", color: "#fff", fontSize: "12px", fontWeight: "600", cursor: "pointer"}}>
                      Compare offers
                    </button>
                  </div>
                </div>
                </>
              ) : null}
            </div>
          </div>
          </>
        ) : null}
        {(V.isDispoTab.Matches) ? (
          <>
          <div style={{display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "12px"}}>
            <div style={{display: "flex", alignItems: "center", gap: "8px", height: "32px", padding: "0 10px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "8px", background: "var(--surface, #fff)", width: "240px"}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--meta, #71717a)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input value={V.matchQ} onChange={V.setMatchQ} placeholder="Search buyers" style={{border: "0", outline: "0", fontSize: "13px", width: "100%", background: "none"}} />
            </div>
            <span style={{fontSize: "12px", color: "var(--meta, #71717a)"}}>
              {V.matchCount} matched buyers · ranked by fit and engagement
            </span>
            <div style={{flex: "1"}}></div>
            <button className="dc2" onClick={V.runMatching} title="Score every buyer's buy box against this deal" style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", color: "var(--ink, #18181b)"}}>
              Run matching
            </button>
            <button className="dc2" onClick={() => setRvmIds(V.matches.map((m) => m.id))} disabled={!V.matches.length} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", color: "var(--ink, #18181b)"}}>
              RVM matches
            </button>
            <button className="dc10" onClick={V.goMarketingTab} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer"}}>
              Create campaign from matches
            </button>
          </div>
          <div style={{display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "14px"}}>
            {(V.matchFilters || []).map((f, f__i) => (
              <React.Fragment key={f__i}>
              <button className="dc23" onClick={f.go} aria-pressed={f.on} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: `1px solid ${f.on ? "#0A8560" : "var(--divider, #e4e4e7)"}`, background: f.on ? "var(--mint-dim, #e7f8f1)" : "var(--surface, #fff)", fontSize: "11.5px", color: f.on ? "var(--tx-mint, #0a8560)" : "var(--muted, #52525b)", fontWeight: f.on ? "600" : "400", cursor: "pointer"}}>
                {f.label}
              </button>
              </React.Fragment>
            ))}
          </div>
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "repeat(2,minmax(0,1fr))", gap: "12px"}}>
            {(V.matches || []).map((m, m__i) => (
              <React.Fragment key={m__i}>
              <div className="dc19" style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", padding: "16px", display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "minmax(0,1fr) 190px", gap: "16px", transition: "box-shadow .15s"}}>
                <div style={{minWidth: "0"}}>
                  <div style={{display: "flex", alignItems: "center", gap: "10px"}}>
                    <span style={{width: "36px", height: "36px", borderRadius: "9px", background: "var(--surface-2, #f4f4f5)", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: "700", color: "var(--muted, #52525b)"}}>
                      {m.initials}
                    </span>
                    <div style={{minWidth: "0"}}>
                      <div style={{display: "flex", alignItems: "center", gap: "8px"}}>
                        <span style={{fontWeight: "700", fontSize: "15px", letterSpacing: "-0.01em"}}>
                          {m.company}
                        </span>
                        <span style={{display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: "700", color: m.vipColor}}>
                          <Mark label={m.vip} />
                          {m.vip}
                        </span>
                      </div>
                      <div style={{fontSize: "12px", color: "var(--meta, #71717a)"}}>
                        {m.name} · {m.markets} · prefers {m.pref}
                      </div>
                    </div>
                  </div>
                  <div style={{display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "8px", marginTop: "12px"}}>
                    <div>
                      <div style={{fontSize: "11px", color: "var(--meta, #71717a)"}}>
                        Ceiling
                      </div>
                      <div style={{fontSize: "12.5px", fontWeight: "600"}}>
                        {m.ceiling}
                      </div>
                    </div>
                    <div>
                      <div style={{fontSize: "11px", color: "var(--meta, #71717a)"}}>
                        Rehab
                      </div>
                      <div style={{fontSize: "12.5px", fontWeight: "600"}}>
                        {m.rehabTol}
                      </div>
                    </div>
                    <div>
                      <div style={{fontSize: "11px", color: "var(--meta, #71717a)"}}>
                        Exit
                      </div>
                      <div style={{fontSize: "12.5px", fontWeight: "600"}}>
                        {m.strategy}
                      </div>
                    </div>
                    <div>
                      <div style={{fontSize: "11px", color: "var(--meta, #71717a)"}}>
                        Last purchase
                      </div>
                      <div style={{fontSize: "12.5px", fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>
                        {m.lastPurchase}
                      </div>
                    </div>
                  </div>
                  <div style={{marginTop: "10px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px"}}>
                    {(m.why || []).map((w, w__i) => (
                      <React.Fragment key={w__i}>
                      <div style={{fontSize: "12px", color: "var(--ink-2, #27272a)", display: "flex", gap: "6px"}}>
                        <span style={{color: "var(--tx-mint, #0a8560)", display: "inline-flex"}}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flex: "none", marginTop: "3px"}}><path d="M20 6 9 17l-5-5" /></svg>
                        </span>
                        {w.w}
                      </div>
                      </React.Fragment>
                    ))}
                  </div>
                  {m.issue ? (
                  <div style={{marginTop: "8px", fontSize: "12px", color: "var(--tx-amber-deep, #92400e)", background: "var(--caution-soft, #fef3c7)", borderRadius: "7px", padding: "6px 9px"}}>
                    <b style={{fontWeight: "600"}}>
                      Potential issue:
                    </b>
                    {" "}{m.issue}
                  </div>
                  ) : null}
                  <div style={{display: "flex", gap: "5px", marginTop: "10px"}}>
                    <button className="clozr-talkr-ghost" onClick={m.call} style={{color: "var(--c-talkr)", height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--tint-rose, #fecdd3)", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "500", cursor: "pointer"}}>
                      Call
                    </button>
                    <button className="clozr-talkr-ghost" onClick={m.text} style={{color: "var(--c-talkr)", height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--tint-rose, #fecdd3)", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "500", cursor: "pointer"}}>
                      Text
                    </button>
                    <button className="dc6" onClick={m.email} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "500", cursor: "pointer"}}>
                      Email
                    </button>
                    <button className="dc6" onClick={() => setRvmIds([m.id])} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "500", cursor: "pointer"}}>
                      RVM
                    </button>
                    <button className="dc2" onClick={m.add} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "500", cursor: "pointer"}}>
                      Add to campaign
                    </button>
                    <button onClick={m.open} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "0", background: "none", fontSize: "12px", fontWeight: "500", cursor: "pointer", color: "var(--tx-mint, #0a8560)"}}>
                      View buyer
                    </button>
                  </div>
                </div>
                <div style={{borderLeft: "1px solid var(--divider-2, #f0f0f1)", paddingLeft: "16px", display: "flex", flexDirection: "column", gap: "10px"}}>
                  <div>
                    <div style={{fontSize: "11px", color: "var(--meta, #71717a)"}}>
                      Match
                    </div>
                    <div style={{display: "flex", alignItems: "baseline", gap: "4px"}}>
                      <span style={{fontSize: "30px", fontWeight: "700", letterSpacing: "-0.04em", color: m.matchColor}}>
                        {m.match}
                      </span>
                      <span style={{fontSize: "11px", color: "var(--meta, #71717a)"}}>
                        / 100
                      </span>
                    </div>
                  </div>
                  <div>
                    <div style={{display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--meta, #71717a)"}}>
                      <span>
                        Response
                      </span>
                      <span style={{fontWeight: "600", color: "var(--ink, #18181b)"}}>
                        {m.engagement}
                      </span>
                    </div>
                    <div style={{height: "5px", background: "var(--divider-2, #f0f0f1)", borderRadius: "3px", marginTop: "4px", overflow: "hidden"}}>
                      <div style={{height: "100%", width: m.engPct, background: m.engColor}}></div>
                    </div>
                  </div>
                  <div style={{fontSize: "11.5px", color: "var(--muted, #52525b)"}}>
                    <div>
                      {m.offers}
                    </div>
                    <div style={{color: "var(--meta, #71717a)", marginTop: "2px"}}>
                      Active {m.lastActivity}
                    </div>
                  </div>
                </div>
              </div>
              </React.Fragment>
            ))}
          </div>
          {V.matches.length ? null : none("No buyers matched to this deal yet. Run matching to score every buy box against it.", "6px 0 16px")}
          <GeniusTopFive workspaceId={V.liveIds?.workspaceId ?? null} dealId={V.liveIds?.dispoDealId ?? null} onViewAll={V.genius.tab} />
          </>
        ) : null}
        {(V.isDispoTab.Genius) ? (
          <div id="genius-mode">
            <GeniusMode workspaceId={V.liveIds?.workspaceId ?? null} dealId={V.liveIds?.dispoDealId ?? null} userId={session.user?.id ?? null}
              canWrite={!!V.liveIds?.canWrite} isMobile={V.isMobile} onToast={V.showToast} onAdded={V.reloadCrm}
              onCall={V.genius.call} onQueue={V.genius.queue} onOpenBuyer={V.genius.openBuyer} onCampaign={V.genius.campaign} onAddToMarketing={V.genius.addToMarketing} onShowProspects={V.goBuyerProspects} />
          </div>
        ) : null}
        {(V.isDispoTab.Marketing) ? (
          <>
          {/* One flow: the page every message links to, then the campaigns that send it. */}
          <div style={{marginBottom: "14px"}}>
            <BuyerPagePanel dealId={V.liveIds?.dispoDealId ?? null} canWrite={!!V.liveIds?.canWrite || !!V.dispoCampaign?.demo}
              defaultHeadline={((p) => p ? `Investment property in ${p}` : "Investment property")(V.DP.cityLine.replace(/\s*\d{5}(?:-\d{4})?\s*$/, "").replace(/^[\s,]+|[\s,]+$/g, ""))} onToast={V.showToast} photoUrl={V.DP.imgSafe || null}
              demo={V.dispoCampaign?.demo ? { page: V.dispoCampaign.demo.page, url: V.dispoCampaign.demo.pageUrl } : null} />
          </div>
          <DispoCampaign workspaceId={V.liveIds?.workspaceId ?? null} dealId={V.liveIds?.dispoDealId ?? null} canWrite={!!V.liveIds?.canWrite || !!V.dispoCampaign?.demo} isMobile={V.isMobile}
            dealFields={V.dispoCampaign?.dealFields ?? null} textCtx={V.dispoCampaign?.textCtx ?? null} onToast={V.showToast} onChanged={V.reloadCrm}
            demo={V.dispoCampaign?.demo ?? null}
            viewed={V.isLiveData ? (V.campaignMetrics.find((m) => m.k === "Viewed")?.v ?? null) : null}
            buyer={V.dispoCampaign?.buyer} onCall={V.genius.call} onOpenBuyer={V.dispoCampaign?.openBuyer ?? V.genius.openBuyer}
            onQueue={V.genius.queue} onAgent={V.genius.startAgent} />
          </>
        ) : null}
        {(V.isDispoTab.Activity) ? (
          <>
          <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "hidden", maxWidth: "900px"}}>
            {V.dispoActivity.length ? null : none("No activity on this property yet.")}
            {(V.dispoActivity || []).map((a, a__i) => (
              <React.Fragment key={a__i}>
              <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "90px 90px 1fr", gap: V.isMobile ? "3px" : "12px", padding: "11px 16px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontSize: "12.5px", alignItems: V.isMobile ? "start" : "center"}}>
                <span style={{color: "var(--meta, #71717a)"}}>
                  {a.t}
                </span>
                <span style={{fontSize: "11.5px", fontWeight: "600", color: "var(--meta, #71717a)"}}>
                  {a.kind}
                </span>
                <span style={{color: "var(--ink-2, #27272a)"}}>
                  {a.text}
                </span>
              </div>
              </React.Fragment>
            ))}
          </div>
          </>
        ) : null}
        {(V.isDispoTab.Communications) ? (
          <>
          <div style={{display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px"}}>
            <span style={{fontWeight: "600", fontSize: "14px"}}>
              Communications
            </span>
            <span style={{fontSize: "12px", color: "var(--meta, #71717a)"}}>
              every call, text and email tied to this property and its people
            </span>
            <div style={{flex: "1"}}></div>
            <span style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontVariantNumeric: "tabular-nums"}}>
              {V.dispoCommsCount}
            </span>
          </div>
          {V.hasDispoComms ? null : none("No calls, texts or emails on this property yet.", "0")}
          {(V.hasDispoComms) ? (
            <>
            <div style={{maxWidth: "900px"}}>
              {(V.dispoComms || []).map((c, c__i) => (
                <React.Fragment key={c__i}>
                <div style={{display: "grid", gridTemplateColumns: "30px minmax(0,1fr)", gap: "12px", paddingBottom: "12px"}}>
                  <div style={{display: "flex", flexDirection: "column", alignItems: "center"}}>
                    <span style={{width: "30px", height: "30px", borderRadius: "8px", background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "700", color: "var(--muted, #52525b)", flex: "none"}}>
                      {c.initials}
                    </span>
                    <span style={{flex: "1", width: "1px", background: "var(--divider, #e4e4e7)", marginTop: "6px"}}></span>
                  </div>
                  <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "10px", padding: "11px 14px", minWidth: "0"}}>
                    <div style={{display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap"}}>
                      <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: "700", color: c.color}}>
                        <Mark label={c.channel} />
                        {c.channel}
                      </span>
                      <span style={{fontSize: "11px", fontWeight: "700", color: c.dirColor}}>
                        {c.dirLabel}
                      </span>
                      <span style={{fontSize: "12.5px", fontWeight: "600", color: "var(--ink, #18181b)"}}>
                        {c.party}
                      </span>
                      {(c.isBuyer) ? (
                        <>
                        <span style={{fontSize: "11px", fontWeight: "700", color: "#ff7a45"}}>
                          Buyer
                        </span>
                        </>
                      ) : null}
                      <span style={{flex: "1"}}></span>
                      {(c.hasDur) ? (
                        <>
                        <span style={{fontSize: "11px", color: "var(--meta, #71717a)", fontVariantNumeric: "tabular-nums"}}>
                          {c.dur}
                        </span>
                        </>
                      ) : null}
                      <span style={{fontSize: "11px", color: "var(--meta, #71717a)", whiteSpace: "nowrap"}}>
                        {c.time}
                      </span>
                    </div>
                    <div style={{fontSize: "12.5px", color: "var(--ink-2, #27272a)", marginTop: "5px", lineHeight: "1.5"}}>
                      <MentionText text={c.preview} />
                    </div>
                    {(c.hasRep) ? (
                      <>
                      <div style={{fontSize: "11px", color: "var(--meta, #71717a)", marginTop: "5px"}}>
                        {c.rep}
                      </div>
                      </>
                    ) : null}
                  </div>
                </div>
                </React.Fragment>
              ))}
            </div>
            </>
          ) : null}
          </>
        ) : null}
        {(V.isDispoTab.Offers) ? (
          <OfferDesk key={dealId ?? "demo"} workspaceId={V.liveIds?.workspaceId ?? null} dealId={dealId} userId={session.user?.id ?? null}
            canWrite={!!V.liveIds?.canWrite || demo} canApprove={V.canApproveOffers} isMobile={V.isMobile} address={V.DP.addr}
            buyerChoices={V.dispoDeskBuyerChoices} buyerOf={V.deskBuyerOf} onToast={V.showToast} onChanged={V.reloadCrm}
            onOpenBuyer={(id) => V.openBuyerRecord('b' + id)} onAssign={V.generateAssignment} assignLabel={V.assignLabel} demo={demo} />
        ) : null}
        {(V.isDispoTab.Walkthroughs) ? (
          <>
          <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "minmax(0,1fr) 300px", gap: "14px", alignItems: "start"}}>
            <Walkthroughs key={dealId ?? "demo"} dealId={dealId} workspaceId={V.liveIds?.workspaceId ?? null} userId={session.user?.id ?? null}
              canWrite={!!V.liveIds?.canWrite || demo} isMobile={V.isMobile} buyerOf={V.deskBuyerOf}
              onOpenBuyer={(id) => V.openBuyerRecord('b' + id)} onToast={V.showToast} version={walkVersion}
              demoRows={demo ? V.walkRows.map((w) => ({ buyer: w.buyer, contact: w.contact, date: w.date, time: w.time, status: w.status })) : null} />
            <div>
            <WalkthroughForm V={V} onBooked={() => setWalkVersion((n) => n + 1)} />
            {V.isLiveData ? null : (
            <div style={{background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", padding: "16px"}}>
              <div style={{fontWeight: "600", fontSize: "14px"}}>
                Fri Sept 5 · 2:30 PM window
              </div>
              <div style={{fontSize: "12.5px", color: "var(--meta, #71717a)", marginTop: "2px"}}>
                Group showing · lockbox 4471 · 2 buyers in this window
              </div>
              <div style={{marginTop: "12px", display: "flex", flexDirection: "column", gap: "6px"}}>
                <div style={{display: "flex", justifyContent: "space-between", padding: "8px 10px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "8px", fontSize: "12.5px"}}>
                  <span style={{fontWeight: "600"}}>
                    Harbor Capital
                  </span>
                  <span style={{color: "var(--tx-mint, #0a8560)", fontWeight: "600"}}>
                    Confirmed
                  </span>
                </div>
                <div style={{display: "flex", justifyContent: "space-between", padding: "8px 10px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "8px", fontSize: "12.5px"}}>
                  <span style={{fontWeight: "600"}}>
                    Blue Mesa Investments
                  </span>
                  <span style={{color: "var(--tx-amber, #b45309)", fontWeight: "600"}}>
                    Requested
                  </span>
                </div>
                <button type="button" className="dc26" style={{height: "30px", borderRadius: "8px", border: "1px dashed var(--line, #d4d4d8)", background: "none", fontSize: "12px", color: "var(--muted, #52525b)", cursor: "pointer"}} onClick={V.addBuyer}>
                  Add buyer to window
                </button>
              </div>
            </div>
            )}
            </div>
          </div>
          </>
        ) : null}
        {(V.isDispoTab.Files) ? (
          <div style={{maxWidth: "820px"}}>
            <DealFiles
              workspaceId={V.liveIds?.workspaceId ?? null}
              dealId={V.liveIds?.dispoDealId ?? null}
              canWrite={!!V.liveIds?.canWrite}
              onToast={V.showToast}
              onOpenPhotos={(title, urls, start) => V.openPhotoShow(title, urls, V.liveIds?.dispoDealId ?? null, start)}
              fallbackPhotos={V.DP.photos.length ? V.DP.photos : [V.DP.streetSafe].filter(Boolean)}
            />
          </div>
        ) : null}
        {(V.isDispoTab.Assignment) ? (
          <>
          <div style={{maxWidth: "720px", background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", padding: "20px"}}>
            <div style={{fontWeight: "600", fontSize: "14px"}}>
              Assignment
            </div>
            {(V.hasAccepted) ? (
              <>
              <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr 1fr" : "repeat(3,1fr)", gap: "12px", marginTop: "12px"}}>
                <div style={{border: "1px solid var(--divider, #e4e4e7)", borderRadius: "10px", padding: "12px"}}>
                  <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
                    Assignee
                  </div>
                  <div style={{fontWeight: "700", marginTop: "4px"}}>
                    {V.acceptedOffer!.buyer}
                  </div>
                </div>
                <div style={{border: "1px solid var(--divider, #e4e4e7)", borderRadius: "10px", padding: "12px"}}>
                  <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
                    Assignment fee
                  </div>
                  <div style={{fontWeight: "700", marginTop: "4px"}}>
                    {V.acceptedOffer!.assignment}
                  </div>
                </div>
                <div style={{border: "1px solid var(--divider, #e4e4e7)", borderRadius: "10px", padding: "12px"}}>
                  <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "600"}}>
                    Buyer EMD
                  </div>
                  <div style={{fontWeight: "700", marginTop: "4px"}}>
                    {V.acceptedOffer!.emd}
                  </div>
                </div>
              </div>
              <div style={{display: "flex", gap: "8px", marginTop: "14px"}}>
                <button className="dc10" onClick={V.generateAssignment} style={{height: "34px", padding: "0 14px", borderRadius: "9px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer"}}>
                  {V.assignLabel}
                </button>
                {V.can.tc ? (
                <button className="dc2" onClick={V.openTcFromDispo} style={{height: "34px", padding: "0 14px", borderRadius: "9px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", cursor: "pointer"}}>
                  Open TC file
                </button>
                ) : null}
              </div>
              </>
            ) : null}
            {(V.noAccepted) ? (
              <>
              <div style={{fontSize: "12.5px", color: "var(--meta, #71717a)", marginTop: "6px"}}>
                No accepted offer yet. Pick one on the 
                <button onClick={V.goOffersTab} style={{background: "none", border: "0", padding: "0", color: "var(--tx-mint, #0a8560)", cursor: "pointer", fontSize: "12.5px", fontWeight: "500"}}>
                  Offer desk
                </button>
                 and the assignment contract, buyer notice and TC file are created from it.
              </div>
              </>
            ) : null}
          </div>
          </>
        ) : null}
      </div>
      {rvmIds ? (
        <BulkCompose
          kind="buyer"
          channel="rvm"
          people={V.matches.flatMap((m) => rvmIds.includes(m.id) ? [{
            id: m.id, dbId: m.dbId, name: m.name, phone: m.phone, pref: m.pref, dnc: m.dnc, inactive: m.inactive,
          }] : [])}
          workspaceId={V.liveIds?.workspaceId ?? null}
          canWrite={!!V.liveIds?.canWrite}
          userId={session.user?.id ?? null}
          rep={{ repName: session.profile?.full_name ?? '', repPhone: session.profile?.phone ?? '', repEmail: session.user?.email ?? '' }}
          toast={V.showToast}
          onClose={() => setRvmIds(null)}
        />
      ) : null}
    </section>
  );
}
