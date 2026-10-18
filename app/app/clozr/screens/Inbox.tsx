// The Inbox: one set of channel tabs (All, SMS, Email, Calls, Voicemail)
// over Talkr's messages page (SMS, ported component-for-component from
// A:\talkr\apps\web into app/components/talkr), the member's Gmail
// (app/components/inbox/EmailInbox) and Talkr's call history. This file is the
// seam: Talkr's tokens are scoped under `.talkr-inbox`, `authed` is whether
// Talkr recognises the rep's sign-in, a call goes out through CLOZR's own
// floating dialer, and CLOZR's templates and record resolver are handed in.
'use client';

import { onInboxSms, onInboxThread, takeInboxSms, takeInboxThread } from '@/app/clozr/screens/inboxHandoff';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { eventFacts, useTalkrEvents } from '@/lib/talkr-events';
import type { ClozrView } from '@/app/clozr/view';
import { MessagesScreen } from '@/app/components/talkr/MessagesScreen';
import { TopBar } from '@/app/components/talkr/TopBar';
import { Icon } from '@/app/components/talkr/Icon';
import { Button } from '@/app/components/talkr/ui';
import type { ClozrRecord } from '@/app/components/talkr/MessagesScreen';
import { GmailInbox } from '@/app/components/inbox/gmail/GmailInbox';
import { useTeam } from '@/app/components/inbox/gmail/mail-extras';
import type { MergeFor, PickerRender } from '@/app/components/inbox/types';
import { CallsList, callLine, theirNumber } from '@/app/components/inbox/CallsList';
import { type EmailRow, type EmailThread, groupThreads, isVoicemail, useCalls, useEmail, useGmailPoll, useThreadBodies } from '@/app/components/inbox/data';
import { splitQuoted } from '@/app/components/inbox/quoted';
import { emailPlain } from '@/lib/email-html';
import { TemplatePicker, seg, segWrap } from '@/app/components/templates/TemplatePicker';
import { TemplatesManager } from '@/app/components/templates/TemplatesManager';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { type MessageDto, api } from '@/lib/talkr-web/api';
import { SkeletonRows } from '@/components/ds/Skeleton';
import { formatPhone, toE164 } from '@/lib/talkr-web/time';
import { fieldsFor, renderMerge } from '@/lib/sms';
import { displayName, useSession } from '@/lib/session';
import { type Role, isAdmin, seesAllMail } from '@/lib/team';
import { openReach } from '@/app/components/record/reach';
import '@/app/clozr/talkr-inbox.css';
import { type InboxState, isCleared, isUnread, pinnedFirst, smsKey, useInboxState } from '@/lib/inbox-state';
import { threadUnread, useEmailState } from '@/lib/email-state';
import { setTalkrDemo } from '@/lib/talkr-web/api';
import { DEMO_TALKR_ME, DEMO_TEAM, demoEmailRows, demoTalkr } from '@/lib/inbox-demo';
import { type InboxOwner, type OwnerChoice, UNASSIGNED, callOwner, eventTouches, inInbox, lineOwners, linesFor, ownerChoices, ownerTitle } from '@/lib/inbox-owner';
import { type InboxScope, useOwnerThreads, viewingOther } from '@/app/components/inbox/ownerInbox';
import { emailReceiptLabel, useEmailReceipts, useLinkViews } from '@/app/components/inbox/receipts';
import { SeenMark } from '@/app/components/inbox/ReceiptLine';
import { messageFromEvent, onTalkrEvent, withEventMessage } from '@/lib/talkr-events';
import { ArrowUp, Bookmark, ChevronDown, Ellipsis, ListFilter, Star } from 'lucide-react';
import { type SequenceDto } from '@/lib/talkr-web/api';
import { DISPOSITIONS, EMPTY_FILTER, type Folder, type InboxFilter, filterCount, folderCounts, inFolder, matchesFilter, optedOutOf, suggestLabel } from '@/lib/inbox-folders';
import { InboxRail } from '@/app/components/inbox/InboxRail';
import { type HeatChip, LabelChips, heatChip } from '@/app/components/inbox/LabelChips';
import { Menu } from '@/app/components/inbox/Menu';
import { FilterDialog } from '@/app/components/inbox/FilterDialog';
import { BulkBar } from '@/app/components/inbox/BulkBar';
import { InfoTab, NotesTab, type RelatedRow } from '@/app/components/inbox/ThreadInfo';
import type { AssignMate } from '@/app/components/bulk/AssignPanel';
import { assignSellers } from '@/lib/crm-write';
import { SKIP_REASON, enrollSellers } from '@/app/components/sequences/enrollSellers';
import { SendToCampaign } from '@/app/components/talkr/Campaigns';
import type { SendSeller } from '@/lib/talkr-campaign-send';

const TABS = ['All', 'SMS', 'Email', 'Calls', 'Voicemail'] as const;
type Tab = (typeof TABS)[number];

// What the Inbox was showing when the rep left it. The screen unmounts when
// another one opens, so the tab and the thread open on each were lost and
// coming back always landed on All. Kept for the tab's session; unsent text
// is kept per thread in lib/compose-drafts. `owner` is whose inbox: always
// the rep's own when the app opens.
const memory: { tab: Tab; smsConv: string | null; emailKey: string | null; callId: string | null; allKey: string | null; owner: InboxOwner; mailOwner: string; folder: Folder } = {
  tab: 'All', smsConv: null, emailKey: null, callId: null, allKey: null, owner: 'me', mailOwner: 'me', folder: 'all',
};

/** The Email tab's list on sample data: the demo's rows, already grouped, with nothing to load. */
function demoEmail(): ReturnType<typeof useEmail> {
  const threads = groupThreads(demoEmailRows() as EmailRow[]);
  const none = () => Promise.resolve();
  return {
    threads, google: null, account: null, canSend: false, loading: false, error: null, reload: none, version: 0,
    hasMore: false, loadingMore: false, more: none, search: none, searching: false,
  } as unknown as ReturnType<typeof useEmail>;
}

/**
 * Whose inbox the SMS, Calls, Voicemail and All tabs show: mine by default,
 * or one teammate's at a time. Never everyone mixed; the record's Activity
 * feed is where the office's messages with a contact sit together.
 */
function OwnerSwitch({ value, choices, onChange, title = 'Whose texts and calls this inbox shows. Your own unless you pick a teammate.' }: {
  value: InboxOwner; choices: OwnerChoice[]; onChange: (v: InboxOwner) => void; title?: string;
}) {
  if (choices.length < 2) return null;
  return (
    <label className="inbox-owner" data-other={value !== 'me' || undefined} title={title}>
      <span className="sr-only">Whose inbox</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    </label>
  );
}

