// The app paths the edge functions write (supabase/functions/_shared/app-paths.ts)
// are a copy of lib/routes.ts for Deno. Every path they build must parse back
// through parsePath to the screen and record it means, and the SQL copy in the
// webhook_record_paths migration must write the same links.
// Run: npx tsx tools/app-paths.test.ts
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_BASE, appLink, appPath, isOwnCalendarLink } from '../supabase/functions/_shared/app-paths';
import { parsePath, type Route } from '../lib/routes';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const R = (screen: Route['screen'], id: string | null = null, deal: string | null = null, tab: string | null = null): Route => ({ screen, id, deal, tab });

test('the base is the app the route table reads', () => {
  assert.equal(APP_BASE, '/app');
  assert.equal(appPath.base, '/app');
});

test('each record path parses back to its screen and record', () => {
  for (const id of [1, 42, '7', ' 815 ', '123456789012345678']) {
    const n = String(id).trim();
    assert.deepEqual(parsePath(appPath.seller(id)), R('person', 's' + n), `seller ${id}`);
    assert.deepEqual(parsePath(appPath.buyer(id)), R('buyer', 'b' + n), `buyer ${id}`);
    assert.deepEqual(parsePath(appPath.deal(id)), R('dealSheet', null, 'd' + n), `deal ${id}`);
    assert.deepEqual(parsePath(appPath.contract(id)), R('contracts', 'k' + n), `contract ${id}`);
  }
  assert.equal(appPath.seller(12), '/app/people/s12');
  assert.equal(appPath.buyer(45), '/app/buyers/b45');
  assert.equal(appPath.deal(7), '/app/deals/d7');
  assert.equal(appPath.contract(123), '/app/contracts/k123');
});

test('a missing or junk id links to the list, never to nothing', () => {
  for (const id of [null, undefined, '', 'abc', -1, 1.5, '12; drop', 's12', NaN, Infinity, '1'.repeat(19)]) {
    assert.deepEqual(parsePath(appPath.seller(id)), R('people'), `seller ${String(id)}`);
    assert.deepEqual(parsePath(appPath.buyer(id)), R('buyers'), `buyer ${String(id)}`);
    assert.deepEqual(parsePath(appPath.deal(id)), R('deals'), `deal ${String(id)}`);
    assert.deepEqual(parsePath(appPath.contract(id)), R('contracts'), `contract ${String(id)}`);
  }
});

test('each screen path parses back to its screen', () => {
  assert.deepEqual(parsePath(appPath.coaching), R('coaching'));
  assert.deepEqual(parsePath(appPath.calendar), R('calendar'));
  assert.deepEqual(parsePath(appPath.tasks), R('tasks'));
  assert.deepEqual(parsePath(appPath.customReports), R('reporting', null, null, 'custom'));
  assert.deepEqual(parsePath(appPath.deliverability), R('settings', null, null, 'email/deliverability'));
  assert.deepEqual(parsePath(appPath.campaigns), R('campaigns'));
  assert.deepEqual(parsePath(appPath.dispo), R('dispo'));
});

test('an absolute link is the origin plus the path, whatever the origin ends with', () => {
  assert.equal(appLink('https://clozr.app', appPath.seller(12)), 'https://clozr.app/app/people/s12');
  assert.equal(appLink('https://clozr.app/', appPath.coaching), 'https://clozr.app/app/coaching');
  assert.equal(appLink('https://clozr.app//', appPath.base), 'https://clozr.app/app');
  const u = new URL(appLink('http://localhost:3000/', appPath.deal(7)));
  assert.deepEqual(parsePath(u.pathname), R('dealSheet', null, 'd7'));
});

test('the calendar pull knows our own links, old and new, and nothing else', () => {
  for (const line of [
    'https://your-clozr-site.example.com/clozr/', 'http://localhost:3000/clozr',
    appLink('https://your-clozr-site.example.com', appPath.seller(12)), appLink('https://clozr.app', appPath.buyer(9)),
    appLink('https://clozr.app', appPath.calendar), appLink('https://clozr.app', appPath.tasks), '  https://clozr.app/app/tasks  ',
  ]) assert.ok(isOwnCalendarLink(line), line);
  for (const line of [
    'Bring the comps', 'https://zillow.com/homedetails/123', 'https://clozr.app/app/people', 'https://clozr.app/app/deals/d7',
    'Notes: https://clozr.app/app/people/s12', 'https://clozr.app/app/people/s12 call first', 'Ann Lee — 12 Oak St',
  ]) assert.ok(!isOwnCalendarLink(line), line);
});

test('the webhook SQL writes the same links as the functions', () => {
  const dir = join(HERE, '../supabase/migrations');
  const file = readdirSync(dir).find((f) => /^\d+_webhook_record_paths\.sql$/.test(f));
  assert.ok(file, 'webhook_record_paths migration exists');
  const sql = readFileSync(join(dir, file!), 'utf8');
  const forms = Object.fromEntries([...sql.matchAll(/when p_kind = '(\w+)' then '([^']+)' \|\| p_id/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(forms).sort(), ['buyer', 'deal', 'seller']);
  const origin = 'https://your-clozr-site.example.com';
  for (const kind of ['seller', 'deal', 'buyer'] as const) {
    const link = forms[kind] + '42';
    assert.equal(link, appLink(origin, appPath[kind](42)), kind);
    assert.ok(parsePath(new URL(link).pathname), `${kind} parses`);
  }
  assert.match(sql, /else 'https:\/\/your-clozr-site\.example\.com\/app'/);
});

test('the shared file has no Deno global, so the app tests can import it', () => {
  const src = readFileSync(join(HERE, '../supabase/functions/_shared/app-paths.ts'), 'utf8');
  assert.ok(!/\bDeno\b/.test(src.replace(/^\s*\/\/.*$/gm, '')));
});

console.log(`app-paths: ${passed} passed`);
