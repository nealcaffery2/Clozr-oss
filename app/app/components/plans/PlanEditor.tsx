// The right-hand side of the builder: the plan's name and trigger, its
// settings, the step list, and who is on it.
'use client';

import React, { useState } from 'react';
import { SELLER_STAGE_LABELS } from '@/lib/stages';
import { type OnComplete, type PlanDraft, type PlanSummary, type StepType, STEP_TYPES, TRIGGERS, delayLabel, routeSummary, stepMinutes, minutesToDelay } from '@/lib/plans';
import type { PlansApi } from './usePlans';
import { StepCard } from './StepCard';
import { Btn, FAINT, INK, LINE, MINT, MUTED, PlayPause, Section, Toggle, ago, input, label, select, smallSelect, textarea } from './ui';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export function PlanEditor({ api, draft, isMobile, onOpenPerson }: { api: PlansApi; draft: PlanDraft; isMobile: boolean; onOpenPerson?: (sellerId: number) => void }) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(true);
  const others: PlanSummary[] = api.plans.filter((p) => p.id !== draft.id);
  const total = draft.steps.reduce((a, s) => a + stepMinutes(s), 0);
  const span = total ? delayLabel(minutesToDelay(total)) : 'immediately';
  const enrolledActive = api.enrolled.filter((e) => e.status === 'active');
  const enrolledPaused = api.enrolled.filter((e) => e.status === 'paused');
  const enrolledDone = api.enrolled.filter((e) => e.status !== 'active' && e.status !== 'paused');
  const onIt = new Set([...enrolledActive, ...enrolledPaused].map((e) => e.seller_id));
  const candidates = api.sellers.filter((s) => !onIt.has(s.id));
  const route = draft.on_complete;
  const setRoute = (p: Partial<OnComplete>) => {
    const next = { ...route, ...p };
    api.patch({ on_complete: next, on_end_next_plan_id: next.mode === 'fixed' ? next.plan_id : null });
  };
  const routeLine = routeSummary(route, others);
  const planName = (id: number | null) => (id ? api.plans.find((p) => p.id === id)?.name ?? 'another plan' : null);
  const setRunning = (on: boolean) => {
    if (draft.id) void api.toggleActive(draft.id, on);
    else api.patch({ active: on });
  };

  return (
    <>
      <Section title="Plan">
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : '1fr 1fr', gap: '12px' }}>
          <label>
            <span style={label}>Plan name</span>
            <input value={draft.name} onChange={(e) => api.patch({ name: e.target.value })} placeholder="e.g. Cold lead — 7 touches" style={{ ...input, fontWeight: 600 }} />
          </label>
          <div>
            <span style={label}>Starts when</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <select value={draft.trigger_type} onChange={(e) => api.patch({ trigger_type: e.target.value as PlanDraft['trigger_type'], trigger_value: '' })} style={{ ...select, flex: draft.trigger_type === 'stage' || draft.trigger_type === 'tag' ? '0 0 46%' : 1 }}>
                {TRIGGERS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
              {draft.trigger_type === 'stage' ? (
                <select value={draft.trigger_value} onChange={(e) => api.patch({ trigger_value: e.target.value })} style={{ ...select, flex: 1 }}>
                  <option value="">Choose a stage…</option>
                  {SELLER_STAGE_LABELS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : null}
              {draft.trigger_type === 'tag' ? (
                <>
                  <input list="plan-trigger-tags" value={draft.trigger_value} onChange={(e) => api.patch({ trigger_value: e.target.value })} placeholder="tag name" style={{ ...input, flex: 1 }} />
                  <datalist id="plan-trigger-tags">{api.tags.map((t) => <option key={t} value={t} />)}</datalist>
                </>
              ) : null}
            </div>
            <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '5px' }}>
              {TRIGGERS.find((t) => t.v === draft.trigger_type)?.hint}{draft.trigger_type === 'form' ? ' — form leads arrive through the ingest door as new leads' : ''}
            </span>
          </div>
        </div>
        <label style={{ display: 'block', marginTop: '12px' }}>
          <span style={label}>Description</span>
          <textarea value={draft.description} onChange={(e) => api.patch({ description: e.target.value })} rows={2} placeholder="Who this plan is for and what it is trying to get." style={textarea} />
        </label>
        <label style={{ display: 'block', marginTop: '12px' }}>
          <span style={label}>Who this plan is for</span>
          <select
            value={draft.settings.audience || 'seller'}
            onChange={(e) => api.patchSettings({ audience: e.target.value })}
            style={select}
          >
            <option value="seller">Sellers — shows on seller records</option>
            <option value="buyer">Buyers — shows on buyer records</option>
            <option value="tc">TC — shows on sellers, buyers, and vendors</option>
            <option value="source">Sources — shows on vendor lists</option>
          </select>
          <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '5px' }}>
            Record dropdowns only list plans that match. TC plans appear everywhere.
          </span>
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px', flexWrap: 'wrap' }}>
          <PlayPause playing={draft.active} disabled={!!draft.id && !api.canWrite && !api.preview} onClick={() => setRunning(!draft.active)} />
          <Toggle on={draft.active} onChange={setRunning} label={draft.active ? 'Playing' : 'Paused'} hint={draft.active ? 'Triggers fire, and anyone on it keeps going' : 'Nothing new starts, and people already on it are held'} />
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: '11.5px', color: FAINT }}>
            {draft.steps.length} step{draft.steps.length === 1 ? '' : 's'} over {span}{draft.id ? ` · plan #${draft.id}` : ' · not saved yet'}
          </span>
        </div>
      </Section>

      <Section title="Settings" style={{ marginTop: '12px' }} aside={<Btn small onClick={() => setShowSettings((v) => !v)}>{showSettings ? 'Hide' : 'Show'}</Btn>}>
        {showSettings ? (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : '1fr 1fr', gap: '16px' }}>
            <div>
              <span style={{ ...label, color: INK }}>Smart stop</span>
              <Toggle on={draft.settings.stop_on_reply} onChange={(v) => api.patchSettings({ stop_on_reply: v })} label="When the seller replies" hint="An inbound text or email ends the sequence; the rep takes over" />
              <Toggle on={draft.settings.stop_on_call} onChange={(v) => api.patchSettings({ stop_on_call: v })} label="When a call connects" hint="A call with talk time on the record ends it" />
              <Toggle on={draft.settings.stop_on_stage} onChange={(v) => api.patchSettings({ stop_on_stage: v })} label="When the stage changes" hint="Moving the seller to any other stage ends it" />
            </div>
            <div>
              <span style={{ ...label, color: INK }}>When finished</span>
              <select data-testid="plan-route-mode" value={route.mode} onChange={(e) => setRoute({ mode: e.target.value as OnComplete['mode'] })} style={select}>
                <option value="none">Leave the plan</option>
                <option value="fixed">Continue in one plan</option>
                <option value="smart">Let AI pick the next plan</option>
              </select>
              {route.mode === 'fixed' ? (
                <select value={route.plan_id ?? ''} onChange={(e) => setRoute({ plan_id: e.target.value ? Number(e.target.value) : null })} style={{ ...select, marginTop: '6px' }}>
                  <option value="">Choose the next plan…</option>
                  {others.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (paused)'}</option>)}
                </select>
              ) : null}
              {route.mode === 'smart' ? (
                <div style={{ marginTop: '6px', border: `1px solid ${LINE}`, borderRadius: '8px', padding: '6px 10px', maxHeight: '168px', overflow: 'auto', background: '#fafafa' }}>
                  {!others.length ? <span style={{ fontSize: '12px', color: MUTED }}>No other plans yet.</span> : null}
                  {others.map((p) => {
                    const on = route.candidate_ids.includes(p.id);
                    return (
                      <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: INK, padding: '3px 0', cursor: 'pointer' }}>
                        <input type="checkbox" checked={on} onChange={() => setRoute({ candidate_ids: on ? route.candidate_ids.filter((x) => x !== p.id) : [...route.candidate_ids, p.id] })} />
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}{p.active ? '' : ' (paused)'}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {route.mode !== 'none' ? (
                <Toggle on={route.also_when_stopped} onChange={(v) => setRoute({ also_when_stopped: v })} label="Also when stopped" hint="Route a lead whose run was stopped early (they replied, a call connected, the stage changed). A rep's own Stop never routes" />
              ) : null}
              <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '5px' }}>
                {route.mode === 'smart'
                  ? 'The AI reads the lead’s history and picks one of the ticked plans, or none. '
                  : route.mode === 'fixed' ? 'Runs when the last step is done. ' : ''}
                A lead is never routed into a plan it already ran. Where each lead went, and why, shows under Enrolled sellers.
              </span>
              <span style={{ ...label, color: INK, marginTop: '14px' }}>Business hours</span>
              <Toggle on={draft.settings.business_hours.enabled} onChange={(v) => api.patchSettings({ business_hours: { ...draft.settings.business_hours, enabled: v } })} label="Only during business hours" hint="Steps landing outside these hours wait for the next window" />
              {draft.settings.business_hours.enabled ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
                  <input type="time" value={draft.settings.business_hours.start} onChange={(e) => api.patchSettings({ business_hours: { ...draft.settings.business_hours, start: e.target.value } })} style={{ ...smallSelect, width: 'auto', height: '30px' }} />
                  <span style={{ fontSize: '12px', color: MUTED }}>to</span>
                  <input type="time" value={draft.settings.business_hours.end} onChange={(e) => api.patchSettings({ business_hours: { ...draft.settings.business_hours, end: e.target.value } })} style={{ ...smallSelect, width: 'auto', height: '30px' }} />
                  <span style={{ display: 'inline-flex', gap: '3px', marginLeft: '4px' }}>
                    {DAYS.map((d, i) => {
                      const on = draft.settings.business_hours.days.includes(i);
                      return (
                        <button key={d} type="button" onClick={() => api.patchSettings({ business_hours: { ...draft.settings.business_hours, days: on ? draft.settings.business_hours.days.filter((x) => x !== i) : [...draft.settings.business_hours.days, i].sort() } })}
                          style={{ width: '28px', height: '26px', borderRadius: '6px', border: `1px solid ${on ? MINT : LINE}`, background: on ? MINT : '#fff', color: on ? '#fff' : MUTED, fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                          {d}
                        </button>
                      );
                    })}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: MUTED }}>
            {[draft.settings.stop_on_reply && 'stops on reply', draft.settings.stop_on_call && 'stops when a call connects', draft.settings.stop_on_stage && 'stops on stage change',
              routeLine,
              draft.settings.business_hours.enabled && `${draft.settings.business_hours.start}–${draft.settings.business_hours.end}`].filter(Boolean).join(' · ') || 'No smart stop, no hours, nothing after'}
          </div>
        )}
      </Section>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '16px 0 10px', flexWrap: 'wrap' }}>
        <span style={{ ...label, marginBottom: 0 }}>Steps</span>
        <span style={{ fontSize: '11.5px', color: FAINT }}>{draft.steps.length} in sequence · delays are after the previous step</span>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', gap: '5px', flexWrap: 'wrap' }}>
          {STEP_TYPES.map((t) => (
            <Btn key={t.v} small kind="ghost" onClick={() => api.addStep(t.v as StepType)} title={t.hint}>+ {t.label}</Btn>
          ))}
        </span>
      </div>
      {!draft.steps.length ? (
        <div style={{ border: `1px dashed #d4d4d8`, borderRadius: '10px', padding: '18px', textAlign: 'center', fontSize: '12.5px', color: MUTED }}>
          No steps yet — add one above, or describe the plan in the AI box.
        </div>
      ) : null}
      {draft.steps.map((st, i) => (
        <StepCard
          key={st.key} step={st} index={i} total={draft.steps.length} team={api.team} tags={api.tags} dragging={dragFrom === i} workspaceId={api.workspaceId}
          onPatch={(p) => api.patchStep(st.key, p)} onRemove={() => api.removeStep(st.key)} onDuplicate={() => api.duplicateStep(st.key)}
          onMove={(dir) => api.moveStep(i, i + dir)} onAddAfter={(t) => api.addStep(t, st.key)}
          onDragStart={() => setDragFrom(i)}
          onDragOver={(e) => { if (dragFrom !== null) e.preventDefault(); }}
          onDrop={() => { if (dragFrom !== null && dragFrom !== i) api.moveStep(dragFrom, i); setDragFrom(null); }}
          onDragEnd={() => setDragFrom(null)}
        />
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: '26px minmax(0,1fr)', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <span style={{ width: '26px', height: '26px', borderRadius: '999px', border: `1px solid ${LINE}`, background: '#fff', display: 'grid', placeItems: 'center', fontSize: '11px', color: FAINT }}>■</span>
        </div>
        <div style={{ fontSize: '12px', color: MUTED, padding: '5px 0' }}>
          Plan ends{routeLine ? `, ${routeLine}` : ', and the lead leaves it'}.
        </div>
      </div>

      <div style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'hidden', marginTop: '18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 16px', borderBottom: '1px solid #f0f0f1', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>Enrolled sellers</span>
          <span style={{ fontSize: '11.5px', color: FAINT, fontVariantNumeric: 'tabular-nums' }}>{enrolledActive.length} playing{enrolledPaused.length ? ` · ${enrolledPaused.length} paused` : ''}{enrolledDone.length ? ` · ${enrolledDone.length} finished` : ''}</span>
          <div style={{ flex: 1 }} />
          {draft.id ? (
            <select value="" onChange={(e) => { if (e.target.value) void api.enroll(Number(e.target.value)); }} style={{ ...smallSelect, width: 'auto', height: '30px', maxWidth: '260px' }}>
              <option value="">+ Enrol a seller…</option>
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.addr ? ` — ${c.addr}` : ''}</option>)}
            </select>
          ) : <span style={{ fontSize: '12px', color: MUTED }}>Save the plan to enrol sellers</span>}
        </div>
        {!api.enrolled.length ? <div style={{ padding: '14px 16px', fontSize: '12.5px', color: MUTED }}>Nobody yet. Enrol from here, from a seller’s record, or with “Start action plan” on the People list.</div> : null}
        {[...enrolledActive, ...enrolledPaused, ...enrolledDone].map((e) => {
          const pct = e.total ? Math.round((Math.min(e.step, e.total) / e.total) * 100) : 0;
          const paused = e.status === 'paused';
          const done = e.status !== 'active' && !paused;
          const note = paused ? 'paused' : done ? (e.stopped_reason && e.stopped_reason !== 'plan_paused' ? `stopped on ${e.stopped_reason}` : 'finished') : `enrolled ${ago(e.enrolled_at)}`;
          return (
            <div key={e.id} style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr) auto' : 'minmax(0,1fr) 160px auto', gap: '12px', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid #f0f0f1', opacity: done ? 0.65 : 1 }}>
              <button type="button" className="dc12" onClick={() => onOpenPerson?.(e.seller_id)} style={{ textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: onOpenPerson ? 'pointer' : 'default', minWidth: 0, fontFamily: 'inherit' }}>
                <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: INK }}>{e.name}</span>
                <span style={{ display: 'block', fontSize: '11px', color: FAINT }}>{e.addr || '—'} · {note}</span>
                {(e.agent ?? []).map((a, i) => (
                  <span key={i} data-testid="plan-run-agent" style={{ display: 'block', fontSize: '11px', color: a.status === 'failed' ? '#b91c1c' : '#0f766e', marginTop: '2px' }}>
                    AI step {ago(a.at)}: {a.actions.length ? a.actions.map((x) => `${x.kind === 'send_sms' ? 'text' : x.kind === 'create_task' ? 'task' : 'stage'} ${x.ok ? '✓' : '✗'} ${x.detail}`).join(' · ') : a.status === 'running' ? 'deciding' : a.status === 'skipped' ? 'skipped' : 'did nothing'}
                    {a.reason ? <span style={{ color: MUTED }}> — {a.reason}</span> : null}
                  </span>
                ))}
                {e.routed ? (
                  <span data-testid="plan-run-routed" style={{ display: 'block', fontSize: '11px', color: e.routed.plan_id ? INK : MUTED, marginTop: '2px' }}>
                    {e.routed.plan_id ? `→ ${planName(e.routed.plan_id)} · ` : ''}{e.routed.reason}
                  </span>
                ) : null}
              </button>
              <span style={{ display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ flex: 1, height: '4px', borderRadius: '2px', background: '#f0f0f1', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: done || paused ? '#a1a1aa' : MINT }} />
                </span>
                <span style={{ fontSize: '11px', color: MUTED, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{Math.min(e.step, e.total)}/{e.total}</span>
              </span>
              {done ? <span style={{ fontSize: '11px', color: FAINT }}>done</span> : (
                <span style={{ display: 'inline-flex', gap: '6px' }}>
                  <PlayPause playing={!paused} label={paused ? 'Play' : 'Pause'} onClick={() => void (paused ? api.resumeOne(e.id) : api.pauseOne(e.id))} />
                  <Btn small onClick={() => void api.stop(e.id)}>Stop</Btn>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
