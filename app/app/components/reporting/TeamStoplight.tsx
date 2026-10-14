'use client';

// Reporting, Team stoplight (owners and admins): every teammate graded green,
// yellow or red against the team targets (lib/stoplight.ts), from what CLOZR
// logged. One RPC
// (team_stoplight, migration 260) per range. Click a teammate for what they
// are leaving undone, each item linked to its record. /demo shows a sample
// team so the screen is never blank.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { localIsoDay } from '@/lib/deal-close';
import {
  LANE_LABEL, STOPLIGHT_RANGES, TC_STALE_DAYS, acquisitionsCells, dispositionsCells, gapCells, laneOf, personLight, recordHref,
  stoplightRange, tcCells, tcFileGaps,
  type Cell, type Lane, type Light, type StoplightPayload, type StoplightPerson, type StoplightRange, type TcFileRow,
} from '@/lib/stoplight';
import { sampleStoplight } from '@/lib/stoplight-sample';

const INK = '#18181b';
const INK2 = '#3f3f46';
const MUTED = '#71717a';
const LINE = '#e4e4e7';
const HAIR = '#f0f0f1';
const ACCENT = '#0A8560';

/** Dot fill, text ink and the word each light reads as. Colour never carries it alone. */
const LIGHT: Record<Light, { dot: string; ink: string; bg: string; word: string }> = {
  green: { dot: '#0A8560', ink: '#0a6b4e', bg: '#E7F5EF', word: 'Green' },
  yellow: { dot: '#d97706', ink: '#b45309', bg: '#fef6e7', word: 'Yellow' },
  red: { dot: '#dc2626', ink: '#b91c1c', bg: '#fef2f2', word: 'Red' },
  none: { dot: 'transparent', ink: MUTED, bg: '#f4f4f5', word: 'No target set' },
};
const SEVERITY: Record<Light, number> = { red: 0, yellow: 1, green: 2, none: 3 };
const LANES: Lane[] = ['acquisitions', 'dispositions', 'tc', 'other'];

const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: 12 };

/** `targets` grades the numbers, `admin` the gaps; `light` is the worse of the two, for sorting and the count. */
type Row = { p: StoplightPerson; lane: Lane; cells: Cell[]; gaps: Cell[]; targets: Light; admin: Light; light: Light };
type Res = { key: string; data: StoplightPayload | null; error: string | null };

function errorText(e: { code?: string; message?: string } | null): string {
  if (!e) return 'The stoplight did not load. Reload the page to try again.';
  if (e.code === '42501') return 'Only an owner or admin can see the team stoplight.';
  if (e.code === 'PGRST202' || e.code === '42883') return 'The team_stoplight function is not in the database yet. It ships with migration 260 and applies when that change merges to main.';
  return `The stoplight did not load: ${e.message ?? 'unknown error'}. Reload the page to try again.`;
}

