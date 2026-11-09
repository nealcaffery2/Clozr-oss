// lib/routes.ts: the path codec, and every old link form it still reads.
// Run with:  npx tsx tools/routes.test.ts
import {
  RECORD_KEY, SCREEN_TABS, SETTINGS_SECTIONS, URL_SCREENS, cleanFrom, historyStem, isBasePath, legacyTarget, parseLegacy, parsePath,
  linkTarget, pathFor, reportLabel, reportSlug, routeAt, shellBase, stripLegacySearch, underBase, type Route,
} from '../lib/routes';
import { encodeNavHash } from '../lib/nav-hash';
import {
  DEFAULT_SETTINGS_SECTION, SETTINGS_GROUPS, SETTINGS_PATHS, legacySettingsSection, normalSettingsSection, settingsSectionOf,
} from '../lib/settings-sections';
import { REPORT_TABS } from '../lib/reporting';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};
const eq = (label: string, got: unknown, want: unknown) => check(label, JSON.stringify(got) === JSON.stringify(want), { got, want });
const R = (screen: Route['screen'], id: string | null = null, deal: string | null = null, tab: string | null = null): Route => ({ screen, id, deal, tab });

// ---- every screen has a path, and the path reads back to it ----
const TOP: [Route['screen'], string][] = [
  ['home', '/app/home'], ['today', '/app/today'], ['people', '/app/people'], ['import', '/app/import'],
  ['liveLists', '/app/database'], ['inbox', '/app/inbox'], ['dialer', '/app/dialer'], ['tasks', '/app/tasks'],
  ['calendar', '/app/calendar'], ['plans', '/app/plans'], ['automations', '/app/automations'], ['deals', '/app/deals'],
  ['contracts', '/app/contracts'], ['dispo', '/app/dispo'], ['buyers', '/app/buyers'],
  ['campaigns', '/app/campaigns'], ['dealMachine', '/app/deal-machine'], ['reporting', '/app/reporting'],
  ['leaderboard', '/app/leaderboard'], ['coaching', '/app/coaching'], ['settings', '/app/settings'],
  ['account', '/app/settings/you/account'],
];
for (const [screen, path] of TOP) {
  eq(`path: ${screen}`, pathFor(screen), path);
  eq(`parse: ${path}`, parsePath(path), R(screen));
  eq(`demo: ${screen}`, parsePath(pathFor(screen, {}, '/demo'), '/demo'), R(screen));
}

// Records, with and without the deal they are pinned to.
const RECORDS: [string, Route, string][] = [
  ['seller', R('person', 's42'), '/app/people/s42'],
  ['seller pinned to a house', R('person', 's42', 'd7'), '/app/people/s42/d7'],
  ['demo seller', R('person', 'p1'), '/app/people/p1'],
  ['seller added on the sample data', R('person', 'p_k3j9'), '/app/people/p_k3j9'],
  ['vendor', R('vendor', 'v12'), '/app/people/v12'],
  ['buyer', R('buyer', 'b9'), '/app/buyers/b9'],
  ['deal sheet by its deal', R('dealSheet', null, 'd7'), '/app/deals/d7'],
  ['deal sheet, no deal', R('dealSheet', 's42'), '/app/people/s42/deal-sheet'],
  ['TC file by its deal', R('tc', null, 'd7'), '/app/deals/d7/tc'],
  ['TC file, no deal', R('tc', 's42'), '/app/people/s42/tc'],
  ['dispo property by its deal', R('dispoProperty', null, 'd7'), '/app/dispo/d7'],
  ['dispo property, no deal', R('dispoProperty', 's42'), '/app/people/s42/dispo'],
  ['deal added on the sample data', R('dealSheet', null, 'd_k3j9'), '/app/deals/d_k3j9'],
  ['action plan', R('plans', 'ap12'), '/app/plans/ap12'],
  ['contract', R('contracts', 'k123'), '/app/contracts/k123'],
];
for (const [label, r, path] of RECORDS) {
  eq(`path: ${label}`, pathFor(r.screen, r), path);
  eq(`parse: ${label}`, parsePath(path), r);
  eq(`demo round trip: ${label}`, parsePath(pathFor(r.screen, r, '/demo'), '/demo'), r);
}
// A deal-keyed path drops the seller; the shell fills it back from the deal.
eq('deal sheet with a seller is keyed by the deal', pathFor('dealSheet', { id: 's42', deal: 'd7' }), '/app/deals/d7');
eq('TC with a seller is keyed by the deal', pathFor('tc', { id: 's42', deal: 'd7' }), '/app/deals/d7/tc');
eq('dispo with a seller is keyed by the deal', pathFor('dispoProperty', { id: 's42', deal: 'd7' }), '/app/dispo/d7');

