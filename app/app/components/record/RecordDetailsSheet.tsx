'use client';

// Record details: the sections that moved off the record's page, in one
// sheet from the right. More ▾ opens it scrolled to the section you picked.
// Everything that writes data is still here — plans, appointments,
// contracts, the deal team, property records, files, the other sellers on the
// property, tags — or one tap away (the deal sheet, the TC's closing file).

import React, { useEffect, useRef } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ContractsCard } from '@/components/ContractsCard';
import { DealTeam } from '@/components/DealTeam';
import { DealFiles } from '@/components/DealFiles';
import { PropertyRecords } from '@/components/PropertyRecords';
import { PersonDeals } from '@/components/PersonDeals';
import { RecordCalendar } from '@/app/components/calendar/RecordCalendar';
import { TcFile } from './TcFile';
import { eyebrow, ghostBtn } from './ui';
import { useExit, useFocusTrap } from './useModal';
import { DEAL_SHEET_BTN } from './deal-sheet-style';

export type SectionKey = 'plan' | 'appointments' | 'contracts' | 'team' | 'deals' | 'records' | 'files' | 'sellers' | 'tags' | 'closing';

export const SECTION_LABELS: Record<SectionKey, string> = {
  plan: 'Action plan', appointments: 'Appointments', contracts: 'Contracts & documents', team: 'Deal team',
  deals: 'Deals on this contact', records: 'Property records', files: 'Files & links', sellers: 'Sellers on this property',
  tags: 'Tags & source', closing: 'Closing file',
};

const empty: React.CSSProperties = { fontSize: '12.5px', color: '#71717a', padding: '10px 12px', border: '1px dashed #e4e4e7', borderRadius: '9px', lineHeight: 1.5 };
const SIGNED_IN = 'on a signed-in workspace';

function Section({ k, component, children, title = true }: { k: SectionKey; component: string; children: React.ReactNode; title?: boolean }) {
  return (
    <section id={'rec-' + k} data-section={k} data-component={component} aria-label={SECTION_LABELS[k]} style={{ scrollMarginTop: '8px', padding: '14px 0', borderBottom: '1px solid #f0f0f1' }}>
      {title ? <h3 style={{ ...eyebrow, margin: '0 0 8px' }}>{SECTION_LABELS[k]}</h3> : null}
      {children}
    </section>
  );
}

