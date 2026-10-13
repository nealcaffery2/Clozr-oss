// Unsubscribe tokens, and the verification gate on a send.
// Run:  deno run --allow-env supabase/functions/_shared/mailguard.test.ts
import { blockUnverified, emailSafety, guardSend, guardSendResend, readUnsubscribeToken, unsubscribeToken, type GuardOptions } from './mailguard.ts';
import type { SendKind } from './deliverability-rules.ts';

Deno.env.set('UNSUBSCRIBE_SECRET', 'test-secret');
const t = await unsubscribeToken({ w: 11, e: 'kara@example.com', a: 3 });
const back = await readUnsubscribeToken(t);
if (JSON.stringify(back) !== JSON.stringify({ w: 11, e: 'kara@example.com', a: 3 })) throw new Error(`round-trip failed: ${JSON.stringify(back)}`);
const [, sig] = t.split('.');
const forged = `${btoa(JSON.stringify({ w: 11, e: 'someone@else.com', a: 3 })).replace(/=+$/, '')}.${sig}`;
if (await readUnsubscribeToken(forged)) throw new Error('a token with an edited address was accepted');
if (await readUnsubscribeToken('garbage')) throw new Error('garbage accepted');
Deno.env.set('UNSUBSCRIBE_SECRET', 'rotated');
if (await readUnsubscribeToken(t)) throw new Error('a token signed with another secret was accepted');
console.log('mailguard tokens: ok');

// ---------------------------------------------------------------- gate
let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

eq('no rows is unverified', emailSafety([]), 'unverified');
eq('null is unverified', emailSafety([null, null]), 'unverified');
eq('a true anywhere is safe', emailSafety([false, null, true]), 'safe');
eq('every row false is unsafe', emailSafety([false, false]), 'unsafe');
eq('false mixed with null is not known-bad', emailSafety([false, null]), 'unverified');

eq('unsafe bulk is refused', blockUnverified('unsafe', 'bulk', {}), true);
eq('unsafe one-to-one is refused', blockUnverified('unsafe', 'one_to_one', {}), true);
eq('unverified bulk still sends', blockUnverified('unverified', 'bulk', {}), false);
eq('unverified one-to-one still sends', blockUnverified('unverified', 'one_to_one', {}), false);
eq('require_verified_email refuses a null on bulk', blockUnverified('unverified', 'bulk', { requireVerified: true }), true);
eq('require_verified_email leaves one-to-one alone', blockUnverified('unverified', 'one_to_one', { requireVerified: true }), false);
eq('allowUnverified sends a known-bad address', blockUnverified('unsafe', 'bulk', { allowUnverified: true, requireVerified: true }), false);
eq('transactional mail is exempt', blockUnverified('unsafe', 'transactional', { requireVerified: true }), false);
eq('a safe address is not refused', blockUnverified('safe', 'bulk', { requireVerified: true }), false);

type Row = { id?: number; email?: string; email_key?: string; email_safe_to_send?: boolean | null; buyer_id?: number };
type TableSpec = Row[] | { error: string };

const MAILBOX = {
  account_id: 3, workspace_id: 7, daily_cap: 500, hourly_cap: 100, min_gap_seconds: 0,
  window_start: 0, window_end: 24, window_days: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC',
  ramp_enabled: false, ramp_start: 50, ramp_increase_pct: 0, ramp_target: 500, ramp_started_on: '2020-01-01',
  paused: false, paused_reason: null, paused_at: null, paused_auto: false,
};
const account = { id: 3, workspace_id: 7, email: 'rep@gmail.com' };

function fakeAdmin(tables: Record<string, TableSpec>, settings: Record<string, unknown> = {}) {
  const seen: string[] = [];
  let claims = 0;
  const from = (name: string) => {
    seen.push(name);
    const q: {
      select: () => typeof q; eq: () => typeof q; in: () => typeof q; or: () => typeof q; upsert: () => typeof q;
      maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise<unknown>;
    } = {
      select: () => q, eq: () => q, in: () => q, or: () => q, upsert: () => q,
      maybeSingle: () => Promise.resolve(finish()),
      then: (res, rej) => Promise.resolve(finish()).then(res, rej),
    };
    const finish = () => {
      if (name === 'workspaces') return { data: { settings }, error: null };
      if (name === 'mailbox_settings') return { data: MAILBOX, error: null };
      if (name === 'email_suppressions') return { data: [], error: null };
      const spec = tables[name];
      if (spec && !Array.isArray(spec)) return { data: null, error: { message: spec.error } };
      return { data: spec ?? [], error: null };
    };
    return q;
  };
  return {
    seen, claims: () => claims,
    from, rpc: () => { claims++; return Promise.resolve({ data: { ok: true, ids: [9], today: 0, last_hour: 0, hour_oldest: null, last_sent_at: null }, error: null }); },
  };
}

