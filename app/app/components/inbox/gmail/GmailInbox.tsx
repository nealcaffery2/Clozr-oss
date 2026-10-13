'use client';

// The Email tab: a folder rail, a list that fills the rest of the width, and
// a reading view that replaces the list when a thread is opened.
//
// It wears the inbox's own chrome rather than a mail client's. The channel
// tabs live in the shared TopBar (Inbox.tsx renders it above this, as it does
// for All, Calls and Voicemail), so switching tabs does not move the header;
// the mail search is the same search pill the Calls and All tabs put at the
// top of their lists; type, colour and radii are the inbox tokens.
//
// At the app's phone breakpoint (820px, gmail-inbox.css) the rail folds into a
// row of folder chips and Compose moves beside the search.
//
// Read and starred are real: they live in migration 73 and degrade to memory
// when it has not been applied yet (lib/email-state.ts). The reading view is
// GmailThread; sending, templates, merge fields and the spam badge live in
// useEmailComposer, which the original EmailThreadPane runs too, so there is
// one implementation of the part that must not be written twice.
//
// Migration 82 adds three ways to cut the mail:
//   Deals      a folder per deal, grouped by stage (under contract, in escrow,
//              marketing, closed), holding every email filed on it whoever it
//              was with — the deal team across the top, the files underneath.
//              "Not on a deal" collects mail with a CRM person but no deal, to
//              be filed by hand.
//   Mailbox    whose mail: everyone's (the default, as before), my own, or —
//              for an owner or admin — any teammate's, read-only.
//   Receipts   sent mail shows whether it has been opened (mail-extras.ts).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { syncGoogle } from '@/lib/google';
import { PARTY_ROLE_LABEL, saveDealParty } from '@/lib/deal-parties';
import { threadUnread, useEmailState } from '@/lib/email-state';
import { GoogleConnect } from '@/components/GoogleConnect';
import { Icon } from '@/app/components/talkr/Icon';
import { Button } from '@/app/components/talkr/ui';
import type { DealFor, DealRef, EmailScope, EmailThread, RecordFor, useEmail } from '../data';
import type { MergeFor, PickerRender } from '../types';
import { FileChip, GmailThread } from './GmailThread';
import { type DealFolder, FOLDERS, FOLDER_OF, useDealTeam, useMailExtras, useScopedThreads, useTeam } from './mail-extras';
import { GmailCheck, GmailIcon } from './GmailIcon';
import { GmailRow } from './GmailRow';
import { participantsOf, snippetOf } from './format';
import '@/app/clozr/gmail-inbox.css';

const PAGE = 50;

type Bucket = 'inbox' | 'starred' | 'sent' | 'all' | 'unfiled';

const BUCKETS: { key: Bucket; label: string; icon: string }[] = [
  { key: 'inbox', label: 'Inbox', icon: 'inbox' },
  { key: 'starred', label: 'Starred', icon: 'star_outline' },
  { key: 'sent', label: 'Sent', icon: 'send' },
  { key: 'all', label: 'All mail', icon: 'drafts' },
  { key: 'unfiled', label: 'Not on a deal', icon: 'label' },
];

const addrs = (s: string | null | undefined) => (s ?? '').split(',').map((a) => a.trim().toLowerCase()).filter((a) => a.includes('@'));

/** A reply or a new email, handed to CLOZR's docked composer. */
export type QuickDraft = {
  to?: string; name?: string; subject?: string; inReplyTo?: string | null;
  sellerId?: number | null; buyerId?: number | null; dealId?: number | null;
};

