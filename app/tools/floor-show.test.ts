// Floor show rules. Run: npx tsx tools/floor-show.test.ts
import assert from 'node:assert/strict';
import { applyLeaderboardResets, buildLeaderboard, type LeaderboardRaw } from '../lib/leaderboard';
import {
  catchUp, diffFloor, throttleLive, emailLooksSigned, findPasses, floorBadgeHits, snapFrom, spinWheel, wheelPrizes, windowKey,
  type BadgeHit, type DayStat, type FloorEvent, type SignedContract,
} from '../lib/floor-show';
import { BADGES } from '../lib/leaderboard';

const a: DayStat = { id: 'a', name: 'Alex', calls: 10, offers: 1, talk: 600 };
const b: DayStat = { id: 'b', name: 'Jordan', calls: 4, offers: 3, talk: 200 };

{
  const passed = findPasses([a, b], [{ ...a, calls: 12 }, { ...b, calls: 13 }]);
  assert.equal(passed.length, 1);
  assert.equal(passed[0].kind, 'pass');
  if (passed[0].kind === 'pass') {
    assert.equal(passed[0].passer, 'Jordan');
    assert.equal(passed[0].passed, 'Alex');
    assert.equal(passed[0].metric, 'calls');
  }
}

{
  const tied = findPasses(
    [{ ...a, calls: 0 }, { ...b, calls: 0 }],
    [{ ...a, calls: 1 }, { ...b, calls: 0 }],
  );
  assert.equal(tied.length, 0, 'leaving zero does not pass someone still at zero');
}

{
  assert.equal(emailLooksSigned('Purchase agreement signed', 'All parties have signed the purchase agreement.'), true);
  assert.equal(emailLooksSigned('Your offer', 'Thanks for the call'), false);
  assert.equal(emailLooksSigned('Document completed', 'Please review'), false);
}

{
  const stats = [a, b];
  const contracts: SignedContract[] = [{ id: 'contract:1', title: 'Oak', ownerId: 'a', ownerName: 'Alex', source: 'esign' }];
  const seeded = snapFrom(stats, [], []);
  const first = diffFloor({ seeded: false, badges: {}, stats: {}, contracts: [] }, stats, [], contracts);
  assert.equal(first.length, 0, 'the first look seeds and stays quiet');
  const next = diffFloor(seeded, stats, [], contracts);
  assert.equal(next.length, 1);
  assert.equal(next[0].kind, 'contract');
  const again = diffFloor(snapFrom(stats, [], contracts), stats, [], contracts);
  assert.equal(again.length, 0);
}

{
  const prizes = wheelPrizes('AirPods');
  assert.equal(prizes.filter((p) => !p.jackpot).every((p) => p.weight === 10), true);
  const jackpot = prizes.find((p) => p.jackpot)!;
  assert.equal(jackpot.weight, 2);
  assert.ok(jackpot.label.includes('AirPods'));
  const counts = new Map<string, number>();
  const units = prizes.reduce((s, p) => s + p.weight, 0);
  for (let i = 0; i < units; i++) {
    const { prize } = spinWheel(prizes, (i + 0.5) / units);
    counts.set(prize.id, (counts.get(prize.id) ?? 0) + 1);
  }
  for (const p of prizes) assert.equal(counts.get(p.id), p.weight, p.id);
}

{
  const now = new Date('2026-09-21T17:00:00Z').toISOString();
  const raw: LeaderboardRaw = {
    members: [{ id: 'a', name: 'Alex', role: 'acquisitions' }],
    sellers: [{ id: 1, created_at: '2026-06-15T18:00:00Z', assigned_to: 'a' }],
    deals: [],
    comms: [{ seller_id: 1, rep_id: 'a', channel: 'call', direction: 'outbound', occurred_at: '2026-09-01T00:00:00Z', duration_s: 30, status: 'completed' }],
    offers: [{ seller_id: 1, direction: 'outbound', sent_at: '2026-09-02T00:00:00Z', created_by: 'a' }],
  };
  const before = buildLeaderboard(raw, 'this-year', { now: Date.parse('2026-09-21T17:00:00Z') });
  assert.ok((before.salesPeople[0].leads ?? 0) >= 1);
  assert.ok(before.salesPeople[0].calls >= 1);
  const after = buildLeaderboard(applyLeaderboardResets(raw, { a: now }), 'this-year', { now: Date.parse('2026-09-21T17:00:00Z') });
  assert.equal(after.salesPeople[0].leads, 0);
  assert.equal(after.salesPeople[0].calls, 0);
  assert.equal(after.salesPeople[0].offersMade, 0);
}