const BAD = [{ email: 'bad@example.com', email_safe_to_send: false }];
const SAFE = [{ email: 'ok@example.com', email_safe_to_send: true }];
const NULLS = [{ email: 'new@example.com', email_safe_to_send: null }];

async function send(kind: SendKind, tables: Record<string, TableSpec>, opts: GuardOptions = {}, settings: Record<string, unknown> = {}, to = 'bad@example.com') {
  const admin = fakeAdmin(tables, settings);
  const guard = await guardSend(admin as never, account, [to], kind, opts);
  return { guard, admin };
}

{
  const { guard, admin } = await send('one_to_one', { buyers: SAFE, buyer_emails: [], buyer_contacts: [], sellers: [] }, {}, {}, 'ok@example.com');
  eq('a safe address is claimed', [guard.ok, admin.claims()], [true, 1]);
}
{
  const { guard, admin } = await send('bulk', { buyers: BAD, buyer_emails: BAD, buyer_contacts: [], sellers: BAD });
  eq('known-bad is unverified_unsafe and not claimed', [guard.ok, !guard.ok && guard.code, admin.claims()], [false, 'unverified_unsafe', 0]);
}
{
  const { guard, admin } = await send('one_to_one', { buyers: NULLS, buyer_emails: [], buyer_contacts: [], sellers: [] }, {}, {}, 'new@example.com');
  eq('a null address still sends', [guard.ok, admin.claims()], [true, 1]);
}
{
  const { guard, admin } = await send('bulk', {}, {}, {}, 'nobody@example.com');
  eq('an address on no row still sends', [guard.ok, admin.claims()], [true, 1]);
}
{
  const { guard, admin } = await send('bulk', { buyers: BAD, buyer_emails: [], buyer_contacts: [], sellers: [] }, { allowUnverified: true });
  eq('allowUnverified overrides a known-bad address', [guard.ok, admin.claims(), admin.seen.includes('buyers')], [true, 1, false]);
}
{
  const { guard, admin } = await send('transactional', { buyers: BAD, buyer_emails: BAD, buyer_contacts: BAD, sellers: BAD });
  eq('transactional mail ignores a known-bad address', [guard.ok, admin.claims(), admin.seen.includes('buyers')], [true, 1, false]);
}
{
  const { guard, admin } = await send('bulk', { buyers: NULLS, buyer_emails: [], buyer_contacts: [], sellers: [] }, {}, { require_verified_email: true }, 'new@example.com');
  eq('require_verified_email refuses a null bulk recipient', [guard.ok, !guard.ok && guard.code, admin.claims()], [false, 'unverified_unsafe', 0]);
}
{
  const { guard, admin } = await send('one_to_one', { buyers: NULLS }, {}, { require_verified_email: true }, 'new@example.com');
  eq('require_verified_email does not refuse one-to-one', [guard.ok, admin.claims()], [true, 1]);
}
{
  const { guard } = await send('one_to_one', {
    buyers: [{ email: 'mix@example.com', email_safe_to_send: false }],
    sellers: [{ email: 'mix@example.com', email_safe_to_send: null }],
  }, {}, {}, 'mix@example.com');
  eq('one false row is not enough when another is null', guard.ok, true);
}
{
  const { guard, admin } = await send('bulk', { buyers: { error: 'column email_safe_to_send does not exist' } }, {}, {}, 'ok@example.com');
  eq('a missing verification column does not block the send', [guard.ok, admin.claims()], [true, 1]);
}
{
  const admin = fakeAdmin({ buyers: BAD, buyer_emails: [], buyer_contacts: [], sellers: [] });
  const guard = await guardSendResend(admin as never, { id: 4, workspace_id: 7 } as never, ['bad@example.com'], 'one_to_one');
  eq('resend guard refuses the same known-bad address', [guard.ok, !guard.ok && guard.code, admin.claims()], [false, 'unverified_unsafe', 0]);
}

if (failed) { console.log(`\n${failed} FAILED`); Deno.exit(1); }
console.log('\nmailguard: ok');
