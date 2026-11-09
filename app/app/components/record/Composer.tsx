'use client';

// One composer, the way Follow Up Boss's reads: Create note · Send email ·
// Text · Log call. It says where a message goes before you send it, keeps a draft per record, remembers the channel you last used, and
// sends with ⌘⏎ from the box. Template opens the real CLOZR template picker
// for the current channel (SMS or email), with merge fields filled for this
// seller. Nothing in it animates: it is used all day.

import { SmsFromPicker } from '@/components/SmsFromPicker';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Mail, MessageSquare, Phone, StickyNote } from 'lucide-react';
import { EmailCompose } from './EmailCompose';
import { LogCall } from './LogCall';
import { TextCompose } from './TextCompose';
import { createBuyerNote } from '@/lib/buyer-desk';
import type { ClozrView } from '@/app/clozr/view';
import { MentionField, type Mentionable } from './MentionField';

const NO_TEAM: Mentionable[] = [];
import { ghostBtn, primaryBtn } from './ui';
import { TemplatePicker } from '@/app/components/templates/TemplatePicker';
import { TemplatesManager } from '@/app/components/templates/TemplatesManager';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { renderMerge } from '@/lib/sms';
import { blankFields } from '@/lib/merge-gaps';
import { MergeGapNotice } from '@/components/MergeGapNotice';
import { displayName, useSession } from '@/lib/session';
import { type Role, isAdmin } from '@/lib/team';
import type { MessageTemplate } from '@/lib/message-templates';
import { draftFor, keepDraft } from '@/lib/compose-drafts';
import { useComposerText } from '@/app/clozr/composerStore';

const CHANNEL_KEY = 'clozr.composer.channel';
/**
 * Drafts by record id, for the session (lib/compose-drafts, `record:<id>`):
 * leaving a record and coming back finds what you were typing. The docked
 * quick text keeps its own (`quick:…`), so the two never trade text.
 */
const draftKey = (pid: string) => 'record:' + pid;
/** The last composerFocusSeq this composer acted on; a new one is a hand-off asking for focus. */
let handledSeq = 0;

export function readChannel(): string | null {
  try { const v = window.localStorage.getItem(CHANNEL_KEY); return v === 'Text' || v === 'Email' || v === 'Note' ? v : null; } catch { return null; }
}
function saveChannel(v: string) {
  try { window.localStorage.setItem(CHANNEL_KEY, v); } catch { /* private mode: the channel just isn't remembered */ }
}

