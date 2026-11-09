// Generated from the Claude Design prototype "CLOZR CRM.dc.html".
// Hand-edited since: the Talkr dialer's caller-ID picker, softphone status,
// in-call keypad / transfer / conference panels, the incoming-call card, and
// every previously hard-coded transcript, intelligence and summary string now
// bind to the view-model (useTalkrPhone). The dialer itself (launcher, slide-out,
// incoming card, Dialer screen) is now Talkr's UI, in app/components/talkr.
// Re-generating from the prototype
// will drop those bindings unless the design carries them too.
// Inline styles are carried over verbatim; hover/focus styles live in clozr.css.
'use client';

// Talkr's two stylesheets, once, here. Imported from the ten dialer, inbox
// and composer modules that use them, each file became a shared CSS-only chunk
// whose JS half Vite never writes, so /app and /demo modulepreloaded
// talkr-inbox-*.js and talkr-dialer-*.js, both 404, and the chunk-reload
// guard (lib/chunk-reload.ts) read that as a stale deploy and loaded the page
// a second time. Every module that uses them renders inside this shell, and
// the page linked both stylesheets up front already.
import './talkr-inbox.css';
import './talkr-dialer.css';
import { Markdown } from '@/components/Markdown';
import { SearchSelect } from '@/components/SearchSelect';
import { ContractsHub, ContractsListPopup } from '@/components/ContractsHub';
import { ContractRequestHost } from '@/components/contract-request/ContractRequestHost';
import React, { Suspense, useEffect, useRef } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { CommandBar } from './CommandBar';
import { NavIcon } from './NavIcon';
import { NAV_GROUPS } from '@/lib/nav-model';
import { NotifList, type NotifListHandle } from './NotifList';
import { FloorShow } from './FloorShow';
import { SectionGapPops } from './SectionGapPops';
import { DialerReadinessHost } from '@/app/components/talkr/DialerReadiness';
import { VoicemailRecorderHost } from '@/app/components/talkr/VoicemailDrop';
import { AddInput, flushAddInputs } from '@/components/ds/AddInput';
import { MentionField } from '@/app/components/record/MentionField';
import { ScreenBoundary } from '@/components/ds/ScreenBoundary';
import { Empty } from '@/components/ds/Empty';
import { AddAsk } from './AddAsk';
import { ArchiveConfirm } from './ArchiveConfirm';
import { TaskEditSheet } from '@/app/components/tasks/TaskEditSheet';
import { BulkAgentPanel } from '@/app/components/ai-agent/BulkAgentPanel';
import { TalkrSoftphoneProvider } from '@/app/components/talkr/softphoneAdapter';
import { DialerIncoming, DialerLauncher, DialerPanel } from '@/app/components/talkr/DialerPanel';
import { CallBar } from '@/app/components/talkr/CallBar';
import { PhoneCallPill, PhoneScreen } from '@/app/components/talkr/PhoneScreen';
import { applyStoredPrefs } from './prefs';
import { ScreenEnter, usePressFeedback } from './motion';
import { ActionPlans, Automations, BuyerRecord, Buyers, Calendar, Campaigns, Coaching, DealMachine, DealSheet, Deals, Dialer, Dispo, DispoProperty, Home, Import, Inbox, People, Reporting, SalesLeaderboard, ScreenLoading, SellerRecord, Settings, Tasks, Today, TransactionCoordination, VendorRecord, preloadScreens } from './screens/lazy';
import { ClozrAppIcon, ClozrMark } from '@/components/ds/ClozrMark';
import { displayName, useSession } from '@/lib/session';
import { usePendingLeads } from '@/lib/use-crm';
import { UserAvatar } from '@/components/UserAvatar';
import { avatarOf } from '@/lib/avatar';
import { PhotoShow } from '@/app/components/record/PhotoShow';
import { QuickReach } from '@/app/components/record/QuickReach';
import { MeetingInviteHost } from '@/app/components/meeting/MeetingInvite';
import { Mark } from '@/components/ds/mark';
import { Drawer } from '@/components/ds/Drawer';
import { Button, buttonClass } from '@/components/ds/Button';
import { Plus } from 'lucide-react';
import { SideNav } from './SideNav';
import { AccountMenu, QuickAddMenu } from './ShellMenus';
import { SignPrompt } from '@/components/SignPrompt';
import { dismissToast, useToast } from './toastStore';
import { Icon as ResIcon, LaneResources, RESOURCES_ICON } from './LaneResources';
import { closeResources, toggleResources, useResourcesPanel } from '@/lib/resources';

/** Lucide geometry, currentColor, for the shell's few icons (DESIGN.md §1: no glyphs). */
/** The More sheet's headings, in the order the desk's side menu uses. */
const MORE_GROUPS = NAV_GROUPS;

const ICON_PATHS = {
  x: 'M18 6 6 18M6 6l12 12',
  chevronRight: 'm9 18 6-6-6-6',
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  briefcase: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  check: 'M20 6 9 17l-5-5',
};
function CardIcon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={d} />
    </svg>
  );
}
const XIcon = () => <CardIcon d={ICON_PATHS.x} size={16} />;
const ChevronRightIcon = () => <CardIcon d={ICON_PATHS.chevronRight} size={14} />;

