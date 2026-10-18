// Today: the one list an acquisitions rep calls, and the call loop around it.
//
// Desk: the list on the left, the seller in view in the middle (why now,
// what we know, the notes), and the outcome rail on the right — pick what
// happened, press Enter, and the stage, the next step and the text are done.
// Phone: the list, with Call / Text / Log outcome for the picked row; a call
// hands off to the full-screen phone, whose wrap-up is the same picker.
//
// Above the call loop on the desk, and under the list on the phone, sits the
// rep's own work: My tasks (due today or late) and My deals (still moving).
// With nobody to call, that band is the page instead of three empty columns.
//
// Built to the Paved spec (canvas Paved-Today and Paved-Mobile): mint for
// actions, red only for hanging up, money in ink, sentence case, 1px borders
// on resting surfaces, no motion on the things done a hundred times a day.
'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import type { WrapKey } from '@/app/clozr/useClozr';
import { OutcomePicker } from '@/app/components/talkr/OutcomePicker';
import { WrapFieldsCard } from '@/app/components/talkr/DialerParts';
import { useMinuteTick } from '@/app/components/talkr/ProspectTime';
import { useSoftphone } from '@/app/components/talkr/softphoneAdapter';
import { ColdHealthCard } from '@/app/components/deliverability/ColdHealthCard';
import { callWindow, tzTime, zoneForNumber } from '@/lib/talkr-web/time';
import { ClozrForToday } from '@/app/components/today/ClozrForToday';

type Today = ClozrView['today'];
type Row = Today['rows'][number];
type Lead = NonNullable<Today['lead']>;

const INK = 'var(--ink, #18181b)';
const INK2 = 'var(--ink-3, #3f3f46)';
const MUTED = 'var(--muted, #52525b)';
const SUBTLE = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';
const LINE_SOFT = 'var(--divider-2, #f0f0f1)';
const CONTROL = 'var(--line, #d4d4d8)';
const MINT = '#0A8560';
const MINT_TEXT = 'var(--tx-mint-deep, #08694c)';
const MINT_TINT = 'var(--mint-dim, #e7f8f1)';
const MINT_LINE = '#A8ECD2';
const AMBER = '#B45309';
const LINK_BLUE = '#0369A1';
const FONT = "var(--font-inter), 'Inter', 'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const TAG_COLOR: Record<string, string> = { muted: MUTED, due: AMBER, overdue: '#B91C1C', money: INK, mint: MINT_TEXT };

/** Hover, focus and press, which inline styles cannot say. Colour only on the list; a small press on the big buttons. */
const CSS = `
.today-root button, .today-root textarea { font-family: inherit; }
.today-root :is(button, a, textarea, input):focus-visible { outline: 2px solid ${MINT}; outline-offset: 2px; }
.today-row { transition: background-color 120ms linear; }
.today-row:not([aria-current="true"]):not(:disabled):hover { background: var(--surface-2, #f4f4f5) !important; }
.today-secondary:hover { background: var(--surface-2, #f4f4f5) !important; }
.today-dark-secondary:hover { background: rgba(255,255,255,.08) !important; }
.today-link:hover { color: var(--tx-mint-deep, #08694c) !important; }
.today-primary:not(:disabled):hover { background: #08694C !important; }
.today-check .today-check-mark { opacity: 0; }
@media (hover: hover) and (pointer: fine) {
  .today-check:hover { color: ${MINT} !important; }
  .today-check:hover .today-check-mark { opacity: 1; }
}
.today-check:focus-visible .today-check-mark { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .today-press { transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), background-color 120ms linear; }
  .today-press:active { transform: scale(0.97); }
  .today-sheet { animation: todaySheet 220ms cubic-bezier(0.23, 1, 0.32, 1); }
  @keyframes todaySheet { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: none; } }
}
`;

function Icon({ d, size = 16, color = 'currentColor' }: { d: string; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
      <path d={d} />
    </svg>
  );
}
const PHONE = 'M3.5 2.5h2.2l1.1 3-1.5 1a8 8 0 0 0 4.2 4.2l1-1.5 3 1.1v2.2a1.5 1.5 0 0 1-1.6 1.5A11.5 11.5 0 0 1 2 4.1a1.5 1.5 0 0 1 1.5-1.6z';
const POWER = 'M2.5 4h8M2.5 8h5M2.5 12h5M10.5 9.5v4l3.5-2z';
const CLOCK = 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5';
const TEXT = 'M2.5 3.5h11v7.5h-6l-3 2.5V11h-2z';
const LOG = 'M4.5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12V4a1.5 1.5 0 0 1 1.5-1.5zM5.5 8.2 7.2 10l3.3-3.5';
const CHEVRON = 'M6 3.5 10.5 8 6 12.5';
const CHECK = 'M4.5 8.2 6.9 10.5 11.5 5.5';
const RED = '#B91C1C';

/** "10:12 AM their time", amber outside the calling window. Nothing when the number has no known zone. */
function TheirTime({ e164, size = 13 }: { e164: string; size?: number }) {
  const now = useMinuteTick();
  const zone = e164 ? zoneForNumber(e164) : null;
  if (!zone || now === null) return null;
  const safe = callWindow(zone, now).safe;
  return (
    <span style={{ fontSize: size, fontWeight: 500, color: safe ? MUTED : AMBER, whiteSpace: 'nowrap' }}>
      {tzTime(zone, now)} their time{safe ? '' : ', quiet hours'}
    </span>
  );
}

