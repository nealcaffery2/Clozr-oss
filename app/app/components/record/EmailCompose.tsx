'use client';

// The record's Send email tab, packed the way Follow Up Boss's is: To chips,
// Cc / Bcc, Subject, a row of quick template chips, a formatting toolbar over
// a rich box with the rep's signature already in it, and a footer with
// Attachments and Templates on the left, clear and Send on the right. Sends
// through lib/google sendEmail (Gmail), filed on the seller or buyer; the
// clock writes to scheduled_emails (migration 373) and the scheduled-send
// tick sends it through the same path later.
//
// The box is a contentEditable div driven by execCommand: no editor library,
// and Gmail renders the same tags (b, i, u, ul, ol, a, img, pre).

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Bold, Code, Image as ImageIcon, Italic, Link as LinkIcon, List, ListOrdered, Paperclip, RemoveFormatting, Trash2, Underline, Video, X } from 'lucide-react';
import type { ClozrView } from '@/app/clozr/view';
import { EmojiButton } from '@/app/components/talkr/EmojiPicker';
import { TemplatePicker } from '@/app/components/templates/TemplatePicker';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { UserAvatar } from '@/components/UserAvatar';
import { sendEmail, uploadOutgoing, type OutgoingFile } from '@/lib/google';
import { scheduleProblem, sendsLabel } from '@/lib/inbox-schedule';
import { useScheduled } from '@/lib/use-scheduled';
import { takeEmailEdit } from './scheduled-edit';
import { WhenMenu } from './WhenMenu';
import type { MessageTemplate } from '@/lib/message-templates';
import { renderMerge } from '@/lib/sms';
import { blankFields, factFields, labelOf } from '@/lib/merge-gaps';
import { MergeGapNotice } from '@/components/MergeGapNotice';
import { displayName, useSession } from '@/lib/session';
import { ghostBtn, primaryBtn } from './ui';

export type EmailTarget = {
  kind: 'seller' | 'buyer';
  name: string; email: string; avatar?: string | null;
  sellerId?: number | null; buyerId?: number | null;
  /** The house the record shows, so the send files there and not on another of the seller's deals. */
  dealId?: number | null;
};

