// Settings, AI Agent, AI Autopilot (migration 146, docs/ai-agents.md): the
// rules that put leads on an agent without anyone switching it on. Three cards:
// Speed to lead (a new lead from a source the owner picked is called or texted
// within seconds), Follow-up (the ones not reached or not booked stay on a
// cadence) and Dead lead reactivation (every night, aged leads from the People
// smart lists). A live line says what it did today. Owners and admins edit;
// everyone else reads.
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Phone, Play, RefreshCw, Zap } from 'lucide-react';
import { useSession } from '@/lib/session';
import { useCanWrite } from '@/lib/read-only-context';
import {
  aiAgentApi, autopilotStatusLine, CHANNEL_LABEL, RVM_HELP,
  type AutopilotSettings, type AutopilotSource, type AutopilotView, type Channel, type ReactivationListId,
} from '@/lib/ai-agent-client';
import { Badge, Banner, Field, GREEN, INK, MUTED, Section, SettingRow, Switch, VaStyles, card, ghost, grid, input, primary } from '@/app/components/voice-agent/kit';

type Load = { at: 'loading' } | { at: 'ready'; view: AutopilotView } | { at: 'error'; error: string };

const CHANNELS: Channel[] = ['call', 'rvm', 'sms', 'email'];
const WEEK: [string, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cadenceText = (d: number[]) => d.join(', ');
const cadenceOf = (t: string) => t.split(/[\s,]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n));

