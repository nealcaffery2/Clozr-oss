'use client';

// The record's Text tab: the SMS composer with the line picker, quick
// template chips, merge fields, a segment counter, emoji, and a split
// Send | clock. The clock writes to scheduled_messages (migration 367) the
// way the Inbox's Send later does. Photos and files ride along as MMS through
// the Inbox's own picker (talkr/MmsAttachments: shrink, upload to Talkr,
// lib/mms limits), and go on the same Talkr send.

import React, { useMemo, useRef, useState } from 'react';
import { Paperclip, Trash2 } from 'lucide-react';
import type { ClozrView } from '@/app/clozr/view';
import { SmsFromPicker } from '@/components/SmsFromPicker';
import { EmojiButton, insertAtCaret } from '@/app/components/talkr/EmojiPicker';
import { TemplatePicker } from '@/app/components/templates/TemplatePicker';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { scheduleProblem, sendsLabel } from '@/lib/inbox-schedule';
import { MMS_ACCEPT, MMS_MAX_FILES } from '@/lib/mms';
import { PendingAttachments, useMmsAttachments } from '@/app/components/talkr/MmsAttachments';
import { WhenMenu } from './WhenMenu';
import { MERGE_FIELDS, type MessageTemplate } from '@/lib/message-templates';
import { renderMerge } from '@/lib/sms';
import { getSmsFrom } from '@/lib/sms-from';
import { useScheduled } from '@/lib/use-scheduled';
import { smsSegments } from '@/lib/talkr-web/sequences';
import { useSession } from '@/lib/session';
import { primaryBtn } from './ui';

export type TextTarget = { kind: 'seller' | 'buyer'; name: string; phone: string; sellerId?: number | null; buyerId?: number | null };

