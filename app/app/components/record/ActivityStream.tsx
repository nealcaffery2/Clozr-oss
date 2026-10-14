'use client';

// Activity: every call, text, email and note on the record in one stream,
// filtered by chips (All · Calls · Texts · Email · Notes). The chips are the
// old tabs' state (`personTab`), so they switch instantly and a hand-off that
// names a tab still lands. Pinned items first; older activity pages by 30.

import React, { useState } from 'react';
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
import { Chevron, CZ } from '@/components/ds/chrome';
import { MentionText } from './MentionField';
import { EmailThread } from './EmailThread';
import { Mark } from '@/components/ds/mark';

const DEMO_REVIEW = demoCoachingReview();
const PAGE = 30;

/** The chip row, with the timeline's User filter on the right. */
export function ActivityChips({ V }: { V: ClozrView }) {
  const f = V.timelineUserMenu;
  return (
    <div data-tabs style={{ display: 'flex', alignItems: 'center', gap: '2px', padding: V.isMobile ? '0 12px' : '0 16px', borderBottom: '1px solid #e4e4e7', background: '#fff', flex: 'none', minWidth: 0 }}>
      <div role="group" aria-label="Filter activity" style={{ display: 'flex', gap: '2px', minWidth: 0, flexWrap: 'wrap' }}>
        {V.recordChips.map((c) => (
          <button key={c.label} type="button" className="rec-chip" aria-pressed={c.pressed} onClick={c.go}
            style={{ height: '40px', padding: V.isMobile ? '0 8px' : '0 10px', border: 0, borderBottom: `2px solid ${c.pressed ? '#18181b' : 'transparent'}`, background: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 500, color: c.pressed ? '#18181b' : '#71717a', marginBottom: '-1px', whiteSpace: 'nowrap', fontFamily: 'var(--font-sans)' }}>
            {c.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ position: 'relative', marginRight: V.isMobile ? 0 : '10px', flex: 'none' }}>
        <button type="button" className="dc2 cz-menu-trigger" onClick={f.toggle} aria-expanded={f.open} style={{ height: '28px', padding: '0 10px', borderRadius: '10px', border: `1px solid ${f.border}`, background: f.bg, fontSize: '12px', cursor: 'pointer', color: f.color, fontWeight: f.on ? 600 : 500, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-sans)' }}>
          {f.on ? f.value : f.label}
          <Chevron size={11} color={f.on ? CZ.mint : CZ.faint} />
        </button>
        {f.open ? (
          <>
            <div onClick={V.closeFilterMenus} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
            <div ref={keepInView} style={{ position: 'absolute', top: '34px', right: 0, minWidth: '190px', background: 'var(--c-menu-bg)', border: '1px solid var(--c-menu-line)', borderRadius: '12px', boxShadow: '0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)', zIndex: 45, padding: '4px' }}>
              {f.options.map((o) => (
                <button key={o.label} type="button" className="dc2" onClick={o.go} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', width: '100%', textAlign: 'left', padding: '7px 9px', border: 0, borderRadius: '7px', background: o.on ? '#E7F8F1' : 'none', cursor: 'pointer', fontSize: '12.5px', color: o.on ? '#0A8560' : '#27272a', fontWeight: o.on ? 600 : 400, whiteSpace: 'nowrap' }}>
                  {o.label}
                  {o.on ? <span style={{ fontSize: '11px' }}>✓</span> : null}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
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
export function ActivityStream({ V, me }: { V: ClozrView; me: string | null }) {
  const [shown, setShown] = useState(PAGE);
  const all = V.timelineItems || [];
  const items = all.slice(0, shown);
  return (
    <div data-testid="record-activity">
    {(V.pinnedItems.length) ? (
      <button className="dc2" onClick={V.togglePins} aria-expanded={V.pinsOpen} style={{display: "flex", alignItems: "center", gap: "6px", width: "100%", margin: "0 0 10px", padding: "4px 6px", border: "0", borderRadius: "7px", background: "none", cursor: "pointer", fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#0A8560", fontWeight: "700"}}>
        <span style={{display: "inline-block", transform: V.pinsOpen ? "none" : "rotate(-90deg)", transition: "transform .12s"}}>▾</span>
        Pinned · {V.pinnedItems.length}
        <span style={{flex: "1", height: "1px", background: "#e4e4e7", marginLeft: "6px"}}></span>
      </button>
    ) : null}
    {[...(V.pinsOpen ? V.pinnedItems.map((t) => ({ ...t, inPinned: true })) : []), ...items.map((t) => ({ ...t, inPinned: false }))].map((t, t__i) => (
      <React.Fragment key={(t.inPinned ? 'pin:' : '') + t.id}>
      {(t__i > 0 && !t.inPinned && V.pinsOpen && V.pinnedItems.length && t__i === V.pinnedItems.length) ? (
        <div style={{margin: "0 0 12px", fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#a1a1aa", fontWeight: "600", paddingLeft: "6px"}}>All activity</div>
      ) : null}
      <div className="clozr-tl" style={{display: "grid", gridTemplateColumns: "30px minmax(0,1fr)", gap: "12px", paddingBottom: "16px"}}>
        <div style={{display: "flex", flexDirection: "column", alignItems: "center", minWidth: "0"}}>
          {(t.avatar || t.agent) ? (
            <UserAvatar name={t.who} src={t.avatar || null} size={30} radius="8px" border="1px solid #e4e4e7" />
          ) : (
          <span title={t.who} aria-label={t.who} style={{width: "30px", height: "30px", borderRadius: "8px", background: "#fff", border: "1px solid #e4e4e7", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "700", color: "#52525b", flex: "none", cursor: "default"}}>
            {t.talkr ? <TalkrMark size={16} /> : t.clozr ? <ClozrIcon size={8} /> : t.icon ? <Icon name={t.icon} size={15} /> : t.initials}
          </span>
          )}
          <span title={t.who} style={{maxWidth: "52px", marginTop: "3px", fontSize: "9.5px", lineHeight: "1.2", color: "#71717a", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
            {t.who.split(' ')[0]}
          </span>
          <span style={{flex: "1", width: "1px", background: "#e4e4e7", marginTop: "6px"}}></span>
        </div>
        <div style={{background: t.inPinned ? "#fbfefd" : "#fff", border: `1px solid ${t.inPinned ? "rgba(10, 133, 96,.28)" : "#e4e4e7"}`, borderRadius: "10px", padding: "12px 14px", minWidth: "0"}}>
          <div style={{display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap"}}>
            <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "10.5px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: t.color}}>
              <Mark label={t.chan} />
              {t.chan}
            </span>
            <span style={{fontWeight: "600", fontSize: "13px"}}>
              {t.title}
            </span>
            {(!t.email) ? (
            <span style={{fontSize: "12px", color: "#71717a"}}>
              · {t.who}
            </span>
            ) : null}
            {t.agentTag ? <AgentBadge /> : null}
            <span style={{flex: "1"}}></span>
            <span style={{fontSize: "11.5px", color: "#a1a1aa", whiteSpace: "nowrap"}}>
              {t.time}
            </span>
            <button className="clozr-tl-pin dc2" onClick={t.togglePin} aria-pressed={t.pinned} title={t.pinned ? `Pinned by ${t.pinnedBy} · unpin` : "Pin to top"} style={{height: "22px", padding: "0 6px", border: "0", borderRadius: "6px", background: "none", cursor: "pointer", fontSize: "11px", color: t.pinned ? "#0A8560" : "#71717a", fontWeight: t.pinned ? "600" : "400", whiteSpace: "nowrap"}}>
              📌{t.pinned ? (t.inPinned ? ` ${t.pinnedBy}` : "") : " Pin"}
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
            <div style={{fontSize: "13px", color: "#27272a", marginTop: "8px", lineHeight: "1.5", textWrap: "pretty"}}>
              <MentionText text={t.body} />
            </div>
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
              <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
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
                <div style={{fontSize: "10.5px", letterSpacing: ".1em", textTransform: "uppercase", color: "#0A8560", fontWeight: "600"}}>
                  AI summary
                </div>
                <div style={{fontSize: "13px", color: "#27272a", marginTop: "6px", lineHeight: "1.5"}}>
                  {t.ai.summary}
                </div>
                <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "1fr 1fr", gap: V.isMobile ? "10px" : "12px", marginTop: "10px", minWidth: "0"}}>
                  <div>
                    <div style={{fontSize: "10.5px", letterSpacing: ".08em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
                      Objections
                    </div>
                    {(t.objections || []).map((o, o__i) => (
                      <React.Fragment key={o__i}>
                      <div style={{fontSize: "12.5px", color: "#27272a", marginTop: "4px", display: "flex", gap: "6px"}}>
                        <span style={{color: "#d97706"}}>
                          •
                        </span>
                        {o.o}
                      </div>
                      </React.Fragment>
                    ))}
                  </div>
                  <div>
                    <div style={{fontSize: "10.5px", letterSpacing: ".08em", textTransform: "uppercase", color: "#71717a", fontWeight: "600"}}>
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
          Nothing here yet. Calls, texts, emails and notes on this seller show up as they happen.
        </div>
      ) : null}
    </div>
  );
}
