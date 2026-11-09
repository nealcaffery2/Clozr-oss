// The app's places, defined once.
//
// Every surface that lists where you can go reads this table: the desk's side
// nav (rows, Tools and its foot), the account menu, the phone's bottom tabs
// and More sheet, the ⌘K command bar, the screen titles (document.title, the
// Back links) and which nav row lights for the screen on view. One label per
// place, everywhere; one icon per place (lib/nav-icons.ts). Which places a
// role sees is still lib/team.ts canSee, passed in as `can`, so this stays
// pure and testable (`npx tsx tools/nav-model.test.ts`).

import type { Mark } from './command';
import type { NavIconKey } from './nav-icons';

export type NavGroup = 'Daily' | 'Pipeline' | 'Team' | 'Tools' | 'You';
/** Group order on the desk and in the More sheet. */
export const NAV_GROUPS: readonly NavGroup[] = ['Daily', 'Pipeline', 'Team', 'Tools', 'You'];

/**
 * Where a place sits on the desk: a row in its group, a row under Tools, the
 * foot of the side nav (under the scrolling list), or the account menu.
 */
export type DeskSpot = 'row' | 'tool' | 'foot' | 'menu';

export type Place = {
  /** The shell's screen key ('genius', 'liveLists'), or a panel's ('compr', 'lane', 'askClozr'). */
  key: string;
  /** The one name: nav row, tab, More row, ⌘K, the screen's title and document.title. */
  label: string;
  group: NavGroup;
  icon: NavIconKey;
  /** A screen has an address; a panel opens beside the screen you are on. */
  kind: 'screen' | 'panel';
  desk: DeskSpot;
  /** A Compr workspace sells Compr: no seller pipeline and none of the wholesaling tools. */
  comprHidden?: boolean;
  /** The command bar: words that find it, the line under it, its mark. Panels are not offered there. */
  say: string[];
  hint: string;
  mark: Mark;
  /** A place shown elsewhere lights this one instead when it has no row of its own (Account lights Settings on the desk). */
  lights?: string[];
};

const place = (p: Omit<Place, 'say' | 'hint' | 'mark'> & Partial<Pick<Place, 'say' | 'hint' | 'mark'>>): Place =>
  ({ say: [], hint: '', mark: 'neutral', ...p });

