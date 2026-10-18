'use client';

// The right rail under Next action: the seller's action-plan enrollment
// (start, open, stop) and the light "Suggested next stage" card.

import React, { useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { aiAgentApi, whenLabel, type RecordStatus } from '@/lib/ai-agent-client';
import { RecordTextSequence } from '@/app/components/sequences/TextSequences';
import { eyebrow } from './ui';

export function RecordActionPlans({ V }: { V: ClozrView }) {
  const plan = V.personPlan;
  return (
    <div style={{ marginTop: '10px' }} data-testid="record-action-plans">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={eyebrow}>
          Action plans
        </span>
        <button
          type="button"
          className="dc12"
          onClick={V.goPlans}
          style={{ fontSize: '11px', color: '#0A8560', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: 600 }}
        >
          Builder
        </button>
      </div>

      <AiAgentPlan V={V} />
      {plan ? (
        <div style={{ marginTop: '8px', padding: '10px', border: '1px solid #e4e4e7', borderRadius: '9px', background: '#fafafa' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12.5px' }}>
            <button
              type="button"
              className="dc12"
              onClick={plan.open}
              style={{ fontWeight: 600, background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', color: '#18181b', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {plan.name}
            </button>
            <span style={{ color: '#71717a', flex: 'none' }}>
              Step {plan.step} / {plan.total}
            </span>
          </div>
          <div style={{ height: '4px', background: '#e4e4e7', borderRadius: '2px', overflow: 'hidden', marginTop: '8px' }}>
            <div style={{ width: plan.pct, height: '100%', background: '#0A8560' }} />
          </div>
          <div style={{ fontSize: '11.5px', color: '#52525b', marginTop: '6px', lineHeight: 1.4 }}>
            {plan.nextLabel} · {plan.statusNote}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '8px' }}>
            <button type="button" className="dc2 rec-press" onClick={plan.open} style={{ height: '24px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', cursor: 'pointer', color: '#18181b' }}>
              Open plan
            </button>
            <button type="button" className="dc2 rec-press" onClick={plan.stop} style={{ height: '24px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', cursor: 'pointer', color: '#52525b' }}>
              Stop
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: '8px' }}>
          <div style={{ fontSize: '12px', color: '#71717a', lineHeight: 1.45 }}>
            Not on an action plan.
          </div>
          <select
            aria-label="Start an action plan"
            defaultValue=""
            onChange={V.startPlanFor}
            style={{ marginTop: '8px', width: '100%', height: '30px', borderRadius: '8px', border: '1px solid #e4e4e7', padding: '0 8px', fontSize: '12.5px', background: '#fff', color: '#18181b' }}
          >
            <option value="">Start an action plan…</option>
            {(V.planPickerOptions || []).map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="dc3 rec-press"
            onClick={V.aiPlanForLead}
            disabled={V.planDrafting}
            title="Claude reads every call, text and note on this record and writes a sequence for this seller"
            style={{ marginTop: '8px', width: '100%', height: '28px', borderRadius: '8px', border: '1px solid #0A8560', background: '#0A8560', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer', opacity: V.planDrafting ? 0.6 : 1 }}
          >
            {V.planDrafting ? 'Reading the history…' : 'AI plan from this lead'}
          </button>
        </div>
      )}
      <RecordTextSequence
        key={V.P.id}
        toast={V.showToast}
        seller={{
          name: V.P.name,
          phone: V.P.phone === '—' ? '' : V.P.phone || '',
          address: V.P.traceAddress
            ? { line1: V.P.traceAddress.address, city: V.P.traceAddress.city, state: V.P.traceAddress.state, postal_code: V.P.traceAddress.zip }
            : undefined,
        }}
      />
    </div>
  );
}

/** @deprecated Prefer RecordActionPlans — kept as an alias for any lingering imports. */
export const RecordTasks = RecordActionPlans;

export function AiRecommended({ V }: { V: ClozrView }) {
  if (!V.showAi || !V.aiStage?.stage) return null;
  const pick = V.aiStage;
  return (
    // Light, like every card on the record: the dark card with a blue glow
    // and a pulsing dot was a second accent (DESIGN.md §1).
    <div data-testid="clozr-ai" style={{ borderRadius: '12px', padding: '12px 14px', background: '#fff', border: '1px solid #e4e4e7', color: '#18181b' }}>
      <span style={eyebrow}>
        Suggested next stage
      </span>
      <div style={{ fontSize: '13px', lineHeight: 1.5, marginTop: '6px', color: '#27272a' }}>
        {pick.reason}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
        <button type="button" className="dc3 rec-press rec-primary" onClick={() => pick.go(pick.stage!)} title={`Move to ${pick.stage}`} style={{ height: '28px', padding: '0 12px', borderRadius: '8px', border: 0, background: '#0A8560', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
          Move to {pick.stage}
        </button>
        <button type="button" className="rec-press rec-ghost" onClick={V.callPerson} style={{ height: '28px', padding: '0 12px', borderRadius: '8px', border: 0, background: '#fff', color: '#18181b', fontSize: '12px', fontWeight: 600, cursor: 'pointer', boxShadow: 'var(--shadow-ring)' }}>
          Call now
        </button>
      </div>
    </div>
  );
}

/**
 * The AI agent running this record's sequence, shown with the action plans
 * because it is one: an agent and an action plan never run on the same record
 * at once (migration 155), so starting a plan below stops the agent.
 */
function AiAgentPlan({ V }: { V: ClozrView }) {
  const ws = V.liveIds?.workspaceId ?? null;
  const id = V.liveIds?.sellerId ?? null;
  const [st, setSt] = useState<RecordStatus | null>(null);
  useEffect(() => {
    if (!ws || id == null) return;
    let live = true;
    void aiAgentApi(ws).status('seller', id).then((r) => { if (live && r.ok) setSt(r); });
    return () => { live = false; };
  }, [ws, id, V.hasPersonPlan]);
  const en = st?.enrollment;
  if (!en || (en.status !== 'active' && en.status !== 'paused')) return null;
  const name = st?.agent?.name || en.agent_key;
  const done = en.touches;
  const total = Math.max(en.plan?.steps?.length ?? 0, done);
  return (
    <div style={{ marginTop: '8px', padding: '10px', border: '1px solid #A7DCC5', borderRadius: '9px', background: '#F0FAF5' }} data-testid="record-ai-agent-plan">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12.5px' }}>
        <span style={{ fontWeight: 600, color: '#18181b', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name} · AI agent</span>
        <span style={{ color: '#08694C', flex: 'none' }}>{en.status === 'paused' ? 'Paused' : total ? `Touch ${done} / ${total}` : `${done} touches`}</span>
      </div>
      {en.plan?.summary ? <div style={{ fontSize: '11.5px', color: '#3f3f46', marginTop: '6px', lineHeight: 1.4 }}>{en.plan.summary}</div> : null}
      <div style={{ fontSize: '11.5px', color: '#52525b', marginTop: '4px' }}>
        {en.next_action_at ? `Next ${whenLabel(en.next_action_at)}` : 'Waiting on a reply'} · every touch is in Activity
      </div>
      <div style={{ fontSize: '11px', color: '#71717a', marginTop: '4px' }}>Starting an action plan stops {name}: one sequence at a time.</div>
    </div>
  );
}
