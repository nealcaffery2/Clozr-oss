// The custom-report engine on a small fixture, and the guard that keeps the
// edge function's copy identical to the library. Run: npx tsx tools/report-engine.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { abbreviate, compute, evalFormula, formulaError, normalize, presetRange, rangeFor, withComparison, type EngineRaw, type Spec, type Token } from '../lib/report-engine';

const NOW = new Date(2026, 8, 21, 12, 0, 0); // Sep 21 2026, local
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();

const raw: EngineRaw = {
  members: [{ id: 'u1', name: 'Sam', role: 'owner' }, { id: 'u2', name: 'Taylor', role: 'acquisitions' }],
  sellers: [
    { id: 1, name: 'A', created_at: ago(2), source: 'PPC', assigned_to: 'u1', stage: 'New Lead', address: '1 Main', email: 'a@x.com', phone: '210', tags: ['Hot', 'Probate'] },
    { id: 2, name: 'B', created_at: ago(10), source: 'PPC', assigned_to: 'u2', stage: 'Offer Sent', address: '2 Main', email: null, phone: '210', tags: [] },
    { id: 3, name: 'C', created_at: ago(40), source: 'Referral', assigned_to: 'u2', stage: 'Under Contract - Seller', address: '3 Main', email: 'c@x.com', phone: null, tags: ['Hot'] },
    { id: 4, name: 'D', created_at: ago(45), source: 'Cold call', assigned_to: null, stage: 'Closed', address: '4 Main', email: null, phone: null, tags: [] },
  ],
  deals: [
    { id: 10, seller_id: 3, buyer_id: null, stage: 'Ready To Market', created_at: ago(30), stage_entered_at: ago(5), contract_date: ago(28).slice(0, 10), close_date: null, closed_on: null, marketing_started_on: ago(20).slice(0, 10), owner_id: 'u2', dispo_rep_id: 'u1', offer_amount: 150000, arv: 260000, mao: 170000, assignment_fee: 15000, sold_price: null, wholesale_fee: null, total_cogs: null, team_commissions_paid: null, deal_net_profit: null, final_profit: null, lead_source: 'Referral' },
    { id: 11, seller_id: 4, buyer_id: 1, stage: 'Closed', created_at: ago(44), stage_entered_at: ago(3), contract_date: ago(40).slice(0, 10), close_date: ago(3).slice(0, 10), closed_on: ago(3).slice(0, 10), marketing_started_on: ago(35).slice(0, 10), owner_id: 'u1', dispo_rep_id: 'u1', offer_amount: 100000, arv: 200000, mao: 120000, assignment_fee: 12000, sold_price: 118000, wholesale_fee: 18000, total_cogs: 1000, team_commissions_paid: 3000, deal_net_profit: 14000, final_profit: 14000, dispo_fee: 20000 },
    { id: 12, seller_id: 2, buyer_id: null, stage: 'Dead', created_at: ago(60), stage_entered_at: ago(50), contract_date: null, close_date: null, closed_on: null, marketing_started_on: null, owner_id: 'u2', dispo_rep_id: null, offer_amount: 90000, arv: null, mao: null, assignment_fee: null, sold_price: null, wholesale_fee: null, total_cogs: null, team_commissions_paid: null, deal_net_profit: null, final_profit: null },
  ],
  comms: [
    { seller_id: 1, channel: 'call', direction: 'outbound', occurred_at: ago(1), duration_s: 120, status: 'completed' },
    { seller_id: 1, channel: 'call', direction: 'outbound', occurred_at: ago(2, 1), duration_s: 0, status: 'no-answer' },
    { seller_id: 2, channel: 'call', direction: 'inbound', occurred_at: ago(12), duration_s: 300, status: 'completed' },
    { seller_id: 2, channel: 'sms', direction: 'outbound', occurred_at: ago(3), duration_s: null, status: 'delivered' },
    { seller_id: null, buyer_id: 1, channel: 'email', direction: 'outbound', occurred_at: ago(4), duration_s: null, status: 'sent' },
  ],
  offers: [
    { id: 1, deal_id: 10, seller_id: 3, buyer_id: null, direction: 'outbound', amount: 150000, status: 'accepted', sent_at: ago(29), responded_at: ago(28), created_by: 'u2' },
    { id: 2, deal_id: 10, seller_id: null, buyer_id: 1, direction: 'inbound', amount: 165000, status: 'pending', sent_at: ago(6), responded_at: null, created_by: null },
  ],
  contracts: [{ id: 1, deal_id: 10, kind: 'psa', status: 'completed', provider: 'pandadoc', sent_at: ago(29), viewed_at: ago(29), completed_at: ago(28), created_at: ago(29) }],
  matches: [
    { deal_id: 10, buyer_id: 1, status: 'replied', sent_at: ago(8), viewed_at: ago(8), replied_at: ago(7) },
    { deal_id: 10, buyer_id: 2, status: 'sent', sent_at: ago(8), viewed_at: null, replied_at: null },
  ],
  buyers: [{ id: 1, name: 'Buyer One', vip: true, created_at: ago(200), last_activity_at: ago(7), blacklisted_at: null }, { id: 2, name: 'Buyer Two', vip: false, created_at: ago(20), last_activity_at: ago(120), blacklisted_at: null }],
  appointments: [{ id: 1, seller_id: 1, buyer_id: null, title: 'Walkthrough', kind: 'walkthrough', starts_at: ago(1), assigned_to: 'u1', source: 'clozr', created_at: ago(3), deleted_at: null }, { id: 2, seller_id: 2, buyer_id: null, title: 'Call', kind: 'call', starts_at: ago(-2), assigned_to: 'u2', source: 'google', created_at: ago(1), deleted_at: null }],
  tasks: [{ id: 1, seller_id: 1, title: 'Follow up', task_type: 'call', priority: 'High', due_at: ago(1), assigned_to: 'u1', done: false, completed_at: null, created_at: ago(2) }],
};

