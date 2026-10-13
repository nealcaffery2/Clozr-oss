// AI Agent, Test call: talk to the agent from the browser, as if a seller or
// buyer had rung: a made-up sample seller or cash buyer, a real record, or "Me" (the sample
// seller under your own name, from the browser or rung on any phone you type). `test_session` returns a signed link plus the exact dynamic
// variables the phone path would send; the SDK is loaded only on Start.
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Mic, MicOff, Phone, PhoneOff, Search, Wrench, X } from 'lucide-react';
import { searchRecords, type Api, type RecordHit } from '@/lib/voice-agent-client';
import { DEMO_RECORDS } from '@/lib/voice-agent-demo';
import { startDemoCall, startLiveCall, type CallHandle, type CallStatus } from '@/lib/voice-agent-session';
import { formatDuration, levelPercent, orderVariables, pushLine, type TestLine, type TestSession } from '@/lib/voice-agent';
import { Banner, Empty, GREEN, INK, LINE, MUTED, Segmented, Spinner, card, eyebrow, ghost, h2, input, mono, primary, sub } from './kit';

type Phase = 'idle' | 'starting' | 'connecting' | 'live' | 'ended';
type Kind = 'seller' | 'buyer';
type Target = { kind: 'sample' } | ({ kind: Kind } & Pick<RecordHit, 'id' | 'name' | 'sub'>);
const SAMPLE: Record<Kind | 'me', [string, string]> = {
  me: ['You, as a test seller', 'Mock seller data under your name. Talk here or have the agent ring a phone.'],
  seller: ['Sample seller', 'A made-up seller with a full brief'],
  buyer: ['Sample cash buyer', 'A made-up cash buyer with a buy box and a deal we sent'],
};
type ToolNote = { key: number; name: string; phase: 'start' | 'done' | 'error'; after: number };

const TOOL_TEXT: Record<string, [string, string]> = {
  lead_context: ['Looking up the lead brief…', 'Looked up the lead brief'],
};
const toolText = (n: ToolNote) => {
  const [running, done] = TOOL_TEXT[n.name] ?? [`Running ${n.name}…`, `Ran ${n.name}`];
  return n.phase === 'start' ? running : n.phase === 'error' ? `${n.name} failed` : done;
};

export type CallEnd = { conversationId: string | null; lines: number };

/**
 * `callerAs` is who the tester plays (the Test tab's seller or buyer switch): the
 * sample follows it, and picking a caller here reports its kind back through `onCallerAs`.
 */
