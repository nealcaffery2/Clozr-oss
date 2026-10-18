'use client';

// Activity: every call, text, email and note on the record in one stream,
// under the record's tab row (Activity, Calls, Texts, Email, Notes, then
// Automations, History, Details and Submission; record-tabs.ts). The tab is
// the view's `personTab`, so it switches instantly and a hand-off that names
// a tab still lands. Pinned items first; older activity pages by 30.

import React, { useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { keepInView } from '@/components/ds/keepInView';
import { UserAvatar } from '@/components/UserAvatar';
import { ClozrIcon } from '@/components/ds/ClozrMark';
import { TalkrMark } from '@/app/components/brand/TalkrMark';
import { Icon } from '@/app/components/talkr/Icon';
import { CallInsight } from './CallInsight';
import { DemoCallRecording } from './CallRecording';
import { CoachingReviewView } from '@/app/components/talkr/CoachingReviewCard';
import { demoCoachingReview } from '@/lib/call-coaching';
import { Chevron, CZ, MenuCheck } from '@/components/ds/chrome';
import { MentionText } from './MentionField';
import { EmailThread } from './EmailThread';
import { Mark } from '@/components/ds/mark';
import { LinkReceipt } from '@/app/components/inbox/ReceiptLine';
import { stepTab, tabOf, type RecordTab, type RecordTabKey } from './record-tabs';

const DEMO_REVIEW = demoCoachingReview();
const PAGE = 30;
/** A label inside an entry: sentence case, 11.5px / 600 / muted (DESIGN.md §1). */
const cap: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: '#71717a' };

/** Lucide's pin, for Pin to top. */
function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: 'none' }}>
      <path d="M12 17v5" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

