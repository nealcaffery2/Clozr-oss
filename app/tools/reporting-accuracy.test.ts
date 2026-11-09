// The seven Reporting accuracy bugs from the 2026-10-18 audit, each pinned
// with a small fixture. Run: npx tsx tools/reporting-accuracy.test.ts
import assert from 'node:assert/strict';
import { type ReportRaw, buildReport, closedAt, fee, isListSource, leadsOf, profitOf, repMetrics, teamRows } from '../lib/reporting';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const now = new Date('2026-10-18T12:00:00');
const day = (n: number) => new Date(2026, 9, n, 9).toISOString();
const deal = (p: Partial<ReportRaw['deals'][number]> & { id: number }): ReportRaw['deals'][number] => ({
  seller_id: null, buyer_id: null, stage: 'Closed', created_at: day(1), stage_entered_at: null, contract_date: null, close_date: null, closed_on: '2026-10-05',
  marketing_started_on: null, owner_id: null, dispo_rep_id: null, offer_amount: null, arv: null, mao: null, assignment_fee: null, sold_price: null,
  wholesale_fee: null, total_cogs: 0, team_commissions_paid: 0, deal_net_profit: null, final_profit: null, ...p,
});
const seller = (p: Partial<ReportRaw['sellers'][number]> & { id: number }): ReportRaw['sellers'][number] => ({
  name: 'S' + p.id, created_at: day(3), source: 'podio', assigned_to: 'amy', stage: 'Lead', address: null, ...p,
});
const raw = (p: Partial<ReportRaw>): ReportRaw => ({
  members: [{ id: 'amy', name: 'Amy', role: 'acquisitions' }, { id: 'morgan', name: 'Morgan', role: 'dispositions' }],
  sellers: [], deals: [], comms: [], commsCapped: false, offers: [], contracts: [], matches: [], buyers: [], transactions: [], appointments: [], ...p,
});
const mtd = { start: new Date(2026, 9, 1).getTime(), end: now.getTime() };
const kpi = (blocks: ReturnType<typeof buildReport>, k: string) => blocks.flatMap((b) => (b.kind === 'kpis' ? b.items : [])).find((x) => x.k === k)?.v;
const table = (blocks: ReturnType<typeof buildReport>, title: string) => blocks.find((b): b is Extract<typeof b, { kind: 'table' }> => b.kind === 'table' && b.title === title)!;

// 1. Profit: a closed deal with no sold price typed used the database's
// sold − contract, so profit read minus the whole contract price.
test('profit never goes negative by a contract price', () => {
  const d = deal({ id: 5039, offer_amount: 300000, sold_price: null, assignment_fee: null, wholesale_fee: -300000, deal_net_profit: -300000, final_profit: -300000 });
  assert.equal(fee(d), 0);
  assert.equal(profitOf(d).final, 0);
  const d2 = deal({ id: 4402, offer_amount: 90000, assignment_fee: 9000, wholesale_fee: -90000, final_profit: -90000 });
  assert.equal(profitOf(d2).final, 9000);
  // The first load has no wholesale_fee yet: the spread is figured from the prices on the row.
  const d3 = deal({ id: 4373, offer_amount: 215000, sold_price: 275000, assignment_fee: 30000, wholesale_fee: null, total_cogs: 38755.24, team_commissions_paid: 7491.19, final_profit: 13753.57 });
  assert.equal(fee(d3), 60000);
  assert.equal(Math.round(profitOf(d3).final), 13754);
  const blocks = buildReport('Profitability', 'MTD', raw({ deals: [d, d2] }), { admin: true, now });
  assert.equal(kpi(blocks, 'Final profit'), '$9,000');
  assert.deepEqual(table(blocks, 'Per deal').rows[0].slice(2), ['$0', '$0', '$0', '$0', '$0']);
});

// 2. Cold-list rows are not leads until they answer or a rep works them.
test('cold-list rows do not count as leads', () => {
  const sellers = [
    seller({ id: 1, source: 'Propstream Daily 10-13', stage: 'Lead - No Contact' }),
    seller({ id: 2, source: 'Propstream Daily 10-13', stage: 'Lead' }),
    seller({ id: 3, source: 'Propstream Anderson SC Tired Landlord', stage: 'Contacted - Follow Up Needed', stage_entered_at: day(6) }),
    seller({ id: 4, source: 'podio', stage: 'Lead' }),
    seller({ id: 5, source: null, stage: 'Lead' }),
  ];
  assert.deepEqual(sellers.map((s) => isListSource(s.source)), [true, true, true, false, false]);
  const r = raw({ sellers });
  assert.deepEqual(leadsOf(r).map((l) => l.s.id), [3, 4, 5]);
  assert.equal(repMetrics(r, mtd).newLeads, 3);
  assert.equal(kpi(buildReport('Overview', 'MTD', r, { admin: false, now }), 'New leads'), '3');
});

