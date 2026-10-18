// The seller record, as a composition of app/components/record/*. Two
// layouts: the classic three-column record (SellerRecordClassic.tsx, the
// default) and the deal page below, which Settings › Try new design turns on.
//
// Desktop, the deal page: a header toolbar (AI agent, Deal sheet, TC, Call,
// Text, Email, More); the seller's name; a strip of key numbers; then two
// columns. The wide one is the record's tabs (record-tabs.ts): the activity
// feeds (Activity, Calls, Texts, Email, Notes) with the composer pinned to the
// bottom of the screen, then Automations, History, Details (the house, who
// works the deal, What we know) and Submission when the record came in as
// one. The narrow one has Deal info (stage, Next action, how the offer went),
// the photo, COMPR, the underwriting and the offer, then files, the deal team
// and contracts. Everything else lives behind More in the Record details
// sheet. Text and Email in the header open the floating quick box. Phone: one
// column, the same tabs, the composer docked above the tab bar.
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
import { EditableName, PropertyCard } from '@/app/components/record/PropertyCard';
import { TypeChip } from '@/components/TypeChip';
import { KeyNumbers } from '@/app/components/record/DealOverview';
import { StageCard } from '@/app/components/record/StageCard';
import { OutcomeBar } from '@/app/components/record/OutcomeBar';
import { ActivityStream, RecordTabs } from '@/app/components/record/ActivityStream';
import { AutomationsPanel, DetailsPanel, HistoryPanel, SubmissionPanel } from '@/app/components/record/RecordTabPanels';
import { recordTabs, resolveRecordTab, TAB_TO_SECTION, tabOf, type RecordTabKey } from '@/app/components/record/record-tabs';
import { Icon } from '@/app/components/talkr/Icon';
import { Composer } from '@/app/components/record/Composer';
import { OfferSheet } from '@/app/components/record/OfferSheet';
import { RecordDetailsSheet, SECTION_LABELS, type SectionKey } from '@/app/components/record/RecordDetailsSheet';
import { AiRecommended } from '@/app/components/record/RailCards';
import { ContractTemplatePicker } from '@/components/ContractTemplatePicker';
import { ContractsBlock, DealTeamBlock, FilesBlock, MORE_GROUPS } from '@/app/components/record/RecordBlocks';
import { SellerRecordClassic } from './SellerRecordClassic';
import type { MoreItem } from '@/app/components/record/MoreMenu';
import { BulkSkipTrace } from '@/components/BulkSkipTrace';
import { CenteredDialog } from '@/components/ContractsHub';
import { shortcutAllowed } from '@/app/components/record/record-logic';
import { isArchiveKey, isTypingTarget, peopleNavAction, recordNavBlocked } from '@/lib/people-keys';
import '@/app/components/record/record.css';
import { DEAL_SHEET_BTN } from '@/app/components/record/deal-sheet-style';

/**
 * The seller record. Settings › Try new design picks the layout, per user:
 * off (the default) is the classic three-column record, on is the deal page.
 */
export function SellerRecord({ V }: { V: ClozrView }) {
  return V.newDesign ? <SellerRecordNew V={V} /> : <SellerRecordClassic V={V} />;
}