export function TestCall({ api, workspaceId, admin, agentKey, ready, agentName, onEnded, onStarted, callerAs = 'seller', onCallerAs }: {
  api: Api; workspaceId: number | null; admin: boolean; agentKey: string; ready: boolean; agentName: string; onEnded?: (e: CallEnd) => void; onStarted?: () => void;
  callerAs?: Kind; onCallerAs?: (k: Kind) => void;
}) {
  const demo = api.demo;
  const [target, setTarget] = useState<Target>({ kind: 'sample' });
  // The sample's kind is the parent's when it tracks one, else this panel's own.
  const [ownAs, setOwnAs] = useState<Kind>(callerAs);
  const [me, setMe] = useState(false);
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const sampleAs: Kind = onCallerAs ? callerAs : ownAs;
  const ringPhone = me && target.kind === 'sample' && phone.trim() !== '';
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<RecordHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<TestSession | null>(null);
  const [lines, setLines] = useState<TestLine[]>([]);
  const [tools, setTools] = useState<ToolNote[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mic, setMic] = useState(0);
  const [out, setOut] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [knowsOpen, setKnowsOpen] = useState(false);
  const handle = useRef<CallHandle | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const toolSeq = useRef(0);
  const spoken = useRef(0);
  const livePanel = useRef<HTMLElement | null>(null);
  const live = workspaceId != null && !demo;
  const convId = useRef<string | null>(null);

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

  // Meter and clock while a call is up.
  useEffect(() => {
    if (phase !== 'live') return;
    const t0 = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - t0) / 1000));
      setMic(handle.current?.micLevel() ?? 0);
      convId.current = handle.current?.conversationId() ?? convId.current;
      setOut(handle.current?.agentLevel() ?? 0);
    }, 90);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }, [lines.length, tools.length]);
  useEffect(() => () => { void handle.current?.end().catch(() => undefined); }, []);

  const end = useCallback(async () => {
    const h = handle.current;
    handle.current = null;
    try { await h?.end(); } catch { /* already closed */ }
    setPhase((p) => (p === 'idle' ? p : 'ended'));
    setSpeaking(false); setMic(0); setOut(0);
  }, []);

  useEffect(() => {
    if (phase === 'ended') onEnded?.({ conversationId: convId.current, lines: spoken.current });
    // Only the phase changing to ended is an event; the callback identity is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const start = useCallback(async () => {
    setError(null); setNote(null); setLines([]); setTools([]); spoken.current = 0; setElapsed(0); setMuted(false); setSpeaking(false);
    setPhase('starting');
    const tt = target.kind === 'sample' ? { sample: me ? 'me' as const : sampleAs } : { kind: target.kind, id: target.id };
    if (ringPhone) {
      const p = await api.phoneTest(agentKey, tt, phone.trim());
      setPhase('idle');
      if (!p.ok) return setError(p.error);
      setSession(p.data);
      return setNote(p.data.note);
    }
    const r = await api.startTestSession(agentKey, tt);
    if (!r.ok) { setPhase('idle'); return setError(r.error); }
    const s: TestSession = r.data;
    convId.current = null;
    onStarted?.();
    setSession(s);
    setPhase('connecting');
    // Stacked on a phone, the transcript sits below the controls: bring it into view.
    if (window.innerWidth < 760) livePanel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const ev = {
      onStatus: (st: CallStatus) => {
        if (st === 'connected') setPhase('live');
        if (st === 'ended') { handle.current = null; setPhase((p) => (p === 'idle' ? p : 'ended')); setSpeaking(false); setMic(0); setOut(0); }
      },
      onSpeaking: setSpeaking,
      onLine: (role: TestLine['role'], text: string) => { if (text.trim()) spoken.current += 1; setLines((l) => pushLine(l, role, text)); },
      onTool: (name: string, ph: ToolNote['phase']) => setTools((t) => {
        if (ph === 'start') return [...t, { key: ++toolSeq.current, name, phase: 'start', after: spoken.current }];
        const i = t.map((x) => x.name === name && x.phase === 'start').lastIndexOf(true);
        return i < 0 ? [...t, { key: ++toolSeq.current, name, phase: ph, after: spoken.current }] : t.map((x, j) => (j === i ? { ...x, phase: ph } : x));
      }),
      onError: (m: string) => setError(m),
    };
    try {
      handle.current = live ? await startLiveCall(s, ev) : startDemoCall(s, ev);
    } catch (e) {
      handle.current = null;
      setPhase('idle');
      setError(e instanceof Error ? e.message : 'The call could not start.');
    }
  }, [agentKey, api, live, me, onStarted, phone, ringPhone, sampleAs, target]);

  const busy = phase === 'starting' || phase === 'connecting';
  const inCall = busy || phase === 'live';
  const canStart = admin && (demo || ready) && !inCall;
  const showResults = q.trim().length >= 2;
  const pickSample = (k: Kind | 'me') => {
    const as = k === 'me' ? 'seller' : k;
    setTarget({ kind: 'sample' }); setQ(''); setHits(null); setMe(k === 'me'); setNote(null); setOwnAs(as); onCallerAs?.(as);
  };
  const pick = (t: Exclude<Target, { kind: 'sample' }>) => { setTarget(t); setQ(''); setHits(null); setMe(false); onCallerAs?.(t.kind); };
  const sampleKey = me ? 'me' : sampleAs;
  const who = target.kind === 'sample' ? SAMPLE[sampleKey][0] : target.name;
  const toolsAfter = (n: number) => tools.filter((t) => t.after === n).map((t) => (
    <div key={t.key} className="va-in" role="status" style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 7, height: 26, padding: '0 11px', borderRadius: 999, fontSize: 12, fontWeight: 500,
      background: t.phase === 'error' ? '#fef2f2' : '#fffbeb', color: t.phase === 'error' ? '#b91c1c' : '#92400e', border: `1px solid ${t.phase === 'error' ? '#fecaca' : '#fde68a'}` }}>
      {t.phase === 'start' ? <Spinner size={12} /> : <Wrench size={12} aria-hidden="true" />}
      {toolText(t)}
    </div>
  ));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: '0 12px', alignItems: 'start' }}>
      <div style={{ minWidth: 0 }}>
        <section style={card} aria-labelledby="va-test">
          <h2 id="va-test" style={h2}>Test the agent</h2>
          <p style={{ ...sub, marginBottom: 14 }}>Talk to it from this browser. It is given the same brief a real caller&apos;s record would give it.</p>

          {demo ? <div style={{ marginBottom: 12 }}><Banner tone="info"><strong style={{ color: INK }}>Demo.</strong> This plays a scripted conversation. No microphone, no ElevenLabs, no model.</Banner></div> : null}
          {!admin ? <div style={{ marginBottom: 12 }}><Banner tone="info">Only owners and admins can start a test call.</Banner></div> : null}
          {!demo && admin && !ready ? <div style={{ marginBottom: 12 }}><Banner tone="warn">Publish the agent first. The test call talks to the published agent, so there is nothing to call yet.</Banner></div> : null}
          <div style={{ marginBottom: 12 }}>
            <Banner tone="info">A browser test has no caller ID, so the agent&apos;s <span style={mono}>lead_context</span> tool cannot look anything up here. It works from the brief below, which is what a real call starts with.</Banner>
          </div>

          <span style={eyebrow}>Who is calling</span>
          <div style={{ marginBottom: 8 }}>
            <Segmented<Kind | 'me'> label="Caller type" disabled={inCall} value={target.kind === 'sample' ? sampleKey : target.kind}
              onChange={pickSample}
              options={[{ id: 'seller', label: 'Seller', hint: 'A homeowner the agent is buying from.' }, { id: 'buyer', label: 'Cash buyer', hint: 'An investor the agent is selling deals to.' },
                { id: 'me', label: 'Me (test)', hint: 'You, the CRM owner, with mock seller data. Optionally rings your phone.' }]} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 8px 12px', borderRadius: 10, border: `1px solid ${LINE}`, background: '#fafafa' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who}</span>
              <span style={{ display: 'block', fontSize: 12, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {target.kind === 'sample' ? SAMPLE[sampleKey][1] : target.sub}
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
              <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED }}>Leave empty to talk from this browser. With a number, the published agent calls it from its line. Nothing is saved to the CRM.</p>
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
                <div role="listbox" aria-label="Matching records" style={{ marginTop: 6, border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', background: '#fff', maxHeight: 240, overflowY: 'auto' }}>
                  {searching && !hits ? (
                    <div style={{ padding: 12, fontSize: 12.5, color: MUTED, display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> Searching</div>
                  ) : hits && hits.length ? hits.map((h) => (
                    <button key={h.kind + h.id} type="button" role="option" aria-selected={false} className="va-row va-btn" onClick={() => pick({ kind: h.kind, id: h.id, name: h.name, sub: h.sub })}
                      style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '9px 12px', border: 0, borderBottom: '1px solid #f0f0f1', background: 'transparent', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' }}>
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
              <button type="button" className="va-btn" onClick={() => void end()} style={{ ...ghost, height: 40, flex: 1, background: '#dc2626', border: '1px solid #dc2626', color: '#fff', fontSize: 13.5 }}>
                <PhoneOff size={16} aria-hidden="true" /> End call
              </button>
            ) : (
              <button type="button" className="va-btn va-prim" disabled={!canStart} onClick={() => void start()} style={{ ...primary(!canStart), height: 40, flex: 1, fontSize: 13.5 }}>
                <Phone size={16} aria-hidden="true" /> {ringPhone ? 'Call this phone' : phase === 'ended' ? 'Start another test call' : 'Start test call'}
              </button>
            )}
            {phase === 'live' ? (
              <button type="button" className="va-btn va-ghost" aria-pressed={muted} onClick={() => { const m = !muted; setMuted(m); handle.current?.setMuted(m); }} style={{ ...ghost, height: 40, minWidth: 92 }}>
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
                    <div key={v.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 150px) minmax(0, 1fr)', gap: 10, padding: '6px 0', borderTop: '1px solid #f0f0f1', fontSize: 12.5 }}>
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
          <div style={{ display: 'grid', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${LINE}`, background: '#fafafa' }}>
            <Meter label="You" pct={muted ? 0 : levelPercent(mic)} off={muted} />
            <Meter label="Agent" pct={levelPercent(out)} />
          </div>
        ) : null}
        <div ref={scroller} role="log" aria-live="polite" aria-label="Transcript" style={{ height: 360, maxHeight: '55vh', overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, background: '#fff' }}>
          {lines.length === 0 && phase !== 'live' && phase !== 'connecting' ? (
            <Empty title={phase === 'ended' ? 'The call ended before anyone spoke' : 'The transcript shows here'}>
              {phase === 'ended' ? 'Start another test call to try again.' : 'Start a test call and both sides appear as they speak.'}
            </Empty>
          ) : null}
          {lines.length === 0 && (phase === 'live' || phase === 'connecting') ? (
            <div style={{ margin: 'auto', display: 'flex', alignItems: 'center', gap: 8, color: MUTED, fontSize: 13 }}><Spinner /> {phase === 'connecting' ? 'Connecting…' : 'Listening. Say hello.'}</div>
          ) : null}
          {toolsAfter(0)}
          {lines.map((l, i) => (
            <React.Fragment key={l.id}>
              <div className="va-in" style={{ alignSelf: l.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '86%' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: MUTED, margin: '0 4px 3px', textAlign: l.role === 'user' ? 'right' : 'left' }}>
                  {l.role === 'user' ? 'You' : agentName || 'Agent'}
                </div>
                <div style={{ padding: '9px 12px', borderRadius: l.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px', fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere',
                  background: l.role === 'user' ? GREEN : '#f4f4f5', color: l.role === 'user' ? '#fff' : INK }}>
                  {l.text}
                </div>
              </div>
              {toolsAfter(i + 1)}
            </React.Fragment>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatusPill({ phase, speaking, muted }: { phase: Phase; speaking: boolean; muted: boolean }) {
  const s = phase === 'live'
    ? (speaking ? { t: 'Agent is speaking', c: GREEN, bg: '#E7F8F1', dot: true } : muted ? { t: 'Muted', c: '#92400e', bg: '#fef3c7', dot: false } : { t: 'Listening', c: GREEN, bg: '#E7F8F1', dot: true })
    : phase === 'connecting' ? { t: 'Connecting', c: '#92400e', bg: '#fef3c7', dot: false }
    : phase === 'starting' ? { t: 'Getting the session ready', c: '#92400e', bg: '#fef3c7', dot: false }
    : phase === 'ended' ? { t: 'Call ended', c: '#52525b', bg: '#f4f4f5', dot: false }
    : { t: 'Not on a call', c: '#52525b', bg: '#f4f4f5', dot: false };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 26, padding: '0 11px', borderRadius: 999, background: s.bg, color: s.c, fontSize: 12.5, fontWeight: 600 }}>
      {phase === 'connecting' || phase === 'starting' ? <Spinner size={12} /> : <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: s.c, opacity: s.dot ? 1 : 0.55 }} />}
      {s.t}
    </span>
  );
}

function Meter({ label, pct, off }: { label: string; pct: number; off?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '44px minmax(0, 1fr)', alignItems: 'center', gap: 10, fontSize: 12, color: MUTED }}>
      <span>{off ? 'Muted' : label}</span>
      <div role="meter" aria-label={`${label} level`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={{ height: 8, borderRadius: 999, background: '#e4e4e7', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: pct > 85 ? '#f59e0b' : GREEN, transition: 'width .09s linear' }} />
      </div>
    </div>
  );
}