export function Inbox({ V }: { V: ClozrView }) {
  const session = useSession();
  const workspaceId = V.liveIds?.workspaceId ?? null;
  const userId = session.user?.id ?? null;
  // Opened from "Open in Inbox" on a record: straight to that email thread.
  const [handoff] = useState(() => takeInboxThread());
  // Opened from the bell on a text whose sender is not a contact: that number's thread.
  const [smsHandoff] = useState(() => takeInboxSms());
  // Without a hand-off, back where the rep left it.
  const [tab, setTab] = useState<Tab>(handoff ? 'Email' : smsHandoff ? 'SMS' : memory.tab);
  const [smsTo, setSmsTo] = useState<string | null>(smsHandoff);
  const [newSms, setNewSms] = useState(0);
  const [emailKey, setEmailKey] = useState<string | null>(handoff ?? (smsHandoff ? null : memory.emailKey));
  useEffect(() => onInboxThread((key) => { setTab('Email'); setEmailKey(key); }), []);
  useEffect(() => onInboxSms((to) => { setTab('SMS'); setSmsTo(to); }), []);
  const [callId, setCallId] = useState<string | null>(handoff || smsHandoff ? null : memory.callId);
  useEffect(() => { memory.tab = tab; }, [tab]);
  useEffect(() => { memory.callId = callId; }, [callId]);
  // A tab picked by hand reopens what was last open on it, not the thread a
  // hand-off or "New text" opened earlier.
  const pickTab = (t: Tab) => {
    if (t === tab) return;
    setTab(t);
    setNewSms(0);
    if (t === 'SMS') setSmsTo(null);
    if (t === 'Email') setEmailKey(memory.emailKey);
  };
  const [manager, setManager] = useState<'any' | 'sms' | 'email' | null>(null);

  const templates = useTemplates(workspaceId);
  const allMail = seesAllMail(session.workspace?.role as Role | undefined);
  // Sample data (/demo): Talkr and Gmail are answered from lib/inbox-demo.
  // Installed while the first render runs, before the lists below ask Talkr.
  // The sample-data demo is /demo or a build without Supabase; a signed-in
  // workspace whose records are still loading (no liveIds yet) is not.
  const [onDemo] = useState(() => !!session.demo || (typeof window !== 'undefined' && window.location.pathname.startsWith('/demo')));
  const demo = onDemo || !V.liveIds;
  const demoPhone = onDemo && !V.talkrAuthed;
  useState(() => { if (demoPhone) setTalkrDemo(demoTalkr); return null; });
  useEffect(() => {
    if (!demoPhone) return;
    setTalkrDemo(demoTalkr);
    return () => setTalkrDemo(null);
  }, [demoPhone]);
  const authed = V.talkrAuthed || demoPhone;
  // Each teammate's name and photo by their Talkr user id, matched on the
  // sign-in address, so the thread can say who sent each text (MessagesScreen
  // `senders`). The roster is small; one read per workspace.
  const roster = useTeam(onDemo ? null : workspaceId, !onDemo);
  const talkrMembers = demoPhone ? DEMO_TEAM : V.talkrPhone.data.team;
  const faces = useMemo(() => {
    const byEmail = new Map(roster.filter((t) => t.email).map((t) => [t.email!.trim().toLowerCase(), t]));
    const m = new Map<string, { name: string; avatar: string | null }>();
    for (const t of (talkrMembers ?? []) as { id: string; display_name: string; email?: string | null }[]) {
      const mate = t.email ? byEmail.get(t.email.trim().toLowerCase()) : undefined;
      m.set(t.id, { name: mate?.full_name || t.display_name || 'Teammate', avatar: mate?.avatar_url ?? null });
    }
    return m;
  }, [roster, talkrMembers]);
  const senderFor = useCallback((id: string) => faces.get(id) ?? null, [faces]);
  // The All list, unread counts and alerts are your own mail, managers included;
  // the Email tab still lets TC and admins open a teammate's or everyone's.
  const liveEmail = useEmail(onDemo ? null : workspaceId, userId ?? null);
  const [sampleEmail] = useState(demoEmail);
  const email = onDemo ? sampleEmail : liveEmail;
  // New mail within about a minute while the Inbox is open and in front of the rep.
  useGmailPoll(workspaceId, !onDemo && email.account?.status === 'active' && !!email.account?.gmail_read);
  const calls = useCalls(authed);
  const recordFor = V.recordForContact;

  // Whose inbox: mine, or one teammate's (lib/inbox-owner). Talkr's ids.
  const talkrMe = demoPhone ? DEMO_TALKR_ME : V.talkrPhone.data.me;
  const talkrTeam = demoPhone ? DEMO_TEAM : V.talkrPhone.data.team;
  const meId = talkrMe?.id ?? null;
  const orgLines = useMemo(() => talkrMe?.org_numbers ?? [], [talkrMe]);
  const choices = useMemo(() => ownerChoices(meId, talkrTeam, orgLines), [meId, talkrTeam, orgLines]);
  const [ownerPick, setOwnerPick] = useState<InboxOwner>(memory.owner);
  useEffect(() => { memory.owner = ownerPick; }, [ownerPick]);
  // A teammate who left the team (or a list not read yet) falls back to mine.
  const owner = choices.some((c) => c.value === ownerPick) ? ownerPick : 'me';
  const scope = useMemo<InboxScope>(() => ({ owner, me: meId, lines: orgLines, title: ownerTitle(owner, choices) }), [owner, meId, orgLines, choices]);
  const owners = useMemo(() => lineOwners(orgLines), [orgLines]);
  // Calls and voicemail on this inbox: who handled it, else the line it rang.
  const scopedCalls = useMemo(
    () => ({ ...calls, calls: calls.calls.filter((h) => inInbox(callOwner(h, owners), owner, meId)) }),
    [calls, owners, owner, meId],
  );
  // What this rep opened, pinned and cleared (migration 154).
  const inboxState = useInboxState(workspaceId, userId);

  // The sender's merge fields: who is signed in, from which address.
  const rep = useMemo(() => ({
    repName: session.profile?.full_name || displayName(session),
    repPhone: session.profile?.phone ?? '',
    repEmail: email.account?.email ?? session.user?.email ?? '',
    company: V.workspaceName,
  }), [session, email.account?.email, V.workspaceName]);
  const mergeFor = useCallback<MergeFor>(
    (rec, name, to) => fieldsFor(rec?.recipient ?? { sellerId: null, name, phone: null }, rep, to),
    [rep],
  );

  const picker: PickerRender = ({ channel, audience, onPick, onClose }) => (
    <TemplatePicker
      channel={channel} audience={audience} templates={templates.templates} team={templates.team} userId={userId}
      loading={templates.loading} error={workspaceId ? templates.error : 'Templates run on a signed-in workspace.'}
      onPick={onPick} onClose={onClose} onManage={() => setManager(channel)}
    />
  );

  // Email is per mailbox (migration 107), picked in the same switch: your own
  // by default, one teammate's for TC and admins. Never everyone's mixed.
  const mailTeam = useTeam(workspaceId, allMail && !demo);
  const mailChoices = useMemo<OwnerChoice[]>(() => [
    { value: 'me', label: 'My inbox' },
    ...(allMail && userId ? mailTeam.filter((t) => t.user_id !== userId)
      .map((t) => ({ value: t.user_id, label: t.full_name || t.email || 'Teammate' }))
      .sort((a, b) => a.label.localeCompare(b.label)) : []),
  ], [allMail, userId, mailTeam]);
  const [mailPick, setMailPick] = useState<string>(memory.mailOwner);
  useEffect(() => { memory.mailOwner = mailPick; }, [mailPick]);
  const mailOwner = mailChoices.some((c) => c.value === mailPick) ? mailPick : 'me';
  const pickMailOwner = (v: string) => {
    if (v === mailOwner) return;
    setMailPick(v);
    setEmailKey(null);
    memory.emailKey = null;
  };
  const ownerSwitch = !authed && tab !== 'Email' ? null : tab === 'Email'
    ? <OwnerSwitch value={mailOwner} choices={mailChoices} onChange={pickMailOwner} title="Whose mail this inbox shows. Your own unless you pick a teammate." />
    : <OwnerSwitch value={owner} choices={choices} onChange={setOwnerPick} />;

  const tabs = (
    <>
      <span role="tablist" aria-label="Channel" style={segWrap}>
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} style={{ ...seg(tab === t), height: 26, padding: '0 11px', fontSize: 12.5 }} onClick={() => pickTab(t)}>{t}</button>
        ))}
      </span>
      {tab !== 'Email' ? (
        <button type="button" className="tray-btn" onClick={() => { setTab('SMS'); setSmsTo(null); setNewSms((n) => n + 1); }} title="Text any number: one that already has a thread opens it, with its history">
          <Icon name="edit" size={14} /> New text
        </button>
      ) : null}
      <button type="button" className="tray-btn" onClick={() => setManager('any')} disabled={!workspaceId} title={workspaceId ? 'SMS and email templates' : 'Templates run on a signed-in workspace'}>
        <Icon name="template" size={14} /> Templates
      </button>
    </>
  );

  const openFromAll = (kind: Kind, key: string) => {
    if (kind === 'sms') { setSmsTo(key); setTab('SMS'); }
    if (kind === 'email') { memory.emailKey = key; setEmailKey(key); setTab('Email'); }
    if (kind === 'call') { setCallId(key); setTab('Calls'); }
  };
  const onSmsOpen = useCallback((id: string | null) => { memory.smsConv = id; }, []);
  // A text thread read here is read in the bell too, on every device
  // (V.bellReadNumber). Only one the rep opened: landing on the SMS tab shows
  // the newest thread without reading it.
  const onSmsRead = V.bellReadNumber;

  return (
    <section
      data-screen-label="Inbox"
      className="talkr-inbox"
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      {tab === 'SMS' ? (
        <MessagesScreen
          key={`${smsTo ?? 'sms'}:${owner}`}
          authed={authed}
          scope={scope}
          receiptsWorkspace={onDemo ? null : workspaceId}
          placeCall={V.dialE164}
          onNewCall={V.openDialer}
          to={smsTo}
          conversation={smsTo ? null : memory.smsConv}
          onOpen={onSmsOpen}
          onRead={onSmsRead}
          recordFor={recordFor}
          inbox={inboxState}
          startNew={newSms}
          headerSlot={tabs}
          titleSlot={ownerSwitch}
          live={V.liveIds ? { workspaceId: V.liveIds.workspaceId, canWrite: V.liveIds.canWrite, me: userId, toast: V.showToast, reload: V.reloadCrm } : null}
          senders={senderFor}
          orgName={V.workspaceName}
          clozrTemplates={({ record, name, phone, insert, close }) => picker({
            channel: 'sms', audience: record?.kind ?? 'any', onClose: close,
            onPick: (t) => insert(renderMerge(t.body_text, mergeFor(record, name ?? '', phone ?? ''))),
          })}
        />
      ) : tab === 'Email' ? (
        // The same TopBar as All, Calls and Voicemail, so switching tabs does
        // not move the header; the mail search sits at the top of the list.
        <>
          <TopBar title="Inbox" subtitle={subtitleFor(tab, email.threads.length, scopedCalls.calls)} onNewCall={V.openDialer} titleSlot={ownerSwitch}>{tabs}</TopBar>
          <GmailInbox
            key={`${mailOwner}|${emailKey ?? 'email'}`}
            mailbox={mailOwner === 'me' ? userId : mailOwner}
            workspaceId={workspaceId} demo={demo} userId={userId} email={email}
            recordFor={recordFor} dealFor={V.dealForId} deals={V.mailDeals} seesAllMail={allMail}
            mergeFor={mergeFor} picker={picker} placeCall={V.dialE164}
            openKey={emailKey} toast={V.showToast}
            onPicked={(key) => { memory.emailKey = key; }}
            onCompose={(d, done) => openReach('email', {
              name: d.name ?? '', email: d.to ?? '', subject: d.subject, inReplyTo: d.inReplyTo,
              sellerId: d.sellerId, buyerId: d.buyerId, dealId: d.dealId, editableTo: !d.to, onSent: done,
            })}
          />
        </>
      ) : (
        <>
          <TopBar title="Inbox" subtitle={subtitleFor(tab, email.threads.length, scopedCalls.calls, scope)} onNewCall={V.openDialer} titleSlot={ownerSwitch}>{tabs}</TopBar>
          {(tab === 'Calls' || tab === 'Voicemail') && (
            <CallsList key={`${callId ?? 'calls'}:${owner}`} calls={scopedCalls} voicemailOnly={tab === 'Voicemail'} authed={authed} recordFor={recordFor} placeCall={V.dialE164} openId={callId} />
          )}
          {tab === 'All' && (
            <AllList key={owner} V={V} email={email} calls={scopedCalls} onOpen={openFromAll} inbox={inboxState} userId={userId}
              authed={authed} scope={scope} allMail={allMail} receiptsWorkspace={onDemo ? null : workspaceId}
              onQuickReplies={workspaceId ? () => setManager('sms') : null} />
          )}
        </>
      )}

      {manager && workspaceId && (
        <TemplatesManager
          data={templates} userId={userId} isAdmin={isAdmin(session.workspace?.role as Role | undefined)} talkrAuthed={V.talkrAuthed}
          initialChannel={manager}
          ctx={{
            workspaceId, toast: V.showToast, testTo: email.canSend ? email.account?.email ?? null : null,
            rep: Object.fromEntries(Object.entries({ rep_name: rep.repName, rep_phone: rep.repPhone, rep_email: rep.repEmail, company: rep.company }).filter(([, v]) => v)),
          }}
          onClose={() => setManager(null)}
        />
      )}
    </section>
  );
}