function NewLeadsBar() {
  const { count, refresh } = usePendingLeads();
  if (!count) return null;
  const noun = count === 1 ? 'new lead arrived' : 'new leads arrived';
  return (
    <div role="status" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 16px', background: 'var(--tint-orange, #fff7ed)', borderBottom: '1px solid #fdba74', color: 'var(--tx-orange-deep, #9a3412)', fontSize: '13px' }}>
      <span style={{ flex: 1, minWidth: 0 }}>{count.toLocaleString()} {noun}.</span>
      <button type="button" onClick={refresh} style={{ height: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid #0A8560', background: '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}>
        Refresh
      </button>
    </div>
  );
}

/**
 * The toast, on its own: it reads its store (toastStore), so raising one
 * redraws this and not the shell. A tick on the Tasks list raises one in the
 * click, and redrawing the whole shell there held up the tick's paint.
 */
function ShellToast({ phone, phoneUp }: { phone: boolean; phoneUp: boolean }) {
  const toast = useToast();
  return (
    toast.msg ? (
      <>
      {/* The square says how it went: red for a write that failed (announced
          at once, and left up long enough to read), green for one that
          landed, grey for everything else. */}
      <div role={toast.tone === 'error' ? 'alert' : 'status'} aria-live={toast.tone === 'error' ? 'assertive' : 'polite'} style={{position: "fixed", left: "50%", ...(phone && phoneUp ? {top: "calc(env(safe-area-inset-top, 0px) + 56px)", bottom: "auto"} : {bottom: phone ? "calc(70px + env(safe-area-inset-bottom, 0px) + var(--clozr-callbar, 0px) + var(--clozr-todaybar, 0px) + var(--clozr-dock, 0px))" : "calc(24px + var(--clozr-callbar, 0px) + var(--clozr-todaybar, 0px))"}), transform: "translateX(-50%)", width: "max-content", maxWidth: "calc(100vw - 32px)", background: "var(--ink, #18181b)", color: "var(--surface, #fff)", padding: "10px 14px", borderRadius: "10px", fontSize: "13px", fontWeight: "500", boxShadow: "var(--shadow-md)", zIndex: "var(--z-toast)", display: "flex", alignItems: "center", gap: "8px", animation: "clozrToastIn .22s cubic-bezier(.23,1,.32,1)"}}>
        <span style={{ color: toast.tone === 'error' ? "var(--c-err)" : toast.tone === 'success' ? "var(--c-ok)" : "var(--meta, #71717a)", display: 'inline-flex' }}><Mark label={toast.tone === 'error' ? 'error' : toast.tone === 'success' ? 'success' : 'info'} /></span>
        {toast.msg}
        {toast.action ? (
          // Pressing the button runs the action and takes the toast down.
          <button type="button" onClick={() => { const run = toast.action?.run; dismissToast(); run?.(); }} style={{marginLeft: "6px", border: "0", background: "none", padding: "2px 4px", color: "#6ee7b7", font: "inherit", fontWeight: "650", cursor: "pointer"}}>
            {toast.action.label}
          </button>
        ) : null}
      </div>
      </>
    ) : null
  );
}

export function ClozrShell({ V, children }: { V: ClozrView; children?: React.ReactNode }) {
  // The shell owns the account menu, so it reads the session directly rather
  // than routing identity through the view-model, which knows only about the
  // entity graph.
  const session = useSession();
  const who = displayName(session);
  const notifList = useRef<NotifListHandle>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // Quick Add's Enter reads the form a beat after the fields hand over what was just typed.
  const viewRef = useRef(V);
  useEffect(() => { viewRef.current = V; }, [V]);
  usePressFeedback(shellRef);
  const resPanel = useResourcesPanel();

  // Display preferences (Settings) are a class on <body>; set it once on mount
  // so a compact-rows choice holds before Settings has ever been opened.
  useEffect(() => { applyStoredPrefs(); }, []);
  // Screens are separate chunks. Once the workspace is in (the demo has
  // nothing to wait for), warm the screen in view and the few opened most;
  // the rest load on their first open.
  const dataIn = V.isLiveData || V.isDemo;
  const screen = V.screen;
  useEffect(() => { if (dataIn) preloadScreens(screen); }, [dataIn, screen]);

  return (
    <TalkrSoftphoneProvider V={V}>
    <div ref={shellRef} data-screen-label="CLOZR shell" className="clozr-shell" tabIndex={-1} style={{minWidth: "0", width: "100%", display: "flex", flexDirection: V.isMobile ? "column" : "row", fontSize: "13px", lineHeight: "1.45", background: "var(--canvas, #fafafa)", color: "var(--ink, #18181b)", paddingBottom: V.isMobile ? "calc(58px + env(safe-area-inset-bottom, 0px) + var(--clozr-callbar, 0px))" : "0"}}>
      {V.isMobile ? null : <SideNav V={V} />}
      <div style={{flex: "1", minWidth: "0", minHeight: "0", display: "flex", flexDirection: "column"}}>
      {/* The phone keeps this bar; on a desk the side menu carries all of it. */}
      <header inert={V.isMobile && V.phoneUp ? true : undefined} style={{height: "56px", flex: "none", display: V.isMobile ? V.chromeDisplay : "none", alignItems: "center", gap: "8px", padding: "0 16px", background: "var(--surface, #fff)", borderBottom: "1px solid var(--divider, #e4e4e7)", position: "relative", zIndex: "var(--z-sticky)", minWidth: "0"}}>
        <button onClick={V.goHome} style={{display: "flex", alignItems: "center", gap: "10px", background: "none", border: "0", padding: "0 6px 0 0", cursor: "pointer", color: "var(--ink, #18181b)"}}>
          <ClozrMark size={18} />
        </button>
        <div style={{flex: "1", minWidth: "8px"}}></div>
        <button className="dc32" onClick={V.openSearch} aria-label="Search or type a command" aria-keyshortcuts="Meta+K Control+K" aria-haspopup="dialog" style={{height: "34px", flex: V.isMobile ? "none" : "1", width: V.isMobile ? "34px" : "auto", justifyContent: V.isMobile ? "center" : "flex-start", minWidth: V.isMobile ? "34px" : "132px", maxWidth: "280px", display: "flex", alignItems: "center", gap: "9px", padding: V.isMobile ? "0" : "0 10px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "9px", background: "var(--canvas, #fafafa)", color: "var(--meta, #71717a)", cursor: "pointer", fontSize: "13px", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden"}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span style={{flex: "1", overflow: "hidden", textOverflow: "ellipsis", display: V.isMobile ? "none" : "block"}}>
            Search or type a command
          </span>
          <span style={{display: V.isMobile ? "none" : "inline", fontSize: "11px", color: "var(--meta, #71717a)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "5px", padding: "1px 5px", background: "var(--surface, #fff)"}}>
            ⌘K
          </span>
        </button>
        <div style={{position: "relative"}}>
          <button className="dc10" onClick={V.toggleQuickAdd} aria-label="Quick add" style={{height: "34px", padding: V.isMobile ? "0" : "0 12px", width: V.isMobile ? "34px" : "auto", borderRadius: "9px", border: "1px solid var(--c-primary)", background: "var(--c-primary)", color: "#fff", fontWeight: "600", fontSize: "13px", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", whiteSpace: "nowrap", flex: "none"}}>
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span style={{display: V.isMobile ? "none" : "inline"}}>Quick Add</span>
            <span style={{display: V.isMobile ? "none" : "inline", fontSize: "10.5px", color: "var(--on-dark, #fff)", whiteSpace: "nowrap", border: "1px solid rgba(255,255,255,.4)", borderRadius: "4px", padding: "0 4px", marginLeft: "2px"}}>
              Q
            </span>
          </button>
          {V.quickAddOpen ? <QuickAddMenu V={V} style={{position: V.isMobile ? "fixed" : "absolute", top: V.isMobile ? "58px" : "40px", right: V.isMobile ? "12px" : "0", left: V.isMobile ? "12px" : "auto", width: V.isMobile ? "auto" : "240px"}} /> : null}
        </div>
        <DialerLauncher V={V} />
        <button className="dc6" onClick={V.toggleNotif} title="Notifications" aria-label={V.unreadNotifs ? `Notifications, ${V.unreadNotifs} unread` : 'Notifications'} style={{position: "relative", width: "34px", height: "34px", borderRadius: "9px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", color: "var(--muted, #52525b)", cursor: "pointer", display: "grid", placeItems: "center"}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          {/* Nothing unread, no badge: a "0" reads as something to look at. */}
          {V.unreadNotifs > 0 ? (
            <span aria-hidden="true" style={{position: "absolute", top: "-5px", right: "-5px", minWidth: "18px", height: "18px", borderRadius: "9px", background: "var(--c-accent)", color: "#fff", fontSize: "11px", fontWeight: "600", fontVariantNumeric: "tabular-nums", display: "grid", placeItems: "center", padding: "0 4px", border: "2px solid #fff"}}>
              {V.unreadNotifs > 99 ? '99+' : V.unreadNotifs}
            </span>
          ) : null}
        </button>
        <button className="dc6" onClick={V.toggleAi} title="Help — ask CLOZR" style={{display: V.isMobile ? "none" : "grid", width: "34px", height: "34px", borderRadius: "9px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", color: "var(--muted, #52525b)", cursor: "pointer", placeItems: "center"}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>
        <div style={{position: "relative", flex: "none"}}>
          <button onClick={V.toggleAccountMenu} aria-haspopup="menu" aria-expanded={V.accountMenuOpen} title={`${who} · account and settings`} style={{width: "34px", height: "34px", borderRadius: "9px", border: "1px solid var(--divider, #e4e4e7)", background: "var(--mint-dim, #e7f8f1)", color: "var(--tx-mint, #0a8560)", fontWeight: "700", fontSize: "12px", cursor: "pointer", padding: "0", overflow: "hidden", display: "grid", placeItems: "center"}}>
            <UserAvatar name={who} src={avatarOf(session.profile?.avatar_url, session.user?.user_metadata)} size={32} radius="8px" />
          </button>
          {V.accountMenuOpen ? <AccountMenu V={V} className="cz-menu cz-menu--right" style={{top: "40px", width: "240px"}} /> : null}
        </div>
      </header>
      <NewLeadsBar />
      <main ref={mainRef} inert={V.isMobile && V.phoneUp ? true : undefined} style={{flex: "1", minHeight: "0", minWidth: "0", display: "flex", position: "relative", overflowX: "clip"}}>
        <ScreenBoundary screen={V.screen} label={V.screenLabel} onHome={V.goHome}>
        <Suspense fallback={<ScreenLoading />}>
        {V.isToday ? <Today V={V} /> : null}
        {(V.isHome) ? (
          <>
          <Home V={V} />
          </>
        ) : null}
        {(V.isPeople) ? (
          <>
          <People V={V} />
          </>
        ) : null}
        {(V.isPerson) ? (
          <>
          {V.recordPicked.person ? <SellerRecord V={V} /> : V.recordLoading ? <PickRecord title="Opening the record…" hint="It is coming back from the archive. This takes a moment." action={V.recordBack.go} actionLabel={`Back to ${V.recordBack.label}`} /> : <PickRecord title="Pick a seller" hint={`Open a record from ${V.recordBack.label} to see it here.`} action={V.recordBack.go} actionLabel={`Open ${V.recordBack.label}`} />}
          </>
        ) : null}
        {(V.isDeals) ? (
          <>
          <Deals V={V} />
          </>
        ) : null}
        {V.isContracts ? <ContractsHub V={V} /> : null}
        {(V.isDispo) ? (
          <>
          <Dispo V={V} />
          </>
        ) : null}
        {(V.isDispoProperty) ? (
          <>
          {V.recordPicked.dispo ? <DispoProperty V={V} /> : <PickRecord title="Pick a property" hint="Open a property from the Dispo list to market it, match buyers or run Buyr." action={V.goDispo} actionLabel="Open Dispo" />}
          </>
        ) : null}
        {(V.isBuyers) ? (
          <>
          <Buyers V={V} />
          </>
        ) : null}
        {(V.isBuyer) ? (
          <>
          {V.recordPicked.buyer ? <BuyerRecord V={V} /> : <PickRecord title="Pick a buyer" hint="Open a buyer from the Buyers list to see their buy box and activity." action={V.goBuyers} actionLabel="Open Buyers" />}
          </>
        ) : null}
        {V.isVendor ? <VendorRecord V={V} /> : null}
        {(V.isTc) ? (
          <>
          {V.recordPicked.tc ? <TransactionCoordination V={V} /> : <PickRecord title="Pick a deal" hint="Open a deal under contract to work its transaction file." action={V.openTcList} actionLabel="Open the first closing file" />}
          </>
        ) : null}
        {(V.isDealSheet) ? (
          <>
          {(V.recordPicked.person || V.dealSheetFor.dealId != null) ? <DealSheet V={V} /> : <PickRecord title="Pick a seller" hint={`The deal sheet edits the seller in view. Open a record from ${V.recordBack.label} first.`} action={V.recordBack.go} actionLabel={`Open ${V.recordBack.label}`} />}
          </>
        ) : null}
        {(V.isImport) ? (
          <>
          <Import V={V} />
          </>
        ) : null}
        {(V.isInbox) ? (
          <>
          <Inbox V={V} />
          </>
        ) : null}
        {(V.isDialer) ? (
          <>
          <Dialer V={V} />
          </>
        ) : null}
        {(V.isTasks) ? (
          <>
          <Tasks V={V} />
          </>
        ) : null}
        {(V.isCalendar) ? (
          <>
          <Calendar V={V} />
          </>
        ) : null}
        {(V.isReporting) ? (
          <>
          <Reporting V={V} />
          </>
        ) : null}
        {/* Account is Settings › You › Account (/app/settings/you/account). */}
        {(V.isSettings || V.isAccount) ? (
          <>
          <Settings isMobile={V.isMobile} section={V.settingsSection} onSection={V.openSettingsSection} blacklist={V.secretList} openPerson={V.openPerson} openBuyer={V.openBuyerRecord} onImported={V.reloadCrm} onViewAs={V.goHome} onToast={V.showToast} talkrAuthed={V.talkrAuthed} newDesign={V.newDesign} onNewDesign={V.setNewDesign} recording={V} />
          </>
        ) : null}
        {(V.isLeaderboard) ? (
          <>
          <SalesLeaderboard V={V} />
          </>
        ) : null}
        {V.isCoaching ? <Coaching V={V} /> : null}
        {(V.isPlans) ? (
          <>
          <ActionPlans V={V} />
          </>
        ) : null}
        {(V.isAutomations) ? (
          <>
          <Automations V={V} />
          </>
        ) : null}
        {V.isCampaigns ? <Campaigns V={V} /> : null}
        {(V.isDealMachine) ? (
          <>
          <DealMachine V={V} />
          </>
        ) : null}
        <ScreenEnter screen={V.screen} host={mainRef} />
        </Suspense>
        {children}
        </ScreenBoundary>
      </main>
      <CallBar V={V} />
      </div>
      {/* No floating buttons over the screens: they covered row actions and
          names. On a desk Ask CLOZR and the dialer live in the side menu's
          foot; on a phone the dialer is in the top bar, and the theme switch
          is in the account menu on both. */}
      {/* A phone has one phone: the full-screen PhoneScreen, which also rings
          and carries the call; the desk keeps the banner and the slide-out. */}
      {V.isMobile ? (
        <>
        <PhoneScreen V={V} />
        <PhoneCallPill V={V} />
        </>
      ) : (
        <>
        <DialerIncoming V={V} />
        {(V.dialerOpen && !V.isDialer && !V.todayHidesDialer) ? (
          <DialerPanel V={V} />
        ) : null}
        </>
      )}
      {(V.notifOpen) ? (
        <>
        <Drawer label="Notifications" mobile={V.isMobile} onClose={V.toggleNotif}
          title="Notifications" meta={`${V.unreadNotifs} unread`}
          actions={<Button size={28} data-testid="notif-mark-all" onClick={() => { notifList.current?.leave((V.notifs || []).map((n) => n.id)); V.markAllRead(); }}>Clear all</Button>}>
          <div style={{display: "flex", flexWrap: "wrap", gap: "4px", padding: "8px 14px", borderBottom: "1px solid var(--divider-2, #f0f0f1)"}}>
            {(V.notifCatFilter || []).map((c, c__i) => (
              <React.Fragment key={c__i}>
              <button className="dc2" onClick={c.go} style={{height: "24px", padding: "0 7px", borderRadius: "6px", border: "0", fontSize: "11.5px", fontWeight: c.on ? "600" : "500", background: c.bg, color: c.color, cursor: "pointer", whiteSpace: "nowrap"}}>
                {c.c}
              </button>
              </React.Fragment>
            ))}
          </div>
          {/* What Mute has quieted, until when, and the way back. */}
          {(V.notifMutes || []).map((m) => (
            <div key={m.cat} role="status" data-testid="notif-muted" style={{display: "flex", alignItems: "center", gap: "6px", padding: "6px 14px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", background: "var(--canvas, #fafafa)", fontSize: "12px", color: "var(--muted, #52525b)"}}>
              <span>Muted: {m.label} (until {m.until})</span>
              <span aria-hidden>·</span>
              <button type="button" onClick={m.unmute} style={{background: "none", border: "0", padding: "0", color: "var(--tx-mint, #0a8560)", fontSize: "12px", fontWeight: "600", cursor: "pointer"}}>
                Unmute
              </button>
            </div>
          ))}
          <div style={{flex: "1", overflow: "auto"}}>
            <NotifList ref={notifList} items={V.notifs || []} onDismiss={V.dismissNotifs} />
          </div>
        </Drawer>
        </>
      ) : null}
      {(V.aiOpen) ? (
        <>
        <Drawer label="Ask CLOZR" mobile={V.isMobile} layer={1} onClose={V.toggleAi}
          icon={<ClozrAppIcon size={22} />} title="Ask CLOZR" meta="answers with records and actions">
          <div style={{flex: "1", overflow: "auto", padding: "14px"}}>
            {(V.hasAiAnswer) ? (
              <>
              <div style={{fontSize: "12.5px", color: "var(--meta, #71717a)", padding: "8px 12px", background: "var(--surface-2, #f4f4f5)", borderRadius: "9px", display: "inline-block", maxWidth: "100%"}}>
                {V.aiAnswer!.q}
              </div>
              <div data-testid="ask-answer" style={{marginTop: "12px", fontSize: "13.5px", lineHeight: "1.55", color: "var(--ink, #18181b)", animation: "clozrFade .2s", overflowWrap: "anywhere"}}>
                <Markdown text={V.aiAnswer!.text} />
              </div>
              {(V.aiAnswer!.hasCards) ? (
                <>
                <div style={{marginTop: "12px", display: "flex", flexDirection: "column", gap: "6px"}}>
                  {(V.aiAnswer!.cards || []).map((c, c__i) => (
                    <React.Fragment key={c__i}>
                    <button className="dc37" onClick={c.go} style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", width: "100%", textAlign: "left", padding: "10px 12px", border: "1px solid var(--c-btn-line)", borderRadius: "10px", background: "var(--c-btn-bg)", cursor: "pointer"}}>
                      <span>
                        <span style={{display: "block", fontWeight: "600", fontSize: "13px", color: "var(--ink, #18181b)"}}>
                          {c.t}
                        </span>
                        <span style={{display: "block", fontSize: "12px", color: "var(--meta, #71717a)"}}>
                          {c.s}
                        </span>
                      </span>
                      <span style={{color: "var(--meta, #71717a)", display: "inline-flex"}}>
                        <ChevronRightIcon />
                      </span>
                    </button>
                    </React.Fragment>
                  ))}
                </div>
                </>
              ) : null}
              {(V.aiAnswer!.hasCta) ? (
                <>
                <Button kind="solid" onClick={V.aiAnswer!.ctaGo} style={{marginTop: "12px"}}>
                  {V.aiAnswer!.cta}
                </Button>
                </>
              ) : null}
              {V.aiExamples.length ? (
              <div style={{marginTop: "18px", fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "500"}}>
                Ask something else
              </div>
              ) : null}
              </>
            ) : null}
            {(V.noAiAnswer) ? (
              <>
              <div style={{fontSize: "13px", color: "var(--muted, #52525b)", lineHeight: "1.5"}}>
                {V.isLiveData
                  ? 'Ask about your sellers, buyers, deals and tasks. Answers are read from this workspace\'s records and come back as rows you can open. For one transaction file — title, earnest money, the HUD — ask Lane (L).'
                  : 'Ask about sellers, buyers, deals, comps or reps. Answers come back as CRM records you can act on.'}
              </div>
              {V.aiExamples.length ? (
              <div style={{marginTop: "14px", fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "500"}}>
                Try
              </div>
              ) : null}
              </>
            ) : null}
            <div style={{display: "flex", flexDirection: "column", gap: "4px", marginTop: "8px"}}>
              {(V.aiExamples || []).map((e, e__i) => (
                <React.Fragment key={e__i}>
                <button className="dc38" onClick={e.go} style={{textAlign: "left", padding: "8px 10px", border: "1px solid var(--c-btn-line)", borderRadius: "8px", background: "var(--c-btn-bg)", fontSize: "12.5px", color: "var(--ink-2, #27272a)", cursor: "pointer", lineHeight: "1.4"}}>
                  {e.q}
                </button>
                </React.Fragment>
              ))}
            </div>
          </div>
          <div style={{padding: "10px 14px 14px", borderTop: "1px solid var(--divider, #e4e4e7)"}}>
            <div style={{display: "flex", gap: "6px"}}>
              <input className="dc17" aria-label="Ask CLOZR" value={V.aiQ} onChange={V.setAiQ} onKeyDown={V.aiKey} placeholder="Ask CLOZR…" style={{flex: "1", height: "38px", padding: "0 12px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "10px", fontSize: "13px", outline: "0", background: "var(--canvas, #fafafa)"}} />
              <Button kind="primary" onClick={V.askAi} style={{height: "38px"}}>
                Ask
              </Button>
            </div>
          </div>
        </Drawer>
        </>
      ) : null}
      {(V.laneOpen) ? (
        <>
        <Drawer label="Lane" mobile={V.isMobile} layer={1} onClose={() => { closeResources(); V.closeLane(); }} closeLabel="Close Lane"
          icon={<span style={{display: "inline-flex", color: "var(--c-lane)"}}><Mark label="Lane" size={16} /></span>} title="Lane"
          meta={V.laneList ? 'your chats' : V.laneReading.title}
          actions={<>
            <button className={buttonClass('ghost', 28, 'lr-head-btn')} aria-label="Resources" aria-pressed={resPanel.open} onClick={toggleResources} title="Team resources: TC Bible, scripts, checklists, templates" style={V.isMobile ? {width: "28px", padding: 0} : undefined}>
              <ResIcon d={RESOURCES_ICON} size={13} />
              {V.isMobile ? null : <span>Resources</span>}
            </button>
            {V.laneList ? (
              V.laneHasThread || V.laneReading.filed ? <Button size={28} onClick={() => { closeResources(); V.laneHideList(); }}>Back</Button> : null
            ) : (
              <Button size={28} onClick={() => { closeResources(); V.laneShowList(); }} title="All your Lane chats">Chats</Button>
            )}
            <Button size={28} onClick={() => { closeResources(); V.laneNewChat(); }} title="Start a new chat" icon={<Plus size={13} aria-hidden />}>New</Button>
          </>}>
          {resPanel.open ? (
            <LaneResources ws={V.resourcesWs} canAdd={V.resourcesCanAdd} admin={V.resourcesAdmin} />
          ) : (
          <>
          {!V.laneList ? (
          <div style={{padding: "8px 14px", borderBottom: "1px solid var(--divider-2, #f0f0f1)", background: "var(--canvas, #fafafa)", fontSize: "11px", color: "var(--meta, #71717a)", lineHeight: "1.45"}}>
            {V.laneReading.filed ? (
              <>
              {V.laneReading.canOpen
                ? <button onClick={V.laneReading.open} title="Open the record" style={{padding: 0, border: 0, background: "none", color: "var(--c-link)", fontWeight: 600, fontSize: "11.5px", cursor: "pointer"}}>{V.laneReading.addr}</button>
                : <span style={{color: "var(--muted, #52525b)", fontWeight: 600}}>{V.laneReading.addr}</span>}
              {V.laneReading.line ? ` · ${V.laneReading.line}` : ''}
              </>
            ) : V.laneReading.line}
          </div>
          ) : null}
          {V.laneList ? (
          <div style={{flex: "1", overflow: "auto", padding: "10px"}}>
            <button className="clozr-lane-ghost" onClick={V.laneNewChat} style={{width: "100%", textAlign: "left", padding: "10px 12px", border: "1px dashed var(--line, #d4d4d8)", borderRadius: "9px", background: "var(--surface, #fff)", fontSize: "12.5px", color: "var(--ink, #18181b)", fontWeight: 600, cursor: "pointer", marginBottom: "8px"}}>
              + New chat
            </button>
            {!V.laneHasChats ? (
              <div style={{fontSize: "12.5px", color: "var(--meta, #71717a)", lineHeight: "1.5", padding: "6px 4px"}}>
                No chats yet. Start one and ask about any property — Lane finds the record and keeps a chat for each property.
              </div>
            ) : null}
            {(V.laneChatRows || []).map((c) => (
              <div key={c.id} role="button" tabIndex={0} onClick={c.go} onKeyDown={(e) => { if (e.key === 'Enter') c.go(); }} className="clozr-lane-ghost" style={{display: "flex", alignItems: "center", gap: "10px", padding: "9px 10px", borderRadius: "9px", border: `1px solid ${c.active ? 'var(--c-action-line, #a7dcc5)' : 'var(--divider-2, #f0f0f1)'}`, background: c.active ? 'var(--c-action-soft, #e7f5ef)' : 'var(--surface, #fff)', cursor: "pointer", marginBottom: "6px"}}>
                <span aria-hidden="true" style={{width: "7px", height: "7px", borderRadius: "999px", flex: "none", background: c.filed ? 'var(--c-lane)' : 'var(--line, #d4d4d8)'}}></span>
                <div style={{flex: "1", minWidth: "0"}}>
                  <div style={{fontSize: "12.5px", fontWeight: 600, color: "var(--ink, #18181b)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{c.title}</div>
                  <div style={{fontSize: "11px", color: "var(--meta, #71717a)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{c.sub} · {c.when}</div>
                </div>
                <button className="dc2" aria-label={`Delete ${c.title}`} title="Delete chat" onClick={c.remove} style={{width: "24px", height: "24px", borderRadius: "6px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", cursor: "pointer", color: "var(--meta, #71717a)", fontSize: "13px", lineHeight: "1", flex: "none", display: "grid", placeItems: "center"}}><CardIcon d={ICON_PATHS.x} size={13} /></button>
              </div>
            ))}
          </div>
          ) : (
          <div style={{flex: "1", overflow: "auto", padding: "14px"}}>
            {(V.laneEmpty) ? (
              <>
              <div style={{fontSize: "13px", color: "var(--muted, #52525b)", lineHeight: "1.5"}}>
                {V.laneReading.filed
                  ? <>This chat is about <b>{V.laneReading.addr}</b>. Lane reads its whole file — seller, deal, TC checklist, title, buyer, vendors and messages.</>
                  : <>Ask about any property by address, or a seller, buyer or vendor. Lane looks it up across the CRM and files this chat under that property, so each property keeps its own chat.</>}
              </div>
              <div style={{marginTop: "14px", fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "500"}}>
                Try
              </div>
              </>
            ) : null}
            {(V.laneThread || []).map((t, t__i) => (
              <React.Fragment key={t__i}>
              {(t.isTc) ? (
                <>
                <div style={{display: "flex", justifyContent: "flex-end", marginBottom: "10px"}}>
                  <span style={{fontSize: "12.5px", color: "var(--ink, #18181b)", padding: "8px 12px", background: "var(--surface-2, #f4f4f5)", borderRadius: "9px", maxWidth: "88%", lineHeight: "1.5"}}>
                    {t.text}
                  </span>
                </div>
                </>
              ) : null}
              {(t.isLane) ? (
                <>
                <div style={{marginBottom: "14px", animation: "clozrFade .2s"}}>
                  <div style={{fontSize: "13.5px", lineHeight: "1.55", color: "var(--ink, #18181b)", overflowWrap: "anywhere"}}>
                    <Markdown text={t.text} />
                  </div>
                  {(t.hasRefs) ? (
                    <>
                    <div style={{display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "9px"}}>
                      {(t.refs || []).map((r, r__i) => (
                        <React.Fragment key={r__i}>
                        {r.canGo ? (
                          <button className="clozr-lane-chip" onClick={r.go} title={r.isDoc ? `Open ${r.r} in Resources` : `Open ${r.r} on the file`} style={{display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: "600", padding: "3px 7px", border: "1px solid var(--c-btn-line)", borderRadius: "var(--r-badge)", color: "var(--ink-3, #3f3f46)", background: "var(--c-btn-bg)", cursor: "pointer"}}>
                            {r.isDoc ? <ResIcon d={RESOURCES_ICON} size={11} /> : null}
                            {r.r}
                          </button>
                        ) : (
                          <span style={{fontSize: "11px", fontWeight: "600", padding: "3px 7px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "6px", color: "var(--muted, #52525b)", background: "var(--canvas, #fafafa)"}}>
                            {r.r}
                          </span>
                        )}
                        </React.Fragment>
                      ))}
                    </div>
                    </>
                  ) : null}
                  {(t.hasCards) ? (
                    <div style={{display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px"}}>
                      {(t.cards || []).map((c) => (
                        <button key={c.id} className="dc2" onClick={c.go} title={c.subtitle} style={{display: "inline-flex", alignItems: "center", gap: "6px", maxWidth: "100%", height: "26px", padding: "0 9px", borderRadius: "7px", border: "1px solid var(--divider, #e4e4e7)", background: "var(--surface, #fff)", color: "var(--ink-2, #27272a)", fontSize: "11.5px", fontWeight: 600, cursor: "pointer"}}>
                          <CardIcon d={c.kind === 'buyer' ? ICON_PATHS.briefcase : ICON_PATHS.home} />
                          <span style={{overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{c.title}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {(t.hasActions) ? (
                    <div style={{display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px"}}>
                      {(t.actions || []).map((a) => (
                        <button key={a.id} className="dc2" onClick={a.go} title={a.title} style={{display: "inline-flex", alignItems: "center", gap: "6px", maxWidth: "100%", height: "28px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", color: "var(--ink, #18181b)", fontSize: "12px", fontWeight: "600", cursor: "pointer"}}>
                          <CardIcon d={a.kind === 'calendar' ? ICON_PATHS.calendar : ICON_PATHS.check} />
                          <span style={{overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{a.label}: {a.title} · {a.when}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {(t.hasDrafts) ? (
                    <div style={{display: "grid", gap: "8px", marginTop: "10px"}}>
                      {(t.drafts || []).map((d, d__i) => (
                        <div key={d__i} style={{border: "1px solid var(--divider, #e4e4e7)", borderRadius: "9px", padding: "10px 12px", background: "var(--canvas, #fafafa)"}}>
                          <div style={{display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap"}}>
                            <span style={{fontSize: "11.5px", fontWeight: "600", color: "var(--ink-3, #3f3f46)"}}>{d.channel}</span>
                            <span style={{fontSize: "12px", color: "var(--muted, #52525b)"}}>to {d.to}</span>
                            <div style={{flex: "1"}}></div>
                            <button className="dc2" onClick={d.copy} style={{height: "24px", padding: "0 8px", borderRadius: "6px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11px", fontWeight: "600", cursor: "pointer", color: "var(--ink, #18181b)"}}>Copy</button>
                            <button className="dc2" onClick={d.log} style={{height: "24px", padding: "0 8px", borderRadius: "6px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "11px", fontWeight: "600", cursor: "pointer", color: "var(--ink, #18181b)"}}>Log on file</button>
                            {d.canSend ? <button className="dc2" onClick={d.send} style={{height: "28px", padding: "0 10px", borderRadius: "var(--r-control)", border: "0", background: "var(--ink, #18181b)", fontSize: "12px", fontWeight: "600", cursor: "pointer", color: "var(--surface, #fff)"}}>{d.channel === 'sms' ? 'Text it' : 'Email it'}</button> : null}
                          </div>
                          {d.hasSubject ? <div style={{fontSize: "12px", fontWeight: "600", marginTop: "6px", color: "var(--ink, #18181b)"}}>{d.subject}</div> : null}
                          <div style={{fontSize: "12.5px", color: "var(--ink-2, #27272a)", marginTop: "4px", lineHeight: "1.45", whiteSpace: "pre-wrap"}}>{d.body}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                </>
              ) : null}
              </React.Fragment>
            ))}
            {(V.laneBusy) ? (
              <>
              <div style={{display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "12.5px", color: "var(--meta, #71717a)"}}>
                <span style={{width: "6px", height: "6px", borderRadius: "999px", background: "var(--c-lane)", animation: "clozrPulseLane 1.2s infinite"}}></span>
                Lane is looking through the records…
              </div>
              </>
            ) : null}
            {(V.laneHasThread) ? (
              <>
              <div style={{marginTop: "6px", fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "500"}}>
                Ask something else
              </div>
              </>
            ) : null}
            <div style={{display: "flex", flexDirection: "column", gap: "4px", marginTop: "8px"}}>
              {(V.lanePrompts || []).map((e, e__i) => (
                <React.Fragment key={e__i}>
                <button className="clozr-lane-ghost" onClick={e.go} style={{textAlign: "left", padding: "8px 10px", border: "1px solid var(--c-btn-line)", borderRadius: "8px", background: "var(--c-btn-bg)", fontSize: "12.5px", color: "var(--ink-2, #27272a)", cursor: "pointer", lineHeight: "1.4"}}>
                  {e.question}
                </button>
                </React.Fragment>
              ))}
            </div>
            {!V.isLiveData ? (
            <div style={{marginTop: "16px", paddingTop: "12px", borderTop: "1px solid var(--divider-2, #f0f0f1)", fontSize: "11px", color: "var(--meta, #71717a)", lineHeight: "1.5"}}>
              Sample workspace — Lane answers from canned guidance here. Signed in, it reads your real file on Claude.
            </div>
            ) : null}
          </div>
          )}
          {!V.laneList ? (
          <div style={{padding: "10px 14px 14px", borderTop: "1px solid var(--divider, #e4e4e7)"}}>
            <div style={{display: "flex", gap: "6px"}}>
              <input className="dc17" aria-label="Ask Lane" value={V.laneQ} onChange={V.setLaneQ} onKeyDown={V.laneKey} placeholder={V.laneReading.filed ? 'Ask Lane about this property…' : 'Ask about any address, seller, buyer or vendor…'} style={{flex: "1", height: "38px", padding: "0 12px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "10px", fontSize: "13px", outline: "0", background: "var(--canvas, #fafafa)"}} />
              <button className={buttonClass('primary')} onClick={V.askLane} style={{height: "38px", fontWeight: "600", cursor: "pointer"}}>
                Ask
              </button>
            </div>
          </div>
          ) : null}
          </>
          )}
        </Drawer>
        </>
      ) : null}
      {(V.addOpen) ? (
        <>
        <div onClick={V.closeAdd} style={{position: "fixed", inset: "0", background: "rgba(24,24,27,.35)", backdropFilter: "blur(3px)", zIndex: "var(--z-dialog)", display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "10vh"}}>
          <div data-screen-label="Create record" tabIndex={-1} onClick={V.stop} ref={(el) => { if (el && !el.contains(document.activeElement)) el.querySelector<HTMLInputElement>('input:not([type=hidden])')?.focus(); }} onKeyDown={(e) => { const t = e.target as HTMLElement; if (e.key !== 'Enter' || e.shiftKey || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON') return; if ([...document.querySelectorAll<HTMLElement>('.pac-container')].some((p) => p.offsetParent !== null && p.childElementCount > 0)) return; e.preventDefault(); flushAddInputs(); window.setTimeout(() => { if (viewRef.current.addCanSubmit) viewRef.current.submitAdd(); }, 0); }} style={{width: "560px", maxWidth: "calc(100% - 40px)", maxHeight: "80vh", outline: "0", background: "var(--surface, #fff)", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "14px", boxShadow: "var(--shadow-lg)", overflow: "hidden", display: "flex", flexDirection: "column", animation: "clozrPop .16s cubic-bezier(.23,1,.32,1)"}}>
            <div style={{display: "flex", alignItems: "center", gap: "10px", padding: "14px 16px", borderBottom: "1px solid var(--divider, #e4e4e7)", flex: "none"}}>
              <span style={{minWidth: "0"}}>
                <span style={{display: "block", fontWeight: "700", fontSize: "15px", letterSpacing: "-0.01em"}}>
                  {V.addTitle}
                </span>
                <span style={{display: "block", fontSize: "12px", color: "var(--meta, #71717a)", marginTop: "1px"}}>
                  {V.addSubtitle}
                </span>
              </span>
              <div style={{flex: "1"}}></div>
              <button className="dc2" onClick={V.closeAdd} style={{width: "28px", height: "28px", borderRadius: "7px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", cursor: "pointer", color: "var(--muted, #52525b)", fontSize: "16px", lineHeight: "1", flex: "none"}}>
                <XIcon />
              </button>
            </div>
            {V.addAsk ? (
              <div style={{padding: "14px 16px", overflow: "auto", flex: "1"}}><AddAsk V={V} /></div>
            ) : (
            <div style={{padding: "14px 16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", overflow: "auto", flex: "1"}}>
              {(V.addFields || []).map((f, f__i) => (
                <React.Fragment key={f__i}>
                <label style={{gridColumn: f.wide ? "1 / -1" : "auto", minWidth: "0"}}>
                  <span style={{display: "block", fontSize: "11.5px", color: "var(--meta, #71717a)", fontWeight: "500", marginBottom: "5px"}}>
                    {f.label}
                    {(f.req) ? (
                      <>
                      <span style={{color: "var(--tx-hot, #dc2626)", marginLeft: "3px"}}>
                        *
                      </span>
                      </>
                    ) : null}
                  </span>
                  {(f.isSelect && (f.options || []).length > 10) ? (
                    <SearchSelect value={f.value} options={f.options || []} placeholder={f.ph} ariaLabel={f.label} onChange={f.setValue} />
                  ) : (f.isSelect) ? (
                    <>
                    <select value={f.value} onChange={f.set} style={{width: "100%", height: "34px", padding: "0 8px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "8px", fontSize: "13px", outline: "0", background: "var(--canvas, #fafafa)", color: f.value ? "var(--ink, #18181b)" : "var(--meta, #71717a)", cursor: "pointer", fontFamily: "inherit"}}>
                      <option value="">
                        {f.ph}
                      </option>
                      {(f.options || []).map((o, o__i) => (
                        <React.Fragment key={o__i}>
                        <option value={o.v}>
                          {o.label}
                        </option>
                        </React.Fragment>
                      ))}
                    </select>
                    </>
                  ) : null}
                  {(f.mention) ? (
                    <MentionField team={V.mentionTeam} above={false} value={f.value} onChange={f.setValue} placeholder={f.ph + ' @ to mention'} rows={4} style={{width: "100%", padding: "8px 10px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "8px", fontSize: "13px", outline: "0", background: "var(--canvas, #fafafa)", color: "var(--ink, #18181b)", resize: "vertical", fontFamily: "inherit", lineHeight: "1.5"}} />
                  ) : null}
                  {(!f.isSelect && !f.mention) ? (
                    <>
                    <AddInput f={f} placesKey={V.placesKey} onPlace={V.fillAddAddress} style={{width: "100%", height: "34px", padding: "0 10px", border: "1px solid var(--divider, #e4e4e7)", borderRadius: "8px", fontSize: "13px", outline: "0", background: "var(--canvas, #fafafa)", color: "var(--ink, #18181b)"}} />
                    </>
                  ) : null}
                </label>
                </React.Fragment>
              ))}
            </div>
            )}
            <div style={{display: "flex", alignItems: "center", gap: "8px", padding: "12px 16px", borderTop: "1px solid var(--divider, #e4e4e7)", background: "var(--canvas, #fafafa)", flex: "none"}}>
              <span role={V.addError ? 'alert' : undefined} style={{fontSize: "11.5px", color: V.addError || V.addProblem ? "var(--tx-red, #b91c1c)" : "var(--meta, #71717a)"}}>
                {V.addError ? 'Not saved: ' + V.addError.replace(/[.\s]*$/, '.') + ' Everything you typed is still here.' : V.addProblem || (V.addAsk ? 'Nothing is saved until you choose.' : V.addOpen === 'buyer' ? 'Buyers need a phone number or an email. Someone at a company already on file can be added there as their own contact.' : 'Writes straight into the record graph — no page reload.')}
              </span>
              <div style={{flex: "1"}}></div>
              {(V.addCanClear && !V.addAsk) ? (
                <button type="button" onClick={V.clearAdd} title="Empties the form. Closing it keeps what you typed for next time." style={{height: "34px", padding: "0 6px", border: "0", background: "none", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", color: "var(--meta, #71717a)"}}>
                  Clear
                </button>
              ) : null}
              <button className="dc2" onClick={V.closeAdd} style={{height: "34px", padding: "0 14px", borderRadius: "9px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", color: "var(--ink, #18181b)"}}>
                Cancel
              </button>
              <button className="dc10" onPointerDown={flushAddInputs} onClick={V.submitAdd} disabled={!V.addCanSubmit} style={{height: "34px", padding: "0 14px", borderRadius: "9px", border: "1px solid", background: V.addCanSubmit ? "var(--ink, #18181b)" : "var(--line, #d4d4d8)", borderColor: V.addCanSubmit ? "var(--ink, #18181b)" : "var(--line, #d4d4d8)", color: "var(--surface, #fff)", fontSize: "12.5px", fontWeight: "600", cursor: V.addCanSubmit ? "pointer" : "not-allowed"}}>
                {V.addBusy || V.addSubmitLabel}
              </button>
            </div>
          </div>
        </div>
        </>
      ) : null}
      {(V.isMobile) ? (
        <>
        <nav data-screen-label="Mobile tabs" className="clozr-safe-bottom" inert={V.phoneUp ? true : undefined} style={{position: "fixed", left: "0", right: "0", bottom: "0", height: "calc(58px + env(safe-area-inset-bottom, 0px))", background: "var(--glass-strong, rgba(255,255,255,.94))", backdropFilter: "saturate(180%) blur(12px)", borderTop: "1px solid var(--divider, #e4e4e7)", display: V.phoneUp ? "none" : "flex", alignItems: "stretch", zIndex: "var(--z-tabbar)"}}>
          {(V.mobileTabs || []).map((t, t__i) => (
            <React.Fragment key={t__i}>
            <button onClick={t.go} aria-current={t.active ? "page" : undefined} style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "3px", border: "0", background: "none", cursor: "pointer", color: t.color, padding: "6px 0 8px"}}>
              <NavIcon name={t.icon} size={21} stroke={1.9} />
              <span style={{fontSize: "11px", fontWeight: t.weight, letterSpacing: "-0.01em"}}>
                {t.label}
              </span>
            </button>
            </React.Fragment>
          ))}
          <button onClick={V.toggleMore} style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "3px", border: "0", background: "none", cursor: "pointer", color: V.moreOpen ? "var(--tx-mint, #0a8560)" : "var(--meta, #71717a)", padding: "6px 0 8px"}}>
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5" cy="12" r="1.4" />
              <circle cx="12" cy="12" r="1.4" />
              <circle cx="19" cy="12" r="1.4" />
            </svg>
            <span style={{fontSize: "11px", fontWeight: V.moreOpen ? "600" : "500", letterSpacing: "-0.01em"}}>
              More
            </span>
          </button>
        </nav>
        </>
      ) : null}
      {(V.isMobile && V.moreOpen) ? (
        <>
        <div onClick={V.closeMore} style={{position: "fixed", inset: "0", background: "rgba(24,24,27,.35)", backdropFilter: "blur(3px)", zIndex: "calc(var(--z-sheet) - 1)"}}></div>
        <div role="dialog" aria-label="More" data-screen-label="More" className="clozr-safe-bottom cz-more" onClick={V.stop}>
          <div className="cz-more-head">
            <span className="cz-more-grip" aria-hidden="true" />
            <button type="button" className="cz-more-close" onClick={V.closeMore} aria-label="Close">
              <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="cz-more-scroll">
            {MORE_GROUPS.map((label) => {
              const rows = (V.moreItems || []).filter((m) => m.group === label);
              if (!rows.length) return null;
              return (
                <div key={label} role="group" aria-label={label} className="cz-more-group">
                  <span className="cz-more-label">{label}</span>
                  <div className="cz-more-grid">
                    {rows.map((m) => (
                      <button key={m.key} type="button" className="cz-more-row" onClick={m.go} aria-current={m.active ? 'page' : undefined}>
                        <span className="cz-more-icon" aria-hidden="true">
                          <NavIcon name={m.icon} size={16} />
                        </span>
                        <span className="cz-more-text">{m.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        </>
      ) : null}
      {/* The ⌘K command bar (the header's search button opens it too); on a phone it is the whole screen. */}
      {V.searchOpen && V.cmdData ? <CommandBar V={V} /> : null}
      <ContractsListPopup V={V} />
      <PhotoShow V={V} />
      <QuickReach V={V} />
      <MeetingInviteHost workspaceId={V.liveIds?.workspaceId ?? null} company={V.workspaceName} repName={who} isMobile={V.isMobile}
        canWrite={V.liveIds ? V.liveIds.canWrite : true} toast={V.showToast} />
      <FloorShow V={V} />
      <SectionGapPops V={V} />
      <DialerReadinessHost V={V} />
      <VoicemailRecorderHost workspaceId={V.floorWorkspaceId} userId={V.floorMe} />
      <ContractRequestHost V={V} />
      <ShellToast phone={V.isMobile} phoneUp={!!V.phoneUp} />
      {V.agentPick ? (
        <BulkAgentPanel kind="buyer" workspaceId={V.agentPick.workspaceId} canWrite={V.agentPick.canWrite}
          selectedIds={V.agentPick.selectedIds} records={V.agentPick.records} toast={V.agentPick.say}
          onClose={V.closeAgentPick} onDone={V.agentPickDone} />
      ) : null}
      <TaskEditSheet V={V} />
      {V.archiveAsk ? <ArchiveConfirm key={V.archiveAsk.kind + ':' + V.archiveAsk.ids.join(',')} ask={V.archiveAsk} onAnswer={V.answerArchive} /> : null}
      {session.user?.email && V.liveIds?.workspaceId ? <SignPrompt workspaceId={V.liveIds.workspaceId} email={session.user.email} /> : null}
    </div>
    </TalkrSoftphoneProvider>
  );
}

/** A record screen with nothing chosen. A live workspace never opens an arbitrary record in its place. */
function PickRecord(p: { title: string; hint: string; action: () => void; actionLabel: string }) {
  return (
    <section style={{ flex: '1', minWidth: '0', display: 'grid', placeItems: 'center' }}>
      <Empty {...p} />
    </section>
  );
}
