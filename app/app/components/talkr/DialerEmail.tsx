'use client';

/**
 * The dialer card's Email tab: every email with whoever owns the number, drawn
 * as CLOZR's Gmail-style inbox draws mail (GmailRow for the list, the same
 * message layout for an open thread, gmail-inbox.css for both), and a
 * composer that sends through the inbox's own send path (useEmailComposer:
 * lib/google sendEmail, filed on the seller or buyer, replies kept in the
 * Gmail thread).
 *
 * Live, the history is the Gmail sync's (loadContactEmail) and sending needs
 * the rep's Gmail connected. The demo reads the sample record's email
 * (V.dialerEmailFor) and a send lands in the list locally.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { type EmailRow, type EmailThread, groupThreads, loadContactEmail, useThreadBodies } from '@/app/components/inbox/data';
import { useEmailComposer } from '@/app/components/inbox/useEmailComposer';
import type { MergeFor } from '@/app/components/inbox/types';
import { GmailRow } from '@/app/components/inbox/gmail/GmailRow';
import { GmailMessage } from '@/app/components/inbox/gmail/GmailThread';
import { GmailIcon } from '@/app/components/inbox/gmail/GmailIcon';
import { participantsOf } from '@/app/components/inbox/gmail/format';
import { useMailExtras } from '@/app/components/inbox/gmail/mail-extras';
import { EmailHtml } from '@/app/components/email/EmailHtml';
import { TemplatePicker } from '@/app/components/templates/TemplatePicker';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { useRep } from '@/app/components/record/QuickReach';
import { requestSettingsTab } from '@/app/clozr/screens/settingsTab';
import { type GoogleAccount, GOOGLE_SCOPE, googleStatus, granted } from '@/lib/google';
import { fieldsFor, renderMerge } from '@/lib/sms';
import { useSession } from '@/lib/session';
import { Icon } from './Icon';
import { Button } from './ui';
import '@/app/clozr/talkr-inbox.css';
import '@/app/clozr/gmail-inbox.css';

type Info = NonNullable<ReturnType<ClozrView['dialerEmailFor']>>;
type View = { kind: 'list' } | { kind: 'thread'; key: string } | { kind: 'compose'; key: string | null };

const noop = () => undefined;

export function DialerEmail({ V, phone, name, onManage }: { V: ClozrView; phone: string; name: string; onManage: () => void }) {
  const info = V.dialerEmailFor(phone);
  const first = name.split(' ')[0] || name;

  if (!info) {
    return (
      <div className="dial-mail-empty">
        <Icon name="mail" size={20} />
        <p className="dial-mail-empty-title">No email to write to</p>
        <p>This number is not on a CLOZR record, so there is no address on file. Save it as a seller or buyer to email them from here.</p>
      </div>
    );
  }
  if (!info.email) {
    return (
      <div className="dial-mail-empty">
        <Icon name="mail" size={20} />
        <p className="dial-mail-empty-title">No email address for {first} yet</p>
        <p>Add one on the {info.kind === 'seller' ? 'seller' : 'buyer'} record and their email shows here, with a box to write to them.</p>
        <Button tone="ghost" onClick={info.open}>Open {first}’s record</Button>
      </div>
    );
  }
  return <Mailbox key={info.email} V={V} info={info} onManage={onManage} />;
}

function Mailbox({ V, info, onManage }: { V: ClozrView; info: Info; onManage: () => void }) {
  const ws = V.liveIds?.workspaceId ?? null;
  const demo = ws === null;
  const first = info.name.split(' ')[0] || info.name;

  // The history: the Gmail sync's rows live, the sample record's in the demo.
  const [rows, setRows] = useState<EmailRow[] | null>(demo ? info.sample : null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { email, sellerId, buyerId } = info;
  useEffect(() => {
    if (demo || ws === null) return;
    let on = true;
    void loadContactEmail(ws, { email, sellerId, buyerId }).then((r) => {
      if (!on) return;
      if (r.error) setError(r.error);
      else { setRows(r.rows); setError(null); }
    });
    return () => { on = false; };
  }, [demo, ws, email, sellerId, buyerId, tick]);
  // Sent from here in the demo, where nothing reaches Gmail.
  const [local, setLocal] = useState<EmailRow[]>([]);
  const threads = useMemo(() => groupThreads([...(rows ?? []), ...local]), [rows, local]);

  // Whether Gmail can send as this rep (the same test useEmail makes).
  const [account, setAccount] = useState<GoogleAccount | null | undefined>(demo ? null : undefined);
  useEffect(() => {
    if (demo || ws === null) return;
    let on = true;
    void googleStatus(ws).then((r) => { if (on) setAccount(r.ok ? r.data.account : null); });
    return () => { on = false; };
  }, [demo, ws]);
  const canSend = demo || (!!account && account.status === 'active' && account.gmail_send && granted(account, GOOGLE_SCOPE.gmailSend));

  const [view, setView] = useState<View>({ kind: 'list' });
  const open = view.kind !== 'list' && view.key ? threads.find((t) => t.key === view.key) ?? null : null;
  const recordFor = V.recordForContact;

  const sent = useCallback((row: EmailRow | null) => {
    if (row) setLocal((cur) => [...cur, row]);
    else setTick((n) => n + 1);
    setView({ kind: 'list' });
  }, []);

  if (view.kind === 'compose') {
    return (
      <div className="talkr-inbox dial-mail">
        <div className="email-tab">
          <Composer
            key={view.key ?? 'new'} V={V} info={info} thread={open} ws={ws} canSend={canSend} account={account}
            onManage={onManage} onDone={sent} onCancel={() => setView(open ? { kind: 'thread', key: open.key } : { kind: 'list' })}
          />
        </div>
      </div>
    );
  }

  if (view.kind === 'thread' && open) {
    return (
      <div className="talkr-inbox dial-mail">
        <div className="email-tab">
          <Reader thread={open} ws={ws} demo={demo} mine={account?.email ?? null} toast={V.showToast}
            onBack={() => setView({ kind: 'list' })} onReply={() => setView({ kind: 'compose', key: open.key })} />
        </div>
      </div>
    );
  }

  return (
    <div className="talkr-inbox dial-mail">
      <div className="email-tab">
        <div className="em-toolbar dial-mail-bar">
          <span className="dial-mail-who" title={info.email}>
            {rows === null && !error ? 'Loading email…' : `${threads.length} ${threads.length === 1 ? 'conversation' : 'conversations'} with`} <b>{info.email}</b>
          </span>
          <Button tone="accent" onClick={() => setView({ kind: 'compose', key: null })}>
            <Icon name="edit" size={14} /> Compose
          </Button>
        </div>
        {error ? (
          <p role="alert" className="em-notice dial-mail-err">Could not load email with {first}: {error}. It is still in the Inbox under Email.</p>
        ) : rows === null ? (
          <p role="status" className="em-empty">Loading email with {first}…</p>
        ) : threads.length === 0 ? (
          <div className="dial-mail-empty">
            <p className="dial-mail-empty-title">No email with {first} yet</p>
            <p>Mail you send from here, or from Gmail, shows up in this list once Gmail syncs it.</p>
            <Button tone="ghost" onClick={() => setView({ kind: 'compose', key: null })}>Write the first email</Button>
          </div>
        ) : (
          <div aria-label={`Email with ${info.name}`}>
            {threads.map((t) => (
              <GmailRow
                key={t.key}
                thread={t}
                senders={participantsOf(t, recordFor)}
                unread={false}
                starred={false}
                checked={false}
                onOpen={() => setView({ kind: 'thread', key: t.key })}
                onCheck={noop} onStar={noop} onArchive={noop} onToggleRead={noop}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One thread, open: the subject, then every message as the Email tab shows it. */
