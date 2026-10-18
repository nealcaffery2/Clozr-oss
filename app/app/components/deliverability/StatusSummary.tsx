'use client';

// The box at the very top of the email page. In plain words: one sentence
// that says where cold email and buyer blasts stand today, the problems
// behind the count (each with a link to the box that fixes it), and at most
// one button for the most urgent fix. Everything it says comes from rows
// already loaded for the boxes below (lib/deliverability-summary.ts does the
// counting, with coldReadiness() deciding what blocks cold email).

import React from 'react';
import { type ColdStatus, type NextAction, type Target, type WarmStatus } from '@/lib/deliverability-summary';
import { textValue } from '@/lib/deliverability';
import { Icon, Mark, card, goTo, primary } from './ui';

/** The words on each link, named after the box it scrolls to. */
const BOX: Record<Target, string> = {
  'cold-inboxes': 'Outreach inboxes',
  'cold-warmup': 'Warmup',
  'cold-rules': 'Safety rules',
  'cold-campaigns': 'Campaigns',
  'sending-domains': 'Sending domains',
  'warm-checklist': 'Blast checklist',
  'warm-resend': 'Resend',
};
/** More than this and the list would bury the page; the boxes below have the rest. */
const SHOWN = 5;

export function StatusSummary({ cold, coldErr, coldLoading, warm, warmLoading, next }: {
  cold: ColdStatus; coldErr: string | null; coldLoading: boolean;
  warm: WarmStatus; warmLoading: boolean;
  next: NextAction | null;
}) {
  const loading = coldLoading || warmLoading;
  const problems = cold.problems + warm.blocking;
  const tone = coldErr ? '#b91c1c' : problems ? '#b91c1c' : '#08694C';
  const icon = coldErr || problems ? 'alert' : loading ? 'clock' : 'check';
  const list = cold.list.slice(0, SHOWN);
  const more = cold.list.length - list.length;
  return (
    <section aria-label="Email status" style={card}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <span style={{ color: loading && !coldErr ? 'var(--meta, #71717a)' : tone, marginTop: '1px' }}><Icon name={icon} size={18} /></span>
        <div role="status" style={{ flex: '1 1 260px', minWidth: 0, maxWidth: '64ch' }}>
          {loading && !cold.line && !warm.line ? (
            <p style={{ margin: 0, fontSize: '13.5px', fontWeight: 650, color: 'var(--meta, #71717a)' }}>Checking your email setup…</p>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: '13.5px', fontWeight: 650, color: 'var(--ink, #18181b)', lineHeight: 1.45 }}>
                {coldErr ? `Couldn't load cold email: ${coldErr.replace(/\.$/, '')}. Press Try again in the cold email box below.` : cold.line || (coldLoading ? 'Checking cold email…' : '')}
              </p>
              {warm.line || warmLoading ? (
                <p style={{ margin: '3px 0 0', fontSize: '12.5px', color: 'var(--ink-3, #3f3f46)', lineHeight: 1.45 }}>
                  {warm.line || 'Checking buyer blasts…'}
                  {cold.retrying ? ` ${cold.retrying} ${cold.retrying === 1 ? 'inbox is' : 'inboxes are'} retrying a reply check on their own, nothing to do.` : ''}
                </p>
              ) : null}
            </>
          )}
        </div>
        {next ? <button type="button" style={{ ...primary, height: '32px', padding: '0 14px' }} onClick={() => goTo(next.target)}>{next.label}</button> : null}
      </div>
      {list.length ? (
        <ul aria-label="Problems" style={{ listStyle: 'none', margin: '12px 0 0', padding: '10px 0 0 30px', borderTop: '1px solid var(--divider-2, #f0f0f1)', display: 'grid', gap: '6px' }}>
          {list.map((p) => (
            <li key={`${p.target}:${p.text}`} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: '8px', alignItems: 'start', fontSize: '12.5px', lineHeight: 1.45 }}>
              <span style={{ paddingTop: '2px' }}><Mark tone={p.level === 'block' ? 'bad' : 'warn'} size={13} /></span>
              <span style={{ color: 'var(--ink-2, #27272a)', overflowWrap: 'anywhere' }}>{textValue(p.text)}</span>
              <a href={`#${p.target}`} onClick={(e) => { e.preventDefault(); goTo(p.target); }} style={{ color: 'var(--tx-mint, #0a8560)', fontWeight: 600, fontSize: '12px', whiteSpace: 'nowrap' }}>{BOX[p.target]}</a>
            </li>
          ))}
          {more > 0 ? <li style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>{more} more in the boxes below.</li> : null}
        </ul>
      ) : null}
    </section>
  );
}
