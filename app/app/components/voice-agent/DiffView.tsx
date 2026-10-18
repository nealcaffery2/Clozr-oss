// A diff between two versions of an agent (or the live agent and its draft):
// the settings that changed, grouped by tab, then the lines the assembled
// prompt gained and lost. Shared by the publish dialog and the History tab.
'use client';

import React from 'react';
import type { DiffResult } from '@/lib/voice-agent';
import { changeSummary, groupChanges } from '@/lib/voice-agent-console';
import { Badge, Empty, INK, LINE, MUTED, RED, linkBtn } from './kit';

export function DiffView({ diff, onJump }: { diff: DiffResult; onJump?: (path: string) => void }) {
  const groups = groupChanges(diff.changes);
  const { added, removed, tokens_from, tokens_to } = diff.prompt;
  const delta = tokens_to - tokens_from;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: MUTED }}>
        <Badge tone="grey">{diff.from}</Badge><span aria-hidden="true">{'→'}</span><Badge tone="green">{diff.to}</Badge>
        <span style={{ marginLeft: 4 }}>{changeSummary(diff.changes)}</span>
      </div>

      {groups.length === 0 && added.length === 0 && removed.length === 0 ? <Empty title="These are the same">Nothing differs in the settings or in the prompt.</Empty> : null}

      {groups.length ? (
        <div>
          <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>Settings</div>
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
            {groups.map((g, gi) => (
              <div key={g.group} style={{ borderTop: gi ? `1px solid ${LINE}` : 'none' }}>
                <div style={{ padding: '7px 12px', background: 'var(--canvas, #fafafa)', fontSize: 12, fontWeight: 600, color: INK, borderBottom: `1px solid ${LINE}` }}>{g.group} <span style={{ color: MUTED, fontWeight: 500 }}>({g.items.length})</span></div>
                {g.items.map((c, i) => (
                  <div key={c.path} style={{ padding: '9px 12px', borderTop: i ? '1px solid var(--divider-2, #f0f0f1)' : 'none', display: 'grid', gap: 5 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: INK, overflowWrap: 'anywhere' }}>{c.label}</span>
                      {c.kind !== 'changed' ? <Badge tone={c.kind === 'added' ? 'green' : 'red'}>{c.kind === 'added' ? 'Added' : 'Removed'}</Badge> : null}
                      {onJump && c.tab ? <button type="button" className="va-btn" style={{ ...linkBtn, fontSize: 12 }} onClick={() => onJump(c.path)}>Go to field</button> : null}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 6, fontSize: 12.5, lineHeight: 1.45 }}>
                      <span style={{ padding: '4px 8px', borderRadius: 7, background: 'var(--tint-red, #fef2f2)', color: c.from === 'empty' ? 'var(--meta, #71717a)' : RED, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}><span className="va-sr">Was: </span>{c.from}</span>
                      <span style={{ padding: '4px 8px', borderRadius: 7, background: 'var(--mint-dim, #e7f8f1)', color: c.to === 'empty' ? 'var(--meta, #71717a)' : '#065f46', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}><span className="va-sr">Now: </span>{c.to}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {added.length || removed.length ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>Prompt</span>
            <span style={{ fontSize: 12, color: MUTED }}>{tokens_from.toLocaleString('en-US')} to {tokens_to.toLocaleString('en-US')} tokens ({delta >= 0 ? '+' : ''}{delta.toLocaleString('en-US')})</span>
          </div>
          <div role="group" aria-label="Prompt changes" style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.5 }}>
            {removed.map((l, i) => (
              <div key={`r${i}`} style={{ display: 'flex', gap: 8, padding: '3px 10px', background: 'var(--tint-red, #fef2f2)', color: 'var(--tx-red-deep, #991b1b)' }}><span aria-label="removed" style={{ flex: 'none' }}>-</span><span style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{l}</span></div>
            ))}
            {added.map((l, i) => (
              <div key={`a${i}`} style={{ display: 'flex', gap: 8, padding: '3px 10px', background: 'var(--tint-green, #ecfdf5)', color: '#065f46' }}><span aria-label="added" style={{ flex: 'none' }}>+</span><span style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{l}</span></div>
            ))}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 11.5, color: MUTED }}>Only whole lines that appear on one side are shown; a reworded line shows as one removed and one added.</p>
        </div>
      ) : null}
    </div>
  );
}
