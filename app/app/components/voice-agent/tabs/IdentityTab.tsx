// AI Agent, Identity: who the agent says it is, and the languages it speaks.
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { LIMITS } from '@/lib/voice-agent';
import { addLanguage, fieldId } from '@/lib/voice-agent-console';
import { aiAgentApi, type AgentInfo, type HandoffTrigger } from '@/lib/ai-agent-client';
import { AgentAvatar } from '@/app/components/ai-agent/AgentAvatar';
import { Banner, ChipList, Field, Section, Segmented, SettingRow, Spinner, Switch, TextField, grid, eyebrow, input, primary } from '../kit';
import type { TabCtx } from '../types';

type Audience = 'sellers' | 'buyers' | 'both';

/**
 * The agent's face and which records it works (migration 123). Saved straight
 * away through the ai-agent function: neither is part of the prompt, so
 * neither needs a publish.
 */
function FaceAndAudience({ agentKey, workspaceId, detail, canEdit, demo, name, role }: Pick<TabCtx, 'agentKey' | 'workspaceId' | 'detail' | 'canEdit' | 'demo'> & { name: string; role: string }) {
  const api = useMemo(() => (workspaceId && !demo ? aiAgentApi(workspaceId) : null), [workspaceId, demo]);
  const [avatar, setAvatar] = useState<string | null>(detail.avatar_url ?? null);
  const [audience, setAudience] = useState<Audience>(detail.audience ?? (/^(buyer_assistant|jr_dispo)$/.test(role) ? 'buyers' : 'sellers'));
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<'realistic' | 'illustrated'>('realistic');
  const [busy, setBusy] = useState<null | 'avatar' | 'audience'>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const off = !canEdit || !api;

  const generate = async () => {
    if (!api) return;
    setBusy('avatar'); setMsg(null);
    const r = await api.generateAvatar(agentKey, prompt.trim() || undefined, style);
    setBusy(null);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    setAvatar(r.avatar_url);
    setMsg({ tone: 'ok', text: r.provider === 'gemini' ? (style === 'realistic' ? 'New headshot made with Gemini and saved.' : 'New picture made with Gemini and saved.') : 'New avatar drawn and saved.' });
  };
  const pickAudience = async (v: Audience) => {
    if (!api || v === audience) return;
    const was = audience;
    setAudience(v); setBusy('audience'); setMsg(null);
    const r = await api.setAudience(agentKey, v);
    setBusy(null);
    if (!r.ok) { setAudience(was); setMsg({ tone: 'error', text: r.error }); }
  };

  return (
    <Section id="va-face" title="Face and who it works" description="The picture reps see on records, the bulk bar and the AI agents report, and which records it may be switched on for.">
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative' }}>
          <AgentAvatar name={name || 'Agent'} src={avatar} size={88} />
          {busy === 'avatar' ? <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(255,255,255,.7)', display: 'grid', placeItems: 'center', color: '#0A8560' }}><Spinner size={22} /></span> : null}
        </div>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <label htmlFor="va-avatar-prompt" style={eyebrow}>Describe the look (optional)</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input id="va-avatar-prompt" className="va-field" value={prompt} disabled={off || !!busy} maxLength={400} onChange={(e) => setPrompt(e.target.value)}
              placeholder={`e.g. friendly woman in her 30s, navy blazer, warm smile`} style={{ ...input, flex: '1 1 220px' }} />
            <button type="button" className="va-btn va-prim" disabled={off || !!busy} onClick={() => void generate()} style={{ ...primary(off || !!busy), height: 36 }}>
              <Sparkles size={14} aria-hidden /> {avatar ? 'Regenerate' : 'Generate with AI'}
            </button>
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: '#71717a', lineHeight: 1.5 }}>
            Takes a few seconds. Gemini makes it (a realistic headshot of someone who doesn’t exist, or an illustration); without Gemini, Claude draws one.
          </p>
          <div style={{ marginTop: 8 }}>
            <Segmented<'realistic' | 'illustrated'> id="va-avatar-style" label="Picture style" value={style} disabled={off || !!busy} onChange={setStyle}
              options={[{ id: 'realistic', label: 'Realistic photo' }, { id: 'illustrated', label: 'Illustration' }]} />
          </div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <span style={eyebrow} id="va-audience-l">Works</span>
        <Segmented<Audience> id="va-audience" label="Works" value={audience} disabled={off || !!busy} onChange={(v) => void pickAudience(v)}
          options={[{ id: 'sellers', label: 'Sellers' }, { id: 'buyers', label: 'Buyers' }, { id: 'both', label: 'Both' }]} />
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#71717a', lineHeight: 1.5 }}>VIP buyers and funds are never put on an agent, whatever this says.</p>
      </div>
      {!api ? <div style={{ marginTop: 12 }}><Banner tone="info">Pictures and audiences are saved on a live workspace.</Banner></div> : null}
      {msg ? <div style={{ marginTop: 12 }}><Banner tone={msg.tone === 'ok' ? 'ok' : 'error'}>{msg.text}</Banner></div> : null}
    </Section>
  );
}

