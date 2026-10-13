// The left column: every plan in the workspace, the one being edited marked.
'use client';

import React from 'react';
import type { PlanSummary } from '@/lib/plans';
import { settingsSummary } from '@/lib/plans';
import { Btn, FAINT, INK, LINE, MINT, MINT_BG, MUTED, PlayPause, ago } from './ui';

export function PlansList({
  plans, loading, error, currentId, isNew, onSelect, onNew, onDuplicate, onDelete, onToggle, onRetry,
}: {
  plans: PlanSummary[]; loading: boolean; error: string | null; currentId: number | null; isNew: boolean;
  onSelect: (id: number) => void; onNew: () => void; onDuplicate: (id: number) => void; onDelete: (id: number) => void;
  onToggle: (id: number, active: boolean) => void; onRetry: () => void;
}) {
  return (
    <div style={{ padding: '12px' }}>
      {isNew ? (
        <div style={{ padding: '11px 12px', marginBottom: '8px', borderRadius: '10px', border: `1px solid ${MINT}`, background: MINT_BG }}>
          <span style={{ fontWeight: 600, fontSize: '13.5px', color: INK }}>New plan</span>
          <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '3px' }}>not saved yet</span>
        </div>
      ) : null}
      {loading ? <div style={{ fontSize: '12.5px', color: MUTED, padding: '10px 4px' }}>Loading plans…</div> : null}
      {error ? (
        <div style={{ fontSize: '12.5px', color: '#b91c1c', padding: '10px 4px' }}>
          {error} <Btn small onClick={onRetry} style={{ marginLeft: '6px' }}>Retry</Btn>
        </div>
      ) : null}
      {!loading && !error && !plans.length && !isNew ? (
        <div style={{ padding: '18px 12px', textAlign: 'center' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>No action plans yet</div>
          <div style={{ fontSize: '12px', color: MUTED, marginTop: '4px', lineHeight: 1.5 }}>Build one by hand, or describe what you want and let the AI draft it.</div>
          <Btn kind="dark" onClick={onNew} style={{ marginTop: '12px' }}>+ New plan</Btn>
        </div>
      ) : null}
      {plans.map((pl) => {
        const on = pl.id === currentId;
        const smart = settingsSummary(pl.settings);
        return (
          <div
            key={pl.id} role="button" tabIndex={0} className="dc2"
            onClick={() => onSelect(pl.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect(pl.id); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 12px', marginBottom: '8px', borderRadius: '10px', border: `1px solid ${on ? MINT : LINE}`, background: on ? MINT_BG : '#fff', cursor: 'pointer', boxSizing: 'border-box' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600, fontSize: '13.5px', color: INK, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.name}</span>
              <span style={{ flex: 1 }} />
              <PlayPause playing={pl.active} onClick={() => onToggle(pl.id, !pl.active)} />
            </span>
            <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.settings.audience ? pl.settings.audience.toUpperCase() + ' · ' : ''}{pl.trigger_label}</span>
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
