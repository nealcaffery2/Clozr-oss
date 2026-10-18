// Sends, failures, no-sends, and the replies on one action plan.
'use client';

import React from 'react';
import { channelWord, type PlanAttempt, type PlanProgress, type PlanReply, type ResultsKind } from '@/lib/plan-progress';
import { ago, Btn, INK, LINE, MINT, MINT_BG, MUTED, Section } from './ui';

const COUNTS: { kind: ResultsKind; label: string; plural?: string; color: string; pick: (p: PlanProgress) => number }[] = [
  { kind: 'sent', label: 'Sent', color: INK, pick: (p) => p.sent },
  { kind: 'failed', label: 'Failed', color: 'var(--tx-red, #b91c1c)', pick: (p) => p.failed },
  { kind: 'not_sent', label: 'Not sent', color: 'var(--tx-amber, #b45309)', pick: (p) => p.notSent },
  { kind: 'waiting', label: 'Waiting', color: MUTED, pick: (p) => p.waiting },
  { kind: 'replies', label: 'Reply', plural: 'Replies', color: MINT, pick: (p) => p.replies },
];

const EMPTY: Record<ResultsKind, string> = {
  sent: 'Nothing has gone out yet.',
  failed: 'No failed sends.',
  not_sent: 'No skipped sends. Anything still queued is under Waiting.',
  waiting: 'Nothing is waiting to send.',
  replies: 'No replies yet. A text, email, or call back from someone on this plan shows up here.',
};

function CountButton({ label, plural, n, color, pressed, onClick }: { label: string; plural?: string; n: number; color: string; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        height: '24px', padding: '0 8px', borderRadius: '6px', border: `1px solid ${pressed ? MINT : LINE}`,
        background: pressed ? MINT_BG : 'var(--surface, #fff)', color, fontSize: '11.5px', fontWeight: 600, fontFamily: 'inherit',
        cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
      }}
    >
      {n} {n === 1 ? label : (plural ?? label)}
    </button>
  );
}

export function SendMeter({ progress, kind, onKind }: { progress: PlanProgress; kind: ResultsKind | null; onKind: (kind: ResultsKind) => void }) {
  const pct = progress.enrolled ? Math.round((progress.reached / progress.enrolled) * 100) : 0;
  return (
    <span style={{ display: 'block', marginTop: '8px' }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11.5px', color: MUTED, fontVariantNumeric: 'tabular-nums' }}>
        <span>{progress.reached} of {progress.enrolled} reached</span>
        <span>{pct}%</span>
      </span>
      <span
        role="meter"
        aria-valuenow={progress.reached}
        aria-valuemin={0}
        aria-valuemax={progress.enrolled}
        aria-label={`${progress.reached} of ${progress.enrolled} people reached`}
        style={{ display: 'block', height: '6px', borderRadius: '3px', background: 'var(--divider-2, #f0f0f1)', marginTop: '4px', overflow: 'hidden' }}
      >
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: MINT }} />
      </span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
        {COUNTS.map((c) => (
          <CountButton key={c.kind} label={c.label} plural={c.plural} n={c.pick(progress)} color={c.color} pressed={kind === c.kind} onClick={() => onKind(c.kind)} />
        ))}
      </span>
    </span>
  );
}

export function PlanResults({
  progress, state, error, kind, onKind, onRetry, onOpenBuyer, onOpenPerson,
}: {
  progress: PlanProgress | null;
  state: 'loading' | 'ready' | 'error';
  error: string | null;
  kind: ResultsKind | null;
  onKind: (kind: ResultsKind) => void;
  onRetry: () => void;
  onOpenBuyer?: (buyerId: number) => void;
  onOpenPerson?: (sellerId: number) => void;
}) {
  const rows = (() => {
    if (!progress || !kind) return [];
    if (kind === 'replies') {
      return progress.people.flatMap((p) => p.replies.map((r) => ({ who: p, reply: r as PlanReply | null, attempt: null as PlanAttempt | null })));
    }
    return progress.people.flatMap((p) => p.attempts.filter((a) => a.outcome === kind).map((a) => ({ who: p, reply: null as PlanReply | null, attempt: a })));
  })().sort((a, b) => {
    const at = (a.reply?.at ?? a.attempt?.at ?? '');
    const bt = (b.reply?.at ?? b.attempt?.at ?? '');
    return bt.localeCompare(at);
  });

  return (
    <Section title="Sends" style={{ marginBottom: '12px' }} aside={state === 'ready' ? <Btn small onClick={onRetry}>Refresh</Btn> : null}>
      {state === 'loading' && !progress ? <div style={{ fontSize: '12.5px', color: MUTED }}>Loading sends…</div> : null}
      {error ? (
        <div style={{ fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)', marginBottom: progress ? '8px' : 0 }}>
          Sends did not load. {error} <Btn small onClick={onRetry} style={{ marginLeft: '6px' }}>Retry</Btn>
        </div>
      ) : null}
      {progress && progress.enrolled === 0 ? (
        <div style={{ fontSize: '12.5px', color: MUTED, lineHeight: 1.5 }}>Nobody is on this plan yet. Enrol someone and the sends, failures, and replies show up here.</div>
      ) : null}
      {progress && progress.enrolled > 0 ? <SendMeter progress={progress} kind={kind} onKind={onKind} /> : null}
      {progress && kind ? (
        <div data-testid="plan-results-list" style={{ marginTop: '12px', borderTop: `1px solid ${LINE}` }}>
          {!rows.length ? <div style={{ padding: '12px 0 2px', fontSize: '12.5px', color: MUTED, lineHeight: 1.5 }}>{EMPTY[kind]}</div> : null}
          {rows.slice(0, 200).map((row) => {
            const attempt = row.attempt;
            const snippet = row.reply?.snippet ?? attempt?.reason ?? '';
            const when = row.reply ? ago(row.reply.at) : attempt?.at ? ago(attempt.at) : '';
            const word = channelWord(row.reply?.channel ?? attempt?.channel ?? '');
            const step = attempt && attempt.title && attempt.title !== word ? attempt.title : '';
            const meta = [word, step, when].filter(Boolean).join(' · ');
            const open = () => {
              if (row.who.buyerId != null) onOpenBuyer?.(row.who.buyerId);
              else if (row.who.sellerId != null) onOpenPerson?.(row.who.sellerId);
            };
            const canOpen = row.who.buyerId != null ? !!onOpenBuyer : row.who.sellerId != null && !!onOpenPerson;
            return (
              <button
                key={row.reply?.key ?? row.attempt?.key}
                type="button"
                onClick={open}
                disabled={!canOpen}
                title={canOpen ? `Open ${row.who.name}` : undefined}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 0', border: 0, borderBottom: `1px solid var(--divider-2, #f0f0f1)`,
                  background: 'none', cursor: canOpen ? 'pointer' : 'default', fontFamily: 'inherit', minHeight: '44px',
                }}
              >
                <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: INK }}>{row.who.name}</span>
                <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '2px' }}>{meta}</span>
                {snippet ? <span style={{ display: 'block', fontSize: '12.5px', color: INK, marginTop: '3px', lineHeight: 1.45 }}>{snippet}</span> : null}
              </button>
            );
          })}
          {rows.length > 200 ? <div style={{ padding: '8px 0', fontSize: '11.5px', color: MUTED }}>Showing the latest 200.</div> : null}
        </div>
      ) : null}
    </Section>
  );
}
