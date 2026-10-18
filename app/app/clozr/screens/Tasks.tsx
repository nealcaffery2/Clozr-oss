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

// A ticked task fades and slides out before it leaves the list (useClozr taskLeaving).
const LEAVE_CSS = `
@keyframes taskLeave { 0% { opacity: 1; transform: none; } 35% { opacity: 1; background: var(--mint-dim, #e7f8f1); } 100% { opacity: 0; transform: translateX(24px); } }
.task-leaving, .task-leaving > td { animation: taskLeave .5s ease forwards; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .task-leaving, .task-leaving > td { animation-duration: .01s; } }
`;

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
  return (
    <section data-screen-label="Tasks" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: V.isMobile ? "column" : "row"}}>
      <style>{LEAVE_CSS}</style>
      {(!V.isMobile) ? (
        <>
      <aside style={{width: "210px", flex: "none", background: "var(--surface, #fff)", borderRight: "1px solid var(--divider, #e4e4e7)", padding: "14px 10px"}}>
        <div style={{fontSize: "10.5px", fontWeight: "600", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--meta, #71717a)", padding: "0 8px 8px"}}>
          Tasks
        </div>
        {(V.tasksViews || []).map((v, v__i) => (
          <React.Fragment key={v__i}>
          <button className="dc2" onClick={v.go} style={{display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", height: "30px", padding: "0 8px", border: "0", borderRadius: "7px", cursor: "pointer", fontSize: "13px", textAlign: "left", background: v.bg, color: v.color, fontWeight: "500"}}>
            <span>
              {v.label}
            </span>
            <span style={{fontSize: "11.5px", color: "var(--subtle, #a1a1aa)"}}>
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
            <span style={{fontSize: "19px", fontWeight: "700", letterSpacing: "-0.03em"}}>
              Tasks
            </span>
            <span style={{fontSize: "12.5px", color: "var(--meta, #71717a)", whiteSpace: "nowrap"}}>
              {V.taskCount} in {V.tasksView.toLowerCase()}
            </span>
            {/* Drops under the title on a narrow phone rather than squeezing the count. */}
            <span style={{marginLeft: "auto"}}>
              <CompleteShown V={V} />
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
      <div style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
        <div style={{display: V.isMobile ? "none" : "flex", alignItems: "center", gap: "10px", padding: "12px 16px", background: "var(--surface, #fff)", borderBottom: "1px solid var(--divider, #e4e4e7)"}}>
          <h1 style={{margin: "0", fontSize: "16px", fontWeight: "700", letterSpacing: "-0.02em"}}>
            {V.tasksView}
          </h1>
          <span style={{fontSize: "12px", color: "var(--meta, #71717a)"}}>
            {V.taskCount} tasks
          </span>
          <div style={{flex: "1"}}></div>
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
          <button className="dc10" onClick={V.addTask} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer"}}>
            + Task
          </button>
        </div>
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
          <table style={{width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px"}}>
            <thead>
              <tr>
                <th style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", width: "40px", height: "36px"}}></th>
                {(V.taskCols || []).map((c, c__i) => (
                  <React.Fragment key={c__i}>
                  <th style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", padding: "0 12px", height: "36px", textAlign: "left", fontSize: "10.5px", fontWeight: "600", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--meta, #71717a)", whiteSpace: "nowrap"}}>
                    {c}
                  </th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t, t__i) => <TaskItem key={t__i} t={t} phone={false} act={act} />)}
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
type TaskAct = (id: string, what: 'toggle' | 'open' | 'call' | 'snooze') => void;

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
  if (phone) return (
    <div data-task-focus={t.focused || undefined} className={mark.leaving ? 'task-leaving' : undefined} style={{background: t.focused ? "var(--mint-dim, #e7f8f1)" : "var(--surface, #fff)", border: t.focused ? "1px solid #0A8560" : "1px solid var(--divider, #e4e4e7)", borderRadius: "12px", padding: "11px 12px", display: "flex", flexDirection: "column", gap: "8px", minWidth: "0"}}>
      <div style={{display: "flex", alignItems: "flex-start", gap: "10px", minWidth: "0"}}>
        <input type="checkbox" checked={!!(mark.done)} onChange={toggle} aria-label={`Mark done: ${t.title}`} style={{width: "18px", height: "18px", flex: "none", marginTop: "1px", accentColor: "#16a34a", cursor: "pointer"}} />
        <div onClick={open} style={{flex: "1", minWidth: "0", cursor: "pointer"}}>
          <div style={{fontSize: "14px", fontWeight: "600", lineHeight: "1.35", color: look.textColor, textDecoration: look.deco}}>
            {t.title}
          </div>
          {(t.hasNote) ? (
            <div style={{fontSize: "12.5px", color: "var(--meta, #71717a)", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
              {t.note}
            </div>
          ) : null}
        </div>
        <span style={{flex: "none", display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "10px", fontWeight: "600", letterSpacing: ".08em", textTransform: "uppercase", color: t.prColor, whiteSpace: "nowrap", marginTop: "2px"}}>
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
        <span style={{color: t.assignedColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
          {t.assigned}
        </span>
      </div>
      <div style={{display: "flex", gap: "6px", minWidth: "0"}}>
        <button className="clozr-talkr-ghost" onClick={call} style={{color: "var(--c-talkr)", flex: "1", minWidth: "0", height: "38px", borderRadius: "9px", border: "1px solid var(--tint-rose, #fecdd3)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer"}}>
          Call
        </button>
        <button className="dc2" onClick={open} style={{flex: "1", minWidth: "0", height: "38px", borderRadius: "9px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", color: "var(--ink, #18181b)", cursor: "pointer"}}>
          Open
        </button>
        <button className="dc2" onClick={snooze} style={{flex: "1", minWidth: "0", height: "38px", borderRadius: "9px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", color: "var(--ink, #18181b)", cursor: "pointer"}}>
          Snooze
        </button>
      </div>
    </div>
  );
  return (
    <tr data-task-focus={t.focused || undefined} className={mark.leaving ? 'dc2 task-leaving' : 'dc2'} style={t.focused ? { background: 'var(--mint-dim, #e7f8f1)' } : undefined}>
      <td style={{padding: "0 0 0 14px", height: "44px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
        <input type="checkbox" checked={!!(mark.done)} onChange={toggle} aria-label={`Mark done: ${t.title}`} style={{width: "15px", height: "15px", accentColor: "#16a34a", cursor: "pointer"}} />
      </td>
      <td onClick={open} style={{padding: "7px 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", fontWeight: "600", cursor: "pointer", color: look.textColor, textDecoration: look.deco, maxWidth: "380px"}}>
        {t.title}
        {(t.hasNote) ? (
          <div style={{fontWeight: "400", fontSize: "12px", color: "var(--meta, #71717a)", textDecoration: "none", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
            {t.note}
          </div>
        ) : null}
      </td>
      <td onClick={open} style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", cursor: "pointer", color: "var(--tx-mint, #0a8560)"}}>
        {t.person}
      </td>
      <td style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", color: "var(--muted, #52525b)"}}>
        {t.addr}
      </td>
      <td style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", color: "var(--muted, #52525b)"}}>
        {t.type}
      </td>
      <td style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", fontWeight: "500", color: look.dueColor}}>
        {look.due}
      </td>
      <td style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap", color: t.assignedColor}}>
        {t.assigned}
      </td>
      <td style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap"}}>
        <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "10.5px", fontWeight: "600", letterSpacing: ".08em", textTransform: "uppercase", color: t.prColor}}>
          <Mark label={t.priority} />
          {t.priority}
        </span>
      </td>
      <td style={{padding: "0 12px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", whiteSpace: "nowrap"}}>
        <span style={{display: "flex", gap: "4px"}}>
          <button className="clozr-talkr-ghost" onClick={call} style={{color: "var(--c-talkr)", height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--tint-rose, #fecdd3)", background: "var(--c-btn-bg)", fontSize: "11.5px", cursor: "pointer"}}>
            Call
          </button>
          <button className="dc2" onClick={open} style={{height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11.5px", cursor: "pointer"}}>
            Open
          </button>
          <button className="dc2" onClick={snooze} style={{height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11.5px", cursor: "pointer"}}>
            Snooze
          </button>
        </span>
      </td>
    </tr>
  );
}, sameRow);
