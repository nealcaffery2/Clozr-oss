// AI Agent, Test call: talk to the agent from the browser, as if a seller or
// buyer had rung: a made-up sample seller or cash buyer, a real record, or "Me" (the sample
// seller, or the sample buyer on a buyer-side agent, under your own name, from the browser or
// rung on any phone you type). `test_session` returns a signed link plus the exact dynamic
// variables the phone path would send (plus record_id and record_token for a real record, so lead_context finds it
// without a caller ID); the SDK is loaded only on Start.
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Mic, MicOff, Phone, PhoneOff, Search, X } from 'lucide-react';
import { searchRecords, type Api, type RecordHit, type TestVersion } from '@/lib/voice-agent-client';
import { DEMO_RECORDS } from '@/lib/voice-agent-demo';
import { asComprProspect, formatDuration, levelPercent, orderVariables } from '@/lib/voice-agent';
import { Banner, GREEN, INK, LINE, MUTED, Segmented, Spinner, card, eyebrow, ghost, h2, input, mono, primary, sub } from './kit';
import { Meter, StatusPill, Transcript } from './CallParts';
import { useCallSession, type CallEnd } from './useCallSession';

export type { CallEnd } from './useCallSession';

type Kind = 'seller' | 'buyer';
type Target = { kind: 'sample' } | ({ kind: Kind } & Pick<RecordHit, 'id' | 'name' | 'sub'>);
const SAMPLE: Record<Kind, [string, string]> = {
  seller: ['Sample seller', 'A made-up seller with a full brief'],
  buyer: ['Sample cash buyer', 'A made-up cash buyer with a buy box and a deal we sent'],
};
/** "Me" plays the side this agent talks to: a test seller, or a test cash buyer on a buyer-side agent. */
const ME: Record<Kind, [string, string]> = {
  seller: ['You, as a test seller', 'Mock seller data under your name. Talk here or have the agent ring a phone.'],
  buyer: ['You, as a test cash buyer', 'Mock buyer data (buy box, a deal we sent) under your name. Talk here or have the agent ring a phone.'],
};
/** A COMPR agent's caller is a COMPR prospect (a buyer record), never a seller or cash buyer. */
const COMPR_SAMPLE: [string, string] = ['Sample COMPR prospect', 'A made-up wholesaler on a COMPR trial: two addresses run, no demo booked'];
const COMPR_ME: [string, string] = ['You, as a test COMPR prospect', 'Mock COMPR trial data under your name. Talk here or have the agent ring a phone.'];
/**
 * `callerAs` is who the tester plays (the Test tab's seller or buyer switch): the
 * sample follows it, and picking a caller here reports its kind back through `onCallerAs`.
 * `version` picks what the call runs: the draft (read when Start is pressed, so a tweak
 * is in the next call) or, when omitted, the published agent. `compr` is a COMPR agent:
 * the caller is a COMPR prospect, and there is no seller or cash buyer to pick.
 */