function StageChip({ stage }: { stage: string }) {
  return <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.4, color: INK2, background: 'var(--surface-2, #f4f4f5)', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>{stage}</span>;
}

function StageBar({ lead }: { lead: Lead }) {
  return (
    <div role="img" aria-label={lead.stageAria} style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 2, width: '100%', maxWidth: 520 }}>
      {lead.segs.map((seg) => (
        <div key={seg.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 4, borderRadius: 999, background: seg.state === 'done' ? INK : seg.state === 'current' ? MINT : LINE }} />
          <span style={{ fontSize: 12, fontWeight: 500, color: seg.state === 'current' ? MINT_TEXT : MUTED }}>{seg.label}</span>
        </div>
      ))}
    </div>
  );
}

function WhyNow({ why }: { why: string }) {
  return (
    <div data-testid="today-why" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', background: 'var(--caution-soft, #fef3c7)', borderRadius: 10 }}>
      <span style={{ marginTop: 2 }}><Icon d={CLOCK} color={AMBER} /></span>
      <span style={{ fontSize: 13, fontWeight: 600, color: AMBER, whiteSpace: 'nowrap', lineHeight: 1.45 }}>Why now</span>
      <span style={{ fontSize: 13, fontWeight: 500, color: INK2, lineHeight: 1.45 }}>{why}</span>
    </div>
  );
}

function Known({ lead }: { lead: Lead }) {
  return (
    <div style={{ background: 'var(--surface, #ffffff)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, border: `1px solid ${LINE}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: MUTED }}>What we know</h3>
        <span style={{ fontSize: 12, fontWeight: 500, color: lead.askCount ? AMBER : MUTED }}>
          {lead.askCount ? `${lead.askCount} ${lead.askCount === 1 ? 'thing' : 'things'} to ask` : 'Complete'}
        </span>
      </div>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '132px minmax(0, 1fr)', rowGap: 8, columnGap: 12, fontSize: 13, lineHeight: 1.45 }}>
        {lead.facts.map((f) => (
          <React.Fragment key={f.k}>
            <dt style={{ fontWeight: 500, color: MUTED }}>{f.k}</dt>
            <dd style={{ margin: 0, fontWeight: f.ask ? 600 : 500, color: f.ask ? AMBER : INK }}>{f.v}</dd>
          </React.Fragment>
        ))}
        {lead.money.map((m) => (
          <React.Fragment key={m.k}>
            <dt style={{ fontWeight: 500, color: MUTED }}>{m.k}</dt>
            <dd style={{ margin: 0, fontWeight: 600, color: INK }}>{m.v}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

/** Buttons on the dark call bar. */
const darkSecondary: React.CSSProperties = {
  height: 36, padding: '0 14px', borderRadius: 6, border: `1px solid ${INK2}`, background: 'transparent', color: 'var(--on-dark, #ffffff)',
  fontSize: 13, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
};
const primary: React.CSSProperties = {
  height: 36, padding: '0 14px', borderRadius: 6, border: 0, background: MINT, color: 'var(--on-dark, #ffffff)',
  fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
};

export function Today({ V }: { V: ClozrView }) {
  return (
    <>
      <style>{CSS}</style>
      {V.isMobile ? <TodayPhone V={V} /> : (
        // One scroll for the page: the call loop keeps its full height under the band.
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', background: 'var(--canvas, #fafafa)' }}>
          <Focus V={V} />
          {V.today.total === 0 && V.callState === 'idle' ? <EmptyDay V={V} /> : (
            <>
              <MyWork V={V} size="compact" />
              <TodayDesk V={V} />
            </>
          )}
        </div>
      )}
    </>
  );
}

/** "Clozr for today" above the call list: the focus list and the composer. */
function Focus({ V }: { V: ClozrView }) {
  const F = V.today.focus;
  return (
    <>
      <ClozrForToday workspaceId={F.workspaceId} first={F.first} isMobile={V.isMobile} demo={F.demo} open={F.open} ask={F.ask} busy={F.busy} />
      <ColdHealthCard workspaceId={F.workspaceId} demo={F.demo != null} />
    </>
  );
}

// ---- my work: tasks and deals ---------------------------------------------

type Band = ClozrView['todayBand'];
type BandSize = 'compact' | 'full' | 'phone';
/** Rows per panel: a short band over the call loop, a longer one when it is the page. */
const BAND_ROWS: Record<BandSize, number> = { compact: 3, full: 8, phone: 4 };

/** The desk with nobody to call: the rep's tasks and deals are the page. */
function EmptyDay({ V }: { V: ClozrView }) {
  return (
    <section
      data-screen-label="Today"
      data-testid="today-root"
      className="today-root"
      style={{ flex: '1 0 auto', boxSizing: 'border-box', padding: '20px 24px 32px', display: 'flex', flexDirection: 'column', gap: 16, color: INK, fontFamily: FONT, fontVariantNumeric: 'tabular-nums' }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.01em' }}>Today</h1>
        <p data-testid="today-empty" style={{ margin: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.45, color: MUTED }}>
          Nobody on your call list. New leads, tasks due today and offers waiting on an answer join it as they arrive.
        </p>
      </header>
      <MyWork V={V} size="full" />
    </section>
  );
}

/** My tasks and My deals, side by side on the desk and stacked on the phone. */
function MyWork({ V, size }: { V: ClozrView; size: BandSize }) {
  const B = V.todayBand;
  const phone = size === 'phone';
  // With nobody to call, the band is the page: it also says what comes after today's tasks.
  const nextUp = size === 'full' || (phone && V.today.total === 0);
  return (
    <section
      aria-label="My work"
      data-testid="today-band"
      className="today-root"
      style={{
        flexShrink: 0, boxSizing: 'border-box', display: 'grid', gap: phone ? 16 : 12, alignItems: 'start', color: INK, fontFamily: FONT, fontVariantNumeric: 'tabular-nums',
        gridTemplateColumns: phone ? 'minmax(0, 1fr)' : 'repeat(auto-fit, minmax(360px, 1fr))',
        padding: size === 'compact' ? '12px 24px' : 0, borderBottom: size === 'compact' ? `1px solid ${LINE}` : 0,
      }}
    >
      <TasksPanel B={B} size={size} nextUp={nextUp} />
      <DealsPanel B={B} size={size} />
    </section>
  );
}

function BandPanel({ title, meta, link, onLink, testid, phone, children }: {
  title: string; meta: React.ReactNode; link: string; onLink: () => void; testid: string; phone: boolean; children: React.ReactNode;
}) {
  return (
    <section aria-label={title} data-testid={testid} style={{ background: 'var(--surface, #ffffff)', border: `1px solid ${LINE}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: phone ? '4px 8px 4px 14px' : '6px 8px 6px 14px', minHeight: phone ? 48 : 40, boxSizing: 'border-box', borderBottom: `1px solid ${LINE_SOFT}` }}>
        <h2 style={{ margin: 0, fontSize: phone ? 15 : 13.5, fontWeight: 650, lineHeight: 1.3, whiteSpace: 'nowrap' }}>{title}</h2>
        <span style={{ fontSize: 12, fontWeight: 500, color: MUTED, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</span>
        <button type="button" className="today-link" onClick={onLink} style={{ marginLeft: 'auto', flexShrink: 0, border: 0, background: 'none', padding: '0 6px', minHeight: phone ? 40 : 28, color: MINT_TEXT, fontSize: 12.5, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          {link}
        </button>
      </div>
      {children}
    </section>
  );
}

function BandEmpty({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, padding: '12px 14px 14px', fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: MUTED }}>{children}</p>;
}

const bandList: React.CSSProperties = { margin: 0, padding: 0, listStyle: 'none' };

function TasksPanel({ B, size, nextUp }: { B: Band; size: BandSize; nextUp: boolean }) {
  const phone = size === 'phone';
  const shown = B.tasks.slice(0, BAND_ROWS[size]);
  const later = nextUp ? B.upcoming.slice(0, Math.max(0, BAND_ROWS[size] - shown.length)) : [];
  const due = B.taskCount - B.overdueCount;
  const meta = B.taskCount === 0 ? null : (
    <>
      {B.overdueCount > 0 && <span style={{ color: RED, fontWeight: 600 }}>{B.overdueCount} late</span>}
      {B.overdueCount > 0 && due > 0 && ', '}
      {due > 0 && `${due} due today`}
    </>
  );
  return (
    <BandPanel title="My tasks" meta={meta} link="All tasks" onLink={B.allTasks} testid="today-band-tasks" phone={phone}>
      {shown.length ? (
        <ul style={bandList}>{shown.map((t, i) => <TaskLine key={t.id} t={t} phone={phone} first={i === 0} />)}</ul>
      ) : (
        <BandEmpty>
          {later.length ? 'Nothing due today or late.' : 'Nothing due today or late. Save a call outcome with a next step and it lands here.'}
        </BandEmpty>
      )}
      {later.length > 0 && (
        <>
          <h3 style={{ margin: 0, padding: '10px 14px 4px', fontSize: 12, fontWeight: 600, color: MUTED, borderTop: shown.length ? `1px solid ${LINE_SOFT}` : 0 }}>Coming up</h3>
          <ul style={bandList}>{later.map((t, i) => <TaskLine key={t.id} t={t} phone={phone} first={i === 0} />)}</ul>
        </>
      )}
    </BandPanel>
  );
}

function TaskLine({ t, phone, first }: { t: Band['tasks'][number]; phone: boolean; first: boolean }) {
  return (
    <li style={{ display: 'flex', alignItems: 'stretch', borderTop: first ? 0 : `1px solid ${LINE_SOFT}` }}>
      <button
        type="button"
        className="today-check"
        data-testid={`today-band-done-${t.id}`}
        onClick={t.complete}
        aria-label={`Mark done: ${t.title}`}
        title="Mark done"
        style={{ flexShrink: 0, width: phone ? 44 : 36, minHeight: phone ? 44 : 32, display: 'grid', placeItems: 'center', border: 0, background: 'none', padding: 0, color: SUBTLE, cursor: 'pointer' }}
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="8" cy="8" r="6.25" />
          <path className="today-check-mark" d={CHECK} />
        </svg>
      </button>
      <button
        type="button"
        className="today-row"
        data-testid={`today-band-task-${t.id}`}
        onClick={t.open}
        title={t.title}
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, padding: phone ? '8px 14px 8px 0' : '7px 14px 7px 0', minHeight: phone ? 52 : 44, border: 0, background: 'var(--surface, #ffffff)', textAlign: 'left', color: INK, cursor: 'pointer' }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', minWidth: 0 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: phone ? 14 : 13, fontWeight: 600, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
          <span style={{ flexShrink: 0, fontSize: 12, fontWeight: t.late ? 600 : 500, color: t.late ? RED : MUTED, whiteSpace: 'nowrap' }}>{t.due}</span>
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.4, color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
          {[t.who || 'No seller on it', t.type].filter(Boolean).join(' · ')}
        </span>
      </button>
    </li>
  );
}

function DealsPanel({ B, size }: { B: Band; size: BandSize }) {
  const phone = size === 'phone';
  const shown = B.deals.slice(0, BAND_ROWS[size]);
  return (
    <BandPanel
      title="My deals" meta={B.dealCount ? `${B.dealCount} in motion` : null} link="All deals" onLink={B.allDeals} testid="today-band-deals" phone={phone}
    >
      {!shown.length && <BandEmpty>No deals of yours in motion. When a seller signs, the deal shows here until it closes.</BandEmpty>}
      {shown.length > 0 && <ul style={bandList}>{shown.map((d, i) => (
        <li key={d.id} style={{ borderTop: i ? `1px solid ${LINE_SOFT}` : 0 }}>
          <button
            type="button"
            className="today-row"
            data-testid={`today-band-deal-${d.id}`}
            onClick={d.open}
            title={[d.addr, d.city].filter(Boolean).join(', ')}
            style={{ width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, padding: phone ? '8px 14px' : '7px 14px', minHeight: phone ? 52 : 44, border: 0, background: 'var(--surface, #ffffff)', textAlign: 'left', color: INK, cursor: 'pointer' }}
          >
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', minWidth: 0 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: phone ? 14 : 13, fontWeight: 600, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.addr || 'No address'}</span>
              <span style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, color: d.key ? INK : MUTED, whiteSpace: 'nowrap' }}>
                {d.key ? <><span style={{ fontSize: 12, fontWeight: 500, color: MUTED }}>{d.key.label} </span>{d.key.value}</> : <span style={{ fontSize: 12, fontWeight: 500 }}>No price yet</span>}
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', minWidth: 0, fontSize: 12, fontWeight: 500, lineHeight: 1.4, color: MUTED }}>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.stage} · {d.seller}</span>
              <span style={{ flexShrink: 0, whiteSpace: 'nowrap', color: d.stale ? AMBER : MUTED, fontWeight: d.stale ? 600 : 500 }}>{d.days}</span>
            </span>
          </button>
        </li>
      ))}</ul>}
    </BandPanel>
  );
}

// ---- desk -----------------------------------------------------------------

function TodayDesk({ V }: { V: ClozrView }) {
  const T = V.today;
  const lead = T.lead;
  const { notes, setNotes } = useSoftphone();
  const notesRef = useRef<HTMLTextAreaElement>(null);
  // The rep's corrections to the call's CRM fields, shared by "From this call"
  // and the rail's save. Keyed to the call, so the next call starts clean.
  const [edits, setEdits] = useState<{ key: string; v: Partial<Record<WrapKey, string>> }>({ key: '', v: {} });
  const editKey = T.target?.key ?? '';
  const factEdits = edits.key === editKey ? edits.v : {};
  const facts = Object.fromEntries(V.wrapFields.map((f) => [f.key, factEdits[f.key] ?? f.v])) as Partial<Record<WrapKey, string>>;
  const setFactEdits = (next: (prev: Partial<Record<WrapKey, string>>) => Partial<Record<WrapKey, string>>) =>
    setEdits((cur) => ({ key: editKey, v: next(cur.key === editKey ? cur.v : {}) }));
  const onThisCall = V.callState !== 'idle' && !!T.target && T.target.mode === 'call';
  const showFields = V.isWrap && onThisCall && !V.wrapNoAnswer && V.wrapFields.length > 0;
  const lastNow = T.rows.filter((x) => x.group === 'now').slice(-1)[0]?.pid;

  return (
    <section
      data-screen-label="Today"
      data-testid="today-root"
      className="today-root"
      style={{ flex: '1 0 600px', minWidth: 0, minHeight: 0, display: 'flex', background: 'var(--canvas, #fafafa)', color: INK, fontFamily: FONT, fontVariantNumeric: 'tabular-nums' }}
    >
      <aside
        aria-label="Today's list"
        data-testid="today-list"
        style={{ width: 'clamp(280px, calc(280px + (100vw - 1199px) * 1000), 320px)', flexShrink: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: 'var(--surface, #ffffff)', borderRight: `1px solid ${LINE}`, minHeight: 0 }}
      >
        <div style={{ padding: '20px 16px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.01em' }}>Today</h1>
            <span data-testid="today-left" style={{ fontSize: 12, fontWeight: 500, color: MUTED }}>{T.allDone ? 'All done' : `${T.left} left`}</span>
          </div>
          <p style={{ margin: 0, fontSize: 12, fontWeight: 500, lineHeight: 1.4, color: MUTED }}>Power dial runs this list top to bottom. New leads first.</p>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {T.total === 0 && (
            <p style={{ margin: 0, padding: '14px 8px', fontSize: 13, fontWeight: 500, lineHeight: 1.45, color: MUTED }}>
              Nothing on your list. New leads, tasks due today and offers waiting on an answer land here.
            </p>
          )}
          {T.rows.map((r) => (
            <React.Fragment key={r.pid}>
              {r.groupStart && <div style={{ padding: '14px 8px 6px', fontSize: 12, fontWeight: 600, color: MUTED }}>{r.groupLabel}</div>}
              <DeskRow r={r} />
              {T.more > 0 && lastNow === r.pid && (
                <button type="button" className="today-link" onClick={T.openMore} style={{ alignSelf: 'flex-start', margin: '4px 12px', padding: 0, border: 0, background: 'none', color: MINT_TEXT, fontSize: 12, fontWeight: 500, cursor: 'pointer', minHeight: 32 }}>
                  {T.more} more in People, New leads
                </button>
              )}
            </React.Fragment>
          ))}
          {T.total > 0 && <p data-testid="today-source" style={{ margin: 0, padding: '12px 8px 0', fontSize: 12, fontWeight: 500, color: SUBTLE }}>{T.sourceLabel}</p>}
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {T.allDone ? (
          <QueueWorked V={V} />
        ) : lead ? (
          <>
            <section data-testid="today-lead" aria-label="Seller" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '24px 28px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lead.name}</h2>
                  <span data-testid="today-stage"><StageChip stage={lead.stage} /></span>
                  <button type="button" className="today-link" onClick={lead.open} style={{ marginLeft: 'auto', border: 0, background: 'none', padding: 0, color: MINT_TEXT, fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 32 }}>
                    Open full record
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 16, rowGap: 4, fontSize: 13, fontWeight: 500, color: MUTED }}>
                  {lead.address && <span>{lead.address}</span>}
                  {lead.e164 ? (
                    <button type="button" data-testid="today-phone" onClick={() => V.callPhone(lead.phone)} disabled={V.callState !== 'idle'} style={{ border: 0, background: 'none', padding: 0, color: LINK_BLUE, fontSize: 13, fontWeight: 500, cursor: V.callState === 'idle' ? 'pointer' : 'default' }}>
                      {lead.phone}
                    </button>
                  ) : <span>No phone number</span>}
                  <span>Last touch: {lead.last}</span>
                  <TheirTime e164={lead.e164} />
                </div>
                <StageBar lead={lead} />
              </div>
              {lead.why && <WhyNow why={lead.why} />}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' }}>
                <Known lead={lead} />
                <div style={{ background: 'var(--surface, #ffffff)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, border: `1px solid ${LINE}` }}>
                  <label htmlFor="today-notes" style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>Notes, saved with the outcome</label>
                  <textarea
                    id="today-notes"
                    ref={notesRef}
                    data-call-notes
                    data-testid="today-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Asking price, timeline, condition, who decides"
                    style={{ height: 132, resize: 'none', boxSizing: 'border-box', padding: '10px 12px', border: `1px solid ${CONTROL}`, borderRadius: 6, fontSize: 13, fontWeight: 400, lineHeight: 1.55, color: INK, background: 'var(--surface, #ffffff)' }}
                  />
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 500, lineHeight: 1.4, color: MUTED }}>
                    They land on the record&rsquo;s timeline when you save the outcome. <kbd style={kbd}>N</kbd> jumps here during wrap-up, <kbd style={kbd}>Esc</kbd> goes back.
                  </p>
                </div>
              </div>
              {showFields && <WrapFieldsCard V={V} edits={factEdits} setEdits={setFactEdits} variant="plain" />}
            </section>
            <CallStrip V={V} lead={lead} />
          </>
        ) : (
          <section style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 40 }}>
            <p style={{ margin: 0, maxWidth: 420, fontSize: 13, fontWeight: 500, lineHeight: 1.55, color: MUTED, textAlign: 'center' }}>
              Nobody to call right now. New leads, tasks due today and offers waiting on an answer show up here as they arrive.
            </p>
          </section>
        )}
      </main>

      <aside
        aria-label="Outcome"
        data-testid="today-rail"
        style={{ width: 'clamp(340px, calc(340px + (100vw - 1199px) * 1000), 380px)', flexShrink: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: 'var(--surface, #ffffff)', borderLeft: `1px solid ${LINE}`, minHeight: 0, overflow: 'auto' }}
      >
        <Rail V={V} facts={facts} onFocusNotes={() => notesRef.current?.focus()} />
      </aside>
    </section>
  );
}

const kbd: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, lineHeight: 1.4, fontFamily: 'inherit', color: MUTED, background: 'var(--surface-2, #f4f4f5)',
  border: `1px solid ${LINE}`, borderRadius: 4, padding: '1px 5px',
};

/** A logged row is not shut: picking it logs a different outcome over a wrong one. */
const CHANGE_OUTCOME = 'Logged. Click to change the outcome';

function DeskRow({ r }: { r: Row }) {
  return (
    <button
      type="button"
      className="today-row"
      data-testid={`today-row-${r.pid}`}
      aria-current={r.current ? 'true' : undefined}
      title={r.done ? CHANGE_OUTCOME : undefined}
      onClick={r.pick}
      style={{
        display: 'flex', flexDirection: 'column', gap: 3, width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10,
        border: `1px solid ${r.current ? MINT_LINE : 'transparent'}`, background: r.current ? MINT_TINT : 'var(--surface, #ffffff)', textAlign: 'left', color: INK,
        cursor: 'pointer', minHeight: 32,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
        <span data-testid={`today-tag-${r.pid}`} style={{ fontSize: 12, fontWeight: r.tone === 'money' ? 600 : 500, color: TAG_COLOR[r.tone] ?? MUTED, whiteSpace: 'nowrap' }}>{r.tagText}</span>
      </span>
      <span data-testid={r.done ? 'today-done' : undefined} style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.4, color: r.done ? MINT_TEXT : MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{r.line}</span>
    </button>
  );
}

/** The bar under the seller: Call and Power dial when idle, "Call ended" in wrap-up. A live call is the shell's call bar. */
function CallStrip({ V, lead }: { V: ClozrView; lead: Lead }) {
  const T = V.today;
  const stripRef = useRef<HTMLDivElement>(null);
  const shown = V.callState !== 'live';
  // On the desk the toast rose from the page bottom straight over this bar and hid Call for its whole life.
  useEffect(() => {
    const el = stripRef.current;
    const root = document.documentElement;
    if (!shown || !el) return;
    const ro = new ResizeObserver(() => root.style.setProperty('--clozr-todaybar', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--clozr-todaybar');
    };
  }, [shown]);
  if (!shown) return null;
  const wrap = V.callState === 'wrap';
  const idle = V.callState === 'idle';
  return (
    <div ref={stripRef} style={{ padding: '0 28px 20px' }}>
      <div
        role="region"
        aria-label="Call"
        style={{
          minHeight: 56, boxSizing: 'border-box', borderRadius: 14, background: INK, color: 'var(--on-dark, #ffffff)', display: 'flex', alignItems: 'center', gap: 16, padding: '10px 10px 10px 18px',
          boxShadow: '0px 0px 0px 1px rgba(0,0,0,0.06), 0px 1px 1px -0.5px rgba(0,0,0,0.06), 0px 3px 3px -1.5px rgba(0,0,0,0.06), 0px 6px 6px -3px rgba(0,0,0,0.06), 0px 12px 12px -6px rgba(0,0,0,0.06), 0px 24px 24px -12px rgba(0,0,0,0.06)',
        }}
      >
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: SUBTLE, flexShrink: 0 }} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{wrap ? 'Call ended' : T.target?.mode === 'log' ? `Logging ${lead.first} without a call` : `Ready to call ${lead.first}`}</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--subtle, #a1a1aa)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {wrap ? `${V.callTarget.name}, ${V.callDuration}` : lead.e164 ? lead.phone : 'No phone number on the record'}
          </span>
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {wrap && (
            <button type="button" className="today-dark-secondary today-press" onClick={T.callAgain} style={darkSecondary}>
              <Icon d={PHONE} />Call again
            </button>
          )}
          {idle && (
            <>
              <button type="button" data-testid="today-power" className="today-dark-secondary today-press" onClick={T.powerDial} disabled={!T.powerCount} style={darkSecondary}>
                <Icon d={POWER} />Power dial, {T.powerCount}
              </button>
              <button type="button" data-testid="today-call" className="today-primary today-press" onClick={lead.call} disabled={!lead.e164} style={{ ...primary, opacity: lead.e164 ? 1 : 0.5 }}>
                <Icon d={PHONE} />Call {lead.first}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function QueueWorked({ V }: { V: ClozrView }) {
  const T = V.today;
  return (
    <section aria-label="Queue finished" data-testid="today-worked" style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <div style={{ width: 560, maxWidth: '100%', background: 'var(--surface, #ffffff)', borderRadius: 14, padding: 28, display: 'flex', flexDirection: 'column', gap: 16, border: `1px solid ${LINE}` }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Queue worked</h2>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: INK2 }}>
          Every call ended with an outcome, a stage and a next step. Nothing is waiting on you to go back and log it.
        </p>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
          {T.results.map((r) => (
            <li key={r.pid} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 13, fontWeight: 500, padding: '8px 0', borderBottom: `1px solid ${LINE_SOFT}` }}>
              <span>{r.name}</span>
              <span style={{ color: MUTED, textAlign: 'right' }}>{r.label}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="today-secondary today-press" onClick={V.goTasks} style={{ alignSelf: 'flex-start', height: 36, padding: '0 14px', borderRadius: 6, border: `1px solid ${CONTROL}`, background: 'var(--surface, #ffffff)', color: INK, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
          Open Tasks
        </button>
      </div>
    </section>
  );
}

/** The right rail: the outcome picker for the seller in view. */
function Rail({ V, facts, onFocusNotes }: { V: ClozrView; facts?: Partial<Record<WrapKey, string>>; onFocusNotes: () => void }) {
  const T = V.today;
  const target = T.target;
  if (T.allDone) return <p style={{ margin: 0, padding: 20, fontSize: 13, fontWeight: 500, color: MUTED }}>Nothing left on today&rsquo;s list.</p>;
  if (!target) {
    return (
      <p style={{ margin: 0, padding: 20, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: MUTED }}>
        {V.callState !== 'idle'
          ? 'This call is not with a seller, so it is wrapped up in the dialer instead of here.'
          : 'Pick someone on the list to log how the call went.'}
      </p>
    );
  }
  const onCall = target.mode === 'call';
  return (
    <OutcomePicker
      key={target.key}
      V={V}
      target={target}
      variant="rail"
      armed={T.armed}
      canPick={T.armed || T.live}
      saveLabel={T.saveLabel}
      counter={T.counter}
      facts={facts}
      onFocusNotes={onFocusNotes}
      onCancel={target.mode === 'log' ? T.cancelLog : undefined}
      offer={T.offerOutcomes}
      plans={V.outcomeDrips}
    >
      {target.mode === 'idle' && (
        <div style={{ padding: '12px 20px 0' }}>
          <button type="button" data-testid="today-log" className="today-link" onClick={T.logWithoutCall} style={{ border: 0, background: 'none', padding: 0, color: MUTED, fontSize: 13, fontWeight: 500, cursor: 'pointer', minHeight: 32, textDecoration: 'underline', textUnderlineOffset: 3 }}>
            Log without calling
          </button>
        </div>
      )}
      {onCall && V.isWrap && (
        <div style={{ padding: '12px 20px 0' }}>
          <button type="button" data-testid="today-skip" className="today-link" onClick={V.dismissWrap} style={{ border: 0, background: 'none', padding: 0, color: MUTED, fontSize: 13, fontWeight: 500, cursor: 'pointer', minHeight: 32 }}>
            Close without an outcome
          </button>
        </div>
      )}
    </OutcomePicker>
  );
}

// ---- phone ----------------------------------------------------------------

function TodayPhone({ V }: { V: ClozrView }) {
  const T = V.today;
  const lead = T.lead;
  const barRef = useRef<HTMLDivElement>(null);
  const barShown = !V.phoneUp && !V.phoneCallMin && !!lead && !T.allDone;
  // The toast and anything else fixed to the bottom stand on the action bar, not behind it.
  useEffect(() => {
    const el = barRef.current;
    const root = document.documentElement;
    if (!barShown || !el) return;
    const ro = new ResizeObserver(() => root.style.setProperty('--clozr-todaybar', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--clozr-todaybar');
    };
  }, [barShown]);
  const sheetOpen = !!T.target && T.target.mode === 'log';
  const groups = T.rows.reduce<{ label: string; rows: Row[] }[]>((acc, r) => {
    if (r.groupStart) acc.push({ label: r.groupLabel, rows: [] });
    acc[acc.length - 1]!.rows.push(r);
    return acc;
  }, []);

  return (
    <section
      data-screen-label="Today"
      data-testid="today-root"
      className="today-root"
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--canvas, #fafafa)', color: INK, fontFamily: FONT, fontVariantNumeric: 'tabular-nums' }}
    >
      <header style={{ flexShrink: 0, boxSizing: 'border-box', minHeight: 60, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.01em' }}>Today</h1>
          <span data-testid="today-left" style={{ fontSize: 12, fontWeight: 500, color: MUTED }}>{T.allDone ? 'All done' : `${T.left} left`}</span>
        </div>
        <button
          type="button"
          data-testid="today-power"
          className="today-secondary today-press"
          onClick={T.powerDialAll}
          disabled={!T.left || V.callState !== 'idle'}
          style={{ marginLeft: 'auto', flexShrink: 0, height: 44, boxSizing: 'border-box', padding: '0 14px', display: 'flex', alignItems: 'center', gap: 8, borderRadius: 6, border: `1px solid ${CONTROL}`, background: 'var(--surface, #ffffff)', color: INK, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: !T.left ? 0.5 : 1 }}
        >
          <Icon d={POWER} />Power dial
        </button>
      </header>

      <div aria-label="Today's list" style={{ flex: 1, minHeight: 0, overflowY: 'auto', boxSizing: 'border-box', padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ margin: '0 -16px' }}><Focus V={V} /></div>
        {T.total === 0 && (
          <p style={{ margin: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: MUTED }}>
            Nothing on your list. New leads, tasks due today and offers waiting on an answer land here.
          </p>
        )}
        {T.allDone && (
          <div data-testid="today-worked" style={{ background: 'var(--surface, #ffffff)', border: `1px solid ${LINE}`, borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Queue worked</h2>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: INK2 }}>Every call ended with an outcome and a next step.</p>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600, lineHeight: 1.4, color: MUTED }}>{g.label}</h2>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {g.rows.map((r) => (
                <li key={r.pid}>
                  <button
                    type="button"
                    className="today-row"
                    data-testid={`today-row-${r.pid}`}
                    aria-current={r.current ? 'true' : undefined}
                    title={r.done ? CHANGE_OUTCOME : undefined}
                    onClick={r.pick}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 2, width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10,
                      border: `1px solid ${r.current ? MINT_LINE : LINE}`, background: r.current ? MINT_TINT : 'var(--surface, #ffffff)', textAlign: 'left', color: INK, minHeight: 44,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 12, width: '100%' }}>
                      <span style={{ flexGrow: 1, minWidth: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                      <span data-testid={`today-tag-${r.pid}`} style={{ flexShrink: 0, fontSize: 12, fontWeight: r.tone === 'money' || r.tone === 'due' || r.tone === 'overdue' ? 600 : 500, lineHeight: 1.4, color: TAG_COLOR[r.tone] ?? MUTED }}>{r.tagText}</span>
                    </span>
                    <span data-testid={r.done ? 'today-done' : undefined} style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4, color: r.done ? MINT_TEXT : INK2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{r.line}</span>
                    {r.address && <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.4, color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{r.address}</span>}
                  </button>
                </li>
              ))}
              {g.label === 'Call now' && T.more > 0 && (
                <li>
                  <button type="button" className="today-link" onClick={T.openMore} style={{ border: 0, background: 'none', padding: 0, minHeight: 44, color: MINT_TEXT, fontSize: 13, fontWeight: 500 }}>
                    {T.more} more in People, New leads
                  </button>
                </li>
              )}
            </ul>
          </section>
        ))}
        {T.total > 0 && <p data-testid="today-source" style={{ margin: 0, fontSize: 12, fontWeight: 500, color: SUBTLE }}>{T.sourceLabel}</p>}
        <MyWork V={V} size="phone" />
      </div>

      {barShown && lead && (
        <div ref={barRef} data-testid="today-bar" style={{ flexShrink: 0, background: 'var(--surface, #ffffff)', borderTop: `1px solid ${LINE}` }}>
          <section aria-label={`Actions for ${lead.name}`} style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <button type="button" onClick={lead.open} aria-label={`Open record for ${lead.name}`} className="today-link" style={{ minHeight: 44, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, border: 0, background: 'none', padding: 0, color: INK, fontSize: 15, fontWeight: 600, lineHeight: 1.3, cursor: 'pointer' }}>
                <span data-testid="today-bar-name" style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lead.name}</span>
                <Icon d={CHEVRON} color={MUTED} />
              </button>
              <span data-testid="today-bar-phone" style={{ flexShrink: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.4, color: LINK_BLUE }}>{lead.e164 ? lead.phone : 'No number'}</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" data-testid="today-call" className="today-primary today-press" onClick={lead.call} disabled={!lead.e164 || V.callState !== 'idle'} style={{ ...primary, flexGrow: 1, minWidth: 0, height: 44, justifyContent: 'center', opacity: lead.e164 ? 1 : 0.5 }}>
                <Icon d={PHONE} />Call
              </button>
              <button type="button" data-testid="today-text" className="today-secondary today-press" onClick={lead.text} style={{ flexShrink: 0, height: 44, boxSizing: 'border-box', padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 6, border: `1px solid ${CONTROL}`, background: 'var(--surface, #ffffff)', color: INK, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>
                <Icon d={TEXT} />Text
              </button>
              <button type="button" data-testid="today-log" className="today-secondary today-press" onClick={T.logWithoutCall} disabled={V.callState !== 'idle'} style={{ flexShrink: 0, height: 44, boxSizing: 'border-box', padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 6, border: `1px solid ${CONTROL}`, background: 'var(--surface, #ffffff)', color: INK, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', opacity: V.callState !== 'idle' ? 0.5 : 1 }}>
                <Icon d={LOG} />Log outcome
              </button>
            </div>
          </section>
        </div>
      )}

      {sheetOpen && T.target && (
        <>
          <div onClick={T.cancelLog} aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(24,24,27,.35)', zIndex: 70 }} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Log outcome for ${T.target.name}`}
            data-testid="today-sheet"
            className="today-sheet"
            style={{
              position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 71, maxHeight: '88dvh', overflowY: 'auto', boxSizing: 'border-box',
              background: 'var(--surface, #ffffff)', borderRadius: '14px 14px 0 0', padding: '16px 16px max(env(safe-area-inset-bottom, 0px), 16px)',
              boxShadow: '0 2.8px 2.2px rgba(0,0,0,0.034), 0 6.7px 5.3px rgba(0,0,0,0.048), 0 12.5px 10px rgba(0,0,0,0.06), 0 22.3px 17.9px rgba(0,0,0,0.072), 0 41.8px 33.4px rgba(0,0,0,0.086), 0 100px 80px rgba(0,0,0,0.12)',
            }}
          >
            <OutcomePicker
              key={T.target.key}
              V={V}
              target={T.target}
              variant="sheet"
              armed
              heading={`Log outcome for ${T.target.first}`}
              saveLabel={T.saveLabel.replace(/^Log for .*/, 'Save')}
              onCancel={T.cancelLog}
              offer={T.offerOutcomes}
              plans={V.outcomeDrips}
            />
          </div>
        </>
      )}
    </section>
  );
}
