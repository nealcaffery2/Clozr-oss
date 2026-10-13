// The second wave of floor badges.  Run:  npx tsx tools/badges-v2.test.ts
import assert from 'node:assert/strict';
import { BADGES, type SalesPerson, qualifies } from '../lib/leaderboard';

const badge = (id: string) => BADGES.find((b) => b.id === id)!;
const rep = (p: Partial<SalesPerson>): SalesPerson => ({ id: 'r', name: 'Rep', role: 'acquisitions', ...p } as SalesPerson);
const has = (id: string, p: Partial<SalesPerson>) => qualifies(badge(id), rep(p), {});

// Speed to lead needs three leads behind it.
assert.ok(has('speed-demon', { speedToLeadSeconds: 120, speedToLeadLeadsCount: 5 }));
assert.ok(!has('speed-demon', { speedToLeadSeconds: 120, speedToLeadLeadsCount: 1 }), 'one lucky pickup is not a badge');
assert.ok(!has('speed-demon', { speedToLeadSeconds: 400, speedToLeadLeadsCount: 5 }));
assert.ok(has('snail-mail', { speedToLeadSeconds: 5400, speedToLeadLeadsCount: 4 }));
assert.ok(!has('snail-mail', { speedToLeadSeconds: 5400, speedToLeadLeadsCount: 2 }));
assert.ok(!has('snail-mail', {}), 'no leads, no snail');

assert.ok(has('smooth-talker', { conversations: 25 }));
assert.ok(!has('smooth-talker', { conversations: 24 }));

// Offers are an acquisitions number; buyers added are dispo's.
assert.ok(has('offer-cannon', { offersMade: 15 }));
assert.ok(!has('offer-cannon', { offersMade: 30, role: 'disposition' }));
assert.ok(has('buyer-magnet', { buyersAdded: 12, role: 'disposition' }));
assert.ok(!has('buyer-magnet', { buyersAdded: 12 }));

assert.ok(has('ice-cold-closer', { dealsClosed: 3 }));
assert.ok(has('ice-cold-closer', { dispositionDealsClosed: 3, role: 'disposition' }));
assert.ok(!has('ice-cold-closer', { dealsClosed: 2 }));

assert.ok(has('paper-tiger', { calls: 140 }));
assert.ok(!has('paper-tiger', { calls: 140, deals: 1, dealsUnderContract: 1 }), 'one contract clears it');
assert.ok(!has('paper-tiger', { calls: 140, role: 'disposition' }));

assert.ok(has('butterfingers', { dealsTerminated: 2, terminationPercent: 50 }));
assert.ok(!has('butterfingers', { dealsTerminated: 1, terminationPercent: 100 }), 'one fallout is not half');

// 150 dials out; inbound calls are not dialing.
assert.ok(has('dialing-for-dollars', { calls: 150, outboundCalls: 150 }));
assert.ok(!has('dialing-for-dollars', { calls: 160, outboundCalls: 90 }), 'seventy of those rang in');
assert.ok(has('dialing-for-dollars', { calls: 150 }), 'a board without the split keeps the old count');

// Blood in the Water is the first contract, not every contract.
{
  const ctx = { firstContractIds: ['first'] };
  assert.ok(qualifies(badge('blood-in-the-water'), rep({ id: 'first', deals: 1, dealsUnderContract: 1 }), ctx));
  assert.ok(!qualifies(badge('blood-in-the-water'), rep({ id: 'second', deals: 2, dealsUnderContract: 2 }), ctx), 'a later contract is not the first');
  assert.ok(qualifies(badge('blood-in-the-water'), rep({ deals: 1, dealsUnderContract: 1 }), {}), 'no first to go on, any contract');
}

// Every badge has art on disk.
import { existsSync } from 'node:fs';
for (const b of BADGES) assert.ok(existsSync(new URL('../public' + b.image, import.meta.url)), `art for ${b.id}`);
console.log('badges-v2 ok');