export function TestCall({ api, workspaceId, agentKey, ready, agentName, onEnded, onStarted, callerAs = 'seller', onCallerAs, version, compr = false }: {
  api: Api; workspaceId: number | null; agentKey: string; ready: boolean; agentName: string; onEnded?: (e: CallEnd) => void; onStarted?: () => void;
  callerAs?: Kind; onCallerAs?: (k: Kind) => void; version?: () => TestVersion; compr?: boolean;
}) {
  const demo = api.demo;
  const [target, setTarget] = useState<Target>({ kind: 'sample' });
  // The sample's kind is the parent's when it tracks one, else this panel's own.
  const [ownAs, setOwnAs] = useState<Kind>(callerAs);
  const [me, setMe] = useState(false);
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const sampleAs: Kind = compr ? 'buyer' : onCallerAs ? callerAs : ownAs;
  const ringPhone = me && target.kind === 'sample' && phone.trim() !== '';
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<RecordHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [knowsOpen, setKnowsOpen] = useState(false);
  const livePanel = useRef<HTMLElement | null>(null);
  const live = workspaceId != null && !demo;
  const call = useCallSession({ live, onStarted, onEnded });
  const { phase, error, setError, session, lines, tools, speaking, muted, mic, out, elapsed, busy, inCall, run, setPhase, setSession } = call;

  // The picker: sample records in /demo, a debounced name search otherwise.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let alive = true;
    const t = setTimeout(async () => {
      if (!live) {
        const w = term.toLowerCase();
        if (alive) { setHits(DEMO_RECORDS.filter((r) => r.name.toLowerCase().includes(w) || r.sub.toLowerCase().includes(w))); setSearching(false); }
        return;
      }
      const r = await searchRecords(workspaceId as number, term);
      if (!alive) return;
      setSearching(false);
      setHits(r.ok ? r.data : []);
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, live, workspaceId]);

  const start = useCallback(async () => {
    setNote(null);
    const tt = target.kind === 'sample' ? (me ? { sample: 'me' as const, as: sampleAs } : { sample: sampleAs }) : { kind: target.kind, id: target.id };
    const v = version?.() ?? {};
    if (ringPhone) {
      setError(null);
      setPhase('starting');
      const p = await api.phoneTest(agentKey, tt, phone.trim(), v);
      setPhase('idle');
      if (!p.ok) return setError(p.error);
      setSession(p.data);
      return setNote(p.data.note);
    }
    // Stacked on a phone, the transcript sits below the controls: bring it into view.
    if (window.innerWidth < 760) livePanel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // A COMPR agent's sample rides on the sample buyer; the prospect's brief replaces the buy box.
    const prospect = compr && target.kind === 'sample';
    await run(() => api.startTestSession(agentKey, tt, v).then((r) => (r.ok && prospect ? { ...r, data: asComprProspect(r.data) } : r)));
  }, [agentKey, api, compr, me, phone, ringPhone, run, sampleAs, setError, setPhase, setSession, target, version]);

  const canStart = (demo || ready) && !inCall;
  const showResults = q.trim().length >= 2;
  const pickSample = (k: Kind | 'me') => {
    const as = k === 'me' ? sampleAs : k;
    setTarget({ kind: 'sample' }); setQ(''); setHits(null); setMe(k === 'me'); setNote(null); setOwnAs(as); onCallerAs?.(as);
  };
  const pick = (t: Exclude<Target, { kind: 'sample' }>) => { setTarget(t); setQ(''); setHits(null); setMe(false); onCallerAs?.(t.kind); };
  const sampleKey = me ? 'me' : sampleAs;
  const sampleText: [string, string] = compr ? (me ? COMPR_ME : COMPR_SAMPLE) : (me ? ME : SAMPLE)[sampleAs];
  const who = target.kind === 'sample' ? sampleText[0] : target.name;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: '0 12px', alignItems: 'start' }}>
      <div style={{ minWidth: 0 }}>
        <section style={card} aria-labelledby="va-test">
          <h2 id="va-test" style={h2}>Test the agent</h2>
          <p style={{ ...sub, marginBottom: 14 }}>Talk to it from this browser. It is given the same brief a real caller&apos;s record would give it.</p>

          {demo ? <div style={{ marginBottom: 12 }}><Banner tone="info"><strong style={{ color: INK }}>Demo.</strong> This plays a scripted conversation. No microphone, no ElevenLabs, no model.</Banner></div> : null}
          {!demo && !ready ? <div style={{ marginBottom: 12 }}><Banner tone="warn">Publish the agent once. A test call runs on its ElevenLabs agent, so there is nothing to call until it exists.</Banner></div> : null}
          <div style={{ marginBottom: 12 }}>
            <Banner tone="info">{target.kind === 'sample'
              ? <>The sample callers are made up, so the agent&apos;s <span style={{ ...mono, whiteSpace: 'nowrap' }}>lead_context</span> tool finds no record. It works from the brief below.</>
              : <>The agent&apos;s <span style={{ ...mono, whiteSpace: 'nowrap' }}>lead_context</span> tool looks up {target.name || 'this record'}, as it would on a real call from their number.</>}</Banner>
          </div>

          <span style={eyebrow}>Who is calling</span>
          <div style={{ marginBottom: 8 }}>
            <Segmented<Kind | 'me'> label="Caller type" disabled={inCall} value={target.kind === 'sample' ? sampleKey : target.kind}
              onChange={pickSample}
              options={compr
                ? [{ id: 'buyer', label: 'COMPR prospect', hint: 'An investor on a COMPR trial the agent books a demo with Alex for.' },
                  { id: 'me', label: 'Me (test)', hint: 'You, the CRM owner, as a COMPR prospect. Optionally rings your phone.' }]
                : [{ id: 'seller', label: 'Seller', hint: 'A homeowner the agent is buying from.' }, { id: 'buyer', label: 'Cash buyer', hint: 'An investor the agent is selling deals to.' },
                  { id: 'me', label: 'Me (test)', hint: `You, the CRM owner, with mock ${sampleAs} data. Optionally rings your phone.` }]} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 8px 12px', borderRadius: 10, border: `1px solid ${LINE}`, background: 'var(--canvas, #fafafa)' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who}</span>
              <span style={{ display: 'block', fontSize: 12, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {target.kind === 'sample' ? sampleText[1] : target.sub}
              </span>
            </span>
            {target.kind !== 'sample' && !inCall ? (
              <button type="button" className="va-btn va-ghost" style={{ ...ghost, height: 28, padding: '0 9px' }} onClick={() => pickSample(target.kind)}>
                <X size={13} aria-hidden="true" /> Use sample
              </button>
            ) : null}
          </div>

          {me && !inCall ? (
            <div style={{ marginTop: 10 }}>
              <label htmlFor="va-test-phone" style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: INK, marginBottom: 4 }}>Phone to ring (optional)</label>
              <input id="va-test-phone" className="va-field" type="tel" inputMode="tel" autoComplete="tel" name="phone" placeholder="(210) 555-0100…" value={phone} style={input}
                onChange={(e) => setPhone(e.target.value)} />
              <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED }}>Leave empty to talk from this browser. With a number, the agent calls it from its line. Nothing is saved to the CRM.</p>
            </div>
          ) : null}

          <div role="status" aria-live="polite">{note ? <div style={{ marginTop: 12 }}><Banner tone="ok">{note}</Banner></div> : null}</div>

          {!inCall && !me ? (
            <div style={{ marginTop: 10 }}>
              <div style={{ position: 'relative' }}>
                <Search size={15} aria-hidden="true" style={{ position: 'absolute', left: 11, top: 11, color: MUTED, pointerEvents: 'none' }} />
                <input className="va-field" type="search" aria-label="Search sellers and buyers" placeholder="Or search a seller or buyer by name" value={q} style={{ ...input, paddingLeft: 33 }}
                  onChange={(e) => { setQ(e.target.value); setSearching(e.target.value.trim().length >= 2); }} />
              </div>
              {showResults ? (
                <div role="listbox" aria-label="Matching records" style={{ marginTop: 6, border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', background: 'var(--surface, #fff)', maxHeight: 240, overflowY: 'auto' }}>
                  {searching && !hits ? (
                    <div style={{ padding: 12, fontSize: 12.5, color: MUTED, display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> Searching</div>
                  ) : hits && hits.length ? hits.map((h) => (
                    <button key={h.kind + h.id} type="button" role="option" aria-selected={false} className="va-row va-btn" onClick={() => pick({ kind: h.kind, id: h.id, name: h.name, sub: h.sub })}
                      style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '9px 12px', border: 0, borderBottom: '1px solid var(--divider-2, #f0f0f1)', background: 'transparent', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: INK }}>{h.name}</span>
                        <span style={{ display: 'block', fontSize: 12, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.sub}</span>
                      </span>
                      <span style={{ textTransform: 'capitalize', fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: h.kind === 'buyer' ? '#eef2ff' : '#E7F8F1', color: h.kind === 'buyer' ? '#4338ca' : GREEN }}>{h.kind}</span>
                    </button>
                  )) : <div style={{ padding: 12, fontSize: 12.5, color: MUTED }}>No seller or buyer named like that.</div>}
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? <div style={{ marginTop: 12 }}><Banner tone="error" action={!inCall ? <button type="button" className="va-btn va-ghost" style={ghost} onClick={() => void start()} disabled={!canStart}>Try again</button> : undefined}>{error}</Banner></div> : null}

          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {inCall ? (
              <button type="button" className="va-btn" onClick={() => void call.end()} style={{ ...ghost, height: 40, flex: 1, background: '#dc2626', border: '1px solid #dc2626', color: '#fff', fontSize: 13.5 }}>
                <PhoneOff size={16} aria-hidden="true" /> End call
              </button>
            ) : (
              <button type="button" className="va-btn va-prim" disabled={!canStart} onClick={() => void start()} style={{ ...primary(!canStart), height: 40, flex: 1, fontSize: 13.5 }}>
                <Phone size={16} aria-hidden="true" /> {ringPhone ? 'Call this phone' : phase === 'ended' ? 'Start another test call' : 'Start test call'}
              </button>
            )}
            {phase === 'live' ? (
              <button type="button" className="va-btn va-ghost" aria-pressed={muted} onClick={call.toggleMute} style={{ ...ghost, height: 40, minWidth: 92 }}>
                {muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />} {muted ? 'Unmute' : 'Mute'}
              </button>
            ) : null}
          </div>
        </section>

        {session ? (
          <section style={card} aria-labelledby="va-knows">
            <button type="button" id="va-knows" className="va-btn" aria-expanded={knowsOpen} aria-controls="va-knows-body" onClick={() => setKnowsOpen((o) => !o)}
              style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', ...h2 }}>What the agent knows</span>
                <span style={{ display: 'block', ...sub }}>The brief and variables it was handed for this call.</span>
              </span>
              <ChevronDown size={18} aria-hidden="true" style={{ color: MUTED, flex: 'none', transform: knowsOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
            </button>
            {knowsOpen ? (
              <div id="va-knows-body" className="va-in" style={{ marginTop: 14 }}>
                {session.first_message ? (
                  <>
                    <span style={eyebrow}>Opening line</span>
                    <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.55, color: INK }}>&ldquo;{session.first_message}&rdquo;</p>
                  </>
                ) : null}
                {session.resolution ? <p style={{ margin: '0 0 14px', fontSize: 12, color: MUTED }}>{session.resolution}</p> : null}
                <span style={eyebrow}>Brief</span>
                <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.55, color: session.dynamic_variables.lead_brief ? INK : MUTED, whiteSpace: 'pre-wrap' }}>
                  {String(session.dynamic_variables.lead_brief || 'No brief on this record yet. The agent will ask who is calling.')}
                </p>
                <span style={eyebrow}>Variables</span>
                <dl style={{ margin: 0 }}>
                  {orderVariables(session.dynamic_variables).map((v) => (
                    <div key={v.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 150px) minmax(0, 1fr)', gap: 10, padding: '6px 0', borderTop: '1px solid var(--divider-2, #f0f0f1)', fontSize: 12.5 }}>
                      <dt style={{ ...mono, color: MUTED }}>{v.key}</dt>
                      <dd style={{ margin: 0, minWidth: 0, color: INK, overflowWrap: 'anywhere' }}>{v.value === '' ? <span style={{ color: MUTED }}>empty</span> : v.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      <section ref={livePanel} style={{ ...card, minWidth: 0, padding: 0, overflow: 'hidden' }} aria-label="Live call" aria-busy={busy}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${LINE}`, flexWrap: 'wrap' }}>
          <StatusPill phase={phase} speaking={speaking} muted={muted} />
          <span style={{ marginLeft: 'auto', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: MUTED }}>{phase === 'idle' || phase === 'starting' ? '' : formatDuration(elapsed)}</span>
        </div>
        {phase === 'live' || phase === 'ended' ? (
          <div style={{ display: 'grid', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${LINE}`, background: 'var(--canvas, #fafafa)' }}>
            <Meter label="You" pct={muted ? 0 : levelPercent(mic)} off={muted} />
            <Meter label="Agent" pct={levelPercent(out)} />
          </div>
        ) : null}
        <Transcript scroller={call.scroller} phase={phase} lines={lines} tools={tools} agentName={agentName} idleHint="Start a test call and both sides appear as they speak." style={{ height: 360, maxHeight: '55vh' }} />
      </section>
    </div>
  );
}
