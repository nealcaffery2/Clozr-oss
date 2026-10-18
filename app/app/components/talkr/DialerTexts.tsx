'use client';

/**
 * The dialer's messages card: whoever is on the line, or the number typed, as
 * a text thread with a full composer under it, and an Email tab beside it, so
 * a rep can text or email during or right after a call without leaving the
 * dialer for the inbox.
 *
 * Text. Live, the thread is Talkr's (the same conversation the inbox shows),
 * kept fresh by the softphone's event stream. A send goes through lib/sms
 * textOne, the path every CLOZR text takes: the blacklist check, the line the
 * rep picked (SmsFromPicker), MMS attachments, and the copy filed on the
 * record. The composer carries what QuickReach and the inbox thread carry:
 * CLOZR templates with merge fields filled for this contact, emoji, photo and
 * file attachments (lib/mms limits), and "Save as template". Enter sends,
 * Shift+Enter breaks the line; the dial box ignores keys typed in a field
 * (DialerParts' window handler skips INPUT, TEXTAREA and SELECT).
 *
 * Email. DialerEmail, in the Gmail-style inbox's own look.
 *
 * Without Talkr (the demo, a rep Talkr does not know) the card shows the texts
 * on the record, and a send, attachments included, stays in the browser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { api, type MessageDto } from '@/lib/talkr-web/api';
import { type TalkrEvent, eventFacts, messageFromEvent, onTalkrEvent, useTalkrEvents } from '@/lib/talkr-events';
import { useLinkViews } from '@/app/components/inbox/receipts';
import { fieldsFor, renderMerge, textOne } from '@/lib/sms';
import { type AttachmentKind, MMS_ACCEPT, kindFromUrl } from '@/lib/mms';
import { type Audience, type MessageTemplate, saveTemplate } from '@/lib/message-templates';
import { formatPhone, toE164 } from '@/lib/talkr-web/time';
import { useSession } from '@/lib/session';
import { type Role, isAdmin } from '@/lib/team';
import { SmsFromPicker } from '@/components/SmsFromPicker';
import { TemplatePicker } from '@/app/components/templates/TemplatePicker';
import { TemplatesManager } from '@/app/components/templates/TemplatesManager';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { useRep } from '@/app/components/record/QuickReach';
import { useSoftphone } from './softphoneAdapter';
import { Bubble } from './Bubble';
import { EmojiButton, insertAtCaret } from './EmojiPicker';
import { MmsImage, PendingAttachments, useMmsAttachments } from './MmsAttachments';
import { DialerEmail } from './DialerEmail';
import { IosSegmented } from './ios';
import { Icon } from './Icon';
import { Card } from './ui';
import { smsShownStatus } from '@/lib/sms-receipt';

type Media = { url: string; kind: AttachmentKind; name?: string };
type Line = { id: string; dir: 'in' | 'out'; body: string; time: string; status?: string; media?: Media[] };
type Mode = 'text' | 'email';

const RECEIPT: Record<string, string> = {
  queued: 'Sending…', sending: 'Sending…', sent: 'Sent', delivered: 'Delivered', undelivered: 'Not delivered', failed: 'Not delivered',
};

const clock = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const toLine = (m: MessageDto): Line => ({
  id: m.id, dir: m.direction === 'inbound' ? 'in' : 'out', body: m.body, time: clock(m.sent_at ?? m.created_at), status: smsShownStatus(m.status, m.sent_at ?? m.created_at),
  media: m.media_urls.map((url) => ({ url, kind: kindFromUrl(url) })),
});

// The tab the rep last used, kept while they move from one number to the next.
let lastMode: Mode = 'text';

export function DialerTexts({ V, phone }: { V: ClozrView; phone: string }) {
  const e164 = toE164(phone);
  const onRecord = V.dialerTextsFor(e164);
  const name = onRecord.name || V.dialerRecordFor(e164)?.name || formatPhone(e164);
  const [mode, setModeState] = useState<Mode>(lastMode);
  const [emailSeen, setEmailSeen] = useState(lastMode === 'email');
  const setMode = (m: Mode) => { lastMode = m; setModeState(m); if (m === 'email') setEmailSeen(true); };

  // The Templates manager, opened from either tab's picker.
  const session = useSession();
  const ws = V.templatesWorkspaceId ?? null;
  const templates = useTemplates(ws);
  const [manager, setManager] = useState<'sms' | 'email' | null>(null);
  const rep = useRep(V);
  const { authed } = useSoftphone();
  const manage = useCallback((channel: 'sms' | 'email') => {
    if (ws === null) return V.showToast('Templates are kept on a signed-in workspace. The demo shows the samples.');
    setManager(channel);
  }, [ws, V]);

  if (!e164) return null;
  const idBase = 'dial-msg';
  return (
    <Card className="dial-texts flex flex-col" padded={false}>
      <div className="dial-texts-head">
        <Icon name={mode === 'text' ? 'msg' : 'mail'} size={17} className="dial-texts-icon" />
        <h2 className="dial-texts-title" title={name}>{name}</h2>
        <IosSegmented
          idBase={idBase}
          ariaLabel={`Message ${name} by`}
          value={mode}
          onChange={setMode}
          options={[{ value: 'text', label: 'Text' }, { value: 'email', label: 'Email' }]}
        />
        <button type="button" className="dial-link" onClick={() => V.goInbox()} title={`Open ${mode === 'text' ? 'texts' : 'email'} in the inbox`}>
          Open in inbox
        </button>
      </div>
      {/* Both panels stay mounted once opened, so a half-written text or email
          survives a look at the other tab. Email is read on first visit. */}
      <div id={`${idBase}-panel-text`} role="tabpanel" aria-labelledby={`${idBase}-tab-text`} hidden={mode !== 'text'} className="min-w-0 flex-col" style={{ display: mode === 'text' ? 'flex' : 'none' }}>
        <TextPane key={e164} V={V} e164={e164} name={name} onRecord={onRecord} templates={templates} onManage={() => manage('sms')} />
      </div>
      <div id={`${idBase}-panel-email`} role="tabpanel" aria-labelledby={`${idBase}-tab-email`} hidden={mode !== 'email'} className="min-w-0 flex-col" style={{ display: mode === 'email' ? 'flex' : 'none' }}>
        {(mode === 'email' || emailSeen) && <DialerEmail key={e164} V={V} phone={e164} name={name} onManage={() => manage('email')} />}
      </div>
      {manager && ws !== null && (
        <TemplatesManager
          data={templates} userId={session.user?.id ?? null} isAdmin={isAdmin(session.workspace?.role as Role | undefined)} talkrAuthed={authed}
          initialChannel={manager}
          ctx={{
            workspaceId: ws, toast: V.showToast, testTo: null,
            rep: Object.fromEntries(Object.entries({ rep_name: rep.repName, rep_phone: rep.repPhone, rep_email: rep.repEmail, company: rep.company ?? '' }).filter(([, v]) => v)),
          }}
          onClose={() => setManager(null)}
        />
      )}
    </Card>
  );
}