function SellerRecordNew({ V }: { V: ClozrView }) {
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

  // Pick a composer channel and put the cursor in it. Instant: used all day.
  const pick = useCallback((ch: 'Text' | 'Email' | 'Note') => {
    if (ch === 'Text') { V.openQuickReach('text'); return; }
    if (ch === 'Email') { V.openQuickReach('email'); return; }
    if (!tabOf(resolveRecordTab(V.personTab, !!V.recordSubmission)).composer) V.setPersonTab('Activity');
    V.composerTabs.find((t) => t.label === ch)?.go();
    requestAnimationFrame(() => requestAnimationFrame(() => inputRef.current?.focus()));
  }, [V]);

  // A screen that still names an old tab (the TC screen, Lane) lands on the
  // record with the matching section open; any other name lands on the tab
  // that holds it now (record-tabs.ts), and an unknown one on Activity.
  const [seenTab, setSeenTab] = useState<string | null>(null);
  if (V.personTab !== seenTab) {
    setSeenTab(V.personTab);
    const sec: SectionKey | undefined = TAB_TO_SECTION[V.personTab];
    if (sec && (sec !== 'closing' || V.hasTcFile)) setDetails(sec);
  }
  const hasSubmission = !!V.recordSubmission;
  const tabs = recordTabs(hasSubmission);
  const tab: RecordTabKey = resolveRecordTab(V.personTab, hasSubmission);
  const tabInfo = tabOf(tab);
  const setPersonTab = V.setPersonTab;
  const needsFix = tab !== V.personTab;
  useEffect(() => { if (needsFix) setPersonTab(tab); }, [needsFix, tab, setPersonTab]);
  const pickTab = useCallback((k: RecordTabKey) => setPersonTab(k), [setPersonTab]);

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
  // One line over the name (in the stack on mobile): whose submission this
  // is, with the way to its details, its deal sheet and the partner's others.
  const subNote = sub && subKey !== subClosed ? (
    <div role="status" className="rec2-subnote">
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${sub.partner} submission · ${sub.addr}`}>
        <strong style={{ color: 'var(--ink, #18181b)' }}>{sub.partner}</strong> submission
      </span>
      <span style={{ display: 'flex', gap: '6px', alignItems: 'center', flex: 'none', flexWrap: 'wrap' }}>
        {tab !== 'Submission' ? <button type="button" className="rec2-chip rec-press" onClick={() => pickTab('Submission')}>Submission details</button> : null}
        <button type="button" className="rec2-chip rec-press" onClick={sub.showAll}>All{sub.others ? ` (+${sub.others})` : ''}</button>
        <button type="button" className="dc2 rec-press" onClick={sub.openDealSheet} style={{ ...DEAL_SHEET_BTN, height: '28px', padding: '0 10px', fontSize: '12px' }}>Deal sheet</button>
        <button type="button" className="rec2-icon rec-press" aria-label="Close submission note" title="Close" onClick={() => setSubClosed(subKey)}>
          <Icon name="x" size={14} />
        </button>
      </span>
    </div>
  ) : null;
  const meet = () => openMeetingInvite({
    name: V.P.name, email: V.P.email.includes('@') ? V.P.email : '', phone: V.P.phone && V.P.phone !== '—' ? V.P.phone : '',
    sellerId: V.liveIds?.sellerId ?? null, address: V.P.addr !== '—' ? V.P.addr : null, typeKey: 'walkthrough',
  });
  const header = <RecordHeader V={V} onText={() => pick('Text')} onEmail={() => pick('Email')} onMeet={meet} moreItems={moreItems} showBack={false} />;
  const tabRow = <RecordTabs V={V} tabs={tabs} current={tab} onPick={pickTab} idBase="rec-tabs" />;
  const panel = tab === 'Automations' ? <AutomationsPanel V={V} me={me} />
    : tab === 'History' ? <HistoryPanel V={V} me={me} />
      : tab === 'Details' ? <DetailsPanel V={V} hasSubmission={hasSubmission} />
        : tab === 'Submission' ? <SubmissionPanel V={V} />
          : <ActivityStream V={V} me={me} />;
  const panelProps = { role: 'tabpanel', id: 'rec-tabs-panel', 'aria-labelledby': `rec-tabs-tab-${tab}`, 'data-panel': tab } as const;
  const archiveRow = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button type="button" className="dc2" data-testid="record-archive" title="Archive this record (Shift+Delete). Asks first; nothing is deleted." onClick={() => V.archiveOpenRecord('seller')}
        style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--line, #d4d4d8)', background: 'var(--surface, #fff)', color: 'var(--ink-3, #3f3f46)', fontSize: 12.5, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        Archive
      </button>
      <BlacklistButton count={1} names={[V.P.name]} onConfirm={V.blacklistPerson} />
    </div>
  );
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
        <div data-record-scroll style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--canvas, #fafafa)' }}>
          <div style={{ display: 'grid', gap: '10px', padding: '12px' }}>
            {subNote}
            <NextActionCard V={V} />
            <OutcomeBar V={V} />
            <FilesBlock V={V} compact />
            <AiRecommended V={V} />
            <StageCard V={V} selectRef={stageRef} />
            <PropertyCard V={V} />
            <DealTeamBlock V={V} />
            <ContractsBlock V={V} />
            {archiveRow}
          </div>
          {tabRow}
          <div {...panelProps} className={'rec2-phone-panel' + (tabInfo.composer ? '' : ' rec2-phone-sheet')}>
            {panel}
          </div>
        </div>
        {tabInfo.composer ? <Composer V={V} inputRef={inputRef} docked /> : null}
        {overlays}
      </section>
    );
  }

  // Opened from People: the smart list and where in it. From anywhere else
  // (Today, Inbox, Deals…): that screen's name, and the link goes back there.
  const listLabel = V.recordBack.fromList
    ? (V.recordListPos ? `${V.peopleList} · ${V.recordListPos}` : V.peopleList)
    : V.recordBack.label;
  // The deal page: the header, the numbers across the top, then two columns.
  // The wide one is the record's tabs, the activity first; the narrow one
  // holds Deal info, the photos, COMPR and the underwriting, the deal team and
  // the paperwork. Each column scrolls with the page.
  return (
    <section data-screen-label="Seller record" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div className="rec2">
        <div className="rec2-head">{header}</div>
        <div className="rec2-scroll" data-record-scroll>
          <div className="rec2-top">
            <span className="rec-head-back" data-testid="record-smart-list"><BackLink to={{ ...V.recordBack, label: listLabel }} /></span>
            {subNote}
            {/* Who this is, as the page's heading: avatar, click-to-rename name, type and market. */}
            <div className="rec2-who">
              <span aria-hidden className="rec2-initials">{V.P.initials}</span>
              <div style={{ minWidth: 0 }}>
                <EditableName V={V} style={{ margin: 0, fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>
                  <TypeChip kind="Seller" />
                  {V.P.market}
                </div>
              </div>
            </div>
          </div>
          <KeyNumbers V={V} />
          <div className="rec2-grid">
            <div className="rec2-main">
              <section aria-label="Activity and record" className="rec2-card rec2-feed">
                {tabRow}
                <div {...panelProps} className={tabInfo.stream && tab !== 'Automations' && tab !== 'History' ? 'rec2-feed-scroll' : 'rec2-tab-body'}>
                  {panel}
                </div>
                {tabInfo.composer ? <div className="rec2-composer"><Composer V={V} inputRef={inputRef} /></div> : null}
              </section>
            </div>
            <aside className="rec2-side" aria-label="Deal info, photos, underwriting and the deal team">
              {/* What has to stay in view whichever tab is open: the stage, the next action, how the offer went. */}
              <section aria-labelledby="rec2-deal-title" className="rec2-stack" data-testid="deal-info">
                <div className="rec2-stack-head">
                  <h2 id="rec2-deal-title" className="rec2-title">Deal info</h2>
                  {tab !== 'Details' ? <button type="button" className="rec2-link rec-press" onClick={() => pickTab('Details')}>Who works it</button> : null}
                </div>
                <StageCard V={V} selectRef={stageRef} />
                <NextActionCard V={V} compact />
                <OutcomeBar V={V} />
              </section>
              <PropertyCard V={V} side />
              <div className="rec2-card rec2-block"><FilesBlock V={V} compact /></div>
              <div className="rec2-card rec2-block"><DealTeamBlock V={V} /></div>
              <div className="rec2-card rec2-block"><ContractsBlock V={V} /></div>
              <AiRecommended V={V} />
              {archiveRow}
            </aside>
          </div>
        </div>
      </div>
      {overlays}
    </section>
  );
}