function subtitleFor(tab: Tab, emailThreads: number, calls: ReturnType<typeof useCalls>['calls'], scope?: InboxScope): string {
  if (tab === 'Email') return `${emailThreads} email thread${emailThreads === 1 ? '' : 's'}`;
  const whose = scope ? `${scope.title} · ` : '';
  if (tab === 'Voicemail') { const n = calls.filter(isVoicemail).length; return `${whose}${n} voicemail${n === 1 ? '' : 's'}`; }
  if (tab === 'Calls') return `${whose}${calls.length} recent call${calls.length === 1 ? '' : 's'}`;
  if (!scope) return 'Texts, email and calls, newest first';
  return `${whose}${viewingOther(scope) ? 'texts and calls' : 'texts, email and calls'}, newest first`;
}

type Kind = 'sms' | 'email' | 'call';
type AllItem = {
  key: string; at: string; kind: Kind; open: string; rec: ClozrRecord | null;
  name: string; unread: boolean; label: string; title?: string; preview: string; alert?: boolean; pinned?: boolean;
  /** Who a call or a text from the thread goes to. */
  phone: string | null;
  email: string | null;
  /** What the thread pane reads: the Talkr conversation, or the email thread already loaded. */
  convId?: string; thread?: EmailThread;
  /** Folder facts (lib/inbox-folders): the last word was theirs, a call rang out, they asked not to be contacted. */
  theyLast: boolean; missed: boolean; optedOut: boolean; archived: boolean;
  /** When and what they last wrote, for the response-date filter and the suggested label. */
  lastTheirsAt: string; lastTheirsText: string;
  unreadCount: number; tags: string[]; owner: string | null; temp: string | null;
  /** The rep's disposition labels on the thread (inbox state). */
  labels: string[];
};

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Which heading a timestamp files under. Sentence case, no dates in the headings themselves. */
function dayGroup(iso: string, today: number): string {
  if (!iso) return 'Older';
  const d = startOfDay(new Date(iso));
  if (d >= today) return 'Today';
  if (d >= today - DAY) return 'Yesterday';
  if (d >= today - 6 * DAY) return 'This week';
  if (d >= today - 30 * DAY) return 'This month';
  return 'Older';
}

