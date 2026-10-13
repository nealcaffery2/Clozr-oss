// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

import React from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { Empty, EmptyRow } from '@/components/ds/Empty';
import { Chevron, CZ, trayBtn } from '@/components/ds/chrome';
import type { ClozrView } from '@/app/clozr/view';
import { Mark } from '@/components/ds/mark';

// A ticked task fades and slides out before it leaves the list (useClozr taskLeaving).
const LEAVE_CSS = `
@keyframes taskLeave { 0% { opacity: 1; transform: none; } 35% { opacity: 1; background: #E7F8F1; } 100% { opacity: 0; transform: translateX(24px); } }
.task-leaving, .task-leaving > td { animation: taskLeave .5s ease forwards; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .task-leaving, .task-leaving > td { animation-duration: .01s; } }
`;

export function Tasks({ V }: { V: ClozrView }) {
  // A task opened from the command bar: bring its row into view once.
  const focusId = (V.taskRows || []).find((t) => t.focused)?.id;
  React.useEffect(() => {
    if (focusId) document.querySelector('[data-task-focus="true"]')?.scrollIntoView({ block: 'center' });
  }, [focusId]);
  return (
    <section data-screen-label="Tasks" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: V.isMobile ? "column" : "row"}}>
      <style>{LEAVE_CSS}</style>
      {(!V.isMobile) ? (
        <>
      <aside style={{width: "210px", flex: "none", background: "#fff", borderRight: "1px solid #e4e4e7", padding: "14px 10px"}}>
        <div style={{fontSize: "10.5px", fontWeight: "600", letterSpacing: ".1em", textTransform: "uppercase", color: "#71717a", padding: "0 8px 8px"}}>
          Tasks
        </div>
        {(V.tasksViews || []).map((v, v__i) => (
          <React.Fragment key={v__i}>
          <button className="dc2" onClick={v.go} style={{display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", height: "30px", padding: "0 8px", border: "0", borderRadius: "7px", cursor: "pointer", fontSize: "13px", textAlign: "left", background: v.bg, color: v.color, fontWeight: "500"}}>
            <span>
              {v.label}
            </span>
            <span style={{fontSize: "11.5px", color: "#a1a1aa"}}>
              {v.count}
            </span>
          </button>
          </React.Fragment>
        ))}
        {V.can.automations ? (
        <div style={{margin: "14px 8px 0", paddingTop: "12px", borderTop: "1px solid #f0f0f1"}}>
          <button className="dc2" onClick={V.goAutomations} style={{display: "flex", alignItems: "center", gap: "7px", width: "100%", height: "30px", padding: "0 8px", border: "0", borderRadius: "7px", cursor: "pointer", fontSize: "13px", textAlign: "left", background: "none", color: "#27272a", fontWeight: "500"}}>
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
        <div style={{flex: "none", background: "#fff", borderBottom: "1px solid #e4e4e7", padding: "10px 0 10px 12px"}}>
          <div style={{display: "flex", alignItems: "baseline", gap: "8px", paddingRight: "12px"}}>
            <span style={{fontSize: "19px", fontWeight: "700", letterSpacing: "-0.03em"}}>
              Tasks
            </span>
            <span style={{fontSize: "12.5px", color: "#71717a"}}>
              {V.taskCount} in {V.tasksView.toLowerCase()}
            </span>
          </div>
          <div style={{display: "flex", gap: "6px", overflowX: "auto", marginTop: "9px", paddingRight: "12px", paddingBottom: "2px"}}>
            {(V.tasksViews || []).map((v, v__i) => (
              <React.Fragment key={v__i}>
              <button type="button" onClick={v.go} style={{...trayBtn(v.on), ...(v.on ? { background: '#18181b', color: '#fff' } : null)}}>
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
        <div style={{display: V.isMobile ? "none" : "flex", alignItems: "center", gap: "10px", padding: "12px 16px", background: "#fff", borderBottom: "1px solid #e4e4e7"}}>
          <h1 style={{margin: "0", fontSize: "16px", fontWeight: "700", letterSpacing: "-0.02em"}}>
            {V.tasksView}
          </h1>
          <span style={{fontSize: "12px", color: "#71717a"}}>
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
          {V.can.plans ? (
          <button className="dc2" onClick={V.goPlans} style={{height: "32px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", cursor: "pointer", color: "#18181b", whiteSpace: "nowrap"}}>
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
          <div style={{flex: "1", overflow: "auto", background: "#fafafa", padding: "10px 12px calc(96px + env(safe-area-inset-bottom, 0px))", display: "flex", flexDirection: "column", gap: "8px"}}>
            {(V.taskRows || []).map((t, t__i) => (
              <React.Fragment key={t__i}>
              <div data-task-focus={t.focused || undefined} className={t.leaving ? 'task-leaving' : undefined} style={{background: t.focused ? "#E7F8F1" : "#fff", border: t.focused ? "1px solid #0A8560" : "1px solid #e4e4e7", borderRadius: "12px", padding: "11px 12px", display: "flex", flexDirection: "column", gap: "8px", minWidth: "0"}}>
                <div style={{display: "flex", alignItems: "flex-start", gap: "10px", minWidth: "0"}}>
                  <input type="checkbox" checked={!!(t.done)} onChange={t.toggle} aria-label={`Mark done: ${t.title}`} style={{width: "18px", height: "18px", flex: "none", marginTop: "1px", accentColor: "#16a34a", cursor: "pointer"}} />
                  <div onClick={t.open} style={{flex: "1", minWidth: "0", cursor: "pointer"}}>
                    <div style={{fontSize: "14px", fontWeight: "600", lineHeight: "1.35", color: t.textColor, textDecoration: t.deco}}>
                      {t.title}
                    </div>
                    {(t.hasNote) ? (
                      <div style={{fontSize: "12.5px", color: "#71717a", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
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
                  <span onClick={t.open} style={{color: "#0A8560", fontWeight: "500", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%"}}>
                    {t.person}
                  </span>
                  <span style={{color: "#d4d4d8"}}>·</span>
                  <span style={{color: "#52525b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%"}}>
                    {t.addr}
                  </span>
                </div>
                <div style={{display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", fontSize: "12px", color: "#71717a", minWidth: "0"}}>
                  <span style={{fontWeight: "500", color: t.dueColor, whiteSpace: "nowrap"}}>
                    {t.due}
                  </span>
                  <span style={{color: "#d4d4d8"}}>·</span>
                  <span style={{whiteSpace: "nowrap"}}>
                    {t.type}
                  </span>
                  <span style={{color: "#d4d4d8"}}>·</span>
                  <span style={{color: t.assignedColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                    {t.assigned}
                  </span>
                </div>
                <div style={{display: "flex", gap: "6px", minWidth: "0"}}>
                  <button className="clozr-talkr-ghost" onClick={t.call} style={{color: "var(--c-talkr)", flex: "1", minWidth: "0", height: "38px", borderRadius: "9px", border: "1px solid #fecdd3", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer"}}>
                    Call
                  </button>
                  <button className="dc2" onClick={t.open} style={{flex: "1", minWidth: "0", height: "38px", borderRadius: "9px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", color: "#18181b", cursor: "pointer"}}>
                    Open
                  </button>
                  <button className="dc2" onClick={t.snooze} style={{flex: "1", minWidth: "0", height: "38px", borderRadius: "9px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", color: "#18181b", cursor: "pointer"}}>
                    Snooze
                  </button>
                </div>
              </div>
              </React.Fragment>
            ))}
            {(V.taskRows || []).length === 0 ? (
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
        <div style={{flex: "1", overflow: "auto", background: "#fff"}}>
          <table style={{width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px"}}>
            <thead>
              <tr>
                <th style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", width: "40px", height: "36px"}}></th>
                {(V.taskCols || []).map((c, c__i) => (
                  <React.Fragment key={c__i}>
                  <th style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: "1px solid var(--c-thead-line)", padding: "0 12px", height: "36px", textAlign: "left", fontSize: "10.5px", fontWeight: "600", letterSpacing: ".08em", textTransform: "uppercase", color: "#71717a", whiteSpace: "nowrap"}}>
                    {c}
                  </th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {(V.taskRows || []).map((t, t__i) => (
                <React.Fragment key={t__i}>
                <tr data-task-focus={t.focused || undefined} className={t.leaving ? 'dc2 task-leaving' : 'dc2'} style={t.focused ? { background: '#E7F8F1' } : undefined}>
                  <td style={{padding: "0 0 0 14px", height: "44px", borderBottom: "1px solid #f0f0f1"}}>
                    <input type="checkbox" checked={!!(t.done)} onChange={t.toggle} aria-label={`Mark done: ${t.title}`} style={{width: "15px", height: "15px", accentColor: "#16a34a", cursor: "pointer"}} />
                  </td>
                  <td onClick={t.open} style={{padding: "7px 12px", borderBottom: "1px solid #f0f0f1", fontWeight: "600", cursor: "pointer", color: t.textColor, textDecoration: t.deco, maxWidth: "380px"}}>
                    {t.title}
                    {(t.hasNote) ? (
                      <div style={{fontWeight: "400", fontSize: "12px", color: "#71717a", textDecoration: "none", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                        {t.note}
                      </div>
                    ) : null}
                  </td>
                  <td onClick={t.open} style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", cursor: "pointer", color: "#0A8560"}}>
                    {t.person}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#52525b"}}>
                    {t.addr}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: "#52525b"}}>
                    {t.type}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", fontWeight: "500", color: t.dueColor}}>
                    {t.due}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap", color: t.assignedColor}}>
                    {t.assigned}
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                    <span style={{display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "10.5px", fontWeight: "600", letterSpacing: ".08em", textTransform: "uppercase", color: t.prColor}}>
                      <Mark label={t.priority} />
                      {t.priority}
                    </span>
                  </td>
                  <td style={{padding: "0 12px", borderBottom: "1px solid #f0f0f1", whiteSpace: "nowrap"}}>
                    <span style={{display: "flex", gap: "4px"}}>
                      <button className="clozr-talkr-ghost" onClick={t.call} style={{color: "var(--c-talkr)", height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid #fecdd3", background: "var(--c-btn-bg)", fontSize: "11.5px", cursor: "pointer"}}>
                        Call
                      </button>
                      <button className="dc2" onClick={t.open} style={{height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11.5px", cursor: "pointer"}}>
                        Open
                      </button>
                      <button className="dc2" onClick={t.snooze} style={{height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11.5px", cursor: "pointer"}}>
                        Snooze
                      </button>
                    </span>
                  </td>
                </tr>
                </React.Fragment>
              ))}
              {(V.taskRows || []).length === 0 ? (
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
