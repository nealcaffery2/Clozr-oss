'use client';

// The deal page's blocks (Settings › Try new design, desktop): the hero with
// the house and the toolbar, Key Numbers, Property Details beside Deal Info,
// the summary feed (Activity, Notes, Tasks, Files), and the right rail of
// Photos, Comps & Valuation and Files & Documents. SellerRecord.tsx lays
// them out; "View all" there swaps the summary feed for the full tabs and
// the composer.

import React, { useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { RepPicker } from '@/components/ds/RepPicker';
import { PropertyPhoto } from '@/components/PropertyPhoto';
import { UserAvatar } from '@/components/UserAvatar';
import { Icon } from '@/app/components/talkr/Icon';
import { CheckSquare, ChevronDown, Copy, ExternalLink, MessageSquare, Pencil, Phone } from 'lucide-react';
import { Mark } from '@/components/ds/mark';
import { factValue } from './PropertyCard';
import { parseMoney } from './record-logic';
import { MoreMenu, type MoreItem } from './MoreMenu';
import { FilesBlock } from './RecordBlocks';

const money = (n: number | null | undefined) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
const has = (v: string | null | undefined) => !!v && !!v.trim() && v.trim() !== '—';

/** Every stage the record can move to, grouped the way the stage picker groups them. */
function stageGroups(V: ClozrView) {
  return V.stageSelect ? V.stageSelect.groups : [{ label: 'Stages', options: V.stageOptions.map((o) => o.label) }];
}

/** The stage as a select. `pill`: the hero's tinted chip; else Deal Info's boxed row with a dot. */
export function StageSelect({ V, pill, selectRef }: { V: ClozrView; pill?: boolean; selectRef?: React.Ref<HTMLSelectElement> }) {
  const move = (label: string) => V.stageOptions.find((o) => o.label === label)?.go();
  return (
    <span className={pill ? 'rec3-stage-pill' : 'rec3-box rec3-stage-box'} style={{ '--stage': V.P.stageColor } as React.CSSProperties}>
      {pill ? null : <span aria-hidden className="rec3-dot" />}
      <span className="rec3-select-text">{V.P.stage}</span>
      <ChevronDown size={pill ? 15 : 14} aria-hidden className="rec3-chev" />
      <select ref={selectRef} aria-label={`Stage: ${V.P.stage}. Move to a stage`} title={V.recordReadOnly || 'Move to a stage (S)'} value={V.P.stage}
        disabled={!!V.recordReadOnly} onChange={(e) => { if (e.target.value !== V.P.stage) move(e.target.value); }}>
        {stageGroups(V).some((g) => g.options.includes(V.P.stage)) ? null : <option value={V.P.stage}>{V.P.stage}</option>}
        {stageGroups(V).map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </optgroup>
        ))}
      </select>
    </span>
  );
}