/** FUB's quick chips, matched to the workspace's email templates by name; the rest of the row is the first templates on file. */
const QUICK = ['Introduction', 'Follow up', 'Still buying', 'Nurture lead'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = (text: string) => text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

/**
 * `gaps`: where the merge fields come from, so a template with {{beds}} on a
 * house with no beds says so above the box, links to the facts and saves a
 * quick fill to the record. Left out (a buyer), blanks are only named.
 */
export type GapFix = { where: string; open?: () => void; save?: (field: string, value: string) => Promise<{ ok: true } | { ok: false; message?: string }> };

export function EmailCompose({ V, to, mergeFields, onSent, gaps }: { V: ClozrView; to: EmailTarget; mergeFields: Record<string, string>; onSent?: () => void; gaps?: GapFix }) {
  const session = useSession();
  const workspaceId = V.templatesWorkspaceId ?? V.liveIds?.workspaceId ?? null;
  const templates = useTemplates(workspaceId);
  const rep = { name: session.profile?.full_name || displayName(session), phone: session.profile?.phone ?? '', email: session.user?.email ?? '', company: V.workspaceName || '' };
  // The signature block is not editable: a click on it puts the caret on the line above, so typing never lands inside it.
  const signature = `<p><br></p><p data-signature contenteditable="false"><strong>${esc(rep.name)}</strong>${rep.company ? `<br><span style="color:#71717a">${esc(rep.company)}</span>` : ''}${rep.phone || rep.email ? `<br>${[rep.phone, rep.email].filter(Boolean).map(esc).join(' · ')}` : ''}</p>`;

  const scheduled = useScheduled(V.liveIds?.workspaceId ?? null);
  // A scheduled email being edited (scheduled-edit.ts) arrives with its words.
  const [edit] = useState(takeEmailEdit);
  const [cc, setCc] = useState<string | null>(edit?.cc ?? null);
  const [bcc, setBcc] = useState<string | null>(edit?.bcc ?? null);
  const [subject, setSubject] = useState(edit?.subject ?? '');
  const [files, setFiles] = useState<OutgoingFile[]>(edit?.attachments ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [empty, setEmpty] = useState(!edit);
  // The editor is found by id when a handler runs: neither a ref (lint forbids reads in render paths) nor state (lint forbids mutating it).
  const editorId = useId();
  const editor = () => (typeof document === 'undefined' ? null : document.getElementById(editorId) as HTMLDivElement | null);
  const fileIn = useRef<HTMLInputElement | null>(null);

  // The signature is in the box from the start; a template drops in above it.
  useEffect(() => { const el = document.getElementById(editorId); if (el && !el.innerHTML) el.innerHTML = edit?.html || signature; }, [editorId, signature, edit]);
  const bodyOf = () => {
    const el = editor();
    if (!el) return { html: '', text: '', written: false };
    // Everything but the signature counts as written, the spacer line above it included: a click lands the caret there.
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-signature]')?.remove();
    return { html: el.innerHTML, text: el.innerText.trim(), written: clone.innerText.trim().length > 0 };
  };
  const onInput = () => setEmpty(!bodyOf().written);
  // A click below the text or on the signature leaves the caret nowhere editable and typing goes nowhere: put it on the first line.
  const settleCaret = () => {
    const el = editor();
    const sel = window.getSelection();
    if (!el || !sel) return;
    const sig = el.querySelector('[data-signature]');
    if (sel.anchorNode && el.contains(sel.anchorNode) && !(sig && sig.contains(sel.anchorNode))) return;
    const r = document.createRange();
    r.setStart(el.firstChild ?? el, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  const cmd = (name: string, value?: string) => { editor()?.focus(); document.execCommand(name, false, value); onInput(); };
  const insertHtml = (html: string) => cmd('insertHTML', html);
  const ask = (what: string) => { const v = window.prompt(what); return v && /^https?:\/\//i.test(v.trim()) ? v.trim() : null; };

  const emailTemplates = useMemo(() => templates.templates.filter((t) => t.channel === 'email' && (t.audience === to.kind || t.audience === 'general')), [templates.templates, to.kind]);
  const chips = useMemo(() => {
    const byName = (q: string) => emailTemplates.find((t) => t.name.toLowerCase().includes(q.toLowerCase()));
    const picked = QUICK.map((q) => byName(q)).filter((t): t is MessageTemplate => !!t);
    for (const t of emailTemplates) { if (picked.length >= 4) break; if (!picked.includes(t)) picked.push(t); }
    return picked;
  }, [emailTemplates]);
  // The template in the box and what it rendered to, so a quick fill can put
  // the saved value in while the rep has not typed over the template yet.
  const [applied, setApplied] = useState<{ t: MessageTemplate; text: string } | null>(null);
  const [filled, setFilled] = useState<Record<string, string>>({});
  const fieldsNow = useMemo(() => ({ ...mergeFields, ...filled }), [mergeFields, filled]);
  const blank = useMemo(() => (applied ? blankFields([applied.t.subject, applied.t.body_html ?? applied.t.body_text], fieldsNow) : []), [applied, fieldsNow]);
  const applyTemplate = (t: MessageTemplate, fields: Record<string, string> = fieldsNow) => {
    if (t.subject) setSubject(renderMerge(t.subject, fields));
    const body = t.body_html ? renderMerge(t.body_html, fields) : toHtml(renderMerge(t.body_text, fields));
    const el = editor();
    if (el) el.innerHTML = body + signature;
    // Compared as text: a contentEditable box rewrites its own markup on focus.
    setApplied({ t, text: el?.innerText ?? '' });
    setPicker(false);
    onInput();
    el?.focus();
  };
  /** A fact saved from the notice: in the merge set, and in the box when the box is still the template as it went in. */
  const takeFact = (name: string, value: string) => {
    const n = Number(value.replace(/[^0-9.]/g, ''));
    const facts = name === 'property_type' ? { property_type: value } : factFields({ ...readFacts(fieldsNow), [factKey(name)]: Number.isFinite(n) ? n : 0 });
    const next = { ...filled, ...(name === 'property_type' ? facts : Object.fromEntries(Object.entries(facts).filter(([k]) => k === name || k === 'specs' || k === 'beds_baths'))) };
    setFilled(next);
    if (applied && editor()?.innerText === applied.text) applyTemplate(applied.t, { ...mergeFields, ...next });
    V.showToast(`${labelOf(name)} saved on ${gaps?.where || 'the property'}`, 'success');
  };
  const clear = () => { const el = editor(); if (el) el.innerHTML = signature; setSubject(''); setFiles([]); setErr(null); setApplied(null); onInput(); };

  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    if (workspaceId == null) { setErr('Attachments upload on a signed-in workspace.'); return; }
    setBusy('Uploading…');
    for (const f of Array.from(list)) {
      const r = await uploadOutgoing(workspaceId, f);
      if (!r.ok) { setErr(r.message); break; }
      setFiles((xs) => [...xs, r.data]);
    }
    setBusy(null);
  };

  const sendLater = async (at: Date | null): Promise<boolean> => {
    const b = bodyOf();
    setErr(null);
    const problem = scheduleProblem(at);
    if (problem) { setErr(problem); return false; }
    if (!to.email) { setErr(`Add an email address for ${to.name.split(' ')[0]} first.`); return false; }
    if (!b.written) { setErr('Write something above the signature first.'); return false; }
    if (!V.liveIds?.canWrite || workspaceId == null) { V.showToast(`${sendsLabel(at!)} (demo)`); clear(); return true; }
    setBusy('Scheduling…');
    const e = await scheduled.scheduleEmail({
      to: to.email, subject: subject.trim() || mergeFields.address || 'Following up', html: b.html, sendAt: at!,
      cc: cc?.trim() || null, bcc: bcc?.trim() || null, attachments: files, sellerId: to.sellerId ?? null, buyerId: to.buyerId ?? null,
    });
    setBusy(null);
    if (e) { setErr(e); return false; }
    V.showToast(`${sendsLabel(at!)} to ${to.name}`, 'success');
    clear();
    onSent?.();
    return true;
  };

  const send = async () => {
    const b = bodyOf();
    setErr(null);
    if (!to.email) return setErr(`Add an email address for ${to.name.split(' ')[0]} first.`);
    if (!b.written) return setErr('Write something above the signature first.');
    if (!V.liveIds?.canWrite || workspaceId == null) { V.showToast(`Email to ${to.name} (demo)`); clear(); return; }
    setBusy('Sending…');
    const r = await sendEmail(workspaceId, {
      to: to.email, subject: subject.trim() || mergeFields.address || 'Following up', body_html: b.html, body_text: b.text,
      cc: cc?.trim() || undefined, bcc: bcc?.trim() || undefined, attachments: files.length ? files : undefined,
      seller_id: to.sellerId ?? null, buyer_id: to.buyerId ?? null, deal_id: to.dealId ?? null,
    });
    setBusy(null);
    if (!r.ok || !r.data.connected || !r.data.ok) {
      setErr(!r.ok ? r.message : !r.data.connected ? 'Connect Gmail in Settings to send email.' : r.data.message ?? 'Gmail refused that send.');
      return;
    }
    V.showToast(`Email sent to ${to.name}${r.data.tracked ? ' · read receipt on' : ''}`, 'success');
    clear();
    onSent?.();
  };

  const tool = (label: string, icon: React.ReactNode, run: () => void) => (
    <button type="button" className="rec-tool-btn" aria-label={label} title={label} onMouseDown={(e) => e.preventDefault()} onClick={run}>{icon}</button>
  );
  const first = to.name.split(' ')[0];

  return (
    <div className="rec-compose-form rec-email" data-testid="record-email-compose">
      <div className="rec-email-row">
        <span className="rec-email-k">To</span>
        <span className="rec-email-chip" title={to.email || 'No email on file'}>
          <UserAvatar name={to.name} src={to.avatar || null} size={18} radius="6px" />
          {to.name}{to.email ? '' : ' · no email'}
        </span>
        <span style={{ flex: 1 }} />
        {cc === null ? <button type="button" className="rec-link" onClick={() => setCc('')}>Cc</button> : null}
        {bcc === null ? <button type="button" className="rec-link" onClick={() => setBcc('')}>Bcc</button> : null}
      </div>
      {cc !== null ? (
        <div className="rec-email-row"><label htmlFor="rec-email-cc" className="rec-email-k">Cc</label><input id="rec-email-cc" className="rec-email-in" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="name@example.com, another@example.com" /></div>
      ) : null}
      {bcc !== null ? (
        <div className="rec-email-row"><label htmlFor="rec-email-bcc" className="rec-email-k">Bcc</label><input id="rec-email-bcc" className="rec-email-in" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="name@example.com" /></div>
      ) : null}
      <div className="rec-email-row"><label htmlFor="rec-email-subject" className="rec-email-k">Subject</label><input id="rec-email-subject" className="rec-email-in" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={mergeFields.address || 'Subject'} /></div>
      <div className="rec-email-quick" role="group" aria-label="Quick templates">
        {chips.map((t) => <button key={t.id} type="button" className="rec-qchip rec-press" onClick={() => applyTemplate(t)}>{t.name}</button>)}
        <button type="button" className="rec-qchip rec-press" aria-pressed={picker} onClick={() => setPicker((o) => !o)}>+ Custom</button>
      </div>
      {blank.length ? (
        <MergeGapNotice blank={blank} where={gaps?.where || to.name} onOpen={gaps?.open}
          onSave={gaps?.save ? (field, _name, value) => gaps.save!(field, value) : undefined}
          onUse={gaps?.save ? takeFact : undefined} testId="email-merge-gaps" />
      ) : null}
      {picker ? (
        <TemplatePicker channel="email" audience={to.kind} templates={templates.templates} team={templates.team} userId={session.user?.id ?? null}
          loading={templates.loading} error={templates.error} onPick={applyTemplate} onManage={() => setPicker(false)} onClose={() => setPicker(false)} />
      ) : null}
      <div className="rec-toolbar" role="toolbar" aria-label="Formatting">
        {tool('Bold', <Bold size={14} aria-hidden />, () => cmd('bold'))}
        {tool('Italic', <Italic size={14} aria-hidden />, () => cmd('italic'))}
        {tool('Underline', <Underline size={14} aria-hidden />, () => cmd('underline'))}
        <span className="rec-toolbar-rule" aria-hidden />
        {tool('Bulleted list', <List size={14} aria-hidden />, () => cmd('insertUnorderedList'))}
        {tool('Numbered list', <ListOrdered size={14} aria-hidden />, () => cmd('insertOrderedList'))}
        <span className="rec-toolbar-rule" aria-hidden />
        {tool('Link', <LinkIcon size={14} aria-hidden />, () => { const u = ask('Link address (https://…)'); if (u) cmd('createLink', u); })}
        {tool('Image', <ImageIcon size={14} aria-hidden />, () => { const u = ask('Image address (https://…)'); if (u) insertHtml(`<img src="${esc(u)}" alt="" style="max-width:100%">`); })}
        {tool('Video link', <Video size={14} aria-hidden />, () => { const u = ask('Video address (https://…)'); if (u) insertHtml(`<a href="${esc(u)}">${esc(u)}</a>`); })}
        <EmojiButton onPick={(e) => insertHtml(esc(e))} />
        <span className="rec-toolbar-rule" aria-hidden />
        {tool('Clear formatting', <RemoveFormatting size={14} aria-hidden />, () => cmd('removeFormat'))}
        {tool('Code', <Code size={14} aria-hidden />, () => cmd('formatBlock', 'pre'))}
      </div>
      <div id={editorId} className="rec-email-box dc17" contentEditable role="textbox" aria-multiline="true" aria-label={'Email to ' + first} data-placeholder={`Write to ${first}…`} onInput={onInput} onFocus={settleCaret} onMouseUp={settleCaret} suppressContentEditableWarning />
      {files.length ? (
        <div className="rec-email-files">
          {files.map((f) => (
            <span key={f.storage_path} className="rec-email-chip">
              <Paperclip size={12} aria-hidden />{f.filename}
              <button type="button" className="rec-email-chip-x" aria-label={`Remove ${f.filename}`} onClick={() => setFiles((xs) => xs.filter((x) => x !== f))}><X size={11} aria-hidden /></button>
            </span>
          ))}
        </div>
      ) : null}
      {err ? <p role="alert" className="rec-smart-hint" style={{ color: 'var(--tx-red, #b91c1c)', margin: '6px 0 0' }}>{err}</p> : null}
      <div className="rec-compose-foot">
        <input ref={fileIn} type="file" multiple hidden aria-hidden onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
        <button type="button" className="dc2 rec-press" style={{ ...ghostBtn, height: '28px', display: 'inline-flex', alignItems: 'center', gap: '6px' }} onClick={() => fileIn.current?.click()}><Paperclip size={13} aria-hidden />Attachments</button>
        <button type="button" className="dc2 rec-press" style={{ ...ghostBtn, height: '28px' }} aria-pressed={picker} onClick={() => setPicker((o) => !o)}>Templates</button>
        <span style={{ flex: 1, minWidth: 0, fontSize: '11.5px', color: 'var(--meta, #71717a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{busy ?? (to.email ? `From your Gmail to ${to.email}` : '')}</span>
        <button type="button" className="rec-tool-btn" aria-label="Clear the draft" title="Clear the draft" onClick={clear}><Trash2 size={14} aria-hidden /></button>
        <span className="rec-split-btn" style={{ position: 'relative' }}>
          <button type="button" className="dc3 rec-press" disabled={!!busy || empty || !to.email} title={!to.email ? 'No email on file' : empty ? 'Write something first' : undefined}
            style={{ ...primaryBtn, height: '30px', borderRadius: '8px 0 0 8px', opacity: busy || empty || !to.email ? 0.5 : 1 }} onClick={() => void send()}>
            {busy === 'Sending…' ? 'Sending…' : busy === 'Scheduling…' ? 'Scheduling…' : 'Send email'}
          </button>
          <WhenMenu disabled={!!busy || empty || !to.email} title={!to.email ? 'No email on file' : empty ? 'Write something first' : 'Send later'} onPick={sendLater} />
        </span>
      </div>
    </div>
  );
}

/** The facts already in a merge set, as numbers, so a quick fill can rebuild {{specs}} around them. */
function readFacts(f: Record<string, string>) {
  const n = (v: string | undefined) => Number((v ?? '').replace(/[^0-9.]/g, '')) || 0;
  return { beds: n(f.beds), baths: n(f.baths), sqft: n(f.sqft), year: n(f.year_built), type: f.property_type || '' };
}
const factKey = (name: string) => (name === 'year_built' ? 'year' : name);
