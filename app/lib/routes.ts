// The CLOZR address as a path: `/app/people/s42`, `/app/deals/d7/tc`.
//
// One table maps every screen the shell can show to a path under the shell's
// base (`/app`, or `/demo` for the sample data), and back. The old address,
// the hash (`#screen=person&id=s42&deal=d7&from=deals`, lib/nav-hash), and
// the query links Zapier and the webhooks carry (`/app?seller=42`) are read
// by parseLegacy, permanently: old emails, calendar events and bookmarks
// never expire.
//
// Where a screen was opened from (`from`) is not in the path. It rides in
// `history.state`, which survives reload, Back and Forward in the same tab;
// a copied link uses the screen's own fallback, which is what a link from
// someone else should do.
//
// Pure, so the codec is testable without a browser
// (`npx tsx tools/routes.test.ts`).

import { decodeNavHash, formatFrom, parseFrom } from './nav-hash';
import { SETTINGS_GROUPS } from './settings-sections';

/** The screens a link may name. */
export const URL_SCREENS = [
  'home', 'people', 'person', 'vendor', 'import', 'inbox', 'tasks', 'calendar', 'deals', 'dealSheet', 'dispo', 'dispoProperty',
  'buyers', 'buyer', 'tc', 'reporting', 'dialer', 'plans', 'automations', 'leaderboard', 'settings',
  'account', 'liveLists', 'dealMachine', 'today', 'contracts', 'coaching', 'campaigns',
] as const;
export type UrlScreen = (typeof URL_SCREENS)[number];

/** Which piece of shell state holds the record a record screen shows. */
export const RECORD_KEY: Partial<Record<string, 'personId' | 'buyerId' | 'dispoId' | 'tcId' | 'vendorId'>> = {
  person: 'personId', dealSheet: 'personId', buyer: 'buyerId', dispoProperty: 'dispoId', tc: 'tcId', vendor: 'vendorId',
};

export const isUrlScreen = (s: string | null | undefined): s is UrlScreen =>
  !!s && (URL_SCREENS as readonly string[]).includes(s);

/**
 * A place: its screen, on a record screen the record (`s42`, `b9`, `v12`,
 * `p1` in the demo), the deal it is pinned to (`d7`), and a section inside
 * the screen (`dialer/numbers` in Settings, `team` in Reporting). On
 * Contracts and Action plans `id` is the contract (`k123`) or plan (`ap12`).
 */
export type Route = { screen: UrlScreen; id: string | null; deal: string | null; tab: string | null };

/** The shell's two roots. */
export type ShellBase = '/app' | '/demo';
export const SHELL_BASES: readonly ShellBase[] = ['/app', '/demo'];

/** The root a pathname is under: /demo for the sample data, else /app. */
export function shellBase(pathname: string | null | undefined): ShellBase {
  const p = pathname ?? '';
  return p === '/demo' || p.startsWith('/demo/') ? '/demo' : '/app';
}

/** True when the pathname is the base itself (`/app`, `/app/`): the role's landing. */
export function isBasePath(pathname: string, base: string = '/app'): boolean {
  return pathname === base || pathname === base + '/';
}

/** True when the pathname is the shell's: the base or anything under it. */
export function underBase(pathname: string, base: string = '/app'): boolean {
  return pathname === base || pathname.startsWith(base + '/');
}

// ---- slugs ------------------------------------------------------------------

/** Top-level screens: one slug each. */
const SLUG: Partial<Record<UrlScreen, string>> = {
  home: 'home', today: 'today', people: 'people', import: 'import', liveLists: 'database', inbox: 'inbox',
  dialer: 'dialer', tasks: 'tasks', calendar: 'calendar', plans: 'plans', automations: 'automations',
  deals: 'deals', contracts: 'contracts', dispo: 'dispo', buyers: 'buyers', campaigns: 'campaigns',
  dealMachine: 'deal-machine', reporting: 'reporting', leaderboard: 'leaderboard', coaching: 'coaching',
  settings: 'settings',
};
const BY_SLUG: Record<string, UrlScreen> = Object.fromEntries(
  Object.entries(SLUG).map(([k, v]) => [v, k as UrlScreen]),
);

