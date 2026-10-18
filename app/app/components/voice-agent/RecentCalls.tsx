// AI Agent, Calls: what the agent handled lately, from the post-call webhook's
// communications rows. Summary first, the transcript one click down, and a way
// to grade the call against a scenario.
'use client';

import React, { useEffect, useState } from 'react';
import { ChevronDown, ClipboardCheck, RefreshCw } from 'lucide-react';
import type { Api } from '@/lib/voice-agent-client';
import { formatDuration, scenarioFits, timeAgo, type AgentCall, type Scenario } from '@/lib/voice-agent';
import { Badge, Banner, Dialog, Empty, GREEN, INK, LINE, MUTED, Skeleton, card, ghost, h2, sub } from './kit';
import { ScenarioCard, ScenarioList, ScenarioLoading, ScoreRunner, useScenarios } from './ScenarioParts';

type Load = { at: 'loading' } | { at: 'ready'; calls: AgentCall[] } | { at: 'error'; error: string };

/** "Agent: hi\nCaller: hello" into speaker and text; a line with no label continues the last one. */
function speakerLines(text: string): { who: string; text: string }[] {
  const out: { who: string; text: string }[] = [];
  for (const raw of text.split(/\n+/)) {
    const m = /^(Agent|Caller|Rep|Contact|User|AI)\s*:\s*(.*)$/i.exec(raw.trim());
    if (m) out.push({ who: m[1]!, text: m[2]! });
    else if (raw.trim()) out.push({ who: out.length ? '' : 'Transcript', text: raw.trim() });
  }
  return out;
}

function ScoreDialog({ api, agentKey, call, now, onClose }: { api: Api; agentKey: string; call: AgentCall; now: number; onClose: () => void }) {
  const { load, retry } = useScenarios(api);
  const [id, setId] = useState<string | null>(null);
  // A known buyer or seller call lists the scenarios for that caller; a call with no record (a sample test) lists them all.
  const as = call.record_kind;
  const scenarios: Scenario[] = load.at === 'ready' ? load.scenarios.filter((s) => !as || scenarioFits(s, as)) : [];
  const scenario = scenarios.find((s) => s.id === id) ?? null;
  return (
    <Dialog title="Score against a scenario" titleId="va-score-title" onClose={onClose} width={640}
      footer={<button type="button" className="va-btn va-ghost" style={ghost} onClick={onClose} data-autofocus>Close</button>}>
      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
        Grade {timeAgo(call.started_at, now) || 'this'} call ({formatDuration(call.duration_s)}) against a checklist. Best for test calls where you played the scenario.
      </p>
      {load.at === 'loading' ? <ScenarioLoading /> : load.at === 'error' ? (
        <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={retry}>Try again</button>}>Could not load the scenarios. {load.error}</Banner>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <ScenarioList scenarios={scenarios} value={id} onChange={setId} />
          {scenario ? <ScenarioCard scenario={scenario} /> : null}
          <ScoreRunner api={api} agentKey={agentKey} conversationId={call.conversation_id} scenario={scenario} label="Score this call" />
        </div>
      )}
    </Dialog>
  );
}

