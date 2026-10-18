// talkr-webhook's signature check: the HMAC key is imported once per secret
// and reused, a rotated secret gets a new key, and a bad signature still fails.
// Run: npx tsx tools/talkr-hmac.test.ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { hmacHex, hmacKey, safeEqual } from '../supabase/functions/talkr-webhook/hmac';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const node = (secret: string, msg: string) => createHmac('sha256', secret).update(msg).digest('hex');
const msg = `1760000000.${JSON.stringify({ id: 'evt_1', type: 'message.received', data: { body: 'hi' } })}`;

await test('the digest is HMAC-SHA256 hex of t.body, as Talkr signs it', async () => {
  assert.equal(await hmacHex('whsec_a', msg), node('whsec_a', msg));
  assert.match(await hmacHex('whsec_a', msg), /^[0-9a-f]{64}$/);
});

await test('one import per secret: the same key comes back for every delivery', async () => {
  const k1 = hmacKey('whsec_cache');
  const k2 = hmacKey('whsec_cache');
  assert.equal(k1, k2);
  assert.equal(await k1, await k2);
  assert.equal(await hmacHex('whsec_cache', msg), node('whsec_cache', msg));
  assert.equal(await hmacHex('whsec_cache', msg + 'x'), node('whsec_cache', msg + 'x'));
});

await test('a rotated secret gets its own key, and the old signature no longer verifies', async () => {
  const before = await hmacHex('whsec_old', msg);
  assert.notEqual(hmacKey('whsec_new'), hmacKey('whsec_old'));
  const after = await hmacHex('whsec_new', msg);
  assert.equal(after, node('whsec_new', msg));
  assert.equal(safeEqual(after, before), false);
  // The old secret still checks with its own key (another workspace may hold it).
  assert.equal(await hmacHex('whsec_old', msg), before);
});

await test('a bad signature is rejected exactly as before', async () => {
  const good = await hmacHex('whsec_a', msg);
  assert.equal(safeEqual(good, node('whsec_a', msg)), true);
  assert.equal(safeEqual(await hmacHex('whsec_b', msg), good), false);
  assert.equal(safeEqual(await hmacHex('whsec_a', msg + ' '), good), false);
  const flipped = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
  assert.equal(safeEqual(flipped, good), false);
  assert.equal(safeEqual(good.slice(0, 63), good), false);
  assert.equal(safeEqual('', good), false);
});

console.log(`talkr-hmac: ${passed} passed`);
