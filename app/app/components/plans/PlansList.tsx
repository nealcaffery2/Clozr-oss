// The left column: every plan in the workspace, the one being edited marked.
'use client';

import React, { useState } from 'react';
import type { PlanSummary } from '@/lib/plans';
import { settingsSummary } from '@/lib/plans';
import type { PlanProgress, ResultsKind } from '@/lib/plan-progress';
import { SendMeter } from './PlanResults';
import { Btn, FAINT, INK, LINE, MINT, MINT_BG, MUTED, PlayPause, ago } from './ui';

const AUDIENCE: Record<string, string> = { seller: 'Seller', buyer: 'Buyer', tc: 'TC', source: 'Source' };

export function PlansList({
  plans, loading, error, currentId, isNew, onSelect, onNew, onDuplicate, onDelete, onToggle, onRetry,
  progressByPlan, progressState, resultsKind, onResults,
}: {
  plans: PlanSummary[]; loading: boolean; error: string | null; currentId: number | null; isNew: boolean;
  onSelect: (id: number) => void; onNew: () => void; onDuplicate: (id: number) => void; onDelete: (id: number) => void;
  onToggle: (id: number, active: boolean) => void; onRetry: () => void;
  progressByPlan: Map<number, PlanProgress>;
  progressState: 'loading' | 'ready' | 'error';
  resultsKind: ResultsKind | null;
  onResults: (planId: number, kind: ResultsKind) => void;
}) {
  const [mode, setMode] = useState<'sent' | 'all'>('sent');
  const sent = plans.filter((pl) => (progressByPlan.get(pl.id)?.enrolled ?? 0) > 0);
  const shown = progressState === 'ready' && mode === 'sent' ? sent : plans;
  return (
    <div style={{ padding: '12px' }}>
      {isNew ? (
        <div style={{ padding: '11px 12px', marginBottom: '8px', borderRadius: '10px', border: `1px solid ${MINT}`, background: MINT_BG }}>
          <span style={{ fontWeight: 600, fontSize: '13.5px', color: INK }}>New plan</span>
          <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '3px' }}>not saved yet</span>
        </div>
      ) : null}
      <div role="group" aria-label="Which plans" style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
        {([['sent', 'Sent out'], ['all', 'All plans']] as const).map(([id, label]) => {
          const on = mode === id;
          return (
            <button
              key={id} type="button" aria-pressed={on} onClick={() => setMode(id)}
              style={{
                height: '28px', padding: '0 10px', borderRadius: '8px', border: `1px solid ${on ? MINT : LINE}`,
                background: on ? MINT_BG : 'var(--surface, #fff)', color: on ? MINT : INK, fontSize: '12px', fontWeight: 650,
                fontFamily: 'inherit', cursor: 'pointer',
              }}
            >{label}</button>
          );
        })}
      </div>
      {loading ? <div style={{ fontSize: '12.5px', color: MUTED, padding: '10px 4px' }}>Loading plans…</div> : null}
      {progressState === 'loading' ? <div style={{ fontSize: '12.5px', color: MUTED, padding: '0 4px 8px' }}>Loading sends…</div> : null}
      {error ? (
        <div style={{ fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)', padding: '10px 4px' }}>
          {error} <Btn small onClick={onRetry} style={{ marginLeft: '6px' }}>Retry</Btn>
        </div>
      ) : null}
      {!loading && !error && progressState === 'ready' && mode === 'sent' && plans.length > 0 && !shown.length && !isNew ? (
        <div style={{ padding: '18px 12px', textAlign: 'center' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>No plan has been sent</div>
          <div style={{ fontSize: '12px', color: MUTED, marginTop: '4px', lineHeight: 1.5 }}>Enrol someone on a plan and it shows up here, with what went out and who wrote back.</div>
          <Btn small onClick={() => setMode('all')} style={{ marginTop: '12px' }}>Show every plan</Btn>
        </div>
      ) : null}
      {!loading && !error && !plans.length && !isNew ? (
        <div style={{ padding: '18px 12px', textAlign: 'center' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>No action plans yet</div>
          <div style={{ fontSize: '12px', color: MUTED, marginTop: '4px', lineHeight: 1.5 }}>Build one by hand, or describe what you want and let the AI draft it.</div>
          <Btn kind="dark" onClick={onNew} style={{ marginTop: '12px' }}>+ New plan</Btn>
        </div>
      ) : null}
      {shown.map((pl) => {
        const on = pl.id === currentId;
        const smart = settingsSummary(pl.settings);
        const progress = progressByPlan.get(pl.id);
        const audience = pl.settings.audience ? (AUDIENCE[pl.settings.audience] ?? pl.settings.audience) : '';
        return (
          <div
            key={pl.id} role="button" tabIndex={0} className="dc2"
            onClick={() => onSelect(pl.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect(pl.id); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 12px', marginBottom: '8px', borderRadius: '10px', border: `1px solid ${on ? MINT : LINE}`, background: on ? MINT_BG : 'var(--surface, #fff)', cursor: 'pointer', boxSizing: 'border-box' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span title={pl.name} style={{ fontWeight: 600, fontSize: '13.5px', color: INK, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.name}</span>
              <span style={{ flex: 1 }} />
              <PlayPause playing={pl.active} onClick={() => onToggle(pl.id, !pl.active)} />
            </span>
            <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{audience ? `${audience} · ` : ''}{pl.trigger_label}</span>
            {progress && progress.enrolled > 0 ? <SendMeter progress={progress} kind={on ? resultsKind : null} onKind={(kind) => onResults(pl.id, kind)} /> : null}
            <span style={{ display: 'flex', gap: '10px', marginTop: '7px', fontSize: '11px', color: FAINT, flexWrap: 'wrap' }}>
              <span>{pl.step_count} step{pl.step_count === 1 ? '' : 's'}</span>
              <span>{pl.enrolled_count} enrolled</span>
              <span>edited {ago(pl.updated_at)}</span>
            </span>
            {smart.length ? <span style={{ display: 'block', fontSize: '11px', color: FAINT, marginTop: '4px' }}>{smart.join(' · ')}</span> : null}
            {on ? (
              <span style={{ display: 'flex', gap: '6px', marginTop: '9px' }}>
                <Btn small onClick={(e) => { e.stopPropagation(); onDuplicate(pl.id); }}>Duplicate</Btn>
                <Btn small kind="danger" onClick={(e) => { e.stopPropagation(); onDelete(pl.id); }}>Delete</Btn>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
