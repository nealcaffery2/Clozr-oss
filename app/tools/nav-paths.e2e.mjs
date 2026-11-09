// End-to-end check of the operator app's path addresses (lib/routes.ts) and
// the popstate guard (lib/shell-history.ts), on a production build served the
// way Vercel serves it.
//
// Run from app/:
//   pnpm build
//   node tools/nav-paths.e2e.mjs                 # serves dist/client itself, then runs
//   node tools/nav-paths.e2e.mjs --serve 4173    # only serve (to poke at it by hand)
//   node tools/nav-paths.e2e.mjs --url http://127.0.0.1:4173   # run against a server already up
//   node tools/nav-paths.e2e.mjs --shots <dir>   # also save desk (1440) and phone (390) screenshots
//
// The built-in server mimics vercel.json: cleanUrls (/demo -> demo.html), a
// trailing slash 308s to the bare path, files win, then the `redirects` and
// `rewrites` in vercel.json (/demo/:path+ -> /demo). Playwright comes from the
// project if installed, else $PLAYWRIGHT (a path to playwright's index.mjs);
// the browser from $CHROMIUM (cloud sessions: /opt/pw-browsers/chromium,
// started with --no-sandbox).
//
// What it asserts, on /demo (sample data, no sign-in): the side nav and list
// rows move the address to the place's path; Back and Forward three times
// each fetch no `?_rsc` and load no document (a window marker survives); a
// record's in-app Back link steps back in history and keeps its `from`
// across a reload; a hard reload on a deep record path (and on a deal-keyed
// TC path) opens the same record; old `#screen=` and `?buyer=` links become
// their path; an unknown path lands on the landing with a toast; a
// `#screen=` anchor and a path anchor clicked in the page navigate in the
// app; a modified click opens a new tab; `/#screen=` on the marketing page
// forwards to /app; `/demo?as=` keeps its query and the phone tabs work at
// 390px. The nav model (lib/nav-model.ts): every place the More sheet lists
// is on the desk, and each screen lights its own row. The sections inside
// screens: a Settings section, a Reporting tab and a Contracts tab push an
// entry and survive a reload; an Inbox channel replaces its entry; an old
// Settings link and a contract link land where they say. Prints PASS/FAIL per check and exits 1 if any failed. Run it before
// upgrading vinext (lib/shell-history.ts depends on its internals).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ROOT = path.join(APP, 'dist/client');

// ---- the server -------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.rsc': 'text/x-component', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain', '.wasm': 'application/wasm',
};

/** A vercel.json `source` (path-to-regexp, the subset this project uses) as a RegExp with named groups. */
function sourceRe(source) {
  const re = source
    .replace(/[.]/g, '\\.')
    .replace(/:(\w+)\+/g, '(?<$1>.+)')
    .replace(/:(\w+)\*/g, '(?<$1>.*)')
    .replace(/:(\w+)/g, '(?<$1>[^/]+)');
  return new RegExp('^' + re + '$');
}

function fileFor(p) {
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) return null;
  if (path.extname(f) && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  if (fs.existsSync(f + '.html')) return f + '.html';
  const idx = path.join(f, 'index.html');
  return fs.existsSync(idx) ? idx : null;
}

export function serve(port) {
  const vercel = JSON.parse(fs.readFileSync(path.join(APP, 'vercel.json'), 'utf8'));
  const rewrites = (vercel.rewrites ?? []).filter((r) => r.destination.startsWith('/')).map((r) => ({ re: sourceRe(r.source), to: r.destination }));
  const redirects = (vercel.redirects ?? []).map((r) => ({ re: sourceRe(r.source), r }));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.length > 1 && p.endsWith('/')) { res.writeHead(308, { location: p.slice(0, -1) + u.search }); return res.end(); }
    let f = fileFor(p);
    if (!f) {
      for (const { re, r } of redirects) {
        const m = p.match(re);
        if (!m) continue;
        let groups = { ...(m.groups ?? {}) };
        const ok = (r.has ?? []).every((h) => {
          if (h.type !== 'query') return false;
          const v = u.searchParams.get(h.key);
          if (v == null) return false;
          const hm = h.value ? v.match(new RegExp('^' + h.value + '$')) : [v];
          if (!hm) return false;
          groups = { ...groups, ...(hm.groups ?? {}) };
          return true;
        });
        if (!ok) continue;
        const to = r.destination.replace(/:(\w+)/g, (_, k) => groups[k] ?? '');
        res.writeHead(r.permanent ? 308 : 307, { location: to + u.search });
        return res.end();
      }
      for (const { re, to } of rewrites) if (re.test(p)) { p = to; break; }
      f = fileFor(p);
    }
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

