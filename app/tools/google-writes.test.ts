// Google sync writes only what changed: the quiet minute's heartbeat stamp
// and the end-of-run status write. Run: npx tsx tools/google-writes.test.ts
import assert from 'node:assert/strict';
import { FAST_BEHIND_MS } from '../supabase/functions/_shared/gmail-lanes';
import { QUIET_STAMP_MS, changedOnly, quietPatch } from '../supabase/functions/_shared/google-writes';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const T = Date.parse('2026-10-17T19:00:00Z');
const at = (ms: number) => new Date(T + ms);
const ago = (ms: number) => new Date(T - ms).toISOString();

test('a moved historyId is always written, with the stamp', () => {
  assert.deepEqual(quietPatch({ verdict: 'history', historyId: '42', last: ago(5_000), startedAt: at(0) }), { last_gmail_sync_at: at(0).toISOString(), gmail_history_id: '42' });
});

test('an unchanged mailbox skips a fresh stamp', () => {
  assert.equal(quietPatch({ verdict: 'quiet', historyId: '42', last: ago(30_000), startedAt: at(0) }), null);
  assert.equal(quietPatch({ verdict: 'quiet', historyId: '42', last: ago(QUIET_STAMP_MS - 1), startedAt: at(0) }), null);
});

test('and stamps once it is due', () => {
  assert.deepEqual(quietPatch({ verdict: 'quiet', historyId: '42', last: ago(QUIET_STAMP_MS), startedAt: at(0) }), { last_gmail_sync_at: at(0).toISOString() });
  assert.deepEqual(quietPatch({ verdict: 'quiet', historyId: '42', last: ago(3_600_000), startedAt: at(0) }), { last_gmail_sync_at: at(0).toISOString() });
});

test('no stamp, an unreadable one, or one ahead of the clock is written over', () => {
  for (const last of [null, 'not a date', new Date(T + 60_000).toISOString()]) {
    assert.deepEqual(quietPatch({ verdict: 'quiet', historyId: '42', last, startedAt: at(0) }), { last_gmail_sync_at: at(0).toISOString() }, String(last));
  }
});

test('the slow lane never reads a healthy fast lane as behind, and half the minutes write nothing', () => {
  // The minute cron, each check landing 0 to 30 s into its minute (cold
  // start, token refresh). The slow lane catches up when the stamp is older
  // than FAST_BEHIND_MS at the moment it loads the account: any moment.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let stored = T;
  let writes = 0;
  let oldest = 0;
  const minutes = 2000;
  for (let m = 1; m <= minutes; m++) {
    const startedAt = T + m * 60_000 + Math.floor(rand() * 30_000);
    // Just before this check lands, the stamp is as old as it gets.
    oldest = Math.max(oldest, startedAt - stored);
    const patch = quietPatch({ verdict: 'quiet', historyId: '42', last: new Date(stored).toISOString(), startedAt: new Date(startedAt) });
    if (patch) { stored = Date.parse(patch.last_gmail_sync_at as string); writes++; }
  }
  assert.ok(oldest < FAST_BEHIND_MS, `oldest stamp ${oldest} ms`);
  assert.ok(writes <= minutes * 0.51, `${writes} writes in ${minutes} minutes`);
  assert.ok(writes >= minutes * 0.49, `${writes} writes in ${minutes} minutes`);
});

test('the closing write drops what is already so', () => {
  const was = { status: 'active', last_error: null };
  assert.deepEqual(changedOnly({ last_error: null, status: 'active' }, was), {});
  assert.deepEqual(changedOnly({ last_error: null, status: 'active', last_gmail_sync_at: 'x' }, was), { last_gmail_sync_at: 'x' });
  assert.deepEqual(changedOnly({ last_error: 'Gmail sync hit an error.', status: 'active' }, was), { last_error: 'Gmail sync hit an error.' });
});

test('and keeps what changed or was not loaded', () => {
  assert.deepEqual(changedOnly({ last_error: null, status: 'active' }, { status: 'active', last_error: 'Calendar sync hit an error.' }), { last_error: null });
  assert.deepEqual(changedOnly({ last_error: null, status: 'active' }, { status: 'needs_reauth', last_error: undefined }), { last_error: null, status: 'active' });
  assert.deepEqual(changedOnly({ last_error: null }, {}), { last_error: null });
});

console.log(`google-writes: ${passed} passed`);