{
  // A dispo rep's badges: his contracts this week are a good badge that fires,
  // no seller offers is not Warm Milk, and a good badge earned again next week
  // announces again.
  const at = (iso: string) => Date.parse(iso);
  const raw: LeaderboardRaw = {
    members: [
      { id: 't', name: 'Morgan', role: 'dispositions' },
      { id: 'n', name: 'Alex', role: 'dispositions' },
      { id: 'c', name: 'Chris', role: 'acquisitions' },
    ],
    sellers: [{ id: 1, created_at: '2026-09-01T18:00:00Z', assigned_to: 'c' }],
    deals: [],
    comms: [
      { seller_id: 1, rep_id: 't', channel: 'call', direction: 'outbound', occurred_at: '2026-09-22T15:00:00Z', duration_s: 300, status: 'completed' },
      { seller_id: 1, rep_id: 'n', channel: 'call', direction: 'outbound', occurred_at: '2026-09-22T15:00:00Z', duration_s: 30, status: 'completed' },
      { seller_id: 1, rep_id: 'c', channel: 'call', direction: 'outbound', occurred_at: '2026-09-22T15:00:00Z', duration_s: 30, status: 'completed' },
    ],
    offers: [],
  };
  const now = at('2026-09-23T17:00:00Z');
  const hits = floorBadgeHits(raw, now);
  const of = (id: string) => hits.filter((h) => h.personId === id).map((h) => h.badge.id);
  assert.ok(!of('t').includes('warm-milk'), 'a dispo rep is not judged on seller offers');
  assert.ok(of('c').includes('warm-milk'), 'an acquisitions rep with calls and no offers is');
  assert.ok(!of('c').includes('furniture'), 'the only acquisitions rep is not the quietest of one');
  // Snapshot keys carry the window, so next week the same badge is new again.
  const snap = snapFrom([], hits, []);
  const again = floorBadgeHits(raw, at('2026-09-30T17:00:00Z'));
  const fired = diffFloor({ ...snap, seeded: true, stats: { t: { calls: 0, offers: 0, talk: 0 }, n: { calls: 0, offers: 0, talk: 0 }, c: { calls: 0, offers: 0, talk: 0 } } }, [], again, []);
  const sameWeek = diffFloor({ ...snap, seeded: true, stats: { t: { calls: 0, offers: 0, talk: 0 }, n: { calls: 0, offers: 0, talk: 0 }, c: { calls: 0, offers: 0, talk: 0 } } }, [], hits, []);
  assert.equal(sameWeek.filter((e) => e.kind === 'badge').length, 0, 'the same badges in the same window do not fire twice');
  assert.ok(fired.every((e) => e.kind !== 'badge' || e.id.includes('@')), 'badge events carry their window');
}

{
  // A badge that drops off for one refresh and comes back in the same run does
  // not announce again (a reset still loading, a short read, Furniture trading hands).
  const now = Date.parse('2026-10-02T17:00:00Z');
  const furniture = BADGES.find((b) => b.id === 'furniture')!;
  const hit = (personId: string, at = now): BadgeHit => ({ personId, person: personId, badge: furniture, window: windowKey('last-7-days', at) });
  const stats: DayStat[] = [{ ...a, id: 't', name: 'Morgan' }, { ...b, id: 'n', name: 'Alex' }];
  const s1 = snapFrom(stats, [hit('t')], [], undefined, now);
  const s2 = snapFrom(stats, [hit('n')], [], s1, now);
  const back = diffFloor(s2, stats, [hit('t')], [], now);
  assert.equal(back.filter((e) => e.kind === 'badge').length, 0, 'Morgan had it this week already');
  // Next week the run is over, so it is remembered no longer and can fire again.
  const nextWeek = now + 7 * 86_400_000;
  const s3 = snapFrom(stats, [], [], s2, nextWeek);
  assert.deepEqual(s3.badges, {}, 'a finished run drops out of the snapshot');
  assert.equal(diffFloor(s3, stats, [hit('t', nextWeek)], [], nextWeek).filter((e) => e.kind === 'badge').length, 1);
  // A contract that falls out of one read is not new on the next.
  const c: SignedContract = { id: 'contract:9', title: 'Elm', ownerId: 't', ownerName: 'Morgan', source: 'esign' };
  const withC = snapFrom(stats, [], [c], undefined, now);
  const without = snapFrom(stats, [], [], withC, now);
  assert.equal(diffFloor(without, stats, [], [c], now).length, 0);
}

{
  // Passes are judged within one day: yesterday's 40 calls against today's 3 is not a pass.
  const now = Date.parse('2026-10-02T17:00:00Z');
  const yesterday = now - 86_400_000;
  const prev = snapFrom([{ ...a, calls: 40 }, { ...b, calls: 0 }], [], [], undefined, yesterday);
  const today = [{ ...a, calls: 3 }, { ...b, calls: 5 }];
  assert.equal(diffFloor(prev, today, [], [], now).filter((e) => e.kind === 'pass').length, 0);
  const sameDay = snapFrom([{ ...a, calls: 4 }, { ...b, calls: 1 }], [], [], undefined, now);
  assert.equal(diffFloor(sameDay, today, [], [], now).filter((e) => e.kind === 'pass').length, 1);
}