function Reader({ thread: listed, ws, demo, mine, toast, onBack, onReply }: {
  thread: EmailThread; ws: number | null; demo: boolean; mine: string | null; toast: (m: string) => void;
  onBack: () => void; onReply: () => void;
}) {
  const thread = useThreadBodies(listed);
  const ids = useMemo(() => (demo ? [] : thread.rows.map((r) => r.id)), [demo, thread.rows]);
  const { files, receipts } = useMailExtras(ids, 0, demo ? null : ws);
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const last = thread.rows.length - 1;
  const fileProps = { workspaceId: ws ?? 0, canSave: false, toast, onSaved: noop };
  return (
    <div className="em-read">
      <div className="em-toolbar">
        <button type="button" aria-label="Back to the list" title="Back" className="em-icon-btn" onClick={onBack}>
          <GmailIcon name="arrow_back" />
        </button>
        <span className="dial-mail-count">{thread.rows.length} {thread.rows.length === 1 ? 'message' : 'messages'}</span>
      </div>
      <header className="em-read-head">
        <h3 className="em-read-subject">{thread.subject || '(no subject)'}</h3>
      </header>
      {thread.rows.map((r, i) => (
        <GmailMessage
          key={r.id}
          row={r}
          mine={mine}
          files={files.get(r.id) ?? []}
          receipt={receipts.get(r.id)}
          fileProps={fileProps}
          single={thread.rows.length === 1}
          open={i === last || !!opened[r.id]}
          onToggle={() => setOpened((o) => ({ ...o, [r.id]: !o[r.id] }))}
        />
      ))}
      <div className="em-reply-row">
        <Button tone="ghost" onClick={onReply}>
          <GmailIcon name="reply" size={16} /> Reply
        </Button>
      </div>
    </div>
  );
}

