// The seller record, as a composition of app/components/record/*.
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
import { Identity, PropertyCard } from '@/app/components/record/PropertyCard';
import { StageCard } from '@/app/components/record/StageCard';
import { OutcomeBar } from '@/app/components/record/OutcomeBar';
import { WhatWeKnow } from '@/app/components/record/WhatWeKnow';
import { ActivityChips, ActivityStream } from '@/app/components/record/ActivityStream';
import { Composer } from '@/app/components/record/Composer';
import { OfferSheet } from '@/app/components/record/OfferSheet';
import { RecordDetailsSheet, SECTION_LABELS, type SectionKey } from '@/app/components/record/RecordDetailsSheet';
import { RecordActionPlans, AiRecommended } from '@/app/components/record/RailCards';
import { ContractsCard } from '@/components/ContractsCard';
import { ContractTemplatePicker } from '@/components/ContractTemplatePicker';
import { DealTeam } from '@/components/DealTeam';
import { DealFiles } from '@/components/DealFiles';
import { InteractiveFolderGallery } from '@/components/ui/interactive-folder-gallery';
import { eyebrow } from '@/app/components/record/ui';
import type { MoreItem } from '@/app/components/record/MoreMenu';
import { BulkSkipTrace } from '@/components/BulkSkipTrace';
import { CenteredDialog } from '@/components/ContractsHub';
import { shortcutAllowed } from '@/app/components/record/record-logic';
import { isArchiveKey, isTypingTarget, peopleNavAction, recordNavBlocked } from '@/lib/people-keys';
import { useRailPrefs } from '@/app/components/record/useRailPrefs';
import '@/app/components/record/record.css';
import { DEAL_SHEET_BTN } from '@/app/components/record/deal-sheet-style';

const MORE_GROUPS: { group: string; keys: SectionKey[] }[] = [
  { group: 'Deal', keys: ['contracts', 'team', 'deals'] },
  { group: 'Follow-up', keys: ['plan', 'appointments', 'tags'] },
  { group: 'Property', keys: ['records', 'files', 'sellers'] },
];
/** Old tab names another screen may still hand over, and where they live now. */
const TAB_TO_SECTION: Record<string, SectionKey> = { TC: 'closing', 'Files & Links': 'files' };
const CHIP_TABS = ['Activity', 'Calls', 'Texts', 'Emails', 'Notes'];

function DealTeamBlock({ V }: { V: ClozrView }) {
  const live = V.liveIds;
  return (
    <div style={{ marginTop: '16px' }}>
      {live?.sellerId != null ? (
        <DealTeam bare sellerId={live.sellerId} dealId={live.dealId} onCall={V.callParty} onOpenSeller={(id) => V.openPerson('s' + id)} onOpenBuyer={(id) => V.openBuyerRecord('b' + id)} onOpenVendor={V.openVendorContact} onChanged={V.reloadCrm} />
      ) : (
        <>
          <div style={eyebrow}>Deal team</div>
          <div style={{ marginTop: '6px', fontSize: '12.5px', color: '#71717a' }}>Title, agents and the rest of the team show here on a signed-in deal.</div>
        </>
      )}
    </div>
  );
}

/**
 * The record's contracts: "New contract" lists the templates only; picking one
 * opens the contract full size on that template, filled from this record.
 * "Open contracts full size" opens the same view with nothing picked.
 */
