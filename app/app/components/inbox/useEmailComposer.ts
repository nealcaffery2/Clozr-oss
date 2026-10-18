'use client';

// Everything needed to answer a thread, with no opinion about how it looks.
//
// This is lifted out of EmailThreadPane unchanged, because two panes now write
// email — the original, and the Gmail one — and the send path is the part that
// must not be written twice. It carries the address and subject seeding, the
// template picker's merge-field rendering, the in-reply-to header that keeps a
// reply in the same Gmail thread, and the seller/buyer ids that file the sent
// copy against the right record. A second implementation of any of those would
// drift, and the drift would be invisible until a reply threaded wrong or
// filed nowhere.
//
// What the caller supplies is the markup. What it gets back is the state, the
// errors, and `send`.

import { useMemo, useState } from 'react';
import { type MessageTemplate, renderEmail } from '@/lib/message-templates';
import { renderMerge } from '@/lib/sms';
import { type OutgoingFile, sendEmail, uploadOutgoing } from '@/lib/google';
import { type EmailThread, type RecordFor, baseSubject } from './data';
import { useCanWrite } from '@/lib/read-only-context';
import { READ_ONLY_MESSAGE } from '@/lib/read-only';
import type { MergeFor } from './types';

export type EmailComposer = ReturnType<typeof useEmailComposer>;

/** A file waiting to go out: uploaded from this device, already on the deal, or on an email being forwarded. */
export type PendingFile =
  | { kind: 'upload'; key: string; name: string; size: number; file: OutgoingFile }
  | { kind: 'deal'; key: string; name: string; size: number | null; id: number }
  | { kind: 'email'; key: string; name: string; size: number | null; id: number };

const splitAddrs = (s: string | null | undefined) => (s ?? '').split(',').map((a) => a.trim().toLowerCase()).filter((a) => a.includes('@'));

