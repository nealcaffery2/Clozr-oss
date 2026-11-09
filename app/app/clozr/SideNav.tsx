// The desk's side menu: the app's places in their groups and the product tools
// (both from lib/nav-model.ts, through the view model), Settings at the foot,
// and the controls that used to sit in the top bar (search, Quick add,
// notifications, Ask CLOZR, the account menu). Phones keep the top bar and
// the bottom tabs; this only mounts on a desk. It can fold to an icon rail,
// remembered per browser.
'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { isVoicemail, useCalls, useEmail } from '@/app/components/inbox/data';
import { threadUnread, useEmailState } from '@/lib/email-state';
import { isCleared, isUnread, smsKey, useInboxState } from '@/lib/inbox-state';
import { callOwner, inInbox, lineOwners } from '@/lib/inbox-owner';
import type { ClozrView } from '@/app/clozr/view';
import { ClozrAppIcon, ClozrMark } from '@/components/ds/ClozrMark';
import { UserAvatar } from '@/components/UserAvatar';
import { avatarOf } from '@/lib/avatar';
import { displayName, useSession } from '@/lib/session';
import { ROLE_LABEL, type Role } from '@/lib/team';
import { AccountMenu, QuickAddMenu } from './ShellMenus';
import { DialerLauncher } from '@/app/components/talkr/DialerPanel';
import { placePill } from './motion';
import { NavIcon } from './NavIcon';
import { toolsOpen } from '@/lib/nav-model';
import './sidenav.css';

function Icon({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      {children}
    </svg>
  );
}

const TOOLS_KEY = 'clozr.sidenav.tools';
const toolsListeners = new Set<() => void>();
/**
 * The Tools rows shown or folded away, per browser: '1' shown, '0' folded,
 * '' never chosen (folded). Storage that throws (private mode) reads as never chosen.
 */
const TOOLS = {
  subscribe: (fn: () => void) => { toolsListeners.add(fn); return () => { toolsListeners.delete(fn); }; },
  get: (): string => { try { return localStorage.getItem(TOOLS_KEY) ?? ''; } catch { return ''; } },
  getServer: (): string => '',
  set: (v: boolean) => {
    try { localStorage.setItem(TOOLS_KEY, v ? '1' : '0'); } catch { /* storage blocked: the choice lasts until reload */ }
    toolsListeners.forEach((fn) => fn());
  },
};

const FOLD_KEY = 'clozr.sidenav.folded';
const foldListeners = new Set<() => void>();
/** Folded or open, per browser. Storage that throws (private mode) reads as open. */
const FOLD = {
  subscribe: (fn: () => void) => { foldListeners.add(fn); return () => { foldListeners.delete(fn); }; },
  get: (): boolean => { try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; } },
  getServer: (): boolean => false,
  set: (v: boolean) => {
    try { localStorage.setItem(FOLD_KEY, v ? '1' : '0'); } catch { /* storage blocked: nothing to keep */ }
    foldListeners.forEach((fn) => fn());
  },
};

/**
 * A menu row is a real link: a plain left click stays in the app (no reload,
 * so the softphone and a live dial session keep going); middle-click,
 * ctrl/cmd-click and the right-click menu get the browser's own new tab.
 */
function linkClick(go: () => void) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };
}

