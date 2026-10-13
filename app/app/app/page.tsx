// CLOZR — the operating system for a real-estate acquisition company.
//
// One shell, every screen: Home, People, Seller record (+ the COMPR
// underwriting workspace), Talkr, Deals, Dispo, Buyer matching and profiles,
// Transaction coordination, Inbox, Tasks, Calendar, Reporting, the TV sales
// leaderboard, Automations, Account and Settings — plus ⌘K search, Quick Add
// (Q), notifications, the Ask CLOZR drawer and the floating dialer.
//
// This route is the real thing: it requires a session and renders the signed-in
// workspace loaded from Supabase. /demo is the same shell on the bundled sample
// graph, for anyone without an account.
'use client';

import '../clozr/tokens.css';
import '../clozr/clozr.css';
import '../clozr/chrome.css';
import '../clozr/surfaces.css';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useCrm } from '@/lib/use-crm';
import { isAdmin, canSeeBuyers, type Role } from '@/lib/team';
import { useViewAs } from '@/lib/view-as';
import { ViewAsBanner } from '@/components/ViewAs';
import { ReadOnlyContext, useReadOnlyWrites } from '@/lib/read-only-context';
import { READ_ONLY_MESSAGE, onReadOnlyRefusal } from '@/lib/read-only';
import { useSession } from '@/lib/session';
import { AppSkeleton } from '@/components/ds/Skeleton';
import { NoWorkspace } from '@/components/ds/NoWorkspace';
import { ClozrShell } from '../clozr/ClozrShell';
import { LiveLists } from '../clozr/LiveLists';
import { BuyerProfileModal } from '@/components/BuyerProfileModal';
import { useClozr } from '../clozr/useClozr';
import { nudgeGoogle, syncGoogle } from '@/lib/google';
import { PLACES_KEY } from '@/lib/integrations';

/**
 * When each workspace's Google connection was last run, as a timestamp.
 * Module scope on purpose: navigating between screens remounts this component,
 * and a sync per remount would be a sync per click.
 */
const syncedAt = new Map<number, number>();

/**
 * How stale the connection may get while the app sits open. The scheduled run
 * (pg_cron -> google-sync `sync_all`, migration 71) is the floor for everyone
 * whether or not anyone has CLOZR open; this is what keeps the tab actually
 * being looked at level with it.
 */
const SYNC_EVERY_MS = 5 * 60_000;

/**
 * Google's consent screen sends the browser back here with the result in the
 * query string, and this fires once per landing rather than once per render.
 */
let googleReturnHandled = false;

/**
 * Login, with this address as ?next=, so signing in lands back on the same
 * screen and record (login checks it is a CLOZR app address).
 */
const toLogin = () => '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);