{
  // Coming back to the screen: no takeovers, stale passes dropped, a pile of badges folded into one toast.
  const badge = (person: string, name: string): FloorEvent => ({ id: `badge:${person}:${name}`, kind: 'badge', tier: 'good', personId: person, person, badgeId: name, badgeName: name, hint: '', image: '' });
  const pass: FloorEvent = { id: 'pass:x', kind: 'pass', metric: 'calls', passerId: 'n', passer: 'Alex', passedId: 't', passed: 'Morgan', value: '9' };
  const contract: FloorEvent = { id: 'contract:contract:1', kind: 'contract', contractId: 'contract:1', title: 'Oak', ownerId: 't', ownerName: 'Morgan', source: 'esign' };
  const two = catchUp([badge('Morgan', 'Furniture'), badge('Alex', 'Smooth Talker'), pass]);
  assert.deepEqual(two.map((e) => e.kind), ['badge', 'badge']);
  const many = catchUp([badge('Morgan', 'A'), badge('Morgan', 'B'), badge('Alex', 'C'), badge('Jamie', 'D'), contract, pass]);
  assert.deepEqual(many.map((e) => e.kind), ['digest', 'contract']);
  if (many[0].kind === 'digest') assert.match(many[0].text, /^4 badges while you were away — Morgan got A, Morgan got B, Alex got C and 1 more\.$/);
}

{
  // Back after a long weekend: a pile of contracts is one toast too; two or fewer still show one by one.
  const contract = (n: number): FloorEvent => ({ id: `contract:contract:${n}`, kind: 'contract', contractId: `contract:${n}`, title: `Lot ${n}`, ownerId: 't', ownerName: 'Morgan', source: 'esign' });
  assert.deepEqual(catchUp([contract(1), contract(2)]).map((e) => e.kind), ['contract', 'contract']);
  const pile = catchUp([contract(1), contract(2), contract(3), contract(4)]);
  assert.deepEqual(pile.map((e) => e.kind), ['digest']);
  if (pile[0].kind === 'digest') assert.match(pile[0].text, /^4 contracts signed while you were away: Lot 1, Lot 2, Lot 3 and 1 more\.$/);
}

{
  // A live refresh: at most two badges take over the screen, the rest fold into one quiet toast.
  const badge = (n: number): FloorEvent => ({ id: `badge:${n}`, kind: 'badge', tier: 'good', personId: 'p', person: 'Morgan', badgeId: `b${n}`, badgeName: `B${n}`, hint: '', image: '' });
  const contract: FloorEvent = { id: 'contract:contract:9', kind: 'contract', contractId: 'contract:9', title: 'Oak', ownerId: 't', ownerName: 'Morgan', source: 'esign' };
  const few = throttleLive([badge(1), badge(2), contract]);
  assert.equal(few.loud.length, 3); assert.equal(few.quiet.length, 0);
  const lots = throttleLive([badge(1), badge(2), badge(3), badge(4), badge(5), contract]);
  assert.deepEqual(lots.loud.map((e) => e.id), ['badge:1', 'badge:2', 'contract:contract:9']);
  assert.equal(lots.quiet.length, 1);
  if (lots.quiet[0].kind === 'digest') assert.match(lots.quiet[0].text, /^3 badges just now — Morgan got B3, Morgan got B4, Morgan got B5\.$/);
}

{
  // "#1 for the month" waits for a week of the month: on the 2nd one call makes a leader.
  const raw: LeaderboardRaw = {
    members: [{ id: 'a', name: 'Alex', role: 'acquisitions' }, { id: 'b', name: 'Bo', role: 'acquisitions' }],
    sellers: [{ id: 1, created_at: '2026-09-01T18:00:00Z', assigned_to: 'a' }],
    deals: [],
    comms: [{ seller_id: 1, rep_id: 'a', channel: 'call', direction: 'outbound', occurred_at: '2026-10-02T15:00:00Z', duration_s: 30, status: 'completed' }],
    offers: [],
  };
  const early = floorBadgeHits(raw, Date.parse('2026-10-02T17:00:00Z')).map((h) => h.badge.id);
  assert.ok(!early.includes('apex-predator'), 'not on the 2nd');
  const later = floorBadgeHits({ ...raw, comms: [{ ...raw.comms[0], occurred_at: '2026-10-09T15:00:00Z' }] }, Date.parse('2026-10-09T17:00:00Z')).map((h) => h.badge.id);
  assert.ok(later.includes('apex-predator'), 'a week in, the leader is the leader');
}

console.log('floor-show ok');