/** Time of day inside Today and Yesterday, weekday inside the week, a date after that. */
function rowTime(iso: string, today: number): string {
  if (!iso) return '';
  const d = new Date(iso);
  const day = startOfDay(d);
  if (day >= today - DAY) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (day >= today - 6 * DAY) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: '2-digit' }) });
}

/** Two letters for the avatar; a bare number gets a hash. */
const initials = (name: string) => {
  const words = name.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length ? (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase() : '#';
};
const KIND_ICON: Record<Kind, 'msg' | 'mail' | 'phone'> = { sms: 'msg', email: 'mail', call: 'phone' };
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/**
 * Everything, newest first: SMS threads, email threads and calls, filed in
 * folders (lib/inbox-folders) down a rail on the left, with label chips on
 * each row and the open conversation on the right (one pane at a time on a
 * phone), so a reply, a call and the record are a click from the list.
 */
function AllList({ V, email, calls, onOpen, inbox, userId, authed, scope, allMail, receiptsWorkspace, onQuickReplies }: {
  V: ClozrView; email: ReturnType<typeof useEmail>; calls: ReturnType<typeof useCalls>;
  onOpen: (kind: Kind, key: string) => void; inbox: InboxState; userId: string | null;
  authed: boolean; scope: InboxScope; allMail: boolean; receiptsWorkspace: number | null;
  onQuickReplies: (() => void) | null;
}) {
  // This inbox's threads (ownerInbox): the owner's lines and assignments,
  // live off the phone's one event stream.
  const owned = useOwnerThreads(scope, authed);
  const convs = owned.convs;
  // Someone else's inbox is looked at, not worked: their unread stays theirs.
  const other = viewingOther(scope);
  const [q, setQ] = useState('');
  const [folder, setFolderState] = useState<Folder>(memory.folder);
  const [filter, setFilter] = useState<InboxFilter>(EMPTY_FILTER);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [toCampaign, setToCampaign] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(memory.allKey);
  useEffect(() => { memory.allKey = openKey; }, [openKey]);
  useEffect(() => { memory.folder = folder; }, [folder]);
  const setFolder = (f: Folder) => { setFolderState(f); setSavedId(null); setSel(new Set()); };
  // Email read state, the same the Email tab keeps (lib/email-state, migration 73).
  const mail = useEmailState(V.liveIds?.workspaceId ?? null, userId);
  // Live off the phone's one event stream (lib/talkr-events): the threads are
  // the phone's own list, `tick` re-reads the open conversation when a text
  // lands on it, and a call event re-reads the calls. Coming back to the tab
  // reads the calls again, since the stream may have dropped while hidden.
  // Email is live already (useEmail's own subscription).
  const [tick, setTick] = useState(0);
  const refreshCalls = calls.refresh;
  const phoneRefresh = V.talkrPhone.refresh;
  const ownedRefresh = owned.refresh;
  const refresh = useCallback(() => {
    if (!authed) return;
    if (V.talkrAuthed) phoneRefresh();
    ownedRefresh();
    setTick((n) => n + 1);
  }, [authed, V.talkrAuthed, phoneRefresh, ownedRefresh]);
  const openConv = openKey?.startsWith('sms:') ? openKey.slice(4) : null;
  useTalkrEvents(authed, ['message.received', 'message.updated', 'conversation.updated'], (events) => {
    if (openConv && events.some((e) => eventFacts(e).conversationId === openConv)) setTick((n) => n + 1);
  });
  // The stream carries every teammate's calls: at most one re-read of the
  // 200-call history per 30 seconds, however busy the floor is, except a call
  // or voicemail on this inbox's own lines, which is read within two seconds.
  const callsReadAt = React.useRef(0);
  const callsLater = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (callsLater.current) clearTimeout(callsLater.current); }, []);
  const scopeRef = React.useRef(scope);
  useEffect(() => { scopeRef.current = scope; });
  useTalkrEvents(authed, ['call.updated', 'voicemail.left'], (events) => {
    const s = scopeRef.current;
    const ours = events.some((e) => eventTouches(eventFacts(e), s.owner, s.me, linesFor(s.owner, s.me, s.lines), new Set()));
    if (callsLater.current && !ours) return;
    if (callsLater.current) clearTimeout(callsLater.current);
    const wait = ours ? 0 : Math.max(0, callsReadAt.current + 30_000 - Date.now());
    callsLater.current = setTimeout(() => {
      callsLater.current = null;
      callsReadAt.current = Date.now();
      refreshCalls();
    }, wait);
  }, 2000);
  useEffect(() => {
    if (!authed) return;
    const back = () => { if (document.visibilityState === 'visible') refreshCalls(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [authed, refreshCalls]);

  const recordFor = V.recordForContact;
  // A text thread is remembered by its number, so a new text to or from it is the same thread.
  const stateKey = (i: { kind: Kind; phone: string | null; key: string }) => (i.kind === 'sms' && i.phone ? smsKey(i.phone) : i.key);
  const base = {
    email: null as string | null, theyLast: false, missed: false, optedOut: false, archived: false, lastTheirsAt: '', lastTheirsText: '',
    unreadCount: 0, tags: [] as string[], owner: null as string | null, temp: null as string | null, labels: [] as string[],
  };
  const items: AllItem[] = [
    ...convs.map((c): AllItem => {
      const rec = recordFor(c.their_number);
      const out = c.last_message?.direction === 'outbound';
      const body = c.last_message?.body || (c.last_message?.media_count ? 'Photo' : '');
      return {
        ...base, key: `sms:${c.id}`, at: c.last_message_at ?? '', kind: 'sms', open: c.their_number, rec, phone: c.their_number, convId: c.id,
        name: c.contact_name ?? rec?.name ?? formatPhone(c.their_number), unread: c.unread_count > 0, unreadCount: c.unread_count,
        label: 'Text', preview: `${out ? 'You: ' : ''}${body}`,
        theyLast: !out && !!c.last_message, lastTheirsAt: out ? '' : c.last_message_at ?? '', lastTheirsText: out ? '' : body,
        optedOut: optedOutOf(c.contact_status, c.tags), tags: c.tags ?? [], owner: c.assigned_user_name, temp: c.temperature,
      };
    }),
    // Email is each rep's own mailbox (migration 107): a teammate's inbox here is their texts and calls.
    ...(other ? [] : email.threads).map((t): AllItem => {
      const rec = t.counterpart ? recordFor(t.counterpart) : null;
      const theirs = t.rows.filter((r) => r.direction === 'inbound');
      const lastTheirs = theirs[theirs.length - 1];
      return {
        ...base, key: `email:${t.key}`, at: t.last.occurred_at, kind: 'email', open: t.key, rec, thread: t,
        phone: rec?.recipient?.phone ? toE164(rec.recipient.phone) || null : null, email: t.counterpart?.includes('@') ? t.counterpart : null,
        name: rec?.name ?? t.counterpart ?? 'Email', unread: threadUnread(t.rows, mail.read, mail.seenThrough),
        label: 'Email', title: t.subject, preview: (t.last.body ?? t.last.preview ?? '').replace(/\s+/g, ' ').slice(0, 200),
        theyLast: t.last.direction === 'inbound', lastTheirsAt: lastTheirs?.occurred_at ?? '', lastTheirsText: '', unreadCount: 1,
      };
    }),
    ...calls.calls.map((h): AllItem => {
      const rec = recordFor(theirNumber(h));
      const missed = h.direction === 'inbound' && !h.duration_seconds && !isVoicemail(h);
      return {
        ...base, key: `call:${h.id}`, at: h.at, kind: 'call', open: h.id, rec, phone: theirNumber(h) || null,
        name: h.contact_name ?? rec?.name ?? formatPhone(theirNumber(h)), unread: h.direction === 'inbound' && !h.duration_seconds, unreadCount: 1,
        label: isVoicemail(h) ? 'Voicemail' : missed ? 'Missed call' : 'Call', alert: missed,
        preview: callLine(h).replace(/^(Voicemail|Incoming|Outgoing)( · )?/, ''),
        theyLast: h.direction === 'inbound', missed: missed || isVoicemail(h), lastTheirsAt: h.direction === 'inbound' ? h.at : '', owner: h.user_name,
      };
    }),
  ].sort((a, b) => Date.parse(b.at || '0') - Date.parse(a.at || '0'));

  // The rep's own view of each row: read, pinned, archived, labelled.
  const visible = pinnedFirst(
    items.map((i) => {
      const st = inbox.state.get(stateKey(i));
      return { ...i, unread: isUnread(i.unread, i.at, st), pinned: !!st?.pinned_at, archived: isCleared(i.at, st), labels: st?.labels ?? [] };
    }),
    stateKey, inbox.state,
  );
  const counts = folderCounts(visible);
  const heatOf = (i: AllItem) => heatChip(i.rec?.score, i.temp);
  /** Every label a row carries, for the filter: dispositions, the stage, the heat word. */
  const labelsOf = (i: AllItem) => [...i.labels, ...(i.rec?.stage ? [i.rec.stage] : []), ...(heatOf(i) ? [heatOf(i)!.label] : [])];
  const open = (i: AllItem) => {
    setOpenKey(i.key);
    if (other) return;
    inbox.seen(stateKey(i));
    // Talkr's own unread count goes too, so the SMS tab agrees.
    if (i.convId && i.unread) { owned.markRead(i.convId); if (V.talkrAuthed) V.talkrPhone.markRead(i.convId); }
    // An email read here is read on the Email tab too.
    if (i.thread && i.unread) mail.markRead(i.thread.rows.filter((r) => r.direction === 'inbound').map((r) => r.id));
    // And a text thread or a missed call read here leaves the bell.
    if (i.kind !== 'email' && i.phone) V.bellReadNumber(i.phone);
  };
  const needle = q.trim().toLowerCase();
  const filtering = filterCount(filter) > 0;
  let shown = visible.filter((i) => inFolder(i, folder)
    && (!filtering || matchesFilter({ kind: i.kind, labels: labelsOf(i), lastTheirsAt: i.lastTheirsAt, phone: i.phone, tags: i.tags, owner: i.owner }, filter))
    && (!needle || [i.name, i.title, i.preview, i.rec?.address].some((v) => v?.toLowerCase().includes(needle))));
  // Unreplied: the ones nobody has read yet first, then newest, so the stalest open question is never buried.
  if (folder === 'unreplied') shown = shown.map((i, n) => ({ i, n })).sort((a, b) => Number(b.i.unread) - Number(a.i.unread) || a.n - b.n).map((x) => x.i);

  const today = startOfDay(new Date());
  const groups: { label: string; rows: AllItem[] }[] = [];
  for (const i of shown.slice(0, 200)) {
    const label = dayGroup(i.at, today);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(i); else groups.push({ label, rows: [i] });
  }
  const loading = (!other && email.loading) || calls.loading || owned.loading;
  const picked = openKey ? visible.find((i) => i.key === openKey) ?? null : null;
  // A phone has room for one pane: the list, or the conversation with a Back.
  const one = V.isMobile;

  // "New activity": a message that just landed out of sight (below the fold,
  // or in a folder other than the one open) gets a jump button, SmarterContact's.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const shownRef = React.useRef(shown);
  useEffect(() => { shownRef.current = shown; });
  const newest = items[0] ? `${items[0].key}|${items[0].at}` : '';
  const lastNewest = React.useRef(newest);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (newest === lastNewest.current) return;
    lastNewest.current = newest;
    const [key, at] = newest.split('|');
    // Only something that just happened: the lists loading in stages is not news.
    if (!at || Date.now() - Date.parse(at) > 5 * 60_000) return;
    const inView = shownRef.current.some((i) => i.key === key) && (scrollRef.current?.scrollTop ?? 0) < 40;
    if (!inView) setFresh(true);
  }, [newest]);
  const jump = () => { setFolder('all'); setFilter(EMPTY_FILTER); setQ(''); setFresh(false); scrollRef.current?.scrollTo({ top: 0 }); };

  // Bulk actions on the selected rows.
  const selected = visible.filter((i) => sel.has(i.key));
  const sellerRecs = uniq(selected.filter((i) => i.rec?.kind === 'seller' && i.rec.id != null).map((i) => i.rec!));
  const canWrite = !!V.liveIds?.canWrite;
  const toast = V.showToast;
  const done = () => setSel(new Set());
  const markRead = (list: AllItem[]) => list.forEach((i) => {
    inbox.seen(stateKey(i));
    if (i.convId && i.unread) { owned.markRead(i.convId); if (V.talkrAuthed) V.talkrPhone.markRead(i.convId); }
    if (i.thread && i.unread) mail.markRead(i.thread.rows.filter((r) => r.direction === 'inbound').map((r) => r.id));
  });
  const assign = async (recs: ClozrRecord[], userId: string | null, who: string) => {
    const n = recs.length;
    if (!canWrite) { toast(`${n} assigned to ${who} (demo)`); return; }
    const r = await assignSellers(recs.map((r) => String(r.id)), userId);
    if (!r.ok) { toast(`Assigning did not save: ${r.message || 'try again'}`, 'error'); return; }
    toast(`${n} seller${n === 1 ? '' : 's'} assigned to ${who}`, 'success');
    V.reloadCrm();
  };
  const enroll = async (s: SequenceDto, recs: ClozrRecord[]) => {
    toast(`Enrolling ${recs.length} in ${s.name}…`);
    try {
      const r = await enrollSellers(s.id, recs.map((r) => ({ name: r.name, phone: r.recipient?.phone ?? '', address: r.recipient?.address ? { line1: r.recipient.address, city: r.recipient.city, state: r.recipient.state, postal_code: r.recipient.zip } : undefined })));
      const skipped = r.skipped.length ? ` · ${r.skipped.length} skipped (${uniq(r.skipped.map((x) => SKIP_REASON[x.reason] ?? x.reason)).join(', ')})` : '';
      toast(`${r.enrolled} enrolled in ${s.name}${r.already ? ` · ${r.already} already in it` : ''}${skipped}`, r.enrolled ? 'success' : 'info');
    } catch (e) { toast(`Talkr did not enrol them: ${e instanceof Error ? e.message : 'try again'}`, 'error'); }
  };
  const team = V.peopleAssign.team;
  const archive = (list: AllItem[]) => { list.forEach((i) => inbox.clear(stateKey(i))); if (list.some((i) => i.key === openKey)) setOpenKey(null); };

  const relatedTo = (p: AllItem) => visible.filter((i) => i.key !== p.key && ((p.phone && i.phone === p.phone) || (p.rec && i.rec && i.rec.kind === p.rec.kind && i.rec.id === p.rec.id)))
    .slice(0, 8).map((i) => ({ key: i.key, kind: i.kind, label: i.label, preview: i.preview, at: i.at, title: i.title }));
  const allSelected = shown.length > 0 && shown.every((i) => sel.has(i.key));

  return (
    <div className="ax-desk" data-one={one || undefined}>
    {(!one || !picked) && (
      <InboxRail folder={folder} counts={counts} onFolder={setFolder} saved={inbox.filters} savedId={savedId}
        onSaved={(s) => { setFilter(s.filter); setSavedId(s.id); setFolderState('all'); setSel(new Set()); }}
        onNewFilter={() => setFilterOpen(true)}
        onRemoveFilter={(s) => { inbox.removeFilter(s.id); if (savedId === s.id) { setSavedId(null); setFilter(EMPTY_FILTER); } }}
        onQuickReplies={onQuickReplies} />
    )}
    {(!one || !picked) && (
    <div className="ax">
      {sel.size ? (
        <BulkBar count={sel.size} sellers={sellerRecs.length} team={team} talkr={V.talkrAuthed}
          onClear={done}
          onRead={() => { markRead(selected); done(); }}
          onUnread={() => { selected.forEach((i) => inbox.markUnread(stateKey(i))); done(); }}
          onLabel={(d) => { selected.forEach((i) => inbox.label(stateKey(i), uniq([...i.labels, d]))); done(); }}
          onArchive={() => { archive(selected); done(); }}
          onAssign={(uid, who) => { void assign(sellerRecs, uid, who); done(); }}
          onEnroll={(s) => { void enroll(s, sellerRecs); done(); }}
          onCampaign={() => setToCampaign(true)} />
      ) : (
      <div className="ax-bar">
        <label className="ax-check ax-check-all" title={allSelected ? 'Clear the selection' : 'Select every thread shown'}>
          <input type="checkbox" checked={allSelected} disabled={!shown.length} onChange={() => setSel(allSelected ? new Set() : new Set(shown.map((i) => i.key)))} aria-label="Select all shown" />
        </label>
        <label className="ax-search">
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names, messages, addresses" aria-label="Search the inbox" />
        </label>
        <button type="button" className="ax-chip" aria-pressed={filtering} onClick={() => setFilterOpen(true)} title="Filter threads by label, response date, area code, tag, rep or channel">
          <ListFilter size={13} strokeWidth={2.25} aria-hidden />Filters{filtering ? <span className="ax-chip-n">{filterCount(filter)}</span> : null}
        </button>
        <span className="ax-count" role="status">
          {loading && !items.length ? 'Loading…' : `${shown.length} ${shown.length === 1 ? 'conversation' : 'conversations'}`}
        </span>
      </div>
      )}

      <div className="ax-scroll" ref={scrollRef} onScroll={() => { if (fresh && folder === 'all' && (scrollRef.current?.scrollTop ?? 0) < 40) setFresh(false); }}>
        {fresh ? (
          <button type="button" className="ax-fresh" onClick={jump}><ArrowUp size={13} strokeWidth={2.5} aria-hidden />New activity</button>
        ) : null}
        {savedId && filtering ? (
          <p className="ax-note" role="status"><Bookmark size={13} aria-hidden />{inbox.filters.find((f) => f.id === savedId)?.name ?? 'Saved filter'} is on.
            <button type="button" className="ax-link" onClick={() => { setSavedId(null); setFilter(EMPTY_FILTER); }}>Turn off</button></p>
        ) : null}
        {!authed && (
          <p className="ax-note"><Icon name="phone" size={13} />Talkr isn’t connected to this sign-in, so texts and calls are not listed. Email still is.</p>
        )}
        {authed && other && (
          <p className="ax-note" role="note"><Icon name="user" size={13} />
            {scope.owner === UNASSIGNED
              ? 'Texts and calls on shared lines nobody owns. Opening one leaves it unread.'
              : `${scope.title}: their texts and calls. Opening one leaves it unread for them. ${allMail ? 'Their email is on the Email tab, under Whose mail.' : 'Their email stays in their own mailbox.'}`}
          </p>
        )}
        {authed && owned.error && (
          <p className="ax-note" role="alert"><Icon name="msg" size={13} />Talkr did not return these texts: {owned.error}. Calls and email still show.</p>
        )}
        {shown.length === 0 && (needle || filtering ? (
          <div className="ax-empty">
            <p className="ax-empty-t">Nothing matches</p>
            <p className="ax-empty-h">{needle ? <>No conversation here mentions “{q.trim()}”.</> : 'No thread in this folder fits the filter.'}</p>
            <button type="button" className="ax-chip" onClick={() => { setQ(''); setFilter(EMPTY_FILTER); setSavedId(null); }}>Clear filters</button>
          </div>
        ) : loading ? (
          <SkeletonRows count={6} label="Loading the inbox" face={false} />
        ) : (
          <div className="ax-empty">
            <p className="ax-empty-t">{EMPTY_T[folder]}</p>
            <p className="ax-empty-h">{EMPTY_H[folder]}</p>
            {folder !== 'all' ? <button type="button" className="ax-chip" onClick={() => setFolder('all')}>Show all</button> : null}
          </div>
        ))}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h2 className="ax-day">{g.label}</h2>
            <ul className="ax-list">
              {g.rows.map((i) => {
                const h = heatOf(i);
                const on = sel.has(i.key);
                return (
                <li key={i.key}>
                  <div className="ax-row" data-unread={i.unread || undefined} data-selected={on || undefined} aria-current={i.key === openKey || undefined}>
                    <span className="ax-dot" aria-label={i.unread ? 'Unread' : undefined} />
                    <label className="ax-check">
                      <input type="checkbox" checked={on} aria-label={`Select ${i.name}`} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(i.key)) n.delete(i.key); else n.add(i.key); return n; })} />
                    </label>
                    <button type="button" className="ax-open" onClick={() => open(i)}>
                      <span className="ax-avatar" aria-hidden>{initials(i.name)}{i.unread && i.unreadCount > 0 ? <span className="ax-avatar-n">{i.unreadCount > 9 ? '9+' : i.unreadCount}</span> : null}</span>
                      <span className="ax-who">
                        <span className="ax-name">{i.name}</span>
                        <span className="ax-sub">
                          {i.rec ? (
                            <>
                              <span className={`ax-badge ax-badge-${i.rec.kind}`}>{i.rec.kind === 'seller' ? 'Seller' : 'Buyer'}</span>
                              {i.rec.address ? <span className="ax-addr" title={i.rec.address}>{i.rec.address}</span> : null}
                            </>
                          ) : <span className="ax-addr">Not in CLOZR</span>}
                        </span>
                      </span>
                      <span className="ax-body">
                        <span className="ax-kind" data-alert={i.alert || undefined}><Icon name={KIND_ICON[i.kind]} size={12} />{i.label}</span>
                        {i.title ? <span className="ax-title">{i.title}</span> : null}
                        <span className="ax-preview">{i.preview}</span>
                      </span>
                      <time className="ax-time" dateTime={i.at || undefined}>{rowTime(i.at, today)}</time>
                    </button>
                    <LabelChips compact stage={i.rec?.stage} heat={h} labels={i.labels} suggestion={i.labels.length ? null : suggestLabel(i.lastTheirsText)} onLabels={(l) => inbox.label(stateKey(i), l)} />
                    <button type="button" className="ax-star" aria-pressed={i.pinned} aria-label={i.pinned ? `Unpin ${i.name}` : `Pin ${i.name} to the top`} onClick={() => inbox.pin(stateKey(i), !i.pinned)}>
                      <Star size={14} strokeWidth={2} aria-hidden fill={i.pinned ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                </li>
              ); })}
            </ul>
          </section>
        ))}
      </div>
    </div>
    )}
    {(!one || picked) && (picked ? (
      <AllThread key={picked.key} item={picked} tick={tick} onSent={refresh} receiptsWorkspace={receiptsWorkspace} onOpen={onOpen} placeCall={V.dialE164} onBack={one ? () => setOpenKey(null) : undefined}
        heat={heatOf(picked)} onLabels={(l) => inbox.label(stateKey(picked), l)}
        onPin={(on) => inbox.pin(stateKey(picked), on)}
        onArchive={() => archive([picked])} onRestore={() => inbox.unclear(stateKey(picked))}
        onMarkUnread={() => { inbox.markUnread(stateKey(picked)); setOpenKey(null); }}
        team={team} canWrite={canWrite} onAssign={(uid, who) => (picked.rec ? assign([picked.rec], uid, who) : undefined)}
        related={relatedTo(picked)} onOpenRelated={(k) => { const t = visible.find((i) => i.key === k); if (t) open(t); }}
        workspaceId={V.liveIds?.workspaceId ?? null} userId={userId} toast={toast} />
    ) : (
      <div className="ax-read ax-read-blank"><p>Pick a conversation. The reply, the call and the record open beside the list.</p></div>
    ))}
    {filterOpen ? (
      <FilterDialog value={filter}
        labels={uniq([...DISPOSITIONS, ...visible.flatMap((i) => labelsOf(i))])}
        tags={uniq(visible.flatMap((i) => i.tags)).sort()}
        owners={uniq(visible.map((i) => i.owner).filter((x): x is string => !!x)).sort()}
        onApply={(f) => { setFilter(f); setSavedId(null); setFilterOpen(false); }}
        onSave={(name, f) => { const id = inbox.saveFilter(name, f); setFilter(f); setSavedId(id); toast(`“${name}” saved to the rail`, 'success'); }}
        onClose={() => setFilterOpen(false)} />
    ) : null}
    {toCampaign && sellerRecs.length ? (
      <SendToCampaign workspaceId={V.liveIds?.workspaceId ?? null}
        sellers={sellerRecs.map((r): SendSeller => ({ dbId: r.id!, name: r.name, phone: r.recipient?.phone ?? '', fields: { address: r.recipient?.address, city: r.recipient?.city, state: r.recipient?.state, zip: r.recipient?.zip } }))}
        onClose={() => setToCampaign(false)} onDone={(msg) => { setToCampaign(false); done(); toast(msg); }} />
    ) : null}
    </div>
  );
}

