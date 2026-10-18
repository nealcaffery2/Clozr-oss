'use client';

// A thread, open.
//
// A document rather than a chat: the subject once at the top, then each
// message as a header (sender, address, date, "to …") over a plain
// body, with quoted text behind the "•••" toggle and older messages folded to
// one line. Sent and received messages are drawn alike; the name in the header
// says who wrote it.
//
// The composer is not persistent: Reply and Forward open it. Everything inside
// it — the address, the subject, the template picker, the merge fields, the
// spam score and the send itself — is useEmailComposer, the same code the
// original pane runs, so there is one send path and not two.
//
// Type, colour and controls are the inbox's own (gmail-inbox.css): the accent
// Button for Send, ghost Buttons for Reply and Forward.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { emailAttachment } from '@/lib/google';
import { emailPlain } from '@/lib/email-html';
import { EmailHtml } from '@/app/components/email/EmailHtml';
import { useEmailDocument } from '@/app/components/email/useEmailDocument';
import { type DealFile, listDealFiles } from '@/lib/deal-files';
import { supabase } from '@/lib/supabase';
import { SpamRiskBadge } from '@/app/components/deliverability/SpamRiskBadge';
import { GoogleConnect } from '@/components/GoogleConnect';
import { Icon } from '@/app/components/talkr/Icon';
import { Button } from '@/app/components/talkr/ui';
import { type DealRef, type EmailRow, type EmailThread, type RecordFor, type useEmail, useThreadBodies } from '../data';
import type { MergeFor, PickerRender } from '../types';
import { splitQuoted } from '../quoted';
import { useEmailComposer } from '../useEmailComposer';
import { useCanWrite } from '@/lib/read-only-context';
import { GmailIcon } from './GmailIcon';
import type { QuickDraft } from './GmailInbox';
import { DealPicker } from './DealPicker';
import { fullStamp, gmailDate } from './format';
import { type MailFile, type Receipt, fmtBytes, receiptLabel } from './mail-extras';


/** "me" is the account holder, in the header and in the To line. */
const asMe = (addr: string | null | undefined, mine: string | null) =>
  addr && mine && addr.toLowerCase() === mine.toLowerCase() ? 'me' : (addr ?? '—');