export function TeamStoplight({ workspaceId, isMobile }: { workspaceId: number | null; isMobile: boolean }) {
  const live = !!(workspaceId && supabase);
  const [range, setRange] = useState<StoplightRange>('This week');
  const [res, setRes] = useState<Res | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Bounds are fixed per range pick (and per mount), so a re-render never re-reads.
  const bounds = useMemo(() => stoplightRange(range), [range]);
  const key = `${workspaceId}:${range}`;

  useEffect(() => {
    if (!live) return;
    let gone = false;
    void (async () => {
      const { data, error } = await supabase!.rpc('team_stoplight' as never, {
        p_workspace: workspaceId, p_from: bounds.from.toISOString(), p_to: bounds.to.toISOString(), p_stale_days: TC_STALE_DAYS,
      } as never);
      if (gone) return;
      setRes({ key, data: error ? null : (data as unknown as StoplightPayload), error: error ? errorText(error) : null });
    })();
    return () => { gone = true; };
  }, [live, workspaceId, bounds, key]);

  const data = !live ? sampleStoplight(bounds.from, bounds.to, bounds.workdays) : res?.key === key ? res.data : null;
  const error = live && res?.key === key ? res.error : null;
  const today = localIsoDay();

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    return data.people.map((p) => {
      const lane = laneOf(p);
      const gaps = gapCells(p);
      const cells = lane === 'acquisitions' ? acquisitionsCells(p.metrics, bounds.workdays)
        : lane === 'dispositions' ? dispositionsCells(p.metrics, bounds.workdays)
          : lane === 'tc' ? tcCells(data.tc_files.filter((f) => f.tc_rep_id === p.user_id), today, p.gaps.overdue_unlinked, data.stale_days)
            : [];
      return { p, lane, cells, gaps, targets: personLight(cells, []), admin: personLight([], gaps), light: personLight(cells, gaps) };
    }).sort((a, b) => SEVERITY[a.light] - SEVERITY[b.light] || a.p.name.localeCompare(b.p.name));
  }, [data, bounds.workdays, today]);

  const counts = rows.reduce<Record<Light, number>>((t, r) => ({ ...t, [r.light]: t[r.light] + 1 }), { red: 0, yellow: 0, green: 0, none: 0 });
  const hasTc = rows.some((r) => r.lane === 'tc');
  const rangeLabel = range === 'This month' ? 'this month' : range === 'Last week' ? 'last week' : 'this week';

  return (
    <div data-stoplight style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: '-0.015em', color: INK }}>Team stoplight</h2>
          <p style={{ margin: '3px 0 0', fontSize: 12.5, color: MUTED, lineHeight: 1.45, maxWidth: '72ch' }}>
            Each teammate against the team targets, from what CLOZR logged {rangeLabel}
            {' '}({bounds.workdays} workday{bounds.workdays === 1 ? '' : 's'}). Monthly targets are scaled to those workdays.
            {live ? '' : ' Sample team: this is the demo workspace.'}
          </p>
        </div>
        <div role="radiogroup" aria-label="Range" style={{ display: 'flex', gap: 4 }}>
          {STOPLIGHT_RANGES.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={range === r} className="sl-chip" data-on={range === r ? '' : undefined}
              onClick={() => { setRange(r); setOpen(null); }}>
              {r}
            </button>
          ))}
        </div>
      </div>

      <Legend />

      {error ? <div role="alert" style={{ ...card, padding: '12px 14px', color: '#991b1b', background: '#fef2f2', borderColor: '#fecaca', fontSize: 12.5 }}>{error}</div> : null}
      {!data && !error ? (
        <div style={{ ...card, padding: 14 }} aria-busy="true">
          <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 10 }} role="status">Loading the team stoplight…</div>
          {[0, 1, 2, 3].map((i) => <div key={i} className="sl-skel" style={{ height: 34, marginBottom: 8, width: `${92 - i * 9}%` }} />)}
        </div>
      ) : null}
      {data && !rows.length ? (
        <div style={{ ...card, padding: 22 }}>
          <div style={{ fontSize: 13.5, fontWeight: 650, color: INK }}>No teammates to grade</div>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: MUTED }}>Invite the team in Settings, Team. Acquisitions and Dispositions roles are graded against their targets; everyone else is checked for overdue tasks and untouched leads.</p>
        </div>
      ) : null}

      {data && rows.length ? (
        <>
          <p role="status" style={{ margin: 0, fontSize: 12.5, color: INK2 }}>
            <b style={{ color: LIGHT.red.ink }}>{counts.red} red</b>, <b style={{ color: LIGHT.yellow.ink }}>{counts.yellow} yellow</b>, <b style={{ color: LIGHT.green.ink }}>{counts.green} green</b>
            {counts.none ? `, ${counts.none} with nothing to grade` : ''}. Red first; click a teammate for the records behind each number.
          </p>
          {LANES.map((lane) => {
            const laneRows = rows.filter((r) => r.lane === lane);
            if (!laneRows.length) return null;
            return (
              <LaneCard key={lane} lane={lane} rows={laneRows} isMobile={isMobile} open={open} setOpen={setOpen}
                files={data.tc_files} today={today} staleDays={data.stale_days} />
            );
          })}
          {!hasTc && data.tc_files.length ? (
            <section aria-label="Transaction files" style={{ ...card, padding: '12px 14px' }}>
              <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 650, color: INK }}>Transaction files</h3>
              <p style={{ margin: '2px 0 10px', fontSize: 12, color: MUTED }}>No one coordinates a live file yet, so every open file is listed here.</p>
              <FileList files={data.tc_files} today={today} staleDays={data.stale_days} />
            </section>
          ) : null}
          <Noise n={data.noise} />
        </>
      ) : null}
    </div>
  );
}