export const PLACES: readonly Place[] = [
  // Daily: Today and Home swap so the role's landing comes first (deskNav).
  place({ key: 'today', label: 'Today', group: 'Daily', icon: 'today', kind: 'screen', desk: 'row', comprHidden: true, say: ['today', 'call list', 'queue'], hint: 'Your list to call' }),
  place({ key: 'home', label: 'Home', group: 'Daily', icon: 'home', kind: 'screen', desk: 'row', say: ['home', 'dashboard'], hint: 'Priority queue, inbound, closings' }),
  place({ key: 'people', label: 'People', group: 'Daily', icon: 'people', kind: 'screen', desk: 'row', comprHidden: true, say: ['people', 'sellers', 'leads', 'contacts'], hint: 'Smart lists and the record table' }),
  place({ key: 'inbox', label: 'Inbox', group: 'Daily', icon: 'inbox', kind: 'screen', desk: 'row', say: ['inbox', 'messages', 'threads'], hint: 'Texts and email, one place' }),
  place({ key: 'dialer', label: 'Dialer', group: 'Daily', icon: 'dialer', kind: 'screen', desk: 'row', say: ['dialer', 'phone', 'talkr', 'calls'], hint: 'Queue, recents, voicemail', mark: 'talkr' }),
  place({ key: 'tasks', label: 'Tasks', group: 'Daily', icon: 'tasks', kind: 'screen', desk: 'row', say: ['tasks', 'todos', 'to do'], hint: 'Today, upcoming, overdue' }),
  place({ key: 'calendar', label: 'Calendar', group: 'Daily', icon: 'calendar', kind: 'screen', desk: 'row', say: ['calendar', 'appointments', 'schedule'], hint: 'The week' }),

  place({ key: 'deals', label: 'Deals', group: 'Pipeline', icon: 'deals', kind: 'screen', desk: 'row', comprHidden: true, say: ['deals', 'pipeline'], hint: 'The pipeline' }),
  place({ key: 'contracts', label: 'Contracts', group: 'Pipeline', icon: 'contracts', kind: 'screen', desk: 'row', comprHidden: true, say: ['contracts', 'contract', 'psa', 'agreements', 'documents'], hint: 'Purchase and assignment agreements' }),
  place({ key: 'dispo', label: 'Dispo', group: 'Pipeline', icon: 'dispo', kind: 'screen', desk: 'row', comprHidden: true, say: ['dispo', 'dispositions', 'inventory'], hint: 'Inventory to market' }),
  place({ key: 'buyers', label: 'Buyers', group: 'Pipeline', icon: 'buyers', kind: 'screen', desk: 'row', say: ['buyers', 'cash buyers'], hint: 'The buyer database', mark: 'genius' }),
  place({ key: 'plans', label: 'Action plans', group: 'Pipeline', icon: 'plans', kind: 'screen', desk: 'row', say: ['action plans', 'plans', 'drips'], hint: 'Follow-up plans' }),

  place({ key: 'reporting', label: 'Reporting', group: 'Team', icon: 'reporting', kind: 'screen', desk: 'row', say: ['reporting', 'reports', 'report', 'kpis', 'stats'], hint: 'Executive overview' }),
  place({ key: 'coaching', label: 'Coaching', group: 'Team', icon: 'coaching', kind: 'screen', desk: 'row', say: ['coaching', 'coach', 'scorecard', 'roleplay', 'graded calls'], hint: 'Graded calls, scorecard and roleplay' }),
  place({ key: 'leaderboard', label: 'Leaderboard', group: 'Team', icon: 'leaderboard', kind: 'screen', desk: 'row', say: ['leaderboard', 'sales leaderboard', 'tv', 'scoreboard'], hint: 'The office TV board' }),

  place({ key: 'compr', label: 'COMPR', group: 'Tools', icon: 'compr', kind: 'panel', desk: 'tool' }),
  place({ key: 'lane', label: 'Lane', group: 'Tools', icon: 'lane', kind: 'panel', desk: 'tool', comprHidden: true }),
  place({ key: 'campaigns', label: 'Campaigns', group: 'Tools', icon: 'campaigns', kind: 'screen', desk: 'tool', say: ['campaigns', 'bulk sms', 'bulk texts', 'blast'], hint: 'Bulk texts to a list, on a schedule' }),
  place({ key: 'dealMachine', label: 'Deal Machine', group: 'Tools', icon: 'dealMachine', kind: 'screen', desk: 'tool', comprHidden: true, say: ['deal machine', 'scraper'], hint: 'The scraper: run, pause, its log and finds', mark: 'dealMachine' }),
  place({ key: 'liveLists', label: 'Live database', group: 'Tools', icon: 'liveLists', kind: 'screen', desk: 'tool', say: ['live database', 'database', 'vendors', 'lists'], hint: 'Buyers, vendors and sellers' }),
  place({ key: 'import', label: 'Import', group: 'Tools', icon: 'import', kind: 'screen', desk: 'tool', say: ['import', 'upload', 'csv'], hint: 'Sellers, buyers or vendors from a file' }),
  place({ key: 'automations', label: 'Automations', group: 'Tools', icon: 'automations', kind: 'screen', desk: 'tool', say: ['automations', 'sequences', 'triggers'], hint: 'One action plan drawn as a flow' }),

  place({ key: 'settings', label: 'Settings', group: 'You', icon: 'settings', kind: 'screen', desk: 'foot', say: ['settings', 'preferences'], hint: 'Workspace and your own' }),
  place({ key: 'account', label: 'Account', group: 'You', icon: 'account', kind: 'screen', desk: 'menu', say: ['account', 'profile'], hint: 'Your profile and sign-in', lights: ['settings'] }),
  place({ key: 'askClozr', label: 'Ask CLOZR', group: 'You', icon: 'askClozr', kind: 'panel', desk: 'foot' }),
];

/**
 * Screens that are not places of their own: records and the screens under
 * them. Each lights the first of `lights` the surface shows (the seller
 * record lights People, or Deals for a role with no People).
 */
export type SubScreen = { key: string; label: string; lights: string[]; say?: string[]; hint?: string; mark?: Mark };
export const SUB_SCREENS: readonly SubScreen[] = [
  { key: 'person', label: 'Seller', lights: ['people', 'deals'] },
  { key: 'vendor', label: 'Vendor', lights: ['people', 'liveLists'] },
  { key: 'buyer', label: 'Buyer', lights: ['buyers'] },
  { key: 'dealSheet', label: 'Deal sheet', lights: ['deals'] },
  { key: 'dispoProperty', label: 'Dispo property', lights: ['dispo', 'deals'] },
  // The closing files; the command bar offers it as a place of its own.
  { key: 'tc', label: 'Transaction coordination', lights: ['deals'], say: ['tc', 'transaction', 'closing file', 'title file'], hint: 'The closing files, furthest along first' },
];

const BY_KEY: ReadonlyMap<string, Place | SubScreen> = new Map<string, Place | SubScreen>([
  ...PLACES.map((p) => [p.key, p] as const),
  ...SUB_SCREENS.map((s) => [s.key, s] as const),
]);

export const placeOf = (key: string): Place | undefined => PLACES.find((p) => p.key === key);

/** What a screen is called, everywhere it is named. */
export const SCREEN_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  [...BY_KEY].filter(([k]) => placeOf(k)?.kind !== 'panel').map(([k, v]) => [k, v.label]),
);

/**
 * The row that lights for a screen on a surface showing `shown`: the screen's
 * own row when it has one there, else the first of its `lights` that does.
 * Null when nothing on that surface stands for it.
 */
