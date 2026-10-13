// The leaderboard engine on a small fixture, and the guard that keeps the
// edge function's copy identical to the library. Run: npx tsx tools/leaderboard.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BADGES, TITLES, badgesFor, buildBadgeContext, buildLeaderboard, calculatePoints, periodRange, resolveTitles, type LeaderboardRaw } from '../lib/leaderboard';

const TZ = 'America/Chicago';
// Mon Sep 21 2026 12:00 Chicago (17:00 UTC).
const NOW = Date.UTC(2026, 8, 21, 17, 0, 0);
const ago = (days: number, hours = 0) => new Date(NOW - days * 86_400_000 - hours * 3_600_000).toISOString();

const raw: LeaderboardRaw = {
  members: [
    { id: 'ava', name: 'Taylor Reed', role: 'acquisitions', avatar: '/avatars/taylor.png' },
    { id: 'tom', name: 'Morgan Lane', role: 'dispositions' },
    { id: 'sam', name: 'Sam Carter', role: 'owner' },
  ],
  sellers: [
    { id: 1, created_at: ago(20), assigned_to: 'ava' },
    { id: 2, created_at: ago(3), assigned_to: 'ava' },
    { id: 3, created_at: ago(40), assigned_to: null },
  ],
  deals: [
    // Closed 5 days ago, owner ava, dispo tom: fee 30k credited to both sides, split in `revenue`.
    { id: 10, seller_id: 1, stage: 'Closed', created_at: ago(30), stage_entered_at: ago(5), contract_date: ago(15), close_date: ago(5), closed_on: ago(5), owner_id: 'ava', dispo_rep_id: 'tom', assignment_fee: 30_000, dispo_fee: null, wholesale_fee: null, total_cogs: 4_000, deal_net_profit: 26_000, market: 'San Antonio' },
    // Under contract with the seller 2 days ago: pipeline, contracts for ava.
    { id: 11, seller_id: 2, stage: 'Seller Under Contract', created_at: ago(3), stage_entered_at: ago(2), contract_date: ago(2), close_date: null, closed_on: null, owner_id: 'ava', dispo_rep_id: null, assignment_fee: 12_000, dispo_fee: null, wholesale_fee: null, total_cogs: null, deal_net_profit: null, market: 'Houston' },
    // In escrow, dispo tom.
    { id: 12, seller_id: 3, stage: 'In Escrow', created_at: ago(50), stage_entered_at: ago(4), contract_date: ago(45), close_date: ago(-10), closed_on: null, owner_id: 'ava', dispo_rep_id: 'tom', assignment_fee: 20_000, dispo_fee: null, wholesale_fee: null, total_cogs: null, deal_net_profit: null, market: 'Houston' },
    // Terminated last week.
    { id: 13, seller_id: 3, stage: 'Terminated', created_at: ago(60), stage_entered_at: ago(6), contract_date: ago(50), close_date: null, closed_on: null, owner_id: 'ava', dispo_rep_id: null, assignment_fee: 9_000, dispo_fee: null, wholesale_fee: null, total_cogs: null, deal_net_profit: null, market: null },
  ],
  comms: [
    // Credited by rep_id (Talkr user), not by the seller's rep.
    { seller_id: 1, rep_id: 'tom', channel: 'call', direction: 'outbound', occurred_at: ago(1), duration_s: 200, status: 'completed' },
    // No rep_id: falls back to seller 1's assigned rep, ava. Long enough to be a conversation.
    { seller_id: 1, rep_id: null, channel: 'call', direction: 'outbound', occurred_at: ago(2), duration_s: 130, status: 'completed' },
    { seller_id: 2, rep_id: null, channel: 'call', direction: 'inbound', occurred_at: ago(2, 1), duration_s: 20, status: 'no-answer' },
    { seller_id: 2, rep_id: null, channel: 'sms', direction: 'outbound', occurred_at: ago(1), duration_s: null, status: 'delivered' },
    { seller_id: 2, rep_id: null, channel: 'sms', direction: 'inbound', occurred_at: ago(1), duration_s: null, status: null },
    { seller_id: 2, rep_id: 'ava', channel: 'email', direction: 'outbound', occurred_at: ago(1), duration_s: null, status: null },
    // Unassigned seller, no rep: nobody's.
    { seller_id: 3, rep_id: null, channel: 'call', direction: 'outbound', occurred_at: ago(1), duration_s: 400, status: 'completed' },
    // Outside a 30-day window.
    { seller_id: 1, rep_id: 'ava', channel: 'call', direction: 'outbound', occurred_at: ago(45), duration_s: 400, status: 'completed' },
  ],
  offers: [
    { seller_id: 2, direction: 'outbound', sent_at: ago(1), created_by: 'ava' },
    { seller_id: 1, direction: 'inbound', sent_at: ago(1), created_by: null },
  ],
  appointments: [
    { seller_id: 2, assigned_to: 'ava', starts_at: ago(-1), created_at: ago(1) },
    { seller_id: 2, assigned_to: 'ava', starts_at: ago(-1), created_at: ago(1), deleted_at: ago(0) },
  ],
  buyers: [{ created_at: ago(2), created_by: 'tom' }],
};