// ---- the run ----------------------------------------------------------------

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

async function loadPlaywright() {
  for (const spec of ['playwright', process.env.PLAYWRIGHT, '/opt/node-tools/node_modules/playwright/index.mjs']) {
    if (!spec) continue;
    try { return await import(spec); } catch { /* next */ }
  }
  throw new Error('Playwright not found: install it, or set PLAYWRIGHT to its index.mjs');
}

let failed = 0;
let passed = 0;
function check(label, cond, detail) {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
  return cond;
}

/** Watches one page: document loads and RSC fetches after the first load. */
function watch(page) {
  const seen = { docs: [], rsc: [] };
  page.on('request', (r) => {
    const u = r.url();
    if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) seen.docs.push(u);
    if (u.includes('_rsc') || /\.rsc(\?|$)/.test(new URL(u).pathname + new URL(u).search) || r.headers()['rsc']) seen.rsc.push(u);
  });
  return seen;
}

const pathOf = (page) => { const u = new URL(page.url()); return u.pathname + u.search; };
const settle = (page, ms = 700) => page.waitForTimeout(ms);
/** The shell is up: its side nav (desk) or bottom tabs (phone) are drawn and the address restored. */
async function ready(page) {
  await page.waitForFunction(() => typeof history.state?.clozrIdx === 'number' && / · CLOZR$/.test(document.title), null, { timeout: 30000 });
  await settle(page, 500);
}
const mark = (page) => page.evaluate(() => { window.__e2eMark = 'alive'; });
/** Unfold the side nav's Tools rows when they are folded away. */
async function openTools(page) {
  const t = page.locator('.cz-side .cz-side-toggle');
  if (await t.getAttribute('aria-expanded') !== 'true') { await t.click(); await page.waitForTimeout(200); }
}
/** Rows of the side nav's list drawn below the top of its foot, and how far the list scrolls (0 when it fits). */
const navOverflow = (page) => page.evaluate(() => {
  const list = document.querySelector('.cz-side-list');
  const footTop = document.querySelector('.cz-side-foot').getBoundingClientRect().top;
  const rows = [...list.querySelectorAll('.cz-side-link, .cz-side-toggle')].filter((e) => e.getClientRects().length);
  return {
    below: rows.filter((r) => r.getBoundingClientRect().bottom > Math.min(footTop, innerHeight)).map((r) => r.textContent.trim() || r.getAttribute('aria-label')),
    scroll: list.scrollHeight - list.clientHeight,
  };
});
const alive = (page) => page.evaluate(() => window.__e2eMark === 'alive');

