// AI Agent, Tools: what the agent may do mid-call. `available` is set by the
// server from what is built; a tool that is not built shows as Coming soon
// with its switch off the table, and is never mentioned to the agent.
'use client';

import React from 'react';
import { Wrench } from 'lucide-react';
import { TOOL_KEYS, TOOL_META, type ToolKey } from '@/lib/voice-agent';
import { Badge, Banner, LINE, Section, Switch, linkBtn, INK, MUTED } from '../kit';
import type { TabCtx } from '../types';

export function ToolsTab({ form, canEdit, goTo }: TabCtx) {
  const { draft, set } = form;
  const built = TOOL_KEYS.filter((k) => draft.tools[k].available).length;
  const off = !canEdit;
  const transferNeedsSetup = draft.tools.transfer.enabled && !(draft.live_transfer.enabled && draft.live_transfer.destinations.length);
  return (
    <Section id="va-tools" title="Tools" description={`Things the agent can do during a call. ${built} of ${TOOL_KEYS.length} are built today.`}
      help="A tool that is not built is stored but never offered to the agent, so a script cannot send it to something that does not exist yet.">
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
        {TOOL_KEYS.map((k: ToolKey, i) => {
          const t = draft.tools[k];
          const meta = TOOL_META[k];
          const soon = !t.available;
          return (
            <li key={k} id={`va-f-tools-${k}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', borderTop: i ? '1px solid var(--divider-2, #f0f0f1)' : 'none', background: soon ? 'var(--canvas, #fafafa)' : 'var(--surface, #fff)' }}>
              <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 8, flex: 'none', display: 'grid', placeItems: 'center', background: soon ? 'var(--inset)' : 'var(--chip-ok)', boxShadow: `inset 0 0 0 1px ${soon ? 'var(--inset-line)' : 'var(--ok-line)'}`, color: soon ? '#71717a' : 'var(--ok-ink)' }}><Wrench size={15} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: soon ? MUTED : INK }}>{meta.label}</span>
                  <code style={{ fontSize: 11.5, color: MUTED }}>{k}</code>
                  {soon ? <Badge tone="grey">Coming soon</Badge> : null}
                </div>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{meta.hint}</p>
                {k === 'transfer' && t.available && transferNeedsSetup ? (
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--tx-amber-deep, #92400e)', lineHeight: 1.5 }}>
                    Needs live transfer switched on with a destination. <button type="button" className="va-btn" style={linkBtn} onClick={() => goTo('transfer')}>Set it up</button>
                  </p>
                ) : null}
                {k === 'mark_do_not_contact' ? <p style={{ margin: '6px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>Until this exists, a do not contact request is only recorded in the call log. The agent still ends the call.</p> : null}
              </div>
              <Switch label={`${meta.label}${soon ? ' (coming soon)' : ''}`} on={soon ? false : t.enabled} disabled={off || soon} onChange={(v) => set(['tools', k, 'enabled'], v)} />
            </li>
          );
        })}
      </ul>
      <div style={{ marginTop: 12 }}>
        <Banner tone="info">Book, save, offer and agreement tools are next. Until they exist the templates use fallback wording: the agent notes the next step and the call is logged.</Banner>
      </div>
    </Section>
  );
}