export function GmailInbox({
  workspaceId, demo, userId, email, recordFor, dealFor, deals = [], seesAllMail = false, mergeFor, picker, placeCall, openKey, toast, onCompose, onPicked,
}: {
  workspaceId: number | null;
  demo: boolean;
  userId: string | null;
  email: ReturnType<typeof useEmail>;
  recordFor?: RecordFor;
  dealFor?: DealFor;
  /** Every deal in the workspace, for the deal folders and "File under". */
  deals?: DealRef[];
  /** An owner, admin or TC reads everyone's mail and may open any teammate's mailbox; anyone else reads only their own. */
  seesAllMail?: boolean;
  mergeFor: MergeFor;
  picker: PickerRender;
  placeCall: (e164: string) => void;
  openKey?: string | null;
  toast: (msg: string) => void;
  /**
   * CLOZR: Compose and Reply open the app's docked quick email instead of the
   * box in the reading pane. `done` reads the mail again once it has gone.
   */
  onCompose?: (draft: QuickDraft, done: () => void) => void;
  /** CLOZR: told which thread is open, so the Inbox reopens it when the rep comes back. */
  onPicked?: (key: string | null) => void;
}) {
  const [bucket, setBucket] = useState<Bucket>('inbox');
  const [picked, setPicked] = useState<string | null>(openKey ?? null);
  useEffect(() => { onPicked?.(picked === 'new' ? null : picked); }, [picked, onPicked]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set<string>());
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [syncing, setSyncing] = useState(false);

  // Whose mail (null: everyone's) and which deal folder is open.
  // Everyone opens on their own mail; TC and admins can switch to a teammate's or everyone's.
  const [mailbox, setMailbox] = useState<string | null>(userId ?? null);
  const [dealId, setDealId] = useState<number | null>(null);
  const [dealTab, setDealTab] = useState<'mail' | 'files'>('mail');
  const [party, setParty] = useState<string | null>(null);
  const [folderOpen, setFolderOpen] = useState<Record<DealFolder, boolean>>({ contract: true, escrow: true, marketing: false, closed: false, other: false });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => { setTick((n) => n + 1); void email.reload(); }, [email]);

  // Someone else's mailbox is read as them — their read state — and never written to.
  const viewingOther = !!mailbox && mailbox !== userId;
  const state = useEmailState(workspaceId, viewingOther ? mailbox : userId);
  const { read, starred, archived, seenThrough, persists } = state;
  const markRead = useMemo(() => (viewingOther ? () => {} : state.markRead), [viewingOther, state.markRead]);
  const toggleStar = useMemo(() => (viewingOther ? () => {} : state.toggleStar), [viewingOther, state.toggleStar]);
  const setArchived = useMemo(() => (viewingOther ? () => {} : state.setArchived), [viewingOther, state.setArchived]);

  const team = useTeam(workspaceId, true);
  // A rep outside TC and admin is held to their own mailbox, deal folders included.
  const own = seesAllMail ? undefined : userId ?? undefined;
  const dealSeller = dealId ? (dealFor?.(dealId) ?? deals.find((d) => d.id === dealId))?.sellerId ?? null : null;
  const scope: EmailScope = dealId ? { kind: 'deal', dealId, userId: own, sellerId: dealSeller } : mailbox ? { kind: 'mailbox', userId: mailbox } : own ? { kind: 'mailbox', userId: own } : { kind: 'all' };
  // The rep's own mailbox is the list useEmail already holds (the Inbox asks
  // it for exactly that), so it is not read a second time here; a teammate's
  // mailbox or a deal folder is. email.version moves when mail arrives or is
  // refiled anywhere (useEmail's live subscription).
  const ownList = scope.kind === 'mailbox' && scope.userId === userId;
  const scoped = useScopedThreads(workspaceId, ownList ? { kind: 'all' } : scope, tick + (email.version ?? 0));
  const source = scoped ? scoped.threads : email.threads;
  const openDeal = dealId ? dealFor?.(dealId) ?? deals.find((d) => d.id === dealId) ?? null : null;
  const dealTeam = useDealTeam(dealId, tick);

  const idsOf = useCallback((t: EmailThread) => t.rows.map((r) => r.id), []);

  /** Bucket (or deal folder), then search. Archived is hidden in the Inbox only. */
  const threads = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return source.filter((t) => {
      const ids = t.rows.map((r) => r.id);
      if (dealId) {
        if (party && !t.rows.some((r) => [...addrs(r.from_email), ...addrs(r.to_email), ...addrs(r.cc_email)].includes(party))) return false;
      } else {
        const isArchived = ids.every((id) => archived.has(id));
        if (bucket === 'inbox' && isArchived) return false;
        if (bucket === 'starred' && !ids.some((id) => starred.has(id))) return false;
        if (bucket === 'sent' && !t.rows.some((r) => r.direction === 'outbound')) return false;
        if (bucket === 'unfiled' && (t.deal_id != null || (t.seller_id == null && t.buyer_id == null))) return false;
      }
      if (!needle) return true;
      return [participantsOf(t, recordFor), t.counterpart, t.subject, snippetOf(t.last)]
        .some((v) => v?.toLowerCase().includes(needle));
    });
  }, [source, q, bucket, dealId, party, archived, starred, recordFor]);

  // A search reaches the server too, for mail older than what is loaded
  // (subject, sender, recipient). Its hits join the list, which filters them.
  const emailSearch = email.search;
  useEffect(() => {
    if (scoped || q.trim().length < 3) return;
    const t = setTimeout(() => void emailSearch(q), 400);
    return () => clearTimeout(t);
  }, [q, scoped, emailSearch]);

  const total = threads.length;
  const shown = useMemo(() => threads.slice(page * PAGE, page * PAGE + PAGE), [threads, page]);

  const unreadCount = useMemo(
    () => source.filter((t) => threadUnread(t.rows, read, seenThrough)).length,
    [source, read, seenThrough],
  );

  // Mail and unread per deal, from the workspace list, for the folder counts.
  // A thread never filed under a deal counts toward its seller's deal when
  // that seller has exactly one (the same rule the deal folder reads by).
  const perDeal = useMemo(() => {
    const dealsBySeller = new Map<number, number[]>();
    for (const d of deals) if (d.id != null && d.sellerId != null) dealsBySeller.set(d.sellerId, [...(dealsBySeller.get(d.sellerId) ?? []), d.id]);
    const m = new Map<number, { mail: number; unread: number }>();
    for (const t of email.threads) {
      const only = t.seller_id != null ? dealsBySeller.get(t.seller_id) : undefined;
      const dealOf = t.deal_id ?? (only && only.length === 1 ? only[0] : null);
      if (dealOf == null) continue;
      const c = m.get(dealOf) ?? { mail: 0, unread: 0 };
      c.mail++;
      if (threadUnread(t.rows, read, seenThrough)) c.unread++;
      m.set(dealOf, c);
    }
    return m;
  }, [email.threads, deals, read, seenThrough]);

  const folders = useMemo(() => {
    const by = new Map<DealFolder, DealRef[]>();
    for (const d of deals) {
      if (d.id == null) continue;
      const f = FOLDER_OF[d.stage ?? ''] ?? 'other';
      if (f === 'other') continue;
      by.set(f, [...(by.get(f) ?? []), d]);
    }
    // Deals with mail first, then by name.
    for (const [f, list] of by) by.set(f, list.sort((a, b) => (perDeal.get(b.id!)?.mail ?? 0) - (perDeal.get(a.id!)?.mail ?? 0) || a.label.localeCompare(b.label)));
    return by;
  }, [deals, perDeal]);

  const open = useCallback((t: EmailThread) => {
    setPicked(t.key);
    markRead(t.rows.filter((r) => r.direction === 'inbound').map((r) => r.id));
  }, [markRead]);

  const thread = picked && picked !== 'new' ? source.find((t) => t.key === picked) ?? null : null;

  // Files and receipts for what is on screen: the page, the open thread, and in a deal folder every thread in it.
  const extraIds = useMemo(() => {
    const on = dealId ? source : threads.slice(page * PAGE, page * PAGE + PAGE);
    return [...on, ...(thread ? [thread] : [])].flatMap((t) => t.rows.map((r) => r.id));
  }, [dealId, source, threads, page, thread]);
  const extras = useMailExtras(extraIds, tick);

  // Everyone on the deal, and anyone else writing about it who is not on the team yet.
  const known = useMemo(() => new Set(dealTeam.map((p) => (p.email ?? '').toLowerCase()).filter(Boolean)), [dealTeam]);
  const strangers = useMemo(() => {
    if (!dealId) return [];
    const ours = new Set([...(team.map((t) => (t.email ?? '').toLowerCase())), (email.account?.email ?? '').toLowerCase()]);
    const seen = new Map<string, number>();
    for (const t of source) for (const r of t.rows) {
      for (const a of [...addrs(r.from_email), ...addrs(r.to_email), ...addrs(r.cc_email)]) {
        if (!known.has(a) && !ours.has(a) && !recordFor?.(a)) seen.set(a, (seen.get(a) ?? 0) + 1);
      }
    }
    return Array.from(seen.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([a]) => a);
  }, [dealId, source, known, team, email.account?.email, recordFor]);

  async function addToTeam(address: string) {
    if (!workspaceId || !dealId) return;
    const err = await saveDealParty(workspaceId, dealId, {
      role: 'other', email: address, name: null, company: address.split('@')[1] ?? null, phone: null, user_id: null, vendor_id: null, buyer_id: null,
    });
    if (err) return toast(err);
    toast(`${address} added to the deal team — their mail files on this deal from now on`);
    setTick((n) => n + 1);
  }

  const dealFiles = useMemo(
    () => (dealId ? source.flatMap((t) => t.rows).flatMap((r) => extras.files.get(r.id) ?? []) : []),
    [dealId, source, extras.files],
  );

  async function syncNow() {
    if (!workspaceId) return;
    setSyncing(true);
    const r = await syncGoogle(workspaceId);
    await email.reload();
    setSyncing(false);
    if (!r.ok) toast(r.message);
  }

  const allChecked = shown.length > 0 && shown.every((t) => checked.has(t.key));
  const someChecked = checked.size > 0 && !allChecked;

  const toggleAll = () => setChecked(allChecked ? new Set<string>() : new Set(shown.map((t) => t.key)));
  const toggleOne = (key: string) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const checkedThreads = useMemo(
    () => threads.filter((t) => checked.has(t.key)),
    [threads, checked],
  );

  const archiveChecked = () => {
    setArchived(checkedThreads.flatMap(idsOf));
    setChecked(new Set<string>());
  };
  const readChecked = (isRead: boolean) => {
    markRead(checkedThreads.flatMap(idsOf), isRead);
    setChecked(new Set<string>());
  };

  const pickBucket = (b: Bucket) => { setBucket(b); setDealId(null); setParty(null); setPicked(null); setPage(0); };
  const pickDeal = (id: number) => { setDealId(id); setDealTab('mail'); setParty(null); setPicked(null); setPage(0); };
  const pickMailbox = (v: string) => { setMailbox(v || null); setDealId(null); setPicked(null); setPage(0); setChecked(new Set<string>()); };
  const threadStarred = thread ? idsOf(thread).some((id) => starred.has(id)) : false;

  // -------------------------------------------------------------- the frame
  return (
    <div className="email-tab flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="em-body">
        <nav className="em-rail" aria-label="Mail folders">
          <Button tone="accent" className="em-compose" onClick={() => (onCompose ? onCompose({ dealId }, refresh) : setPicked('new'))}>
            <Icon name="edit" size={14} /> Compose
          </Button>
          {/* Nothing to choose for a rep with no signed-in mailbox (the demo): no empty picker. */}
          {seesAllMail || userId ? (
            <label className="em-mailbox">
              <span className="em-rail-head">Mailbox</span>
              <select className="em-select" value={mailbox ?? ''} onChange={(e) => pickMailbox(e.target.value)} aria-label="Whose mail">
                {seesAllMail ? <option value="">Everyone’s mail</option> : null}
                {userId ? <option value={userId}>My mail</option> : null}
                {seesAllMail ? team.filter((t) => t.user_id !== userId).map((t) => (
                  <option key={t.user_id} value={t.user_id}>{t.full_name || t.email || 'Teammate'}</option>
                )) : null}
              </select>
            </label>
          ) : null}
          {BUCKETS.map((b) => (
            <button
              key={b.key} type="button" className="em-nav"
              aria-current={!dealId && bucket === b.key ? 'true' : undefined}
              onClick={() => pickBucket(b.key)}
            >
              <GmailIcon name={b.icon} size={18} />
              <span className="em-nav-label">{b.label}</span>
              {b.key === 'inbox' && unreadCount > 0 ? <span className="em-nav-count">{unreadCount}</span> : null}
            </button>
          ))}
          {deals.length ? <div className="em-rail-head em-rail-head--deals">Deals</div> : null}
          {FOLDERS.map((f) => {
            const list = folders.get(f.key) ?? [];
            if (!list.length) return null;
            const unread = list.reduce((n, d) => n + (perDeal.get(d.id!)?.unread ?? 0), 0);
            return (
              <div key={f.key} className="em-folder">
                <button type="button" className="em-nav em-nav--folder" aria-expanded={folderOpen[f.key]}
                  onClick={() => setFolderOpen((o) => ({ ...o, [f.key]: !o[f.key] }))}>
                  <GmailIcon name="folder" size={18} />
                  <span className="em-nav-label">{f.label}</span>
                  {unread ? <span className="em-nav-count">{unread}</span> : <span className="em-nav-muted">{list.length}</span>}
                </button>
                {folderOpen[f.key] ? list.map((d) => {
                  const c = perDeal.get(d.id!);
                  return (
                    <button key={d.id} type="button" className="em-nav em-nav--deal" aria-current={dealId === d.id ? 'true' : undefined}
                      onClick={() => pickDeal(d.id!)} title={d.label}>
                      <span className="em-nav-label">{d.label}</span>
                      {c?.unread ? <span className="em-nav-count">{c.unread}</span> : c?.mail ? <span className="em-nav-muted">{c.mail}</span> : null}
                    </button>
                  );
                }) : null}
              </div>
            );
          })}
        </nav>

        <div className="em-panel">
          {thread || picked === 'new' ? (
            // The reading view: back to the list, the thread's actions, and the
            // pane that already knows how to send, template, merge and link.
            <>
              <div className="em-toolbar">
                <button type="button" aria-label="Back to the list" title="Back" className="em-icon-btn" onClick={() => setPicked(null)}>
                  <GmailIcon name="arrow_back" />
                </button>
                {thread ? (
                  <>
                    <button
                      type="button" aria-label="Archive" title="Archive" className="em-icon-btn"
                      onClick={() => { setArchived(idsOf(thread)); setPicked(null); }}
                    >
                      <GmailIcon name="archive" />
                    </button>
                    <button
                      type="button" aria-label="Mark as unread" title="Mark as unread" className="em-icon-btn"
                      onClick={() => { markRead(idsOf(thread), false); setPicked(null); }}
                    >
                      <GmailIcon name="mark_email_unread" />
                    </button>
                    <button
                      type="button" aria-label={threadStarred ? 'Starred' : 'Star'} title="Star" className="em-icon-btn"
                      onClick={() => toggleStar(thread.last.id)}
                    >
                      <GmailIcon
                        name={threadStarred ? 'star' : 'star_outline'}
                        style={{ color: threadStarred ? 'var(--amber)' : undefined }}
                      />
                    </button>
                  </>
                ) : null}
              </div>
              {workspaceId ? (
                <GmailThread
                  thread={thread}
                  isNew={picked === 'new'}
                  workspaceId={workspaceId}
                  userId={userId}
                  email={email}
                  recordFor={recordFor}
                  deal={thread?.deal_id ? dealFor?.(thread.deal_id) ?? null : null}
                  deals={deals}
                  files={extras.files}
                  receipts={extras.receipts}
                  onRefiled={refresh}
                  readOnly={viewingOther}
                  composeDealId={dealId}
                  mergeFor={mergeFor}
                  picker={picker}
                  placeCall={placeCall}
                  toast={toast}
                  onSent={(key) => { setPicked(key); refresh(); }}
                  onReply={onCompose ? (d) => onCompose(d, refresh) : undefined}
                />
              ) : null}
            </>
          ) : (
            <>
              {openDeal && dealId ? (
                <section className="em-deal">
                  <div className="em-deal-head">
                    <GmailIcon name="folder" size={18} />
                    <h2 className="em-deal-title">{openDeal.label}</h2>
                    {openDeal.stage ? <span className="em-tag">{openDeal.stage}</span> : null}
                    <span className="em-compose-spacer" />
                    <button type="button" className="em-record" onClick={openDeal.open}>Open deal</button>
                  </div>
                  <div className="em-team" role="group" aria-label="Deal team">
                    <span className="em-team-label"><GmailIcon name="people" size={14} /> Team</span>
                    {dealTeam.length === 0 ? <span className="em-muted">No one on this deal’s team yet.</span> : null}
                    {dealTeam.map((p) => {
                      const a = (p.email ?? '').toLowerCase();
                      return (
                        <button key={p.id} type="button" className="em-party" aria-pressed={!!a && party === a} disabled={!a}
                          title={a ? `Show mail with ${a}` : 'No email on file'}
                          onClick={() => setParty(party === a ? null : a)}>
                          <span className="em-party-role">{PARTY_ROLE_LABEL[p.role] ?? p.role}</span>
                          <span>{p.name || p.company || p.email || '—'}</span>
                        </button>
                      );
                    })}
                  </div>
                  {strangers.length ? (
                    <div className="em-team" role="group" aria-label="Also writing about this deal">
                      <span className="em-team-label">Also on these emails</span>
                      {strangers.map((a) => (
                        <span key={a} className="em-party em-party--new">
                          <button type="button" className="em-party-pick" aria-pressed={party === a} onClick={() => setParty(party === a ? null : a)}>{a}</button>
                          <button type="button" className="em-party-add" title="Add to the deal team" onClick={() => void addToTeam(a)}>
                            <GmailIcon name="person_add" size={14} /> Add
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="em-folders em-folders--deal" role="tablist" aria-label="Deal mail">
                    <button type="button" role="tab" className="em-chip-btn" aria-current={dealTab === 'mail' ? 'true' : undefined} onClick={() => setDealTab('mail')}>
                      Emails <span className="em-nav-muted">{source.length}</span>
                    </button>
                    <button type="button" role="tab" className="em-chip-btn" aria-current={dealTab === 'files' ? 'true' : undefined} onClick={() => setDealTab('files')}>
                      Files <span className="em-nav-muted">{dealFiles.length}</span>
                    </button>
                  </div>
                </section>
              ) : null}
              {viewingOther ? (
                <div className="em-notice">
                  Reading {team.find((t) => t.user_id === mailbox)?.full_name || 'a teammate'}’s mailbox — the CRM mail their Gmail synced. Read-only.
                </div>
              ) : null}
              {dealId && dealTab === 'files' && workspaceId ? (
                <div className="min-h-0 flex-1 overflow-auto em-files em-files--page">
                  {dealFiles.length === 0 ? <Empty>No files on this deal’s email yet.</Empty> : dealFiles.map((f) => (
                    <FileChip key={f.id} f={f} workspaceId={workspaceId} canSave={!viewingOther} toast={toast} onSaved={refresh} />
                  ))}
                </div>
              ) : (<>
              <div className="em-find">
                <div className="search-pill flex items-center gap-2">
                  <Icon name="search" size={14} style={{ color: '#8e8e93', flexShrink: 0 }} />
                  {/* A new search starts at the top. Reset here rather than
                      from an effect: setting state in an effect body is what
                      makes renders cascade. */}
                  <input
                    value={q}
                    onChange={(e) => { setQ(e.target.value); setPage(0); }}
                    placeholder="Search mail" aria-label="Search mail"
                  />
                  {q ? (
                    <button type="button" aria-label="Clear search" className="em-clear" onClick={() => { setQ(''); setPage(0); }}>
                      <Icon name="x" size={13} />
                    </button>
                  ) : null}
                </div>
                {/* The rail's Compose, on a phone where the rail is folded away. */}
                <button type="button" aria-label="Compose" title="Compose" className="em-icon-btn em-only-narrow" onClick={() => (onCompose ? onCompose({ dealId }, refresh) : setPicked('new'))}
                  style={{ background: 'var(--accent)', color: '#fff' }}>
                  <Icon name="edit" size={16} />
                </button>
              </div>

              {/* The rail's mailbox and deal folders, on a phone where the rail is folded away. */}
              <div className="em-narrow-pickers">
{seesAllMail || userId ? (
                <select className="em-select" value={mailbox ?? ''} onChange={(e) => pickMailbox(e.target.value)} aria-label="Whose mail">
                  {seesAllMail ? <option value="">Everyone’s mail</option> : null}
                  {userId ? <option value={userId}>My mail</option> : null}
                  {seesAllMail ? team.filter((t) => t.user_id !== userId).map((t) => (
                    <option key={t.user_id} value={t.user_id}>{t.full_name || t.email || 'Teammate'}</option>
                  )) : null}
                </select>
                ) : null}
                <select className="em-select" value={dealId ?? ''} aria-label="Deal folder"
                  onChange={(e) => (e.target.value ? pickDeal(Number(e.target.value)) : pickBucket('inbox'))}>
                  <option value="">All deals</option>
                  {FOLDERS.map((f) => (folders.get(f.key)?.length ? (
                    <optgroup key={f.key} label={f.label}>
                      {folders.get(f.key)!.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </optgroup>
                  ) : null))}
                </select>
              </div>
              {!dealId ? (
              <div className="em-folders" role="group" aria-label="Mail folders">
                {BUCKETS.map((b) => (
                  <button
                    key={b.key} type="button" className="em-chip-btn"
                    aria-current={bucket === b.key ? 'true' : undefined}
                    onClick={() => pickBucket(b.key)}
                  >
                    {b.label}
                    {b.key === 'inbox' && unreadCount > 0 ? <span className="em-nav-count">{unreadCount}</span> : null}
                  </button>
                ))}
              </div>
              ) : null}

              <div className="em-toolbar">
                <button
                  type="button" role="checkbox" aria-checked={allChecked ? 'true' : someChecked ? 'mixed' : 'false'}
                  aria-label="Select all" className="em-icon-btn" onClick={toggleAll}
                >
                  <GmailCheck state={allChecked ? 'on' : someChecked ? 'some' : 'off'} />
                </button>
                {checked.size > 0 ? (
                  <>
                    <button type="button" aria-label="Archive" title="Archive" className="em-icon-btn" onClick={archiveChecked}>
                      <GmailIcon name="archive" />
                    </button>
                    <button type="button" aria-label="Mark as read" title="Mark as read" className="em-icon-btn" onClick={() => readChecked(true)}>
                      <GmailIcon name="mark_email_read" />
                    </button>
                    <button type="button" aria-label="Mark as unread" title="Mark as unread" className="em-icon-btn" onClick={() => readChecked(false)}>
                      <GmailIcon name="mark_email_unread" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button" aria-label="Refresh" title="Refresh" className="em-icon-btn"
                    disabled={syncing || !email.account} onClick={() => void syncNow()}
                  >
                    <GmailIcon name="refresh" />
                  </button>
                )}

                <div className="em-pager">
                  <span>
                    {total === 0 ? '0' : `${page * PAGE + 1}–${Math.min(total, page * PAGE + PAGE)}`}
                    {' of '}
                    {total}
                  </span>
                  <button
                    type="button" aria-label="Newer" title="Newer" className="em-icon-btn"
                    disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    <GmailIcon name="keyboard_arrow_left" />
                  </button>
                  <button
                    type="button" aria-label="Older" title="Older" className="em-icon-btn"
                    disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}
                  >
                    <GmailIcon name="keyboard_arrow_right" />
                  </button>
                </div>
              </div>

              {!persists ? (
                // Said out loud rather than papered over: the tab works, it
                // just cannot remember across a reload until migration 73 runs.
                <div className="em-notice">
                  Read and starred are not being saved yet — this workspace has not had the inbox migration applied.
                </div>
              ) : null}

              <div className="min-h-0 flex-1 overflow-auto">
                {demo || !workspaceId ? (
                  <Empty>Connect a workspace to read mail here.</Empty>
                ) : email.loading || scoped?.loading ? (
                  <Empty>Loading…</Empty>
                ) : scoped?.error || email.error ? (
                  <Empty>{scoped?.error || email.error}</Empty>
                ) : !email.account ? (
                  <div style={{ padding: 16, maxWidth: 720 }}>
                    <GoogleConnect workspaceId={workspaceId} demo={demo} userId={userId} />
                  </div>
                ) : shown.length === 0 ? (
                  <Empty>{q ? (email.searching ? 'Searching older mail…' : 'No mail matched that search.') : dealId ? 'No email filed on this deal yet. Mail with anyone on its team, or naming its street in the subject, lands here on the next sync.' : 'Nothing here.'}</Empty>
                ) : (
                  <>{shown.map((t) => {
                    const ids = idsOf(t);
                    const tracked = t.rows.filter((r) => extras.receipts.has(r.id));
                    return (
                      <GmailRow
                        key={t.key}
                        thread={t}
                        senders={participantsOf(t, recordFor)}
                        unread={threadUnread(t.rows, read, seenThrough)}
                        starred={ids.some((id) => starred.has(id))}
                        checked={checked.has(t.key)}
                        record={t.counterpart ? recordFor?.(t.counterpart) ?? null : null}
                        deal={t.deal_id && !dealId ? dealFor?.(t.deal_id) ?? null : null}
                        hasFiles={t.rows.some((r) => (extras.files.get(r.id)?.length ?? 0) > 0)}
                        opened={tracked.length ? tracked.some((r) => (extras.receipts.get(r.id)?.opens ?? 0) > 0) : undefined}
                        onOpen={() => open(t)}
                        onCheck={() => toggleOne(t.key)}
                        onStar={() => toggleStar(t.last.id)}
                        onArchive={() => setArchived(ids)}
                        onToggleRead={() => markRead(ids, !threadUnread(t.rows, read, seenThrough))}
                      />
                    );
                  })}
                  {!scoped && email.hasMore && (page + 1) * PAGE >= total ? (
                    <div className="em-more">
                      <button type="button" className="em-more-btn" disabled={email.loadingMore} onClick={() => void email.more()}>
                        {email.loadingMore ? 'Loading older mail…' : 'Load older mail'}
                      </button>
                    </div>
                  ) : null}
                  </>
                )}
              </div>
              </>)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="em-empty">{children}</div>
  );
}
