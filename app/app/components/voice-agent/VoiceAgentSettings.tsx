// Settings, AI Agent: the console for a workspace's ElevenLabs phone agents,
// which answer callers with the same memory a rep reads on the record
// (docs/voice-agent.md). This screen owns the list of agents and which one is
// open; AgentEditor owns one agent's tabs. Every call goes through the `Api`
// (lib/voice-agent-client.ts, the `voice-agent-admin` edge function); /demo
// swaps in an in-memory one (lib/voice-agent-demo.ts) and runs the whole
// console on sample data.
'use client';

import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Bot, Plus } from 'lucide-react';
import { useSession } from '@/lib/session';
import { isAdmin, type Role } from '@/lib/team';
import { useCanWrite } from '@/lib/read-only-context';
import { liveApi } from '@/lib/voice-agent-client';
import { createDemoApi } from '@/lib/voice-agent-demo';
import type { AgentStats, AgentSummary } from '@/lib/voice-agent';
import { AgentDialogsHost, type DialogState } from './AgentDialogsHost';
import { AgentEditor } from './AgentEditor';
import { AgentList } from './AgentList';
import { Banner, Empty, Skeleton, VaStyles, card, ghost, primary } from './kit';
import { useAgentForms } from './useAgentForm';

/** /demo?as=member shows the console as that role sees it: read only. Read after hydration, like the demo page's own ?as=. */
const DEMO_ROLE = {
  subscribe: () => () => {},
  getSnapshot: (): string => new URLSearchParams(window.location.search).get('as') ?? '',
  getServerSnapshot: (): string => '',
};

type Load = { at: 'loading' } | { at: 'ready' } | { at: 'error'; error: string };

