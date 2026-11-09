// The app's places (lib/nav-model.ts): every surface that lists them agrees,
// and every role reaches what it may open on the desk and on the phone.
// Run with:  npx tsx tools/nav-model.test.ts
import {
  COMMAND_SCREENS, NAV_GROUPS, PLACES, SCREEN_LABELS, SUB_SCREENS, deskKeys, deskNav, deskRowKeys, litKey, phoneKeys, phoneNav,
  toolsOpen, visiblePlaces, type NavContext,
} from '../lib/nav-model';
import { NAV_ICONS } from '../lib/nav-icons';
import { URL_SCREENS, parsePath, pathFor } from '../lib/routes';
import { matchScreens } from '../lib/command';
import { DEMO_ROLE, canSee, landingFor, type Role } from '../lib/team';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  if (!cond) console.log(`FAIL  ${label}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

const ROLES: Role[] = ['owner', 'admin', 'member', 'dispositions', 'acquisitions', 'tc', 'notary', 'partnerships', 'sdr'];
const ctxFor = (role: Role, compr = false): NavContext => ({
  can: (k) => canSee(role, k), landing: landingFor(role), compr, buyersFirst: compr || role === 'sdr',
});
const screens = PLACES.filter((p) => p.kind === 'screen');

// ---- every place is whole -----------------------------------------------------
{
  const keys = PLACES.map((p) => p.key);
  check('place keys are unique', new Set(keys).size === keys.length, keys);
  const labels = [...PLACES.map((p) => p.label), ...SUB_SCREENS.map((s) => s.label)];
  check('one label per place: no two places share a name', new Set(labels).size === labels.length, labels);
  for (const p of PLACES) {
    check(`${p.key}: has a label`, !!p.label.trim());
    check(`${p.key}: has an icon in the one icon map`, Object.prototype.hasOwnProperty.call(NAV_ICONS, p.icon), p.icon);
    check(`${p.key}: its group is a nav group`, NAV_GROUPS.includes(p.group), p.group);
  }
  for (const p of screens) {
    const path = pathFor(p.key);
    check(`${p.key}: has a path`, path !== '/app' && path.startsWith('/app/'), path);
    check(`${p.key}: its path parses back to it`, parsePath(path)?.screen === p.key, [path, parsePath(path)]);
    check(`${p.key}: is a screen a link may name`, (URL_SCREENS as readonly string[]).includes(p.key));
    check(`${p.key}: SCREEN_LABELS uses its label`, SCREEN_LABELS[p.key] === p.label);
  }
  for (const s of SUB_SCREENS) {
    check(`${s.key}: sub-screen is a screen a link may name`, (URL_SCREENS as readonly string[]).includes(s.key));
    check(`${s.key}: lights places that exist`, s.lights.every((k) => PLACES.some((p) => p.key === k)), s.lights);
  }
  // Every screen the shell can show is named, so a title or Back link never reads a key.
  for (const k of URL_SCREENS) check(`${k}: has a label`, !!SCREEN_LABELS[k], k);
  check('the dead talkr key is gone', !('talkr' in SCREEN_LABELS));
  check('panels have no address and no label in SCREEN_LABELS', PLACES.filter((p) => p.kind === 'panel').every((p) => !(p.key in SCREEN_LABELS)));
}

// ---- the decided names ------------------------------------------------------------
{
  const label = (k: string) => PLACES.find((p) => p.key === k)?.label;
  check('Dialer, never Phone or Talkr', label('dialer') === 'Dialer');
  check('no place is called Phone or Talkr', !PLACES.some((p) => /^(phone|talkr)$/i.test(p.label)) && !Object.values(SCREEN_LABELS).some((l) => /talkr/i.test(l)));
  check('Live database', label('liveLists') === 'Live database' && SCREEN_LABELS.liveLists === 'Live database');
  check('Leaderboard', label('leaderboard') === 'Leaderboard');
  check('Lane, without a suffix', label('lane') === 'Lane');
  check('⌘K uses the same labels', COMMAND_SCREENS.every((c) => c.label === SCREEN_LABELS[c.key]), COMMAND_SCREENS.filter((c) => c.label !== SCREEN_LABELS[c.key]));
  check('⌘K "phone" still finds the Dialer', matchScreens('phone', () => true)[0]?.key === 'dialer');
  check('⌘K "talkr" still finds the Dialer', matchScreens('talkr', () => true)[0]?.key === 'dialer');
}

// ---- ⌘K offers every place --------------------------------------------------------
{
  for (const p of screens) check(`⌘K offers ${p.key}`, COMMAND_SCREENS.some((c) => c.key === p.key));
  check('⌘K offers Campaigns', matchScreens('campaigns', () => true)[0]?.key === 'campaigns');
  check('⌘K offers the closing files', COMMAND_SCREENS.some((c) => c.key === 'tc'));
  for (const role of ROLES) {
    const offered = matchScreens('', (k) => canSee(role, k)).map((c) => c.key);
    check(`${role}: ⌘K offers nothing the role cannot open`, offered.every((k) => canSee(role, k)), offered);
  }
}

// ---- every role reaches what it can see, on both surfaces -----------------------
for (const compr of [false, true]) {
  for (const role of ROLES) {
    const tag = `${role}${compr ? ' (Compr workspace)' : ''}`;
    const ctx = ctxFor(role, compr);
    const visible = visiblePlaces(ctx).map((p) => p.key);
    const desk = deskNav(ctx);
    const phone = phoneNav(ctx);
    const onDesk = deskKeys(desk);
    const onPhone = phoneKeys(phone);
    for (const k of visible) {
      check(`${tag}: ${k} is on the desk`, onDesk.includes(k));
      check(`${tag}: ${k} is on the phone`, onPhone.includes(k));
    }
    const refused = [...onDesk, ...onPhone].filter((k) => { const p = PLACES.find((x) => x.key === k)!; return p.kind === 'screen' && !canSee(role, k); });
    check(`${tag}: nothing shown that canSee refuses`, !refused.length, refused);
    check(`${tag}: the desk and the phone show the same places`, [...onDesk].sort().join() === [...onPhone].sort().join(), [onDesk, onPhone]);
    check(`${tag}: each place once on the desk`, new Set(onDesk).size === onDesk.length, onDesk);
    check(`${tag}: each place once on the phone`, new Set(onPhone).size === onPhone.length, onPhone);
    const landing = landingFor(role);
    if (canSee(role, landing) && !(compr && PLACES.find((p) => p.key === landing)?.comprHidden)) {
      check(`${tag}: phone slot one is the landing (${landing})`, phone.tabs[0]?.key === landing, phone.tabs.map((t) => t.key));
    }
    check(`${tag}: at most five tabs before More`, phone.tabs.length <= 5, phone.tabs.length);
    check(`${tag}: the tabs are screens`, phone.tabs.every((t) => t.kind === 'screen'));
    // Home sits beside Today, landing first, for roles that have both.
    const daily = desk.groups.find((g) => g.group === 'Daily')?.places.map((p) => p.key) ?? [];
    if (daily.includes('home') && daily.includes('today')) {
      const [first, second] = landing === 'today' ? ['today', 'home'] : ['home', 'today'];
      check(`${tag}: ${first} then ${second} in Daily`, daily.indexOf(first) === 0 && daily.indexOf(second) === 1, daily);
    }
    // Every screen the role can open lights a row the desk shows (records light their list).
    const rows = deskRowKeys(desk);
    for (const k of URL_SCREENS) {
      if (!canSee(role, k)) continue;
      const p = PLACES.find((x) => x.key === k);
      if (p && compr && p.comprHidden) continue;
      // A Compr workspace has no seller pipeline: the records under it go with their lists.
      const sub = SUB_SCREENS.find((x) => x.key === k);
      if (sub && compr && !sub.lights.some((l) => visible.includes(l))) continue;
      const lit = litKey(k, rows);
      check(`${tag}: ${k} lights a desk row`, !!lit && rows.includes(lit), [k, lit]);
      const plit = litKey(k, onPhone);
      check(`${tag}: ${k} lights a phone tab or More row`, !!plit, [k, plit]);
    }
  }
}

// ---- the rows that used to light wrong --------------------------------------------
{
  const rows = deskRowKeys(deskNav(ctxFor(DEMO_ROLE)));
  const lights = (k: string) => litKey(k, rows);
  check('Action plans lights its own row', lights('plans') === 'plans');
  check('Automations lights its own row', lights('automations') === 'automations');
  check('Leaderboard lights its own row', lights('leaderboard') === 'leaderboard');
  check('Import lights its own row', lights('import') === 'import');
  check('Settings lights its row', lights('settings') === 'settings');
  check('Account lights Settings', lights('account') === 'settings');
  check('Live database lights its row', lights('liveLists') === 'liveLists');
  check('a vendor lights People', lights('vendor') === 'people');
  check('a seller lights People', lights('person') === 'people');
  check('a buyer lights Buyers', lights('buyer') === 'buyers');
  check('a TC file lights Deals', lights('tc') === 'deals');
  check('a dispo property lights Dispo', lights('dispoProperty') === 'dispo');
  check('a TC role\'s seller record lights Deals', litKey('person', deskRowKeys(deskNav(ctxFor('tc')))) === 'deals');
  // On the phone Account has a More row of its own.
  const phone = phoneKeys(phoneNav(ctxFor(DEMO_ROLE)));
  check('phone: Account lights its own More row', litKey('account', phone) === 'account');
}

// ---- the desk's Tools rows fold away ------------------------------------------------
{
  const tools = deskNav(ctxFor(DEMO_ROLE)).tools.map((t) => t.key);
  const rows = deskRowKeys(deskNav(ctxFor(DEMO_ROLE)));
  const at = (screen: string, saved: boolean | null) => toolsOpen(saved, litKey(screen, rows), tools);
  check('Tools start folded when never chosen', JSON.stringify(at('home', null)) === JSON.stringify({ open: false, forced: false }));
  check('Tools stay folded when folded', !at('deals', false).open);
  check('Tools open when opened', at('deals', true).open && !at('deals', true).forced);
  for (const k of ['campaigns', 'dealMachine', 'liveLists', 'import', 'automations']) {
    check(`${k} on view keeps Tools open, whatever was chosen`, at(k, false).open && at(k, false).forced && at(k, null).open);
  }
  check('Lane open keeps Tools open', toolsOpen(false, 'lane', tools).open);
  check('a record under a list does not open Tools', !at('person', false).open && !at('buyer', null).open);
  check('Settings and Account do not open Tools', !at('settings', null).open && !at('account', false).open);
  check('no lit row: the choice stands', !toolsOpen(null, null, tools).open && toolsOpen(true, null, tools).open);
}

// ---- tabs by role -------------------------------------------------------------------
{
  const tabs = (role: Role, compr = false) => phoneNav(ctxFor(role, compr)).tabs.map((t) => t.key).join(',');
  check('owner tabs', tabs('owner') === 'home,people,deals,tasks,inbox', tabs('owner'));
  check('acquisitions tabs', tabs('acquisitions') === 'today,people,deals,tasks,inbox', tabs('acquisitions'));
  check('partnerships starts on People', tabs('partnerships') === 'people,deals,tasks,inbox', tabs('partnerships'));
  check('sdr starts on Buyers', tabs('sdr') === 'buyers,tasks,inbox', tabs('sdr'));
  check('tc tabs', tabs('tc') === 'home,deals,tasks,inbox', tabs('tc'));
  check('a Compr workspace owner', tabs('owner', true) === 'home,buyers,tasks,inbox', tabs('owner', true));
}

// ---- the Compr workspace hides what it hid before ---------------------------------
{
  const shown = visiblePlaces(ctxFor('owner', true)).map((p) => p.key);
  for (const k of ['today', 'people', 'deals', 'contracts', 'dispo', 'lane', 'genius', 'dealMachine']) check(`Compr workspace hides ${k}`, !shown.includes(k));
  for (const k of ['home', 'buyers', 'plans', 'inbox', 'tasks', 'reporting', 'compr', 'campaigns', 'settings']) check(`Compr workspace keeps ${k}`, shown.includes(k));
}

console.log(failed ? `\n${failed} of ${passed + failed} nav-model checks failed` : `all ${passed} nav-model checks passed`);
if (failed) process.exit(1);
