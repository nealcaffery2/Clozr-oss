// The pieces of a test call both TestCall and TalkDock draw: the status pill,
// the level meters and the transcript with its tool notes.
'use client';

import React from 'react';
import { Wrench } from 'lucide-react';
import type { TestLine } from '@/lib/voice-agent';
import { Empty, GREEN, INK, MUTED, Spinner } from './kit';
import { toolText, type Phase, type ToolNote } from './useCallSession';

export function StatusPill({ phase, speaking, muted }: { phase: Phase; speaking: boolean; muted: boolean }) {
  const s = phase === 'live'
    ? (speaking ? { t: 'Agent is speaking', c: GREEN, bg: 'var(--mint-dim, #e7f8f1)', dot: true } : muted ? { t: 'Muted', c: '#92400e', bg: 'var(--caution-soft, #fef3c7)', dot: false } : { t: 'Listening', c: GREEN, bg: 'var(--mint-dim, #e7f8f1)', dot: true })
    : phase === 'connecting' ? { t: 'Connecting', c: '#92400e', bg: 'var(--caution-soft, #fef3c7)', dot: false }
    : phase === 'starting' ? { t: 'Getting the session ready', c: '#92400e', bg: 'var(--caution-soft, #fef3c7)', dot: false }
    : phase === 'ended' ? { t: 'Call ended', c: 'var(--muted, #52525b)', bg: 'var(--surface-2, #f4f4f5)', dot: false }
    : { t: 'Not on a call', c: 'var(--muted, #52525b)', bg: 'var(--surface-2, #f4f4f5)', dot: false };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 26, padding: '0 11px', borderRadius: 999, background: s.bg, color: s.c, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {phase === 'connecting' || phase === 'starting' ? <Spinner size={12} /> : <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: s.c, opacity: s.dot ? 1 : 0.55 }} />}
      {s.t}
    </span>
  );
}

export function Meter({ label, pct, off }: { label: string; pct: number; off?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '44px minmax(0, 1fr)', alignItems: 'center', gap: 10, fontSize: 12, color: MUTED }}>
      <span>{off ? 'Muted' : label}</span>
      <div role="meter" aria-label={`${label} level`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={{ height: 8, borderRadius: 999, background: 'var(--divider, #e4e4e7)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: pct > 85 ? '#f59e0b' : GREEN, transition: 'width .09s linear' }} />
      </div>
    </div>
  );
}

/** The scrolling transcript: both sides as they speak, tool notes where they ran, and the idle and connecting states. */
export function Transcript({ scroller, phase, lines, tools, agentName, idleHint, style }: {
  scroller: React.RefObject<HTMLDivElement | null>; phase: Phase; lines: TestLine[]; tools: ToolNote[]; agentName: string; idleHint: string; style?: React.CSSProperties;
}) {
  const toolsAfter = (n: number) => tools.filter((t) => t.after === n).map((t) => (
    <div key={t.key} className="va-in" role="status" style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 26, padding: '0 11px', borderRadius: 999, fontSize: 12, fontWeight: 500,
      background: t.phase === 'error' ? 'var(--tint-red, #fef2f2)' : 'var(--tint-amber, #fffbeb)', color: t.phase === 'error' ? '#b91c1c' : '#92400e', border: `1px solid ${t.phase === 'error' ? 'var(--tint-red-2, #fecaca)' : 'var(--tint-amber-2, #fde68a)'}` }}>
      {t.phase === 'start' ? <Spinner size={12} /> : <Wrench size={12} aria-hidden="true" />}
      {toolText(t)}
    </div>
  ));
  return (
    <div ref={scroller} role="log" aria-live="polite" aria-label="Transcript" style={{ overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--surface, #fff)', ...style }}>
      {lines.length === 0 && phase !== 'live' && phase !== 'connecting' ? (
        <Empty title={phase === 'ended' ? 'The call ended before anyone spoke' : 'The transcript shows here'}>
          {phase === 'ended' ? 'Start another call to try again.' : idleHint}
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
              background: l.role === 'user' ? GREEN : 'var(--surface-2, #f4f4f5)', color: l.role === 'user' ? 'var(--surface, #fff)' : INK }}>
              {l.text}
            </div>
          </div>
          {toolsAfter(i + 1)}
        </React.Fragment>
      ))}
    </div>
  );
}