export function VoiceAgentSettings({ isMobile, onOpenRecord }: { isMobile: boolean; onOpenRecord?: (kind: 'seller' | 'buyer', id: number) => void }) {
  const s = useSession();
  const canWrite = useCanWrite();
  const workspaceId = s.workspace?.id ?? null;
  const demo = s.demo || workspaceId == null;
  const demoRole = useSyncExternalStore(DEMO_ROLE.subscribe, DEMO_ROLE.getSnapshot, DEMO_ROLE.getServerSnapshot);
  const admin = demo && demoRole ? isAdmin(demoRole as Role) : demo || isAdmin((s.workspace?.role as Role | undefined) ?? null);
  const workspaceName = s.workspace?.name || 'Acme Homes';

  // One Api for the life of the screen: the demo one holds its agents in memory, so it must not be rebuilt on a render.
  const api = useMemo(() => (demo ? createDemoApi(workspaceName) : liveApi(workspaceId as number)), [demo, workspaceId, workspaceName]);
  const forms = useAgentForms();

  const [load, setLoad] = useState<Load>({ at: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [stats, setStats] = useState<Record<string, AgentStats | undefined>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The on/off switch: one request at a time per agent, and the reason it failed stays next to the switch that failed.
  const [switching, setSwitching] = useState<string[]>([]);
  const [switchErrors, setSwitchErrors] = useState<Record<string, string | undefined>>({});

  const fetchAll = useCallback(() => Promise.all([api.listAgents(), api.stats(undefined, 30)]), [api]);
  const apply = useCallback(([a, st]: Awaited<ReturnType<typeof fetchAll>>) => {
    if (!a.ok) return setLoad({ at: 'error', error: a.error });
    setAgents(a.data.agents);
    // Stats are decoration on the cards: a failure there must not hide the agents.
    setStats(st.ok ? Object.fromEntries(st.data.agents.map((x) => [x.agent_key, x])) : {});
    setSelected((cur) => (cur && a.data.agents.some((x) => x.agent_key === cur) ? cur : a.data.agents[0]?.agent_key ?? null));
    setLoad({ at: 'ready' });
  }, []);
  /** Read the list again after something changed it. */
  const readAll = useCallback(() => fetchAll().then(apply), [fetchAll, apply]);

  useEffect(() => {
    // nonce re-runs a failed first read.
    let live = true;
    void nonce;
    void fetchAll().then((r) => { if (live) apply(r); });
    return () => { live = false; };
  }, [fetchAll, apply, nonce]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const canEdit = admin && canWrite;
  /** No optimistic flip: the switch is disabled while the request is out, and shows what the function says when it refuses. */
  const toggleEnabled = useCallback(async (a: AgentSummary, enabled: boolean) => {
    setSwitchErrors((cur) => ({ ...cur, [a.agent_key]: undefined }));
    setSwitching((cur) => [...cur, a.agent_key]);
    const r = await api.setEnabled(a.agent_key, enabled);
    setSwitching((cur) => cur.filter((k) => k !== a.agent_key));
    if (!r.ok) return setSwitchErrors((cur) => ({ ...cur, [a.agent_key]: r.error }));
    setAgents((cur) => cur.map((x) => (x.agent_key === a.agent_key ? { ...x, enabled: r.data.enabled } : x)));
    void readAll();
  }, [api, readAll]);
  const current = agents.find((a) => a.agent_key === selected) ?? null;

  if (load.at === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading the AI agents">
        <VaStyles />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 250px), 1fr))', gap: 10, marginBottom: 12 }}>
          {[0, 1].map((i) => <Skeleton key={i} h={132} style={{ borderRadius: 12 }} />)}
        </div>
        <div style={card}><Skeleton h={14} w="40%" /><div style={{ display: 'grid', gap: 10, marginTop: 16 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={16} />)}</div></div>
      </div>
    );
  }
  if (load.at === 'error') {
    return (
      <div style={card}>
        <VaStyles />
        <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => { setLoad({ at: 'loading' }); setNonce((n) => n + 1); }}>Try again</button>}>
          Could not load the AI agents. {load.error}
        </Banner>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1040 }}>
      <VaStyles />
      {toast ? <div style={{ marginBottom: 12 }}><Banner tone="ok" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => setToast(null)}>Dismiss</button>}>{toast}</Banner></div> : null}

      {agents.length === 0 ? (
        <section style={card} aria-label="Agents">
          <Empty title="No agents yet">
            An agent answers sellers and buyers with the brief a rep would read on the record. {canEdit ? 'Start from a template and change what you like.' : 'Only owners and admins can create one.'}
          </Empty>
          {canEdit ? (
            <div style={{ textAlign: 'center', paddingBottom: 12 }}>
              <button type="button" className="va-btn va-prim" style={{ ...primary(), height: 36, padding: '0 16px' }} onClick={() => setDialog({ kind: 'new' })}><Plus size={15} aria-hidden="true" /> Create your first agent</button>
            </div>
          ) : <div style={{ textAlign: 'center', paddingBottom: 12, color: '#a1a1aa' }}><Bot size={22} aria-hidden="true" /></div>}
        </section>
      ) : (
        <AgentList agents={agents} stats={stats} selected={selected} dirtyKeys={forms.dirtyKeys} canEdit={canEdit} isMobile={isMobile}
          switching={switching} switchErrors={switchErrors} onToggle={(a, on) => void toggleEnabled(a, on)}
          onSelect={setSelected} onNew={() => setDialog({ kind: 'new' })} onDuplicate={(a) => setDialog({ kind: 'duplicate', agent: a })} onDelete={(a) => setDialog({ kind: 'delete', agent: a })} />
      )}

      {current ? (
        <AgentEditor key={current.agent_key} api={api} workspaceId={workspaceId} summary={current} form={forms.view(current.agent_key)} seeded={forms.has(current.agent_key)} admin={admin}
          canWrite={canWrite} isMobile={isMobile} onOpenRecord={onOpenRecord} onChanged={() => void readAll()}
          switching={switching.includes(current.agent_key)} switchError={switchErrors[current.agent_key]} onToggle={(on) => void toggleEnabled(current, on)} />
      ) : null}

      <AgentDialogsHost api={api} state={dialog} agents={agents} onClose={() => setDialog(null)}
        onCreated={(c, what) => { setDialog(null); void readAll().then(() => setSelected(c.agent.agent_key)); setToast(`${what} ${c.agent.name || c.agent.agent_key}. It is a draft: set it up, then publish.`); }}
        onDeleted={(key, remote) => { forms.forget(key); setDialog(null); void readAll(); setToast(remote ? 'Agent deleted, and removed from ElevenLabs too.' : 'Agent deleted.'); }} />
    </div>
  );
}
