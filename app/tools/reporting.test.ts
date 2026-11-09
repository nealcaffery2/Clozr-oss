// Reporting figures that went wrong on live data (lib/reporting.ts): list
// imports counted as leads, terminated deals counted as closings, profit from
// a blank sold price, and the rep filter.
// Run: npx tsx tools/reporting.test.ts
import assert from 'node:assert/strict';
import { type ReportRaw, buildReport, closedAt, isListSource, leadsOf, profitOf, rangeOf, scopeToRep, sourceGroup } from '../lib/reporting';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const now = new Date('2026-10-18T12:00:00');
const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const deal = (o: Partial<ReportRaw['deals'][number]>): ReportRaw['deals'][number] => ({
  id: 1, seller_id: null, buyer_id: null, stage: 'Closed', created_at: day(40), stage_entered_at: day(5), contract_date: day(30).slice(0, 10),
  close_date: null, closed_on: day(5).slice(0, 10), marketing_started_on: null, owner_id: null, dispo_rep_id: null,
  offer_amount: 100000, arv: null, mao: null, assignment_fee: null, sold_price: null, dispo_fee: null,
  wholesale_fee: -100000, total_cogs: 0, team_commissions_paid: 0, deal_net_profit: -100000, final_profit: -100000, ...o,
});
const seller = (o: Partial<ReportRaw['sellers'][number]>): ReportRaw['sellers'][number] => ({
  id: 1, name: 'A', created_at: day(3), source: 'Google PPC', assigned_to: 'diego', stage: 'Lead', address: null, ...o,
});
const raw = (o: Partial<ReportRaw>): ReportRaw => ({
  members: [{ id: 'diego', name: 'Diego', role: 'acquisitions' }, { id: 'morgan', name: 'Morgan', role: 'dispositions' }],
  sellers: [], deals: [], comms: [], commsCapped: false, offers: [], contracts: [], matches: [], buyers: [], transactions: [], ...o,
});
const kpi = (blocks: ReturnType<typeof buildReport>, k: string) => {
  for (const b of blocks) if (b.kind === 'kpis') { const x = b.items.find((i) => i.k === k); if (x) return x.v; }
  throw new Error('no kpi ' + k);
};

test('list sources and groups', () => {
  assert.equal(isListSource('Propstream Daily 10-13'), true);
  assert.equal(isListSource('Mark Spain 10.02.2026'), true);
  assert.equal(isListSource('Google PPC'), false);
  assert.equal(sourceGroup('Propstream Anderson SC Tired Landlord'), 'Cold lists');
  assert.equal(sourceGroup('ISTL PPL'), 'Pay per lead');
  assert.equal(sourceGroup('Property Leads PPL'), 'Pay per lead');
  assert.equal(sourceGroup('Facebook PPC'), 'PPC');
  assert.equal(sourceGroup('Zapier Webhook'), 'Website');
  assert.equal(sourceGroup('Offerpad'), 'Wholesaler / JV');
  assert.equal(sourceGroup('Complete Homes Holdings LLC'), 'Wholesaler / JV');
  assert.equal(sourceGroup('podio'), 'Not recorded');
  assert.equal(sourceGroup(''), 'Not recorded');
  assert.equal(sourceGroup('Dean Slate'), 'Other');
});

test('a list row is a lead only once it answers or is worked, dated then', () => {
  const r = raw({
    sellers: [
      seller({ id: 1, source: 'Propstream Daily 10-13', created_at: day(60) }),
      seller({ id: 2, source: 'Propstream Daily 10-13', created_at: day(60) }),
      seller({ id: 3, source: 'Propstream Daily 10-13', created_at: day(60), stage: 'Contacted - Follow Up Needed', stage_entered_at: day(4) }),
      seller({ id: 4, source: 'Google PPC', created_at: day(2) }),
    ],
    comms: [{ seller_id: 2, channel: 'sms', direction: 'inbound', occurred_at: day(1), duration_s: null, status: null }],
  });
  const leads = leadsOf(r);
  assert.deepEqual(leads.map((l) => l.s.id).sort(), [2, 3, 4]);
  assert.equal(leads.find((l) => l.s.id === 2)!.at, Date.parse(day(1)));
  assert.equal(leads.find((l) => l.s.id === 3)!.at, Date.parse(day(4)));
  assert.equal(kpi(buildReport('Overview', '30 Days', r, { admin: true, now }), 'New leads'), '3');
});

