'use client';

// Roleplay: the rep picks a seller persona, a difficulty and optionally an
// objection drill, then either calls the workspace's roleplay phone line (the
// AI seller picks up as that persona; scored from the post-call webhook), or
// talks to it by voice in the browser (ElevenLabs, the AI Agent's
// infrastructure), or by text (Claude) when voice is not configured. Finishing grades the session with the same scorecard and
// call flow as a real call (lib/roleplay.ts) and stores it (migration 149).

import React, { useEffect, useRef, useState } from 'react';
import { Mic, MessageSquare, Phone, PhoneOff, Send } from 'lucide-react';
import { DIFFICULTIES, OBJECTIONS, PERSONAS, type RoleplayFeedback, type RoleplayLine } from '@/lib/roleplay';
import { salesManagerApi } from '@/lib/sales-manager-client';
import { startLiveCall, type CallHandle } from '@/lib/voice-agent-session';
import { fmtClock } from '@/lib/call-media';
import { FeedbackView, GREEN, INK, LINE, MUTED, RED, btn, card, eyebrow, primary } from './parts';

type Phase = 'pick' | 'starting' | 'live' | 'grading' | 'done' | 'armed';

export function Roleplay({ workspaceId, isMobile, onScored, onArmed }: { workspaceId: number | null; isMobile: boolean; onScored?: () => void; onArmed?: () => void }) {
  const [persona, setPersona] = useState(PERSONAS[0]!.id);
  const [difficulty, setDifficulty] = useState<string>('medium');
  const [objection, setObjection] = useState<string>('');
  const [mode, setMode] = useState<'phone' | 'voice' | 'text'>('phone');
  const [armed, setArmed] = useState<{ phone: string; until: string; seller: string } | null>(null);
  const [phase, setPhase] = useState<Phase>('pick');
  const [session, setSession] = useState<{ id: number; mode: 'voice' | 'text'; seller: string } | null>(null);
  const [lines, setLines] = useState<RoleplayLine[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<RoleplayFeedback | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const call = useRef<CallHandle | null>(null);
  const linesRef = useRef<RoleplayLine[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const api = workspaceId ? salesManagerApi(workspaceId) : null;

  useEffect(() => {
    if (phase !== 'live' || startedAt == null) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase, startedAt]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [lines]);
  useEffect(() => () => { void call.current?.end(); }, []);

  const push = (l: RoleplayLine) => {
    linesRef.current = [...linesRef.current, l];
    setLines(linesRef.current);
  };

  const start = async () => {
    if (!api) return;
    setError(null); setNote(null); setFeedback(null); setPhase('starting');
    linesRef.current = []; setLines([]);
    if (mode === 'phone') {
      const a = await api.arm({ persona, difficulty, objection: objection || null });
      if (!a.ok) { setError(a.error); setPhase('pick'); return; }
      setArmed({ phone: a.phone, until: a.armed_until, seller: a.seller_name });
      setPhase('armed');
      return;
    }
    const r = await api.start({ persona, difficulty, objection: objection || null, mode });
    if (!r.ok) { setError(r.error); setPhase('pick'); return; }
    setSession({ id: r.session_id, mode: r.mode, seller: r.seller_name });
    if (r.voice_error) setNote(r.voice_error);
    const t0 = Date.now();
    setStartedAt(t0); setElapsed(0);
    if (r.mode === 'voice' && r.voice) {
      try {
        call.current = await startLiveCall(
          { signed_url: r.voice.signed_url, agent_id: r.voice.agent_id, agent_key: 'roleplay', live_version: 0, dynamic_variables: r.voice.dynamic_variables, first_message: r.voice.first_message, resolution: null },
          {
            onStatus: (s) => { if (s === 'ended') setSpeaking(false); },
            onSpeaking: setSpeaking,
            onLine: (role, text) => push({ role: role === 'user' ? 'rep' : 'seller', text, at_s: Math.round((Date.now() - t0) / 1000) }),
            onTool: () => {},
            onError: (m) => setError(m),
          },
        );
        setPhase('live');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The microphone could not start.');
        void api.abandon(r.session_id);
        setPhase('pick');
      }
      return;
    }
    push({ role: 'seller', text: r.opener, at_s: 0 });
    setPhase('live');
  };

  const send = async () => {
    if (!api || !session || !draft.trim() || busy) return;
    const text = draft.trim();
    setDraft(''); setBusy(true); setError(null);
    push({ role: 'rep', text, at_s: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null });
    const r = await api.say(session.id, text);
    setBusy(false);
    if (r.ok) push({ role: 'seller', text: r.reply, at_s: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null });
    else setError(r.error);
  };

  const finish = async () => {
    if (!api || !session) return;
    let conversationId: string | null = null;
    if (call.current) {
      conversationId = call.current.conversationId();
      await call.current.end().catch(() => {});
      call.current = null;
    }
    setPhase('grading'); setError(null);
    const r = await api.finish(session.id, { lines: linesRef.current, conversationId, durationS: startedAt ? Math.round((Date.now() - startedAt) / 1000) : undefined });
    if (r.ok) { setFeedback(r.feedback); setPhase('done'); onScored?.(); }
    else { setError(r.error); setPhase('done'); }
  };

  if (!api) {
    return <div style={{ ...card, color: MUTED, fontSize: 13 }}>Roleplay runs against a live workspace. Sign in to practise.</div>;
  }

  const p = PERSONAS.find((x) => x.id === persona)!;

  if (phase === 'pick' || phase === 'starting') {
    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <div style={{ ...eyebrow, marginBottom: 6 }}>Seller persona</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {PERSONAS.map((x) => (
              <button key={x.id} type="button" onClick={() => setPersona(x.id)} aria-pressed={persona === x.id}
                style={{ textAlign: 'left', ...card, padding: '10px 12px', cursor: 'pointer', border: `1px solid ${persona === x.id ? INK : LINE}`, boxShadow: persona === x.id ? `0 0 0 1px ${INK}` : 'none' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{x.label}</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2, lineHeight: 1.45 }}>{x.blurb}</div>
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <div style={{ ...eyebrow, marginBottom: 6 }}>Difficulty</div>
            <div role="radiogroup" style={{ display: 'flex', gap: 4 }}>
              {DIFFICULTIES.map((d) => (
                <button key={d.id} type="button" role="radio" aria-checked={difficulty === d.id} onClick={() => setDifficulty(d.id)}
                  style={{ ...btn, background: difficulty === d.id ? INK : 'var(--surface, #fff)', color: difficulty === d.id ? 'var(--surface, #fff)' : INK }}>{d.label}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ ...eyebrow, marginBottom: 6 }}>Objection drill</div>
            <select value={objection} onChange={(e) => setObjection(e.target.value)} style={{ height: 30, borderRadius: 8, border: `1px solid ${LINE}`, padding: '0 8px', fontSize: 12.5 }}>
              <option value="">None, a natural call</option>
              {OBJECTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <div style={{ ...eyebrow, marginBottom: 6 }}>How</div>
            <div role="radiogroup" style={{ display: 'flex', gap: 4 }}>
              <button type="button" role="radio" aria-checked={mode === 'phone'} onClick={() => setMode('phone')} style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6, background: mode === 'phone' ? INK : 'var(--surface, #fff)', color: mode === 'phone' ? 'var(--surface, #fff)' : INK }}><Phone size={13} />Phone line</button>
              <button type="button" role="radio" aria-checked={mode === 'voice'} onClick={() => setMode('voice')} style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6, background: mode === 'voice' ? INK : 'var(--surface, #fff)', color: mode === 'voice' ? 'var(--surface, #fff)' : INK }}><Mic size={13} />Voice</button>
              <button type="button" role="radio" aria-checked={mode === 'text'} onClick={() => setMode('text')} style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6, background: mode === 'text' ? INK : 'var(--surface, #fff)', color: mode === 'text' ? 'var(--surface, #fff)' : INK }}><MessageSquare size={13} />Text</button>
            </div>
          </div>
          <button type="button" onClick={start} disabled={phase === 'starting'} style={{ ...primary, height: 34, padding: '0 16px', background: GREEN }}>
            {phase === 'starting' ? (mode === 'phone' ? 'Arming…' : 'Calling…') : mode === 'phone' ? 'Arm the roleplay line' : `Call ${p.name}`}
          </button>
        </div>
        {error ? <div style={{ fontSize: 12.5, color: RED }}>{error}</div> : null}
        <p style={{ margin: 0, fontSize: 12, color: MUTED }}>Phone line: arm it here, then call the roleplay number from the cell on your profile; the seller picks up as this persona and your scorecard lands in Practice after you hang up. Browser voice and text work anywhere. You are the rep calling about the property. Run your normal call: intro, price, motivation, through to the close. Hit Finish for your scorecard.</p>
      </div>
    );
  }

  if (phase === 'armed' && armed) {
    return (
      <div style={{ ...card, display: 'grid', gap: 10 }}>
        <div style={eyebrow}>Roleplay line armed</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>Call <a href={`tel:${armed.phone.replace(/[^+\d]/g, '')}`} style={{ color: GREEN }}>{armed.phone}</a> from your cell</div>
        <div style={{ fontSize: 13, color: 'var(--ink-2, #27272a)', lineHeight: 1.5 }}>
          {armed.seller} ({p.label}, {DIFFICULTIES.find((d) => d.id === difficulty)?.label.toLowerCase()}{objection ? `, ${OBJECTIONS.find((o) => o.id === objection)?.label.toLowerCase()}` : ''}) picks up. Armed until {new Date(armed.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
          Your scorecard lands in Practice about a minute after you hang up.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={primary} onClick={() => onArmed?.()}>Go to Practice</button>
          <button type="button" style={btn} onClick={() => { setPhase('pick'); setArmed(null); }}>Pick another scenario</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{session?.seller ?? p.name} · {p.label}</div>
          <div style={{ fontSize: 12, color: MUTED }}>
            {DIFFICULTIES.find((d) => d.id === difficulty)?.label}{objection ? ` · ${OBJECTIONS.find((o) => o.id === objection)?.label}` : ''} · {session?.mode === 'voice' ? 'Voice' : 'Text'}
            {phase === 'live' ? ` · ${fmtClock(elapsed)}` : ''}
            {phase === 'live' && session?.mode === 'voice' ? (speaking ? ' · seller talking' : ' · listening') : ''}
          </div>
        </div>
        {phase === 'live' ? <button type="button" onClick={finish} style={{ ...primary, display: 'inline-flex', alignItems: 'center', gap: 6, background: RED }}><PhoneOff size={13} />Finish and score</button> : null}
        {phase === 'done' ? <button type="button" onClick={() => { setPhase('pick'); setSession(null); }} style={primary}>New roleplay</button> : null}
      </div>
      {note ? <div style={{ fontSize: 12.5, color: MUTED }}>{note}</div> : null}
      <div ref={scroller} style={{ ...card, maxHeight: phase === 'done' ? 220 : 380, overflow: 'auto', display: 'grid', gap: 8, padding: 12 }}>
        {lines.length === 0 ? <div style={{ fontSize: 12.5, color: MUTED }}>{session?.mode === 'voice' ? 'Connecting… say hello when you hear them.' : ''}</div> : null}
        {lines.map((l, i) => (
          <div key={i} style={{ justifySelf: l.role === 'rep' ? 'end' : 'start', maxWidth: '82%', background: l.role === 'rep' ? INK : 'var(--surface-2, #f4f4f5)', color: l.role === 'rep' ? 'var(--surface, #fff)' : INK, borderRadius: 12, padding: '7px 11px', fontSize: 13, lineHeight: 1.45 }}>
            {l.text}
          </div>
        ))}
        {busy ? <div style={{ fontSize: 12, color: MUTED }}>{session?.seller ?? 'Seller'} is typing…</div> : null}
      </div>
      {phase === 'live' && session?.mode === 'text' ? (
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ display: 'flex', gap: 8 }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What do you say?" autoFocus
            style={{ flex: 1, minWidth: 0, height: 36, borderRadius: 9, border: `1px solid ${LINE}`, padding: '0 12px', fontSize: 13.5 }} />
          <button type="submit" disabled={busy || !draft.trim()} style={{ ...primary, height: 36, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Send size={13} />Send</button>
        </form>
      ) : null}
      {phase === 'grading' ? <div style={{ ...card, fontSize: 13, color: MUTED }}>Scoring your call against the framework…</div> : null}
      {error ? <div style={{ fontSize: 12.5, color: RED }}>{error}</div> : null}
      {phase === 'done' && feedback ? <div style={card}><FeedbackView f={feedback} /></div> : null}
    </div>
  );
}
