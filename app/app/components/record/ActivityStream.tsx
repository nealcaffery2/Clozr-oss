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
import { replyToEmail } from './EmailThread';
import { openReach } from './reach';
import { counterpartOf } from '@/lib/email-thread';
import { ChevronRight, Forward, MoreHorizontal, Reply } from 'lucide-react';
import { menuItem, menuPanel } from './ui';
import { PendingSends } from './PendingSends';
import { NoteThread } from './NoteThread';

const DEMO_REVIEW = demoCoachingReview();
const PAGE = 30;
/** A label inside an entry: sentence case, 11.5px / 600 / muted (DESIGN.md §1). */
const cap: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: 'var(--meta, #71717a)' };

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
              <button key={o.label} type="button" className="dc2" onClick={o.go} aria-pressed={o.on} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', width: '100%', minHeight: '30px', textAlign: 'left', padding: '6px 9px', border: 0, borderRadius: '7px', background: o.on ? 'var(--c-action-soft, #e7f5ef)' : 'none', cursor: 'pointer', fontSize: '12.5px', color: o.on ? 'var(--tx-mint-deep, #08694c)' : 'var(--ink-2, #27272a)', fontWeight: o.on ? 600 : 400, whiteSpace: 'nowrap' }}>
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
    <span style={{display: "inline-flex", alignItems: "center", height: "18px", padding: "0 6px", borderRadius: "6px", background: "var(--badge-teal-bg, #f0fdfa)", color: "var(--badge-teal-ink, #0f766e)", fontSize: "11px", fontWeight: "600", whiteSpace: "nowrap"}}>
      AI agent
    </span>
  );
}

