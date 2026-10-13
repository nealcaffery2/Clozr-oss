'use client';

// Stage: the specific stage, where it sits on the five-step path, and the
// two stages that come next in the list. Moving is one select (S focuses it)
// or one tap on a Likely next chip.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { eyebrow, card } from './ui';
import { stageBar } from './record-logic';
import { Mark } from '@/components/ds/mark';

export function StageCard({ V, selectRef }: { V: ClozrView; selectRef?: React.Ref<HTMLSelectElement> }) {
  const bar = stageBar(V.P.stage);
  const pick = V.aiStage;
  const next = (pick?.chips ?? []).map((label) => ({ label, go: () => pick.go(label) }));
  const groups = V.stageSelect ? V.stageSelect.groups : [{ label: 'Stages', options: V.stageOptions.map((o) => o.label) }];
  const move = (label: string) => V.stageOptions.find((o) => o.label === label)?.go();
  const stepN = bar.index === null ? null : bar.index + 1;

  return (
    <div data-testid="record-stage" style={{ ...card, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={eyebrow}>Stage</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', fontSize: '11px', fontWeight: 700, color: V.P.stageColor }}>
            <Mark label={V.P.stage} />
            {V.P.stage}
          </div>
        </div>
        <select ref={selectRef} aria-label="Move to a stage" title={V.recordReadOnly || 'Move to a stage (S)'} value="" disabled={!!V.recordReadOnly} onChange={(e) => { if (e.target.value && e.target.value !== V.P.stage) move(e.target.value); }}
          style={{ height: '26px', width: '104px', flex: 'none', padding: '0 4px', borderRadius: '7px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', color: '#27272a', cursor: 'pointer' }}>
          <option value="" disabled>Move to…</option>
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => <option key={o} value={o}>{o === V.P.stage ? o + ' (now)' : o}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div role="img" aria-label={bar.offPath ? `Stage progress: off the path (${V.P.stage})` : `Stage progress: ${bar.label}, step ${stepN} of 5`}
        style={{ marginTop: '10px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '3px' }} data-seg>
          {bar.steps.map((st) => (
            <span key={st.label} style={{ height: '5px', borderRadius: '2px', background: st.state === 'todo' ? '#f0f0f1' : V.P.stageColor, opacity: st.state === 'done' ? 0.45 : 1 }} />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '5px', fontSize: '11px', color: '#71717a' }}>
          <span style={{ fontWeight: 600, color: bar.offPath ? '#dc2626' : '#27272a' }}>{bar.offPath ? 'Off the path' : bar.label}</span>
          <span className="rec-money">{bar.offPath ? 'Lead to Closed' : `step ${stepN} of 5`}</span>
        </div>
      </div>
      {bar.offPath ? (
        <div style={{ marginTop: '8px', fontSize: '11.5px', color: '#71717a' }}>Off the path. Pick a stage above to bring {V.P.name.split(' ')[0]} back.</div>
      ) : next.length ? (
        <div style={{ marginTop: '9px' }}>
          <div style={{ ...eyebrow, fontSize: '10px' }}>Likely next <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, color: '#a1a1aa' }}>· from the activity</span></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '5px' }}>
            {next.map((o) => (
              <button key={o.label} type="button" className="dc13 rec-press" onClick={o.go} title={`Move to ${o.label}`} disabled={!!V.recordReadOnly}
                style={{ height: '26px', padding: '0 9px', borderRadius: '999px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', cursor: 'pointer', color: '#52525b', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: '8px', fontSize: '11.5px', color: '#71717a' }}>End of the path.</div>
      )}
    </div>
  );
}