/** A new email or a reply: To, Subject, the body or a template, Send. */
function Composer({ V, info, thread, ws, canSend, account, onManage, onDone, onCancel }: {
  V: ClozrView; info: Info; thread: EmailThread | null; ws: number | null; canSend: boolean;
  account: GoogleAccount | null | undefined; onManage: () => void;
  onDone: (local: EmailRow | null) => void; onCancel: () => void;
}) {
  const demo = ws === null;
  const rep = useRep(V);
  const session = useSession();
  const templates = useTemplates(ws);
  const mergeFor = useCallback<MergeFor>(
    (rec, name, to) => fieldsFor(rec?.recipient ?? { sellerId: null, name, phone: null, email: to }, { ...rep, repEmail: account?.email ?? rep.repEmail }, to),
    [rep, account?.email],
  );
  const c = useEmailComposer({
    thread, workspaceId: ws ?? 0, recordFor: V.recordForContact, mergeFor, toast: V.showToast,
    onSent: () => onDone(null), mine: account?.email ?? null, initialTo: info.email,
  });
  const first = info.name.split(' ')[0] || info.name;
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { (thread ? bodyRef : subjectRef).current?.focus(); }, [thread]);

  const send = () => {
    if (!demo) return void c.send();
    // The demo: the same checks, and the email joins the list instead of Gmail.
    if (!c.subject.trim()) return V.showToast('Add a subject');
    const text = c.rendered ? c.rendered.text : renderMerge(c.draft, mergeFor(c.rec, info.name, info.email));
    if (!text.trim()) return V.showToast('Write something first');
    V.showToast(`Email sent to ${first} (demo)`);
    onDone({
      id: -Date.now(), seller_id: info.sellerId, buyer_id: info.buyerId, deal_id: null, direction: 'outbound',
      occurred_at: new Date().toISOString(), subject: c.subject.trim(), body: c.rendered?.html ?? text, preview: null,
      from_email: 'you@yourcompany.com', to_email: info.email, status: 'sent', source: 'sample', source_id: `sample:sent:${Date.now()}`,
    });
  };

  return (
    <div className="em-read">
      <div className="em-toolbar">
        <button type="button" aria-label={thread ? 'Back to the thread' : 'Back to the list'} title="Back" className="em-icon-btn" onClick={onCancel}>
          <GmailIcon name="arrow_back" />
        </button>
        <span className="dial-mail-count">{thread ? `Reply · ${thread.subject}` : `New email to ${first}`}</span>
      </div>
      {!canSend ? (
        <div className="em-connect dial-mail-connect">
          <p>{account === undefined
            ? 'Checking your Gmail connection…'
            : account
              ? 'Gmail sending is off for your connection. Switch it on in Settings to send email from your own address.'
              : 'Connect Gmail in Settings to send email.'}</p>
          {account !== undefined ? (
            <Button tone="ghost" onClick={() => { requestSettingsTab({ main: 'outbound', tab: 'google' }); V.goSettings(); }}>
              Open Gmail settings
            </Button>
          ) : null}
        </div>
      ) : (
        // A div, not a form: Enter in the template search must not send the email.
        <div className="em-composer dial-mail-composer" role="group" aria-label={thread ? `Reply to ${first}` : `New email to ${first}`}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}>
          <div className="em-compose-to">To <b>{info.name}</b> &lt;{c.to}&gt;</div>
          <label className="sr-only" htmlFor="dial-mail-subject">Subject</label>
          <input id="dial-mail-subject" ref={subjectRef} className="em-field" value={c.subject} onChange={(e) => c.setSubject(e.target.value)} placeholder="Subject" />
          {c.tpl && c.rendered?.html ? (
            <>
              <div className="em-tpl">
                <GmailIcon name="label" size={14} />
                <span>Template: {c.tpl.name} · filled for {first}</span>
                <button type="button" onClick={() => c.setTpl(null)}>Remove</button>
              </div>
              <EmailHtml html={c.rendered.html} title="Email preview" scrollHeight={220} />
            </>
          ) : (
            <>
              <label className="sr-only" htmlFor="dial-mail-body">Email body</label>
              <textarea id="dial-mail-body" ref={bodyRef} className="em-body-input" value={c.draft} onChange={(e) => c.setDraft(e.target.value)}
                rows={7} placeholder={thread ? `Reply to ${first}` : `Write to ${first}`} />
            </>
          )}
          {c.pickerOpen ? (
            <div className="dial-tpl">
              <TemplatePicker
                channel="email" audience={info.kind} templates={templates.templates} team={templates.team}
                userId={session.user?.id ?? null} loading={templates.loading} error={templates.error}
                onPick={c.pick} onClose={() => c.setPickerOpen(false)}
                onManage={() => { c.setPickerOpen(false); onManage(); }}
              />
            </div>
          ) : null}
          {c.err ? <p role="alert" className="em-err">{c.err}</p> : null}
          <div className="em-compose-foot">
            <Button tone="accent" onClick={send} disabled={c.sending || (!c.draft.trim() && !c.tpl)} style={{ minHeight: 36, padding: '9px 18px' }}>
              <Icon name="send" size={14} /> {c.sending ? 'Sending…' : 'Send'}
            </Button>
            <button type="button" className="tray-btn" aria-expanded={c.pickerOpen} onClick={() => c.setPickerOpen(!c.pickerOpen)}>
              <Icon name="template" size={14} /> Templates
            </button>
            <span className="em-compose-spacer" />
            <span className="dial-mail-hint">⌘ Enter sends</span>
            <button type="button" className="em-icon-btn" aria-label="Discard this email" title="Discard" onClick={() => { c.setDraft(''); c.setTpl(null); onCancel(); }}>
              <Icon name="trash" size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
