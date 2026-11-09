// Nightly bug signals (scripts/bug-signals-lib.mjs): grouping production
// errors, masking personal data, device names, issue text, and the
// file / comment / skip decision against existing issues.
// Run: npx tsx tools/bug-signals.test.ts
import assert from 'node:assert/strict';
import {
  clientSignals, cronSignals, decide, deviceOf, function5xxSignals, functionErrorSignals, issueBody, issueTitle,
  mask, markerOf, normalizeMessage, screenOf, sortSignals, workflowSignal,
} from '../scripts/bug-signals-lib.mjs';
import { slopFindings } from '../supabase/functions/_shared/no-ai-slop';
import { RECORD_KEY, URL_SCREENS, pathFor } from '../lib/routes';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

test('mask hides emails and phone numbers', () => {
  assert.equal(mask('calendarId: "sam@yourcompany.com"'), 'calendarId: "<email>"');
  assert.equal(mask('texting +1 (512) 555-0134 now'), 'texting <phone> now');
  assert.equal(mask('tx: 90'), 'tx: 90');
});

test('mask hides credentials in URLs and long token runs', () => {
  const hex48 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
  assert.equal(mask(`at https://clozr.app/deal/sunny-lane?token=${hex48}&x=1`), 'at https://clozr.app/deal/sunny-lane?token=<redacted>&x=1');
  assert.equal(mask('GET /listing/r?t=abc123&u=https://x.co'), 'GET /listing/r?t=<redacted>&u=https://x.co');
  assert.equal(mask('/calendar-feed?token=short-one failed'), '/calendar-feed?token=<redacted> failed');
  assert.equal(mask('/auth#access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig&refresh_token=r1&code=c1'), '/auth#access_token=<redacted>&refresh_token=<redacted>&code=<redacted>');
  assert.equal(mask(`email-track/c/${hex48}:12:4`), 'email-track/c/<secret>:12:4');
  assert.equal(mask('key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), 'key <secret>.<secret>.<secret>');
  assert.equal(mask('a-very-long-hyphenated-component-name-without-digits stays'), 'a-very-long-hyphenated-component-name-without-digits stays');
  assert.equal(mask('at DealSheet (webpack-internal:///(app-pages-browser)/./components/deal-sheet/DealSheet.tsx:120:5)'), 'at DealSheet (webpack-internal:///(app-pages-browser)/./components/deal-sheet/DealSheet.tsx:120:5)');
  assert.equal(mask('https://clozr.app/_next/static/chunks/4bd1b696-8a7c2f0e1d3b5a9c.js:1:12345'), 'https://clozr.app/_next/static/chunks/4bd1b696-8a7c2f0e1d3b5a9c.js:1:12345');
  assert.equal(mask("Cannot read properties of undefined (reading 'DealSheet')"), "Cannot read properties of undefined (reading 'DealSheet')");
});

test('normalizeMessage groups the same error with different ids and numbers', () => {
  const a = normalizeMessage('Stale request cancelled (id=21d7630d-2f8d-47de-8a82-002b0a00252f, gen=105, current=106)');
  const b = normalizeMessage('Stale request cancelled (id=51d01851-3415-4b11-a3ea-fa8c3a8934fe, gen=1, current=2)');
  assert.equal(a, b);
  assert.equal(a, 'Stale request cancelled (id=<id>, gen=N, current=N)');
  const c = normalizeMessage("lane-listen file failed {\n  tx: 90,\n  err: 'Error: 400 invalid_request_error'");
  const d = normalizeMessage("lane-listen file failed {\n  tx: 4,\n  err: 'Error: 400 invalid_request_error'");
  assert.equal(c, d);
  assert.match(c, /invalid_request_error/, 'keeps the error after the first line');
  assert.ok(normalizeMessage('x'.repeat(500)).length <= 160);
});

test('screenOf drops record ids', () => {
  assert.equal(screenOf('/app#screen=dealSheet&id=s26180&deal=d5299'), 'dealSheet');
  assert.equal(screenOf('/app#screen=settings'), 'settings');
  assert.equal(screenOf('/sign/abc?x=1'), '/sign/abc');
  assert.equal(screenOf(null), null);
});

test('screenOf reads app paths, one group per screen', () => {
  assert.equal(screenOf('/app/people/s26180'), 'person');
  assert.equal(screenOf('/app/people/s1/d5299'), 'person');
  assert.equal(screenOf('/app/deals/d5299'), 'dealSheet');
  assert.equal(screenOf('/app/deals/d5299/tc'), 'tc');
  assert.equal(screenOf('/app/settings/dialer/numbers'), 'settings');
  assert.equal(screenOf('/app'), '/app');
  assert.equal(screenOf('/app/nope'), '/app/nope');
  assert.equal(screenOf('/app/constructor'), '/app/constructor');
  // The copy of the slug map agrees with lib/routes.ts for every screen.
  for (const screen of URL_SCREENS) {
    const id = RECORD_KEY[screen] ? (screen === 'buyer' ? 'b1' : screen === 'vendor' ? 'v1' : 's1') : null;
    assert.equal(screenOf(pathFor(screen, { id })), screen, screen);
    if (RECORD_KEY[screen] && screen !== 'buyer' && screen !== 'vendor') assert.equal(screenOf(pathFor(screen, { id, deal: 'd2' })), screen, screen + ' with a deal');
  }
});

test('deviceOf names phone vs computer and the browser', () => {
  assert.equal(deviceOf(IPHONE), 'iPhone · Safari');
  assert.equal(deviceOf(MAC_CHROME), 'Computer (Mac) · Chrome');
  assert.equal(deviceOf(WIN_EDGE), 'Computer (Windows) · Edge');
  assert.equal(deviceOf(ANDROID), 'Android phone · Chrome');
  assert.equal(deviceOf(null), 'Unknown device · Unknown browser');
});

const row = (over: Record<string, unknown>) => ({
  kind: 'promise', where_at: null, message: 'boom', stack: null, component_stack: null,
  path: '/app#screen=inbox', user_agent: MAC_CHROME, user_id: 'u1', created_at: '2026-10-25T10:00:00Z', ...over,
});

test('a crash card counts on its first occurrence', () => {
  const s = clientSignals([row({ kind: 'screen', where_at: 'dealSheet', message: "Cannot read properties of undefined (reading 'DealSheet')", path: '/app#screen=dealSheet&id=s1' })]);
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, 'screen_crash');
  assert.equal(s[0].title, "Screen crash on dealSheet: Cannot read properties of undefined (reading 'DealSheet')");
});

test('a credential in a client stack never reaches the issue text', () => {
  const rows = [row({ kind: 'screen', where_at: 'listing', stack: 'Error: boom\n    at render (https://clozr.app/listing/r?t=f00dbabef00dbabef00dbabef00dbabef00dbabe&u=x:1:2)' })];
  const [s] = clientSignals(rows);
  const body = issueBody(s, { hours: 24 });
  assert.doesNotMatch(body, /f00dbabe/);
  assert.match(body, /\?t=<redacted>/);
});

test('a stray rejection needs 3 hits or 2 people', () => {
  const one = [row({ message: 'Stale request cancelled (id=21d7630d-2f8d-47de-8a82-002b0a00252f, gen=1, current=2)' })];
  assert.equal(clientSignals(one).length, 0);
  const twoPeople = [...one, row({ user_id: 'u2', message: 'Stale request cancelled (id=51d01851-3415-4b11-a3ea-fa8c3a8934fe, gen=5, current=6)' })];
  assert.equal(clientSignals(twoPeople).length, 1);
  const three = [row({}), row({}), row({ user_agent: IPHONE })];
  const [s] = clientSignals(three);
  assert.equal(s.count, 3);
  assert.equal(s.people, 1);
  const devices = s.facts.find(([k]) => k === 'Devices')?.[1] ?? '';
  assert.match(devices, /Computer \(Mac\) · Chrome \(2\)/);
  assert.match(devices, /iPhone · Safari \(1\)/);
});

test('same error on two screens is two signals; fingerprints are stable', () => {
  const rows = [row({ kind: 'screen', where_at: 'inbox' }), row({ kind: 'screen', where_at: 'deals' })];
  const a = clientSignals(rows);
  assert.equal(a.length, 2);
  assert.notEqual(a[0].fp, a[1].fp);
  assert.deepEqual(clientSignals(rows).map((s) => s.fp), a.map((s) => s.fp));
});

test('function error logs group by function and normalized line, threshold 5', () => {
  const rows = [
    { fn: 'lane-listen', msg: "lane-listen file failed {\n tx: 90, err: 'Error: 400'", n: 3, last: '2026-10-25T10:00:00Z' },
    { fn: 'lane-listen', msg: "lane-listen file failed {\n tx: 4, err: 'Error: 400'", n: 3, last: '2026-10-25T11:00:00Z' },
    { fn: 'google-sync', msg: 'calendar pull skipped { calendarId: "a@b.co" }', n: 4, last: null },
  ];
  const s = functionErrorSignals(rows);
  assert.equal(s.length, 1);
  assert.equal(s[0].count, 6);
  assert.equal(s[0].last, '2026-10-25T11:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(functionErrorSignals(rows, 1)), /a@b\.co/, 'emails never reach an issue');
});

test('5xx groups per function with status hints', () => {
  const s = function5xxSignals([
    { fn: 'google-sync', status: 546, n: 236, last: '2026-10-25T10:00:00Z' },
    { fn: 'google-sync', status: 504, n: 51, last: '2026-10-25T12:00:00Z' },
    { fn: 'dispogenius-sync', status: 503, n: 1, last: null },
  ]);
  assert.equal(s.length, 1);
  assert.equal(s[0].count, 287);
  assert.match(s[0].facts[1][1], /^546 \(236\): killed for CPU time or memory, 504 \(51\): timed out$/);
});

test('sortSignals puts broken main and cron ahead of browser noise', () => {
  const sorted = sortSignals([
    ...clientSignals([row({}), row({}), row({})]),
    ...cronSignals([{ job: 'scheduled_kick', msg: 'ERROR: boom', n: 2, last: '2026-10-25T10:00:00Z' }]),
    workflowSignal({ name: 'CI', run_number: 7, html_url: 'https://x', head_sha: 'abcdef123', created_at: '2026-10-25T10:00:00Z' }),
  ]);
  assert.deepEqual(sorted.map((s) => s.kind), ['workflow', 'cron', 'browser_error']);
});

test('issue text carries the marker, reads plainly, and has no slop', () => {
  const [s] = function5xxSignals([{ fn: 'google-sync', status: 546, n: 300, last: '2026-10-25T10:00:00Z' }]);
  const body = issueBody(s, { hours: 24 });
  assert.equal(markerOf(body), s.fp);
  assert.match(body, /300 times in the last 24 hours/);
  const prose = body.replace(/```[\s\S]*?```/g, '').replace(/<!--.*?-->/g, '');
  assert.deepEqual(slopFindings(prose), []);
  assert.doesNotMatch(prose, /—/);
  const back = issueBody(s, { hours: 24, cameBackFrom: 12 });
  assert.match(back, /came back after #12/);
  const long = issueTitle({ ...s, title: 'x'.repeat(300) });
  assert.equal(long.length, 110);
});

test('decide: comment on open, skip not planned, new issue when a fix did not hold', () => {
  const [s] = cronSignals([{ job: 'j', msg: 'boom', n: 1, last: '2026-10-25T10:00:00Z' }]);
  const issue = (over: Record<string, unknown>) => ({ number: 5, state: 'open', state_reason: null, closed_at: null, body: `<!-- bug-signal:${s.fp} -->`, ...over });
  assert.equal(decide(s, []).action, 'create');
  assert.equal(decide(s, [issue({ body: 'other' })]).action, 'create');
  assert.equal(decide(s, [issue({})]).action, 'comment');
  assert.equal(decide(s, [issue({ state: 'closed', state_reason: 'not_planned', closed_at: '2026-10-20T00:00:00Z' })]).action, 'skip');
  assert.equal(decide(s, [issue({ state: 'closed', state_reason: 'completed', closed_at: '2026-10-20T00:00:00Z' })]).action, 'reopen-new');
  assert.equal(decide(s, [issue({ state: 'closed', state_reason: 'completed', closed_at: '2026-10-25T12:00:00Z' })]).action, 'skip');
  const newest = decide(s, [issue({ number: 3, state: 'closed', state_reason: 'completed', closed_at: '2026-10-01T00:00:00Z' }), issue({ number: 9 })]);
  assert.deepEqual([newest.action, newest.issue.number], ['comment', 9]);
});

console.log(`bug-signals: ${passed} passed`);