export function SideNav({ V }: { V: ClozrView }) {
  const session = useSession();
  const who = displayName(session);
  const role = session.workspace ? (ROLE_LABEL[session.workspace.role as Role] ?? session.workspace.role) : 'Sample data';
  const folded = useSyncExternalStore(FOLD.subscribe, FOLD.get, FOLD.getServer);
  // Full-width overlays (the campaign builder) start where the menu ends.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--clozr-side', folded ? '64px' : '236px');
    return () => { root.style.removeProperty('--clozr-side'); };
  }, [folded]);
  const fold = () => FOLD.set(!folded);

  // The Inbox count: the Inbox's own Unread folder for this rep (texts, email
  // threads and missed calls), with what they opened or archived in CLOZR
  // taken off. Talkr's raw unread count alone ignored that, so the badge read
  // 88 over an Unread folder of 2 (2026-10-26). The bell's Mark all read does not touch it.
  const workspaceId = V.liveIds?.workspaceId ?? null;
  const userId = session.user?.id ?? null;
  const email = useEmail(workspaceId, userId);
  const mail = useEmailState(workspaceId, userId);
  const inbox = useInboxState(workspaceId, userId);
  const phone = V.talkrPhone.data;
  // The Inbox's own 200 calls: the phone's 40 are an hour of floor dials, which left missed calls off the badge.
  const calls = useCalls(V.talkrAuthed);
  const refreshCalls = calls.refresh;
  useEffect(() => { refreshCalls(); }, [phone.history, refreshCalls]);
  const inboxUnread = useMemo(() => {
    const open = (key: string, at: string | null | undefined) => {
      const st = inbox.state.get(key);
      return isUnread(true, at, st) && !isCleared(at, st);
    };
    const texts = V.talkrAuthed ? phone.unreadThreads.filter((t) => open(smsKey(t.phone), t.at)).length : 0;
    const owners = lineOwners(phone.me?.org_numbers);
    const missed = V.talkrAuthed ? calls.calls.filter((h) => h.direction === 'inbound' && (!h.duration_seconds || isVoicemail(h))
      && inInbox(callOwner(h, owners), 'me', phone.me?.id ?? null) && open(`call:${h.id}`, h.at)).length : 0;
    const mails = email.threads.filter((t) => threadUnread(t.rows, mail.read, mail.seenThrough) && !isCleared(t.last.occurred_at, inbox.state.get(`email:${t.key}`))).length;
    return texts + missed + mails;
  }, [V.talkrAuthed, phone.unreadThreads, calls.calls, phone.me, email.threads, mail.read, mail.seenThrough, inbox.state]);

  const grouped = V.navGroups || [];
  const items = grouped.flatMap((g) => g.items);
  const tools = V.navTools || [];
  const foot = V.navFoot || [];

  // One selected pill for the whole menu, moved to whichever section is open.
  // It lives in the sections' own scroller, so it scrolls with them on a
  // window too short for the list, and is placed again when the window's
  // height changes the row heights (sidenav.css).
  const listRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const activeKey = [...items, ...tools].find((n) => n.on)?.key ?? '';
  // Tools fold away so the rest fits a 900px window; the tool on view keeps them open.
  const toolsSaved = useSyncExternalStore(TOOLS.subscribe, TOOLS.get, TOOLS.getServer);
  const toolsState = toolsOpen(toolsSaved === '' ? null : toolsSaved === '1', activeKey, tools.map((t) => t.key));
  const toolsShown = toolsState.open;
  const toolsBadge = tools.reduce((n, t) => n + (t.badge || 0), 0);
  const layoutKey = `${activeKey}|${folded}|${items.map((n) => n.key).join()}|${tools.length}|${toolsShown}`;
  useLayoutEffect(() => {
    const list = listRef.current;
    const pill = pillRef.current;
    if (!list || !pill) return;
    const place = () => placePill(list, pill, list.querySelector<HTMLElement>(".cz-side-link[aria-current='page']"));
    place();
    // On a window too short for every row, the lit one scrolls into the list's view.
    const lit = list.querySelector<HTMLElement>(".cz-side-link[aria-current='page']");
    if (lit && (lit.offsetTop < list.scrollTop || lit.offsetTop + lit.offsetHeight > list.scrollTop + list.clientHeight)) {
      list.scrollTop = Math.max(0, lit.offsetTop - (list.clientHeight - lit.offsetHeight) / 2);
    }
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [layoutKey]);

  // Notifications sit in the menu with Daily, a row like the sections, its
  // unread count on it. It opens the bell panel rather than a screen.
  const unread = V.unreadNotifs > 99 ? '99+' : V.unreadNotifs;
  const bell = (
    <button type="button" className="cz-side-link" onClick={V.toggleNotif} aria-expanded={V.notifOpen} data-testid="nav-notifications"
      aria-label={V.unreadNotifs ? `Notifications, ${V.unreadNotifs} unread` : 'Notifications'} title={folded ? 'Notifications' : undefined} style={{ position: 'relative' }}>
      <Icon><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></Icon>
      {folded ? null : <span className="cz-side-grow">Notifications</span>}
      {V.unreadNotifs ? <span className={folded ? 'cz-side-badge' : 'cz-side-count'} aria-hidden="true">{unread}</span> : null}
    </button>
  );

  return (
    <nav aria-label="Main" data-tabs className={'cz-side' + (folded ? ' is-folded' : '')} style={{ display: V.chromeDisplay === 'none' ? 'none' : undefined }}>
      <div className="cz-side-head">
        <button type="button" className="cz-side-logo" onClick={V.goHome} aria-label="Clozr home">
          {folded ? <ClozrAppIcon size={32} /> : <ClozrMark size={17} />}
        </button>
      </div>

      <div className="cz-side-actions">
        <button type="button" className="cz-side-search" onClick={V.openSearch} aria-label="Search or type a command" aria-keyshortcuts="Meta+K Control+K" aria-haspopup="dialog" title="Search (⌘K)">
          <Icon size={15}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
          {folded ? null : <><span className="cz-side-grow">Search</span><kbd>⌘K</kbd></>}
        </button>
        <div style={{ position: 'relative' }}>
          <button type="button" className="cz-side-add" onClick={V.toggleQuickAdd} aria-label="Quick add" aria-haspopup="menu" aria-expanded={V.quickAddOpen} title="Quick add (Q)">
            <Icon size={15}><path d="M12 5v14M5 12h14" /></Icon>
            {folded ? null : 'Add'}
          </button>
          {V.quickAddOpen ? <QuickAddMenu V={V} style={{ position: 'fixed', top: folded ? 96 : 94, left: folded ? 72 : 12, width: 240 }} /> : null}
        </div>
      </div>

      <div ref={listRef} className="cz-side-list">
        <span ref={pillRef} className="cz-side-pill" aria-hidden="true" />
        {grouped.map((g, gi) => (
          <div key={g.label} role="group" aria-label={g.label} className={'cz-side-group' + (gi ? ' has-rule' : '')}>
            {folded ? null : <span className="cz-side-label">{g.label}</span>}
            {g.items.map((n) => {
              const count = n.key === 'inbox' ? inboxUnread : 0;
              return (
                <a key={n.key} href={n.href} className="cz-side-link" onClick={linkClick(n.go)} aria-current={n.on ? 'page' : undefined} title={folded ? n.label : undefined}
                  aria-label={count ? `${n.label}, ${count} unread` : folded ? n.label : undefined} style={count ? { position: 'relative' } : undefined}>
                  <NavIcon name={n.icon} />
                  {folded ? null : <span className="cz-side-grow">{n.label}</span>}
                  {count ? <span className={folded ? 'cz-side-badge' : 'cz-side-count'} aria-hidden="true">{count > 99 ? '99+' : count}</span> : null}
                </a>
              );
            })}
            {gi === 0 ? bell : null}
          </div>
        ))}

        {tools.length ? (
          <div role="group" aria-label="Tools" className="cz-side-group has-rule">
            {/* The group's name folds and unfolds its rows. While a tool is on view they stay open. */}
            <button type="button" className={folded ? 'cz-side-link cz-side-toggle is-rail' : 'cz-side-label cz-side-toggle'}
              aria-expanded={toolsShown} aria-controls="cz-side-tools" disabled={toolsState.forced}
              onClick={() => TOOLS.set(!toolsShown)}
              aria-label={folded || toolsBadge ? `Tools${toolsBadge && !toolsShown ? `, Lane has ${toolsBadge} for you` : ''}` : undefined}
              title={toolsState.forced ? 'Tools stay open while one is on view' : toolsShown ? 'Hide tools' : 'Show tools'}>
              {folded ? null : <span className="cz-side-grow">Tools</span>}
              {toolsBadge && !toolsShown ? <span className={folded ? 'cz-side-badge is-lane' : 'cz-side-count is-lane'} aria-hidden="true">{toolsBadge}</span> : null}
              <Icon size={14}>{toolsShown ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}</Icon>
            </button>
            <div id="cz-side-tools" hidden={!toolsShown} style={{ display: toolsShown ? 'contents' : 'none' }}>
            {tools.map((t) => {
              const name = t.label;
              const badge = t.badge;
              const body = (
                <>
                  <span className="cz-side-tool" style={t.dot ? { color: t.dot } : undefined}><NavIcon name={t.icon} size={14} /></span>
                  {folded ? null : <span className="cz-side-grow">{name}</span>}
                  {badge ? <span className={folded ? 'cz-side-badge is-lane' : 'cz-side-count is-lane'} title={`Lane has ${badge} for you`}>{badge}</span> : null}
                </>
              );
              const on = t.on ? 'page' as const : undefined;
              // Tools that are screens link; COMPR and Lane act on the record in front of you, so they stay buttons.
              return t.href ? (
                <a key={t.key} href={t.href} className="cz-side-link is-tool" onClick={linkClick(t.go)} aria-current={on} title={folded ? name : undefined} aria-label={folded ? name : undefined}>{body}</a>
              ) : (
                <button key={t.key} type="button" className="cz-side-link is-tool" onClick={t.go} aria-current={on} title={folded ? name : undefined} aria-label={folded ? name : undefined}>{body}</button>
              );
            })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="cz-side-foot">
        {/* The icon rail has no room for Settings at 1440x900; the account menu just below opens it. */}
        {(folded ? foot.filter((f) => f.key !== 'settings') : foot).map((f) => {
          const body = (
            <>
              <NavIcon name={f.icon} />
              {folded ? null : <span className="cz-side-grow">{f.label}</span>}
            </>
          );
          const link = f.href ? (
            <a key={f.key} href={f.href} className="cz-side-link" onClick={linkClick(f.go)} aria-current={f.on ? 'page' : undefined} title={folded ? f.label : undefined} aria-label={folded ? f.label : undefined}>{body}</a>
          ) : (
            <button key={f.key} type="button" className="cz-side-link" onClick={f.go} aria-expanded={f.key === 'askClozr' ? V.aiOpen : undefined} title={folded ? f.label : 'Help, ask CLOZR'} aria-label={folded ? f.label : undefined}>{body}</button>
          );
          // Ask CLOZR and the dialer share a row; they used to float over the screens.
          return f.key === 'askClozr' ? (
            <div key={f.key} className="cz-side-row">
              {link}
              <DialerLauncher V={V} size={28} className="cz-side-icon" />
            </div>
          ) : link;
        })}
        {foot.some((f) => f.key === 'askClozr') ? null : <DialerLauncher V={V} size={28} className="cz-side-icon" />}
        <div style={{ position: 'relative' }}>
          <button type="button" className="cz-side-me" onClick={V.toggleAccountMenu} aria-haspopup="menu" aria-expanded={V.accountMenuOpen} title={`${who} · account and settings`}>
            <UserAvatar name={who} src={avatarOf(session.profile?.avatar_url, session.user?.user_metadata)} size={30} radius="50%" />
            {folded ? null : (
              <span className="cz-side-who">
                <span className="cz-side-name">{who}</span>
                <span className="cz-side-role">{role}</span>
              </span>
            )}
            {folded ? null : <Icon size={15}><path d="m7 15 5-5 5 5" /></Icon>}
          </button>
          {V.accountMenuOpen ? (
            <AccountMenu V={V} className="cz-menu" style={{ position: 'fixed', bottom: folded ? 40 : 86, left: folded ? 72 : 12, width: 240, transformOrigin: 'bottom left' }} />
          ) : null}
        </div>
        <button type="button" className="cz-side-fold" onClick={fold} aria-label={folded ? 'Expand the menu' : 'Collapse the menu'} title={folded ? 'Expand the menu' : 'Collapse the menu'}>
          <Icon size={15}>{folded ? <path d="m9 18 6-6-6-6" /> : <path d="m15 18-6-6 6-6" />}</Icon>
          {folded ? null : <span className="cz-side-grow">Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
