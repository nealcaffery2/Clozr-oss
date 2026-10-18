'use client';

// One composer: Text · Email · Note. It says where a message goes before you
// send it, keeps a draft per record, remembers the channel you last used, and
// sends with ⌘⏎ from the box. Template opens the real CLOZR template picker
// for the current channel (SMS or email), with merge fields filled for this
// seller. Nothing in it animates: it is used all day.

import { SmsFromPicker } from '@/components/SmsFromPicker';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { MentionField, type Mentionable } from './MentionField';

const NO_TEAM: Mentionable[] = [];
import { ghostBtn, primaryBtn } from './ui';
import { TemplatePicker } from '@/app/components/templates/TemplatePicker';
import { TemplatesManager } from '@/app/components/templates/TemplatesManager';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { renderMerge } from '@/lib/sms';
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

export function Composer({ V, inputRef, docked }: { V: ClozrView; inputRef: React.MutableRefObject<HTMLTextAreaElement | null>; docked?: boolean }) {
  const pid = V.P.id;
  // The box's text lives in composerStore: typing re-renders this component, not the view model.
  const composerText = useComposerText();
  const tab = V.composerTab === 'Email' || V.composerTab === 'Note' ? V.composerTab : 'Text';
  const [subject, setSubject] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manager, setManager] = useState(false);
  const session = useSession();
  const workspaceId = V.templatesWorkspaceId ?? V.liveIds?.workspaceId ?? null;
  const templates = useTemplates(workspaceId);
  const first = V.P.name.split(' ')[0];
  const street = V.P.addr && V.P.addr !== '—' ? V.P.addr : '';
  const email = V.P.email.includes('@') ? V.P.email : '';
  const phone = V.P.phone && V.P.phone !== '—' ? V.P.phone : '';

  const mergeFields = useMemo(() => ({
    first_name: first,
    name: V.P.name,
    contact_name: V.P.name,
    address: street,
    city: '',
    state: '',
    zip: '',
    postal_code: '',
    phone,
    email,
    company: V.workspaceName || '',
    rep_name: session.profile?.full_name || displayName(session),
    rep_phone: session.profile?.phone ?? '',
    rep_email: session.user?.email ?? '',
  }), [V.P.name, V.workspaceName, first, street, phone, email, session]);

  // On arrival: a hand-off (the command bar's "text kara") names the channel
  // and wants the box focused; otherwise the channel you last used comes back.
  useEffect(() => {
    if (V.composerFocusSeq !== handledSeq) {
      handledSeq = V.composerFocusSeq;
      requestAnimationFrame(() => inputRef.current?.focus());
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
  const sendLabel = tab === 'Text' ? 'Send text' : tab === 'Email' ? 'Send email' : 'Save note';
  // Back into the box after a send: a click on Save note left the focus on the
  // button, so the next note typed went to the record's letter keys instead.
  const send = () => {
    if (blocked) return;
    // What is in the box now: the field hands typing to the app a beat late.
    const text = flushRef.current?.() ?? composerText;
    void V.send(tab === 'Email' ? { subject: subject.trim() || street, text } : { text });
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const onKeys = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); send(); return; }
    if (e.key === 'Escape' && (e.target as HTMLElement).tagName === 'TEXTAREA') (e.target as HTMLElement).blur();
  };
  const box: React.CSSProperties = { width: '100%', marginTop: '8px', padding: '10px 12px', border: '1px solid #e4e4e7', borderRadius: '9px', resize: 'none', fontSize: '13px', outline: 0, background: '#fafafa', color: '#18181b', lineHeight: 1.5 };

  const onPick = (t: MessageTemplate) => {
    V.setComposerText(renderMerge(t.body_text, mergeFields));
    if (tab === 'Email' && t.subject) setSubject(renderMerge(t.subject, mergeFields));
    setPickerOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const templateBtn = tab !== 'Note' ? (
    <button
      type="button"
      className="dc2 rec-press"
      aria-pressed={pickerOpen}
      onClick={() => setPickerOpen((o) => !o)}
      style={{ ...ghostBtn, height: docked ? '36px' : '28px', padding: docked ? '0 9px' : '0 10px', fontSize: '12px', flex: 'none', background: pickerOpen ? '#ecfdf5' : ghostBtn.background, color: pickerOpen ? '#0A8560' : undefined, borderColor: pickerOpen ? '#0A8560' : undefined }}
    >
      Template
    </button>
  ) : null;

  const picker = pickerOpen && tab !== 'Note' ? (
    <div data-testid="composer-template-picker" style={{ borderTop: '1px solid #e4e4e7' }}>
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

  // Phone: docked above the tab bar, as short as it can be. Send sits on the
  // top row, clear of the dialer button, which floats over the bottom right.
  if (docked) {
    const input: React.CSSProperties = { ...box, marginTop: '6px', width: V.hideFab ? '100%' : 'calc(100% - 64px)', minHeight: '42px' };
    return (
      <>
      {managerOverlay}
      <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {picker}
        <form data-testid="record-composer" aria-label={'Message ' + first} onSubmit={(e) => { e.preventDefault(); send(); }} onKeyDown={onKeys}
          style={{ flex: 'none', borderTop: '1px solid #e4e4e7', background: '#fff', padding: '8px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <div role="group" aria-label="Channel" style={{ display: 'inline-flex', gap: '2px', padding: '3px', background: '#f4f4f5', borderRadius: '8px', flex: 'none' }}>
              {V.composerTabs.map((t) => (
                <button key={t.label} type="button" aria-pressed={t.pressed} onClick={t.go}
                  style={{ height: '32px', padding: '0 10px', borderRadius: '6px', border: 0, cursor: 'pointer', fontSize: '12.5px', fontWeight: 600, background: t.bg, color: t.color, boxShadow: t.shadow }}>
                  {t.label}
                </button>
              ))}
            </div>
            {templateBtn}
            {tab === 'Text' ? <SmsFromPicker compact /> : null}
            <div style={{ flex: 1 }} />
            <button type="submit" className="dc3 rec-press" disabled={!!blocked} title={blocked || undefined}
              style={{ ...primaryBtn, flex: 'none', height: '36px', padding: '0 12px', opacity: blocked ? 0.5 : 1 }}>
              {sendLabel}
            </button>
          </div>
          <div data-testid="composer-hint" style={{ marginTop: '5px', fontSize: '11.5px', color: blocked ? '#b45309' : '#71717a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
      </div>
      </>
    );
  }

  return (
    <>
    {managerOverlay}
    <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', minWidth: 0, background: '#fff' }}>
      {picker}
      <form data-testid="record-composer" aria-label={'Message ' + first} onSubmit={(e) => { e.preventDefault(); send(); }} onKeyDown={onKeys}
        style={{ flex: 'none', borderTop: pickerOpen ? 0 : '1px solid #e4e4e7', background: '#fff', padding: '10px 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <div role="group" aria-label="Channel" style={{ display: 'inline-flex', gap: '2px', padding: '3px', background: '#f4f4f5', borderRadius: '8px', flex: 'none' }}>
            {V.composerTabs.map((t) => (
              <button key={t.label} type="button" aria-pressed={t.pressed} onClick={t.go}
                style={{ height: '26px', padding: '0 11px', borderRadius: '6px', border: 0, cursor: 'pointer', fontSize: '12px', fontWeight: 600, background: t.bg, color: t.color, boxShadow: t.shadow }}>
                {t.label}
              </button>
            ))}
          </div>
          <span style={{ fontSize: '11.5px', color: '#a1a1aa', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tab === 'Note' ? 'Team only' : 'to ' + (tab === 'Email' ? email || '—' : phone || '—')}
          </span>
        </div>
        {tab === 'Email' ? (
          <input aria-label="Subject" placeholder={street || 'Subject'} value={subject} onChange={(e) => setSubject(e.target.value)} className="dc17"
            style={{ ...box, height: '34px', padding: '0 12px' }} />
        ) : null}
        <MentionField inputRef={inputRef} flushRef={flushRef} team={tab === 'Note' ? V.mentionTeam : NO_TEAM} className="dc17" value={composerText} onChange={V.setComposerText}
            aria-label={tab === 'Email' ? 'Email to ' + first : tab === 'Text' ? 'Text to ' + first : 'Note on ' + first}
            placeholder={tab === 'Note' ? V.composerPlaceholder + ' @ to mention' : V.composerPlaceholder} rows={2} style={box} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', minWidth: 0 }}>
          {templateBtn}
          {tab === 'Text' ? <SmsFromPicker compact /> : null}
          <span data-testid="composer-hint" style={{ fontSize: '11.5px', color: blocked ? '#b45309' : '#71717a', minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'normal' }}>
            {blocked || where}
          </span>
          {V.isMobile ? null : <span style={{ fontSize: '11px', color: '#a1a1aa', whiteSpace: 'nowrap' }}>⌘↵</span>}
          <button type="submit" className="dc3 rec-press" disabled={!!blocked} title={blocked || undefined}
            style={{ ...primaryBtn, flex: 'none', height: '30px', opacity: blocked ? 0.5 : 1 }}>
            {sendLabel}
          </button>
        </div>
      </form>
    </div>
    </>
  );
}
