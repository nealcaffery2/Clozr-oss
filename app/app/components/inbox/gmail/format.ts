// The small formatting rules that make a list row read as Gmail's.
'use client';

import type { EmailRow, EmailThread } from '../data';
import { splitQuoted } from '../quoted';
import type { RecordFor } from '../data';
import { emailPlain } from '@/lib/email-html';

/**
 * Gmail's date column, which has three branches, not two: a time today, a
 * month and day this year, and a numeric date before that. The old `when()`
 * had only the first two, so a message from last year read as "Sep 21" and
 * looked like this month.
 */
export function gmailDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

/** The full stamp, for the date cell's tooltip. */
export const fullStamp = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
};

/**
 * The sender column: everyone in the thread, oldest first, deduped, with the
 * member's own messages as "me" — which is what Gmail shows and what makes a
 * thread you have replied to recognisable at a glance.
 */
export function participantsOf(thread: EmailThread, recordFor?: RecordFor): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of thread.rows) {
    const name = row.direction === 'outbound'
      ? 'me'
      : (recordFor?.(row.from_email ?? '')?.name ?? row.from_email ?? 'unknown');
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.join(', ');
}

/** The snippet: the new part of the latest message, on one line. */
export function snippetOf(row: EmailRow): string {
  if (row.body == null) return (row.preview ?? '').replace(/\s+/g, ' ').trim();
  return splitQuoted(emailPlain(row.body ?? ''))[0].replace(/\s+/g, ' ').trim();
}