/** A file on a message: open it, or put it on the deal. */
export function FileChip({ f, workspaceId, canSave, toast, onSaved }: {
  f: MailFile; workspaceId: number; canSave: boolean; toast: (m: string) => void; onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const go = async (save: boolean) => {
    setBusy(true);
    const r = await emailAttachment(workspaceId, f.id, save);
    setBusy(false);
    if (!r.ok || !r.data.ok) return toast(r.ok ? r.data.message ?? 'Could not open that file.' : r.message);
    if (save) { toast(`${f.filename} saved to the deal's files`); onSaved(); return; }
    if (r.data.url) window.open(r.data.url, '_blank', 'noopener');
  };
  return (
    <span className="em-file">
      <GmailIcon name="attach_file" size={14} />
      <button type="button" className="em-file-name" disabled={busy} onClick={() => void go(false)} title={`Open ${f.filename}`}>
        {f.filename}
      </button>
      <span className="em-file-size">{fmtBytes(f.byte_size)}</span>
      {f.deal_file_id ? (
        <span className="em-file-saved" title="On the deal's files">On deal</span>
      ) : canSave ? (
        <button type="button" className="em-file-save" disabled={busy} onClick={() => void go(true)} title="Save to the deal's files">
          Save to deal
        </button>
      ) : null}
    </span>
  );
}

function Message({ row, open, onToggle, mine, single, files, receipt, fileProps }: {
  row: EmailRow; open: boolean; onToggle: () => void; mine: string | null; single: boolean;
  files: MailFile[]; receipt?: Receipt;
  fileProps: { workspaceId: number; canSave: boolean; toast: (m: string) => void; onSaved: () => void };
}) {
  const [quotedOpen, setQuotedOpen] = useState(false);
  const doc = useEmailDocument(row.body, { workspaceId: fileProps.workspaceId, communicationId: row.id });
  const [fresh, quoted] = useMemo(
    () => doc.html ? [emailPlain(doc.html), ''] : splitQuoted(emailPlain(row.body ?? '')),
    [doc.html, row.body],
  );
  const outbound = row.direction === 'outbound';
  const from = outbound ? 'me' : (row.from_email ?? 'Unknown sender');

  // Collapsed: one line, for the older messages in a thread.
  if (!open && !single) {
    return (
      <div className="em-msg em-msg--shut" role="button" tabIndex={0}
        onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <span className="em-msg-who">{from}</span>
        <span className="em-msg-peek">{fresh.replace(/\s+/g, ' ').trim().slice(0, 140)}</span>
        {files.length ? <GmailIcon name="attach_file" size={14} /> : null}
        <span className="em-msg-when" title={fullStamp(row.occurred_at)}>{gmailDate(row.occurred_at)}</span>
      </div>
    );
  }

  return (
    <article className="em-msg">
      <div className="em-msg-body">
        <div className="em-msg-head">
          <span className="em-msg-who">{from}</span>
          {!outbound && row.from_email ? <span className="em-msg-addr">&lt;{row.from_email}&gt;</span> : null}
          {row.source === 'cold' && !outbound && row.rep_id ? <span className="em-msg-addr">Assigned to the record owner</span> : null}
          <span className="em-msg-when" title={fullStamp(row.occurred_at)}>{gmailDate(row.occurred_at)}</span>
        </div>
        <div className="em-msg-to">
          to {asMe(row.to_email, mine)}
          {row.cc_email ? <> · cc {row.cc_email}</> : null}
          {row.bcc_email ? <> · bcc {row.bcc_email}</> : null}
        </div>
        {outbound && receiptLabel(receipt) ? (
          <div className="em-receipt" data-opened={receipt && receipt.opens > 0 ? 'true' : 'false'}
            title={receipt?.first_opened_at ? `First opened ${fullStamp(receipt.first_opened_at)}` : 'Read receipt on — no open reported yet'}>
            <GmailIcon name={receipt && receipt.opens > 0 ? 'done_all' : 'done'} size={14} /> {receiptLabel(receipt)}
          </div>
        ) : null}
        {doc.html ? (
          <div className="em-msg-html"><EmailHtml html={doc.html} title={row.subject || 'Email'} /></div>
        ) : (
          <div className="em-msg-text">{fresh || (doc.loading ? 'Loading the email…' : '(no text)')}</div>
        )}
        {files.length ? (
          <div className="em-files">
            {files.map((f) => <FileChip key={f.id} f={f} {...fileProps} />)}
          </div>
        ) : null}
        {!doc.html && quoted ? (
          <>
            <button type="button" className="em-quoted-toggle" aria-expanded={quotedOpen}
              aria-label={quotedOpen ? 'Hide quoted text' : 'Show quoted text'}
              onClick={() => setQuotedOpen((v) => !v)}>•••</button>
            {quotedOpen ? <div className="em-quoted">{quoted}</div> : null}
          </>
        ) : null}
      </div>
    </article>
  );
}

export function GmailThread({
  thread: listed, isNew, workspaceId, userId, email, recordFor, deal, mergeFor, picker, placeCall, toast, onSent,
  files, receipts, deals, onRefiled, readOnly: otherMailbox, composeDealId, onReply,
}: {
  thread: EmailThread | null; isNew: boolean; workspaceId: number; userId: string | null;
  email: ReturnType<typeof useEmail>; recordFor?: RecordFor; deal?: DealRef | null; mergeFor: MergeFor; picker: PickerRender;
  placeCall: (e164: string) => void; toast: (msg: string) => void; onSent: (key: string) => void;
  /** Files and read receipts by communication id (mail-extras.ts). */
  files: Map<number, MailFile[]>; receipts: Map<number, Receipt>;
  /** Every deal, for "File under". */
  deals: DealRef[];
  /** A thread was moved to another deal, or a file saved onto one: read again. */
  onRefiled: () => void;
  /** An admin reading someone else's mailbox: no replying as them. */
  readOnly?: boolean;
  /** A new email started inside a deal folder files there. */
  composeDealId?: number | null;
  /** CLOZR: Reply opens the docked quick email. Reply all and Forward keep this box, for Cc and the files they carry. */
  onReply?: (draft: QuickDraft) => void;
}) {
  // The list carries previews; the messages themselves are read on open.
  const thread = useThreadBodies(listed);
  // A View-as preview is read-only too: no replying, refiling or saving files.
  const preview = !useCanWrite();
  const readOnly = otherMailbox || preview;
  const mine = email.account?.email ?? null;
  const c = useEmailComposer({ thread, workspaceId, recordFor, mergeFor, toast, onSent, mine, dealId: composeDealId ?? null });
  const [refiling, setRefiling] = useState(false);
  const [dealFiles, setDealFiles] = useState<DealFile[] | null>(null);
  const [dealFilesOpen, setDealFilesOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const attachDealId = composeDealId ?? thread?.deal_id ?? null;

  /** Move every message in the thread onto another deal (or off any deal). */
  const refile = async (dealId: number | null) => {
    if (!thread || !supabase) return;
    setRefiling(false);
    let propertyId: number | null = null;
    if (dealId) {
      const { data } = await supabase.from('deals').select('property_id').eq('id', dealId).maybeSingle();
      propertyId = (data?.property_id as number | null | undefined) ?? null;
    }
    // 'manual' (migration 107) keeps the Gmail sync's re-routing off this thread; without 107 the plain update still files it.
    const ids = thread.rows.map((r) => r.id);
    let { error } = await supabase.from('communications').update({ deal_id: dealId, property_id: propertyId, deal_routed_by: 'manual' }).in('id', ids);
    if (error && /deal_routed_by/.test(error.message)) ({ error } = await supabase.from('communications').update({ deal_id: dealId, property_id: propertyId }).in('id', ids));
    if (error) return toast(error.message);
    toast(dealId ? `Filed under ${deals.find((d) => d.id === dealId)?.label ?? 'the deal'}` : 'Removed from the deal');
    onRefiled();
  };

  const openDealFiles = async () => {
    setDealFilesOpen((v) => !v);
    if (attachDealId && !dealFiles) setDealFiles(await listDealFiles(attachDealId));
  };
  // A new email opens with the box already down; a thread opens as a document.
  // The mode is held rather than read back off the subject: the reader can edit
  // "Fwd:" away, and the To field must not vanish when they do.
  const [mode, setMode] = useState<'shut' | 'reply' | 'forward' | 'new'>(isNew ? 'new' : 'shut');
  const replying = mode !== 'shut';
  // Which older messages the reader has expanded. The newest is always open.
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (replying) box.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [replying]);

  const rows = thread?.rows ?? [];
  const last = rows.length - 1;
  const fileProps = { workspaceId, canSave: !!thread?.deal_id && !readOnly, toast, onSaved: onRefiled };

  if (!thread && !isNew) {
    return <div className="em-empty">Pick a thread, or start a new email.</div>;
  }

  return (
    <div className="em-read">
      <header className="em-read-head">
        <h2 className="em-read-subject">{thread ? thread.subject || '(no subject)' : 'New message'}</h2>
        {c.rec ? (
          <button type="button" className={c.rec.kind === 'seller' ? 'em-record em-record--seller' : 'em-record em-record--buyer'} onClick={c.rec.open} title="Go to record">
            {c.rec.kind === 'seller' ? 'Seller' : 'Buyer'} · {c.rec.name}
          </button>
        ) : null}
        {deal ? (
          <button type="button" className="em-record" onClick={deal.open} title="Go to the deal">
            Deal · {deal.label}
          </button>
        ) : null}
        {thread && !readOnly ? (
          <span style={{ position: 'relative' }}>
            <button type="button" className="em-record em-record--ghost" onClick={() => setRefiling((v) => !v)} title="File this thread under a deal in the pipeline" aria-expanded={refiling} data-deal-picker-toggle>
              {deal ? 'Move…' : 'File under deal…'}
            </button>
            {refiling ? <DealPicker deals={deals} current={thread.deal_id ?? null} onPick={(id) => void refile(id)} onClose={() => setRefiling(false)} /> : null}
          </span>
        ) : null}
        {c.phone ? (
          <button type="button" className="em-icon-btn" aria-label="Call" title="Call" onClick={() => placeCall(c.phone!)}
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            <Icon name="phone" size={16} />
          </button>
        ) : null}
      </header>

      {rows.map((r, i) => (
        <Message
          key={r.id}
          row={r}
          mine={mine}
          files={files.get(r.id) ?? []}
          receipt={receipts.get(r.id)}
          fileProps={fileProps}
          single={rows.length === 1}
          open={i === last || !!opened[r.id]}
          onToggle={() => setOpened((o) => ({ ...o, [r.id]: !o[r.id] }))}
        />
      ))}

      {preview ? (
        <div className="em-connect"><p>Read-only preview · replying is off while you view as a teammate.</p></div>
      ) : readOnly && !workspaceId ? (
        <div className="em-connect"><p>Sample data: replying is off. Connect Gmail in a workspace to answer from your own address.</p></div>
      ) : readOnly ? (
        <div className="em-connect"><p>You are reading a teammate’s mailbox. Replies go out from your own Gmail — open the thread from your own inbox to answer it.</p></div>
      ) : !email.canSend ? (
        <div className="em-connect">
          <p>{email.account
            ? 'Gmail sending is off for your connection — switch it on below to reply from your own address.'
            : 'Connect Gmail to read and reply to email from CLOZR.'}</p>
          <GoogleConnect workspaceId={workspaceId} demo={false} userId={userId} onChange={() => void email.reload()} />
        </div>
      ) : !replying ? (
        <div className="em-reply-row">
          <Button tone="ghost" onClick={() => {
            if (!onReply || !thread?.counterpart) return setMode('reply');
            onReply({
              to: thread.counterpart, name: c.rec?.name ?? '', subject: `Re: ${thread.subject}`,
              // The newest message id, so Gmail files the reply under it (as useEmailComposer does).
              inReplyTo: [...thread.rows].reverse().find((r) => r.source_id.startsWith('<'))?.source_id ?? null,
              sellerId: thread.seller_id, buyerId: thread.buyer_id, dealId: composeDealId ?? thread.deal_id,
            });
          }}>
            <GmailIcon name="reply" size={16} /> Reply
          </Button>
          {thread && (thread.last.cc_email || (thread.last.to_email ?? '').includes(',')) ? (
            <Button tone="ghost" onClick={() => { c.replyAll(); setMode('reply'); }}>
              <GmailIcon name="reply_all" size={16} /> Reply all
            </Button>
          ) : null}
          <Button
            tone="ghost"
            onClick={() => {
              c.setSubject(`Fwd: ${thread?.subject ?? ''}`); c.setTo('');
              // A forward carries the files it was sent with.
              for (const f of thread ? files.get(thread.last.id) ?? [] : []) c.attach({ kind: 'email', key: `e:${f.id}`, name: f.filename, size: f.byte_size, id: f.id });
              setMode('forward');
            }}
          >
            <GmailIcon name="forward" size={16} /> Forward
          </Button>
        </div>
      ) : (
        <div className="em-composer" ref={box}>
          {c.pickerOpen ? picker({ channel: 'email', audience: c.rec?.kind ?? 'any', onPick: c.pick, onClose: () => c.setPickerOpen(false) }) : null}

          <div className="em-to-row">
            {(mode === 'new' || mode === 'forward' || !thread?.counterpart) ? (
              <input className="em-field" value={c.to} onChange={(e) => c.setTo(e.target.value)}
                placeholder="To" aria-label="To" inputMode="email" />
            ) : (
              <div className="em-compose-to">To {c.name || c.to}</div>
            )}
            {!c.showCopies ? (
              <button type="button" className="em-link-btn" onClick={() => c.setShowCopies(true)}>Cc Bcc</button>
            ) : null}
          </div>
          {c.showCopies ? (
            <>
              <input className="em-field" value={c.cc} onChange={(e) => c.setCc(e.target.value)}
                placeholder="Cc — comma between addresses" aria-label="Cc" inputMode="email" />
              <input className="em-field" value={c.bcc} onChange={(e) => c.setBcc(e.target.value)}
                placeholder="Bcc — they get it, nobody sees they did" aria-label="Bcc" inputMode="email" />
            </>
          ) : null}
          <input className="em-field" value={c.subject} onChange={(e) => c.setSubject(e.target.value)}
            placeholder="Subject" aria-label="Subject" />

          {c.tpl && c.rendered?.html ? (
            <>
              <div className="em-tpl">
                <GmailIcon name="label" size={14} />
                <span>Template: {c.tpl.name} · filled for {c.name || 'this recipient'}</span>
                <button type="button" onClick={() => c.setTpl(null)}>Remove</button>
              </div>
              <EmailHtml html={c.rendered.html} title="Email preview" scrollHeight={220} />
            </>
          ) : (
            <textarea
              className="em-body-input"
              value={c.draft}
              onChange={(e) => c.setDraft(e.target.value)}
              rows={8}
              aria-label="Email body"
              placeholder={thread ? 'Reply' : 'Compose email'}
            />
          )}

          {c.files.length || c.uploading ? (
            <div className="em-files">
              {c.files.map((f) => (
                <span key={f.key} className="em-file">
                  <GmailIcon name="attach_file" size={14} />
                  <span className="em-file-name">{f.name}</span>
                  <span className="em-file-size">{fmtBytes(f.size)}</span>
                  <button type="button" className="em-file-x" aria-label={`Remove ${f.name}`} onClick={() => c.detach(f.key)}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              {c.uploading ? <span className="em-file em-file--busy">Uploading {c.uploading}…</span> : null}
            </div>
          ) : null}

          {dealFilesOpen ? (
            <div className="em-dealfiles">
              {!dealFiles ? <span className="em-muted">Loading the deal’s files…</span>
                : !dealFiles.filter((f) => f.storage_path).length ? <span className="em-muted">No uploaded files on this deal yet.</span>
                  : dealFiles.filter((f) => f.storage_path).map((f) => (
                    <button key={f.id} type="button" className="em-dealfile"
                      onClick={() => c.attach({ kind: 'deal', key: `d:${f.id}`, name: f.name, size: f.byte_size, id: f.id })}>
                      <GmailIcon name="attach_file" size={14} /> {f.name} <span className="em-file-size">{fmtBytes(f.byte_size)}</span>
                    </button>
                  ))}
            </div>
          ) : null}

          {c.err ? <p className="em-err">{c.err}</p> : null}
          {(c.draft.trim() || c.rendered) ? (
            <div className="em-spam">
              <SpamRiskBadge subject={c.subject} html={c.rendered?.html ?? null}
                text={c.outgoingText} recipients={c.recipientCount} />
            </div>
          ) : null}

          <div className="em-compose-foot">
            <Button tone="accent" disabled={c.sending || (!c.draft.trim() && !c.tpl)} onClick={() => void c.send()}
              style={{ minHeight: 36, padding: '9px 18px' }}>
              <Icon name="send" size={14} /> {c.sending ? 'Sending…' : 'Send'}
            </Button>
            <button type="button" className="tray-btn" aria-pressed={c.pickerOpen}
              title="Templates" onClick={() => c.setPickerOpen(!c.pickerOpen)}>
              <Icon name="template" size={14} /> Templates
            </button>
            <input ref={fileInput} type="file" multiple hidden
              onChange={(e) => { if (e.target.files) void c.addFiles(e.target.files); e.target.value = ''; }} />
            <button type="button" className="tray-btn" title="Attach files" onClick={() => fileInput.current?.click()}>
              <GmailIcon name="attach_file" size={14} /> Attach
            </button>
            {attachDealId ? (
              <button type="button" className="tray-btn" aria-pressed={dealFilesOpen} title="Attach a file already on the deal"
                onClick={() => void openDealFiles()}>
                <GmailIcon name="folder" size={14} /> Deal files
              </button>
            ) : null}
            <label className="em-track" title="Read receipt: see when they open it and click its links">
              <input type="checkbox" checked={c.track} onChange={(e) => c.setTrack(e.target.checked)} />
              <GmailIcon name="done_all" size={14} /> Track
            </label>
            <span className="em-compose-spacer" />
            <button type="button" className="em-icon-btn" aria-label="Discard reply" title="Discard"
              onClick={() => { c.setDraft(''); c.setTpl(null); setMode('shut'); }}>
              <Icon name="trash" size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One message of a thread, for a reader outside the Email tab (the dialer's Email card). */
export { Message as GmailMessage };
