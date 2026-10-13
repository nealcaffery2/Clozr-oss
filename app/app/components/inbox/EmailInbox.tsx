'use client';

// The inbox's Email tab: threads from the member's Gmail sync, read as email
// cards (short replies as bubbles), answered from their own Gmail so the reply
// threads in both inboxes. A designed message is the same frame the record uses.

import React, { useEffect, useState } from 'react';
import { syncGoogle } from '@/lib/google';
import { emailPlain, looksLikeHtml } from '@/lib/email-html';
import { EmailHtml } from '@/app/components/email/EmailHtml';
import { useEmailDocument } from '@/app/components/email/useEmailDocument';
import { SpamRiskBadge } from '@/app/components/deliverability/SpamRiskBadge';
import { GoogleConnect } from '@/components/GoogleConnect';
import { Icon } from '@/app/components/talkr/Icon';
import { Avatar, Button, FIELD } from '@/app/components/talkr/ui';
import { Bubble, TimeSeparator, needsStamp } from '@/app/components/talkr/Bubble';
import { type EmailRow, type EmailThread, type RecordFor, baseSubject, type useEmail } from './data';
import { InboxRow } from './InboxRow';
import { splitQuoted } from './quoted';
import type { MergeFor, PickerRender } from './types';
import { useEmailComposer } from './useEmailComposer';
import { READ_ONLY_TITLE } from '@/lib/read-only-context';


const when = (iso: string) => {
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};


