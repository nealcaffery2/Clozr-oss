// The Inbox: one set of channel tabs (All, SMS, Email, Calls, Voicemail)
// over Talkr's messages page (SMS, ported component-for-component from
// A:\talkr\apps\web into app/components/talkr), the member's Gmail
// (app/components/inbox/EmailInbox) and Talkr's call history. This file is the
// seam: Talkr's tokens are scoped under `.talkr-inbox`, `authed` is whether
// Talkr recognises the rep's sign-in, a call goes out through CLOZR's own
// floating dialer, and CLOZR's templates and record resolver are handed in.
'use client';

import { onInboxSms, onInboxThread, takeInboxSms, takeInboxThread } from '@/app/clozr/screens/inboxHandoff';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { eventFacts, useTalkrEvents } from '@/lib/talkr-events';
import type { ClozrView } from '@/app/clozr/view';
import { MessagesScreen } from '@/app/components/talkr/MessagesScreen';
import { TopBar } from '@/app/components/talkr/TopBar';
import { Icon } from '@/app/components/talkr/Icon';
import { Button } from '@/app/components/talkr/ui';
import type { ClozrRecord, MessagesScreenProps } from '@/app/components/talkr/MessagesScreen';
import { GmailInbox, type QuickDraft } from '@/app/components/inbox/gmail/GmailInbox';
import { GmailThread } from '@/app/components/inbox/gmail/GmailThread';
import { useMailExtras, useTeam } from '@/app/components/inbox/gmail/mail-extras';
import { allReplyFor, headerTextLabel, openInLabel } from '@/lib/inbox-reply';
import { useSenders } from '@/app/components/inbox/senders';
import type { MergeFor, PickerRender } from '@/app/components/inbox/types';
import { CallsList, callLine, theirNumber } from '@/app/components/inbox/CallsList';
import { type EmailRow, type EmailThread, groupThreads, isVoicemail, useCalls, useEmail, useGmailPoll } from '@/app/components/inbox/data';
import { emailPlain } from '@/lib/email-html';
import { TemplatePicker, seg, segWrap } from '@/app/components/templates/TemplatePicker';
import { TemplatesManager } from '@/app/components/templates/TemplatesManager';
import { useTemplates } from '@/app/components/templates/useTemplates';
import type { MessageDto } from '@/lib/talkr-web/api';
import { SkeletonRows } from '@/components/ds/Skeleton';
import { formatPhone, toE164 } from '@/lib/talkr-web/time';
import { fieldsFor, renderMerge } from '@/lib/sms';
import { displayName, useSession } from '@/lib/session';
import { NotHere, NotHereLink, ThreadName } from '@/app/components/inbox/Elsewhere';
import { type Role, isAdmin, seesAllMail } from '@/lib/team';
import { openReach } from '@/app/components/record/reach';
// Styles: talkr-inbox.css, loaded once by ClozrShell (see the note there).
import { type InboxState, isCleared, isUnread, numbersThatWrote, pinnedFirst, smsKey, useInboxState } from '@/lib/inbox-state';
import { threadUnread, useEmailState } from '@/lib/email-state';
import { setTalkrDemo } from '@/lib/talkr-web/api';
import { DEMO_TALKR_ME, DEMO_TEAM, demoEmailRows, demoTalkr } from '@/lib/inbox-demo';
import { type InboxOwner, type OwnerChoice, UNASSIGNED, callOwner, eventTouches, inInbox, lineOwners, linesFor, ownerChoices, ownerTitle } from '@/lib/inbox-owner';
import { type InboxScope, useOwnerThreads, viewingOther } from '@/app/components/inbox/ownerInbox';
import { ArrowUp, Bookmark, ChevronDown, Ellipsis, ListFilter, Star } from 'lucide-react';
import { type SequenceDto } from '@/lib/talkr-web/api';
import { DISPOSITIONS, EMPTY_FILTER, withDefaults, ackOnly, type Folder, type FolderItem, type InboxFilter, type SavedFilter, automatedSender, closedBy, filterCount, folderCounts, inFolder, leftCampaign, matchesFilter, optedOutOf, suggestLabel } from '@/lib/inbox-folders';
import { InboxRail } from '@/app/components/inbox/InboxRail';
import { type HeatChip, LabelChips, heatChip } from '@/app/components/inbox/LabelChips';
import { Menu } from '@/app/components/inbox/Menu';
import { FilterDialog } from '@/app/components/inbox/FilterDialog';
import { type Scheduled, useScheduled } from '@/lib/use-scheduled';
import { useMessageSearch } from '@/lib/inbox-search';
import { Clock } from 'lucide-react';
import { sendsLabel } from '@/lib/inbox-schedule';
import { BulkBar } from '@/app/components/inbox/BulkBar';
import { InfoTab, NotesTab, type RelatedRow } from '@/app/components/inbox/ThreadInfo';
import type { AssignMate } from '@/app/components/bulk/AssignPanel';
import { assignSellers } from '@/lib/crm-write';
import { SKIP_REASON, enrollSellers } from '@/app/components/sequences/enrollSellers';
import { SendToCampaign } from '@/app/components/talkr/Campaigns';
import { PushToCampaign } from '@/app/components/campaigns/PushToCampaign';
import type { SendSeller } from '@/lib/talkr-campaign-send';
import { BLAST_DONE_STAGES, type Blast, type BlastThread, loadBlastThreads, loadBlasts } from '@/lib/dispo-campaign';
import { phoneTail } from '@/lib/bell-events';
import { blastedAbout, dealOptions } from '@/lib/inbox-blast-tags';
import { useBlastTags } from '@/lib/use-blast-tags';
import { BlastChip, ProspectChip } from '@/app/components/inbox/BlastChips';
import { DEMO_BLASTS } from '@/lib/inbox-demo';
import { onWorkspaceReset } from '@/lib/active-workspace';

const TABS = ['All', 'SMS', 'Email', 'Calls', 'Voicemail'] as const;
type Tab = (typeof TABS)[number];
/** A channel's address (/app/inbox/sms, lib/routes.ts); All is the bare /app/inbox. */
const TAB_SLUG: Record<Tab, string | null> = { All: null, SMS: 'sms', Email: 'email', Calls: 'calls', Voicemail: 'voicemail' };
const tabOfSlug = (slug: string | null | undefined): Tab => TABS.find((t) => TAB_SLUG[t] === (slug ?? null)) ?? 'All';

// What the Inbox was showing when the rep left it. The screen unmounts when
// another one opens, so the tab and the thread open on each were lost and
// coming back always landed on All. Kept for the tab's session; unsent text
// is kept per thread in lib/compose-drafts. `owner` is whose inbox: always
// the rep's own when the app opens. It belongs to one user in one workspace:
// a sign-in as someone else, or a workspace switch, starts it over, so the
// next person is not sent to the previous one's threads.
type InboxMemory = { uid: string | null; tab: Tab; smsConv: string | null; emailKey: string | null; callId: string | null; allKey: string | null; owner: InboxOwner; mailOwner: string; folder: Folder; applySaved: SavedFilter | null; openFilter: boolean; deal: string };
const freshMemory = (uid: string | null): InboxMemory => ({
  uid, tab: 'All', smsConv: null, emailKey: null, callId: null, allKey: null, owner: 'me', mailOwner: 'me', folder: 'all', applySaved: null, openFilter: false,
  // Deal blasted (lib/inbox-blast-tags): one deal's id on every tab, '' for every thread. All keeps it in its filter.
  deal: '',
});
const memory: InboxMemory = freshMemory(null);
function forgetMemory(uid: string | null): void {
  Object.assign(memory, freshMemory(uid));
}
onWorkspaceReset(() => forgetMemory(memory.uid));

