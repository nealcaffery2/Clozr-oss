'use client';

// "AI agent" on the Buyers and People bulk bars: switch an agent ON (or OFF)
// for the selected records at once. The rep picks the agent, the channels,
// and either writes what they want or lets the AI decide from each record's
// own history. VIP buyers and funds are skipped before anything is sent (and
// refused by the server and the database too); blacklisted and
// do-not-contact records are skipped here, and anything else the server
// refuses (unreachable, already on an agent) comes back with the reason.

import React, { useEffect, useMemo, useState } from 'react';
import { Mail, MessageSquare, Phone, Power, Sparkles, Voicemail, X } from 'lucide-react';
import { CHANNEL_LABEL, RVM_HELP, aiAgentApi, type AgentInfo, type AiAgentApi, type Channel, type RecordKind } from '@/lib/ai-agent-client';
import { AgentAvatar } from './AgentAvatar';
import { AiaStyles } from './styles';

/** One selected record. `blacklisted` covers do-not-contact too; `protected` is a VIP or fund buyer. */
export type BulkRecord = { dbId: number; name: string; phone: string; email: string; blacklisted: boolean; protected?: boolean };

const WORDS: Record<RecordKind, { one: string; many: string; template: string; ask: string; skip: string }> = {
  buyer: {
    one: 'buyer', many: 'buyers', template: 'the Buyer assistant',
    ask: 'Confirm they are still buying and get their buy box', skip: 'blacklisted',
  },
  seller: {
    one: 'seller', many: 'sellers', template: 'a Lead manager',
    ask: 'Find out if they still want to sell and set a call with acquisitions', skip: 'do-not-contact or blacklisted',
  },
};

const GREEN = '#0A8560';
const label: React.CSSProperties = { fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 600 };
const ICON: Record<Channel, React.ReactNode> = { call: <Phone size={12} aria-hidden />, rvm: <Voicemail size={12} aria-hidden />, sms: <MessageSquare size={12} aria-hidden />, email: <Mail size={12} aria-hidden /> };

