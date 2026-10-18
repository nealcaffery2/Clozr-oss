// The three things you do to an agent as a whole: create one (from a template
// or blank), duplicate one, delete one. Each is a dialog that names what will
// happen and shows the server's refusal (ten agents, a taken key) in place.
'use client';

import React, { useEffect, useState } from 'react';
import type { Api, CreatedAgent } from '@/lib/voice-agent-client';
import type { AgentSummary, TemplateInfo } from '@/lib/voice-agent';
import { agentKeyFor, agentTitle } from '@/lib/voice-agent-console';
import { Banner, ConfirmDialog, Dialog, Field, GREEN, INK, LINE, MUTED, Skeleton, Spinner, TextField, ghost, primary } from './kit';

type Choice = 'lead_manager' | 'acquisitions' | 'speed_to_lead' | 'reactivation' | 'blank';

export function NewAgentDialog({ api, taken, onClose, onCreated }: { api: Api; taken: string[]; onClose: () => void; onCreated: (c: CreatedAgent) => void }) {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [tplError, setTplError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>('lead_manager');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.templates().then((r) => { if (!live) return; if (r.ok) setTemplates(r.data.templates); else setTplError(r.error); });
    return () => { live = false; };
  }, [api]);

  const options: { id: Choice; label: string; hint: string; items: string[] }[] = [
    ...(templates ?? []).filter((t) => ['lead_manager', 'acquisitions', 'speed_to_lead', 'reactivation'].includes(t.id)).map((t) => ({ id: t.id as Choice, label: t.name, hint: t.description, items: t.open_items })),
    { id: 'blank', label: 'Blank', hint: 'Starts with the defaults and no script. You write everything yourself.', items: [] },
  ];
  const picked = options.find((o) => o.id === choice);

  const create = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const trimmed = name.trim();
    const key = trimmed ? agentKeyFor(trimmed, taken) : '';
    const r = await api.createAgent({ ...(choice === 'blank' ? {} : { template: choice }), ...(trimmed ? { name: trimmed } : {}), ...(key ? { agent_key: key } : {}) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onCreated(r.data);
  };

  return (
    <Dialog title="New agent" titleId="va-new-title" onClose={onClose} busy={busy} width={620}
      footer={(
        <>
          <button type="button" className="va-btn va-ghost" style={ghost} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="va-btn va-prim" style={{ ...primary(busy || !templates), minWidth: 120 }} disabled={busy || !templates} onClick={() => void create()}>
            {busy ? <Spinner size={14} /> : null}{busy ? 'Creating…' : 'Create agent'}
          </button>
        </>
      )}>
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <span id="va-new-start" style={{ display: 'block', fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>Start from</span>
          {!templates && !tplError ? <div aria-busy="true" aria-label="Loading templates" style={{ display: 'grid', gap: 8 }}><Skeleton h={62} style={{ borderRadius: 10 }} /><Skeleton h={62} style={{ borderRadius: 10 }} /></div> : null}
          {tplError ? <Banner tone="error">Could not load the templates. {tplError}</Banner> : null}
          {templates ? (
            <div role="radiogroup" aria-labelledby="va-new-start" style={{ display: 'grid', gap: 8 }}>
              {options.map((o, i) => {
                const on = o.id === choice;
                return (
                  <button key={o.id} type="button" role="radio" aria-checked={on} className="va-btn" data-autofocus={i === 0 ? true : undefined} onClick={() => setChoice(o.id)}
                    style={{ textAlign: 'left', padding: '11px 13px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${on ? GREEN : LINE}`, background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', boxShadow: on ? `0 0 0 1px ${GREEN}` : 'none' }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: on ? GREEN : INK }}>{o.label}</span>
                    <span style={{ display: 'block', marginTop: 2, fontSize: 12.5, color: MUTED, lineHeight: 1.45 }}>{o.hint}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <Field label="Name (optional)" htmlFor="va-new-name" hint="What callers hear. You can set it later on the Identity tab.">
          <TextField id="va-new-name" value={name} maxLength={40} placeholder="Riley" onChange={setName} />
        </Field>

        {picked && picked.items.length ? (
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--tint-amber, #fffbeb)', border: '1px solid var(--tint-amber-2, #fde68a)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx-amber-deep, #92400e)' }}>Yours to confirm before it goes live</div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--tx-amber-deep, #92400e)', lineHeight: 1.55 }}>{picked.items.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </div>
        ) : null}
        {error ? <Banner tone="error">{error}</Banner> : null}
      </div>
    </Dialog>
  );
}

export function DuplicateDialog({ api, agent, onClose, onCreated }: { api: Api; agent: AgentSummary; onClose: () => void; onCreated: (c: CreatedAgent) => void }) {
  const [name, setName] = useState(`${agent.name || 'Agent'} copy`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await api.duplicateAgent(agent.agent_key, name.trim() || undefined);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onCreated(r.data);
  };
  return (
    <Dialog title={`Duplicate ${agentTitle(agent)}`} titleId="va-dup-title" onClose={onClose} busy={busy} width={460}
      footer={(
        <>
          <button type="button" className="va-btn va-ghost" style={ghost} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="va-btn va-prim" style={{ ...primary(busy), minWidth: 110 }} disabled={busy} onClick={() => void run()}>{busy ? <Spinner size={14} /> : null}{busy ? 'Copying…' : 'Duplicate'}</button>
        </>
      )}>
      <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.55, color: INK }}>The copy gets the same settings as the draft you see here, as a new draft that has never been published. It does not share the live agent.</p>
      <Field label="Name of the copy" htmlFor="va-dup-name">
        <TextField id="va-dup-name" value={name} maxLength={40} onChange={setName} />
      </Field>
      {error ? <div style={{ marginTop: 12 }}><Banner tone="error">{error}</Banner></div> : null}
    </Dialog>
  );
}

export function DeleteDialog({ api, agent, onClose, onDeleted }: { api: Api; agent: AgentSummary; onClose: () => void; onDeleted: (key: string, remote: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    const r = await api.deleteAgent(agent.agent_key);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDeleted(r.data.deleted, r.data.remote_deleted);
  };
  return (
    <ConfirmDialog title={`Delete ${agentTitle(agent)}?`} titleId="va-del-title" confirmLabel="Delete agent" busy={busy} error={error} onConfirm={() => void run()} onClose={onClose}>
      <p style={{ margin: 0 }}>Its settings and every saved version are removed. This cannot be undone.</p>
      {agent.agent_id ? <p style={{ margin: '10px 0 0' }}><strong>It is published, so the ElevenLabs agent is deleted too</strong> and its calls stop being answered by it.</p> : null}
    </ConfirmDialog>
  );
}