function Legend() {
  const items: [Light, string][] = [['green', 'met the goal'], ['yellow', 'met the expectation'], ['red', 'below the expectation'], ['none', 'not graded']];
  return (
    <ul aria-label="What the colours mean" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 12, color: INK2 }}>
      {items.map(([l, t]) => (
        <li key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Dot light={l} /> <span><b style={{ fontWeight: 600 }}>{l === 'none' ? 'Grey' : LIGHT[l].word}</b> {t}</span>
        </li>
      ))}
    </ul>
  );
}

function Dot({ light, size = 10 }: { light: Light; size?: number }) {
  const l = LIGHT[light];
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: 999, flex: 'none', display: 'inline-block', background: l.dot,
      boxShadow: light === 'none' ? `inset 0 0 0 1.5px #a1a1aa` : 'none',
    }} />
  );
}

function Badge({ light, label }: { light: Light; label: string }) {
  const l = LIGHT[light];
  return (
    <span title={`${label}: ${light === 'none' ? 'not graded' : l.word.toLowerCase()}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 7px', borderRadius: 6, background: l.bg, color: l.ink, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      <Dot light={light} size={8} />{label} {light === 'none' ? 'n/a' : l.word.toLowerCase()}
    </span>
  );
}

/** The two verdicts: the numbers against target, and the admin gaps. */
function Verdicts({ r }: { r: Row }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {r.cells.length ? <Badge light={r.targets} label={r.lane === 'tc' ? 'Files' : 'Targets'} /> : null}
      <Badge light={r.admin} label="Admin" />
    </span>
  );
}

function LaneCard({ lane, rows, isMobile, open, setOpen, files, today, staleDays }: {
  lane: Lane; rows: Row[]; isMobile: boolean; open: string | null; setOpen: (id: string | null) => void;
  files: TcFileRow[]; today: string; staleDays: number;
}) {
  // Columns come from the first row: every teammate in a lane is held to the same metrics.
  const cols = [...rows[0].cells, ...rows[0].gaps];
  // The detail row spans a table wider than the card; pin it to the visible width.
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile]);
  const sub = lane === 'acquisitions' ? 'Daily minimums: hit any one (2 of 5 is green). KPIs and appointment minimums from the team targets.'
    : lane === 'dispositions' ? 'Daily minimums: all four for green, 3 of 4 is yellow.'
      : lane === 'tc' ? `Live TC files they coordinate, checked against the TC SOP checklist. Stale means nothing logged in ${staleDays} days.`
        : 'No activity targets for these roles, so only the admin gaps are checked.';
  return (
    <section aria-label={LANE_LABEL[lane]} style={{ ...card, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${HAIR}` }}>
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 650, color: INK }}>{LANE_LABEL[lane]}</h3>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.45 }}>{sub}</p>
      </div>
      {isMobile ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r) => {
            const isOpen = open === r.p.user_id;
            return (
              <li key={r.p.user_id} style={{ borderBottom: `1px solid ${HAIR}` }}>
                <button type="button" className="sl-row-btn" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.p.user_id)}
                  style={{ width: '100%', padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 650, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.p.name}</span>
                  <Verdicts r={r} />
                  <ChevronDown size={16} aria-hidden style={{ color: MUTED, transform: isOpen ? 'rotate(180deg)' : 'none' }} />
                </button>
                <dl style={{ margin: 0, padding: '0 14px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px' }}>
                  {[...r.cells, ...r.gaps].map((c) => (
                    <div key={c.key} style={{ minWidth: 0 }}>
                      <dt style={{ fontSize: 11.5, color: MUTED }}>{c.label}</dt>
                      <dd style={{ margin: '1px 0 0' }}><Value c={c} /></dd>
                      <dd style={{ margin: 0, fontSize: 11.5, color: MUTED }}>{c.short ?? 'No target set'}</dd>
                    </div>
                  ))}
                </dl>
                {isOpen ? <Detail r={r} files={files} today={today} staleDays={staleDays} isMobile /> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div ref={scroller} style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr>
                <th scope="col" className="sl-th sl-sticky" style={{ minWidth: 170 }}>Teammate</th>
                {cols.map((c) => <th key={c.key} scope="col" className="sl-th" title={c.note}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.p.user_id;
                return (
                  <React.Fragment key={r.p.user_id}>
                    <tr className="sl-tr" data-open={isOpen ? '' : undefined} style={{ background: '#fff' }} onClick={() => setOpen(isOpen ? null : r.p.user_id)}>
                      <th scope="row" className="sl-td sl-sticky" style={{ textAlign: 'left' }}>
                        <button type="button" className="sl-name" aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : r.p.user_id); }}>
                          <ChevronDown size={14} aria-hidden style={{ color: MUTED, flex: 'none', transform: isOpen ? 'rotate(180deg)' : 'rotate(-90deg)' }} />
                          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 3, alignItems: 'flex-start' }}>
                            <span style={{ fontSize: 13.5, fontWeight: 650, color: INK, whiteSpace: 'nowrap' }}>{r.p.name}</span>
                            <Verdicts r={r} />
                          </span>
                        </button>
                      </th>
                      {[...r.cells, ...r.gaps].map((c) => (
                        <td key={c.key} className="sl-td" title={`${c.label}: ${c.shown}. ${c.target ? 'Target ' + c.target + '.' : 'No target set.'} ${c.note ?? ''}`}>
                          <Value c={c} />
                          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2, whiteSpace: 'nowrap' }}>{c.short ?? 'No target set'}</div>
                        </td>
                      ))}
                    </tr>
                    {isOpen ? (
                      <tr style={{ background: '#fafafa' }}>
                        <td colSpan={cols.length + 1} style={{ padding: 0, borderBottom: `1px solid ${LINE}`, background: '#fafafa' }}>
                          <div style={{ position: 'sticky', left: 0, width: width ?? undefined, maxWidth: '100%' }}>
                            <Detail r={r} files={files} today={today} staleDays={staleDays} isMobile={false} />
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Value({ c }: { c: Cell }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <Dot light={c.light} />
      <span style={{ fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>{c.shown}</span>
      <span className="sl-sr">{c.light === 'none' ? 'not graded' : LIGHT[c.light].word}</span>
    </span>
  );
}

const shortDate = (iso: string | null) => (iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

function Detail({ r, files, today, staleDays, isMobile }: { r: Row; files: TcFileRow[]; today: string; staleDays: number; isMobile: boolean }) {
  const { p } = r;
  const mine = files.filter((f) => f.tc_rep_id === p.user_id);
  const unassigned = files.filter((f) => !f.tc_rep_id);
  const lastCall = p.last_call_at ? `Last outbound call ${shortDate(p.last_call_at)}.` : 'No outbound call on record.';
  return (
    <div style={{ padding: isMobile ? '4px 14px 14px' : '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 12.5, color: INK2 }}>
        {r.p.name}: {r.cells.length ? `${r.lane === 'tc' ? 'files' : 'targets'} ${r.targets === 'none' ? 'not graded' : LIGHT[r.targets].word.toLowerCase()}, ` : ''}admin {LIGHT[r.admin].word.toLowerCase()}. {r.lane === 'acquisitions' || r.lane === 'dispositions' ? lastCall : ''}
        {p.metrics.calendar_meetings ? ` ${p.metrics.calendar_meetings} calendar meeting${p.metrics.calendar_meetings === 1 ? '' : 's'} left out of appointments.` : ''}
      </p>
      {r.cells.length ? (
        <div>
          <h4 className="sl-h4">How each number is graded</h4>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))', gap: '6px 18px' }}>
            {r.cells.map((c) => (
              <li key={c.key} style={{ fontSize: 12, color: INK2, lineHeight: 1.45 }}>
                <span style={{ fontWeight: 600, color: INK }}>{c.label}</span> <Value c={c} />
                <div style={{ color: MUTED }}>{c.target ? `Target ${c.target}. ` : 'No target set. '}{c.note}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.lane === 'tc' ? (
        <div>
          <h4 className="sl-h4">Their open files ({mine.length})</h4>
          {mine.length ? <FileList files={mine} today={today} staleDays={staleDays} /> : <p className="sl-empty">No live files assigned to them.</p>}
          {unassigned.length ? (
            <>
              <h4 className="sl-h4" style={{ marginTop: 12 }}>Open files with no TC ({unassigned.length})</h4>
              <FileList files={unassigned} today={today} staleDays={staleDays} />
            </>
          ) : null}
        </div>
      ) : null}
      <GapList title="Overdue tasks" total={p.gaps.overdue_tasks} shown={p.items.overdue_tasks.length} empty="No overdue tasks." order="oldest first"
        items={p.items.overdue_tasks.map((t) => ({
          key: 't' + t.id,
          text: t.title,
          meta: [t.who, `due ${shortDate(t.due_at)}`, t.deal_id ? null : 'no deal linked'].filter(Boolean).join(' · '),
          href: t.seller_id ? recordHref({ screen: 'person', sellerId: t.seller_id, dealId: t.deal_id }) : t.buyer_id ? recordHref({ screen: 'buyer', buyerId: t.buyer_id }) : '#screen=tasks',
          link: t.seller_id ? 'Open lead' : t.buyer_id ? 'Open buyer' : 'Open tasks',
        }))} />
      <GapList title="Leads never worked" total={p.gaps.untouched_leads} shown={p.items.untouched_leads.length} empty="Every lead assigned to them has been called, texted or emailed." order="newest first"
        items={p.items.untouched_leads.map((s) => ({
          key: 's' + s.id, text: s.name || 'Unnamed lead', meta: [s.address, `added ${shortDate(s.created_at)}`].filter(Boolean).join(' · '),
          href: recordHref({ screen: 'person', sellerId: s.id }), link: 'Open lead',
        }))} />
      <GapList title="Deals with no next step" total={p.gaps.no_next_step} shown={p.items.no_next_step.length} empty="Every live deal of theirs has an open task." order=""
        items={p.items.no_next_step.map((d) => ({
          key: 'd' + d.deal_id, text: d.label, meta: d.stage,
          href: recordHref({ screen: d.seller_id ? 'person' : 'dealSheet', sellerId: d.seller_id, dealId: d.deal_id }), link: 'Open deal',
        }))} />
    </div>
  );
}

function GapList({ title, total, shown, items, empty, order }: {
  title: string; total: number; shown: number; empty: string; order: string;
  items: { key: string; text: string; meta: string; href: string; link: string }[];
}) {
  return (
    <div>
      <h4 className="sl-h4">
        {title} <span style={{ fontVariantNumeric: 'tabular-nums', color: total ? LIGHT.red.ink : LIGHT.green.ink }}>{total.toLocaleString('en-US')}</span>
        {total > shown && shown ? <span style={{ fontWeight: 500, color: MUTED }}> · showing {shown}, {order}</span> : null}
      </h4>
      {items.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${LINE}`, borderRadius: 10, background: '#fff' }}>
          {items.map((it, i) => (
            <li key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderTop: i ? `1px solid ${HAIR}` : 'none', minWidth: 0 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span title={it.text} style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.text}</span>
                <span title={it.meta} style={{ display: 'block', fontSize: 11.5, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.meta}</span>
              </span>
              <a href={it.href} className="sl-link">{it.link}<ExternalLink size={12} aria-hidden /></a>
            </li>
          ))}
        </ul>
      ) : <p className="sl-empty">{total ? 'The list did not load with the count. Reload to see the records.' : empty}</p>}
    </div>
  );
}

function FileList({ files, today, staleDays }: { files: TcFileRow[]; today: string; staleDays: number }) {
  const rows = files.map((f) => ({ f, gaps: tcFileGaps(f, today, staleDays) })).sort((a, b) => b.gaps.length - a.gaps.length);
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${LINE}`, borderRadius: 10, background: '#fff' }}>
      {rows.map(({ f, gaps }, i) => (
        <li key={f.transaction_id} style={{ padding: '8px 10px', borderTop: i ? `1px solid ${HAIR}` : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <Dot light={gaps.length ? 'red' : 'green'} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span title={f.label} style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</span>
              <span style={{ display: 'block', fontSize: 11.5, color: MUTED }}>
                {[f.deal_type === 'novation' ? 'Novation' : 'Assignment', f.stage, f.contract_date ? `contract ${shortDate(f.contract_date)}` : null, f.ctc_target ? `CTC ${shortDate(f.ctc_target)}` : null, f.close_date ? `close ${shortDate(f.close_date)}` : null].filter(Boolean).join(' · ')}
              </span>
            </span>
            <a href={recordHref({ screen: f.seller_id ? 'tc' : 'dealSheet', sellerId: f.seller_id, dealId: f.deal_id })} className="sl-link">Open file<ExternalLink size={12} aria-hidden /></a>
          </div>
          {gaps.length ? (
            <ul aria-label={`What ${f.label} has missed`} style={{ listStyle: 'none', margin: '6px 0 0 20px', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {gaps.map((g) => (
                <li key={g.kind} style={{ fontSize: 11, fontWeight: 600, color: LIGHT.red.ink, background: LIGHT.red.bg, borderRadius: 6, padding: '3px 7px' }}>{g.text}</li>
              ))}
            </ul>
          ) : <div style={{ margin: '4px 0 0 20px', fontSize: 11.5, color: LIGHT.green.ink }}>Nothing missed</div>}
        </li>
      ))}
    </ul>
  );
}

function Noise({ n }: { n: StoplightPayload['noise'] }) {
  const parts = [
    n.prospect_deals ? `${n.prospect_deals.toLocaleString('en-US')} Prospect deals (${n.prospect_negative_fee.toLocaleString('en-US')} with negative fees) never count as contracts or pipeline` : null,
    n.calendar_meetings ? `${n.calendar_meetings.toLocaleString('en-US')} calendar meetings are not seller appointments` : null,
    n.buyers_imported ? `${n.buyers_imported.toLocaleString('en-US')} imported buyers are not buyers added` : null,
    n.open_files_on_ended_deals ? `${n.open_files_on_ended_deals.toLocaleString('en-US')} TC files still open on closed, terminated or archived deals are skipped` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p style={{ margin: 0, fontSize: 12, color: MUTED, lineHeight: 1.5, maxWidth: '90ch' }}>
      Left out so the lights stay honest: {parts.join('; ')}. JV sellers, lead-to-close ratio, touches before handoff, days to assign and fallout rate are not recorded in CLOZR, so they are not graded.
    </p>
  );
}

const CSS = `
[data-stoplight] .sl-chip{height:28px;padding:0 10px;border-radius:8px;border:0;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;background:#fff;color:${INK2};box-shadow:0 0 0 1px rgba(0,0,0,.08),0 1px 2px -1px rgba(0,0,0,.08),0 2px 4px 0 rgba(0,0,0,.04);transition:transform 140ms cubic-bezier(.23,1,.32,1)}
[data-stoplight] .sl-chip[data-on]{background:${INK};color:#fff}
[data-stoplight] .sl-chip:active{transform:scale(.97)}
[data-stoplight] button:focus-visible,[data-stoplight] a:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}
[data-stoplight] .sl-th{position:sticky;top:0;text-align:left;font-size:11.5px;font-weight:500;color:${MUTED};padding:8px 12px;border-bottom:1px solid ${LINE};background:#fff;white-space:nowrap}
[data-stoplight] .sl-td{padding:9px 12px;border-bottom:1px solid ${HAIR};vertical-align:top;background:#fff}
[data-stoplight] .sl-sticky{position:sticky;left:0;z-index:1;box-shadow:1px 0 0 ${HAIR}}
[data-stoplight] .sl-tr{cursor:pointer}
[data-stoplight] .sl-tr[data-open] > *{background:#fafafa}
[data-stoplight] .sl-name{display:flex;align-items:flex-start;gap:6px;border:0;background:none;padding:2px 0;font:inherit;cursor:pointer;text-align:left;min-height:24px}
[data-stoplight] .sl-row-btn{border:0;background:none;font:inherit;cursor:pointer;min-height:44px}
[data-stoplight] .sl-h4{margin:0 0 6px;font-size:12.5px;font-weight:650;color:${INK}}
[data-stoplight] .sl-empty{margin:0;font-size:12px;color:${MUTED}}
[data-stoplight] .sl-link{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:12px;font-weight:600;color:${ACCENT};text-decoration:none;padding:4px 2px;min-height:24px;border-radius:4px}
[data-stoplight] .sl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
[data-stoplight] .sl-skel{border-radius:8px;background:#f4f4f5}
@media (hover:hover) and (pointer:fine){
  [data-stoplight] .sl-tr:hover > *{background:#e9f6f0}
  [data-stoplight] .sl-link:hover{color:#08694C;text-decoration:underline;text-underline-offset:2px}
  [data-stoplight] .sl-chip:not([data-on]):hover{background:#f4f4f5}
}
`;