export function AutopilotPanel({ isMobile }: { isMobile: boolean }) {
  const s = useSession();
  const canWrite = useCanWrite();
  const ws = s.workspace?.id ?? null;
  const api = useMemo(() => (ws && !s.demo ? aiAgentApi(ws) : null), [ws, s.demo]);
  const [load, setLoad] = useState<Load>({ at: 'loading' });
  const [draft, setDraft] = useState<AutopilotSettings | null>(null);
  const [cadence, setCadence] = useState('');
  const [busy, setBusy] = useState<'save' | 'run' | 'test' | null>(null);
  const [testPhone, setTestPhone] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const take = useCallback((view: AutopilotView) => {
    setLoad({ at: 'ready', view });
    setDraft(view.settings);
    setCadence(cadenceText(view.settings.followup.cadence_days));
  }, []);
  const read = useCallback(async () => {
    if (!api) return;
    const r = await api.autopilot();
    if (r.ok) take(r); else setLoad({ at: 'error', error: r.error });
  }, [api, take]);
  useEffect(() => {
    let live = true;
    if (!api) return;
    void api.autopilot().then((r) => { if (!live) return; if (r.ok) take(r); else setLoad({ at: 'error', error: r.error }); });
    return () => { live = false; };
  }, [api, take]);

  if (!api) return null;
  if (load.at === 'loading' || !draft) {
    return <section style={{ ...card, marginBottom: 12 }} aria-busy="true" aria-label="Loading AI Autopilot"><VaStyles /><div style={{ fontSize: 12.5, color: MUTED }}>Loading AI Autopilot…</div></section>;
  }
  if (load.at === 'error') {
    return <section style={{ ...card, marginBottom: 12 }}><VaStyles /><Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => void read()}>Try again</button>}>Could not load AI Autopilot. {load.error}</Banner></section>;
  }
  const view = load.view;
  const edit = view.can_edit && canWrite && view.migrated;
  const dirty = !same(draft, view.settings) || cadence !== cadenceText(view.settings.followup.cadence_days);
  const set = (fn: (d: AutopilotSettings) => AutopilotSettings) => setDraft((d) => (d ? fn(structuredClone(d)) : d));
  const agentName = (k: string | null, fallback: string | null) => view.agents.find((a) => a.agent_key === (k ?? fallback))?.name ?? 'No agent yet';

  const save = async () => {
    if (busy) return;
    setBusy('save'); setNote(null);
    const r = await api.setAutopilot({ ...draft, followup: { ...draft.followup, cadence_days: cadenceOf(cadence) } });
    setBusy(null);
    if (!r.ok) return setNote({ ok: false, text: r.error });
    take(r);
    setNote({ ok: true, text: 'Saved. AI Autopilot works from these rules now.' });
  };
  const runNow = async () => {
    if (busy) return;
    setBusy('run'); setNote(null);
    const r = await api.runReactivation();
    setBusy(null);
    if (!r.ok) return setNote({ ok: false, text: r.error });
    setNote({ ok: true, text: r.enrolled ? `${r.enrolled} aged lead${r.enrolled === 1 ? '' : 's'} put on the agent. First touches go out inside the sending window.` : 'Nothing to reactivate right now (or today\'s cap is used).' });
    void read();
  };

  const testCall = async () => {
    if (busy || !testPhone.trim()) return;
    setBusy('test'); setNote(null);
    const r = await api.testCall(testPhone.trim(), draft.speed.agent_key);
    setBusy(null);
    setNote(r.ok ? { ok: true, text: `${r.note} Pick up and talk to it like a seller would.` } : { ok: false, text: r.error });
  };

  const speedSources = view.sources.filter((x) => x.leads > 0 || draft.speed.sources.some((k) => k.toLowerCase() === x.source.toLowerCase()) || x.kind === 'inbound');
  const listSources = draft.speed.sources.filter((k) => view.sources.find((x) => x.source.toLowerCase() === k.toLowerCase())?.kind === 'list');

  return (
    <div style={{ marginBottom: 14, display: 'grid', gap: 12 }}>
      <VaStyles />
      <Section id="autopilot" title="AI Autopilot"
        description="New leads get a call or a text within seconds, the ones not reached stay on a follow-up cadence, and aged leads are reactivated every night. Every touch keeps the agent's guard rails: do-not-contact, calling hours in the lead's time zone, no prices in writing, the opt-out line on the first text."
        aside={edit ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="va-btn va-ghost" style={ghost} disabled={!dirty || !!busy} onClick={() => { setDraft(view.settings); setCadence(cadenceText(view.settings.followup.cadence_days)); }}>Discard</button>
            <button type="button" className="va-btn va-prim" style={primary(!dirty || !!busy)} disabled={!dirty || !!busy} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          </div>
        ) : null}>
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: INK, flexWrap: 'wrap' }}>
          <Zap size={14} aria-hidden="true" style={{ color: GREEN, flex: 'none' }} />
          <span style={{ flex: '1 1 260px', minWidth: 0 }}>{autopilotStatusLine(view.today, view.running)}</span>
          <button type="button" className="va-btn va-ghost" style={{ ...ghost, height: 28 }} onClick={() => void read()} aria-label="Refresh today's numbers"><RefreshCw size={13} aria-hidden="true" /> Refresh</button>
        </div>
        {!view.migrated ? <div style={{ marginTop: 10 }}><Banner tone="warn">AI Autopilot needs migration 146 (ai_autopilot). It applies on the next merge to main; until then nothing here runs.</Banner></div> : null}
        {!view.agents.length ? <div style={{ marginTop: 10 }}><Banner tone="warn">No agent works sellers yet. Create a Lead manager (or the Speed to lead and Reactivation templates) below first.</Banner></div> : null}
        {!view.can_edit ? <p style={{ margin: '10px 0 0', fontSize: 12, color: MUTED }}>Only owners and admins can change these rules.</p> : null}
        {note ? <div style={{ marginTop: 10 }}><Banner tone={note.ok ? 'ok' : 'error'}>{note.text}</Banner></div> : null}
      </Section>

      <div style={grid(isMobile ? 260 : 300)}>
        {/* ---- speed to lead ---- */}
        <Section id="autopilot-speed" title="Speed to lead" description="Calls every new lead from the sources you pick within seconds, any day, inside the calling window in the lead's own time zone. A call that is not answered gets a text."
          aside={<Switch on={draft.speed.enabled} disabled={!edit} onChange={(v) => set((d) => { d.speed.enabled = v; return d; })} label="Speed to lead on" />}>
          <Field label="Lead sources it may call" htmlFor="ap-speed-sources" hint="Only leads that asked to hear from you. A purchased or pulled list needs its own consent before an AI calls it.">
            <SourcePicker id="ap-speed-sources" sources={speedSources} picked={draft.speed.sources} disabled={!edit} onChange={(v) => set((d) => { d.speed.sources = v; return d; })} />
          </Field>
          {listSources.length ? <div style={{ marginTop: 8 }}><Banner tone="warn">{listSources.join(', ')} look{listSources.length === 1 ? 's' : ''} like a list, not leads that asked to hear from you. Only keep {listSources.length === 1 ? 'it' : 'them'} if you have their consent to automated calls and texts.</Banner></div> : null}
          {draft.speed.enabled && !draft.speed.sources.length ? <div style={{ marginTop: 8 }}><Banner tone="info">Pick at least one source: nothing is called until you do.</Banner></div> : null}
          <div style={{ ...grid(160), marginTop: 12 }}>
            <AgentSelect id="ap-speed-agent" label="Agent" view={view} value={draft.speed.agent_key} fallback={view.defaults.speed} disabled={!edit} onChange={(k) => set((d) => { d.speed.agent_key = k; return d; })} />
            <Field label="Calling window (lead's time)" htmlFor="ap-speed-start" hint="8am to 9pm at most.">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input id="ap-speed-start" type="time" style={input} disabled={!edit} value={draft.speed.window.start} onChange={(e) => set((d) => { d.speed.window.start = e.target.value; return d; })} aria-label="Window opens" />
                <span style={{ color: MUTED, fontSize: 12 }}>to</span>
                <input type="time" style={input} disabled={!edit} value={draft.speed.window.end} onChange={(e) => set((d) => { d.speed.window.end = e.target.value; return d; })} aria-label="Window closes" />
              </div>
            </Field>
          </div>
          <Field label="Days it calls" htmlFor="ap-speed-days" hint="Every day by default (24/7 inside the hours above). Outside the schedule a text goes out and the call waits.">
            <div id="ap-speed-days" role="group" aria-label="Days" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {WEEK.map(([d, label]) => {
                const days = draft.speed.window.days ?? WEEK.map(([x]) => x);
                return <Chip key={d} on={days.includes(d)} disabled={!edit} label={label}
                  onChange={(v) => set((x) => { const cur = x.speed.window.days ?? WEEK.map(([k]) => k); const next = v ? [...cur, d] : cur.filter((k) => k !== d); if (next.length) x.speed.window.days = next; return x; })} />;
              })}
            </div>
          </Field>
          <SettingRow first title="Channels" help="In this order: a call first when the agent can call, else a text right away. A voicemail is never the first touch; it comes on the follow-up cadence.">
            <Channels value={draft.speed.channels} disabled={!edit} onChange={(v) => set((d) => { d.speed.channels = v; return d; })} />
          </SettingRow>
          <SettingRow title="After hours: text now, call when the window opens" help="Off: nothing goes out until the window opens. Some states limit texts at night too; check with counsel.">
            <Switch on={draft.speed.after_hours_text} disabled={!edit} onChange={(v) => set((d) => { d.speed.after_hours_text = v; return d; })} label="Text after hours" />
          </SettingRow>
          <SettingRow title="Text if the call is not answered after" help="Minutes.">
            <input type="number" min={1} max={30} style={{ ...input, width: 80 }} disabled={!edit} value={draft.speed.fallback_minutes} onChange={(e) => set((d) => { d.speed.fallback_minutes = Number(e.target.value); return d; })} aria-label="Fallback minutes" />
          </SettingRow>
          {edit ? (
            <SettingRow title="Call me now" help="Hear it for yourself: the speed-to-lead agent calls your phone as if you were a new lead named Alex. No record is touched.">
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="tel" inputMode="tel" placeholder="Your phone" style={{ ...input, width: 150 }} value={testPhone} onChange={(e) => setTestPhone(e.target.value)} aria-label="Your phone number" />
                <button type="button" className="va-btn va-ghost" style={ghost} disabled={!!busy || !testPhone.trim()} onClick={() => void testCall()}><Phone size={13} aria-hidden="true" /> {busy === 'test' ? 'Calling…' : 'Call me'}</button>
              </div>
            </SettingRow>
          ) : null}
        </Section>

        {/* ---- follow-up ---- */}
        <Section id="autopilot-followup" title="Follow-up" description="A new lead that was not reached or not booked stays on the agent with a cadence, then monthly. It stops when they book, ask to stop, say not interested, the lead goes to a dead stage, or a rep calls, texts or moves it past qualification."
          aside={<Switch on={draft.followup.enabled} disabled={!edit} onChange={(v) => set((d) => { d.followup.enabled = v; return d; })} label="Follow-up on" />}>
          <div style={grid(160)}>
            <AgentSelect id="ap-fu-agent" label="Agent" view={view} value={draft.followup.agent_key} fallback={draft.speed.agent_key ?? view.defaults.speed} disabled={!edit} onChange={(k) => set((d) => { d.followup.agent_key = k; return d; })} hint="Blank: the speed agent keeps the lead." />
            <Field label="Cadence (days)" htmlFor="ap-fu-cadence" hint="Day 0 is the speed touch; then monthly after the last.">
              <input id="ap-fu-cadence" style={input} disabled={!edit} value={cadence} onChange={(e) => setCadence(e.target.value)} />
            </Field>
            <Field label="Most touches" htmlFor="ap-fu-max">
              <input id="ap-fu-max" type="number" min={2} max={60} style={input} disabled={!edit} value={draft.followup.max_touches} onChange={(e) => set((d) => { d.followup.max_touches = Number(e.target.value); return d; })} />
            </Field>
          </div>
          <SettingRow title="Channels" help={`Voicemail drops one ringless voicemail on the second cadence day, after the first call or text, and never two within a week. ${RVM_HELP}`}>
            <Channels value={draft.followup.channels} disabled={!edit} onChange={(v) => set((d) => { d.followup.channels = v; return d; })} />
          </SettingRow>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>The agent drafts each touch from the record&apos;s history, inside the agent&apos;s sending window, never twice in 20 hours unless they replied.</p>
        </Section>

        {/* ---- reactivation ---- */}
        <Section id="autopilot-reactivation" title="Dead lead reactivation" description="Every night, aged leads from the People smart lists go on the agent to re-engage, re-qualify and book, up to a daily cap. Never a lead under contract, closed, do-not-contact or already on an agent; each lead once."
          aside={<Switch on={draft.reactivation.enabled} disabled={!edit} onChange={(v) => set((d) => { d.reactivation.enabled = v; return d; })} label="Reactivation on" />}>
          <Field label="From these lists" htmlFor="ap-re-lists">
            <div id="ap-re-lists" role="group" aria-label="Smart lists" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {view.lists.map((l) => (
                <Chip key={l.id} on={draft.reactivation.lists.includes(l.id)} disabled={!edit} label={l.label}
                  onChange={(v) => set((d) => { d.reactivation.lists = (v ? [...d.reactivation.lists, l.id] : d.reactivation.lists.filter((x) => x !== l.id)) as ReactivationListId[]; return d; })} />
              ))}
            </div>
          </Field>
          <div style={{ ...grid(140), marginTop: 12 }}>
            <AgentSelect id="ap-re-agent" label="Agent" view={view} value={draft.reactivation.agent_key} fallback={view.defaults.reactivation} disabled={!edit} onChange={(k) => set((d) => { d.reactivation.agent_key = k; return d; })} />
            <Field label="No contact for (days)" htmlFor="ap-re-idle">
              <input id="ap-re-idle" type="number" min={30} max={3650} style={input} disabled={!edit} value={draft.reactivation.idle_days} onChange={(e) => set((d) => { d.reactivation.idle_days = Number(e.target.value); return d; })} />
            </Field>
            <Field label="Per day, at most" htmlFor="ap-re-cap">
              <input id="ap-re-cap" type="number" min={1} max={500} style={input} disabled={!edit} value={draft.reactivation.daily_cap} onChange={(e) => set((d) => { d.reactivation.daily_cap = Number(e.target.value); return d; })} />
            </Field>
          </div>
          <Field label="Only these sources (none picked: any)" htmlFor="ap-re-sources">
            <SourcePicker id="ap-re-sources" sources={view.sources} picked={draft.reactivation.sources} disabled={!edit} onChange={(v) => set((d) => { d.reactivation.sources = v; return d; })} />
          </Field>
          <SettingRow title="Channels" help={`Texts and email by default. A call needs the agent published with a phone number, and consent to AI calls. Voicemail drops one ringless voicemail on the first day. ${RVM_HELP}`}>
            <Channels value={draft.reactivation.channels} disabled={!edit} onChange={(v) => set((d) => { d.reactivation.channels = v; return d; })} />
          </SettingRow>
          {edit ? (
            <button type="button" className="va-btn va-ghost" style={{ ...ghost, marginTop: 6 }} disabled={!!busy || dirty || !view.settings.reactivation.enabled} title={dirty ? 'Save first' : !view.settings.reactivation.enabled ? 'Switch reactivation on and save first' : undefined} onClick={() => void runNow()}>
              <Play size={13} aria-hidden="true" /> {busy === 'run' ? 'Running…' : 'Run tonight’s batch now'}
            </button>
          ) : null}
        </Section>
      </div>

      <section style={card} aria-labelledby="autopilot-limits">
        <SettingRow first id="autopilot-limits" title="Daily spending limit" help="A ceiling for all AI agents together, from midnight Central: every program, bulk starts and a rep's own switch. Past it nothing runs until 9am tomorrow, so no Claude turns and no texts are spent. 0 stops them all for the day.">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Field label="Texts, emails and calls a day" htmlFor="ap-lim-touches">
              <input id="ap-lim-touches" type="number" min={0} max={5000} style={{ ...input, width: 120 }} disabled={!edit} value={draft.limits?.daily_touches ?? 150}
                onChange={(e) => set((d) => { d.limits = { daily_touches: Number(e.target.value), daily_steps: d.limits?.daily_steps ?? 500 }; return d; })} />
            </Field>
            <Field label="AI steps a day" htmlFor="ap-lim-steps">
              <input id="ap-lim-steps" type="number" min={0} max={20000} style={{ ...input, width: 120 }} disabled={!edit} value={draft.limits?.daily_steps ?? 500}
                onChange={(e) => set((d) => { d.limits = { daily_touches: d.limits?.daily_touches ?? 150, daily_steps: Number(e.target.value) }; return d; })} />
            </Field>
          </div>
        </SettingRow>
      </section>

      <section style={card} aria-labelledby="autopilot-sender">
        <SettingRow first id="autopilot-sender" title="Texts and emails go out as" help={`The lead's assigned rep when it has one; otherwise this member. Agents: speed ${agentName(draft.speed.agent_key, view.defaults.speed)}, reactivation ${agentName(draft.reactivation.agent_key, view.defaults.reactivation)}.`}>
          <select style={{ ...input, width: 220 }} disabled={!edit} value={draft.send_as ?? ''} onChange={(e) => set((d) => { d.send_as = e.target.value || null; return d; })} aria-label="Send as">
            <option value="">The workspace owner</option>
            {view.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
          </select>
        </SettingRow>
      </section>
    </div>
  );
}