/** The "..." on a stream item: pin, and for an email where else it lives. */
function ItemMenu({ items }: { items: { label: string; run: () => void }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
      <button type="button" className="dc2 rec-press tl-act" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ padding: '0 5px' }}>
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={keepInView} role="menu" style={{ ...menuPanel, position: 'absolute', top: '28px', right: 0, minWidth: '170px', zIndex: 45, border: '1px solid var(--c-menu-line)' }}
            onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
            {items.map((it) => (
              <button key={it.label} type="button" role="menuitem" className="dc2" onClick={() => { setOpen(false); it.run(); }} style={menuItem}>{it.label}</button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}

export type StreamItem = ClozrView['timelineItems'][number];

/** A buyer (or vendor) feed row in the seller stream's shape, so one renderer draws every record. */
export function feedToStream(t: ClozrView['buyerTimeline'][number], pin?: { is: (id: string, fallback: boolean) => boolean; toggle: (id: string, now: boolean) => void }): StreamItem {
  const pinned = pin ? pin.is(t.id, !!t.pinnedAt) : false;
  const base = {
    id: t.id, who: t.who, agent: false, agentTag: !!t.agentTag, actor: t.actor, toRep: t.toRep ?? null, line: t.line ?? null,
    time: t.time, title: t.title, body: t.body, hasBody: !!t.body, isCall: t.isCall, isSms: t.isSms, ai: t.ai, smsOut: false,
    callNote: null, email: t.email, pinned, pinnedBy: t.pinnedBy ?? '', togglePin: () => pin?.toggle(t.id, pinned), commId: t.commId, chan: t.chan, color: t.color,
    canEditNote: false, canDeleteCall: false,
    initials: t.who.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase(), avatar: t.rep?.avatar ?? '', icon: null, talkr: false, clozr: false,
    objections: t.ai ? t.ai.objections.map((o) => ({ o })) : [], at: null,
  };
  return { ...base, earlier: (t.earlier ?? []).map((m) => ({ ...feedToStream({ ...m, earlier: [] }), earlier: [] })) } as unknown as StreamItem;
}
export type StreamOrder = 'desc' | 'asc';
const ORDER_KEY = 'clozr-activity-order';
/** Newest at the bottom (asc, like a chat) unless this user flipped it. */
export function readOrder(): StreamOrder {
  try { return window.localStorage.getItem(ORDER_KEY) === 'desc' ? 'desc' : 'asc'; } catch { return 'asc'; }
}
export function saveOrder(o: StreamOrder) {
  try { window.localStorage.setItem(ORDER_KEY, o); } catch { /* not remembered, still flips */ }
}

/**
 * The stream itself. `me` is the signed-in user (call insight notes).
 * `items`: another record's rows in the same shape (the buyer record); then
 * `kind` says whose call insights to load and pins are off.
 * A vendor record passes its own `vendor` (name and id) to file replies on.
 */
export function ActivityStream({ V, me, empty, items: given, kind = 'seller', order = 'desc', vendor }: {
  V: ClozrView; me: string | null; empty?: string; items?: StreamItem[]; kind?: 'seller' | 'buyer' | 'vendor'; order?: StreamOrder;
  vendor?: { id: number; name: string };
}) {
  const [shown, setShown] = useState(PAGE);
  const source = given ?? V.timelineItems ?? [];
  const all = order === 'asc' ? source.slice().reverse() : source;
  const items = all.slice(0, shown);
  // The note being reworded in place (Edit note on its menu).
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  // The buyer hands its rows in; its pins are the pinned ones among them.
  const pins = given ? given.filter((t) => t.pinned).map((t) => ({ ...t, earlier: [] as typeof given })) : V.pinnedItems;
  const insightSeller = kind === 'seller' ? V.liveIds?.sellerId ?? null : null;
  const who = kind === 'vendor' ? vendor?.name ?? '' : kind === 'buyer' ? V.B.name : V.P.name;
  // Where a reply or forward is filed: this record's id, or nothing when it has none.
  const filing = kind === 'vendor' ? (vendor ? { vendorId: vendor.id } : null)
    : kind === 'buyer' ? (V.liveIds?.buyerId ? { buyerId: V.liveIds.buyerId } : null)
      : (V.liveIds?.sellerId ? { sellerId: V.liveIds.sellerId } : null);
  // Their colour in a call's waveform: the seller's heat, the buyer's type (DESIGN.md: flipper orange, landlord blue, builder teal).
  const theirColor = kind === 'vendor' ? '#2563eb' : kind === 'buyer' ? (/flip/i.test(V.B.type) ? '#ea580c' : /build/i.test(V.B.type) ? '#0d9488' : '#2563eb') : V.P.scoreColor;
  return (
    <div data-testid="record-activity">
    {kind !== 'vendor' ? <PendingSends V={V} kind={kind} /> : null}
    {(pins.length) ? (
      <button className="dc2" onClick={V.togglePins} aria-expanded={V.pinsOpen} style={{display: "flex", alignItems: "center", gap: "6px", width: "100%", minHeight: "28px", margin: "0 0 10px", padding: "4px 6px", border: "0", borderRadius: "7px", background: "none", cursor: "pointer", fontSize: "11.5px", color: "var(--tx-mint-deep, #08694c)", fontWeight: "600"}}>
        <Chevron dir={V.pinsOpen ? 'down' : 'right'} size={12} color="var(--tx-mint-deep, #08694c)" />
        Pinned · {pins.length}
        <span style={{flex: "1", height: "1px", background: "var(--divider, #e4e4e7)", marginLeft: "6px"}}></span>
      </button>
    ) : null}
    {[...(V.pinsOpen ? pins.map((t) => ({ ...t, inPinned: true })) : []), ...items.map((t) => ({ ...t, inPinned: false }))].map((t, t__i) => (
      <React.Fragment key={(t.inPinned ? 'pin:' : '') + t.id}>
      {(t__i > 0 && !t.inPinned && V.pinsOpen && pins.length && t__i === pins.length) ? (
        <div style={{margin: "0 0 12px", ...cap, paddingLeft: "6px"}}>All activity</div>
      ) : null}
      <div className="clozr-tl" style={{display: "grid", gridTemplateColumns: "40px minmax(0,1fr)", gap: "10px", paddingBottom: "16px"}}>
        <div style={{display: "flex", flexDirection: "column", alignItems: "center", minWidth: "0"}}>
          {(t.avatar || t.agent) ? (
            <UserAvatar name={t.who} src={t.avatar || null} size={30} radius="8px" border="1px solid var(--divider, #e4e4e7)" />
          ) : (
          <span title={t.who} aria-label={t.who} style={{width: "30px", height: "30px", borderRadius: "8px", background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: "700", color: "var(--muted, #52525b)", flex: "none", cursor: "default"}}>
            {t.talkr ? <TalkrMark size={16} /> : t.clozr ? <ClozrIcon size={8} /> : t.icon ? <Icon name={t.icon} size={15} /> : t.initials}
          </span>
          )}
          <span title={t.who} style={{maxWidth: "40px", marginTop: "3px", fontSize: "11px", lineHeight: "1.2", color: "var(--meta, #71717a)", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
            {t.who.split(' ')[0]}
          </span>
          <span style={{flex: "1", width: "1px", background: "var(--divider, #e4e4e7)", marginTop: "6px"}}></span>
        </div>
        <div style={{background: t.inPinned ? "var(--c-genius-soft, #fbfefd)" : "var(--surface, #fff)", border: `1px solid ${t.inPinned ? "rgba(10, 133, 96,.28)" : "var(--divider, #e4e4e7)"}`, borderRadius: "10px", padding: "12px 14px", minWidth: "0"}}>
          <div style={{display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap"}}>
            <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11.5px", fontWeight: "600", color: `color-mix(in srgb, ${t.color} 76%, #000)`}}>
              <Mark label={t.chan} />
              {t.chan}
            </span>
            <span style={{ fontWeight: 700, fontSize: '13.5px', color: 'var(--ink, #18181b)' }}>
              {t.title}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '12px', color: 'var(--meta, #71717a)', minWidth: 0 }}>
              <span style={{ color: 'var(--ink-2, #27272a)', fontWeight: 500 }}>{t.who}</span>
              {t.toRep || t.email?.to[0] ? <><ChevronRight size={12} aria-hidden style={{ flex: 'none' }} /><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.toRep || t.email?.to[0]}</span></> : null}
              {t.line ? <span> · {t.line}</span> : null}
            </span>
            {t.agentTag ? <AgentBadge /> : null}
            <span style={{flex: "1"}}></span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flex: 'none', marginLeft: 'auto' }}>
            <span className="rec-money" style={{fontSize: "11.5px", color: "var(--meta, #71717a)", whiteSpace: "nowrap", marginRight: '4px'}}>
              {t.time}
            </span>
            {t.pinned ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', fontWeight: 600, color: 'var(--tx-mint-deep, #08694c)', whiteSpace: 'nowrap' }}>
                <PinIcon />{t.inPinned ? t.pinnedBy : 'Pinned'}
              </span>
            ) : null}
            {t.email && (!V.liveIds || (V.liveIds.canWrite && filing)) ? (
              <>
                <button type="button" className="dc2 rec-press tl-act" onClick={() => replyToEmail(t.email!, !V.liveIds ? { name: who } : { name: who, ...filing, onSent: V.reloadCrm })} title={t.email.sourceId ? 'Reply in this Gmail thread' : 'Reply by email'}>
                  <Reply size={13} aria-hidden />Reply
                </button>
                <button type="button" className="dc2 rec-press tl-act" aria-label="Forward" title="Forward by email" onClick={() => openReach('email', {
                  name: who, email: null, subject: /^fwd?:/i.test(t.email!.subject) ? t.email!.subject : 'Fwd: ' + t.email!.subject,
                  body: `

---------- Forwarded message ----------
From: ${t.email!.fromName || t.email!.from}
To: ${t.email!.to.join(', ')}
Subject: ${t.email!.subject}

${t.email!.body}`,
                  ...(V.liveIds ? filing : null), audience: kind === 'vendor' ? 'any' : kind, onSent: V.reloadCrm,
                })}>
                  <Forward size={13} aria-hidden />
                </button>
              </>
            ) : null}
            <ItemMenu items={[
              ...(given && kind !== 'buyer' ? [] : [{ label: t.pinned ? 'Unpin' : 'Pin to top', run: t.togglePin }]),
              ...(t.canEditNote ? [{ label: 'Edit note', run: () => setEditing({ id: t.id, body: t.body }) }, { label: 'Delete note', run: () => void V.removeNote(t.id) }] : []),
              ...(t.canDeleteCall && (!given || kind === 'seller') ? [{ label: 'Delete call log', run: () => void V.removeCallLog(t.id) }] : []),
              ...(t.email && V.liveIds ? [{ label: 'Open in Inbox', run: () => V.openEmailInInbox(t.email!) }] : []),
              ...(t.email && counterpartOf(t.email) ? [{ label: 'Copy sender address', run: () => { void navigator.clipboard?.writeText(counterpartOf(t.email!) || ''); } }] : []),
            ]} />
            </span>
          </div>
          {(t.email) ? (
            <EmailThread
              latest={{ id: t.id, email: t.email, commId: t.commId, time: t.time }}
              earlier={t.earlier.flatMap((m) => (m.email ? [{ id: m.id, email: m.email, commId: m.commId, time: m.time }] : []))}
              workspaceId={V.liveIds?.workspaceId}
              onOpenInbox={V.liveIds ? () => V.openEmailInInbox(t.email!) : undefined}
              reply={!V.liveIds ? { name: who } : V.liveIds.canWrite && filing ? { name: who, ...filing, onSent: V.reloadCrm } : null}
            />
          ) : (editing && editing.id === t.id) ? (
            <form onSubmit={(e) => { e.preventDefault(); void V.saveNote(t.id, editing.body).then((ok) => { if (ok) setEditing(null); }); }} style={{ marginTop: '8px', display: 'grid', gap: '6px' }}>
              <textarea aria-label="Edit note" value={editing.body} onChange={(e) => setEditing({ id: t.id, body: e.target.value })} rows={3} autoFocus
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
                style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', font: 'inherit', fontSize: 'var(--ds-input-size, 13px)', lineHeight: 1.45, color: 'var(--ink, #18181b)', background: 'var(--surface, #fff)', resize: 'vertical', boxSizing: 'border-box' }} />
              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                <button type="button" className="dc2" onClick={() => setEditing(null)} style={{ height: '30px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', color: 'var(--ink, #18181b)' }}>Cancel</button>
                <button type="submit" className="dc3" style={{ height: '30px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--c-primary, #0a8560)', background: 'var(--c-primary, #0a8560)', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}>Save note</button>
              </div>
            </form>
          ) : (t.hasBody) ? (
            <>
            <div style={{fontSize: "13px", color: "var(--ink-2, #27272a)", marginTop: "8px", lineHeight: "1.5", textWrap: "pretty", overflowWrap: "anywhere"}}>
              <MentionText text={t.body} />
            </div>
            {t.smsOut ? <LinkReceipt text={t.body} workspaceId={V.liveIds?.workspaceId ?? null} /> : null}
            </>
          ) : null}
          {/* 2026-10-23: reactions and replies on a stored note (migration 410). */}
          {(t.chan === 'Note' && t.commId && V.liveIds) ? (
            <NoteThread communicationId={t.commId} workspaceId={V.liveIds.workspaceId} me={me} canWrite={V.liveIds.canWrite} nameOf={V.teammateName} />
          ) : null}
          {(t.isCall && t.commId && V.liveIds && (kind !== 'seller' || insightSeller)) ? (
            <CallInsight communicationId={t.commId} workspaceId={V.liveIds.workspaceId} sellerId={insightSeller} me={me} canWrite={V.liveIds.canWrite} prospectName={who} repName={kind === 'seller' ? V.P.assigned : undefined} contactColor={theirColor} onToast={V.showToast} onChanged={V.reloadCrm} />
          ) : null}
          {(t.isCall && !t.commId && t.ai && V.showAi) ? (
            <div style={{ marginTop: '10px', display: 'grid', gap: '8px' }}>
              <DemoCallRecording contactName={who} contactColor={theirColor} />
              <div style={{ padding: '12px', borderRadius: '10px', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)' }}>
                <CoachingReviewView review={DEMO_REVIEW} />
              </div>
            </div>
          ) : null}
          {(t.callNote) ? (
            <div style={{marginTop: "10px", padding: "10px 12px", borderRadius: "8px", background: "var(--canvas, #fafafa)", border: "1px solid var(--divider, #e4e4e7)"}}>
              <div style={cap}>
                Call note
              </div>
              <div style={{fontSize: "13px", color: "var(--ink-2, #27272a)", marginTop: "4px", lineHeight: "1.5", whiteSpace: "pre-wrap"}}>
                <MentionText text={t.callNote} />
              </div>
            </div>
          ) : null}
          {(t.isCall && t.ai) ? (
            <>
            {(V.showAi) ? (
              <>
              <div style={{marginTop: "10px", padding: "12px", borderRadius: "8px", background: "rgba(10, 133, 96,.05)", border: "1px solid rgba(10, 133, 96,.18)"}}>
                <div style={{...cap, color: "var(--tx-mint-deep, #08694c)"}}>
                  AI summary
                </div>
                <div style={{fontSize: "13px", color: "var(--ink-2, #27272a)", marginTop: "6px", lineHeight: "1.5"}}>
                  {t.ai.summary}
                </div>
                <div style={{display: "grid", gridTemplateColumns: V.isMobile ? "1fr" : "1fr 1fr", gap: V.isMobile ? "10px" : "12px", marginTop: "10px", minWidth: "0"}}>
                  <div>
                    <div style={cap}>
                      Objections
                    </div>
                    {(t.objections || []).map((o, o__i) => (
                      <React.Fragment key={o__i}>
                      <div style={{fontSize: "12.5px", color: "var(--ink-2, #27272a)", marginTop: "4px", display: "flex", gap: "6px"}}>
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
                    <div style={{fontSize: "12.5px", color: "var(--ink, #18181b)", fontWeight: "600", marginTop: "4px"}}>
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
          style={{ display: 'block', margin: '0 auto 8px', height: '30px', padding: '0 14px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12.5px', cursor: 'pointer', color: 'var(--ink, #18181b)' }}>
          Show older activity · {all.length - shown} more
        </button>
      ) : null}
      {all.length === 0 && !pins.length ? (
        <div style={{ background: 'var(--surface, #fff)', border: '1px dashed var(--divider, #e4e4e7)', borderRadius: '12px', padding: '24px', textAlign: 'center', fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>
          {empty ?? 'Nothing here yet. Calls, texts, emails and notes on this seller show up as they happen.'}
        </div>
      ) : null}
    </div>
  );
}
