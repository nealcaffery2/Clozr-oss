// Reoon status mapping, a missing key, and power-mode requests. Fetch is mocked.
// Run:  deno run --allow-env supabase/functions/_shared/reoon.test.ts
import { MISSING_KEY_ERROR, VERIFY_PROVIDER, safeToSend, statusClass, verifyEmails, verifyRecords, writeVerification, type VerifyResult } from './reoon.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

const PARKED = ['catch_all', 'unknown', 'role_account'];
const DEAD = ['invalid', 'disabled', 'disposable', 'inbox_full', 'spamtrap'];
for (const status of PARKED) {
  eq(`${status} is parked and not safe`, [statusClass(status), safeToSend(status)], ['parked', false]);
}
for (const status of DEAD) {
  eq(`${status} is unsafe`, [statusClass(status), safeToSend(status)], ['unsafe', false]);
}
eq('safe is the only status that may be sent', [statusClass('safe'), safeToSend(' SAFE ')], ['safe', true]);
eq('an unfamiliar status is not safe', [statusClass('valid'), safeToSend('valid')], ['unknown', false]);

type Hit = { url: string; method: string; body: string };
function fetchMock(script: { status?: number; body: unknown }[]) {
  const hits: Hit[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    hits.push({ url, method, body });
    const next = script.shift() ?? { status: 500, body: { status: 'error', reason: 'no scripted response' } };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { fetchImpl, hits };
}

const keyEnv = { get: (name: string) => (name === 'REOON_API_KEY' ? 'test-key' : undefined) };
const noKey = { get: () => undefined };

{
  let called = false;
  const out = await verifyEmails(['ada@example.com'], {
    env: noKey,
    fetch: () => { called = true; return Promise.resolve(new Response('{}')); },
  });
  eq('a missing key does not call Reoon', [out.ok, !out.ok && out.missingKey, !out.ok && out.error, called], [false, true, MISSING_KEY_ERROR, false]);
}
{
  const out = await verifyEmails(['ada@example.com'], { env: { get: () => '   ' }, fetch: () => Promise.resolve(new Response('{}')) });
  eq('a blank key is the same no-op', out.ok, false);
}

{
  const mock = fetchMock([{ body: { email: 'ada@example.com', status: 'safe', is_safe_to_send: true, verification_mode: 'power' } }]);
  const out = await verifyEmails([' Ada@Example.com '], { env: keyEnv, fetch: mock.fetchImpl });
  const hit = mock.hits[0];
  eq('one address is a power-mode GET', [mock.hits.length, hit.method, hit.url.includes('mode=power'), hit.url.includes('quick'), hit.url.startsWith('https://emailverifier.reoon.com/api/v1/verify?')], [1, 'GET', true, false, true]);
  eq('the address is encoded and the key is sent', [hit.url.includes('email=ada%40example.com'), hit.url.includes('key=test-key')], [true, true]);
  eq('safe maps to email_safe_to_send true', out.ok && out.results, [{ email: 'ada@example.com', status: 'safe', safe: true, provider: VERIFY_PROVIDER }]);
}
{
  const mock = fetchMock([{ body: { email: 'pool@example.com', status: 'catch_all', is_safe_to_send: true } }]);
  const out = await verifyEmails(['pool@example.com'], { env: keyEnv, fetch: mock.fetchImpl });
  eq('catch_all stays false even when Reoon says is_safe_to_send', out.ok && out.results[0].safe, false);
  eq('quick mode is never requested', mock.hits.every((h) => !h.url.includes('quick') && !h.body.includes('quick')), true);
}

{
  const results = {
    'a@example.com': { email: 'a@example.com', status: 'safe', is_safe_to_send: true },
    'b@example.com': { email: 'b@example.com', status: 'invalid', is_safe_to_send: false },
  };
  const mock = fetchMock([
    { status: 201, body: { status: 'success', task_id: 40676, count_processing: 2 } },
    { body: { status: 'running', progress_percentage: 40 } },
    { body: { status: 'completed', task_id: '40676', results } },
  ]);
  let slept = 0;
  const out = await verifyEmails(['a@example.com', 'b@example.com'], { env: keyEnv, fetch: mock.fetchImpl, sleep: async () => { slept++; }, polls: 5 });
  const post = mock.hits[0];
  const poll = mock.hits[2];
  eq('two addresses create a bulk task', [post.method, post.url, JSON.parse(post.body).emails, JSON.parse(post.body).mode ?? null], ['POST', 'https://emailverifier.reoon.com/api/v1/create-bulk-verification-task/', ['a@example.com', 'b@example.com'], null]);
  eq('the task is polled by task_id', [poll.url.includes('get-result-bulk-verification-task/'), poll.url.includes('task_id=40676'), poll.url.includes('task-id='), slept], [true, true, false, 1]);
  eq('bulk statuses map the same way', out.ok && out.results.map((r) => [r.email, r.safe]), [['a@example.com', true], ['b@example.com', false]]);
  eq('no request uses quick mode', mock.hits.every((h) => !/quick/i.test(h.url + h.body)), true);
}

type Rec = { id: number; email?: string; email_key?: string; buyer_id?: number; other_emails?: string[] };
function memory(seed: Record<string, Rec[]>) {
  const updates: { table: string; ids: number[]; patch: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const state: { op: string; patch: Record<string, unknown> | null; inCol: string; inVals: unknown[] } = { op: 'select', patch: null, inCol: '', inVals: [] };
    const q = {
      select: () => q, eq: () => q, or: () => q,
      in: (col: string, vals: unknown[]) => { state.inCol = col; state.inVals = vals; return q; },
      update: (patch: Record<string, unknown>) => { state.op = 'update'; state.patch = patch; return q; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (state.op === 'update') {
          updates.push({ table, ids: state.inVals as number[], patch: state.patch ?? {} });
          return Promise.resolve({ error: null }).then(res, rej);
        }
        let data = seed[table] ?? [];
        if (state.inCol) data = data.filter((row) => state.inVals.map(String).includes(String((row as Record<string, unknown>)[state.inCol])));
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return q;
  };
  return { from, updates };
}

{
  const db = memory({
    buyers: [{ id: 1, email: 'ada@example.com' }, { id: 2, email: 'other@example.com' }],
    buyer_emails: [{ id: 10, buyer_id: 1, email: 'ada@example.com', email_key: 'ada@example.com' }],
    buyer_contacts: [{ id: 20, buyer_id: 1, email: 'Ada@Example.com' }],
    sellers: [{ id: 30, email: 'ada@example.com', other_emails: ['extra@example.com'] }, { id: 31, email: 'nope@example.com' }],
  });
  const at = new Date('2026-10-06T00:00:00.000Z');
  const results: VerifyResult[] = [
    { email: 'ada@example.com', status: 'safe', safe: true, provider: VERIFY_PROVIDER },
    { email: 'extra@example.com', status: 'spamtrap', safe: false, provider: VERIFY_PROVIDER },
  ];
  const stored = await writeVerification(db as never, 7, results, at);
  const patch = {
    email_status: 'safe', email_safe_to_send: true, email_verified_at: at.toISOString(), email_verify_provider: 'reoon',
  };
  eq('writes land on every row with that address', stored, { ok: true, updated: 4 });
  eq('all four columns, on all four tables', db.updates.map((u) => [u.table, u.ids, u.patch]), [
    ['buyers', [1], patch],
    ['buyer_emails', [10], patch],
    ['buyer_contacts', [20], patch],
    ['sellers', [30], patch],
  ]);
}
{
  const db = memory({
    buyers: [{ id: 1, email: 'ada@example.com' }],
    buyer_emails: [], buyer_contacts: [], sellers: [],
  });
  const out = await verifyRecords(db as never, 7, { buyer_ids: [1] }, { env: noKey, fetch: () => Promise.reject(new Error('should not be called')) });
  eq('verify_emails with no key writes nothing', [out.ok, !out.ok && out.error, db.updates.length], [false, MISSING_KEY_ERROR, 0]);
}

if (failed) { console.log(`\n${failed} FAILED`); Deno.exit(1); }
console.log('\nreoon: ok');