// A record screen with no record names its list.
eq('seller, no record', pathFor('person'), '/app/people');
eq('buyer, no record', pathFor('buyer'), '/app/buyers');
eq('TC, no record', pathFor('tc'), '/app/deals');
eq('dispo property, no record', pathFor('dispoProperty'), '/app/dispo');
eq('deal sheet, no record', pathFor('dealSheet'), '/app/deals');

// Sections inside a screen.
for (const [screen, tabs] of Object.entries(SCREEN_TABS)) {
  for (const tab of tabs!) {
    const r = R(screen as Route['screen'], null, null, tab);
    const p = pathFor(screen, { tab });
    eq(`tab round trip: ${screen}/${tab}`, parsePath(p), r);
  }
}
eq('reporting tab path', pathFor('reporting', { tab: 'team' }), '/app/reporting/team');
eq('inbox tab path', pathFor('inbox', { tab: 'sms' }), '/app/inbox/sms');
eq('live database section path', pathFor('liveLists', { tab: 'buyers' }), '/app/database/buyers');
for (const [group, sections] of Object.entries(SETTINGS_SECTIONS)) {
  eq(`settings group ${group}`, parsePath(pathFor('settings', { tab: group })), R('settings', null, null, group));
  for (const sec of sections) {
    if (group === 'you' && sec === 'account') continue;
    eq(`settings ${group}/${sec}`, parsePath(pathFor('settings', { tab: `${group}/${sec}` })), R('settings', null, null, `${group}/${sec}`));
  }
}
eq('settings section path', pathFor('settings', { tab: 'dialer/numbers' }), '/app/settings/dialer/numbers');
eq('settings you/account is the Account screen', parsePath('/app/settings/you/account'), R('account'));
eq('/app/account is an alias', parsePath('/app/account'), R('account'));
eq('a tab the screen does not have is left off', pathFor('reporting', { tab: 'nope' }), '/app/reporting');
eq('a tab on a screen with none is left off', pathFor('tasks', { tab: 'sms' }), '/app/tasks');

// Every URL screen is covered.
for (const screen of URL_SCREENS) {
  const id = RECORD_KEY[screen] ? (screen === 'buyer' ? 'b1' : screen === 'vendor' ? 'v1' : 's1') : null;
  const p = pathFor(screen, { id });
  const back = parsePath(p);
  check(`every screen parses back: ${screen}`, !!back && back.screen === screen && back.id === id, { p, back });
}

// ---- base ----
eq('bare /app is no route', parsePath('/app'), null);
check('bare base', isBasePath('/app') && isBasePath('/app/') && isBasePath('/demo', '/demo') && !isBasePath('/app/people'));
eq('trailing slash', parsePath('/app/people/s42/'), R('person', 's42'));
eq('not under the base', parsePath('/login'), null);
eq('another base', parsePath('/demo/people', '/app'), null);
eq('a path that only starts like the base', parsePath('/apple/people'), null);
check('underBase', underBase('/app') && underBase('/app/deals') && !underBase('/apple') && !underBase('/demo/x'));
eq('shellBase app', shellBase('/app/people/s1'), '/app');
eq('shellBase demo', shellBase('/demo/deals'), '/demo');
eq('shellBase demo bare', shellBase('/demo'), '/demo');
eq('shellBase elsewhere', shellBase('/demonstration'), '/app');
eq('shellBase nothing', shellBase(undefined), '/app');
eq('demo base', pathFor('person', { id: 'p1', deal: 'd3' }, '/demo'), '/demo/people/p1/d3');