test('terminated deals are never closings, profit comes from the fee', () => {
  assert.equal(closedAt(deal({ stage: 'Terminated' })), null);
  assert.deepEqual(profitOf(deal({ assignment_fee: 9000 })), { fee: 9000, cogs: 0, net: 9000, comm: 0, final: 9000 });
  const r = raw({ deals: [
    deal({ id: 1, assignment_fee: 9000 }),
    deal({ id: 2, stage: 'Terminated', dispo_fee: 10000, terminated_on: day(3).slice(0, 10), termination_reason: 'Price too high' }),
    deal({ id: 3, stage: 'Terminated', terminated_on: day(3).slice(0, 10) }),
  ] });
  const b = buildReport('Overview', '30 Days', r, { admin: true, now });
  assert.equal(kpi(b, 'Closed revenue'), '$9,000');
  assert.equal(kpi(b, 'Net profit'), '$9,000');
  assert.equal(kpi(b, 'Fall-out rate'), '67%');
});

test('closed revenue credits the seller rep when a deal has no owner', () => {
  const r = raw({ sellers: [seller({ id: 7, created_at: day(90) })], deals: [deal({ seller_id: 7, assignment_fee: 5000, dispo_rep_id: 'morgan' })] });
  const team = buildReport('Team', '30 Days', r, { admin: true, now }).find((b) => b.kind === 'table');
  assert.ok(team && team.kind === 'table');
  const row = (name: string) => team.rows.find((x) => x[1] === name)!;
  assert.deepEqual(row('Diego').slice(9), ['$5,000', '$0']);
  assert.deepEqual(row('Morgan').slice(9), ['$0', '$5,000']);
});

test('rep filter keeps only that rep\'s slice', () => {
  const r = raw({
    sellers: [seller({ id: 1, assigned_to: 'diego' }), seller({ id: 2, assigned_to: 'morgan' })],
    deals: [deal({ id: 1, owner_id: 'diego', assignment_fee: 5000 }), deal({ id: 2, owner_id: 'morgan', assignment_fee: 7000 })],
  });
  const s = scopeToRep(r, 'diego');
  assert.deepEqual(s.sellers.map((x) => x.id), [1]);
  assert.equal(kpi(buildReport('Overview', '30 Days', r, { admin: true, now, rep: 'diego' }), 'Closed revenue'), '$5,000');
  assert.equal(kpi(buildReport('Overview', '30 Days', r, { admin: true, now }), 'Closed revenue'), '$12,000');
});

test('custom range reads only its days', () => {
  const r = raw({ deals: [deal({ id: 1, assignment_fee: 5000, closed_on: '2026-09-10' }), deal({ id: 2, assignment_fee: 7000, closed_on: '2026-10-10' })] });
  const b = buildReport('Overview', 'Custom', r, { admin: true, now, custom: { from: '2026-09-01', to: '2026-09-30' } });
  assert.equal(kpi(b, 'Closed revenue'), '$5,000');
});

console.log(`reporting: ${passed} passed`);

// The Monday after the clocks fall back (2026-11-01): Yesterday is the whole calendar
// day, not 24 hours back from midnight (run under TZ=America/Chicago too).
const afterFallBack = new Date(2026, 10, 2, 12, 0, 0);
const yesterday = rangeOf('Yesterday', afterFallBack);
assert.equal(new Date(yesterday.start).getHours(), 0, 'yesterday starts at local midnight');
assert.equal(new Date(yesterday.start).getDate(), 1);
assert.equal(new Date(yesterday.prevStart!).getHours(), 0, 'the day before starts at local midnight');
assert.equal(new Date(yesterday.prevStart!).getDate(), 31);
assert.equal(new Date(rangeOf('Today', afterFallBack).prevStart!).getHours(), 0, 'today compares with yesterday from its midnight');