const TRIGGERS: { id: HandoffTrigger; title: string; help: string }[] = [
  { id: 'ready', title: 'When they are ready', help: 'The agent judges the person is ready for the next stage: they want to talk price, ask for an offer, or say yes to a call.' },
  { id: 'qualified', title: 'When the seller is qualified', help: 'Motivation, timeline and condition are all on the record after the agent has made at least one touch. Sellers only.' },
];
const serves = (a: string, b: string) => a === 'both' || b === 'both' || a === b;

/**
 * Who this agent passes a record to when its stage is done (migration 124),
 * so a seller goes Lead manager → Acquisitions with one agent on the record
 * at a time. Saved straight away, like the face: it is not part of the prompt.
 */
function HandOff({ agentKey, workspaceId, canEdit, demo }: Pick<TabCtx, 'agentKey' | 'workspaceId' | 'canEdit' | 'demo'>) {
  const api = useMemo(() => (workspaceId && !demo ? aiAgentApi(workspaceId) : null), [workspaceId, demo]);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [saved, setSaved] = useState<{ to: string | null; on: HandoffTrigger[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!api) return;
    let gone = false;
    void api.agents().then((r) => {
      if (gone) return;
      if (!r.ok) { setMsg({ tone: 'error', text: r.error }); setAgents([]); return; }
      setAgents(r.agents);
    });
    return () => { gone = true; };
  }, [api]);

  const me = agents?.find((a) => a.agent_key === agentKey) ?? null;
  // An unmigrated database sends no handoff_on: the setting cannot be saved yet.
  const unmigrated = !!me && me.handoff_on === undefined;
  const cur = saved ?? { to: me?.handoff_to ?? null, on: me?.handoff_on ?? ['ready', 'qualified'] };
  const others = (agents ?? []).filter((a) => a.agent_key !== agentKey && (!me || serves(a.audience, me.audience)));
  // The whole relay from here, for the picture next to the picker: stops at a person or a repeat.
  const chain: AgentInfo[] = [];
  for (let k = cur.to; k && chain.length < 4;) {
    const a = (agents ?? []).find((x) => x.agent_key === k);
    if (!a || a.agent_key === agentKey || chain.includes(a)) break;
    chain.push(a); k = a.handoff_to ?? null;
  }
  const off = !canEdit || !api || !me || unmigrated || busy;

  const save = async (to: string | null, on: HandoffTrigger[]) => {
    if (!api) return;
    setBusy(true); setMsg(null);
    const r = await api.setHandoff(agentKey, to, on);
    setBusy(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    setSaved({ to: r.handoff_to, on: r.handoff_on });
    setMsg({ tone: 'ok', text: r.handoff_to ? `Hands off to ${others.find((a) => a.agent_key === r.handoff_to)?.name ?? r.handoff_to}.` : 'Hands off to a person.' });
  };
  const flip = (t: HandoffTrigger, v: boolean) => {
    const on = v ? [...new Set([...cur.on, t])] : cur.on.filter((x) => x !== t);
    void save(cur.to, TRIGGERS.map((x) => x.id).filter((x) => on.includes(x)));
  };

  return (
    <Section id="va-handoff" title="Hands off to" description="When this agent's stage is done it passes the record on: to the next agent, who picks up with everything it learned, or to a person. One agent works a record at a time.">
      {agents === null && api ? <span style={{ fontSize: 12.5, color: '#71717a', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Spinner size={12} /> Loading agents…</span> : (
        <>
          <label htmlFor="va-handoff-to" style={eyebrow}>Next</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <select id="va-handoff-to" className="va-field" value={cur.to ?? ''} disabled={off} onChange={(e) => void save(e.target.value || null, cur.on)} style={{ ...input, flex: '0 1 320px' }}>
              <option value="">A person (the rep gets a notification)</option>
              {others.map((a) => <option key={a.agent_key} value={a.agent_key}>{a.name}{a.role_label || a.role ? ` · ${a.role_label || a.role.replace(/_/g, ' ')}` : ''}</option>)}
            </select>
            {me ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#52525b' }}>
                <AgentAvatar name={me.name} src={me.avatar_url} size={26} />
                <ArrowRight size={14} aria-hidden color="#a1a1aa" />
                {chain.map((a) => (
                  <React.Fragment key={a.agent_key}>
                    <AgentAvatar name={a.name} src={a.avatar_url} size={26} /><b>{a.name}</b>
                    <ArrowRight size={14} aria-hidden color="#a1a1aa" />
                  </React.Fragment>
                ))}
                <span style={{ color: chain.length ? '#71717a' : undefined, fontWeight: chain.length ? 400 : 700 }}>a person</span>
              </span>
            ) : null}
          </div>
          {cur.to ? (
            <div style={{ marginTop: 12 }}>
              {TRIGGERS.filter((t) => t.id !== 'qualified' || me?.audience !== 'buyers').map((t, i) => (
                <SettingRow key={t.id} first={i === 0} title={t.title} help={t.help}>
                  <Switch on={cur.on.includes(t.id)} disabled={off} label={t.title} onChange={(v) => flip(t.id, v)} />
                </SettingRow>
              ))}
              {!cur.on.length ? <div style={{ marginTop: 8 }}><Banner tone="warn">With both off it never passes a record on by itself: someone ready for a person still goes to the rep, and Hand off now on a record still works.</Banner></div> : null}
            </div>
          ) : null}
          <p style={{ margin: '8px 0 0', fontSize: 12, color: '#71717a', lineHeight: 1.5 }}>
            A hand-off is a line on the record&rsquo;s timeline, the touch count starts again, and the 20-hour gap between touches still holds. An automatic hand-off never sends a record back to an agent that already worked it.
          </p>
        </>
      )}
      {!api ? <div style={{ marginTop: 12 }}><Banner tone="info">Hand-offs are saved on a live workspace.</Banner></div> : null}
      {unmigrated ? <div style={{ marginTop: 12 }}><Banner tone="warn">Hand-offs need migration 124 on the database.</Banner></div> : null}
      {msg ? <div style={{ marginTop: 12 }}><Banner tone={msg.tone === 'ok' ? 'ok' : 'error'}>{msg.text}</Banner></div> : null}
    </Section>
  );
}

export function IdentityTab({ form, canEdit, agentKey, workspaceId, detail, demo }: TabCtx) {
  const { draft, errors, set } = form;
  const id = draft.identity;
  const off = !canEdit;
  const nameMissing = !id.name.trim();
  return (
    <>
      <FaceAndAudience agentKey={agentKey} workspaceId={workspaceId} detail={detail} canEdit={canEdit} demo={demo} name={id.name || detail.name} role={id.role} />
      <HandOff agentKey={agentKey} workspaceId={workspaceId} canEdit={canEdit} demo={demo} />
      <Section id="va-identity" title="Identity" description="What callers hear when the agent introduces itself.">
        <div style={grid()}>
          <Field label="Agent name" htmlFor={fieldId('identity.name')} error={errors['identity.name']} hint="The first name callers hear. Leave it empty and the agent falls back to the company name.">
            <TextField id={fieldId('identity.name')} value={id.name} disabled={off} maxLength={LIMITS.name} placeholder="Sam" error={errors['identity.name']} onChange={(v) => set(['identity', 'name'], v)} />
          </Field>
          <Field label="Company" htmlFor={fieldId('identity.company')} error={errors['identity.company']} hint="Said in the greeting and in {{company}} wherever the script uses it.">
            <TextField id={fieldId('identity.company')} value={id.company} disabled={off} maxLength={LIMITS.company} placeholder="Acme Homes" error={errors['identity.company']} onChange={(v) => set(['identity', 'company'], v)} />
          </Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Field label="Role" htmlFor={fieldId('identity.role')} error={errors['identity.role']} hint="The job the agent does, like lead_manager or acquisitions. Shown on the agent's card and in its prompt.">
            <TextField id={fieldId('identity.role')} value={id.role} disabled={off} maxLength={LIMITS.role} placeholder="lead_manager" error={errors['identity.role']} onChange={(v) => set(['identity', 'role'], v)} />
          </Field>
        </div>
        {nameMissing && canEdit ? <div style={{ marginTop: 14 }}><Banner tone="warn">This agent has no name yet. Templates leave it empty on purpose: add one before you publish.</Banner></div> : null}
      </Section>

      <Section id="va-intro" title="How it introduces itself" description="Whether the opening says the agent is a virtual assistant.">
        <span style={eyebrow} id="va-introduce-l">Introduction</span>
        <Segmented<'none' | 'virtual_assistant'> id={fieldId('identity.introduce_as')} label="Introduction" value={id.introduce_as} disabled={off} onChange={(v) => set(['identity', 'introduce_as'], v)}
          options={[{ id: 'virtual_assistant', label: 'Virtual assistant' }, { id: 'none', label: 'Just the name' }]} />
        <p style={{ margin: '8px 0 0', fontSize: 12, color: '#71717a', lineHeight: 1.5 }}>
          &ldquo;Virtual assistant&rdquo; opens with &ldquo;this is Sam, a virtual assistant with Acme Homes&rdquo;. Either way the agent always says honestly that it is an AI when someone sincerely asks. That part is locked and lives under Rules.
        </p>
      </Section>

      <Section id="va-languages" title="Languages" description="The language codes the agent may speak, like en or es.">
        <label htmlFor={fieldId('identity.languages')} style={eyebrow}>Languages</label>
        <ChipList id={fieldId('identity.languages')} items={id.languages} onChange={(next) => set(['identity', 'languages'], next.length ? next : ['en'])} add={addLanguage} placeholder="en, then Enter" disabled={off} max={LIMITS.languages} />
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#71717a', lineHeight: 1.5 }}>
          English is always on. More than one language needs a language preset on the ElevenLabs agent, which publishing does not create: it is listed as a manual step. {id.languages.length}/{LIMITS.languages}
        </p>
        {errors['identity.languages'] ? <p role="alert" style={{ margin: '6px 0 0', fontSize: 12, color: '#b91c1c' }}>{errors['identity.languages']}</p> : null}
      </Section>
    </>
  );
}