// ---- junk ----
const JUNK = [
  '/app/people/x"><', '/app/people/%3Cscript%3E', '/app/../login', '/app/people/..', '/app/people/./s1',
  '/app/nope', '/app/people/s1/d7/tc', '/app/people/s1/nope', '/app/people/v12/tc', '/app/deals/s42',
  '/app/deals/d7/nope', '/app/dispo/s42', '/app/dispo/d7/tc', '/app/buyers/b1/x', '/app/reporting/nope',
  '/app/settings/nope', '/app/settings/dialer/nope', '/app/settings/you/account/x', '/app/a/b/c/d',
  '/app/home/x', '/app/contracts/nope', '/app/constructor', '/app/__proto__', '/app/people/' + 'a'.repeat(65),
  '/app//people', '/app/inbox/sms/x', '/app/account/x', '/app/people/s1/constructor', '/app/settings/constructor',
  '/app/reporting/constructor', '/app/settings/toString/x',
];
for (const p of JUNK) eq(`junk: ${p}`, parsePath(p), null);
eq('junk id left off the path', pathFor('person', { id: 'x"><' }), '/app/people');
eq('junk deal left off the path', pathFor('person', { id: 's1', deal: '../x' }), '/app/people/s1');
eq('a deal must look like one', pathFor('person', { id: 's1', deal: 's2' }), '/app/people/s1');
eq('unknown screen is the base', pathFor('nope'), '/app');
eq('talkr has no path of its own', pathFor('talkr'), '/app');