/** Settings: `/app/settings/<group>/<section>`, from lib/settings-sections.ts. */
export const SETTINGS_SECTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  SETTINGS_GROUPS.map((g) => [g.slug, g.sections.map((x) => x.slug)]),
);

/** Sections a screen can be opened on: `/app/reporting/team`, `/app/inbox/sms`. */
export const SCREEN_TABS: Partial<Record<UrlScreen, readonly string[]>> = {
  reporting: [
    'overview', 'acquisitions', 'lead-sources', 'calls', 'team', 'offers', 'contracts', 'dispo', 'buyers', 'closings',
    'marketing', 'profitability', 'team-stoplight', 'ai-agents', 'ai-sales-manager', 'flows', 'custom',
    // A Compr workspace's own report.
    'scoreboard', 'road-to-100',
  ],
  inbox: ['sms', 'email', 'calls', 'voicemail'],
  contracts: ['summaries', 'terms', 'bulk', 'forms', 'reports'],
  import: ['buyers', 'vendors', 'submissions'],
  liveLists: ['sellers', 'buyers', 'vendors'],
};

/** A Reporting tab's slug: its label in kebab case ("Lead Sources" → lead-sources); "Custom reports" is `custom`. */
export const reportSlug = (label: string): string =>
  label === 'Custom reports' ? 'custom' : label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The Reporting tab a slug names, from the tabs the workspace has; null when none does. */
export const reportLabel = (slug: string | null | undefined, tabs: readonly string[]): string | null =>
  (slug ? tabs.find((t) => reportSlug(t) === slug) ?? null : null);

/**
 * The path with the sections that replace their history entry rather than
 * push one taken off: the Inbox channel (a frequent toggle) and an open
 * contract (a dialog over the Contracts list). Two addresses with the same
 * stem are the same entry. Settings sections, Reporting tabs and Contracts
 * tabs are places, so they stay in the stem and push.
 */
export function historyStem(path: string): string {
  return path
    .replace(/^(\/(?:app|demo)\/inbox)\/[a-z-]+$/, '$1')
    .replace(/^(\/(?:app|demo)\/contracts)\/k\d{1,18}$/, '$1');
}

/** A path segment CLOZR wrote: letters, digits, `_` and `-`, no dots, nothing encoded. */
const SEG = /^[A-Za-z0-9_-]{1,64}$/;
/** A deal: `d7` live and in the demo, `d_<uid>` for one added on the sample data. */
const DEAL = /^d(?:\d{1,18}|_[A-Za-z0-9_-]{1,60})$/;
/** A vendor: `v12`. */
const VENDOR = /^v\d{1,18}$/;
/** A contract: `k123`. */
const CONTRACT = /^k\d{1,18}$/;
/** What follows a seller's id: the screen of theirs it opens. */
const PERSON_SUB: Record<string, UrlScreen> = { 'deal-sheet': 'dealSheet', tc: 'tc', dispo: 'dispoProperty' };

const safe = (v: string | null | undefined): string | null => (v && SEG.test(v) ? v : null);
const safeDeal = (v: string | null | undefined): string | null => (v && DEAL.test(v) ? v : null);

/** A section slug the screen has; Settings takes `<group>` or `<group>/<section>`. */
function validTab(screen: UrlScreen, tab: string | null | undefined): string | null {
  if (!tab) return null;
  if (screen === 'settings') {
    const [group, section, ...rest] = tab.split('/');
    const sections = Object.prototype.hasOwnProperty.call(SETTINGS_SECTIONS, group) ? SETTINGS_SECTIONS[group] : null;
    if (!sections || rest.length) return null;
    if (section === undefined) return group;
    return sections.includes(section) ? `${group}/${section}` : null;
  }
  return SCREEN_TABS[screen]?.includes(tab) ? tab : null;
}

/**
 * The path for a place. A record screen with no record names the list it
 * belongs to, so the address never points at nothing. Junk ids are left off.
 */
