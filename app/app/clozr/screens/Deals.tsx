// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React, { useEffect, useState } from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { AiButton } from '@/components/AiButton';
import type { ClozrView } from '@/app/clozr/view';
import { ColumnPicker, SortMenu, ViewMenu, sameList, type ColumnDef } from '@/components/ViewControls';
import { cmpSort, sortToken, toggleSort, type SortDir } from '@/lib/list-sort';
import { Chevron, CZ, seg, segWrap, trayBtn } from '@/components/ds/chrome';
import { cleanColumns, useSavedViews } from '@/lib/saved-views';
import { useRemembered } from '@/lib/screen-memory';
import { DEAL_TYPES } from '@/lib/deal-types';
import { Mark } from '@/components/ds/mark';
import { OptionTimers } from '@/components/OptionTimers';
import { PropertyPhoto } from '@/components/PropertyPhoto';
import { openReach } from '@/app/components/record/reach';
import { Button, buttonClass } from '@/components/ds/Button';
import { Badge, SectionLabel } from '@/components/ds/Text';
import { textTone } from '@/lib/text-tone';
import { ArrowDown, ArrowUp, FileText } from 'lucide-react';
import { DEAL_COL_LABELS, DEAL_TABLE_DEFAULT } from '@/lib/deal-tracker-sheet';
import { FilterPanel } from '@/app/components/filters/FilterPanel';
import { AttackGapFields, DateRangeFields } from '@/app/components/filters/RangeFilters';
import { DealsRvm, dealSellers } from '@/app/components/bulk/DealsRvm';
import { CloseBar } from '@/app/components/deals/CloseBar';
import { ScreenHeader } from '@/components/ds/Screen';

function DealTypeBadge({ label }: { label?: string }) {
  const tone = DEAL_TYPES.find((t) => t.label === label);
  // No type yet: nothing to badge. A dash in a pill read as a value.
  if (!label) return null;
  const text = label;
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: '18px', padding: '0 7px', borderRadius: '999px', background: tone?.bg ?? 'var(--surface, rgba(255,255,255,.92))', color: tone?.fg ?? 'var(--meta, #71717a)', fontSize: '11px', fontWeight: 750, letterSpacing: '.02em', border: tone ? '0' : '1px solid #e4e4e7' }}>{text}</span>;
}

/**
 * A deal's stage as a picker: the same move as dragging its card on the board,
 * which the table and a phone cannot do. Clicks stay off the row underneath.
 */
