'use client';

// One row of the Email tab's list.
//
// At desk widths it is one line — select, star, sender, subject and snippet,
// date — and hovering swaps the date for archive / mark read / open in place.
// At phone widths (gmail-inbox.css) the same cells re-flow into a grid:
// sender and time on top, subject and a two-line snippet under them, the
// checkbox and star as 40px targets either side.
//
// Unread is the inbox's usual signal: the accent dot and bold text, as the
// SMS, Calls and All rows show it.

import React from 'react';
import type { DealRef, EmailThread } from '../data';
import type { ClozrRecord } from '@/app/components/talkr/MessagesScreen';
import { GmailCheck, GmailIcon } from './GmailIcon';
import { fullStamp, gmailDate, snippetOf } from './format';

/** Keeps a control's click off the row underneath it. */
const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };

export type GmailRowProps = {
  thread: EmailThread;
  senders: string;
  unread: boolean;
  starred: boolean;
  checked: boolean;
  cursor?: boolean;
  /** The CRM record behind the counterpart, when there is one. */
  record?: ClozrRecord | null;
  /** The deal the sync filed this thread under, when there is one. */
  deal?: DealRef | null;
  /** Something in the thread has a file on it. */
  hasFiles?: boolean;
  /** A tracked send in the thread: true once it has been opened, false while not yet. Undefined when nothing was tracked. */
  opened?: boolean;
  onOpen: () => void;
  onCheck: () => void;
  onStar: () => void;
  onArchive: () => void;
  onToggleRead: () => void;
};

export const GmailRow = React.memo(function GmailRow({
  thread, senders, unread, starred, checked, cursor, record, deal, hasFiles, opened,
  onOpen, onCheck, onStar, onArchive, onToggleRead,
}: GmailRowProps) {
  const count = thread.rows.length;
  const snippet = snippetOf(thread.last);
  const stamp = thread.last.occurred_at;

  return (
    <div
      role="row"
      tabIndex={0}
      className="em-row"
      data-state={checked ? 'checked' : unread ? 'unread' : 'read'}
      data-cursor={cursor ? 'true' : undefined}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
    >
      <span className="em-cell-check">
        <button
          type="button" role="checkbox" aria-checked={checked}
          aria-label={checked ? 'Deselect' : 'Select'}
          onClick={stop(onCheck)} className="em-icon-btn em-icon-btn--sm"
        >
          <GmailCheck state={checked ? 'on' : 'off'} />
        </button>
      </span>

      <span className="em-cell-star">
        <button
          type="button" aria-label={starred ? 'Starred' : 'Not starred'}
          onClick={stop(onStar)} className="em-icon-btn em-icon-btn--sm"
        >
          <GmailIcon
            name={starred ? 'star' : 'star_outline'}
            style={{ color: starred ? 'var(--amber)' : 'var(--muted-2)' }}
          />
        </button>
      </span>

      <span className="em-cell-sender">
        {unread ? <span className="em-dot" role="img" aria-label="Unread" /> : <span className="em-dot" aria-hidden="true" />}
        <span className="em-sender">{senders}</span>
        {count > 1 ? <span className="em-count">{count}</span> : null}
      </span>

      <span className="em-cell-main">
        <span className="em-subject-line">
          {/* Which CRM record this is, when there is one. */}
          {record ? <span className={record.kind === 'seller' ? 'em-tag em-tag--seller' : 'em-tag em-tag--buyer'}>{record.kind === 'seller' ? 'Seller' : 'Buyer'}</span> : null}
          {/* The deal, even when the other party is a buyer or the title
              company — which record the email is about, not who sent it. */}
          {deal ? (
            <button type="button" className="em-tag em-tag--deal" onClick={stop(deal.open)} title="Go to the deal">
              {deal.label}
            </button>
          ) : null}
          <span className="em-subject">{thread.subject || '(no subject)'}</span>
          {hasFiles ? <GmailIcon name="attach_file" size={14} className="em-row-glyph" /> : null}
          {opened != null ? (
            <span className="em-row-glyph" data-opened={opened ? 'true' : 'false'} title={opened ? 'Opened' : 'Not opened yet'}>
              <GmailIcon name={opened ? 'done_all' : 'done'} size={14} />
            </span>
          ) : null}
        </span>
        {snippet ? <span className="em-snippet">{snippet}</span> : null}
      </span>

      <span className="em-cell-date" title={fullStamp(stamp)}>{gmailDate(stamp)}</span>

      <span className="em-actions">
        <button type="button" aria-label="Archive" title="Archive" onClick={stop(onArchive)} className="em-icon-btn em-icon-btn--sm">
          <GmailIcon name="archive" />
        </button>
        <button
          type="button"
          aria-label={unread ? 'Mark as read' : 'Mark as unread'}
          title={unread ? 'Mark as read' : 'Mark as unread'}
          onClick={stop(onToggleRead)} className="em-icon-btn em-icon-btn--sm"
        >
          <GmailIcon name={unread ? 'mark_email_read' : 'mark_email_unread'} />
        </button>
        <button type="button" aria-label="Open" title="Open" onClick={stop(onOpen)} className="em-icon-btn em-icon-btn--sm">
          <GmailIcon name="open_in_new" />
        </button>
      </span>
    </div>
  );
});