export function RecordDetailsSheet({ V, me, at, onClosed }: { V: ClozrView; me: string | null; at: SectionKey; onClosed: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const { closing, close } = useExit(onClosed, 170);
  useFocusTrap(panel, close, 'button[aria-label="Close record details"]');
  useEffect(() => {
    const el = body.current?.querySelector<HTMLElement>('#rec-' + at);
    if (el && body.current) body.current.scrollTop = el.offsetTop - body.current.offsetTop;
  }, [at]);
  const live = V.liveIds;
  const top = V.isMobile ? 'calc(56px + env(safe-area-inset-top, 0px))' : '0';
  const bottom = V.isMobile ? 'calc(58px + env(safe-area-inset-bottom, 0px) + var(--clozr-callbar, 0px))' : 'var(--clozr-callbar, 0px)';

  return (
    <>
      <div className="rec-backdrop" data-closing={closing || undefined} onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 48, background: 'rgba(12,13,16,.18)' }} />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="rec-details-title" data-testid="record-details" className="rec-sheet" data-closing={closing || undefined}
        style={{ position: 'fixed', top, right: 0, bottom, width: V.isMobile ? '100%' : '520px', maxWidth: '100%', background: '#fff', borderLeft: V.isMobile ? 0 : '1px solid #e4e4e7', boxShadow: '0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)', zIndex: 49, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', borderBottom: '1px solid #e4e4e7' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 id="rec-details-title" style={{ margin: 0, fontSize: '14px', fontWeight: 700 }}>Record details</h2>
            <div style={{ fontSize: '11.5px', color: '#71717a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{V.P.name} · {V.P.addr}</div>
          </div>
          <button type="button" aria-label="Close record details" className="dc2 rec-press" onClick={close} style={{ ...ghostBtn, width: V.isMobile ? '44px' : '30px', height: V.isMobile ? '44px' : '30px', padding: 0, fontSize: '16px' }}>×</button>
        </div>
        <div ref={body} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 16px 24px', position: 'relative' }}>
          {V.hasTcFile ? (
            <Section k="closing" component="TcFile">
              <TcFile V={V} readOnly={!V.can.tc} />
            </Section>
          ) : null}

          <Section k="plan" component="ActionPlan">
              {(V.hasPersonPlan) ? (
                <>
                <div style={{marginTop: "6px", padding: "10px", border: "1px solid #e4e4e7", borderRadius: "9px"}}>
                  <div style={{display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "12.5px"}}>
                    <button className="dc12" onClick={V.personPlan!.open} style={{fontWeight: "600", background: "none", border: "0", padding: "0", cursor: "pointer", textAlign: "left", color: "#18181b", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {V.personPlan!.name}
                    </button>
                    <span style={{color: "#16a34a", fontWeight: "600", whiteSpace: "nowrap"}}>
                      Step {V.personPlan!.step} / {V.personPlan!.total}
                    </span>
                  </div>
                  <div style={{height: "4px", background: "#f0f0f1", borderRadius: "2px", marginTop: "8px", overflow: "hidden"}}>
                    <div style={{width: V.personPlan!.pct, height: "100%", background: "#0A8560"}}></div>
                  </div>
                  <div style={{fontSize: "11.5px", color: "#71717a", marginTop: "6px"}}>
                    {V.personPlan!.nextLabel} · {V.personPlan!.statusNote}
                  </div>
                  <div style={{display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap"}}>
                    <button className="dc2" data-testid="record-plan-play-pause" onClick={V.personPlan!.paused ? V.personPlan!.resume : V.personPlan!.pause} style={{height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid #0A8560", background: V.personPlan!.paused ? "#fff" : "#E7F8F1", fontSize: "11.5px", fontWeight: "650", cursor: "pointer", color: "#0A8560"}}>
                      {V.personPlan!.paused ? '▶ Play' : '❚❚ Pause'}
                    </button>
                    <button className="dc2" onClick={V.personPlan!.open} style={{height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11.5px", cursor: "pointer", color: "#18181b"}}>
                      Open plan
                    </button>
                    <button className="dc2" onClick={V.personPlan!.stop} style={{height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11.5px", cursor: "pointer", color: "#52525b"}}>
                      Stop
                    </button>
                  </div>
                </div>
                </>
              ) : null}
              {(!V.hasPersonPlan) ? (
                <>
                <div style={{marginTop: "6px", padding: "10px", border: "1px dashed #e4e4e7", borderRadius: "9px"}}>
                  <div style={{fontSize: "12px", color: "#71717a", marginBottom: "7px"}}>
                    Not on an action plan.
                  </div>
                  <select value="" onChange={V.startPlanFor} style={{width: "100%", height: "30px", padding: "0 8px", border: "1px solid #e4e4e7", borderRadius: "8px", fontSize: "12.5px", outline: "0", background: "#fafafa", color: "#18181b", cursor: "pointer", fontFamily: "inherit"}}>
                    <option value="">
                      Start an action plan…
                    </option>
                    {(V.planPickerOptions || []).map((o, o__i) => (
                      <React.Fragment key={o__i}>
                      <option value={o.v}>
                        {o.label}
                      </option>
                      </React.Fragment>
                    ))}
                  </select>
                  <button className="dc3" onClick={V.aiPlanForLead} disabled={V.planDrafting} title="Claude reads every call, text and note on this record and writes a sequence for this seller" style={{marginTop: "8px", width: "100%", height: "30px", borderRadius: "8px", border: "1px solid #0A8560", background: "#0A8560", color: "#fff", fontSize: "12px", fontWeight: "600", cursor: "pointer", opacity: V.planDrafting ? 0.6 : 1}}>
                    {V.planDrafting ? 'Reading the history…' : 'AI action plan from this lead\u2019s history'}
                  </button>
                </div>
                </>
              ) : null}
          </Section>

          <Section k="appointments" component="RecordCalendar">
            {live?.sellerId != null ? (
              <RecordCalendar workspaceId={live.workspaceId} sellerId={live.sellerId} sellerName={V.P.name} sellerEmail={V.P.email} sellerPhone={V.P.phone} address={V.P.addr} me={me} canWrite={live.canWrite} onToast={V.showToast} />
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr', gap: '8px', padding: '8px 0', borderBottom: '1px solid #f0f0f1' }}>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: '#52525b', border: '1px solid #e4e4e7', borderRadius: '6px', textAlign: 'center', padding: '4px 0', lineHeight: 1.2 }}>SAT<br />6</span>
                  <span>
                    <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 500 }}>Walkthrough with brother on speaker</span>
                    <span style={{ display: 'block', fontSize: '11.5px', color: '#71717a' }}>10:00 AM · {V.P.addr}</span>
                  </span>
                </div>
                <button type="button" className="dc2 rec-press" onClick={V.addAppointment} style={{ ...ghostBtn, marginTop: '8px', fontSize: '12px' }}>+ Appointment</button>
              </>
            )}
          </Section>

          <Section k="contracts" component="ContractsCard">
            {live?.sellerId != null ? (
              <ContractsCard compact workspaceId={live.workspaceId} sellerId={live.sellerId} dealId={live.dealId} seller={{ name: V.P.name, email: V.P.email, phone: V.P.phone }} canWrite={live.canWrite} onToast={V.showToast} onChanged={V.reloadCrm} />
            ) : <div style={empty}>Purchase agreements and offer letters are drafted, signed and stored {SIGNED_IN}. Contract: {V.offerCard.contract}.</div>}
          </Section>

          <Section k="team" component="DealTeam">
            {live?.sellerId != null ? (
              <DealTeam bare sellerId={live.sellerId} dealId={live.dealId} onCall={V.callParty} onOpenSeller={(id) => V.openPerson('s' + id)} onOpenBuyer={(id) => V.openBuyerRecord('b' + id)} onOpenVendor={V.openVendorContact} onChanged={V.reloadCrm} />
            ) : <div style={empty}>Title, agents, attorneys and lenders on this deal are listed {SIGNED_IN}.</div>}
          </Section>

          <Section k="deals" component="PersonDeals">
            {(V.personDeals || []).length > 1 ? <PersonDeals rows={V.personDeals} /> : (
              <div style={empty}>{(V.personDeals || []).length === 1 ? 'One deal on this contact: ' + V.personDeals[0].addr + '.' : 'No other deals on this contact.'}
                {V.can.dealSheet ? <> <button type="button" className="dc12" onClick={() => V.openDealSheet()} style={{ ...DEAL_SHEET_BTN, height: '34px', fontSize: '13px', marginTop: '6px' }}>Open the deal sheet</button></> : null}
              </div>
            )}
          </Section>

          <Section k="records" component="PropertyRecords">
            {live?.sellerId != null ? <PropertyRecords sellerId={live.sellerId} reloadKey={V.comprRanLabel} /> : (
              <div style={empty}>County records (owner, sale history, liens) load {SIGNED_IN}. <button type="button" className="dc12" onClick={V.openPropertyData} style={{ border: 0, background: 'none', padding: 0, color: '#0A8560', cursor: 'pointer', fontSize: '12.5px' }}>Property data</button></div>
            )}
          </Section>

          <Section k="files" component="DealFiles">
            {live?.dealId != null ? (
              <DealFiles
                workspaceId={live.workspaceId}
                dealId={live.dealId}
                canWrite={live.canWrite}
                onToast={V.showToast}
                onOpenPhotos={(title, urls, start) => V.openPhotoShow(title, urls, live.dealId, start)}
                fallbackPhotos={V.P.photos.length ? V.P.photos : [V.P.streetSafe].filter(Boolean)}
              />
            ) : <div style={empty}>No deal on this record yet. Photos, docs and links attach to a deal, so they show on the deal sheet and in dispo too.</div>}
          </Section>

          <Section k="sellers" component="SellersOnProperty" title={false}>
              <div style={{border: "1px solid #e4e4e7", borderRadius: "12px", overflow: "hidden", background: "#fff"}}>
                <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid #f0f0f1"}}>
                  <span style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
                    Sellers on this property
                  </span>
                  <span style={{fontSize: "11px", color: "#a1a1aa", fontVariantNumeric: "tabular-nums"}}>
                    {V.sellerCount}
                  </span>
                </div>
                {(V.sellersOnProperty || []).map((p, p__i) => (
                  <React.Fragment key={p__i}>
                  <button className="dc2" onClick={p.go} style={{display: "grid", gridTemplateColumns: "26px minmax(0,1fr) auto", gap: "9px", alignItems: "center", width: "100%", textAlign: "left", padding: "8px 12px", border: "0", borderBottom: "1px solid #f0f0f1", background: p.bg, cursor: "pointer"}}>
                    <span style={{width: "26px", height: "26px", borderRadius: "7px", background: "#f4f4f5", display: "grid", placeItems: "center", fontSize: "9.5px", fontWeight: "700", color: "#52525b"}}>
                      {p.initials}
                    </span>
                    <span style={{minWidth: "0"}}>
                      <span style={{display: "block", fontSize: "12.5px", fontWeight: "600", color: "#18181b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                        {p.name}
                      </span>
                      <span className="clozr-contact" style={{display: "block", fontSize: "11px"}}>
                        {p.phone}
                      </span>
                    </span>
                    <span style={{fontSize: "10px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: p.isCurrent ? "#0A8560" : "#a1a1aa", whiteSpace: "nowrap"}}>
                      {p.role}
                    </span>
                  </button>
                  </React.Fragment>
                ))}
                <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", padding: "10px 12px"}}>
                  <button className="dc2" onClick={V.addSeller} style={{height: "30px", borderRadius: "8px", border: "1px dashed #d4d4d8", background: "#fff", fontSize: "12px", fontWeight: "500", cursor: "pointer", color: "#18181b"}}>
                    + Add seller
                  </button>
                  {(!V.hasAddress) ? (
                    <button className="dc3" onClick={V.setAddress} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid #0A8560", background: "#0A8560", color: "#fff", fontSize: "12px", fontWeight: "600", cursor: "pointer"}}>
                      Set address
                    </button>
                  ) : V.canEditAddress ? (
                    <button className="dc2" data-testid="details-edit-address" onClick={V.editAddress} style={{height: "30px", borderRadius: "8px", border: "1px solid #d4d4d8", background: "#fff", fontSize: "12px", fontWeight: "500", cursor: "pointer", color: "#18181b"}}>
                      Edit address
                    </button>
                  ) : null}
                  <button className="dc2" onClick={V.addProperty} style={{height: "30px", borderRadius: "8px", border: "1px dashed #d4d4d8", background: "#fff", fontSize: "12px", fontWeight: "500", cursor: "pointer", color: "#18181b"}}>
                    + New property
                  </button>
                </div>
              </div>
          </Section>

          <Section k="tags" component="Tags">
            <div style={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '10px', padding: '6px 0', borderBottom: '1px solid #f0f0f1', fontSize: '12.5px' }}>
              <span style={{ color: '#71717a' }}>Source</span>
              <span style={{ fontWeight: 500 }}>{V.P.source}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '10px', padding: '8px 0', fontSize: '12.5px' }}>
              <span style={{ color: '#71717a' }}>Tags</span>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {(V.P.tags || []).map((t) => (
                  <span key={t.t} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '2px 4px 2px 7px', border: '1px solid #e4e4e7', borderRadius: '6px', color: '#52525b', background: '#fafafa' }}>
                    {t.t}
                    <button type="button" onClick={t.remove} aria-label={'Remove tag ' + t.t} title="Remove tag" style={{ border: 0, background: 'none', minWidth: V.isMobile ? '26px' : 0, padding: V.isMobile ? 0 : '0 2px', color: '#a1a1aa', cursor: 'pointer', fontSize: V.isMobile ? '15px' : '12px', lineHeight: 1, alignSelf: 'stretch' }}>×</button>
                  </span>
                ))}
                <button type="button" className="dc14" onClick={V.addTag} style={{ fontSize: '11px', padding: '2px 7px', border: '1px dashed #d4d4d8', borderRadius: '6px', color: '#a1a1aa', background: 'none', cursor: 'pointer' }}>+ tag</button>
              </span>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
