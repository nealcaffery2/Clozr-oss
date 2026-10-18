// Every screen, loaded on demand.
//
// The shell used to import all 26 screens up front, so /app shipped them in
// one 4 MB chunk (1.16 MB gzipped) that had to download and parse before the
// first row drew, including Genius maps, Import, Settings and the leaderboard
// that most sessions never open. Each screen is now its own chunk: the shell
// and the screen in view load first, and the rest are fetched while the
// browser is idle, so moving between screens is still instant from the
// second click on.
'use client';

import { lazy, type FunctionComponent } from 'react';
import { SkeletonRows } from '@/components/ds/Skeleton';
import { decodeNavHash } from '@/lib/nav-hash';
import { canSee, landingFor, type Role } from '@/lib/team';

type Loader = () => Promise<unknown>;

/** One loader per chunk, shared by the lazy component and the idle preload so a chunk is requested once. */
const loaders = {
  today: () => import('./Today'),
  home: () => import('./Home'),
  people: () => import('./People'),
  person: () => import('./SellerRecord'),
  deals: () => import('./Deals'),
  dispo: () => import('./Dispo'),
  dispoProperty: () => import('./DispoProperty'),
  buyers: () => import('./Buyers'),
  buyer: () => import('./BuyerRecord'),
  tc: () => import('./TransactionCoordination'),
  dealSheet: () => import('./DealSheet'),
  import: () => import('./Import'),
  inbox: () => import('./Inbox'),
  dialer: () => import('./Dialer'),
  tasks: () => import('./Tasks'),
  calendar: () => import('./Calendar'),
  reporting: () => import('./Reporting'),
  leaderboard: () => import('./SalesLeaderboard'),
  coaching: () => import('./Coaching'),
  account: () => import('./Account'),
  settings: () => import('./Settings'),
  plans: () => import('./ActionPlans'),
  automations: () => import('./Automations'),
  dealMachine: () => import('./DealMachine'),
  genius: () => import('./Genius'),
  buyr: () => import('./Buyr'),
} satisfies Record<string, Loader>;

const started = new Map<Loader, Promise<unknown>>();
function load<T>(loader: () => Promise<T>): Promise<T> {
  let p = started.get(loader);
  if (!p) {
    p = loader();
    // A failed fetch (offline, a deploy mid-session) may be retried on the next visit.
    p.catch(() => started.delete(loader));
    started.set(loader, p);
  }
  return p as Promise<T>;
}

/** A lazy component typed as the screen it stands for, so props are checked exactly as before. */
function screen<M, K extends keyof M>(loader: () => Promise<M>, name: K): M[K] {
  return lazy(() => load(loader).then((m) => ({ default: m[name] as FunctionComponent<object> }))) as M[K];
}

export const Today = screen(loaders.today, 'Today');
export const Home = screen(loaders.home, 'Home');
export const People = screen(loaders.people, 'People');
export const SellerRecord = screen(loaders.person, 'SellerRecord');
export const Deals = screen(loaders.deals, 'Deals');
export const Dispo = screen(loaders.dispo, 'Dispo');
export const DispoProperty = screen(loaders.dispoProperty, 'DispoProperty');
export const Buyers = screen(loaders.buyers, 'Buyers');
export const BuyerRecord = screen(loaders.buyer, 'BuyerRecord');
export const TransactionCoordination = screen(loaders.tc, 'TransactionCoordination');
export const DealSheet = screen(loaders.dealSheet, 'DealSheet');
export const Import = screen(loaders.import, 'Import');
export const Inbox = screen(loaders.inbox, 'Inbox');
export const Dialer = screen(loaders.dialer, 'Dialer');
export const Tasks = screen(loaders.tasks, 'Tasks');
export const Calendar = screen(loaders.calendar, 'Calendar');
export const Reporting = screen(loaders.reporting, 'Reporting');
export const SalesLeaderboard = screen(loaders.leaderboard, 'SalesLeaderboard');
export const Coaching = screen(loaders.coaching, 'Coaching');
export const Account = screen(loaders.account, 'Account');
export const Settings = screen(loaders.settings, 'Settings');
export const ActionPlans = screen(loaders.plans, 'ActionPlans');
export const Automations = screen(loaders.automations, 'Automations');
export const DealMachine = screen(loaders.dealMachine, 'DealMachine');
export const Genius = screen(loaders.genius, 'Genius');
export const Buyr = screen(loaders.buyr, 'Buyr');

/**
 * After the first screen and the workspace are up: the screen in view (its
 * chunk is already on the way) and the few screens most sessions open next.
 * Everything else loads when it is first opened. Warming all 26 screens used
 * to fire 150 chunk requests (6 MB) at startup, ahead of the first workspace
 * read, for screens most sessions never visit.
 */
const NEXT: (keyof typeof loaders)[] = ['people', 'person', 'deals'];

const warmed = new Set<string>();

/** Warm the current screen's chunk and the most-used ones, in idle time, once each. */
export function preloadScreens(current: string) {
  if (typeof window === 'undefined') return;
  // Respect a data-saver connection: screens still load when they are opened.
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const idle: (cb: () => void) => void =
    'requestIdleCallback' in window
      ? (cb) => window.requestIdleCallback(cb, { timeout: 3000 })
      : (cb) => window.setTimeout(cb, 300);
  const queue = [current, ...NEXT].filter((k): k is keyof typeof loaders => k in loaders && !warmed.has(k));
  const next = () => {
    const k = queue.shift();
    if (!k) return;
    warmed.add(k);
    load(loaders[k] as Loader).then(() => idle(next), () => idle(next));
  };
  idle(next);
}

/**
 * The chunk of the screen /app opens on, decided as useClozr's restore
 * decides it: the screen the address names when this role may see it, else
 * the role's landing. With no role yet, the address's screen alone. Null when
 * there is nothing to load: no role and no address, or a screen with no chunk
 * of its own (Contracts).
 */
export function bootScreen(hash: string, role: Role | null | undefined): keyof typeof loaders | null {
  const want = decodeNavHash(hash)?.screen;
  if (want && (!role || canSee(role, want))) return Object.prototype.hasOwnProperty.call(loaders, want) ? want as keyof typeof loaders : null;
  return role ? landingFor(role) : null;
}

/**
 * Start the first screen's chunk now, alongside the session and workspace
 * reads. The shell mounts only once the workspace is in, so its screen's chunk
 * used to start only then.
 */
export function preloadBootScreen(role: Role | null | undefined) {
  const k = bootScreen(window.location.hash, role);
  if (k) void load(loaders[k] as Loader);
}

/** What a screen shows for the moment its chunk is still on the way. */
export function ScreenLoading() {
  return (
    <div className="clozr-screen-loading" style={{ flex: 1, minWidth: 0, padding: '16px' }}>
      <span className="clozr-skel-line clozr-skel-line-lg" style={{ marginBottom: '14px' }} />
      <SkeletonRows count={6} label="Opening screen" />
    </div>
  );
}