function TextPane({ V, e164, name, onRecord, templates, onManage }: {
  V: ClozrView; e164: string; name: string;
  onRecord: ReturnType<ClozrView['dialerTextsFor']>;
  templates: ReturnType<typeof useTemplates>;
  onManage: () => void;
}) {
  const { authed } = useSoftphone();
  const first = name.split(' ')[0] || name;
  const ws = V.templatesWorkspaceId ?? null;
  const local = !authed || ws === null;

  // Talkr's thread for this number, when Talkr knows the rep.
  const [convId, setConvId] = useState<string | null>(null);
  const [live, setLive] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const convRef = useRef<string | null>(null);
  convRef.current = convId;

  const readThread = useCallback((id: string) => {
    api.listConversationMessages(id).then(
      (r) => { setLive(r.messages.map(toLine)); setError(null); },
      () => setError('Could not load this thread. It is still in the inbox.'),
    );
  }, []);

  useEffect(() => {
    setConvId(null);
    setLive(null);
    setError(null);
    if (!authed || !e164) return;
    let on = true;
    const digits = e164.replace(/\D/g, '').slice(-10);
    api.listConversations({ q: digits, limit: 5 }).then(
      (r) => {
        if (!on) return;
        const hit = r.conversations.find((c) => toE164(c.their_number) === e164);
        if (hit) { setConvId(hit.id); readThread(hit.id); } else setLive([]);
      },
      () => { if (on) setError('Could not load texts for this number.'); },
    );
    return () => { on = false; };
  }, [authed, e164, readThread]);

  // A text in or a receipt: re-read the open thread (one read per burst).
  const onEvents = useCallback((events: TalkrEvent[]) => {
    const id = convRef.current;
    if (!id) return;
    if (events.some((ev) => { const c = eventFacts(ev).conversationId; return c ? c === id : ev.type === 'message.updated'; })) readThread(id);
  }, [readThread]);
  useTalkrEvents(authed && !!convId, ['message.received', 'message.updated'], onEvents);
  // A reply draws the moment the stream carries it; the re-read above replaces it.
  useEffect(() => (authed ? onTalkrEvent((ev) => {
    const m = ev.type === 'message.received' ? messageFromEvent(ev) : null;
    const id = convRef.current;
    if (m && id && m.conversation_id === id) setLive((cur) => (cur && !cur.some((l) => l.id === m.id) ? [...cur, toLine({ ...m, error_code: null, failure_class: 'none', is_auto_reply: false, delivered_at: null, failed_at: null })] : cur));
  }) : undefined), [authed]);
  // "Viewed 2:14 PM" on a text whose CLOZR link was opened.
  const views = useLinkViews((live ?? []).filter((l) => l.dir === 'out').map((l) => l.body), V.liveIds?.workspaceId ?? null);

  // Sent here this session, before the thread re-read brings them back.
  const [mine, setMine] = useState<Line[]>([]);
  useEffect(() => setMine([]), [e164]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const att = useMmsAttachments({ local });

  // Merge fields for this contact, the way QuickReach fills them.
  const rep = useRep(V);
  const recipient = onRecord.recipient ?? { sellerId: null, name, phone: e164 };
  const fields = () => fieldsFor(recipient, rep, e164);
  const audience: Audience = recipient.buyerId ? 'buyer' : recipient.sellerId ? 'seller' : 'general';

  // Templates: CLOZR's, plus any saved here in the demo.
  const session = useSession();
  const [tplOpen, setTplOpen] = useState(false);
  const [saved, setSaved] = useState<MessageTemplate[]>([]);
  const [saving, setSaving] = useState<{ name: string; busy: boolean } | null>(null);
  const pick = (t: MessageTemplate) => {
    setDraft(renderMerge(t.body_text, fields()));
    setTplOpen(false);
    requestAnimationFrame(() => textRef.current?.focus());
  };
  const saveAsTemplate = async () => {
    if (!saving || saving.busy) return;
    const tplName = saving.name.trim();
    if (!tplName || !draft.trim()) return;
    if (ws === null) {
      setSaved((cur) => [...cur, {
        id: -100 - cur.length, workspace_id: 0, owner_id: 'demo', shared: false, channel: 'sms', audience, category: null,
        name: tplName, subject: null, body_text: draft, body_html: null, blocks: null, merge_fields: [], archived_at: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }]);
      setSaving(null);
      return V.showToast(`Saved “${tplName}” (demo)`);
    }
    setSaving({ name: saving.name, busy: true });
    const r = await saveTemplate(ws, { name: tplName, channel: 'sms', audience, category: null, subject: null, body_text: draft, body_html: null, blocks: null, shared: false });
    if (!r.ok) { setSaving({ name: saving.name, busy: false }); return V.showToast(r.message, 'error'); }
    setSaving(null);
    templates.reload();
    V.showToast(`Saved “${r.data.name}” to your SMS templates`);
  };

  const lines: Line[] = [...(live ?? onRecord.texts), ...mine.filter((m) => !(live ?? []).some((l) => l.id === m.id))];
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => { tail.current?.scrollTo({ top: tail.current.scrollHeight }); }, [lines.length]);
  const lastOut = lines.map((l) => l.dir).lastIndexOf('out');
  const canSend = !busy && !att.uploading && (draft.trim().length > 0 || att.attachments.length > 0);

  const send = async () => {
    const body = draft.trim();
    if (!canSend || !e164) return;
    if (local || ws === null) {
      // Sample data: nothing leaves the building.
      const taken = att.take();
      setMine((m) => [...m, {
        id: 'demo' + Date.now(), dir: 'out', body: renderMerge(body, fields()), time: 'Just now', status: 'sent',
        media: taken.map((a) => ({ url: a.url, kind: a.kind, name: a.name })),
      }]);
      setDraft('');
      V.showToast('Text sent to ' + first + ' (demo)');
      return;
    }
    setBusy(true);
    const media = att.attachments;
    const r = await textOne(ws, recipient, body, { ...rep, mediaUrls: media.map((a) => a.url), carrier: 'reply' });
    setBusy(false);
    if (r.error) { V.showToast(r.error, 'error'); return; }
    setDraft('');
    for (const a of att.take()) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setMine((m) => [...m, {
      id: r.messageId ?? 'sent' + Date.now(), dir: 'out', body: renderMerge(body, fields()), time: 'Just now', status: r.status,
      media: media.map((a) => ({ url: a.url, kind: a.kind, name: a.name })),
    }]);
    if (convRef.current) readThread(convRef.current);
    else if (e164) {
      // A first text starts the thread: find it so receipts and replies land here.
      api.listConversations({ q: e164.replace(/\D/g, '').slice(-10), limit: 5 }).then((res) => {
        const hit = res.conversations.find((c) => toE164(c.their_number) === e164);
        if (hit) { setConvId(hit.id); readThread(hit.id); }
      }, () => undefined);
    }
  };

  return (
    <>
      <div ref={tail} role="log" aria-label={`Texts with ${name}`} className="dial-thread flex max-h-80 min-h-[120px] flex-col overflow-auto px-4 py-3">
        {error && <p role="alert" className="dial-note-text" style={{ color: 'var(--red)' }}>{error}</p>}
        {!error && authed && live === null && <p role="status" className="dial-note-text">Loading texts…</p>}
        {!error && (live !== null || !authed) && lines.length === 0 && (
          <p className="dial-note-text">No texts with {first} yet. Write the first one below.</p>
        )}
        {lines.map((l, i) => {
          const out = l.dir === 'out';
          return (
            <Bubble
              key={l.id}
              mine={out}
              background="var(--sms-thread, #fff)"
              maxWidth="78%"
              receipt={<>{l.time}{i === lastOut && l.status && RECEIPT[l.status] ? ` · ${RECEIPT[l.status]}` : ''}{out && views.label(l.body) ? ` · ${views.label(l.body)}` : ''}</>}
            >
              {l.media?.length ? (
                <span className="mb-1.5 flex flex-col gap-1.5">
                  {l.media.map((m) => <MmsImage key={m.url} url={m.url} mine={out} kind={m.kind} name={m.name} />)}
                </span>
              ) : null}
              {l.body}
            </Bubble>
          );
        })}
      </div>

      <div className="dial-composer">
        {tplOpen && (
          <div className="dial-tpl">
            <TemplatePicker
              channel="sms" audience={audience} templates={[...templates.templates, ...saved]} team={templates.team}
              userId={session.user?.id ?? null} loading={templates.loading} error={templates.error}
              onPick={pick} onClose={() => setTplOpen(false)} onManage={() => { setTplOpen(false); onManage(); }}
            />
          </div>
        )}
        {saving && (
          <div className="dial-save-tpl">
            <label htmlFor="dial-tpl-name" className="dial-label">Save this text as an SMS template</label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="dial-tpl-name" className="dial-input min-w-0 flex-1" value={saving.name} autoFocus
                onChange={(e) => setSaving({ ...saving, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void saveAsTemplate(); }
                  if (e.key === 'Escape') { e.preventDefault(); setSaving(null); }
                }}
                placeholder="Template name, e.g. Day-2 follow-up"
              />
              <button type="button" className="dial-btn is-primary" disabled={saving.busy || !saving.name.trim()} onClick={() => void saveAsTemplate()}>
                {saving.busy ? 'Saving…' : 'Save template'}
              </button>
              <button type="button" className="dial-btn" onClick={() => setSaving(null)}>Cancel</button>
            </div>
            <p className="dial-hint">It saves the words as typed. Put {'{{first_name}}'} where the name goes so it fills in for the next person.</p>
          </div>
        )}

        <PendingAttachments attachments={att.attachments} uploading={att.uploading} onRemove={att.remove} className="flex flex-wrap items-center gap-2.5 px-1 pt-2" />
        {att.error && <p role="alert" className="dial-note-text px-1" style={{ color: 'var(--red)' }}>{att.error}</p>}

        <form className="flex items-end gap-2" onSubmit={(ev) => { ev.preventDefault(); void send(); }}>
          <label className="sr-only" htmlFor="dial-text-draft">Text {name}</label>
          <textarea
            id="dial-text-draft"
            ref={textRef}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(); } }}
            rows={1}
            placeholder={att.attachments.length ? 'Add a caption (optional)' : `Text ${first}…`}
            className="dial-compose min-w-0 flex-1"
          />
          <button type="submit" className="dial-send" disabled={!canSend} aria-label={busy ? 'Sending…' : 'Send text'} title="Send (Enter). Shift+Enter starts a new line.">
            <Icon name="send" size={16} />
          </button>
        </form>

        <div className="dial-tools" role="toolbar" aria-label="Text tools">
          <button type="button" className="dial-tool" aria-expanded={tplOpen} onClick={() => { setTplOpen((v) => !v); setSaving(null); }}>
            <Icon name="template" size={14} /> Templates
          </button>
          <EmojiButton onPick={(emoji) => setDraft(insertAtCaret(textRef.current, draft, emoji))} />
          <button
            type="button" className="dial-tool" disabled={att.uploading || att.full}
            title={att.full ? 'A text holds 10 attachments at most' : 'Attach a photo, short video, PDF or contact card (MMS, 3 MB each)'}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="paperclip" size={14} /> {att.uploading ? 'Uploading…' : 'Attach'}
          </button>
          <input
            ref={fileRef} type="file" accept={MMS_ACCEPT} multiple hidden
            onChange={(e) => { if (e.target.files?.length) void att.addFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            type="button" className="dial-tool" disabled={!draft.trim()} aria-expanded={!!saving}
            title={draft.trim() ? 'Keep this text as a template' : 'Write the text first'}
            onClick={() => { setSaving(saving ? null : { name: '', busy: false }); setTplOpen(false); }}
          >
            <Icon name="plus" size={14} /> Save as template
          </button>
          <span className="dial-tools-from"><SmsFromPicker compact /></span>
        </div>
      </div>
    </>
  );
}