const data = normalize(raw, NOW.getTime());
const range30 = rangeFor('Last 30 days', 'previous', null, NOW);
const S = (source: Spec['source'], agg: Spec['agg'], o: Partial<Spec> = {}): Spec => ({ source, agg, field: null, groupBy: null, dateField: 'created_at', filters: [], ...o });
const run = (spec: Spec, chart: Parameters<typeof compute>[4] extends infer O ? (O extends { chart?: infer C } ? C : never) : never = 'number') => compute(spec, range30, data, raw, { now: NOW.getTime(), me: 'u1', chart });

// Counting in a window, and the previous window.
const sellers30 = run(S('sellers', 'count'));
assert.equal(sellers30.value, 2, 'two sellers in the last 30 days');
assert.equal(sellers30.prev, 2, 'two sellers in the 30 days before that');

// Filters: bool, user (@me), tags.
assert.equal(run(S('sellers', 'count', { filters: [[{ field: 'has_email', op: 'is', value: 'true' }]] })).value, 1);
assert.equal(run(S('sellers', 'count', { filters: [[{ field: 'assigned', op: 'is', value: '@me' }]] })).value, 1);
assert.equal(run(S('sellers', 'count', { dateField: null, filters: [[{ field: 'tags', op: 'is', value: 'hot' }]] })).value, 2, 'tag match is case-insensitive');

// Group by with the categorical fold and label mapping for users.
const bySource = run(S('sellers', 'count', { dateField: null, groupBy: 'source' }), 'donut');
assert.deepEqual(bySource.groups?.map((g) => g.label), ['PPC', 'Referral', 'Cold call']);
const byRep = run(S('sellers', 'count', { dateField: null, groupBy: 'assigned' }), 'bar');
assert.deepEqual(byRep.groups?.map((g) => g.label).sort(), ['Sam', 'Taylor', '—']);

// Money aggregation and derived deal fields.
const fees = run(S('deals', 'sum', { field: 'fee', dateField: 'closed_on', filters: [[{ field: 'status', op: 'is', value: 'won' }]] }));
assert.equal(fees.value, 20000, 'dispo fee wins over wholesale and assignment fee');
assert.equal(fees.format, 'usd');
const spread = run(S('deals', 'avg', { field: 'spread', dateField: 'closed_on' }));
assert.equal(spread.value, 18000);
assert.equal(run(S('deals', 'avg', { field: 'days_to_assign', dateField: 'closed_on' })).value, 32, 'marketing start → closed');

// Calls: duration, answered, first-time.
assert.equal(run(S('calls', 'count', { dateField: 'occurred_at', filters: [[{ field: 'direction', op: 'is', value: 'outbound' }, { field: 'answered', op: 'is', value: 'true' }]] })).value, 1);
assert.equal(run(S('calls', 'count', { dateField: 'occurred_at', filters: [[{ field: 'first_time', op: 'is', value: 'true' }]] })).value, 2, 'one first call per seller');
assert.equal(run(S('calls', 'sum', { field: 'duration', dateField: 'occurred_at' })).format, 'dur');