// ---- periods ------------------------------------------------------------------------
{
  const r = periodRange('today', NOW, TZ);
  assert.equal(new Date(r.start!).toISOString(), '2026-09-21T05:00:00.000Z', 'today starts at Chicago midnight (CDT = UTC-5)');
  const w = periodRange('this-week', NOW, TZ);
  assert.equal(new Date(w.start!).toISOString(), '2026-09-21T05:00:00.000Z', 'a Monday is the start of its own week');
  const lw = periodRange('last-week', NOW, TZ);
  assert.equal(new Date(lw.start!).toISOString(), '2026-09-14T05:00:00.000Z');
  assert.equal(lw.end, w.start! - 1);
  const lm = periodRange('last-month', NOW, TZ);
  assert.equal(new Date(lm.start!).toISOString(), '2026-08-01T05:00:00.000Z');
  assert.equal(new Date(lm.end + 1).toISOString(), '2026-09-01T05:00:00.000Z');
  assert.equal(periodRange('all-time', NOW, TZ).start, null);
  // DST edge: 2 Nov 2026 the clocks fall back; the day still starts at local midnight.
  const nov = periodRange('today', Date.UTC(2026, 10, 2, 18), TZ);
  assert.equal(new Date(nov.start!).toISOString(), '2026-11-02T06:00:00.000Z', 'CST = UTC-6 after the change');
}

// ---- attribution ----------------------------------------------------------------------
{
  const p = buildLeaderboard(raw, 'last-30-days', { now: NOW, tz: TZ });
  const by = Object.fromEntries(p.salesPeople.map((x) => [x.id, x]));
  const ava = by.ava, tom = by.tom, sam = by.sam;

  assert.equal(ava.calls, 2, 'ava: one call by seller fallback + one inbound attempt');
  assert.equal(ava.conversations, 1, 'only the 130s call is a conversation');
  assert.equal(ava.sms, 1, 'outbound texts only');
  assert.equal(ava.emails, 1);
  assert.equal(ava.totalTalkTime, 150);
  assert.equal(tom.calls, 1, 'the rep_id call goes to tom, not to the seller’s rep');
  assert.equal(tom.conversations, 1);
  assert.equal(sam.calls, 0);
  assert.equal(ava.appointments, 1, 'a deleted appointment does not count');
  assert.equal(ava.offersMade, 1, 'inbound offers are not made by us');
  assert.equal(ava.leads, 2);
  assert.equal(tom.buyersAdded, 1);

  assert.equal(ava.dealsUnderContract, 2, 'both contract_dates fall in the window (15d and 2d ago)');
  assert.equal(ava.dealsClosed, 1);
  assert.equal(tom.dispositionDealsClosed, 1);
  assert.equal(ava.closed, 30_000, 'the full fee on the acquisitions side');
  assert.equal(tom.dispositionClosed, 30_000, 'the full fee on the dispo side');
  assert.equal(ava.revenue, 15_000, 'the combined revenue is split when the two reps differ');
  assert.equal(tom.revenue, 15_000);
  assert.equal(ava.pipelineVolume, 12_000, 'seller under contract is pipeline');
  assert.equal(ava.inEscrow, 20_000);
  assert.equal(tom.dispositionInEscrow, 20_000);
  assert.equal(ava.dealsTerminated, 1);
  assert.equal(ava.terminationPercent, 50);
  assert.equal(ava.cogs, 4_000);
  assert.equal(ava.netProfit, 26_000);
  assert.equal(tom.netProfit, 26_000, 'profit is company profit, shown to both reps on the deal');
  assert.equal(sam.cogs, null, 'no closed deals → null, not 0');
  assert.equal(ava.leadsToContract, 2, 'both of ava’s leads this period reached a contract');
  assert.equal(ava.leadsToClosing, 1, 'one of them closed');
  assert.ok((ava.speedToLeadSeconds ?? 0) > 0, 'speed to lead measured for seller 2 (created 3d ago, first touch 2d ago)');

  // Points, the dashboard's formula.
  assert.equal(ava.points, 1 * 250 + 1 * 100 + 2 * 10 + 1 * 2 + 1 * 1 + 1 * 50 + 2 * 200 + 1 * 500);
  assert.equal(calculatePoints(ava), ava.points);
  assert.equal(tom.points, 1 * 100 + 1 * 10 + 1 * 200 + 1 * 500, 'dispo counts dispo-side contracts (deal 10 was contracted 15d ago) and closings');

  // Ranking is by revenue, the board's rule; ava and tom tie, contracts break it.
  assert.deepEqual(p.salesPeople.map((x) => x.id), ['ava', 'tom', 'sam']);
  assert.equal(p.salesPeople[0].rank, 1);

  const x = p.executiveSummary;
  assert.equal(x.totalRevenue, 30_000, 'the team total is the fee once, not the split twice');
  assert.equal(x.totalClosings, 1);
  assert.equal(x.totalDealsUnderContract, 2);
  assert.equal(x.totalPipelineVolume, 12_000);
  assert.equal(x.totalInEscrow, 20_000);
  assert.equal(x.totalCalls, 3, 'nobody’s call is not in the team total either');
  assert.equal(x.totalNetProfit, 26_000);
  assert.deepEqual(x.netProfitCoverage, { dealsWithCogs: 1, dealsClosedInPeriod: 1 });
  assert.equal(x.totalTerminationPercent, 50);
  assert.equal(x.terminationStatus, 'at-risk');
  assert.equal(x.cashConversionDays, 10);
  assert.deepEqual(x.topMarketsByDealsQuarter, ['Houston', 'San Antonio']);
  assert.equal(p.notes.length, 1, 'the unattributed call is reported, not hidden');
  assert.match(p.notes[0], /1 call\/text\/email row/);
  assert.equal(p.dataSource, 'clozr');
}

