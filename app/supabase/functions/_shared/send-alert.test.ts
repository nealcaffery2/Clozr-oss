// Send-failure alerts: an auto-pause rings the owner's bell and emails them,
// once per mailbox per hour.  Run:  deno run --allow-env send-alert.test.ts
import { alertPause, alertSendFailure, ALERT_EVERY_MS } from './send-alert.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

// deno-lint-ignore no-explicit-any
type Any = any;
// A Supabase client over in-memory tables: eq / gte / limit / maybeSingle / insert.
function fakeAdmin(tables: Record<string, Any[]>) {
  return {
    from(t: string) {
      const filters: ((r: Any) => boolean)[] = [];
      let max = Infinity;
      const field = (r: Any, k: string) => k.includes('->>') ? r[k.split('->>')[0]]?.[k.split('->>')[1]] : r[k];
      const rows = () => (tables[t] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, max);
      const q: Any = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push((r) => field(r, k) === v); return q; },
        gte: (k: string, v: string) => { filters.push((r) => r[k] >= v); return q; },
        limit: (n: number) => { max = n; return q; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        insert: async (row: Any) => { (tables[t] ??= []).push({ ...row, created_at: new Date(now).toISOString() }); return { error: null }; },
        then: (ok: (v: Any) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
      };
      return q;
    },
  } as Any;
}

let now = Date.parse('2026-10-31T15:00:00Z');
const mails: Any[] = [];
globalThis.fetch = (async (_url: string, init: Any) => { mails.push(JSON.parse(init.body)); return new Response('{"id":"e1"}'); }) as Any;
Deno.env.set('RESEND_API_KEY', 're_test');
Deno.env.set('MAIL_FROM', 'CLOZR <alerts@clozr.app>');
Deno.env.set('APP_URL', 'https://clozr.app');

const tables: Record<string, Any[]> = {
  notifications: [],
  workspaces: [{ id: 13, owner_id: 'owner-1' }],
  profiles: [{ id: 'owner-1', email: 'owner@example.com' }],
};
const admin = fakeAdmin(tables);

// pause -> notify
eq('a pause rings the bell', await alertPause(admin, 13, 'cold_mailbox', 7, 'alex@deals.yourcompany.com', 'bounce rate 3.1% over 2%'), true);
const n = tables.notifications[0];
eq('for the workspace owner, as send_failure', [n.user_id, n.category, n.workspace_id], ['owner-1', 'send_failure', 13]);
eq('says what paused', n.title, 'alex@deals.yourcompany.com was auto-paused');
eq('and why', n.body.startsWith('Auto-paused: bounce rate 3.1% over 2%.'), true);
eq('one email to the owner', mails.map((m) => m.to), [['owner@example.com']]);
eq('linking Email deliverability', mails[0].html.includes('https://clozr.app/app/settings/email/deliverability'), true);

// throttle
now += ALERT_EVERY_MS - 60_000;
eq('the same mailbox again inside the hour: nothing', await alertSendFailure(admin, { ws: 13, key: 'cold_mailbox:7', title: 't', reason: 'r', path: '/app', place: 'p' }, now), false);
eq('a different mailbox still alerts', await alertPause(admin, 13, 'cold_mailbox', 8, 'm8@x.com', 'complaint'), true);
now += 120_000;
eq('the first mailbox after the hour alerts again', await alertSendFailure(admin, { ws: 13, key: 'cold_mailbox:7', title: 't', reason: 'r', path: '/app', place: 'p' }, now), true);
eq('three bell rows, three emails', [tables.notifications.length, mails.length], [3, 3]);

eq('no owner: no bell', await alertSendFailure(fakeAdmin({ workspaces: [{ id: 2, owner_id: null }] }), { ws: 2, key: 'k', title: 't', reason: 'r', path: '/app', place: 'p' }, now), false);

if (failed) { console.log(`${failed} failed`); Deno.exit(1); }