function StageSelect({ stage, color, choices, onPick, height }: { stage: string; color: string; choices: string[]; onPick: (stage: string) => void; height: string }) {
  const opts = choices.includes(stage) ? choices : [stage, ...choices];
  return (
    <select aria-label="Deal stage" title="Move this deal to another stage" value={stage} data-testid="deal-stage"
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => onPick(e.target.value)}
      style={{ height, maxWidth: '100%', borderRadius: '7px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', color, fontSize: '11.5px', fontWeight: 650, padding: '0 6px', cursor: 'pointer' }}>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

/** Table cells by name, not by position (lib/deal-tracker-sheet DEAL_COL_LABELS). */
const col = (label: (typeof DEAL_COL_LABELS)[number]) => DEAL_COL_LABELS.indexOf(label);
const C = {
  daysToClose: col('Days to Close'), address: col('Address'), sellerPrice: col('Seller Price'), dispoFee: col('Dispo Fee'),
  status: col('Contract Status'), phone: col('Seller Phone'), email: col('Seller Email'), arv: col('ARV'),
};
/** Money columns, right-aligned: Seller Price through Dispo Fee, and ARV. */
const isMoneyCol = (i: number) => (i >= C.sellerPrice && i <= C.dispoFee) || i === C.arv;
/** Rows (and Prospect cards) shown per page; "Show more" adds this many. */
const PAGE = 50;

/** What a saved Deals view keeps (lib/saved-views.ts). */
type DealsConfig = {
  layout: 'pipeline' | 'table';
  /** Table fields, in order. */
  cols: string[];
  /** Board stages that are hidden. */
  hiddenStages: string[];
  /** Columns added beyond the pipeline: Terminated, or a seller stage ('Seller · Memo Filed / Legal'). */
  extraStages?: string[];
  /** Board card fields, in order. */
  card: string[];
  filters: { dealOwner: string; dealMarket: string; dealStatus: string };
};

/** The row's actions, a column of its own pinned to the right edge. */
const ACTIONS = 'actions';

const CARD_FIELDS: ColumnDef[] = [
  { key: 'seller', label: 'City · seller' },
  { key: 'contract', label: 'Contract price' },
  { key: 'fee', label: 'Fee' },
  { key: 'amended', label: 'Amended price' },
  { key: 'phone', label: 'Seller phone' },
  { key: 'email', label: 'Seller email' },
  { key: 'rep', label: 'Rep' },
  { key: 'next', label: 'Next task' },
  { key: 'days', label: 'Days in stage' },
  { key: 'health', label: 'Health' },
];
const CARD_DEFAULT = ['seller', 'contract', 'fee', 'amended', 'rep', 'next', 'days', 'health'];
const DEAL_SORT_OPTIONS = [
  { id: 'tracker:desc', label: 'Tracker order' },
  { id: 'close:asc', label: 'Close date, soonest' },
  { id: 'added:desc', label: 'Date added, newest' },
  { id: 'added:asc', label: 'Date added, oldest' },
  { id: 'address:asc', label: 'Address' },
  { id: 'seller:asc', label: 'Seller' },
  { id: 'price:desc', label: 'Seller price' },
  { id: 'offerRoom:desc', label: 'Offer vs ask, we can pay more' },
  { id: 'uwRoom:desc', label: 'UW high vs ask, we can pay more' },
  { id: 'stage:asc', label: 'Status' },
];
const DEAL_DEFAULT_SORT = { key: 'tracker', dir: 'desc' as SortDir };
const PIPELINE_SORTS = new Set(['added', 'address', 'seller', 'price', 'close', 'offerRoom', 'uwRoom']);

type DealSortable = {
  addedAt?: string;
  contractAt?: string;
  addr: string;
  seller: string;
  contractRaw: number;
  /** Scheduled close as a sortable number; undated deals last (lib/close-date.ts). */
  closeSort?: number;
  /** Our offer minus their ask, and the underwriter high minus their ask. Null sorts last. */
  offerRoom?: number | null;
  uwRoom?: number | null;
  stage?: string;
  cells?: string[];
};

function dealSortValue(d: DealSortable, key: string): string | number {
  if (key === 'added') return d.addedAt || '';
  if (key === 'address') return d.addr;
  if (key === 'seller') return d.seller;
  if (key === 'price') return d.contractRaw;
  // Undated deals read as blank, so they sort last either way.
  if (key === 'close') return d.closeSort == null || d.closeSort === Number.MAX_SAFE_INTEGER ? '' : d.closeSort;
  if (key === 'offerRoom') return d.offerRoom ?? '';
  if (key === 'uwRoom') return d.uwRoom ?? '';
  if (key === 'stage') return d.stage || '';
  if (key === 'c1') return d.contractAt || '';
  if (key.startsWith('c') && d.cells) return sortToken(d.cells[Number(key.slice(1))]);
  return '';
}

function colSortKey(f: ColumnDef): string | null {
  if (f.key === ACTIONS) return null;
  if (f.label === 'Date added') return 'added';
  if (f.label === 'Address') return 'address';
  if (f.label === 'Seller') return 'seller';
  if (f.label === 'Seller Price') return 'price';
  if (f.label === 'Contract Status') return 'stage';
  if (f.label === 'Contract Date') return 'c1';
  return f.key;
}

function firstDealDir(key: string): SortDir {
  if (key === 'added' || key === 'price' || key === 'c1' || /^c(3|5|6|7|8|9|10|11|24|25|31)$/.test(key)) return 'desc';
  return 'asc';
}
const NO_FILTERS = { dealOwner: 'Any', dealMarket: 'Any', dealStatus: 'Any', dealAdded: 'Any', dealAddedFrom: 'Any', dealAddedTo: 'Any', dealGap: 'Any', dealGapBasis: 'Our offer' };

/** A stage colour mixed into white (or another base) — the board's drop-zone washes. */
const tint = (color: string, pct: number, base = 'var(--surface, #fff)') => `color-mix(in srgb, ${color} ${pct}%, ${base})`;

/** Cards a column shows before "Show more": as many as fit above the fold. */
function useColumnCap() {
  const fit = () => (typeof window === 'undefined' ? 4 : Math.max(2, Math.floor((window.innerHeight - 230) / 250)));
  const [cap, setCap] = useState(fit);
  useEffect(() => {
    const on = () => setCap(fit());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return cap;
}

/** A checkbox in the deals table and on a phone card: 18px, the accent when ticked, the row click kept off it. */
const pickBox: React.CSSProperties = { width: '18px', height: '18px', margin: 0, accentColor: 'var(--c-accent, #0a8560)', cursor: 'pointer', display: 'block' };

/**
 * The bulk bar for the ticked deals (V.dealsBulk): Change stage and Assign are
 * pickers, Archive asks in the archive prompt. On a desk it sits under the
 * toolbar; on a phone it docks above the bottom tabs, like People's.
 */
function DealsBulkBar({ V, ids, onClear, phone }: { V: ClozrView; ids: string[]; onClear: () => void; phone: boolean }) {
  useEffect(() => {
    if (!phone) return;
    document.documentElement.style.setProperty('--clozr-dock', '96px');
    return () => { document.documentElement.style.removeProperty('--clozr-dock'); };
  }, [phone]);
  const [busy, setBusy] = useState(false);
  // A write that throws (offline, a rejected confirm) frees the bar and says so.
  const run = (p: Promise<boolean>) => { setBusy(true); void p.then((ok) => { setBusy(false); if (ok) onClear(); }, () => { setBusy(false); V.showToast('That did not save.', 'error'); }); };
  const n = ids.length;
  const field: React.CSSProperties = { height: phone ? '36px' : '30px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', color: 'var(--ink, #18181b)', fontSize: phone ? '16px' : '12.5px', fontWeight: 600, padding: '0 8px', cursor: 'pointer', minWidth: 0, flex: phone ? 1 : 'none' };
  const stage = (
    <select aria-label="Change stage" data-testid="deals-bulk-stage" value="" disabled={busy} style={field}
      onChange={(e) => { const st = e.target.value; e.target.value = ''; if (st) run(V.dealsBulk.setStage(ids, st)); }}>
      <option value="">Change stage…</option>
      {V.dealStageChoices.map((st) => <option key={st} value={st}>{st}</option>)}
    </select>
  );
  const assign = (
    <select aria-label="Assign" data-testid="deals-bulk-assign" value="" disabled={busy} style={field}
      onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) run(V.dealsBulk.assign(ids, v === 'nobody' ? null : v)); }}>
      <option value="">Assign to…</option>
      {V.dealsBulk.team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      <option value="nobody">Nobody</option>
    </select>
  );
  const archive = (
    <button type="button" data-testid="deals-bulk-archive" disabled={busy} onClick={() => { V.dealsBulk.archive(ids); onClear(); }}
      title="Archive: off the board, the list and Dispo. Asks first."
      style={{ ...field, flex: 'none', color: 'var(--tx-red, #b91c1c)', padding: '0 10px', fontSize: phone ? '13px' : '12.5px' }}>
      Archive
    </button>
  );
  const count = <span role="status" data-testid="deals-bulk-count" style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--c-accent-2, #08694c)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{n} selected</span>;
  const clear = <button type="button" className="pp-link" onClick={onClear} style={{ height: '28px', background: 'none', border: 0, cursor: 'pointer', fontSize: '12.5px', fontWeight: 600, color: 'var(--muted, #52525b)' }}>Clear</button>;
  if (phone) {
    return (
      <div data-screen-label="Selected" style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(58px + env(safe-area-inset-bottom, 0px) + var(--clozr-callbar, 0px))', zIndex: 47, background: 'var(--surface, #fff)', borderTop: '1px solid var(--divider, #e4e4e7)', boxShadow: '0 -8px 24px -12px rgba(18,22,45,.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px 0' }}>
          {count}
          <span style={{ flex: 1 }} />
          {clear}
        </div>
        <div style={{ display: 'flex', gap: '6px', padding: '8px 12px 10px' }}>
          {stage}
          {assign}
          {archive}
        </div>
      </div>
    );
  }
  return (
    <div data-screen-label="Selected" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 20px', background: 'var(--mint-dim, #e7f8f1)', borderBottom: '1px solid var(--divider, #e4e4e7)' }}>
      {count}
      {stage}
      {assign}
      {archive}
      <span style={{ flex: 1 }} />
      {clear}
    </div>
  );
}

export function Deals({ V }: { V: ClozrView }) {
  // The search, the opened columns, the sort and the look below are kept for
  // the session (lib/screen-memory): the board unmounts while a deal is open,
  // and the rep comes back to the board they left, not a fresh one.
  const [q, setQ] = useRemembered('deals.q', '');
  const [open, setOpen] = useRemembered<Record<string, boolean>>('deals.open', {});
  const [over, setOver] = useState<string | null>(null);
  // The Prospect column and the table page through what they hold (thousands of lead sheets).
  const [prospectLimit, setProspectLimit] = useState(PAGE);
  const [tableLimit, setTableLimit] = useState(PAGE);
  // The ticked deals (the table's checkboxes, a phone's Select mode), by deal id.
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [selectMode, setSelectMode] = useState(false);
  const [sort, setSort] = useRemembered('deals.sort', DEAL_DEFAULT_SORT);
  const cap = useColumnCap();

  // ---- Fields, stages and saved views ---------------------------------------
  const fieldDefs: ColumnDef[] = [
    ...(V.dealCols || []).map((label, i) => ({ key: 'c' + i, label, locked: i === 4 })),
    { key: ACTIONS, label: 'Deal sheet · TC' },
  ];
  const fieldKeys = fieldDefs.map((f) => f.key);
  const labels = V.dealCols || [];
  const defaultCols = [
    ...DEAL_TABLE_DEFAULT.map((label) => {
      const i = labels.indexOf(label);
      return i >= 0 ? 'c' + i : '';
    }).filter((k) => k && fieldKeys.includes(k)),
    ACTIONS,
  ];
  const extraOpts: string[] = V.dealExtraOptions || [];
  const stageNames = (V.dealsCols || []).map((c) => c.stage).filter((st) => !extraOpts.includes(st));
  const [tableCols, setTableCols] = useRemembered<string[]>('deals.cols', defaultCols);
  const [hiddenStages, setHiddenStages] = useRemembered<string[]>('deals.hiddenStages', []);
  const [cardFields, setCardFields] = useRemembered<string[]>('deals.card', CARD_DEFAULT);
  const apply = (c: DealsConfig | null) => {
    setTableCols(c ? cleanColumns(c.cols, fieldKeys, defaultCols) : defaultCols);
    setHiddenStages(c && Array.isArray(c.hiddenStages) ? c.hiddenStages.filter((x) => typeof x === 'string') : []);
    V.setDealExtraStages(c && Array.isArray(c.extraStages) ? c.extraStages.filter((x) => typeof x === 'string' && extraOpts.includes(x)) : []);
    setCardFields(c ? cleanColumns(c.card, CARD_FIELDS.map((f) => f.key), CARD_DEFAULT) : CARD_DEFAULT);
    V.setGf({ ...NO_FILTERS, ...(c?.filters ?? {}) });
    V.setDealsView(c?.layout === 'table' ? 'table' : 'pipeline');
  };
  // The open view goes on once a session; after that the board is as the rep left it.
  const sv = useSavedViews<DealsConfig>('deals', V.liveIds?.workspaceId ?? null, V.liveIds?.userId ?? null, apply, { oncePerSession: true });
  const current: DealsConfig = {
    layout: V.isTable ? 'table' : 'pipeline', cols: tableCols, hiddenStages, extraStages: V.dealExtraStages, card: cardFields,
    filters: { dealOwner: V.gf.dealOwner, dealMarket: V.gf.dealMarket, dealStatus: V.gf.dealStatus },
  };
  const base: DealsConfig = sv.active?.config ?? { layout: 'pipeline', cols: defaultCols, hiddenStages: [], card: CARD_DEFAULT, filters: NO_FILTERS };
  const dirty = current.layout !== base.layout || !sameList(current.cols, cleanColumns(base.cols, fieldKeys, defaultCols))
    || !sameList([...current.hiddenStages].sort(), [...(base.hiddenStages ?? [])].sort())
    || !sameList(current.extraStages ?? [], base.extraStages ?? [])
    || !sameList(current.card, cleanColumns(base.card, CARD_FIELDS.map((f) => f.key), CARD_DEFAULT))
    || (['dealOwner', 'dealMarket', 'dealStatus'] as const).some((k) => current.filters[k] !== (base.filters?.[k] ?? 'Any'));
  const shownStages = stageNames.filter((st) => !hiddenStages.includes(st));
  const show = (k: string) => cardFields.includes(k);
  const visibleFields = tableCols.map((k) => fieldDefs.find((f) => f.key === k)).filter((f): f is ColumnDef => !!f);
  const viewMenu = <ViewMenu sv={sv} current={current} dirty={dirty} onApply={apply} onToast={V.showToast} pill={V.isMobile} align={V.isMobile ? 'left' : 'right'} />;
  const needle = q.trim().toLowerCase();
  const hit = (...parts: (string | undefined)[]) => !needle || parts.join(' ').toLowerCase().includes(needle);
  const order = <T extends DealSortable>(list: T[], pipeline = false): T[] => {
    if (sort.key === 'tracker') return list;
    if (pipeline && !PIPELINE_SORTS.has(sort.key)) return list;
    return [...list].sort((a, b) => cmpSort(dealSortValue(a, sort.key), dealSortValue(b, sort.key), sort.dir));
  };
  const rows = order((V.dealRows || []).filter((d) => !needle || d.search.includes(needle)));
  // Only deals still on this list count as selected: a filter change or an archive drops the rest.
  const selectedIds = Object.keys(picked).filter((id) => picked[id] && rows.some((d) => d.dealId === id));
  const togglePick = (id: string) => setPicked((cur) => ({ ...cur, [id]: !cur[id] }));
  const clearPicks = () => { setPicked({}); setSelectMode(false); };
  const tableShown = rows.slice(0, tableLimit);
  const allShownPicked = tableShown.length > 0 && tableShown.every((d) => picked[d.dealId]);
  const toggleAllShown = () => setPicked(allShownPicked ? {} : Object.fromEntries(tableShown.map((d) => [d.dealId, true])));
  // Deals → RVM sellers: the sellers of the deals this list shows (its filters and search).
  const [rvmOpen, setRvmOpen] = useState(false);
  // On the board, a hidden stage's deals are not on screen, so they are not sent to either.
  const rvmPeople = rvmOpen ? dealSellers(V.isPipeline ? rows.filter((d) => !hiddenStages.includes(d.stage)) : rows) : [];
  const cols = (V.dealsCols || []).filter((c) => !hiddenStages.includes(c.stage)).map((c) => {
    if (c.page) {
      const pg = c.page(needle, prospectLimit, sort);
      return { ...c, cards: pg.cards, pagedTotal: pg.total as number | null };
    }
    return { ...c, cards: order((c.cards || []).filter((x) => hit(x.addr, x.city, x.seller, x.search)), true), pagedTotal: null as number | null };
  });
  const mobileCards = order((V.mobileDealCards || []).filter((d) => hit(d.addr, d.seller, d.search)));
  const sortMenu = (
    <SortMenu
      options={DEAL_SORT_OPTIONS}
      value={`${sort.key}:${sort.dir}`}
      resetId="tracker:desc"
      pill={V.isMobile}
      onChange={(id) => {
        const [key, dir] = id.split(':');
        setSort({ key, dir: dir === 'asc' ? 'asc' : 'desc' });
      }}
    />
  );
  // The running total is exactly what is on screen: the stage columns, table
  // rows or phone cards left after the owner / market / status menus and the
  // search box. Closed and terminated deals are excluded even when their
  // column shows, since their fees are booked or gone, not pipeline.
  const onScreen: { feeRaw: number; contractRaw: number; inPipeline: boolean }[] = V.isMobile ? mobileCards : V.isTable ? rows : cols.flatMap((c) => c.cards);
  const inPipeline = onScreen.filter((d) => d.inPipeline);
  const feeTotal = inPipeline.reduce((a, d) => a + d.feeRaw, 0);
  const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
  const totals = (
    <span style={{fontSize: "12.5px", color: "var(--meta, #71717a)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontVariantNumeric: "tabular-nums"}}>
      <strong style={{fontSize: "14px", fontWeight: "800", color: "var(--tx-green, #15803d)", letterSpacing: "-0.01em"}}>{money(feeTotal)}</strong>
      {` pipeline fees · ${inPipeline.length} deal${inPipeline.length === 1 ? '' : 's'}`}
    </span>
  );
  const dealFiltersPanel = (
    <FilterPanel
      menus={V.dealMenus || []}
      active={(V.dealMenus || []).filter((f) => f.on).length + ((V.gf.dealAdded ?? 'Any') !== 'Any' ? 1 : 0) + ((V.gf.dealGap ?? 'Any') !== 'Any' ? 1 : 0)}
      onReset={() => V.setGf(NO_FILTERS)}
      onClose={V.closeFilterMenus}
      showLabel={`Show ${onScreen.length} deal${onScreen.length === 1 ? '' : 's'}`}>
      <div className="cz-fp-more">
        <DateRangeFields when={V.gf.dealAdded} from={V.gf.dealAddedFrom} to={V.gf.dealAddedTo}
          onChange={(patch) => V.setGf({ dealAdded: patch.when, ...(patch.from != null ? { dealAddedFrom: patch.from } : {}), ...(patch.to != null ? { dealAddedTo: patch.to } : {}) })} />
        <AttackGapFields basis={V.gf.dealGapBasis} gap={V.gf.dealGap} onBasis={(v) => V.setGf({ dealGapBasis: v })} onGap={(v) => V.setGf({ dealGap: v })} />
      </div>
    </FilterPanel>
  );
  const search = (
    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search deals — address, seller, agent" aria-label="Search deals"
      style={{height: "32px", width: V.isMobile ? "100%" : "260px", padding: "0 10px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "8px", fontSize: "12.5px", outline: "0", background: "var(--canvas, #fafafa)", color: "var(--ink, #18181b)"}} />
  );
  return (
    <section data-screen-label="Deals" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
      {(V.isMobile) ? (
        <>
        <div style={{flex: "none", background: "var(--surface, #fff)", borderBottom: "1px solid var(--divider, #e4e4e7)", padding: "10px 0 10px 16px"}}>
          <div style={{display: "flex", alignItems: "baseline", gap: "8px", paddingRight: "16px"}}>
            <h1 className="ds-title">
              Deals
            </h1>
            {totals}
          </div>
          <div style={{marginTop: "9px", paddingRight: "16px"}}>{search}</div>
          <div data-tray style={{display: "flex", gap: "6px", overflowX: "auto", marginTop: "9px", paddingRight: "16px", paddingBottom: "2px"}}>
            {V.can.tc ? (
            <button className="dc2" onClick={V.openTcFiles} style={{...trayBtn(), border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)"}}>
              <span style={{ color: "var(--tx-green-deep, #1f7a4d)", display: 'inline-flex' }}><Mark label={'TC files'} /></span>
              TC files
              <span style={{fontSize: "11px", color: "var(--meta, #71717a)"}}>
                {V.tcOpenCount}
              </span>
            </button>
            ) : null}
            <AiButton kind="lane" onClick={() => V.openLane()} />
            <button type="button" data-testid="deals-archived-m" onClick={() => V.setDealsArchived(!V.dealsArchived)} aria-pressed={V.dealsArchived}
              style={{...trayBtn(V.dealsArchived), flex: "none"}}>
              {V.dealsArchived ? 'Back to live deals' : `Archived · ${V.archivedDealCount}`}
            </button>
            <button type="button" data-testid="deals-select-m" onClick={() => (selectMode ? clearPicks() : setSelectMode(true))} aria-pressed={selectMode}
              title={selectMode ? 'Leave select mode' : 'Tick deals to move, assign or archive them together'}
              style={{...trayBtn(selectMode), flex: "none"}}>
              {selectMode ? 'Done' : 'Select'}
            </button>
            {viewMenu}
            {sortMenu}
            {dealFiltersPanel}
            {(V.dealMenus || []).map((f, f__i) => (
              <React.Fragment key={f__i}>
              <div style={{position: "relative", flex: "none"}}>
                <button type="button" onClick={f.toggle} style={{...trayBtn(f.on), border: `1px solid ${f.border}`, background: f.bg, color: f.color}}>
                  {f.on ? f.value : f.label}
                  <Chevron size={11} color={f.on ? CZ.mint : CZ.faint} />
                </button>
                {(f.open) ? (
                  <>
                  <div onClick={V.closeFilterMenus} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
                  <div ref={keepInView} className="cz-menu" style={{position: "absolute", top: "36px", left: "0", minWidth: "190px", maxHeight: "44vh", overflow: "auto", background: "var(--c-menu-bg)", border: "1px solid var(--c-menu-line)", borderRadius: "12px", boxShadow: "0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)", zIndex: "45", padding: "4px"}}>
                    {(f.options || []).map((o, o__i) => (
                      <React.Fragment key={o__i}>
                      <button className="dc2" onClick={o.go} style={{display: "block", width: "100%", textAlign: "left", padding: "9px 10px", border: "0", borderRadius: "7px", background: o.on ? "var(--mint-dim, #e7f8f1)" : "none", cursor: "pointer", fontSize: "13px", color: o.on ? "var(--tx-mint, #0a8560)" : "var(--ink-2, #27272a)", whiteSpace: "nowrap"}}>
                        {o.label}
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
        </div>
        </>
      ) : null}
      {V.isMobile ? null : <ScreenHeader title="Deals" meta={totals} actions={<>
        {search}
        <AiButton kind="lane" onClick={() => V.openLane()} />
        <div role="tablist" aria-label="Deals layout" style={segWrap}>
          {(V.dealsViews || []).map((v, v__i) => (
            <React.Fragment key={v__i}>
            <button type="button" role="tab" aria-selected={v.bg === 'var(--surface, #fff)'} onClick={v.go} style={seg(v.bg === 'var(--surface, #fff)')}>{v.label}</button>
            </React.Fragment>
          ))}
        </div>
        {V.dealsRvm.canWrite && !V.dealsArchived && rows.length > 0 && (
          <button type="button" data-testid="deals-rvm" onClick={() => setRvmOpen(true)}
            title="A ringless voicemail to the seller on every deal this list shows. Each drop is filed on its deal, and a callback comes back to you."
            style={{height: "32px", padding: "0 11px", borderRadius: "10px", border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', color: 'var(--ink-3, #3f3f46)', fontSize: "12.5px", fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap"}}>
            RVM sellers
          </button>
        )}
        {rvmOpen && <DealsRvm bulk={V.dealsRvm} people={rvmPeople} onClose={() => setRvmOpen(false)} />}
        <button type="button" data-testid="deals-archived" onClick={() => V.setDealsArchived(!V.dealsArchived)} aria-pressed={V.dealsArchived}
          title={V.dealsArchived ? 'Back to live deals' : 'Archived deals: archived by hand, terminated, or a seller gone to legal'}
          style={{height: "32px", padding: "0 11px", borderRadius: "10px", border: `1px solid ${V.dealsArchived ? '#0A8560' : 'var(--divider, #e4e4e7)'}`, background: V.dealsArchived ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', color: V.dealsArchived ? 'var(--tx-mint, #0a8560)' : 'var(--ink-3, #3f3f46)', fontSize: "12.5px", fontWeight: V.dealsArchived ? 650 : 500, cursor: "pointer", whiteSpace: "nowrap"}}>
          {V.dealsArchived ? 'Back to live deals' : `Archived · ${V.archivedDealCount}`}
        </button>
        {viewMenu}
        {sortMenu}
        {V.isTable ? (
          <ColumnPicker all={fieldDefs} value={tableCols} onChange={setTableCols} defaults={defaultCols} title="Fields in the deals table"
            note="Pick the fields, move them left or right, then save it as a view from the view menu." />
        ) : (
          <>
            <ColumnPicker all={[...stageNames, ...extraOpts].map((st) => ({ key: st, label: st }))} value={[...shownStages, ...V.dealExtraStages]} label="Stages"
              onChange={(keys) => { setHiddenStages(stageNames.filter((st) => !keys.includes(st))); V.setDealExtraStages(keys.filter((k) => extraOpts.includes(k))); }}
              defaults={stageNames} title="Stages on the board"
              note="Add any seller stage (Memo Filed / Legal, Appointment Set…) or Terminated as a column. Those columns show archived deals too, marked as such." />
            <ColumnPicker all={CARD_FIELDS} value={cardFields} onChange={setCardFields} defaults={CARD_DEFAULT} label="Card fields" title="Fields on each card" />
          </>
        )}
        {dealFiltersPanel}
        {V.can.tc ? (
        <button className="dc2" onClick={V.openTcFiles} title="Open transaction coordination" style={{height: "32px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "7px", whiteSpace: "nowrap", color: "var(--ink, #18181b)"}}>
          <span style={{ color: "var(--tx-green-deep, #1f7a4d)", display: 'inline-flex' }}><Mark label={'Transaction coordination'} /></span>
          Transaction coordination
          <span style={{fontSize: "11px", color: "var(--meta, #71717a)", fontVariantNumeric: "tabular-nums"}}>
            {V.tcOpenCount}
          </span>
        </button>
        ) : null}
        {V.can.automations ? (
        <button className="dc2" onClick={V.goAutomations} style={{height: "32px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px"}}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
          </svg>
          Automations
        </button>
        ) : null}
      </>} />}
      {/* The board is built from the full workspace read. Until it lands, or
          when it fails, the columns read "Nothing here yet", which is the same
          as a workspace with no deals: say which one it is. */}
      {V.crmPartial || !V.crmOk ? (
        <div role="status" aria-live="polite" data-testid="deals-load-state"
          style={{display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "8px 20px", borderBottom: "1px solid var(--divider, #e4e4e7)", background: !V.crmOk ? "var(--tint-red, #fef2f2)" : "var(--surface, #fff)", fontSize: "13px", color: !V.crmOk ? "var(--tx-red, #b91c1c)" : "var(--muted, #52525b)"}}>
          {!V.crmOk ? 'Deals didn’t load, so the board is empty. Your deals are still there.' : 'Loading every deal…'}
          {!V.crmOk && V.reload ? (
            <button type="button" data-testid="deals-load-retry" onClick={() => V.reload?.()}
              style={{height: "28px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-btn-line, #d4d4d8)", background: "var(--surface, #fff)", fontSize: "12.5px", fontWeight: 600, color: "var(--ink, #18181b)", cursor: "pointer"}}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {(V.isPipeline && !V.isMobile) ? (
        <div style={{flex: "1", minHeight: "0", overflow: "auto", padding: "18px 20px 24px", background: "var(--page)"}}>
        <div style={{display: "flex", gap: "14px", alignItems: V.dealDragging ? "stretch" : "flex-start", minHeight: "100%", width: "max-content", margin: "0 auto"}}>
          {cols.map((col) => {
            const paged = col.pagedTotal != null;
            const shown = paged || open[col.stage] ? col.cards : col.cards.slice(0, cap);
            const dragging = V.dealDragging;
            const isOver = dragging && over === col.stage;
            const isFrom = dragging && V.dealDragFrom === col.stage;
            const target = isOver && !isFrom;
            return (
            <div key={col.stage} data-testid="deal-column" data-stage={col.stage} data-drop={target ? 'over' : dragging ? 'wash' : undefined}
              onDragOver={(e) => { col.over(e); if (e.dataTransfer) e.dataTransfer.dropEffect = isFrom ? 'none' : 'move'; if (over !== col.stage) setOver(col.stage); }}
              onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; setOver((o) => (o === col.stage ? null : o)); }}
              onDrop={(e) => { setOver(null); col.drop(e); }}
              style={{width: "264px", flex: "none", background: target ? tint(col.color, 20) : dragging ? tint(col.color, 8) : "var(--trough)", border: `1px solid ${target ? col.color : dragging ? tint(col.color, 40) : "var(--trough-line)"}`, borderRadius: "var(--r-card)", padding: "0 8px 8px", minHeight: "220px", boxShadow: target ? `inset 0 0 0 2px ${col.color}` : "var(--elev-inset)", transition: "background .12s,border-color .12s,box-shadow .12s"}}>
              <div style={{position: "sticky", top: "-18px", zIndex: 1, margin: "0 -8px 8px", padding: "12px 14px 10px", borderRadius: "var(--r-card) var(--r-card) 0 0", background: target ? tint(col.color, 32) : dragging ? tint(col.color, 14) : "var(--band)", boxShadow: target || dragging ? "none" : "0 1px 0 var(--band-line)", transition: "background .12s"}}>
                <div style={{display: "flex", alignItems: "center", gap: "8px"}}>
                  <span style={{ color: col.color, display: 'inline-flex', flex: 'none' }}><Mark label={col.stage} /></span>
                  <span className="t-title" style={{whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{col.stage}</span>
                  <span style={{minWidth: "20px", height: "20px", padding: "0 6px", borderRadius: "999px", background: tint(col.color, 16), color: "var(--ink, #18181b)", boxShadow: `inset 0 0 0 1px ${tint(col.color, 55)}`, fontSize: "11px", fontWeight: "700", display: "inline-grid", placeItems: "center", fontVariantNumeric: "tabular-nums"}}>{col.count}</span>
                </div>
                {dragging && (target || isFrom) ? (
                  <div style={{fontSize: "12px", fontWeight: 700, marginTop: "3px", color: target ? textTone(col.color) : "var(--meta, #71717a)"}}>{target ? 'Drop to move here' : 'Current stage'}</div>
                ) : (
                  <div style={{fontSize: "12px", color: "var(--meta, #71717a)", marginTop: "3px", fontVariantNumeric: "tabular-nums"}}>{col.count ? `${col.count} deal${col.count === 1 ? '' : 's'} · ${money(col.cards.reduce((a, c) => a + (c.feeRaw || 0), 0))} fees` : 'Nothing here yet'}</div>
                )}
              </div>
              {shown.map((c) => (
                <div key={c.dealId || c.id} className="dc22" draggable="true" onDragStart={c.dragStart} onDragEnd={c.dragEnd} onClick={c.open}
                  style={{position: "relative", background: "var(--surface, #fff)", border: "1px solid var(--edge)", borderRadius: "12px", padding: "0 0 10px", marginBottom: "8px", cursor: "grab", transition: "transform .15s,box-shadow .15s,opacity .12s", boxShadow: "var(--elev-1)", overflow: "hidden", opacity: V.dealDragId === c.dragId ? 0.45 : 1, contentVisibility: "auto", containIntrinsicHeight: "auto 382px"}}>
                  {c.dealId ? (
                    <button type="button" className="deal-card-archive" draggable={false} onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); if (c.archived) V.unarchiveDeal(c.dealId); else V.archiveDeal(c.dealId); }}
                      title={c.archived ? 'Restore to the board' : 'Archive: off the board, the list and Dispo'} aria-label={c.archived ? 'Restore deal' : 'Archive deal'}
                      style={{position: "absolute", right: "8px", top: "8px", zIndex: 2, height: "24px", padding: "0 8px", borderRadius: "7px", border: 0, background: "rgba(12,14,18,.72)", color: "#fff", fontSize: "11px", fontWeight: 700, cursor: "pointer"}}>
                      {c.archived ? 'Restore' : 'Archive'}
                    </button>
                  ) : null}
                  <button type="button" data-testid="deal-photo" draggable={false} onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); if (c.photos.length) V.openPhotoShow(c.addr, c.photos, c.dealDbId); else if (c.streetOnly) window.open('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.addr + ' ' + c.city), 'clozr-Street View', 'popup=yes,width=1200,height=850'); }}
                    title={c.photos.length ? 'View photos' : 'Street view'}
                    style={{display: "block", width: "100%", height: "118px", padding: 0, border: 0, borderBottom: "1px solid #eee", background: "var(--photo-bg, #e9ebf0)", cursor: "pointer", position: "relative"}}>
                    <PropertyPhoto photo={c.photos?.[0] || (c.streetOnly ? '' : c.img)} street={c.street || (c.streetOnly ? c.img : '')} alt={'Photo of ' + c.addr} />
                    {c.photos.length > 1 ? <span style={{position: "absolute", right: "8px", bottom: "8px", background: "rgba(12,14,18,.72)", color: "#fff", fontSize: "11px", fontWeight: 700, borderRadius: "999px", padding: "2px 7px"}}>{c.photos.length} photos</span> : null}
                    <span style={{position: "absolute", left: "8px", top: "8px"}}><DealTypeBadge label={c.dealType} /></span>
                  </button>
                  <CloseBar badge={c.closeBadge} edge />
                  <div style={{display: "flex", alignItems: "flex-start", gap: "8px", padding: "10px 12px 0 14px"}}>
                    <div style={{minWidth: 0, flex: 1}}>
                      <div className="t-name" style={{whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{c.addr}</div>
                      {show('seller') ? <div style={{fontSize: "11.5px", color: "var(--meta, #71717a)", marginTop: "1px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{[c.city, c.seller].filter((x) => x && x !== '—').join(' · ')}</div> : null}
                      {c.added && c.added !== '—' ? <div style={{fontSize: "11px", color: "var(--meta, #71717a)", marginTop: "2px"}}>Added {c.added}</div> : null}
                      {c.archived ? <Badge tone="warn" style={{marginTop: "4px"}}>Archived</Badge> : null}
                    </div>
                    {show('health') ? <span title="Health" style={{width: "8px", height: "8px", borderRadius: "50%", background: c.health, flex: "none", marginTop: "5px", boxShadow: `0 0 0 3px ${c.health}22`}} /> : null}
                  </div>
                  {show('contract') || show('fee') ? (
                  <div style={{display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", marginTop: "10px", padding: "0 12px 0 14px"}}>
                    {show('contract') ? (
                    <div>
                      <SectionLabel>Contract</SectionLabel>
                      <div style={{fontSize: "13px", fontWeight: "650", fontVariantNumeric: "tabular-nums"}}>{c.price}</div>
                    </div>
                    ) : <span />}
                    {show('fee') ? (
                    <div style={{textAlign: "right"}}>
                      <SectionLabel>Fee</SectionLabel>
                      <div style={{display: "inline-block", marginTop: "1px", padding: "2px 8px", borderRadius: "999px", background: c.profit !== '—' ? "var(--positive-soft, #dcfce7)" : "var(--surface-2, #f4f4f5)", color: c.profit !== '—' ? "var(--tx-green, #15803d)" : "var(--meta, #71717a)", fontSize: "13px", fontWeight: "750", fontVariantNumeric: "tabular-nums"}}>{c.profit}</div>
                    </div>
                    ) : null}
                  </div>
                  ) : null}
                  {c.gapLine ? (
                    <div title={c.gapTitle} style={{margin: "6px 12px 0 14px", fontSize: "11.5px", fontWeight: 650, color: c.gapUp ? "var(--tx-green, #15803d)" : "#b45309", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{c.gapLine}</div>
                  ) : null}
                  {show('amended') && c.amended ? (
                    <div title="Latest amended price — full history on the Deal Sheet" style={{margin: "8px 12px 0 14px", fontSize: "11px", fontWeight: "600", color: "var(--tx-amber, #b45309)", background: "var(--tint-amber, #fffbeb)", border: "1px solid var(--tint-amber-2, #fde68a)", borderRadius: "7px", padding: "3px 7px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>Amended {c.amended}</div>
                  ) : null}
                  <div style={{ margin: '8px 12px 0 14px' }}><OptionTimers seller={c.optionSeller} buyer={c.optionBuyer} /></div>
                  {c.fridayClose ? (
                    <div data-testid="deal-friday" title="Closings are Monday to Thursday. Open the deal sheet to move it, or keep it with a reason." style={{margin: "8px 12px 0 14px", fontSize: "11px", fontWeight: 650, color: "var(--tx-red, #b91c1c)", background: "var(--tint-red, #fef2f2)", borderRadius: "7px", padding: "3px 7px"}}>Friday close</div>
                  ) : null}
                  {(show('phone') && c.phone) || (show('email') && c.email) ? (
                    <div style={{margin: "8px 12px 0 14px", display: "grid", gap: "2px", fontSize: "11.5px", minWidth: 0}}>
                      {show('phone') && c.phone ? <a className="clozr-contact" href={'tel:' + c.phone} onClick={(e) => { e.stopPropagation(); e.preventDefault(); V.callPhone(c.phone); }} style={{whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontVariantNumeric: "tabular-nums"}}>{c.phone}</a> : null}
                      {show('email') && c.email ? <a className="clozr-contact" href={'mailto:' + c.email} onClick={(e) => { e.stopPropagation(); e.preventDefault(); openReach('email', { name: '', email: c.email, audience: 'seller' }); }} style={{whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{c.email}</a> : null}
                    </div>
                  ) : null}
                  {show('rep') || show('next') || show('days') ? (
                  <div style={{display: "flex", alignItems: "center", gap: "7px", margin: "9px 12px 0 14px", paddingTop: "8px", borderTop: "1px dashed #ececee"}}>
                    {show('rep') ? <span title={c.rep} style={{width: "20px", height: "20px", borderRadius: "999px", background: "var(--ink, #18181b)", color: "var(--surface, #fff)", fontSize: "10.5px", fontWeight: "700", display: "grid", placeItems: "center", flex: "none"}}>{c.repInit}</span> : null}
                    <span style={{fontSize: "11px", color: "var(--muted, #52525b)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "1"}}>{show('next') ? c.next : ''}</span>
                    {c.noTitle ? <Badge tone="warn" title="No title company on this deal — open it to add one">No title</Badge> : null}
                    {show('days') ? <Badge title="Days in stage">{c.days}</Badge> : null}
                  </div>
                  ) : null}
                  <div onMouseDown={(e) => e.stopPropagation()} style={{display: "flex", flexDirection: "column", gap: "6px", margin: "9px 12px 0 14px"}}>
                    {c.setStage ? <StageSelect stage={col.stage} color={col.color} choices={V.dealStageChoices} onPick={c.setStage} height="28px" /> : null}
                    <Button data-testid="deal-sheet" onClick={c.openSheet} draggable={false} title="Open the deal sheet"
                      icon={<FileText size={13} aria-hidden />} style={{width: "100%"}}>
                      Deal sheet
                    </Button>
                    {V.can.tc ? (
                      <button type="button" className="dc2" data-testid="deal-tc" onClick={c.openTc} draggable={false}
                        title="Open transaction coordination"
                        style={{width: "100%", height: "28px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11.5px", fontWeight: "650", color: "var(--tx-green-deep, #1f7a4d)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px"}}>
                        <Mark label="TC" />
                        Transaction coordination
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
              {paged && col.pagedTotal! > col.cards.length ? (
                <button type="button" className="dc2" data-testid="deal-column-more" onClick={() => setProspectLimit((n) => n + PAGE)} style={{width: "100%", height: "32px", border: "1px solid var(--c-btn-line)", borderRadius: "10px", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "650", color: "var(--ink, #18181b)", cursor: "pointer"}}>
                  {`Show ${Math.min(PAGE, col.pagedTotal! - col.cards.length)} more · ${col.cards.length} of ${col.pagedTotal!.toLocaleString('en-US')}`}
                </button>
              ) : null}
              {!paged && col.cards.length > cap ? (
                <button type="button" className="dc2" onClick={() => setOpen((o) => ({ ...o, [col.stage]: !o[col.stage] }))} style={{width: "100%", height: "32px", border: "1px solid var(--c-btn-line)", borderRadius: "10px", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "650", color: "var(--ink, #18181b)", cursor: "pointer"}}>
                  {open[col.stage] ? 'Show fewer' : `Show ${col.cards.length - cap} more`}
                </button>
              ) : null}
              {col.cards.length === 0 ? (
                <div style={{border: "1.5px dashed #dcdcde", borderRadius: "12px", padding: "18px 10px", textAlign: "center", fontSize: "12px", color: "var(--meta, #71717a)"}}>{needle ? 'No match' : 'Drop a deal here'}</div>
              ) : null}
            </div>
            );
          })}
        </div>
        </div>
      ) : null}
      {(V.isMobile) ? (
        <>
        <div style={{flex: "1", minHeight: "0", overflow: "auto", background: "var(--canvas, #fafafa)", padding: "10px 10px calc(96px + env(safe-area-inset-bottom, 0px))"}}>
          {mobileCards.map((d) => (
            <React.Fragment key={d.dealId}>
            <div role="button" tabIndex={0} onClick={selectMode ? () => togglePick(d.dealId) : d.open} onKeyDown={V.cardKey} aria-pressed={selectMode ? !!picked[d.dealId] : undefined} data-testid={selectMode ? 'deal-card-pick' : undefined}
              style={{position: "relative", background: "var(--surface, #fff)", border: `1px solid ${selectMode && picked[d.dealId] ? 'var(--c-accent, #0a8560)' : 'var(--divider, #e4e4e7)'}`, boxShadow: selectMode && picked[d.dealId] ? 'inset 0 0 0 1px var(--c-accent, #0a8560)' : undefined, borderRadius: "13px", padding: "0 0 12px", marginBottom: "8px", cursor: "pointer", overflow: "hidden", contentVisibility: "auto", containIntrinsicHeight: "auto 471px"}}>
              {selectMode ? (
                <span style={{ position: 'absolute', top: '8px', right: '8px', zIndex: 2, display: 'grid', placeItems: 'center', width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(255,255,255,.92)', boxShadow: 'var(--shadow-ring, 0 0 0 1px rgba(0,0,0,.08))' }}>
                  <input type="checkbox" aria-label={`Select ${d.addr}`} checked={!!picked[d.dealId]} onChange={() => togglePick(d.dealId)} onClick={(e) => e.stopPropagation()} style={{ ...pickBox, width: '20px', height: '20px' }} />
                </span>
              ) : null}
              <button type="button" data-testid="deal-photo" onClick={(e) => { e.stopPropagation(); if (d.photos.length) V.openPhotoShow(d.addr, d.photos, d.dealDbId); }}
                title={d.photos.length ? 'View photos' : 'Street view'}
                style={{display: "block", width: "100%", height: "140px", padding: 0, border: 0, background: "var(--photo-bg, #e9ebf0)", cursor: "pointer", position: "relative"}}>
                <PropertyPhoto photo={d.photos?.[0] || ''} street={d.street || d.img} alt={'Photo of ' + d.addr} />
                {d.photos.length > 1 ? <span style={{position: "absolute", right: "8px", bottom: "8px", background: "rgba(12,14,18,.72)", color: "#fff", fontSize: "11px", fontWeight: 700, borderRadius: "999px", padding: "2px 7px"}}>{d.photos.length} photos</span> : null}
                <span style={{position: "absolute", left: "8px", top: "8px"}}><DealTypeBadge label={d.dealType} /></span>
              </button>
              <div style={{display: "flex", alignItems: "baseline", gap: "8px", padding: "12px 13px 0"}}>
                <span className="t-name" style={{minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                  {d.addr}
                </span>
                <span style={{flex: "1"}}></span>
                <span style={{display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: "600", color: d.healthColor, whiteSpace: "nowrap"}}>
                  <Mark label={d.health} />
                  {d.health.charAt(0).toUpperCase() + d.health.slice(1)}
                </span>
              </div>
              <div style={{fontSize: "12.5px", color: "var(--meta, #71717a)", marginTop: "1px", padding: "0 13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                {d.seller}{d.added && d.added !== '—' ? ` · Added ${d.added}` : ''}{d.closeBadge || !d.close || d.close === '—' ? '' : ` · Close ${d.close}`}
              </div>
              {d.closeBadge ? <div style={{ margin: "10px 13px 0" }}><CloseBar badge={d.closeBadge} /></div> : null}
              <div style={{display: "flex", alignItems: "flex-end", gap: "14px", marginTop: "10px", padding: "0 13px"}}>
                <span>
                  <span className="t-meta" style={{display: "block"}}>
                    Contract
                  </span>
                  <span style={{display: "block", fontSize: "17px", fontWeight: "700", letterSpacing: "-0.02em"}}>
                    {d.contract}
                  </span>
                  {d.gapLine ? <span title={d.gapTitle} style={{display: "block", marginTop: "2px", fontSize: "11.5px", fontWeight: 650, color: d.gapUp ? "var(--tx-green, #15803d)" : "#b45309"}}>{d.gapLine}</span> : null}
                </span>
                <span>
                  <span className="t-meta" style={{display: "block"}}>
                    Profit
                  </span>
                  <span style={{display: "block", fontSize: "17px", fontWeight: "700", letterSpacing: "-0.02em", color: "var(--tx-green, #15803d)", fontVariantNumeric: "tabular-nums"}}>
                    {d.profit}
                  </span>
                </span>
              </div>
              <div onClick={(e) => e.stopPropagation()} style={{display: "flex", flexDirection: "column", gap: "6px", margin: "10px 13px 0"}}>
                <Button data-testid="deal-sheet" onClick={d.openSheet} title="Open the deal sheet" icon={<FileText size={13} aria-hidden />} style={{width: "100%"}}>
                  Deal sheet
                </Button>
                {V.can.tc ? (
                  <button className="dc2" data-testid="deal-tc" onClick={d.openTc} title="Open transaction coordination" style={{height: "32px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: "650", color: "var(--tx-green-deep, #1f7a4d)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px"}}>
                    <Mark label="TC" />
                    Transaction coordination
                  </button>
                ) : null}
              </div>
              <div style={{display: "flex", alignItems: "center", gap: "10px", margin: "10px 13px 0", paddingTop: "8px", borderTop: "1px solid var(--divider-2, #f0f0f1)"}}>
                {d.setStage ? <StageSelect stage={d.stage} color={d.stageColor} choices={V.dealStageChoices} onPick={d.setStage} height="32px" /> : (
                <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11.5px", fontWeight: "600", color: textTone(d.stageColor)}}>
                  <Mark label={d.stage} />
                  {d.stage}
                </span>
                )}
                <span style={{flex: "1"}}></span>
                {d.dealId ? (
                  <button type="button" data-testid="deal-archive-m" onClick={(e) => { e.stopPropagation(); if (d.archived) V.unarchiveDeal(d.dealId); else V.archiveDeal(d.dealId); }}
                    style={{height: "32px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--divider, #e4e4e7)", background: "var(--surface, #fff)", fontSize: "12px", fontWeight: 600, color: d.archived ? "var(--tx-mint, #0a8560)" : "var(--muted, #52525b)", cursor: "pointer", whiteSpace: "nowrap"}}>
                    {d.archived ? 'Restore deal' : 'Archive deal'}
                  </button>
                ) : null}
              </div>
              <div style={{ margin: '8px 13px 0' }}>
                <OptionTimers seller={d.optionSeller} buyer={d.optionBuyer} />
              </div>
            </div>
            </React.Fragment>
          ))}
        </div>
        </>
      ) : null}
      {(V.isTable && !V.isMobile && selectedIds.length) ? <DealsBulkBar V={V} ids={selectedIds} onClear={clearPicks} phone={false} /> : null}
      {(V.isMobile && selectMode && selectedIds.length) ? <DealsBulkBar V={V} ids={selectedIds} onClear={clearPicks} phone /> : null}
      {(V.isTable && !V.isMobile) ? (
        <>
        <div className="clozr-scroll-well" style={{flex: "1", minHeight: "0", overflow: "auto", background: "var(--page)", padding: "14px 20px 20px", scrollPadding: "54px 20px 20px"}}>
          <div style={{minWidth: "100%", width: "max-content", background: "var(--surface, #fff)", border: "1px solid #ececee", borderRadius: "12px", overflow: "clip"}}>
          <table className="cz-zebra" style={{width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px", minWidth: `${Math.max(760, visibleFields.length * 118)}px`}}>
            <thead>
              <tr>
                <th style={{position: "sticky", top: "0", zIndex: 2, background: "var(--surface, #fff)", borderBottom: "1px solid #ececee", padding: "0 0 0 12px", height: "40px", width: "30px"}}>
                  <input type="checkbox" data-testid="deals-pick-all" aria-label={allShownPicked ? 'Clear the selection' : `Select all ${tableShown.length} deals shown`} checked={allShownPicked} onChange={toggleAllShown} disabled={!tableShown.length} style={pickBox} />
                </th>
                {visibleFields.map((f) => {
                  const i = f.key === ACTIONS ? -1 : Number(f.key.slice(1));
                  const right = isMoneyCol(i) || i === C.daysToClose;
                  const sk = colSortKey(f);
                  const active = sk != null && sort.key === sk;
                  return (
                  <th key={f.key} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} style={{position: "sticky", top: "0", zIndex: f.key === ACTIONS ? 3 : 2, ...(f.key === ACTIONS ? {right: 0, boxShadow: "-8px 0 12px -10px rgba(18,20,28,.25)"} : null), background: "var(--surface, #fff)", borderBottom: "1px solid #ececee", padding: "0 12px", height: "40px", textAlign: right ? "right" : "left", fontSize: "12px", fontWeight: "500", color: active ? "var(--tx-mint, #0a8560)" : "var(--meta, #71717a)", whiteSpace: "nowrap"}}>
                    {sk ? (
                      <button type="button" onClick={() => setSort((cur) => toggleSort(cur, sk, firstDealDir(sk)))} style={{background: "none", border: 0, padding: 0, font: "inherit", letterSpacing: "inherit", textTransform: "inherit", color: "inherit", cursor: "pointer", fontWeight: 500}}>
                        {f.label}{active ? (sort.dir === 'asc' ? <ArrowUp size={12} aria-hidden style={{marginLeft: 3, verticalAlign: "-2px"}} /> : <ArrowDown size={12} aria-hidden style={{marginLeft: 3, verticalAlign: "-2px"}} />) : null}
                      </button>
                    ) : null}
                  </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={visibleFields.length + 1} style={{padding: "28px 12px", textAlign: "center", color: "var(--meta, #71717a)"}}>{needle ? `No deal matches “${q.trim()}”.` : 'No deals yet.'}</td></tr>
              ) : null}
              {rows.slice(0, tableLimit).map((d) => (
                <React.Fragment key={d.dealId}>
                <tr className="dc2" onClick={d.open} aria-selected={picked[d.dealId] || undefined} style={{cursor: "pointer", background: picked[d.dealId] ? 'var(--mint-dim, #e7f8f1)' : undefined}}>
                  <td onClick={(e) => e.stopPropagation()} style={{padding: "0 0 0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", width: "30px"}}>
                    <input type="checkbox" data-testid="deal-pick" aria-label={`Select ${d.addr}`} checked={!!picked[d.dealId]} onChange={() => togglePick(d.dealId)} style={pickBox} />
                  </td>
                  {visibleFields.map((f) => {
                    if (f.key === ACTIONS) {
                      return (
                        <td key={f.key} className="cz-sticky-col" onClick={(e) => e.stopPropagation()} style={{position: "sticky", right: 0, zIndex: 1, boxShadow: "-8px 0 12px -10px rgba(18,20,28,.25)", padding: "0 10px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap"}}>
                          <span style={{display: "inline-flex", flexDirection: "column", gap: "4px", padding: "6px 0"}}>
                            <button className={buttonClass('ghost', 28)} data-testid="deal-sheet" onClick={d.openSheet} title="Open the deal sheet">
                              Deal sheet
                            </button>
                            {d.setStage ? <StageSelect stage={d.stage} color={d.stageColor} choices={V.dealStageChoices} onPick={d.setStage} height="26px" /> : null}
                            {d.dealId ? (
                              <button className="dc2" data-testid="deal-archive" onClick={() => (d.archived ? V.unarchiveDeal(d.dealId) : V.archiveDeal(d.dealId))} title={d.archived ? `Archived${d.archivedReason ? ` (${d.archivedReason})` : ''}: put it back on the board` : 'Archive: off the board, the list and Dispo'}
                                style={{display: "inline-flex", alignItems: "center", justifyContent: "center", height: "24px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11.5px", fontWeight: "600", color: d.archived ? "var(--tx-mint, #0a8560)" : "var(--meta, #71717a)", cursor: "pointer"}}>
                                {d.archived ? 'Restore' : 'Archive'}
                              </button>
                            ) : null}
                            {V.can.tc ? (
                              <button className="dc2" data-testid="deal-tc" onClick={d.openTc} title="Open transaction coordination" style={{display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", height: "24px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11px", fontWeight: "600", color: "var(--tx-green-deep, #1f7a4d)", cursor: "pointer"}}>
                                <Mark label={'TC'} />
                                TC
                              </button>
                            ) : null}
                          </span>
                        </td>
                      );
                    }
                    const i = Number(f.key.slice(1));
                    const cell = d.cells[i] ?? '—';
                    const isContact = (i === C.phone || i === C.email) && cell !== '—';
                    return (
                    <td key={f.key} style={{padding: "0 12px", height: "48px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", fontWeight: i === C.address ? "700" : "400", fontSize: i === C.address ? "15px" : undefined, color: i === C.dispoFee && cell !== '—' ? "#15803d" : (isMoneyCol(i) || i === C.address) ? "var(--ink, #18181b)" : "var(--muted, #52525b)", textAlign: isMoneyCol(i) || i === C.daysToClose ? "right" : "left", fontVariantNumeric: "tabular-nums"}}>
                      {i === C.status ? (
                        <span style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "24px", padding: "0 9px", borderRadius: "6px", fontSize: "12px", fontWeight: "600", color: `color-mix(in srgb, ${d.stageColor} 55%, var(--ink, #18181b))`, background: `color-mix(in srgb, ${d.stageColor} 11%, var(--surface, #fff))`}}>
                          <span style={{color: d.stageColor, display: "inline-flex"}}><Mark label={cell} /></span>
                          {cell}
                        </span>
                      ) : i === C.address ? (
                        <span style={{display: "inline-flex", alignItems: "center", gap: "8px"}}>
                          <button type="button" data-testid="deal-photo" onClick={(e) => { e.stopPropagation(); if (d.photos.length) V.openPhotoShow(d.addr, d.photos, d.dealDbId); }} title={d.photos.length ? 'View photos' : 'Street view'} style={{width: "46px", height: "32px", padding: 0, border: 0, borderRadius: "6px", overflow: "hidden", background: "var(--photo-bg, #e9ebf0)", cursor: "pointer", flex: "none"}}>
                            <PropertyPhoto photo={d.photos?.[0] || ''} street={d.street || d.img} alt="" />
                          </button>
                          <span>{cell}{d.amended ? <span title={'Amended: ' + d.amended} style={{marginLeft: "6px", fontSize: "11px", fontWeight: "600", color: "var(--tx-amber, #b45309)", background: "var(--tint-amber, #fffbeb)", borderRadius: "6px", padding: "2px 6px"}}>Amended</span> : null}</span>
                        </span>
                      ) : isContact ? (
                        <a className="clozr-contact" href={(i === C.phone ? 'tel:' : 'mailto:') + cell} onClick={(e) => { e.stopPropagation(); e.preventDefault(); if (i === C.phone) V.callPhone(cell); else openReach('email', { name: '', email: cell, audience: 'seller' }); }}>{cell}</a>
                      ) : cell}
                    </td>
                    );
                  })}
                </tr>
                </React.Fragment>
              ))}
            </tbody>
          </table>
          {rows.length > tableLimit ? (
            <div style={{padding: "10px 12px", borderTop: "1px solid var(--divider-2, #f0f0f1)", display: "flex", alignItems: "center", gap: "10px", fontSize: "12px", color: "var(--meta, #71717a)"}}>
              <span>{`Showing ${tableLimit} of ${rows.length.toLocaleString('en-US')} deals`}</span>
              <button type="button" className="dc2" data-testid="deals-table-more" onClick={() => setTableLimit((n) => n + PAGE)} style={{height: "28px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12px", fontWeight: 600, color: "var(--ink, #18181b)", cursor: "pointer"}}>
                {`Show ${Math.min(PAGE, rows.length - tableLimit)} more`}
              </button>
            </div>
          ) : null}
          </div>
        </div>
        </>
      ) : null}
    </section>
  );
}