// ---- a narrower period ------------------------------------------------------------------
{
  const p = buildLeaderboard(raw, 'this-week', { now: NOW, tz: TZ });
  const ava = p.salesPeople.find((x) => x.id === 'ava')!;
  assert.equal(ava.dealsUnderContract, 0, 'the contract two days ago was last week (today is Monday)');
  assert.equal(ava.dealsClosed, 0);
  assert.equal(ava.pipelineVolume, 12_000, 'pipeline is a snapshot, not period-filtered');
  assert.equal(ava.sms, 0, 'yesterday is Sunday — not this week');
  assert.equal(ava.calls, 0);
}

// ---- exclusions and goals ------------------------------------------------------------------
{
  const p = buildLeaderboard(raw, 'this-year', { now: NOW, tz: TZ, exclude: ['sam'], goals: { monthlyClosed: 60_000 } });
  assert.deepEqual(p.salesPeople.map((x) => x.id), ['ava', 'tom']);
  assert.equal(p.executiveSummary.monthlyClosedGoal, 60_000);
  assert.equal(p.executiveSummary.monthlyClosedProgress, 50);
}

// ---- gamification ---------------------------------------------------------------------------
{
  const p = buildLeaderboard(raw, 'last-30-days', { now: NOW, tz: TZ });
  const ctx = buildBadgeContext(p.salesPeople);
  const ava = p.salesPeople.find((x) => x.id === 'ava')!;
  const ids = badgesFor(ava, ctx).map((b) => b.id);
  assert.ok(ids.includes('apex-predator'), 'top points');
  assert.ok(ids.includes('blood-in-the-water'), 'the first contract of the period (15 days ago, shared with tom on the same deal)');
  assert.deepEqual(ctx.firstContractIds?.sort(), ['ava', 'tom']);
  assert.equal(ava.outboundCalls, 1, 'the inbound attempt is a call but not a dial');
  assert.equal(ava.calls, 2);
  assert.ok(!ids.includes('deal-reaper'), 'not three');
  assert.ok(!ids.includes('furniture'), 'shame badges stay off the board');
  const sam = p.salesPeople.find((x) => x.id === 'sam')!;
  assert.ok(badgesFor(sam, ctx, true).some((b) => b.id === 'casper'), 'no activity at all is Casper in the gallery');
  assert.equal(BADGES.length, 27);
  assert.equal(TITLES.length, 4);
  const titles = resolveTitles(p.salesPeople);
  assert.equal(titles.find((t) => t.title.id === 'the-crown')?.holder?.id, 'ava', 'revenue ties go to the first in rank order');
  assert.equal(titles.find((t) => t.title.id === 'sniper')?.holder, undefined, 'nobody has five conversations yet');
}

