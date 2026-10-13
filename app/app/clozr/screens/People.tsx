// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import { RailToggle, useRailOpen } from '@/components/ds/ListRail';
import { ContractsButton } from '@/components/ContractsHub';
import React, { useEffect, useState } from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { SearchSelectMenu } from '@/components/ds/SearchSelect';
import { PickLabel } from '@/components/ds/PickBox';
import { MoreFilters, MoreFiltersFields } from '@/app/components/people/MoreFilters';
import { FilterPanel } from '@/app/components/filters/FilterPanel';
import { PeopleMap } from '@/app/components/people/PeopleMap';
import { ListMapSwitch, useListOrMap } from '@/components/ListMap';
import { useReveal } from '@/components/ds/useReveal';
import { useDebouncedText } from '@/components/ds/useDebouncedText';
import { Empty, EmptyRow } from '@/components/ds/Empty';
import { SkeletonRows } from '@/components/ds/Skeleton';
import type { ClozrView } from '@/app/clozr/view';
import { BlacklistButton } from '@/components/BlacklistButton';
import { PeopleBulkCompose } from '@/app/components/bulk/PeopleBulkCompose';
import { BulkSkipTrace } from '@/components/BulkSkipTrace';
import { BulkAgentPanel, type BulkRecord } from '@/app/components/ai-agent/BulkAgentPanel';
import { AssignPanel, SelectCount } from '@/app/components/bulk/AssignPanel';
import { ActionsMenu } from '@/app/components/bulk/ActionsMenu';
import { EnrollSellersPanel } from '@/app/components/sequences/TextSequences';
import { SendToCampaign } from '@/app/components/talkr/Campaigns';
import type { SendSeller } from '@/lib/talkr-campaign-send';
import { TypeChip } from '@/components/TypeChip';
import { VendorGroups } from '@/app/components/people/VendorGroups';
import { typeTone } from '@/lib/people-colors';
import { ColumnPicker, ViewMenu, sameList } from '@/components/ViewControls';
import { Chevron, CZ, seg, segWrap, trayBtn } from '@/components/ds/chrome';
import { cleanColumns, useSavedViews } from '@/lib/saved-views';
import type { PeopleFilters } from '@/app/clozr/useClozr';
import { isTypingTarget, listNavBlocked, peopleNavAction, isArchiveKey, isSelectAllChord, isOpenKey } from '@/lib/people-keys';
import { Mark } from '@/components/ds/mark';
import { openReach } from '@/app/components/record/reach';

/** What a saved People view keeps (lib/saved-views.ts): the list, its filters and its columns. */
type PeopleConfig = { list: string; filters: Partial<PeopleFilters>; cols: string[] };

/** A saved smart list's × asks in place before it deletes: one stray click used to lose the list. */
function SavedListDelete({ name, onDelete }: { name: string; onDelete: () => void }) {
  const [asking, setAsking] = useState(false);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  if (!asking) {
    return (
      <span role="button" tabIndex={0} aria-label={`Delete ${name}`} title="Delete this saved list"
        onClick={(e) => { stop(e); setAsking(true); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stop(e); setAsking(true); } }}
        style={{ display: 'inline-grid', placeItems: 'center', width: '20px', height: '20px', borderRadius: '5px', fontSize: '14px', color: '#a1a1aa', lineHeight: '1', cursor: 'pointer' }}>
        ×
      </span>
    );
  }
  return (
    <span onClick={stop} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', fontWeight: 600 }}>
      <span style={{ color: '#71717a' }}>Delete?</span>
      <span role="button" tabIndex={0} data-testid="saved-list-delete-yes" onClick={(e) => { stop(e); setAsking(false); onDelete(); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stop(e); setAsking(false); onDelete(); } }}
        style={{ color: '#b91c1c', cursor: 'pointer' }}>Yes</span>
      <span role="button" tabIndex={0} onClick={(e) => { stop(e); setAsking(false); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); stop(e); setAsking(false); } }}
        style={{ color: '#52525b', cursor: 'pointer' }}>No</span>
    </span>
  );
}

function PeopleViews({ V }: { V: ClozrView }) {
  const keys = V.peopleColDefs.map((c) => c.key);
  const sanitize = (c: PeopleConfig | null) => (c ? { ...c, cols: cleanColumns(c.cols, keys, V.peopleColDefaults) } : null);
  const sv = useSavedViews<PeopleConfig>('people', V.liveIds?.workspaceId ?? null, V.liveIds?.userId ?? null, (c) => V.applyPeopleView(sanitize(c)));
  const current: PeopleConfig = { list: V.peopleList, filters: { ...V.peoplePf }, cols: V.peopleColKeys };
  const base = sv.active?.config;
  const dirty = base
    ? base.list !== current.list || !sameList(cleanColumns(base.cols, keys, V.peopleColDefaults), current.cols)
      || (Object.keys(current.filters) as (keyof PeopleFilters)[]).some((k) => (base.filters?.[k] ?? 'Any') !== (current.filters[k] ?? 'Any'))
    : false;
  return <ViewMenu sv={sv} current={current} dirty={dirty} onApply={(c) => V.applyPeopleView(sanitize(c))} onToast={V.showToast} />;
}

function SmartListDialog({ V }: { V: ClozrView }) {
  if (!V.smartListOpen) return null;
  const teamKey = V.smartListTeam.map((p) => p.id).join(',');
  return <SmartListForm key={V.suggestedListName + '|' + teamKey} V={V} />;
}

