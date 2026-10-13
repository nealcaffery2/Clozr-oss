'use client';

// An email on the record's Activity feed, drawn the way every inbox draws
// one: who it is from, who it went to, the subject in bold, and the first few
// lines of what they wrote, with "Show full email" to read the rest. The
// signature and the quoted thread under a reply fold behind "···", as Gmail
// does, so a five-message thread does not print five times.

import React, { useState } from 'react';
import type { TimelineEntry } from '@/lib/clozr-types';
import { cleanEmail, stripQuotedHtml } from '@/lib/email-text';
import { EmailHtml } from '@/app/components/email/EmailHtml';
import { useEmailDocument } from '@/app/components/email/useEmailDocument';

type Email = NonNullable<TimelineEntry['email']>;

const PREVIEW_LINES = 4;
const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;

/** Plain text with its links clickable and its line breaks kept. */
function Linked({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1
        ? <a key={i} href={p} target="_blank" rel="noopener noreferrer" style={{ color: '#0A8560', wordBreak: 'break-all' }}>{p.length > 60 ? p.slice(0, 57) + '…' : p}</a>
        : <React.Fragment key={i}>{p}</React.Fragment>))}
    </>
  );
}

const link: React.CSSProperties = { border: 0, background: 'none', padding: 0, cursor: 'pointer', font: '600 12px/1 var(--sans, inherit)', color: '#0A8560' };

const replyBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', height: '28px', padding: '0 10px', border: 0, borderRadius: '8px',
  background: '#fff', cursor: 'pointer', font: '600 12.5px/1 var(--font-sans, inherit)', color: '#18181b',
  boxShadow: '0 0 0 1px rgba(0,0,0,.08), 0 1px 2px -1px rgba(0,0,0,.08), 0 2px 4px 0 rgba(0,0,0,.04)',
};

export function EmailEntry({ email, workspaceId, communicationId, onOpenInbox, onReply, compact }: {
  email: Email;
  /** Opens this message in the Inbox, in its thread. */
  onOpenInbox?: () => void;
  /** Reply from the feed, in the same Gmail thread (EmailThread.tsx). */
  onReply?: () => void;
  /** An earlier message inside a folded thread: tighter, no actions but its own expand. */
  compact?: boolean;
  /** Set on a stored row, so an older plain copy can be upgraded to the HTML Gmail still has. */
  workspaceId?: number | null;
  communicationId?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [showRest, setShowRest] = useState(false);
  const [allTo, setAllTo] = useState(false);
  const doc = useEmailDocument(email.body, { workspaceId, communicationId });
  const { text, rest } = cleanEmail(doc.html ? '' : email.body);
  // An HTML reply shows this message only; the thread under it is behind ···.
  const htmlOnly = doc.html ? stripQuotedHtml(doc.html) : null;
  const html = doc.html ? (showRest || !htmlOnly ? doc.html : htmlOnly) : null;
  const long = !!doc.html || text.split('\n').length > PREVIEW_LINES || text.length > 360;
  const to = allTo ? email.to : email.to.slice(0, 2);

  return (
    <div style={{ marginTop: compact ? '4px' : '8px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap', fontSize: '13px' }}>
        <span style={{ color: '#71717a', width: '34px', flex: 'none' }}>From</span>
        {email.fromName ? (
          <>
            <span style={{ fontWeight: 600, color: '#18181b' }}>{email.fromName}</span>
            <span style={{ color: '#71717a', wordBreak: 'break-all' }}>&lt;{email.from}&gt;</span>
          </>
        ) : (
          <span style={{ fontWeight: 600, color: '#18181b', wordBreak: 'break-all' }}>{email.from || 'Unknown sender'}</span>
        )}
      </div>
      {email.to.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap', fontSize: '12.5px', color: '#52525b', marginTop: '3px' }}>
          <span style={{ color: '#71717a', width: '34px', flex: 'none' }}>To</span>
          <span style={{ minWidth: 0, wordBreak: 'break-all' }}>{to.join(', ')}</span>
          {email.to.length > 2 && (
            <button type="button" onClick={() => setAllTo(!allTo)} style={{ ...link, fontWeight: 500 }}>
              {allTo ? 'show less' : `+${email.to.length - 2} more`}
            </button>
          )}
        </div>
      )}

      <div style={{ fontSize: '14px', fontWeight: 700, color: '#18181b', marginTop: '10px', lineHeight: 1.35, wordBreak: 'break-word' }}>
        {email.subject}
      </div>

      {html ? (
        <div style={{ marginTop: '8px' }}>
          <EmailHtml html={html} title={email.subject || 'Email'} clip={!open} />
        </div>
      ) : text ? (
        <div
          style={{
            fontSize: '13px', color: '#27272a', marginTop: '6px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            ...(open ? {} : { display: '-webkit-box', WebkitLineClamp: PREVIEW_LINES, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }),
          }}
        >
          <Linked text={text} />
        </div>
      ) : (
        <div style={{ fontSize: '13px', color: '#a1a1aa', marginTop: '6px' }}>{doc.loading ? 'Loading the email…' : 'No message text.'}</div>
      )}

      {open && htmlOnly && (
        <button type="button" onClick={() => setShowRest(!showRest)} title={showRest ? 'Hide earlier messages' : 'Show earlier messages in the thread'}
          style={{ marginTop: '8px', height: '18px', padding: '0 8px', border: '1px solid #e4e4e7', borderRadius: '9px', background: '#f4f4f5', cursor: 'pointer', fontSize: '12px', lineHeight: 1, color: '#52525b' }}>
          ···
        </button>
      )}
      {open && rest && (
        <>
          <button
            type="button"
            onClick={() => setShowRest(!showRest)}
            title={showRest ? 'Hide signature and earlier messages' : 'Show signature and earlier messages'}
            style={{ marginTop: '8px', height: '18px', padding: '0 8px', border: '1px solid #e4e4e7', borderRadius: '9px', background: '#f4f4f5', cursor: 'pointer', fontSize: '12px', lineHeight: 1, color: '#52525b' }}
          >
            ···
          </button>
          {showRest && (
            <div style={{ fontSize: '12.5px', color: '#71717a', marginTop: '8px', paddingLeft: '10px', borderLeft: '2px solid #e4e4e7', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <Linked text={rest} />
            </div>
          )}
        </>
      )}

      {(long || rest || onOpenInbox || onReply) && (
        <div style={{ marginTop: onReply ? '10px' : '8px', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
          {onReply ? (
            <button type="button" className="clozr-reply" onClick={onReply} title={email.sourceId ? 'Reply in this Gmail thread' : 'Reply by email'} style={replyBtn}>
              <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" />
              </svg>
              Reply
            </button>
          ) : null}
          {long || rest ? (
            <button type="button" onClick={() => { setOpen(!open); if (open) setShowRest(false); }} style={link}>
              {open ? 'Show less' : 'Show full email'}
            </button>
          ) : null}
          {onOpenInbox ? <button type="button" onClick={onOpenInbox} style={{ ...link, color: '#52525b' }}>Open in Inbox</button> : null}
        </div>
      )}
    </div>
  );
}