const EMPTY_T: Record<Folder, string> = {
  all: 'Nothing in the inbox yet', unread: 'Everything has been read', missed: 'No missed calls', unreplied: 'Nobody is waiting on you',
  awaiting: 'Nothing awaiting a reply', optout: 'Nobody has opted out', archived: 'Nothing archived',
};
const EMPTY_H: Record<Folder, string> = {
  all: 'Texts, email and calls land here as they come in, newest first.', unread: 'A new text, email or missed call shows up here.',
  missed: 'Calls that ring out on your lines land here, voicemail included.', unreplied: 'Threads where they wrote last land here.',
  awaiting: 'Threads where you wrote last land here.', optout: 'Contacts marked DNC or who texted STOP land here.',
  archived: 'Close a thread and it waits here until something new happens on it.',
};

const WHERE: Record<Kind, string> = { sms: 'SMS', email: 'Email', call: 'Calls' };
const stamp = (iso: string) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
type ThreadTab = 'messages' | 'info' | 'notes';

/**
 * The open conversation beside the All list, with Messages, Info and Notes
 * tabs. Texts are read from Talkr, email from the thread the list already
 * loaded, a call is its one line. Reply goes through the docked quick text (a
 * real send); an email reply opens the Gmail thread, which knows whose
 * mailbox it is and whether sending is on.
 */