export function pathFor(
  screen: string,
  r: { id?: string | null; deal?: string | null; tab?: string | null } = {},
  base: string = '/app',
): string {
  const id = safe(r.id);
  const deal = safeDeal(r.deal);
  const at = (...segs: string[]) => base + '/' + segs.join('/');
  switch (screen) {
    case 'person': return id ? at('people', id, ...(deal ? [deal] : [])) : at('people');
    case 'vendor': return id ? at('people', id) : at('people');
    case 'dealSheet': return deal ? at('deals', deal) : id ? at('people', id, 'deal-sheet') : at('deals');
    case 'tc': return deal ? at('deals', deal, 'tc') : id ? at('people', id, 'tc') : at('deals');
    case 'dispoProperty': return deal ? at('dispo', deal) : id ? at('people', id, 'dispo') : at('dispo');
    case 'buyer': return id ? at('buyers', id) : at('buyers');
    case 'account': return at('settings', 'you', 'account');
    case 'plans': return id ? at('plans', id) : at('plans');
    case 'contracts': {
      if (id && CONTRACT.test(id)) return at('contracts', id);
      const tab = validTab('contracts', r.tab);
      return tab ? at('contracts', tab) : at('contracts');
    }
    default: {
      if (!isUrlScreen(screen)) return base;
      const slug = SLUG[screen];
      if (!slug) return base;
      const tab = validTab(screen, r.tab);
      return tab ? at(slug, ...tab.split('/')) : at(slug);
    }
  }
}

const route = (screen: UrlScreen, id: string | null = null, deal: string | null = null, tab: string | null = null): Route =>
  ({ screen, id, deal, tab });

/**
 * A path back into its place; null when it is not under `base`, is the bare
 * base (the role's landing, see isBasePath), or names no CLOZR screen.
 */
export function parsePath(pathname: string, base: string = '/app'): Route | null {
  if (!underBase(pathname, base)) return null;
  const rest = pathname.slice(base.length).replace(/^\/|\/$/g, '');
  if (!rest) return null;
  const segs = rest.split('/');
  if (segs.length > 3 || !segs.every((s) => SEG.test(s))) return null;
  const [a, b, c] = segs;
  switch (a) {
    case 'people': {
      if (!b) return route('people');
      if (!c) return VENDOR.test(b) ? route('vendor', b) : route('person', b);
      if (VENDOR.test(b)) return null;
      const sub = Object.prototype.hasOwnProperty.call(PERSON_SUB, c) ? PERSON_SUB[c] : undefined;
      if (sub) return route(sub, b);
      return DEAL.test(c) ? route('person', b, c) : null;
    }
    case 'deals':
      if (!b) return route('deals');
      if (!DEAL.test(b)) return null;
      if (!c) return route('dealSheet', null, b);
      return c === 'tc' ? route('tc', null, b) : null;
    case 'dispo':
      if (!b) return route('dispo');
      return !c && DEAL.test(b) ? route('dispoProperty', null, b) : null;
    case 'buyers':
      if (c) return null;
      return b ? route('buyer', b) : route('buyers');
    case 'plans':
      if (c) return null;
      return route('plans', b ?? null);
    case 'account':
      return b ? null : route('account');
    case 'contracts':
      if (c) return null;
      if (!b) return route('contracts');
      if (CONTRACT.test(b)) return route('contracts', b);
      return validTab('contracts', b) ? route('contracts', null, null, b) : null;
    case 'settings': {
      if (b === 'you' && c === 'account') return route('account');
      // Sequences › Action plans was the Action plans screen a second time; old links open the screen.
      if (b === 'sequences' && c === 'plans') return route('plans');
      const tab = b ? validTab('settings', c ? `${b}/${c}` : b) : null;
      return b && !tab ? null : route('settings', null, null, tab);
    }
    default: {
      const screen = Object.prototype.hasOwnProperty.call(BY_SLUG, a) ? BY_SLUG[a] : undefined;
      if (!screen) return null;
      if (c) return null;
      if (!b) return route(screen);
      const tab = validTab(screen, b);
      return tab ? route(screen, null, null, tab) : null;
    }
  }
}

/**
 * The place an address names before the shell has restored it (the boot
 * chunk, the vitals rows): an old hash or webhook query on it first, else its
 * path. `bare` is the base itself, which is the role's landing. `href` is a
 * pathname with its search and hash; a bare hash or '' reads as /app.
 */