export default function Page() {
  const s = useSession();
  const crm = useCrm();
  const router = useRouter();
  const realRole = (s.workspace?.role as Role | undefined) ?? null;
  // An owner or admin previewing a teammate: their role and their id, read-only.
  const viewAs = useViewAs();
  const previewing = !!viewAs && isAdmin(realRole) && viewAs.userId !== s.user?.id;
  const V = useClozr({
    live: crm.live,
    me: previewing ? viewAs!.userId : s.user?.id ?? null,
    readOnly: previewing,
    workspaceId: s.workspace?.id ?? null,
    crmOk: crm.ok,
    crmPartial: crm.partial,
    workspaceName: s.workspace?.name ?? null,
    role: previewing ? viewAs!.role : realRole,
    placesKey: crm.settings.places_key || PLACES_KEY || null,
    talkrUrl: crm.settings.talkr_url ?? null,
    // Read the way the offers function reads it: unset means draft.
    offerSend: crm.settings.offers?.send ?? false,
    // The board reads the workspace's zone, goals and exclusions, as the TV feed does.
    board: { tz: crm.settings.leaderboard_tz, exclude: crm.settings.leaderboard_exclude, goals: crm.settings.leaderboard_goals },
    reload: crm.reload,
    refreshSeller: crm.refreshSeller,
    refreshDeal: crm.refreshDeal,
    loadGallery: crm.loadGallery,
    patchLocal: crm.patchLocal,
    // The screen in the URL is restored against the real workspace and role,
    // so wait for both rather than check it against the sample graph.
    ready: s.ready && crm.ready,
  });

  // useClozr's own saves check canWrite, but the screens that save for
  // themselves (Settings, Account, the deal team, the composer, Deal Sheet…)
  // do not. So the preview also switches the Supabase and Talkr requests to
  // refuse writes (lib/read-only.ts), from the first frame until Exit, and
  // says so whenever one is refused, in case the caller claimed it saved.
  useReadOnlyWrites(previewing);
  const showToast = V.showToast;
  useEffect(() => {
    if (!previewing) return;
    return onReadOnlyRefusal(() => showToast(READ_ONLY_MESSAGE));
  }, [previewing, showToast]);

  // The guard only bites when Supabase is actually configured. Without
  // credentials there is nothing to sign in to, so the app stays open on mock
  // data rather than bouncing to a login it could never satisfy.
  const locked = !s.demo && s.ready && !s.session;
  useEffect(() => {
    if (locked) router.replace(toLogin());
  }, [locked, router]);

  // A recovery session must set a password before the pipeline. The old
  // callback sent people here with ?account=1, which the shell never read.
  useEffect(() => {
    if (!s.ready || !s.session) return;
    try {
      if (sessionStorage.getItem('clozr.recovery') === '1') router.replace('/login/reset');
    } catch { /* private mode */ }
  }, [s.ready, s.session, router]);

  // Two-factor: an account with a verified authenticator must pass it before
  // the workspace opens. The answer is keyed to the session it was asked for,
  // so a new sign-in is asked again and a stale answer never lets one through.
  const sessionKey = s.session?.access_token ?? null;
  const [mfa, setMfa] = useState<{ key: string | null; ok: boolean }>({ key: null, ok: false });
  useEffect(() => {
    if (!sessionKey) return;
    let live = true;
    void s.mfa.level().then((lvl) => {
      if (!live) return;
      if (lvl.stepUp) router.replace(toLogin());
      else setMfa({ key: sessionKey, ok: true });
    });
    return () => {
      live = false;
    };
  }, [sessionKey, s.mfa, router]);
  const mfaPending = !!sessionKey && !(mfa.key === sessionKey && mfa.ok);

  // Once the workspace is actually open, bring Google level with it: events
  // pushed, anything moved on Google's side pulled back, replies logged onto
  // records. Writes nudge it again as they happen.
  //
  // This used to run exactly once per page load, which is why the calendar
  // felt dead: a tab left open all afternoon never asked Google anything
  // again, so a meeting moved on a phone did not appear until someone
  // reloaded. `appointments` is in the realtime publication (migration 35),
  // so the grid redraws itself the moment a pull writes a row — it just had
  // to be asked. Re-run on a timer, and whenever this tab comes back to the
  // front, which is the moment somebody is about to look at the calendar.
  const workspaceId = s.workspace?.id ?? null;
  // Not during a View-as preview, which writes nothing (the sync writes); it
  // runs the moment the preview ends instead of being marked as done.
  const ready = s.ready && !locked && !mfaPending && crm.ready && !s.demo && !previewing;
  useEffect(() => {
    if (!ready || !workspaceId) return;
    const runIfStale = () => {
      const last = syncedAt.get(workspaceId) ?? 0;
      if (Date.now() - last < SYNC_EVERY_MS) return;
      syncedAt.set(workspaceId, Date.now());
      void syncGoogle(workspaceId, { calendarOnly: true, ifStale: true }).catch(() => null);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') runIfStale(); };
    runIfStale();
    // The tick is cheap and does nothing until the window above has passed.
    const timer = window.setInterval(runIfStale, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', runIfStale);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', runIfStale);
    };
  }, [ready, workspaceId]);

  // Back from Google. The callback redirects here with the answer instead of
  // rendering its own page — Supabase serves every edge function response as
  // text/plain, so a page from that host arrives as source code and a download
  // prompt. Saying it here means it can be styled, dismissed, and read on a
  // phone like anything else in the app.
  useEffect(() => {
    if (googleReturnHandled) return;
    const q = new URLSearchParams(window.location.search);
    const outcome = q.get('google');
    if (!outcome) return;
    googleReturnHandled = true;
    const ok = outcome === 'ok';
    const detail = q.get('m') ?? '';
    // Drop Google's query, keep the hash: the screen and record CLOZR was on.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);

    // Opened as a popup, which is what a desktop does: hand the result to the
    // window that started it and get out of the way.
    if (window.opener) {
      try { window.opener.postMessage({ source: 'clozr-google', ok, detail }, window.location.origin); } catch { /* opener is gone or elsewhere */ }
      window.close();
      return;
    }
    // A phone opens it as a tab instead, so this is the app now. Say it here,
    // and sync straight away rather than waiting for the next visit.
    window.setTimeout(() => V.showToast(ok ? (detail || 'Google connected.') : (detail || 'Google was not connected.')), 0);
    if (ok && workspaceId) nudgeGoogle(workspaceId);
  }, [V, workspaceId]);

  // A signed-out or mid-challenge session is on its way to login. Everything
  // else draws the shell immediately: the workspace read fills in as skeletons
  // instead of a blank page, and it never flashes the sample pipeline.
  if (locked || mfaPending || !s.ready) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#fafafa' }} />
    );
  }
  // Signed in, but no workspace to open: never invited, removed from the
  // team, or the membership read failed. Say which, instead of a skeleton
  // that never resolves.
  if (!s.demo && s.session && (s.memberships === 'none' || s.memberships === 'failed')) {
    return <NoWorkspace failed={s.memberships === 'failed'} email={s.user?.email ?? null} onRetry={s.retryMemberships} onSignOut={() => void s.signOut()} />;
  }
  if (!crm.ready) return <AppSkeleton />;

  return (
    <ReadOnlyContext.Provider value={previewing}>
      <ClozrShell V={V}>
        {previewing ? <ViewAsBanner who={viewAs!} onExit={V.goSettings} /> : null}
        {V.isLiveLists && (
          <LiveLists
            section={V.liveSection}
            onSection={V.setLiveSection}
            onToast={V.showToast}
            onChanged={V.reloadCrm}
            canSeeBuyers={canSeeBuyers(previewing ? viewAs!.role : realRole)}
          />
        )}
        <BuyerProfileModal
          open={!!V.buyerProfile}
          buyerId={V.buyerProfile?.buyerId ?? null}
          workspaceId={s.workspace?.id ?? null}
          userId={s.user?.id ?? null}
          onClose={V.closeBuyerProfile}
          onSaved={V.reloadCrm}
          onToast={V.showToast}
        />
      </ClozrShell>
    </ReadOnlyContext.Provider>
  );
}