export function Composer({ V, inputRef, docked, kind = 'seller' }: { V: ClozrView; inputRef: React.MutableRefObject<HTMLTextAreaElement | null>; docked?: boolean; kind?: 'seller' | 'buyer' }) {
  // The buyer record draws the same card; its person is V.B.
  const buyer = kind === 'buyer';
  const who = buyer
    ? { id: 'b:' + (V.B.dbId ?? V.B.name), name: V.B.name || V.B.company, email: V.B.email, phone: V.B.phone, addr: '' }
    : { id: V.P.id, name: V.P.name, email: V.P.email, phone: V.P.phone, addr: V.P.addr };
  const pid = who.id;
  // The box's text lives in composerStore: typing re-renders this component, not the view model.
  const composerText = useComposerText();
  const tab = V.composerTab === 'Email' || V.composerTab === 'Note' ? V.composerTab : 'Text';
  const [subject, setSubject] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manager, setManager] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const session = useSession();
  const workspaceId = V.templatesWorkspaceId ?? V.liveIds?.workspaceId ?? null;
  const templates = useTemplates(workspaceId);
  const first = who.name.split(' ')[0];
  const street = who.addr && who.addr !== '—' ? who.addr : '';
  const email = who.email.includes('@') ? who.email : '';
  const phone = who.phone && who.phone !== '—' ? who.phone : '';

  // A seller's house rides along (V.P.merge): city, ZIP, beds, baths, sqft …
  // A buyer record has no house, so those stay out and a template naming them
  // is flagged by the email box rather than sent with a guess.
  const house = buyer ? null : V.P.merge;
  const mergeFields = useMemo((): Record<string, string> => ({
    ...(house ?? { city: '', state: '', zip: '', postal_code: '' }),
    first_name: first,
    name: who.name,
    contact_name: who.name,
    address: street,
    phone,
    email,
    company: V.workspaceName || '',
    rep_name: session.profile?.full_name || displayName(session),
    rep_first_name: (session.profile?.full_name || displayName(session)).trim().split(/\s+/)[0] ?? '',
    rep_phone: session.profile?.phone ?? '',
    rep_email: session.user?.email ?? '',
  }), [house, who.name, V.workspaceName, first, street, phone, email, session]);

  // On arrival: a hand-off (the command bar's "text kara") names the channel
  // and wants the box focused; otherwise the channel you last used comes back.
  useEffect(() => {
    if (V.composerFocusSeq !== handledSeq) {
      handledSeq = V.composerFocusSeq;
      requestAnimationFrame(() => { setLogOpen(false); inputRef.current?.focus(); });
      const t = setTimeout(() => {
        const a = document.activeElement;
        if (inputRef.current && a !== inputRef.current && (!a || a === document.body || !a.closest('[role=dialog]'))) inputRef.current.focus();
      }, 80);
      return () => clearTimeout(t);
    }
    const stored = readChannel();
    if (stored && stored !== V.composerTab) V.composerTabs.find((t) => t.label === stored)?.go();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [V.composerFocusSeq]);

  // Remember the channel you pick.
  const lastTab = useRef(tab);
  const flushRef = useRef<(() => string) | null>(null);
  useEffect(() => { if (lastTab.current !== tab) { lastTab.current = tab; saveChannel(tab); setPickerOpen(false); } }, [tab]);

  // A draft per record. Switching records swaps the box's contents; typing saves.
  const draftPid = useRef<string | null>(null);
  useEffect(() => {
    if (draftPid.current !== pid) {
      const prev = draftPid.current ? draftFor(draftKey(draftPid.current)).text : '';
      draftPid.current = pid;
      const d = draftFor(draftKey(pid));
      setSubject(d?.subject ?? '');
      setPickerOpen(false);
      if (!composerText || composerText === prev) {
        if ((d?.text ?? '') !== composerText) V.setComposerText(d?.text ?? '');
      }
      return;
    }
    keepDraft(draftKey(pid), { text: composerText, subject });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, composerText, subject]);

  const blocked = tab === 'Email' && !email ? `Add an email address for ${first} under What we know to email them.`
    : tab === 'Text' && !phone ? `Add a phone number for ${first} under What we know to text them.` : '';
  const where = tab === 'Text' ? `Sends by text to ${phone || 'no number yet'}`
    : tab === 'Email' ? `Sends from your Gmail to ${email || 'no email yet'}`
      : 'Only your team sees notes. Type @ to mention someone.';
  const sendLabel = tab === 'Text' ? 'Send text' : tab === 'Email' ? 'Send email' : 'Create note';
  // Back into the box after a send: a click on Save note left the focus on the
  // button, so the next note typed went to the record's letter keys instead.
  const send = () => {
    if (blocked) return;
    // What is in the box now: the field hands typing to the app a beat late.
    const text = flushRef.current?.() ?? composerText;
    if (buyer) {
      // A buyer's note is a communications row (lib/buyer-desk); texts and emails have their own tabs.
      if (!text.trim()) { V.showToast('Type a note first'); return; }
      if (!V.liveIds?.canWrite || V.B.dbId == null) { V.showToast('Note on ' + who.name + ' (demo)'); V.setComposerText(''); return; }
      void createBuyerNote(V.liveIds.workspaceId, V.B.dbId, text, V.liveIds.userId).then((r) => {
        if (!r.ok) { V.showToast(r.message || 'Could not save the note.', 'error'); return; }
        V.setComposerText('');
        V.reloadCrm();
        V.showToast('Note added', 'success');
      });
    } else {
      void V.send(tab === 'Email' ? { subject: subject.trim() || street, text } : { text });
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  // The Text tab's send: the seller's goes through V.send, the buyer's through the record's own sender. Both carry the MMS urls.
  const sendText = async (body: string, mediaUrls: string[]): Promise<boolean> => {
    if (!buyer) return V.send({ text: body, mediaUrls });
    V.sendBuyerMsg(body, mediaUrls);
    return true;
  };
  const onKeys = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); send(); return; }
    if (e.key === 'Escape' && (e.target as HTMLElement).tagName === 'TEXTAREA') (e.target as HTMLElement).blur();
  };
  const box: React.CSSProperties = { width: '100%', marginTop: '8px', padding: '10px 12px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', resize: 'none', fontSize: '13px', outline: 0, background: docked ? 'var(--canvas, #fafafa)' : 'var(--tint-amber, #fffbeb)', color: 'var(--ink, #18181b)', lineHeight: 1.5 };

  /** Property details on this record, scrolled into view and focused so the keyboard lands there too. */
  const openFacts = () => {
    const el = document.querySelector<HTMLElement>('[data-testid="property-details"], [data-testid="record-property"]');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  };
  // The template the phone's box was filled from, what it rendered to, and
  // facts saved from the blank-field notice since: a saved fact goes into the
  // box while the box is still the template as it went in.
  const [picked, setPicked] = useState<{ t: MessageTemplate; text: string } | null>(null);
  const [filled, setFilled] = useState<Record<string, string>>({});
  const fieldsNow = useMemo(() => ({ ...mergeFields, ...filled }), [mergeFields, filled]);
  const pickedGaps = picked && tab !== 'Note' && composerText.trim() ? blankFields([tab === 'Email' ? picked.t.subject : '', picked.t.body_text], fieldsNow) : [];
  const onPick = (t: MessageTemplate, fields: Record<string, string> = fieldsNow) => {
    const text = renderMerge(t.body_text, fields);
    V.setComposerText(text);
    if (tab === 'Email' && t.subject) setSubject(renderMerge(t.subject, fields));
    setPicked({ t, text });
    setPickerOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const takeFact = (name: string, value: string) => {
    const next = { ...filled, [name]: name === 'sqft' && /^\d+$/.test(value) ? Number(value).toLocaleString('en-US') : value };
    setFilled(next);
    if (picked && composerText === picked.text) onPick(picked.t, { ...mergeFields, ...next });
  };
  const gapNote = !buyer && pickedGaps.length ? (
    <MergeGapNotice blank={pickedGaps} where={street || 'this record'} onOpen={openFacts}
      onSave={(field, _name, value) => V.saveSellerField(field, value)} onUse={takeFact} testId="docked-merge-gaps" />
  ) : null;

  const templateBtn = tab !== 'Note' ? (
    <button
      type="button"
      className="dc2 rec-press"
      aria-pressed={pickerOpen}
      onClick={() => setPickerOpen((o) => !o)}
      style={{ ...ghostBtn, height: docked ? '36px' : '28px', padding: docked ? '0 9px' : '0 10px', fontSize: '12px', flex: 'none', background: pickerOpen ? 'var(--tint-green, #ecfdf5)' : ghostBtn.background, color: pickerOpen ? 'var(--tx-mint, #0a8560)' : undefined, borderColor: pickerOpen ? '#0A8560' : undefined }}
    >
      Template
    </button>
  ) : null;

  const picker = pickerOpen && tab !== 'Note' ? (
    <div data-testid="composer-template-picker" style={{ borderTop: '1px solid var(--divider, #e4e4e7)' }}>
      <TemplatePicker
        channel={tab === 'Email' ? 'email' : 'sms'}
        audience="seller"
        templates={templates.templates}
        team={templates.team}
        userId={session.user?.id ?? null}
        loading={templates.loading}
        error={templates.error}
        onPick={onPick}
        onManage={() => { setPickerOpen(false); setManager(true); }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  ) : null;

  const managerOverlay = manager && workspaceId ? (
    <TemplatesManager
      data={templates}
      userId={session.user?.id ?? null}
      isAdmin={isAdmin(session.workspace?.role as Role | undefined)}
      talkrAuthed={!!V.talkrAuthed}
      initialChannel={tab === 'Email' ? 'email' : 'sms'}
      ctx={{
        workspaceId,
        toast: V.showToast,
        testTo: session.user?.email ?? null,
        rep: Object.fromEntries(Object.entries({
          rep_name: mergeFields.rep_name,
          rep_phone: mergeFields.rep_phone,
          rep_email: mergeFields.rep_email,
          company: mergeFields.company,
        }).filter(([, v]) => v)),
      }}
      onClose={() => setManager(false)}
    />
  ) : null;

  // Phone: docked above the tab bar, as short as it can be. Send sits on the top row.
  if (docked) {
    const input: React.CSSProperties = { ...box, marginTop: '6px', width: '100%', minHeight: '42px' };
    return (
      <>
      {managerOverlay}
      <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {picker}
        <form data-testid="record-composer" aria-label={'Message ' + first} onSubmit={(e) => { e.preventDefault(); send(); }} onKeyDown={onKeys}
          style={{ flex: 'none', borderTop: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', padding: '8px 12px' }}>
          {/* Wraps at 390px so Send drops under the channel tabs instead of off the screen. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <div role="group" aria-label="Channel" style={{ display: 'inline-flex', gap: '2px', padding: '3px', background: 'var(--surface-2, #f4f4f5)', borderRadius: '8px', flex: 'none' }}>
              {V.composerTabs.map((t) => (
                <button key={t.label} type="button" aria-pressed={logOpen ? false : t.pressed} onClick={() => { setLogOpen(false); t.go(); }}
                  style={{ height: '32px', padding: '0 10px', borderRadius: '6px', border: 0, cursor: 'pointer', fontSize: '12.5px', fontWeight: 600, ...(logOpen ? { background: 'transparent', color: 'var(--muted, #52525b)', boxShadow: 'none' } : { background: t.bg, color: t.color, boxShadow: t.shadow }) }}>
                  {t.label}
                </button>
              ))}
              {/* Log call: the outcome picker, the desk's fourth tab, on the phone too. */}
              <button type="button" aria-pressed={logOpen} onClick={() => setLogOpen(true)} title="Log a call you made off CLOZR"
                style={{ height: '32px', padding: '0 10px', borderRadius: '6px', border: 0, cursor: 'pointer', fontSize: '12.5px', fontWeight: 600, ...(logOpen ? { background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', boxShadow: '0 1px 2px rgba(0,0,0,.08)' } : { background: 'transparent', color: 'var(--muted, #52525b)' }) }}>
                Log call
              </button>
            </div>
            {templateBtn}
            {tab === 'Text' ? <SmsFromPicker compact /> : null}
            <div style={{ flex: 1 }} />
            <button type="submit" className="dc3 rec-press" disabled={!!blocked} title={blocked || undefined}
              style={{ ...primaryBtn, flex: 'none', height: '36px', padding: '0 12px', opacity: blocked ? 0.5 : 1 }}>
              {sendLabel}
            </button>
          </div>
          <div data-testid="composer-hint" style={{ marginTop: '5px', fontSize: '11.5px', color: blocked ? 'var(--tx-amber, #b45309)' : 'var(--meta, #71717a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {blocked || where}
          </div>
          {tab === 'Email' ? (
            <input aria-label="Subject" placeholder={street || 'Subject'} value={subject} onChange={(e) => setSubject(e.target.value)} className="dc17"
              style={{ ...input, height: '40px', padding: '0 12px', minHeight: 0 }} />
          ) : null}
          <MentionField inputRef={inputRef} flushRef={flushRef} team={tab === 'Note' ? V.mentionTeam : NO_TEAM} className="dc17" value={composerText} onChange={V.setComposerText}
            aria-label={tab === 'Email' ? 'Email to ' + first : tab === 'Text' ? 'Text to ' + first : 'Note on ' + first}
            placeholder={tab === 'Note' ? V.composerPlaceholder + ' @ to mention' : V.composerPlaceholder} rows={1} style={input} />
        </form>
        {logOpen ? <div style={{ flex: 'none', padding: '0 12px 8px', background: 'var(--surface, #fff)', maxHeight: '50vh', overflow: 'auto', borderTop: '1px solid var(--divider-2, #f0f0f1)' }}><LogCall V={V} kind={kind} /></div> : null}
        {/* Outside the send form: its quick fills are forms of their own. */}
        {gapNote ? <div style={{ flex: 'none', padding: '0 12px 8px', background: 'var(--surface, #fff)', maxHeight: '40vh', overflow: 'auto' }}>{gapNote}</div> : null}
      </div>
      </>
    );
  }

  // Desktop: FUB's card. The tabs are Note, Email, Text (the view's composerTab)
  // and Log call, which is this component's own: it is the outcome picker,
  // not a message, so it never becomes the remembered channel.
  const TABS: { key: 'Note' | 'Email' | 'Text' | 'Log'; label: string; icon: React.ReactNode }[] = [
    { key: 'Note', label: 'Create note', icon: <StickyNote size={14} aria-hidden /> },
    { key: 'Email', label: 'Send email', icon: <Mail size={14} aria-hidden /> },
    { key: 'Text', label: 'Text', icon: <MessageSquare size={14} aria-hidden /> },
    { key: 'Log', label: 'Log call', icon: <Phone size={14} aria-hidden /> },
  ];
  const current = logOpen ? 'Log' : tab;
  const pickTab = (k: typeof TABS[number]['key']) => {
    if (k === 'Log') { setLogOpen(true); return; }
    setLogOpen(false);
    V.composerTabs.find((t) => t.label === k)?.go();
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  return (
    <>
    {managerOverlay}
    <div className="rec-compose" data-testid="record-composer-card">
      <div role="tablist" aria-label="Compose" className="rec-compose-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={current === t.key} tabIndex={current === t.key ? 0 : -1} className="rec-compose-tab" onClick={() => pickTab(t.key)}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>
      {logOpen ? (
        <LogCall V={V} kind={kind} />
      ) : tab === 'Email' ? (
        <EmailCompose key={pid} V={V} mergeFields={mergeFields} onSent={V.reloadCrm}
          gaps={buyer ? { where: who.name } : {
            where: street || 'this record',
            open: openFacts,
            save: (field, value) => V.saveSellerField(field, value),
          }}
          to={{ kind, name: who.name, email, sellerId: buyer ? null : V.liveIds?.sellerId ?? null, buyerId: buyer ? V.B.dbId ?? null : null, dealId: buyer ? null : V.liveIds?.dealId ?? null }} />
      ) : tab === 'Text' ? (
        <TextCompose key={pid} V={V} mergeFields={mergeFields} value={composerText} onChange={V.setComposerText} onSend={sendText} inputRef={inputRef}
          to={{ kind, name: who.name, phone, sellerId: buyer ? null : V.liveIds?.sellerId ?? null, buyerId: buyer ? V.B.dbId ?? null : null }} />
      ) : (
      <form data-testid="record-composer" aria-label={'Note on ' + first} onSubmit={(e) => { e.preventDefault(); send(); }} onKeyDown={onKeys} className="rec-compose-form">
        <MentionField inputRef={inputRef} flushRef={flushRef} team={V.mentionTeam} className="dc17 rec-compose-box" value={composerText} onChange={V.setComposerText}
            aria-label={'Note on ' + first} placeholder="Add notes or type @name to notify" rows={3} style={box} />
        <div className="rec-compose-foot">
          <span data-testid="composer-hint" style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {where}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--meta, #71717a)', whiteSpace: 'nowrap' }} aria-hidden>⌘↵</span>
          <button type="submit" className="dc3 rec-press" style={{ ...primaryBtn, flex: 'none', height: '30px' }}>
            {sendLabel}
          </button>
        </div>
      </form>
      )}
    </div>
    </>
  );
}
