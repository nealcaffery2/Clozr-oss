// The calendar: every rep's appointments and due tasks, month / week / day,
// kept level with Google Calendar both ways.
//
// Layout reads like Google Calendar (sidebar mini-month, large title, round
// today badge, solid event blocks). Chrome — Today, arrows, view swapper,
// buttons — uses the shared iPhone look from ds/chrome.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { useSession } from '@/lib/session';
import {
  type CalEvent, type EventType, EVENT_TYPES, addDays, addMonths, fmtMonth, monthGrid, startOfDay, startOfMonth, startOfWeek,
  useCalendar, useTeam,
} from '@/lib/calendar';
import { type GoogleStatus, googleStatus, syncGoogle } from '@/lib/google';
import { GoogleConnect } from '@/components/GoogleConnect';
import { EventPanel, type PanelDraft } from '@/app/components/calendar/EventPanel';
import { MonthView } from '@/app/components/calendar/MonthView';
import { WeekView } from '@/app/components/calendar/WeekView';
import { MiniMonth } from '@/app/components/calendar/MiniMonth';
import { Avatar, Chip, INK, LINE, MINT, MUTED, SOFT, ago, ghost } from '@/app/components/calendar/ui';
import { Chevron, CZ, darkBtn, ghostBtn, seg, segWrap } from '@/components/ds/chrome';

type View = 'month' | 'week' | 'day';

