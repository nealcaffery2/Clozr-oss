#!/usr/bin/env node
// Overflow check: no control a person can press sits past the right edge of
// the window.
//
// The audit of 2026-10 found header actions (People Import / New list, Tasks
// Task, Buyers Contracts, Buyer Send a deal, Leaderboard Badges / TV mode) and
// the phone record's More menu drawn beyond `innerWidth`, where the shell's
// overflow clipping made them impossible to reach. This script opens the main
// demo screens at 390x844 (phone) and 1024x768 (small laptop, side nav open)
// and fails when an enabled, visible button, link, input or select has its
// right edge past `innerWidth`.
//
// A control inside a sideways-scrolling container (overflow-x: auto | scroll,
// such as a wide table or a chip strip) is reachable by scrolling, so it does
// not count. Controls under `inert` or `aria-hidden="true"` do not count.
//
// This is a browser test, not a `tsx` unit test: it needs a running app and
// Playwright, so `npx tsx tools/*.test.ts` never picks it up.
//
// Run, from app/:
//   npx vinext dev --port 4377            # in another terminal
//   node tools/overflow.e2e.mjs           # or: CLOZR_URL=http://localhost:4377/demo node tools/overflow.e2e.mjs
//
// Options (env):
//   CLOZR_URL        the demo URL (default http://localhost:4377/demo)
//   SCREENS          comma list to check a subset (e.g. "people,tasks")
//   VIEWPORTS        "phone", "laptop" or both (default both)
//   PLAYWRIGHT_PATH  where to load Playwright from when it is not installed in
//                    app/ (e.g. /opt/node-tools/node_modules/playwright)
//
// Exit code 0 when every screen is clean, 1 when any control overflows, 2 when
// the app could not be opened.
//
// Screens are opened with the `#screen=<key>&id=<id>` address the app reads
// today. If navigation moves to paths, change `open()` below.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const t of tries) {
    try { return require(t); } catch { /* try the next one */ }
  }
  console.error('Playwright was not found. Install it (npm i -D playwright) or set PLAYWRIGHT_PATH.');
  process.exit(2);
}

const BASE = process.env.CLOZR_URL || 'http://localhost:4377/demo';

// [key, record id]. The record ids are the demo graph's.
const ALL_SCREENS = [
  ['home'], ['people'], ['person', 'p1'], ['inbox'], ['tasks'], ['calendar'], ['deals'], ['dealSheet', 'p2'],
  ['dispo'], ['dispoProperty', 'p6'], ['buyers'], ['buyer', 'b1'], ['tc', 'p6'], ['reporting'], ['plans'],
  ['automations'], ['leaderboard'], ['settings'], ['account'], ['campaigns'], ['coaching'], ['import'],
];

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  laptop: { viewport: { width: 1024, height: 768 } },
};

const pick = process.env.SCREENS ? new Set(process.env.SCREENS.split(',').map((s) => s.trim())) : null;
const screens = ALL_SCREENS.filter(([k]) => !pick || pick.has(k));
const vps = (process.env.VIEWPORTS || 'phone,laptop').split(',').map((s) => s.trim()).filter((v) => VIEWPORTS[v]);

async function settle(page) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    const { len, loading } = await page.evaluate(() => {
      const t = document.querySelector('main')?.innerText || '';
      return { len: t.length, loading: /Loading…|Opening the record/.test(t) };
    });
    if (len === last && len > 20 && !loading) break;
    last = len;
  }
  await page.waitForTimeout(300);
}

async function open(page, key, id) {
  await page.evaluate((h) => { window.location.hash = h; }, '#screen=' + key + (id ? '&id=' + id : ''));
  await settle(page);
}

/** Runs in the page: every enabled, visible control whose right edge passes innerWidth. */
function findOverflow() {
  const W = window.innerWidth;
  const out = [];
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem]';
  for (const el of document.querySelectorAll(sel)) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('[inert], [aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (r.right <= W + 1) continue;
    // Reachable when a sideways scroller that ends on screen holds it (scrollers
    // can nest: a chip strip inside a scrolling row). A clipping ancestor met
    // first (overflow hidden or clip) cuts it off for good.
    let reachable = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      const right = a.getBoundingClientRect().right;
      if ((ox === 'auto' || ox === 'scroll') && right <= W + 1) { reachable = true; break; }
      if ((ox === 'hidden' || ox === 'clip') && right < r.right) break;
    }
    if (reachable) continue;
    // Something fixed and fully off screen to the right (a closed drawer) is not on the page.
    if (r.left >= W && cs.position === 'fixed') continue;
    const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
    out.push({ name, left: Math.round(r.left), right: Math.round(r.right), width: W });
  }
  return out;
}

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  let failures = 0;
  try {
    for (const vp of vps) {
      const ctx = await browser.newContext(VIEWPORTS[vp]);
      // The side nav opens at 1024 too: the case the audit measured.
      await ctx.addInitScript(() => { try { localStorage.setItem('clozr.sidenav.folded', '0'); } catch { /* private mode */ } });
      const page = await ctx.newPage();
      page.setDefaultTimeout(240000);
      try {
        await page.goto(BASE, { waitUntil: 'load', timeout: 300000 });
      } catch (e) {
        console.error(`Could not open ${BASE}: ${e.message}. Start the dev server first.`);
        process.exit(2);
      }
      await settle(page);
      // The demo graph loads after first paint; until it does, a hash change
      // still shows the welcome screen. Wait for navigation to take.
      for (let i = 0; i < 60; i++) {
        await open(page, 'buyers');
        if (await page.evaluate(() => !/Welcome back/.test(document.querySelector('main')?.innerText || ''))) break;
        await page.evaluate(() => { window.location.hash = ''; });
        await page.waitForTimeout(500);
      }
      for (const [key, id] of screens) {
        await open(page, key, id);
        // Screens slide in (ScreenEnter); measure once it has finished, twice, and keep both.
        await page.waitForTimeout(700);
        const first = await page.evaluate(findOverflow);
        await page.waitForTimeout(500);
        const again = await page.evaluate(findOverflow);
        const seen = new Set();
        const bad = [...first, ...again].filter((b) => (seen.has(b.name + b.right) ? false : seen.add(b.name + b.right)));
        const label = `${vp.padEnd(6)} ${key}`;
        if (bad.length) {
          failures += bad.length;
          console.log(`FAIL ${label}`);
          for (const b of bad) console.log(`     "${b.name}" spans ${b.left}–${b.right}px, window is ${b.width}px`);
        } else {
          console.log(`ok   ${label}`);
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  if (failures) {
    console.log(`\n${failures} control${failures === 1 ? '' : 's'} past the right edge.`);
    process.exit(1);
  }
  console.log('\nEvery control is inside the window.');
}

main().catch((e) => { console.error(e); process.exit(2); });
