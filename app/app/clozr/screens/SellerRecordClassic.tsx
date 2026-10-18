// The classic seller record, the default layout. Settings › Try new design
// swaps it for the deal page (SellerRecord.tsx), per user. Both draw the same
// record components, so fixes to them land in both.
//
// Desktop: a header toolbar (Call, Text, Email, More ▾); on the left who they
// are, the stage, the property and what we know; in the middle one activity
// stream and one composer; on the right Next action, tasks, the CLOZR AI card
// and the offer. Everything else lives behind More ▾ in the Record details
// sheet. Phone: one column with the composer docked above the tab bar.
//
// Single keys, only on this screen and never while typing or with a sheet,
// menu or dialog up: C call, T text, E email, O make offer, S move stage.
// Arrows walk the active smart list (previous/next person) and ctrl+left/right
// steps this record's stage. The same guards apply, and the photo slideshow
// and quick compose keep left/right for themselves.
'use client';

import { ContractPopup } from '@/components/ContractsHub';
import { BackLink } from '@/components/ds/BackLink';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { BlacklistButton } from '@/components/BlacklistButton';
import { useSession } from '@/lib/session';
import { NextActionCard } from '@/app/components/record/NextActionCard';
import { RecordHeader } from '@/app/components/record/RecordHeader';
import { openMeetingInvite } from '@/app/components/meeting/MeetingInvite';
import { Identity, PropertyCard } from '@/app/components/record/PropertyCard';
import { StageCard } from '@/app/components/record/StageCard';
import { OutcomeBar } from '@/app/components/record/OutcomeBar';
import { WhatWeKnow } from '@/app/components/record/WhatWeKnow';
import { ActivityStream } from '@/app/components/record/ActivityStream';
import { ActivityChips } from '@/app/components/record/ActivityChips';
import { Composer } from '@/app/components/record/Composer';
import { OfferSheet } from '@/app/components/record/OfferSheet';
import { RecordDetailsSheet, SECTION_LABELS, type SectionKey } from '@/app/components/record/RecordDetailsSheet';
import { RecordActionPlans, AiRecommended } from '@/app/components/record/RailCards';
import { ContractTemplatePicker } from '@/components/ContractTemplatePicker';
import { ContractsBlock, DealTeamBlock, FilesBlock, MORE_GROUPS } from '@/app/components/record/RecordBlocks';
import { Icon } from '@/app/components/talkr/Icon';
import type { MoreItem } from '@/app/components/record/MoreMenu';
import { BulkSkipTrace } from '@/components/BulkSkipTrace';
import { CenteredDialog } from '@/components/ContractsHub';
import { shortcutAllowed } from '@/app/components/record/record-logic';
import { isArchiveKey, isTypingTarget, peopleNavAction, recordNavBlocked } from '@/lib/people-keys';
import { useRailPrefs } from '@/app/components/record/useRailPrefs';
import '@/app/components/record/record.css';
import { DEAL_SHEET_BTN } from '@/app/components/record/deal-sheet-style';

/** Old tab names another screen may still hand over, and where they live now. */
const TAB_TO_SECTION: Record<string, SectionKey> = { TC: 'closing', 'Files & Links': 'files' };
const CHIP_TABS = ['Activity', 'Calls', 'Texts', 'Emails', 'Notes'];

