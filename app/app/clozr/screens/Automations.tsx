// Automations — one action plan drawn as a flow: the trigger, the conditions
// that stop it, each step in order, and where it hands off when it ends.
// Read-only; editing happens in Action plans, which shares the same data.
'use client';

import React from 'react';
import { ReadOnlyNote } from '@/components/ViewAs';
import type { ClozrView } from '@/app/clozr/view';
import { usePlans } from '@/app/components/plans/usePlans';
import { Btn, FAINT, INK, LINE, MINT, MUTED, PlayPause, Toast } from '@/app/components/plans/ui';
import { STEP_TYPES, delayLabel, settingsSummary, stepMeta, stepMinutes, stepSummary, triggerLabel, minutesToDelay } from '@/lib/plans';
import { Mark } from '@/components/ds/mark';

export function Automations({ V }: { V: ClozrView }) {
  const api = usePlans();
  const d = api.draft;
  const summary = d?.id ? api.plans.find((p) => p.id === d.id) : null;
  const next = d?.on_end_next_plan_id ? api.plans.find((p) => p.id === d.on_end_next_plan_id) : null;
  const active = api.enrolled.filter((e) => e.status === 'active').length;
  const paused = api.enrolled.filter((e) => e.status === 'paused').length;
  const finished = api.enrolled.filter((e) => e.status !== 'active' && e.status !== 'paused' && !e.stopped_reason).length;
  const stopped = api.enrolled.filter((e) => e.status !== 'active' && e.status !== 'paused' && e.stopped_reason).length;
  const stops = d ? settingsSummary(d.settings).filter((s) => s.startsWith('stops')) : [];
  // Each step's offset from enrolment: the running total of the waits before it.
  const offsets = (d?.steps ?? []).reduce<number[]>((acc, st) => [...acc, (acc[acc.length - 1] ?? 0) + stepMinutes(st)], []);

  return (
    <section data-screen-label="Automations" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 20px', background: 'var(--surface, #fff)', borderBottom: `1px solid ${LINE}`, flexWrap: 'wrap' }}>
        <button type="button" className="dc12" onClick={V.goTasks} style={{ fontSize: '12.5px', color: MUTED, background: 'none', border: 0, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>Tasks</button>
        <span style={{ color: 'var(--line, #d4d4d8)' }}>/</span>
        {api.plans.length ? (
          <select value={d?.id ?? ''} onChange={(e) => { if (e.target.value) api.select(Number(e.target.value)); }} aria-label="Action plan" style={{ height: '32px', padding: '0 8px', border: `1px solid ${LINE}`, borderRadius: '8px', fontSize: '14px', fontWeight: 700, letterSpacing: '-0.02em', color: INK, background: 'var(--surface, #fff)', cursor: 'pointer', fontFamily: 'inherit', maxWidth: '360px' }}>
            {!d ? <option value="">Choose a plan…</option> : null}
            {api.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ) : <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Automations</h1>}
        {d?.id ? (
          <PlayPause playing={d.active} disabled={!api.canWrite && !api.preview} onClick={() => void api.toggleActive(d.id!, !d.active)} label={d.active ? `Pause · ${active} playing` : `Play · ${paused} held`} />
        ) : null}
        <div style={{ flex: 1 }} />
        <Btn disabled title="Test runs need a scheduler — not wired yet">Test run</Btn>
        <Btn kind="dark" onClick={V.goPlans}>Edit in Action plans</Btn>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: V.isMobile ? 'block' : 'grid', overflow: V.isMobile ? 'auto' : 'visible', gridTemplateColumns: V.isMobile ? '1fr' : 'minmax(0,1fr) 260px' }}>
        <div style={{ overflow: 'auto', padding: '24px 20px 40px', backgroundImage: `radial-gradient(${LINE} 1px, transparent 1px)`, backgroundSize: '20px 20px' }}>
          <div style={{ maxWidth: '620px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
            <ReadOnlyNote />
            {!d ? (
              <div style={{ background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '12px', padding: '24px', textAlign: 'center' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: INK }}>{api.loading ? 'Loading…' : api.plans.length ? 'Pick a plan above to see it as a flow' : 'No action plans yet'}</div>
                {!api.loading && !api.plans.length ? <Btn kind="dark" onClick={V.goPlans} style={{ marginTop: '12px' }}>Build one in Action plans</Btn> : null}
              </div>
            ) : (
              <>
                <div style={{ background: 'var(--ink-hero, #141419)', color: 'var(--on-dark, #fff)', borderRadius: '12px', padding: '14px 16px', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(120% 90% at 90% -10%, rgba(10, 133, 96,0.34), transparent 58%)' }} />
                  <div style={{ position: 'relative' }}>
                    <div style={{ fontSize: '11.5px', color: 'rgba(255,255,255,.6)', fontWeight: 600 }}>Trigger</div>
                    <div style={{ fontSize: '15px', fontWeight: 700, marginTop: '4px' }}>{triggerLabel(d.trigger_type, d.trigger_value)}</div>
                    {d.description ? <div style={{ fontSize: '12.5px', color: 'rgba(255,255,255,.7)', marginTop: '4px' }}>{d.description}</div> : null}
                  </div>
                </div>
                <div style={{ width: '2px', height: '22px', background: 'var(--line, #d4d4d8)', margin: '0 auto' }} />
                <div style={{ background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '12px', padding: '14px 16px' }}>
                  <div style={{ fontSize: '11.5px', color: MUTED, fontWeight: 600 }}>Smart stop · any of these ends the plan</div>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                    {stops.length ? stops.map((c) => (
                      <span key={c} style={{ fontSize: '12.5px', fontWeight: 500, padding: '5px 10px', border: `1px solid ${LINE}`, borderRadius: '7px', background: 'var(--canvas, #fafafa)' }}>{c}</span>
                    )) : <span style={{ fontSize: '12.5px', color: MUTED }}>Runs to the end no matter what</span>}
                    {d.settings.business_hours.enabled ? <span style={{ fontSize: '12.5px', fontWeight: 500, padding: '5px 10px', border: `1px solid ${LINE}`, borderRadius: '7px', background: 'var(--canvas, #fafafa)' }}>only {d.settings.business_hours.start}–{d.settings.business_hours.end}</span> : null}
                    <button type="button" className="dc14" onClick={V.goPlans} style={{ fontSize: '12px', padding: '5px 10px', border: '1px dashed var(--line, #d4d4d8)', borderRadius: '7px', background: 'none', color: MUTED, cursor: 'pointer', fontFamily: 'inherit' }}>edit</button>
                  </div>
                </div>
                {d.steps.map((st, i) => {
                  const elapsed = offsets[i] ?? 0;
                  const meta = stepMeta(st.type);
                  const when = elapsed === 0 ? 'Immediately' : delayLabel(minutesToDelay(elapsed)) + ' in';
                  return (
                    <div key={st.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
                      <div style={{ width: '2px', height: '22px', background: 'var(--line, #d4d4d8)', margin: '0 auto' }} />
                      <div className="dc19" style={{ background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '12px', padding: '12px 16px', display: 'grid', gridTemplateColumns: V.isMobile ? '1fr' : '110px 1fr', gap: V.isMobile ? '4px' : '14px', alignItems: 'center', cursor: 'pointer' }} onClick={V.goPlans}>
                        <span style={{ fontSize: '11.5px', color: MUTED, fontWeight: 500 }}>{when}{st.delay ? <span style={{ display: 'block', fontSize: '10.5px', color: FAINT }}>wait {delayLabel(st)}</span> : null}</span>
                        <span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', fontWeight: 700, color: meta.color }}>
                            <Mark label={meta.label} />
                            {meta.label}
                          </span>
                          <span style={{ display: 'block', fontSize: '13px', marginTop: '3px', color: 'var(--ink-2, #27272a)' }}>{stepSummary(st)}</span>
                          {st.body && st.type !== 'wait' ? <span style={{ display: 'block', fontSize: '12px', marginTop: '3px', color: MUTED, whiteSpace: 'pre-wrap' }}>{st.body.length > 180 ? st.body.slice(0, 180) + '…' : st.body}</span> : null}
                        </span>
                      </div>
                    </div>
                  );
                })}
                <div style={{ width: '2px', height: '22px', background: 'var(--line, #d4d4d8)', margin: '0 auto' }} />
                <div style={{ border: `1px solid ${next ? MINT : LINE}`, background: next ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', borderRadius: '12px', padding: '12px 16px' }}>
                  <div style={{ fontSize: '11.5px', color: next ? MINT : MUTED, fontWeight: 600 }}>When it ends</div>
                  <div style={{ fontSize: '13px', marginTop: '3px', color: 'var(--ink-2, #27272a)' }}>{next ? `Enrol in “${next.name}”` : 'Nothing more — the seller stays where they are'}</div>
                </div>
              </>
            )}
          </div>
        </div>
        <aside style={{ background: 'var(--surface, #fff)', borderLeft: `1px solid ${LINE}`, padding: '14px', overflow: 'auto' }}>
          <div style={{ fontSize: '11.5px', color: MUTED, fontWeight: 600 }}>Step kinds</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '10px' }}>
            {STEP_TYPES.map((p) => (
              <button key={p.v} type="button" className="dc23" onClick={V.goPlans} title={p.hint} style={{ height: '32px', padding: '0 10px', border: `1px solid ${LINE}`, borderRadius: '8px', background: 'var(--surface, #fff)', fontSize: '12px', fontWeight: 500, cursor: 'pointer', textAlign: 'left', color: 'var(--ink-2, #27272a)', fontFamily: 'inherit' }}>
                {p.label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: '16px', padding: '12px', border: `1px solid ${LINE}`, borderRadius: '10px' }}>
            <div style={{ fontSize: '11.5px', color: MUTED, fontWeight: 600 }}>This plan</div>
            {[['Steps', String(d?.steps.length ?? 0)], ['Playing', String(active)], ['Paused', String(paused)], ['Finished', String(finished)], ['Stopped early', String(stopped)], ['Last edited', summary ? new Date(summary.updated_at).toLocaleDateString() : '—']].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '12.5px' }}>
                <span style={{ color: 'var(--muted, #52525b)' }}>{k}</span>
                <span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '12px', fontSize: '11.5px', color: MUTED, lineHeight: 1.5 }}>
            Steps become dated tasks for the rep when a seller is enrolled. A reply or a connected call stops the plan when it asks to; a finished plan can hand off to another.
          </div>
        </aside>
      </div>
      <Toast msg={api.toastMsg} />
    </section>
  );
}