// ---- legacy: the hash ----
const L = (hash: string, search = '') => parseLegacy(hash, search);
eq('no legacy form', L('', ''), null);
eq('no legacy form, just a query', L('', '?as=tc'), null);
eq('hash without a screen', L('#id=s4'), null);
// Every screen the hash could name.
for (const screen of URL_SCREENS) {
  const key = RECORD_KEY[screen];
  const id = key ? (screen === 'buyer' ? 'b4' : screen === 'vendor' ? 'v4' : 's4') : null;
  const got = L(encodeNavHash({ screen, id, deal: null, from: null }, false));
  check(`legacy hash: ${screen}`, !!got?.route && got.route.screen === screen && got.route.id === id, got);
}
eq('legacy bare home hash', L('#screen=home'), { route: R('home'), from: null });
eq('talkr names the dialer', L('#screen=talkr'), { route: R('dialer'), from: null });
eq('unknown screen', L('#screen=nope'), { route: null, from: null });
eq('prototype key', L('#screen=constructor'), { route: null, from: null });
// Forms from tools/nav-hash.test.ts.
eq('person with from', L('#screen=person&id=s42&from=deals'), { route: R('person', 's42'), from: 'deals' });
eq('deal sheet from a seller', L('#screen=dealSheet&id=s42&deal=d7&from=person%3As42'), { route: R('dealSheet', 's42', 'd7'), from: 'person:s42' });
eq('a seller-less deal sheet', L('#screen=dealSheet&deal=d7'), { route: R('dealSheet', null, 'd7'), from: null });
eq('top-level screen drops from', L('#screen=deals&from=home'), { route: R('deals'), from: null });
eq('junk from dropped', L('#screen=person&id=s1&from=%3Cscript%3E'), { route: R('person', 's1'), from: null });
eq('TC round trip form', L('#screen=tc&id=s9&deal=d3&from=dispoProperty:s9'), { route: R('tc', 's9', 'd3'), from: 'dispoProperty:s9' });
// tools/stoplight.test.ts (Team stoplight links).
eq('stoplight TC file', L('#screen=tc&id=s42&deal=d7&from=reporting'), { route: R('tc', 's42', 'd7'), from: 'reporting' });
eq('stoplight lead', L('#screen=person&id=s9&from=reporting'), { route: R('person', 's9'), from: 'reporting' });
eq('stoplight buyer', L('#screen=buyer&id=b3&from=reporting'), { route: R('buyer', 'b3'), from: 'reporting' });
eq('stoplight demo lead', L('#screen=person&id=p1&from=reporting'), { route: R('person', 'p1'), from: 'reporting' });
eq('stoplight tasks', L('#screen=tasks'), { route: R('tasks'), from: null });
// tools/boot-screen.test.ts.
eq('boot record', L('#screen=person&id=s42&from=people'), { route: R('person', 's42'), from: 'people' });
eq('boot dispo', L('#screen=dispo'), { route: R('dispo'), from: null });
eq('boot contracts', L('#screen=contracts'), { route: R('contracts'), from: null });
// supabase/functions/_shared/rep-alert.ts (the rep alert emails).
eq('rep alert seller', L('#screen=person&id=s12'), { route: R('person', 's12'), from: null });
eq('rep alert buyer', L('#screen=buyer&id=b45'), { route: R('buyer', 'b45'), from: null });
// tools/bug-signals.test.ts (client_errors.path rows).
eq('bug signals deal sheet', L('#screen=dealSheet&id=s26180&deal=d5299'), { route: R('dealSheet', 's26180', 'd5299'), from: null });
eq('bug signals settings', L('#screen=settings'), { route: R('settings'), from: null });
eq('bug signals inbox', L('#screen=inbox'), { route: R('inbox'), from: null });
// The sales manager email (`/#screen=coaching`, forwarded to /app by the root page).
eq('coaching', L('#screen=coaching'), { route: R('coaching'), from: null });
// Junk record ids are dropped, the screen kept (the shell then says the record is missing).
eq('junk id', L('#screen=person&id=x%22%3E%3C'), { route: R('person'), from: null });
eq('junk deal', L('#screen=person&id=s1&deal=..%2F'), { route: R('person', 's1'), from: null });
eq('id on a screen with no record is dropped', L('#screen=deals&id=s1'), { route: R('deals'), from: null });
eq('the hash wins over a webhook query', L('#screen=buyers', '?seller=4'), { route: R('buyers'), from: null });

// ---- legacy: the webhook query ----
eq('?seller=N', L('', '?seller=42'), { route: R('person', 's42'), from: null });
eq('?seller=sN', L('', '?seller=s42'), { route: R('person', 's42'), from: null });
eq('?deal=N', L('', '?deal=7'), { route: R('dealSheet', null, 'd7'), from: null });
eq('?deal=dN', L('', '?deal=d7'), { route: R('dealSheet', null, 'd7'), from: null });
eq('?buyer=N', L('', '?buyer=9'), { route: R('buyer', 'b9'), from: null });
eq('?seller junk', L('', '?seller=abc'), { route: null, from: null });
eq('?deal junk', L('', '?deal=1;drop'), { route: null, from: null });
eq('?buyer empty', L('', '?buyer='), { route: null, from: null });
eq('?seller with other params', L('', '?as=tc&seller=5'), { route: R('person', 's5'), from: null });

// ---- where the address bar goes ----
eq('legacy target: record', legacyTarget(L('#screen=person&id=s42&deal=d7')!, ''), '/app/people/s42/d7');
eq('legacy target keeps ?as=', legacyTarget(L('#screen=deals')!, '?as=tc', '/demo'), '/demo/deals?as=tc');
eq('legacy target drops the webhook query', legacyTarget(L('', '?seller=42&google=ok')!, '?seller=42&google=ok'), '/app/people/s42?google=ok');
eq('legacy target: unknown screen is the base', legacyTarget(L('#screen=nope')!, ''), '/app');
eq('legacy target: deal sheet with a seller', legacyTarget(L('#screen=dealSheet&id=s42&deal=d7')!, ''), '/app/deals/d7');
eq('legacy target: demo TC', legacyTarget(L('#screen=tc&id=p1')!, '', '/demo'), '/demo/people/p1/tc');
eq('strip: nothing', stripLegacySearch(''), '');
eq('strip: all', stripLegacySearch('?deal=1&buyer=2&seller=3'), '');
eq('strip: keeps the rest', stripLegacySearch('?as=acquisitions&deal=1'), '?as=acquisitions');