function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details style={{ border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', background: 'var(--surface, #fff)' }}>
      <summary style={{ minHeight: '44px', display: 'flex', alignItems: 'center', padding: '0 12px', cursor: 'pointer', fontSize: '13px', color: 'var(--ink, #18181b)', fontWeight: 650 }}>
        {title}
      </summary>
      <div style={{ padding: '0 12px 12px' }}>{children}</div>
    </details>
  );
}

function RailToggle({ side, open, onToggle }: { side: 'left' | 'right'; open: boolean; onToggle: () => void }) {
  const label = side === 'left' ? (open ? 'Collapse left column' : 'Expand left column') : (open ? 'Collapse right column' : 'Expand right column');
  return (
    <button type="button" className={`rec-rail-toggle rec-rail-toggle-${side} rec-press`} data-testid={`rail-toggle-${side}`} aria-label={label} title={label} onClick={onToggle}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        {side === 'left'
          ? (open ? <path d="M15 18 9 12l6-6" /> : <path d="m9 18 6-6-6-6" />)
          : (open ? <path d="m9 18 6-6-6-6" /> : <path d="M15 18 9 12l6-6" />)}
      </svg>
    </button>
  );
}

export function SellerRecordClassic({ V }: { V: ClozrView }) {
  const me = useSession().user?.id ?? null;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stageRef = useRef<HTMLSelectElement | null>(null);
  const [details, setDetails] = useState<SectionKey | null>(null);
  const [tracing, setTracing] = useState(false);
  // The submission note closed with its ✕, by partner + house; another submission shows it again.
  const [subClosed, setSubClosed] = useState<string | null>(null);
  const closeDetails = useCallback(() => setDetails(null), []);
  // Contracts open wide and centered; the side sheet squeezed the composer.
  // false: closed; null: open, nothing picked; a number: open on that template (-1 for "other").
  const [contractsPop, setContractsPop] = useState<number | null | false>(false);
  const [pickingContract, setPickingContract] = useState(false);
  const { prefs: rails, toggle: toggleRail, stretch } = useRailPrefs();
  const [wide, setWide] = useState<'left' | 'right' | null>(null);

  // Pick a composer channel and put the cursor in it. Instant: used all day.
  const pick = useCallback((ch: 'Text' | 'Email' | 'Note') => {
    if (ch === 'Text') { V.openQuickReach('text'); return; }
    if (ch === 'Email') { V.openQuickReach('email'); return; }
    V.composerTabs.find((t) => t.label === ch)?.go();
    requestAnimationFrame(() => requestAnimationFrame(() => inputRef.current?.focus()));
  }, [V]);

  // A screen that still names an old tab (the TC screen, Lane) lands on the
  // record with the matching section open; anything else shows All.
  const [seenTab, setSeenTab] = useState<string | null>(null);
  if (V.personTab !== seenTab) {
    setSeenTab(V.personTab);
    const sec = TAB_TO_SECTION[V.personTab];
    if (sec && (sec !== 'closing' || V.hasTcFile)) setDetails(sec);
  }
  const oldTab = !CHIP_TABS.includes(V.personTab);
  const setPersonTab = V.setPersonTab;
  useEffect(() => { if (oldTab) setPersonTab('Activity'); }, [oldTab, setPersonTab]);

  // The single-letter keys. Bubble phase on window, so the shell's capture
  // handler (⌘K, Escape) and anything that handles the key first win.
  const live = useRef({ V, details, pick });
  useEffect(() => { live.current = { V, details, pick }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const { V: v, details: d } = live.current;
      const navBlocked = recordNavBlocked({
        onRecord: v.isPerson,
        typing: isTypingTarget(t),
        dialogOrMenu: !!document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"]'),
        offerOpen: v.offerSheetOpen,
        addOpen: !!v.addOpen,
        searchOpen: v.searchOpen,
        phoneUp: v.phoneUp,
        detailsOpen: !!d,
        photoShow: !!v.photoShow,
        quickReach: !!v.quickReach,
        inDialer: !!t?.closest?.('[data-screen-label="Talkr dialer"], [data-testid="phone-root"]'),
      });
      // Shift+Delete archives (after the prompt). Ctrl+A is left to the browser's select-all.
      if (isArchiveKey(e, navBlocked)) { e.preventDefault(); v.archiveOpenRecord('seller'); return; }
      const nav = peopleNavAction(e, 'record', navBlocked);
      if (nav) {
        e.preventDefault();
        if (nav.type === 'stage') v.shiftStage(nav.dir);
        else v.moveOpenRecord(nav.dir);
        return;
      }
      if (!shortcutAllowed(e, t)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : '';
      if (!k || !'ctoes'.includes(k)) return;
      if (!v.isPerson || v.offerSheetOpen || v.addOpen || v.searchOpen || v.phoneUp || d) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"]')) return;
      if (t?.closest?.('[data-screen-label="Talkr dialer"], [data-testid="phone-root"]')) return;
      e.preventDefault();
      if (k === 'c') v.callPerson();
      else if (k === 't') v.openQuickReach('text');
      else if (k === 'e') v.openQuickReach('email');
      else if (k === 'o') v.openOfferSheet(v.P.id);
      else if (k === 's') {
        const sel = stageRef.current;
        sel?.focus();
        try { (sel as HTMLSelectElement & { showPicker?: () => void })?.showPicker?.(); } catch { /* focus is enough */ }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Acceptance tests drive the command bar's hand-off from the page. Inert
  // unless the test sets window.__clozrTestHooks before load.
  useEffect(() => {
    if ((window as unknown as { __clozrTestHooks?: boolean }).__clozrTestHooks !== true) return;
    (window as unknown as { __clozrRecord?: unknown }).__clozrRecord = { openRecordComposer: V.openRecordComposer, openOfferSheet: V.openOfferSheet };
  });

  const moreItems: MoreItem[] = [
    ...(V.can.dealSheet ? [{ key: 'dealSheet', label: 'Deal sheet', group: 'Deal', run: () => V.openDealSheet() }] : []),
    ...(V.canStartDispo ? [{ key: 'startDispo', label: 'Start dispo', group: 'Deal', run: V.startDispo }] : []),
    ...(V.hasTcFile ? [{ key: 'closing', label: 'Closing file', group: 'Deal', note: V.can.tc ? 'TC file' : 'read-only', run: V.can.tc ? V.openClosingFile : () => setDetails('closing') }] : []),
    ...(V.liveIds?.sellerId != null && V.liveIds.canWrite ? [{ key: 'newContract', label: 'New contract', group: 'Deal', note: 'pick a template', run: () => setPickingContract(true) }] : []),
    { key: 'skiptrace', label: 'Skip trace', group: 'Contact', note: 'find phones and emails', run: () => setTracing(true) },
    ...(V.canEditAddress ? [{ key: 'editAddress', label: V.hasAddress ? 'Edit address' : 'Set address', group: 'Contact', note: 'open deals move with it', run: V.editAddress }] : []),
    ...(V.liveIds?.dealId ? [{ key: 'archiveDeal', label: V.dealArchivedDb(V.liveIds.dealId) ? 'Restore deal' : 'Archive deal', group: 'Deal', note: 'off the board, list and Dispo', run: () => V.archiveDealDb(V.liveIds?.dealId, !V.dealArchivedDb(V.liveIds?.dealId)) }] : []),
    ...MORE_GROUPS.flatMap(({ group, keys }) => keys.map((k) => ({ key: k, label: SECTION_LABELS[k], group, run: () => (k === 'contracts' && V.liveIds?.sellerId != null ? setContractsPop(null) : setDetails(k)) }))),
  ];

  const sub = V.submissionFocus;
  const subKey = sub ? `${sub.partner}|${sub.addr}` : null;
  // A small card at the top of the left rail (in the stack on mobile), not a band across the record.
  const subNote = sub && subKey !== subClosed ? (
    <div role="status" style={{ position: 'relative', margin: '0 0 12px', padding: '8px 28px 8px 10px', borderRadius: '8px', background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: '12px', lineHeight: 1.35, color: '#1e3a8a' }}>
      <button type="button" className="dc2" aria-label="Close submission note" title="Close" onClick={() => setSubClosed(subKey)}
        style={{ position: 'absolute', top: '2px', right: '2px', width: '24px', height: '24px', padding: 0, border: 0, borderRadius: '6px', background: 'transparent', color: '#1e3a8a', cursor: 'pointer', display: 'inline-grid', placeItems: 'center' }}>
        <Icon name="x" size={12} />
      </button>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${sub.partner} submission · ${sub.addr}`}>
        <strong>{sub.partner}</strong> submission
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
        <button type="button" className="dc2" onClick={sub.openDealSheet} style={{ ...DEAL_SHEET_BTN, height: '26px', padding: '0 10px', fontSize: '12px' }}>Deal sheet</button>
        <button type="button" className="dc2" onClick={sub.showAll} style={{ height: '26px', padding: '0 8px', borderRadius: '7px', border: '1px solid #bfdbfe', background: '#fff', fontSize: '12px', fontWeight: 600, color: '#1d4ed8', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          All{sub.others ? ` (+${sub.others})` : ''}
        </button>
      </div>
    </div>
  ) : null;
  const meet = () => openMeetingInvite({
    name: V.P.name, email: V.P.email.includes('@') ? V.P.email : '', phone: V.P.phone && V.P.phone !== '—' ? V.P.phone : '',
    sellerId: V.liveIds?.sellerId ?? null, address: V.P.addr !== '—' ? V.P.addr : null, typeKey: 'walkthrough',
  });
  const header = <RecordHeader V={V} onText={() => pick('Text')} onEmail={() => pick('Email')} onMeet={meet} moreItems={moreItems} showBack={!rails.left} />;
  const overlays = (
    <>
      {V.offerSheetOpen ? <OfferSheet V={V} /> : null}
      {tracing ? (
        <CenteredDialog title={`Skip trace · ${V.P.name}`} onClose={() => setTracing(false)} width={620} z={90}>
          <BulkSkipTrace kind="seller" records={[{ kind: 'seller', dbId: V.liveIds?.sellerId ?? 0, name: V.P.name, address: V.P.traceAddress }]}
            workspaceId={V.liveIds?.workspaceId ?? null} canWrite={!!V.liveIds?.canWrite} userId={V.liveIds?.userId ?? null}
            toast={(m) => V.showToast(m)} onDone={() => V.reloadCrm()} onClose={() => setTracing(false)} />
        </CenteredDialog>
      ) : null}
      {details ? <RecordDetailsSheet V={V} me={me} at={details} onClosed={closeDetails} /> : null}
      {pickingContract && V.liveIds?.workspaceId ? (
        <ContractTemplatePicker
          workspaceId={V.liveIds.workspaceId}
          who={V.P.name}
          onPick={(id) => { setPickingContract(false); setContractsPop(id); }}
          onOther={() => { setPickingContract(false); setContractsPop(-1); }}
          onClose={() => setPickingContract(false)}
        />
      ) : null}
      {contractsPop !== false && V.liveIds?.sellerId != null ? (
        <ContractPopup
          key={contractsPop ?? 'all'}
          V={V}
          target={{ sellerId: V.liveIds.sellerId, dealId: V.liveIds.dealId, buyerId: null, title: `Contracts · ${V.P.name}`, seller: { id: V.liveIds.sellerId, name: V.P.name, email: V.P.email || '', phone: V.P.phone || '', addr: V.P.addr, dealId: V.liveIds.dealId } }}
          startTemplateId={contractsPop}
          onClose={() => setContractsPop(false)}
        />
      ) : null}
    </>
  );

  if (V.isMobile) {
    return (
      <section data-screen-label="Seller record" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {header}
        <div data-record-scroll style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#fafafa' }}>
          <div style={{ display: 'grid', gap: '10px', padding: '12px' }}>
            {subNote}
            <NextActionCard V={V} />
            <OutcomeBar V={V} />
            <FilesBlock V={V} compact />
            <AiRecommended V={V} />
            <StageCard V={V} selectRef={stageRef} />
            <PropertyCard V={V} />
            <Disclosure title="What we know">
              <Identity V={V} compact />
              <div style={{ marginTop: '8px' }}><WhatWeKnow V={V} bare /></div>
            </Disclosure>
            <div><RecordActionPlans V={V} /></div>
            <DealTeamBlock V={V} />
            <ContractsBlock V={V} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="dc2" data-testid="record-archive" title="Archive this record (Shift+Delete). Asks first; nothing is deleted." onClick={() => V.archiveOpenRecord('seller')}
                style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid #d4d4d8', background: '#fff', color: '#3f3f46', fontSize: 12.5, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                Archive
              </button>
              <BlacklistButton count={1} names={[V.P.name]} onConfirm={V.blacklistPerson} />
            </div>
          </div>
          <ActivityChips V={V} />
          <div style={{ padding: '12px' }}>
            <ActivityStream V={V} me={me} />
          </div>
        </div>
        <Composer V={V} inputRef={inputRef} docked />
        {overlays}
      </section>
    );
  }

  // Opened from People: the smart list and where in it. From anywhere else
  // (Today, Inbox, Deals…): that screen's name, and the link goes back there.
  const listLabel = V.recordBack.fromList
    ? (V.recordListPos ? `${V.peopleList} · ${V.recordListPos}` : V.peopleList)
    : V.recordBack.label;
  const frameClass = [
    'rec-frame',
    rails.left ? '' : 'rec-left-collapsed',
    rails.right ? '' : 'rec-right-collapsed',
    wide === 'left' ? 'rec-left-wide' : '',
    wide === 'right' ? 'rec-right-wide' : '',
  ].filter(Boolean).join(' ');
  return (
    <section data-screen-label="Seller record" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div className={frameClass}>
        <aside className={`rec-rail rec-rail-left${rails.left ? '' : ' rec-rail-collapsed'}`}>
          {rails.left ? (
            <>
              <span className="rec-head-back" data-testid="record-smart-list"><BackLink to={{ ...V.recordBack, label: listLabel }} /></span>
              {subNote}
              <div className="rec-card"><Identity V={V} /></div>
              <div style={{ marginTop: '10px' }}><StageCard V={V} selectRef={stageRef} /></div>
              <div className="rec-card" style={{ marginTop: '10px' }}><WhatWeKnow V={V} /></div>
              <div style={{ marginTop: '10px' }}><PropertyCard V={V} /></div>
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="dc2" data-testid="record-archive" title="Archive this record (Shift+Delete). Asks first; nothing is deleted." onClick={() => V.archiveOpenRecord('seller')}
                  style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid #d4d4d8', background: '#fff', color: '#3f3f46', fontSize: 12.5, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  Archive
                </button>
                <BlacklistButton count={1} names={[V.P.name]} onConfirm={V.blacklistPerson} />
              </div>
            </>
          ) : null}
        </aside>
        <RailToggle side="left" open={rails.left} onToggle={() => { setWide(null); toggleRail('left'); }} />
        <button type="button" className="rec-split rec-split-left" aria-label="Resize left column. Double-click to stretch."
          title="Double-click to stretch / expand"
          onDoubleClick={() => { setWide((w) => (w === 'left' ? null : 'left')); stretch('left'); }} />
        {header}
        <div className="rec-main">
          {/* The composer sits over the stream, the way Follow Up Boss's note box does: what you write goes first. */}
          <div className="rec-composer-top"><Composer V={V} inputRef={inputRef} /></div>
          <ActivityChips V={V} />
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 20px' }}>
            <ActivityStream V={V} me={me} />
          </div>
        </div>
        <button type="button" className="rec-split rec-split-right" aria-label="Resize right column. Double-click to stretch."
          title="Double-click to stretch / expand"
          onDoubleClick={() => { setWide((w) => (w === 'right' ? null : 'right')); stretch('right'); }} />
        <aside className={`rec-rail rec-rail-right${rails.right ? '' : ' rec-rail-collapsed'}`}>
          {rails.right ? (
            <>
              <NextActionCard V={V} />
              <div style={{ marginTop: '10px' }}><OutcomeBar V={V} /></div>
              <div className="rec-card" style={{ marginTop: '10px' }}><FilesBlock V={V} compact /></div>
              <div style={{ marginTop: '10px' }}><AiRecommended V={V} /></div>
              <div className="rec-card" style={{ marginTop: '10px' }}><RecordActionPlans V={V} /></div>
              <div className="rec-card" style={{ marginTop: '10px' }}><DealTeamBlock V={V} /></div>
              <div className="rec-card" style={{ marginTop: '10px' }}><ContractsBlock V={V} /></div>
            </>
          ) : null}
        </aside>
        <RailToggle side="right" open={rails.right} onToggle={() => { setWide(null); toggleRail('right'); }} />
      </div>
      {overlays}
    </section>
  );
}
