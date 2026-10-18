'use client';

// The receipt line under a sent text or email on the record's Activity feed:
// "Viewed 2:14 PM" when the person opened the CLOZR link in a text, "Opened
// 2:14 PM · 2 clicks" on a tracked email. Live (receipts.ts, ReceiptLine.tsx). Nothing renders
// for a text with no tracked link or an email that was not tracked.

import React from 'react';
import { emailReceiptLabel, type Receipt, useEmailReceipts, useLinkViews } from './receipts';

const line = (done: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 6,
  font: '500 11.5px/1.3 var(--font-sans, var(--sans, inherit))', fontVariantNumeric: 'tabular-nums',
  color: done ? '#0A8560' : '#71717a',
});

/** Lucide "check-check" (seen) and "check" (sent, not seen yet). */
export function SeenMark({ seen, size = 13 }: { seen: boolean; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {seen ? <><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></> : <path d="M20 6 9 17l-5-5" />}
    </svg>
  );
}

/** Under an outbound text: when the link in it was first opened. */
export function LinkReceipt({ text, workspaceId }: { text: string; workspaceId: number | null }) {
  const views = useLinkViews([text], workspaceId);
  const label = views.label(text);
  if (!label) return null;
  const seen = views.viewed(text);
  return (
    <span style={line(seen)} title={views.title(text)}>
      <SeenMark seen={seen} />{label}
    </span>
  );
}

/** Under an outbound email: opens and clicks, from its tracking pixel and links. */
export function EmailReceipt({ communicationId, workspaceId, demo }: { communicationId: number | null; workspaceId: number | null; demo?: Receipt | null }) {
  const live = useEmailReceipts(communicationId != null && !demo ? [communicationId] : [], workspaceId);
  const r = demo ?? (communicationId != null ? live.get(communicationId) : undefined);
  const label = emailReceiptLabel(r);
  if (!label) return null;
  const seen = !!r && r.opens > 0;
  const title = seen && r?.first_opened_at
    ? `First opened ${new Date(r.first_opened_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Opens are a signal, not proof: some mail apps hide them, Apple Mail can report one nobody read.`
    : 'Read receipt on. No open reported yet.';
  return (
    <span style={line(seen)} title={title}>
      <SeenMark seen={seen} />{label}
    </span>
  );
}
