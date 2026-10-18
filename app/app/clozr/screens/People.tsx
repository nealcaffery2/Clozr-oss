// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import { RailToggle, useRailOpen } from '@/components/ds/ListRail';
import { ContractsButton } from '@/components/ContractsHub';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { PickLabel } from '@/components/ds/PickBox';
import { MoreFilters, MoreFiltersFields } from '@/app/components/people/MoreFilters';
import { FilterPanel } from '@/app/components/filters/FilterPanel';
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
import { ViewMenu, sameList } from '@/components/ViewControls';
import { Chevron, MenuCheck, seg, segWrap, trayBtn } from '@/components/ds/chrome';
import { cleanColumns, useSavedViews } from '@/lib/saved-views';
import type { PeopleFilters } from '@/app/clozr/useClozr';
import { isTypingTarget, listNavBlocked, peopleNavAction, isArchiveKey, isSelectAllChord, isOpenKey } from '@/lib/people-keys';
import { Mark } from '@/components/ds/mark';
import { openReach } from '@/app/components/record/reach';
import { PeopleColumns } from '@/app/components/people/PeopleColumns';
import { picksOf, togglePick } from '@/lib/multi-filter';
import { DATE_RANGES } from '@/lib/date-window';
import { ArrowDown, ArrowDownUp, ArrowUp, ArrowUpRight, Bookmark, ChevronLeft, ChevronRight, Download, Filter, Mail, MessageSquare, Phone, PhoneOutgoing, Plus, Search, Settings2, Sparkles, Tag, Trash2, Upload, UserCheck, UserPlus, Users, Voicemail, X } from 'lucide-react';
import '@/app/components/people/people.css';


type PeopleRowData = ClozrView['peopleRows'][number];

/** Minutes since the last touch, as the colour it reads in: quiet under 3 days, amber to 7, red past that. */
const lastTone = (age: number | null | undefined) => (age == null || age < 3 * 1440 ? 'is-quiet' : age <= 7 * 1440 ? 'is-amber' : 'is-red');
const LAST_ICON: Record<string, React.ReactNode> = {
  Call: <Phone size={12} aria-hidden />, SMS: <MessageSquare size={12} aria-hidden />, Email: <Mail size={12} aria-hidden />, Voicemail: <Voicemail size={12} aria-hidden />,
};
const real = (v: unknown) => !!v && v !== '—';

/**
 * One lead in the table. Memoized on the row object, which useClozr rebuilds
 * only when the list, the selection, the cursor or the columns change, so a
 * keystroke elsewhere in the shell no longer redraws every drawn row.
 * The last cell is the hover tray: call, text, email, open.
 */
const PeopleRow = React.memo(function PeopleRow({ p, callPhone }: { p: PeopleRowData; callPhone: (phone: string) => void }) {
  const hasPhone = real(p.phone);
  const hasEmail = real(p.email);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <tr className={'pp-row' + (p.focused ? ' is-focus' : '')} data-people-focus={p.focused ? 'true' : 'false'}
      style={{ cursor: 'pointer', background: p.checked ? 'var(--c-accent-soft, #E7F8F1)' : p.focused ? 'var(--surface-2, #f4f4f5)' : 'var(--surface, #fff)' }}>
      <td className="pp-td" style={{ width: '36px' }}>
        <input type="checkbox" checked={!!(p.checked)} onChange={p.toggle} aria-label={`Select ${p.name}`} style={{ width: '14px', height: '14px', accentColor: 'var(--c-accent, #0A8560)', cursor: 'pointer', display: 'block' }} />
      </td>
      {(p.cells || []).map((c, c__i) => (
        <td key={c__i} className="pp-td" onClick={p.open}>
          {c.isName ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
              <span className="pp-avatar" aria-hidden>{c.initials}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600, color: 'var(--ink, #18181b)', lineHeight: 1.25 }}>{c.v}</span>
                {real(c.source) ? <span className="pp-sub">{c.source}</span> : null}
              </span>
            </div>
          ) : null}
          {c.isStage ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: '24px', padding: '0 9px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, color: `color-mix(in srgb, ${c.stageColor} 55%, var(--ink, #18181b))`, background: `color-mix(in srgb, ${c.stageColor} 11%, var(--surface, #fff))` }}>
              <Mark label={String(c.v)} />
              {c.v}
            </span>
          ) : null}
          {c.isProperty ? (
            <>
              <span style={{ display: 'block', color: 'var(--ink-2, #27272a)', lineHeight: 1.25 }}>{c.v}</span>
              <span className="pp-sub">{c.cityLine}</span>
            </>
          ) : null}
          {c.isAssigned ? (
            c.assignedInitials ? (
              <span className="pp-rep"><span className="pp-avatar" aria-hidden>{c.assignedInitials}</span><span style={{ color: 'var(--ink-2, #27272a)' }}>{c.v}</span></span>
            ) : <span style={{ color: '#b91c1c', fontWeight: 500 }}>{c.v}</span>
          ) : null}
          {c.isScore ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <span aria-hidden style={{ width: '44px', height: '4px', borderRadius: '2px', background: 'var(--divider-2, #f0f0f1)', overflow: 'hidden', display: 'inline-block' }}>
                <span style={{ display: 'block', height: '100%', width: c.scorePct, background: c.scoreColor }}></span>
              </span>
              <span style={{ fontWeight: 600, color: c.scoreColor, fontVariantNumeric: 'tabular-nums' }}>{c.v}</span>
              <span style={{ fontSize: '11.5px', fontWeight: 600, color: c.scoreColor }}>{c.heatLabel}</span>
            </span>
          ) : null}
          {c.isTemp ? (
            <span style={{ fontSize: '12px', fontWeight: 600, color: c.tempColor }}>{c.temp.charAt(0) + c.temp.slice(1).toLowerCase()}</span>
          ) : null}
          {c.isUwTriage ? (
            <span title={c.uwTriageHint} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: '24px', padding: '0 9px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, color: c.uwTriageColor, background: `color-mix(in srgb, ${c.uwTriageColor} 12%, var(--surface, #fff))`, border: `1px solid color-mix(in srgb, ${c.uwTriageColor} 35%, var(--surface, #fff))` }}>
              {c.v}
            </span>
          ) : null}
          {c.isLast ? (
            <span className={'pp-last ' + lastTone(c.lastAge)} title={c.lastAge == null ? 'No contact logged' : c.lastAge > 7 * 1440 ? 'More than 7 days since the last touch' : c.lastAge >= 3 * 1440 ? '3 to 7 days since the last touch' : undefined}>
              {LAST_ICON[String(c.v).split(' · ')[0]] ?? null}
              {c.v}
            </span>
          ) : c.isPlain ? (
            <span style={{ color: c.weight === '500' ? 'var(--ink, #18181b)' : 'var(--ink-2, #27272a)', fontWeight: c.weight }}>{c.v}</span>
          ) : null}
          {c.isContact ? (
            real(c.v) ? (
              <>
                <a className="clozr-contact" href={(c.key === 'email' ? 'mailto:' : 'tel:') + c.v} onClick={(e) => { stop(e); e.preventDefault(); if (c.key === 'email') openReach('email', { name: p.name, email: String(c.v) }); else callPhone(String(c.v)); }}>{c.v}</a>
                {c.key === 'phone' ? <button type="button" className="pp-inline" onClick={(e) => { stop(e); openReach('text', { name: p.name, phone: String(c.v) }); }}>Send text</button> : null}
              </>
            ) : <span style={{ color: 'var(--subtle, #a1a1aa)' }}>—</span>
          ) : null}
        </td>
      ))}
      <td className="pp-td pp-quick">
        <span className="pp-quick-box" role="group" aria-label={`Quick actions for ${p.name}`}>
          <button type="button" className="pp-icon" disabled={!hasPhone} title={hasPhone ? `Call ${p.name}` : 'No phone'} aria-label={hasPhone ? `Call ${p.name}` : `No phone for ${p.name}`} onClick={(e) => { stop(e); callPhone(p.phone); }}><Phone size={14} aria-hidden /></button>
          <button type="button" className="pp-icon" disabled={!hasPhone} title={hasPhone ? `Text ${p.name}` : 'No phone'} aria-label={hasPhone ? `Text ${p.name}` : `No phone for ${p.name}`} onClick={(e) => { stop(e); openReach('text', { name: p.name, phone: p.phone }); }}><MessageSquare size={14} aria-hidden /></button>
          <button type="button" className="pp-icon" disabled={!hasEmail} title={hasEmail ? `Email ${p.name}` : 'No email'} aria-label={hasEmail ? `Email ${p.name}` : `No email for ${p.name}`} onClick={(e) => { stop(e); openReach('email', { name: p.name, email: p.email }); }}><Mail size={14} aria-hidden /></button>
          <button type="button" className="pp-icon" title={`Open ${p.name}`} aria-label={`Open ${p.name}`} onClick={(e) => { stop(e); p.open(); }}><ArrowUpRight size={14} aria-hidden /></button>
        </span>
      </td>
    </tr>
  );
});

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

