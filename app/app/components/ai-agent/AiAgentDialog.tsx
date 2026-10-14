'use client';

// The AI agent popup on a seller or buyer record: a chat with the agent, its
// plan, which channels it may use, what it has done, and the ON/OFF switch.
//
// The rep types what they want ("get a call booked with me this week") and the
// agent answers and drafts a plan from the record's history; or they press
// "Let AI decide" and it plans and starts on its own. Nothing goes out until
// the agent is ON. The server (supabase/functions/ai-agent) holds every rule
// that matters: VIPs and funds refused, do-not-contact honoured, sending
// windows, gaps between touches and the touch cap.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, Ban, CalendarCheck, Clock, Mail, MessageSquare, Phone, Power, Sparkles, Voicemail, X } from 'lucide-react';
import {
  CHANNEL_LABEL, CHANNEL_ORDER, QUICK_ASKS, RVM_HELP, actionText, agoLabel, whenLabel,
  type AiAgentApi, type AgentAction, type Channel, type ChatTurn, type Contact, type RecordKind, type RecordStatus, type Result,
} from '@/lib/ai-agent-client';
import { AgentAvatar } from './AgentAvatar';
import { AiaStyles } from './styles';

const GREEN = '#0A8560';
const RED = '#dc2626';
const INK = '#18181b';
const MUTED = '#71717a';
const LINE = '#e4e4e7';

const CH_ICON: Record<Channel, React.ReactNode> = {
  call: <Phone size={13} aria-hidden />, rvm: <Voicemail size={13} aria-hidden />, sms: <MessageSquare size={13} aria-hidden />, email: <Mail size={13} aria-hidden />,
};
const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const AUTO_TEXT = 'Let the AI decide from the record history.';

