// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { Empty, EmptyRow } from '@/components/ds/Empty';
import { Chevron, CZ, trayBtn } from '@/components/ds/chrome';
import type { ClozrView } from '@/app/clozr/view';
import { Mark } from '@/components/ds/mark';
import { taskLook } from '@/lib/task-views';
import { READ_ONLY_TITLE, useCanWrite } from '@/lib/read-only-context';
import { ScreenHeader } from '@/components/ds/Screen';
import { Button } from '@/components/ds/Button';
import { SectionLabel } from '@/components/ds/Text';
import { Plus } from 'lucide-react';
import { textTone } from '@/lib/text-tone';

// A ticked task fades and slides out before it leaves the list (useClozr taskLeaving).
const LEAVE_CSS = `
@keyframes taskLeave { 0% { opacity: 1; transform: none; } 35% { opacity: 1; background: var(--mint-dim, #e7f8f1); } 100% { opacity: 0; transform: translateX(24px); } }
.task-leaving, .task-leaving > td { animation: taskLeave .5s ease forwards; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .task-leaving, .task-leaving > td { animation-duration: .01s; } }
`;

// Offscreen tasks skip style, layout and paint (content-visibility). A table
// row cannot be skipped, so on the desk the rows sit in tables of CHUNK rows
// inside skippable blocks. The header table sizes the columns from every
// task's text, as the one table did (SizerRow), and each block copies its
// column widths (--tc0 to --tc8), so the columns come out the same. Phone
// cards (here, Buyers, Dispo) also carry flexShrink 0: a skipped card has no
// content height to keep the flex column from shrinking it.
const CHUNK = 50;
const TASK_COLS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