function SmartListForm({ V }: { V: ClozrView }) {
  const [name, setName] = useState(V.suggestedListName);
  const [access, setAccess] = useState<string[]>(() => V.smartListTeam.map((p) => p.id));
  const toggle = (id: string) => setAccess((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="smart-list-title" data-testid="smart-list-dialog"
      style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'grid', placeItems: 'center', background: 'rgba(12,13,16,.28)', padding: '16px' }}>
      <form onSubmit={(e) => { e.preventDefault(); V.commitSmartList(name, access); }}
        style={{ width: 'min(420px, 100%)', background: '#fff', borderRadius: '14px', padding: '18px', boxShadow: '0 24px 60px rgba(18,22,45,.28)' }}>
        <h2 id="smart-list-title" style={{ margin: 0, fontSize: '16px', fontWeight: 800 }}>Name this smart list</h2>
        <p style={{ margin: '6px 0 0', fontSize: '12.5px', color: '#71717a' }}>It keeps the filters you have on now. Choose who on the team can open it.</p>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="List name"
          style={{ marginTop: '12px', width: '100%', height: '36px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e4e4e7', fontSize: '14px', fontWeight: 600 }} />
        <div style={{ marginTop: '12px', maxHeight: '220px', overflow: 'auto', border: '1px solid #e4e4e7', borderRadius: '10px' }}>
          {V.smartListTeam.map((p) => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderTop: '1px solid #f4f4f5', fontSize: '13px', cursor: 'pointer' }}>
              <input type="checkbox" checked={access.includes(p.id)} onChange={() => toggle(p.id)} />
              <span style={{ flex: 1 }}>{p.name}</span>
              {p.me ? <span style={{ fontSize: '11px', color: '#a1a1aa' }}>You</span> : null}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
          <button type="button" onClick={V.closeSmartList} style={{ height: '34px', padding: '0 12px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" style={{ height: '34px', padding: '0 14px', borderRadius: '8px', border: 0, background: 'var(--c-primary)', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Save list</button>
        </div>
      </form>
    </div>
  );
}

// People bulk bar: what stays on the bar, and how the rest of the actions group under Actions ▾.
const BAR_ACTIONS = new Set(['Text', 'Email', 'Add to Call Queue', 'Assign', 'Call List']);
const MENU_GROUP: Record<string, string> = {
  RVM: 'Reach out',
  'Change Stage': 'Organize', 'Add Tag': 'Organize', 'Remove Tag': 'Organize', 'Start Action Plan': 'Organize',
  'Pause action plans': 'Organize', 'Stop action plans': 'Organize',
  'Run COMPR': 'Data', Export: 'Data',
  Archive: 'Remove',
};
const GROUP_ORDER = ['Reach out', 'Organize', 'Data', 'More', 'Remove'];

export function People({ V }: { V: ClozrView }) {
  const [view, setView] = useListOrMap('clozr.people.view');
  // Vendor lists stay lists: a vendor has an office, not a property.
  const onMap = view === 'map' && !V.isVendorList;
  const [pinMenu, setPinMenu] = useState<{ label: string; x: number; y: number; pinned: boolean } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [railOpen, toggleRail] = useRailOpen('people');
  const [tracing, setTracing] = useState(false);
  const [agentPanel, setAgentPanel] = useState(false);
  const [seqPanel, setSeqPanel] = useState(false);
  const [toCampaign, setToCampaign] = useState(false);
  const pb = V.peopleBulk;
  // Sellers into a Talkr dialer campaign: needs Talkr linked (not the demo).
  const campaignSellers: SendSeller[] = pb.kind === 'seller' && V.talkrStatus === 'ok'
    ? pb.people.flatMap((p) => (p.dbId > 0 && 'dnc' in p ? [{ dbId: p.dbId, name: p.name, phone: p.phone, dnc: p.dnc, blacklisted: p.blacklisted, fields: p.fields }] : []))
    : [];
  // Sellers can go on an AI agent (a Lead manager, Acquisitions); vendors cannot.
  // Submissions rows ('sub:<deal>') are not people and have no seller id.
  const agentRecords: Record<string, BulkRecord> = {};
  if (pb.kind === 'seller') for (const p of pb.people) {
    if (!(p.dbId > 0)) continue;
    agentRecords[p.id] = { dbId: p.dbId, name: p.name, phone: p.phone, email: p.email, blacklisted: ('dnc' in p && !!p.dnc) || ('blacklisted' in p && !!p.blacklisted) };
  }
  const agentIds = Object.keys(agentRecords);
  // Sellers are traced at the property they own; vendor lists have no skip trace.
  const traceRecords = pb.kind === 'seller' ? pb.people.map((p) => {
    const f = p.fields as Partial<Record<'address' | 'city' | 'state' | 'zip', string>>;
    return {
      kind: 'seller' as const, dbId: p.dbId, name: p.name,
      address: f.address && f.zip ? { address: f.address, city: f.city ?? '', state: f.state ?? '', zip: f.zip } : null,
    };
  }) : [];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const blocked = listNavBlocked({
        vendorList: V.isVendorList,
        typing: isTypingTarget(t),
        dialogOrMenu: !!document.querySelector('[role="dialog"], [role="menu"]'),
        smartListOpen: V.smartListOpen,
        searchOpen: V.searchOpen,
        colsOpen: V.colsOpen,
        filterOpen: !!V.pfOpen,
      });
      // Ctrl+A checks every row; Shift+Delete archives (after the prompt).
      if (isSelectAllChord(e, blocked)) { e.preventDefault(); V.selectAllPeople(); return; }
      if (isArchiveKey(e, blocked)) { e.preventDefault(); V.archivePeopleKey(); return; }
      if (isOpenKey(e, blocked) && !(t && t.closest('button, a, [role="button"], input, select, textarea'))) { e.preventDefault(); V.openPeopleCursor(); return; }
      const action = peopleNavAction(e, 'list', blocked);
      if (!action) return;
      e.preventDefault();
      if (action.type === 'stage') V.shiftStage(action.dir);
      else if (action.type === 'in-list') V.moveInList(action.dir);
      else V.moveSmartList(action.dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [V]);
  // The cursor row in view: as the arrows move it, and on coming back from a
  // record (People remounts), where useReveal below has drawn far enough to hold it.
  useEffect(() => {
    document.querySelector('[data-people-focus="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [V.peopleCursor, V.peopleList]);
  const [peopleQText, setPeopleQText] = useDebouncedText(V.peopleQ, V.setPeopleQuery);
  // Draw a page of leads and add the next as the scroll nears the end, so a
  // five-figure list does not put every row in the DOM at once.
  const allRows = V.peopleRows || [];
  const allCards = V.mobilePeopleCards || [];
  const { shown: revealed, total: revealTotal, more, sentinel, showMore } = useReveal(V.isMobile ? allCards.length : allRows.length,
    `${V.peopleList}|${V.peopleQ}|${V.peopleSortColumn?.key}:${V.peopleSortColumn?.dir}|${V.isMobile}`, V.peopleCursor);
  const moreNote = more ? `Showing ${revealed.toLocaleString('en-US')} of ${revealTotal.toLocaleString('en-US')} · scroll for more` : '';
  // A search or filter that hides every lead says so, with the way out, not
  // "add one with Quick Add" as if the list were empty.
  const searching = !!V.peopleQ.trim();
  const filtering = V.activeFilterCount > 0;
  const noMatch = searching || filtering ? {
    hint: searching ? `Nothing in ${V.peopleList} matches “${V.peopleQ.trim()}”${filtering ? ' with these filters' : ''}.` : `Nothing in ${V.peopleList} passes these filters.`,
    label: searching && filtering ? 'Clear search and filters' : searching ? 'Clear search' : 'Clear filters',
    clear: () => { if (searching) setPeopleQText(''); if (filtering) V.clearFilters(); },
  } : null;
  return (
    <section data-screen-label="People" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: V.isMobile ? "column" : "row"}}>
      {(!V.isMobile && railOpen) ? (
        <>
      <aside style={{width: "276px", flex: "none", borderRight: "1px solid #e4e4e7", background: "#fff", overflow: "auto", padding: "14px 10px"}}>
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px 8px"}}>
          <span style={{fontSize: "11.5px", fontWeight: "500", color: "#71717a"}}>
            Smart lists
          </span>
          <span style={{display: "inline-flex", alignItems: "center", gap: "2px"}}>
            <button className="dc6" onClick={V.saveSmartList} title="Save the current filters as a smart list" aria-label="Save the current filters as a smart list" style={{width: "28px", height: "28px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", color: "#52525b", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <RailToggle open onToggle={toggleRail} />
          </span>
        </div>
        {(V.operationalLists || V.smartLists || []).map((l: { label: string; count: number; go: () => void; bg: string; color: string; weight: number; pin: string; pinned?: boolean }, l__i: number) => (
          <React.Fragment key={l.label}>
          <button className="dc2" onClick={l.go} draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/plain', l.label); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(l.label); }}
            onDragLeave={() => setDragOver((cur) => cur === l.label ? null : cur)}
            onDrop={(e) => { e.preventDefault(); setDragOver(null); const from = e.dataTransfer.getData('text/plain'); if (from) V.dropSmartList(from, l.label); }}
            onContextMenu={(e) => { e.preventDefault(); setPinMenu({ label: l.label, x: e.clientX, y: e.clientY, pinned: !!l.pinned }); }}
            title={l.pinned ? 'Pinned · drag to reorder · right-click to unpin' : 'Drag to reorder · right-click to pin'}
            aria-current={l.weight === 600 ? 'page' : undefined}
            style={{display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", height: "30px", padding: "0 8px", border: "0", borderRadius: "8px", cursor: "grab", fontSize: "13px", textAlign: "left", background: dragOver === l.label ? '#f4f4f5' : l.weight === 600 ? '#fff' : l.bg, boxShadow: l.weight === 600 ? '0 0 0 1px rgba(24,24,27,.07), 0 1px 2px rgba(24,24,27,.05)' : 'none', color: l.weight === 600 ? '#18181b' : l.color, fontWeight: l.weight, outline: dragOver === l.label ? '1px dashed #a1a1aa' : 'none'}}>
            <span style={{display: "inline-flex", alignItems: "center", gap: "7px"}}>
              <span style={{ color: l.pin, display: 'inline-flex' }}><Mark label={l.label} /></span>
              {l.label}
            </span>
            <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>
              {l.count}
            </span>
          </button>
          </React.Fragment>
        ))}
        {(V.submissionNav || []).length ? (
          <>
          <div style={{fontSize: "11.5px", fontWeight: "500", color: "#71717a", padding: "18px 8px 6px"}}>
            Submissions
          </div>
          {(V.submissionNav || []).map((g: { label: string; count: number; go: () => void; bg: string; color: string; weight: number; children: { label: string; count: number; go: () => void; bg: string; color: string; weight: number }[] }, g__i: number) => (
            <React.Fragment key={g__i}>
              <button className="dc2" onClick={g.go} style={{display: "flex", alignItems: "center", gap: "8px", width: "100%", height: "30px", padding: "0 8px", border: "0", borderRadius: "7px", cursor: "pointer", fontSize: "13px", textAlign: "left", background: g.bg, color: g.color, fontWeight: g.weight || 650}}>
                <span style={{minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{g.label}</span>
                <span style={{fontSize: "11.5px", color: "#a1a1aa", fontVariantNumeric: "tabular-nums", flex: "none"}}>{g.count.toLocaleString('en-US')}</span>
              </button>
              {(g.children || []).map((c, c__i) => (
                <button key={c__i} className="dc2" onClick={c.go} style={{display: "flex", alignItems: "center", gap: "8px", width: "100%", height: "28px", padding: "0 8px 0 22px", border: "0", borderRadius: "7px", cursor: "pointer", fontSize: "12.5px", textAlign: "left", background: c.bg, color: c.color, fontWeight: c.weight}}>
                  <span style={{display: "flex", alignItems: "center", gap: "7px", minWidth: 0, flex: "1 1 auto"}}>
                    <span style={{width: "6px", height: "6px", borderRadius: "999px", background: c.color === '#0A8560' ? '#0A8560' : '#a1a1aa', flex: "none"}} />
                    <span style={{minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{c.label}</span>
                  </span>
                  <span style={{fontSize: "11.5px", color: "#a1a1aa", fontVariantNumeric: "tabular-nums", flex: "none"}}>{c.count.toLocaleString('en-US')}</span>
                </button>
              ))}
            </React.Fragment>
          ))}
          </>
        ) : null}
        {(V.hasSavedLists) ? (
          <>
          <div style={{fontSize: "11.5px", fontWeight: "500", color: "#71717a", padding: "18px 8px 6px"}}>
            Saved lists
          </div>
          {(V.savedListRows || []).map((l, l__i) => (
            <React.Fragment key={l__i}>
            <button className="dc2" onClick={l.go} title={l.accessLabel} style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", width: "100%", height: "30px", padding: "0 8px", border: "0", borderRadius: "7px", cursor: "pointer", fontSize: "13px", textAlign: "left", background: l.bg, color: l.color, fontWeight: l.weight}}>
              <span style={{minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                {l.label}
                <span style={{marginLeft: "6px", fontSize: "10px", color: "#a1a1aa", fontWeight: 500}}>{l.accessLabel}</span>
              </span>
              <span style={{display: "inline-flex", alignItems: "center", gap: "6px", flex: "none"}}>
                <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>
                  {l.count}
                </span>
                {l.canRemove ? <SavedListDelete name={l.label} onDelete={l.remove} /> : null}
              </span>
            </button>
            </React.Fragment>
          ))}
          </>
        ) : null}
        <div style={{fontSize: "11.5px", fontWeight: "500", color: "#71717a", padding: "18px 8px 6px"}}>
          Custom lists
        </div>
        {(V.customLists || []).map((l, l__i) => (
          <React.Fragment key={l__i}>
          <button className="dc2" onClick={l.go} disabled={l.disabled} title={l.title} style={{display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", height: "30px", padding: "0 8px", border: "0", borderRadius: "7px", cursor: l.disabled ? "not-allowed" : "pointer", fontSize: "13px", textAlign: "left", background: l.bg, color: l.color, fontWeight: l.weight}}>
            <span style={{display: "inline-flex", alignItems: "center", gap: "8px"}}>
              <span aria-hidden style={{width: "8px", height: "8px", borderRadius: "999px", background: l.disabled ? "#e4e4e7" : typeTone(l.label).fg, flex: "none"}}></span>
              {l.label}
            </span>
            <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>
              {l.count}
            </span>
          </button>
          </React.Fragment>
        ))}
        <div style={{margin: "16px 8px 0", paddingTop: "12px", borderTop: "1px solid #f0f0f1", fontSize: "11.5px", color: "#a1a1aa", lineHeight: "1.5"}}>
          Drag to reorder · right-click to pin
        </div>
        {pinMenu ? (
          <>
          <div onClick={() => setPinMenu(null)} style={{position: "fixed", inset: 0, zIndex: 80}} />
          <div role="menu" style={{position: "fixed", top: pinMenu.y, left: pinMenu.x, zIndex: 81, minWidth: "160px", background: "#fff", border: "1px solid #e4e4e7", borderRadius: "10px", boxShadow: "0 12px 32px rgba(24,24,27,.16)", padding: "4px"}}>
            <button type="button" role="menuitem" onClick={() => { V.pinSmartList(pinMenu.label); setPinMenu(null); }}
              style={{display: "block", width: "100%", textAlign: "left", border: 0, background: "none", padding: "8px 10px", borderRadius: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 600}}>
              {pinMenu.pinned ? 'Unpin ' : 'Pin '}{pinMenu.label}
            </button>
          </div>
          </>
        ) : null}
      </aside>
        </>
      ) : null}
      <div style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
        {/* Two rows on purpose: the title, count and actions on one, every filter on
            the next, left-aligned. One wrapping row used to break the filters across
            two ragged, right-aligned lines under the title. */}
        <div style={{display: V.isMobile ? "none" : "block", position: "relative", zIndex: 3, borderBottom: "1px solid #e4e4e7", background: "#fff"}}>
        <div style={{display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px 8px"}}>
          {!railOpen ? <RailToggle open={false} onToggle={toggleRail} /> : null}
          <h1 style={{margin: "0", fontSize: "18px", fontWeight: "700", letterSpacing: "-0.02em", whiteSpace: "nowrap"}}>
            {V.peopleList === 'Last import' && V.lastImportLabel ? V.lastImportLabel : V.peopleList}
          </h1>
          <span style={{fontSize: "12px", color: "#71717a", whiteSpace: "nowrap"}}>
            {V.isVendorList ? V.vendorCount : V.peopleCount} {V.isVendorList ? 'vendors' : (V.listNoun || 'people')}{V.crmPartial && !V.isVendorList ? ' so far · loading the rest…' : ''}
          </span>
          {V.podioOnlyNote ? <span data-testid="podio-only-note" style={{fontSize: "12px", color: "#a1a1aa", whiteSpace: "nowrap"}}>{V.podioOnlyNote}</span> : null}
          {V.subPartnerChip ? (
            <span data-testid="sub-partner-chip" style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "26px", padding: "0 4px 0 10px", borderRadius: "999px", background: "#eff6ff", border: "1px solid #bfdbfe", fontSize: "12px", fontWeight: 600, color: "#1d4ed8", whiteSpace: "nowrap"}}>
              <button type="button" onClick={V.subPartnerChip.open} title="Open the partner's own record" style={{border: 0, background: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer"}}>{V.subPartnerChip.label}</button>
              <button type="button" onClick={V.subPartnerChip.clear} aria-label="Show every partner's submissions" style={{width: "20px", height: "20px", borderRadius: "50%", border: 0, background: "#dbeafe", color: "#1d4ed8", cursor: "pointer", lineHeight: 1}}>×</button>
            </span>
          ) : null}
          <div style={{flex: "1"}}></div>
          <div style={{display: "flex", alignItems: "center", gap: "8px", height: "32px", padding: "0 10px", border: "1px solid #e4e4e7", borderRadius: "8px", background: "#fafafa", width: "220px"}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input value={peopleQText} onChange={(e) => setPeopleQText(e.target.value)} placeholder="Search this list" style={{border: "0", background: "none", outline: "0", fontSize: "13px", width: "100%", color: "#18181b"}} />
          </div>
          {!V.isVendorList ? <ContractsButton V={V} /> : null}
          <button className="dc10" onClick={() => V.openImport(V.peopleImportKind)} title={V.peopleImportKind === 'submissions' ? 'Import a vendor’s list of submissions (Excel, CSV or a Google Sheet)' : V.isVendorList ? 'Bulk import vendors from a file, a Google Sheet or a paste' : 'Bulk import sellers from a file, a Google Sheet or a paste'} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px"}}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
            Import
          </button>
          {/* One filled button per view: Import carries the fill. */}
          <button className="cz-btn" onClick={V.saveSmartList}>
            Save smart list
          </button>
        </div>
        <div style={{display: "flex", alignItems: "center", gap: "8px", padding: "0 16px 10px", flexWrap: "wrap"}}>
          {!V.isVendorList ? (
            <>
              <ListMapSwitch value={view} onChange={setView} />
              <PeopleViews V={V} />
              <ColumnPicker all={V.peopleColDefs} value={V.peopleColKeys} onChange={V.setPeopleCols} defaults={V.peopleColDefaults}
                title="Fields in this list" note={`Saved with ${V.peopleList} — each smart list keeps its own fields. Save a view to keep this look.`} />
            </>
          ) : null}
          {V.isVendorList ? (
            <div role="tablist" aria-label="Vendor view" style={segWrap}>
              {(V.vendorViewToggle || []).map((t) => (
                <button key={t.label} type="button" role="tab" aria-selected={t.on} onClick={t.go} style={seg(t.on)}>{t.label}</button>
              ))}
            </div>
          ) : null}
          {(V.peopleFilterMenus || []).filter((f) => f.key === 'sort').map((f, f__i) => (
            <React.Fragment key={f__i}>
            <div style={{position: "relative"}}>
              <button className="dc9 cz-menu-trigger" onClick={f.toggle} style={{height: "32px", padding: "0 10px", borderRadius: "10px", border: `1px solid ${f.border}`, background: f.bg, fontSize: "12.5px", color: f.color, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap", fontWeight: f.on ? "600" : "500", fontFamily: "var(--font-sans)"}}>
                {f.on ? f.value : f.label}
                <Chevron size={11} color={f.on ? CZ.mint : CZ.faint} />
              </button>
              {(f.open && f.searchable) ? (
                <SearchSelectMenu multi={'multi' in f && !!f.multi} options={f.options} onClose={V.closeFilterMenus} placeholder={`Search ${f.label.toLowerCase()}…`} />
              ) : (f.open) ? (
                <>
                <div onClick={V.closeFilterMenus} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
                <div ref={keepInView} className="cz-menu cz-menu--left" style={{top: "38px", left: "0", minWidth: "208px", maxHeight: "min(360px, 48vh)", overflow: "auto"}}>
                  {(f.options || []).map((o, o__i) => (
                    <React.Fragment key={o__i}>
                    <button type="button" className={"dc2 cz-menu-item" + (o.on ? " is-on" : "")} onClick={o.go} aria-pressed={'multi' in f && f.multi ? o.on : undefined}>
                      <PickLabel multi={'multi' in f && !!f.multi} on={o.on} label={o.label} />
                      {(o.on && !('multi' in f && f.multi && o.label !== 'Any')) ? (
                        <>
                        <span style={{fontSize: "11px"}}>
                          ✓
                        </span>
                        </>
                      ) : null}
                    </button>
                    </React.Fragment>
                  ))}
                  {('multi' in f && f.multi) ? <div style={{padding: "6px 10px 4px", fontSize: "11px", color: "#a1a1aa"}}>Pick as many as you like</div> : null}
                </div>
                </>
              ) : null}
            </div>
            </React.Fragment>
          ))}
          <FilterPanel
            menus={(V.peopleFilterMenus || []).filter((f) => f.key !== 'sort')}
            active={V.activeFilterCount}
            onReset={V.clearFilters}
            onClose={V.closeFilterMenus}
            showLabel={`Show ${V.isVendorList ? V.vendorCount : V.peopleCount} ${V.isVendorList ? 'vendors' : (V.listNoun || 'people')}`}>
            {!V.isVendorList ? <div className="cz-fp-more"><MoreFiltersFields V={V} /></div> : null}
          </FilterPanel>
          {(V.hasActiveFilters) ? (
            <>
            <button className="dc12" onClick={V.clearFilters} style={{height: "32px", padding: "0 8px", background: "none", border: "0", fontSize: "12px", color: "#0A8560", cursor: "pointer", whiteSpace: "nowrap"}}>
              Reset
            </button>
            </>
          ) : null}
        </div>
        </div>
        {(V.hasSelection) ? (
          <>
          {/* Wraps instead of squeezing: fixed-height buttons in a no-wrap row
              broke "Start Action Plan" onto two lines inside a 28px pill and
              pushed Export, Archive and Clear off the right edge. */}
          <div role="toolbar" aria-label="Bulk actions" style={{display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", padding: "8px 16px", background: "#E7F8F1", borderBottom: "1px solid rgba(10, 133, 96,.2)", animation: "clozrFade .14s", minWidth: 0}}>
            <span role="status" style={{fontSize: "12.5px", fontWeight: "600", color: "#0A8560", marginRight: "8px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums"}}>
              {V.selectionCount} selected
            </span>
            {/* The few kept on the bar; the rest live under Actions ▾ (app/components/bulk/ActionsMenu). */}
            {(V.massActions || []).filter((a) => BAR_ACTIONS.has(a.label)).map((a) => (
              <button key={a.label} className="dc11" onClick={a.go} style={{height: "28px", flex: "none", whiteSpace: "nowrap", padding: "0 10px", borderRadius: "7px", border: "1px solid rgba(10, 133, 96,.25)", background: "#fff", fontSize: "12px", color: "#18181b", cursor: "pointer", fontWeight: "500"}}>
                {a.label}
              </button>
            ))}
            {agentIds.length ? (
              <button className="dc11" onClick={() => { setAgentPanel(!agentPanel); setTracing(false); }} aria-pressed={agentPanel} title="Switch an AI agent on or off for the selected sellers" style={{height: "28px", flex: "none", whiteSpace: "nowrap", padding: "0 10px", borderRadius: "7px", border: "1px solid rgba(10,133,96,.3)", background: agentPanel ? "#E7F5EF" : "#fff", fontSize: "12px", color: "#08694C", cursor: "pointer", fontWeight: "600"}}>
                ✦ AI agent
              </button>
            ) : null}
            <ActionsMenu actions={[
              ...(V.massActions || []).filter((a) => !BAR_ACTIONS.has(a.label)).map((a) => ({
                key: a.label, label: a.label, group: MENU_GROUP[a.label] ?? 'More', danger: a.label === 'Archive', run: a.go,
              })),
              ...(campaignSellers.length ? [{ key: 'talkr-campaign', label: 'Send to Talkr campaign', group: 'Reach out', note: 'every good number', run: () => setToCampaign(true) }] : []),
              ...(traceRecords.length ? [{ key: 'trace', label: 'Skip trace', group: 'Data', note: 'find phones & emails', run: () => { setTracing(true); setAgentPanel(false); } }] : []),
              ...(agentIds.length ? [{ key: 'text-sequence', label: 'Automated texts', group: 'Reach out', note: 'enroll in a Talkr sequence', run: () => { setSeqPanel(true); setTracing(false); setAgentPanel(false); } }] : []),
            ].sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group))} />
            <div style={{flex: "1 0 0px"}}></div>
            <SelectCount listCount={V.peopleAssign.listCount} ownerAware={!V.isVendorList} onSelect={(n, unassigned) => V.selectFirstPeople(n, unassigned)} />
            <button onClick={V.clearSelection} style={{height: "28px", flex: "none", whiteSpace: "nowrap", padding: "0 10px", borderRadius: "7px", border: "0", background: "none", fontSize: "12px", color: "#0A8560", cursor: "pointer"}}>
              Clear
            </button>
          </div>
          {toCampaign && campaignSellers.length ? (
            <SendToCampaign sellers={campaignSellers} workspaceId={pb.workspaceId} onClose={() => setToCampaign(false)}
              onDone={(msg) => { setToCampaign(false); V.clearSelection(); pb.toast(msg); }} />
          ) : null}
          {tracing && traceRecords.length ? (
            <BulkSkipTrace kind="seller" records={traceRecords} workspaceId={pb.workspaceId} canWrite={pb.canWrite}
              userId={V.liveIds?.userId ?? null} toast={pb.toast} onDone={() => pb.reload?.()} onClose={() => setTracing(false)} />
          ) : null}
          {seqPanel && agentIds.length ? (
            <EnrollSellersPanel
              sellers={pb.people.filter((p) => p.dbId > 0).map((p) => {
                const f = p.fields as Partial<Record<'address' | 'city' | 'state' | 'zip', string>>;
                return { name: p.name, phone: p.phone, address: f.address ? { line1: f.address, city: f.city, state: f.state, postal_code: f.zip } : undefined };
              })}
              onClose={() => setSeqPanel(false)} onDone={(msg) => { setSeqPanel(false); V.clearSelection(); pb.toast(msg); }} />
          ) : null}
          {agentPanel && agentIds.length ? (
            <BulkAgentPanel kind="seller" workspaceId={pb.workspaceId} canWrite={pb.canWrite} selectedIds={agentIds} records={agentRecords} toast={pb.toast}
              onClose={() => setAgentPanel(false)} onDone={(msg) => { setAgentPanel(false); V.clearSelection(); pb.reload?.(); pb.toast(msg); }} />
          ) : null}
          {V.peopleAssign.open ? (
            <AssignPanel noun={{ one: 'lead', many: 'leads' }} team={V.peopleAssign.team} selectedIds={V.peopleAssign.selectedIds}
              listCount={V.peopleAssign.listCount} canWrite={pb.canWrite} onSelectFirst={V.peopleAssign.selectFirst}
              onAssign={V.peopleAssign.assign} onClose={V.peopleAssign.close} />
          ) : V.bulkMenu ? (
            <div style={{display: "flex", flexWrap: "wrap", gap: "6px", padding: "8px 14px", background: "#fff", borderBottom: "1px solid #e4e4e7"}}>
              <span style={{fontSize: "10.5px", letterSpacing: ".08em", textTransform: "uppercase", color: "#71717a", fontWeight: 600, alignSelf: "center", marginRight: "4px"}}>
                {V.bulkMenu === 'assign' ? 'Assign to' : V.bulkMenu === 'stage' ? 'Move to' : 'Enrol in'}
              </span>
              {(V.bulkMenuOptions || []).map((o, o__i) => (
                <button key={o__i} className="dc2" onClick={o.go} style={{height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", cursor: "pointer", color: "#18181b"}}>
                  {o.label}
                </button>
              ))}
              {(V.bulkMenuOptions || []).length === 0 ? <span style={{fontSize: "12px", color: "#a1a1aa", alignSelf: "center"}}>Nothing to pick from yet</span> : null}
              <button onClick={V.closeBulkMenu} style={{height: "28px", padding: "0 8px", border: "0", background: "none", fontSize: "12px", cursor: "pointer", color: "#71717a"}}>Cancel</button>
            </div>
          ) : null}
          </>
        ) : null}
        {(V.isMobile) ? (
          <>
          <div style={{flex: "none", background: "#fff", borderBottom: "1px solid #e4e4e7", padding: "10px 0 10px 10px"}}>
            <div style={{display: "flex", alignItems: "baseline", gap: "8px", padding: "0 10px 8px 2px"}}>
              <span style={{fontSize: "19px", fontWeight: "700", letterSpacing: "-0.03em"}}>
                {V.peopleList}
              </span>
              <span style={{fontSize: "12.5px", color: "#71717a"}}>
                {V.isVendorList ? V.vendorCount : V.peopleCount} {V.isVendorList ? 'vendors' : (V.listNoun || 'people')}{V.crmPartial && !V.isVendorList ? ' so far · loading…' : ''}
              </span>
              {V.subPartnerChip ? (
                <span data-testid="sub-partner-chip" style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "26px", padding: "0 4px 0 10px", borderRadius: "999px", background: "#eff6ff", border: "1px solid #bfdbfe", fontSize: "12px", fontWeight: 600, color: "#1d4ed8", whiteSpace: "nowrap"}}>
                  <button type="button" onClick={V.subPartnerChip.open} title="Open the partner's own record" style={{border: 0, background: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer"}}>{V.subPartnerChip.label}</button>
                  <button type="button" onClick={V.subPartnerChip.clear} aria-label="Show every partner's submissions" style={{width: "20px", height: "20px", borderRadius: "50%", border: 0, background: "#dbeafe", color: "#1d4ed8", cursor: "pointer", lineHeight: 1}}>×</button>
                </span>
              ) : null}
              <span style={{flex: "1"}}></span>
              {!V.isVendorList ? <ContractsButton V={V} /> : null}
              <button onClick={() => V.openImport(V.peopleImportKind)} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px", alignSelf: "center"}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                Import
              </button>
            </div>
            {/* The desk header (and its search) is hidden on a phone, so the list gets its own. */}
            <div style={{display: "flex", alignItems: "center", gap: "8px", height: "36px", margin: "0 10px 8px 0", padding: "0 10px", border: "1px solid #e4e4e7", borderRadius: "9px", background: "#fafafa"}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input type="search" value={peopleQText} onChange={(e) => setPeopleQText(e.target.value)} placeholder="Search this list" aria-label="Search this list" style={{border: "0", background: "none", outline: "0", fontSize: "16px", width: "100%", minWidth: 0, color: "#18181b"}} />
            </div>
            <div style={{display: "flex", gap: "6px", overflowX: "auto", paddingRight: "10px", paddingBottom: "2px"}}>
              {!V.isVendorList ? <ListMapSwitch value={view} onChange={setView} pill /> : null}
              {(V.mobileLists || []).map((l, l__i) => (
                <React.Fragment key={l__i}>
                <button type="button" onClick={l.go} style={{...trayBtn(l.on), border: `1px solid ${l.border}`, background: l.bg, color: l.color}}>
                  {l.label}
                  <span style={{fontSize: "11px", opacity: ".65"}}>
                    {l.count}
                  </span>
                </button>
                </React.Fragment>
              ))}
              {(V.peopleFilterMenus || []).filter((f) => f.key === 'sort').map((f) => (
                <div key={f.key} style={{position: "relative", flex: "none"}}>
                  <button type="button" className="dc9 cz-menu-trigger" onClick={f.toggle} style={{...trayBtn(f.on), border: `1px solid ${f.border}`, background: f.bg, color: f.color, fontWeight: f.on ? 600 : 500}}>
                    {f.on ? f.value : f.label}
                    <Chevron size={11} color={f.on ? CZ.mint : CZ.faint} />
                  </button>
                  {f.open ? (
                    <>
                    <div onClick={V.closeFilterMenus} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
                    <div ref={keepInView} className="cz-menu cz-menu--left" style={{top: "38px", left: "0", minWidth: "208px", maxHeight: "min(360px, 48vh)", overflow: "auto"}}>
                      {(f.options || []).map((o, o__i) => (
                        <button key={o__i} type="button" className={"dc2 cz-menu-item" + (o.on ? " is-on" : "")} onClick={o.go}>
                          {o.label}
                          {o.on ? <span style={{fontSize: "11px"}}>✓</span> : null}
                        </button>
                      ))}
                    </div>
                    </>
                  ) : null}
                </div>
              ))}
              {!V.isVendorList ? <MoreFilters V={V} sheet /> : null}
              {V.hasActiveFilters ? (
                <button type="button" className="dc12" onClick={V.clearFilters} style={{height: "32px", padding: "0 8px", background: "none", border: "0", fontSize: "12px", color: "#0A8560", cursor: "pointer", whiteSpace: "nowrap"}}>
                  Reset
                </button>
              ) : null}
            </div>
          </div>
          </>
        ) : null}
        {onMap ? (
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0 }}>
              <PeopleMap V={V} height="100%" />
            </div>
          </div>
        ) : null}
        {(V.isMobile && !V.isVendorList && !onMap) ? (
          <>
          <div style={{flex: "1", minHeight: "0", overflow: "auto", background: "#fafafa", padding: "10px 10px calc(96px + env(safe-area-inset-bottom, 0px))"}}>
            {allCards.slice(0, revealed).map((p, p__i) => (
              <React.Fragment key={p__i}>
              <div role="button" tabIndex={0} onClick={p.open} onKeyDown={V.cardKey} data-people-focus={p.focused ? 'true' : 'false'} style={{background: "#fff", border: `1px solid ${p.focused ? '#a7f3d0' : '#e4e4e7'}`, borderRadius: "13px", padding: "12px 13px", marginBottom: "8px", cursor: "pointer"}}>
                <div style={{display: "flex", alignItems: "center", gap: "10px"}}>
                  <span style={{width: "34px", height: "34px", borderRadius: "9px", background: "#f4f4f5", display: "grid", placeItems: "center", fontSize: "11.5px", fontWeight: "700", color: "#52525b", flex: "none"}}>
                    {p.initials}
                  </span>
                  <span style={{minWidth: "0", flex: "1"}}>
                    <span style={{display: "block", fontSize: "15px", fontWeight: "600", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {p.name}
                    </span>
                    <span style={{display: "block", fontSize: "12.5px", color: "#71717a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {p.addr} · {p.cityLine}
                    </span>
                  </span>
                  {/* No number: the button stays, greyed, and says so when tapped rather than doing nothing. */}
                  <button className="clozr-talkr-ghost" onClick={p.call} title={p.hasPhone ? 'Call' : 'No phone'} aria-label={p.hasPhone ? `Call ${p.name}` : `No phone for ${p.name}`} style={{color: p.hasPhone ? "var(--c-talkr)" : "#d4d4d8", width: "38px", height: "38px", borderRadius: "10px", border: `1px solid ${p.hasPhone ? '#fecdd3' : '#e4e4e7'}`, background: "var(--c-btn-bg)", display: "grid", placeItems: "center", cursor: p.hasPhone ? "pointer" : "default", flex: "none", }}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
                    </svg>
                  </button>
                </div>
                <div style={{display: "flex", alignItems: "center", gap: "10px", marginTop: "10px", flexWrap: "wrap"}}>
                  <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "10.5px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: p.stageColor}}>
                    <Mark label={p.stage} />
                    {p.stage}
                  </span>
                  {(p.hasScore) ? (
                  <span style={{display: "inline-flex", alignItems: "center", gap: "6px"}}>
                    <span style={{width: "34px", height: "4px", borderRadius: "2px", background: "#f0f0f1", overflow: "hidden", display: "inline-block"}}>
                      <span style={{display: "block", height: "100%", width: p.score + "%", background: p.scoreColor}}></span>
                    </span>
                    <span style={{fontSize: "12px", fontWeight: "700", color: p.scoreColor}}>
                      {p.score}
                    </span>
                  </span>
                  ) : (p.temp) ? (
                  <span style={{fontSize: "10.5px", fontWeight: "700", letterSpacing: ".08em", color: p.tempColor}}>
                    {p.temp}
                  </span>
                  ) : null}
                  <span style={{flex: "1"}}></span>
                  <span style={{fontSize: "11.5px", color: "#a1a1aa", textAlign: "right"}}>
                    {p.added ? <span style={{display: "block"}}>Added {p.added}</span> : null}
                    <span style={{display: "block"}}>{p.last}</span>
                  </span>
                </div>
                <div style={{marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #f0f0f1", fontSize: "12.5px", color: "#27272a", display: "flex", gap: "8px"}}>
                  <span style={{minWidth: "0", flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                    {p.next}
                  </span>
                  <span style={{fontSize: "11.5px", color: "#a1a1aa", whiteSpace: "nowrap"}}>
                    {p.assigned}
                  </span>
                </div>
              </div>
              </React.Fragment>
            ))}
            {allCards.length === 0 ? (
              V.crmPartial ? (
                <SkeletonRows count={4} label="Loading leads…" />
              ) : noMatch ? (
                <Empty compact title="No leads match" hint={noMatch.hint} action={noMatch.clear} actionLabel={noMatch.label} />
              ) : (
                // A phone showed a blank page here: no message, no Retry.
                <Empty compact title="No leads in this list" hint="Leads land here from Deal Machine and Talkr, or you can add one with Quick Add." failed={!V.crmOk} onRetry={V.reloadCrm} />
              )
            ) : null}
            {more ? (
              <button type="button" ref={sentinel} onClick={showMore} className="dc2" style={{width: "100%", height: "40px", borderRadius: "10px", border: "1px dashed #e4e4e7", background: "#fff", color: "#71717a", fontSize: "12.5px", cursor: "pointer", fontVariantNumeric: "tabular-nums"}}>
                {moreNote}
              </button>
            ) : null}
          </div>
          </>
        ) : null}
        {V.vendorGrouped ? <VendorGroups V={V} /> : null}
        {(V.isVendorList && V.isMobile && !V.vendorGrouped) ? (
          <>
          {/* The 8-column vendor table is 1040px wide; a phone gets the same rows as cards. */}
          <div style={{flex: "1", minHeight: "0", overflow: "auto", background: "#fafafa", padding: "10px 10px calc(96px + env(safe-area-inset-bottom, 0px))", display: "flex", flexDirection: "column", gap: "8px"}}>
            {(V.vendorRows || []).map((v, v__i) => (
              <div key={v__i} style={{background: v.rowBg, border: "1px solid #e4e4e7", borderRadius: "12px", padding: "11px 12px", display: "flex", flexDirection: "column", gap: "6px", minWidth: "0"}}>
                <div style={{display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px"}}>
                  <input type="checkbox" checked={!!(v.checked)} onChange={v.toggle} aria-label={`Select ${v.name}`} style={{width: "16px", height: "16px", accentColor: "#0A8560", cursor: "pointer", flex: "none", alignSelf: "center"}} />
                  <span style={{fontWeight: "600", fontSize: "14px", minWidth: "0", flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{v.name}</span>
                  <TypeChip kind={v.kind} />
                </div>
                <div style={{fontSize: "12px", color: "#71717a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{v.contact}{v.market && v.market !== '—' ? ` · ${v.market}` : ''}</div>
                <div style={{display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", fontSize: "12.5px"}}>
                  <button className="dc12 clozr-contact" onClick={v.call} style={{background: "none", border: "0", padding: "0", fontSize: "12.5px", cursor: "pointer", fontWeight: "500"}}>{v.phone}</button>
                  <span className="clozr-contact" style={{minWidth: "0", overflow: "hidden", textOverflow: "ellipsis"}}>{v.email}</span>
                  <span style={{color: v.rated ? "#d97706" : "#d4d4d8", letterSpacing: "1px", marginLeft: "auto"}}>{v.stars}</span>
                </div>
                {v.subsLine ? <div style={{fontSize: "11.5px", color: "#27272a", fontWeight: 600, fontVariantNumeric: "tabular-nums"}}>{v.subsLine}</div> : null}
                {V.hasGaps && v.openGaps ? (
                  <button className="dc12" onClick={v.openGaps} style={{alignSelf: "flex-start", background: "none", border: "0", padding: "0", fontSize: "11.5px", color: v.hasCloseCalls ? "#0A8560" : "#71717a", fontWeight: v.hasCloseCalls ? "600" : "400", cursor: "pointer", textAlign: "left"}}>
                    {v.closeCalls} close {v.closeCalls === '1' ? 'call' : 'calls'} · closest {v.closestGap} · {v.offers} offered
                  </button>
                ) : null}
                {v.note ? <div style={{fontSize: "11.5px", color: "#a1a1aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{v.note}</div> : null}
              </div>
            ))}
          </div>
          </>
        ) : null}
        {(V.isVendorList && !V.isMobile && !V.vendorGrouped) ? (
          <>
          <div style={{flex: "1", minHeight: "0", overflow: "auto", background: "#fff"}}>
            <table style={{width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px", minWidth: `${(V.hasGaps ? 1440 : 1080) + (V.vendorHasSubs ? 380 : 0)}px`}}>
              <thead>
                <tr>
                  <th style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", padding: "0 12px", height: "36px", width: "36px", textAlign: "left"}}>
                    <input type="checkbox" onChange={V.toggleAll} checked={!!(V.allSelected)} aria-label="Select all" style={{width: "14px", height: "14px", accentColor: "#0A8560", cursor: "pointer"}} />
                  </th>
                  {(V.vendorCols || []).map((c, c__i) => (
                    <React.Fragment key={c__i}>
                    <th style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", padding: "0 12px", height: "36px", textAlign: "left", fontSize: "10.5px", fontWeight: "600", letterSpacing: "0.08em", textTransform: "uppercase", color: "#71717a", whiteSpace: "nowrap"}}>
                      {c}
                    </th>
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(V.vendorRows || []).map((v, v__i) => (
                  <React.Fragment key={v__i}>
                  <tr className="dc2" style={{background: v.rowBg, transition: "background .1s"}}>
                    <td style={{padding: "0 12px", height: "44px", borderBottom: "1px solid #f0f0f1"}}>
                      <input type="checkbox" checked={!!(v.checked)} onChange={v.toggle} aria-label={`Select ${v.name}`} style={{width: "14px", height: "14px", accentColor: "#0A8560", cursor: "pointer"}} />
                    </td>
                    <td style={{padding: "0 12px", height: "44px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                      <span style={{display: "block", fontWeight: "600", color: "#18181b"}}>
                        {v.name}
                      </span>
                      <span style={{display: "block", fontSize: "11px", color: "#a1a1aa", maxWidth: "320px", overflow: "hidden", textOverflow: "ellipsis"}}>
                        {v.note}
                      </span>
                      {v.scoreLine ? (
                        <span style={{display: "block", marginTop: "2px", fontSize: "11px", fontWeight: 650, color: "#27272a", whiteSpace: "nowrap"}}>
                          {v.scoreLine}{v.national ? ' · national · no email follow-up' : ''}
                        </span>
                      ) : null}
                    </td>
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                      <TypeChip kind={v.kind} />
                    </td>
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#27272a"}}>
                      {v.contact}
                    </td>
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                      <button className="dc12 clozr-contact" onClick={v.call} style={{background: "none", border: "0", padding: "0", fontSize: "12.5px", cursor: "pointer"}}>
                        {v.phone}
                      </button>
                    </td>
                    <td className="clozr-contact" style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                      {v.email}
                    </td>
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#52525b"}}>
                      {v.market}
                    </td>
                    {V.vendorHasSubs ? (
                      <>
                      <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", textAlign: "right", fontWeight: 600, color: "#18181b", fontVariantNumeric: "tabular-nums"}}>
                        {v.subs}
                      </td>
                      {[v.offered, v.accepted, v.closed].map((n, i) => (
                        <td key={i} style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", textAlign: "right", color: "#52525b", fontVariantNumeric: "tabular-nums"}}>
                          {n}
                        </td>
                      ))}
                      </>
                    ) : null}
                    {V.hasGaps ? (
                      <>
                      <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#52525b", textAlign: "right", fontVariantNumeric: "tabular-nums"}}>
                        {v.offers}
                      </td>
                      <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", textAlign: "right", fontVariantNumeric: "tabular-nums"}}>
                        {v.openGaps ? (
                          <button className="dc12" onClick={v.openGaps} title={`Show every deal we offered on for ${v.name}`} style={{background: "none", border: "0", padding: "0", fontSize: "12.5px", fontWeight: v.hasCloseCalls ? "600" : "400", color: v.hasCloseCalls ? "#0A8560" : "#52525b", cursor: "pointer", fontVariantNumeric: "tabular-nums"}}>
                            {v.closeCalls}
                          </button>
                        ) : (
                          <span style={{color: "#a1a1aa"}}>
                            {v.closeCalls}
                          </span>
                        )}
                      </td>
                      <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", textAlign: "right", color: v.hasCloseCalls ? "#0A8560" : "#52525b", fontWeight: v.hasCloseCalls ? "600" : "400", fontVariantNumeric: "tabular-nums"}}>
                        {v.closestGap}
                      </td>
                      <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#52525b", textAlign: "right", fontVariantNumeric: "tabular-nums"}}>
                        {v.declined}
                      </td>
                      </>
                    ) : null}
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: v.rated ? "#d97706" : "#d4d4d8", letterSpacing: "1px"}}>
                      {v.stars}
                    </td>
                  </tr>
                  </React.Fragment>
                ))}
            </tbody>
            </table>
          </div>
          </>
        ) : null}
        {(!V.isVendorList && !V.isMobile && !onMap) ? (
          <>
        <div className="clozr-scroll-well" style={{flex: "1", minHeight: "0", overflow: "auto", background: "var(--page)", padding: "14px 20px 20px", scrollPadding: "54px 20px 20px"}}>
          <div style={{minWidth: "100%", width: "max-content", background: "#fff", border: "1px solid #ececee", borderRadius: "12px", overflow: "clip"}}>
          <table style={{width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px", minWidth: `${Math.max(900, (V.peopleColumns || []).length * 118)}px`}}>
            <thead>
              <tr>
                <th style={{position: "sticky", top: "0", background: "#fff", borderBottom: "1px solid #ececee", padding: "0 12px", height: "40px", width: "36px", textAlign: "left"}}>
                  <input type="checkbox" onChange={V.toggleAll} checked={!!(V.allSelected)} aria-label="Select all" style={{width: "14px", height: "14px", accentColor: "#0A8560", cursor: "pointer"}} />
                </th>
                {(V.peopleColumns || []).map((c) => {
                  const sortable = ['name', 'stage', 'score', 'created', 'lastComm', 'arv', 'offer', 'market', 'subs', 'props', 'stack'].includes(c.key);
                  const active = V.peopleSortColumn?.key === c.key;
                  return (
                  <th key={c.key} aria-sort={active ? (V.peopleSortColumn?.dir === 'asc' ? 'ascending' : 'descending') : undefined} style={{position: "sticky", top: "0", background: "#fff", borderBottom: "1px solid #ececee", padding: "0 12px", height: "40px", textAlign: "left", fontSize: "12px", fontWeight: "500", color: active ? "#0A8560" : "#71717a", whiteSpace: "nowrap"}}>
                    {sortable ? (
                      <button type="button" onClick={() => V.sortPeopleColumn(c.key)} style={{background: "none", border: 0, padding: 0, font: "inherit", letterSpacing: "inherit", textTransform: "inherit", color: "inherit", cursor: "pointer", fontWeight: 500}}>
                        {c.label}{active ? (V.peopleSortColumn?.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                    ) : c.label}
                  </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {allRows.slice(0, revealed).map((p, p__i) => (
                <React.Fragment key={p__i}>
                <tr className="dc2" data-people-focus={p.focused ? 'true' : 'false'} style={{cursor: "pointer", background: p.focused ? '#d1fae5' : p.rowBg, boxShadow: p.focused ? 'inset 4px 0 0 #0A8560' : 'none', transition: "background .1s"}}>
                  <td style={{padding: "0 12px", height: "50px", borderBottom: "1px solid #f0f0f1"}}>
                    <input type="checkbox" checked={!!(p.checked)} onChange={p.toggle} aria-label={`Select ${(p.cells || []).find((c) => c.isName)?.v ?? 'row'}`} style={{width: "14px", height: "14px", accentColor: "#0A8560", cursor: "pointer"}} />
                  </td>
                  {(p.cells || []).map((c, c__i) => (
                    <React.Fragment key={c__i}>
                    <td onClick={p.open} style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                      {(c.isName) ? (
                        <>
                        <div style={{display: "flex", alignItems: "center", gap: "9px"}}>
                          <span style={{width: "28px", height: "28px", borderRadius: "50%", background: "#f4f4f5", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: "700", color: "#52525b"}}>
                            {c.initials}
                          </span>
                          <span style={{fontWeight: "600", color: "#18181b"}}>
                            {c.v}
                          </span>
                        </div>
                        </>
                      ) : null}
                      {(c.isStage) ? (
                        <>
                        <span style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "24px", padding: "0 9px", borderRadius: "6px", fontSize: "12px", fontWeight: "600", color: `color-mix(in srgb, ${c.stageColor} 55%, #18181b)`, background: `color-mix(in srgb, ${c.stageColor} 11%, #fff)`}}>
                          <Mark label={String(c.v)} />
                          {c.v}
                        </span>
                        </>
                      ) : null}
                      {(c.isProperty) ? (
                        <>
                        <span style={{display: "block", color: "#27272a"}}>
                          {c.v}
                        </span>
                        <span style={{display: "block", fontSize: "12px", color: "#71717a"}}>
                          {c.cityLine}
                        </span>
                        </>
                      ) : null}
                      {(c.isAssigned) ? (
                        <>
                        <span style={{color: c.assignedColor}}>
                          {c.v}
                        </span>
                        </>
                      ) : null}
                      {(c.isScore) ? (
                        <>
                        <span style={{display: "inline-flex", alignItems: "center", gap: "8px"}}>
                          <span style={{width: "44px", height: "4px", borderRadius: "2px", background: "#f0f0f1", overflow: "hidden", display: "inline-block"}}>
                            <span style={{display: "block", height: "100%", width: c.scorePct, background: c.scoreColor}}></span>
                          </span>
                          <span style={{fontWeight: "600", color: c.scoreColor}}>
                            {c.v}
                          </span>
                        </span>
                        </>
                      ) : null}
                      {(c.isTemp) ? (
                        <span style={{fontSize: "12px", fontWeight: "600", color: c.tempColor}}>
                          {c.temp}
                        </span>
                      ) : null}
                      {(c.isPlain) ? (
                        <>
                        <span style={{color: c.color, fontWeight: c.weight}}>
                          {c.v}
                        </span>
                        </>
                      ) : null}
                      {(c.isContact) ? (
                        c.v && c.v !== '—' ? (
                          <a className="clozr-contact" href={(c.key === 'email' ? 'mailto:' : 'tel:') + c.v} onClick={(e) => { e.stopPropagation(); e.preventDefault(); if (c.key === 'email') openReach('email', { name: '', email: String(c.v) }); else V.callPhone(String(c.v)); }}>{c.v}</a>
                        ) : <span style={{color: "#a1a1aa"}}>—</span>
                      ) : null}
                    </td>
                    </React.Fragment>
                  ))}
                </tr>
                </React.Fragment>
              ))}
              {more ? (
                <tr ref={sentinel}>
                  <td colSpan={(V.peopleColumns || []).length + 1} style={{padding: "0"}}>
                    <button type="button" onClick={showMore} className="dc2" style={{width: "100%", height: "40px", border: 0, background: "#fafafa", color: "#71717a", fontSize: "12px", cursor: "pointer", fontVariantNumeric: "tabular-nums"}}>
                      {moreNote}
                    </button>
                  </td>
                </tr>
              ) : null}
              {allRows.length === 0 ? (
                V.crmPartial ? (
                  <tr><td colSpan={(V.peopleColumns || []).length || 1} style={{ padding: 0 }}><SkeletonRows count={6} label="Loading leads…" /></td></tr>
                ) : noMatch ? (
                  <EmptyRow colSpan={(V.peopleColumns || []).length || 1} title="No leads match" hint={noMatch.hint} action={noMatch.clear} actionLabel={noMatch.label} />
                ) : (
                  <EmptyRow
                    colSpan={(V.peopleColumns || []).length || 1}
                    title="No leads in this list"
                    hint="Leads land here from Deal Machine and Talkr, or you can add one with Quick Add."
                    failed={!V.crmOk}
                    onRetry={V.reloadCrm}
                  />
                )
              ) : null}
            </tbody>
          </table>
          </div>
        </div>
          </>
        ) : null}
        {V.isVendorList ? null : (
          // The right padding clears the shell's floating buttons (20px inset, 44px
          // wide), which otherwise sit on top of Blacklist at every desk width.
          <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, padding: V.isMobile ? '10px 16px' : '10px 80px 10px 16px', borderTop: '1px solid #e4e4e7', background: '#fff' }}>
            <BlacklistButton count={V.blacklistSelection.count} names={V.blacklistSelection.names} onConfirm={V.blacklistSelection.go} />
          </div>
        )}
      </div>
      {/* Offer gaps: one person's offered deals, closest first. */}
      {V.gapDetail ? (
        <>
        <div onClick={V.gapDetail.close} style={{position: "fixed", inset: "0", background: "rgba(24,24,27,.45)", zIndex: "60"}}></div>
        <div role="dialog" aria-modal="true" aria-label={`Offers for ${V.gapDetail.who}`} style={{position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "min(760px, calc(100vw - 24px))", maxHeight: "min(80vh, 720px)", display: "flex", flexDirection: "column", background: "#fff", border: "1px solid #e4e4e7", borderRadius: "14px", boxShadow: "0 24px 64px rgba(24,24,27,.24)", zIndex: "61", overflow: "hidden"}}>
          <div style={{display: "flex", alignItems: "flex-start", gap: "12px", padding: "14px 16px", borderBottom: "1px solid #f0f0f1"}}>
            <div style={{minWidth: "0", flex: "1"}}>
              <div style={{fontSize: "14px", fontWeight: "600", color: "#18181b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                {V.gapDetail.who}
              </div>
              <div style={{fontSize: "11.5px", color: "#71717a", marginTop: "2px"}}>
                {V.gapDetail.sub} — gap measured against {V.gapDetail.basis}
              </div>
            </div>
            <button className="dc12" onClick={V.gapDetail.close} aria-label="Close" style={{flex: "none", width: "26px", height: "26px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", color: "#52525b", cursor: "pointer", fontSize: "14px", lineHeight: "1"}}>
              ×
            </button>
          </div>
          <div style={{flex: "1", minHeight: "0", overflow: "auto"}}>
            <table style={{width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px"}}>
              <thead>
                <tr>
                  {['Property', 'Stage', 'Ask', 'We offered', 'UW high', 'Gap'].map((h, h__i) => (
                    <th key={h__i} style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", padding: "0 12px", height: "34px", textAlign: h__i >= 2 ? "right" : "left", fontSize: "10.5px", fontWeight: "600", letterSpacing: "0.08em", textTransform: "uppercase", color: "#71717a", whiteSpace: "nowrap"}}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {V.gapDetail.rows.map((r, r__i) => (
                  <tr key={r__i} style={{background: r.close ? "#F3FBF7" : "#fff"}}>
                    <td style={{padding: "0 12px", height: "40px", borderBottom: "1px solid #f0f0f1", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                      {r.open ? (
                        <button className="dc12" onClick={r.open} style={{background: "none", border: "0", padding: "0", fontSize: "12.5px", color: "#0A8560", fontWeight: "500", cursor: "pointer"}}>
                          {r.address}
                        </button>
                      ) : (
                        <span style={{color: "#27272a"}}>{r.address}</span>
                      )}
                    </td>
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#52525b"}}>
                      {r.stage}
                    </td>
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", textAlign: "right", color: "#27272a", fontVariantNumeric: "tabular-nums"}}>
                      {r.ask}
                    </td>
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", textAlign: "right", color: "#27272a", fontVariantNumeric: "tabular-nums"}}>
                      {r.offer}
                    </td>
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", textAlign: "right", color: "#52525b", fontVariantNumeric: "tabular-nums"}}>
                      {r.high}
                    </td>
                    <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", textAlign: "right", fontWeight: r.close ? "600" : "400", color: r.close ? "#0A8560" : "#27272a", fontVariantNumeric: "tabular-nums"}}>
                      {r.gap}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
      ) : null}
      {/* Bulk Text / Email on more than one person: the shared composer. */}
      <PeopleBulkCompose bulk={V.peopleBulk} />
      <SmartListDialog V={V} />
    </section>
  );
}
