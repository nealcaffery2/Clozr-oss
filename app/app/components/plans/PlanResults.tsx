// Sends, failures, no-sends, and the replies on one action plan.
'use client';

import React from 'react';
import { channelWord, type PlanAttempt, type PlanProgress, type PlanReply, type ReportRow, type ResultsKind } from '@/lib/plan-progress';
import { ago, Btn, FAINT, INK, LINE, MINT, MINT_BG, MUTED, Section } from './ui';
import { explainWait, groupWaits, LIMITS } from '@/lib/throttle-explain';

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
  report: 'Nothing has gone out yet, so there is nothing to measure.',
};

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '');

/** Sends, delivered, failed, bounced, opened, replies and opt-outs, one row each, with the rate under the count. */
function ReportTable({ title, rows, total }: { title: string; rows: ReportRow[]; total?: ReportRow }) {
  const cols: { key: keyof ReportRow; label: string; rate?: (r: ReportRow) => string; hide?: (r: ReportRow) => boolean }[] = [
    { key: 'sent', label: 'Sent' },
    { key: 'delivered', label: 'Delivered', rate: (r) => pct(r.delivered, r.sent) },
    { key: 'failed', label: 'Failed', rate: (r) => pct(r.failed, r.sent) },
    { key: 'bounced', label: 'Bounced', rate: (r) => pct(r.bounced, r.sent), hide: (r) => r.channel === 'sms' || r.channel === 'rvm' || r.channel === 'ai_agent' },
    { key: 'opened', label: 'Opened', rate: (r) => pct(r.opened, r.delivered), hide: (r) => r.channel != null && r.channel !== 'email' },
    { key: 'replies', label: 'Replies', rate: (r) => pct(r.replies, r.delivered), hide: (r) => r.channel != null },
    { key: 'optOuts', label: 'Opt-outs', rate: (r) => pct(r.optOuts, r.delivered), hide: (r) => r.channel != null },
  ];
  const all = total ? [total, ...rows] : rows;
  const th: React.CSSProperties = { textAlign: 'right', fontSize: '11px', fontWeight: 600, color: MUTED, padding: '6px 0 6px 10px', whiteSpace: 'nowrap', borderBottom: `1px solid ${LINE}` };
  const td: React.CSSProperties = { textAlign: 'right', padding: '7px 0 7px 10px', fontVariantNumeric: 'tabular-nums', fontSize: '12.5px', color: INK, borderBottom: `1px solid var(--divider-2, #f0f0f1)`, verticalAlign: 'top', whiteSpace: 'nowrap' };
  return (
    <div style={{ marginTop: '12px' }}>
      <div style={{ fontSize: '11.5px', fontWeight: 600, color: MUTED, marginBottom: '2px' }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', paddingLeft: 0 }}>{title === 'By week' ? 'Week of' : 'Step'}</th>
              {cols.map((c) => <th key={c.key} style={th}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {all.map((r) => (
              <tr key={r.key} style={r.key === 'total' ? { fontWeight: 600 } : undefined}>
                <td style={{ ...td, textAlign: 'left', paddingLeft: 0, whiteSpace: 'normal', minWidth: '96px' }}>
                  {r.label}
                  {r.channel && channelWord(r.channel) !== r.label ? <span style={{ display: 'block', fontSize: '11px', fontWeight: 500, color: MUTED }}>{channelWord(r.channel)}</span> : null}
                </td>
                {cols.map((c) => {
                  if (c.hide?.(r)) return <td key={c.key} style={{ ...td, color: FAINT }} aria-label="not measured">·</td>;
                  const n = r[c.key] as number;
                  const rate = c.rate && n ? c.rate(r) : '';
                  return (
                    <td key={c.key} style={{ ...td, color: n || c.key === 'sent' ? INK : FAINT }}>
                      {n.toLocaleString('en-US')}
                      {rate ? <span style={{ display: 'block', fontSize: '11px', fontWeight: 500, color: c.key === 'failed' || c.key === 'bounced' || c.key === 'optOuts' ? 'var(--tx-red, #b91c1c)' : MUTED }}>{rate}</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
        <button
          type="button"
          aria-pressed={kind === 'report'}
          onClick={(e) => { e.stopPropagation(); onKind('report'); }}
          title="Delivered, failed, bounced, opened, replies and opt-outs by step and by week"
          style={{
            height: '24px', padding: '0 8px', borderRadius: '6px', border: `1px solid ${kind === 'report' ? MINT : LINE}`,
            background: kind === 'report' ? MINT_BG : 'var(--surface, #fff)', color: INK, fontSize: '11.5px', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
          }}
        >
          Report
        </button>
      </span>
    </span>
  );
}

/** Under Waiting: what is holding these steps, why, and what to do. Then the limits in force. */
function WaitSummary({ rows }: { rows: { reason: string | null; at: string | null }[] }) {
  const [limits, setLimits] = React.useState(false);
  const groups = groupWaits(rows);
  if (!groups.length) return null;
  return (
    <div data-testid="plan-wait-summary" style={{ margin: '10px 0 2px', padding: '10px 12px', borderRadius: '10px', background: 'var(--canvas, #fafafa)', border: `1px solid ${LINE}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <b style={{ fontSize: '12.5px', color: INK }}>Why these are waiting</b>
        <button type="button" onClick={() => setLimits((v) => !v)} aria-expanded={limits}
          style={{ marginLeft: 'auto', border: 0, background: 'none', padding: 0, color: 'var(--accent, #0A8560)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
          {limits ? 'Hide limits' : 'All sending limits'}
        </button>
      </div>
      {groups.map(({ t, n }) => (
        <div key={t.key + t.why} style={{ padding: '6px 0', borderTop: `1px solid var(--divider-2, #f0f0f1)`, fontSize: '12px', lineHeight: 1.45 }}>
          <div><b style={{ color: INK }}>{t.label}</b> <span style={{ color: MUTED, fontVariantNumeric: 'tabular-nums' }}>· {n}</span></div>
          <div style={{ color: MUTED }}>{t.why}</div>
          <div style={{ color: INK }}><span style={{ fontWeight: 600 }}>To do: </span>{t.todo}</div>
        </div>
      ))}
      {limits ? (
        <table style={{ width: '100%', marginTop: '6px', fontSize: '11.5px', borderCollapse: 'collapse' }}>
          <tbody>
            {LIMITS.map((l) => (
              <tr key={l.what} style={{ borderTop: `1px solid var(--divider-2, #f0f0f1)` }}>
                <td style={{ padding: '4px 0', color: MUTED }}>{l.what}</td>
                <td style={{ padding: '4px 0', color: INK, textAlign: 'right' }}>{l.limit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
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
    if (!progress || !kind || kind === 'report') return [];
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
      {progress && kind === 'report' ? (
        <div data-testid="plan-report" style={{ marginTop: '4px' }}>
          {!progress.report.total.sent ? <div style={{ padding: '12px 0 2px', fontSize: '12.5px', color: MUTED, lineHeight: 1.5 }}>{EMPTY.report}</div> : (
            <>
              <ReportTable title="By step" rows={progress.report.steps} total={progress.report.total} />
              <ReportTable title="By week" rows={progress.report.weeks} />
              <div style={{ fontSize: '11px', color: MUTED, marginTop: '8px', lineHeight: 1.5 }}>
                Delivered means the carrier reported a text as delivered, or an email went out and did not bounce. Opened needs the read pixel, which goes on relationship mail only, never cold. Replies and opt-outs answer the plan, so they count by week, not by step.
              </div>
            </>
          )}
        </div>
      ) : null}
      {progress && kind && kind !== 'report' ? (
        <div data-testid="plan-results-list" style={{ marginTop: '12px', borderTop: `1px solid ${LINE}` }}>
          {!rows.length ? <div style={{ padding: '12px 0 2px', fontSize: '12.5px', color: MUTED, lineHeight: 1.5 }}>{EMPTY[kind]}</div> : null}
          {kind === 'waiting' ? <WaitSummary rows={rows.flatMap((r) => (r.attempt ? [{ reason: r.attempt.reason, at: r.attempt.at }] : []))} /> : null}
          {rows.slice(0, 200).map((row) => {
            const attempt = row.attempt;
            const snippet = row.reply?.snippet ?? (attempt?.outcome === 'waiting' ? explainWait(attempt.reason, attempt.at).label : attempt?.reason) ?? '';
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
                title={canOpen ? `Open ${row.who.name}: every text, email, call and AI step on their timeline` : undefined}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 0', border: 0, borderBottom: `1px solid var(--divider-2, #f0f0f1)`,
                  background: 'none', cursor: canOpen ? 'pointer' : 'default', fontFamily: 'inherit', minHeight: '44px',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: INK }}>{row.who.name}</span>
                  {canOpen ? <span style={{ marginLeft: 'auto', fontSize: '11.5px', fontWeight: 600, color: 'var(--accent, #0A8560)', whiteSpace: 'nowrap' }}>View activity ›</span> : null}
                </span>
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