/** The timeline's User filter, at the right end of the tab row on the stream tabs. */
export function UserFilter({ V }: { V: ClozrView }) {
  const f = V.timelineUserMenu;
  return (
    <div style={{ position: 'relative', flex: 'none', marginLeft: '8px' }}>
      <button type="button" className="dc2 cz-menu-trigger rec-press" onClick={f.toggle} aria-expanded={f.open} aria-haspopup="true"
        aria-label={f.on ? `Activity by ${f.value}. Change who` : 'Filter activity by who did it'}
        style={{ height: '28px', padding: '0 10px', borderRadius: '8px', border: `1px solid ${f.border}`, background: f.bg, fontSize: '12px', cursor: 'pointer', color: f.color, fontWeight: f.on ? 600 : 500, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-sans)' }}>
        {f.on ? f.value : f.label}
        <Chevron size={11} color={f.on ? CZ.mint : CZ.faint} />
      </button>
      {f.open ? (
        <>
          <div onClick={V.closeFilterMenus} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={keepInView} style={{ position: 'absolute', top: '34px', right: 0, minWidth: '190px', background: 'var(--c-menu-bg)', border: '1px solid var(--c-menu-line)', borderRadius: '12px', boxShadow: 'var(--shadow-md)', zIndex: 45, padding: '4px' }}>
            {f.options.map((o) => (
              <button key={o.label} type="button" className="dc2" onClick={o.go} aria-pressed={o.on} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', width: '100%', minHeight: '30px', textAlign: 'left', padding: '6px 9px', border: 0, borderRadius: '7px', background: o.on ? '#E7F5EF' : 'none', cursor: 'pointer', fontSize: '12.5px', color: o.on ? '#08694C' : '#27272a', fontWeight: o.on ? 600 : 400, whiteSpace: 'nowrap' }}>
                {o.label}
                <MenuCheck on={o.on} />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The record's tab row (record-tabs.ts): a WAI-ARIA tablist. Left and right
 * arrows move between tabs and select as they go, Home and End jump to the
 * ends; the arrows never reach the record's previous/next person keys while
 * a tab has focus. A thin rule separates the feeds, the logs and the record.
 */
export function RecordTabs({ V, tabs, current, onPick, idBase }: {
  V: ClozrView;
  tabs: readonly RecordTab[];
  current: RecordTabKey;
  onPick: (key: RecordTabKey) => void;
  idBase: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<RecordTabKey, HTMLButtonElement | null>>>({});
  const keys = tabs.map((t) => t.key);
  // On a phone the row scrolls sideways: keep the selected tab in view
  // without moving the page.
  useEffect(() => {
    const row = listRef.current;
    const b = tabRefs.current[current];
    if (!row || !b || row.scrollWidth <= row.clientWidth) return;
    const left = b.offsetLeft;
    const right = left + b.offsetWidth;
    if (left < row.scrollLeft) row.scrollLeft = Math.max(0, left - 16);
    else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 16;
  }, [current]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const next = stepTab(keys, current, e.key);
    if (!next) return;
    e.preventDefault();
    onPick(next);
    tabRefs.current[next]?.focus();
  };
  return (
    <div className={'rec-tabs' + (V.isMobile ? ' rec-tabs-phone' : '')} data-tabs>
      <div ref={listRef} role="tablist" aria-label="Record" className="rec-tablist" onKeyDown={onKeyDown}>
        {tabs.map((t, i) => (
          <React.Fragment key={t.key}>
            {i > 0 && tabs[i - 1].group !== t.group ? <span aria-hidden className="rec-tab-rule" /> : null}
            <button
              ref={(el) => { tabRefs.current[t.key] = el; }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${t.key}`}
              aria-controls={`${idBase}-panel`}
              aria-selected={t.key === current}
              tabIndex={t.key === current ? 0 : -1}
              className="rec-tab"
              data-tab={t.key}
              onClick={() => onPick(t.key)}
            >
              {t.label}
            </button>
          </React.Fragment>
        ))}
      </div>
      {tabOf(current).stream ? <UserFilter V={V} /> : null}
    </div>
  );
}

/** Beside the name on a message an AI agent sent, so "Text sent · Riley" does not read as a teammate. */
export function AgentBadge() {
  return (
    <span style={{display: "inline-flex", alignItems: "center", height: "18px", padding: "0 6px", borderRadius: "6px", background: "#f0fdfa", color: "#0f766e", fontSize: "11px", fontWeight: "600", whiteSpace: "nowrap"}}>
      AI agent
    </span>
  );
}

/** The stream itself. `me` is the signed-in user (call insight notes). */
export function ActivityStream({ V, me, empty }: { V: ClozrView; me: string | null; empty?: string }) {
  const [shown, setShown] = useState(PAGE);
  const all = V.timelineItems || [];
  const items = all.slice(0, shown);
  return (
    <div data-testid="record-activity">
    {(V.pinnedItems.length) ? (
      <button className="dc2" onClick={V.togglePins} aria-expanded={V.pinsOpen} style={{display: "flex", alignItems: "center", gap: "6px", width: "100%", minHeight: "28px", margin: "0 0 10px", padding: "4px 6px", border: "0", borderRadius: "7px", background: "none", cursor: "pointer", fontSize: "11.5px", color: "#08694C", fontWeight: "600"}}>
        <Chevron dir={V.pinsOpen ? 'down' : 'right'} size={12} color="#08694C" />
        Pinned · {V.pinnedItems.length}
        <span style={{flex: "1", height: "1px", background: "#e4e4e7", marginLeft: "6px"}}></span>
      </button>
    ) : null}
    {[...(V.pinsOpen ? V.pinnedItems.map((t) => ({ ...t, inPinned: true })) : []), ...items.map((t) => ({ ...t, inPinned: false }))].map((t, t__i) => (
      <React.Fragment key={(t.inPinned ? 'pin:' : '') + t.id}>
      {(t__i > 0 && !t.inPinned && V.pinsOpen && V.pinnedItems.length && t__i === V.pinnedItems.length) ? (
        <div style={{margin: "0 0 12px", ...cap, paddingLeft: "6px"}}>All activity</div>
      ) : null}
      <div className="clozr-tl" style={{display: "grid", gridTemplateColumns: "40px minmax(0,1fr)", gap: "10px", paddingBottom: "16px"}}>
        <div style={{display: "flex", flexDirection: "column", alignItems: "center", minWidth: "0"}}>
          {(t.avatar || t.agent) ? (
            <UserAvatar name={t.who} src={t.avatar || null} size={30} radius="8px" border="1px solid #e4e4e7" />
          ) : (
          <span title={t.who} aria-label={t.who} style={{width: "30px", height: "30px", borderRadius: "8px", background: "#fff", border: "1px solid #e4e4e7", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "700", color: "#52525b", flex: "none", cursor: "default"}}>
            {t.talkr ? <TalkrMark size={16} /> : t.clozr ? <ClozrIcon size={8} /> : t.icon ? <Icon name={t.icon} size={15} /> : t.initials}
          </span>
          )}
          <span title={t.who} style={{maxWidth: "40px", marginTop: "3px", fontSize: "11px", lineHeight: "1.2", color: "#71717a", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
            {t.who.split(' ')[0]}
          </span>
          <span style={{flex: "1", width: "1px", background: "#e4e4e7", marginTop: "6px"}}></span>
        </div>
        <div style={{background: t.inPinned ? "#fbfefd" : "#fff", border: `1px solid ${t.inPinned ? "rgba(10, 133, 96,.28)" : "#e4e4e7"}`, borderRadius: "10px", padding: "12px 14px", minWidth: "0"}}>
          <div style={{display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap"}}>
            <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11.5px", fontWeight: "600", color: `color-mix(in srgb, ${t.color} 76%, #000)`}}>
              <Mark label={t.chan} />
              {t.chan}
            </span>
            <span style={{fontWeight: "600", fontSize: "13px"}}>
              {t.title}
            </span>
            {(!t.email) ? (
            <span style={{fontSize: "12px", color: "#71717a"}}>
              · {t.who}{t.toRep ? ` to ${t.toRep}` : ''}{t.line ? ` · ${t.line}` : ''}
            </span>
            ) : null}
            {t.agentTag ? <AgentBadge /> : null}
            <span style={{flex: "1"}}></span>
            <span className="rec-money" style={{fontSize: "11.5px", color: "#71717a", whiteSpace: "nowrap"}}>
              {t.time}
            </span>
            <button className="clozr-tl-pin dc2" onClick={t.togglePin} aria-pressed={t.pinned} title={t.pinned ? `Pinned by ${t.pinnedBy} · unpin` : "Pin to top"} style={{height: "24px", padding: "0 6px", border: "0", borderRadius: "6px", background: "none", cursor: "pointer", fontSize: "11.5px", color: t.pinned ? "#08694C" : "#71717a", fontWeight: t.pinned ? "600" : "400", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "4px"}}>
              <PinIcon />{t.pinned ? (t.inPinned ? ` ${t.pinnedBy}` : "") : " Pin"}
            </button>
          </div>
          {(t.email) ? (
            <EmailThread
              latest={{ id: t.id, email: t.email, commId: t.commId, time: t.time }}
              earlier={t.earlier.flatMap((m) => (m.email ? [{ id: m.id, email: m.email, commId: m.commId, time: m.time }] : []))}
              workspaceId={V.liveIds?.workspaceId}
              onOpenInbox={V.liveIds ? () => V.openEmailInInbox(t.email!) : undefined}
              reply={!V.liveIds ? { name: V.P.name } : V.liveIds.canWrite && V.liveIds.sellerId ? { name: V.P.name, sellerId: V.liveIds.sellerId, onSent: V.reloadCrm } : null}
            />
          ) : (t.hasBody) ? (
            <>
            <div style={{fontSize: "13px", color: "#27272a", marginTop: "8px", lineHeight: "1.5", textWrap: "pretty", overflowWrap: "anywhere"}}>
              <MentionText text={t.body} />
            </div>
            {t.smsOut ? <LinkReceipt text={t.body} workspaceId={V.liveIds?.workspaceId ?? null} /> : null}
            </>
          ) : null}
          {(t.isCall && t.commId && V.liveIds?.sellerId) ? (
            <CallInsight communicationId={t.commId} workspaceId={V.liveIds.workspaceId} sellerId={V.liveIds.sellerId} me={me} canWrite={V.liveIds.canWrite} prospectName={V.P.name} repName={V.P.assigned} onToast={V.showToast} onChanged={V.reloadCrm} />
          ) : null}
          {(t.isCall && !t.commId && t.ai && V.showAi) ? (
            <div style={{ marginTop: '10px', display: 'grid', gap: '8px' }}>
              <DemoCallRecording contactName={V.P.name} />
              <div style={{ padding: '12px', borderRadius: '10px', background: '#fff', border: '1px solid #e4e4e7' }}>
                <CoachingReviewView review={DEMO_REVIEW} />
              </div>
            </div>
          ) : null}
          {(t.callNote) ? (
            <div style={{marginTop: "10px", padding: "10px 12px", borderRadius: "8px", background: "#fafafa", border: "1px solid #e4e4e7"}}>
              <div style={cap}>
                Call note
              </div>
              <div style={{fontSize: "13px", color: "#27272a", marginTop: "4px", lineHeight: "1.5", whiteSpace: "pre-wrap"}}>
                <MentionText text={t.callNote} />
              </div>
            </div>
          ) : null}
          {(t.isCall && t.ai) ? (
            <>
            {(V.showAi) ? (
              <>
              <div style={{marginTop: "10px", padding: "12px", borderRadius: "8px", background: "rgba(10, 133, 96,.05)", border: "1px solid rgba(10, 133, 96,.18)"}}>
                <div style={{...cap, color: "#08694C"}}>
                  AI summary
                </div>
                <div style={{fontSize: "13px", color: "#27272a", marginTop: "6px", lineHeight: "1.5"}}>
                  {t.ai.summary}
                </div>
                <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "1fr 1fr", gap: V.isMobile ? "10px" : "12px", marginTop: "10px", minWidth: "0"}}>
                  <div>
                    <div style={cap}>
                      Objections
                    </div>
                    {(t.objections || []).map((o, o__i) => (
                      <React.Fragment key={o__i}>
                      <div style={{fontSize: "12.5px", color: "#27272a", marginTop: "4px", display: "flex", gap: "6px"}}>
                        <span aria-hidden style={{width: "5px", height: "5px", borderRadius: "999px", background: "#b45309", flex: "none", marginTop: "7px"}} />
                        {o.o}
                      </div>
                      </React.Fragment>
                    ))}
                  </div>
                  <div>
                    <div style={cap}>
                      Next best action
                    </div>
                    <div style={{fontSize: "12.5px", color: "#18181b", fontWeight: "600", marginTop: "4px"}}>
                      {t.ai.next}
                    </div>
                    <button className="dc3" onClick={() => V.openOfferSheet(V.P.id)} style={{marginTop: "6px", height: "26px", padding: "0 10px", borderRadius: "7px", border: "0", background: "#0A8560", color: "#fff", fontSize: "12px", fontWeight: "600", cursor: "pointer"}}>
                      Build revised offer
                    </button>
                  </div>
                </div>
              </div>
              </>
            ) : null}
            </>
          ) : null}
        </div>
      </div>
      </React.Fragment>
    ))}

      {all.length > shown ? (
        <button type="button" className="dc2 rec-press" onClick={() => setShown((n) => n + PAGE)}
          style={{ display: 'block', margin: '0 auto 8px', height: '30px', padding: '0 14px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12.5px', cursor: 'pointer', color: '#18181b' }}>
          Show older activity · {all.length - shown} more
        </button>
      ) : null}
      {all.length === 0 && !V.pinnedItems.length ? (
        <div style={{ background: '#fff', border: '1px dashed #e4e4e7', borderRadius: '12px', padding: '24px', textAlign: 'center', fontSize: '12.5px', color: '#71717a' }}>
          {empty ?? 'Nothing here yet. Calls, texts, emails and notes on this seller show up as they happen.'}
        </div>
      ) : null}
    </div>
  );
}