function ContractsBlock({ V }: { V: ClozrView }) {
  const live = V.liveIds;
  const [picking, setPicking] = useState(false);
  // undefined: closed; null: open, nothing picked; a number: open on that template.
  const [full, setFull] = useState<number | null | undefined>(undefined);
  if (live?.sellerId == null) {
    return (
      <div style={{ marginTop: '16px', fontSize: '12.5px', color: '#71717a', padding: '10px 12px', border: '1px dashed #e4e4e7', borderRadius: '9px' }}>
        Contracts fill from this record once you are signed in.
      </div>
    );
  }
  const seller = { id: live.sellerId, name: V.P.name, email: V.P.email || '', phone: V.P.phone || '', addr: V.P.addr, dealId: live.dealId };
  return (
    <div style={{ marginTop: '16px' }} data-testid="record-contracts">
      <button type="button" className="dc2" onClick={() => setFull(null)} style={{ display: 'block', marginLeft: 'auto', marginBottom: '6px', height: '26px', padding: '0 10px', borderRadius: '7px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '11.5px', fontWeight: 600, color: '#0A8560', cursor: 'pointer' }}>
        Open contracts full size
      </button>
      <ContractsCard
        compact
        workspaceId={live.workspaceId}
        sellerId={live.sellerId}
        dealId={live.dealId}
        seller={{ name: V.P.name, email: V.P.email, phone: V.P.phone }}
        canWrite={live.canWrite}
        onToast={V.showToast}
        onChanged={V.reloadCrm}
        onNewContract={() => setPicking(true)}
      />
      {picking && live.workspaceId ? (
        <ContractTemplatePicker
          workspaceId={live.workspaceId}
          who={V.P.name}
          onPick={(id) => { setPicking(false); setFull(id); }}
          onOther={() => { setPicking(false); setFull(-1); }}
          onClose={() => setPicking(false)}
        />
      ) : null}
      {full !== undefined ? (
        <ContractPopup
          key={full ?? 'all'}
          V={V}
          target={{ sellerId: live.sellerId, dealId: live.dealId, buyerId: null, title: `Contracts · ${V.P.name}`, seller }}
          startTemplateId={full}
          onClose={() => setFull(undefined)}
        />
      ) : null}
    </div>
  );
}

function FilesBlock({ V, compact }: { V: ClozrView; compact?: boolean }) {
  const live = V.liveIds;
  // The house the Property card shows (V.P.dealDbId), so its photos and files sit together.
  const dealId = V.P.dealDbId ?? live?.dealId ?? null;
  return (
    <div style={{ marginTop: compact ? '10px' : '16px' }} data-testid="record-photos-files">
      <div style={{ ...eyebrow, marginBottom: '8px' }}>Photos and files</div>
      {live && dealId != null ? (
        <DealFiles
          key={dealId}
          workspaceId={live.workspaceId}
          dealId={dealId}
          canWrite={live.canWrite}
          onToast={V.showToast}
          onOpenPhotos={(title, urls, start) => V.openPhotoShow(title, urls, dealId, start)}
          fallbackPhotos={V.P.photos.length ? V.P.photos : [V.P.streetSafe].filter(Boolean)}
        />
      ) : (
        <>
          {V.P.photos.length ? (
            <div style={{ marginBottom: '8px', padding: '6px 0', display: 'flex', justifyContent: 'center', background: 'transparent' }}>
              <InteractiveFolderGallery
                size="sm"
                photos={V.P.photos.map((u, i) => ({ id: i, image: u, label: i === 0 ? 'Front' : undefined }))}
                folderName={`${V.P.photos.length} photo${V.P.photos.length === 1 ? '' : 's'}`}
                dragHintText="Tap a photo to view · drag down to close"
                onPhotoClick={(i) => V.openPhotoShow(V.P.addr, V.P.photos, null, i)}
              />
            </div>
          ) : null}
          <div style={{ fontSize: '12.5px', color: '#71717a', padding: '10px 12px', border: '1px dashed #e4e4e7', borderRadius: '9px' }}>
            Photos, docs and links attach to a deal, so they sit here once this record has one.
          </div>
        </>
      )}
    </div>
  );
}

function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details style={{ border: '1px solid #e4e4e7', borderRadius: '10px', background: '#fff' }}>
      <summary style={{ minHeight: '44px', display: 'flex', alignItems: 'center', padding: '0 12px', cursor: 'pointer', fontSize: '11px', color: '#71717a', fontWeight: 600 }}>
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

export function SellerRecord({ V }: { V: ClozrView }) {
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
        style={{ position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px', padding: 0, border: 0, borderRadius: '5px', background: 'transparent', color: '#1e3a8a', fontSize: '14px', lineHeight: '20px', cursor: 'pointer' }}>
        ×
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
  const header = <RecordHeader V={V} onText={() => pick('Text')} onEmail={() => pick('Email')} moreItems={moreItems} showBack={!rails.left} />;
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
              <Identity V={V} />
              <div style={{ marginTop: '14px' }}><StageCard V={V} selectRef={stageRef} /></div>
              <div style={{ marginTop: '14px' }}><PropertyCard V={V} /></div>
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
          <ActivityChips V={V} />
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 20px' }}>
            <ActivityStream V={V} me={me} />
          </div>
          <Composer V={V} inputRef={inputRef} />
        </div>
        <button type="button" className="rec-split rec-split-right" aria-label="Resize right column. Double-click to stretch."
          title="Double-click to stretch / expand"
          onDoubleClick={() => { setWide((w) => (w === 'right' ? null : 'right')); stretch('right'); }} />
        <aside className={`rec-rail rec-rail-right${rails.right ? '' : ' rec-rail-collapsed'}`}>
          {rails.right ? (
            <>
              <NextActionCard V={V} />
              <div style={{ marginTop: '10px' }}><OutcomeBar V={V} /></div>
              <FilesBlock V={V} compact />
              <AiRecommended V={V} />
              <div style={{ marginTop: '10px' }}><WhatWeKnow V={V} /></div>
              <details style={{ marginTop: '10px' }}>
                <summary style={{ cursor: 'pointer', fontSize: '11.5px', color: '#71717a', fontWeight: 600 }}>Tasks & plans</summary>
                <RecordActionPlans V={V} />
              </details>
              <DealTeamBlock V={V} />
              <ContractsBlock V={V} />
            </>
          ) : null}
        </aside>
        <RailToggle side="right" open={rails.right} onToggle={() => { setWide(null); toggleRail('right'); }} />
      </div>
      {overlays}
    </section>
  );
}