async function runDesk(browser, base, shots) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const seen = watch(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base + '/demo', { waitUntil: 'load' });
  await ready(page);
  check('bare /demo becomes the landing path', pathOf(page) === '/demo/home', pathOf(page));
  check('title names the screen', (await page.title()) === 'Home · CLOZR', await page.title());
  check('the side nav rows link to paths', await page.locator('a.cz-side-link[href="/demo/people"]').count() === 1);
  const docsAtLoad = seen.docs.length;
  const rscAtLoad = seen.rsc.length;
  await mark(page);

  /** Every place visited, in history order, so Back and Forward can be checked against it. */
  const visited = [pathOf(page)];
  const go = async (label, act, want, title) => {
    const idxBefore = await page.evaluate(() => history.state.clozrIdx);
    await act();
    await settle(page);
    const at = pathOf(page);
    const ok = typeof want === 'string' ? at === want : want.test(at);
    check(`${label}: address is ${want}`, ok, at);
    if (title) check(`${label}: title`, typeof title === 'string' ? (await page.title()) === title : title.test(await page.title()), await page.title());
    visited.push(at);
    check(`${label}: one new history entry`, await page.evaluate(() => history.state.clozrIdx) === idxBefore + 1);
  };
  const side = (label) => () => page.click(`a.cz-side-link:has-text("${label}")`);

  // Sections from the side nav.
  for (const [label, path] of [['People', '/demo/people'], ['Inbox', '/demo/inbox'], ['Tasks', '/demo/tasks'], ['Calendar', '/demo/calendar'], ['Reporting', '/demo/reporting'], ['Buyr', '/demo/buyr'], ['Buyers', '/demo/buyers']]) {
    // Buyr is a tool: its rows start folded away.
    if (label === 'Buyr') await openTools(page);
    await go(`side nav ${label}`, side(label), path, `${label} · CLOZR`);
  }
  // Records from list rows.
  await go('buyer row', () => page.locator('table tbody tr').first().locator('td').nth(1).click(), /^\/demo\/buyers\/b\d+$/, /^(?!Buyers ·).+ · CLOZR$/);
  await go('side nav People again', side('People'), '/demo/people', 'People · CLOZR');
  await go('seller row', () => page.locator('table tbody tr').first().locator('td').nth(1).click(), /^\/demo\/people\/p\d+$/, /^(?!People ·).+ · CLOZR$/);
  await go('side nav Deals', side('Deals'), '/demo/deals', 'Deals · CLOZR');
  await go('deal card: Deal sheet', () => page.getByRole('button', { name: 'Deal sheet' }).first().click(), /^\/demo\/deals\/d\d+$/);
  if (shots) await page.screenshot({ path: path.join(shots, 'desk-1440-deal-sheet.png') });
  await go('side nav Deals once more', side('Deals'), '/demo/deals');
  await go('deal card: Transaction coordination', () => page.getByRole('button', { name: 'Transaction coordination' }).first().click(), /^\/demo\/deals\/d\d+\/tc$/);

  // Back three times, Forward three times: the page never reloads.
  for (let i = 1; i <= 3; i++) {
    await page.goBack({ waitUntil: 'commit' });
    await settle(page);
    check(`Back ${i}: ${visited[visited.length - 1 - i]}`, pathOf(page) === visited[visited.length - 1 - i], pathOf(page));
  }
  for (let i = 2; i >= 0; i--) {
    await page.goForward({ waitUntil: 'commit' });
    await settle(page);
    check(`Forward: ${visited[visited.length - 1 - i]}`, pathOf(page) === visited[visited.length - 1 - i], pathOf(page));
  }
  check('Back/Forward: no ?_rsc fetch', seen.rsc.length === rscAtLoad, seen.rsc.slice(rscAtLoad));
  check('Back/Forward: no document load', seen.docs.length === docsAtLoad, seen.docs.slice(docsAtLoad));
  check('Back/Forward: the page is the same page (marker alive)', await alive(page));

  // The in-app Back link (components/ds/BackLink): from a record opened off
  // the list, it steps back in history (lib/nav-hash backAction), so the
  // entry count goes down, not up; `from` rides in history.state.
  await page.click('a.cz-side-link:has-text("People")');
  await settle(page);
  await page.locator('table tbody tr').first().locator('td').nth(1).click();
  await settle(page);
  const recIdx = await page.evaluate(() => history.state.clozrIdx);
  check('record opened from People carries from=people in history.state', await page.evaluate(() => history.state.clozrFrom) === 'people');
  await page.locator('button.ds-back').first().click();
  await settle(page);
  check('Back link returns to People by stepping back', pathOf(page) === '/demo/people' && await page.evaluate(() => history.state.clozrIdx) === recIdx - 1, [pathOf(page), recIdx]);
  await page.goForward({ waitUntil: 'commit' });
  await settle(page);
  check('…and Forward reopens the record with its from', /^\/demo\/people\/p\d+$/.test(pathOf(page)) && await page.evaluate(() => history.state.clozrFrom) === 'people');
  // Reloaded, the record's Back link still knows where it came from (People
  // names the smart list it was opened from).
  const backLabel = await page.locator('button.ds-back').first().getAttribute('aria-label');
  await page.reload({ waitUntil: 'load' });
  await ready(page);
  check('after a reload the Back link says the same', (await page.locator('button.ds-back').first().getAttribute('aria-label')) === backLabel, [backLabel, await page.locator('button.ds-back').first().getAttribute('aria-label')]);
  await page.locator('button.ds-back').first().click();
  await settle(page);
  check('after a reload the Back link goes to People', pathOf(page) === '/demo/people', pathOf(page));
  await mark(page);
  const docsNow = seen.docs.length;

  // A path anchor and an old #screen= anchor in the page move in the app.
  await page.evaluate(() => {
    const add = (id, href, left) => { const a = document.createElement('a'); a.id = id; a.href = href; a.textContent = id; a.style.cssText = `position:fixed;top:4px;left:${left}px;z-index:99999;background:#fff;padding:4px`; document.body.appendChild(a); };
    add('e2e-path', '/demo/tasks', 560); add('e2e-hash', '#screen=buyers&from=reporting', 700);
  });
  await go('path anchor clicked', () => page.click('#e2e-path'), '/demo/tasks', 'Tasks · CLOZR');
  await go('old #screen= anchor clicked', () => page.click('#e2e-hash'), '/demo/buyers', 'Buyers · CLOZR');
  check('anchors: no document load', seen.docs.length === docsNow, seen.docs.slice(docsNow));
  check('anchors: marker alive', await alive(page));

  // A modified click keeps the browser's new tab; this tab stays put.
  const before = pathOf(page);
  const [popup] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null),
    page.click('a.cz-side-link:has-text("Calendar")', { modifiers: ['ControlOrMeta'] }),
  ]);
  await settle(page);
  check('ctrl-click opens a new tab', !!popup);
  if (popup) {
    await popup.waitForLoadState('load');
    check('the new tab opens the path', new URL(popup.url()).pathname === '/demo/calendar', popup.url());
    await popup.close();
  }
  check('ctrl-click leaves this tab where it was', pathOf(page) === before && await alive(page), pathOf(page));

  // Hard reload on a deep record path lands on the same record.
  await page.goto(base + '/demo/people/p3', { waitUntil: 'load' });
  await ready(page);
  const p3Title = await page.title();
  check('deep link to a seller opens it', pathOf(page) === '/demo/people/p3' && !/^People ·/.test(p3Title), [pathOf(page), p3Title]);
  if (shots) {
    await page.screenshot({ path: path.join(shots, 'desk-1440-record.png') });
  }
  await page.reload({ waitUntil: 'load' });
  await ready(page);
  check('reload on a seller keeps it', pathOf(page) === '/demo/people/p3' && (await page.title()) === p3Title, [pathOf(page), await page.title()]);
  // A deal-keyed TC path: the seller rides in history.state and survives the reload.
  await page.click('a.cz-side-link:has-text("Deals")');
  await settle(page);
  await page.getByRole('button', { name: 'Transaction coordination' }).first().click();
  await settle(page);
  const tcPath = pathOf(page);
  const tcTitle = await page.title();
  await page.reload({ waitUntil: 'load' });
  await ready(page);
  check('reload on a TC file keeps it', pathOf(page) === tcPath && (await page.title()) === tcTitle, [tcPath, pathOf(page), tcTitle, await page.title()]);
  // The same TC path opened fresh (no history.state): the seller comes from the deal.
  const fresh = await ctx.newPage();
  await fresh.goto(base + tcPath, { waitUntil: 'load' });
  await ready(fresh);
  check('a TC path opened in a new tab opens the file', pathOf(fresh) === tcPath && (await fresh.title()) === tcTitle, [pathOf(fresh), await fresh.title()]);
  await fresh.close();

  // Old links become their path.
  await page.goto(base + '/demo#screen=person&id=p2&from=deals', { waitUntil: 'load' });
  await ready(page);
  check('old #screen=person link becomes /demo/people/p2', pathOf(page) === '/demo/people/p2', pathOf(page));
  check('its from moved into history.state', await page.evaluate(() => history.state.clozrFrom) === 'deals');
  check('old link: the record opened', !/^People ·/.test(await page.title()), await page.title());
  await page.goto(base + '/demo#screen=talkr', { waitUntil: 'load' });
  await ready(page);
  check('old #screen=talkr opens the dialer', pathOf(page) === '/demo/dialer', pathOf(page));
  await page.goto(base + '/demo?as=owner&buyer=999999', { waitUntil: 'load' });
  await ready(page);
  check('old ?buyer= link: its query goes, ?as= stays', pathOf(page) === '/demo/buyers?as=owner', pathOf(page));
  await page.goto(base + '/demo/nope', { waitUntil: 'load' });
  await ready(page);
  check('unknown path lands on the landing', pathOf(page) === '/demo/home', pathOf(page));
  check('…and says why', (await page.content()).includes('That link doesn’t point to a CLOZR screen'));
  await page.goto(base + '/demo/people/', { waitUntil: 'load' });
  await ready(page);
  check('trailing slash', pathOf(page) === '/demo/people', pathOf(page));
  if (shots) await page.screenshot({ path: path.join(shots, 'desk-1440-side-nav.png') });

  // The marketing page forwards an old app hash to /app.
  const root = await ctx.newPage();
  const rootDocs = watch(root);
  await root.goto(base + '/#screen=coaching', { waitUntil: 'load' });
  await root.waitForTimeout(1500);
  check('/#screen= is forwarded to /app', rootDocs.docs.some((u) => new URL(u).pathname === '/app'), rootDocs.docs);
  await root.close();

  check('no page errors on the desk', errors.length === 0, errors.slice(0, 3));
  await ctx.close();
}