/** Photo, address, the house in one line, its source; the stage and the toolbar on the right. */
export function DealHero({ V, moreItems, onText, stageRef }: { V: ClozrView; moreItems: MoreItem[]; onText: () => void; stageRef?: React.Ref<HTMLSelectElement> }) {
  const f = (k: string) => factValue(V.propFacts, k);
  const beds = f('Beds'), baths = f('Baths');
  const facts = [
    V.P.cityLine.replace(/^[\s,]+|[\s,]+$/g, ''),
    beds !== '—' || baths !== '—' ? `${beds !== '—' ? beds : '?'} bed ${baths !== '—' ? baths : '?'} bath` : '',
    f('Sqft') !== '—' ? `${f('Sqft')} sqft` : '',
    f('Year') !== '—' ? `Built ${f('Year')}` : '',
    f('Type') !== '—' ? f('Type') : '',
  ].filter((x) => x && x !== ',');
  const photo = V.P.photos[0] || '';
  return (
    <div className="rec3-hero">
      <button type="button" className="rec3-thumb rec-press" onClick={() => (V.P.photos.length ? V.openPhotoShow(V.P.addr, V.P.photos, V.P.dealDbId) : V.P.lookups[0]?.go())}
        aria-label={V.P.photos.length ? `View photos of ${V.P.addr}` : `Open Street View of ${V.P.addr}`}>
        {V.ready ? <PropertyPhoto photo={photo} street={V.P.streetSafe || V.P.imgSafe} alt="" eager /> : null}
      </button>
      <div className="rec3-hero-text">
        <div className="rec3-hero-title">
          <h1 title={V.P.addr}>{V.P.addr}</h1>
          {V.canEditAddress ? (
            <button type="button" className="rec3-icon-btn rec-press" onClick={V.editAddress} aria-label={V.hasAddress ? 'Edit address' : 'Set address'} title={V.hasAddress ? 'Edit address' : 'Set address'}>
              <Pencil size={16} aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="rec3-hero-facts">
          {facts.map((x, i) => <React.Fragment key={i}>{i ? <span aria-hidden className="rec3-sep">·</span> : null}<span>{x}</span></React.Fragment>)}
          {has(V.P.source) ? <span className="rec3-source">Source: {V.P.source}</span> : null}
        </div>
      </div>
      <div className="rec3-actions" role="toolbar" aria-label={'Act on ' + V.P.addr}>
        <StageSelect V={V} pill selectRef={stageRef} />
        {V.comprLinked ? (
          <button type="button" data-testid="open-in-compr" className="rec3-btn rec-press" onClick={V.openCompr} title="The COMPR report in its own window">
            Open in COMPR <ExternalLink size={15} aria-hidden />
          </button>
        ) : (
          <button type="button" data-testid="run-compr" className="rec3-btn rec-press" onClick={V.runCompr} disabled={V.comprRunning} aria-busy={V.comprRunning || undefined}
            title="Underwrites this house in COMPR. ARV, rehab and MAO fill in.">
            {V.comprRunning ? 'Running COMPR…' : 'Run COMPR'} <ExternalLink size={15} aria-hidden />
          </button>
        )}
        <button type="button" className="rec3-btn rec3-btn-call rec-press" onClick={V.callPerson} title="Call (C)">
          <Phone size={16} aria-hidden /> Call
        </button>
        <button type="button" className="rec3-btn rec-press" onClick={onText} title="Text (T)">
          <MessageSquare size={16} aria-hidden /> Text
        </button>
        <span className="rec3-more"><MoreMenu items={moreItems} /></span>
      </div>
    </div>
  );
}

function CardHead({ title, action }: { title: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rec3-card-head">
      <h2 className="rec3-title">{title}</h2>
      {action}
    </div>
  );
}

/** Asking, ARV, rehab, MAO and the spread (MAO over asking), in one strip. */
export function KeyNumbersCard({ V, onEdit }: { V: ClozrView; onEdit: () => void }) {
  const o = V.offerCard;
  const asking = parseMoney(V.P.asking || '');
  const spread = asking != null && o.mao != null ? o.mao - asking : null;
  const cells = [
    { k: 'Asking Price', v: money(asking) },
    { k: 'ARV', v: o.arvLabel },
    { k: 'Est. Rehab', v: o.rehabLabel },
    { k: 'Max Allowable Offer', v: o.maoLabel },
    { k: 'Est. Spread', v: money(spread), tone: spread == null ? undefined : spread >= 0 ? 'var(--tx-green, #15803d)' : 'var(--tx-red, #b91c1c)', hint: 'MAO minus asking' },
  ];
  return (
    <section aria-labelledby="rec3-num-title" className="rec3-card" data-testid="key-numbers">
      <CardHead title={<span id="rec3-num-title">Key Numbers</span>} action={<button type="button" className="rec3-link rec-press" aria-label="Edit key numbers" onClick={onEdit}>Edit</button>} />
      <div className="rec3-numbers">
        {cells.map((c) => (
          <div key={c.k} className="rec3-number" title={c.hint}>
            <div className="rec3-label">{c.k}</div>
            <div className="rec3-num rec-money" style={{ color: c.v === '—' ? 'var(--ink, #18181b)' : c.tone }}>{c.v}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="rec3-row">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The house as label and value rows. Edit opens the Details tab, where every field edits in place. */
export function PropertyDetailsCard({ V, onEdit }: { V: ClozrView; onEdit: () => void }) {
  const f = (k: string) => factValue(V.propFacts, k);
  const addr = [V.P.addr, V.P.cityLine.replace(/^[\s,]+|[\s,]+$/g, '')].filter(has).join(', ');
  const plain = (v: string | null | undefined) => (has(v) ? v : '—');
  const copy = () => {
    void navigator.clipboard?.writeText(addr).then(() => V.showToast('Address copied'), () => V.showToast('Could not copy the address'));
  };
  return (
    <section aria-labelledby="rec3-prop-title" className="rec3-card" data-testid="property-details">
      <CardHead title={<span id="rec3-prop-title">Property Details</span>} action={<button type="button" className="rec3-link rec-press" aria-label="Edit property details" onClick={onEdit}>Edit</button>} />
      <dl className="rec3-list">
        <Row k="Address">
          <span className="rec3-addr">
            <span title={addr}>{addr || '—'}</span>
            {addr ? <button type="button" className="rec3-icon-btn rec3-icon-sm rec-press" onClick={copy} aria-label="Copy address" title="Copy address"><Copy size={14} aria-hidden /></button> : null}
          </span>
        </Row>
        <Row k="Beds / Baths">{f('Beds') === '—' && f('Baths') === '—' ? '—' : `${f('Beds')} / ${f('Baths')}`}</Row>
        <Row k="Square Feet"><span className="rec-money">{f('Sqft')}</span></Row>
        <Row k="Year Built"><span className="rec-money">{f('Year')}</span></Row>
        <Row k="Lot Size">{f('Lot')}</Row>
        <Row k="Property Type">{f('Type')}</Row>
        <Row k="APN"><span className="rec-money">{plain(V.P.apn)}</span></Row>
        <Row k="Occupancy">{plain(V.P.occupancy)}</Row>
        <Row k="Condition">{plain(V.P.condition)}</Row>
        <Row k="Motivation">{plain(V.P.motivation)}</Row>
      </dl>
    </section>
  );
}

/** "Submitted Oct 5, 2026" to "Sep 30, 2026 (5 days ago)". */
function submittedLine(recordDate: string | null | undefined) {
  if (!recordDate) return '—';
  const day = recordDate.replace(/^(Submitted|Added)\s+/, '');
  const t = Date.parse(day);
  if (!Number.isFinite(t)) return day;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return `${day} (${days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`})`;
}

/** Who the seller is, the stage, the deal type, who works it, when it came in and the next action. */
export function DealInfoCard({ V, onEdit }: { V: ClozrView; onEdit: () => void }) {
  return (
    <section aria-labelledby="rec3-deal-title" className="rec3-card" data-testid="deal-info">
      <CardHead title={<span id="rec3-deal-title">Deal Info</span>} action={<button type="button" className="rec3-link rec-press" aria-label="Edit deal info" onClick={onEdit}>Edit</button>} />
      <dl className="rec3-list rec3-info">
        <Row k="Seller"><span className="rec3-plain" title={V.P.name}>{V.P.name}</span></Row>
        <Row k="Stage"><StageSelect V={V} /></Row>
        <Row k="Deal Type">
          {V.can.dealSheet ? (
            <button type="button" className="rec3-box rec-press" onClick={() => V.openDealSheet()} title="Set the deal type on the deal sheet">
              <span className="rec3-select-text">{V.P.dealType || 'Not set'}</span><ChevronDown size={14} aria-hidden className="rec3-chev" />
            </button>
          ) : <span className="rec3-plain">{V.P.dealType || 'Not set'}</span>}
        </Row>
        <Row k="Assigned To">
          <span className="rec3-picker">
            <RepPicker label="Assigned to" showLabel={false} team={V.team} roles={['acq']} value={V.P.assignedId || null} noneLabel="Unassigned"
              onChange={(id) => V.P.assignTo(id ?? '')} readOnlyReason={V.recordReadOnly} />
          </span>
        </Row>
        <Row k="Underwriter">
          <span className="rec3-picker">
            <RepPicker label="Underwriter" showLabel={false} team={V.team} roles={['underwriter']} value={V.P.underwriterId || null} noneLabel="Nobody"
              onChange={(id) => V.P.underwriterTo(id ?? '')} readOnlyReason={V.recordReadOnly} />
          </span>
        </Row>
        <Row k="Submitted"><span className="rec3-plain">{submittedLine(V.recordDate)}</span></Row>
        <Row k="Last Touch"><span className="rec3-plain">{has(V.lastTouch) ? V.lastTouch : '—'}</span></Row>
        <Row k="Next Action"><NextAction V={V} /></Row>
      </dl>
    </section>
  );
}

function NextAction({ V }: { V: ClozrView }) {
  const [menu, setMenu] = useState(false);
  const late = V.hasNextTask && V.nextTaskOverdue;
  if (!V.hasNextTask) {
    return (
      <div className="rec3-next" data-testid="next-action">
        <div className="rec3-next-title" style={{ color: 'var(--meta, #71717a)' }}>No task scheduled</div>
        <button type="button" className="rec3-btn rec-press" onClick={V.scheduleNext} style={{ marginTop: 10, height: 36 }}>Schedule next action</button>
      </div>
    );
  }
  return (
    <div className={'rec3-next' + (late ? ' rec3-next-late' : '')} data-testid="next-action">
      <div className="rec3-next-title">{V.nextTaskLabel}</div>
      <div className="rec3-next-meta">
        {late ? <span className="rec3-late">Overdue</span> : null}
        {late && V.nextTaskDue && !/overdue/i.test(V.nextTaskDue) ? ' · ' : null}
        {V.nextTaskDue && !/overdue/i.test(V.nextTaskDue) ? V.nextTaskDue : null}
        {V.nextTaskDue || late ? ' · ' : null}Assigned to {V.nextTaskAssignee}
      </div>
      {V.nextIsComprReport ? (
        <button type="button" className="rec3-btn rec-press" onClick={V.sendNextReport} style={{ marginTop: 10, width: '100%', height: 36 }}>Send report</button>
      ) : null}
      <div className="rec3-next-acts">
        <button type="button" className="rec3-ink rec-press" onClick={V.completeNext}>Mark Complete</button>
        <span style={{ position: 'relative', display: 'flex' }}>
          <button type="button" className="rec3-ink-alt rec-press" aria-label="More for this task" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <ChevronDown size={16} aria-hidden />
          </button>
          {menu ? (
            <>
              <div onClick={() => setMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
              <div role="menu" className="rec3-menu">
                <button type="button" role="menuitem" className="cz-menu-item" onClick={() => { setMenu(false); V.rescheduleNext('tomorrow'); }}>Reschedule to tomorrow 9 AM</button>
                <button type="button" role="menuitem" className="cz-menu-item" onClick={() => { setMenu(false); V.scheduleNext(); }}>Schedule another task</button>
              </div>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

type FeedTab = 'Activity' | 'Notes' | 'Tasks' | 'Files';

/** When a feed row happened, in full: "Oct 11, 2026, 1:02 AM". */
function fullStamp(at: string | null | undefined) {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
}

/**
 * The summary feed: Activity and Notes as one line each, the open tasks, the
 * deal's files. View all opens the full tabs with the composer.
 */
export function SummaryFeed({ V, onViewAll }: { V: ClozrView; onViewAll: () => void }) {
  const [tab, setTab] = useState<FeedTab>(V.personTab === 'Notes' ? 'Notes' : 'Activity');
  const pick = (t: FeedTab) => {
    setTab(t);
    // The feed's rows filter on personTab (useClozr typeFilter).
    if (t === 'Activity' || t === 'Notes') V.setPersonTab(t);
  };
  const rows = (V.timelineItems || []).slice(0, 8);
  return (
    <section aria-label="Activity" className="rec3-card rec3-feed">
      <div className="rec3-feed-head">
        <div role="tablist" aria-label="Record feed" className="rec3-tabs">
          {(['Activity', 'Notes', 'Tasks', 'Files'] as const).map((t) => (
            <button key={t} type="button" role="tab" id={`rec3-tab-${t}`} aria-selected={tab === t} aria-controls="rec3-feed-panel" className="rec3-tab" onClick={() => pick(t)}>{t}</button>
          ))}
        </div>
        <button type="button" className="rec3-btn rec3-btn-sm rec-press" onClick={onViewAll} title="Every tab, with the composer">
          View all <ExternalLink size={13} aria-hidden />
        </button>
      </div>
      <div role="tabpanel" id="rec3-feed-panel" aria-labelledby={`rec3-tab-${tab}`}>
        {tab === 'Tasks' ? (
          <ul className="rec3-feed-list">
            {V.hasNextTask ? (
              <li className="rec3-feed-row">
                <span className="rec3-feed-icon" aria-hidden><CheckSquare size={16} /></span>
                <span className="rec3-feed-body"><span className="rec3-feed-title">{V.nextTaskLabel}</span><span className="rec3-feed-meta">{V.nextTaskDue} · {V.nextTaskAssignee}</span></span>
              </li>
            ) : null}
            {V.personTasks.map((t, i) => (
              <li key={i} className="rec3-feed-row">
                <input type="checkbox" checked={t.done} onChange={t.toggle} aria-label={`Done: ${t.title}`} className="rec3-check" />
                <span className="rec3-feed-body"><span className="rec3-feed-title" style={t.done ? { textDecoration: 'line-through', color: 'var(--meta, #71717a)' } : undefined}>{t.title}</span>{t.due ? <span className="rec3-feed-meta">{t.due}</span> : null}</span>
              </li>
            ))}
            {!V.hasNextTask && !V.personTasks.length ? <li className="rec3-feed-empty">No tasks on this record.</li> : null}
          </ul>
        ) : tab === 'Files' ? (
          <div style={{ padding: '4px 20px 20px' }}><FilesBlock V={V} compact hideTitle /></div>
        ) : (
          <ul className="rec3-feed-list">
            {rows.map((t) => {
              const stamp = fullStamp(t.at);
              return (
                <li key={t.id} className="rec3-feed-row">
                  {t.avatar ? <UserAvatar name={t.who} src={t.avatar} size={36} radius="999px" border="0" />
                    : <span className="rec3-feed-icon" aria-hidden style={{ color: t.color, background: `color-mix(in srgb, ${t.color} 12%, var(--surface, #fff))` }}>{t.icon ? <Icon name={t.icon} size={17} /> : <Mark label={t.chan} />}</span>}
                  <span className="rec3-feed-body">
                    <span className="rec3-feed-title">{t.title}</span>
                    <span className="rec3-feed-meta">{[stamp, `by ${t.actor || t.who}`].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="rec3-feed-time rec-money">{t.time}</span>
                </li>
              );
            })}
            {!rows.length ? <li className="rec3-feed-empty">{tab === 'Notes' ? 'No notes yet.' : 'No activity yet.'}</li> : null}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The cover photo and a strip of thumbnails, the last one counting the rest. */
export function PhotosCard({ V }: { V: ClozrView }) {
  const photos = V.P.photos;
  const show = (i: number) => V.openPhotoShow(V.P.addr, photos, V.P.dealDbId, i);
  const thumbs = photos.slice(1, 7);
  const extra = photos.length - 7;
  return (
    <section aria-labelledby="rec3-photos-title" className="rec3-card" data-testid="record-photos">
      <CardHead title={<span id="rec3-photos-title">Photos ({photos.length})</span>}
        action={photos.length ? <button type="button" className="rec3-link rec-press" onClick={() => show(0)}>View all</button> : <button type="button" className="rec3-link rec-press" onClick={V.openPhotos}>Add</button>} />
      <button type="button" className="rec3-cover rec-press" onClick={() => (photos.length ? show(0) : V.P.lookups[0]?.go())} aria-label={photos.length ? `View photos of ${V.P.addr}` : `Open Street View of ${V.P.addr}`}>
        {V.ready ? <PropertyPhoto photo={photos[0] || ''} street={V.P.streetSafe || V.P.imgSafe} alt={'Photo of ' + V.P.addr} eager /> : null}
      </button>
      {thumbs.length ? (
        <div className="rec3-thumbs">
          {thumbs.map((u, i) => {
            const last = i === thumbs.length - 1 && extra > 0;
            return (
              <button key={u + i} type="button" className="rec3-thumb-sm rec-press" onClick={() => show(i + 1)} aria-label={last ? `View ${extra + 1} more photos` : `View photo ${i + 2}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="" loading="lazy" decoding="async" />
                {last ? <span className="rec3-thumb-more">+{extra + 1}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/** Three comps with their photos, then ARV, the average $/sqft and the rehab. */
export function CompsCard({ V }: { V: ClozrView }) {
  const o = V.offerCard;
  const used = (V.comps || []).filter((c) => c.included);
  const top = (used.length ? used : V.comps || []).slice(0, 3);
  const avgPpsf = used.length ? Math.round(used.reduce((n, c) => n + c.ppsf, 0) / used.length) : null;
  return (
    <section aria-labelledby="rec3-comps-title" className="rec3-card" data-testid="record-comps">
      <CardHead title={<span id="rec3-comps-title">Comps &amp; Valuation</span>}
        action={(
          <button type="button" className="rec3-link rec-press rec3-link-icon" onClick={V.comprLinked ? V.openCompr : V.runCompr} disabled={!V.comprLinked && V.comprRunning}>
            <ExternalLink size={15} aria-hidden /> {V.comprLinked ? 'Open in COMPR' : V.comprRunning ? 'Running COMPR…' : 'Run COMPR'}
          </button>
        )} />
      {top.length ? (
        <div className="rec3-comps">
          {top.map((c) => (
            <div key={c.id} className="rec3-comp" title={c.addr}>
              <div className="rec3-comp-img">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {c.img ? <img src={c.img} alt={'Comp at ' + c.addr} loading="lazy" decoding="async" /> : null}
              </div>
              <div className="rec3-comp-price rec-money">{c.priceF}</div>
              <div className="rec3-comp-meta rec-money">{c.distF} · {c.sqftF} sqft</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="rec3-hint">{V.comprLinked ? 'The comps live in the COMPR report.' : 'COMPR has not run this house yet. One run pulls the comps and fills ARV, rehab and MAO.'}</p>
      )}
      <div className="rec3-vals">
        <div><div className="rec3-label">ARV</div><div className="rec3-val rec-money">{o.arvLabel}</div></div>
        <div><div className="rec3-label">Avg $/SF</div><div className="rec3-val rec-money">{avgPpsf != null ? '$' + avgPpsf : '—'}</div></div>
        <div><div className="rec3-label">Est. Rehab</div><div className="rec3-val rec-money">{o.rehabLabel}</div></div>
      </div>
    </section>
  );
}

/** The deal's documents (DealFiles), under the mockup's heading. */
export function FilesCard({ V, onViewAll }: { V: ClozrView; onViewAll: () => void }) {
  return (
    <section aria-labelledby="rec3-files-title" className="rec3-card" data-testid="record-files">
      <CardHead title={<span id="rec3-files-title">Files &amp; Documents</span>}
        action={<button type="button" className="rec3-link rec-press" onClick={onViewAll}>View all</button>} />
      <FilesBlock V={V} compact hideTitle />
    </section>
  );
}