// 3. The Lead Sources tab counts the same leads the New leads tile does, and names the list rows left out.
test('lead sources agree with the lead count', () => {
  const sellers = [
    seller({ id: 1, source: 'Propstream Daily 10-13', stage: 'Lead - No Contact' }),
    seller({ id: 2, source: 'Propstream Daily 10-13', stage: 'Lead - No Contact' }),
    seller({ id: 4, source: 'podio', stage: 'Lead' }),
    seller({ id: 5, source: 'Offerpad', stage: 'Lead' }),
  ];
  const blocks = buildReport('Lead Sources', 'MTD', raw({ sellers }), { admin: true, now });
  assert.equal(kpi(blocks, 'New leads'), '2');
  const byName = table(blocks, 'By source name');
  assert.equal(byName.rows.reduce((a, x) => a + Number(x[2]), 0), 2);
  assert.ok(!byName.rows.some((x) => /propstream/i.test(x[0])));
});

// 4. A Terminated deal with a Closed On date is not a closing.
test('terminated deals are not closings', () => {
  const t = deal({ id: 3728, stage: 'Terminated', closed_on: '2026-10-02', dispo_fee: 18000 });
  const c = deal({ id: 1, stage: 'Closed', closed_on: '2026-10-03', dispo_fee: 5000 });
  assert.equal(closedAt(t), null);
  assert.equal(closedAt(c), '2026-10-03');
  assert.equal(closedAt(deal({ id: 2, closed_on: null, close_date: '2026-10-04' })), '2026-10-04');
  const blocks = buildReport('Closings', 'MTD', raw({ deals: [t, c] }), { admin: true, now });
  assert.equal(kpi(blocks, 'Closed'), '1');
  assert.equal(kpi(blocks, 'Revenue'), '$5,000');
});

// 5. A closed deal with no owner credits the seller's rep; acq and dispo revenue are separate columns that each add up.
test('closings credit the seller rep when the owner is blank', () => {
  const sellers = [seller({ id: 10, assigned_to: 'amy' })];
  const d = deal({ id: 1, seller_id: 10, owner_id: null, dispo_rep_id: 'morgan', dispo_fee: 10000 });
  const rows = teamRows(raw({ sellers, deals: [d] }), mtd);
  assert.deepEqual(rows.map((x) => [x.id, x.closings, x.acqRevenue, x.dispoRevenue]), [['amy', 1, 10000, 0], ['morgan', 1, 0, 10000]]);
  assert.equal(rows.reduce((a, x) => a + x.acqRevenue, 0), 10000);
  assert.equal(kpi(buildReport('Overview', 'MTD', raw({ sellers, deals: [d] }), { admin: false, now }), 'Closed revenue'), '$10,000');
});

// 6. A capped communications read says so on the ranges it shortens.
test('a capped communications read says so', () => {
  const r = raw({ commsCapped: true, comms: [{ seller_id: null, channel: 'call', direction: 'outbound', occurred_at: day(10), duration_s: 30, status: null }] });
  const note = (label: string) => buildReport('Calls', label, r, { admin: false, now }).some((b) => b.kind === 'table' && / loaded from /.test(b.sub ?? ''));
  assert.equal(note('YTD'), true);
  assert.equal(note('Today'), false);
});

// 7. Appointment is a booked appointment, never inferred from an offer.
test('funnel appointment step counts real appointments only', () => {
  const sellers = [seller({ id: 1, stage: 'Offer Made' }), seller({ id: 2, stage: 'Lead' }), seller({ id: 3, stage: 'Appointment Set' })];
  const r = raw({ sellers, offers: [{ id: 1, deal_id: null, seller_id: 1, buyer_id: null, direction: 'outbound', amount: 1, status: 'pending', sent_at: day(4), responded_at: null, created_by: 'amy' }], appointments: [{ id: 1, seller_id: 2, buyer_id: null, title: 'Walk', kind: 'walk', starts_at: day(5) }] });
  const f = buildReport('Acquisitions', 'MTD', r, { admin: false, now }).find((b): b is Extract<typeof b, { kind: 'funnel' }> => b.kind === 'funnel')!;
  const step = (k: string) => f.steps.find((s) => s.k === k)!;
  assert.equal(step('Appointment').n, 2);
  assert.equal(step('Offer made').n, 1);
  assert.equal(step('Contacted').n, 3);
});

console.log(`reporting-accuracy: ${passed} passed`);