export function litKey(screen: string, shown: readonly string[]): string | null {
  const def = BY_KEY.get(screen);
  const chain = [screen, ...((def && 'lights' in def ? def.lights : undefined) ?? [])];
  return chain.find((k) => shown.includes(k)) ?? null;
}

/** Who is looking: what they may open (lib/team canSee), where they land, and the workspace kind. */
export type NavContext = {
  can: (screen: string) => boolean;
  /** lib/team landingFor(role). */
  landing: string;
  /** A Compr workspace (it sells Compr to its signups). */
  compr: boolean;
  /** Buyers is their main list (an SDR, or a Compr workspace). */
  buyersFirst: boolean;
};

/** The places this role sees in this workspace. Panels are on for everyone a Compr workspace does not hide. */
export function visiblePlaces(ctx: NavContext): Place[] {
  return PLACES.filter((p) => (p.kind === 'panel' || ctx.can(p.key)) && !(ctx.compr && p.comprHidden));
}

/** Today and Home, landing first. */
function landingFirst(places: Place[], landing: string): Place[] {
  const i = places.findIndex((p) => p.key === 'today');
  const j = places.findIndex((p) => p.key === 'home');
  if (i < 0 || j < 0 || landing !== 'home' || j < i) return places;
  const out = places.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export type DeskNav = {
  /** Rows by group, in group order; groups with nothing in them left out. */
  groups: { group: NavGroup; places: Place[] }[];
  tools: Place[];
  foot: Place[];
  menu: Place[];
};

export function deskNav(ctx: NavContext): DeskNav {
  const shown = landingFirst(visiblePlaces(ctx), ctx.landing);
  return {
    groups: NAV_GROUPS.map((group) => ({ group, places: shown.filter((p) => p.desk === 'row' && p.group === group) })).filter((g) => g.places.length),
    tools: shown.filter((p) => p.desk === 'tool'),
    foot: shown.filter((p) => p.desk === 'foot'),
    menu: shown.filter((p) => p.desk === 'menu'),
  };
}

/**
 * Whether the desk's Tools rows show. They fold away so every other row fits
 * a 900px window: open when the rep opened them (`saved`, remembered per
 * browser; null when never chosen, which starts folded), and always while the
 * lit row is one of them, so the place on view is never hidden.
 */
export function toolsOpen(saved: boolean | null, lit: string | null | undefined, tools: readonly string[]): { open: boolean; forced: boolean } {
  const forced = !!lit && tools.includes(lit);
  return { open: forced || saved === true, forced };
}

/** Every key the desk shows anywhere (rows, Tools, foot, account menu): what litKey picks from there. */
export const deskKeys = (d: DeskNav): string[] =>
  [...d.groups.flatMap((g) => g.places), ...d.tools, ...d.foot, ...d.menu].map((p) => p.key);
/** The keys the desk's side nav itself can light (the account menu is not a row). */
export const deskRowKeys = (d: DeskNav): string[] => [...d.groups.flatMap((g) => g.places), ...d.tools, ...d.foot].map((p) => p.key);

export type PhoneNav = { tabs: Place[]; more: { group: NavGroup; places: Place[] }[] };

/**
 * The phone: the bottom tabs, then More with everything else. Slot one is
 * where the role lands; then the lists the role lives in (Buyers for an SDR
 * or a Compr workspace, else People and Deals), Tasks and Inbox.
 */
export function phoneNav(ctx: NavContext): PhoneNav {
  const shown = visiblePlaces(ctx);
  const has = (k: string) => shown.some((p) => p.key === k && p.kind === 'screen');
  const want = [ctx.landing, ...(ctx.buyersFirst ? ['buyers'] : ['people', 'deals']), 'tasks', 'inbox'];
  const tabKeys = want.filter((k, i) => has(k) && want.indexOf(k) === i);
  const tabs = tabKeys.map((k) => shown.find((p) => p.key === k)!);
  const rest = landingFirst(shown.filter((p) => !tabKeys.includes(p.key)), ctx.landing);
  return {
    tabs,
    more: NAV_GROUPS.map((group) => ({ group, places: rest.filter((p) => p.group === group) })).filter((g) => g.places.length),
  };
}

/** Every key the phone shows: tabs and More. */
export const phoneKeys = (n: PhoneNav): string[] => [...n.tabs, ...n.more.flatMap((g) => g.places)].map((p) => p.key);

/** A ⌘K "Go to" target. */
export type ScreenDef = { key: string; label: string; say: string[]; hint: string; mark: Mark };

/** Where "go …" can take you: every screen place, plus the closing files. The role filter is matchScreens'. */
export const COMMAND_SCREENS: readonly ScreenDef[] = [
  ...PLACES.filter((p) => p.kind === 'screen').map(({ key, label, say, hint, mark }) => ({ key, label, say: say.length ? say : [label.toLowerCase()], hint, mark })),
  ...SUB_SCREENS.filter((s) => s.say).map((s) => ({ key: s.key, label: s.label, say: s.say!, hint: s.hint ?? '', mark: s.mark ?? 'neutral' as Mark })),
];