export function Tasks({ V }: { V: ClozrView }) {
  const rows = V.taskRows || [];
  // The rows' handlers as of the last render, by task id: a row that did not
  // redraw still calls the current ones.
  const latest = React.useRef(new Map<string, TaskRow>());
  const act = React.useCallback<TaskAct>((id, what) => { latest.current.get(id)?.[what](); }, []);
  React.useLayoutEffect(() => { latest.current = new Map(rows.map((t) => [t.id, t])); });
  // A task opened from the command bar: bring its row into view once.
  const focusId = rows.find((t) => t.focused)?.id;
  React.useEffect(() => {
    if (focusId) document.querySelector('[data-task-focus="true"]')?.scrollIntoView({ block: 'center' });
  }, [focusId]);
  // The header table's widths, copied to the row blocks before every paint
  // (ResizeObserver runs after layout, before paint).
  const head = React.useRef<HTMLTableElement>(null);
  React.useLayoutEffect(() => {
    const table = head.current;
    const box = table?.closest<HTMLElement>('[role="table"]');
    if (!table || !box) return;
    const cells = Array.from(table.rows[0].cells);
    const sync = () => {
      box.style.setProperty('--tw', `${table.getBoundingClientRect().width}px`);
      cells.forEach((c, i) => box.style.setProperty(`--tc${i}`, `${c.getBoundingClientRect().width}px`));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(table);
    cells.forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [V.isMobile]);
  const chunks: TaskRow[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));
  return (
    <section data-screen-label="Tasks" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: V.isMobile ? "column" : "row"}}>
      <style>{LEAVE_CSS}</style>
      {(!V.isMobile) ? (
        <>
      <aside style={{width: "210px", flex: "none", background: "var(--surface, #fff)", borderRight: "1px solid var(--divider, #e4e4e7)", padding: "14px 10px"}}>
        <SectionLabel style={{padding: "0 8px 8px"}}>Tasks</SectionLabel>
        {(V.tasksViews || []).map((v, v__i) => (
          <React.Fragment key={v__i}>
          <button className="dc2" onClick={v.go} style={{display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", height: "30px", padding: "0 8px", border: "0", borderRadius: "7px", cursor: "pointer", fontSize: "13px", textAlign: "left", background: v.bg, color: v.color, fontWeight: "500"}}>
            <span>
              {v.label}
            </span>
            <span style={{fontSize: "11.5px", color: "var(--meta, #71717a)"}}>
              {v.count}
            </span>
          </button>
          </React.Fragment>
        ))}
        {V.can.automations ? (
        <div style={{margin: "14px 8px 0", paddingTop: "12px", borderTop: "1px solid var(--divider-2, #f0f0f1)"}}>
          <button className="dc2" onClick={V.goAutomations} style={{display: "flex", alignItems: "center", gap: "7px", width: "100%", height: "30px", padding: "0 8px", border: "0", borderRadius: "7px", cursor: "pointer", fontSize: "13px", textAlign: "left", background: "none", color: "var(--ink-2, #27272a)", fontWeight: "500"}}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
            </svg>
            Automations
          </button>
        </div>
        ) : null}
      </aside>
        </>
      ) : null}
      {(V.isMobile) ? (
        <>
        <div style={{flex: "none", background: "var(--surface, #fff)", borderBottom: "1px solid var(--divider, #e4e4e7)", padding: "10px 0 10px 12px"}}>
          <div style={{display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 8px", paddingRight: "12px"}}>
            <span style={{fontSize: "19px", fontWeight: "700", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums"}}>
              Tasks
            </span>
            <span style={{fontSize: "12.5px", color: "var(--meta, #71717a)", whiteSpace: "nowrap"}}>
              {V.taskCount} in {V.tasksView.toLowerCase()}
            </span>
            {/* Drops under the title on a narrow phone rather than squeezing the count. */}
            <span style={{marginLeft: "auto", display: "inline-flex", gap: "6px", alignItems: "center"}}>
              <CompleteShown V={V} />
              <button className="dc10" onClick={V.addTask} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap"}}>
                + Task
              </button>
            </span>
          </div>
          <div style={{display: "flex", gap: "6px", overflowX: "auto", marginTop: "9px", paddingRight: "12px", paddingBottom: "2px"}}>
            {(V.tasksViews || []).map((v, v__i) => (
              <React.Fragment key={v__i}>
              <button type="button" onClick={v.go} style={{...trayBtn(v.on), ...(v.on ? { background: 'var(--ink, #18181b)', color: 'var(--surface, #fff)' } : null)}}>
                {v.label}
                <span style={{fontSize: "11px", opacity: ".65"}}>
                  {v.count}
                </span>
              </button>
              </React.Fragment>
            ))}
          </div>
        </div>
        </>
      ) : null}
      <div style={{flex: "1", minWidth: "0", minHeight: "0", display: "flex", flexDirection: "column"}}>
        <ScreenHeader title="Tasks" meta={`${V.taskCount} in ${V.tasksView.toLowerCase()}`} actions={<>
          {/* A phone keeps its view chips below; the filter menus and plans are desk tools. */}
          {V.isMobile ? null : <>
          {(V.taskMenus || []).map((f, f__i) => (
            <React.Fragment key={f__i}>
            <div style={{position: "relative"}}>
              <button className="dc2 cz-menu-trigger" onClick={f.toggle} style={{height: "32px", padding: "0 10px", borderRadius: "10px", border: `1px solid ${f.border}`, background: f.bg, fontSize: "12.5px", cursor: "pointer", color: f.color, fontWeight: f.on ? "600" : "500", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px", fontFamily: "var(--font-sans)"}}>
                {f.on ? f.value : f.label}
                <Chevron size={11} color={f.on ? CZ.mint : CZ.faint} />
              </button>
              {(f.open) ? (
                <>
                <div onClick={V.closeFilterMenus} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
                <div ref={keepInView} className="cz-menu cz-menu--left" style={{top: "38px", left: "0", minWidth: "208px", maxHeight: "min(340px, 46vh)", overflow: "auto"}}>
                  {(f.options || []).map((o, o__i) => (
                    <React.Fragment key={o__i}>
                    <button type="button" className={"dc2 cz-menu-item" + (o.on ? " is-on" : "")} onClick={o.go}>
                      {o.label}
                      {(o.on) ? (
                        <>
                        <span style={{fontSize: "11px"}}>
                          ✓
                        </span>
                        </>
                      ) : null}
                    </button>
                    </React.Fragment>
                  ))}
                </div>
                </>
              ) : null}
            </div>
            </React.Fragment>
          ))}
          <CompleteShown V={V} />
          {V.can.plans ? (
          <button className="dc2" onClick={V.goPlans} style={{height: "32px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", cursor: "pointer", color: "var(--ink, #18181b)", whiteSpace: "nowrap"}}>
            Action plans
          </button>
          ) : null}
          </>}
          <Button kind="primary" onClick={V.addTask} icon={<Plus size={13} aria-hidden />}>Task</Button>
        </>} />
        {(V.isMobile) ? (
          <>
          {/* A phone gets cards, not the nine-column table: the title column
              crushed to one word per line and everything from TYPE rightwards
              sat off the screen with nothing to scroll. */}
          <div style={{flex: "1", overflow: "auto", background: "var(--canvas, #fafafa)", padding: "10px 12px calc(96px + env(safe-area-inset-bottom, 0px))", display: "flex", flexDirection: "column", gap: "8px"}}>
            {rows.map((t, t__i) => <TaskItem key={t__i} t={t} phone act={act} />)}
            {rows.length === 0 ? (
              <Empty
                title={V.crmOk ? 'Nothing due' : ''}
                hint={'Tasks appear here when you create one or an action plan fires.'}
                failed={!V.crmOk}
                onRetry={V.reloadCrm}
                action={V.addTask}
                actionLabel={'Add a task'}
              />
            ) : null}
          </div>
          </>
        ) : (
        <div style={{flex: "1", overflow: "auto", background: "var(--surface, #fff)"}}>
          <div role="table">
          <div style={{position: "sticky", top: "0", zIndex: 1}}>
          <table ref={head} role="presentation" style={{width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px"}}>
            <thead>
              <tr role="row">
                <th role="columnheader" style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", width: "40px", height: "36px"}}></th>
                {(V.taskCols || []).map((c, c__i) => (
                  <React.Fragment key={c__i}>
                  <th role="columnheader" style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", padding: "0 12px", height: "36px", textAlign: "left", fontSize: "11.5px", fontWeight: "600", color: "var(--muted, #52525b)", whiteSpace: "nowrap"}}>
                    {c}
                  </th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length ? <SizerRow rows={rows} /> : null}
              {rows.length === 0 ? (
                <EmptyRow
                  colSpan={(V.taskCols || []).length || 1}
                  title={V.crmOk ? 'Nothing due' : ''}
                  hint={'Tasks appear here when you create one or an action plan fires.'}
                  failed={!V.crmOk}
                  onRetry={V.reloadCrm}
                  action={V.addTask}
                  actionLabel={'Add a task'}
                />
              ) : null}
            </tbody>
          </table>
          </div>
          {chunks.map((part, ci) => (
            <div key={ci} style={{width: "var(--tw)", contentVisibility: "auto", containIntrinsicHeight: `auto ${part.length * 44}px`}}>
              <table role="presentation" style={{width: "100%", tableLayout: "fixed", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px"}}>
                <colgroup>{TASK_COLS.map((i) => <col key={i} style={{width: `var(--tc${i})`}} />)}</colgroup>
                <tbody>
                  {part.map((t, t__i) => <TaskItem key={t__i} t={t} phone={false} act={act} />)}
                </tbody>
              </table>
            </div>
          ))}
          </div>
        </div>
        )}
      </div>
    </section>
  );
}

/**
 * "Complete all shown (N)": ticks every open task the view and its filters
 * list, after asking (useClozr completeShown). Gone when none are open, and
 * off with the read-only tooltip while an admin previews a teammate.
 */
function CompleteShown({ V }: { V: ClozrView }) {
  const canWrite = useCanWrite();
  const n = V.taskOpenShown;
  if (!n) return null;
  return (
    <button type="button" className={canWrite ? 'dc2' : undefined} disabled={!canWrite} title={canWrite ? undefined : READ_ONLY_TITLE} onClick={() => void V.completeShown()} style={{height: "32px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", cursor: canWrite ? "pointer" : "not-allowed", opacity: canWrite ? 1 : 0.45, color: "var(--ink, #18181b)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums"}}>
      Complete all shown ({n.toLocaleString()})
    </button>
  );
}

type TaskRow = ClozrView['taskRows'][number];
type TaskAct = (id: string, what: 'toggle' | 'open' | 'call' | 'snooze' | 'edit') => void;

/** A row redraws only when what it shows changes; its handlers are read at click time (act). */
function sameRow(a: { t: TaskRow; phone: boolean; act: TaskAct }, b: { t: TaskRow; phone: boolean; act: TaskAct }) {
  return a.phone === b.phone && a.act === b.act
    && (Object.keys(a.t) as (keyof TaskRow)[]).every((k) => typeof a.t[k] === 'function' || a.t[k] === b.t[k]);
}

/**
 * One task, a table row on the desk and a card on the phone. The tick shows
 * the moment it is clicked (useOptimistic) while the workspace view rebuilds
 * in a transition (useClozr toggleTaskDone); a closed task starts fading out
 * at once, as it leaves every list but Completed. A rebuild that leaves the
 * row as it was does not redraw it (sameRow).
 */
const TaskItem = React.memo(function TaskItem({ t, phone, act }: { t: TaskRow; phone: boolean; act: TaskAct }) {
  // Rows are keyed by position, as they always were: a tick held for another
  // task (a load landed and moved the rows under it) is not carried over.
  const [held, setHeld] = React.useOptimistic({ id: t.id, done: t.done, leaving: t.leaving });
  const mark = held.id === t.id ? held : { id: t.id, done: t.done, leaving: t.leaving };
  const look = taskLook(mark.done, t.due, t.bucket);
  const toggle = () => React.startTransition(() => {
    setHeld({ id: t.id, done: !mark.done, leaving: !mark.done });
    act(t.id, 'toggle');
  });
  const open = () => act(t.id, 'open');
  const call = () => act(t.id, 'call');
  const snooze = () => act(t.id, 'snooze');
  const edit = () => act(t.id, 'edit');
  if (phone) return (
    <div data-task-focus={t.focused || undefined} className={mark.leaving ? 'task-leaving' : undefined} style={{background: t.focused ? "var(--mint-dim, #e7f8f1)" : "var(--surface, #fff)", border: t.focused ? "1px solid #0A8560" : "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", padding: "11px 12px", display: "flex", flexDirection: "column", gap: "8px", minWidth: "0", flexShrink: 0, contentVisibility: "auto", containIntrinsicHeight: "auto 116px"}}>
      <div style={{display: "flex", alignItems: "flex-start", gap: "10px", minWidth: "0"}}>
        <input type="checkbox" checked={!!(mark.done)} onChange={toggle} aria-label={`Mark done: ${t.title}`} style={{width: "18px", height: "18px", flex: "none", marginTop: "1px", accentColor: "#16a34a", cursor: "pointer"}} />
        <div onClick={open} style={{flex: "1", minWidth: "0", cursor: "pointer"}}>
          <div className="t-name" style={{color: look.textColor, textDecoration: look.deco}}>
            {t.title}
          </div>
          {(t.hasNote) ? (
            <div style={{fontSize: "12.5px", color: "var(--meta, #71717a)", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
              {t.note}
            </div>
          ) : null}
        </div>
        <span style={{flex: "none", display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: "600", color: t.prColor, whiteSpace: "nowrap", marginTop: "2px"}}>
          <Mark label={t.priority} />
          {t.priority}
        </span>
      </div>
      <div style={{display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", fontSize: "12.5px", minWidth: "0"}}>
        <span onClick={open} style={{color: "var(--tx-mint, #0a8560)", fontWeight: "500", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%"}}>
          {t.person}
        </span>
        <span style={{color: "var(--line, #d4d4d8)"}}>·</span>
        <span style={{color: "var(--muted, #52525b)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%"}}>
          {t.addr}
        </span>
      </div>
      <div style={{display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", fontSize: "12px", color: "var(--meta, #71717a)", minWidth: "0"}}>
        <span style={{fontWeight: "500", color: look.dueColor, whiteSpace: "nowrap"}}>
          {look.due}
        </span>
        <span style={{color: "var(--line, #d4d4d8)"}}>·</span>
        <span style={{whiteSpace: "nowrap"}}>
          {t.type}
        </span>
        <span style={{color: "var(--line, #d4d4d8)"}}>·</span>
        <span style={{color: textTone(t.assignedColor), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
          {t.assigned}
        </span>
      </div>
      <div style={{display: "flex", gap: "6px", minWidth: "0"}}>
        <Button onClick={call} style={{flex: "1", minWidth: "0", height: "38px"}}>Call</Button>
        <Button onClick={open} style={{flex: "1", minWidth: "0", height: "38px"}}>Open</Button>
        <Button onClick={snooze} title="Move it to tomorrow at 9 AM" style={{flex: "1", minWidth: "0", height: "38px"}}>Snooze</Button>
        <Button onClick={edit} aria-label={`Edit task: ${t.title}`} style={{flex: "1", minWidth: "0", height: "38px"}}>Edit</Button>
      </div>
    </div>
  );
  return (
    <tr role="row" data-task-focus={t.focused || undefined} className={mark.leaving ? 'dc2 task-leaving' : 'dc2'} style={t.focused ? { background: 'var(--mint-dim, #e7f8f1)' } : undefined}>
      <td role="cell" style={{padding: "0 0 0 14px", height: "44px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
        <input type="checkbox" checked={!!(mark.done)} onChange={toggle} aria-label={`Mark done: ${t.title}`} style={{width: "15px", height: "15px", accentColor: "#16a34a", cursor: "pointer"}} />
      </td>
      <td role="cell" onClick={open} style={{padding: "7px 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontWeight: "600", cursor: "pointer", color: look.textColor, textDecoration: look.deco, maxWidth: "380px"}}>
        {t.title}
        {(t.hasNote) ? (
          <div style={{fontWeight: "400", fontSize: "12px", color: "var(--meta, #71717a)", textDecoration: "none", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
            {t.note}
          </div>
        ) : null}
      </td>
      <td role="cell" onClick={open} style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", cursor: "pointer", color: "var(--tx-mint, #0a8560)"}}>
        {t.person}
      </td>
      <td role="cell" style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", color: "var(--muted, #52525b)"}}>
        {t.addr}
      </td>
      <td role="cell" style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", color: "var(--muted, #52525b)"}}>
        {t.type}
      </td>
      <td role="cell" style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", fontWeight: "500", color: look.dueColor}}>
        {look.due}
      </td>
      <td role="cell" style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", color: textTone(t.assignedColor)}}>
        {t.assigned}
      </td>
      <td role="cell" style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap"}}>
        <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: "600", color: t.prColor}}>
          <Mark label={t.priority} />
          {t.priority}
        </span>
      </td>
      {/* Pinned to the right edge so Call, Open, Snooze and Edit stay in reach when the columns run wider than the screen. */}
      <td role="cell" className="cz-sticky-col" style={{position: "sticky", right: 0, zIndex: 1, boxShadow: "inset 1px 0 0 var(--divider-2, #f0f0f1)", padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap"}}>
        <span style={{display: "flex", gap: "4px"}}>
          <Button size={28} onClick={call}>Call</Button>
          <Button size={28} onClick={open}>Open</Button>
          <Button size={28} onClick={snooze} title="Move it to tomorrow at 9 AM">Snooze</Button>
          <Button size={28} onClick={edit} aria-label={`Edit task: ${t.title}`}>Edit</Button>
        </span>
      </td>
    </tr>
  );
}, sameRow);

/**
 * The header table's hidden row: each column's distinct values, styled as
 * TaskItem's cells (keep the two in step). A collapsed row takes no height but
 * still counts toward column widths, so the header gets the widths one table
 * of every task gave, and the row blocks copy them.
 */
function SizerRow({ rows }: { rows: TaskRow[] }) {
  const uniq = (f: (t: TaskRow) => string) => [...new Set(rows.map(f))];
  const titles = [...new Map(rows.map((t) => [t.title + '\n' + (t.hasNote ? t.note : ''), t])).entries()];
  const lines = (f: (t: TaskRow) => string) => uniq(f).map((v) => <div key={v}>{v}</div>);
  return (
    <tr aria-hidden style={{visibility: "collapse"}}>
      <td style={{padding: "0 0 0 14px"}}>
        <input type="checkbox" tabIndex={-1} style={{width: "15px", height: "15px"}} />
      </td>
      {/* The title column never goes under 220px: below that, titles wrapped five lines deep. */}
      <td style={{padding: "7px 12px", fontWeight: "600", minWidth: "220px", maxWidth: "380px"}}>
        {titles.map(([k, t]) => (
          <div key={k}>
            {t.title}
            {t.hasNote ? <div style={{fontWeight: "400", fontSize: "12px", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{t.note}</div> : null}
          </div>
        ))}
      </td>
      <td style={{padding: "0 12px", whiteSpace: "nowrap"}}>{lines((t) => t.person)}</td>
      <td style={{padding: "0 12px", whiteSpace: "nowrap"}}>{lines((t) => t.addr)}</td>
      <td style={{padding: "0 12px", whiteSpace: "nowrap"}}>{lines((t) => t.type)}</td>
      <td style={{padding: "0 12px", whiteSpace: "nowrap", fontWeight: "500"}}>{lines((t) => taskLook(t.done, t.due, t.bucket).due)}</td>
      <td style={{padding: "0 12px", whiteSpace: "nowrap"}}>{lines((t) => t.assigned)}</td>
      <td style={{padding: "0 12px", whiteSpace: "nowrap"}}>
        {uniq((t) => t.priority).map((p) => (
          <div key={p}>
            <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: "600"}}>
              <Mark label={p} />
              {p}
            </span>
          </div>
        ))}
      </td>
      <td style={{padding: "0 12px", whiteSpace: "nowrap"}}>
        <span style={{display: "flex", gap: "4px"}}>
          <button type="button" tabIndex={-1} className="ds-btn ds-btn--ghost ds-btn--sm">Call</button>
          <button type="button" tabIndex={-1} className="ds-btn ds-btn--ghost ds-btn--sm">Open</button>
          <button type="button" tabIndex={-1} className="ds-btn ds-btn--ghost ds-btn--sm">Snooze</button>
          <button type="button" tabIndex={-1} className="ds-btn ds-btn--ghost ds-btn--sm">Edit</button>
        </span>
      </td>
    </tr>
  );
}