const rememberDeal = (d: number | null) => { memory.deal = d == null ? '' : String(d); };

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

/** `compact`: a pane beside the dialer's script, one pane at a time like a phone. */
export function Inbox({ V, compact = false }: { V: ClozrView; compact?: boolean }) {
  const one = V.isMobile || compact;
  const session = useSession();
  const workspaceId = V.liveIds?.workspaceId ?? null;
  // Scheduled texts (migration 367): the Scheduled folder, Send later, pending bubbles.
  const scheduled = useScheduled(workspaceId);
  const userId = session.user?.id ?? null;
  // Before anything below reads it: memory left by another user starts over.
  if (memory.uid !== userId) forgetMemory(userId);
  // Opened from "Open in Inbox" on a record: straight to that email thread.
  const [handoff] = useState(() => takeInboxThread());
  // Opened from the bell on a text whose sender is not a contact: that number's thread.
  const [smsHandoff] = useState(() => takeInboxSms());
  // Without a hand-off, back where the rep left it.
  // Beside the dialer (compact) it is the texting pane: it opens on SMS, not on All.
  const [ownTab, setOwnTab] = useState<Tab>(handoff ? 'Email' : smsHandoff || compact ? 'SMS' : memory.tab);
  // The Inbox's channel is in its address (/app/inbox/sms), so Back, a reload
  // and a link come back to it; beside the dialer the pane keeps its own.
  const setInboxTab = V.setInboxTab;
  const tab: Tab = compact ? ownTab : tabOfSlug(V.inboxTab);
  const setTab = useCallback((t: Tab) => (compact ? setOwnTab(t) : setInboxTab(TAB_SLUG[t])), [compact, setInboxTab]);
  useLayoutEffect(() => {
    if (!compact && (handoff || smsHandoff)) setInboxTab(handoff ? 'email' : 'sms');
  }, [compact, handoff, smsHandoff, setInboxTab]);
  const [smsTo, setSmsTo] = useState<string | null>(smsHandoff);
  const [newSms, setNewSms] = useState(0);
  const [emailKey, setEmailKey] = useState<string | null>(handoff ?? (smsHandoff ? null : memory.emailKey));
  useEffect(() => onInboxThread((key) => { setTab('Email'); setEmailKey(key); }), [setTab]);
  useEffect(() => onInboxSms((to) => { setTab('SMS'); setSmsTo(to); }), [setTab]);
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
  // Who sent each text, by Talkr user id (MessagesScreen `senders`).
  const talkrMembers = demoPhone ? DEMO_TEAM : V.talkrPhone.data.team;
  const senderFor = useSenders(onDemo ? null : workspaceId, !onDemo, talkrMembers);
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

  // The folder rail on the channel tabs (lib/inbox-folders): the same folder
  // as the All tab (memory.folder, so it survives switching tabs), counts
  // scoped to the channel, folders that cannot apply there left out. The SMS
  // tab's threads live in MessagesScreen, which filters and counts them
  // itself; Email and Calls are filtered here and handed the shorter list.
  // memory.folder is the source; a pick bumps a counter so this re-renders, and a tab switch re-reads it.
  const [, bumpFolder] = useState(0);
  const folder = memory.folder;
  const setFolder = (f: Folder) => { memory.folder = f; bumpFolder((n) => n + 1); };
  const [smsCounts, setSmsCounts] = useState<Record<Folder, number> | null>(null);
  // Deal blasted: the deals the rail lists (still being marketed), and the one picked.
  const blastWs = onDemo ? null : workspaceId;
  const [blasts, setBlasts] = useState<Blast[]>([]);
  useEffect(() => {
    if (blastWs == null) return;
    let on = true;
    void loadBlasts(blastWs, 60, false).then((r) => { if (on && r.ok) setBlasts(r.data); });
    return () => { on = false; };
  }, [blastWs]);
  const blastDeals = useMemo<{ deal_id: number; address: string }[]>(() => (onDemo ? DEMO_BLASTS
    : blasts.filter((b, n) => blasts.findIndex((x) => x.deal_id === b.deal_id) === n && !BLAST_DONE_STAGES.includes(b.stage ?? ''))), [onDemo, blasts]);
  const deal = memory.deal ? Number(memory.deal) : null;
  const setDeal = (d: number | null) => { rememberDeal(d); bumpFolder((n) => n + 1); };
  const dealName = (d: number | null) => (d == null ? null : blastDeals.find((b) => b.deal_id === d)?.address ?? `Deal ${d}`);
  const mailCounterparts = useMemo(() => email.threads.map((t) => t.counterpart), [email.threads]);
  const mailBlast = useBlastTags(workspaceId, [], mailCounterparts, onDemo);
  const emailInDeal = useCallback((t: EmailThread) => deal == null || blastedAbout(mailBlast(null, t.counterpart), deal), [deal, mailBlast]);
  const mailState = useEmailState(V.liveIds?.workspaceId ?? null, userId);
  const emailItems = useMemo(() => email.threads.map((t): FolderItem & { key: string } => ({
    key: t.key, kind: 'email', unread: threadUnread(t.rows, mailState.read, mailState.seenThrough), missed: false,
    theyLast: t.last.direction === 'inbound', optedOut: false, archived: isCleared(t.last.occurred_at, inboxState.state.get(`email:${t.key}`)),
    closed: automatedSender(t.counterpart) || closedBy(inboxState.state.get(`email:${t.key}`)?.labels),
    scheduled: !!t.counterpart && scheduled.byEmail.has(t.counterpart.toLowerCase()),
  })), [email.threads, mailState.read, mailState.seenThrough, inboxState.state, scheduled.byEmail]);
  const callItems = useMemo(() => scopedCalls.calls.map((h): FolderItem & { key: string } => {
    const missed = (h.direction === 'inbound' && !h.duration_seconds) || isVoicemail(h);
    return { key: h.id, kind: 'call', unread: missed, missed, theyLast: h.direction === 'inbound', optedOut: false, archived: isCleared(h.at, inboxState.state.get(`call:${h.id}`)) };
  }), [scopedCalls.calls, inboxState.state]);
  const emailShown = useMemo(() => ({ ...email, threads: email.threads.filter((t, i) => emailInDeal(t) && inFolder(emailItems[i]!, folder)) }), [email, emailItems, folder, emailInDeal]);
  const emailCounted = useMemo(() => emailItems.filter((_, i) => emailInDeal(email.threads[i]!)), [emailItems, email.threads, emailInDeal]);
  const callsShown = useMemo(() => ({ ...scopedCalls, calls: scopedCalls.calls.filter((h, i) => inFolder(callItems[i]!, folder)) }), [scopedCalls, callItems, folder]);
  const railFor = (kind: FolderItem['kind'], counts: Record<Folder, number>) => (
    <InboxRail kind={kind} folder={folder} counts={counts} onFolder={setFolder} saved={inboxState.filters} savedId={null}
      onSaved={(f) => { memory.applySaved = f; setTab('All'); }}
      onNewFilter={() => { memory.openFilter = true; setTab('All'); }}
      onRemoveFilter={(f) => inboxState.removeFilter(f.id)}
      onQuickReplies={workspaceId ? () => setManager('sms') : null}
      {...(kind === 'call' ? {} : { blasts: blastDeals, blastDeal: deal, onBlast: setDeal })} />
  );

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

  // New text and Templates: labelled chips beside the channel tabs on a desk.
  // On a phone (`one`) they are icon buttons: beside the All list's search,
  // or at the right of the channel row on the tabs that have no search.
  const tools = (
    <>
      {tab !== 'Email' ? (
        <button type="button" className={one ? 'ax-tool ax-tool-icon' : 'tray-btn'} aria-label={one ? 'New text' : undefined} onClick={() => { setTab('SMS'); setSmsTo(null); setNewSms((n) => n + 1); }} title="Text any number: one that already has a thread opens it, with its history">
          <Icon name="edit" size={one ? 16 : 14} />{one ? null : ' New text'}
        </button>
      ) : null}
      {/* Beside the dialer the composer's own picker is enough. */}
      {compact ? null : <button type="button" className={one ? 'ax-tool ax-tool-icon' : 'tray-btn'} aria-label={one ? 'Templates' : undefined} onClick={() => setManager('any')} disabled={!workspaceId} title={workspaceId ? 'SMS and email templates' : 'Templates run on a signed-in workspace'}>
        <Icon name="template" size={one ? 16 : 14} />{one ? null : ' Templates'}
      </button>}
    </>
  );
  const seg5 = (
    <span role="tablist" aria-label="Channel" style={segWrap}>
      {TABS.map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} style={{ ...seg(tab === t), height: 26, padding: '0 11px', fontSize: 12.5 }} onClick={() => pickTab(t)}>{t}</button>
      ))}
    </span>
  );
  const tabs = one ? (
    // One strip: the segment scrolls, the icons stay put at the right.
    <span className="ax-chan">{seg5}{tab === 'All' ? null : tools}</span>
  ) : (
    <>{seg5}{tools}</>
  );

  // What the SMS tab hands its thread and composer, so a text thread opened on
  // All replies through the same MessagesScreen send path: the From line,
  // templates, merge fields, the carrier check, opt-out and quiet-hours
  // refusals, Send later and the copy filed on the record.
  const smsShared = {
    authed, scope, receiptsWorkspace: onDemo ? null : workspaceId, placeCall: V.dialE164, onNewCall: V.openDialer,
    recordFor, scheduled, senders: senderFor, orgName: V.workspaceName,
    live: V.liveIds ? { workspaceId: V.liveIds.workspaceId, canWrite: V.liveIds.canWrite, me: userId, toast: V.showToast, reload: V.reloadCrm } : null,
    clozrTemplates: ({ record, name, phone, insert, close }) => picker({
      channel: 'sms', audience: record?.kind ?? 'any', onClose: close,
      onPick: (t) => insert(renderMerge(t.body_text, mergeFor(record, name ?? '', phone ?? ''))),
    }),
  } satisfies Partial<MessagesScreenProps>;
  // The Email tab's Reply and Compose: the docked quick email.
  const composeEmail = (d: QuickDraft, done: () => void) => openReach('email', {
    name: d.name ?? '', email: d.to ?? '', subject: d.subject, inReplyTo: d.inReplyTo,
    sellerId: d.sellerId, buyerId: d.buyerId, dealId: d.dealId, editableTo: !d.to, onSent: done,
  });
  // A thread opened on All borrows its channel tab's own reply box (lib/inbox-reply).
  const replyBoxes: ReplyBoxes = {
    sms: (convId, onThread) => (
      <MessagesScreen {...smsShared} key={convId} threadOnly onePane conversation={convId} onThread={onThread} />
    ),
    email: (thread) => (
      <AllMail thread={thread} workspaceId={workspaceId} demo={demo} userId={userId} email={email} recordFor={recordFor}
        dealFor={V.dealForId} deals={V.mailDeals} mergeFor={mergeFor} picker={picker} placeCall={V.dialE164} toast={V.showToast} onCompose={composeEmail} />
    ),
  };

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
          {...smsShared}
          key={`${smsTo ?? 'sms'}:${owner}`}
          titleLevel={compact ? 2 : 1}
          to={smsTo}
          conversation={smsTo ? null : memory.smsConv}
          onOpen={onSmsOpen}
          onRead={onSmsRead}
          inbox={inboxState}
          folder={folder}
          blast={{ workspace: workspaceId, demo: onDemo, deal, dealName: dealName(deal), onClear: () => setDeal(null) }}
          rail={railFor('sms', smsCounts ?? folderCounts([], 'sms'))}
          railOne={one}
          onePane={one}
          onFolderCounts={setSmsCounts}
          startNew={newSms}
          headerSlot={tabs}
          titleSlot={ownerSwitch}
        />
      ) : tab === 'Email' ? (
        // The same TopBar as All, Calls and Voicemail, so switching tabs does
        // not move the header; the mail search sits at the top of the list.
        <>
          <TopBar level={compact ? 2 : 1} title="Inbox" subtitle={subtitleFor(tab, email.threads.length, scopedCalls.calls)} onNewCall={V.openDialer} titleSlot={ownerSwitch}>{tabs}</TopBar>
          <div className="ax-desk" data-one={one || undefined}>
          {railFor('email', folderCounts(emailCounted, 'email'))}
          <div className="ax-tabfull">
          {deal != null ? <DealNote name={dealName(deal)} onClear={() => setDeal(null)} /> : null}
          <GmailInbox
            key={`${mailOwner}|${emailKey ?? 'email'}|${folder}`}
            mailbox={mailOwner === 'me' ? userId : mailOwner}
            workspaceId={workspaceId} demo={demo} userId={userId} email={emailShown}
            recordFor={recordFor} dealFor={V.dealForId} deals={V.mailDeals} seesAllMail={allMail} blastFor={(addr) => mailBlast(null, addr)}
            mergeFor={mergeFor} picker={picker} placeCall={V.dialE164}
            openKey={emailKey} toast={V.showToast}
            onPicked={(key) => { memory.emailKey = key; }}
            onCompose={composeEmail}
          />
          </div>
          </div>
        </>
      ) : (
        <>
          <TopBar level={compact ? 2 : 1} title="Inbox" subtitle={subtitleFor(tab, email.threads.length, scopedCalls.calls, scope)} onNewCall={V.openDialer} titleSlot={ownerSwitch}>{tabs}</TopBar>
          {(tab === 'Calls' || tab === 'Voicemail') && (
            <div className="ax-desk" data-one={one || undefined}>
              {railFor('call', folderCounts(callItems, 'call'))}
              <div className="ax-tabfull">
                <CallsList key={`${callId ?? 'calls'}:${owner}`} calls={callsShown} voicemailOnly={tab === 'Voicemail'} authed={authed} recordFor={recordFor} placeCall={V.dialE164} openId={callId}
                  onSeen={(h) => { inboxState.seen(`call:${h.id}`); V.bellReadNumber(theirNumber(h)); }} />
              </div>
            </div>
          )}
          {tab === 'All' && (
            <AllList key={owner} V={V} one={one} email={email} calls={scopedCalls} onOpen={openFromAll} inbox={inboxState} userId={userId} myEmail={email.account?.email ?? session.user?.email ?? (onDemo ? 'taylor@acmehomes.com' : null)}
              authed={authed} scope={scope} allMail={allMail} receiptsWorkspace={onDemo ? null : workspaceId} scheduled={scheduled}
              onQuickReplies={workspaceId ? () => setManager('sms') : null} tools={one ? tools : null}
              blastDeals={blastDeals} demo={onDemo} reply={replyBoxes} />
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

/** The Deal blasted filter in force, and the way off it. */
function DealNote({ name, onClear }: { name: string | null; onClear: () => void }) {
  return (
    <p className="ax-note" role="status" data-testid="inbox-blast-note"><Icon name="msg" size={13} />
      Only people the {name ?? 'deal'} blast reached.
      <button type="button" className="ax-link" onClick={onClear}>Show every thread</button></p>
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
  theyLast: boolean; missed: boolean; optedOut: boolean; archived: boolean; scheduled?: boolean; closed?: boolean; cold?: boolean;
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
/** The item's name, or null when it is only the number (ThreadName then tries the other workspaces). */
const titled = (i: AllItem) => (i.rec || !i.phone || i.name !== formatPhone(i.phone) ? i.name : null);

/**
 * Everything, newest first: SMS threads, email threads and calls, filed in
 * folders (lib/inbox-folders) down a rail on the left, with label chips on
 * each row and the open conversation on the right (one pane at a time on a
 * phone), so a reply, a call and the record are a click from the list.
 */
function AllList({ V, one, email, calls, onOpen, inbox, userId, myEmail, authed, scope, allMail, receiptsWorkspace, onQuickReplies, scheduled, tools = null, blastDeals, demo, reply }: {
  V: ClozrView; one: boolean; email: ReturnType<typeof useEmail>; calls: ReturnType<typeof useCalls>;
  onOpen: (kind: Kind, key: string) => void; inbox: InboxState; userId: string | null;
  /** The viewer's address: what "You" means in a mailbox that also holds mail a teammate cc'd them on. */
  myEmail: string | null;
  authed: boolean; scope: InboxScope; allMail: boolean; receiptsWorkspace: number | null;
  onQuickReplies: (() => void) | null;
  scheduled: Scheduled;
  /** Phone: New text and Templates as icons, drawn beside the search. */
  tools?: React.ReactNode;
  /** Deals still being marketed, for the rail's Deal blasts. */
  blastDeals: { deal_id: number; address: string }[];
  /** Sample data: blast labels come from lib/inbox-demo. */
  demo: boolean;
  /** The SMS and Email tabs' own thread and composer, for the open thread. */
  reply: ReplyBoxes;
}) {
  // This inbox's threads (ownerInbox): the owner's lines and assignments,
  // live off the phone's one event stream.
  // 200, the most the list draws: at 60 a blast of a few hundred texts pushed
  // every older reply off Unreplied and Awaiting reply (2026-10-23).
  const owned = useOwnerThreads(scope, authed, 200);
  // One row per number: a buyer texted from two of our lines was two rows
  // sharing one read and pin state. The newest thread stands for both.
  const ownedConvs = owned.convs;
  const convs = useMemo(() => {
    const by = new Map<string, (typeof ownedConvs)[number]>();
    for (const c of ownedConvs) {
      const k = smsKey(c.their_number);
      const had = by.get(k);
      by.set(k, had ? { ...had, unread_count: had.unread_count + c.unread_count } : c);
    }
    return [...by.values()];
  }, [ownedConvs]);
  // Numbers that have ever texted us, for Awaiting reply (inFolder `cold`).
  const ws = V.liveIds?.workspaceId ?? null;
  const ourLast = convs.filter((c) => c.last_message?.direction === 'outbound').map((c) => c.their_number).sort().join(',');
  const [wrote, setWrote] = useState<{ key: string; set: Set<string> } | null>(null);
  useEffect(() => {
    if (ws == null || !ourLast) return;
    let on = true;
    void numbersThatWrote(ws, ourLast.split(',')).then((set) => { if (on && set) setWrote({ key: ourLast, set }); });
    return () => { on = false; };
  }, [ws, ourLast]);
  const wroteSet = wrote?.key === ourLast ? wrote.set : null;
  // Someone else's inbox is looked at, not worked: their unread stays theirs.
  const other = viewingOther(scope);
  const [q, setQ] = useState('');
  // A saved filter picked, or New saved filter pressed, on a channel tab's rail lands here on mount.
  const [folder, setFolderState] = useState<Folder>(() => (memory.applySaved ? 'all' : memory.folder));
  // Deal blasted rides in the filter here and in memory.deal for the SMS and Email tabs.
  const [filter, setFilter] = useState<InboxFilter>(() => (memory.applySaved ? withDefaults(memory.applySaved.filter) : { ...EMPTY_FILTER, deal: memory.deal }));
  useEffect(() => { memory.deal = filter.deal; }, [filter.deal]);
  const [savedId, setSavedId] = useState<string | null>(() => { const f = memory.applySaved; memory.applySaved = null; return f?.id ?? null; });
  const [filterOpen, setFilterOpen] = useState(() => { const o = memory.openFilter; memory.openFilter = false; return o; });
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [toCampaign, setToCampaign] = useState(false);
  const [toSms, setToSms] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(memory.allKey);
  useEffect(() => { memory.allKey = openKey; }, [openKey]);
  useEffect(() => { memory.folder = folder; }, [folder]);
  const setFolder = (f: Folder) => { setFolderState(f); setSavedId(null); setSel(new Set()); };
  // Email read state, the same the Email tab keeps (lib/email-state, migration 73).
  const mail = useEmailState(V.liveIds?.workspaceId ?? null, userId);
  // Live off the phone's one event stream (lib/talkr-events): the threads are
  // the phone's own list (the open text thread is MessagesScreen, live on its
  // own), `tick` re-reads the deal's blast threads after a send, and a call
  // event re-reads the calls. Coming back to the tab
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
        optedOut: optedOutOf(c.contact_status, c.tags, out ? null : body), closed: out ? leftCampaign(body) : ackOnly(body), tags: c.tags ?? [], owner: c.assigned_user_name, temp: c.temperature,
        // Not known until the read lands: shown as awaiting meanwhile.
        cold: out && !!wroteSet && !wroteSet.has(c.their_number),
      };
    }),
    // Email is each rep's own mailbox (migration 107): a teammate's inbox here is their texts and calls.
    ...(other ? [] : email.threads).map((t): AllItem => {
      const rec = t.counterpart ? recordFor(t.counterpart) : null;
      const theirs = t.rows.filter((r) => r.direction === 'inbound');
      const lastTheirs = theirs[theirs.length - 1];
      // My mailbox also holds mail a teammate cc'd me on. Its rows are
      // "outbound" (a workspace address sent them), but they are not mine:
      // the list names the sender, never "You", and a thread I am only
      // copied on is marked Cc and asks nothing of me.
      const mine = fromMe(t.last, myEmail);
      const ccOnly = !!myEmail && t.rows.every((r) => !fromMe(r, myEmail) && !listsAddress(r.to_email, myEmail)) && t.rows.some((r) => listsAddress(r.cc_email, myEmail));
      const sender = mine ? 'You' : t.last.direction === 'outbound' ? senderName(t.last.from_email) : null;
      return {
        ...base, key: `email:${t.key}`, at: t.last.occurred_at, kind: 'email', open: t.key, rec, thread: t,
        phone: rec?.recipient?.phone ? toE164(rec.recipient.phone) || null : null, email: t.counterpart?.includes('@') ? t.counterpart : null,
        name: rec?.name ?? t.counterpart ?? 'Email', unread: threadUnread(t.rows, mail.read, mail.seenThrough),
        label: ccOnly ? 'Email · Cc' : 'Email', title: t.subject,
        preview: `${sender ? `${sender}: ` : ''}${emailPlain(t.last.body ?? t.last.preview ?? '').replace(/\s+/g, ' ').slice(0, 200)}`,
        theyLast: !ccOnly && t.last.direction === 'inbound', lastTheirsAt: lastTheirs?.occurred_at ?? '', lastTheirsText: '', unreadCount: 1, cold: !lastTheirs,
        closed: automatedSender(t.counterpart),
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
      // A thread with a text (367) or an email (373) written now and waiting on its send time.
      const pending = i.kind === 'sms' ? scheduled.byThread.has(stateKey(i)) : i.kind === 'email' && !!i.email && scheduled.byEmail.has(i.email.toLowerCase());
      // A missed call opened since it rang is handled: off Missed, still on All (2026-10-23).
      return { ...i, unread: isUnread(i.unread, i.at, st), missed: i.missed && isUnread(true, i.at, st), pinned: !!st?.pinned_at, archived: isCleared(i.at, st), labels: st?.labels ?? [], scheduled: pending, closed: !!i.closed || closedBy(st?.labels) };
    }),
    stateKey, inbox.state,
  );
  // Deal blasted (the rail's Deal blasts, or the filter): every buyer the
  // deal's blasts texted, read from CLOZR (loadBlastThreads), so a reply never
  // drops off Talkr's newest threads, plus any other thread (an email) whose
  // person that deal's blast reached (lib/inbox-blast-tags). A deal that
  // reaches Buyer Under Contract, In Escrow, Closed or Terminated leaves the
  // rail; the filter can still pick it.
  const deal = filter.deal ? Number(filter.deal) : null;
  const setBlastDeal = (d: number | null) => { setFilter((f) => ({ ...f, deal: d == null ? '' : String(d) })); setSavedId(null); };
  const [blastGot, setBlastGot] = useState<{ deal: number; rows: BlastThread[] } | null>(null);
  // Re-read when anything new lands in the inbox: a blast reply comes in at the top.
  const blastStamp = items[0] ? `${items[0].key}|${items[0].at}` : '';
  const readsBlasts = deal != null && receiptsWorkspace != null;
  useEffect(() => {
    if (deal == null || !readsBlasts) return;
    let on = true;
    void loadBlastThreads(deal).then((r) => { if (on) setBlastGot({ deal, rows: r.ok ? r.data : [] }); });
    return () => { on = false; };
  }, [deal, readsBlasts, blastStamp, tick]);
  const blastRows = deal != null && blastGot?.deal === deal ? blastGot.rows : null;
  // The labels: who a deal blast reached, for every thread on screen.
  const tagPhones = [...visible.map((i) => i.phone), ...(blastRows ?? []).map((t) => t.phone)];
  const tagEmails = visible.map((i) => i.email ?? i.rec?.recipient?.email ?? null);
  const blastTag = useBlastTags(ws, tagPhones, tagEmails, demo);
  const tagFor = (i: AllItem) => blastTag(i.phone, i.email ?? i.rec?.recipient?.email ?? null);
  const blastItems = (blastRows ?? []).map((t): AllItem => {
    // A thread Talkr already listed keeps its richer row (unread count, tags, owner).
    const have = visible.find((i) => i.kind === 'sms' && !!i.phone && phoneTail(i.phone) === phoneTail(t.phone));
    if (have) return have;
    const rec = recordFor(t.phone);
    const st = inbox.state.get(smsKey(t.phone));
    const labels = st?.labels ?? [];
    const optedOut = optedOutOf(null, null, t.theyLast ? t.body : null);
    return {
      ...base, key: `sms:${t.convId}`, at: t.at, kind: 'sms', open: t.phone, rec, phone: t.phone, convId: t.convId,
      name: rec?.name ?? t.name, unread: !optedOut && isUnread(t.theyLast, t.at, st), unreadCount: t.theyLast ? 1 : 0, label: 'Text',
      preview: `${t.theyLast ? '' : 'You: '}${t.body}`, theyLast: t.theyLast, lastTheirsAt: t.lastTheirsAt, lastTheirsText: t.lastTheirsText,
      optedOut, cold: !t.lastTheirsAt, pinned: !!st?.pinned_at, archived: isCleared(t.at, st), labels, closed: closedBy(labels) || (t.theyLast ? ackOnly(t.body) : leftCampaign(t.body)),
    };
  });
  const dealItems = deal == null ? null : (() => {
    const keys = new Set(blastItems.map((i) => i.key));
    const more = visible.filter((i) => !keys.has(i.key) && blastedAbout(tagFor(i), deal));
    return pinnedFirst([...blastItems, ...more].sort((a, b) => Date.parse(b.at || '0') - Date.parse(a.at || '0')), stateKey, inbox.state);
  })();
  /** What the list and the rail's counts work from: one deal's inbox, or everything. */
  const list = dealItems ?? visible;
  const view = `${folder}|${deal ?? ''}`;
  // The Deal blasted picker: deals the threads on screen were blasted about, with how many, then the rail's other live deals.
  const dealOptionsAll = (() => {
    const opts = dealOptions(visible.map(tagFor));
    for (const b of blastDeals) if (!opts.some((o) => o.dealId === b.deal_id)) opts.push({ dealId: b.deal_id, line1: b.address, count: 0 });
    if (deal != null && !opts.some((o) => o.dealId === deal)) opts.push({ dealId: deal, line1: `Deal ${deal}`, count: dealItems?.length ?? 0 });
    return opts;
  })();
  const counts = folderCounts(list);
  const heatOf = (i: AllItem) => heatChip(i.rec?.score, i.temp);
  /** Every label a row carries, for the filter: dispositions, the stage, the heat word. */
  const labelsOf = (i: AllItem) => [...i.labels, ...(i.rec?.stage ? [i.rec.stage] : []), ...(heatOf(i) ? [heatOf(i)!.label] : [])];
  // The thread open stays on the list it was opened from until the rep moves
  // on, even when opening it (or a new text) files it in another folder:
  // opening a reply under Awaiting reply made it vanish (2026-10-23).
  const [openedIn, setOpenedIn] = useState('');
  const open = (i: AllItem) => {
    setOpenKey(i.key);
    setOpenedIn(view);
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
  // The deal's list already is the deal's people: the rest of the filter applies on top.
  const rest = deal == null ? filter : { ...filter, deal: '' };
  // "In messages": every text's words, from Postgres (lib/inbox-search,
  // migration 367), on top of the names and previews searched here. The
  // folder and the filter still apply: the match only adds threads.
  const [inMessages, setInMessages] = useState(true);
  const [withCampaign, setWithCampaign] = useState(false);
  const deep = useMessageSearch(inMessages && !other ? receiptsWorkspace : null, q, withCampaign);
  let shown = list.filter((i) => (inFolder(i, folder) || (i.key === openKey && openedIn === view))
    && (!filtering || matchesFilter({ kind: i.kind, labels: labelsOf(i), lastTheirsAt: i.lastTheirsAt, phone: i.phone, tags: i.tags, owner: i.owner }, rest))
    && (!needle || [i.name, i.title, i.preview, i.rec?.address].some((v) => v?.toLowerCase().includes(needle))
      || (i.kind === 'sms' && deep.hits.has(stateKey(i)))));
  // Unreplied: the ones nobody has read yet first, then newest, so the stalest open question is never buried.
  if (folder === 'unreplied') shown = shown.map((i, n) => ({ i, n })).sort((a, b) => Number(b.i.unread) - Number(a.i.unread) || a.n - b.n).map((x) => x.i);

  const today = startOfDay(new Date());
  const groups: { label: string; rows: AllItem[] }[] = [];
  for (const i of shown.slice(0, 200)) {
    const label = dayGroup(i.at, today);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(i); else groups.push({ label, rows: [i] });
  }
  const loading = (!other && email.loading) || calls.loading || owned.loading || (readsBlasts && !blastRows);
  const picked = openKey ? list.find((i) => i.key === openKey) ?? visible.find((i) => i.key === openKey) ?? null : null;
  // A phone (or the dialer's pane) has room for one pane: the list, or the conversation with a Back.

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
  const selected = list.filter((i) => sel.has(i.key));
  const sellerRecs = uniq(selected.filter((i) => i.rec?.kind === 'seller' && i.rec.id != null).map((i) => i.rec!));
  const canWrite = !!V.liveIds?.canWrite;
  const toast = V.showToast;
  const done = () => setSel(new Set());
  const markRead = (list: AllItem[]) => list.forEach((i) => {
    inbox.seen(stateKey(i));
    if (i.kind !== 'email' && i.phone) V.bellReadNumber(i.phone);
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
  // Archived is handled: its missed call, voicemail or text leaves the bell too.
  const archive = (list: AllItem[]) => { list.forEach((i) => { inbox.clear(stateKey(i)); if (i.kind !== 'email' && i.phone) V.bellReadNumber(i.phone); }); if (list.some((i) => i.key === openKey)) setOpenKey(null); };

  const relatedTo = (p: AllItem) => visible.filter((i) => i.key !== p.key && ((p.phone && i.phone === p.phone) || (p.rec && i.rec && i.rec.kind === p.rec.kind && i.rec.id === p.rec.id)))
    .slice(0, 8).map((i) => ({ key: i.key, kind: i.kind, label: i.label, preview: i.preview, at: i.at, title: i.title }));
  const allSelected = shown.length > 0 && shown.every((i) => sel.has(i.key));

  return (
    <div className="ax-desk" data-one={one || undefined}>
    {(!one || !picked) && (
      <InboxRail folder={folder} counts={counts} onFolder={setFolder} saved={inbox.filters} savedId={savedId}
        onSaved={(s) => { setFilter(withDefaults(s.filter)); setSavedId(s.id); setFolderState('all'); setSel(new Set()); }}
        onNewFilter={() => setFilterOpen(true)}
        onRemoveFilter={(s) => { inbox.removeFilter(s.id); if (savedId === s.id) { setSavedId(null); setFilter(EMPTY_FILTER); } }}
        onQuickReplies={onQuickReplies}
        blasts={blastDeals} blastDeal={deal} onBlast={(d) => { setBlastDeal(d); setSel(new Set()); }} />
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
          onCampaign={() => setToCampaign(true)} onPush={() => setToSms(true)} />
      ) : (
      <div className="ax-bar">
        <label className="ax-check ax-check-all" title={allSelected ? 'Clear the selection' : 'Select every thread shown'}>
          <input type="checkbox" checked={allSelected} disabled={!shown.length} onChange={() => setSel(allSelected ? new Set() : new Set(shown.map((i) => i.key)))} aria-label="Select all shown" />
        </label>
        <label className="ax-search">
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={one ? 'Search' : 'Search names, messages, addresses'} aria-label="Search the inbox" />
        </label>
        {tools}
        <button type="button" className="ax-chip" aria-pressed={filtering} aria-label={one ? 'Filters' : undefined} onClick={() => setFilterOpen(true)} title="Filter threads by label, response date, area code, tag, rep or channel">
          <ListFilter size={one ? 16 : 13} strokeWidth={2.25} aria-hidden />{one ? null : 'Filters'}{filtering ? <span className="ax-chip-n">{filterCount(filter)}</span> : null}
        </button>
        {/* Phone: the whole list read or cleared at once lives under More, not on a row of its own. */}
        {one && !other && shown.length ? (
          <Menu className="ax-bar-more" label={<Ellipsis size={16} strokeWidth={2.25} aria-hidden />} title="More" align="end" items={[
            { label: 'Read all', hint: 'Mark every conversation shown here read', disabled: !shown.some((i) => i.unread), run: () => { const n = shown.filter((i) => i.unread).length; markRead(shown); toast(`${n} marked read`); } },
            { label: 'Clear all', hint: 'Clear every conversation shown here to Archived; a new message brings it back', run: () => { const n = shown.length; archive(shown); toast(`${n} cleared to Archived. A new message brings one back.`); } },
          ]} />
        ) : null}
        {needle ? (
          <label className="ax-search-scope" title="Search every text's words too, not only names and the last message">
            <input type="checkbox" checked={inMessages} onChange={(e) => setInMessages(e.target.checked)} />In messages
          </label>
        ) : null}
        {needle && inMessages ? (
          <label className="ax-search-scope" title="Campaign, sequence and AI agent texts are left out unless this is on">
            <input type="checkbox" checked={withCampaign} onChange={(e) => setWithCampaign(e.target.checked)} />Include campaign texts
          </label>
        ) : null}
        {needle || one ? null : (
          <span className="ax-count" role="status">
            {loading && !items.length ? 'Loading…' : `${shown.length} ${shown.length === 1 ? 'conversation' : 'conversations'}`}
          </span>
        )}
        {/* Desk, second row: the whole list read or cleared at once. */}
        {!one && !other && shown.length ? <span className="ax-break" aria-hidden /> : null}
        {!one && !other && shown.length ? (
          <>
            <button type="button" className="ax-chip" disabled={!shown.some((i) => i.unread)} data-testid="inbox-read-all"
              onClick={() => { const n = shown.filter((i) => i.unread).length; markRead(shown); toast(`${n} marked read`); }}
              title="Mark every conversation shown here read">Read all</button>
            <button type="button" className="ax-chip" data-testid="inbox-clear-all"
              onClick={() => { const n = shown.length; archive(shown); toast(`${n} cleared to Archived. A new message brings one back.`); }}
              title="Clear every conversation shown here to Archived; a new message brings it back">Clear all</button>
          </>
        ) : null}
      </div>
      )}

      <div className="ax-scroll" ref={scrollRef} onScroll={() => { if (fresh && folder === 'all' && (scrollRef.current?.scrollTop ?? 0) < 40) setFresh(false); }}>
        {fresh ? (
          <button type="button" className="ax-fresh" onClick={jump}><ArrowUp size={13} strokeWidth={2.5} aria-hidden />New activity</button>
        ) : null}
        {deal != null ? <DealNote name={dealOptionsAll.find((o) => o.dealId === deal)?.line1 ?? null} onClear={() => setBlastDeal(null)} /> : null}
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
        {needle && shown.length > 0 ? (
          <p className="ax-note" role="status"><Icon name="search" size={13} />
            {deep.searching ? 'Searching every text…' : `${shown.length} ${shown.length === 1 ? 'conversation mentions' : 'conversations mention'} “${q.trim()}”${inMessages && !withCampaign && deep.hits.size ? ', campaign texts left out' : ''}`}
          </p>
        ) : null}
        {deep.error && (
          <p className="ax-note" role="alert"><Icon name="search" size={13} />Message search did not run: {deep.error}. Names and previews are still searched.</p>
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
                const t = tagFor(i);
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
                        <span className="ax-name"><ThreadName name={titled(i)} phone={i.phone} /></span>
                        <span className="ax-sub">
                          {i.rec ? (
                            <>
                              {t?.prospect && i.rec.kind === 'buyer' ? null : <span className={`ax-badge ax-badge-${i.rec.kind}`}>{i.rec.kind === 'seller' ? 'Seller' : 'Buyer'}</span>}
                              <ProspectChip tag={t} />
                              <BlastChip tag={t} />
                              {i.rec.address && !t ? <span className="ax-addr" title={i.rec.address}>{i.rec.address}</span> : null}
                            </>
                          ) : t ? <><ProspectChip tag={t} /><BlastChip tag={t} /></> : <span className="ax-addr"><NotHere phone={i.phone} /></span>}
                        </span>
                      </span>
                      <span className="ax-body">
                        <span className="ax-kind" data-alert={i.alert || undefined}><Icon name={KIND_ICON[i.kind]} size={12} />{i.label}</span>
                        {i.title ? <span className="ax-title">{i.title}</span> : null}
                        {needle && i.kind === 'sms' && deep.hits.get(stateKey(i)) ? (
                          <span className="ax-preview ax-mark" title={`${deep.hits.get(stateKey(i))!.hits} matching ${deep.hits.get(stateKey(i))!.hits === 1 ? 'text' : 'texts'}`}
                            dangerouslySetInnerHTML={{ __html: deep.hits.get(stateKey(i))!.snippet }} />
                        ) : <span className="ax-preview">{i.preview}</span>}
                      </span>
                      <time className="ax-time" dateTime={i.at || undefined}>{rowTime(i.at, today)}</time>
                    </button>
                    <LabelChips compact stage={t?.prospect && /^prospect$/i.test(i.rec?.stage ?? '') ? null : i.rec?.stage} heat={h} labels={i.labels} suggestion={i.labels.length ? null : suggestLabel(i.lastTheirsText)} onLabels={(l) => inbox.label(stateKey(i), l)} />
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
      <AllThread key={picked.key} item={picked} reply={reply} onSent={refresh} scheduled={scheduled} onOpen={onOpen} placeCall={V.dialE164} onBack={one ? () => setOpenKey(null) : undefined}
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
        deals={dealOptionsAll}
        onApply={(f) => { setFilter(f); setSavedId(null); setFilterOpen(false); }}
        onSave={(name, f) => { const id = inbox.saveFilter(name, f); setFilter(f); setSavedId(id); toast(`“${name}” saved to the rail`, 'success'); }}
        onClose={() => setFilterOpen(false)} />
    ) : null}
    {toSms && sellerRecs.length ? (
      <PushToCampaign workspaceId={V.liveIds?.workspaceId ?? null} toast={toast}
        audience={{ kind: 'ids', ids: sellerRecs.map((r) => r.id!), label: `${sellerRecs.length} selected in the Inbox` }}
        onClose={() => setToSms(false)} onGo={() => { setToSms(false); done(); V.goCampaigns(); }} />
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
  awaiting: 'Nothing awaiting a reply', scheduled: 'Nothing scheduled', optout: 'Nobody has opted out', archived: 'Nothing archived',
};
const EMPTY_H: Record<Folder, string> = {
  all: 'Texts, email and calls land here as they come in, newest first.', unread: 'A new text, email or missed call shows up here.',
  missed: 'Calls that ring out on your lines land here, voicemail included.', unreplied: 'Threads where they wrote last land here.',
  awaiting: 'Threads where you wrote last land here.', scheduled: 'Write a text, then use the clock beside Send to pick when it goes out.', optout: 'Contacts marked DNC or who texted STOP land here.',
  archived: 'Close a thread and it waits here until something new happens on it.',
};

const sameAddress = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
/** Whether an address list (to, cc) names this address. */
const listsAddress = (list: string | null | undefined, addr: string) => !!list && list.toLowerCase().includes(addr.trim().toLowerCase());
/**
 * Mine: sent from my address. "Outbound" only says a workspace address sent
 * it; in my mailbox that includes a teammate's email I was copied on. With
 * no address to compare (sample data), outbound is taken as mine.
 */
const fromMe = (r: EmailRow, me: string | null) => r.direction === 'outbound' && (!me || !r.from_email || sameAddress(r.from_email, me));
/** "casey@yourcompany.com" reads as Casey. */
const senderName = (addr: string | null | undefined) => {
  const local = String(addr ?? '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Teammate';
};

const stamp = (iso: string) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
type ThreadTab = 'messages' | 'info' | 'notes';

/**
 * The SMS and Email tabs' own reply boxes, handed down from the Inbox so a
 * thread opened on All is answered with the same components and send paths.
 * `onThread` hears the text thread's messages, for the suggested label.
 */
type ReplyBoxes = {
  sms: (convId: string, onThread: (messages: MessageDto[]) => void) => React.ReactNode;
  email: (thread: EmailThread) => React.ReactNode;
};

/**
 * An email thread opened on All: the Email tab's reading view (GmailThread)
 * with its Reply, Reply all and Forward, its files, read receipts and deal
 * filing. Reply opens the docked quick email, as it does on the Email tab;
 * on sample data replying is off there and here.
 */
function AllMail({ thread, workspaceId, demo, userId, email, recordFor, dealFor, deals, mergeFor, picker, placeCall, toast, onCompose }: {
  thread: EmailThread; workspaceId: number | null; demo: boolean; userId: string | null;
  email: ReturnType<typeof useEmail>; recordFor: ClozrView['recordForContact'];
  dealFor: ClozrView['dealForId']; deals: ClozrView['mailDeals'];
  mergeFor: MergeFor; picker: PickerRender; placeCall: (e164: string) => void; toast: (msg: string) => void;
  onCompose: (draft: QuickDraft, done: () => void) => void;
}) {
  const [tick, setTick] = useState(0);
  const ids = useMemo(() => thread.rows.map((r) => r.id), [thread.rows]);
  const extras = useMailExtras(ids, tick, demo ? null : workspaceId);
  const reload = useCallback(() => { setTick((n) => n + 1); void email.reload(); }, [email]);
  return (
    <GmailThread
      thread={thread} isNew={false} workspaceId={workspaceId ?? 0} userId={userId} email={email} recordFor={recordFor}
      deal={thread.deal_id ? dealFor(thread.deal_id) : null} deals={deals} files={extras.files} receipts={extras.receipts}
      onRefiled={reload} readOnly={demo} mergeFor={mergeFor} picker={picker} placeCall={placeCall} toast={toast}
      onSent={reload} onReply={(d) => onCompose(d, reload)}
    />
  );
}

/**
 * The open conversation beside the All list, with Messages, Info and Notes
 * tabs. A text thread is the SMS tab's own thread and composer, an email
 * thread the Email tab's (lib/inbox-reply), so replying from here is replying
 * there. A call is its one line, with Text in the header for the docked quick
 * text.
 */
function AllThread({ item, reply, onSent, onOpen, placeCall, onBack, heat: h, onLabels, onPin, onArchive, onRestore, onMarkUnread, team, canWrite, onAssign, related, onOpenRelated, workspaceId, userId, toast, scheduled }: {
  item: AllItem; reply: ReplyBoxes; onSent: () => void; onOpen: (kind: Kind, key: string) => void; placeCall: (e164: string) => void; onBack?: () => void;
  heat: HeatChip; onLabels: (l: string[]) => void; onPin: (on: boolean) => void; onArchive: () => void; onRestore: () => void; onMarkUnread: () => void;
  team: AssignMate[]; canWrite: boolean; onAssign: (userId: string | null, who: string) => void;
  related: RelatedRow[]; onOpenRelated: (key: string) => void;
  workspaceId: number | null; userId: string | null; toast: ClozrView['showToast'];
  scheduled: Scheduled;
}) {
  const [tab, setTab] = useState<ThreadTab>('messages');
  const box = allReplyFor(item);
  // The text thread as the SMS composer last read it, for the suggested label.
  const [sms, setSms] = useState<MessageDto[]>([]);
  const { phone, rec } = item;
  // The suggested label reads the last text from them, once the thread is loaded.
  const lastTheirs = [...sms].reverse().find((m) => m.direction === 'inbound')?.body ?? item.lastTheirsText;
  const text = phone ? () => openReach('text', { name: item.name, phone, recipient: rec?.recipient, onSent }) : null;
  const textLabel = headerTextLabel(item);
  const assignee = rec?.kind === 'seller' ? (rec.rep ?? 'Unassigned') : null;
  const tabs: [ThreadTab, string][] = [['messages', 'Messages'], ['info', 'Info'], ['notes', 'Notes']];
  // Emails written on the record that go out later (scheduled_emails). Edit lives on the record's timeline.
  const laterMail = box === 'email' && item.email ? scheduled.byEmail.get(item.email.toLowerCase()) ?? [] : [];

  return (
    <section className="ax-read" aria-label={`Conversation with ${item.name}`}>
      <header className="ax-read-head">
        {onBack && <Button onClick={onBack}>Back</Button>}
        <span className="ax-read-who">
          <span className="ax-name"><ThreadName name={titled(item)} phone={item.phone} />{item.archived ? <span className="ax-tag" style={{ marginLeft: 8 }}>Archived</span> : null}</span>
          <span className="ax-sub">
            <span className="ax-kind" data-alert={item.alert || undefined}><Icon name={KIND_ICON[item.kind]} size={12} />{item.label}</span>
            <span className="ax-addr">{rec ? rec.address || rec.stage : <NotHereLink phone={item.phone} />}</span>
          </span>
          <LabelChips stage={rec?.stage} heat={h} labels={item.labels} suggestion={item.labels.length ? null : suggestLabel(lastTheirs)} onLabels={onLabels} />
        </span>
        <span className="ax-read-actions">
          {phone && <Button tone="accent" onClick={() => placeCall(phone)}>Call</Button>}
          {text && textLabel && <Button onClick={text}>{textLabel}</Button>}
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
            { label: openInLabel(item.kind), run: () => onOpen(item.kind, item.open) },
            { label: 'Mark unread', hint: 'Unread again until you open it', run: onMarkUnread },
          ]} />
        </span>
      </header>
      <div role="tablist" aria-label="Conversation" className="ax-read-tabs">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className="ax-read-tab" onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'messages' ? (
        box === 'sms' ? (
          <div className="ax-read-reply" data-testid="all-sms-reply">{reply.sms(item.convId!, setSms)}</div>
        ) : box === 'email' ? (
          <div className="email-tab ax-read-reply ax-read-mail" data-testid="all-email-reply">
            {reply.email(item.thread!)}
            {laterMail.length ? (
              <div className="ax-read-later">
                {laterMail.map((r) => (
                  <div key={`sched:${r.id}`} className="ax-msg ax-msg-pending" data-out>
                    <p><strong>{r.subject}</strong><br />{r.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)}</p>
                    <span className="ax-receipt ax-sched-line" style={r.status === 'error' ? { color: 'var(--red)' } : undefined}>
                      <Clock size={12} strokeWidth={2.5} aria-hidden />{r.status === 'error' ? `Not sent: ${r.error ?? 'unknown error'}` : sendsLabel(new Date(r.send_at))}
                      {item.rec ? <button type="button" className="ax-link" onClick={item.rec.open}>Edit on record</button> : null}
                      <button type="button" className="ax-link" onClick={() => void scheduled.cancel(r.id, 'scheduled_emails').then((e) => toast(e ?? (r.status === 'error' ? 'Dismissed' : 'Cancelled')))}>{r.status === 'error' ? 'Dismiss' : 'Cancel'}</button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="ax-read-msgs">
            <div className="ax-msg">
              <p>{item.preview}</p>
              <time dateTime={item.at || undefined}>{stamp(item.at)}</time>
            </div>
          </div>
        )
      ) : tab === 'info' ? (
        <InfoTab rec={rec} name={item.name} phone={phone} email={item.email ?? rec?.recipient?.email ?? null} lastAt={item.at} heat={h} related={related} onOpenRelated={onOpenRelated} onText={text} />
      ) : (
        <NotesTab rec={rec} workspaceId={workspaceId} userId={userId} canWrite={canWrite} toast={toast} />
      )}
    </section>
  );
}
