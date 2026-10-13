// The Inbox: one set of channel tabs — All · SMS · Email · Calls · Voicemail —
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
import { Avatar, Button } from '@/app/components/talkr/ui';
import type { ClozrRecord } from '@/app/components/talkr/MessagesScreen';
import { GmailInbox } from '@/app/components/inbox/gmail/GmailInbox';
import type { MergeFor, PickerRender } from '@/app/components/inbox/types';
import { CallsList, callLine, theirNumber } from '@/app/components/inbox/CallsList';
import { type EmailThread, isVoicemail, useCalls, useEmail, useThreadBodies } from '@/app/components/inbox/data';
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

const TABS = ['All', 'SMS', 'Email', 'Calls', 'Voicemail'] as const;
type Tab = (typeof TABS)[number];

// What the Inbox was showing when the rep left it. The screen unmounts when
// another one opens, so the tab and the thread open on each were lost and
// coming back always landed on All. Kept for the tab's session; unsent text
// is kept per thread in lib/compose-drafts.
const memory: { tab: Tab; smsConv: string | null; emailKey: string | null; callId: string | null; allKey: string | null } = {
  tab: 'All', smsConv: null, emailKey: null, callId: null, allKey: null,
};

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
  // The All list, unread counts and alerts are your own mail, managers included;
  // the Email tab still lets TC and admins open a teammate's or everyone's.
  const email = useEmail(workspaceId, userId ?? null);
  const calls = useCalls(V.talkrAuthed);
  const recordFor = V.recordForContact;
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
          key={smsTo ?? 'sms'}
          authed={V.talkrAuthed}
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
          live={V.liveIds ? { workspaceId: V.liveIds.workspaceId, canWrite: V.liveIds.canWrite, me: userId, toast: V.showToast, reload: V.reloadCrm } : null}
          clozrTemplates={({ record, name, phone, insert, close }) => picker({
            channel: 'sms', audience: record?.kind ?? 'any', onClose: close,
            onPick: (t) => insert(renderMerge(t.body_text, mergeFor(record, name ?? '', phone ?? ''))),
          })}
        />
      ) : tab === 'Email' ? (
        // The same TopBar as All, Calls and Voicemail, so switching tabs does
        // not move the header; the mail search sits at the top of the list.
        <>
          <TopBar title="Inbox" subtitle={subtitleFor(tab, email.threads.length, calls.calls)} onNewCall={V.openDialer}>{tabs}</TopBar>
          <GmailInbox
            key={emailKey ?? 'email'}
            workspaceId={workspaceId} demo={session.demo || !V.liveIds} userId={userId} email={email}
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
          <TopBar title="Inbox" subtitle={subtitleFor(tab, email.threads.length, calls.calls)} onNewCall={V.openDialer}>{tabs}</TopBar>
          {(tab === 'Calls' || tab === 'Voicemail') && (
            <CallsList key={callId ?? 'calls'} calls={calls} voicemailOnly={tab === 'Voicemail'} authed={V.talkrAuthed} recordFor={recordFor} placeCall={V.dialE164} openId={callId} />
          )}
          {tab === 'All' && <AllList V={V} email={email} calls={calls} onOpen={openFromAll} inbox={inboxState} userId={userId} />}
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

function subtitleFor(tab: Tab, emailThreads: number, calls: ReturnType<typeof useCalls>['calls']): string {
  if (tab === 'Email') return `${emailThreads} email thread${emailThreads === 1 ? '' : 's'}`;
  if (tab === 'Voicemail') { const n = calls.filter(isVoicemail).length; return `${n} voicemail${n === 1 ? '' : 's'}`; }
  if (tab === 'Calls') return `${calls.length} recent call${calls.length === 1 ? '' : 's'}`;
  return 'Texts, email and calls, newest first';
}

type Kind = 'sms' | 'email' | 'call';
type AllItem = {
  key: string; at: string; kind: Kind; open: string; rec: ClozrRecord | null;
  name: string; unread: boolean; label: string; title?: string; preview: string; alert?: boolean; pinned?: boolean;
  /** Who a call or a text from the thread goes to. */
  phone: string | null;
  /** What the thread pane reads: the Talkr conversation, or the email thread already loaded. */
  convId?: string; thread?: EmailThread;
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

const CHANNEL_ICON = { sms: 'msg', email: 'mail', call: 'phone' } as const;

/**
 * Everything, newest first: SMS threads, email threads and calls. The list and
 * the open conversation sit side by side (one at a time on a phone), so a
 * reply, a call and the record are a click from the list without leaving All.
 */
function AllList({ V, email, calls, onOpen, inbox, userId }: {
  V: ClozrView; email: ReturnType<typeof useEmail>; calls: ReturnType<typeof useCalls>;
  onOpen: (kind: Kind, key: string) => void; inbox: InboxState; userId: string | null;
}) {
  // The phone's threads (useTalkrPhone): one list and one event stream for the whole app.
  const convs = V.talkrPhone.data.convs;
  const [q, setQ] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(memory.allKey);
  useEffect(() => { memory.allKey = openKey; }, [openKey]);
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
  const refresh = useCallback(() => {
    if (!V.talkrAuthed) return;
    phoneRefresh();
    setTick((n) => n + 1);
  }, [V.talkrAuthed, phoneRefresh]);
  const openConv = openKey?.startsWith('sms:') ? openKey.slice(4) : null;
  useTalkrEvents(V.talkrAuthed, ['message.received', 'message.updated', 'conversation.updated'], (events) => {
    if (openConv && events.some((e) => eventFacts(e).conversationId === openConv)) setTick((n) => n + 1);
  });
  // The stream carries every teammate's calls: at most one re-read of the
  // 200-call history per 30 seconds, however busy the floor is.
  const callsReadAt = React.useRef(0);
  const callsLater = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (callsLater.current) clearTimeout(callsLater.current); }, []);
  useTalkrEvents(V.talkrAuthed, ['call.updated', 'voicemail.left'], () => {
    if (callsLater.current) return;
    const wait = Math.max(0, callsReadAt.current + 30_000 - Date.now());
    callsLater.current = setTimeout(() => {
      callsLater.current = null;
      callsReadAt.current = Date.now();
      refreshCalls();
    }, wait);
  }, 2000);
  useEffect(() => {
    if (!V.talkrAuthed) return;
    const back = () => { if (document.visibilityState === 'visible') refreshCalls(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [V.talkrAuthed, refreshCalls]);

  const recordFor = V.recordForContact;
  const items: AllItem[] = [
    ...convs.map((c): AllItem => {
      const rec = recordFor(c.their_number);
      const out = c.last_message?.direction === 'outbound';
      return {
        key: `sms:${c.id}`, at: c.last_message_at ?? '', kind: 'sms', open: c.their_number, rec, phone: c.their_number, convId: c.id,
        name: c.contact_name ?? rec?.name ?? formatPhone(c.their_number), unread: c.unread_count > 0,
        label: 'Text', preview: `${out ? 'You: ' : ''}${c.last_message?.body || (c.last_message?.media_count ? 'Photo' : '')}`,
      };
    }),
    ...email.threads.map((t): AllItem => {
      const rec = t.counterpart ? recordFor(t.counterpart) : null;
      return {
        key: `email:${t.key}`, at: t.last.occurred_at, kind: 'email', open: t.key, rec, thread: t,
        phone: rec?.recipient?.phone ? toE164(rec.recipient.phone) || null : null,
        name: rec?.name ?? t.counterpart ?? 'Email', unread: threadUnread(t.rows, mail.read, mail.seenThrough),
        label: 'Email', title: t.subject, preview: (t.last.body ?? t.last.preview ?? '').replace(/\s+/g, ' ').slice(0, 200),
      };
    }),
    ...calls.calls.map((h): AllItem => {
      const rec = recordFor(theirNumber(h));
      const missed = h.direction === 'inbound' && !h.duration_seconds && !isVoicemail(h);
      return {
        key: `call:${h.id}`, at: h.at, kind: 'call', open: h.id, rec, phone: theirNumber(h) || null,
        name: h.contact_name ?? rec?.name ?? formatPhone(theirNumber(h)), unread: h.direction === 'inbound' && !h.duration_seconds,
        label: isVoicemail(h) ? 'Voicemail' : missed ? 'Missed call' : 'Call', alert: missed,
        preview: callLine(h).replace(/^(Voicemail|Incoming|Outgoing)( · )?/, ''),
      };
    }),
  ].sort((a, b) => Date.parse(b.at || '0') - Date.parse(a.at || '0'));

  // A text thread is remembered by its number, so a new text to or from it is the same thread.
  const stateKey = (i: AllItem) => (i.kind === 'sms' && i.phone ? smsKey(i.phone) : i.key);
  const visible = pinnedFirst(
    items
      .filter((i) => !isCleared(i.at, inbox.state.get(stateKey(i))))
      .map((i) => ({ ...i, unread: isUnread(i.unread, i.at, inbox.state.get(stateKey(i))), pinned: !!inbox.state.get(stateKey(i))?.pinned_at })),
    stateKey, inbox.state,
  );
  const open = (i: AllItem) => {
    setOpenKey(i.key);
    inbox.seen(stateKey(i));
    // Talkr's own unread count goes too, so the SMS tab agrees.
    if (i.convId && i.unread) V.talkrPhone.markRead(i.convId);
    // An email read here is read on the Email tab too.
    if (i.thread && i.unread) mail.markRead(i.thread.rows.filter((r) => r.direction === 'inbound').map((r) => r.id));
    // And a text thread or a missed call read here leaves the bell.
    if (i.kind !== 'email' && i.phone) V.bellReadNumber(i.phone);
  };
  const needle = q.trim().toLowerCase();
  const unreadCount = visible.filter((i) => i.unread).length;
  const shown = visible.filter((i) => (!unreadOnly || i.unread)
    && (!needle || [i.name, i.title, i.preview, i.rec?.address].some((v) => v?.toLowerCase().includes(needle))));

  const today = startOfDay(new Date());
  const groups: { label: string; rows: AllItem[] }[] = [];
  for (const i of shown.slice(0, 200)) {
    const label = dayGroup(i.at, today);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(i); else groups.push({ label, rows: [i] });
  }
  const loading = email.loading || calls.loading;
  const picked = openKey ? items.find((i) => i.key === openKey) ?? null : null;
  // A phone has room for one pane: the list, or the conversation with a Back.
  const one = V.isMobile;

  return (
    <div className="ax-desk" data-one={one || undefined}>
    {(!one || !picked) && (
    <div className="ax">
      <div className="ax-bar">
        <label className="ax-search">
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names, messages, addresses" aria-label="Search the inbox" />
        </label>
        <button type="button" className="ax-chip" aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
          Unread{unreadCount ? <span className="ax-chip-n">{unreadCount}</span> : null}
        </button>
        <span className="ax-count" role="status">
          {loading && !items.length ? 'Loading…' : `${shown.length} ${shown.length === 1 ? 'conversation' : 'conversations'}`}
        </span>
      </div>

      <div className="ax-scroll">
        {!V.talkrAuthed && (
          <p className="ax-note"><Icon name="phone" size={13} />Talkr isn’t connected to this sign-in, so texts and calls are not listed. Email still is.</p>
        )}
        {shown.length === 0 && (needle || unreadOnly ? (
          <div className="ax-empty">
            <p className="ax-empty-t">Nothing matches</p>
            <p className="ax-empty-h">{needle ? <>No conversation mentions “{q.trim()}”.</> : 'Every conversation has been read.'}</p>
            <button type="button" className="ax-chip" onClick={() => { setQ(''); setUnreadOnly(false); }}>Clear filters</button>
          </div>
        ) : loading ? (
          <SkeletonRows count={6} label="Loading the inbox" />
        ) : (
          <div className="ax-empty">
            <p className="ax-empty-t">Nothing in the inbox yet</p>
            <p className="ax-empty-h">Texts, email and calls land here as they come in, newest first.</p>
          </div>
        ))}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h2 className="ax-day">{g.label}</h2>
            <ul className="ax-list">
              {g.rows.map((i) => (
                <li key={i.key}>
                  <button type="button" className="ax-row" data-unread={i.unread || undefined} aria-current={i.key === openKey || undefined} onClick={() => open(i)}>
                    <span className="ax-dot" aria-label={i.unread ? 'Unread' : undefined} />
                    <span className="ax-av">
                      {/[a-z]/i.test(i.name) ? <Avatar name={i.name} size={32} /> : <span className="ax-anon"><Icon name="user" size={15} /></span>}
                      <span className="ax-ch" data-alert={i.alert || undefined}><Icon name={CHANNEL_ICON[i.kind]} size={9} /></span>
                    </span>
                    <span className="ax-who">
                      <span className="ax-name">{i.pinned ? <span className="ax-kind" style={{ marginRight: 6 }}>Pinned</span> : null}{i.name}</span>
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
                      <span className="ax-kind" data-alert={i.alert || undefined}>{i.label}</span>
                      {i.title ? <span className="ax-title">{i.title}</span> : null}
                      <span className="ax-preview">{i.preview}</span>
                    </span>
                    <time className="ax-time" dateTime={i.at || undefined}>{rowTime(i.at, today)}</time>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
    )}
    {(!one || picked) && (picked ? (
      <AllThread key={picked.key} item={picked} tick={tick} onSent={refresh} onOpen={onOpen} placeCall={V.dialE164} onBack={one ? () => setOpenKey(null) : undefined}
        pinned={!!inbox.state.get(stateKey(picked))?.pinned_at}
        onPin={(on) => inbox.pin(stateKey(picked), on)}
        onClear={() => { inbox.clear(stateKey(picked)); setOpenKey(null); }} />
    ) : (
      <div className="ax-read ax-read-blank"><p>Pick a conversation. The reply, the call and the record open beside the list.</p></div>
    ))}
    </div>
  );
}

const WHERE: Record<Kind, string> = { sms: 'SMS', email: 'Email', call: 'Calls' };
const stamp = (iso: string) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/**
 * The open conversation beside the All list. Texts are read from Talkr, email
 * from the thread the list already loaded, a call is its one line. Reply goes
 * through the docked quick text (a real send); an email reply opens the Gmail
 * thread, which knows whose mailbox it is and whether sending is on.
 */
function AllThread({ item, tick, onSent, onOpen, placeCall, onBack, pinned, onPin, onClear }: {
  item: AllItem; tick: number; onSent: () => void; onOpen: (kind: Kind, key: string) => void; placeCall: (e164: string) => void; onBack?: () => void;
  pinned: boolean; onPin: (on: boolean) => void; onClear: () => void;
}) {
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

  const msgs = mailThread
    ? mailThread.rows.map((r) => ({ id: String(r.id), out: r.direction === 'outbound', at: r.occurred_at, text: splitQuoted(emailPlain(r.body))[0].trim() }))
    : (sms ?? []).map((m) => ({ id: m.id, out: m.direction === 'outbound', at: m.created_at, text: m.body || (m.media_urls.length ? 'Photo' : '') }));
  const { phone, rec } = item;

  return (
    <section className="ax-read" aria-label={`Conversation with ${item.name}`}>
      <header className="ax-read-head">
        {onBack && <Button onClick={onBack}>Back</Button>}
        <Avatar name={item.name} size={36} />
        <span className="ax-read-who">
          <span className="ax-name">{item.name}</span>
          <span className="ax-sub">
            <span className="ax-kind" data-alert={item.alert || undefined}>{item.label}</span>
            <span className="ax-addr">{rec ? rec.address || rec.stage : 'Not in CLOZR'}</span>
          </span>
        </span>
        <span className="ax-read-actions">
          {phone && <Button tone="accent" onClick={() => placeCall(phone)}>Call</Button>}
          {phone && <Button onClick={() => openReach('text', { name: item.name, phone, recipient: rec?.recipient, onSent })}>{item.kind === 'sms' ? 'Reply' : 'Text'}</Button>}
          {rec && <Button onClick={rec.open}>Open record</Button>}
          <Button onClick={() => onOpen(item.kind, item.open)}>{item.kind === 'email' ? 'Reply in Email' : `Open in ${WHERE[item.kind]}`}</Button>
          <Button onClick={() => onPin(!pinned)} title={pinned ? 'Unpin' : 'Keep at the top of the list'}>{pinned ? 'Unpin' : 'Pin'}</Button>
          <Button onClick={onClear} title="Take it off the list until something new happens on it">Clear</Button>
        </span>
      </header>
      {item.title ? <p className="ax-read-title">{item.title}</p> : null}
      <div className="ax-read-msgs">
        {item.convId && sms === null ? (
          <SkeletonRows count={3} label="Loading the conversation" />
        ) : (msgs.length ? msgs : [{ id: 'last', out: false, at: item.at, text: item.preview }]).map((m) => (
          <div key={m.id} className="ax-msg" data-out={m.out || undefined}>
            <p>{m.text}</p>
            <time dateTime={m.at || undefined}>{stamp(m.at)}</time>
          </div>
        ))}
      </div>
    </section>
  );
}
