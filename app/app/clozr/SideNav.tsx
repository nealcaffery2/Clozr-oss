// The desk's side menu: the app's sections in three groups, the product tools,
// and the controls that used to sit in the top bar (search, Quick add,
// notifications, Ask CLOZR, the account menu). Phones keep the top bar and
// the bottom tabs; this only mounts on a desk. It can fold to an icon rail,
// remembered per browser.
'use client';

import React, { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ClozrAppIcon, ClozrMark } from '@/components/ds/ClozrMark';
import { ComprIcon } from '@/components/ds/ComprIcon';
import { Mark } from '@/components/ds/mark';
import { UserAvatar } from '@/components/UserAvatar';
import { avatarOf } from '@/lib/avatar';
import { displayName, useSession } from '@/lib/session';
import { ROLE_LABEL, type Role } from '@/lib/team';
import { AccountMenu, QuickAddMenu } from './ShellMenus';
import { placePill } from './motion';
import './sidenav.css';

const GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Daily', keys: ['today', 'people', 'inbox', 'dialer', 'tasks', 'calendar'] },
  { label: 'Pipeline', keys: ['deals', 'contracts', 'dispo', 'buyers'] },
  { label: 'Team', keys: ['reporting', 'coaching'] },
];

/** Lucide geometry, one per section. */
const ICON: Record<string, React.ReactNode> = {
  today: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" /></>,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><path d="M18 14.5a6 6 0 0 1 3.5 5.5" /></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" /></>,
  dialer: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />,
  tasks: <><path d="m9 11 3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
  deals: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>,
  contracts: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M8 17c1.5-2 2.5-2 3.5 0s2 2 4.5-1" /></>,
  dispo: <><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" /></>,
  buyers: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M3 13h18" /></>,
  reporting: <><path d="M3 3v18h18" /><path d="M8 17v-5M13 17V8M18 17v-3" /></>,
  coaching: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
};

function Icon({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      {children}
    </svg>
  );
}

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

  const items = V.navItems || [];
  const grouped = GROUPS.map((g) => ({ label: g.label, items: items.filter((n) => g.keys.includes(n.key)) }));
  // A section the groups do not name still shows, at the end of the last group.
  const loose = items.filter((n) => !GROUPS.some((g) => g.keys.includes(n.key)));
  if (loose.length) grouped[grouped.length - 1].items.push(...loose);
  const tools = V.navTools || [];

  // One selected pill for the whole menu, moved to whichever section is open.
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const activeKey = items.find((n) => n.on)?.key ?? tools.find((t) => t.bg !== 'transparent')?.label ?? '';
  const layoutKey = `${activeKey}|${folded}|${items.map((n) => n.key).join()}|${tools.length}`;
  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return;
    placePill(nav, pill, nav.querySelector<HTMLElement>(".cz-side-link[aria-current='page']"));
  }, [layoutKey]);

  const bell = (
    <button type="button" className="cz-side-icon" onClick={V.toggleNotif} aria-label={V.unreadNotifs ? `Notifications, ${V.unreadNotifs} unread` : 'Notifications'} title="Notifications">
      <Icon><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></Icon>
      {V.unreadNotifs ? <span className="cz-side-badge" aria-hidden="true">{V.unreadNotifs > 99 ? '99+' : V.unreadNotifs}</span> : null}
    </button>
  );

  return (
    <nav ref={navRef} aria-label="Main" data-tabs className={'cz-side' + (folded ? ' is-folded' : '')} style={{ display: V.chromeDisplay === 'none' ? 'none' : undefined }}>
      <span ref={pillRef} className="cz-side-pill" aria-hidden="true" />
      <div className="cz-side-head">
        <button type="button" className="cz-side-logo" onClick={V.goHome} aria-label="Clozr home">
          {folded ? <ClozrAppIcon size={32} /> : <ClozrMark size={17} />}
        </button>
        {folded ? null : bell}
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

      {grouped.filter((g) => g.items.length).map((g, gi) => (
        <div key={g.label} role="group" aria-label={g.label} className={'cz-side-group' + (gi ? ' has-rule' : '')}>
          {folded ? null : <span className="cz-side-label">{g.label}</span>}
          {g.items.map((n) => (
            <button key={n.key} type="button" className="cz-side-link" onClick={n.go} aria-current={n.on ? 'page' : undefined} title={folded ? n.label : undefined} aria-label={folded ? n.label : undefined}>
              <Icon>{ICON[n.key] ?? ICON.today}</Icon>
              {folded ? null : <span className="cz-side-grow">{n.label}</span>}
            </button>
          ))}
        </div>
      ))}

      {tools.length ? (
        <div role="group" aria-label="Tools" className="cz-side-group has-rule">
          {folded ? null : <span className="cz-side-label">Tools</span>}
          {tools.map((t) => {
            const name = t.label;
            const badge = 'badge' in t && t.badge ? t.badge : 0;
            return (
              <button key={t.label} type="button" className="cz-side-link is-tool" onClick={t.go} aria-current={t.bg !== 'transparent' ? 'page' : undefined} title={folded ? name : undefined} aria-label={folded ? name : undefined}>
                <span className="cz-side-tool" style={{ color: t.dot }}>{t.label === 'COMPR' ? <ComprIcon size={14} /> : <Mark label={t.label} size={14} />}</span>
                {folded ? null : <span className="cz-side-grow">{name}</span>}
                {badge ? <span className={folded ? 'cz-side-badge is-lane' : 'cz-side-count is-lane'} title={`Lane has ${badge} for you`}>{badge}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="cz-side-foot">
        <button type="button" className="cz-side-link" onClick={V.toggleAi} title="Help, ask CLOZR" aria-label={folded ? 'Ask CLOZR' : undefined}>
          <Icon><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></Icon>
          {folded ? null : <span className="cz-side-grow">Ask CLOZR</span>}
        </button>
        {folded ? bell : null}
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
