'use client';

// An email thread on a record's Activity feed (seller or buyer): the newest
// message drawn in full, the earlier ones folded behind one line the way Gmail
// folds a conversation, and Reply right there. A reply goes out from the rep's
// Gmail with In-Reply-To set to the newest message, so it lands in the same
// Gmail thread the seller or buyer sees, and the sent copy files back onto
// this record.

import React, { useState } from 'react';
import type { TimelineEntry } from '@/lib/clozr-types';
import { counterpartOf, replySubject } from '@/lib/email-thread';
import { openReach } from './reach';
import { EmailEntry } from './EmailEntry';

type Email = NonNullable<TimelineEntry['email']>;
export type ThreadMessage = { id: string; email: Email; commId: number | null; time: string };

/** Who a reply is filed on. */
export type ReplyFiling = { name: string; sellerId?: number | null; buyerId?: number | null; onSent?: () => void };

/** Open the docked email box as a reply to `email`, threaded in Gmail when its Message-ID is known. */
export function replyToEmail(email: Email, filing: ReplyFiling) {
  openReach('email', {
    name: filing.name,
    email: counterpartOf(email) || null,
    subject: replySubject(email.subject),
    inReplyTo: email.sourceId ?? null,
    sellerId: filing.sellerId ?? null,
    buyerId: filing.buyerId ?? null,
    audience: filing.buyerId ? 'buyer' : 'seller',
    onSent: filing.onSent,
  });
}

const fold: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minHeight: '32px', marginTop: '10px', padding: '0 10px',
  border: '1px solid #e4e4e7', borderRadius: '8px', background: '#fafafa', cursor: 'pointer',
  font: '500 12.5px/1.2 var(--font-sans, inherit)', color: '#3f3f46', textAlign: 'left',
};

export function EmailThread({ latest, earlier, workspaceId, onOpenInbox, reply }: {
  latest: ThreadMessage;
  /** The rest of the thread, oldest first. */
  earlier: ThreadMessage[];
  workspaceId?: number | null;
  onOpenInbox?: () => void;
  /** Where a reply is filed; leave out to hide Reply (sample data, read-only preview). */
  reply?: ReplyFiling | null;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const n = earlier.length;
  return (
    <div style={{ minWidth: 0 }}>
      {n > 0 && (
        <button type="button" className="clozr-thread-fold" onClick={() => setShowEarlier(!showEarlier)} aria-expanded={showEarlier} style={fold}>
          <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ flex: 'none', color: '#71717a', transition: 'transform 160ms cubic-bezier(.23,1,.32,1)', transform: showEarlier ? 'rotate(90deg)' : 'none' }}>
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {showEarlier ? 'Hide' : 'Show'} {n} earlier {n === 1 ? 'message' : 'messages'}
          </span>
          <span className="clozr-thread-since" style={{ fontSize: '11.5px', color: '#71717a', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>since {earlier[0].time}</span>
        </button>
      )}
      {showEarlier && (
        <div className="clozr-thread-earlier" style={{ marginTop: '4px' }}>
          {earlier.map((m) => (
            <div key={m.id} style={{ paddingBottom: '12px', borderBottom: '1px solid #f0f0f1' }}>
              <div style={{ fontSize: '11.5px', color: '#71717a', marginTop: '10px', fontVariantNumeric: 'tabular-nums' }}>{m.time}</div>
              <EmailEntry email={m.email} workspaceId={workspaceId} communicationId={m.commId} compact />
            </div>
          ))}
        </div>
      )}
      <EmailEntry
        email={latest.email}
        workspaceId={workspaceId}
        communicationId={latest.commId}
        onOpenInbox={onOpenInbox}
        onReply={reply ? () => replyToEmail(latest.email, reply) : undefined}
      />
    </div>
  );
}