export function useEmailComposer({ thread, workspaceId, recordFor, mergeFor, toast, onSent, mine, dealId, initialTo }: {
  thread: EmailThread | null;
  workspaceId: number;
  recordFor?: RecordFor;
  mergeFor: MergeFor;
  toast: (msg: string) => void;
  onSent: (key: string) => void;
  /** The sender's own address, left out of Reply all. */
  mine?: string | null;
  /** File the send on this deal (a deal folder, or the thread's deal). */
  dealId?: number | null;
  /** A new email's address when there is no thread to reply to (the dialer's Email tab). */
  initialTo?: string;
}) {
  const [to, setTo] = useState(thread?.counterpart ?? initialTo ?? '');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCopies, setShowCopies] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(0);
  const [track, setTrack] = useState(true);
  const [subject, setSubject] = useState(thread ? `Re: ${thread.subject}` : '');
  const [draft, setDraft] = useState('');
  const [tpl, setTpl] = useState<MessageTemplate | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A View-as preview sends nothing and uploads nothing; say so in the box.
  const canWrite = useCanWrite();

  const rec = to.includes('@') ? recordFor?.(to) ?? null : null;
  const name = rec?.name ?? thread?.counterpart ?? to ?? '';
  const fields = useMemo(() => mergeFor(rec, name, to), [mergeFor, rec, name, to]);
  const rendered = tpl ? renderEmail(tpl, fields) : null;

  /** A template with HTML is sent as-is; a text one fills the draft so it can be edited. */
  const pick = (t: MessageTemplate) => {
    setTpl(t.body_html ? t : null);
    if (!t.body_html) setDraft(renderMerge(t.body_text, fields));
    const s = renderMerge(t.subject ?? '', fields);
    if (s && !thread) setSubject(s);
    setPickerOpen(false);
  };

  /** Everyone else on the newest message goes on Cc; the sender and the To address stay off it. */
  const replyAll = () => {
    const lastRow = thread?.last;
    if (!lastRow) return;
    const me = (mine ?? '').toLowerCase();
    const main = (thread?.counterpart ?? '').toLowerCase();
    const others = Array.from(new Set([...splitAddrs(lastRow.from_email), ...splitAddrs(lastRow.to_email), ...splitAddrs(lastRow.cc_email)]))
      .filter((a) => a !== me && a !== main);
    setCc(others.join(', '));
    if (others.length) setShowCopies(true);
  };

  /** Upload picked files now, so Send only has to name them. */
  const addFiles = async (list: FileList | File[]) => {
    const picked = Array.from(list);
    if (!picked.length) return;
    if (!canWrite) return setErr(READ_ONLY_MESSAGE);
    setUploading((n) => n + picked.length);
    await Promise.all(picked.map(async (f) => {
      const r = await uploadOutgoing(workspaceId, f);
      setUploading((n) => n - 1);
      if (!r.ok) { setErr(r.message); return; }
      setFiles((prev) => [...prev, { kind: 'upload', key: r.data.storage_path, name: f.name, size: f.size, file: r.data }]);
    }));
  };
  const attach = (f: PendingFile) => setFiles((prev) => (prev.some((x) => x.key === f.key) ? prev : [...prev, f]));
  const detach = (key: string) => setFiles((prev) => prev.filter((f) => f.key !== key));

  const send = async () => {
    if (sending) return;
    if (!canWrite) return setErr(READ_ONLY_MESSAGE);
    setErr(null);
    if (!to.includes('@')) return setErr('Who is this to? Enter an email address.');
    if (!subject.trim()) return setErr('Add a subject.');
    const text = rendered ? rendered.text : renderMerge(draft, fields);
    if (!text.trim() && !rendered?.html) return setErr('Write something first.');
    if (uploading) return setErr('Still uploading a file — one moment.');
    setSending(true);
    // The newest message id in the thread, which is what makes Gmail file the
    // reply under it rather than starting a conversation of its own.
    const inReplyTo = [...(thread?.rows ?? [])].reverse().find((r) => r.source_id.startsWith('<'))?.source_id ?? null;
    const r = await sendEmail(workspaceId, {
      to, cc: cc.trim() || undefined, bcc: bcc.trim() || undefined,
      subject: subject.trim(), body_text: text, body_html: rendered?.html ?? undefined, in_reply_to: inReplyTo,
      attachments: files.flatMap((f) => (f.kind === 'upload' ? [f.file] : [])),
      deal_file_ids: files.flatMap((f) => (f.kind === 'deal' ? [f.id] : [])),
      email_attachment_ids: files.flatMap((f) => (f.kind === 'email' ? [f.id] : [])),
      track, deal_id: dealId ?? thread?.deal_id ?? null,
      seller_id: thread?.seller_id ?? (rec?.kind === 'seller' ? rec.id ?? null : null),
      buyer_id: thread?.buyer_id ?? (rec?.kind === 'buyer' ? rec.id ?? null : null),
    });
    setSending(false);
    if (!r.ok) return setErr(r.message);
    if (!r.data.connected) return setErr('Connect Gmail to send.');
    if (!r.data.ok) return setErr(r.data.message ?? 'Gmail refused that send.');
    toast(`Email sent to ${name || to}${r.data.tracked ? ' · read receipt on' : ''}`);
    setDraft(''); setTpl(null); setFiles([]); setCc(''); setBcc('');
    onSent(thread?.key ?? `${to.toLowerCase()}|${baseSubject(subject).toLowerCase()}`);
  };

  /** The text that would go out, which the spam badge scores. */
  const outgoingText = rendered ? rendered.text : renderMerge(draft, fields);
  /** How many addresses the To field holds, for the same badge. */
  const recipientCount = [to, cc, bcc].join(',').split(',').filter((a) => a.includes('@')).length || 1;

  return {
    to, setTo, subject, setSubject, draft, setDraft,
    cc, setCc, bcc, setBcc, showCopies, setShowCopies, replyAll,
    files, addFiles, attach, detach, uploading, track, setTrack,
    tpl, setTpl, pickerOpen, setPickerOpen, sending, err, canWrite,
    rec, name, rendered, pick, send, outgoingText, recipientCount,
    phone: rec?.recipient?.phone ?? null,
  };
}