// ---- transaction coordinator ------------------------------------------------------------------
{
  // Fri Sep 18 2026 (a date), Thu Sep 10 2026, and a file still open past Sep 15.
  const tcRaw: LeaderboardRaw = {
    members: [{ id: 'cas', name: 'Casey Lane', role: 'tc' }, { id: 'ava', name: 'Taylor Reed', role: 'acquisitions' }],
    sellers: [], comms: [], offers: [],
    deals: [
      { id: 20, seller_id: null, stage: 'Closed', created_at: ago(40), stage_entered_at: ago(3), contract_date: ago(30), close_date: '2026-09-18', closed_on: '2026-09-18', owner_id: 'ava', dispo_rep_id: null, assignment_fee: 10_000, wholesale_fee: null, total_cogs: null, deal_net_profit: null, coordinator: 'Casey' },
      { id: 21, seller_id: null, stage: 'Closed', created_at: ago(40), stage_entered_at: ago(11), contract_date: ago(30), close_date: '2026-09-08', closed_on: '2026-09-10', owner_id: 'ava', dispo_rep_id: null, assignment_fee: 10_000, wholesale_fee: null, total_cogs: null, deal_net_profit: null, coordinator: 'casey lane' },
      { id: 22, seller_id: null, stage: 'In Escrow', created_at: ago(40), stage_entered_at: ago(10), contract_date: ago(30), close_date: '2026-09-15', closed_on: null, owner_id: 'ava', dispo_rep_id: null, assignment_fee: 10_000, wholesale_fee: null, total_cogs: null, deal_net_profit: null, coordinator: 'Casey' },
      { id: 23, seller_id: null, stage: 'Terminated', created_at: ago(40), stage_entered_at: ago(2), contract_date: ago(30), close_date: null, closed_on: null, owner_id: 'ava', dispo_rep_id: null, assignment_fee: 10_000, wholesale_fee: null, total_cogs: null, deal_net_profit: null, coordinator: 'Casey' },
      { id: 24, seller_id: null, stage: 'Closed', created_at: ago(40), stage_entered_at: ago(3), contract_date: ago(30), close_date: '2026-09-18', closed_on: '2026-09-18', owner_id: 'ava', dispo_rep_id: null, assignment_fee: 10_000, wholesale_fee: null, total_cogs: null, deal_net_profit: null, coordinator: 'Somebody Else' },
    ],
  };
  const p = buildLeaderboard(tcRaw, 'this-month', { now: NOW, tz: TZ });
  const cas = p.salesPeople.find((x) => x.id === 'cas')!;
  assert.deepEqual([cas.tcClosings, cas.tcFridayClosings, cas.tcOnTime, cas.tcLate, cas.tcFallouts], [2, 1, 1, 2, 1], 'coordinator by first or full name; Sep 18 is a Friday; one closed late and one open past its date');
  const ctx = buildBadgeContext(p.salesPeople);
  const ids = badgesFor(cas, ctx, true).map((b) => b.id);
  assert.ok(ids.includes('friday-closer'), 'a Friday closing is a Friday Closer');
  assert.ok(ids.includes('rain-check') && ids.includes('leaky-bucket'), 'two late and a fall-out');
  assert.ok(!ids.includes('swiss-watch') && !ids.includes('title-wave'));
  const ava = p.salesPeople.find((x) => x.id === 'ava')!;
  assert.equal(ava.tcClosings, undefined, 'only the coordinator gets TC numbers');
}

// ---- empty ------------------------------------------------------------------------------------
{
  const p = buildLeaderboard({ members: [], sellers: [], deals: [], comms: [], offers: [] }, 'today', { now: NOW, tz: TZ });
  assert.deepEqual(p.salesPeople, []);
  assert.equal(p.executiveSummary.totalRevenue, 0);
  assert.equal(p.executiveSummary.cashConversionDays, null);
}

// ---- the mirror -------------------------------------------------------------------------------
{
  const lib = readFileSync(new URL('../lib/leaderboard.ts', import.meta.url), 'utf8');
  const shared = readFileSync(new URL('../supabase/functions/_shared/leaderboard.ts', import.meta.url), 'utf8');
  assert.equal(shared, lib, 'supabase/functions/_shared/leaderboard.ts must be a byte-for-byte copy of lib/leaderboard.ts');
}

console.log('leaderboard: ok');