// ---- routeAt: an address before the shell restores it ----
eq('routeAt bare', routeAt(''), { route: null, bare: true, base: '/app' });
eq('routeAt bare hash', routeAt('#id=s4'), { route: null, bare: true, base: '/app' });
eq('routeAt legacy hash', routeAt('#screen=person&id=s42&from=people'), { route: R('person', 's42'), bare: false, base: '/app' });
eq('routeAt legacy hash on a path', routeAt('/app/deals#screen=buyers'), { route: R('buyers'), bare: false, base: '/app' });
eq('routeAt path', routeAt('/app/people/s42'), { route: R('person', 's42'), bare: false, base: '/app' });
eq('routeAt demo path', routeAt('/demo/deals?as=tc'), { route: R('deals'), bare: false, base: '/demo' });
eq('routeAt demo bare', routeAt('/demo?as=tc'), { route: null, bare: true, base: '/demo' });
eq('routeAt webhook query', routeAt('/app?seller=4'), { route: R('person', 's4'), bare: false, base: '/app' });
eq('routeAt unknown path', routeAt('/app/nope'), { route: null, bare: false, base: '/app' });

// ---- linkTarget: a clicked link ----
const O = 'https://clozr.example';
const LT = (raw: string, at = '/app/reporting', base = '/app') => linkTarget(raw, new URL(raw, O + at).href, O, base);
eq('link: a path', LT('/app/people/s42'), { want: R('person', 's42'), from: null, unknown: false });
eq('link: the base', LT('/app'), { want: null, from: null, unknown: false });
eq('link: unknown path', LT('/app/nope'), { want: null, from: null, unknown: true });
eq('link: stoplight hash on the page', LT('#screen=tc&id=s42&deal=d7&from=reporting'), { want: R('tc', 's42', 'd7'), from: 'reporting', unknown: false });
eq('link: stoplight unknown hash', LT('#screen=nope'), { want: null, from: null, unknown: true });
eq('link: old app link', LT('/app#screen=buyer&id=b3'), { want: R('buyer', 'b3'), from: null, unknown: false });
eq('link: webhook query', LT('/app?deal=7'), { want: R('dealSheet', null, 'd7'), from: null, unknown: false });
eq('link: in-page anchor', LT('#'), null);
eq('link: in-page section', LT('#notes'), null);
eq('link: another page', LT('/login'), null);
eq('link: the marketing page', LT('/'), null);
eq('link: another site', linkTarget('https://evil.example/app/people', 'https://evil.example/app/people', O), null);
eq('link: demo path on the demo', LT('/demo/deals', '/demo', '/demo'), { want: R('deals'), from: null, unknown: false });
eq('link: app path on the demo', LT('/app/deals', '/demo', '/demo'), null);
eq('link: junk href', linkTarget('x', 'not a url', O), null);

// ---- from ----
eq('from kept', cleanFrom('tc:s42:d9'), 'tc:s42:d9');
eq('from junk', cleanFrom('javascript:alert(1)'), null);
eq('from empty', cleanFrom(null), null);