export function Calendar({ V }: { V: ClozrView }) {
  const s = useSession();
  const workspaceId = s.workspace?.id ?? null;
  const userId = s.user?.id ?? null;
  const canWrite = V.liveIds?.canWrite ?? !s.demo;

  const [view, setView] = useState<View>('week');
  const [cursor, setCursor] = useState<Date>(() => startOfDay(new Date()));
  const [reps, setReps] = useState<Set<string> | null>(null); // null = everyone
  const [types, setTypes] = useState<Set<EventType>>(() => new Set(EVENT_TYPES.map((t) => t.key)));
  const [open, setOpen] = useState<{ event: CalEvent | null; draft: PanelDraft | null; key: string } | null>(null);
  const [google, setGoogle] = useState<{ key: number | null; v: GoogleStatus } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  // The phone's appointment sheet: whether its form has unsaved changes, and
  // whether a backdrop tap is asking to throw them away.
  const sheetDirty = useRef(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const closeSheet = () => { sheetDirty.current = false; setAskDiscard(false); setOpen(null); };

  // The visible range. Month shows six weeks; week and day their own span.
  const range = useMemo(() => {
    if (view === 'month') { const g = monthGrid(cursor); return { from: g[0], to: addDays(g[41], 1) }; }
    if (view === 'week') { const f = startOfWeek(cursor); return { from: f, to: addDays(f, 7) }; }
    return { from: startOfDay(cursor), to: addDays(startOfDay(cursor), 1) };
  }, [view, cursor]);

  const cal = useCalendar(workspaceId, range.from, range.to);
  const team = useTeam(workspaceId, userId);

  // The connection: who is connected, when it last synced.
  const account = google && google.key === workspaceId ? google.v.account : null;
  const refreshGoogle = React.useCallback(async () => {
    if (!workspaceId) return;
    const r = await googleStatus(workspaceId);
    if (r.ok) setGoogle({ key: workspaceId, v: r.data });
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId || s.demo) return;
    let live = true;
    void googleStatus(workspaceId).then((r) => { if (live && r.ok) setGoogle({ key: workspaceId, v: r.data }); });
    return () => { live = false; };
  }, [workspaceId, s.demo]);

  async function syncNow() {
    if (!workspaceId) return;
    setSyncing(true); setSyncNote(null);
    const r = await syncGoogle(workspaceId);
    setSyncing(false);
    if (!r.ok) { setSyncNote(r.message); return; }
    if (!r.data.connected) { setSyncNote('Google is not connected.'); return; }
    const c = r.data.calendar;
    const bits: string[] = [];
    if (c) {
      const out = c.created + c.updated + c.removed;
      if (out) bits.push(`${out} to Google`);
      const back = c.applied + c.added + c.deleted;
      if (back) bits.push(`${back} from Google`);
      if (c.invited) bits.push(`${c.invited} invited`);
    }
    setSyncNote(r.data.ok === false ? (r.data.message ?? 'Sync hit an error.') : bits.length ? `Synced · ${bits.join(', ')}` : 'Up to date');
    cal.reload();
    void refreshGoogle();
  }

  // Filters.
  const shown = useMemo(() => cal.events.filter((ev) =>
    types.has(ev.type) && (reps === null || (ev.repId ? reps.has(ev.repId) : true)),
  ), [cal.events, types, reps]);
  const repOn = (id: string) => reps === null || reps.has(id);
  const toggleRep = (id: string) => setReps((cur) => {
    const all = new Set(team.map((t) => t.user_id));
    const next = new Set(cur ?? all);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next.size === all.size ? null : next;
  });
  const onlyMe = () => setReps(userId ? new Set([userId]) : null);
  const toggleType = (t: EventType) => setTypes((cur) => { const n = new Set(cur); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const countFor = (t: EventType) => cal.events.filter((e) => e.type === t).length;

  // Navigation.
  const step = (n: number) => setCursor((c) => view === 'month' ? addMonths(c, n) : addDays(c, n * (view === 'week' ? 7 : 1)));
  const title = view === 'month' ? fmtMonth(cursor)
    : view === 'week' ? (() => { const a = startOfWeek(cursor); const b = addDays(a, 6); const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); return `${f(a)} – ${a.getMonth() === b.getMonth() ? b.getDate() : f(b)}, ${b.getFullYear()}`; })()
    : cursor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const openEvent = (ev: CalEvent) => setOpen({ event: ev, draft: null, key: ev.id });
  const create = (start: Date, end: Date) => {
    if (!canWrite) { V.showToast('Sign in to add appointments'); return; }
    setOpen({ event: null, draft: { start, end }, key: `new:${start.getTime()}` });
  };
  const addNow = () => { const st = new Date(); st.setMinutes(Math.ceil(st.getMinutes() / 30) * 30, 0, 0); create(st, new Date(st.getTime() + 3_600_000)); };
  const busyDays = useMemo(() => new Set(cal.events.map((e) => `${e.start.getFullYear()}-${e.start.getMonth()}-${e.start.getDate()}`)), [cal.events]);
  const openSeller = (sellerId: number) => V.openPerson('s' + sellerId);

  return (
    <section data-screen-label="Calendar" className="clozr-cal" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--surface, #fff)' }}>
      {/* Google Calendar–style top bar */}
      <div data-head style={{
        display: 'flex', alignItems: 'center', gap: V.isMobile ? 6 : 10,
        padding: V.isMobile ? '8px 12px' : '8px 16px 8px 12px',
        background: 'var(--surface, #fff)', borderBottom: `1px solid ${LINE}`, flexWrap: 'wrap', minHeight: 64,
      }}>
        <h1 style={{ margin: 0, font: '400 22px/1.2 var(--font-sans)', letterSpacing: 0, color: 'var(--ink-4, #3c4043)', paddingLeft: V.isMobile ? 0 : 4 }}>
          Calendar
        </h1>

        <button type="button" className="dc2 cz-btn" onClick={() => setCursor(startOfDay(new Date()))} style={{ ...ghostBtn, height: 36, borderRadius: 18, borderColor: LINE, fontWeight: 500, marginLeft: 4 }}>
          Today
        </button>

        <div style={{ display: 'inline-flex', alignItems: 'center' }}>
          <button type="button" className="cz-icon-btn" onClick={() => step(-1)} aria-label="Previous">
            <Chevron dir="left" size={18} color="var(--ink-4, #3c4043)" />
          </button>
          <button type="button" className="cz-icon-btn" onClick={() => step(1)} aria-label="Next">
            <Chevron dir="right" size={18} color="var(--ink-4, #3c4043)" />
          </button>
        </div>

        <span style={{ font: '400 22px/1.2 var(--font-sans)', color: 'var(--ink-4, #3c4043)', letterSpacing: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>

        <span style={{ font: '400 12px/1 var(--font-sans)', color: MUTED, display: V.isMobile ? 'none' : 'inline' }}>
          {cal.loading ? 'Loading…' : `${shown.length} on view`}
        </span>

        <div style={{ flex: 1 }} />

        {!s.demo && workspaceId ? (
          account ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, font: '500 12px/1 var(--font-sans)', color: MUTED }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: account.status === 'active' ? '#16a34a' : '#d97706' }} />
              <span style={{ display: V.isMobile ? 'none' : 'inline' }}>
                {account.status === 'active' ? `Google · synced ${ago(account.last_calendar_sync_at)}` : 'Google needs reconnecting'}
              </span>
              <button type="button" className="dc2 cz-btn" onClick={() => void syncNow()} disabled={syncing} style={{ ...ghostBtn, height: 32, borderColor: LINE }}>
                {syncing ? 'Syncing…' : 'Sync'}
              </button>
            </span>
          ) : google ? (
            <button type="button" className="dc2 cz-btn" onClick={() => setConnectOpen((v) => !v)} style={{ ...ghostBtn, height: 32, borderColor: '#f59e0b', color: 'var(--tx-amber, #b45309)' }}>
              Connect Google
            </button>
          ) : null
        ) : null}

        <div role="tablist" aria-label="Calendar view" style={segWrap}>
          {(['month', 'week', 'day'] as View[]).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} style={seg(view === v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>

        <button type="button" className="dc10" onClick={addNow} style={{ ...darkBtn, height: 36, borderRadius: 18, padding: '0 16px' }}>
          + Create
        </button>
      </div>

      {syncNote ? (
        <div style={{ padding: '6px 16px', font: '500 12px/1.3 var(--font-sans)', color: syncNote.startsWith('Synced') || syncNote === 'Up to date' ? MINT : '#b45309', background: 'var(--surface, #fff)', borderBottom: `1px solid ${SOFT}` }}>
          {syncNote}
        </div>
      ) : null}

      {connectOpen || (google && google.key === workspaceId && !google.v.account && google.v.configured && !V.isMobile && cal.events.length === 0) ? (
        <div style={{ padding: '14px 20px 0', maxWidth: 720 }}>
          <GoogleConnect workspaceId={workspaceId} demo={s.demo} userId={userId} />
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {!V.isMobile ? (
          <aside style={{ width: 256, flex: 'none', background: 'var(--surface, #fff)', borderRight: `1px solid ${LINE}`, padding: '12px 14px', overflow: 'auto' }}>
            <button type="button" className="dc10" onClick={addNow} style={{ ...darkBtn, width: '100%', height: 48, borderRadius: 24, marginBottom: 12, boxShadow: '0 1px 2px rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15)', justifyContent: 'flex-start', padding: '0 18px', gap: 12 }}>
              <span style={{ fontSize: 22, fontWeight: 300, lineHeight: 1 }}>+</span> Create
            </button>

            <MiniMonth month={startOfMonth(cursor)} selected={cursor} busyDays={busyDays} onPick={(d) => { setCursor(d); if (view === 'month') setView('day'); }} onMonth={(m) => setCursor(m)} />

            <div style={{ marginTop: 18, paddingTop: 12, borderTop: `1px solid ${SOFT}` }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ font: '500 11px/1 var(--font-sans)', color: MUTED, flex: 1, letterSpacing: '.02em' }}>My calendars</span>
                <button type="button" onClick={() => (reps === null ? onlyMe() : setReps(null))} style={{ background: 'none', border: 0, font: '600 11.5px/1 var(--font-sans)', color: MINT, cursor: 'pointer', padding: 0 }}>
                  {reps === null ? 'Just me' : 'Everyone'}
                </button>
              </div>
              {team.length ? team.map((t) => (
                <button key={t.user_id} type="button" className="dc2" onClick={() => toggleRep(t.user_id)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 32, padding: '0 4px',
                  border: 0, borderRadius: 8, cursor: 'pointer', background: 'none',
                  font: '400 13px/1 var(--font-sans)', color: repOn(t.user_id) ? INK : CZ.faint, textAlign: 'left',
                }}>
                  <span style={{
                    width: 14, height: 14, borderRadius: 2, flex: 'none', boxSizing: 'border-box',
                    background: repOn(t.user_id) ? t.color : 'var(--surface, #fff)',
                    border: `2px solid ${t.color}`,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {repOn(t.user_id) ? (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--on-dark, #fff)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    ) : null}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.user_id === userId ? 'My calendar' : t.full_name}
                  </span>
                  <Avatar initials={t.initials} color={repOn(t.user_id) ? t.color : 'var(--line-2, #dadce0)'} size={20} />
                </button>
              )) : (
                <p style={{ margin: 0, font: '400 12px/1.4 var(--font-sans)', color: CZ.faint }}>
                  {s.demo ? 'Sign in to see teammates.' : 'Just you so far.'}
                </p>
              )}
            </div>

            <div style={{ marginTop: 18, paddingTop: 12, borderTop: `1px solid ${SOFT}` }}>
              <span style={{ display: 'block', font: '500 11px/1 var(--font-sans)', color: MUTED, marginBottom: 6, letterSpacing: '.02em' }}>Show</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                {EVENT_TYPES.map((t) => <Chip key={t.key} on={types.has(t.key)} color={t.color} label={t.label} count={countFor(t.key)} onClick={() => toggleType(t.key)} />)}
              </div>
            </div>
          </aside>
        ) : null}

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', padding: V.isMobile ? '0 0 24px' : '0' }}>
          {V.isMobile ? (
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '8px 12px', flex: 'none', borderBottom: `1px solid ${SOFT}` }}>
              {EVENT_TYPES.map((t) => <Chip key={t.key} on={types.has(t.key)} color={t.color} label={t.label} onClick={() => toggleType(t.key)} />)}
            </div>
          ) : null}
          {!cal.ok ? (
            <div style={{ padding: 20, textAlign: 'center', font: '400 12.5px/1.4 var(--font-sans)', color: 'var(--tx-red, #b91c1c)' }}>
              Couldn&rsquo;t load the calendar{cal.message ? ` — ${/column .* does not exist/i.test(cal.message) ? 'the database is missing the calendar sync columns (apply migration 35)' : cal.message}` : ''}.{' '}
              <button type="button" onClick={cal.reload} style={{ ...ghost, height: 28, marginLeft: 8 }}>Retry</button>
            </div>
          ) : null}
          {view === 'month' ? (
            <MonthView month={startOfMonth(cursor)} events={shown} reps={team} selectedId={open?.event?.id ?? null} onOpen={openEvent} onCreate={create} compact={V.isMobile} />
          ) : (
            <WeekView start={view === 'week' ? startOfWeek(cursor) : startOfDay(cursor)} days={view === 'week' && !V.isMobile ? 7 : 1} events={shown} reps={team} selectedId={open?.event?.id ?? null} onOpen={openEvent} onCreate={create} />
          )}
          {!cal.loading && cal.ok && cal.events.length === 0 && !s.demo ? (
            <p style={{ margin: '10px 0 0', font: '400 12px/1.4 var(--font-sans)', color: CZ.faint, textAlign: 'center' }}>
              Nothing in this {view}. Drag across a time on the grid, or press <strong>+ Create</strong>. Dated tasks show here too.
            </p>
          ) : null}
        </div>

        {open ? (
          V.isMobile ? (
            // A tap on the dimmed backdrop closes the sheet only when nothing in
            // it was changed; with an unsaved appointment it asks first, since a
            // stray tap used to throw the new appointment away without a word.
            <div onClick={() => (sheetDirty.current ? setAskDiscard(true) : closeSheet())} style={{ position: 'fixed', inset: 0, background: 'rgba(24,24,27,.35)', zIndex: 40, display: 'flex', alignItems: 'flex-end' }}>
              <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', background: 'var(--surface, #fff)', borderRadius: '14px 14px 0 0', overflow: 'hidden' }}>
                {askDiscard ? (
                  <div role="alert" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--caution-soft, #fef3c7)', borderBottom: `1px solid ${LINE}`, font: '500 13px/1.35 var(--font-sans)', color: INK }}>
                    <span style={{ flex: 1, minWidth: 0 }}>Discard your changes to this appointment?</span>
                    <button type="button" onClick={() => setAskDiscard(false)} style={{ ...ghost, height: 32 }}>Keep editing</button>
                    <button type="button" onClick={closeSheet} style={{ ...ghost, height: 32, color: 'var(--tx-red, #b91c1c)' }}>Discard</button>
                  </div>
                ) : null}
                <EventPanel key={open.key} workspaceId={workspaceId} userId={userId} reps={team} canWrite={canWrite} event={open.event} draft={open.draft} onClose={closeSheet} onChanged={cal.reload} onToast={V.showToast} onOpenSeller={openSeller} onDirty={(d) => { sheetDirty.current = d; if (!d) setAskDiscard(false); }} inline />
              </div>
            </div>
          ) : (
            <EventPanel key={open.key} workspaceId={workspaceId} userId={userId} reps={team} canWrite={canWrite} event={open.event} draft={open.draft} onClose={() => setOpen(null)} onChanged={cal.reload} onToast={V.showToast} onOpenSeller={openSeller} />
          )
        ) : null}
      </div>
    </section>
  );
}