function Chip({ on, label, onChange, disabled, children }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean; children?: React.ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)} className="va-btn"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 30, padding: '4px 10px', borderRadius: 999, border: `1px solid ${on ? GREEN : 'var(--divider, #e4e4e7)'}`, background: on ? 'var(--tint-green, #ecfdf5)' : 'var(--surface, #fff)', color: on ? GREEN : INK, fontSize: 12.5, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', maxWidth: '100%' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>{children}
    </button>
  );
}

function SourcePicker({ id, sources, picked, onChange, disabled }: { id: string; sources: AutopilotSource[]; picked: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  const has = (k: string) => picked.some((p) => p.toLowerCase() === k.toLowerCase());
  if (!sources.length) return <p id={id} style={{ margin: 0, fontSize: 12.5, color: MUTED }}>No lead sources yet. They appear here as leads come in (a Jotform, Zapier or PPL key, a form, an import).</p>;
  return (
    <div id={id} role="group" aria-label="Lead sources" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 180, overflowY: 'auto' }}>
      {sources.map((x) => (
        <Chip key={x.source} on={has(x.source)} disabled={disabled} label={x.source}
          onChange={(v) => onChange(v ? [...picked, x.source] : picked.filter((p) => p.toLowerCase() !== x.source.toLowerCase()))}>
          <span style={{ fontSize: 11, color: MUTED, fontWeight: 500 }}>{x.leads.toLocaleString('en-US')}</span>
          {x.kind === 'inbound' ? <Badge tone="green">inbound</Badge> : x.kind === 'list' ? <Badge tone="amber">list</Badge> : null}
        </Chip>
      ))}
    </div>
  );
}

function Channels({ value, onChange, disabled }: { value: Channel[]; onChange: (v: Channel[]) => void; disabled: boolean }) {
  return (
    <div role="group" aria-label="Channels" style={{ display: 'flex', gap: 6 }}>
      {CHANNELS.map((c) => (
        <Chip key={c} on={value.includes(c)} disabled={disabled} label={CHANNEL_LABEL[c]}
          onChange={(v) => { const next = v ? CHANNELS.filter((x) => x === c || value.includes(x)) : value.filter((x) => x !== c); if (next.length) onChange(next); }} />
      ))}
    </div>
  );
}

function AgentSelect({ id, label, view, value, fallback, onChange, disabled, hint }: { id: string; label: string; view: AutopilotView; value: string | null; fallback: string | null; onChange: (k: string | null) => void; disabled: boolean; hint?: string }) {
  const def = view.agents.find((a) => a.agent_key === fallback);
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <select id={id} style={input} disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{def ? `Default: ${def.name}` : 'Default'}</option>
        {view.agents.map((a) => <option key={a.agent_key} value={a.agent_key}>{a.name} · {a.role_label}{a.can_call ? '' : ' (texts only)'}</option>)}
      </select>
    </Field>
  );
}
