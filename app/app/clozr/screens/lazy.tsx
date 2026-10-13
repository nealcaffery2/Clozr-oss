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
 * The screens people open most, first, so the likely next click is already
 * cached. Everything else follows; each fetch waits for an idle slot so it
 * never competes with a click, a call or the first workspace read.
 */
const ORDER: Loader[] = [
  loaders.today, loaders.home, loaders.people, loaders.person, loaders.deals, loaders.inbox,
  loaders.tasks, loaders.calendar, loaders.dispo, loaders.dispoProperty, loaders.buyers,
  loaders.buyer, loaders.dialer, loaders.tc, loaders.dealSheet, loaders.reporting,
  loaders.leaderboard, loaders.coaching, loaders.plans, loaders.automations, loaders.settings,
  loaders.account, loaders.import, loaders.dealMachine, loaders.genius, loaders.buyr,
];

let preloading = false;

/** Warm every screen's chunk in the background, one at a time, in idle time. */
export function preloadScreens() {
  if (preloading || typeof window === 'undefined') return;
  preloading = true;
  // Respect a data-saver connection: screens still load when they are opened.
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const idle: (cb: () => void) => void =
    'requestIdleCallback' in window
      ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
      : (cb) => window.setTimeout(cb, 200);
  let i = 0;
  const next = () => {
    if (i >= ORDER.length) return;
    const loader = ORDER[i++];
    load(loader).then(() => idle(next), () => idle(next));
  };
  // Give the first screen and the workspace read a head start.
  window.setTimeout(() => idle(next), 1200);
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