/** The row the side nav lights: its link text, or '' when none is lit. */
const litRow = (page) => page.evaluate(() => {
  const on = [...document.querySelectorAll('.cz-side a.cz-side-link[aria-current="page"], .cz-side button.cz-side-link[aria-current="page"]')];
  return on.map((a) => a.textContent.trim()).join('|');
});

async function runNavModel(browser, base, shots) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const seen = watch(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + '/demo', { waitUntil: 'load' });
  await ready(page);
  let docs = seen.docs.length;
  await mark(page);

  // Every place has a row on the desk, under the labels the phone uses too.
  const rows = await page.locator('.cz-side .cz-side-link').allTextContents();
  const labels = rows.map((t) => t.replace(/\d+$/, '').trim());
  for (const want of ['Today', 'Home', 'People', 'Inbox', 'Dialer', 'Tasks', 'Calendar', 'Deals', 'Contracts', 'Dispo', 'Buyers',
    'Action plans', 'Reporting', 'Coaching', 'Leaderboard', 'COMPR', 'Lane', 'Buyr', 'Campaigns', 'Deal Machine', 'Live database',
    'Import', 'Automations', 'Settings', 'Ask CLOZR']) {
    check(`desk nav has ${want}`, labels.includes(want), labels);
  }
  check('desk nav: no Phone or Talkr row', !labels.some((l) => /^(Phone|Talkr)$/.test(l)));
  check('desk nav: Home beside Today, landing first', labels.indexOf('Home') === 0 && labels.indexOf('Today') === 1, labels.slice(0, 3));

  // The open side nav fits a 1440x900 window: Tools start folded, and every row drawn sits above the foot.
  const toggle = page.locator('.cz-side .cz-side-toggle');
  check('Tools start folded', await toggle.getAttribute('aria-expanded') === 'false');
  const fit = await navOverflow(page);
  check('1440x900, nav open: every visible row is above the foot, no scrolling', !fit.below.length && fit.scroll <= 0, fit);
  for (const [label, w, h] of [['1440x900', 1440, 900]]) {
    await page.evaluate(() => localStorage.setItem('clozr.sidenav.folded', '1'));
    await page.setViewportSize({ width: w, height: h });
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    const f = await navOverflow(page);
    check(`${label}, nav folded: every visible row is above the foot`, !f.below.length && f.scroll <= 0, f);
    if (shots) await page.screenshot({ path: path.join(shots, `desk-${w}-nav-folded.png`) });
  }
  await page.evaluate(() => localStorage.setItem('clozr.sidenav.folded', '0'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: 'load' });
  await ready(page);
  await mark(page);
  await toggle.click();
  await settle(page, 300);
  check('the Tools toggle unfolds them', await toggle.getAttribute('aria-expanded') === 'true' && await page.locator('.cz-side a.cz-side-link:has-text("Live database")').isVisible());
  await toggle.click();
  await settle(page, 300);
  check('…and folds them again', await toggle.getAttribute('aria-expanded') === 'false' && !(await page.locator('.cz-side a.cz-side-link:has-text("Live database")').isVisible()));
  // A tool on view keeps Tools open even when they were folded.
  await page.goto(base + '/demo/database', { waitUntil: 'load' });
  await ready(page);
  check('a tool on view unfolds Tools', await toggle.getAttribute('aria-expanded') === 'true' && await toggle.isDisabled() && (await litRow(page)) === 'Live database', await litRow(page));
  await page.goto(base + '/demo/home', { waitUntil: 'load' });
  await ready(page);
  check('leaving the tool folds them again (the choice was folded)', await toggle.getAttribute('aria-expanded') === 'false');
  await mark(page);
  docs = seen.docs.length;

  // Each screen lights its own row; records and Account light the one they sit under.
  const side = (label) => page.locator(`.cz-side a.cz-side-link:has-text("${label}")`).first();
  for (const [label, path, lit] of [
    ['Action plans', '/demo/plans', 'Action plans'], ['Automations', '/demo/automations', 'Automations'],
    ['Leaderboard', '/demo/leaderboard', 'Leaderboard'], ['Import', '/demo/import', 'Import'],
    ['Live database', '/demo/database', 'Live database'], ['Settings', '/demo/settings/workspace/general', 'Settings'],
  ]) {
    await openTools(page);
    await side(label).click();
    await settle(page);
    check(`${label}: address`, pathOf(page) === path, pathOf(page));
    check(`${label}: lights its own row`, (await litRow(page)) === lit, await litRow(page));
    check(`${label}: title`, (await page.title()) === `${label} · CLOZR`, await page.title());
  }

  // Settings: a section pushes, survives a reload, and Back returns to the section before.
  const idx0 = await page.evaluate(() => history.state.clozrIdx);
  await page.locator('nav[aria-label="Settings"] button', { hasText: /^Numbers$/ }).click();
  await settle(page);
  check('Settings section: address', pathOf(page) === '/demo/settings/dialer/numbers', pathOf(page));
  check('Settings section: pushes', await page.evaluate(() => history.state.clozrIdx) === idx0 + 1);
  check('Settings section: the pane shows it', await page.locator('[data-settings-pane] h2', { hasText: /^Numbers$/ }).count() === 1);
  check('Settings: the Dialer group, no Talkr group', await page.locator('nav[aria-label="Settings"] [role="group"][aria-label="Dialer"]').count() === 1
    && await page.locator('nav[aria-label="Settings"] [role="group"][aria-label="Talkr"]').count() === 0);
  check('Settings: the You group', await page.locator('nav[aria-label="Settings"] [role="group"][aria-label="You"] button').allTextContents()
    .then((t) => t.join('|') === 'Account|Audio & sounds|Notifications'));
  await page.locator('nav[aria-label="Settings"] button', { hasText: /^Account$/ }).click();
  await settle(page);
  check('Settings › You › Account: address', pathOf(page) === '/demo/settings/you/account', pathOf(page));
  check('Settings › You › Account: lights Settings', (await litRow(page)) === 'Settings', await litRow(page));
  check('Settings › You › Account: the Account pane', await page.locator('[data-settings-pane] h2', { hasText: /^Account$/ }).count() === 1);
  if (shots) await page.screenshot({ path: path.join(shots, 'desk-1440-settings-account.png') });
  await page.goBack({ waitUntil: 'commit' });
  await settle(page);
  check('Settings: Back to the section before', pathOf(page) === '/demo/settings/dialer/numbers', pathOf(page));
  check('Settings: Back shows it', await page.locator('[data-settings-pane] h2', { hasText: /^Numbers$/ }).count() === 1);
  check('Settings: Back is no reload', seen.docs.length === docs && await alive(page));
  await page.reload({ waitUntil: 'load' });
  await ready(page);
  check('Settings: reload keeps the section', pathOf(page) === '/demo/settings/dialer/numbers'
    && await page.locator('[data-settings-pane] h2', { hasText: /^Numbers$/ }).count() === 1, pathOf(page));
  await page.goto(base + '/demo/settings/sequences/plans', { waitUntil: 'load' });
  await ready(page);
  check('old Settings › Sequences › Action plans opens Action plans', pathOf(page) === '/demo/plans', pathOf(page));
  await page.goto(base + '/demo/settings', { waitUntil: 'load' });
  await ready(page);
  check('bare /demo/settings opens the section last open in this tab', pathOf(page) === '/demo/settings/dialer/numbers', pathOf(page));

  // Reporting: a tab pushes and comes back on reload; the report emails' link opens Custom reports.
  const tabOn = (label) => page.locator('[data-tabs] button', { hasText: new RegExp(`^${label}$`) }).first()
    .evaluate((b) => !/transparent/.test(b.style.borderBottom));
  await page.goto(base + '/demo/reporting', { waitUntil: 'load' });
  await ready(page);
  const r0 = await page.evaluate(() => history.state.clozrIdx);
  await page.locator('[data-tabs] button', { hasText: /^Team$/ }).first().click();
  await settle(page);
  check('Reporting tab: address', pathOf(page) === '/demo/reporting/team', pathOf(page));
  check('Reporting tab: pushes', await page.evaluate(() => history.state.clozrIdx) === r0 + 1);
  await page.reload({ waitUntil: 'load' });
  await ready(page);
  check('Reporting tab: reload keeps it', pathOf(page) === '/demo/reporting/team' && await tabOn('Team'), pathOf(page));
  await page.goBack({ waitUntil: 'commit' });
  await settle(page);
  check('Reporting tab: Back to the first tab', pathOf(page) === '/demo/reporting' && await tabOn('Overview'), pathOf(page));
  await page.goto(base + '/demo/reporting/custom', { waitUntil: 'load' });
  await ready(page);
  check('/reporting/custom (the report emails) opens Custom reports', pathOf(page) === '/demo/reporting/custom' && await tabOn('Custom reports'), pathOf(page));
  if (shots) await page.screenshot({ path: path.join(shots, 'desk-1440-reporting-custom.png') });

  // Inbox: a channel replaces the entry, so Back leaves the Inbox.
  await page.goto(base + '/demo/deals', { waitUntil: 'load' });
  await ready(page);
  await side('Inbox').click();
  await settle(page);
  const i0 = await page.evaluate(() => history.state.clozrIdx);
  await page.locator('[role="tab"]', { hasText: /^SMS$/ }).first().click();
  await settle(page);
  check('Inbox channel: address', pathOf(page) === '/demo/inbox/sms', pathOf(page));
  check('Inbox channel: replaces', await page.evaluate(() => history.state.clozrIdx) === i0);
  await page.reload({ waitUntil: 'load' });
  await ready(page);
  check('Inbox channel: reload keeps it', pathOf(page) === '/demo/inbox/sms'
    && await page.locator('[role="tab"][aria-selected="true"]', { hasText: /^SMS$/ }).count() >= 1, pathOf(page));
  await page.goBack({ waitUntil: 'commit' });
  await settle(page);
  check('Inbox channel: Back leaves the Inbox', pathOf(page) === '/demo/deals', pathOf(page));

  // Contracts. The sample data draws one deal summary and no tab strip (the
  // hub's tabs need a workspace), so here the addresses are checked: a tab
  // and a contract link land on Contracts and keep their address; the push
  // and replace rule is tools/routes.test.ts's.
  for (const p of ['/demo/contracts/terms', '/demo/contracts/summaries', '/demo/contracts/k123']) {
    await page.goto(base + p, { waitUntil: 'load' });
    await ready(page);
    check(`${p} opens Contracts`, pathOf(page) === p && (await page.title()) === 'Contracts · CLOZR' && (await litRow(page)) === 'Contracts', [pathOf(page), await page.title()]);
    check(`${p} is not an unknown link`, !(await page.content()).includes('That link doesn’t point to a CLOZR screen'));
  }
  if (shots) await page.screenshot({ path: path.join(shots, 'desk-1440-contracts-k123.png') });

  // The command bar names places as the nav does, and offers Campaigns.
  await page.keyboard.press('Control+k');
  await settle(page, 400);
  await page.keyboard.type('campaigns');
  await settle(page, 400);
  check('⌘K offers Campaigns', (await page.locator('[role="dialog"]').first().textContent()).includes('Campaigns'));
  await page.keyboard.press('Escape');

  check('no page errors in the nav-model run', errors.length === 0, errors.slice(0, 3));
  await ctx.close();
}

