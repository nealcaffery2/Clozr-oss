'use client';

// A Gmail-style box docked on the bottom of the page: quick email, quick text.
// Every Text and Email button in CLOZR opens this one box, so a rep learns one
// composer: templates with merge fields, emoji, minimize, and it stays docked
// while they browse. Mounted once on the shell.
//
// Two ways in, one box on screen:
// - a seller record (V.openQuickReach): the box keeps its own draft
//   (lib/compose-drafts, `quick:<channel>:<person>`), shows that seller's
//   feed and sends through V.send to that seller — not the record in view,
//   which keeps its own composer and draft — so the timeline shows it the
//   moment it goes;
// - anyone else (openReach in ./reach): a buyer, a vendor, a deal team member,
//   an inbox contact. The box files the send by the ids it was handed, or the
//   record the number or address resolves to.
// Opening one closes the other.

import { SmsFromPicker } from '@/components/SmsFromPicker';
import React, { useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { TalkrMark } from '@/app/components/talkr/DialerParts';
import { Icon } from '@/app/components/talkr/Icon';
import { EmojiButton, insertAtCaret } from '@/app/components/talkr/EmojiPicker';
import { TemplatePicker } from '@/app/components/templates/TemplatePicker';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { type Recipient, fieldsFor, renderMerge, sendSummary, textOne } from '@/lib/sms';
import { sendEmail } from '@/lib/google';
import { toE164 } from '@/lib/talkr';
import { useCanWrite } from '@/lib/read-only-context';
import { READ_ONLY_MESSAGE } from '@/lib/read-only';
import { displayName, useSession } from '@/lib/session';
import { type ReachState, type ReachTarget, closeReach, registerReachHost, useReach } from './reach';
import { clearDraft, draftFor, keepDraft } from '@/lib/compose-drafts';

export function QuickReach({ V }: { V: ClozrView }) {
  const ext = useReach();
  const reach = V.quickReach;
  const close = useRef(V.closeQuickReach);
  useEffect(() => { close.current = V.closeQuickReach; });
  // Whichever opened last wins, so there is never a second box in the dock.
  useEffect(() => { if (reach) closeReach(); }, [reach]);
  useEffect(() => registerReachHost(), []);
  const nonce = ext?.nonce;
  useEffect(() => { if (nonce) close.current(); }, [nonce]);

  if (reach) return <SellerBox key={reach.channel + ':' + reach.personId} V={V} ch={reach.channel} personId={reach.personId} />;
  if (ext) return <TargetBox key={ext.nonce} V={V} reach={ext} />;
  return null;
}

/** The sender's side of the merge fields. */
export function useRep(V: ClozrView) {
  const session = useSession();
  return {
    repName: session.profile?.full_name || displayName(session),
    repPhone: session.profile?.phone ?? '',
    repEmail: session.user?.email ?? '',
    company: V.workspaceName,
  };
}

function SellerBox({ V, ch, personId }: { V: ClozrView; ch: 'text' | 'email'; personId: string }) {
  const rep = useRep(V);
  // This box's own draft: kept while it is minimized, closed or the rep is
  // elsewhere, and only emptied once the send has landed.
  const key = `quick:${ch}:${personId}`;
  const [body, setBodyState] = useState(() => draftFor(key).text);
  const [subject, setSubjectState] = useState(() => draftFor(key).subject);
  const setBody = (text: string) => { setBodyState(text); keepDraft(key, { text }); };
  const setSubject = (v: string) => { setSubjectState(v); keepDraft(key, { subject: v }); };
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const who = V.reachPerson ?? V.P;
  const email = who.email.includes('@') ? who.email : '';
  const phone = who.phone && who.phone !== '—' ? who.phone : '';
  const isEmail = ch === 'email';
  const blocked = isEmail ? !email : !phone;
  const send = async () => {
    if (sending) return;
    setSending(true);
    const ok = await V.send({ body, personId, channel: ch, ...(isEmail ? { subject: subject.trim() || (who.addr !== '—' ? who.addr : 'Following up') } : {}) });
    if (ok) clearDraft(key);
    // Closed or swapped for another box meanwhile: nothing here to close.
    if (!mounted.current) return;
    setSending(false);
    if (ok) V.closeQuickReach();
  };
  return (
    <ReachFrame
      V={V} isEmail={isEmail} name={who.name} stuck={V.screen === 'person' && V.P.id !== personId}
      thread={(V.reachFeed || []).filter((m) => m.channel === (isEmail ? 'email' : 'text'))}
      emptyThread="Nothing on this record yet. A send lands here, on the timeline and in Inbox."
      to={<><b style={{ color: '#18181b' }}>{who.name}</b> · <b style={{ color: '#18181b' }}>{isEmail ? (email || 'no email yet') : (phone || 'no number yet')}</b></>}
      subject={subject} setSubject={setSubject}
      body={body} setBody={setBody} sending={sending}
      audience="seller"
      merge={() => fieldsFor(
        { sellerId: null, name: who.name, phone: phone || null, address: who.addr !== '—' ? who.addr : '', city: '', state: '', zip: '' },
        rep, phone || '',
      )}
      blocked={blocked ? (isEmail ? 'Add an email on the record first' : 'Add a phone on the record first') : null}
      onSend={() => { void send(); }}
      onClose={V.closeQuickReach}
    />
  );
}

function TargetBox({ V, reach }: { V: ClozrView; reach: NonNullable<ReachState> }) {
  const t: ReachTarget = reach.target;
  const isEmail = reach.channel === 'email';
  const rep = useRep(V);
  const canWrite = useCanWrite();
  const [to, setTo] = useState((isEmail ? t.email : t.phone) ?? '');
  const [subject, setSubject] = useState(t.subject ?? '');
  const [body, setBody] = useState(t.body ?? '');
  const [sending, setSending] = useState(false);

  const key = isEmail ? to.trim().toLowerCase() : (toE164(to) ?? '');
  const rec = key ? V.recordForContact(key) : null;
  const sellerId = t.sellerId ?? (rec?.kind === 'seller' ? rec.id : null);
  const buyerId = t.buyerId ?? (rec?.kind === 'buyer' ? rec.id : null);
  const name = t.name || rec?.name || to.trim();
  const recipient: Recipient = {
    ...(t.recipient ?? rec?.recipient ?? { sellerId: null, name }),
    sellerId, buyerId, vendorId: t.vendorId ?? null,
    name,
    phone: isEmail ? (t.phone ?? rec?.recipient.phone ?? null) : to.trim(),
    email: isEmail ? to.trim() : (t.email ?? rec?.recipient.email ?? ''),
  };
  const merge = () => fieldsFor(recipient, rep, isEmail ? (recipient.phone ?? '') : (toE164(to) ?? to));
  const blocked = isEmail
    ? (to.includes('@') ? null : t.editableTo ? 'Type the address to send to' : 'No email on file for ' + name)
    : (toE164(to) ? null : t.editableTo ? 'Type a mobile number to text' : 'No mobile number on file for ' + name);
  const workspaceId = V.liveIds?.workspaceId ?? null;
  const filedOn = rec ? `${rec.kind === 'seller' ? 'Seller' : 'Buyer'} record: ${rec.name}` : buyerId ? 'Filed on this buyer' : sellerId ? 'Filed on this seller' : null;

  const done = (msg: string) => {
    closeReach();
    // The record it was filed on re-reads; a send on neither (a vendor, a bare number) reloads.
    if (sellerId != null) V.refreshSellerCrm(sellerId);
    if (buyerId != null) V.refreshBuyerCrm(buyerId);
    if (sellerId == null && buyerId == null) V.reloadCrm();
    t.onSent?.();
    V.showToast(msg, 'success');
  };

  const send = async () => {
    if (sending || blocked) return;
    if (!body.trim()) return V.showToast('Type a message first');
    if (isEmail && !subject.trim()) return V.showToast('Add a subject');
    if (!canWrite) return V.showToast(READ_ONLY_MESSAGE);
    if (!workspaceId) { closeReach(); return V.showToast((isEmail ? 'Email' : 'Text') + ' to ' + name + ' (demo)'); }
    setSending(true);
    if (!isEmail) {
      // textOne renders the merge fields itself, against the same recipient.
      const r = await textOne(workspaceId, recipient, body, { ...rep, carrier: 'reply' });
      setSending(false);
      if (r.error) return V.showToast(sendSummary([r]), 'error');
      return done('Text sent to ' + name);
    }
    const r = await sendEmail(workspaceId, {
      to: to.trim(), subject: renderMerge(subject.trim(), merge()), body_text: renderMerge(body, merge()),
      in_reply_to: t.inReplyTo ?? null, deal_id: t.dealId ?? null,
      seller_id: sellerId, buyer_id: buyerId, vendor_id: t.vendorId ?? null,
    });
    setSending(false);
    if (!r.ok || !r.data.connected || !r.data.ok) {
      return V.showToast(!r.ok ? r.message : !r.data.connected ? 'Connect Gmail in Settings to send email.' : r.data.message ?? 'Gmail refused that send.', 'error');
    }
    done('Email sent to ' + name + (r.data.tracked ? ' · read receipt on' : ''));
  };

  const toLine = t.editableTo ? (
    <input value={to} onChange={(e) => setTo(e.target.value)} autoFocus aria-label={isEmail ? 'To address' : 'To number'}
      placeholder={isEmail ? 'name@example.com' : '(512) 555-0134'} inputMode={isEmail ? 'email' : 'tel'}
      style={{ border: 0, outline: 0, font: 'inherit', fontSize: V.isMobile ? '16px' : 'inherit', fontWeight: 600, color: '#18181b', flex: 1, minWidth: 0, background: 'transparent' }} />
  ) : <b style={{ color: '#18181b' }}>{to || (isEmail ? 'no email on file' : 'no number on file')}</b>;

  return (
    <ReachFrame
      V={V} isEmail={isEmail} name={name}
      thread={[]} emptyThread={filedOn ? filedOn + '. The send lands on its timeline and in Inbox.' : 'Not in CLOZR yet. The send still lands in Inbox.'}
      to={toLine} toFlex={!!t.editableTo}
      subject={subject} setSubject={setSubject} body={body} setBody={setBody}
      audience={t.audience ?? rec?.kind ?? 'any'} merge={merge}
      blocked={blocked} sending={sending}
      onSend={() => { void send(); }} onClose={closeReach}
      bodyAutoFocus={!t.editableTo}
    />
  );
}

type ThreadRow = { id: string; out?: boolean; time: string; body?: string; title?: string };

const RING = '0 0 0 1px rgba(0,0,0,.08), 0 1px 2px -1px rgba(0,0,0,.08), 0 2px 4px 0 rgba(0,0,0,.04)';
const MD = '0 0 0 1px rgba(0,0,0,.06), 0 1px 1px -.5px rgba(0,0,0,.06), 0 3px 3px -1.5px rgba(0,0,0,.06), 0 6px 6px -3px rgba(0,0,0,.06), 0 12px 12px -6px rgba(0,0,0,.06)';

function ReachFrame({ V, isEmail, name, stuck, thread, emptyThread, to, toFlex, subject, setSubject, body, setBody, audience, merge, blocked, sending, onSend, onClose, bodyAutoFocus = true }: {
  V: ClozrView; isEmail: boolean; name: string; stuck?: boolean;
  thread: ThreadRow[]; emptyThread: string;
  to: React.ReactNode; toFlex?: boolean;
  subject: string; setSubject: (v: string) => void;
  body: string; setBody: (v: string) => void;
  audience: 'seller' | 'buyer' | 'any';
  merge: () => Record<string, string>;
  blocked: string | null; sending?: boolean;
  onSend: () => void; onClose: () => void;
  bodyAutoFocus?: boolean;
}) {
  const session = useSession();
  const workspaceId = V.liveIds?.workspaceId ?? null;
  const templates = useTemplates(workspaceId);
  const [min, setMin] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const first = name.split(' ')[0];
  const label = isEmail ? 'Email' : 'Text';

  // Sit on the bottom edge, and rise with the live-call bar (and the phone tab bar) so the two never stack.
  const dock = V.isMobile
    ? 'calc(74px + env(safe-area-inset-bottom, 0px) + var(--clozr-callbar, 0px))'
    : 'calc(16px + var(--clozr-callbar, 0px))';
  // Center with auto margins. The pop animation owns `transform`, so a
  // translateX here gets wiped for the whole entrance and the box lands to the right.
  const center: React.CSSProperties = { position: 'fixed', left: 0, right: 0, marginLeft: 'auto', marginRight: 'auto', bottom: dock, zIndex: 55 };
  const iconBtn: React.CSSProperties = { border: 0, background: '#f4f4f5', cursor: 'pointer', color: '#52525b', width: '32px', height: '32px', borderRadius: '8px', display: 'grid', placeItems: 'center', flex: 'none' };

  if (min) {
    return (
      <button type="button" onClick={() => setMin(false)} data-testid="quick-reach-min" title={`Open the ${label.toLowerCase()} draft`}
        style={{ ...center, width: 'fit-content', height: '40px', padding: '0 14px', borderRadius: '10px 10px 0 0', border: '1px solid #e4e4e7', borderBottom: 0, background: '#fff', boxShadow: MD, cursor: 'pointer', fontWeight: 650, fontSize: '13px', color: '#18181b' }}>
        {label}{first ? ' · ' + first : ''}{stuck ? ' · stuck' : ''}
      </button>
    );
  }

  return (
    <form role="dialog" aria-label={isEmail ? 'Quick email' : 'Quick text'} data-testid="quick-reach"
      onSubmit={(e) => { e.preventDefault(); if (!blocked) onSend(); }}
      onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!blocked) onSend(); } }}
      style={{ ...center, width: 'min(640px, calc(100vw - 24px))', maxHeight: 'min(560px, calc(100vh - 120px - var(--clozr-callbar, 0px)))', background: '#fff', borderRadius: '12px', border: '1px solid #e4e4e7', boxShadow: MD, display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'recPop 200ms cubic-bezier(0.23,1,0.32,1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px 8px 12px', background: '#fafafa', borderBottom: '1px solid #e4e4e7', flex: 'none' }}>
        {isEmail ? <span style={{ color: '#71717a', display: 'inline-flex' }}><Icon name="mail" size={16} /></span> : <TalkrMark size={16} />}
        <span style={{ fontWeight: 650, fontSize: '13.5px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>
          {isEmail ? 'New email' : 'New text'}{first ? ' · ' + first : ''}
          {stuck ? <span style={{ fontWeight: 500, color: '#71717a', marginLeft: '6px' }}>not the record on screen</span> : null}
        </span>
        <button type="button" aria-label="Minimize" title="Minimize" data-testid="quick-reach-minimize" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMin(true); }} style={iconBtn}>
          <Icon name="chevron-down" size={16} />
        </button>
        <button type="button" aria-label="Close" title="Close" data-testid="quick-reach-close" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }} style={iconBtn}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div style={{ maxHeight: '220px', overflow: 'auto', background: '#fafafa', borderBottom: '1px solid #f0f0f1', flex: 'none' }}>
        {thread.length === 0 ? (
          <div style={{ padding: '8px 12px', fontSize: '11.5px', color: '#71717a' }}>{emptyThread}</div>
        ) : thread.map((m) => (
          <div key={m.id} style={{ padding: '8px 12px', borderTop: '1px solid #f4f4f5', fontSize: '12.5px' }}>
            <div style={{ color: '#71717a' }}>{m.out ? 'You' : first} · {m.time}</div>
            <div style={{ color: '#18181b', marginTop: '2px', whiteSpace: 'pre-wrap' }}>{m.body || m.title}</div>
          </div>
        ))}
      </div>
      <div style={{ padding: '8px 12px', fontSize: '12.5px', color: '#52525b', borderBottom: '1px solid #f0f0f1', flex: 'none', display: toFlex ? 'flex' : 'block', gap: '6px', alignItems: 'center' }}>
        <span>To </span>{to}
      </div>
      {isEmail ? (
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject"
          style={{ border: 0, borderBottom: '1px solid #f0f0f1', padding: '10px 12px', fontSize: V.isMobile ? '16px' : '13.5px', outline: 0, flex: 'none' }} />
      ) : null}
      <textarea ref={textRef} value={body} onChange={(e) => setBody(e.target.value)} autoFocus={bodyAutoFocus} rows={8} aria-label={isEmail ? 'Email body' : 'Text message'}
        placeholder={isEmail ? 'Write the email…' : 'Write the text…'}
        style={{ border: 0, resize: 'none', padding: '12px', fontSize: V.isMobile ? '16px' : '14px', outline: 0, fontFamily: 'inherit', minHeight: '160px', flex: 1 }} />
      {tplOpen ? (
        <div style={{ flex: 'none', maxHeight: '240px', overflow: 'auto', borderTop: '1px solid #e4e4e7' }}>
          <TemplatePicker
            channel={isEmail ? 'email' : 'sms'}
            audience={audience}
            templates={templates.templates}
            team={templates.team}
            userId={session.user?.id ?? null}
            loading={templates.loading}
            error={workspaceId ? templates.error : 'Templates run on a signed-in workspace.'}
            onClose={() => setTplOpen(false)}
            onManage={() => { setTplOpen(false); V.goInbox?.(); }}
            onPick={(tp) => {
              const fields = merge();
              setBody(renderMerge(tp.body_text, fields));
              if (isEmail && tp.subject) setSubject(renderMerge(tp.subject, fields));
              setTplOpen(false);
            }}
          />
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px 12px', flex: 'none', flexWrap: 'wrap' }}>
        <button type="submit" disabled={!!blocked || sending} style={{ height: '32px', padding: '0 16px', borderRadius: '8px', border: 0, background: '#0A8560', color: '#fff', fontWeight: 600, fontSize: '13px', cursor: blocked || sending ? 'not-allowed' : 'pointer', opacity: blocked || sending ? 0.5 : 1 }}>
          {sending ? 'Sending…' : isEmail ? 'Send email' : 'Send text'}
        </button>
        <button type="button" onClick={() => setTplOpen((v) => !v)} disabled={!workspaceId} aria-expanded={tplOpen}
          title={workspaceId ? 'Insert a template' : 'Templates run on a signed-in workspace'}
          style={{ height: '32px', padding: '0 12px', borderRadius: '8px', border: 0, boxShadow: RING, background: tplOpen ? '#f4f4f5' : '#fff', fontSize: '12.5px', fontWeight: 500, cursor: workspaceId ? 'pointer' : 'not-allowed', color: '#18181b', opacity: workspaceId ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <Icon name="template" size={14} /> Template
        </button>
        <EmojiButton onPick={(emoji) => setBody(insertAtCaret(textRef.current, body, emoji))} />
        {!isEmail ? <SmsFromPicker compact /> : null}
        <span role="status" style={{ fontSize: '11.5px', color: '#71717a', flex: 1, minWidth: '120px' }}>
          {blocked ?? '⌘ Enter sends · stays docked while you browse'}
        </span>
      </div>
    </form>
  );
}