export function EmailInbox({ workspaceId, demo, userId, email, recordFor, mergeFor, picker, placeCall, openKey, toast }: {
  workspaceId: number | null; demo: boolean; userId: string | null;
  email: ReturnType<typeof useEmail>;
  recordFor?: RecordFor; mergeFor: MergeFor; picker: PickerRender;
  placeCall: (e164: string) => void;
  /** A thread to open, from the All tab. */
  openKey?: string | null;
  toast: (msg: string) => void;
}) {
  // The All tab remounts this (keyed) to open a thread, so the prop only seeds the state.
  const [picked, setSelected] = useState<string | null>(openKey ?? null);
  const [listOpen, setListOpen] = useState(!openKey);
  const [q, setQ] = useState('');
  const [syncing, setSyncing] = useState(false);
  // Landing on the tab opens the newest thread, as the SMS inbox does.
  const selected = picked ?? email.threads[0]?.key ?? null;

  const nameOf = (t: EmailThread) => (t.counterpart ? recordFor?.(t.counterpart)?.name : null) ?? t.counterpart ?? 'Unknown sender';
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? email.threads.filter((t) => [nameOf(t), t.counterpart, t.subject, t.last.body].some((v) => v?.toLowerCase().includes(needle)))
    : email.threads;
  const thread = selected === 'new' ? null : email.threads.find((t) => t.key === selected) ?? null;

  const syncNow = async () => {
    if (!workspaceId) return;
    setSyncing(true);
    const r = await syncGoogle(workspaceId);
    setSyncing(false);
    toast(!r.ok ? r.message : !r.data.connected ? 'Connect Gmail first' : r.data.message ?? `Gmail synced${r.data.gmail?.logged ? ` · ${r.data.gmail.logged} new` : ''}${r.data.gmail?.relinked ? ` · ${r.data.gmail.relinked} linked to records` : ''}`);
    await email.reload();
  };

  if (demo || !workspaceId) {
    return <p className="p-6" style={{ font: '400 13px/1.5 var(--sans)', color: 'var(--muted)' }}>Email runs on a signed-in workspace with Gmail connected.</p>;
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[340px_1fr]">
      {/* ── Threads ─────────────────────────────────────────────────── */}
      <div className={`${listOpen ? 'flex' : 'hidden'} min-h-0 flex-col md:flex md:border-r md:border-[var(--line)]`} style={{ background: 'var(--panel)' }}>
        <div className="flex flex-col gap-2 px-3 py-3">
          <div className="flex items-center gap-2">
            <span className="eyebrow mr-auto">Email{email.account ? ` · ${email.account.email}` : ''}</span>
            <Button tone="ghost" className="dc2" style={{ padding: '6px 10px', font: '600 11px/1 var(--sans)' }} disabled={syncing || !email.account} onClick={() => void syncNow()}>{syncing ? 'Syncing…' : 'Sync now'}</Button>
            <Button tone="ghost" className="dc2" style={{ padding: '6px 10px', font: '600 11px/1 var(--sans)' }} onClick={() => { setSelected('new'); setListOpen(false); }}>New</Button>
          </div>
          <div className="search-pill flex items-center gap-2">
            <Icon name="search" size={14} style={{ color: '#8e8e93', flexShrink: 0 }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search email" className="min-w-0 flex-1 bg-transparent outline-none" style={{ font: '400 15px/1 var(--sans)', padding: '7px 0' }} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {email.error && <p className="p-4" style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--red)' }}>{email.error}</p>}
          {!email.loading && !email.account && (
            <p className="px-4 pb-2" style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>Gmail isn’t connected for you yet — connect it on the right to sync and send.</p>
          )}
          {!email.loading && shown.length === 0 && (
            <p className="p-4" style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>
              {needle ? 'No email matches.' : 'No email yet. Mail with sellers and buyers in CLOZR lands here after a Gmail sync.'}
            </p>
          )}
          {shown.map((t) => {
            const rec = t.counterpart ? recordFor?.(t.counterpart) ?? null : null;
            return (
              <InboxRow
                key={t.key}
                name={nameOf(t)}
                time={when(t.last.occurred_at)}
                title={t.subject}
                preview={`${t.last.direction === 'outbound' ? 'You: ' : ''}${splitQuoted(emailPlain(t.last.body ?? ''))[0]}`}
                record={recordFor ? rec : undefined}
                active={t.key === selected}
                onOpen={() => { setSelected(t.key); setListOpen(false); }}
              />
            );
          })}
        </div>
      </div>

      {/* ── Thread ──────────────────────────────────────────────────── */}
      <div className={`${listOpen ? 'hidden' : 'flex'} min-h-0 flex-col md:flex`} style={{ background: 'var(--panel)' }}>
        <EmailThreadPane
          key={thread?.key ?? selected ?? 'none'}
          thread={thread}
          isNew={selected === 'new'}
          workspaceId={workspaceId}
          userId={userId}
          email={email}
          recordFor={recordFor}
          mergeFor={mergeFor}
          picker={picker}
          placeCall={placeCall}
          toast={toast}
          onBack={() => setListOpen(true)}
          onSent={(key) => { void email.reload().then(() => setSelected(key)); }}
        />
      </div>
    </div>
  );
}

/** One iOS Messages-style row: dot, avatar, name, time ›, two-line preview. Shared with the All and Calls tabs. */
// Exported so the Gmail chrome can mount it: it carries the send path, the
// template picker, merge fields, the spam badge, record linking and
// click-to-call, none of which should be rewritten just to restyle a list.
export function EmailThreadPane({ thread, isNew, workspaceId, userId, email, recordFor, mergeFor, picker, placeCall, toast, onBack, onSent }: {
  thread: EmailThread | null; isNew: boolean; workspaceId: number; userId: string | null;
  email: ReturnType<typeof useEmail>; recordFor?: RecordFor; mergeFor: MergeFor; picker: PickerRender;
  placeCall: (e164: string) => void; toast: (msg: string) => void; onBack: () => void; onSent: (key: string) => void;
}) {
  // The send path lives in useEmailComposer, shared with the Gmail pane.
  const c = useEmailComposer({ thread, workspaceId, recordFor, mergeFor, toast, onSent });
  const { to, setTo, subject, setSubject, draft, setDraft, tpl, setTpl,
          pickerOpen, setPickerOpen, sending, err, rec, name, rendered, pick, send, phone } = c;
  const [showQuoted, setShowQuoted] = useState<Record<number, boolean>>({});
  const bottom = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [thread?.rows.length]);

  const rows = thread?.rows ?? [];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
      {/* Glass header, floating over the thread. */}
      <div className="glass-bar sticky top-0 z-10 flex items-center gap-2 px-3 py-2">
        <button type="button" aria-label="Back to email" onClick={onBack} className="inline-flex h-8 w-8 items-center justify-center md:hidden" style={{ color: 'var(--accent)', cursor: 'pointer' }}>
          <Icon name="chevron-left" size={22} strokeWidth={2.4} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
          {thread || to ? (
            <>
              <Avatar name={name || '?'} size={40} />
              <button type="button" disabled={!rec} onClick={rec?.open} className="inline-flex max-w-full items-center gap-0.5" style={{ font: '500 12px/1.2 var(--sans)', color: 'var(--text)', cursor: rec ? 'pointer' : 'default' }} title={rec ? 'Go to record' : 'Not in CLOZR'}>
                <span className="truncate">{name}</span>{rec && <Icon name="chevron-right" size={11} style={{ color: '#8e8e93' }} />}
              </button>
              <span className="max-w-full truncate" style={{ font: '400 11px/1.2 var(--sans)', color: '#8e8e93' }}>{thread ? thread.subject : 'New email'}{!rec && recordFor && (thread || to.includes('@')) ? ' · Not in CLOZR' : ''}</span>
            </>
          ) : (
            <span style={{ font: '600 13px/1 var(--sans)', color: 'var(--muted)' }}>{isNew ? 'New email' : 'Email'}</span>
          )}
        </div>
        {phone ? (
          <button type="button" aria-label="Call" onClick={() => placeCall(phone)} className="inline-flex h-9 w-9 items-center justify-center rounded-full" style={{ color: 'var(--accent)', cursor: 'pointer' }}><Icon name="phone" size={18} /></button>
        ) : <span className="h-9 w-9" />}
      </div>

      <div className="flex flex-1 flex-col px-3 pb-2 pt-3 md:px-6">
        {!thread && !isNew && <p className="self-center" style={{ font: '400 12px/1.6 var(--sans)', color: 'var(--muted)' }}>Pick a thread, or start a new email.</p>}
        {rows.map((r, i) => {
          const html = looksLikeHtml(r.body);
          const [fresh, quoted] = html ? [emailPlain(r.body ?? ''), ''] : splitQuoted(r.body ?? '');
          const mine = r.direction === 'outbound';
          const short = !html && !quoted && fresh.length <= 280 && !/\n\s*\n/.test(fresh) && baseSubject(r.subject) === thread?.subject;
          const next = rows[i + 1];
          return (
            <React.Fragment key={r.id}>
              {needsStamp(rows[i - 1]?.occurred_at, r.occurred_at) && <TimeSeparator at={r.occurred_at} />}
              {short ? (
                <Bubble mine={mine} tail={!next || next.direction !== r.direction || needsStamp(r.occurred_at, next.occurred_at)}>{fresh || '(empty)'}</Bubble>
              ) : (
                <EmailCard row={r} workspaceId={workspaceId} fresh={fresh} quoted={quoted} open={!!showQuoted[r.id]} toggle={() => setShowQuoted((s) => ({ ...s, [r.id]: !s[r.id] }))} />
              )}
            </React.Fragment>
          );
        })}
        {rows.length > 0 && rows[rows.length - 1].direction === 'outbound' && (
          <span className="self-end" style={{ margin: '-6px 4px 6px 0', font: '500 11px/1 var(--sans)', color: '#8e8e93' }}>Sent</span>
        )}
        <div ref={bottom} />
      </div>

      {/* Glass composer, floating under the thread. */}
      <div className="glass-bar sticky bottom-0 z-10 flex flex-col gap-2 px-3 pb-3 pt-2 md:px-6">
        {!email.canSend ? (
          <div style={{ maxWidth: 640 }}>
            <p style={{ font: '500 12.5px/1.5 var(--sans)', color: 'var(--text)', marginBottom: 8 }}>
              {email.account ? 'Gmail sending is off for your connection — switch it on below to reply from your own address.' : 'Connect Gmail to read and reply to email from CLOZR.'}
            </p>
            <GoogleConnect workspaceId={workspaceId} demo={false} userId={userId} onChange={() => void email.reload()} />
          </div>
        ) : (
          <>
            {pickerOpen && picker({ channel: 'email', audience: rec?.kind ?? 'any', onPick: pick, onClose: () => setPickerOpen(false) })}
            <div className="flex flex-wrap items-center gap-2">
              {(isNew || !thread?.counterpart) && (
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To: name@example.com" aria-label="To" inputMode="email" style={{ ...FIELD, flex: '1 1 200px', borderRadius: 18, font: '400 14px/1 var(--sans)' }} />
              )}
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" style={{ ...FIELD, flex: '2 1 260px', borderRadius: 18, font: '500 14px/1 var(--sans)' }} />
            </div>
            {tpl && rendered?.html && (
              <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ border: '1px solid var(--line)', background: 'var(--panel)' }}>
                <Icon name="template" size={14} style={{ color: 'var(--accent)' }} />
                <span className="mr-auto truncate" style={{ font: '500 12.5px/1.2 var(--sans)' }}>Template: {tpl.name} <span style={{ color: 'var(--muted-2)' }}>· filled for {name || 'this recipient'}</span></span>
                <button type="button" onClick={() => setTpl(null)} style={{ font: '600 11.5px/1 var(--sans)', color: 'var(--accent)', cursor: 'pointer' }}>Remove</button>
              </div>
            )}
            {tpl && rendered?.html && (
              <EmailHtml html={rendered.html} title="Email preview" scrollHeight={220} />
            )}
            {err && <p style={{ font: '400 11.5px/1.4 var(--sans)', color: 'var(--red)' }}>{err}</p>}
            {(draft.trim() || rendered) && (
              <div className="flex justify-end">
                <SpamRiskBadge subject={subject} html={rendered?.html ?? null} text={c.outgoingText} recipients={c.recipientCount} />
              </div>
            )}
            <div className="flex items-end gap-2">
              <button type="button" aria-label="Templates" aria-pressed={pickerOpen} onClick={() => setPickerOpen((v) => !v)} className="plus-btn">
                <Icon name="plus" size={18} strokeWidth={2.4} />
              </button>
              <div className="composer-pill flex flex-1 items-end gap-2">
                <textarea
                  value={tpl ? '' : draft}
                  disabled={!!tpl}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={Math.min(8, Math.max(1, draft.split('\n').length))}
                  placeholder={tpl ? 'Sending the template above' : thread ? 'Reply' : 'Email'}
                  aria-label="Email body"
                  className="min-w-0 flex-1 bg-transparent outline-none"
                  style={{ resize: 'none', font: '400 16px/1.3 var(--sans)', padding: '5px 0', maxHeight: 180 }}
                />
                <button type="button" aria-label="Send email" title={c.canWrite ? undefined : READ_ONLY_TITLE} disabled={!c.canWrite || sending || (!draft.trim() && !tpl)} onClick={() => void send()} className="send-btn">
                  <Icon name="send" size={15} strokeWidth={2.6} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EmailCard({ row, workspaceId, fresh, quoted, open, toggle }: { row: EmailRow; workspaceId: number; fresh: string; quoted: string; open: boolean; toggle: () => void }) {
  const mine = row.direction === 'outbound';
  const doc = useEmailDocument(row.body, { workspaceId, communicationId: row.id });
  const words = doc.html ? emailPlain(doc.html) : fresh;
  return (
    <article className="mb-2.5 flex flex-col gap-1.5 rounded-2xl px-4 py-3" style={{ alignSelf: mine ? 'flex-end' : 'flex-start', width: 'min(640px, 92%)', background: mine ? 'var(--accent-soft)' : 'var(--panel)', border: '1px solid var(--line)' }}>
      <div className="flex flex-wrap items-baseline gap-x-2" style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted)' }}>
        <span style={{ font: '600 13px/1.3 var(--sans)', color: 'var(--text)' }}>{mine ? 'You' : row.from_email}</span>
        <span className="mr-auto truncate">to {row.to_email ?? '—'}</span>
        <time dateTime={row.occurred_at}>{new Date(row.occurred_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
      </div>
      {row.subject && <div style={{ font: '600 14px/1.3 var(--sans)' }}>{row.subject}</div>}
      {doc.html ? (
        <EmailHtml html={doc.html} title={row.subject || 'Email'} />
      ) : (
        <div style={{ font: '400 15px/1.5 var(--sans)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text)' }}>{words || (doc.loading ? 'Loading the email…' : '(no text)')}</div>
      )}
      {!doc.html && quoted && (
        <>
          <button type="button" onClick={toggle} style={{ alignSelf: 'flex-start', font: '600 11.5px/1 var(--sans)', color: 'var(--muted)', cursor: 'pointer', padding: '4px 8px', borderRadius: 8, background: 'var(--panel-2)' }}>{open ? 'Hide quoted text' : '•••'}</button>
          {open && <div style={{ font: '400 13px/1.45 var(--sans)', whiteSpace: 'pre-wrap', color: 'var(--muted)', borderLeft: '2px solid var(--line)', paddingLeft: 10 }}>{quoted}</div>}
        </>
      )}
    </article>
  );
}