async function runPhone(browser, base, shots) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const seen = watch(page);
  await page.goto(base + '/demo?as=acquisitions', { waitUntil: 'load' });
  await ready(page);
  check('phone: acquisitions lands on Today, ?as= kept', pathOf(page) === '/demo/today?as=acquisitions', pathOf(page));
  if (shots) await page.screenshot({ path: path.join(shots, 'phone-390-tabs.png') });
  const docs = seen.docs.length;
  const rsc = seen.rsc.length;
  await mark(page);
  const tab = (name) => page.locator('button', { hasText: new RegExp(`^${name}$`) }).last();
  await tab('People').tap();
  await settle(page);
  check('phone: People tab', pathOf(page) === '/demo/people?as=acquisitions', pathOf(page));
  await tab('Deals').tap();
  await settle(page);
  check('phone: Deals tab', pathOf(page) === '/demo/deals?as=acquisitions', pathOf(page));
  await tab('Tasks').tap();
  await settle(page);
  check('phone: Tasks tab', pathOf(page) === '/demo/tasks?as=acquisitions', pathOf(page));
  await page.goBack({ waitUntil: 'commit' });
  await settle(page);
  check('phone: Back', pathOf(page) === '/demo/deals?as=acquisitions', pathOf(page));
  await page.goBack({ waitUntil: 'commit' });
  await settle(page);
  check('phone: Back again', pathOf(page) === '/demo/people?as=acquisitions', pathOf(page));
  await page.goForward({ waitUntil: 'commit' });
  await settle(page);
  check('phone: Forward', pathOf(page) === '/demo/deals?as=acquisitions', pathOf(page));
  check('phone: no ?_rsc, no reload', seen.rsc.length === rsc && seen.docs.length === docs && await alive(page), [seen.rsc.slice(rsc), seen.docs.slice(docs)]);
  // More: the same names as the desk.
  await page.locator('nav[data-screen-label="Mobile tabs"] button', { hasText: /^More$/ }).tap();
  await settle(page);
  const more = await page.locator('.cz-more-row').allTextContents();
  check('phone More: Dialer, not Phone', more.includes('Dialer') && !more.includes('Phone'), more);
  check('phone More: Lane without a suffix', more.includes('Lane') && !more.some((t) => /TC AI/.test(t)), more);
  check('phone More: Home is there for acquisitions', more.includes('Home'), more);
  if (shots) await page.screenshot({ path: path.join(shots, 'phone-390-more.png') });
  await ctx.close();

  // A TC sees no People: its tabs are its landing and the lists it works
  // (the demo's ?as= takes owner, admin, acquisitions, dispositions, tc,
  // notary and member; partnerships' People-first tabs are nav-model.test's).
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pp = await pctx.newPage();
  await pp.goto(base + '/demo?as=tc', { waitUntil: 'load' });
  await ready(pp);
  const tabs = await pp.locator('nav[data-screen-label="Mobile tabs"] button').allTextContents();
  check('phone: tc lands on Home', pathOf(pp) === '/demo/home?as=tc', pathOf(pp));
  check('phone: tc tabs', tabs.join('|') === 'Home|Deals|Tasks|Inbox|More', tabs);
  check('phone: the landing tab is lit', await pp.locator('nav[data-screen-label="Mobile tabs"] button[aria-current="page"]').first().textContent() === 'Home');
  await pctx.close();
}

export async function run() {
  const url = arg('--url');
  const shots = arg('--shots');
  if (shots) fs.mkdirSync(shots, { recursive: true });
  let server = null;
  let base = url;
  if (!base) {
    if (!fs.existsSync(path.join(ROOT, 'demo.html'))) { console.error('No build in dist/client: run pnpm build first.'); process.exit(1); }
    server = await serve(0);
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
    args: ['--no-sandbox'],
  });
  try {
    await runDesk(browser, base, shots);
    await runNavModel(browser, base, shots);
    await runPhone(browser, base, shots);
  } catch (e) {
    failed++;
    console.log('FAIL  run stopped: ' + (e?.stack ?? e));
  } finally {
    await browser.close();
    server?.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

if (arg('--serve')) {
  if (!fs.existsSync(path.join(ROOT, 'demo.html'))) { console.error('No build in dist/client: run pnpm build first.'); process.exit(1); }
  await serve(Number(arg('--serve')));
  console.log(`serving dist/client on http://127.0.0.1:${arg('--serve')}`);
} else {
  await run();
}
