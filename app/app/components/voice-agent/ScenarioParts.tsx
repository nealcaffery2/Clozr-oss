// Scenario testing pieces, shared by the Test tab and the Calls tab: the
// scenario list, the card that says what to play, and the scored result.
// score_call grades a stored call against a scenario's checklist and, for
// every item, returns pass or fail with the words that decided it.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Api } from '@/lib/voice-agent-client';
import type { Scenario, ScoreResult } from '@/lib/voice-agent';
import { gradesSorted, scoreTone } from '@/lib/voice-agent-console';
import { Badge, Banner, INK, LINE, MUTED, RED, Skeleton, Spinner, ghost, primary } from './kit';

type Load = { at: 'loading' } | { at: 'ready'; scenarios: Scenario[] } | { at: 'error'; error: string };

export function useScenarios(api: Api) {
  const [load, setLoad] = useState<Load>({ at: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    void api.scenarios().then((r) => { if (live) setLoad(r.ok ? { at: 'ready', scenarios: r.data } : { at: 'error', error: r.error }); });
    return () => { live = false; };
  }, [api, nonce]);
  const retry = useCallback(() => { setLoad({ at: 'loading' }); setNonce((n) => n + 1); }, []);
  return { load, retry };
}

export function ScenarioList({ scenarios, value, onChange, disabled }: { scenarios: Scenario[]; value: string | null; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Scenario" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 210px), 1fr))', gap: 8 }}>
      {scenarios.map((s) => {
        const on = s.id === value;
        return (
          <button key={s.id} type="button" role="radio" aria-checked={on} disabled={disabled} className="va-btn" onClick={() => onChange(s.id)}
            style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', border: `1px solid ${on ? '#0A8560' : LINE}`,
              background: on ? '#E7F8F1' : '#fff', boxShadow: on ? '0 0 0 1px #0A8560' : 'none', opacity: disabled && !on ? 0.6 : 1 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: on ? '#0A8560' : INK }}>{s.title}</span>
            <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: MUTED, lineHeight: 1.4 }}>{s.summary}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ScenarioLoading() {
  return <div aria-busy="true" aria-label="Loading scenarios" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 210px), 1fr))', gap: 8 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={62} style={{ borderRadius: 10 }} />)}</div>;
}

/** What to say on the call (the persona) and what the agent is expected to do (the checklist). */
export function ScenarioCard({ scenario }: { scenario: Scenario }) {
  return (
    <div className="va-in" style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: '10px 14px', background: '#fffbeb', borderBottom: '1px solid #fde68a' }}>
        <div style={{ fontSize: 11.5, color: '#92400e', fontWeight: 700 }}>You play the {scenario.audience === 'buyer' ? 'cash buyer' : scenario.audience === 'any' ? 'caller' : 'seller'}. Say this to the agent</div>
        <p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.55, color: INK }}>{scenario.persona}</p>
      </div>
      <div style={{ padding: '10px 14px' }}>
        <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>The agent should</div>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
          {scenario.checklist.map((c) => (
            <li key={c.id} style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 1.5, color: INK }}>
              <span aria-hidden="true" style={{ width: 14, height: 14, marginTop: 3, flex: 'none', borderRadius: 4, border: `1.5px solid #d4d4d8` }} />
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const TONE = { good: { fg: '#0A8560', bg: '#E7F8F1' }, mid: { fg: '#92400e', bg: '#fef3c7' }, bad: { fg: RED, bg: '#fee2e2' } };

export function ScoreCard({ result, scenario, demo }: { result: ScoreResult; scenario?: Scenario; demo?: boolean }) {
  const tone = TONE[scoreTone(result.score)];
  return (
    <div className="va-in" role="region" aria-label="Score" style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: `1px solid ${LINE}`, flexWrap: 'wrap' }}>
        <span aria-label={`Score ${result.score} percent`} style={{ display: 'grid', placeItems: 'center', width: 54, height: 54, borderRadius: 999, background: tone.bg, color: tone.fg, fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums', flex: 'none' }}>{result.score}%</span>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: INK }}>{result.passed} of {result.total} passed</span>
            {demo ? <Badge tone="grey">Demo</Badge> : null}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{scenario ? `${scenario.title}. ` : ''}{demo ? 'A scripted result, not a model grade.' : result.model ? `Graded by ${result.model}.` : ''}</div>
        </div>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {gradesSorted(result.items).map((g, i) => (
          <li key={g.id} style={{ display: 'flex', gap: 10, padding: '11px 14px', borderTop: i ? '1px solid #f0f0f1' : 'none' }}>
            <span aria-hidden="true" style={{ width: 20, height: 20, marginTop: 1, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 999, background: g.pass ? '#0A8560' : '#dc2626', color: '#fff' }}>
              {g.pass ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>{g.text}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: g.pass ? '#0A8560' : RED }}>{g.pass ? 'Passed' : 'Failed'}</span>
              </div>
              {g.quote ? (
                <blockquote style={{ margin: '6px 0 0', padding: '6px 10px', borderLeft: `3px solid ${g.pass ? '#86efac' : '#fca5a5'}`, background: '#fafafa', borderRadius: '0 8px 8px 0', fontSize: 12.5, lineHeight: 1.5, color: INK }}>
                  &ldquo;{g.quote}&rdquo;
                  {!g.quote_found ? <span style={{ display: 'block', marginTop: 2, fontSize: 11.5, color: '#92400e' }}>Not found word for word in the transcript.</span> : null}
                </blockquote>
              ) : null}
              {g.note ? <p style={{ margin: '6px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{g.note}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Score one stored call against one scenario. A call is stored when ElevenLabs sends its post-call webhook, which can lag by a minute. */
export function ScoreRunner({ api, agentKey, conversationId, scenario, label = 'Score this call' }: { api: Api; agentKey: string; conversationId: string | null; scenario: Scenario | null; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; r: ScoreResult } | null>(null);
  const key = `${conversationId}|${scenario?.id}`;
  const run = async () => {
    if (!conversationId || !scenario || busy) return;
    setBusy(true); setError(null);
    const r = await api.scoreCall(agentKey, conversationId, scenario.id);
    setBusy(false);
    if (r.ok) setResult({ key, r: r.data }); else setError(r.error);
  };
  const shown = result && result.key === key ? result.r : null;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="va-btn va-prim" disabled={!conversationId || !scenario || busy} onClick={() => void run()} style={{ ...primary(!conversationId || !scenario || busy), height: 36, padding: '0 16px' }}>
          {busy ? <Spinner size={14} /> : null}{busy ? 'Scoring…' : shown ? 'Score again' : label}
        </button>
        {!conversationId ? <span style={{ fontSize: 12, color: MUTED }}>This call has no conversation id yet, so it cannot be scored.</span> : null}
        {!scenario ? <span style={{ fontSize: 12, color: MUTED }}>Pick a scenario first.</span> : null}
      </div>
      {error ? (
        <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => void run()} disabled={busy}>Try again</button>}>
          {error}{/No stored call/i.test(error) ? ' Give it a minute after the call ends, then try again.' : ''}
        </Banner>
      ) : null}
      {shown ? <ScoreCard result={shown} scenario={scenario ?? undefined} demo={api.demo} /> : null}
    </div>
  );
}