function AllThread({ item, tick, onSent, onOpen, placeCall, onBack, heat: h, onLabels, onPin, onArchive, onRestore, onMarkUnread, team, canWrite, onAssign, related, onOpenRelated, workspaceId, userId, toast, receiptsWorkspace }: {
  item: AllItem; tick: number; onSent: () => void; onOpen: (kind: Kind, key: string) => void; placeCall: (e164: string) => void; onBack?: () => void;
  heat: HeatChip; onLabels: (l: string[]) => void; onPin: (on: boolean) => void; onArchive: () => void; onRestore: () => void; onMarkUnread: () => void;
  team: AssignMate[]; canWrite: boolean; onAssign: (userId: string | null, who: string) => void;
  related: RelatedRow[]; onOpenRelated: (key: string) => void;
  workspaceId: number | null; userId: string | null; toast: ClozrView['showToast']; receiptsWorkspace: number | null;
}) {
  const [tab, setTab] = useState<ThreadTab>('messages');
  const [sms, setSms] = useState<MessageDto[] | null>(null);
  // An email thread's bodies are read when it opens (the list carries previews).
  const mailThread = useThreadBodies(item.thread ?? null);
  // Read again on every live tick, keeping what is on screen until it lands.
  useEffect(() => {
    if (!item.convId) return;
    let live = true;
    api.listConversationMessages(item.convId)
      .then((r) => { if (live) setSms(r.messages); })
      .catch(() => { if (live) setSms((cur) => cur ?? []); });
    return () => { live = false; };
  }, [item.convId, tick]);
  // A reply on this thread draws as the stream carries it; the re-read above replaces it.
  useEffect(() => {
    const conv = item.convId;
    if (!conv) return;
    return onTalkrEvent((e) => {
      if (e.type !== 'message.received') return;
      const m = messageFromEvent(e);
      setSms((cur) => (cur ? withEventMessage(cur, m, conv, (x): MessageDto => ({
        ...x, error_code: null, failure_class: 'none', is_auto_reply: false, delivered_at: null, failed_at: null,
      })) as MessageDto[] : cur));
    });
  }, [item.convId]);

  // Receipts: "Viewed" on a text whose CLOZR link was opened, "Opened" on a tracked email.
  const outTexts = useMemo(() => (sms ?? []).filter((m) => m.direction === 'outbound').map((m) => m.body), [sms]);
  const views = useLinkViews(outTexts, receiptsWorkspace);
  const sentIds = useMemo(() => (mailThread?.rows ?? []).filter((r) => r.direction === 'outbound').map((r) => r.id), [mailThread]);
  const opens = useEmailReceipts(sentIds, receiptsWorkspace);

  const msgs = mailThread
    ? mailThread.rows.map((r) => {
      const label = r.direction === 'outbound' ? emailReceiptLabel(opens.get(r.id)) : null;
      return { id: String(r.id), out: r.direction === 'outbound', at: r.occurred_at, text: splitQuoted(emailPlain(r.body))[0].trim(), receipt: label, seen: (opens.get(r.id)?.opens ?? 0) > 0, receiptTitle: undefined as string | undefined };
    })
    : (sms ?? []).map((m) => {
      const out = m.direction === 'outbound';
      return { id: m.id, out, at: m.created_at, text: m.body || (m.media_urls.length ? 'Photo' : ''), receipt: out ? views.label(m.body) : null, seen: out && views.viewed(m.body), receiptTitle: out ? views.title(m.body) : undefined };
    });
  const { phone, rec } = item;
  // The suggested label reads the last text from them, once the thread is loaded.
  const lastTheirs = [...(sms ?? [])].reverse().find((m) => m.direction === 'inbound')?.body ?? item.lastTheirsText;
  const text = phone ? () => openReach('text', { name: item.name, phone, recipient: rec?.recipient, onSent }) : null;
  const assignee = rec?.kind === 'seller' ? (rec.rep ?? 'Unassigned') : null;
  const tabs: [ThreadTab, string][] = [['messages', 'Messages'], ['info', 'Info'], ['notes', 'Notes']];

  return (
    <section className="ax-read" data-sms={item.kind === 'sms' || undefined} aria-label={`Conversation with ${item.name}`}>
      <header className="ax-read-head">
        {onBack && <Button onClick={onBack}>Back</Button>}
        <span className="ax-read-who">
          <span className="ax-name">{item.name}{item.archived ? <span className="ax-tag" style={{ marginLeft: 8 }}>Archived</span> : null}</span>
          <span className="ax-sub">
            <span className="ax-kind" data-alert={item.alert || undefined}><Icon name={KIND_ICON[item.kind]} size={12} />{item.label}</span>
            <span className="ax-addr">{rec ? rec.address || rec.stage : 'Not in CLOZR'}</span>
          </span>
          <LabelChips stage={rec?.stage} heat={h} labels={item.labels} suggestion={item.labels.length ? null : suggestLabel(lastTheirs)} onLabels={onLabels} />
        </span>
        <span className="ax-read-actions">
          {phone && <Button tone="accent" onClick={() => placeCall(phone)}>Call</Button>}
          {text && <Button onClick={text}>{item.kind === 'sms' ? 'Reply' : 'Text'}</Button>}
          {assignee !== null && (
            <Menu label={<><Icon name="user" size={13} />{assignee}<ChevronDown size={12} strokeWidth={2.5} aria-hidden /></>} title="Assigned rep" heading="Assign to" empty="No teammates yet"
              items={[...team.map((m) => ({ label: m.name, on: m.name === rec!.rep, run: () => onAssign(m.id, m.name) })), { label: 'Nobody', on: !rec!.rep, run: () => onAssign(null, 'nobody') }]} />
          )}
          <button type="button" className="ax-star ax-star-head" aria-pressed={!!item.pinned} aria-label={item.pinned ? 'Unpin' : 'Pin to the top of the list'} title={item.pinned ? 'Unpin' : 'Pin to the top of the list'} onClick={() => onPin(!item.pinned)}>
            <Star size={15} strokeWidth={2} aria-hidden fill={item.pinned ? 'currentColor' : 'none'} />
          </button>
          {item.archived
            ? <Button onClick={onRestore} title="Back on the list">Restore</Button>
            : <Button onClick={onArchive} title="Archive: off the list until something new happens on it">Close</Button>}
          <Menu className="ax-more" label={<Ellipsis size={15} strokeWidth={2.25} aria-hidden />} title="More" align="end" items={[
            ...(rec ? [{ label: 'Open record', run: rec.open }] : []),
            { label: item.kind === 'email' ? 'Reply in Email' : `Open in ${WHERE[item.kind]}`, run: () => onOpen(item.kind, item.open) },
            { label: 'Mark unread', hint: 'Unread again until you open it', run: onMarkUnread },
          ]} />
        </span>
      </header>
      <div role="tablist" aria-label="Conversation" className="ax-read-tabs">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className="ax-read-tab" onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'messages' ? (
        <>
          {item.title ? <p className="ax-read-title">{item.title}</p> : null}
          <div className="ax-read-msgs">
            {item.convId && sms === null ? (
              <SkeletonRows count={3} label="Loading the conversation" face={false} />
            ) : (msgs.length ? msgs : [{ id: 'last', out: false, at: item.at, text: item.preview, receipt: null, seen: false, receiptTitle: undefined }]).map((m) => (
              <div key={m.id} className="ax-msg" data-out={m.out || undefined} data-sms={item.kind === 'sms' || undefined}>
                <p>{m.text}</p>
                <time dateTime={m.at || undefined}>{stamp(m.at)}</time>
                {m.receipt ? <span className="ax-receipt" data-seen={m.seen || undefined} title={m.receiptTitle}><SeenMark seen={m.seen} size={12} />{m.receipt}</span> : null}
              </div>
            ))}
          </div>
        </>
      ) : tab === 'info' ? (
        <InfoTab rec={rec} name={item.name} phone={phone} email={item.email ?? rec?.recipient?.email ?? null} lastAt={item.at} heat={h} related={related} onOpenRelated={onOpenRelated} onText={text} />
      ) : (
        <NotesTab rec={rec} workspaceId={workspaceId} userId={userId} canWrite={canWrite} toast={toast} />
      )}
    </section>
  );
}
