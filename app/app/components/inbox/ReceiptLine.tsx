'use client';

// The receipt line under a sent text or email on the record's Activity feed:
// "Viewed 2:14 PM" when the person opened the CLOZR link in a text. On a
// tracked email a click leads ("Clicked 2:14 PM", green, bold); an open alone
// stays grey ("Opened 2:14 PM"), since a mail app can load the pixel with
// nobody reading, and its tooltip says so. Live (receipts.ts). Nothing renders
// for a text with no tracked link or an email that was not tracked.

import React from 'react';
import { type EmailReceiptView, emailReceiptView, type Receipt, useEmailReceipts, useLinkViews } from './receipts';

// Longhands, not the `font` shorthand: beside a shorthand that holds var(),
// a font longhand (tabular-nums, the weight) blanks its size and family.
const line = (done: boolean, weight = 500): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 6,
  fontFamily: 'var(--font-sans, var(--sans, inherit))', fontSize: 12, lineHeight: 1.3, fontWeight: weight, fontVariantNumeric: 'tabular-nums',
  color: done ? 'var(--tx-mint, #0a8560)' : 'var(--meta, #71717a)',
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

/** Lucide "mouse-pointer-click": a link in the email was followed. */
export function ClickMark({ size = 13 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4.1 12 6" /><path d="m5.1 8-2.9-.8" /><path d="m6 12-1.9 2" /><path d="M7.2 2.2 8 5.1" />
      <path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" />
    </svg>
  );
}

/** The mark for an email receipt level: a pointer for a click, double check for an open, one check before either. */
export function EmailReceiptMark({ level, size = 13 }: { level: EmailReceiptView['level']; size?: number }) {
  return level === 'clicked' ? <ClickMark size={size} /> : <SeenMark seen={level === 'opened'} size={size} />;
}

/** Under an outbound email: a click first, then opens, from its tracked links and pixel. */
export function EmailReceipt({ communicationId, workspaceId, demo }: { communicationId: number | null; workspaceId: number | null; demo?: Receipt | null }) {
  const live = useEmailReceipts(communicationId != null && !demo ? [communicationId] : [], workspaceId);
  const r = demo ?? (communicationId != null ? live.get(communicationId) : undefined);
  const v = emailReceiptView(r);
  if (!v) return null;
  const clicked = v.level === 'clicked';
  return (
    <span style={line(clicked, clicked ? 600 : 500)} title={v.title}>
      <EmailReceiptMark level={v.level} />{v.label}
    </span>
  );
}
