'use client';

// The AI agent switch in a seller or buyer record's header. Green and ON while
// an agent is working the record, red and OFF when not. Switching it on opens
// the agent's popup (AiAgentDialog), where the rep says what they want or lets
// the AI decide; switching it off stops the agent at once. Clicking the name
// opens the popup either way, to read the plan and what the agent has done.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ban } from 'lucide-react';
import { aiAgentApi, type RecordKind, type RecordStatus } from '@/lib/ai-agent-client';
import { AgentAvatar } from './AgentAvatar';
import { AiAgentDialog } from './AiAgentDialog';
import { AiaStyles } from './styles';

export function AiAgentToggle({ workspaceId, kind, recordId, recordName, canWrite, mobile, offLimits }: {
  workspaceId: number | null | undefined; kind: RecordKind; recordId: number | null | undefined; recordName: string; canWrite: boolean; mobile?: boolean;
  /** Known before the server answers (a VIP or fund buyer): the switch shows Off limits from the first paint. */
  offLimits?: string | null;
}) {
  const api = useMemo(() => (workspaceId ? aiAgentApi(workspaceId) : null), [workspaceId]);
  // What the server said, keyed by the record it is about, so another record's answer never shows here.
  const key = `${workspaceId ?? ''}:${kind}:${recordId ?? ''}`;
  const [res, setRes] = useState<{ key: string; st: RecordStatus | null; err: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const st = res?.key === key ? res.st : null;
  const err = res?.key === key ? res.err : null;
  const setSt = useCallback((s: RecordStatus) => setRes({ key, st: s, err: null }), [key]);
  const setErr = useCallback((e: string | null) => setRes((r) => ({ key, st: r?.key === key ? r.st : null, err: e })), [key]);
  const live = !!api && !!recordId;

  useEffect(() => {
    if (!api || !recordId) return;
    let gone = false;
    void api.status(kind, recordId).then((r) => {
      if (gone) return;
      setRes({ key, st: r.ok ? r : null, err: r.ok ? null : r.error });
    });
    return () => { gone = true; };
  }, [api, kind, recordId, key]);

  const onChange = useCallback((s: RecordStatus) => setSt(s), [setSt]);
  const on = st?.enrollment?.status === 'active';
  const agent = st?.agents.find((a) => a.agent_key === st?.enrollment?.agent_key) ?? st?.agent ?? null;
  const blocked = (st && !st.eligible.ok ? st.eligible.reason : null) ?? offLimits ?? null;
  const name = agent?.name ?? 'AI Agent';

  const flip = async () => {
    if (!api || !recordId || busy) return;
    if (!on) { setOpen(true); return; }
    if (!canWrite) return;
    setBusy(true); setErr(null);
    const r = await api.stop(kind, recordId);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    const s = await api.status(kind, recordId);
    if (s.ok) setSt(s);
  };

  const title = !live ? 'AI agents work on live records in a connected workspace.'
    : err ? err
      : blocked ? `${blocked}.`
        : on ? `${name} is working this record. Click the name for the plan and activity; flip the switch to turn it off.`
          : `Switch on an AI agent to call, text and email ${recordName.split(' ')[0] || 'them'} on a plan.`;

  return (
    <>
      <AiaStyles />
      <div className="aia-pill" title={title}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 0, height: mobile ? 36 : 32, borderRadius: 999, flex: 'none', overflow: 'hidden',
          border: `1px solid ${on ? 'rgba(22,163,74,.45)' : blocked ? '#e4e4e7' : 'rgba(220,38,38,.35)'}`,
          background: on ? 'linear-gradient(90deg, #ecfdf5, #f0fdf4)' : blocked ? '#fafafa' : '#fff',
          boxShadow: on ? '0 0 0 3px rgba(34,197,94,.12)' : 'none', opacity: live ? 1 : 0.6 }}>
        <button type="button" onClick={() => live && setOpen(true)} disabled={!live} aria-label={`Open ${name} for this record`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: '100%', padding: '0 8px 0 4px', border: 0, background: 'none', cursor: live ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>
          <AgentAvatar name={name} src={agent?.avatar_url} size={mobile ? 28 : 24} live={on} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: on ? '#166534' : '#27272a', whiteSpace: 'nowrap', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {on ? name : 'AI Agent'}
          </span>
        </button>
        {blocked ? (
          <span aria-label="Not allowed" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 10px 0 4px', fontSize: 11.5, fontWeight: 700, color: '#71717a' }}>
            <Ban size={13} aria-hidden /> Off limits
          </span>
        ) : (
          <button type="button" role="switch" aria-checked={on} aria-label={on ? `Turn ${name} off` : 'Turn an AI agent on'} onClick={() => void flip()} disabled={!live || busy || (!on && !canWrite) || (on && !canWrite)}
            style={{ height: '100%', padding: '0 8px 0 6px', border: 0, borderLeft: `1px solid ${on ? 'rgba(22,163,74,.25)' : 'rgba(220,38,38,.2)'}`, background: 'none', cursor: live && canWrite ? 'pointer' : 'not-allowed', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' }}>
            <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', color: on ? '#16a34a' : '#dc2626' }}>{busy ? '…' : on ? 'ON' : 'OFF'}</span>
            <span aria-hidden style={{ width: 34, height: 20, borderRadius: 999, padding: 2, background: on ? '#22c55e' : '#ef4444', display: 'inline-flex', transition: 'background .2s', boxSizing: 'border-box' }}>
              <span style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.3)', transform: `translateX(${on ? 14 : 0}px)`, transition: 'transform .2s' }} />
            </span>
          </button>
        )}
      </div>
      {/* Portaled: the record header is its own stacking context, and the popup belongs above the whole page. */}
      {open && api && recordId && typeof document !== 'undefined' ? createPortal(
        <AiAgentDialog api={api} kind={kind} recordId={recordId} recordName={recordName} canWrite={canWrite} initial={st} onClose={() => setOpen(false)} onChange={onChange} />,
        document.body,
      ) : null}
    </>
  );
}