const dialogField: React.CSSProperties = { width: '100%', height: '36px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', fontSize: '14px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', fontFamily: 'inherit', boxSizing: 'border-box' };
const dialogLabel: React.CSSProperties = { display: 'block', fontSize: '11.5px', fontWeight: 500, color: 'var(--muted, #52525b)', marginBottom: '4px' };

function SmartListForm({ V }: { V: ClozrView }) {
  const [name, setName] = useState(V.suggestedListName);
  const [group, setGroup] = useState('');
  const [access, setAccess] = useState<string[]>(() => V.smartListTeam.map((p) => p.id));
  const toggle = (id: string) => setAccess((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const groups = Array.from(new Set((V.savedListRows || []).map((l) => l.group).filter(Boolean)));
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="smart-list-title" data-testid="smart-list-dialog"
      style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'grid', placeItems: 'center', background: 'rgba(12,13,16,.28)', padding: '16px' }}>
      <form onSubmit={(e) => { e.preventDefault(); V.commitSmartList(name, access, group); }}
        style={{ width: 'min(420px, 100%)', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', borderRadius: '14px', padding: '18px', boxShadow: 'var(--shadow-lg)' }}>
        <h2 id="smart-list-title" style={{ margin: 0, fontSize: '15px', fontWeight: 700, letterSpacing: '-0.015em' }}>Save as smart list</h2>
        <p style={{ margin: '6px 0 0', fontSize: '12.5px', color: 'var(--muted, #52525b)' }}>It keeps the filters and columns you have on now, and its count stays live. Choose who on the team can open it.</p>
        <label style={{ display: 'block', marginTop: '12px' }}>
          <span style={dialogLabel}>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={{ ...dialogField, fontWeight: 600 }} />
        </label>
        <label style={{ display: 'block', marginTop: '10px' }}>
          <span style={dialogLabel}>Collection (optional)</span>
          <input value={group} onChange={(e) => setGroup(e.target.value)} list="smart-list-groups" placeholder="A heading in the rail, e.g. Follow-up…" style={dialogField} />
          <datalist id="smart-list-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </label>
        <span style={{ ...dialogLabel, marginTop: '10px' }}>Who can open it</span>
        <div style={{ maxHeight: '200px', overflow: 'auto', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px' }}>
          {V.smartListTeam.map((p) => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderTop: '1px solid var(--divider-2, #f0f0f1)', fontSize: '13px', cursor: 'pointer' }}>
              <input type="checkbox" checked={access.includes(p.id)} onChange={() => toggle(p.id)} style={{ accentColor: 'var(--c-accent, #0A8560)' }} />
              <span style={{ flex: 1 }}>{p.name}</span>
              {p.me ? <span style={{ fontSize: '11px', color: 'var(--muted, #52525b)' }}>You</span> : null}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
          <button type="button" className="pp-btn" onClick={V.closeSmartList}>Cancel</button>
          <button type="submit" className="dc10" style={{ height: '32px', padding: '0 14px', borderRadius: '8px', border: 0, background: 'var(--c-primary)', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}>Save list</button>
        </div>
      </form>
    </div>
  );
}

/**
 * Leads | Submissions: which half of People the rail lists. Partnerships has
 * only submissions and never sees it (V.peopleSideSwitch).
 */
function PeopleSideSwitch({ V, phone }: { V: ClozrView; phone?: boolean }) {
  if (!V.peopleSideSwitch) return null;
  const sides = [
    { key: 'leads' as const, label: 'Leads', count: V.peopleSideCounts.leads },
    { key: 'submissions' as const, label: 'Submissions', count: V.peopleSideCounts.submissions },
  ];
  return (
    <div role="group" aria-label="Lists to show" data-testid="people-side" className={'cz-half' + (phone ? ' cz-half--phone' : '')}>
      {sides.map((x) => (
        <button key={x.key} type="button" className="cz-half-btn" aria-pressed={V.peopleSide === x.key} onClick={() => V.setPeopleSide(x.key)}>
          {x.label}
          <span className="cz-half-count">{x.count.toLocaleString('en-US')}</span>
        </button>
      ))}
    </div>
  );
}

/** The rail's +, and the header's New list: the filters on now, saved as a smart list. */
function SaveListButton({ V, label }: { V: ClozrView; label?: string }) {
  if (label) {
    return (
      <button type="button" className="pp-btn" onClick={V.saveSmartList} title="Save the current filters and columns as a smart list">
        <Plus size={13} aria-hidden />{label}
      </button>
    );
  }
  return (
    <button type="button" className="pp-icon" onClick={V.saveSmartList} title="Save the current filters as a smart list" aria-label="Save the current filters as a smart list" style={{ width: '24px', height: '24px' }}>
      <Plus size={13} aria-hidden />
    </button>
  );
}

type FilterMenuOf = ClozrView['peopleFilterMenus'][number];
const menuOf = (V: ClozrView, key: string): FilterMenuOf | undefined => (V.peopleFilterMenus || []).find((f) => f.key === key);
const optionOf = (V: ClozrView, key: string, label: string) => menuOf(V, key)?.options.find((o) => o.label === label);

/** The one-click filters over the table: each is one option of a filter the panel also has. */
function QuickChips({ V, tray = false }: { V: ClozrView; tray?: boolean }) {
  const more = V.peopleMore;
  const newWeek = more.values.addedWhen === 'Last 7 days';
  const chips: { label: string; on: boolean; go: () => void; hint: string }[] = [];
  const fromOption = (label: string, key: string, option: string, hint: string) => {
    const o = optionOf(V, key, option);
    if (o) chips.push({ label, on: o.on, go: o.go, hint });
  };
  fromOption('Hot', 'heat', 'Hot', 'Lead score 85 or more, or Talkr says hot');
  fromOption('No touch 7d', 'date', 'No contact 7 days', 'No call, text or email in the last 7 days');
  if (!V.isVendorList) chips.push({ label: 'New this week', on: newWeek, hint: 'Added in the last 7 days', go: () => more.set({ addedWhen: newWeek ? 'Any' : 'Last 7 days', addedFrom: 'Any', addedTo: 'Any' }) });
  fromOption('Unassigned', 'owner', 'Unassigned', 'No rep assigned');
  fromOption('Needs offer', 'compr', 'Run, no offer', 'Underwritten by COMPR with no offer out');
  if (!chips.length) return null;
  return (
    <div role="group" aria-label="Quick filters" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: tray ? 'nowrap' : 'wrap', flex: 'none' }}>
      {chips.map((c) => (
        <button key={c.label} type="button" className="pp-chip" aria-pressed={c.on} onClick={c.go} title={c.hint} style={tray ? { height: '32px', borderRadius: '16px', padding: '0 12px' } : undefined}>{c.label}</button>
      ))}
    </div>
  );
}

/** Everyone / Me / a rep: the Owner filter, the way Follow Up Boss puts it beside Columns. */
function ScopeMenu({ V }: { V: ClozrView }) {
  const [open, setOpen] = useState(false);
  const menu = menuOf(V, 'owner');
  if (!menu) return null;
  const picks = picksOf(V.peoplePf.owner);
  const me = V.ownerMeName;
  const label = !picks.length ? 'Everyone' : picks.length === 1 && picks[0] === me ? 'Me' : menu.value;
  const close = () => setOpen(false);
  const pickMe = () => {
    // Me alone: clear whoever was picked, then pick the signed-in rep.
    menu.options.find((o) => o.label === 'Any')?.go();
    menu.options.find((o) => o.label === me)?.go();
    close();
  };
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button type="button" className={'pp-btn' + (picks.length ? ' is-on' : '')} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Whose leads to show">
        <Users size={13} aria-hidden />
        <span style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <Chevron size={11} dir={open ? 'up' : 'down'} />
      </button>
      {open ? (
        <>
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={keepInView} role="menu" aria-label="Whose leads to show" className="cz-menu cz-menu--right" style={{ top: '38px', right: 0, minWidth: '220px', maxHeight: 'min(360px, 48vh)', overflow: 'auto' }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
            <button type="button" role="menuitemradio" aria-checked={!picks.length} className={'dc2 cz-menu-item' + (!picks.length ? ' is-on' : '')} onClick={() => { menu.options.find((o) => o.label === 'Any')?.go(); close(); }}>
              <span style={{ flex: 1 }}>Everyone</span><MenuCheck on={!picks.length} />
            </button>
            {me ? (
              <button type="button" role="menuitemradio" aria-checked={picks.length === 1 && picks[0] === me} className={'dc2 cz-menu-item' + (picks.length === 1 && picks[0] === me ? ' is-on' : '')} onClick={pickMe}>
                <span style={{ flex: 1 }}>Me</span><MenuCheck on={picks.length === 1 && picks[0] === me} />
              </button>
            ) : null}
            <div className="cz-menu-sep" />
            <div className="cz-menu-head">Reps</div>
            {menu.options.filter((o) => o.label !== 'Any').map((o) => (
              <button key={o.label} type="button" role="menuitemcheckbox" aria-checked={o.on} className={'dc2 cz-menu-item' + (o.on ? ' is-on' : '')} onClick={o.go}>
                <PickLabel multi on={o.on} label={o.label} />
              </button>
            ))}
            <div className="cz-menu-info" style={{ padding: '6px 10px 4px', fontSize: '11px', color: 'var(--muted, #52525b)' }}>Pick several reps to see all of their leads.</div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Which header filter a column opens: a pick list the panel has, a range from More filters, or the list search. */
const COL_MENU: Record<string, string> = { stage: 'stage', assigned: 'owner', source: 'source', tags: 'tag', phone: 'phone', email: 'email', lastComm: 'date', score: 'heat', uwTriage: 'uwTriage' };
const COL_MORE: Record<string, { key: 'addedWhen' | 'offer' | 'arv' | 'subs' | 'props' | 'stack' | 'market'; options: (V: ClozrView) => readonly string[]; multi?: boolean }> = {
  created: { key: 'addedWhen', options: () => DATE_RANGES },
  offer: { key: 'offer', options: (V) => V.peopleMore.money },
  arv: { key: 'arv', options: (V) => V.peopleMore.money },
  subs: { key: 'subs', options: (V) => V.peopleMore.subs },
  props: { key: 'props', options: (V) => V.peopleMore.props },
  stack: { key: 'stack', options: (V) => V.peopleMore.stack },
  market: { key: 'market', options: (V) => V.peopleMore.markets, multi: true },
};
const COL_TEXT = new Set(['name', 'property', 'city', 'zip', 'nextTask', 'motivation', 'timeline', 'condition', 'occupancy', 'asking']);

function columnFilterOn(V: ClozrView, key: string): boolean {
  if (COL_MENU[key]) return !!menuOf(V, COL_MENU[key])?.on;
  if (COL_MORE[key]) return (V.peopleMore.values[COL_MORE[key].key] ?? 'Any') !== 'Any';
  if (COL_TEXT.has(key)) return !!V.peopleQ.trim();
  return false;
}
const columnFilterable = (V: ClozrView, key: string) => (COL_MENU[key] ? !!menuOf(V, COL_MENU[key]) : !!COL_MORE[key] || COL_TEXT.has(key));

/** The per-column filter under a header's funnel icon. */
function ColumnFilter({ V, col, q, setQ, onClose }: { V: ClozrView; col: { key: string; label: string }; q: string; setQ: (v: string) => void; onClose: () => void }) {
  const menu = COL_MENU[col.key] ? menuOf(V, COL_MENU[col.key]) : undefined;
  const more = COL_MORE[col.key];
  const value = more ? (V.peopleMore.values[more.key] ?? 'Any') : 'Any';
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
      <div ref={keepInView} role="dialog" aria-label={`Filter by ${col.label.toLowerCase()}`} className="cz-menu cz-menu--left" style={{ top: '34px', left: '-10px', minWidth: '220px', maxHeight: 'min(360px, 48vh)', overflow: 'auto' }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <div className="cz-menu-head">Filter by {col.label.toLowerCase()}</div>
        {menu ? menu.options.map((o) => (
          <button key={o.label} type="button" className={'dc2 cz-menu-item' + (o.on ? ' is-on' : '')} onClick={() => { o.go(); if (!menu.multi || o.label === 'Any') onClose(); }} aria-pressed={menu.multi ? o.on : undefined}>
            <PickLabel multi={!!menu.multi} on={o.on} label={o.label} />
            {o.on && !(menu.multi && o.label !== 'Any') ? <MenuCheck on /> : null}
          </button>
        )) : null}
        {more ? more.options(V).filter((o) => o !== 'Custom').map((o) => {
          const on = more.multi ? (o === 'Any' ? value === 'Any' : picksOf(value).includes(o)) : value === o;
          return (
            <button key={o} type="button" className={'dc2 cz-menu-item' + (on ? ' is-on' : '')} aria-pressed={more.multi ? on : undefined}
              onClick={() => { V.peopleMore.set({ [more.key]: more.multi ? togglePick(value, o) : o }); if (!more.multi || o === 'Any') onClose(); }}>
              <PickLabel multi={!!more.multi} on={on} label={o} />
              {on && !more.multi ? <MenuCheck on /> : null}
            </button>
          );
        }) : null}
        {!menu && !more ? (
          <div style={{ padding: '4px 6px 6px' }}>
            <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${col.label.toLowerCase()}…`} aria-label={`Search this list by ${col.label.toLowerCase()}`}
              onKeyDown={(e) => { if (e.key === 'Enter') onClose(); }}
              style={{ width: '100%', height: '32px', padding: '0 10px', border: 0, borderRadius: '8px', boxShadow: 'var(--shadow-ring)', fontSize: '13px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', boxSizing: 'border-box' }} />
            <div style={{ padding: '6px 2px 0', fontSize: '11px', color: 'var(--muted, #52525b)' }}>Searches every field in this list.</div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** One rail row: an icon, the list name and its count; the open list is a solid accent row. */
function RailBtn({ label, count, on, go, icon, pinned, disabled, title, drag, over }: {
  label: string; count: number | null; on: boolean; go: () => void; icon: React.ReactNode; pinned?: boolean; disabled?: boolean; title?: string;
  drag?: Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'draggable' | 'onDragStart' | 'onDragOver' | 'onDragLeave' | 'onDrop' | 'onContextMenu'>; over?: boolean;
}) {
  return (
    <button type="button" className={'pp-rail-row' + (pinned ? ' is-pinned' : '') + (over ? ' is-over' : '')} onClick={go} aria-current={on ? 'page' : undefined} disabled={disabled} title={title} {...drag}>
      <span className="pp-rail-ic" aria-hidden>{icon}</span>
      <span className="pp-rail-label">{label}</span>
      {count == null ? null : <span className="pp-rail-count">{count.toLocaleString('en-US')}</span>}
    </button>
  );
}

// The header's icon row (Follow Up Boss's mass actions): the actions with an
// icon stay on the row; the rest group under More. Every action stays.
const ICON_ACTIONS: [string, React.ReactNode][] = [
  ['Email', <Mail size={15} aria-hidden key="email" />],
  ['Text', <MessageSquare size={15} aria-hidden key="text" />],
  ['Add to Call Queue', <PhoneOutgoing size={15} aria-hidden key="queue" />],
  ['Call List', <PhoneOutgoing size={15} aria-hidden key="call" />],
  ['Assign', <UserPlus size={15} aria-hidden key="assign" />],
  ['Add Tag', <Tag size={15} aria-hidden key="tag" />],
  ['Export', <Download size={15} aria-hidden key="export" />],
  ['Archive', <Trash2 size={15} aria-hidden key="archive" />],
];
const ICON_SET = new Set(ICON_ACTIONS.map(([l]) => l));
const MENU_GROUP: Record<string, string> = {
  RVM: 'Reach out',
  'Change Stage': 'Organize', 'Remove Tag': 'Organize', 'Start Action Plan': 'Organize',
  'Pause action plans': 'Organize', 'Stop action plans': 'Organize',
  'Run COMPR': 'Data',
};
const GROUP_ORDER = ['Reach out', 'Organize', 'Data', 'More', 'Remove'];
/** The rail's own names for the two lists every rep starts from. */
const RAIL_LABEL: Record<string, string> = { Sellers: 'All people', 'My Leads': 'Mine' };

/**
 * Server-side paging (V.peoplePage.on): page x of y with prev/next under the
 * list. Loading and a failed read say so here, with the retry, so the rows
 * above can stay as they were (the hook keeps the previous page).
 */
function Pager({ pp, noun }: { pp: ClozrView['peoplePage']; noun: string }) {
  const n = (x: number) => x.toLocaleString('en-US');
  const from = pp.page * pp.pageSize + 1;
  const to = Math.min(pp.total, (pp.page + 1) * pp.pageSize);
  return (
    <nav aria-label="Pages" data-testid="people-pager" style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, fontSize: '12px', color: 'var(--muted, #52525b)', fontVariantNumeric: 'tabular-nums' }}>
      <button type="button" className="pp-icon is-ring" onClick={pp.prev} disabled={pp.page === 0 || pp.loading} aria-label="Previous page" title="Previous page">
        <ChevronLeft size={15} aria-hidden />
      </button>
      <span role="status" aria-live="polite" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {pp.error ? (
          <span style={{ color: '#b91c1c' }}>
            Page {n(pp.page + 1)} did not load ({pp.error}).{' '}
            <button type="button" className="pp-link" onClick={pp.refetch}>Try again</button>
          </span>
        ) : pp.loading ? (
          <>Loading page {n(pp.page + 1)}…</>
        ) : pp.total === 0 ? null : (
          <><span style={{ color: 'var(--ink, #18181b)', fontWeight: 600 }}>Page {n(pp.page + 1)} of {n(pp.pages)}</span> · {n(from)}–{n(to)} of {n(pp.total)} {noun}</>
        )}
      </span>
      <button type="button" className="pp-icon is-ring" onClick={pp.next} disabled={pp.page + 1 >= pp.pages || pp.loading} aria-label="Next page" title="Next page">
        <ChevronRight size={15} aria-hidden />
      </button>
    </nav>
  );
}

/**
 * "Select all N matching" when the list is server-paged: Ctrl+A and the
 * checkboxes only reach the page in the DOM, so this asks the server for every
 * id the filters match and reports how many it checked.
 */
function SelectAllMatching({ pp, selected, noun }: { pp: ClozrView['peoplePage']; selected: number; noun: string }) {
  const [state, setState] = useState<{ busy?: boolean; got?: number; error?: string }>({});
  if (pp.total <= pp.pageSize && !state.got) return null;
  const n = (x: number) => x.toLocaleString('en-US');
  const run = async () => {
    setState({ busy: true });
    try { setState({ got: await pp.selectAllMatching() }); }
    catch (e) { setState({ error: e instanceof Error ? e.message : 'The read failed' }); }
  };
  if (state.busy) return <span role="status" style={{ fontSize: '12px', color: 'var(--muted, #52525b)', whiteSpace: 'nowrap' }}>Selecting…</span>;
  if (state.error) {
    return (
      <span role="alert" style={{ fontSize: '12px', color: '#b91c1c', whiteSpace: 'nowrap' }}>
        Could not select every match ({state.error}). <button type="button" className="pp-link" onClick={run}>Try again</button>
      </span>
    );
  }
  if (state.got != null && selected >= state.got) {
    return <span role="status" data-testid="people-all-matching" style={{ fontSize: '12px', color: 'var(--muted, #52525b)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>All {n(state.got)} matching {noun} selected</span>;
  }
  return (
    <button type="button" className="pp-link" onClick={run} title="Check every row the filters match, on every page, not just this one" style={{ whiteSpace: 'nowrap' }}>
      Select all {n(pp.total)} matching
    </button>
  );
}

export function People({ V }: { V: ClozrView }) {
  // The rail lists one half at a time: the seller smart lists or the submission stages.
  const onLeads = V.peopleSide === 'leads';
  const [pinMenu, setPinMenu] = useState<{ label: string; x: number; y: number; pinned: boolean } | null>(null);
  // Manage: the rail shows drag, pin and delete; otherwise rows only open lists.
  const [manage, setManage] = useState(false);
  // Which column's header filter is open.
  const [colFilter, setColFilter] = useState<string | null>(null);
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
      address: f.address && (f.zip || (f.city && f.state)) ? { address: f.address, city: f.city ?? '', state: f.state ?? '', zip: (f.zip ?? '').slice(0, 5) } : null,
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
  // The rows get a stable callPhone (the view-model's is a new function on every rebuild), so the memo above holds.
  const callPhoneRef = useRef(V.callPhone);
  useEffect(() => { callPhoneRef.current = V.callPhone; });
  const callPhone = useCallback((phone: string) => callPhoneRef.current(phone), []);
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
  // A submission stage is empty until a partner sends a house or a vendor list is imported; say that, not "add a lead".
  // No button of its own: Import in the header already takes a vendor's list here.
  const empty = onLeads
    ? { title: 'No leads in this list', hint: 'Leads land here from Deal Machine and Talkr, or you can add one with Quick Add.' }
    : { title: 'No submissions at this stage', hint: 'Houses land here when a partner submits one, or use Import to bring in a vendor’s list.' };
  const sel = V.selectionCount > 0;
  const iconActions = (V.massActions || []).filter((a) => ICON_SET.has(a.label));
  const menuActions = [
    ...(V.massActions || []).filter((a) => !ICON_SET.has(a.label)).map((a) => ({
      key: a.label, label: a.label, group: MENU_GROUP[a.label] ?? 'More', run: a.go,
    })),
    ...(campaignSellers.length ? [{ key: 'talkr-campaign', label: 'Send to Talkr campaign', group: 'Reach out', note: 'every good number', run: () => setToCampaign(true) }] : []),
    ...(traceRecords.length ? [{ key: 'trace', label: 'Skip trace', group: 'Data', note: 'find phones & emails', run: () => { setTracing(true); setAgentPanel(false); } }] : []),
    ...(agentIds.length ? [{ key: 'text-sequence', label: 'Automated texts', group: 'Reach out', note: 'enroll in a Talkr sequence', run: () => { setSeqPanel(true); setTracing(false); setAgentPanel(false); } }] : []),
  ].sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group));
  const title = V.peopleList === 'Last import' && V.lastImportLabel ? V.lastImportLabel : RAIL_LABEL[V.peopleList] ?? V.peopleList;
  const count = V.isVendorList ? V.vendorCount : V.peopleCount;
  // Server-side paging: one page of rows at a time; off, the whole list is in memory and useReveal pages the DOM.
  const pp = V.peoplePage;
  const paged = !!pp?.on;
  const noun = V.isVendorList ? 'vendors' : (V.listNoun || 'people');
  const savedGroups = Array.from(new Set((V.savedListRows || []).map((l) => l.group)));
  const savedList = (l: ClozrView['savedListRows'][number]) => (
    <div key={l.id} className="pp-rail-item">
      <RailBtn label={l.label} count={l.count} on={l.weight === 600} go={l.go} icon={<Bookmark size={13} aria-hidden />} title={`${l.label} · ${l.accessLabel}`} />
      {manage && l.canRemove ? <SavedListDelete name={l.label} onDelete={l.remove} /> : null}
    </div>
  );
  return (
    <section data-screen-label="People" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: V.isMobile ? "column" : "row"}}>
      {(!V.isMobile && railOpen) ? (
      <aside className="pp-rail" aria-label="Lists">
        <div className="pp-rail-head">
          <span className="pp-rail-title"><Users size={14} aria-hidden />People</span>
          <RailToggle open onToggle={toggleRail} />
        </div>
        <div className="pp-rail-body">
          {V.peopleSideSwitch ? <div style={{ padding: '0 2px 8px' }}><PeopleSideSwitch V={V} /></div> : null}
          {onLeads ? (
            <>
              {(V.customLists || []).filter((l) => l.label === 'Sellers').map((l) => (
                <RailBtn key={l.label} label="All people" count={l.count} on={l.weight === 600} go={l.go} icon={<Users size={13} aria-hidden />} />
              ))}
              {(V.operationalLists || []).filter((l) => l.label === 'My Leads').map((l) => (
                <RailBtn key={l.label} label="Mine" count={l.count} on={l.weight === 600} go={l.go} icon={<UserCheck size={13} aria-hidden />} />
              ))}
              <div className="pp-rail-h">Smart lists <SaveListButton V={V} /></div>
              {(V.operationalLists || []).filter((l) => l.label !== 'My Leads').map((l) => (
                <RailBtn key={l.label} label={l.label} count={l.count} on={l.weight === 600} go={l.go} pinned={l.pinned} over={dragOver === l.label}
                  icon={<Mark label={l.label} />}
                  title={manage ? (l.pinned ? 'Pinned · drag to reorder · right-click to unpin' : 'Drag to reorder · right-click to pin') : undefined}
                  drag={manage ? {
                    draggable: true,
                    onDragStart: (e) => { e.dataTransfer.setData('text/plain', l.label); e.dataTransfer.effectAllowed = 'move'; },
                    onDragOver: (e) => { e.preventDefault(); setDragOver(l.label); },
                    onDragLeave: () => setDragOver((cur) => cur === l.label ? null : cur),
                    onDrop: (e) => { e.preventDefault(); setDragOver(null); const from = e.dataTransfer.getData('text/plain'); if (from) V.dropSmartList(from, l.label); },
                    onContextMenu: (e) => { e.preventDefault(); setPinMenu({ label: l.label, x: e.clientX, y: e.clientY, pinned: !!l.pinned }); },
                  } : undefined} />
              ))}
            </>
          ) : null}
          {(!onLeads && (V.submissionNav || []).length) ? (V.submissionNav || []).map((g, g__i) => (
            <React.Fragment key={g__i}>
              <div className="pp-rail-h" style={{ marginTop: g__i ? '10px' : 0 }}>{g.label}<span className="pp-rail-count">{g.count.toLocaleString('en-US')}</span></div>
              {(g.children || []).map((c) => (
                <RailBtn key={c.label} label={c.label} count={c.count} on={c.weight === 600} go={c.go} icon={<Mark label={c.label} />} />
              ))}
            </React.Fragment>
          )) : null}
          {/* Saved lists filter sellers: under Leads, or under Submissions for Partnerships, who has no Leads. */}
          {((onLeads && V.hasSavedLists) || !V.peopleSideSwitch) ? (
            <>
              {savedGroups.filter(Boolean).map((g) => (
                <React.Fragment key={g}>
                  <div className="pp-rail-h">{g}</div>
                  {(V.savedListRows || []).filter((l) => l.group === g).map(savedList)}
                </React.Fragment>
              ))}
              {(savedGroups.includes('') || !V.peopleSideSwitch) ? (
                <div className="pp-rail-h">Saved lists{!V.peopleSideSwitch ? <SaveListButton V={V} /> : null}</div>
              ) : null}
              {(V.savedListRows || []).filter((l) => !l.group).map(savedList)}
            </>
          ) : null}
          <div className="pp-rail-h">Other lists</div>
          {(V.customLists || []).filter((l) => !(onLeads && l.label === 'Sellers')).map((l) => (
            <RailBtn key={l.label} label={l.label} count={l.count} on={l.weight === 600} go={l.go} disabled={l.disabled} title={l.title || undefined}
              icon={<span aria-hidden style={{ width: '8px', height: '8px', borderRadius: '999px', background: l.disabled ? 'var(--divider, #e4e4e7)' : typeTone(l.label).fg, display: 'block' }} />} />
          ))}
          {manage && onLeads ? <div style={{ margin: '12px 6px 0', fontSize: '11.5px', color: 'var(--muted, #52525b)', lineHeight: 1.5 }}>Drag a smart list to reorder it, right-click to pin it. Saved lists delete from their ×.</div> : null}
        </div>
        <div className="pp-rail-foot">
          <button type="button" className="pp-rail-row" aria-pressed={manage} onClick={() => setManage(!manage)} title="Reorder, pin and delete lists" style={{ flex: 1 }}>
            <span className="pp-rail-ic" aria-hidden><Settings2 size={13} /></span>
            <span className="pp-rail-label">{manage ? 'Done' : 'Manage'}</span>
          </button>
          {!V.isVendorList ? <PeopleColumns compact align="left" all={V.peopleColDefs} value={V.peopleColKeys} onChange={V.setPeopleCols} defaults={V.peopleColDefaults} /> : null}
        </div>
        {pinMenu ? (
          <>
          <div onClick={() => setPinMenu(null)} style={{position: "fixed", inset: 0, zIndex: 80}} />
          <div role="menu" style={{position: "fixed", top: pinMenu.y, left: pinMenu.x, zIndex: 81, minWidth: "160px", background: "var(--surface, #fff)", borderRadius: "10px", boxShadow: "var(--shadow-md)", padding: "4px"}}>
            <button type="button" role="menuitem" className="dc2" onClick={() => { V.pinSmartList(pinMenu.label); setPinMenu(null); }}
              style={{display: "block", width: "100%", textAlign: "left", border: 0, background: "none", padding: "8px 10px", borderRadius: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 600, color: 'var(--ink, #18181b)'}}>
              {pinMenu.pinned ? 'Unpin ' : 'Pin '}{pinMenu.label}
            </button>
          </div>
          </>
        ) : null}
      </aside>
      ) : null}
      <div style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
        {/* Two rows: the title, count and the primary buttons; then the mass actions, quick filters and view controls. */}
        <div style={{display: V.isMobile ? "none" : "block", position: "relative", zIndex: 3, borderBottom: "1px solid var(--divider, #e4e4e7)", background: "var(--surface, #fff)"}}>
        <div style={{display: "flex", alignItems: "center", gap: "10px", padding: "10px 16px 6px"}}>
          {!railOpen ? <RailToggle open={false} onToggle={toggleRail} /> : null}
          {/* The rail carries Leads | Submissions; with it hidden the switch moves up here. */}
          {!railOpen && V.peopleSideSwitch ? <div style={{flex: "none", width: "236px"}}><PeopleSideSwitch V={V} /></div> : null}
          <h1 style={{margin: "0", fontSize: "15px", fontWeight: 700, letterSpacing: "-0.015em", whiteSpace: "nowrap", color: 'var(--ink, #18181b)'}}>
            {title}
          </h1>
          <span role="status" style={{fontSize: "12px", color: "var(--muted, #52525b)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums"}}>
            Showing {count.toLocaleString('en-US')} {noun}{V.crmPartial && !V.isVendorList ? ' so far · loading the rest…' : ''}
          </span>
          {V.podioOnlyNote ? <span data-testid="podio-only-note" style={{fontSize: "12px", color: "var(--muted, #52525b)", whiteSpace: "nowrap"}}>{V.podioOnlyNote}</span> : null}
          {V.subPartnerChip ? (
            <span data-testid="sub-partner-chip" style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "26px", padding: "0 4px 0 10px", borderRadius: "999px", background: "#eff6ff", border: "1px solid #bfdbfe", fontSize: "12px", fontWeight: 600, color: "#1d4ed8", whiteSpace: "nowrap"}}>
              <button type="button" onClick={V.subPartnerChip.open} title="Open the partner's own record" style={{border: 0, background: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer"}}>{V.subPartnerChip.label}</button>
              <button type="button" onClick={V.subPartnerChip.clear} aria-label="Show every partner's submissions" style={{width: "20px", height: "20px", borderRadius: "50%", border: 0, background: "#dbeafe", color: "#1d4ed8", cursor: "pointer", lineHeight: 1, display: 'grid', placeItems: 'center'}}><X size={11} aria-hidden /></button>
            </span>
          ) : null}
          <div style={{flex: "1"}}></div>
          <div style={{display: "flex", alignItems: "center", gap: "8px", height: "32px", padding: "0 10px", borderRadius: "8px", background: "var(--surface, #fff)", boxShadow: 'var(--shadow-ring)', width: "220px"}}>
            <Search size={14} aria-hidden style={{ color: 'var(--muted, #52525b)', flex: 'none' }} />
            <input value={peopleQText} onChange={(e) => setPeopleQText(e.target.value)} placeholder="Search this list" aria-label="Search this list" style={{border: "0", background: "none", outline: "0", fontSize: "13px", width: "100%", color: "var(--ink, #18181b)"}} />
          </div>
          {!V.isVendorList ? <ContractsButton V={V} /> : null}
          <button className="dc10" onClick={() => V.openImport(V.peopleImportKind)} title={V.peopleImportKind === 'submissions' ? 'Import a vendor’s list of submissions (Excel, CSV or a Google Sheet)' : V.isVendorList ? 'Bulk import vendors from a file, a Google Sheet or a paste' : 'Bulk import sellers from a file, a Google Sheet or a paste'} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px"}}>
            <Upload size={13} aria-hidden />
            Import
          </button>
          {/* One filled button per view: Import carries the fill. */}
          <SaveListButton V={V} label="New list" />
        </div>
        <div style={{display: "flex", alignItems: "center", gap: "8px", padding: "0 16px 8px", flexWrap: "wrap"}}>
          {/* Mass actions, greyed until a row is checked, the way Follow Up Boss's header row works. */}
          <div role="toolbar" aria-label="Mass actions" style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
            {sel ? (
              <>
                <span role="status" style={{fontSize: "12.5px", fontWeight: 600, color: "var(--c-accent-2, #08694C)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", marginRight: '4px'}}>{V.selectionCount} selected</span>
                <button type="button" className="pp-link" onClick={V.clearSelection} style={{ marginRight: '8px' }}>Clear</button>
              </>
            ) : null}
            {ICON_ACTIONS.filter(([l]) => iconActions.some((a) => a.label === l)).map(([label, icon]) => {
              const a = iconActions.find((x) => x.label === label)!;
              return (
                <button key={label} type="button" className="pp-icon" disabled={!sel} onClick={a.go} aria-pressed={a.active || undefined}
                  aria-label={label} title={sel ? label : `${label}: check a row first`} style={label === 'Archive' && sel ? { color: '#b91c1c' } : undefined}>
                  {icon}
                </button>
              );
            })}
            {agentIds.length ? (
              <button type="button" className="pp-icon" onClick={() => { setAgentPanel(!agentPanel); setTracing(false); }} aria-pressed={agentPanel} aria-label="AI agent" title="Switch an AI agent on or off for the selected sellers">
                <Sparkles size={15} aria-hidden />
              </button>
            ) : null}
            {sel ? <ActionsMenu actions={menuActions} label="More" /> : null}
            {sel ? <span style={{ marginLeft: '6px' }}><SelectCount listCount={V.peopleAssign.listCount} ownerAware={!V.isVendorList} onSelect={(n, unassigned) => V.selectFirstPeople(n, unassigned)} /></span> : null}
            {sel && paged ? <span style={{ marginLeft: '8px' }}><SelectAllMatching pp={pp} selected={V.selectionCount} noun={noun} /></span> : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
          {!V.isVendorList ? <PeopleViews V={V} /> : null}
          {!V.isVendorList ? <PeopleColumns all={V.peopleColDefs} value={V.peopleColKeys} onChange={V.setPeopleCols} defaults={V.peopleColDefaults} /> : null}
          {V.isVendorList ? (
            <div role="tablist" aria-label="Vendor view" style={segWrap}>
              {(V.vendorViewToggle || []).map((t) => (
                <button key={t.label} type="button" role="tab" aria-selected={t.on} onClick={t.go} style={seg(t.on)}>{t.label}</button>
              ))}
            </div>
          ) : null}
          {!V.isVendorList ? <ScopeMenu V={V} /> : null}
          <FilterPanel
            menus={(V.peopleFilterMenus || []).filter((f) => f.key !== 'sort')}
            active={V.activeFilterCount}
            onReset={V.clearFilters}
            onClose={V.closeFilterMenus}
            moreActive={V.isVendorList ? 0 : V.peopleMore.active}
            showLabel={`Show ${count.toLocaleString('en-US')} ${noun}`}>
            {!V.isVendorList ? <MoreFiltersFields V={V} /> : null}
          </FilterPanel>
          </div>
        </div>
        <div style={{display: "flex", alignItems: "center", gap: "8px", padding: "0 16px 8px", flexWrap: "wrap"}}>
          <QuickChips V={V} />
          {(V.peopleFilterMenus || []).filter((f) => f.key === 'sort').map((f) => (
            <div key={f.key} style={{position: "relative"}}>
              <button type="button" className={'pp-chip' + (f.on ? ' is-on' : '')} onClick={f.toggle} aria-haspopup="menu" aria-expanded={f.open} title="Sort this list" style={f.on ? { background: 'var(--c-accent-soft, #E7F8F1)', color: 'var(--c-accent-2, #08694C)', fontWeight: 600 } : undefined}>
                <ArrowDownUp size={13} aria-hidden />
                {f.on ? f.value : 'Sort'}
                <Chevron size={11} dir={f.open ? 'up' : 'down'} />
              </button>
              {f.open ? (
                <>
                <div onClick={V.closeFilterMenus} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
                <div ref={keepInView} role="menu" aria-label="Sort" className="cz-menu cz-menu--left" style={{top: "38px", left: "0", minWidth: "208px", maxHeight: "min(360px, 48vh)", overflow: "auto"}}>
                  {(f.options || []).map((o) => (
                    <button key={o.label} type="button" role="menuitemradio" aria-checked={o.on} className={"dc2 cz-menu-item" + (o.on ? " is-on" : "")} onClick={o.go}>
                      <span style={{ flex: 1 }}>{o.label}</span>
                      <MenuCheck on={o.on} />
                    </button>
                  ))}
                </div>
                </>
              ) : null}
            </div>
          ))}
          {(V.hasActiveFilters) ? (
            <button type="button" className="pp-link" onClick={V.clearFilters} style={{ height: '32px', padding: '0 4px' }}>
              Reset
            </button>
          ) : null}
        </div>
        </div>
        {(V.hasSelection) ? (
          <>
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
            <div style={{display: "flex", flexWrap: "wrap", alignItems: 'center', gap: "6px", padding: "8px 16px", background: "var(--surface, #fff)", borderBottom: "1px solid var(--divider, #e4e4e7)"}}>
              <span style={{fontSize: "11.5px", color: "var(--muted, #52525b)", fontWeight: 500, marginRight: "4px"}}>
                {V.bulkMenu === 'assign' ? 'Assign to' : V.bulkMenu === 'stage' ? 'Move to' : 'Enrol in'}
              </span>
              {(V.bulkMenuOptions || []).map((o, o__i) => (
                <button key={o__i} type="button" className="pp-chip" onClick={o.go}>{o.label}</button>
              ))}
              {(V.bulkMenuOptions || []).length === 0 ? <span style={{fontSize: "12px", color: "var(--muted, #52525b)"}}>Nothing to pick from yet</span> : null}
              <button type="button" className="pp-link" onClick={V.closeBulkMenu} style={{ color: 'var(--muted, #52525b)' }}>Cancel</button>
            </div>
          ) : null}
          </>
        ) : null}
        {(V.isMobile) ? (
          <>
          <div style={{flex: "none", background: "#fff", borderBottom: "1px solid #e4e4e7", padding: "10px 0 10px 10px"}}>
            {/* Name over count, so a long list name (New Submissions) truncates instead of pushing Import off the screen. */}
            <div style={{display: "flex", alignItems: "center", gap: "8px", padding: "0 10px 8px 2px"}}>
              <span style={{display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: "0 1 auto"}}>
                <span title={V.peopleList} style={{fontSize: "19px", fontWeight: "700", letterSpacing: "-0.03em", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                  {V.peopleList}
                </span>
                <span style={{fontSize: "12.5px", color: "#71717a", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums"}}>
                  {V.isVendorList ? V.vendorCount : V.peopleCount} {V.isVendorList ? 'vendors' : (V.listNoun || 'people')}{V.crmPartial && !V.isVendorList ? ' so far · loading…' : ''}
                </span>
              </span>
              {V.subPartnerChip ? (
                <span data-testid="sub-partner-chip" style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "26px", padding: "0 4px 0 10px", borderRadius: "999px", background: "#eff6ff", border: "1px solid #bfdbfe", fontSize: "12px", fontWeight: 600, color: "#1d4ed8", whiteSpace: "nowrap"}}>
                  <button type="button" onClick={V.subPartnerChip.open} title="Open the partner's own record" style={{border: 0, background: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer"}}>{V.subPartnerChip.label}</button>
                  <button type="button" onClick={V.subPartnerChip.clear} aria-label="Show every partner's submissions" style={{width: "20px", height: "20px", borderRadius: "50%", border: 0, background: "#dbeafe", color: "#1d4ed8", cursor: "pointer", lineHeight: 1, display: 'grid', placeItems: 'center'}}><X size={11} aria-hidden /></button>
                </span>
              ) : null}
              <span style={{flex: "1"}}></span>
              {!V.isVendorList ? <span style={{flex: "none"}}><ContractsButton V={V} /></span> : null}
              <button onClick={() => V.openImport(V.peopleImportKind)} style={{flex: "none", height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px", alignSelf: "center"}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                Import
              </button>
            </div>
            {V.peopleSideSwitch ? <div style={{margin: "0 10px 8px 0"}}><PeopleSideSwitch V={V} phone /></div> : null}
            {/* The desk header (and its search) is hidden on a phone, so the list gets its own. */}
            <div style={{display: "flex", alignItems: "center", gap: "8px", height: "36px", margin: "0 10px 8px 0", padding: "0 10px", border: "1px solid #e4e4e7", borderRadius: "9px", background: "#fafafa"}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input type="search" value={peopleQText} onChange={(e) => setPeopleQText(e.target.value)} placeholder="Search this list" aria-label="Search this list" style={{border: "0", background: "none", outline: "0", fontSize: "16px", width: "100%", minWidth: 0, color: "#18181b"}} />
            </div>
            <div style={{display: "flex", gap: "6px", overflowX: "auto", paddingRight: "10px", paddingBottom: "2px"}}>
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
                    <Chevron size={11} dir={f.open ? 'up' : 'down'} />
                  </button>
                  {f.open ? (
                    <>
                    <div onClick={V.closeFilterMenus} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
                    <div ref={keepInView} className="cz-menu cz-menu--left" style={{top: "38px", left: "0", minWidth: "208px", maxHeight: "min(360px, 48vh)", overflow: "auto"}}>
                      {(f.options || []).map((o, o__i) => (
                        <button key={o__i} type="button" className={"dc2 cz-menu-item" + (o.on ? " is-on" : "")} onClick={o.go}>
                          <span style={{ flex: 1 }}>{o.label}</span>
                          <MenuCheck on={o.on} />
                        </button>
                      ))}
                    </div>
                    </>
                  ) : null}
                </div>
              ))}
              <QuickChips V={V} tray />
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
        {(V.isMobile && !V.isVendorList) ? (
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
                  <span style={{display: "inline-flex", alignItems: "center", gap: "6px", height: "22px", padding: "0 8px", borderRadius: "6px", fontSize: "11.5px", fontWeight: 600, color: `color-mix(in srgb, ${p.stageColor} 55%, var(--ink, #18181b))`, background: `color-mix(in srgb, ${p.stageColor} 11%, var(--surface, #fff))`}}>
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
                  <span style={{fontSize: "12px", fontWeight: 600, color: p.tempColor}}>
                    {p.temp.charAt(0) + p.temp.slice(1).toLowerCase()}
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
              V.crmPartial || (paged && pp.loading) ? (
                <SkeletonRows count={4} label="Loading leads…" />
              ) : noMatch ? (
                <Empty compact title={onLeads ? 'No leads match' : 'No submissions match'} hint={noMatch.hint} action={noMatch.clear} actionLabel={noMatch.label} />
              ) : (
                // A phone showed a blank page here: no message, no Retry.
                <Empty compact title={empty.title} hint={empty.hint} failed={!V.crmOk} onRetry={V.reloadCrm} />
              )
            ) : null}
            {more && !paged ? (
              <button type="button" ref={sentinel} onClick={showMore} className="dc2" style={{width: "100%", height: "40px", borderRadius: "10px", border: "1px dashed #e4e4e7", background: "#fff", color: "#71717a", fontSize: "12.5px", cursor: "pointer", fontVariantNumeric: "tabular-nums"}}>
                {moreNote}
              </button>
            ) : null}
            {paged && allCards.length > 0 ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '10px', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '13px' }}>
                <Pager pp={pp} noun={noun} />
              </div>
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
        {(!V.isVendorList && !V.isMobile) ? (
        <div className="clozr-scroll-well" style={{flex: "1", minHeight: "0", overflow: "auto", background: "var(--page)", padding: "12px 16px 16px", scrollPadding: "48px 16px 16px"}}>
          <div style={{minWidth: "100%", width: "max-content", background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", overflow: "clip"}}>
          <table className="pp-table" aria-busy={paged && pp.loading ? true : undefined} style={{minWidth: `${Math.max(900, (V.peopleColumns || []).length * 118)}px`}}>
            <thead>
              <tr>
                <th style={{width: "36px"}}>
                  <input type="checkbox" onChange={V.toggleAll} checked={!!(V.allSelected)} aria-label="Select all" style={{width: "14px", height: "14px", accentColor: "var(--c-accent, #0A8560)", cursor: "pointer", display: 'block'}} />
                </th>
                {(V.peopleColumns || []).map((c) => {
                  const sortable = ['name', 'stage', 'score', 'created', 'lastComm', 'arv', 'offer', 'market', 'subs', 'props', 'stack'].includes(c.key);
                  const active = V.peopleSortColumn?.key === c.key;
                  const asc = V.peopleSortColumn?.dir === 'asc';
                  const filterOn = columnFilterOn(V, c.key);
                  return (
                  <th key={c.key} className={active ? 'is-sorted' : undefined} aria-sort={active ? (asc ? 'ascending' : 'descending') : undefined}>
                    <span className="pp-th" style={{ position: 'relative' }}>
                      {sortable ? (
                        <button type="button" className="pp-th-btn" onClick={() => V.sortPeopleColumn(c.key)} title={`Sort by ${c.label.toLowerCase()}`}>
                          {c.label}{active ? (asc ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />) : null}
                        </button>
                      ) : c.label}
                      {columnFilterable(V, c.key) ? (
                        <button type="button" className="pp-icon pp-th-filter" aria-pressed={filterOn} aria-haspopup="dialog" aria-expanded={colFilter === c.key}
                          aria-label={`Filter by ${c.label.toLowerCase()}`} title={`Filter by ${c.label.toLowerCase()}`} onClick={() => setColFilter(colFilter === c.key ? null : c.key)}>
                          <Filter size={12} aria-hidden />
                        </button>
                      ) : null}
                      {colFilter === c.key ? <ColumnFilter V={V} col={c} q={peopleQText} setQ={setPeopleQText} onClose={() => setColFilter(null)} /> : null}
                    </span>
                  </th>
                  );
                })}
                <th className="pp-quick" aria-label="Quick actions"></th>
              </tr>
            </thead>
            <tbody>
              {allRows.slice(0, revealed).map((p) => (
                <PeopleRow key={p.id} p={p} callPhone={callPhone} />
              ))}
              {more && !paged ? (
                <tr ref={sentinel}>
                  <td colSpan={(V.peopleColumns || []).length + 2} style={{padding: "0"}}>
                    <button type="button" onClick={showMore} className="dc2" style={{width: "100%", height: "40px", border: 0, background: "var(--surface-2, #f4f4f5)", color: "var(--muted, #52525b)", fontSize: "12px", cursor: "pointer", fontVariantNumeric: "tabular-nums"}}>
                      {moreNote}
                    </button>
                  </td>
                </tr>
              ) : null}
              {allRows.length === 0 ? (
                V.crmPartial || (paged && pp.loading) ? (
                  <tr><td colSpan={(V.peopleColumns || []).length + 2} style={{ padding: 0 }}><SkeletonRows count={6} label="Loading leads…" /></td></tr>
                ) : noMatch ? (
                  <EmptyRow colSpan={(V.peopleColumns || []).length + 2} title={onLeads ? 'No leads match' : 'No submissions match'} hint={noMatch.hint} action={noMatch.clear} actionLabel={noMatch.label} />
                ) : (
                  <EmptyRow
                    colSpan={(V.peopleColumns || []).length + 2}
                    title={empty.title}
                    hint={empty.hint}
                    failed={!V.crmOk}
                    onRetry={V.reloadCrm}
                  />
                )
              ) : null}
            </tbody>
          </table>
          </div>
        </div>
        ) : null}
        {V.isVendorList ? null : (
          // The right padding clears the shell's floating buttons (20px inset, 44px
          // wide), which otherwise sit on top of Blacklist at every desk width.
          <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16, padding: V.isMobile ? '10px 16px' : '10px 80px 10px 16px', borderTop: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)' }}>
            {paged && !V.isMobile ? <Pager pp={pp} noun={noun} /> : null}
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
