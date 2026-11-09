'use client';

// Texts and emails written on this record that go out later (scheduled_messages
// 367, scheduled_emails 373), drawn at the top of the activity stream until the
// tick sends them. Edit puts the words back in the composer and drops the row;
// Cancel drops it. A row the tick could not send says why, with Dismiss.

import React from 'react';
import { Clock, Mail, MessageSquare } from 'lucide-react';
import type { ClozrView } from '@/app/clozr/view';
import { sendsLabel } from '@/lib/inbox-schedule';
import { useScheduled } from '@/lib/use-scheduled';
import { handEmailEdit } from './scheduled-edit';

const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export function PendingSends({ V, kind }: { V: ClozrView; kind: 'seller' | 'buyer' }) {
  const scheduled = useScheduled(V.liveIds?.workspaceId ?? null);
  const sellerId = kind === 'seller' ? V.liveIds?.sellerId ?? null : null;
  const buyerId = kind === 'buyer' ? V.B.dbId ?? null : null;
  const mine = <T extends { seller_id: number | null; buyer_id: number | null }>(r: T) => (sellerId != null ? r.seller_id === sellerId : buyerId != null && r.buyer_id === buyerId);
  const texts = scheduled.rows.filter(mine);
  const mails = scheduled.emails.filter(mine);
  if (!texts.length && !mails.length) return null;
  const goTab = (label: 'Text' | 'Email') => V.composerTabs.find((t) => t.label === label)?.go();
  const rows = [
    ...texts.map((r) => ({
      key: 'sms:' + r.id, icon: <MessageSquare size={13} aria-hidden />, title: 'Text', body: r.body, at: r.send_at, error: r.error, status: r.status,
      edit: () => { void scheduled.cancel(r.id).then((e) => { if (e) return V.showToast(e, 'error'); V.setComposerText(r.body); goTab('Text'); V.showToast('Back in the composer. Schedule it again when it reads right.'); }); },
      cancel: () => void scheduled.cancel(r.id).then((e) => V.showToast(e ?? (r.status === 'error' ? 'Dismissed' : 'Cancelled'), e ? 'error' : undefined)),
    })),
    ...mails.map((r) => ({
      key: 'mail:' + r.id, icon: <Mail size={13} aria-hidden />, title: r.subject, body: strip(r.html), at: r.send_at, error: r.error, status: r.status,
      edit: () => { void scheduled.cancel(r.id, 'scheduled_emails').then((e) => { if (e) return V.showToast(e, 'error'); handEmailEdit({ subject: r.subject, html: r.html, cc: r.cc, bcc: r.bcc, attachments: r.attachments ?? [] }); goTab('Email'); V.showToast('Back in the composer. Schedule it again when it reads right.'); }); },
      cancel: () => void scheduled.cancel(r.id, 'scheduled_emails').then((e) => V.showToast(e ?? (r.status === 'error' ? 'Dismissed' : 'Cancelled'), e ? 'error' : undefined)),
    })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <section aria-label="Scheduled to send" className="rec-pending" data-testid="record-pending-sends">
      {rows.map((r) => (
        <div key={r.key} className="rec-pending-row" data-error={r.status === 'error' || undefined}>
          <span className="rec-pending-when"><Clock size={12} aria-hidden />{r.status === 'error' ? `Not sent: ${r.error ?? 'unknown error'}` : sendsLabel(new Date(r.at))}</span>
          <span className="rec-pending-text">{r.icon}<strong>{r.title}</strong>{r.body ? <span> · {r.body}</span> : null}</span>
          <span className="rec-pending-acts">
            <button type="button" className="rec-link" onClick={r.edit}>Edit</button>
            <button type="button" className="rec-link" onClick={r.cancel}>{r.status === 'error' ? 'Dismiss' : 'Cancel'}</button>
          </span>
        </div>
      ))}
    </section>
  );
}