export function BulkAgentPanel({ kind = 'buyer', workspaceId, canWrite, selectedIds, records, toast, onClose, onDone, api: given }: {
  /** Which records these are; decides the agents offered and the wording. */
  kind?: RecordKind;
  workspaceId: number | null | undefined; canWrite: boolean; selectedIds: string[]; records: Record<string, BulkRecord>;
  toast: (m: string) => void; onClose: () => void; onDone: (msg: string) => void;
  /** Another client in place of the ai-agent function (tests, previews). */
  api?: AiAgentApi;
}) {
  const api = useMemo(() => given ?? (workspaceId ? aiAgentApi(workspaceId) : null), [given, workspaceId]);
  const [loaded, setLoaded] = useState<AgentInfo[] | null>(null);
  // No workspace (the demo): no agents to pick, said plainly below.
  const agents = api ? loaded : [];
  const [agentKey, setAgentKey] = useState('');
  const [channels, setChannels] = useState<Channel[]>(['sms', 'email']);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<null | 'on' | 'off'>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{ id: number; name: string; reason: string }[] | null>(null);

  useEffect(() => {
    if (!api) return;
    let gone = false;
    void api.agents().then((r) => {
      if (gone) return;
      if (!r.ok) { setError(r.error); setLoaded([]); return; }
      const serving = r.agents.filter((a) => a.audience === 'both' || a.audience === (kind === 'buyer' ? 'buyers' : 'sellers'));
      setLoaded(serving);
      setAgentKey((k) => k || serving[0]?.agent_key || '');
    });
    return () => { gone = true; };
  }, [api, kind]);
  const w = WORDS[kind];
  const n = (c: number) => `${c} ${c === 1 ? w.one : w.many}`;

  const picked = selectedIds.map((id) => records[id]).filter((b): b is BulkRecord => !!b);
  const prot = picked.filter((b) => b.protected);
  const black = picked.filter((b) => !b.protected && b.blacklisted);
  const eligible = picked.filter((b) => !b.protected && !b.blacklisted);
  const agent = agents?.find((a) => a.agent_key === agentKey) ?? null;
  const toggle = (c: Channel) => setChannels((l) => (l.includes(c) ? (l.length > 1 ? l.filter((x) => x !== c) : l) : [...l, c]));

  const start = async () => {
    if (!api || !canWrite) return toast(`AI agent on for ${eligible.length} (demo)`);
    if (!eligible.length) return setError(kind === 'buyer' ? 'Every selected buyer is a VIP, a fund or blacklisted, so none can go on an agent.' : 'Every selected seller is do-not-contact or blacklisted, so none can go on an agent.');
    setBusy('on'); setError(null); setSkipped(null);
    const r = await api.bulkStart(eligible.map((b) => b.dbId), { kind, agent_key: agentKey || undefined, channels, message: message.trim() || undefined });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    const skippedAll = [...prot.map((b) => ({ id: b.dbId, name: b.name, reason: 'VIP or fund: never on an AI agent' })), ...black.map((b) => ({ id: b.dbId, name: b.name, reason: w.skip })), ...r.skipped];
    if (skippedAll.length) setSkipped(skippedAll);
    const msg = `${r.agent.name} is on for ${n(r.started)}${skippedAll.length ? ` · ${skippedAll.length} skipped` : ''}`;
    if (!skippedAll.length) onDone(msg); else toast(msg);
  };
  const stop = async () => {
    if (!api || !canWrite) return toast(`AI agent off for ${picked.length} (demo)`);
    setBusy('off'); setError(null);
    const ids = picked.map((b) => b.dbId);
    const r = await api.bulkStop(kind === 'buyer' ? { buyer_ids: ids } : { seller_ids: ids });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    onDone(r.stopped ? `AI agent off for ${n(r.stopped)}` : `None of those ${w.many} had an agent on`);
  };

  const face = agent?.name ?? 'AI agent';
  return (
    <div className="aia-back" onMouseDown={(ev) => { if (ev.target === ev.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(15,23,42,.48)', backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <AiaStyles />
      <div role="dialog" aria-modal="true" aria-labelledby="aia-bulk-title" className="aia-modal"
        style={{ width: 'min(100%, 640px)', maxHeight: 'min(100%, 760px)', overflow: 'auto', background: 'var(--surface, #fff)', borderRadius: 20, boxShadow: '0 30px 80px -20px rgba(15,23,42,.45), 0 0 0 1px rgba(15,23,42,.06)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', padding: '16px 18px', background: 'linear-gradient(120deg, #1f2937 0%, #334155 55%, #08694C 140%)', color: '#fff', display: 'flex', alignItems: 'center', gap: 14 }}>
        <div aria-hidden className="aia-glow" />
        <AgentAvatar name={face} src={agent?.avatar_url} size={54} ring="rgba(255,255,255,.85)" />
        <div style={{ minWidth: 0, flex: 1, position: 'relative' }}>
          <h2 id="aia-bulk-title" style={{ margin: 0, fontSize: 18, fontWeight: 750, letterSpacing: '-0.02em' }}>{face}</h2>
          <div style={{ marginTop: 3, fontSize: 12.5, opacity: 0.9 }}>For {picked.length} selected {picked.length === 1 ? w.one : w.many}. Same switch as a record: tell it what to do, or let it decide.</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} disabled={!!busy}
          style={{ width: 34, height: 34, borderRadius: 10, border: '1px solid rgba(255,255,255,.25)', background: 'rgba(255,255,255,.1)', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer', position: 'relative' }}>
          <X size={17} aria-hidden />
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px 16px' }}>

      {agents === null ? <span style={{ fontSize: 12.5, color: 'var(--meta, #71717a)' }}>Loading agents…</span> : !agents.length && error ? (
        <div role="alert" style={{ fontSize: 12.5, color: 'var(--tx-red-deep, #991b1b)', background: 'var(--tint-red, #fef2f2)', border: '1px solid var(--tint-red-2, #fecaca)', borderRadius: 10, padding: '9px 12px' }}>{error}</div>
      ) : !agents.length ? (
        <div style={{ fontSize: 12.5, color: 'var(--tx-amber-deep, #92400e)', background: 'var(--tint-amber, #fffbeb)', border: '1px solid var(--tint-amber-2, #fde68a)', borderRadius: 10, padding: '9px 12px' }}>
          No agent works {w.many} yet. An owner or admin can add <b>{w.template}</b> in Settings, AI Agent.
        </div>
      ) : (
        <>
          <div role="radiogroup" aria-label="Agent" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {agents.map((a) => {
              const sel = a.agent_key === agentKey;
              return (
                <button key={a.agent_key} type="button" role="radio" aria-checked={sel} onClick={() => setAgentKey(a.agent_key)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, padding: '0 12px 0 5px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                    border: `1px solid ${sel ? 'rgba(10,133,96,.5)' : 'var(--divider, #e4e4e7)'}`, background: sel ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', boxShadow: sel ? '0 0 0 3px rgba(10,133,96,.12)' : 'none' }}>
                  <AgentAvatar name={a.name} src={a.avatar_url} size={30} live={a.active > 0} />
                  <span style={{ textAlign: 'left' }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--ink, #18181b)' }}>{a.name}</span>
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--meta, #71717a)' }}>{a.active} working now{a.handoff_to ? ` · then ${agents.find((x) => x.agent_key === a.handoff_to)?.name ?? 'the next agent'}` : ''}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={label}>Channels</span>
            {(['sms', 'email', 'call', 'rvm'] as Channel[]).map((c) => {
              const sel = channels.includes(c);
              const callOff = c === 'call' && !agent?.can_call;
              return (
                <button key={c} type="button" aria-pressed={sel} disabled={callOff && !sel} onClick={() => toggle(c)}
                  title={callOff ? 'Calls need the agent published with an ElevenLabs phone number id' : c === 'rvm' ? RVM_HELP : undefined}
                  style={{ height: 28, padding: '0 10px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, cursor: callOff ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                    border: `1px solid ${sel ? 'rgba(10,133,96,.35)' : 'var(--divider, #e4e4e7)'}`, background: sel ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', color: sel ? GREEN : callOff ? 'var(--subtle, #a1a1aa)' : 'var(--muted, #52525b)' }}>
                  {ICON[c]}{CHANNEL_LABEL[c]}
                </button>
              );
            })}
            {channels.includes('rvm') ? <span style={{ flexBasis: '100%', fontSize: 11.5, fontWeight: 500, color: 'var(--meta, #71717a)', lineHeight: 1.4 }}>{RVM_HELP}</span> : null}
          </div>
          <div className="aia-composer" style={{ border: '1px solid var(--divider, #e4e4e7)', borderRadius: 14, background: 'var(--surface, #fff)', padding: '8px 10px' }}>
            <label htmlFor="aia-bulk" className="aia-sr">What should the agent do</label>
            <textarea id="aia-bulk" rows={2} value={message} onChange={(e) => setMessage(e.target.value.slice(0, 2000))}
              placeholder={`Tell the agent what you want, e.g. "${w.ask}". Leave empty to let the AI decide from each ${w.one}'s history.`}
              style={{ width: '100%', border: 0, outline: 0, resize: 'vertical', fontSize: 13, lineHeight: 1.5, fontFamily: 'inherit', background: 'transparent', minHeight: 44 }} />
            <div style={{ fontSize: 11.5, color: message.trim() ? 'var(--muted, #52525b)' : '#0A8560', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Sparkles size={12} aria-hidden /> {message.trim() ? `Each ${w.one} gets a plan for these instructions, written from their own history.` : `Let AI decide: each ${w.one} gets a plan written from their own calls, texts and emails.`}
            </div>
          </div>
          {(prot.length || black.length) ? (
            <div style={{ fontSize: 12, color: 'var(--muted, #52525b)' }}>
              {prot.length ? <><b>{prot.length}</b> VIP or fund buyer{prot.length === 1 ? '' : 's'} will be skipped: they stay with the team. </> : null}
              {black.length ? <><b>{black.length}</b> {w.skip} will be skipped.</> : null}
            </div>
          ) : null}
          {error ? <div role="alert" style={{ fontSize: 12.5, color: 'var(--tx-red-deep, #991b1b)', background: 'var(--tint-red, #fef2f2)', border: '1px solid var(--tint-red-2, #fecaca)', borderRadius: 10, padding: '8px 11px' }}>{error}</div> : null}
          {skipped ? (
            <details open style={{ fontSize: 12, color: 'var(--muted, #52525b)' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{skipped.length} skipped</summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 140, overflow: 'auto' }}>
                {skipped.map((s) => <li key={s.id}>{s.name || `${kind === 'buyer' ? 'Buyer' : 'Seller'} ${s.id}`}: {s.reason}</li>)}
              </ul>
            </details>
          ) : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" disabled={!!busy || !eligible.length || !agent} onClick={() => void start()}
              style={{ height: 34, padding: '0 14px', borderRadius: 10, border: 0, background: GREEN, color: 'var(--on-dark, #fff)', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: !eligible.length || !agent ? 0.5 : 1, fontFamily: 'inherit' }}>
              <Power size={14} aria-hidden /> {busy === 'on' ? 'Turning on…' : `Turn on for ${n(eligible.length)}`}
            </button>
            <button type="button" disabled={!!busy || !picked.length} onClick={() => void stop()}
              style={{ height: 34, padding: '0 12px', borderRadius: 10, border: '1px solid var(--tint-red-2, #fecaca)', background: 'var(--surface, #fff)', color: 'var(--tx-hot, #dc2626)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' }}>
              {busy === 'off' ? 'Turning off…' : 'Turn off for selected'}
            </button>
            <span style={{ fontSize: 11.5, color: 'var(--subtle, #a1a1aa)' }}>Touches go out 9am to 8pm, at most one a day per {w.one}, and stop the moment someone replies STOP.</span>
          </div>
        </>
      )}
      </div>
      </div>
    </div>
  );
}
