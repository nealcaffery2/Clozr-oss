// AI Agent, Test: talk to the agent from the browser, either freely or against
// one of the scenarios. The tester plays a seller or a cash buyer; a scenario
// says what to play and what the agent should do; when the call ends, score_call
// grades the stored call against that checklist. A call runs the draft (unsaved
// edits included, through session overrides) or the live version, and this tab
// says which; "Talk while you edit" opens the same call beside every tab.
'use client';

import React, { useCallback, useState } from 'react';
import { AudioLines } from 'lucide-react';
import type { TestVersion } from '@/lib/voice-agent-client';
import { isComprRole, scenarioFits, type Scenario } from '@/lib/voice-agent';
import { Badge, Banner, Section, Segmented, linkBtn, ghost, MUTED, INK } from '../kit';
import { ScenarioCard, ScenarioList, ScenarioLoading, ScoreRunner, useScenarios } from '../ScenarioParts';
import { TestCall, type CallEnd } from '../TestCall';
import type { TabCtx } from '../types';

type Mode = 'free' | 'scenario';
type Which = 'draft' | 'live';

export function TestTab(ctx: TabCtx) {
  const { api, workspaceId, agentKey, detail, form, published, goTo, openTalk } = ctx;
  const [mode, setMode] = useState<Mode>('free');
  const [which, setWhich] = useState<Which>('draft');
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  // Who the tester plays. Buyer-facing roles start as a buyer.
  const role = (detail.live_settings ?? form.draft).identity.role;
  // A COMPR agent, live or in the draft being tested: the caller is a COMPR prospect.
  const compr = isComprRole(role) || isComprRole(form.draft.identity.role);
  const [callerAs, setCallerAs] = useState<'seller' | 'buyer'>(compr || role === 'jr_dispo' || role === 'buyer_assistant' ? 'buyer' : 'seller');
  const [ended, setEnded] = useState<CallEnd | null>(null);
  const { load, retry } = useScenarios(api);
  const scenarios: Scenario[] = load.at === 'ready' ? load.scenarios.filter((s) => scenarioFits(s, callerAs)) : [];
  const scenario = scenarios.find((s) => s.id === scenarioId) ?? null;
  const differs = published && (detail.has_unpublished_changes || form.dirty);
  const draftVersion = useCallback((): TestVersion => ({ draft: true, ...(form.dirty ? { settings: form.draft } : {}) }), [form.dirty, form.draft]);

  return (
    <>
      <section style={{ background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: 12, padding: '14px 18px', marginBottom: 12 }} aria-labelledby="va-test-which">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 id="va-test-which" style={{ margin: 0, fontSize: 14, fontWeight: 600, color: INK }}>What you are testing</h2>
          {published ? null : <Badge tone="amber">Not published</Badge>}
        </div>
        {published ? (
          <div style={{ marginTop: 10 }}>
            <Segmented<Which> label="Version to call" value={which} onChange={setWhich}
              options={[{ id: 'draft', label: form.dirty ? 'Your draft, with edits' : 'Your draft' }, { id: 'live', label: `Live v${detail.live_version}` }]} />
          </div>
        ) : null}
        <p style={{ margin: '8px 0 0', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
          {!published
            ? 'This agent has not been published, so there is nothing to call. Publish it once from the bar below; after that you can call the draft without publishing.'
            : which === 'draft'
              ? `The call runs the prompt, script, rules, voice and model in this form, unsaved edits included. Tools, transfer and call timing stay as live v${detail.live_version}. Nothing is published.`
              : `The call talks to the published agent, version ${detail.live_version}, exactly as callers hear it.`}
        </p>
        {differs && which === 'live' ? (
          <div style={{ marginTop: 10 }}>
            <Banner tone="warn">Your {form.dirty ? 'draft has unsaved edits and ' : ''}draft differs from the live agent. This call will not have those changes. Pick Your draft to hear them.</Banner>
          </div>
        ) : null}
        {openTalk ? (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 10, background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)' }}>
            <span style={{ flex: '1 1 220px', minWidth: 0, fontSize: 12.5, color: MUTED, lineHeight: 1.45 }}>
              <strong style={{ display: 'block', color: INK, fontSize: 13 }}>Talk while you edit</strong>
              Keeps a call open beside the tabs. Change a line in Script or Personality, call again, hear the difference.
            </span>
            <button type="button" className="va-btn va-ghost" style={{ ...ghost, height: 36 }} onClick={openTalk}><AudioLines size={15} aria-hidden="true" /> Talk to it</button>
          </div>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <Segmented<Mode> label="Test mode" value={mode} onChange={(m) => { setMode(m); setEnded(null); }} options={[{ id: 'free', label: 'Free call' }, { id: 'scenario', label: 'Scenario' }]} />
        </div>
      </section>

      {mode === 'scenario' ? (
        <Section id="va-scenarios" title="Pick a scenario" description={compr
          ? 'Each one is a situation that goes wrong on real calls. You play the COMPR prospect; the agent is graded on how it handles it.'
          : `Each one is a situation that goes wrong on real calls. You play the ${callerAs === 'buyer' ? 'cash buyer' : 'seller'}; the agent is graded on how it handles it. Switch seller or buyer under Who is calling.`}>
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

      <TestCall api={api} workspaceId={workspaceId} agentKey={agentKey} ready={published}
        agentName={which === 'draft' ? form.draft.identity.name || detail.name : detail.live_settings?.identity.name || form.draft.identity.name}
        version={which === 'draft' ? draftVersion : undefined} compr={compr}
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