export function RecentCalls({ api, agentKey, epoch, canScore, onOpenRecord }: {
  api: Api; agentKey: string; epoch: number; canScore: boolean; onOpenRecord?: (kind: 'seller' | 'buyer', id: number) => void;
}) {
  const [load, setLoad] = useState<Load>({ at: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [scoring, setScoring] = useState<AgentCall | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void api.calls(agentKey).then((r) => {
      if (!live) return;
      setLoad(r.ok ? { at: 'ready', calls: r.data } : { at: 'error', error: r.error });
      setNow(Date.now());
    });
    return () => { live = false; };
  }, [api, agentKey, nonce, epoch]);

  const refresh = () => { setLoad({ at: 'loading' }); setNonce((n) => n + 1); };

  return (
    <section style={card} aria-labelledby="va-calls">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <h2 id="va-calls" style={h2}>Recent calls</h2>
          <p style={sub}>The last 25 calls this agent handled, filed on the seller or buyer after each call ends.</p>
        </div>
        <button type="button" className="va-btn va-ghost" style={ghost} onClick={refresh} disabled={load.at === 'loading'} aria-label="Refresh calls">
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>

      {load.at === 'loading' ? (
        <div aria-busy="true" aria-label="Loading calls" style={{ display: 'grid', gap: 10 }}>
          {[0, 1, 2].map((i) => <Skeleton key={i} h={64} style={{ borderRadius: 10 }} />)}
        </div>
      ) : load.at === 'error' ? (
        <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={refresh}>Try again</button>}>Could not load calls. {load.error}</Banner>
      ) : load.calls.length === 0 ? (
        <Empty title="No calls yet">Once this agent answers a call, its summary and transcript land here. Use the Test tab to try it now.</Empty>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
          {load.calls.map((c, i) => {
            const open = openId === c.id;
            const link = c.record_kind && c.record_id != null && onOpenRecord;
            return (
              <li key={c.id} style={{ borderTop: i ? `1px solid var(--divider-2, #f0f0f1)` : 'none', background: 'var(--surface, #fff)' }}>
                <div style={{ padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: MUTED, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: INK, fontWeight: 600 }}>{timeAgo(c.started_at, now) || 'Unknown time'}</span>
                    <span aria-hidden="true">{'·'}</span>
                    <span>{formatDuration(c.duration_s)}</span>
                    {c.record_kind ? <Badge tone={c.record_kind === 'buyer' ? 'indigo' : 'green'}>{c.record_kind}</Badge> : <Badge tone="grey">No match</Badge>}
                  </div>
                  <p style={{ margin: '5px 0 0', fontSize: 13, lineHeight: 1.5, color: c.summary ? INK : MUTED }}>{c.summary || 'No summary was written for this call.'}</p>
                  <div style={{ marginTop: 8, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    {c.transcript_preview ? (
                      <button type="button" className="va-btn" aria-expanded={open} onClick={() => setOpenId(open ? null : c.id)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 0, background: 'none', color: GREEN, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                        {open ? 'Hide transcript' : 'Show transcript'}
                        <ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
                      </button>
                    ) : null}
                    {c.conversation_id && canScore ? (
                      <button type="button" className="va-btn" onClick={() => setScoring(c)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0, border: 0, background: 'none', color: GREEN, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                        <ClipboardCheck size={14} aria-hidden="true" /> Score against scenario
                      </button>
                    ) : null}
                    {link ? (
                      <button type="button" className="va-btn" onClick={() => onOpenRecord(c.record_kind!, c.record_id!)}
                        style={{ padding: 0, border: 0, background: 'none', color: GREEN, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Open the {c.record_kind}
                      </button>
                    ) : null}
                  </div>
                  {open ? (
                    <div className="va-in" style={{ marginTop: 10, padding: '10px 12px', borderRadius: 9, background: 'var(--canvas, #fafafa)', border: `1px solid ${LINE}`, display: 'grid', gap: 6, fontSize: 12.5, lineHeight: 1.5 }}>
                      {speakerLines(c.transcript_preview).map((l, j) => (
                        <p key={j} style={{ margin: 0, color: INK, overflowWrap: 'anywhere' }}>
                          {l.who ? <strong style={{ color: MUTED, fontWeight: 600 }}>{l.who}: </strong> : null}{l.text}
                        </p>
                      ))}
                      <p style={{ margin: '2px 0 0', fontSize: 11.5, color: MUTED }}>A preview of the transcript. The full one is on the seller or buyer.</p>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {scoring ? <ScoreDialog api={api} agentKey={agentKey} call={scoring} now={now} onClose={() => setScoring(null)} /> : null}
    </section>
  );
}
