// The agents of a workspace as cards: name, role, whether it is draft, live or
// has unpublished changes, the live version, its numbers, and whether it is
// answering. A workspace holds up to ten. Select one to open its console;
// duplicate and delete sit on the card.
'use client';

import React from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { AgentAvatar } from '@/app/components/ai-agent/AgentAvatar';
import { STATUS_LABEL, agentStatus, enabledNote, roleLabel, type AgentStats, type AgentSummary } from '@/lib/voice-agent';
import { MAX_AGENTS, agentTitle, formatAvg } from '@/lib/voice-agent-console';
import { Badge, GREEN, INK, MUTED, RED, Switch, ghost } from './kit';

const STATUS_TONE = { draft: 'grey', live: 'green', unpublished: 'amber' } as const;

export function AgentList({ agents, stats, selected, dirtyKeys, canEdit, isMobile, switching, switchErrors, onToggle, onSelect, onNew, onDuplicate, onDelete }: {
  agents: AgentSummary[]; stats: Record<string, AgentStats | undefined>; selected: string | null; dirtyKeys: string[]; canEdit: boolean; isMobile: boolean;
  /** Keys with a set_enabled request in flight, and the last refusal per key. */
  switching: string[]; switchErrors: Record<string, string | undefined>; onToggle: (a: AgentSummary, enabled: boolean) => void;
  onSelect: (key: string) => void; onNew: () => void; onDuplicate: (a: AgentSummary) => void; onDelete: (a: AgentSummary) => void;
}) {
  const full = agents.length >= MAX_AGENTS;
  return (
    <section aria-label="Agents" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: INK }}>Agents</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: MUTED }}>{agents.length} of {MAX_AGENTS}. Each one has its own voice, script, rules and phone line in ElevenLabs.</p>
        </div>
        {canEdit ? (
          <button type="button" className="va-btn va-ghost" style={{ ...ghost, height: 34, padding: '0 14px' }} disabled={full} title={full ? `A workspace can have up to ${MAX_AGENTS} agents` : undefined} onClick={onNew}>
            <Plus size={15} aria-hidden="true" /> New agent
          </button>
        ) : null}
      </div>
      <ul className={isMobile ? 'va-noscroll' : undefined} style={{
        listStyle: 'none', margin: 0, padding: isMobile ? '2px 0 6px' : 0, display: isMobile ? 'flex' : 'grid', gap: 10,
        gridTemplateColumns: isMobile ? undefined : 'repeat(auto-fill, minmax(min(100%, 250px), 1fr))', overflowX: isMobile ? 'auto' : undefined, scrollSnapType: isMobile ? 'x mandatory' : undefined,
      }}>
        {agents.map((a) => {
          const on = a.agent_key === selected;
          const status = agentStatus(a);
          const st = stats[a.agent_key];
          const unsaved = dirtyKeys.includes(a.agent_key);
          return (
            <li key={a.agent_key} style={{ flex: isMobile ? '0 0 min(82%, 270px)' : undefined, scrollSnapAlign: 'start', minWidth: 0 }}>
              <div className="va-agent" data-on={on ? '' : undefined} style={{ height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 12, background: 'var(--surface, #fff)', border: `1px solid ${on ? GREEN : 'var(--edge)'}`, boxShadow: on ? `0 0 0 1px ${GREEN}, var(--elev-2)` : 'var(--elev-1)', overflow: 'hidden' }}>
                <button type="button" className="va-btn" aria-current={on ? 'true' : undefined} aria-label={`Open ${agentTitle(a)}, ${roleLabel(a.role)}, ${STATUS_LABEL[status]}`} onClick={() => onSelect(a.agent_key)}
                  style={{ flex: 1, textAlign: 'left', padding: '12px 14px 10px', border: 0, background: on ? '#f4fbf8' : 'transparent', cursor: 'pointer', fontFamily: 'inherit', display: 'block', width: '100%' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AgentAvatar name={agentTitle(a)} src={a.avatar_url} size={30} live={a.enabled && a.live_version > 0} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: on ? GREEN : INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agentTitle(a)}</span>
                    <span title={enabledNote(a)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: a.enabled ? GREEN : MUTED, flex: 'none' }}>
                      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: a.enabled ? '#10b981' : '#d4d4d8' }} />{a.enabled ? 'On' : 'Off'}
                    </span>
                  </span>
                  <span style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                    <Badge tone="indigo">{roleLabel(a.role)}</Badge>
                    {a.audience ? <Badge tone="grey">{a.audience === 'buyers' ? 'Buyers' : a.audience === 'both' ? 'Sellers + buyers' : 'Sellers'}</Badge> : null}
                    <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
                    {unsaved ? <Badge tone="amber">Unsaved edits</Badge> : null}
                  </span>
                  <span style={{ display: 'block', marginTop: 9, fontSize: 12, color: MUTED }}>{a.live_version > 0 ? `Live v${a.live_version}` : 'Never published'}</span>
                  <span style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 8 }}>
                    {[['Calls', String(st?.calls ?? 0)], ['Avg', formatAvg(st?.avg_duration_s ?? 0)], ['Transferred', String(st?.transferred ?? 0)]].map(([k, v]) => (
                      <span key={k} style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 11.5, color: MUTED, fontWeight: 600 }}>{k}</span>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
                      </span>
                    ))}
                  </span>
                </button>
                {canEdit ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px 5px 14px', borderTop: '1px solid var(--band-line)', background: 'var(--band)' }}>
                    <Switch on={a.enabled} busy={switching.includes(a.agent_key)} disabled={a.live_version <= 0} onChange={(v) => onToggle(a, v)} label={`${agentTitle(a)} answers calls`} />
                    <span title={enabledNote(a)} style={{ fontSize: 12, fontWeight: 600, color: a.live_version > 0 && a.enabled ? GREEN : MUTED }}>{a.live_version <= 0 ? 'Not live yet' : a.enabled ? 'Answering' : 'Switched off'}</span>
                  </div>
                ) : null}
                {switchErrors[a.agent_key] ? (
                  <div role="alert" style={{ padding: '6px 12px 7px 14px', fontSize: 12, lineHeight: 1.4, color: 'var(--danger-ink)', background: 'var(--danger-bg)', borderTop: '1px solid var(--danger-line)' }}>{switchErrors[a.agent_key]}</div>
                ) : null}
                {canEdit ? (
                  <div style={{ display: 'flex', gap: 2, padding: '4px 8px 6px', borderTop: '1px solid var(--band-line)' }}>
                    <button type="button" className="va-btn va-ghost" disabled={full} title={full ? `A workspace can have up to ${MAX_AGENTS} agents` : undefined} aria-label={`Duplicate ${agentTitle(a)}`} onClick={() => onDuplicate(a)}
                      style={{ ...ghost, height: 28, padding: '0 8px', border: 0, background: 'transparent', color: MUTED, fontSize: 12 }}><Copy size={13} aria-hidden="true" /> Duplicate</button>
                    <button type="button" className="va-btn va-ghost" aria-label={`Delete ${agentTitle(a)}`} onClick={() => onDelete(a)}
                      style={{ ...ghost, height: 28, padding: '0 8px', border: 0, background: 'transparent', color: RED, fontSize: 12 }}><Trash2 size={13} aria-hidden="true" /> Delete</button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