export function AiAgentDialog({ api, kind, recordId, recordName, canWrite, initial, onClose, onChange }: {
  api: AiAgentApi; kind: RecordKind; recordId: number; recordName: string; canWrite: boolean;
  initial: RecordStatus | null; onClose: () => void; onChange: (s: RecordStatus) => void;
}) {
  const [st, setSt] = useState<RecordStatus | null>(initial);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState<null | 'chat' | 'start' | 'stop' | 'auto' | 'handoff'>(null);
  const [handTo, setHandTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<ChatTurn | null>(null);
  const [agentKey, setAgentKey] = useState<string>(initial?.enrollment?.agent_key ?? initial?.agent?.agent_key ?? '');
  const [channels, setChannels] = useState<Channel[]>(initial?.enrollment?.channels ?? defaultChannels(initial));
  // How the agent opens its calls: the rep's pick, else what was saved, else what the history suggests.
  const [contactPick, setContactPick] = useState<Contact | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const thread = useRef<HTMLDivElement | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  // The parent's callback may be a new function every render; reading it through a ref keeps refresh stable.
  const changed = useRef(onChange);
  useEffect(() => { changed.current = onChange; });

  const apply = useCallback((r: Result<RecordStatus>) => {
    setLoading(false);
    if (!r.ok) { setError(r.error); return; }
    setSt(r); changed.current(r);
    // A running record shows the agent working it, which a hand-off may have just changed.
    setAgentKey((k) => (r.enrollment?.status === 'active' ? r.enrollment.agent_key : k || r.enrollment?.agent_key || r.agent?.agent_key || ''));
    setChannels((c) => (r.enrollment ? r.enrollment.channels : c.length ? c : defaultChannels(r)));
  }, []);
  const refresh = useCallback(() => api.status(kind, recordId).then(apply), [api, kind, recordId, apply]);

  useEffect(() => {
    let gone = false;
    void api.status(kind, recordId).then((r) => { if (!gone) apply(r); });
    return () => { gone = true; };
  }, [api, kind, recordId, apply]);

  // Focus in, Escape out, focus back to the switch on close, page scroll locked.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setTimeout(() => area.current?.focus(), 30);
    return () => { document.body.style.overflow = prev; opener?.focus?.(); };
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onClose(); return; }
    if (e.key !== 'Tab' || !box.current) return;
    const nodes = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!nodes.length) return;
    const a = nodes[0]!; const z = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  };

  const e = st?.enrollment ?? null;
  const agent = useMemo(() => st?.agents.find((a) => a.agent_key === agentKey) ?? st?.agent ?? null, [st, agentKey]);
  const on = e?.status === 'active';
  const chat = useMemo(() => {
    const list = e && e.agent_key === agentKey && !['stopped', 'done'].includes(e.status) ? e.chat : [];
    return pending ? [...list, pending] : list;
  }, [e, agentKey, pending]);
  const blocked = st && !st.eligible.ok ? st.eligible : null;
  const noAgent = st && !st.agents.length;
  const first = recordName.split(/\s+/)[0] || (kind === 'buyer' ? 'this buyer' : 'this seller');
  const agentName = agent?.name ?? 'Your agent';
  const locked = !canWrite || !!blocked || !!noAgent || !agent;
  const contact: Contact = contactPick ?? st?.contact ?? st?.contact_suggested ?? 'first';

  useEffect(() => { thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: 'smooth' }); }, [chat.length, busy]);

  const run = async (kindOfBusy: 'chat' | 'start' | 'auto', message: string | null) => {
    if (locked || busy) return;
    setError(null); setBusy(kindOfBusy);
    if (message) setPending({ role: 'rep', text: message, at: new Date().toISOString() });
    const body = { agent_key: agentKey || undefined, channels, contact, ...(message ? { message } : {}), ...(kindOfBusy === 'auto' ? { mode: 'auto' as const } : {}) };
    const r = kindOfBusy === 'chat' ? await api.chat(kind, recordId, body) : await api.start(kind, recordId, body);
    setPending(null); setBusy(null);
    if (!r.ok) { setError(r.error); if (message) setDraft(message); return; }
    setDraft('');
    await refresh();
  };
  const send = () => { const m = draft.trim(); if (m) void run('chat', m); };
  const stop = async () => {
    if (busy || !canWrite) return;
    setError(null); setBusy('stop');
    const r = await api.stop(kind, recordId);
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    await refresh();
  };
  // The next stage: who takes over from the agent on the record, and handing it over now.
  const nextAgent = on && agent?.handoff_to ? st?.agents.find((a) => a.agent_key === agent.handoff_to) ?? null : null;
  const others = on ? (st?.agents ?? []).filter((a) => a.agent_key !== agent?.agent_key) : [];
  const handPick = handTo || nextAgent?.agent_key || others[0]?.agent_key || '';
  const handOff = async () => {
    if (busy || !canWrite || !handPick) return;
    setError(null); setBusy('handoff');
    const r = await api.handoff(kind, recordId, handPick);
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    setHandTo('');
    await refresh();
  };
  const toggleChannel = (c: Channel) => setChannels((list) => (list.includes(c) ? (list.length > 1 ? list.filter((x) => x !== c) : list) : [...list, c].sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b))));
  const reachable = (c: Channel) => !!st && (c === 'sms' || c === 'rvm' ? st.reach.phone : c === 'email' ? st.reach.email : st.reach.call);

  const plan = e && e.agent_key === agentKey && !['stopped', 'done'].includes(e.status) ? e.plan : null;
  const actions = (st?.actions ?? []).filter((a) => a.action !== 'waited' && a.action !== 'chat').slice(0, 12);

  return (
    <div className="aia-back" onMouseDown={(ev) => { if (ev.target === ev.currentTarget && !busy) onClose(); }} onKeyDown={onKey}
      style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(15,23,42,.48)', backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <AiaStyles />
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="aia-title" className="aia-modal"
        style={{ width: 'min(100%, 940px)', height: 'min(100%, 760px)', background: '#fff', borderRadius: 20, boxShadow: '0 30px 80px -20px rgba(15,23,42,.45), 0 0 0 1px rgba(15,23,42,.06)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ position: 'relative', padding: '16px 18px', background: on ? 'linear-gradient(120deg, #065f46 0%, #0A8560 45%, #08694C 120%)' : 'linear-gradient(120deg, #1f2937 0%, #334155 55%, #08694C 140%)', color: '#fff', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div aria-hidden className="aia-glow" />
          <AgentAvatar name={agentName} src={agent?.avatar_url} size={54} live={on} ring="rgba(255,255,255,.85)" />
          <div style={{ minWidth: 0, flex: '1 1 220px', position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 id="aia-title" style={{ margin: 0, fontSize: 18, fontWeight: 750, letterSpacing: '-0.02em' }}>{agentName}</h2>
              <span style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 8px', borderRadius: 999, background: 'rgba(255,255,255,.16)', border: '1px solid rgba(255,255,255,.25)' }}>
                {agent?.role_label ? cap(agent.role_label) : 'AI agent'}
              </span>
            </div>
            <div style={{ marginTop: 3, fontSize: 12.5, opacity: 0.9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {on ? <>Working {recordName || first}{e?.next_action_at ? ` · next step ${whenLabel(e.next_action_at)}` : ''}</> : <>Working {recordName || first}? Tell {agentName.split(' ')[0]} what you want.</>}
            </div>
          </div>
          {st && st.agents.length > 1 && !on ? (
            <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
              <span className="aia-sr">Agent</span>
              <select value={agentKey} onChange={(ev) => setAgentKey(ev.target.value)} disabled={!!busy}
                style={{ height: 32, borderRadius: 9, border: '1px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.14)', color: '#fff', padding: '0 8px', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit' }}>
                {st.agents.map((a) => <option key={a.agent_key} value={a.agent_key} style={{ color: INK }}>{a.name}</option>)}
              </select>
            </label>
          ) : null}
          <BigSwitch on={on} busy={busy === 'start' || busy === 'stop' || busy === 'auto'} disabled={locked && !on}
            onTurnOn={() => void run('start', draft.trim() || null)} onTurnOff={() => void stop()} />
          <button type="button" aria-label="Close" onClick={onClose} disabled={!!busy} className="aia-icon-btn"
            style={{ width: 34, height: 34, borderRadius: 10, border: '1px solid rgba(255,255,255,.25)', background: 'rgba(255,255,255,.1)', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer', position: 'relative' }}>
            <X size={17} aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="aia-body" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
          {/* Chat */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: 'linear-gradient(180deg, #fafbfc 0%, #f4f6f9 100%)', borderRight: `1px solid ${LINE}` }}>
            {blocked ? (
              <Notice tone="red" icon={<Ban size={16} aria-hidden />}>{blocked.reason}.{blocked.code === 'protected' ? ' VIPs and funds stay with the team.' : ''}</Notice>
            ) : noAgent ? (
              <Notice tone="amber" icon={<Sparkles size={16} aria-hidden />}>No agent works {kind}s yet. An owner or admin can add {kind === 'buyer' ? 'the Buyer assistant' : 'a Lead manager'} in Settings, AI Agent.</Notice>
            ) : !canWrite ? (
              <Notice tone="amber" icon={<Clock size={16} aria-hidden />}>Read-only: you can look, but not switch the agent or give it instructions.</Notice>
            ) : null}

            <div ref={thread} role="log" aria-live="polite" aria-label="Conversation with the agent" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 18px 8px' }}>
              {loading ? <Typing name={agentName} src={agent?.avatar_url} /> : !chat.length ? (
                <div className="aia-rise" style={{ maxWidth: 480, margin: '18px auto 0', textAlign: 'center' }}>
                  <div style={{ display: 'inline-block', position: 'relative' }}>
                    <AgentAvatar name={agentName} src={agent?.avatar_url} size={76} ring="#fff" />
                    <span aria-hidden className="aia-orbit" />
                  </div>
                  <h3 style={{ margin: '14px 0 4px', fontSize: 19, fontWeight: 750, letterSpacing: '-0.02em', color: INK }}>Hi, I&apos;m {agentName.split(' ')[0]}.</h3>
                  <p style={{ margin: 0, fontSize: 13.5, color: MUTED, lineHeight: 1.55 }}>
                    What should I do for {first}? Tell me in your own words, or let me read every call, text, email and note on file and decide the plan myself.
                  </p>
                  <button type="button" disabled={locked || !!busy} onClick={() => void run('auto', null)} className="aia-magic"
                    style={{ marginTop: 16, height: 42, padding: '0 18px', borderRadius: 12, border: 0, color: '#fff', fontWeight: 700, fontSize: 14, cursor: locked ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, opacity: locked ? 0.5 : 1, fontFamily: 'inherit' }}>
                    <Sparkles size={16} aria-hidden /> {busy === 'auto' ? 'Reading the history…' : 'Let AI decide from the history'}
                  </button>
                  <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {QUICK_ASKS[kind].map((q) => (
                      <button key={q} type="button" disabled={locked || !!busy} className="aia-chip" onClick={() => { setDraft(q); area.current?.focus(); }}
                        style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 12, border: `1px solid ${LINE}`, background: '#fff', fontSize: 13, color: '#3f3f46', cursor: 'pointer', lineHeight: 1.4, fontFamily: 'inherit' }}>
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {chat.map((t, i) => <Bubble key={i} t={t} name={agentName} src={agent?.avatar_url} />)}
                  {busy === 'chat' || busy === 'start' || busy === 'auto' ? <Typing name={agentName} src={agent?.avatar_url} /> : null}
                </div>
              )}
            </div>

            {error ? <div role="alert" style={{ margin: '0 18px 8px', padding: '9px 12px', borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12.5 }}>{error}</div> : null}

            {/* Composer */}
            <div style={{ padding: '10px 14px 14px' }}>
              {!on ? <ContactPicker value={contact} onChange={setContactPick} disabled={locked || !!busy} first={first} suggested={!contactPick && !st?.contact} /> : null}
              <div className="aia-composer" style={{ border: `1px solid ${LINE}`, borderRadius: 18, background: '#fff', boxShadow: '0 1px 2px rgba(15,23,42,.04), 0 8px 24px -16px rgba(15,23,42,.25)', padding: '10px 10px 8px 14px' }}>
                <label htmlFor="aia-input" className="aia-sr">Message {agentName}</label>
                <textarea id="aia-input" ref={area} rows={2} value={draft} disabled={locked}
                  placeholder={locked ? '' : on ? `Change the plan: "text only from now on", "push for a call this week"…` : `Tell ${agentName.split(' ')[0]} what you want for ${first}…`}
                  onChange={(ev) => setDraft(ev.target.value.slice(0, 2000))}
                  onKeyDown={(ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); } }}
                  style={{ width: '100%', border: 0, outline: 0, resize: 'none', fontSize: 14, lineHeight: 1.5, color: INK, background: 'transparent', fontFamily: 'inherit', maxHeight: 160, minHeight: 44 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {CHANNEL_ORDER.map((c) => {
                    const can = reachable(c);
                    const sel = channels.includes(c);
                    return (
                      <button key={c} type="button" aria-pressed={sel} disabled={locked || !!busy || (!can && !sel)} onClick={() => toggleChannel(c)}
                        title={can ? (c === 'rvm' ? RVM_HELP : `${sel ? 'Stop using' : 'Use'} ${CHANNEL_LABEL[c].toLowerCase()}`) : c === 'call' ? 'Calls need a published agent with an ElevenLabs number and a phone on the record' : `No ${c === 'email' ? 'email' : 'phone'} on this record`}
                        style={{ height: 28, padding: '0 10px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, cursor: can ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
                          border: `1px solid ${sel ? 'rgba(10,133,96,.35)' : LINE}`, background: sel ? '#E7F8F1' : '#fff', color: sel ? GREEN : can ? '#52525b' : '#a1a1aa', textDecoration: !can ? 'line-through' : 'none' }}>
                        {CH_ICON[c]}{CHANNEL_LABEL[c]}
                      </button>
                    );
                  })}
                  <span style={{ flex: 1 }} />
                  <span className="aia-hint" style={{ fontSize: 11, color: '#a1a1aa' }}>Enter to send · Shift+Enter for a new line</span>
                  {channels.includes('rvm') ? <span style={{ flexBasis: '100%', fontSize: 11.5, fontWeight: 500, color: '#71717a', lineHeight: 1.4 }}>{RVM_HELP}</span> : null}
                  <button type="button" aria-label="Send" disabled={locked || !!busy || !draft.trim()} onClick={send}
                    style={{ width: 36, height: 36, borderRadius: 12, border: 0, display: 'grid', placeItems: 'center', cursor: draft.trim() && !locked ? 'pointer' : 'not-allowed',
                      background: draft.trim() && !locked ? `linear-gradient(135deg, ${GREEN}, #10b981)` : '#e4e4e7', color: '#fff', transition: 'background .15s' }}>
                    <ArrowUp size={18} aria-hidden />
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {!on ? (
                  <>
                    <button type="button" disabled={locked || !!busy || (!chat.length && !draft.trim())} onClick={() => void run('start', draft.trim() || null)}
                      style={{ height: 36, padding: '0 16px', borderRadius: 11, border: 0, background: GREEN, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, opacity: locked || (!chat.length && !draft.trim()) ? 0.45 : 1, fontFamily: 'inherit' }}>
                      <Power size={15} aria-hidden /> {busy === 'start' ? 'Turning on…' : `Turn on ${agentName.split(' ')[0]}`}
                    </button>
                    {chat.length ? (
                      <button type="button" disabled={locked || !!busy} onClick={() => void run('auto', null)} className="aia-link"
                        style={{ border: 0, background: 'none', color: '#0A8560', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'inherit' }}>
                        <Sparkles size={14} aria-hidden /> Let AI decide and turn on
                      </button>
                    ) : null}
                  </>
                ) : (
                  <span style={{ fontSize: 12.5, color: '#3f3f46', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="aia-live" style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                    On · {e?.touches ?? 0} of {e?.max_touches ?? 12} touches{e?.next_action_at ? ` · next ${whenLabel(e.next_action_at)}` : ''}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Side: plan, activity */}
          <aside className="aia-side" style={{ minHeight: 0, overflowY: 'auto', padding: '16px 16px 18px', background: '#fff' }}>
            <SideTitle>The plan</SideTitle>
            {plan && (plan.summary || plan.steps.length) ? (
              <div className="aia-rise">
                {plan.goal ? <div style={{ fontSize: 12.5, color: INK, fontWeight: 650, lineHeight: 1.45 }}>{plan.goal}</div> : null}
                {plan.summary ? <p style={{ margin: '4px 0 10px', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>{plan.summary}</p> : null}
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
                  {plan.steps.map((s, i) => (
                    <li key={i} style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: 8, paddingBottom: 10, position: 'relative' }}>
                      {i < plan.steps.length - 1 ? <span aria-hidden style={{ position: 'absolute', left: 13, top: 26, bottom: 0, width: 2, background: '#eef0f3' }} /> : null}
                      <span style={{ width: 28, height: 28, borderRadius: 9, display: 'grid', placeItems: 'center', background: i < (e?.touches ?? 0) ? '#E7F8F1' : '#f4f4f5', color: i < (e?.touches ?? 0) ? GREEN : '#52525b', border: `1px solid ${i < (e?.touches ?? 0) ? 'rgba(10,133,96,.25)' : LINE}` }}>{CH_ICON[s.channel]}</span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#71717a' }}>{s.day === 0 ? 'Today' : `Day ${s.day}`} · {CHANNEL_LABEL[s.channel]}</span>
                        <span style={{ display: 'block', fontSize: 12.5, color: '#3f3f46', lineHeight: 1.4 }}>{s.purpose}</span>
                      </span>
                    </li>
                  ))}
                </ol>
                {plan.stop_when ? <div style={{ fontSize: 11.5, color: MUTED, display: 'flex', gap: 6, alignItems: 'flex-start' }}><CalendarCheck size={13} aria-hidden style={{ flex: 'none', marginTop: 1 }} /> Stops when {lower(plan.stop_when)}</div> : null}
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
                {busy ? 'Drafting…' : `Once you tell ${agentName.split(' ')[0]} what you want, or let it decide, the plan shows here: when it reaches out, on which channel and why.`}
              </p>
            )}

            {on && others.length ? (
              <>
                <div style={{ height: 1, background: '#f0f1f3', margin: '16px 0' }} />
                <SideTitle>Next stage</SideTitle>
                {nextAgent ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AgentAvatar name={agentName} src={agent?.avatar_url} size={26} />
                    <ArrowRight size={13} aria-hidden color="#a1a1aa" style={{ flex: 'none' }} />
                    <AgentAvatar name={nextAgent.name} src={nextAgent.avatar_url} size={26} />
                    <span style={{ fontSize: 12.5, color: '#3f3f46', lineHeight: 1.4, minWidth: 0 }}>
                      <b style={{ color: INK }}>{nextAgent.name}</b>{nextAgent.role_label ? ` (${lower(nextAgent.role_label)})` : ''} takes over {handoffWhen(agent?.handoff_on ?? [], kind)}.
                    </span>
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>{agentName.split(' ')[0]} hands {first} to you when they are ready. Or pass {kind === 'buyer' ? 'them' : 'the record'} to another agent now.</p>
                )}
                {canWrite ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                    <label className="aia-sr" htmlFor="aia-handto">Hand off to</label>
                    <select id="aia-handto" value={handPick} onChange={(ev) => setHandTo(ev.target.value)} disabled={!!busy}
                      style={{ flex: 1, minWidth: 0, height: 32, borderRadius: 9, border: `1px solid ${LINE}`, background: '#fff', padding: '0 6px', fontSize: 12.5, fontFamily: 'inherit', color: INK }}>
                      {others.map((a) => <option key={a.agent_key} value={a.agent_key}>{a.name}{a.agent_key === nextAgent?.agent_key ? ' (next)' : ''}</option>)}
                    </select>
                    <button type="button" onClick={() => void handOff()} disabled={!!busy || !handPick}
                      style={{ height: 32, padding: '0 10px', borderRadius: 9, border: '1px solid rgba(10,133,96,.3)', background: '#F0FAF5', color: '#08694C', fontWeight: 650, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                      {busy === 'handoff' ? 'Handing off…' : 'Hand off now'}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            <div style={{ height: 1, background: '#f0f1f3', margin: '16px 0' }} />
            <SideTitle>What it has done</SideTitle>
            {actions.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {actions.map((a) => <ActionRow key={a.id} a={a} />)}
              </ul>
            ) : (
              <p style={{ margin: 0, fontSize: 12.5, color: MUTED }}>Nothing yet. Every text, email, call and change lands here and on the record&apos;s timeline.</p>
            )}
            {e && (e.status === 'stopped' || e.status === 'done') && e.stop_reason ? (
              <p style={{ margin: '12px 0 0', fontSize: 12, color: MUTED }}>Last run {e.status === 'done' ? 'finished' : 'stopped'}: {e.stop_reason}.</p>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}

function defaultChannels(s: RecordStatus | null): Channel[] {
  if (!s) return ['sms', 'email'];
  const list: Channel[] = [];
  if (s.reach.phone) list.push('sms');
  if (s.reach.email) list.push('email');
  return list.length ? list : ['sms', 'email'];
}

/** When the next agent takes over, in words, from the triggers set on the agent working the record. */
function handoffWhen(on: string[], kind: RecordKind): string {
  const ready = on.includes('ready'); const qualified = kind === 'seller' && on.includes('qualified');
  if (ready && qualified) return 'once they are qualified or ready to talk price';
  if (qualified) return 'once motivation, timeline and condition are on file';
  if (ready) return 'once they are ready to talk price';
  return 'when you hand it off';
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

function BigSwitch({ on, busy, disabled, onTurnOn, onTurnOff }: { on: boolean; busy: boolean; disabled: boolean; onTurnOn: () => void; onTurnOff: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={on ? 'Agent is on. Turn it off' : 'Agent is off. Turn it on'} disabled={busy || (disabled && !on)}
      onClick={() => (on ? onTurnOff() : onTurnOn())}
      style={{ position: 'relative', height: 34, minWidth: 92, padding: '0 6px 0 12px', borderRadius: 999, border: '1px solid rgba(255,255,255,.35)', display: 'inline-flex', alignItems: 'center', gap: 8,
        background: on ? 'rgba(34,197,94,.95)' : 'rgba(220,38,38,.92)', color: '#fff', fontWeight: 800, fontSize: 12, letterSpacing: '.06em', cursor: busy || (disabled && !on) ? 'not-allowed' : 'pointer', opacity: disabled && !on ? 0.6 : 1, fontFamily: 'inherit',
        boxShadow: on ? '0 0 0 4px rgba(34,197,94,.25)' : '0 0 0 4px rgba(220,38,38,.2)', transition: 'background .2s, box-shadow .2s' }}>
      <span style={{ order: on ? 0 : 1 }}>{busy ? '…' : on ? 'ON' : 'OFF'}</span>
      <span aria-hidden style={{ order: on ? 1 : 0, width: 24, height: 24, borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center', color: on ? '#16a34a' : RED, boxShadow: '0 1px 3px rgba(0,0,0,.25)' }}>
        <Power size={13} />
      </span>
    </button>
  );
}

const CONTACT_CHOICES: { value: Contact; label: string; hint: (first: string) => string }[] = [
  { value: 'first', label: 'First call', hint: (f) => `A new lead or cold call. It opens with who it is and why it's calling about ${f}'s property.` },
  { value: 'known', label: 'Already talking', hint: (f) => `You know it's ${f}. It opens as a follow-up and picks up where you left off.` },
];

/** First call or follow-up: sets how the agent opens its calls and its first touch (migration 258). */
function ContactPicker({ value, onChange, disabled, first, suggested }: { value: Contact; onChange: (c: Contact) => void; disabled: boolean; first: string; suggested: boolean }) {
  const pick = CONTACT_CHOICES.find((c) => c.value === value) ?? CONTACT_CHOICES[0]!;
  return (
    <div role="group" aria-labelledby="aia-contact-label" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span id="aia-contact-label" style={{ fontSize: 11.5, fontWeight: 500, color: '#52525b' }}>Have you talked with {first}?</span>
        <div style={{ display: 'inline-flex', padding: 2, borderRadius: 10, background: '#f4f4f5', border: `1px solid ${LINE}` }}>
          {CONTACT_CHOICES.map((c) => {
            const sel = c.value === value;
            return (
              <button key={c.value} type="button" aria-pressed={sel} disabled={disabled} onClick={() => onChange(c.value)} className="aia-seg"
                style={{ height: 28, padding: '0 12px', borderRadius: 8, border: 0, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer',
                  background: sel ? '#fff' : 'transparent', color: sel ? INK : '#52525b', boxShadow: sel ? '0 1px 2px rgba(15,23,42,.08), 0 0 0 1px rgba(15,23,42,.06)' : 'none' }}>
                {c.label}
              </button>
            );
          })}
        </div>
        {suggested ? <span style={{ fontSize: 11.5, color: '#52525b' }}>{value === 'known' ? 'Picked from the history' : 'No conversation on file'}</span> : null}
      </div>
      <p style={{ margin: '5px 0 0', fontSize: 12, color: '#52525b', lineHeight: 1.45 }}>{pick.hint(first)}</p>
    </div>
  );
}

function Notice({ tone, icon, children }: { tone: 'red' | 'amber'; icon: React.ReactNode; children: React.ReactNode }) {
  const c = tone === 'red' ? { bg: '#fef2f2', bd: '#fecaca', fg: '#991b1b' } : { bg: '#fffbeb', bd: '#fde68a', fg: '#92400e' };
  return (
    <div role="status" style={{ margin: '14px 18px 0', padding: '10px 12px', borderRadius: 12, background: c.bg, border: `1px solid ${c.bd}`, color: c.fg, fontSize: 12.5, lineHeight: 1.5, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ flex: 'none', marginTop: 1 }}>{icon}</span><span>{children}</span>
    </div>
  );
}

function Bubble({ t, name, src }: { t: ChatTurn; name: string; src?: string | null }) {
  if (t.role === 'rep') {
    const auto = t.text === AUTO_TEXT;
    return (
      <div className="aia-rise" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ maxWidth: '78%', padding: '10px 13px', borderRadius: '16px 16px 4px 16px', background: auto ? 'linear-gradient(135deg, #065f46, #08694C)' : `linear-gradient(135deg, ${GREEN}, #0f9b70)`, color: '#fff', fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', boxShadow: '0 6px 16px -10px rgba(10,133,96,.6)' }}>
          {auto ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Sparkles size={14} aria-hidden /> Let AI decide from the history</span> : t.text}
        </div>
      </div>
    );
  }
  return (
    <div className="aia-rise" style={{ display: 'flex', gap: 9, alignItems: 'flex-end' }}>
      <AgentAvatar name={name} src={src} size={28} />
      <div style={{ maxWidth: '80%', padding: '10px 13px', borderRadius: '16px 16px 16px 4px', background: '#fff', border: `1px solid ${LINE}`, color: INK, fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', boxShadow: '0 1px 2px rgba(15,23,42,.04)' }}>
        {t.text}
      </div>
    </div>
  );
}

function Typing({ name, src }: { name: string; src?: string | null }) {
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-end' }} aria-label={`${name} is thinking`}>
      <AgentAvatar name={name} src={src} size={28} />
      <div style={{ padding: '12px 14px', borderRadius: '16px 16px 16px 4px', background: '#fff', border: `1px solid ${LINE}`, display: 'inline-flex', gap: 4 }}>
        <span className="aia-dot" /><span className="aia-dot" style={{ animationDelay: '.15s' }} /><span className="aia-dot" style={{ animationDelay: '.3s' }} />
      </div>
    </div>
  );
}

function SideTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, color: '#71717a', fontWeight: 700, marginBottom: 8 }}>{children}</div>;
}

function ActionRow({ a }: { a: AgentAction }) {
  const tone = a.status === 'failed' ? RED : a.status === 'skipped' ? '#a16207' : GREEN;
  const icon = a.channel === 'sms' ? <MessageSquare size={12} aria-hidden /> : a.channel === 'email' ? <Mail size={12} aria-hidden /> : a.channel === 'call' ? <Phone size={12} aria-hidden /> : a.channel === 'rvm' ? <Voicemail size={12} aria-hidden /> : a.channel === 'plan' ? <Sparkles size={12} aria-hidden /> : <Power size={12} aria-hidden />;
  return (
    <li>
      <details>
        <summary style={{ listStyle: 'none', cursor: 'pointer', display: 'grid', gridTemplateColumns: '22px 1fr auto', gap: 8, alignItems: 'center' }}>
          <span style={{ width: 22, height: 22, borderRadius: 7, display: 'grid', placeItems: 'center', background: '#f4f4f5', color: tone }}>{icon}</span>
          <span style={{ fontSize: 12.5, color: INK, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{actionText(a)}</span>
          <span style={{ fontSize: 11, color: '#a1a1aa' }}>{agoLabel(a.created_at)}</span>
        </summary>
        {a.summary ? <div style={{ margin: '6px 0 2px 30px', fontSize: 12, color: '#52525b', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{a.summary}</div> : null}
      </details>
    </li>
  );
}