// Series buckets by day over a month.
const series = run(S('calls', 'count', { dateField: 'occurred_at' }), 'line');
assert.ok(series.series && series.series.length >= 28 && series.series.length <= 31, 'daily buckets');
assert.equal(series.series!.reduce((a, p) => a + p.value, 0), 3);

// Table and funnel.
const table = run(S('tasks', 'count', { dateField: 'due_at', columns: ['title', 'assigned', 'done'] }), 'table');
assert.deepEqual(table.table?.cols, ['Title', 'Assigned to', 'Done']);
assert.deepEqual(table.table?.rows[0], ['Follow up', 'Sam', 'No']);
const funnel = run(S('sellers', 'count', { dateField: null, funnel: ['lead', 'working', 'offer', 'contract', 'closed'].map((g, i, all) => ({ label: g, filters: all.slice(i).map((x) => [{ field: 'stage_group', op: 'is' as const, value: x }]) })) }), 'funnel');
assert.deepEqual(funnel.funnel?.map((s) => s.value), [4, 3, 3, 2, 1], 'each step counts everyone at or past it');

// Upcoming appointments use a future preset.
const upcoming = compute(S('appointments', 'count', { dateField: 'starts_at', datePreset: 'Next 7 days' }), range30, data, raw, { now: NOW.getTime() });
assert.equal(upcoming.value, 1);

// Blasts and buyers.
assert.equal(run(S('blasts', 'count', { dateField: 'sent_at', filters: [[{ field: 'replied', op: 'is', value: 'true' }]] })).value, 1);
assert.equal(run(S('buyers', 'count', { dateField: null, filters: [[{ field: 'active', op: 'is', value: 'true' }]] })).value, 1);

// Formulas.
const F: Token[] = [{ kind: 'metric', label: 'won', spec: S('deals', 'count', { dateField: 'closed_on', filters: [[{ field: 'status', op: 'is', value: 'won' }]] }) }, { kind: 'op', v: '/' }, { kind: 'metric', label: 'all', spec: S('deals', 'count', { dateField: null }) }, { kind: 'op', v: '*' }, { kind: 'num', v: 100 }];
assert.equal(formulaError(F), null);
assert.equal(Math.round(evalFormula(F, (spec) => run(spec).value) ?? -1), 33);
assert.equal(evalFormula([{ kind: 'num', v: 1 }, { kind: 'op', v: '/' }, { kind: 'num', v: 0 }], () => null), null, 'divide by zero is null, not Infinity');
assert.equal(evalFormula([{ kind: 'op', v: '(' }, { kind: 'num', v: 2 }, { kind: 'op', v: '+' }, { kind: 'num', v: 3 }, { kind: 'op', v: ')' }, { kind: 'op', v: '*' }, { kind: 'num', v: 4 }], () => null), 20);
assert.ok(formulaError([{ kind: 'num', v: 1 }, { kind: 'op', v: '+' }]));
assert.ok(formulaError([{ kind: 'num', v: 1 }, { kind: 'num', v: 2 }]));

// Ranges.
const y = presetRange('Yesterday', null, NOW);
assert.equal(new Date(y.start).getDate(), 20);
assert.equal(new Date(y.end).getDate(), 20);
const cmp = withComparison(presetRange('Last 7 days', null, NOW), 'year');
assert.equal(new Date(cmp.prevStart!).getFullYear(), 2025);
assert.equal(withComparison({ start: 0, end: 10 }, 'none').prevStart, null);

// Formatting.
assert.equal(abbreviate(2640), '2,640');
assert.equal(abbreviate(26400), '26.4K');
assert.equal(abbreviate(1_130_000), '1.13M');

// The edge function runs the very same engine.
assert.equal(readFileSync(new URL('../lib/report-engine.ts', import.meta.url), 'utf8'), readFileSync(new URL('../supabase/functions/_shared/report-engine.ts', import.meta.url), 'utf8'), 'supabase/functions/_shared/report-engine.ts must be a verbatim copy of lib/report-engine.ts (cp lib/report-engine.ts supabase/functions/_shared/report-engine.ts)');

console.log('report-engine: ok');