export function TextCompose({ V, to, mergeFields, value, onChange, onSend, inputRef }: {
  V: ClozrView; to: TextTarget; mergeFields: Record<string, string>;
  value: string; onChange: (v: string) => void;
  /** Send now, with the merged body and any MMS urls. Resolves true once it went. */
  onSend: (body: string, mediaUrls: string[]) => Promise<boolean>;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const session = useSession();
  const workspaceId = V.templatesWorkspaceId ?? V.liveIds?.workspaceId ?? null;
  const templates = useTemplates(workspaceId);
  const scheduled = useScheduled(V.liveIds?.workspaceId ?? null);
  const own = useRef<HTMLTextAreaElement | null>(null);
  const ref = inputRef ?? own;
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const att = useMmsAttachments({ local: !V.talkrAuthed });
  const fileIn = useRef<HTMLInputElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const first = to.name.split(' ')[0];
  const merged = renderMerge(value, mergeFields);
  const seg = smsSegments(merged);
  const smsTemplates = useMemo(() => templates.templates.filter((t) => t.channel === 'sms' && (t.audience === to.kind || t.audience === 'general')).slice(0, 4), [templates.templates, to.kind]);
  const apply = (t: MessageTemplate) => { onChange(renderMerge(t.body_text, mergeFields)); setPicker(false); requestAnimationFrame(() => ref.current?.focus()); };
  const insert = (token: string) => onChange(insertAtCaret(ref.current, value, token));

  const sendNow = async () => {
    setErr(null);
    if (!to.phone) return setErr(`Add a phone number for ${first} first.`);
    if (!merged.trim() && !att.attachments.length) return setErr('Type a message or add a photo first.');
    setBusy(true);
    const ok = await onSend(merged, att.attachments.map((a) => a.url));
    setBusy(false);
    if (ok) { onChange(''); att.take(); }
  };
  const sendLater = async (at: Date | null): Promise<boolean> => {
    const problem = scheduleProblem(at);
    if (problem) { setErr(problem); return false; }
    if (!to.phone) { setErr(`Add a phone number for ${first} first.`); return false; }
    if (!merged.trim()) { setErr('Type a message first.'); return false; }
    if (!V.liveIds?.canWrite) { V.showToast(`${sendsLabel(at!)} (demo)`); onChange(''); att.clear(); return true; }
    setBusy(true);
    const e = await scheduled.schedule({ phone: to.phone, body: merged, sendAt: at!, fromPhoneNumberId: getSmsFrom(), sellerId: to.sellerId ?? null, buyerId: to.buyerId ?? null, media: att.attachments.map((a) => a.url) });
    setBusy(false);
    if (e) { setErr(e); return false; }
    V.showToast(`${sendsLabel(at!)} to ${to.name}`, 'success');
    onChange('');
    att.take();
    return true;
  };

  return (
    <div className="rec-compose-form" data-testid="record-text-compose">
      <div className="rec-email-quick" role="group" aria-label="Quick templates">
        {smsTemplates.map((t) => <button key={t.id} type="button" className="rec-qchip rec-press" onClick={() => apply(t)}>{t.name}</button>)}
        <button type="button" className="rec-qchip rec-press" aria-pressed={picker} onClick={() => setPicker((o) => !o)}>+ Custom</button>
        <span style={{ flex: 1 }} />
        <label className="rec-link" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          Insert field
          <select aria-label="Insert a merge field" value="" onChange={(e) => { if (e.target.value) insert(e.target.value); }} className="rec-field-sel">
            <option value="">…</option>
            {MERGE_FIELDS.map((f) => <option key={f.token} value={f.token}>{f.label}</option>)}
          </select>
        </label>
      </div>
      {picker ? (
        <TemplatePicker channel="sms" audience={to.kind} templates={templates.templates} team={templates.team} userId={session.user?.id ?? null}
          loading={templates.loading} error={templates.error} onPick={apply} onManage={() => setPicker(false)} onClose={() => setPicker(false)} />
      ) : null}
      <textarea ref={ref} className="dc17 rec-compose-box rec-text-box" aria-label={'Text to ' + first} placeholder={`Text ${first}…`} rows={3} value={value} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void sendNow(); } }} />
      <PendingAttachments attachments={att.attachments} uploading={att.uploading} onRemove={att.remove} className="rec-email-files rec-mms" />
      <div className="rec-compose-foot" style={{ marginTop: '6px' }}>
        <SmsFromPicker compact />
        <input ref={fileIn} type="file" accept={MMS_ACCEPT} multiple hidden aria-hidden onChange={(e) => { if (e.target.files?.length) void att.addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" className="rec-tool-btn" aria-label="Attach a photo or file" aria-pressed={att.attachments.length > 0} disabled={att.uploading || att.full}
          title={att.full ? `A text holds ${MMS_MAX_FILES} attachments at most` : 'Attach a photo, short video, PDF or contact card (sends as MMS, 3 MB each)'} onClick={() => fileIn.current?.click()}>
          <Paperclip size={14} aria-hidden />
        </button>
        <EmojiButton onPick={(e) => insert(e)} />
        <span className="rec-seg" style={{ color: seg.segments > 3 || seg.encoding === 'ucs2' ? 'var(--tx-amber, #b45309)' : 'var(--meta, #71717a)' }}>
          {seg.chars} chars · {seg.segments} segment{seg.segments === 1 ? '' : 's'}{seg.encoding === 'ucs2' ? ' · UCS-2' : ''}{att.attachments.length ? ` · MMS, ${att.attachments.length} ${att.attachments.length === 1 ? 'file' : 'files'}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="rec-tool-btn" aria-label="Clear the draft" title="Clear the draft" onClick={() => { onChange(''); setErr(null); }}><Trash2 size={14} aria-hidden /></button>
        <span className="rec-split-btn" style={{ position: 'relative' }}>
          <button type="button" className="dc3 rec-press" disabled={busy || !to.phone} title={!to.phone ? 'No phone on file' : undefined}
            style={{ ...primaryBtn, height: '30px', borderRadius: '8px 0 0 8px', opacity: busy || !to.phone ? 0.5 : 1 }} onClick={() => void sendNow()}>
            {busy ? 'Sending…' : 'Send text'}
          </button>
          <WhenMenu disabled={busy || !to.phone} title={!to.phone ? 'No phone on file' : 'Send later'} onPick={sendLater} />
        </span>
      </div>
      {err || att.error ? <p role="alert" className="rec-smart-hint" style={{ color: 'var(--tx-red, #b91c1c)', margin: '6px 0 0' }}>{err ?? att.error}</p> : null}
    </div>
  );
}
