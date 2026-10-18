// AI Agent, Test: talk to the PUBLISHED agent from the browser, either freely
// or against one of the scenarios. The tester plays a seller or a cash buyer;
// a scenario says what to play and what the agent should do; when the call ends, score_call grades the
// stored call against that checklist. A test never uses unsaved or unpublished
// edits: what runs is the live version, and this tab says so.
'use client';

import React, { useState } from 'react';
import { scenarioFits, type Scenario } from '@/lib/voice-agent';
import { Badge, Banner, Section, Segmented, linkBtn, ghost, MUTED, INK } from '../kit';
import { ScenarioCard, ScenarioList, ScenarioLoading, ScoreRunner, useScenarios } from '../ScenarioParts';
import { TestCall, type CallEnd } from '../TestCall';
import type { TabCtx } from '../types';

type Mode = 'free' | 'scenario';

export function TestTab(ctx: TabCtx) {
  const { api, workspaceId, admin, agentKey, detail, form, published, goTo } = ctx;
  const [mode, setMode] = useState<Mode>('free');
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  // Who the tester plays. Buyer-facing roles start as a buyer.
  const role = (detail.live_settings ?? form.draft).identity.role;
  const [callerAs, setCallerAs] = useState<'seller' | 'buyer'>(role === 'jr_dispo' || role === 'buyer_assistant' ? 'buyer' : 'seller');
  const [ended, setEnded] = useState<CallEnd | null>(null);
  const { load, retry } = useScenarios(api);
  const scenarios: Scenario[] = load.at === 'ready' ? load.scenarios.filter((s) => scenarioFits(s, callerAs)) : [];
  const scenario = scenarios.find((s) => s.id === scenarioId) ?? null;
  const differs = published && (detail.has_unpublished_changes || form.dirty);

  return (
    <>
      <section style={{ background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: 12, padding: '14px 18px', marginBottom: 12 }} aria-labelledby="va-test-which">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 id="va-test-which" style={{ margin: 0, fontSize: 14, fontWeight: 600, color: INK }}>What you are testing</h2>
          {published ? <Badge tone="green">Live v{detail.live_version}</Badge> : <Badge tone="amber">Not published</Badge>}
        </div>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
          {published
            ? `A test call talks to the published agent, version ${detail.live_version}. Edits in this tab, saved or not, are not in it until you publish.`
            : 'This agent has not been published, so there is nothing to call. Publish it from the bar below, then come back.'}
        </p>
        {differs ? (
          <div style={{ marginTop: 10 }}>
            <Banner tone="warn">Your {form.dirty ? 'draft has unsaved edits and ' : ''}draft differs from the live agent. The call will not reflect the changes you are looking at.</Banner>
          </div>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <Segmented<Mode> label="Test mode" value={mode} onChange={(m) => { setMode(m); setEnded(null); }} options={[{ id: 'free', label: 'Free call' }, { id: 'scenario', label: 'Scenario' }]} />
        </div>
      </section>

      {mode === 'scenario' ? (
        <Section id="va-scenarios" title="Pick a scenario" description={`Each one is a situation that goes wrong on real calls. You play the ${callerAs === 'buyer' ? 'cash buyer' : 'seller'}; the agent is graded on how it handles it. Switch seller or buyer under Who is calling.`}>
          {load.at === 'loading' ? <ScenarioLoading /> : load.at === 'error' ? (
            <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={retry}>Try again</button>}>Could not load the scenarios. {load.error}</Banner>
          ) : (
            <>
              <ScenarioList scenarios={scenarios} value={scenarioId} onChange={(id) => { setScenarioId(id); setEnded(null); }} />
              {scenario ? <div style={{ marginTop: 12 }}><ScenarioCard scenario={scenario} /></div> : <p style={{ margin: '10px 0 0', fontSize: 12.5, color: MUTED }}>Choose one to see what to say.</p>}
            </>
          )}
        </Section>
      ) : null}

      <TestCall api={api} workspaceId={workspaceId} admin={admin} agentKey={agentKey} ready={published} agentName={detail.live_settings?.identity.name || form.draft.identity.name}
        onStarted={() => setEnded(null)} onEnded={(e) => setEnded(e)}
        callerAs={callerAs} onCallerAs={(k) => { setCallerAs(k); if (scenario && !scenarioFits(scenario, k)) { setScenarioId(null); setEnded(null); } }} />

      {mode === 'scenario' && ended ? (
        <Section id="va-score" title="Score this call" description={scenario ? `Grade the call you just made against the ${scenario.title} checklist.` : 'Pick a scenario above to grade the call.'}
          help={api.demo ? 'Demo: the result is scripted.' : 'The call is stored when ElevenLabs sends its post-call webhook, which can take a minute. If scoring says it is not there yet, wait and try again.'}>
          {ended.lines === 0 ? <div style={{ marginBottom: 10 }}><Banner tone="warn">The call ended before anyone spoke, so there is nothing to grade.</Banner></div> : null}
          <ScoreRunner api={api} agentKey={agentKey} conversationId={ended.conversationId} scenario={scenario} />
          <p style={{ margin: '10px 0 0', fontSize: 12, color: MUTED }}>Want to grade an older call instead? <button type="button" className="va-btn" style={linkBtn} onClick={() => goTo('calls')}>Open Calls and stats</button></p>
        </Section>
      ) : null}
    </>
  );
}