export function routeAt(href: string): { route: Route | null; bare: boolean; base: ShellBase } {
  let u: URL;
  try { u = new URL(href || '', 'https://clozr.invalid/app'); } catch { return { route: null, bare: false, base: '/app' }; }
  const base = shellBase(u.pathname);
  const legacy = parseLegacy(u.hash, u.search);
  if (legacy) return { route: legacy.route, bare: false, base };
  return { route: parsePath(u.pathname, base), bare: isBasePath(u.pathname, base), base };
}

// ---- the old addresses ------------------------------------------------------

/** What an old link names: the place (null when it names no CLOZR screen) and the `from` it carried. */
export type LegacyLink = { route: Route | null; from: string | null };

/** Query parameters the old webhook links carry (`/app?seller=42`). */
export const LEGACY_QUERY_KEYS = ['seller', 'deal', 'buyer'] as const;

const numId = (raw: string | null, prefix: string): string | null => {
  const t = (raw ?? '').trim();
  const m = t.match(new RegExp(`^${prefix}?(\\d{1,18})$`));
  return m ? prefix + m[1] : null;
};

/**
 * An old link, read once on arrival: the hash (`#screen=…&id=…&deal=…&from=…`,
 * every screen the hash ever named, plus `talkr`, which named the dialer) or
 * the webhook query (`?seller=N`, `?buyer=N`, `?deal=N` or `?deal=dN`). Null
 * when the address carries neither, so the path is read as it is.
 */
export function parseLegacy(hash: string, search: string): LegacyLink | null {
  const nav = decodeNavHash(hash ?? '');
  if (nav) {
    const screen = nav.screen === 'talkr' ? 'dialer' : nav.screen;
    if (!isUrlScreen(screen)) return { route: null, from: null };
    // The hash kept the record on screens that have one; Action plans kept its plan elsewhere.
    const id = RECORD_KEY[screen] ? safe(nav.id) : null;
    const deal = RECORD_KEY[screen] ? safe(nav.deal) : null;
    return { route: route(screen, id, deal), from: nav.from };
  }
  const q = new URLSearchParams(search ?? '');
  const seller = numId(q.get('seller'), 's');
  if (seller) return { route: route('person', seller), from: null };
  const deal = numId(q.get('deal'), 'd');
  if (deal) return { route: route('dealSheet', null, deal), from: null };
  const buyer = numId(q.get('buyer'), 'b');
  if (buyer) return { route: route('buyer', buyer), from: null };
  if (LEGACY_QUERY_KEYS.some((k) => q.has(k))) return { route: null, from: null };
  return null;
}

/** The query string with the old webhook parameters taken out (`?as=`, `?google=` stay). */
export function stripLegacySearch(search: string): string {
  const q = new URLSearchParams(search ?? '');
  for (const k of LEGACY_QUERY_KEYS) q.delete(k);
  const t = q.toString();
  return t ? '?' + t : '';
}

/**
 * Where the shell's address bar should point once an old link is read: the
 * new path plus the query the page still reads. `from` and the full place
 * (with the seller a deal-keyed path drops) go into history.state.
 */
export function legacyTarget(link: LegacyLink, search: string, base: string = '/app'): string {
  const path = link.route ? pathFor(link.route.screen, link.route, base) : base;
  return path + stripLegacySearch(search);
}

/** What an address names before the shell checks it against the records and the role. */
export type RouteTarget = { want: Route | null; from: string | null; unknown: boolean };

/**
 * A clicked link, when it is one of the shell's own places: same origin,
 * under the base, by path or by an old #screen= hash or webhook query. Null
 * leaves it to the browser: another site or page, or an in-page anchor
 * (`#`, `#section`). `raw` is the href as written, `href` the resolved URL.
 */
export function linkTarget(raw: string, href: string, origin: string, base: string = '/app'): RouteTarget | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.origin !== origin || !underBase(url.pathname, base)) return null;
  const legacy = parseLegacy(url.hash, url.search);
  if (legacy) return { want: legacy.route, from: legacy.from, unknown: !legacy.route };
  if (raw.trim().startsWith('#')) return null;
  const want = parsePath(url.pathname, base);
  return { want, from: null, unknown: !want && !isBasePath(url.pathname, base) };
}

/** `from` as history.state keeps it: the same `<screen>[:<id>[:<deal>]]` form the hash used, junk dropped. */
export const cleanFrom = (raw: string | null | undefined): string | null => formatFrom(parseFrom(raw));