// ---- phase d: Settings sections, Reporting tabs, the Inbox channel, Contracts ----
{
  // Every Settings section has an address, and it reads back to the section.
  const seen = new Set<string>();
  for (const g of SETTINGS_GROUPS) {
    for (const x of g.sections) {
      const p = `${g.slug}/${x.slug}`;
      check(`settings slug unique: ${p}`, !seen.has(p));
      seen.add(p);
      const path = pathFor('settings', { tab: p });
      eq(`settings path ${p}`, path, `/app/settings/${p}`);
      const back = parsePath(path);
      // You › Account is the Account screen's own address.
      eq(`settings parse ${p}`, back, p === 'you/account' ? R('account') : R('settings', null, null, p));
      eq(`settings demo ${p}`, parsePath(pathFor('settings', { tab: p }, '/demo'), '/demo')?.screen, p === 'you/account' ? 'account' : 'settings');
      eq(`settings section of ${p}`, settingsSectionOf(p)?.path, p);
    }
  }
  eq('SETTINGS_SECTIONS is the section table', Object.entries(SETTINGS_SECTIONS).flatMap(([g, xs]) => xs.map((x) => `${g}/${x}`)), SETTINGS_PATHS);
  eq('the You group', SETTINGS_SECTIONS.you, ['account', 'audio', 'notifications']);
  eq('one Templates section', SETTINGS_PATHS.filter((p) => p.endsWith('templates')), ['sequences/templates']);
  check('no Sequences › Action plans section', !SETTINGS_PATHS.includes('sequences/plans'));
  check('no Dialer group called Talkr', SETTINGS_GROUPS.every((g) => !/talkr/i.test(g.label)));
  eq('Dialer › Connection, not Account', settingsSectionOf('dialer/connection')?.section.label, 'Connection');
  check('section labels are unique', new Set(SETTINGS_GROUPS.flatMap((g) => g.sections.map((x) => x.label))).size === SETTINGS_PATHS.length);
  eq('the old Sequences › Action plans link opens Action plans', parsePath('/app/settings/sequences/plans'), R('plans'));
  eq('a group alone opens its first section', normalSettingsSection('dialer'), 'dialer/connection');
  eq('an unknown section opens the default', normalSettingsSection('dialer/nope'), DEFAULT_SETTINGS_SECTION);
  eq('the default is Workspace › General', DEFAULT_SETTINGS_SECTION, 'workspace/general');

  // Every old hand-off target (settingsTab.ts) maps to a section, and that section to a path and back.
  const OLD: [string, string | undefined, string | null][] = [
    ['workspace', undefined, 'workspace/general'], ['workspace', 'general', 'workspace/general'], ['workspace', 'company', 'workspace/company'],
    ['workspace', 'team', 'workspace/team'], ['workspace', 'roundrobin', 'workspace/round-robin'], ['workspace', 'integrations', 'workspace/integrations'],
    ['workspace', 'agent', 'workspace/ai-agent'], ['workspace', 'keys', 'workspace/server-keys'], ['workspace', 'floor', 'you/notifications'],
    ['workspace', 'history', 'workspace/history'], ['workspace', 'archive', 'workspace/archive'],
    ['outbound', undefined, 'email/deliverability'], ['outbound', 'email', 'email/deliverability'], ['outbound', 'google', 'email/google'], ['outbound', 'keys', 'email/email-keys'],
    ['talkr', 'account', 'dialer/connection'], ['talkr', 'numbers', 'dialer/numbers'], ['talkr', 'health', 'dialer/caller-id-health'],
    ['talkr', 'audio', 'you/audio'], ['talkr', 'scripts', 'dialer/scripts'], ['talkr', 'templates', 'sequences/templates'], ['talkr', 'calling', 'dialer/calling'],
    ['sequences', undefined, 'sequences/templates'], ['sequences', 'templates', 'sequences/templates'], ['sequences', 'plans', null],
    ['nope', 'general', null], ['workspace', 'nope', null], ['__proto__', undefined, null], ['workspace', 'constructor', null],
  ];
  for (const [main, tab, want] of OLD) {
    const got = legacySettingsSection({ main, tab });
    eq(`old target ${main}/${tab ?? ''}`, got, want);
    if (got) {
      const back = parsePath(pathFor('settings', { tab: got }));
      check(`old target ${main}/${tab ?? ''} round-trips through its path`, got === 'you/account' ? back?.screen === 'account' : back?.tab === got, back);
    }
  }

  // Reporting: every tab of either workspace kind has a slug the codec takes, and the slug reads back to the tab.
  for (const [kind, tabs] of [['wholesaling', REPORT_TABS]] as const) {
    for (const t of tabs) {
      const slug = reportSlug(t);
      check(`report tab ${kind} ${t}: slug ${slug} is a Reporting tab`, !!SCREEN_TABS.reporting?.includes(slug), slug);
      eq(`report tab ${kind} ${t}: path`, pathFor('reporting', { tab: slug }), `/app/reporting/${slug}`);
      eq(`report tab ${kind} ${t}: parse`, parsePath(`/app/reporting/${slug}`), R('reporting', null, null, slug));
      eq(`report tab ${kind} ${t}: label`, reportLabel(slug, tabs), t);
    }
  }
  eq('report slug: Lead Sources', reportSlug('Lead Sources'), 'lead-sources');
  eq('report slug: Custom reports', reportSlug('Custom reports'), 'custom');
  eq('report slug: AI Sales Manager', reportSlug('AI Sales Manager'), 'ai-sales-manager');
  eq('report label: a tab the workspace does not have', reportLabel('scoreboard', REPORT_TABS), null);
  eq('report label: none', reportLabel(null, REPORT_TABS), null);

  // Inbox channels.
  for (const ch of ['sms', 'email', 'calls', 'voicemail']) {
    eq(`inbox ${ch}: path`, pathFor('inbox', { tab: ch }), `/app/inbox/${ch}`);
    eq(`inbox ${ch}: parse`, parsePath(`/app/inbox/${ch}`), R('inbox', null, null, ch));
  }
  eq('inbox All is the bare path', pathFor('inbox', { tab: null }), '/app/inbox');

  // Contracts tabs, and a contract.
  for (const t of ['summaries', 'terms', 'bulk', 'forms', 'reports']) {
    eq(`contracts ${t}: path`, pathFor('contracts', { tab: t }), `/app/contracts/${t}`);
    eq(`contracts ${t}: parse`, parsePath(`/app/contracts/${t}`), R('contracts', null, null, t));
  }
  eq('contract k123: path', pathFor('contracts', { id: 'k123' }), '/app/contracts/k123');
  eq('contract k123: parse', parsePath('/app/contracts/k123'), R('contracts', 'k123'));
  eq('contract: the contract wins over a tab', pathFor('contracts', { id: 'k5', tab: 'terms' }), '/app/contracts/k5');
  eq('contract: junk id is left off', pathFor('contracts', { id: 'k12x' }), '/app/contracts');
  eq('contract: demo', parsePath('/demo/contracts/k9', '/demo'), R('contracts', 'k9'));

  // The history rule: Settings sections, Reporting tabs and Contracts tabs push
  // (their stems differ); the Inbox channel and an open contract replace (same stem).
  const push = (a: string, b: string) => historyStem(a) !== historyStem(b);
  check('history: Settings section to section pushes', push('/app/settings/workspace/general', '/app/settings/dialer/numbers'));
  check('history: Settings bare to a section pushes', push('/app/settings', '/app/settings/dialer/numbers'));
  check('history: Reporting tab pushes', push('/app/reporting', '/app/reporting/team'));
  check('history: Reporting tab to tab pushes', push('/app/reporting/team', '/app/reporting/calls'));
  check('history: Contracts tab pushes', push('/app/contracts', '/app/contracts/terms'));
  check('history: Inbox channel replaces', !push('/app/inbox', '/app/inbox/sms') && !push('/app/inbox/sms', '/app/inbox/email'));
  check('history: Inbox channel replaces on the demo', !push('/demo/inbox/calls', '/demo/inbox'));
  check('history: a contract opened over the list replaces', !push('/app/contracts', '/app/contracts/k12') && !push('/app/contracts/k12', '/app/contracts'));
  check('history: a contract over a tab pushes back to the list tab', push('/app/contracts/k12', '/app/contracts/terms'));
  check('history: another screen pushes', push('/app/inbox/sms', '/app/deals'));
  check('history: a record pushes', push('/app/people', '/app/people/s4'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
