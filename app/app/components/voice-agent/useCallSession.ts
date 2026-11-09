// One browser test call's state: the phase, the transcript, tool notes, the
// meters and the clock. TestCall (the Test tab) and TalkDock (the panel that
// stays open while you edit) both drive a call through this, so a call behaves
// the same wherever it was started.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, primeAudio, startDemoCall, startLiveCall, type CallHandle, type CallStatus } from '@/lib/voice-agent-session';
import { pushLine, type Result, type TestLine, type TestSession } from '@/lib/voice-agent';

export type Phase = 'idle' | 'starting' | 'connecting' | 'live' | 'ended';
export type ToolNote = { key: number; name: string; phase: 'start' | 'done' | 'error'; after: number };
export type CallEnd = { conversationId: string | null; lines: number };

export function useCallSession({ live, onStarted, onEnded }: {
  /** A real ElevenLabs session; false plays the scripted /demo call. */
  live: boolean; onStarted?: () => void; onEnded?: (e: CallEnd) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<TestSession | null>(null);
  const [lines, setLines] = useState<TestLine[]>([]);
  const [tools, setTools] = useState<ToolNote[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [mic, setMic] = useState(0);
  const [out, setOut] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const handle = useRef<CallHandle | null>(null);
  const toolSeq = useRef(0);
  const spoken = useRef(0);
  const convId = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (phase === 'ended') onEnded?.({ conversationId: convId.current, lines: spoken.current });
    // Only the phase changing to ended is an event; the callback identity is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const end = useCallback(async () => {
    const h = handle.current;
    handle.current = null;
    try { await h?.end(); } catch { /* already closed */ }
    setPhase((p) => (p === 'idle' ? p : 'ended'));
    setSpeaking(false); setMic(0); setOut(0);
  }, []);

  /** Clear the last call and show the session is being fetched. */
  const reset = useCallback(() => {
    setError(null); setLines([]); setTools([]); spoken.current = 0; setElapsed(0); setMutedState(false); setSpeaking(false);
    setPhase('starting');
  }, []);

  /**
   * Fetch a session with `open` and connect to it. Resolves once the call is connecting, or failed.
   * Call it straight from the tap: the mic and audio are opened before the first await, while the
   * tap still counts as a user gesture (Safari refuses them after).
   */
  const run = useCallback(async (open: () => Promise<Result<TestSession>>) => {
    const prime = live ? primeAudio() : null;
    reset();
    const r = await open();
    if (!r.ok) { prime?.release(); setPhase('idle'); setError(r.error); return false; }
    const s = r.data;
    convId.current = null;
    onStarted?.();
    setSession(s);
    setPhase('connecting');
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
      handle.current = prime ? await startLiveCall(s, ev, prime) : startDemoCall(s, ev);
      return true;
    } catch (e) {
      prime?.release();
      handle.current = null;
      setPhase('idle');
      setError(describeError(e, 'The call could not start.'));
      return false;
    }
    // onStarted is read when the call starts; a new identity must not restart anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, reset]);

  const toggleMute = useCallback(() => {
    setMutedState((m) => { handle.current?.setMuted(!m); return !m; });
  }, []);

  const busy = phase === 'starting' || phase === 'connecting';
  return {
    phase, setPhase, error, setError, session, setSession, lines, tools, speaking, muted, mic, out, elapsed, scroller,
    busy, inCall: busy || phase === 'live', spokenLines: () => spoken.current,
    run, end, toggleMute,
  };
}

const TOOL_TEXT: Record<string, [string, string]> = {
  lead_context: ['Looking up the lead brief…', 'Looked up the lead brief'],
};
export const toolText = (n: ToolNote) => {
  const [running, done] = TOOL_TEXT[n.name] ?? [`Running ${n.name}…`, `Ran ${n.name}`];
  return n.phase === 'start' ? running : n.phase === 'error' ? `${n.name} failed` : done;
};
